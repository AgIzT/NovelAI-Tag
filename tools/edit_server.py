# -*- coding: utf-8 -*-
"""本地法典编辑服务器（P0）：主站"编辑模式"的后端。

用法：python tools/edit_server.py （或双击 单项工具/法典编辑器.bat）
浏览器打开 http://localhost:18769/ —— 主站探测到 /__edit__/ping 后自动加载编辑模块。

组成：
  · 静态服务 site/ + /originals/ 安全映射（同 preview_server，带 no-store）
  · EditStore —— 词条/图片写核心：备份 → 变更 → 重算 tree/计数 → 自检 → 原子写 → 同步索引
  · HTTP 层：GET /__edit__/ping · POST /__edit__/entry|image|metadata|import-image

数据安全：
  · 只绑 127.0.0.1；写接口校验 Origin
  · 每次写盘前把单本 JSON + codexes.json 快照到 output/edit-backups/<时间戳>/
  · 原子写（同目录临时文件 + os.replace），并保持原文件的紧凑/缩进风格
  · 新词条发号 = max(editorMaxSeq, 现有最大序号) + 1，4 位零填充，删除的号永不复用
  · 外部源书（带 dataUrl，如 mengshen_r18）服务器端强制拒写
"""
import argparse
import ast
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
from pathlib import Path

from sd_metadata_inspector import extract_image_metadata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 18769
MAXDIM = 1100
ENTRY_MAX_BYTES = 512 * 1024
IMAGE_MAX_BYTES = 64 * 1024 * 1024
RATINGS = {"safe", "nsfw", "r18", "r18g", "restricted"}
CODEX_TYPES = ("codex", "string", "composition", "pack")
IMAGE_FIELD_KEYS = ("image", "original", "assetRev", "imageWidth", "imageHeight", "assetCodexId")
IMAGE_FORMAT_EXTENSIONS = {
    "JPEG": "jpg",
    "PNG": "png",
    "WEBP": "webp",
    "GIF": "gif",
    "BMP": "bmp",
}


class EditError(Exception):
    """带 HTTP 语义的业务错误：status + 机器码 code + 人话 message。"""

    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def build_tree(entries, empty_paths=None):
    """entries 的 path 数组 → 目录树 [{name,count,children[]}]（count=子树累计）。
    词条派生部分移植自 import_community_ai_misc.build_tree，语义不得改动。

    `empty_paths` 是显式登记的空分类（编辑器「新建分类」用）：只保证节点存在、不加计数。
    因为目录树本是 path 派生的，没有这个登记就无法表达"还没有词条的分类"。"""
    root = {}

    def ensure(path, counted):
        node = root
        for name in path:
            current = node.setdefault(name, {"name": name, "count": 0, "children": {}})
            if counted:
                current["count"] += 1
            node = current["children"]

    for entry in entries:
        ensure(entry["path"], True)
    for path in (empty_paths or []):
        ensure(path, False)

    def serialize(node):
        return [
            {"name": value["name"], "count": value["count"], "children": serialize(value["children"])}
            for value in node.values()
        ]

    return serialize(root)


def normalize_empty_categories(value):
    """清洗 emptyCategories：只保留非空字符串数组，去重且保序。"""
    out, seen = [], set()
    for path in value or []:
        if not isinstance(path, list) or not path:
            continue
        if not all(isinstance(p, str) and p for p in path):
            continue
        key = tuple(path)
        if key in seen:
            continue
        seen.add(key)
        out.append(list(path))
    return out


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


def _asset_rev_bytes(*payloads):
    """与 _asset_rev 相同的算法，但用于尚未落盘的事务内图片。"""
    h = hashlib.sha256()
    for payload in payloads:
        h.update(hashlib.sha256(payload).hexdigest().encode("ascii"))
    return h.hexdigest()[:16]


def _decode_image_dataurl(durl):
    """严格解码并验真图片；扩展名只相信 Pillow 识别出的实际格式。"""
    if not isinstance(durl, str) or "," not in durl:
        raise EditError(400, "bad-request", "dataURL 非法")
    header, encoded = durl.split(",", 1)
    if not re.fullmatch(r"data:image/[A-Za-z0-9.+-]+;base64", header, re.IGNORECASE):
        raise EditError(400, "bad-request", "dataURL 必须是 base64 图片")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except Exception:
        raise EditError(400, "bad-request", "dataURL base64 解码失败")
    if not raw:
        raise EditError(400, "bad-request", "图片内容为空")

    from PIL import Image, ImageOps

    try:
        # verify() 检查完整文件；随后重开并 load()，确保延迟解码阶段也成功。
        with Image.open(io.BytesIO(raw)) as probe:
            image_format = str(probe.format or "").upper()
            probe.verify()
        ext = IMAGE_FORMAT_EXTENSIONS.get(image_format)
        if not ext:
            raise EditError(400, "unsupported-image", f"不支持的图片格式：{image_format or '未知'}")
        with Image.open(io.BytesIO(raw)) as source:
            source.seek(0)
            source.load()
            thumb = ImageOps.exif_transpose(source)
            if thumb.mode not in ("RGB", "L"):
                thumb = thumb.convert("RGB")
            thumb.thumbnail((MAXDIM, MAXDIM), Image.LANCZOS)
            thumb_w, thumb_h = thumb.size
            out = io.BytesIO()
            thumb.save(out, "JPEG", quality=86, optimize=True)
    except EditError:
        raise
    except Exception:
        raise EditError(400, "bad-request", "无法完整解码为图片")
    return raw, ext, out.getvalue(), thumb_w, thumb_h


