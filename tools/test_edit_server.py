# -*- coding: utf-8 -*-
"""edit_server EditStore 核心单测：全部在临时沙箱目录运行，不碰真实 site/data。
用法：python -m unittest tools.test_edit_server  （或 python tools/test_edit_server.py）
"""
import base64
import glob
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from edit_server import EditError, EditStore, build_tree  # noqa: E402


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def make_png_dataurl(width=20, height=10, color=(200, 30, 30)):
    from PIL import Image

    im = Image.new("RGB", (width, height), color)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def build_sandbox(root):
    """在 root 下搭一套迷你 site/data（普通书 + 紧凑书 + 外来前缀书 + 外部源锁定书）。"""
    data = os.path.join(root, "site", "data")

    testbook_entries = [
            {
                "id": "testbook-0001",
                "title": "甲一",
                "path": ["甲"],
                "tags": "one, two",
                "isNew": False,
                "image": "testbook-0001.jpg",
                "original": "testbook-0001.png",
                "imageWidth": 100,
                "imageHeight": 50,
                "assetRev": "aaaaaaaaaaaaaaaa",
                "characterPrompts": [{"label": "char1", "prompt": "girl"}],
                "credit": "某作者",
            },
            {"id": "testbook-0002", "title": "乙一", "path": ["甲", "乙"], "tags": "three", "negative": "bad", "note": "n"},
            # 单图-数组格式（pack 书那样：顶层 image 与 images[0] 镜像），P0 可编辑
            {"id": "testbook-0003", "title": "丙一", "path": ["丙"], "tags": "four", "isNew": True,
             "image": "testbook-0003.jpg", "original": "testbook-0003.png",
             "images": [{"path": "testbook-0003.jpg", "original": "testbook-0003.png"}]},
        ]
    testbook = {
        "id": "testbook",
        "title": "测试书",
        "entryCount": 3,
        "imagedCount": 2,
        "tree": build_tree(testbook_entries),
        "entries": testbook_entries,
    }
    # 默认风格：单行、分隔符带空格（json.dump 默认），与站内多数手维护书一致
    _write(os.path.join(data, "testbook.json"), json.dumps(testbook, ensure_ascii=False))

    compact_entries = [{"id": "compactbook-0001", "title": "A1", "path": ["A"], "tags": "x"}]
    compactbook = {
        "id": "compactbook",
        "title": "紧凑书",
        "entryCount": 1,
        "imagedCount": 0,
        "tree": build_tree(compact_entries),
        "entries": compact_entries,
    }
    _write(
        os.path.join(data, "compactbook.json"),
        json.dumps(compactbook, ensure_ascii=False, separators=(",", ":")),
    )

    # 合并版：词条 id 用与 cid 无关的历史前缀（如 suozhang_r18 的 codex_xxxx-NNNN）
    foreign_entries = [{"id": "codex_dead-0007", "title": "旧前缀", "path": ["X"], "tags": "y"}]
    foreignbook = {
        "id": "foreignbook",
        "title": "外来前缀书",
        "entryCount": 1,
        "imagedCount": 0,
        "tree": build_tree(foreign_entries),
        "entries": foreign_entries,
    }
    _write(os.path.join(data, "foreignbook.json"), json.dumps(foreignbook, ensure_ascii=False))

    # 下划线 id 规约的书（如 composition_style_0001）
    under_entries = [
        {"id": "underbook_0001", "title": "U1", "path": ["U"], "tags": "a"},
        {"id": "underbook_0002", "title": "U2", "path": ["U"], "tags": "b"},
    ]
    underbook = {
        "id": "underbook",
        "title": "下划线书",
        "entryCount": 2,
        "imagedCount": 0,
        "tree": build_tree(under_entries),
        "entries": under_entries,
    }
    _write(os.path.join(data, "underbook.json"), json.dumps(underbook, ensure_ascii=False))

    # 真·多图词条（images[].length > 1），图片编辑应被拒（留 P1）
    multi_entries = [{
        "id": "multibook-0001", "title": "多图", "path": ["M"], "tags": "m",
        "image": "multibook-0001.jpg", "original": "multibook-0001.png",
        "images": [{"path": "multibook-0001.jpg", "original": "multibook-0001.png"},
                   {"path": "multibook-0001_02.jpg", "original": "multibook-0001_02.png"}],
    }]
    multibook = {
        "id": "multibook", "title": "多图书", "entryCount": 1, "imagedCount": 1,
        "tree": build_tree(multi_entries), "entries": multi_entries,
    }
    _write(os.path.join(data, "multibook.json"), json.dumps(multibook, ensure_ascii=False))

    index = [
        {"id": "testbook", "title": "测试书", "entryCount": 3, "imagedCount": 2},
        {"id": "compactbook", "title": "紧凑书", "entryCount": 1, "imagedCount": 0},
        {"id": "foreignbook", "title": "外来前缀书", "entryCount": 1, "imagedCount": 0},
        {"id": "underbook", "title": "下划线书", "entryCount": 2, "imagedCount": 0},
        {"id": "multibook", "title": "多图书", "entryCount": 1, "imagedCount": 1},
        {"id": "lockbook", "title": "外部源书", "entryCount": 5, "imagedCount": 5,
         "dataUrl": "https://example.test/data.json"},
    ]
    _write(os.path.join(data, "codexes.json"), json.dumps(index, ensure_ascii=False, indent=2))


class EditStoreTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="edit-server-test-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.data = os.path.join(self.root, "site", "data")
        build_sandbox(self.root)
        self.store = EditStore(self.root)

    # ---------- 基础工具 ----------

    def read_book(self, cid):
        return json.loads(_read(os.path.join(self.data, cid + ".json")))

    def assert_edit_error(self, status, code, fn, *args, **kwargs):
        with self.assertRaises(EditError) as ctx:
            fn(*args, **kwargs)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (status, code))

    # ---------- update ----------

    def test_update_whitelist_fields_and_preserve_others(self):
        before = self.read_book("testbook")["entries"][0]
        res = self.store.update_entry("testbook", "testbook-0001", {"title": "改名", "rating": "safe"})
        self.assertTrue(res["ok"])
        after = self.read_book("testbook")["entries"][0]
        self.assertEqual(after["title"], "改名")
        self.assertEqual(after["rating"], "safe")
        for key in ("image", "original", "assetRev", "imageWidth", "imageHeight", "characterPrompts", "credit", "isNew"):
            self.assertEqual(after[key], before[key], key)

    def test_update_empty_string_removes_optional_keys(self):
        self.store.update_entry("testbook", "testbook-0002", {"negative": "", "note": ""})
        after = next(e for e in self.read_book("testbook")["entries"] if e["id"] == "testbook-0002")
        self.assertNotIn("negative", after)
        self.assertNotIn("note", after)

    def test_update_rejections(self):
        up = self.store.update_entry
        self.assert_edit_error(400, "bad-request", up, "testbook", "testbook-0001", {"tags": "  "})
        self.assert_edit_error(400, "bad-request", up, "testbook", "testbook-0001", {"rating": "spicy"})
        self.assert_edit_error(400, "bad-request", up, "testbook", "testbook-0001", {"isNew": "yes"})
        self.assert_edit_error(400, "bad-request", up, "testbook", "testbook-0001", {"credit": "x"})
        self.assert_edit_error(400, "path-not-found", up, "testbook", "testbook-0001", {"path": ["不存在"]})
        self.assert_edit_error(404, "not-found", up, "testbook", "testbook-9999", {"title": "x"})
        self.assert_edit_error(404, "not-found", up, "nobook", "e", {"title": "x"})
        self.assert_edit_error(403, "codex-locked", up, "lockbook", "e", {"title": "x"})

    def test_update_path_moves_and_repositions(self):
        res = self.store.update_entry("testbook", "testbook-0003", {"path": ["甲"]})
        book = self.read_book("testbook")
        ids = [e["id"] for e in book["entries"]]
        self.assertEqual(ids, ["testbook-0001", "testbook-0003", "testbook-0002"])
        jia = next(n for n in book["tree"] if n["name"] == "甲")
        self.assertEqual(jia["count"], 3)
        self.assertEqual(res["tree"], book["tree"])
        self.assertFalse(any(n["name"] == "丙" for n in book["tree"]))

    # ---------- create / delete 与发号铁律 ----------

    def test_create_appends_into_category_with_next_seq(self):
        res = self.store.create_entry("testbook", {"title": "新词", "tags": "t", "path": ["甲"], "note": "备注"})
        self.assertEqual(res["entry"]["id"], "testbook-0004")
        book = self.read_book("testbook")
        ids = [e["id"] for e in book["entries"]]
        self.assertEqual(ids, ["testbook-0001", "testbook-0004", "testbook-0002", "testbook-0003"])
        self.assertEqual(book["editorMaxSeq"], 4)
        self.assertEqual(book["entryCount"], 4)

    def test_deleted_max_seq_is_never_reused(self):
        first = self.store.create_entry("testbook", {"title": "新1", "tags": "t", "path": ["丙"]})
        self.assertEqual(first["entry"]["id"], "testbook-0004")
        self.store.delete_entry("testbook", "testbook-0004")
        second = self.store.create_entry("testbook", {"title": "新2", "tags": "t", "path": ["丙"]})
        self.assertEqual(second["entry"]["id"], "testbook-0005")

    def test_create_in_foreign_prefix_book(self):
        # cid 与历史前缀无关 → 用 cid 起新前缀、连字符分隔，且与旧前缀 id 无冲突
        res = self.store.create_entry("foreignbook", {"title": "n", "tags": "t", "path": ["X"]})
        self.assertEqual(res["entry"]["id"], "foreignbook-0001")
        ids = [e["id"] for e in self.read_book("foreignbook")["entries"]]
        self.assertEqual(len(ids), len(set(ids)))

    def test_create_preserves_underscore_id_scheme(self):
        # 下划线规约的书新增词条应沿用下划线、且序号接历史最大值
        res = self.store.create_entry("underbook", {"title": "U3", "tags": "c", "path": ["U"]})
        self.assertEqual(res["entry"]["id"], "underbook_0003")
        self.store.delete_entry("underbook", "underbook_0003")
        again = self.store.create_entry("underbook", {"title": "U4", "tags": "d", "path": ["U"]})
        self.assertEqual(again["entry"]["id"], "underbook_0004")  # 删除号不复用，分隔符保持

    def test_delete_keeps_image_files(self):
        tdir = os.path.join(self.root, "site", "images", "testbook")
        os.makedirs(tdir)
        thumb = os.path.join(tdir, "testbook-0001.jpg")
        _write(thumb, "fake")
        res = self.store.delete_entry("testbook", "testbook-0001")
        self.assertIsNone(res["entry"])
        self.assertTrue(os.path.exists(thumb))
        book = self.read_book("testbook")
        self.assertEqual(book["entryCount"], 2)
        self.assertEqual(book["imagedCount"], 1)

    # ---------- 计数 / 树 / 索引同步 ----------

    def test_index_surgery_untouched_when_counts_unchanged(self):
        before = _read(os.path.join(self.data, "codexes.json"))
        self.store.update_entry("testbook", "testbook-0001", {"title": "只改标题"})
        self.assertEqual(_read(os.path.join(self.data, "codexes.json")), before)

    def test_index_surgery_updates_only_counts(self):
        before = _read(os.path.join(self.data, "codexes.json"))
        self.store.delete_entry("testbook", "testbook-0002")
        after = _read(os.path.join(self.data, "codexes.json"))
        expected = before.replace('"entryCount": 3', '"entryCount": 2')
        self.assertEqual(after, expected)
        self.assertIn('"dataUrl": "https://example.test/data.json"', after)

    # ---------- 原子性 / 自检 / 备份 ----------

    def test_failed_mutation_leaves_files_untouched(self):
        book_path = os.path.join(self.data, "testbook.json")
        before = _read(book_path)
        self.assert_edit_error(
            400, "bad-request", self.store.update_entry, "testbook", "testbook-0001", {"rating": "nope"}
        )
        self.assertEqual(_read(book_path), before)
        self.assertEqual(glob.glob(os.path.join(self.data, "*.tmp")), [])

    def test_self_check_blocks_corrupting_mutation(self):
        book_path = os.path.join(self.data, "testbook.json")
        before = _read(book_path)

        def corrupt(data):
            data["entries"].append(dict(data["entries"][0]))  # 复制出重复 id
            return None

        self.assert_edit_error(409, "self-check-failed", self.store.mutate, "testbook", corrupt)
        self.assertEqual(_read(book_path), before)

    def test_backup_snapshot_matches_pre_edit_file(self):
        book_path = os.path.join(self.data, "testbook.json")
        before = _read(book_path)
        res = self.store.update_entry("testbook", "testbook-0001", {"title": "有备份"})
        backup = os.path.join(self.root, res["backupDir"].replace("/", os.sep), "testbook.json")
        self.assertTrue(os.path.isfile(backup))
        self.assertEqual(_read(backup), before)

    # ---------- 风格保持 ----------

    def test_compact_style_preserved(self):
        self.store.update_entry("compactbook", "compactbook-0001", {"title": "A2"})
        text = _read(os.path.join(self.data, "compactbook.json"))
        self.assertTrue(text.startswith('{"id":"compactbook"'))
        self.assertNotIn('": "', text.split('"title"')[0])

    def test_spaced_style_preserved(self):
        self.store.update_entry("testbook", "testbook-0002", {"title": "乙二"})
        text = _read(os.path.join(self.data, "testbook.json"))
        self.assertTrue(text.startswith('{"id": "testbook"'))

    # ---------- 图片 ----------

    def test_image_set_writes_files_and_fields(self):
        res = self.store.set_image("testbook", "testbook-0002", make_png_dataurl(1400, 700))
        entry = next(e for e in self.read_book("testbook")["entries"] if e["id"] == "testbook-0002")
        self.assertEqual(entry["image"], "testbook-0002.jpg")
        self.assertEqual(entry["original"], "testbook-0002.png")
        self.assertLessEqual(max(entry["imageWidth"], entry["imageHeight"]), 1100)
        self.assertRegex(entry["assetRev"], r"^[0-9a-f]{16}$")
        self.assertTrue(os.path.isfile(os.path.join(self.root, "site", "images", "testbook", "testbook-0002.jpg")))
        orig = os.path.join(self.root, "originals", "testbook", "testbook-0002.png")
        self.assertTrue(os.path.isfile(orig))
        with open(orig, "rb") as f:
            self.assertEqual(f.read(8), b"\x89PNG\r\n\x1a\n")  # 原图原样字节，未被重编码
        self.assertEqual(res["imagedCount"], 3)
        self.assertTrue(res["pendingR2Sync"])

    def test_image_delete_removes_fields_keeps_files(self):
        self.store.set_image("testbook", "testbook-0002", make_png_dataurl())
        res = self.store.delete_image("testbook", "testbook-0002")
        entry = next(e for e in self.read_book("testbook")["entries"] if e["id"] == "testbook-0002")
        for key in ("image", "original", "assetRev", "imageWidth", "imageHeight"):
            self.assertNotIn(key, entry)
        self.assertTrue(os.path.isfile(os.path.join(self.root, "site", "images", "testbook", "testbook-0002.jpg")))
        self.assertEqual(res["imagedCount"], 2)

    def test_image_ops_reject_only_genuine_multi_image(self):
        # images[].length > 1 才拒绝
        self.assert_edit_error(
            400, "multi-image-unsupported", self.store.set_image, "multibook", "multibook-0001", make_png_dataurl()
        )
        self.assert_edit_error(
            400, "multi-image-unsupported", self.store.delete_image, "multibook", "multibook-0001"
        )

    def test_image_set_syncs_single_element_images_array(self):
        # 单图-数组词条（pack 书那样）：set 要同步顶层字段与 images[0]
        self.store.set_image("testbook", "testbook-0003", make_png_dataurl(1200, 600))
        entry = next(e for e in self.read_book("testbook")["entries"] if e["id"] == "testbook-0003")
        self.assertEqual(entry["image"], "testbook-0003.jpg")
        self.assertEqual(len(entry["images"]), 1)
        self.assertEqual(entry["images"][0]["path"], "testbook-0003.jpg")
        self.assertEqual(entry["images"][0]["original"], "testbook-0003.png")
        self.assertEqual(entry["image"], entry["images"][0]["path"])  # 顶层与 images[0] 镜像

    def test_image_delete_on_single_array_makes_no_image_entry(self):
        res = self.store.delete_image("testbook", "testbook-0003")
        entry = next(e for e in self.read_book("testbook")["entries"] if e["id"] == "testbook-0003")
        for key in ("image", "original", "assetRev", "imageWidth", "imageHeight", "images"):
            self.assertNotIn(key, entry)
        self.assertEqual(res["imagedCount"], 1)  # 原本 0001 + 0003 = 2，删后剩 0001

    # ---------- 能力声明 ----------

    def test_capabilities_reports_editable_and_locked(self):
        caps = self.store.capabilities()
        self.assertTrue(caps["ok"])
        self.assertEqual(sorted(caps["editable"]),
                         ["compactbook", "foreignbook", "multibook", "testbook", "underbook"])
        self.assertEqual(caps["locked"], {"lockbook": "external-data"})
        self.assertEqual(caps["docxWarnings"], [])


