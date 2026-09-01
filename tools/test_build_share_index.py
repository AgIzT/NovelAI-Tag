# -*- coding: utf-8 -*-

"""分享索引的分级断言：门控词条只借出词条名，别的字段一个都不许漏。"""

import json
import tempfile
import unittest
from pathlib import Path

import build_share_index as bsi


MEDIA = {"baseUrl": "https://assets.example.com", "imagePrefix": "images"}


def codex_meta(codex_id, **extra):
    return {"id": codex_id, "title": "书名-" + codex_id, "type": "codex", **extra}


def entry(entry_id, title, **extra):
    return {
        "id": entry_id,
        "title": title,
        "tags": "1girl, solo",
        "path": ["分类"],
        "image": entry_id + ".jpg",
        "imageWidth": 800,
        "imageHeight": 1200,
        "assetRev": "abc",
        **extra,
    }


class ShareIndexGrading(unittest.TestCase):
    def build(self, codexes, books):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            (data_dir / "codexes.json").write_text(
                json.dumps(codexes, ensure_ascii=False), encoding="utf-8"
            )
            (data_dir / "media.json").write_text(
                json.dumps(MEDIA, ensure_ascii=False), encoding="utf-8"
            )
            for book_id, book in books.items():
                (data_dir / (book_id + ".json")).write_text(
                    json.dumps(book, ensure_ascii=False), encoding="utf-8"
                )
            original = bsi.DATA_DIR
            bsi.DATA_DIR = data_dir
            try:
                return bsi.build()
            finally:
                bsi.DATA_DIR = original

    def test_gated_entry_in_safe_book_keeps_only_title(self):
        index, per_codex, _ = self.build(
            [codex_meta("safe")],
            {
                "safe": {
                    "id": "safe",
                    "entries": [
                        entry("safe-0001", "普通词条"),
                        entry("safe-0002", "限制级 0001", rating="r18"),
                        entry("safe-0003", "NSFW 目录里的", path=["分类", "NSFW"]),
                    ],
                }
            },
        )
        entries = per_codex["safe"]["entries"]
        self.assertEqual(entries["safe-0001"]["shareable"], True)
        self.assertIn("image", entries["safe-0001"])

        for gated_id in ("safe-0002", "safe-0003"):
            gated = entries[gated_id]
            self.assertEqual(gated["shareable"], False)
            self.assertEqual(set(gated), {"id", "title", "shareable"})

        # shareCount 只数出完整卡的词条，门控词条不许把它顶上去
        self.assertEqual(index["codexes"]["safe"]["shareCount"], 1)
        self.assertEqual(per_codex["safe"]["shareCount"], 1)

    def test_nsfw_book_exposes_titles_but_never_its_own_name(self):
        index, per_codex, _ = self.build(
            [codex_meta("hidden", nsfw=True, title="不该出现的书名")],
            {"hidden": {"id": "hidden", "entries": [entry("hidden-0001", "露骨词条名")]}},
        )
        meta = index["codexes"]["hidden"]
        self.assertEqual(meta["shareable"], False)
        self.assertEqual(meta["titleOnly"], True)
        self.assertEqual(set(meta), {"id", "aliases", "shareable", "titleOnly"})

        shard = per_codex["hidden"]
        self.assertEqual(set(shard), {"schema", "id", "aliases", "shareable", "titleOnly", "entries"})
        self.assertEqual(
            shard["entries"]["hidden-0001"],
            {"id": "hidden-0001", "title": "露骨词条名", "shareable": False},
        )
        self.assertNotIn("不该出现的书名", json.dumps(shard, ensure_ascii=False))

    def test_nsfw_books_can_be_switched_back_to_no_card(self):
        original = bsi.TITLE_ONLY_NSFW_BOOKS
        bsi.TITLE_ONLY_NSFW_BOOKS = False
        try:
            index, per_codex, _ = self.build(
                [codex_meta("hidden", nsfw=True)],
                {"hidden": {"id": "hidden", "entries": [entry("hidden-0001", "露骨词条名")]}},
            )
        finally:
            bsi.TITLE_ONLY_NSFW_BOOKS = original
        self.assertNotIn("hidden", per_codex)
        self.assertEqual(set(index["codexes"]["hidden"]), {"id", "aliases", "shareable"})

    def test_entry_without_title_is_dropped_rather_than_guessed(self):
        _, per_codex, _ = self.build(
            [codex_meta("safe")],
            {
                "safe": {
                    "id": "safe",
                    "entries": [entry("safe-0002", "", rating="r18")],
                }
            },
        )
        self.assertNotIn("safe-0002", per_codex["safe"]["entries"])


if __name__ == "__main__":
    unittest.main()
