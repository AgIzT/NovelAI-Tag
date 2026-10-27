# -*- coding: utf-8 -*-
"""
画师串编辑器本地服务（端口 18768）：
  GET  /                → 画师串画廊（strings.html）
  GET  /__editor__      → 编辑器页面
  GET  /__strings__     → 编辑器 API
  POST /__strings__?action=save   → 保存 strings.json
  POST /__strings__?action=upload → 上传图片并压缩
用法：python tools/strings_server.py
"""
import http.server, socketserver, json, os, io, re, threading, urllib.parse, time, tempfile, hashlib
from PIL import Image
try:
    from .local_file_transaction import atomic_write_bytes, run_file_transaction, TransactionError
except ImportError:
    from local_file_transaction import atomic_write_bytes, run_file_transaction, TransactionError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
DATA = os.path.join(SITE, "data")
EDITOR_HTML = os.path.join(os.path.dirname(__file__), "strings_editor.html")
STRINGS_INDEX = os.path.join(DATA, "strings_index.json")
MAXDIM = 1100
PORT = 18768
LOCK = threading.Lock()
SAFE_ENTRY_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
SAFE_COLLECTION_FILE = re.compile(r"^strings(?:_[A-Za-z0-9_-]+)?\.json$")
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}


def _is_loopback_origin(origin):
    if not origin:
        return True
    try:
        host = urllib.parse.urlsplit(origin).hostname or ""
    except ValueError:
        host = ""
    return host in LOOPBACK_HOSTS


def _collection_path(filename):
    if not isinstance(filename, str) or filename != os.path.basename(filename):
        raise ValueError("invalid file")
    if filename == "strings_index.json" or not SAFE_COLLECTION_FILE.fullmatch(filename):
        raise ValueError("invalid file")
    base = os.path.abspath(DATA)
    target = os.path.abspath(os.path.join(base, filename))
    if not target.startswith(base + os.sep):
        raise ValueError("invalid file")
    return target


def _atomic_write_json(path, data):
    atomic_write_bytes(path, _json_bytes(data))


def _json_bytes(data):
    return json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")


