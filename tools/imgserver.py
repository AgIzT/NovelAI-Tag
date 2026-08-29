# -*- coding: utf-8 -*-
"""
配图工具的本地服务（端口 18767）：
  GET  /            → 画廊（site/ 静态文件）
  GET  /__pei__     → 配图工具页面
  POST /__upload__  → 接收一张图：
                       · 原图原样存到 originals/<codexId>/<entryId>.<ext>（不重新编码，保留元数据；已 gitignore）
                       · Pillow 压缩成缩略图 site/images/<codexId>/<entryId>.jpg（本地缓存，发布到 R2）
                       · 更新 site/data/<codexId>.json 的 entry.image / original / assetRev
用法：python tools/imgserver.py  （或双击 配图工具.bat）
"""
import http.server, socketserver, json, base64, io, os, threading, hashlib, mimetypes, urllib.parse, re, tempfile
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
DATA = os.path.join(SITE, "data")
INDEX = os.path.join(DATA, "codexes.json")
ORIG = os.path.join(ROOT, "originals")     # 原图（本地保留，不进仓库）
TOOL_HTML = os.path.join(os.path.dirname(__file__), "pei.html")
MAXDIM = 1100          # 缩略图最长边压到 1100px
PORT = 18767
LOCK = threading.Lock()
SAFE_PATH_COMPONENT = re.compile(r"^[A-Za-z0-9_-]+$")
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}


def _is_loopback_origin(origin):
    if not origin:
        return True
    try:
        host = urllib.parse.urlsplit(origin).hostname or ""
    except ValueError:
        host = ""
    return host in LOOPBACK_HOSTS


def _safe_component(value, label):
    if not isinstance(value, str) or not SAFE_PATH_COMPONENT.fullmatch(value):
        raise ValueError(f"invalid {label}")
    return value


def _safe_child_path(directory, *parts):
    base = os.path.abspath(directory)
    target = os.path.abspath(os.path.join(base, *parts))
    if not (target == base or target.startswith(base + os.sep)):
        raise ValueError("invalid output path")
    return target


def _hash_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _asset_rev(*paths):
    h = hashlib.sha256()
    for path in paths:
        if path and os.path.exists(path):
            h.update(_hash_file(path).encode("ascii"))
    return h.hexdigest()[:16]


def _ext_from_dataurl(durl):
    """从 data URL 里取原始扩展名，如 data:image/png;base64,... -> png"""
    try:
        mime = durl[5:durl.index(";")]          # image/png
        ext = mime.split("/")[-1].lower()
    except Exception:
        ext = "png"
    return {"jpeg": "jpg", "svg+xml": "svg"}.get(ext, ext) or "png"


def _write_json_like(path, data):
    try:
        with open(path, encoding="utf-8") as f:
            before = f.read(256)
    except Exception:
        before = ""
    kwargs = {"ensure_ascii": False}
    if before.startswith('{"id":"') or before.startswith("[{"):
        kwargs["separators"] = (",", ":")
    _atomic_write_json(path, data, **kwargs)


