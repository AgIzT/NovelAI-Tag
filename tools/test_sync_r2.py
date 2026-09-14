import hashlib
import http.client
import io
import json
import socket
import tempfile
import threading
import time
import unittest
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from PIL import Image

from tools import preview_server, sync_r2


class MediaMimeTests(unittest.TestCase):
    def test_webp_and_unknown_types_without_system_mapping(self):
        with tempfile.TemporaryDirectory() as tmp, patch("mimetypes.guess_type", return_value=(None, None)):
            root = Path(tmp)
            originals = root / "originals"
            originals.mkdir()
            with patch.object(preview_server, "ROOT", str(root)), patch.object(preview_server, "ORIG", str(originals)):
                for filename, expected in (("sample.webp", "image/webp"), ("sample.WEBP", "image/webp"),
                                           ("sample.unknown", "application/octet-stream")):
                    with self.subTest(filename=filename):
                        source = originals / filename
                        source.write_bytes(b"original bytes")
                        self.assertEqual(sync_r2.guess_type(source), expected)
                        handler = object.__new__(preview_server.Handler)
                        handler.path = "/originals/" + filename
                        handler.wfile = io.BytesIO()
                        handler.send_response = Mock()
                        handler.send_header = Mock()
                        handler.end_headers = Mock()
                        self.assertEqual(handler.guess_type(str(source)), expected)
                        handler._serve_original()
                        handler.send_response.assert_called_once_with(200)
                        handler.send_header.assert_any_call("Content-Type", expected)
                        self.assertEqual(handler.wfile.getvalue(), source.read_bytes())


class CollectAssetsCoverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / "site" / "data"
        self.thumbs = self.root / "site" / "images"
        self.originals = self.root / "originals"
        self.data.mkdir(parents=True)
        self.thumbs.mkdir(parents=True)
        self.originals.mkdir()
        for name, value in (("DATA_DIR", self.data), ("THUMB_DIR", self.thumbs), ("ORIG_DIR", self.originals)):
            patcher = patch.object(sync_r2, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.write_json("codexes.json", [])

    def write_json(self, filename, value):
        path = self.data / filename
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def book(self, cid="demo", **extra):
        value = {"id": cid, "entryCount": 0, "imagedCount": 0, "entries": [], **extra}
        self.write_json(cid + ".json", value)
        return value

    def picture(self, cid, filename, original=False):
        path = (self.originals if original else self.thumbs) / cid / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (12, 18), "navy").save(path)
        return path

    def test_standalone_root_cover_is_collected_without_synthetic_entry_or_metadata_write(self):
        cover = self.picture("demo", "cover-winter.png")
        self.book(cover=cover.name, coverRev="manual-cover-revision")
        before = (self.data / "demo.json").read_bytes()
        assets, issues, changed, stats = sync_r2.collect_assets()
        self.assertEqual(assets, [("image", "demo", cover.name, cover, sync_r2.sha256_hex(cover))])
        self.assertEqual(issues, [])
        self.assertEqual(changed, [])
        self.assertEqual(stats, {"hit": 0, "miss": 1})
        self.assertEqual((self.data / "demo.json").read_bytes(), before)

    def test_index_only_cover_uses_borrowed_asset_owner(self):
        cover = self.picture("legacy", "selector.png")
        self.book()
        self.write_json("codexes.json", [{"id": "demo", "cover": cover.name, "coverCodexId": "legacy"}])
        assets, issues, _, _ = sync_r2.collect_assets()
        self.assertEqual(assets[0][1:4], ("legacy", "selector.png", cover))
        self.assertEqual(len(assets), 1)
        self.assertEqual(issues, [])

    def test_distinct_root_and_index_covers_are_both_collected(self):
        self.picture("demo", "root.png")
        self.picture("demo", "selector.png")
        self.book(cover="root.png")
        self.write_json("codexes.json", [{"id": "demo", "cover": "selector.png"}])
        assets, issues, _, _ = sync_r2.collect_assets()
        self.assertEqual([asset[2] for asset in assets], ["root.png", "selector.png"])
        self.assertEqual(issues, [])

    def test_cover_references_deduplicate_and_leave_entry_revision_unchanged(self):
        thumb = self.picture("demo", "demo-0001.jpg")
        original = self.picture("demo", "demo-0001.png", original=True)
        secondary = self.picture("demo", "demo-0001-02.jpg")
        secondary_original = self.picture("demo", "demo-0001-02.png", original=True)
        revision = sync_r2.rev_from_hashes([sync_r2.sha256_hex(p) for p in (thumb, original, secondary, secondary_original)])
        entry = {"id": "demo-0001", "tags": "coat", "image": thumb.name, "original": original.name,
                 "imageWidth": 12, "imageHeight": 18, "assetRev": revision,
                 "images": [{"path": thumb.name, "original": original.name},
                            {"path": secondary.name, "original": secondary_original.name}]}
        self.book(cover=thumb.name, coverRev=revision, entryCount=1, imagedCount=1, entries=[entry])
        self.write_json("codexes.json", [{"id": "demo", "entryCount": 1, "imagedCount": 1,
                                          "cover": secondary.name, "coverRev": revision},
                                         {"id": "borrower", "cover": thumb.name, "coverCodexId": "demo"}])
        assets, issues, changed, stats = sync_r2.collect_assets(apply_metadata=True)
        self.assertEqual(len(assets), 4)
        self.assertEqual(len({(a[0], a[1], a[2]) for a in assets}), 4)
        self.assertEqual(issues, [])
        self.assertEqual(changed, [])
        self.assertEqual(stats, {"hit": 0, "miss": 4})
        self.assertEqual(sync_r2.load_json(self.data / "demo.json")["entries"], [entry])
        self.assertEqual(sync_r2.load_json(self.data / "demo.json")["coverRev"], revision)

    def test_external_and_relative_mode_covers_are_not_local_uploads(self):
        self.book(cover="https://example.com/cover.png")
        self.write_json("codexes.json", [
            {"id": "a", "cover": "HTTP://example.com/cover.png"},
            {"id": "b", "cover": "data:image/png;base64,AA=="},
            {"id": "c", "cover": "//example.com/cover.png"},
            {"id": "d", "cover": "images/cover.png", "assetPathMode": "relative", "assetBaseUrl": "https://example.com"},
        ])
        assets, issues, _, stats = sync_r2.collect_assets()
        self.assertEqual(assets, [])
        self.assertEqual(issues, [])
        self.assertEqual(stats, {"hit": 0, "miss": 0})

    def test_index_data_url_implies_relative_cover_paths(self):
        self.book()
        self.write_json("codexes.json", [{"id": "demo", "cover": "images/cover.png",
                                          "dataUrl": "https://example.com/data.json"}])
        assets, issues, _, _ = sync_r2.collect_assets()
        self.assertEqual(assets, [])
        self.assertEqual(issues, [])

    def test_index_external_metadata_applies_to_root_cover(self):
        self.book(cover="images/cover.png", assetPathMode="codex")
        self.write_json("codexes.json", [{"id": "demo", "assetPathMode": "relative",
                                          "assetBaseUrl": "https://example.com"}])
        assets, issues, _, _ = sync_r2.collect_assets()
        self.assertEqual(assets, [])
        self.assertEqual(issues, [])

    def test_explicit_index_codex_mode_overrides_root_relative_and_data_url(self):
        cover = self.picture("demo", "cover.png")
        self.book(cover=cover.name, assetPathMode="relative")
        self.write_json("codexes.json", [{"id": "demo", "assetPathMode": "codex",
                                          "dataUrl": "https://example.com/data.json"}])
        assets, issues, _, _ = sync_r2.collect_assets()
        self.assertEqual(assets[0][1:4], ("demo", cover.name, cover))
        self.assertEqual(len(assets), 1)
        self.assertEqual(issues, [])

    def test_missing_cover_reports_once_across_root_and_index(self):
        self.book(cover="missing.png")
        self.write_json("codexes.json", [{"id": "demo", "cover": "missing.png"}])
        assets, issues, changed, _ = sync_r2.collect_assets()
        self.assertEqual(assets, [])
        self.assertEqual(issues, ["missing cover: demo/missing.png"])
        self.assertEqual(changed, [])

    def test_cover_hash_cache_uses_configured_image_prefix(self):
        cover = self.picture("demo", "cover.png")
        self.book(cover=cover.name)
        sha = sync_r2.sha256_hex(cover)
        manifest = {"art/demo/cover.png": sync_r2.manifest_entry(cover, sha)}
        with patch.object(sync_r2, "sha256_hex", side_effect=AssertionError("cache was not used")):
            assets, issues, _, stats = sync_r2.collect_assets(cfg={"image_prefix": "art"}, manifest_objects=manifest)
        self.assertEqual(assets[0][-1], sha)
        self.assertEqual(issues, [])
        self.assertEqual(stats, {"hit": 1, "miss": 0})

    def test_cover_cannot_escape_its_local_cache_directory(self):
        self.book(cover="../../private.txt")
        assets, issues, _, _ = sync_r2.collect_assets()
        self.assertEqual(assets, [])
        self.assertEqual(issues, ["invalid cover path: demo/../../private.txt"])


