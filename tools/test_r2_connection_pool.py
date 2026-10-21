import concurrent.futures
import hashlib
import http.client
import io
import json
import socket
import threading
import time
import unittest
import warnings
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from tools import sync_r2


class LoopbackServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        self.accepts = 0
        self.connects = []
        self.requests = []
        self.truncated_once = False
        self.active = self.max_active = 0
        self.lock = threading.Lock()
        super().__init__(("127.0.0.1", 0), LoopbackHandler)
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    def get_request(self):
        conn, addr = super().get_request()
        with self.lock:
            self.accepts += 1
        if getattr(self, "receive_buffer", None):
            conn.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, self.receive_buffer)
        return conn, addr


class LoopbackHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def do_CONNECT(self):
        # Python 3.10 sends CONNECT as HTTP/1.0; a successful tunnel remains open.
        self.close_connection = False
        self.server.connects.append((self.path, self.headers.get("Proxy-Authorization")))
        self.send_response(200)
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_PUT(self):
        self.do_GET()

    def do_GET(self):
        key = self.path.rsplit("/", 1)[-1]
        with self.server.lock:
            if key == "truncate-once" and not self.server.truncated_once:
                self.server.truncated_once = True
                key = "truncate"
            self.server.requests.append((self.command, self.path, dict(self.headers)))
            self.server.active += 1
            self.server.max_active = max(self.server.max_active, self.server.active)
        try:
            if key == "silent-put":
                self.connection.close()
                self.close_connection = True
                return
            length = int(self.headers.get("Content-Length", "0"))
            while length:
                data = self.rfile.read(min(length, 8192))
                if not data:
                    break
                length -= len(data)
                if key == "slow":
                    time.sleep(0.01)
            if key == "wait":
                time.sleep(0.08)
            if key == "stall":
                time.sleep(0.25)
            body = b"short" if key == "truncate" else b"payload"
            self.send_response(503 if key == "error" else 200)
            self.send_header("Content-Length", "100" if key == "truncate" else str(len(body)))
            if key in ("close", "truncate"):
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
                self.wfile.flush()
            if key == "stale":
                self.close_connection = True
        except (BrokenPipeError, ConnectionResetError, OSError):
            self.close_connection = True
        finally:
            with self.server.lock:
                self.server.active -= 1