def _atomic_write_json(path, data, **kwargs):
    fd, tmp_name = tempfile.mkstemp(
        prefix=os.path.basename(path) + ".", suffix=".tmp", dir=os.path.dirname(path)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, **kwargs)
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _atomic_write_text(path, text):
    fd, tmp_name = tempfile.mkstemp(
        prefix=os.path.basename(path) + ".", suffix=".tmp", dir=os.path.dirname(path)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _update_index_counts(cid, entry_count, imaged_count):
    ip = INDEX
    if not os.path.exists(ip):
        return
    with open(ip, encoding="utf-8") as f:
        text = f.read()

    id_pos = text.find(f'"id": "{cid}"')
    if id_pos == -1:
        with open(ip, encoding="utf-8") as f:
            index = json.load(f)
        for item in index:
            if item.get("id") == cid:
                item["imagedCount"] = imaged_count
                item["entryCount"] = entry_count
                break
        _atomic_write_json(ip, index, ensure_ascii=False, indent=2)
        return

    start = text.rfind("  {", 0, id_pos)
    end = text.find("\n  }", id_pos)
    if start == -1 or end == -1:
        raise ValueError(f"Could not locate codexes.json block for {cid}")
    end += len("\n  }")
    block = text[start:end]
    block = re.sub(r'("entryCount":\s*)\d+', lambda m: m.group(1) + str(entry_count), block, count=1)
    block = re.sub(r'("imagedCount":\s*)\d+', lambda m: m.group(1) + str(imaged_count), block, count=1)
    _atomic_write_text(ip, text[:start] + block + text[end:])


def save_image(cid, eid, durl):
    """存原图(原样) + 缩略图, 并更新法典 JSON。返回结果 dict。"""
    cid = _safe_component(cid, "codexId")
    eid = _safe_component(eid, "entryId")
    raw = base64.b64decode(durl.split(",", 1)[1])
    ext = _safe_component(_ext_from_dataurl(durl), "image extension")
    with LOCK:
        jp = _safe_child_path(DATA, cid + ".json")
        with open(jp, encoding="utf-8") as f:
            d = json.load(f)
        target = next((e for e in d["entries"] if e["id"] == eid), None)
        if target is None:
            raise ValueError(f"Unknown entry id for {cid}: {eid}")

        with Image.open(io.BytesIO(raw)) as source:
            source.load()
            im = source.copy()

        # 1) 原图：原始字节直接落盘，不经 Pillow 重编码（保留 NAI 在 PNG 里的元数据）
        odir = _safe_child_path(ORIG, cid)
        os.makedirs(odir, exist_ok=True)
        ofn = eid + "." + ext
        op = _safe_child_path(odir, ofn)
        with open(op, "wb") as f:
            f.write(raw)

        # 2) 缩略图：压到 MAXDIM，存 JPEG（展示/部署用）
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        im.thumbnail((MAXDIM, MAXDIM), Image.LANCZOS)
        thumb_w, thumb_h = im.size
        tdir = _safe_child_path(os.path.join(SITE, "images"), cid)
        os.makedirs(tdir, exist_ok=True)
        tfn = eid + ".jpg"
        tp = _safe_child_path(tdir, tfn)
        im.save(tp, "JPEG", quality=86, optimize=True)
        rev = _asset_rev(tp, op)

        # 3) 更新 JSON（entry.image 指向缩略图，沿用旧字段）
        for e in d["entries"]:
            if e["id"] == eid:
                e["image"] = tfn
                e["imageWidth"] = thumb_w
                e["imageHeight"] = thumb_h
                e["original"] = ofn
                e["assetRev"] = rev
                e.pop("assetCodexId", None)
                break
        d["imagedCount"] = sum(1 for e in d["entries"] if e.get("image"))
        _write_json_like(jp, d)
        _update_index_counts(cid, d.get("entryCount", len(d["entries"])), d["imagedCount"])

    return {
        "ok": True,
        "image": tfn,
        "imageWidth": thumb_w,
        "imageHeight": thumb_h,
        "original": ofn,
        "assetRev": rev,
        "imagedCount": d["imagedCount"],
    }


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=SITE, **k)

    def end_headers(self):
        if self.path.endswith(".json"):          # 配图后刷新能立刻看到
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/__pei__":
            try:
                with open(TOOL_HTML, "rb") as f:
                    body = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as ex:
                self.send_error(500, str(ex))
            return
        if self.path.split("?")[0].startswith("/originals/"):
            return self._serve_original()
        return super().do_GET()

    def _serve_original(self):
        rel = urllib.parse.unquote(self.path.split("?", 1)[0].lstrip("/"))
        rel = rel.replace("/", os.sep)
        target = os.path.abspath(os.path.join(ROOT, rel))
        base = os.path.abspath(ORIG)
        if not (target == base or target.startswith(base + os.sep)):
            self.send_error(403)
            return
        if not os.path.isfile(target):
            self.send_error(404)
            return
        try:
            with open(target, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(target)[0] or "application/octet-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as ex:
            self.send_error(500, str(ex))

    def do_POST(self):
        if self.path != "/__upload__":
            self.send_error(404); return
        if not _is_loopback_origin(self.headers.get("Origin")):
            self._json({"ok": False, "error": "只接受本机页面的写请求"}, 403)
            return
        try:
            ln = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(ln))
            res = save_image(data["codexId"], data["entryId"], data["dataURL"])
            self._json(res)
        except Exception as ex:
            self._json({"ok": False, "error": str(ex)}, 500)

    def _json(self, obj, code=200):
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
        print(f"配图工具已启动 -> http://localhost:{PORT}/__pei__")
        print(f"画廊预览       -> http://localhost:{PORT}/")
        print(f"原图保留在     -> {ORIG}\\<法典id>\\（已 gitignore，不进仓库）")
        s.serve_forever()