def _normalize_character_prompts(value):
    """校验并清洗 NAI V4 角色框；正负任一侧非空就保留原 char 序号。"""
    if value is None:
        return []
    if not isinstance(value, list):
        raise EditError(400, "bad-request", "characterPrompts 必须是数组")
    if len(value) > 64:
        raise EditError(400, "bad-request", "角色框过多（最多 64 个）")
    out = []
    labels = set()
    for item in value:
        if not isinstance(item, dict):
            raise EditError(400, "bad-request", "角色框必须是对象")
        label = item.get("label")
        prompt = item.get("prompt", "")
        negative = item.get("negative", "")
        if not isinstance(label, str) or not re.fullmatch(r"char[1-9]\d*", label):
            raise EditError(400, "bad-request", "角色框 label 必须形如 char1")
        if label in labels:
            raise EditError(400, "bad-request", f"角色框 label 重复：{label}")
        if not isinstance(prompt, str) or not isinstance(negative, str):
            raise EditError(400, "bad-request", "角色框正负 Tag 必须是字符串")
        prompt = prompt.strip()
        negative = negative.strip()
        if not prompt and not negative:
            continue
        clean = {"label": label, "prompt": prompt}
        if negative:
            clean["negative"] = negative
        labels.add(label)
        out.append(clean)
    return out