class R2IncompleteResponseTests(unittest.TestCase):
    def config(self):
        return {"account_id": "test", "access_key_id": "test", "secret_access_key": "test",
                "bucket": "test", "image_prefix": "images", "original_prefix": "originals",
                "request_retries": 2, "retry_base_delay": 0}

    def response(self, body, truncate=False):
        # Exercise the same HTTPResponse.read() failure seen on the real R2 request.
        wire_body = body[:-7] if truncate else body
        wire = b"HTTP/1.1 200 OK\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + wire_body
        response = http.client.HTTPResponse(Mock(makefile=Mock(return_value=io.BytesIO(wire))))
        response.begin()
        return response

    def page(self, name, token=""):
        return (f'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                f'<Contents><Key>images/{name}.jpg</Key><Size>10</Size></Contents>'
                f'<IsTruncated>{str(bool(token)).lower()}</IsTruncated>'
                f'<NextContinuationToken>{token}</NextContinuationToken></ListBucketResult>').encode()

    def test_incomplete_second_page_retries_same_cursor_and_keeps_all_objects(self):
        first, second = self.page("first", "next-page"), self.page("second")
        with patch.object(sync_r2.urllib.request, "urlopen", side_effect=[
            self.response(first), self.response(second, truncate=True), self.response(second),
        ]) as urlopen, redirect_stdout(io.StringIO()) as output:
            objects = sync_r2.R2Client(self.config()).list_objects_v2("images")
        self.assertEqual(set(objects), {"images/first.jpg", "images/second.jpg"})
        requests = [call.args[0] for call in urlopen.call_args_list]
        self.assertEqual(len(requests), 3)
        self.assertNotIn("continuation-token", requests[0].full_url)
        self.assertIn("continuation-token=next-page", requests[1].full_url)
        self.assertEqual(requests[1].full_url, requests[2].full_url)
        self.assertTrue(all(request.get_method() == "GET" for request in requests))
        self.assertIn("request retry 1/2", output.getvalue())
        self.assertIn("IncompleteRead", output.getvalue())

    def test_repeated_incomplete_listing_stops_before_upload_or_manifest_write(self):
        body = self.page("first")
        args = SimpleNamespace(dry_run=False, check_only=False, verbose=False)
        with patch.object(sync_r2.urllib.request, "urlopen", side_effect=[
            self.response(body, truncate=True) for _ in range(3)
        ]) as urlopen, patch.object(sync_r2.R2Client, "put_file") as upload, \
                patch.object(sync_r2, "write_manifest") as manifest, redirect_stdout(io.StringIO()):
            with self.assertRaises(http.client.IncompleteRead):
                sync_r2.sync_assets(args, self.config(), [], manifest_objects={})
        self.assertEqual(urlopen.call_count, 3)
        upload.assert_not_called()
        manifest.assert_not_called()


class LocalServer:
    """Loopback TCP server; each accepted connection runs `handle(conn)` in its own thread."""

    def __init__(self, test, handle, receive_buffer=None):
        self.listener = socket.socket()
        if receive_buffer:
            self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, receive_buffer)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(8)
        self.port = self.listener.getsockname()[1]
        self.connections = []
        self.handle = handle
        threading.Thread(target=self._accept, daemon=True).start()
        test.addCleanup(self.close)

    def _accept(self):
        while True:
            try:
                conn, _ = self.listener.accept()
            except OSError:
                return
            self.connections.append(conn)
            threading.Thread(target=self._run, args=(conn,), daemon=True).start()

    def _run(self, conn):
        try:
            self.handle(conn)
        except OSError:
            pass  # the client gave up and cleanup closed the socket

    def close(self):
        self.listener.close()
        for conn in self.connections:
            conn.close()


