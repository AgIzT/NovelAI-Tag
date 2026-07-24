# -*- coding: utf-8 -*-
"""本地法典编辑服务器（P0）：主站"编辑模式"的后端。

用法：python tools/edit_server.py （或双击 单项工具/法典编辑器.bat）
浏览器打开 http://localhost:8769/ —— 主站探测到 /__edit__/ping 后自动加载编辑模块。

组成：
  · 静态服务 site/ + /originals/ 安全映射（同 preview_server，带 no-store）
  · EditStore —— 词条/图片写核心：备份 → 变更 → 重算 tree/计数 → 自检 → 原子写 → 同步索引
  · HTTP 层（三端点）：GET /__edit__/ping · POST /__edit__/entry · POST /__edit__/image

数据安全：
  · 只绑 127.0.0.1；写接口校验 Origin
  · 每次写盘前把单本 JSON + codexes.json 快照到 output/edit-backups/<时间戳>/
  · 原子写（同目录临时文件 + os.replace），并保持原文件的紧凑/缩进风格
  · 新词条发号 = max(editorMaxSeq, 现有最大序号) + 1，4 位零填充，删除的号永不复用
  · 外部源书（带 dataUrl，如 mengshen_r18）服务器端强制拒写
"""
import argparse
import base64
import hashlib
import http.server
import io
import json
import mimetypes
import os
import re
import shutil
import socketserver
import tempfile
import threading
import time
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8769
MAXDIM = 1100
ENTRY_MAX_BYTES = 512 * 1024
IMAGE_MAX_BYTES = 64 * 1024 * 1024
RATINGS = {"safe", "r18", "r18g", "restricted"}
IMAGE_FIELD_KEYS = ("image", "original", "assetRev", "imageWidth", "imageHeight", "assetCodexId")


class EditError(Exception):
    """带 HTTP 语义的业务错误：status + 机器码 code + 人话 message。"""

    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def build_tree(entries):
    """entries 的 path 数组 → 目录树 [{name,count,children[]}]（count=子树累计）。
    移植自 import_community_ai_misc.build_tree，语义不得改动。"""
    root = {}
    for entry in entries:
        node = root
        for name in entry["path"]:
            current = node.setdefault(name, {"name": name, "count": 0, "children": {}})
            current["count"] += 1
            node = current["children"]

    def serialize(node):
        return [
            {"name": value["name"], "count": value["count"], "children": serialize(value["children"])}
            for value in node.values()
        ]

    return serialize(root)


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
    try:
        mime = durl[5:durl.index(";")]
        ext = mime.split("/")[-1].lower()
    except Exception:
        ext = "png"
    return {"jpeg": "jpg", "svg+xml": "svg"}.get(ext, ext) or "png"