def _extract_metadata_payload(raw, ext):
    """让浏览器上传也走项目唯一的 sd_metadata_inspector 解析语义。"""
    fd, temp_path = tempfile.mkstemp(prefix="fadian-metadata-", suffix="." + ext)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(raw)
        meta = extract_image_metadata(Path(temp_path))
    except EditError:
        raise
    except Exception as ex:
        raise EditError(400, "metadata-read-failed", f"无法读取图片元数据：{ex}") from ex
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
    return {
        "prompt": str(meta.prompt or "").strip(),
        "negative": str(meta.negative or "").strip(),
        "characterPrompts": _normalize_character_prompts(meta.character_prompts),
        "source": str(meta.source_type or "unknown"),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


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
            tree = ast.parse(text)
            raw_map = None
            for node in tree.body:
                if not isinstance(node, (ast.Assign, ast.AnnAssign)):
                    continue
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                if any(isinstance(target, ast.Name) and target.id == "ID_MAP" for target in targets):
                    raw_map = ast.literal_eval(node.value)
                    break
            pairs = raw_map.items() if isinstance(raw_map, dict) else (raw_map or [])
            for item in pairs:
                if isinstance(item, (list, tuple)) and len(item) == 2:
                    key, cid = item
                    if isinstance(key, str) and isinstance(cid, str):
                        mapping[key] = cid
        except (OSError, SyntaxError, ValueError, TypeError):
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
                fh.flush()
                os.fsync(fh.fileno())
            self._replace_with_retries(tmp_name, path)
        except Exception:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

    def _atomic_write_bytes(self, path, payload):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(
            prefix=os.path.basename(path) + ".", suffix=".tmp", dir=os.path.dirname(path)
        )
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(payload)
                fh.flush()
                os.fsync(fh.fileno())
            self._replace_with_retries(tmp_name, path)
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
                fh.flush()
                os.fsync(fh.fileno())
            self._replace_with_retries(tmp_name, path)
        except Exception:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

    @staticmethod
    def _replace_with_retries(source, target):
        for retry in range(6):
            try:
                os.replace(source, target)
                return
            except PermissionError:
                if retry >= 5:
                    raise
                time.sleep(0.05)
        raise AssertionError("unreachable")

    @staticmethod
    def _safe_child_path(directory, filename):
        """返回 directory 下的绝对路径；任何绝对路径或 .. 越界均拒绝。"""
        base = os.path.abspath(directory)
        target = os.path.abspath(os.path.join(base, filename))
        try:
            inside = os.path.commonpath([base, target])
        except ValueError:
            inside = ""
        if os.path.normcase(inside) != os.path.normcase(base):
            raise EditError(400, "bad-request", "图片文件名越出目标目录")
        return target

    @staticmethod
    def _capture_file_states(paths):
        states = {}
        for path in dict.fromkeys(paths):
            if os.path.isfile(path):
                with open(path, "rb") as fh:
                    states[path] = fh.read()
            else:
                states[path] = None
        return states

    def _restore_file_states(self, states):
        errors = []
        for path, payload in reversed(list(states.items())):
            try:
                if payload is None:
                    if os.path.isfile(path):
                        os.remove(path)
                else:
                    self._atomic_write_bytes(path, payload)
            except Exception as ex:
                errors.append(f"{path}: {ex}")
        if errors:
            raise OSError("；".join(errors))

    def _run_transaction(self, paths, operation):
        """让一组文件变更具备异常回滚；崩溃恢复仍由写前备份兜底。"""
        states = self._capture_file_states(paths)
        try:
            return operation()
        except Exception as original:
            try:
                self._restore_file_states(states)
            except Exception as rollback_error:
                raise EditError(
                    500,
                    "rollback-failed",
                    f"写入失败且自动回滚未完成，请从 output/edit-backups 恢复：{rollback_error}",
                ) from original
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
        for p in dict.fromkeys(paths):
            if os.path.isfile(p):
                # JSON 沿用历史平铺位置，保证旧恢复习惯和测试不变；图片按项目相对路径
                # 放进 files/，避免原图与缩略图同名时互相覆盖。
                if os.path.normcase(os.path.dirname(p)) == os.path.normcase(self.data) and p.lower().endswith(".json"):
                    dest = os.path.join(target, os.path.basename(p))
                else:
                    rel = os.path.relpath(p, self.root)
                    if rel == os.pardir or rel.startswith(os.pardir + os.sep):
                        rel = os.path.join("external", os.path.basename(p))
                    dest = os.path.join(target, "files", rel)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                shutil.copy2(p, dest)
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
        if data.get("tree") != build_tree(entries, data.get("emptyCategories")):
            raise EditError(409, "self-check-failed", "tree 与词条 path / 空分类不一致")

    # ---------- 写管线 ----------

    def mutate(self, cid, mutator, file_writes=None):
        """统一写管线：锁 → 校验可编辑 → 备份 → 变更 → 重算 → 自检 → 原子写 → 同步索引。
        mutator(data) 返回被操作的词条（delete 返回 None）；file_writes 与 JSON 同事务提交。
        file_writes 保留传入字典引用，允许新词条在锁内发号后再登记对应资源路径。"""
        if file_writes is None:
            file_writes = {}
        if not isinstance(file_writes, dict):
            raise TypeError("file_writes must be a dict")
        with self.lock:
            meta = self.codex_meta(cid)
            if not self.is_editable(meta):
                raise EditError(403, "codex-locked", f"{cid} 是外部数据源，禁止本地编辑")
            path, data = self.read_codex(cid)
            if not isinstance(data.get("entries"), list):
                raise EditError(500, "internal", f"{cid}.json 缺少 entries 数组")
            entry = mutator(data)
            entries = data["entries"]
            entry_count, imaged_count = self.compute_counts(entries)
            data["entryCount"] = entry_count
            data["imagedCount"] = imaged_count
            empty = self._prune_empty_categories(data, entries)
            if empty:
                data["emptyCategories"] = empty
            else:
                data.pop("emptyCategories", None)
            data["tree"] = build_tree(entries, empty)
            self.validate_codex(data)
            protected = [path, self.index_path(), *file_writes]
            backup_dir = self.make_backup(protected)

            def commit():
                # 资源先写、JSON 后写；任何一步失败都会把已替换文件恢复到事务前状态。
                for target, payload in file_writes.items():
                    self._atomic_write_bytes(target, payload)
                self.atomic_write_json_styled(path, data)
                self._update_index_counts(cid, entry_count, imaged_count)

            self._run_transaction(protected, commit)
            return {
                "ok": True,
                "entry": entry,
                "entryCount": entry_count,
                "imagedCount": imaged_count,
                "tree": data["tree"],
                "backupDir": backup_dir,
            }

    # ---------- 空分类登记 ----------

    @staticmethod
    def _prune_empty_categories(data, entries):
        """清洗显式分类登记。

        字段沿用历史名 emptyCategories，但语义是“编辑器显式创建的分类”。即使分类
        暂时被词条占用也要保留登记，避免最后一条词条移走后目录骨架消失。
        """
        return normalize_empty_categories(data.get("emptyCategories"))

    @staticmethod
    def _all_tree_paths(data):
        """当前树里的全部分类路径（词条派生 + 空分类登记）。"""
        paths = set()
        for e in data["entries"]:
            path = e.get("path") or []
            for i in range(1, len(path) + 1):
                paths.add(tuple(path[:i]))
        for p in normalize_empty_categories(data.get("emptyCategories")):
            for i in range(1, len(p) + 1):
                paths.add(tuple(p[:i]))
        return paths

    # ---------- 分类（目录）操作 ----------

    @staticmethod
    def _check_category_name(name):
        if not isinstance(name, str) or not name.strip():
            raise EditError(400, "bad-request", "分类名不能为空")
        if len(name) > 60:
            raise EditError(400, "bad-request", "分类名过长（最多 60 字）")
        if "\u0001" in name or "/" in name:
            raise EditError(400, "bad-request", "分类名不能含分隔符")
        return name.strip()

    def create_category(self, cid, parent_path, name):
        """新建分类：登记为空分类（还没有词条），树里以 count 0 出现。"""
        clean = self._check_category_name(name)
        parent = parent_path if isinstance(parent_path, list) else []
        if not all(isinstance(p, str) and p for p in parent):
            raise EditError(400, "bad-request", "父分类路径非法")

        def mutator(data):
            if parent and tuple(parent) not in self._all_tree_paths(data):
                raise EditError(400, "path-not-found", "父分类不存在")
            target = list(parent) + [clean]
            if tuple(target) in self._all_tree_paths(data):
                raise EditError(400, "bad-request", "同名分类已存在")
            registered = normalize_empty_categories(data.get("emptyCategories"))
            registered.append(target)
            data["emptyCategories"] = registered
            return {"path": target}

        return self.mutate(cid, mutator)

    def rename_category(self, cid, path, name):
        """重命名分类：批量改所有以该路径为前缀的词条 path，空分类登记同步。"""
        clean = self._check_category_name(name)
        if not isinstance(path, list) or not path:
            raise EditError(400, "bad-request", "分类路径非法")
        old = list(path)

        def mutator(data):
            if tuple(old) not in self._all_tree_paths(data):
                raise EditError(404, "not-found", "分类不存在")
            new = old[:-1] + [clean]
            if clean != old[-1] and tuple(new) in self._all_tree_paths(data):
                raise EditError(400, "bad-request", "同名分类已存在")
            n = len(old)
            moved = 0
            for e in data["entries"]:
                p = e.get("path") or []
                if len(p) >= n and p[:n] == old:
                    e["path"] = new + p[n:]
                    moved += 1
            registered = []
            for p in normalize_empty_categories(data.get("emptyCategories")):
                registered.append(new + p[n:] if len(p) >= n and p[:n] == old else p)
            data["emptyCategories"] = registered
            return {"path": new, "movedEntries": moved}

        return self.mutate(cid, mutator)

    def move_category(self, cid, path, new_parent_path):
        """移动分类到新父级（new_parent_path 为空数组 = 提升到顶层）。"""
        if not isinstance(path, list) or not path:
            raise EditError(400, "bad-request", "分类路径非法")
        old = list(path)
        parent = new_parent_path if isinstance(new_parent_path, list) else []
        if not all(isinstance(p, str) and p for p in parent):
            raise EditError(400, "bad-request", "目标父分类路径非法")
        if parent[:len(old)] == old:
            raise EditError(400, "bad-request", "不能把分类移到它自己或其子分类下")

        def mutator(data):
            paths = self._all_tree_paths(data)
            if tuple(old) not in paths:
                raise EditError(404, "not-found", "分类不存在")
            if parent and tuple(parent) not in paths:
                raise EditError(400, "path-not-found", "目标父分类不存在")
            new = list(parent) + [old[-1]]
            if new == old:
                raise EditError(400, "bad-request", "目标位置与当前相同")
            if tuple(new) in paths:
                raise EditError(400, "bad-request", "目标位置已有同名分类")
            n = len(old)
            moved = 0
            for e in data["entries"]:
                p = e.get("path") or []
                if len(p) >= n and p[:n] == old:
                    e["path"] = new + p[n:]
                    moved += 1
            registered = []
            for p in normalize_empty_categories(data.get("emptyCategories")):
                registered.append(new + p[n:] if len(p) >= n and p[:n] == old else p)
            data["emptyCategories"] = registered
            return {"path": new, "movedEntries": moved}

        return self.mutate(cid, mutator)

    def delete_category(self, cid, path, with_entries=False):
        """删除分类。默认只允许删空分类；with_entries=True 才连同其下词条一起删。
        图片文件一律保留（回滚网）。"""
        if not isinstance(path, list) or not path:
            raise EditError(400, "bad-request", "分类路径非法")
        target = list(path)

        def mutator(data):
            if tuple(target) not in self._all_tree_paths(data):
                raise EditError(404, "not-found", "分类不存在")
            n = len(target)
            inside = [e for e in data["entries"] if len(e.get("path") or []) >= n and e["path"][:n] == target]
            if inside and not with_entries:
                raise EditError(409, "category-not-empty", f"该分类下还有 {len(inside)} 条词条，请先移走或确认一并删除")
            for e in inside:
                data["entries"].remove(e)
            registered = [
                p for p in normalize_empty_categories(data.get("emptyCategories"))
                if not (len(p) >= n and p[:n] == target)
            ]
            data["emptyCategories"] = registered
            return {"path": target, "deletedEntries": len(inside)}

        return self.mutate(cid, mutator)

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
    def _check_path_field(value, data):
        """目标分类必须是树里已存在的路径（含「新建的空分类」，它们在 emptyCategories 里登记）。"""
        if not isinstance(value, list) or not value or not all(isinstance(p, str) and p for p in value):
            raise EditError(400, "bad-request", "path 必须是非空字符串数组")
        if tuple(value) not in EditStore._all_tree_paths(data):
            raise EditError(400, "path-not-found", "目标分类不存在（只能选树里已有的分类）")

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
                self._check_path_field(fields["path"], data)
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
    def _id_scheme(cid, data):
        """探测本书的词条 id 规约，返回 (分隔符, 历史最大序号)。
        各本 id 形态不一：多数是 `<cid>-NNNN`，少数（如 composition_style）是 `<cid>_NNNN`；
        合并版（suozhang_r18）用与 cid 无关的历史前缀，此时按 cid 起新前缀、以 `-` 为分隔符。"""
        sep = "-"
        if any(re.match(r"^" + re.escape(cid) + r"_\d+$", str(e.get("id") or "")) for e in data["entries"]):
            sep = "_"
        id_re = re.compile(r"^" + re.escape(cid) + r"[-_](\d+)$")
        max_n = 0
        for e in data["entries"]:
            m = id_re.match(str(e.get("id") or ""))
            if m:
                max_n = max(max_n, int(m.group(1)))
        stored = data.get("editorMaxSeq")
        if isinstance(stored, int) and stored > max_n:
            max_n = stored
        return sep, max_n

    def _build_new_entry(self, cid, data, payload):
        if not isinstance(payload, dict):
            raise EditError(400, "bad-request", "entry 必须是对象")
        for key in ("title", "tags"):
            if not isinstance(payload.get(key), str) or not payload[key].strip():
                raise EditError(400, "bad-request", f"新词条必须有非空 {key}")
        self._check_path_field(payload.get("path"), data)
        if "rating" in payload:
            r = payload["rating"]
            if not isinstance(r, str) or (r and r not in RATINGS):
                raise EditError(400, "bad-request", f"rating 必须是 {sorted(RATINGS)} 之一或空串")
        if "isNew" in payload and not isinstance(payload["isNew"], bool):
            raise EditError(400, "bad-request", "isNew 必须是布尔值")
        character_prompts = _normalize_character_prompts(payload.get("characterPrompts"))
        sep, max_n = self._id_scheme(cid, data)
        seq = max_n + 1
        data["editorMaxSeq"] = seq
        entry = {
            "id": f"{cid}{sep}{seq:04d}",
            "title": payload["title"].strip(),
            "path": list(payload["path"]),
            "tags": payload["tags"].strip(),
        }
        for key in ("negative", "note", "rating"):
            if isinstance(payload.get(key), str) and payload[key].strip():
                entry[key] = payload[key].strip()
        if character_prompts:
            entry["characterPrompts"] = character_prompts
        if payload.get("isNew") is True:
            entry["isNew"] = True
        data["entries"].append(entry)
        self._reposition(data["entries"], entry)
        return entry

    def create_entry(self, cid, payload):
        def mutator(data):
            return self._build_new_entry(cid, data, payload)

        return self.mutate(cid, mutator)

    def create_entry_with_image(self, cid, payload, durl):
        """单张原子导入：词条、原图、缩略图、索引任一步失败都整体回滚。"""
        raw, ext, thumb_bytes, thumb_w, thumb_h = _decode_image_dataurl(durl)
        file_writes = {}

        def mutator(data):
            entry = self._build_new_entry(cid, data, payload)
            self._apply_image_fields(
                data, cid, entry, raw, ext, thumb_bytes, thumb_w, thumb_h, file_writes
            )
            return entry

        result = self.mutate(cid, mutator, file_writes=file_writes)
        result["pendingR2Sync"] = True
        return result

    def delete_entry(self, cid, eid):
        def mutator(data):
            entry = self._find_entry(data, eid)
            data["entries"].remove(entry)
            # 图片文件一律不动：磁盘上的缩略图/原图留作回滚网
            return None

        return self.mutate(cid, mutator)

    # ---------- 图片操作 ----------

    @staticmethod
    def inspect_image(durl):
        raw, ext, _thumb_bytes, _thumb_w, _thumb_h = _decode_image_dataurl(durl)
        return {"ok": True, "metadata": _extract_metadata_payload(raw, ext)}

    def _apply_image_fields(self, data, cid, entry, raw, ext, thumb_bytes, thumb_w, thumb_h, file_writes):
        eid = entry["id"]
        imgs = entry.get("images")
        if isinstance(imgs, list) and len(imgs) > 1:
            raise EditError(400, "multi-image-unsupported", "多图词条的图片编辑留待 P1")
        odir = os.path.join(self.orig, cid)
        tdir = os.path.join(self.site, "images", cid)
        ofn = eid + "." + ext
        tfn = eid + ".jpg"
        original_path = self._safe_child_path(odir, ofn)
        thumb_path = self._safe_child_path(tdir, tfn)
        entry["image"] = tfn
        entry["imageWidth"] = thumb_w
        entry["imageHeight"] = thumb_h
        entry["original"] = ofn
        entry["assetRev"] = _asset_rev_bytes(thumb_bytes, raw)
        entry.pop("assetCodexId", None)
        # 图包统一保留 images[0] 镜像；普通书沿用既有顶层单图结构。
        if isinstance(imgs, list) or data.get("type") == "pack":
            entry["images"] = [{"path": tfn, "original": ofn}]
        file_writes[original_path] = raw
        file_writes[thumb_path] = thumb_bytes

    def set_image(self, cid, eid, durl):
        raw, ext, thumb_bytes, thumb_w, thumb_h = _decode_image_dataurl(durl)
        file_writes = {}

        def mutator(data):
            entry = self._find_entry(data, eid)
            self._apply_image_fields(
                data, cid, entry, raw, ext, thumb_bytes, thumb_w, thumb_h, file_writes
            )
            return entry

        result = self.mutate(cid, mutator, file_writes=file_writes)
        result["pendingR2Sync"] = True
        return result

    # ---------- 法典（整本）操作 ----------

    def _write_index(self, index):
        """整表重写 codexes.json（增删本用）。保持 indent=2 风格与原文件的末尾换行习惯。"""
        path = self.index_path()
        try:
            with open(path, encoding="utf-8") as f:
                trailing = "\n" if f.read().endswith("\n") else ""
        except OSError:
            trailing = ""
        self._atomic_write_text(path, json.dumps(index, ensure_ascii=False, indent=2) + trailing)

    @staticmethod
    def _check_codex_id(cid):
        if not isinstance(cid, str) or not re.fullmatch(r"[a-z][a-z0-9_]{1,39}", cid or ""):
            raise EditError(400, "bad-request", "法典 id 只能用小写字母 / 数字 / 下划线，字母开头，2-40 字")
        return cid

    def create_codex(self, payload):
        """新建一本空法典：写 <id>.json + 注册进 codexes.json。"""
        if not isinstance(payload, dict):
            raise EditError(400, "bad-request", "payload 必须是对象")
        cid = self._check_codex_id(payload.get("id"))
        title = payload.get("title")
        if not isinstance(title, str) or not title.strip():
            raise EditError(400, "bad-request", "书名不能为空")
        for key in ("selectorTitle", "author", "version"):
            if key in payload and not isinstance(payload[key], str):
                raise EditError(400, "bad-request", f"{key} 必须是字符串")
        if "nsfw" in payload and not isinstance(payload["nsfw"], bool):
            raise EditError(400, "bad-request", "nsfw 必须是布尔值")
        ctype = payload.get("type") or "codex"
        if ctype not in CODEX_TYPES:
            raise EditError(400, "bad-request", "type 只能是 " + " / ".join(CODEX_TYPES))
        with self.lock:
            index = self.read_index()
            reserved_ids = set()
            for item in index:
                if isinstance(item.get("id"), str):
                    reserved_ids.add(item["id"])
                aliases = item.get("aliases")
                if isinstance(aliases, list):
                    reserved_ids.update(alias for alias in aliases if isinstance(alias, str))
            if cid in reserved_ids:
                raise EditError(400, "bad-request", f"法典 id 已被现有 id 或 alias 占用：{cid}")
            target = self.codex_path(cid)
            if os.path.exists(target):
                raise EditError(400, "bad-request", f"数据文件已存在：{cid}.json")
            backup_dir = self.make_backup([self.index_path()])
            meta = {
                "id": cid,
                "type": ctype,
                "title": title.strip(),
                "version": str(payload.get("version") or "").strip(),
                "author": str(payload.get("author") or "").strip(),
                "entryCount": 0,
                "imagedCount": 0,
            }
            if str(payload.get("selectorTitle") or "").strip():
                meta["selectorTitle"] = payload["selectorTitle"].strip()
            if payload.get("nsfw") is True:
                meta["nsfw"] = True
            book = dict(meta)
            book["tree"] = []
            book["entries"] = []
            index.append(meta)

            def commit():
                self.atomic_write_json_styled(target, book)
                self._write_index(index)

            self._run_transaction([target, self.index_path()], commit)
            return {"ok": True, "codex": meta, "backupDir": backup_dir}

    def delete_codex(self, cid):
        """删除一本法典：从索引摘除，数据文件**归档**到备份目录（不真删）。
        图片 / 原图文件一律保留在磁盘（回滚网）。"""
        with self.lock:
            meta = self.codex_meta(cid)
            if not self.is_editable(meta):
                raise EditError(403, "codex-locked", f"{cid} 是外部数据源，不能在此删除")
            path = self.codex_path(cid)
            backup_dir = self.make_backup([path, self.index_path()])
            index = [item for item in self.read_index() if item.get("id") != cid]

            def commit():
                self._write_index(index)
                if os.path.isfile(path):
                    os.remove(path)   # 已在 backup_dir 留有完整副本

            self._run_transaction([path, self.index_path()], commit)
            return {"ok": True, "removed": cid, "backupDir": backup_dir}

    def update_codex_meta(self, cid, fields):
        """改法典元信息（书名 / 版本 / 作者 / 类型 / NSFW）：单本 JSON 与索引同步。"""
        if not isinstance(fields, dict) or not fields:
            raise EditError(400, "bad-request", "fields 为空")
        allowed = {"title", "version", "author", "type", "nsfw", "selectorTitle"}
        unknown = set(fields) - allowed
        if unknown:
            raise EditError(400, "bad-request", f"不可编辑的字段：{','.join(sorted(unknown))}")
        if "title" in fields and (not isinstance(fields["title"], str) or not fields["title"].strip()):
            raise EditError(400, "bad-request", "书名不能为空")
        if "type" in fields and fields["type"] not in CODEX_TYPES:
            raise EditError(400, "bad-request", "type 只能是 " + " / ".join(CODEX_TYPES))
        if "nsfw" in fields and not isinstance(fields["nsfw"], bool):
            raise EditError(400, "bad-request", "nsfw 必须是布尔值")
        for key in ("title", "version", "author", "selectorTitle"):
            if key in fields and not isinstance(fields[key], str):
                raise EditError(400, "bad-request", f"{key} 必须是字符串")
        with self.lock:
            meta = self.codex_meta(cid)
            if not self.is_editable(meta):
                raise EditError(403, "codex-locked", f"{cid} 是外部数据源，禁止本地编辑")
            path, data = self.read_codex(cid)
            backup_dir = self.make_backup([path, self.index_path()])
            index = self.read_index()
            for key, value in fields.items():
                clean = value.strip() if isinstance(value, str) else value
                for target in (data, next(i for i in index if i.get("id") == cid)):
                    if clean == "" or clean is False:
                        target.pop(key, None)
                    else:
                        target[key] = clean
            def commit():
                self.atomic_write_json_styled(path, data)
                self._write_index(index)

            self._run_transaction([path, self.index_path()], commit)
            return {"ok": True, "codex": next(i for i in index if i.get("id") == cid), "backupDir": backup_dir}

    def delete_image(self, cid, eid):
        def mutator(data):
            entry = self._find_entry(data, eid)
            imgs = entry.get("images")
            if isinstance(imgs, list) and len(imgs) > 1:
                raise EditError(400, "multi-image-unsupported", "多图词条的图片编辑留待 P1")
            for key in IMAGE_FIELD_KEYS:
                entry.pop(key, None)
            if isinstance(imgs, list):
                entry.pop("images", None)  # 单图-数组词条删图后变无图词条
            # 磁盘文件保留（回滚网）
            return entry

        result = self.mutate(cid, mutator)
        result["pendingR2Sync"] = True
        return result


# ---------- HTTP 层 ----------

_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}


