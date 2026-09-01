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
        request_path = self.path.split("?", 1)[0]
        if request_path == "/" or request_path.endswith((".html", ".json", ".js", ".css")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        request_path = self.path.split("?")[0]
        if request_path.startswith("/originals/"):
            return self._serve_original()
        if request_path.startswith("/share/"):
            return self._serve_app_shell()
        return super().do_GET()

    def _serve_app_shell(self):
        """词条深链 /share/<法典>/<词条> 在线上由 Pages Function 交付 App 外壳。

        本地预览只补上"能开、能刷新"这一半：注入 <base href="/"> 让子路径下的相对资源
        仍然指向站点根。OG 卡片要连分享索引，本地验卡请用 wrangler pages dev
        （见 docs/decisions/分享卡OG预览.md「维护」一节），别在这里复刻一份 Function 逻辑。
        """
        index = os.path.join(SITE, "index.html")
        if not os.path.isfile(index):
            self.send_error(404)
            return
        with open(index, "r", encoding="utf-8") as fh:
            html = fh.read()
        html = html.replace("<head>", '<head>\n<base href="/">', 1)
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
