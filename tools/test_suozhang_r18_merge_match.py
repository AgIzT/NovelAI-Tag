# -*- coding: utf-8 -*-

import unittest

from codex_update_match import match_entries
from suozhang_r18_merge_match import (
    build_applied_codex,
    build_updated_codex_index,
    merge_source_halves,
    normalize_legacy_oc_entries,
    split_legacy_oc_blocks,
)


def item(title, path, tags, *, entry_id=None):
    value = {
        "title": title,
        "path": list(path),
        "tags": tags,
        "isNew": False,
    }
    if entry_id:
        value["id"] = entry_id
    return value


class SuozhangR18MergeMatchTests(unittest.TestCase):
    def test_merge_removes_only_lower_artist_group_and_keeps_lower_oc(self):
        shared = item("NAI4.5时期：", ["编纂者杂项", "编纂者常用画师组"], "artist:a,")
        upper = [shared, item("编纂者OC(1)", ["编纂者杂项", "编纂者OC"], "upper oc,")]
        lower = [
            dict(shared),
            item("编纂者OC(1)", ["编纂者杂项", "编纂者oc二则"], "lower oc,"),
            item("下册内容", ["下册"], "lower content,"),
        ]

        result = merge_source_halves(upper, lower)

        self.assertEqual(result["stats"]["lowerArtistCardsRemoved"], 1)
        self.assertEqual(result["stats"]["mergedCount"], 4)
        self.assertEqual(result["special"]["upperOcCards"], 1)
        self.assertEqual(result["special"]["lowerOcCardsKept"], 1)
        self.assertEqual(
            [entry["title"] for entry in result["merged"]],
            ["NAI4.5时期：", "编纂者OC(1)", "编纂者OC(1)", "下册内容"],
        )

    def test_merge_rejects_divergent_lower_artist_group(self):
        upper = [item("NAI4.5时期：", ["编纂者杂项", "编纂者常用画师组"], "artist:a,")]
        lower = [item("NAI4.5时期：", ["编纂者杂项", "编纂者常用画师组"], "artist:b,")]

        with self.assertRaises(ValueError):
            merge_source_halves(upper, lower)

    def test_legacy_oc_giant_tag_is_split_without_marker_leaks(self):
        tags = "body one,（本体）\noutfit one,（服装）\nbody two,（本体）\noutfit two,（服装）"

        self.assertEqual(
            split_legacy_oc_blocks(tags),
            ["body one,\noutfit one,", "body two,\noutfit two,"],
        )

    def test_normalization_keeps_old_id_on_first_oc_card(self):
        legacy = item(
            "(未命名)",
            ["编纂者杂项", "编纂者oc二则"],
            "body one,（本体）\noutfit one,（服装）\nbody two,（本体）\noutfit two,（服装）",
            entry_id="codex_8489ac52-0003",
        )

        normalized, records = normalize_legacy_oc_entries([legacy])

        self.assertEqual(normalized[0]["id"], "codex_8489ac52-0003")
        self.assertEqual(normalized[0]["title"], "编纂者OC(1)")
        self.assertNotIn("本体", normalized[0]["tags"])
        self.assertEqual(records[0]["blockCount"], 2)
        self.assertEqual(records[0]["structuralEntries"][0]["title"], "编纂者OC(2)")

    def test_matching_after_merge_preserves_id_across_half_and_path_move(self):
        old = [
            item(
                "连续片段",
                ["上册", "旧目录"],
                "unique,stable,prompt,",
                entry_id="codex_6e699406-0042",
            )
        ]
        merged = merge_source_halves(
            [],
            [item("连续片段", ["下册", "新目录"], "unique,stable,prompt,")],
        )

        result = match_entries(old, merged["merged"])

        self.assertEqual(result["summary"]["matched"], 1)
        self.assertEqual(result["matches"][0]["old"]["id"], "codex_6e699406-0042")
        self.assertEqual(result["matches"][0]["changes"], ["path"])

    def test_apply_preserves_metadata_and_allocates_each_half_after_history(self):
        moved = {
            **item(
                "连续片段",
                ["上册", "旧目录"],
                "unique,stable,prompt,",
                entry_id="codex_6e699406-0010",
            ),
            "image": "codex_6e699406-0010.jpg",
            "original": "codex_6e699406-0010.png",
            "assetRev": "abc123",
            "imageWidth": 753,
            "imageHeight": 1100,
        }
        lower_old = item(
            "下册旧项", ["下册"], "lower,stable,prompt,", entry_id="codex_8489ac52-0020"
        )
        removed = item(
            "删除项", ["上册"], "removed,prompt,", entry_id="codex_6e699406-0099"
        )
        old_entries = [moved, lower_old, removed]
        merged = merge_source_halves(
            [item("上册新增", ["上册"], "brand,new,upper,")],
            [
                item("连续片段", ["下册", "新目录"], "unique,stable,prompt,"),
                item("下册旧项", ["下册"], "lower,stable,prompt,"),
                item("下册新增", ["下册"], "brand,new,lower,"),
            ],
        )
        match_result = match_entries(old_entries, merged["merged"])
        codex = {
            "id": "suozhang_r18",
            "title": "测试",
            "version": "old",
            "author": "测试",
            "entryCount": len(old_entries),
            "imagedCount": 1,
            "tree": [],
            "entries": old_entries,
        }

        applied, stats = build_applied_codex(
            codex,
            merged["merged"],
            match_result,
            "new",
            reserved_ids={"codex_8489ac52-0090"},
        )

        self.assertEqual(applied["version"], "new")
        self.assertEqual(applied["entryCount"], 4)
        self.assertEqual(applied["imagedCount"], 1)
        self.assertEqual(applied["entries"][0]["id"], "codex_6e699406-0100")
        self.assertEqual(applied["entries"][1]["id"], "codex_6e699406-0010")
        self.assertEqual(applied["entries"][1]["assetRev"], "abc123")
        self.assertEqual(applied["entries"][1]["path"], ["下册", "新目录"])
        self.assertEqual(applied["entries"][3]["id"], "codex_8489ac52-0091")
        self.assertNotIn("sourceHalf", applied["entries"][0])
        self.assertEqual(stats["matchedInherited"], 2)
        self.assertEqual(stats["newIdCount"], 2)
        self.assertEqual(stats["removedIds"], ["codex_6e699406-0099"])

    def test_index_update_preserves_extended_metadata(self):
        index = [
            {"id": "other", "entryCount": 1},
            {
                "id": "suozhang_r18",
                "version": "old",
                "entryCount": 3,
                "imagedCount": 1,
                "author": "curated author",
                "nsfw": True,
            },
        ]
        codex = {"version": "new", "entryCount": 4, "imagedCount": 2}

        updated = build_updated_codex_index(index, codex)

        self.assertEqual(updated[1]["version"], "new")
        self.assertEqual(updated[1]["entryCount"], 4)
        self.assertEqual(updated[1]["imagedCount"], 2)
        self.assertEqual(updated[1]["author"], "curated author")
        self.assertTrue(updated[1]["nsfw"])


if __name__ == "__main__":
    unittest.main()
