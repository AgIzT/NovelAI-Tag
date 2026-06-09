# -*- coding: utf-8 -*-
"""
画师串编辑器本地服务（端口 8768）：
  GET  /                → 画师串画廊（strings.html）
  GET  /__editor__      → 编辑器页面
  GET  /__strings__     → 编辑器 API
  POST /__strings__?action=save   → 保存 strings.json
  POST /__strings__?action=upload → 上传图片并压缩
用法：python tools/strings_server.py
"""
import http.server, socketserver, json, os, io, threading, urllib.parse
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
DATA = os.path.join(SITE, "data")
STRINGS_JSON = os.path.join(DATA, "strings.json")
EDITOR_HTML = os.path.join(os.path.dirname(__file__), "strings_editor.html")
MAXDIM = 1100
PORT = 8768
LOCK = threading.Lock()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=SITE, **k)

    def end_headers(self):
        if self.path.endswith(".json"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/__editor__":
            self._serve_file(EDITOR_HTML, "text/html; charset=utf-8")
            return
        if path == "/__strings__":
            self._serve_json({"version": 1})
            return
        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        qs = urllib.parse.parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
        action = qs.get("action", [""])[0]

        if path == "/__strings__":
            if action == "save":
                self._handle_save()
            elif action == "upload":
                self._handle_upload()
            else:
                self.send_error(404)
            return
        self.send_error(404)

    def _handle_save(self):
        try:
            ln = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(ln))
            with LOCK:
                with open(STRINGS_JSON, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
            self._serve_json({"ok": True})
        except Exception as ex:
            self._serve_json({"ok": False, "error": str(ex)}, 500)

    def _handle_upload(self):
        try:
            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                self._serve_json({"ok": False, "error": "需要 multipart/form-data"}, 400)
                return

            boundary = content_type.split("boundary=")[1].encode() if "boundary=" in content_type else None
            if not boundary:
                self._serve_json({"ok": False, "error": "缺少 boundary"}, 400)
                return

            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))

            parts = self._parse_multipart(body, boundary)
            image_data = None
            entry_id = None
            existing_images = []

            for part in parts:
                name = part.get("name")
                if name == "image" and "data" in part:
                    image_data = part["data"]
                elif name == "entryId":
                    entry_id = part["data"].decode("utf-8")
                elif name == "existingImages":
                    existing_images = json.loads(part["data"].decode("utf-8"))

            if not image_data or not entry_id:
                self._serve_json({"ok": False, "error": "缺少参数"}, 400)
                return

            ext = self._guess_ext(image_data)
            tdir = os.path.join(SITE, "images", "strings")
            os.makedirs(tdir, exist_ok=True)
            tn = f"{entry_id}_{len(existing_images):02d}.jpg"
            tp = os.path.join(tdir, tn)

            im = Image.open(io.BytesIO(image_data))
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            im.thumbnail((MAXDIM, MAXDIM), Image.LANCZOS)
            im.save(tp, "JPEG", quality=86, optimize=True)

            existing_images.append(tn)

            with LOCK:
                if os.path.exists(STRINGS_JSON):
                    with open(STRINGS_JSON, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    for e in data.get("entries", []):
                        if e.get("id") == entry_id:
                            e["images"] = existing_images
                            break
                    with open(STRINGS_JSON, "w", encoding="utf-8") as f:
                        json.dump(data, f, ensure_ascii=False, indent=2)

            self._serve_json({"ok": True, "images": existing_images, "file": tn})
        except Exception as ex:
            self._serve_json({"ok": False, "error": str(ex)}, 500)

    def _parse_multipart(self, body, boundary):
        parts = []
        sep = b"--" + boundary
        sections = body.split(sep)
        for section in sections:
            if not section.strip() or section.strip() == b"--":
                continue
            header_end = section.find(b"\r\n\r\n")
            if header_end == -1:
                continue
            headers_raw = section[:header_end].decode("utf-8", errors="replace")
            data = section[header_end + 4:]
            if data.endswith(b"\r\n"):
                data = data[:-2]

            part = {"data": data}
            for line in headers_raw.split("\r\n"):
                if ":" in line:
                    k, v = line.split(":", 1)
                    k = k.strip().lower()
                    v = v.strip()
                    if k == "content-disposition":
                        for item in v.split(";"):
                            item = item.strip()
                            if "=" in item:
                                key, val = item.split("=", 1)
                                part[key.strip()] = val.strip().strip('"')
            parts.append(part)
        return parts

    def _guess_ext(self, data):
        if data[:4] == b"\x89PNG":
            return "png"
        if data[:2] in (b"\xff\xd8", b"\x00\x00"):
            return "jpg"
        if data[:6] in (b"GIF87a", b"GIF89a"):
            return "gif"
        return "jpg"

    def _serve_file(self, path, mime):
        try:
            with open(path, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as ex:
            self.send_error(500, str(ex))

    def _serve_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as s:
        print(f"NAI Prompt  -> http://localhost:{PORT}/strings.html")
        print(f"编辑器       -> http://localhost:{PORT}/__editor__")
        s.serve_forever()