class ConnectionPoolTests(unittest.TestCase):
    def setUp(self):
        self.server = LoopbackServer()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.proxy_patch = patch("urllib.request.getproxies", return_value={})
        self.proxy_patch.start()
        self.addCleanup(self.proxy_patch.stop)

    def config(self, **extra):
        return {"account_id": "test", "access_key_id": "test", "secret_access_key": "test",
                "bucket": "bucket", "request_retries": 0, "request_timeout": 2,
                "retry_base_delay": 0, **extra}

    def factory(self, host, port, timeout, proxy):
        self.assertEqual((host, port, proxy), ("test.r2.cloudflarestorage.com", 443, None))
        return http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=timeout)

    def client(self, **extra):
        client = sync_r2.R2Client(self.config(**extra), connection_factory=self.factory)
        self.addCleanup(client.close)
        return client

    def test_default_sequential_requests_reuse_one_real_socket(self):
        client = self.client()
        for _ in range(8):
            self.assertEqual(client.get("file")[2], b"payload")
        self.assertEqual(self.server.accepts, 1)
        self.assertEqual(client.transport_info["mode"], "pool")
        self.assertEqual(client.transport_metrics()["connections_created"], 1)
        self.assertEqual(client.transport_metrics()["connections_reused"], 7)
        self.assertGreaterEqual(client.transport_metrics()["max_connections"], 16)
        self.assertTrue(all("Connection" not in req[2] for req in self.server.requests))

    def test_parallelism_is_bounded_and_pool_wait_has_timeout(self):
        client = self.client(http_pool_max_connections=2)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as workers:
            results = list(workers.map(lambda _: client.get("wait"), range(12)))
        self.assertTrue(all(item[0] == 200 for item in results))
        self.assertEqual(self.server.accepts, 2)
        self.assertEqual(self.server.max_active, 2)
        self.assertEqual(client.transport_metrics()["peak_in_use"], 2)
        self.assertGreater(client.transport_metrics()["pool_waits"], 0)
        one = self.client(http_pool_max_connections=1)
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as worker:
            active = worker.submit(one.get, "wait")
            deadline = time.monotonic() + 1
            while one.transport_metrics()["in_use"] != 1 and time.monotonic() < deadline:
                time.sleep(0.001)
            with self.assertRaises(TimeoutError):
                one._request("GET", "file", retries=0, timeout=0.01)
            self.assertEqual(active.result()[0], 200)

    def test_body_interruption_discards_connection(self):
        client = self.client()
        with self.assertRaises(http.client.IncompleteRead):
            client.get("truncate")
        self.assertEqual(client.get("file")[2], b"payload")
        self.assertEqual(self.server.accepts, 2)
        self.assertEqual(client.transport_metrics()["connections_discarded"], 1)

    def test_incomplete_get_uses_only_existing_outer_retry(self):
        client = self.client(request_retries=1)
        with redirect_stdout(io.StringIO()) as output:
            self.assertEqual(client.get("truncate-once")[2], b"payload")
        self.assertEqual(self.server.accepts, 2)
        self.assertEqual(len(self.server.requests), 2)
        self.assertIn("request retry 1/1 GET truncate-once", output.getvalue())

    def test_pool_rejects_destination_changes_before_connecting(self):
        client = self.client()
        client.endpoint = "http://127.0.0.1:1"
        with self.assertRaisesRegex(ValueError, "configured HTTPS origin"):
            client.get("file")
        self.assertEqual(self.server.accepts, 0)

    def test_http_error_body_is_consumed_before_reuse(self):
        client = self.client(request_retries=1)
        with redirect_stdout(io.StringIO()):
            self.assertEqual(client.get("error"), (503, unittest.mock.ANY, b"payload"))
        self.assertEqual(client.get("file")[2], b"payload")
        self.assertEqual(self.server.accepts, 1)
        self.assertEqual(len(self.server.requests), 3)

    def test_server_close_and_idle_expiry_do_not_reuse_socket(self):
        client = self.client(http_pool_idle_timeout=0.02)
        self.assertEqual(client.get("close")[0], 200)
        self.assertEqual(client.get("file")[0], 200)
        time.sleep(0.03)
        self.assertEqual(client.head("file")[0], 200)
        self.assertEqual(self.server.accepts, 3)

    def test_idle_dead_socket_uses_existing_get_retry_only(self):
        client = self.client(request_retries=1)
        self.assertEqual(client.get("stale")[0], 200)
        time.sleep(0.02)
        with redirect_stdout(io.StringIO()) as output:
            self.assertEqual(client.get("file")[0], 200)
        self.assertEqual(self.server.accepts, 2)
        self.assertIn("request retry 1/1 GET file", output.getvalue())

    def test_stalled_response_is_discarded_and_timeout_override_is_reset(self):
        client = self.client(request_timeout=0.5)
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            client._request("GET", "stall", retries=0, timeout=0.03)
        self.assertLess(time.monotonic() - started, 0.2)
        self.assertEqual(client.get("file")[0], 200)
        self.assertEqual(client._request("GET", "file", timeout=0.03)[0], 200)
        self.assertEqual(client.get("stall")[0], 200)
        self.assertEqual(self.server.accepts, 2)

    def test_slow_healthy_upload_is_not_a_total_request_deadline(self):
        client = self.client(request_timeout=0.5)
        body = b"x" * (1024 * 1024)
        self.server.receive_buffer = 16384
        connect = socket.create_connection
        def small_buffer(*args, **kwargs):
            sock = connect(*args, **kwargs)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 16384)
            return sock
        started = time.monotonic()
        with patch("socket.create_connection", small_buffer):
            self.assertEqual(client.put_bytes("slow", body, hashlib.sha256(body).hexdigest(),
                                             "application/octet-stream", "no-store")[0], 200)
        self.assertGreater(time.monotonic() - started, 0.5)
        self.assertEqual(self.server.accepts, 1)

    def test_pooled_tls_handshake_stall_uses_existing_timeout_and_retry(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        listener.settimeout(0.1)
        self.addCleanup(listener.close)
        stop = threading.Event()
        connections = []
        def accept_silently():
            while not stop.is_set():
                try:
                    connection, _address = listener.accept()
                except (TimeoutError, OSError):
                    continue
                connections.append(connection)
        thread = threading.Thread(target=accept_silently, daemon=True)
        thread.start()
        def cleanup():
            stop.set()
            thread.join(1)
            for connection in connections:
                connection.close()
        self.addCleanup(cleanup)
        def tls_factory(_host, _port, timeout, _proxy):
            return http.client.HTTPSConnection("127.0.0.1", listener.getsockname()[1], timeout=timeout)
        client = sync_r2.R2Client(self.config(request_timeout=0.05, request_retries=1),
                                 connection_factory=tls_factory)
        self.addCleanup(client.close)
        started = time.monotonic()
        with redirect_stdout(io.StringIO()) as output, self.assertRaises(TimeoutError):
            client.head("file")
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(len(connections), 2)
        self.assertIn("request retry 1/1", output.getvalue())
        self.assertEqual(client.transport_metrics()["open"], 0)

    def test_raw_put_has_no_hidden_retry_even_after_response_loss(self):
        client = self.client(request_retries=8)
        with self.assertRaises((ConnectionError, TimeoutError)):
            client.put_bytes("silent-put", b"data", hashlib.sha256(b"data").hexdigest(),
                             "application/octet-stream", "no-store", if_none_match="*")
        self.assertEqual(len(self.server.requests), 1)
        self.assertEqual(self.server.accepts, 1)

    def test_http_connect_proxy_is_reused_and_credentials_stay_on_tunnel(self):
        proxy_url = f"http://name:secret@127.0.0.1:{self.server.server_port}"
        def plaintext_tls(host, port=None, **kwargs):
            # A fake TLS layer keeps the actual CONNECT and HTTP socket flow local.
            return http.client.HTTPConnection(host, port, timeout=kwargs.get("timeout"))
        with patch("urllib.request.getproxies", return_value={"https": proxy_url}), \
                patch("urllib.request.proxy_bypass", return_value=False), \
                patch("http.client.HTTPSConnection", side_effect=plaintext_tls):
            client = sync_r2.R2Client(self.config())
            self.addCleanup(client.close)
            for _ in range(3):
                self.assertEqual(client.get("file")[2], b"payload")
        self.assertEqual(self.server.accepts, 1)
        self.assertEqual(self.server.connects, [("test.r2.cloudflarestorage.com:443", "Basic bmFtZTpzZWNyZXQ=")])
        self.assertTrue(all("Proxy-Authorization" not in req[2] for req in self.server.requests))
        self.assertNotIn("secret", str(client.transport_info))

    def test_proxy_bypass_uses_direct_factory_and_unsupported_proxy_falls_back_explicitly(self):
        with patch("urllib.request.getproxies", return_value={"https": "http://127.0.0.1:1"}), \
                patch("urllib.request.proxy_bypass", return_value=True):
            client = self.client()
            self.assertEqual(client.get("file")[0], 200)
            self.assertFalse(client.transport_info["proxy"])
        for scheme in ("https", "socks5"):
            with self.subTest(scheme=scheme), \
                    patch("urllib.request.getproxies", return_value={"https": f"{scheme}://name:secret@127.0.0.1:1"}), \
                    patch("urllib.request.proxy_bypass", return_value=False), warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                client = sync_r2.R2Client(self.config())
                self.addCleanup(client.close)
                with patch("urllib.request.urlopen", side_effect=RuntimeError("legacy path")) as legacy:
                    with self.assertRaisesRegex(RuntimeError, "legacy path"):
                        client.get("file")
                self.assertEqual(legacy.call_count, 1)
                self.assertEqual(client.transport_info["mode"], "urllib")
                self.assertTrue(caught)
                self.assertNotIn("secret", str(caught[0].message))
                self.assertNotIn("secret", str(client.transport_info))

    def test_fixed_sequence_reports_accept_counts_for_both_transports(self):
        count = 8
        client = self.client()
        started = time.perf_counter()
        for _ in range(count):
            client.get("file")
        pooled_seconds = time.perf_counter() - started
        pooled_accepts = self.server.accepts
        client.close()
        legacy = sync_r2.R2Client(self.config(http_pool_enabled=False))
        legacy.endpoint = f"http://127.0.0.1:{self.server.server_port}"
        started = time.perf_counter()
        for _ in range(count):
            legacy.get("file")
        legacy_seconds = time.perf_counter() - started
        legacy_accepts = self.server.accepts - pooled_accepts
        self.assertEqual((legacy_accepts, pooled_accepts), (count, 1))
        report = {"environment": "loopback HTTP, synthetic credentials, identical sequential GET payloads",
                  "requests_per_transport": count, "legacy_accepts": legacy_accepts,
                  "pooled_accepts": pooled_accepts, "legacy_seconds": legacy_seconds,
                  "pooled_seconds": pooled_seconds, "tls_handshakes": "not measured (injected HTTP connection)",
                  "public_network_speedup": "not inferred", "pool_metrics": client.transport_metrics()}
        output = Path(__file__).resolve().parents[1] / "output/r2-integration-20261020/pool"
        output.mkdir(parents=True, exist_ok=True)
        (output / "loopback-benchmark.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
