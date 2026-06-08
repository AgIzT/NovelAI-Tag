# -*- coding: utf-8 -*-
"""Local preview server for site/ plus originals/ image cache."""
import argparse
import http.server
import mimetypes
import os
import socketserver
import urllib.parse


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
ORIG = os.path.join(ROOT, "originals")
PORT = 8766


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SITE, **kwargs)

    def end_headers(self):
        if self.path.endswith(".json"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?")[0].startswith("/originals/"):
            return self._serve_original()
        return super().do_GET()

    def _serve_original(self):
        rel = urllib.parse.unquote(self.path.split("?", 1)[0].lstrip("/")).replace("/", os.sep)
        target = os.path.abspath(os.path.join(ROOT, rel))
        base = os.path.abspath(ORIG)
        if not (target == base or target.startswith(base + os.sep)):
            self.send_error(403)
            return
        if not os.path.isfile(target):
            self.send_error(404)
            return
        with open(target, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(target)[0] or "application/octet-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()
    with Server(("127.0.0.1", args.port), Handler) as server:
        print(f"Preview -> http://localhost:{args.port}")
        server.serve_forever()