def make_handler(store):
    """绑定到指定 EditStore 的 Handler 类（工厂形式便于单测起沙箱服务器）。"""
    site_dir = store.site

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=site_dir, **kwargs)

        def end_headers(self):
            request_path = self.path.split("?", 1)[0]
            if request_path == "/" or request_path.endswith((".html", ".json", ".js", ".css")):
                self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def do_GET(self):
            try:
                self._check_host()
            except EditError as ex:
                return self._json({"ok": False, "error": ex.message, "code": ex.code}, ex.status)
            path = self.path.split("?", 1)[0]
            if path == "/__edit__/ping":
                try:
                    return self._json(store.capabilities())
                except Exception as ex:
                    return self._json({"ok": False, "error": str(ex), "code": "internal"}, 500)
            if path.startswith("/originals/"):
                return self._serve_original()
            if path.startswith("/share/"):
                return self._serve_app_shell()
            return super().do_GET()

        def _serve_app_shell(self):
            """详情地址原位交付首页，让前端继续读取路径/查询串，并从根目录加载资源。"""
            index = os.path.join(site_dir, "index.html")
            if not os.path.isfile(index):
                self.send_error(404)
                return
            with open(index, "r", encoding="utf-8") as fh:
                html = fh.read()
            # charset 保持在 head 最前，base 必须早于 app-base 脚本和所有相对资源。
            html = re.sub(
                r"(<head\b[^>]*>\s*(?:<meta\b[^>]*charset[^>]*>\s*)?)",
                r'\1<base href="/">\n', html, count=1, flags=re.IGNORECASE,
            )
            body = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            try:
                self._check_host()
                path = self.path.split("?", 1)[0]
                routes = {
                    "/__edit__/entry": ENTRY_MAX_BYTES,
                    "/__edit__/image": IMAGE_MAX_BYTES,
                    "/__edit__/metadata": IMAGE_MAX_BYTES,
                    "/__edit__/import-image": IMAGE_MAX_BYTES,
                    "/__edit__/category": ENTRY_MAX_BYTES,
                    "/__edit__/codex": ENTRY_MAX_BYTES,
                }
                if path not in routes:
                    return self._json({"ok": False, "error": "未知端点", "code": "not-found"}, 404)
                self._check_origin()
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0:
                    raise EditError(400, "bad-request", "缺少请求体")
                if length > routes[path]:
                    raise EditError(413, "too-large", "请求体超过上限")
                try:
                    body = json.loads(self.rfile.read(length))
                except Exception:
                    raise EditError(400, "bad-request", "请求体不是合法 JSON")
                if path == "/__edit__/entry":
                    result = self._handle_entry(body)
                elif path == "/__edit__/image":
                    result = self._handle_image(body)
                elif path == "/__edit__/metadata":
                    result = store.inspect_image(body.get("dataURL"))
                elif path == "/__edit__/import-image":
                    result = self._handle_import_image(body)
                elif path == "/__edit__/category":
                    result = self._handle_category(body)
                else:
                    result = self._handle_codex(body)
                return self._json(result)
            except EditError as ex:
                return self._json({"ok": False, "error": ex.message, "code": ex.code}, ex.status)
            except Exception as ex:
                return self._json({"ok": False, "error": str(ex), "code": "internal"}, 500)

        def _handle_entry(self, body):
            cid = body.get("codexId")
            op = body.get("op")
            if not isinstance(cid, str) or not cid:
                raise EditError(400, "bad-request", "缺少 codexId")
            if op == "update":
                eid = body.get("entryId")
                if not isinstance(eid, str) or not eid:
                    raise EditError(400, "bad-request", "缺少 entryId")
                return store.update_entry(cid, eid, body.get("fields"))
            if op == "create":
                return store.create_entry(cid, body.get("entry"))
            if op == "delete":
                eid = body.get("entryId")
                if not isinstance(eid, str) or not eid:
                    raise EditError(400, "bad-request", "缺少 entryId")
                return store.delete_entry(cid, eid)
            raise EditError(400, "bad-request", f"未知 op：{op}")

        def _handle_category(self, body):
            cid = body.get("codexId")
            op = body.get("op")
            if not isinstance(cid, str) or not cid:
                raise EditError(400, "bad-request", "缺少 codexId")
            if op == "create":
                return store.create_category(cid, body.get("parentPath") or [], body.get("name"))
            if op == "rename":
                return store.rename_category(cid, body.get("path"), body.get("name"))
            if op == "move":
                return store.move_category(cid, body.get("path"), body.get("newParentPath") or [])
            if op == "delete":
                return store.delete_category(cid, body.get("path"), body.get("withEntries") is True)
            raise EditError(400, "bad-request", f"未知 op：{op}")

        def _handle_codex(self, body):
            op = body.get("op")
            if op == "create":
                return store.create_codex(body.get("codex") or {})
            cid = body.get("codexId")
            if not isinstance(cid, str) or not cid:
                raise EditError(400, "bad-request", "缺少 codexId")
            if op == "delete":
                return store.delete_codex(cid)
            if op == "meta":
                return store.update_codex_meta(cid, body.get("fields"))
            raise EditError(400, "bad-request", f"未知 op：{op}")

        def _handle_image(self, body):
            cid = body.get("codexId")
            eid = body.get("entryId")
            op = body.get("op")
            if not isinstance(cid, str) or not cid or not isinstance(eid, str) or not eid:
                raise EditError(400, "bad-request", "缺少 codexId / entryId")
            if op == "set":
                return store.set_image(cid, eid, body.get("dataURL"))
            if op == "delete":
                return store.delete_image(cid, eid)
            raise EditError(400, "bad-request", f"未知 op：{op}")

        def _handle_import_image(self, body):
            cid = body.get("codexId")
            if not isinstance(cid, str) or not cid:
                raise EditError(400, "bad-request", "缺少 codexId")
            return store.create_entry_with_image(cid, body.get("entry"), body.get("dataURL"))

        def _check_origin(self):
            origin = self.headers.get("Origin")
            if not origin:
                return
            try:
                host = urllib.parse.urlsplit(origin).hostname or ""
            except ValueError:
                host = ""
            if host not in _LOOPBACK_HOSTS:
                raise EditError(403, "bad-origin", "只接受本机页面的写请求")

        def _check_host(self):
            # Origin 对本机 curl/探活可缺省；Host 是每个请求的安全边界，缺失也必须拒绝。
            raw_host = self.headers.get("Host") or ""
            try:
                host = (urllib.parse.urlsplit("//" + raw_host).hostname or "").casefold()
            except ValueError:
                host = ""
            if host not in _LOOPBACK_HOSTS:
                raise EditError(403, "bad-host", "只接受本机 Host 的请求")

        def _serve_original(self):
            rel = urllib.parse.unquote(self.path.split("?", 1)[0].lstrip("/")).replace("/", os.sep)
            target = os.path.abspath(os.path.join(store.root, rel))
            base = os.path.abspath(store.orig)
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

        def _json(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    return Handler


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()
    store = EditStore(ROOT)
    with Server(("127.0.0.1", args.port), make_handler(store)) as server:
        print(f"Codex editor -> http://localhost:{args.port}/")
        print("Open the site, the pencil toggle appears in the topbar automatically.")
        print("Do NOT run this together with the peitu tool (imgserver :18767) on the same book.")
        server.serve_forever()