class EditStore:
    """全部写操作的核心；root 可注入以便单测在沙箱目录运行。"""

    def __init__(self, root=ROOT):
        self.root = root
        self.site = os.path.join(root, "site")
        self.data = os.path.join(self.site, "data")
        self.orig = os.path.join(root, "originals")
        self.sources = os.path.join(root, "法典源")
        self.backup_root = os.path.join(root, "output", "edit-backups")
        self.lock = threading.Lock()

    # ---------- 索引与能力 ----------

    def index_path(self):
        return os.path.join(self.data, "codexes.json")

    def read_index(self):
        with open(self.index_path(), encoding="utf-8") as f:
            return json.load(f)

    def codex_meta(self, cid):
        for item in self.read_index():
            if item.get("id") == cid:
                return item
        raise EditError(404, "not-found", f"未知法典：{cid}")

    @staticmethod
    def is_editable(meta):
        return not meta.get("dataUrl")

    def capabilities(self):
        editable, locked = [], {}
        for item in self.read_index():
            if self.is_editable(item):
                editable.append(item["id"])
            else:
                locked[item["id"]] = "external-data"
        return {
            "ok": True,
            "version": 1,
            "editable": editable,
            "locked": locked,
            "docxWarnings": self.docx_warnings(editable),
        }

    def docx_warnings(self, editable_ids):
        """法典源/ 里仍有 docx 的可编辑书（重转会覆盖手编）。best-effort：
        从 convert.py 文本抓 ID_MAP 的 文件名→id 映射，失败则返回空。"""
        try:
            docx_files = [
                fn for fn in os.listdir(self.sources)
                if fn.lower().endswith(".docx") and not fn.startswith("~$")
            ]
        except OSError:
            return []
        if not docx_files:
            return []
        mapping = {}
        try:
            with open(os.path.join(self.root, "tools", "convert.py"), encoding="utf-8") as f:
                text = f.read()
            for m in re.finditer(r'"([^"\n]+)"\s*:\s*"([A-Za-z0-9_]+)"', text):
                mapping[m.group(1)] = m.group(2)
        except OSError:
            pass
        warned = set()
        for fn in docx_files:
            stem = os.path.splitext(fn)[0]
            for key, cid in mapping.items():
                if cid in editable_ids and (key in fn or key in stem):
                    warned.add(cid)
        return sorted(warned)

    # ---------- JSON 读写（风格保持 + 原子） ----------

    def codex_path(self, cid):
        return os.path.join(self.data, cid + ".json")

    def read_codex(self, cid):
        path = self.codex_path(cid)
        if not os.path.isfile(path):
            raise EditError(404, "not-found", f"数据文件不存在：{cid}.json")
        with open(path, encoding="utf-8") as f:
            return path, json.load(f)

    @staticmethod
    def _detect_compact(path):
        try:
            with open(path, encoding="utf-8") as f:
                before = f.read(256)
        except OSError:
            before = ""
        return before.startswith('{"id":"') or before.startswith("[{")

    def atomic_write_json_styled(self, path, data):
        kwargs = {"ensure_ascii": False}
        if self._detect_compact(path):
            kwargs["separators"] = (",", ":")
        fd, tmp_name = tempfile.mkstemp(
            prefix=os.path.basename(path) + ".", suffix=".tmp", dir=os.path.dirname(path)
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, **kwargs)
            os.replace(tmp_name, path)
        except Exception:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

    def _atomic_write_text(self, path, text):
        fd, tmp_name = tempfile.mkstemp(
            prefix=os.path.basename(path) + ".", suffix=".tmp", dir=os.path.dirname(path)
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(text)
            os.replace(tmp_name, path)
        except Exception:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

    def make_backup(self, paths):
        os.makedirs(self.backup_root, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        target = os.path.join(self.backup_root, stamp)
        n = 1
        while os.path.exists(target):
            n += 1
            target = os.path.join(self.backup_root, f"{stamp}-{n:02d}")
        os.makedirs(target)
        for p in paths:
            if os.path.isfile(p):
                shutil.copy2(p, os.path.join(target, os.path.basename(p)))
        return os.path.relpath(target, self.root).replace(os.sep, "/")

    def _update_index_counts(self, cid, entry_count, imaged_count):
        """文本手术更新 codexes.json 该书的两个计数，其余部分逐字节不变。
        移植自 imgserver._update_index_counts。"""
        ip = self.index_path()
        if not os.path.exists(ip):
            return
        with open(ip, encoding="utf-8") as f:
            text = f.read()
        id_pos = text.find(f'"id": "{cid}"')
        if id_pos == -1:
            index = json.loads(text)
            for item in index:
                if item.get("id") == cid:
                    item["imagedCount"] = imaged_count
                    item["entryCount"] = entry_count
                    break
            self._atomic_write_text(ip, json.dumps(index, ensure_ascii=False, indent=2))
            return
        start = text.rfind("  {", 0, id_pos)
        end = text.find("\n  }", id_pos)
        if start == -1 or end == -1:
            raise EditError(500, "internal", f"codexes.json 中定位不到 {cid} 的块")
        end += len("\n  }")
        block = text[start:end]
        block = re.sub(r'("entryCount":\s*)\d+', lambda m: m.group(1) + str(entry_count), block, count=1)
        block = re.sub(r'("imagedCount":\s*)\d+', lambda m: m.group(1) + str(imaged_count), block, count=1)
        self._atomic_write_text(ip, text[:start] + block + text[end:])

    # ---------- 校验 ----------

    @staticmethod
    def compute_counts(entries):
        imaged = sum(1 for e in entries if e.get("image") or e.get("images"))
        return len(entries), imaged

    @staticmethod
    def validate_codex(data):
        """写盘前的完整性自检；失败即 409、不落盘。
        只查会破坏站点的结构性问题（id 唯一 / path 形状 / 计数与树一致），
        字段内容合法性在各操作入口单独把关。"""
        entries = data.get("entries")
        if not isinstance(entries, list):
            raise EditError(409, "self-check-failed", "entries 不是数组")
        seen = set()
        for e in entries:
            eid = e.get("id")
            if not isinstance(eid, str) or not eid:
                raise EditError(409, "self-check-failed", "存在缺失 id 的词条")
            if eid in seen:
                raise EditError(409, "self-check-failed", f"词条 id 重复：{eid}")
            seen.add(eid)
            path = e.get("path")
            if not isinstance(path, list) or not path or not all(isinstance(p, str) and p for p in path):
                raise EditError(409, "self-check-failed", f"词条 path 非法：{eid}")
        entry_count, imaged_count = EditStore.compute_counts(entries)
        if data.get("entryCount") != entry_count:
            raise EditError(409, "self-check-failed", "entryCount 与词条数不一致")
        if data.get("imagedCount") != imaged_count:
            raise EditError(409, "self-check-failed", "imagedCount 与配图数不一致")
        if data.get("tree") != build_tree(entries):
            raise EditError(409, "self-check-failed", "tree 与词条 path 不一致")

    # ---------- 写管线 ----------

    def mutate(self, cid, mutator):
        """统一写管线：锁 → 校验可编辑 → 备份 → 变更 → 重算 → 自检 → 原子写 → 同步索引。
        mutator(data) 返回被操作的词条（delete 返回 None）。"""
        with self.lock:
            meta = self.codex_meta(cid)
            if not self.is_editable(meta):
                raise EditError(403, "codex-locked", f"{cid} 是外部数据源，禁止本地编辑")
            path, data = self.read_codex(cid)
            if not isinstance(data.get("entries"), list):
                raise EditError(500, "internal", f"{cid}.json 缺少 entries 数组")
            backup_dir = self.make_backup([path, self.index_path()])
            entry = mutator(data)
            entries = data["entries"]
            entry_count, imaged_count = self.compute_counts(entries)
            data["entryCount"] = entry_count
            data["imagedCount"] = imaged_count
            data["tree"] = build_tree(entries)
            self.validate_codex(data)
            self.atomic_write_json_styled(path, data)
            self._update_index_counts(cid, entry_count, imaged_count)
            return {
                "ok": True,
                "entry": entry,
                "entryCount": entry_count,
                "imagedCount": imaged_count,
                "tree": data["tree"],
                "backupDir": backup_dir,
            }

    # ---------- 词条操作 ----------

    @staticmethod
    def _find_entry(data, eid):
        for e in data["entries"]:
            if e.get("id") == eid:
                return e
        raise EditError(404, "not-found", f"未知词条：{eid}")

    @staticmethod
    def _existing_paths(entries):
        return {tuple(e["path"]) for e in entries if isinstance(e.get("path"), list)}

    @staticmethod
    def _check_path_field(value, entries):
        if not isinstance(value, list) or not value or not all(isinstance(p, str) and p for p in value):
            raise EditError(400, "bad-request", "path 必须是非空字符串数组")
        if tuple(value) not in EditStore._existing_paths(entries):
            raise EditError(400, "path-not-found", "目标分类不存在（P0 只能选现有分类）")

    @staticmethod
    def _reposition(entries, entry):
        """把 entry 挪到同 path 最后一条之后（保持 JSON 按分类分组）；无同类则追加末尾。"""
        entries.remove(entry)
        target = tuple(entry["path"])
        insert_at = len(entries)
        last_same = -1
        for i, e in enumerate(entries):
            if tuple(e.get("path") or ()) == target:
                last_same = i
        if last_same >= 0:
            insert_at = last_same + 1
        entries.insert(insert_at, entry)

    def update_entry(self, cid, eid, fields):
        if not isinstance(fields, dict) or not fields:
            raise EditError(400, "bad-request", "fields 为空")
        allowed = {"title", "tags", "negative", "note", "rating", "isNew", "path"}
        unknown = set(fields) - allowed
        if unknown:
            raise EditError(400, "bad-request", f"不可编辑的字段：{','.join(sorted(unknown))}")

        def mutator(data):
            entry = self._find_entry(data, eid)
            for key in ("title", "tags"):
                if key in fields:
                    if not isinstance(fields[key], str) or not fields[key].strip():
                        raise EditError(400, "bad-request", f"{key} 不能为空")
            if "rating" in fields:
                r = fields["rating"]
                if not isinstance(r, str) or (r and r not in RATINGS):
                    raise EditError(400, "bad-request", f"rating 必须是 {sorted(RATINGS)} 之一或空串")
            if "isNew" in fields and not isinstance(fields["isNew"], bool):
                raise EditError(400, "bad-request", "isNew 必须是布尔值")
            path_changed = False
            if "path" in fields:
                self._check_path_field(fields["path"], data["entries"])
                path_changed = tuple(fields["path"]) != tuple(entry.get("path") or ())
            for key, value in fields.items():
                if key in ("negative", "note", "rating") and value == "":
                    entry.pop(key, None)
                else:
                    entry[key] = value
            if path_changed:
                self._reposition(data["entries"], entry)
            return entry

        return self.mutate(cid, mutator)

    @staticmethod
    def _max_seq(cid, data):
        id_re = re.compile(r"^" + re.escape(cid) + r"-(\d+)$")
        max_n = 0
        for e in data["entries"]:
            m = id_re.match(str(e.get("id") or ""))
            if m:
                max_n = max(max_n, int(m.group(1)))
        stored = data.get("editorMaxSeq")
        if isinstance(stored, int) and stored > max_n:
            max_n = stored
        return max_n

    def create_entry(self, cid, payload):
        if not isinstance(payload, dict):
            raise EditError(400, "bad-request", "entry 必须是对象")

        def mutator(data):
            for key in ("title", "tags"):
                if not isinstance(payload.get(key), str) or not payload[key].strip():
                    raise EditError(400, "bad-request", f"新词条必须有非空 {key}")
            self._check_path_field(payload.get("path"), data["entries"])
            if "rating" in payload:
                r = payload["rating"]
                if not isinstance(r, str) or (r and r not in RATINGS):
                    raise EditError(400, "bad-request", f"rating 必须是 {sorted(RATINGS)} 之一或空串")
            if "isNew" in payload and not isinstance(payload["isNew"], bool):
                raise EditError(400, "bad-request", "isNew 必须是布尔值")
            seq = self._max_seq(cid, data) + 1
            data["editorMaxSeq"] = seq
            entry = {
                "id": f"{cid}-{seq:04d}",
                "title": payload["title"],
                "path": list(payload["path"]),
                "tags": payload["tags"],
            }
            for key in ("negative", "note", "rating"):
                if isinstance(payload.get(key), str) and payload[key]:
                    entry[key] = payload[key]
            if payload.get("isNew") is True:
                entry["isNew"] = True
            data["entries"].append(entry)
            self._reposition(data["entries"], entry)
            return entry

        return self.mutate(cid, mutator)

    def delete_entry(self, cid, eid):
        def mutator(data):
            entry = self._find_entry(data, eid)
            data["entries"].remove(entry)
            # 图片文件一律不动：磁盘上的缩略图/原图留作回滚网
            return None

        return self.mutate(cid, mutator)

    # ---------- 图片操作 ----------

    def set_image(self, cid, eid, durl):
        if not isinstance(durl, str) or not durl.startswith("data:") or "," not in durl:
            raise EditError(400, "bad-request", "dataURL 非法")
        try:
            raw = base64.b64decode(durl.split(",", 1)[1])
        except Exception:
            raise EditError(400, "bad-request", "dataURL base64 解码失败")
        from PIL import Image

        def mutator(data):
            entry = self._find_entry(data, eid)
            if "images" in entry:
                raise EditError(400, "multi-image-unsupported", "多图词条的图片编辑留待 P1")
            ext = _ext_from_dataurl(durl)
            odir = os.path.join(self.orig, cid)
            os.makedirs(odir, exist_ok=True)
            ofn = eid + "." + ext
            with open(os.path.join(odir, ofn), "wb") as f:
                f.write(raw)
            try:
                im = Image.open(io.BytesIO(raw))
            except Exception:
                raise EditError(400, "bad-request", "无法解码为图片")
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            im.thumbnail((MAXDIM, MAXDIM), Image.LANCZOS)
            thumb_w, thumb_h = im.size
            tdir = os.path.join(self.site, "images", cid)
            os.makedirs(tdir, exist_ok=True)
            tfn = eid + ".jpg"
            tp = os.path.join(tdir, tfn)
            im.save(tp, "JPEG", quality=86, optimize=True)
            entry["image"] = tfn
            entry["imageWidth"] = thumb_w
            entry["imageHeight"] = thumb_h
            entry["original"] = ofn
            entry["assetRev"] = _asset_rev(tp, os.path.join(odir, ofn))
            entry.pop("assetCodexId", None)
            return entry

        result = self.mutate(cid, mutator)
        result["pendingR2Sync"] = True
        return result

    def delete_image(self, cid, eid):
        def mutator(data):
            entry = self._find_entry(data, eid)
            if "images" in entry:
                raise EditError(400, "multi-image-unsupported", "多图词条的图片编辑留待 P1")
            for key in IMAGE_FIELD_KEYS:
                entry.pop(key, None)
            # 磁盘文件保留（回滚网）
            return entry

        result = self.mutate(cid, mutator)
        result["pendingR2Sync"] = True
        return result
