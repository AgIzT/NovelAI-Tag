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


class EditStoreTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="edit-server-test-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.data = os.path.join(self.root, "site", "data")

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
            {"id": "testbook-0003", "title": "丙一", "path": ["丙"], "tags": "four", "isNew": True,
             "images": [{"path": "a.jpg", "original": "a.png"}]},
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
        _write(os.path.join(self.data, "testbook.json"), json.dumps(testbook, ensure_ascii=False))

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
            os.path.join(self.data, "compactbook.json"),
            json.dumps(compactbook, ensure_ascii=False, separators=(",", ":")),
        )

        foreign_entries = [{"id": "codex_dead-0001", "title": "旧前缀", "path": ["X"], "tags": "y"}]
        foreignbook = {
            "id": "foreignbook",
            "title": "外来前缀书",
            "entryCount": 1,
            "imagedCount": 0,
            "tree": build_tree(foreign_entries),
            "entries": foreign_entries,
        }
        _write(os.path.join(self.data, "foreignbook.json"), json.dumps(foreignbook, ensure_ascii=False))

        index = [
            {"id": "testbook", "title": "测试书", "entryCount": 3, "imagedCount": 2},
            {"id": "compactbook", "title": "紧凑书", "entryCount": 1, "imagedCount": 0},
            {"id": "foreignbook", "title": "外来前缀书", "entryCount": 1, "imagedCount": 0},
            {"id": "lockbook", "title": "外部源书", "entryCount": 5, "imagedCount": 5,
             "dataUrl": "https://example.test/data.json"},
        ]
        _write(os.path.join(self.data, "codexes.json"), json.dumps(index, ensure_ascii=False, indent=2))

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
        res = self.store.create_entry("foreignbook", {"title": "n", "tags": "t", "path": ["X"]})
        self.assertEqual(res["entry"]["id"], "foreignbook-0001")
        ids = [e["id"] for e in self.read_book("foreignbook")["entries"]]
        self.assertEqual(len(ids), len(set(ids)))

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

    def test_image_ops_reject_multi_image_entries(self):
        self.assert_edit_error(
            400, "multi-image-unsupported", self.store.set_image, "testbook", "testbook-0003", make_png_dataurl()
        )
        self.assert_edit_error(
            400, "multi-image-unsupported", self.store.delete_image, "testbook", "testbook-0003"
        )

    # ---------- 能力声明 ----------

    def test_capabilities_reports_editable_and_locked(self):
        caps = self.store.capabilities()
        self.assertTrue(caps["ok"])
        self.assertEqual(sorted(caps["editable"]), ["compactbook", "foreignbook", "testbook"])
        self.assertEqual(caps["locked"], {"lockbook": "external-data"})
        self.assertEqual(caps["docxWarnings"], [])


if __name__ == "__main__":
    unittest.main()