class R2NetworkStallTests(unittest.TestCase):
    def config(self, **extra):
        return {"account_id": "test", "access_key_id": "test", "secret_access_key": "test",
                "bucket": "test", "image_prefix": "images", "original_prefix": "originals",
                "retry_base_delay": 0, **extra}

    def client(self, endpoint, **extra):
        client = sync_r2.R2Client(self.config(**extra))
        client.endpoint = endpoint
        return client

    def test_defaults_give_up_on_a_stall_quickly_and_retry_more(self):
        client = sync_r2.R2Client({"account_id": "test", "access_key_id": "test",
                                   "secret_access_key": "test", "bucket": "test"})
        self.assertEqual((client.request_timeout, client.request_retries), (30.0, 8))
        self.assertEqual(sync_r2.DEFAULT_UPLOAD_RETRIES, 6)
        self.assertEqual([sync_r2.retry_delay(1.0, n) for n in range(1, 8)], [1, 2, 4, 8, 10, 10, 10])
        self.assertEqual(sync_r2.retry_delay(0, 5), 0)

    def test_dropped_connection_is_not_reported_as_a_missing_file(self):
        dropped = urllib.error.URLError(FileNotFoundError(2, "No such file or directory"))
        self.assertIn("connection dropped by network or proxy", sync_r2.describe_request_error(dropped))
        stalled = urllib.error.URLError(TimeoutError("_ssl.c:990: The handshake operation timed out"))
        self.assertIn("network stalled past the request timeout", sync_r2.describe_request_error(stalled))
        local = FileNotFoundError(2, "No such file or directory", "originals/demo/demo-0001.png")
        self.assertEqual(sync_r2.describe_request_error(local), str(local))

    def test_silent_tls_handshake_is_abandoned_at_the_request_timeout(self):
        # Accept TCP but never answer the TLS ClientHello, like a stalled direct route.
        server = LocalServer(self, lambda conn: None)
        client = self.client(f"https://127.0.0.1:{server.port}", request_timeout=0.3, request_retries=1)
        started = time.monotonic()
        with redirect_stdout(io.StringIO()) as output, self.assertRaises(urllib.error.URLError):
            client.head("images/demo/demo-0001.jpg")
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(len(server.connections), 2)
        self.assertIn("request retry 1/1 HEAD images/demo/demo-0001.jpg: network stalled", output.getvalue())

    def test_connection_closed_mid_handshake_is_named_as_a_network_drop(self):
        def close_after_client_hello(conn):
            conn.recv(4096)
            conn.close()

        server = LocalServer(self, close_after_client_hello)
        client = self.client(f"https://127.0.0.1:{server.port}", request_timeout=5, request_retries=1)
        with redirect_stdout(io.StringIO()) as output, self.assertRaises(urllib.error.URLError):
            client.head("images/demo/demo-0001.jpg")
        self.assertIn("connection dropped by network or proxy", output.getvalue())

    def test_upload_slower_than_the_request_timeout_still_completes(self):
        body = b"x" * (1024 * 1024)
        received = []

        def drain_slowly(conn):
            data = b""
            while b"\r\n\r\n" not in data:
                data += conn.recv(4096)
            head, _, rest = data.partition(b"\r\n\r\n")
            length = int(next(line.split(b":")[1] for line in head.split(b"\r\n")
                              if line.lower().startswith(b"content-length:")))
            got = len(rest)
            while got < length:
                chunk = conn.recv(16 * 1024)
                if not chunk:
                    break
                got += len(chunk)
                time.sleep(len(chunk) / (512 * 1024))
            received.append(got)
            conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")

        # Small socket buffers on both ends make loopback behave like a slow uplink:
        # the client can only write as fast as the server reads.
        server = LocalServer(self, drain_slowly, receive_buffer=16 * 1024)
        client = self.client(f"http://127.0.0.1:{server.port}", request_timeout=0.5)
        connect = socket.create_connection

        def connect_with_small_send_buffer(*args, **kwargs):
            sock = connect(*args, **kwargs)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 16 * 1024)
            return sock

        started = time.monotonic()
        with patch("socket.create_connection", connect_with_small_send_buffer):
            status, _headers, _body = client.put_bytes(
                "originals/demo/demo-0001.png", body, hashlib.sha256(body).hexdigest(), "image/png", "no-store")
        self.assertEqual((status, received), (200, [len(body)]))
        # One sendall() of the whole body would have hit the 0.5s timeout long before this.
        self.assertGreater(time.monotonic() - started, 1.0)

    def test_upload_progress_is_reported_in_small_steps(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            assets = []
            for index in range(30):
                path = root / f"demo-{index:04d}.jpg"
                path.write_bytes(b"image %d" % index)
                assets.append(("image", "demo", path.name, path, sync_r2.sha256_hex(path)))
            args = SimpleNamespace(dry_run=False, check_only=False, verbose=False, workers=4, retries=0,
                                   retry_base_delay=0, request_timeout=None, request_retries=None)
            with patch.object(sync_r2, "R2Client") as client_class, \
                    patch.object(sync_r2, "list_remote_objects", return_value={}), \
                    patch.object(sync_r2, "MANIFEST_PATH", root / "manifest.json"), \
                    redirect_stdout(io.StringIO()) as output:
                client_class.return_value.put_file.return_value = (200, {}, b"")
                counts, failures = sync_r2.sync_assets(args, self.config(), assets, manifest_objects={})
        self.assertEqual((counts["upload"], failures), (30, []))
        progress = [line for line in output.getvalue().splitlines() if line.startswith("upload progress")]
        self.assertEqual(progress, ["upload progress: 25/30, fail 0", "upload progress: 30/30, fail 0"])


if __name__ == "__main__":
    unittest.main()