class WriteConflict(ValueError):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def _require_revision(expected, current):
    if current is not None and not expected:
        raise WriteConflict(428, "页面版本过旧，重新打开编辑器后再保存")
    if expected and (not re.fullmatch(r"[a-f0-9]{64}", expected) or expected != current):
        raise WriteConflict(409, "合集已被其它操作修改；保留当前草稿，重新载入后核对")


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
            qs = urllib.parse.parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            if qs.get("action") == ["read"]:
                self._handle_read(qs)
            else:
                self._serve_json({"version": 2})
            return
        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        qs = urllib.parse.parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
        action = qs.get("action", [""])[0]

        if path == "/__strings__":
            if not _is_loopback_origin(self.headers.get("Origin")):
                self._serve_json({"ok": False, "error": "只接受本机页面的写请求"}, 403)
                return
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
        return _collection_path(fn)

    def _handle_save(self):
        try:
            qs = urllib.parse.parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            try:
                target = self._resolve_file(qs)
            except ValueError:
                self._serve_json({"ok": False, "error": "invalid file"}, 400)
                return
            ln = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(ln))
            if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
                raise WriteConflict(400, "合集格式不正确，未保存")
            self._normalize_images(data)
            expected = (self.headers.get("If-Match") or "").strip('"')
            with LOCK:
                before = None
                if os.path.isfile(target):
                    with open(target, "rb") as stream:
                        before = stream.read()
                revision = hashlib.sha256(before).hexdigest() if before is not None else None
                desired = _json_bytes(data)
                # 已提交但响应丢失时，同一正文的重试只确认现有字节，不再写。
                if expected and re.fullmatch(r"[a-f0-9]{64}", expected) and before == desired:
                    result = {"ok": True, "revision": revision, "unchanged": True}
                else:
                    _require_revision(expected, revision)
                    _, backup_dir = run_file_transaction(os.path.dirname(SITE), [target],
                        lambda: _atomic_write_json(target, data), "strings-save")
                    result = {"ok": True, "revision": hashlib.sha256(desired).hexdigest(), "backupDir": backup_dir}
        except Exception as ex:
            self._write_error(ex)
            return
        self._serve_json(result)

    def _handle_read(self, qs):
        try:
            target = self._resolve_file(qs)
            with LOCK:
                with open(target, "rb") as stream:
                    raw = stream.read()
                data = json.loads(raw)
            if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
                raise WriteConflict(400, "合集格式不正确，未载入")
            result = {"ok": True, "file": os.path.basename(target), "data": data,
                      "revision": hashlib.sha256(raw).hexdigest()}
        except Exception as ex:
            self._write_error(ex)
            return
        self._serve_json(result)

    def _write_error(self, error):
        body = {"ok": False, "error": str(error)}
        if isinstance(error, TransactionError):
            body.update({"backupDir": error.backup_dir, "rollbackErrors": error.rollback_errors})
        self._serve_json(body, error.status if isinstance(error, WriteConflict) else 500)

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
            fp = _collection_path(fn)
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
                _atomic_write_json(fp, scaffold)

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
                _atomic_write_json(STRINGS_INDEX, idx_data)

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
            try:
                fp = _collection_path(target_file)
            except ValueError:
                self._serve_json({"ok": False, "error": "invalid file"}, 400)
                return

            with LOCK:
                if os.path.exists(STRINGS_INDEX):
                    with open(STRINGS_INDEX, "r", encoding="utf-8") as f:
                        idx_data = json.load(f)
                    idx_data["collections"] = [c for c in idx_data.get("collections", []) if c.get("file") != target_file]
                    _atomic_write_json(STRINGS_INDEX, idx_data)

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
            expected = ""

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
                elif name == "revision":
                    expected = part["data"].decode("ascii")

            if not image_data or not entry_id:
                self._serve_json({"ok": False, "error": "缺少参数"}, 400)
                return
            if not SAFE_ENTRY_ID.fullmatch(entry_id):
                self._serve_json({"ok": False, "error": "invalid entryId"}, 400)
                return

            try:
                target = _collection_path(target_file)
            except ValueError:
                self._serve_json({"ok": False, "error": "invalid file"}, 400)
                return

            tdir = os.path.join(SITE, "images", "strings")
            im = Image.open(io.BytesIO(image_data))
            im.load()
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            im.thumbnail((MAXDIM, MAXDIM), Image.LANCZOS)
            thumbnail = io.BytesIO()
            im.save(thumbnail, "JPEG", quality=86, optimize=True)
            payload = thumbnail.getvalue()
            # 删除旧图后再次添加也不会复用旧文件名，未保存的旧正文仍能读到原图。
            tn = f"{entry_id}_{hashlib.sha256(payload).hexdigest()}.jpg"
            tp = os.path.abspath(os.path.join(tdir, tn))
            base = os.path.abspath(tdir)
            if not (tp == base or tp.startswith(base + os.sep)):
                self._serve_json({"ok": False, "error": "invalid image path"}, 400)
                return

            if not isinstance(existing_images, list):
                raise WriteConflict(400, "图片列表格式不正确")
            existing_images.append({"file": tn, "label": label})

            with LOCK:
                with open(target, "rb") as stream:
                    raw = stream.read()
                revision = hashlib.sha256(raw).hexdigest()
                _require_revision(expected, revision)
                data = json.loads(raw)
                entry = next((e for e in data.get("entries", []) if e.get("id") == entry_id), None)
                if entry is not None:
                    entry["images"] = existing_images
                def commit():
                    atomic_write_bytes(tp, payload)
                    if entry is not None:
                        _atomic_write_json(target, data)
                _, backup_dir = run_file_transaction(os.path.dirname(SITE), [tp, target], commit, "strings-image")
                result = {"ok": True, "images": existing_images, "file": tn, "backupDir": backup_dir,
                          "revision": hashlib.sha256(_json_bytes(data)).hexdigest() if entry is not None else revision}
        except Exception as ex:
            self._write_error(ex)
            return
        self._serve_json(result)

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
        self.send_header("Cache-Control", "no-store")
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
