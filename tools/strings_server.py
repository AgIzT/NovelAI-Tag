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
import http.server, socketserver, json, os, io, re, threading, urllib.parse, time
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
DATA = os.path.join(SITE, "data")
EDITOR_HTML = os.path.join(os.path.dirname(__file__), "strings_editor.html")
STRINGS_INDEX = os.path.join(DATA, "strings_index.json")
MAXDIM = 1100
PORT = 8768
LOCK = threading.Lock()
SAFE_ENTRY_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


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
            elif action == "new-collection":
                self._handle_new_collection()
            elif action == "delete-collection":
                self._handle_delete_collection()
            else:
                self.send_error(404)
            return
        self.send_error(404)

    def _resolve_file(self, qs):
        fn = qs.get("file", ["strings.json"])[0]
        fn = os.path.basename(fn)
        if not fn.endswith(".json"):
            raise ValueError("invalid file")
        return os.path.join(DATA, fn)

    def _handle_save(self):
        try:
            qs = urllib.parse.parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            target = self._resolve_file(qs)
            ln = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(ln))
            self._normalize_images(data)
            with LOCK:
                with open(target, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
            self._serve_json({"ok": True})
        except Exception as ex:
            self._serve_json({"ok": False, "error": str(ex)}, 500)

    def _normalize_images(self, data):
        for e in data.get("entries", []):
            imgs = e.get("images")
            if not imgs:
                continue
            for i, img in enumerate(imgs):
                if isinstance(img, str):
                    imgs[i] = {"file": img, "label": "gallery"}

    def _handle_new_collection(self):
        try:
            ln = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(ln))
            name = body.get("name", "").strip()
            if not name:
                self._serve_json({"ok": False, "error": "名称不能为空"}, 400)
                return

            fid = "str_" + hex(int(time.time() * 1000) % 0xFFFFF)[2:]
            fn = f"strings_{fid}.json"
            fp = os.path.join(DATA, fn)
            if os.path.exists(fp):
                self._serve_json({"ok": False, "error": "该名称对应的文件已存在，换个名字试试"}, 400)
                return

            scaffold = {
                "title": name,
                "author": "",
                "categories": [],
                "entries": []
            }
            with LOCK:
                with open(fp, "w", encoding="utf-8") as f:
                    json.dump(scaffold, f, ensure_ascii=False, indent=2)

                idx_data = {"collections": []}
                if os.path.exists(STRINGS_INDEX):
                    with open(STRINGS_INDEX, "r", encoding="utf-8") as f:
                        idx_data = json.load(f)
                idx_data.setdefault("collections", []).append({
                    "id": fid,
                    "name": name,
                    "author": "",
                    "file": fn
                })
                with open(STRINGS_INDEX, "w", encoding="utf-8") as f:
                    json.dump(idx_data, f, ensure_ascii=False, indent=2)

            self._serve_json({"ok": True, "file": fn, "name": name})
        except Exception as ex:
            self._serve_json({"ok": False, "error": str(ex)}, 500)

    def _handle_delete_collection(self):
        try:
            ln = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(ln))
            target_file = body.get("file", "").strip()
            if not target_file:
                self._serve_json({"ok": False, "error": "缺少 file 参数"}, 400)
                return
            target_file = os.path.basename(target_file)
            if not target_file.endswith(".json") or target_file == "strings_index.json":
                self._serve_json({"ok": False, "error": "invalid file"}, 400)
                return

            fp = os.path.join(DATA, target_file)
            with LOCK:
                if os.path.exists(STRINGS_INDEX):
                    with open(STRINGS_INDEX, "r", encoding="utf-8") as f:
                        idx_data = json.load(f)
                    idx_data["collections"] = [c for c in idx_data.get("collections", []) if c.get("file") != target_file]
                    with open(STRINGS_INDEX, "w", encoding="utf-8") as f:
                        json.dump(idx_data, f, ensure_ascii=False, indent=2)

                if os.path.exists(fp):
                    os.remove(fp)

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
            label = "gallery"
            target_file = "strings.json"

            for part in parts:
                name = part.get("name")
                if name == "image" and "data" in part:
                    image_data = part["data"]
                elif name == "entryId":
                    entry_id = part["data"].decode("utf-8").strip()
                elif name == "existingImages":
                    existing_images = json.loads(part["data"].decode("utf-8"))
                elif name == "label":
                    label = part["data"].decode("utf-8")
                elif name == "stringsFile":
                    target_file = part["data"].decode("utf-8")

            if not image_data or not entry_id:
                self._serve_json({"ok": False, "error": "缺少参数"}, 400)
                return
            if not SAFE_ENTRY_ID.fullmatch(entry_id):
                self._serve_json({"ok": False, "error": "invalid entryId"}, 400)
                return

            target_file = os.path.basename(target_file)
            if not target_file.endswith(".json"):
                self._serve_json({"ok": False, "error": "invalid file"}, 400)
                return
            target = os.path.join(DATA, target_file)

            ext = self._guess_ext(image_data)
            tdir = os.path.join(SITE, "images", "strings")
            os.makedirs(tdir, exist_ok=True)
            tn = f"{entry_id}_{len(existing_images):02d}.jpg"
            tp = os.path.abspath(os.path.join(tdir, tn))
            base = os.path.abspath(tdir)
            if not (tp == base or tp.startswith(base + os.sep)):
                self._serve_json({"ok": False, "error": "invalid image path"}, 400)
                return

            im = Image.open(io.BytesIO(image_data))
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            im.thumbnail((MAXDIM, MAXDIM), Image.LANCZOS)
            im.save(tp, "JPEG", quality=86, optimize=True)

            existing_images.append({"file": tn, "label": label})

            with LOCK:
                if os.path.exists(target):
                    with open(target, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    for e in data.get("entries", []):
                        if e.get("id") == entry_id:
                            e["images"] = existing_images
                            break
                    with open(target, "w", encoding="utf-8") as f:
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
