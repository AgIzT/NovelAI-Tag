"""图包逐图负面 / 角色词回填：只写与顶层不同的字段、封面不符整组跳过、排版原样、可重跑。"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import backfill_pack_image_prompts as bf  # noqa: E402

CHAR_A = [{"label": "char1", "prompt": "girl, standing"}]
CHAR_B = [{"label": "char1", "prompt": "girl, sitting", "negative": "hat"}]


def make_entry(count: int = 4) -> dict:
    return {
        "id": "set",
        "tags": "artist, room",
        "negative": "lowres",
        "characterPrompts": CHAR_A,
        "images": [
            {"path": f"set-{i}.jpg", "original": f"set-{i}.webp", "rawTag": "artist, room" if i < 3 else "artist, beach"}
            for i in range(1, count + 1)
        ],
    }


class BackfillTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "book").mkdir()
        for i in range(1, 5):
            (self.root / "book" / f"set-{i}.webp").write_bytes(b"x")
        self.params = {
            "set-1.webp": ("artist, room", "lowres", CHAR_A),
            "set-2.webp": ("artist, room", "lowres", CHAR_B),
            "set-3.webp": ("artist, beach", "", CHAR_A),
            "set-4.webp": ("artist, beach", "lowres", CHAR_A),
        }
        self.reader = lambda path: self.params[path.name]

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def plan(self, entry: dict):
        return bf.plan_entry("book", entry, self.root, self.reader)

    def test_only_differing_fields_are_written(self) -> None:
        entry = make_entry()
        targets, reason = self.plan(entry)
        self.assertEqual(reason, "")
        self.assertEqual(targets, [
            {"negative": None, "characterPrompts": CHAR_B},
            {"negative": "", "characterPrompts": None},
            {"negative": None, "characterPrompts": None},
        ])
        self.assertTrue(bf.apply_entry(entry, targets))
        self.assertEqual(entry["images"][1]["characterPrompts"], CHAR_B)
        self.assertNotIn("negative", entry["images"][1])
        self.assertEqual(entry["images"][2]["negative"], "", "封面有负面、这张没有时要写空串")
        self.assertNotIn("negative", entry["images"][3])
        self.assertNotIn("characterPrompts", entry["images"][0], "封面不写逐图字段")
        self.assertIs(entry[bf.MARKER], True)
        again, _ = self.plan(entry)
        self.assertFalse(bf.apply_entry(entry, again), "重跑不应再有改动")

    def test_old_set_notes_are_migrated_once(self) -> None:
        old_notes = [
            "套图：17 张；每张正向提示词保存在对应图片 raw tag，顶层正向、负面与角色框取封面。",
            "套图：4 张；每张图的正向提示词已绑定为当前图 raw tag，负面词与角色词展示取封面。",
            "套图：4 张；每张图的正向提示词随当前图切换，负面词与角色词展示取封面。",
        ]
        for old in old_notes:
            with self.subTest(old=old):
                entry = make_entry()
                entry["note"] = old + "\n参数：Steps: 28"
                targets, _ = self.plan(entry)
                self.assertTrue(bf.apply_entry(entry, targets))
                count = old.split("：")[1].split(" ")[0]
                self.assertEqual(entry["note"], f"套图：{count} 张；提示词随当前图切换。\n参数：Steps: 28")
                self.assertFalse(bf.apply_entry(entry, targets), "迁移后不再改动")
        entry = make_entry()
        entry["note"] = "作者备注：取封面。"
        targets, _ = self.plan(entry)
        bf.apply_entry(entry, targets)
        self.assertEqual(entry["note"], "作者备注：取封面。", "非套图首行不动")

    def test_stale_image_field_is_removed_when_equal_to_top(self) -> None:
        entry = make_entry()
        entry["images"][3]["negative"] = "old"
        targets, _ = self.plan(entry)
        bf.apply_entry(entry, targets)
        self.assertNotIn("negative", entry["images"][3])

    def test_cover_mismatch_skips_whole_entry(self) -> None:
        entry = make_entry()
        entry["characterPrompts"] = [{"label": "char1", "prompt": "girl, edited"}]
        self.assertEqual(self.plan(entry), (None, "cover_character_mismatch"))
        entry = make_entry()
        entry["negative"] = "edited"
        self.assertEqual(self.plan(entry), (None, "cover_negative_mismatch"))

    def test_prompt_mismatch_and_missing_original_skip(self) -> None:
        entry = make_entry()
        entry["images"][2]["rawTag"] = "artist, edited"
        self.assertEqual(self.plan(entry), (None, "[3] prompt_mismatch"))
        entry = make_entry()
        (self.root / "book" / "set-4.webp").unlink()
        self.assertEqual(self.plan(entry), (None, "[4] original_missing"))

    def test_unreadable_original_skips(self) -> None:
        def broken(path: Path):
            raise ValueError("bad")
        self.assertEqual(
            bf.plan_entry("book", make_entry(), self.root, broken),
            (None, "[1] unreadable:ValueError"),
        )

    def test_layout_round_trip(self) -> None:
        data = {"id": "book", "entries": [make_entry()]}
        for layout in (("indent", "\r\n"), ("indent", "\n"), ("compact", "\n")):
            path = self.root / "book.json"
            path.write_bytes(bf.dump_book(data, layout))
            loaded, detected = bf.load_book(path)
            self.assertEqual(loaded, data)
            self.assertEqual(detected, layout)
        path.write_text(json.dumps(data, indent=4), encoding="utf-8")
        self.assertIsNone(bf.load_book(path)[1], "认不出的排版不写回")


if __name__ == "__main__":
    unittest.main()