class HttpSmokeTest(unittest.TestCase):
    """线程起真服务器（端口 0 随机），走 urllib 全链路冒烟。"""

    def setUp(self):
        import threading

        from edit_server import Server, make_handler

        self.root = tempfile.mkdtemp(prefix="edit-server-http-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        build_sandbox(self.root)
        self.store = EditStore(self.root)
        self.server = Server(("127.0.0.1", 0), make_handler(self.store))
        self.port = self.server.server_address[1]
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.shutdown)

    def request(self, path, payload=None, headers=None, raw_body=None):
        import urllib.error
        import urllib.request

        url = f"http://127.0.0.1:{self.port}{path}"
        body = raw_body if raw_body is not None else (
            json.dumps(payload).encode("utf-8") if payload is not None else None
        )
        req = urllib.request.Request(url, data=body, headers=headers or {})
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as ex:
            return ex.code, json.loads(ex.read())

    def test_ping_shape(self):
        status, data = self.request("/__edit__/ping")
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        self.assertIn("testbook", data["editable"])
        self.assertIn("lockbook", data["locked"])

    def test_entry_update_roundtrip(self):
        status, data = self.request("/__edit__/entry", {
            "codexId": "testbook", "op": "update", "entryId": "testbook-0002",
            "fields": {"title": "HTTP改", "note": "via http"},
        })
        self.assertEqual(status, 200)
        self.assertEqual(data["entry"]["title"], "HTTP改")
        self.assertEqual(data["entryCount"], 3)
        on_disk = json.loads(_read(os.path.join(self.root, "site", "data", "testbook.json")))
        self.assertEqual(next(e for e in on_disk["entries"] if e["id"] == "testbook-0002")["title"], "HTTP改")

    def test_error_shell_and_statuses(self):
        status, data = self.request("/__edit__/entry", {"codexId": "nobook", "op": "delete", "entryId": "x"})
        self.assertEqual((status, data["ok"], data["code"]), (404, False, "not-found"))
        status, data = self.request("/__edit__/entry", {"codexId": "lockbook", "op": "delete", "entryId": "x"})
        self.assertEqual((status, data["code"]), (403, "codex-locked"))
        status, data = self.request("/__edit__/entry", raw_body=b"{not json")
        self.assertEqual((status, data["code"]), (400, "bad-request"))
        status, data = self.request("/__edit__/nothing", {"a": 1})
        self.assertEqual(status, 404)

    def test_oversized_body_rejected(self):
        big = b"x" * (512 * 1024 + 1)
        status, data = self.request("/__edit__/entry", raw_body=big)
        self.assertEqual((status, data["code"]), (413, "too-large"))

    def test_foreign_origin_rejected(self):
        status, data = self.request(
            "/__edit__/entry",
            {"codexId": "testbook", "op": "delete", "entryId": "testbook-0001"},
            headers={"Origin": "https://evil.example"},
        )
        self.assertEqual((status, data["code"]), (403, "bad-origin"))
        on_disk = json.loads(_read(os.path.join(self.root, "site", "data", "testbook.json")))
        self.assertEqual(len(on_disk["entries"]), 3)


if __name__ == "__main__":
    unittest.main()
