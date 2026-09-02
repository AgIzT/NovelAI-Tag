from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import merge_nai45_artist_books as merge  # noqa: E402


def personal_book() -> dict:
    return {
        "id": "artist_nai45_personal",
        "aliases": ["artist_300"],
        "type": "string",
        "title": "NovelAI v4.5单画师词典",
        "version": "2026.7.12",
        "author": "千早爱音 / 兔",
        "source": "千早爱音的单画师收藏 / 兔兔的4.5画师收录",
        "hasOriginal": True,
        "contributors": [{"name": "千早爱音", "role": "词条整理"}],
        "tree": [{"name": "300画师(4.5F版)", "count": 1, "children": []}],
        "entries": [
            {"id": "artist_300_0001", "title": "a", "path": ["300画师(4.5F版)"],
             "image": "artist_300_0001.jpg", "assetCodexId": "artist_300"},
            {"id": "artist_nai45_personal_0002", "title": "b", "path": ["千早爱音的单画师收藏", "1卷"],
             "image": "artist_nai45_personal_0002.jpg"},
        ],
    }


def strings_book() -> dict:
    return {
        "id": "artist_nai45_strings",
        "type": "string",
        "title": "NovelAI v4.5画师串词典",
        "version": "2026.8.23",
        "author": "PieDriver / 梦神",
        "source": "PieDriver · W.O.F_画风",
        "hasOriginal": True,
        "contributors": [{"name": "PieDriver", "role": "词条整理"}],
        "tree": [{"name": "W.O.F_画风", "count": 1, "children": []}],
        "entries": [
            {"id": "artist_nai45_strings_0001", "title": "W.O.F 001", "path": ["W.O.F_画风"],
             "image": "artist_nai45_strings_0001.jpg", "isNew": True, "updateBatches": ["2026.8.23"]},
            {"id": "mengshen_pack-0001", "title": "梦神 001", "path": ["梦神NAI4.5F画风合集"],
             "image": "mengshen_pack-0001.jpg", "assetCodexId": "mengshen_pack"},
        ],
    }


def index_rows() -> list[dict]:
    return [
        {"id": "suozhang", "title": "所长常规"},
        {"id": "artist_nai45_personal", "type": "string", "title": "NovelAI v4.5单画师词典",
         "aliases": ["artist_300"], "version": "2026.7.12", "entryCount": 2, "imagedCount": 2,
         "cover": "artist_300_0001.jpg", "coverCodexId": "artist_300"},
        {"id": "artist_nai45_strings", "type": "string", "title": "NovelAI v4.5画师串词典",
         "version": "2026.8.23", "entryCount": 2, "imagedCount": 2,
         "newFilterLabel": "本次8.23更新",
         "updateFilters": [{"id": "2026.8.23", "label": "8.23更新", "latest": True}]},
    ]


class MergeBooksTests(unittest.TestCase):
    def setUp(self) -> None:
        self.merged = merge.merge_books(personal_book(), strings_book())

    def test_entries_are_pushed_one_level_down(self) -> None:
        paths = [e["path"] for e in self.merged["entries"]]
        self.assertEqual(paths[0], ["单画师词典", "300画师(4.5F版)"])
        self.assertEqual(paths[1], ["单画师词典", "千早爱音的单画师收藏", "1卷"])
        self.assertEqual(paths[2], ["画师串词典", "W.O.F_画风"])
        self.assertEqual(paths[3], ["画师串词典", "梦神NAI4.5F画风合集"])

    def test_entry_ids_are_untouched(self) -> None:
        self.assertEqual(
            [e["id"] for e in self.merged["entries"]],
            ["artist_300_0001", "artist_nai45_personal_0002",
             "artist_nai45_strings_0001", "mengshen_pack-0001"],
        )

    def test_wof_entries_get_asset_route_back_to_their_own_folder(self) -> None:
        wof = next(e for e in self.merged["entries"] if e["id"] == "artist_nai45_strings_0001")
        self.assertEqual(wof["assetCodexId"], "artist_nai45_strings")

    def test_existing_asset_routes_are_preserved(self) -> None:
        by_id = {e["id"]: e for e in self.merged["entries"]}
        self.assertEqual(by_id["mengshen_pack-0001"]["assetCodexId"], "mengshen_pack")
        self.assertEqual(by_id["artist_300_0001"]["assetCodexId"], "artist_300")
        self.assertNotIn("assetCodexId", by_id["artist_nai45_personal_0002"])

    def test_update_batch_flags_survive(self) -> None:
        wof = next(e for e in self.merged["entries"] if e["id"] == "artist_nai45_strings_0001")
        self.assertTrue(wof["isNew"])
        self.assertEqual(wof["updateBatches"], ["2026.8.23"])

    def test_meta_is_merged(self) -> None:
        self.assertEqual(self.merged["title"], "NovelAI v4.5画师词典")
        self.assertEqual(self.merged["version"], "2026.8.23")
        self.assertEqual(self.merged["entryCount"], 4)
        self.assertEqual(self.merged["imagedCount"], 4)
        self.assertIn("artist_nai45_strings", self.merged["aliases"])
        self.assertIn("artist_300", self.merged["aliases"])
        self.assertEqual(self.merged["author"], "千早爱音 / 兔 / PieDriver / 梦神")
        self.assertEqual(len(self.merged["contributors"]), 2)

    def test_tree_gets_two_top_levels(self) -> None:
        names = [(n["name"], n["count"], [c["name"] for c in n["children"]]) for n in self.merged["tree"]]
        self.assertEqual(names, [
            ("单画师词典", 2, ["300画师(4.5F版)"]),
            ("画师串词典", 2, ["W.O.F_画风"]),
        ])

    def test_source_book_is_not_mutated(self) -> None:
        book = strings_book()
        merge.merge_books(personal_book(), book)
        self.assertEqual(book["entries"][0]["path"], ["W.O.F_画风"])


class MergeIndexTests(unittest.TestCase):
    def setUp(self) -> None:
        self.merged = merge.merge_books(personal_book(), strings_book())
        self.index = merge.merge_index(index_rows(), self.merged)

    def test_strings_row_is_removed_and_position_kept(self) -> None:
        self.assertEqual([c["id"] for c in self.index], ["suozhang", "artist_nai45_personal"])

    def test_row_takes_merged_metadata_but_keeps_cover(self) -> None:
        row = self.index[1]
        self.assertEqual(row["title"], "NovelAI v4.5画师词典")
        self.assertEqual(row["entryCount"], 4)
        self.assertEqual(row["cover"], "artist_300_0001.jpg")
        self.assertEqual(row["coverCodexId"], "artist_300")

    def test_book_level_update_filter_moves_over(self) -> None:
        row = self.index[1]
        self.assertEqual(row["newFilterLabel"], "本次8.23更新")
        self.assertEqual(row["updateFilters"][0]["id"], "2026.8.23")

    def test_validate_passes(self) -> None:
        self.assertEqual(merge.validate(self.merged, self.index), [])

    def test_validate_catches_a_missing_asset_route(self) -> None:
        broken = dict(self.merged)
        broken["entries"] = [dict(e) for e in self.merged["entries"]]
        for entry in broken["entries"]:
            if entry["path"][0] == "画师串词典":
                entry.pop("assetCodexId", None)
        problems = merge.validate(broken, self.index)
        self.assertTrue(any("assetCodexId" in p for p in problems))


if __name__ == "__main__":
    unittest.main()
