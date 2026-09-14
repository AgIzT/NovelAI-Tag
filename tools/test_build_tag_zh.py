# -*- coding: utf-8 -*-

"""tag 中文对照构建器：查表键与前端共用夹具、词库别名不串义、译名优先级与分片形态。"""

import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_tag_zh as btz  # noqa: E402


FIXTURE = Path(__file__).resolve().parent / "fixtures" / "tag_zh_keys.json"


class TagKeyTest(unittest.TestCase):
    def test_fixture_matches_frontend_contract(self):
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
        for raw, expected in cases:
            with self.subTest(raw=raw):
                self.assertEqual(btz.tag_key(raw), expected)

    def test_split_pieces_and_artist_names(self):
        self.assertEqual(btz.split_pieces("1girl,\n{{solo}}，smile,"), ["1girl", "{{solo}}", "smile"])
        self.assertEqual(btz.artist_name("0.6::artist:Chigusa_Minori::"), "chigusa minori")
        self.assertEqual(btz.artist_name("[[artist:null (nyanpyoun)]]"), "null (nyanpyoun")
        self.assertEqual(btz.artist_name("smile"), "")

    def test_first_translation_keeps_brackets_and_slash_tags(self):
        self.assertEqual(btz.first_translation("双手朝上|双手抬起", "hands up"), "双手朝上")
        self.assertEqual(btz.first_translation("玉藻前（命运/额外）,狐狸", "tamamo"), "玉藻前（命运/额外）")
        self.assertEqual(btz.first_translation("Fate/Zero", "fate/zero"), "Fate/Zero")

    def test_ai_eligible_skips_markup_and_glued_fragments(self):
        self.assertTrue(btz.ai_eligible("oil paint scent"))
        self.assertFalse(btz.ai_eligible("</style>"))
        self.assertFalse(btz.ai_eligible("watermark:: -5::detailed skin"))
        self.assertFalse(btz.ai_eligible("signaturelogoartistnameworstqualitylowresugly"))


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.data = root / "site" / "data"
        self.src = root / "tools" / "data" / "tag_zh"
        self.data.mkdir(parents=True)
        self.src.mkdir(parents=True)
        index = [{"id": "book"}, {"id": "other"}]
        (self.data / "codexes.json").write_text(json.dumps(index), encoding="utf-8")
        entries = [
            {"id": "book-1", "tags": "1girl, text, {{oil paint scent}}, artist:ciloranko, ciloranko", "negative": "text"},
            {"id": "book-2", "tags": "1girl, long_hair, only here", "characterPrompts": [{"prompt": "hood", "negative": "text"}]},
            {"id": "book-3", "tags": "1girl, rare tag"},
        ]
        (self.data / "book.json").write_text(json.dumps({"id": "book", "entries": entries}), encoding="utf-8")
        (self.data / "other.json").write_text(json.dumps({"id": "other", "entries": [{"id": "o-1", "tags": "hood, text"}]}), encoding="utf-8")
        with (self.src / "dict.csv").open("w", encoding="utf-8", newline="") as fh:
            writer = csv.writer(fh)
            writer.writerow(["1girl", "0", "100", "1girls", "单人女性"])
            writer.writerow(["text_focus", "0", "10", "text", "文字焦点"])
            writer.writerow(["long_hair", "0", "90", "longhair", "长发|长头发"])
            writer.writerow(["hood", "0", "80", "", "兜帽"])
            writer.writerow(["ciloranko", "1", "70", "", "希洛兰科"])
        (self.src / "人工译名.csv").write_text("tag,中文,备注\nText,文字,负面语境\n", encoding="utf-8-sig")
        (self.src / "AI译名.csv").write_text("tag,中文,来源,日期\noil paint scent,油画颜料味,测试,2026-09-15\nrare tag,稀有词,测试,2026-09-15\n", encoding="utf-8-sig")
        self.patches = [
            mock.patch.object(btz, "DATA_DIR", self.data),
            mock.patch.object(btz, "INDEX_PATH", self.data / "codexes.json"),
            mock.patch.object(btz, "OUT_DIR", self.data / "tag_zh"),
            mock.patch.object(btz, "DICT_PATH", self.src / "dict.csv"),
            mock.patch.object(btz, "MANUAL_PATH", self.src / "人工译名.csv"),
            mock.patch.object(btz, "AI_PATH", self.src / "AI译名.csv"),
            mock.patch.object(btz, "REPORT_DIR", root / "output" / "tag-zh"),
            mock.patch.object(btz, "ensure_dictionary", lambda allow_download: None),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.tmp.cleanup()

    def test_alias_that_is_one_word_of_a_longer_tag_is_ignored(self):
        dictionary, artists = btz.load_dictionary()
        self.assertEqual(dictionary["longhair"], "长发")
        self.assertEqual(dictionary["1girls"], "单人女性")
        self.assertNotIn("text", dictionary)
        self.assertIn("ciloranko", artists)
        self.assertNotIn("ciloranko", dictionary)

    def test_build_writes_prioritized_deterministic_shards(self):
        self.assertEqual(btz.main(["--no-download"]), 0)
        core = json.loads((self.data / "tag_zh" / "core.json").read_text(encoding="utf-8"))
        self.assertEqual(core["m"], {"text": "文字"})
        self.assertEqual(core["d"], {"1girl": "单人女性", "hood": "兜帽"})
        self.assertEqual(core["shards"], ["book"])
        self.assertEqual(core["source"]["license"], "GPL-3.0")
        book = json.loads((self.data / "tag_zh" / "book.json").read_text(encoding="utf-8"))
        self.assertEqual(book["d"], {"long hair": "长发"})
        self.assertEqual(book["a"], {"oil paint scent": "油画颜料味", "rare tag": "稀有词"})
        self.assertNotIn("ciloranko", json.dumps(book, ensure_ascii=False))
        first = (self.data / "tag_zh" / "book.json").read_bytes()
        (self.data / "tag_zh" / "gone.json").write_text("{}", encoding="utf-8")
        self.assertEqual(btz.main(["--no-download"]), 0)
        self.assertEqual((self.data / "tag_zh" / "book.json").read_bytes(), first, "内容不变时字节必须不变")
        self.assertFalse((self.data / "tag_zh" / "gone.json").exists(), "书不在了的旧分片要清掉")
        missing = (btz.REPORT_DIR / "待翻译.csv").read_text(encoding="utf-8-sig")
        self.assertIn("only here", missing)
        self.assertNotIn("ciloranko", missing)

    def test_dry_run_does_not_touch_site_data(self):
        self.assertEqual(btz.main(["--dry-run", "--no-download"]), 0)
        self.assertFalse((self.data / "tag_zh").exists())


if __name__ == "__main__":
    unittest.main()
