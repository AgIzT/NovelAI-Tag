# -*- coding: utf-8 -*-

import json
from pathlib import Path
import tempfile
import unittest

from codex_update_match import match_entries
from suozhang_r18_merge_match import (
    build_applied_codex,
    build_summary_payload,
    build_updated_codex_index,
    load_merged_source_snapshot,
    merge_source_halves,
    normalize_legacy_oc_entries,
    resolve_manual_match_overrides,
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

    def test_audited_desk_override_collapses_three_cards_and_keeps_main_asset(self):
        path = ["各种涩涩", "1girl系列", "自慰"]
        old = [
            item("地铁自慰高潮", path, "stable,before,", entry_id="codex_6e699406-2543"),
            {
                **item(
                    "桌角自慰（柚子社名场面）",
                    path,
                    "old,desk,main,",
                    entry_id="codex_6e699406-2544",
                ),
                "image": "codex_6e699406-2544.jpg",
                "original": "codex_6e699406-2544.png",
                "assetRev": "stable-desk-rev",
                "imageWidth": 753,
                "imageHeight": 1100,
            },
            item("其他版本1", path, "old,desk,variant,one,", entry_id="codex_6e699406-2545"),
            item("其他版本2", path, "old,desk,variant,two,", entry_id="codex_6e699406-2546"),
            item("床上自慰", path, "stable,after,", entry_id="codex_6e699406-2547"),
        ]
        new = [
            item("地铁自慰高潮", path, "stable,before,"),
            {**item("桌角自慰", path, "fully,rewritten,desk,"), "isNew": True},
            item("床上自慰", path, "stable,after,"),
        ]

        automatic = match_entries(old, new)
        forced_pairs, audit = resolve_manual_match_overrides(
            old, new, context="upper"
        )
        result = match_entries(old, new, forced_pairs=forced_pairs)

        self.assertEqual(result["summary"]["matched"], automatic["summary"]["matched"] + 1)
        self.assertEqual(result["summary"]["clearAdditions"], automatic["summary"]["clearAdditions"] - 1)
        self.assertEqual(result["summary"]["clearRemovals"], automatic["summary"]["clearRemovals"] - 1)
        self.assertTrue(audit[0]["applied"])
        self.assertEqual(result["matches"][1]["method"], "manual_override")

        codex = {
            "id": "suozhang_r18",
            "title": "测试",
            "version": "2026.7.15",
            "entryCount": len(old),
            "imagedCount": 1,
            "tree": [],
            "entries": old,
        }
        applied, stats = build_applied_codex(codex, new, result, "2026.8.14")
        desk = applied["entries"][1]
        self.assertEqual(desk["id"], "codex_6e699406-2544")
        self.assertEqual(desk["image"], "codex_6e699406-2544.jpg")
        self.assertEqual(desk["assetRev"], "stable-desk-rev")
        self.assertEqual(desk["updateBatches"], ["2026.8.14"])
        self.assertEqual(
            stats["removedIds"],
            ["codex_6e699406-2545", "codex_6e699406-2546"],
        )

        merged_new = [
            {**entry, "sourceHalf": "upper", "sourceIndex": index}
            for index, entry in enumerate(new)
        ]
        global_pairs, global_audit = resolve_manual_match_overrides(
            old, merged_new, context="global"
        )
        self.assertEqual(global_pairs, forced_pairs)
        self.assertTrue(global_audit[0]["applied"])

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
            "curatedNote": "keep me",
            "updateBatches": ["2026.7.15"],
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
                {
                    **item("连续片段", ["下册", "新目录"], "unique,stable,prompt,"),
                    "isNew": True,
                },
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
        self.assertEqual(applied["entries"][1]["curatedNote"], "keep me")
        self.assertEqual(applied["entries"][1]["path"], ["下册", "新目录"])
        self.assertEqual(
            applied["entries"][1]["updateBatches"], ["2026.7.15", "new"]
        )
        self.assertEqual(applied["entries"][3]["id"], "codex_8489ac52-0091")
        self.assertNotIn("sourceHalf", applied["entries"][0])
        self.assertEqual(stats["matchedInherited"], 2)
        self.assertEqual(stats["newIdCount"], 2)
        self.assertEqual(stats["removedIds"], ["codex_6e699406-0099"])
        self.assertEqual(stats["latestUpdateBatchCount"], 1)

    def test_legacy_is_new_seeds_r18_history_and_index_filter(self):
        old = item(
            "旧批次", ["上册"], "stable,tags,", entry_id="codex_6e699406-0010"
        )
        old["isNew"] = True
        candidate = item("旧批次", ["上册"], "stable,tags,")
        merged = merge_source_halves([candidate], [])
        match_result = match_entries([old], merged["merged"])
        codex = {
            "id": "suozhang_r18",
            "title": "测试",
            "version": "2026.7.15",
            "entryCount": 1,
            "imagedCount": 0,
            "tree": [],
            "entries": [old],
        }

        applied, _stats = build_applied_codex(
            codex,
            merged["merged"],
            match_result,
            "2026.8.14",
        )
        self.assertFalse(applied["entries"][0]["isNew"])
        self.assertEqual(
            applied["entries"][0]["updateBatches"], ["2026.7.15"]
        )

        index = [{
            "id": "suozhang_r18",
            "version": "2026.7.15",
            "newFilterLabel": "本次7.15更新",
            "entryCount": 1,
            "imagedCount": 0,
        }]
        updated = build_updated_codex_index(index, applied)
        self.assertEqual(
            updated[0]["updateFilters"],
            [
                {"id": "2026.7.15", "label": "7.15更新"},
                {"id": "2026.8.14", "label": "8.14更新", "latest": True},
            ],
        )

    def test_apply_keeps_normalized_character_prompts(self):
        old = item(
            "角色场景", ["上册"], "scene,", entry_id="codex_6e699406-0010"
        )
        old["characterPrompts"] = [{"label": "char1", "prompt": "old girl,"}]
        candidate = item("角色场景", ["上册"], "scene,")
        candidate["characterPrompts"] = [{"label": "char1", "prompt": "new girl,"}]
        merged = merge_source_halves([candidate], [])
        result = match_entries([old], merged["merged"])
        codex = {
            "id": "suozhang_r18",
            "title": "测试",
            "version": "old",
            "entryCount": 1,
            "imagedCount": 0,
            "tree": [],
            "entries": [old],
        }

        applied, _ = build_applied_codex(codex, merged["merged"], result, "new")

        self.assertEqual(
            applied["entries"][0]["characterPrompts"],
            [{"label": "char1", "prompt": "new girl,"}],
        )

    def test_loads_gated_merged_source_snapshot_as_replay_baseline(self):
        payload = {
            "schema": 1,
            "codexId": "suozhang_r18",
            "version": "2026.7.15",
            "entryCount": 2,
            "stats": {"lowerArtistCardsRemoved": 12, "artistSubsetVerified": True},
            "specialHandling": {"lowerArtistCardsRemoved": 12},
            "entries": [
                {**item("上", ["上册"], "upper,"), "sourceHalf": "upper", "sourceIndex": 0},
                {**item("下", ["下册"], "lower,"), "sourceHalf": "lower", "sourceIndex": 0},
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "merged-source.json"
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

            merged, version = load_merged_source_snapshot(path)

        self.assertEqual(version, "2026.7.15")
        self.assertEqual(len(merged["upper"]), 1)
        self.assertEqual(len(merged["lower"]), 1)
        self.assertEqual(merged["stats"]["mergedCount"], 2)
        self.assertEqual(merged["stats"]["lowerParsed"], 13)

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
                "newFilterLabel": "本次7.15更新",
                "updateFilters": [
                    {"id": "2026.7.15", "label": "7.15更新", "latest": True}
                ],
            },
        ]
        codex = {
            "version": "2026.8.14",
            "entryCount": 4,
            "imagedCount": 2,
            "entries": [
                {
                    "id": "codex_6e699406-0001",
                    "isNew": False,
                    "updateBatches": ["2026.7.15"],
                },
                {
                    "id": "codex_6e699406-0002",
                    "isNew": True,
                    "updateBatches": ["2026.8.14"],
                },
                {"id": "codex_8489ac52-0001", "isNew": False},
                {"id": "codex_8489ac52-0002", "isNew": False},
            ],
        }

        updated = build_updated_codex_index(index, codex)

        self.assertEqual(updated[1]["version"], "2026.8.14")
        self.assertEqual(updated[1]["entryCount"], 4)
        self.assertEqual(updated[1]["imagedCount"], 2)
        self.assertEqual(updated[1]["author"], "curated author")
        self.assertTrue(updated[1]["nsfw"])
        self.assertEqual(updated[1]["newFilterLabel"], "本次8.14更新")
        self.assertEqual(
            updated[1]["updateFilters"],
            [
                {"id": "2026.7.15", "label": "7.15更新"},
                {"id": "2026.8.14", "label": "8.14更新", "latest": True},
            ],
        )

    def test_gate_rejects_non_strict_baseline_without_review_or_content_drift(self):
        old = [item("旧卡", ["旧目录"], "old tags,", entry_id="codex_6e699406-0001")]
        baseline = [item("完全不同", ["新目录"], "unrelated tags,")]
        current = [item("旧卡", ["旧目录"], "old tags,")]
        baseline_result = match_entries(old, baseline)
        new_result = match_entries(old, current)
        self.assertFalse(baseline_result["summary"]["strictReplayPass"])
        self.assertEqual(baseline_result["summary"]["contentChanged"], 0)
        self.assertEqual(baseline_result["review"], [])

        classification = {
            "structuralOcSplits": [],
            "preexistingSourceOnlyAdditions": [],
            "genuineAdditions": [],
            "preexistingFormalOnlyRemovals": [],
            "genuineRemovals": [],
            "contentChanges": [],
            "flagOnlyChanges": [],
            "review": [],
        }
        merge_stats = {
            "upperParsed": 1,
            "lowerParsed": 1,
            "lowerArtistCardsRemoved": 1,
            "lowerKept": 1,
            "mergedCount": 1,
            "artistSubsetVerified": True,
        }
        new_merge = {
            "stats": merge_stats,
            "special": {
                "upperArtistCards": 1,
                "lowerArtistCardsRemoved": 1,
                "upperOcCards": 1,
                "lowerOcCardsKept": 1,
                "unnamedSpecialCards": 0,
                "markerLeaks": 0,
            },
        }
        empty_audit = {"blockers": []}
        payload = build_summary_payload(
            codex={"entries": old, "entryCount": 1, "imagedCount": 0},
            old_version="2026.7.15",
            baseline_version="2026.7.15",
            new_version="2026.8.14",
            old_merge={"stats": merge_stats},
            new_merge=new_merge,
            structures={"upper": {}, "lower": {}},
            baseline_global=baseline_result,
            new_global=new_result,
            classification_global=classification,
            baseline_results={"upper": baseline_result, "lower": baseline_result},
            new_results={"upper": new_result, "lower": new_result},
            classifications={"upper": classification, "lower": classification},
            global_normalizations=[],
            normalizations={"upper": [], "lower": []},
            character_normalization={
                "baseline": {"upper": empty_audit, "lower": empty_audit},
                "new": {"upper": empty_audit, "lower": empty_audit},
            },
            manual_match_overrides={
                "baselineApplied": False,
                "perHalf": {"upper": [], "lower": []},
                "global": [],
            },
            sources={},
            report_paths={},
        )

        self.assertFalse(payload["matchingGatePass"])
        self.assertFalse(payload["summary"]["baselineStrictReplayPass"])


if __name__ == "__main__":
    unittest.main()
