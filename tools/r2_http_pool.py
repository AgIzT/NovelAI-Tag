"""Bounded HTTPS transport; signing and retries remain in the R2 caller.

Only a fully consumed HTTP response may return its connection to the pool.
There is deliberately no retry here: a lost PUT response has an unknown outcome.
"""
import base64
import http.client
import io
import threading
import time
import urllib.parse
import urllib.request


def proxy_route(host):
    """Follow urllib's HTTPS proxy/bypass selection without exposing credentials."""
    proxies = urllib.request.getproxies()
    value = proxies.get("https")
    if not value or urllib.request.proxy_bypass(host):
        return None, None
    try:
        parsed = urllib.parse.urlsplit(value if "://" in value else "http://" + value)
        if parsed.scheme.lower() != "http":
            return None, "unsupported HTTPS proxy scheme; using urllib transport"
        if not parsed.hostname or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            return None, "unsupported HTTPS proxy address; using urllib transport"
        port = parsed.port or 80
        if not 0 < port <= 65535:
            raise ValueError("invalid port")
        authorization = None
        if parsed.username is not None:
            user = urllib.parse.unquote(parsed.username)
            password = urllib.parse.unquote(parsed.password or "")
            authorization = "Basic " + base64.b64encode((user + ":" + password).encode()).decode("ascii")
        return {"host": parsed.hostname, "port": port, "authorization": authorization}, None
    except (TypeError, ValueError):
        return None, "unsupported HTTPS proxy address; using urllib transport"


def https_connection(host, port, timeout, proxy):
    if proxy:
        connection = http.client.HTTPSConnection(proxy["host"], proxy["port"], timeout=timeout)
        headers = {}
        if proxy["authorization"]:
            headers["Proxy-Authorization"] = proxy["authorization"]
        connection.set_tunnel(host, port, headers=headers)
        return connection
    return http.client.HTTPSConnection(host, port, timeout=timeout)


class HTTPSConnectionPool:
    def __init__(self, host, *, max_connections=16, idle_timeout=60.0,
                 proxy=None, connection_factory=None):
        self.host = host
        self.max_connections = max(1, int(max_connections))
        self.idle_timeout = max(0.0, float(idle_timeout))
        self.proxy = proxy
        self._factory = connection_factory or https_connection
        self._condition = threading.Condition()
        self._idle = []
        self._total = 0
        self._in_use = 0
        self._closed = False
        self._metrics = {"connections_created": 0, "connections_reused": 0,
                         "connections_discarded": 0, "requests": 0,
                         "pool_waits": 0, "peak_in_use": 0}

    @staticmethod
    def _close(connection):
        try:
            connection.close()
        except OSError:
            pass

    def _acquire(self, timeout):
        deadline = time.monotonic() + timeout
        with self._condition:
            while True:
                if self._closed:
                    raise RuntimeError("R2 connection pool is closed")
                connection = None
                while self._idle:
                    candidate, returned_at = self._idle.pop()
                    if time.monotonic() - returned_at >= self.idle_timeout:
                        self._close(candidate)
                        self._total -= 1
                        self._metrics["connections_discarded"] += 1
                    else:
                        connection = candidate
                        self._metrics["connections_reused"] += 1
                        break
                if connection is not None or self._total < self.max_connections:
                    if connection is None:
                        self._total += 1
                    self._in_use += 1
                    self._metrics["peak_in_use"] = max(self._metrics["peak_in_use"], self._in_use)
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("R2 connection pool wait exceeded request timeout")
                self._metrics["pool_waits"] += 1
                self._condition.wait(remaining)
        if connection is None:
            try:
                connection = self._factory(self.host, 443, timeout, self.proxy)
            except BaseException:
                self._release(None, False)
                raise
            with self._condition:
                self._metrics["connections_created"] += 1
        return connection

    def _release(self, connection, reusable):
        with self._condition:
            self._in_use -= 1
            if connection is not None and reusable and not self._closed:
                self._idle.append((connection, time.monotonic()))
            else:
                if connection is not None:
                    self._close(connection)
                    self._metrics["connections_discarded"] += 1
                self._total -= 1
            self._condition.notify()

    def request(self, method, url, *, body=b"", headers=None, timeout=30.0):
        parsed = urllib.parse.urlsplit(url)
        # Test connections may be injected, but production destinations stay fixed.
        if (parsed.scheme != "https" or parsed.hostname != self.host or
                parsed.port not in (None, 443) or parsed.username or parsed.password or parsed.fragment):
            raise ValueError("pooled R2 requests must use their configured HTTPS origin")
        timeout = float(timeout)
        connection = self._acquire(timeout)
        reusable = False
        response = None
        try:
            connection.timeout = timeout
            if connection.sock is not None:
                connection.sock.settimeout(timeout)
            request_headers = dict(headers or {})
            # A BytesIO sends 8 KiB blocks, preserving the existing no-progress
            # timeout rather than making one large sendall a total upload timer.
            data = None if method == "HEAD" else body
            if data:
                if not any(name.lower() == "content-length" for name in request_headers):
                    request_headers["Content-Length"] = str(len(data))
                data = io.BytesIO(data)
            path = parsed.path or "/"
            if parsed.query:
                path += "?" + parsed.query
            with self._condition:
                self._metrics["requests"] += 1
            connection.request(method, path, body=data, headers=request_headers)
            response = connection.getresponse()
            response_headers = {name.lower(): value for name, value in response.getheaders()}
            response_body = response.read()
            close_tokens = response_headers.get("connection", "").lower().split(",")
            request_close = any(name.lower() == "connection" and "close" in str(value).lower().split(",")
                                for name, value in request_headers.items())
            reusable = (not response.will_close and connection.sock is not None and
                        "close" not in [token.strip() for token in close_tokens] and not request_close)
            return response.status, response_headers, response_body
        finally:
            try:
                if response is not None:
                    response.close()
            finally:
                self._release(connection, reusable)

    def metrics(self):
        with self._condition:
            return {**self._metrics, "max_connections": self.max_connections,
                    "in_use": self._in_use, "idle": len(self._idle), "open": self._total}

    def close(self):
        with self._condition:
            self._closed = True
            for connection, _returned_at in self._idle:
                self._close(connection)
                self._total -= 1
                self._metrics["connections_discarded"] += 1
            self._idle.clear()
            self._condition.notify_all()
