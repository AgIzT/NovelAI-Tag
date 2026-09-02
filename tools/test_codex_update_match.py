# -*- coding: utf-8 -*-

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import convert as convert_module
from codex_update_match import (
    apply_current_update_batch,
    apply_audited_source_new_overrides,
    build_application_gate,
    build_applied_codex,
    build_updated_codex_index,
    load_baseline_json,
    match_entries,
    norm_tags_value,
    normalize_suozhang_entries,
    normalize_update_batches,
    short_update_filter_label,
    update_filter_history,
    validate_codex_identity,
    write_json_pair_with_rollback,
)
from convert import (
    assign_stable_ids,
    codex_summary_from_file,
    collect_standard_review_items,
    image_metadata,
    is_compiler_oc_path,
    keep_about_fields,
    merge_kept_index_meta,
)


def entry(
    entry_id,
    title,
    path,
    tags,
    *,
    is_new=False,
    image=None,
    character_prompts=None,
):
    result = {
        "id": entry_id,
        "title": title,
        "path": list(path),
        "tags": tags,
        "isNew": is_new,
    }
    if image is not None:
        result["image"] = image
    if character_prompts is not None:
        result["characterPrompts"] = character_prompts
    return result


class CodexUpdateMatchTests(unittest.TestCase):
    def test_convert_normalizes_standalone_role_cards_before_assigning_ids(self):
        prompts = [
            {"label": "char1", "prompt": "cat,chibi,target#being held,"},
            {"label": "char2", "prompt": "girl,upper body,source#holding another under armpits,"},
        ]
        old = [
            entry(
                "suozhang-2699",
                "拉长猫猫（n4限定）",
                ["各式场景", "场景", "表情包/搞怪"],
                "1girl,1other,longcat (meme),",
                character_prompts=prompts,
            )
        ]
        raw = [
            entry(
                None,
                "拉长猫猫（n4限定）",
                ["各式场景", "场景", "表情包/搞怪"],
                "1girl,1other,longcat (meme),",
            ),
            entry(
                None,
                "角色1",
                ["各式场景", "场景", "表情包/搞怪"],
                prompts[0]["prompt"],
            ),
            entry(
                None,
                "角色2",
                ["各式场景", "场景", "表情包/搞怪"],
                prompts[1]["prompt"],
            ),
        ]
        assigned = {}

        def fake_assign(cid, items, old_entries=None):
            assigned["cid"] = cid
            assigned["items"] = items
            assigned["old_entries"] = old_entries
            return [
                {**item, "id": f"{cid}-0001", "image": None}
                for item in items
            ]

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "所长常规NovelAI个人法典（2026.8.31版）.docx"
            source.write_bytes(b"placeholder")
            with patch.object(convert_module, "Document", return_value=object()), \
                patch.object(convert_module, "parse_standard_docx_items", return_value=raw), \
                patch.object(convert_module, "load_existing_entries", return_value=old), \
                patch.object(convert_module, "assign_stable_ids", side_effect=fake_assign), \
                patch.object(convert_module, "DATA_DIR", directory):
                result = convert_module.convert(str(source), "suozhang")

        self.assertEqual(result["entryCount"], 1)
        self.assertEqual(assigned["cid"], "suozhang")
        self.assertIs(assigned["old_entries"], old)
        self.assertEqual(len(assigned["items"]), 1)
        self.assertEqual(assigned["items"][0]["characterPrompts"], prompts)

    def test_codex_identity_rejects_explicitly_mismatched_data_file(self):
        validate_codex_identity({"id": "suozhang"}, "suozhang")
        with self.assertRaisesRegex(ValueError, "codex ID mismatch"):
            validate_codex_identity({"id": "suozhang_r18"}, "suozhang")

    def test_json_pair_rolls_back_when_index_replace_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "data.json"
            index_path = root / "index.json"
            data_path.write_bytes(b"old-data")
            index_path.write_bytes(b"old-index")
            real_replace = Path.replace
            failing_tmp = index_path.with_suffix(index_path.suffix + ".tmp")

            def replace_with_second_failure(path, target):
                if path == failing_tmp and Path(target) == index_path:
                    raise OSError("simulated locked index")
                return real_replace(path, target)

            with patch.object(Path, "replace", new=replace_with_second_failure):
                with self.assertRaisesRegex(OSError, "simulated locked index"):
                    write_json_pair_with_rollback(
                        data_path,
                        {"value": "new-data"},
                        index_path,
                        {"value": "new-index"},
                    )

            self.assertEqual(data_path.read_bytes(), b"old-data")
            self.assertEqual(index_path.read_bytes(), b"old-index")
            self.assertFalse(data_path.with_suffix(".json.tmp").exists())
            self.assertFalse(index_path.with_suffix(".json.tmp").exists())
            self.assertFalse(data_path.with_suffix(".json.rollback").exists())
            self.assertFalse(index_path.with_suffix(".json.rollback").exists())

    def test_json_pair_keeps_recovery_copy_when_rollback_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "data.json"
            index_path = root / "index.json"
            data_path.write_bytes(b"old-data")
            index_path.write_bytes(b"old-index")
            real_replace = Path.replace
            index_tmp = index_path.with_suffix(index_path.suffix + ".tmp")
            data_restore = data_path.with_suffix(data_path.suffix + ".rollback")

            def replace_with_double_failure(path, target):
                if path == index_tmp and Path(target) == index_path:
                    raise OSError("simulated locked index")
                if path == data_restore and Path(target) == data_path:
                    raise OSError("simulated rollback failure")
                return real_replace(path, target)

            with patch.object(Path, "replace", new=replace_with_double_failure):
                with self.assertRaisesRegex(
                    RuntimeError, "rollback was incomplete"
                ) as caught:
                    write_json_pair_with_rollback(
                        data_path,
                        {"value": "new-data"},
                        index_path,
                        {"value": "new-index"},
                    )

            self.assertIn(str(data_restore), str(caught.exception))
            self.assertEqual(data_restore.read_bytes(), b"old-data")
            self.assertEqual(index_path.read_bytes(), b"old-index")
            self.assertFalse(index_tmp.exists())

    def test_strict_replay_matches_everything_unchanged(self):
        old = [
            entry("book-0001", "甲", ["分类一"], "alpha,beta,"),
            entry("book-0002", "乙", ["分类二"], "gamma,delta,"),
        ]
        result = match_entries(old, [dict(item) for item in old])

        self.assertTrue(result["summary"]["strictReplayPass"])
        self.assertEqual(result["summary"]["matched"], 2)
        self.assertEqual(result["summary"]["unchanged"], 2)
        self.assertFalse(result["additions"])
        self.assertFalse(result["removals"])

    def test_add_modify_and_reduce_are_separated(self):
        old = [
            entry("book-0001", "保留", ["甲"], "alpha,beta,"),
            entry("book-0002", "修改", ["乙"], "gamma,delta,"),
            entry("book-0003", "删除", ["丙"], "old,removed,entry,"),
        ]
        new = [
            entry(None, "保留", ["甲"], "alpha,beta,"),
            entry(None, "修改", ["乙"], "gamma,delta,epsilon,"),
            entry(None, "新增", ["丁"], "brand,new,prompt,"),
        ]
        result = match_entries(old, new)

        self.assertEqual(result["summary"]["matched"], 2)
        self.assertEqual(result["summary"]["changed"], 1)
        self.assertEqual(result["summary"]["clearAdditions"], 1)
        self.assertEqual(result["summary"]["clearRemovals"], 1)
        changed = [item for item in result["matches"] if item["changes"]]
        self.assertEqual(changed[0]["old"]["id"], "book-0002")
        self.assertEqual(changed[0]["changes"], ["tags"])

    def test_forced_pair_runs_before_automatic_matching(self):
        old = [
            entry("book-0001", "旧主卡", ["分类"], "old,main,", image="book-0001.jpg"),
            entry("book-0002", "旧变体", ["分类"], "old,variant,"),
        ]
        new = [entry(None, "重写主卡", ["分类"], "fully,rewritten,")]

        without_override = match_entries(old, new)
        result = match_entries(old, new, forced_pairs={0: 0})

        self.assertEqual(without_override["summary"]["matched"], 0)
        self.assertEqual(result["summary"]["matched"], 1)
        self.assertEqual(result["summary"]["clearAdditions"], 0)
        self.assertEqual(result["summary"]["clearRemovals"], 1)
        self.assertEqual(result["matches"][0]["method"], "manual_override")
        self.assertEqual(result["matches"][0]["old"]["id"], "book-0001")
        self.assertEqual(result["matches"][0]["old"]["image"], "book-0001.jpg")

    def test_forced_pairs_reject_invalid_or_reused_indices(self):
        old = [
            entry("book-0001", "甲", ["分类"], "alpha,"),
            entry("book-0002", "乙", ["分类"], "beta,"),
        ]
        new = [entry(None, "新", ["分类"], "new,")]

        with self.assertRaisesRegex(ValueError, "forced old index out of range"):
            match_entries(old, new, forced_pairs={2: 0})
        with self.assertRaisesRegex(ValueError, "forced new index out of range"):
            match_entries(old, new, forced_pairs={0: 1})
        with self.assertRaisesRegex(ValueError, "forced new index is duplicated"):
            match_entries(old, new, forced_pairs={0: 0, 1: 0})

    def test_exact_tags_preserve_id_across_rename_and_move(self):
        old = [entry("book-0042", "旧标题", ["旧目录"], "unique,prompt,tags,")]
        new = [entry(None, "新标题", ["新目录"], "unique,prompt,tags,")]
        result = match_entries(old, new)

        self.assertEqual(result["summary"]["matched"], 1)
        match = result["matches"][0]
        self.assertEqual(match["method"], "unique_exact_tags")
        self.assertEqual(match["old"]["id"], "book-0042")
        self.assertEqual(match["changes"], ["path", "title"])

    def test_generic_title_with_unrelated_tags_is_not_auto_matched(self):
        old = [entry("book-0007", "原版", ["服装"], "alpha,beta,gamma,")]
        new = [entry(None, "原版", ["服装"], "xray,yankee,zulu,")]
        result = match_entries(old, new)

        self.assertEqual(result["summary"]["matched"], 0)
        self.assertEqual(result["summary"]["clearAdditions"], 1)
        self.assertEqual(result["summary"]["clearRemovals"], 1)

    def test_ambiguous_duplicate_structure_is_not_greedily_assigned(self):
        old = [
            entry("book-0010", "其他版本", ["服装"], "alpha,beta,gamma,"),
            entry("book-0011", "其他版本", ["服装"], "delta,epsilon,zeta,"),
        ]
        new = [
            entry(None, "其他版本", ["服装"], "one,two,three,"),
            entry(None, "其他版本", ["服装"], "four,five,six,"),
        ]
        result = match_entries(old, new)

        self.assertEqual(result["summary"]["matched"], 0)
        self.assertTrue(any(
            warning["kind"] == "ambiguous_same_path_title"
            for warning in result["warnings"]
        ))

    def test_is_new_flag_change_keeps_same_id(self):
        old = [entry("book-0001", "甲", ["分类"], "alpha,beta,", is_new=False)]
        new = [entry(None, "甲", ["分类"], "alpha,beta,", is_new=True)]
        result = match_entries(old, new)

        self.assertEqual(result["summary"]["matched"], 1)
        self.assertEqual(result["summary"]["flagOnlyChanged"], 1)
        self.assertEqual(result["matches"][0]["changes"], ["isNew"])
        self.assertTrue(result["summary"]["strictReplayPass"])

    def test_tag_normalization_ignores_spacing_around_weight_colons(self):
        self.assertEqual(
            norm_tags_value("1.2::artist:name ::, next,"),
            norm_tags_value("1.2::artist:name::,next,"),
        )

    def test_unique_title_and_similar_tags_can_follow_directory_move(self):
        old = [
            entry(
                "book-0099",
                "唯一标题",
                ["旧目录"],
                "alpha,beta,gamma,delta,epsilon,zeta,eta,theta,",
            )
        ]
        new = [
            entry(
                None,
                "唯一标题",
                ["新目录"],
                "alpha,beta,gamma,delta,epsilon,zeta,eta,theta,iota,",
            )
        ]
        result = match_entries(old, new)

        self.assertEqual(result["summary"]["matched"], 1)
        self.assertEqual(result["matches"][0]["method"], "unique_title_similar_tags")
        self.assertEqual(result["matches"][0]["old"]["id"], "book-0099")

    def test_duplicate_old_ids_are_reported(self):
        old = [
            entry("book-0001", "甲", ["分类"], "alpha,beta,"),
            entry("book-0001", "乙", ["分类"], "gamma,delta,"),
        ]
        result = match_entries(old, [dict(item) for item in old])

        self.assertTrue(any(
            issue["kind"] == "duplicate_old_ids"
            for issue in result["validationIssues"]
        ))

    def test_inserted_same_title_entry_cannot_steal_existing_ids_or_images(self):
        old = [
            entry(
                "book-0001", "原版杂项", ["分类"], "first,stable,prompt,",
                image="book-0001.jpg",
            ),
            entry(
                "book-0002", "原版杂项", ["分类"], "second,stable,prompt,",
                image="book-0002.jpg",
            ),
        ]
        new = [
            entry(None, "原版杂项", ["分类"], "brand,new,prompt,"),
            entry(None, "原版杂项", ["分类"], "first,stable,prompt,"),
            entry(None, "原版杂项", ["分类"], "second,stable,prompt,"),
        ]

        final = assign_stable_ids("book", new, old_entries=old)

        self.assertEqual(final[0]["id"], "book-0003")
        self.assertIsNone(final[0]["image"])
        self.assertEqual(final[1]["id"], "book-0001")
        self.assertEqual(final[1]["image"], "book-0001.jpg")
        self.assertEqual(final[2]["id"], "book-0002")
        self.assertEqual(final[2]["image"], "book-0002.jpg")

    def test_standard_review_collection_is_initialized_and_filters_dictionary_entries(self):
        regular = entry("book-0001", "单标签", ["常规"], "solo")
        dictionary = entry("book-0002", "词典项", ["各式场景", "视角与打光"], "solo")

        self.assertEqual(collect_standard_review_items([regular, dictionary]), [regular])

    def test_produced_index_refresh_preserves_non_generated_metadata(self):
        old = {
            "id": "book",
            "type": "codex",
            "version": "old",
            "hasOriginal": True,
            "source": "curated source",
        }
        refreshed = {"id": "book", "version": "new", "entryCount": 3}

        self.assertEqual(
            keep_about_fields(old, refreshed),
            {
                "id": "book",
                "type": "codex",
                "version": "new",
                "hasOriginal": True,
                "source": "curated source",
                "entryCount": 3,
            },
        )

    def test_kept_index_metadata_is_frozen(self):
        old = {"id": "book", "author": "curated", "entryCount": 2}
        file_meta = {"id": "book", "author": "raw source", "entryCount": 2}

        self.assertEqual(merge_kept_index_meta(old, file_meta), old)

    def test_non_codex_json_is_not_added_to_codex_index(self):
        handle, path = tempfile.mkstemp(suffix=".json")
        os.close(handle)
        try:
            with open(path, "w", encoding="utf-8") as stream:
                json.dump({"title": "strings", "entries": {}}, stream)
            self.assertIsNone(
                codex_summary_from_file(path, ("id", "title", "entryCount"))
            )
        finally:
            os.unlink(path)

    def test_existing_asset_revision_is_preserved_until_assets_are_refreshed(self):
        old = {
            "image": "book-0001.jpg",
            "original": "book-0001.png",
            "assetRev": "stable-content-rev",
        }
        with patch("convert.local_asset_rev", return_value="fresh-content-rev") as rev:
            preserved = image_metadata("missing-book", "book-0001", old)
            self.assertEqual(preserved["assetRev"], "stable-content-rev")
            rev.assert_not_called()

        with patch("convert.local_asset_rev", return_value="fresh-content-rev") as rev:
            refreshed = image_metadata(
                "missing-book", "book-0001", old, refresh_asset_rev=True
            )
            self.assertEqual(refreshed["assetRev"], "fresh-content-rev")
            rev.assert_called_once()

    def test_compiler_oc_heading_variants_are_recognized(self):
        self.assertTrue(is_compiler_oc_path(["编纂者杂项", "编纂者OC"]))
        self.assertTrue(is_compiler_oc_path(["编纂者杂项", "编纂者oc二则"]))
        self.assertFalse(is_compiler_oc_path(["编纂者杂项", "编纂者常用画师组"]))

    def test_duplicate_generic_title_can_match_after_one_tag_is_removed(self):
        old = [
            entry("book-0001", "其他版本2", ["分类"], "same,unchanged,tags,"),
            entry(
                "book-0002",
                "其他版本2",
                ["分类"],
                "alpha,beta,gamma,delta,epsilon,zeta,eta,theta,removed,",
            ),
        ]
        new = [
            entry(None, "其他版本2", ["分类"], "same,unchanged,tags,"),
            entry(
                None,
                "其他版本2",
                ["分类"],
                "alpha,beta,gamma,delta,epsilon,zeta,eta,theta,",
            ),
        ]

        result = match_entries(old, new)

        self.assertEqual(result["summary"]["matched"], 2)
        changed = [match for match in result["matches"] if match["changes"]]
        self.assertEqual(len(changed), 1)
        self.assertEqual(changed[0]["old"]["id"], "book-0002")
        self.assertEqual(changed[0]["changes"], ["tags"])
        self.assertFalse(result["review"])

    def test_structured_character_prompts_are_part_of_identity_and_allow_empty_tags(self):
        prompts = [{"label": "char1", "prompt": "girl,blue eyes,"}]
        old = [
            entry(
                "book-0001", "纯角色词", ["分类"], "",
                character_prompts=prompts,
            )
        ]
        same = [
            entry(None, "纯角色词", ["分类"], "", character_prompts=prompts)
        ]

        replay = match_entries(old, same)

        self.assertTrue(replay["summary"]["strictReplayPass"])
        self.assertFalse(replay["validationIssues"])
        self.assertEqual(replay["matches"][0]["new"]["characterPrompts"], prompts)

        changed = [
            entry(
                None,
                "纯角色词",
                ["分类"],
                "",
                character_prompts=[{"label": "char1", "prompt": "boy,blue eyes,"}],
            )
        ]
        result = match_entries(old, changed)
        self.assertEqual(result["matches"][0]["changes"], ["characterPrompts"])
        self.assertEqual(result["summary"]["contentChanged"], 1)

    def test_suozhang_source_normalization_reuses_standard_splitter(self):
        prompts = [
            {"label": "char1", "prompt": "girl,blue eyes,"},
            {"label": "char2", "prompt": "boy,black hair,"},
        ]
        old = [
            entry(
                "suozhang-0001",
                "角色场景",
                ["分类"],
                "scene,",
                character_prompts=prompts,
            )
        ]
        raw = [
            entry(
                None,
                "角色场景",
                ["分类"],
                "scene,\nchar1：girl,blue eyes,\nchar2:boy,black hair,",
            )
        ]

        normalized, audit = normalize_suozhang_entries(raw, old)
        result = match_entries(old, normalized)

        self.assertEqual(normalized[0]["tags"], "scene,")
        self.assertEqual(normalized[0]["characterPrompts"], prompts)
        self.assertEqual(audit["changedEntries"], 1)
        self.assertEqual(audit["standardChangedEntries"], 1)
        self.assertFalse(audit["blockers"])
        self.assertTrue(result["summary"]["strictReplayPass"])

    def test_suozhang_source_normalization_merges_adjacent_standalone_role_cards(self):
        prompts = [
            {"label": "char1", "prompt": "cat,chibi,target#being held,"},
            {"label": "char2", "prompt": "girl,upper body,source#holding another under armpits,"},
        ]
        old = [
            entry(
                "suozhang-2699",
                "拉长猫猫（n4限定）",
                ["各式场景", "场景", "表情包/搞怪"],
                "1girl,1other,longcat (meme),",
                character_prompts=prompts,
            ),
            entry(
                "suozhang-2702",
                "后续词条",
                ["各式场景", "场景", "表情包/搞怪"],
                "next,stable,",
            ),
        ]
        raw = [
            entry(
                None,
                "拉长猫猫（n4限定）",
                ["各式场景", "场景", "表情包/搞怪"],
                "1girl,1other,longcat (meme),",
            ),
            entry(
                None,
                "角色1",
                ["各式场景", "场景", "表情包/搞怪"],
                prompts[0]["prompt"],
            ),
            entry(
                None,
                "char2:",
                ["各式场景", "场景", "表情包/搞怪"],
                prompts[1]["prompt"],
            ),
            entry(
                None,
                "后续词条",
                ["各式场景", "场景", "表情包/搞怪"],
                "next,stable,",
            ),
        ]

        normalized, audit = normalize_suozhang_entries(raw, old)

        self.assertEqual(len(normalized), 2)
        self.assertEqual(normalized[0]["title"], "拉长猫猫（n4限定）")
        self.assertEqual(normalized[0]["characterPrompts"], prompts)
        self.assertEqual(normalized[1]["title"], "后续词条")
        self.assertEqual(len(audit["standaloneRoleCardMerges"]), 1)
        self.assertEqual(audit["standaloneRoleCardBoxes"], 2)
        self.assertFalse(audit["blockers"])

        result = match_entries(old, normalized)
        self.assertTrue(result["summary"]["strictReplayPass"])

    def test_suozhang_source_normalization_leaves_unproven_role_card_titles_alone(self):
        old = [
            entry(
                "suozhang-0001",
                "普通主卡",
                ["分类"],
                "scene,",
            )
        ]
        raw = [
            entry(None, "普通主卡", ["分类"], "scene,"),
            entry(None, "角色1", ["分类"], "girl,"),
        ]

        normalized, audit = normalize_suozhang_entries(raw, old)

        self.assertEqual(len(normalized), 2)
        self.assertNotIn("characterPrompts", normalized[0])
        self.assertEqual(normalized[1]["title"], "角色1")
        self.assertFalse(audit["standaloneRoleCardMerges"])
        self.assertFalse(audit["blockers"])

    def test_suozhang_source_normalization_blocks_mismatched_standalone_role_cards(self):
        old = [
            entry(
                "suozhang-0001",
                "主卡",
                ["分类"],
                "scene,",
                character_prompts=[{"label": "char1", "prompt": "girl,"}],
            )
        ]
        raw = [
            entry(None, "主卡", ["分类"], "scene,"),
            entry(None, "角色1", ["分类"], "boy,"),
        ]

        normalized, audit = normalize_suozhang_entries(raw, old)

        self.assertEqual(len(normalized), 2)
        self.assertEqual(normalized[1]["title"], "角色1")
        self.assertEqual(len(audit["blockers"]), 1)
        self.assertEqual(
            audit["blockers"][0]["reason"],
            "standalone_role_card_mismatch",
        )

    def test_suozhang_source_normalization_blocks_ambiguous_old_role_parents(self):
        prompts = [{"label": "char1", "prompt": "girl,"}]
        old = [
            entry(
                "suozhang-0001", "主卡", ["分类"], "scene,",
                character_prompts=prompts,
            ),
            entry(
                "suozhang-0002", "主卡", ["分类"], "different,",
                character_prompts=prompts,
            ),
        ]
        raw = [
            entry(None, "主卡", ["分类"], "scene,"),
            entry(None, "角色1", ["分类"], "girl,"),
        ]

        normalized, audit = normalize_suozhang_entries(raw, old)

        self.assertEqual(len(normalized), 2)
        self.assertEqual(
            audit["blockers"][0]["reason"],
            "ambiguous_standalone_role_parent",
        )
        self.assertEqual(audit["blockers"][0]["oldIds"], [
            "suozhang-0001", "suozhang-0002",
        ])

    def test_suozhang_source_normalization_reports_invalid_standard_split(self):
        raw = [entry(None, "坏角色词", ["分类"], "scene,\nchar1：")]

        normalized, audit = normalize_suozhang_entries(raw, [])

        self.assertEqual(normalized[0]["tags"], raw[0]["tags"])
        self.assertEqual(len(audit["blockers"]), 1)
        self.assertEqual(
            audit["blockers"][0]["reason"], "invalid_standard_character_prompts"
        )

    def test_suozhang_source_normalization_applies_audited_variant_by_old_id(self):
        old = [
            entry(
                "codex_6e699406-0879",
                "三人颜射",
                ["分类"],
                "scene,",
                character_prompts=[
                    {"label": "char1", "prompt": "girl,"},
                    {"label": "char2-4", "prompt": "group,"},
                ],
            )
        ]
        raw = [
            entry(
                None,
                "三人颜射",
                ["分类"],
                "scene,\nchar1：girl,\nchar2-4：group,",
            )
        ]

        normalized, audit = normalize_suozhang_entries(raw, old)

        self.assertEqual(normalized[0]["tags"], "scene,")
        self.assertEqual(
            [item["label"] for item in normalized[0]["characterPrompts"]],
            ["char1", "char2-4"],
        )
        self.assertEqual(audit["variantChangedEntries"], 1)
        self.assertFalse(audit["blockers"])

    def test_variant_structure_ambiguity_is_informational_when_rules_resolve_bodies(self):
        old = [
            entry(
                "codex_6e699406-0879",
                "其他版本1",
                ["分类"],
                "scene one,",
                character_prompts=[
                    {"label": "char1", "prompt": "girl,"},
                    {"label": "char2-4", "prompt": "group,"},
                ],
            ),
            entry(
                "codex_6e699406-0901",
                "其他版本1",
                ["分类"],
                "scene two,",
                character_prompts=[
                    {"label": "char1", "prompt": "girl,"},
                    {"label": "char2", "prompt": "boy,"},
                ],
            ),
        ]
        raw = [
            entry(
                None,
                "其他版本1",
                ["分类"],
                "scene one,\nchar1：girl,\nchar2-4：group,",
            ),
            entry(
                None,
                "其他版本1",
                ["分类"],
                "scene two,\nchar1：girl,\ncher2：boy,",
            ),
        ]

        normalized, audit = normalize_suozhang_entries(raw, old)

        self.assertEqual(audit["variantChangedEntries"], 2)
        self.assertEqual(len(audit["variantAmbiguities"]), 1)
        self.assertFalse(audit["blockers"])
        self.assertEqual(normalized[0]["tags"], "scene one,")
        self.assertEqual(normalized[1]["tags"], "scene two,")

    def test_baseline_json_supports_entries_and_match_report_reconstruction(self):
        direct_handle, direct_path = tempfile.mkstemp(suffix=".json")
        report_handle, report_path = tempfile.mkstemp(suffix=".json")
        os.close(direct_handle)
        os.close(report_handle)
        try:
            with open(direct_path, "w", encoding="utf-8") as stream:
                json.dump({
                    "version": "1.0",
                    "entries": [entry(None, "甲", ["分类"], "alpha,")],
                }, stream, ensure_ascii=False)
            entries, metadata = load_baseline_json(Path(direct_path))
            self.assertEqual(len(entries), 1)
            self.assertEqual(metadata["version"], "1.0")

            with open(report_path, "w", encoding="utf-8") as stream:
                json.dump({
                    "newVersion": "2.0",
                    "matches": [{
                        "new": {**entry(None, "甲", ["分类"], "alpha,"), "index": 0}
                    }],
                    "unmatchedNew": [
                        {**entry(None, "乙", ["分类"], "beta,"), "index": 1}
                    ],
                    "docxStructure": {"tables": 0},
                }, stream, ensure_ascii=False)
            entries, metadata = load_baseline_json(Path(report_path))
            self.assertEqual([item["title"] for item in entries], ["甲", "乙"])
            self.assertEqual(metadata["version"], "2.0")
            self.assertEqual(metadata["structure"], {"tables": 0})
        finally:
            os.unlink(direct_path)
            os.unlink(report_path)

    def test_gated_apply_preserves_non_source_metadata_and_skips_reserved_ids(self):
        old = [
            {
                **entry(
                    "book-0002",
                    "保留",
                    ["旧目录"],
                    "old,tags,",
                    image="book-0002.jpg",
                    character_prompts=[{"label": "char1", "prompt": "old girl,"}],
                ),
                "original": "book-0002.png",
                "assetRev": "stable-rev",
                "imageWidth": 800,
                "imageHeight": 1100,
                "curatedNote": "keep me",
                "updateBatches": ["2026.7.15"],
            }
        ]
        new = [
            entry(
                None,
                "保留",
                ["旧目录"],
                "new,tags,",
                is_new=True,
                character_prompts=[{"label": "char1", "prompt": "new girl,"}],
            ),
            entry(None, "新增", ["分类"], "brand,new,", is_new=True),
        ]
        result = match_entries(old, new)
        codex = {
            "id": "book",
            "title": "测试",
            "version": "old",
            "author": "作者",
            "entryCount": 1,
            "imagedCount": 1,
            "tree": [],
            "entries": old,
        }

        applied, stats = build_applied_codex(
            codex, new, result, "new", reserved_ids={"book-0099"}
        )

        self.assertEqual(applied["entries"][0]["id"], "book-0002")
        self.assertEqual(applied["entries"][0]["image"], "book-0002.jpg")
        self.assertEqual(applied["entries"][0]["assetRev"], "stable-rev")
        self.assertEqual(applied["entries"][0]["curatedNote"], "keep me")
        self.assertEqual(applied["entries"][0]["path"], ["旧目录"])
        self.assertEqual(
            applied["entries"][0]["characterPrompts"][0]["prompt"], "new girl,"
        )
        self.assertEqual(applied["entries"][1]["id"], "book-0100")
        self.assertIsNone(applied["entries"][1]["image"])
        self.assertEqual(
            applied["entries"][0]["updateBatches"], ["2026.7.15", "new"]
        )
        self.assertEqual(applied["entries"][1]["updateBatches"], ["new"])
        self.assertEqual(stats["newIds"], ["book-0100"])
        self.assertEqual(stats["latestUpdateBatchCount"], 2)

    def test_gated_index_refresh_preserves_extended_metadata(self):
        index = [
            {"id": "other", "entryCount": 1},
            {
                "id": "book",
                "version": "old",
                "entryCount": 1,
                "imagedCount": 1,
                "author": "curated",
                "newFilterLabel": "本次7.15更新",
                "updateFilters": [
                    {"id": "2026.7.15", "label": "7.15更新", "latest": True}
                ],
            },
        ]
        applied = {
            "version": "2026.8.14",
            "entryCount": 2,
            "imagedCount": 1,
            "entries": [
                {
                    "id": "book-0001",
                    "isNew": False,
                    "updateBatches": ["2026.7.15"],
                },
                {
                    "id": "book-0002",
                    "isNew": True,
                    "updateBatches": ["2026.8.14"],
                },
            ],
        }

        updated = build_updated_codex_index(index, applied, "book")

        self.assertEqual(updated[1]["version"], "2026.8.14")
        self.assertEqual(updated[1]["author"], "curated")
        self.assertEqual(updated[1]["newFilterLabel"], "本次8.14更新")
        self.assertEqual(
            updated[1]["updateFilters"],
            [
                {"id": "2026.7.15", "label": "7.15更新"},
                {"id": "2026.8.14", "label": "8.14更新", "latest": True},
            ],
        )

    def test_update_batch_helpers_keep_is_new_as_latest_compatibility_flag(self):
        value = {
            "isNew": False,
            "updateBatches": ["2026.7.15", "2026.7.15"],
        }
        apply_current_update_batch(value, "2026.8.14")
        self.assertFalse(value["isNew"])
        self.assertEqual(normalize_update_batches(value), ["2026.7.15"])

        value["isNew"] = True
        apply_current_update_batch(value, "2026.8.14")
        self.assertEqual(
            value["updateBatches"], ["2026.7.15", "2026.8.14"]
        )
        self.assertEqual(short_update_filter_label("2026.8.14"), "8.14更新")

        filters = update_filter_history(
            [{"id": "2026.7.15", "label": "旧标签", "latest": True}],
            "2026.8.14",
        )
        self.assertEqual(filters[0], {"id": "2026.7.15", "label": "旧标签"})
        self.assertTrue(filters[1]["latest"])

        value = {
            "isNew": False,
            "updateBatches": ["2026.7.15", "2026.8.14"],
        }
        apply_current_update_batch(value, "2026.8.14")
        self.assertEqual(value["updateBatches"], ["2026.7.15"])

    def test_legacy_is_new_seeds_history_before_source_overwrite(self):
        old = [entry("book-0001", "旧批次", ["分类"], "stable,tags,", is_new=True)]
        new = [entry(None, "旧批次", ["分类"], "stable,tags,", is_new=False)]
        result = match_entries(old, new)
        codex = {
            "id": "book",
            "title": "测试",
            "version": "2026.7.15",
            "entryCount": 1,
            "imagedCount": 0,
            "tree": [],
            "entries": old,
        }

        applied, _stats = build_applied_codex(
            codex,
            new,
            result,
            "2026.8.14",
        )
        self.assertFalse(applied["entries"][0]["isNew"])
        self.assertEqual(
            applied["entries"][0]["updateBatches"], ["2026.7.15"]
        )

        index = [{
            "id": "book",
            "version": "2026.7.15",
            "newFilterLabel": "本次7.15更新",
            "entryCount": 1,
            "imagedCount": 0,
        }]
        updated = build_updated_codex_index(index, applied, "book")
        self.assertEqual(
            updated[0]["updateFilters"],
            [
                {"id": "2026.7.15", "label": "7.15更新"},
                {"id": "2026.8.14", "label": "8.14更新", "latest": True},
            ],
        )

    def test_same_version_reapply_rebuilds_latest_batch_from_is_new(self):
        old_entry = entry(
            "book-0001", "纠正标记", ["分类"], "stable,tags,", is_new=True
        )
        old_entry["updateBatches"] = ["2026.7.15", "2026.8.14"]
        new = [
            entry(None, "纠正标记", ["分类"], "stable,tags,", is_new=False)
        ]
        result = match_entries([old_entry], new)
        codex = {
            "id": "book",
            "title": "测试",
            "version": "2026.8.14",
            "entryCount": 1,
            "imagedCount": 0,
            "tree": [],
            "entries": [old_entry],
        }

        applied, _stats = build_applied_codex(
            codex,
            new,
            result,
            "2026.8.14",
            previous_update_filters=[
                {"id": "2026.7.15", "label": "7.15更新"},
                {"id": "2026.8.14", "label": "8.14更新", "latest": True},
            ],
        )
        self.assertFalse(applied["entries"][0]["isNew"])
        self.assertEqual(
            applied["entries"][0]["updateBatches"], ["2026.7.15"]
        )

    def test_audited_unhighlighted_new_override_applies_on_first_update(self):
        old = [entry("suozhang-5703", "旧词条", ["各种风格"], "old,")]
        new = [
            entry(None, "旧词条", ["各种风格"], "old,"),
            entry(
                None,
                "动画画风",
                ["各种风格"],
                "7::anime,anime screencap,anime coloring,official style,dense linework::,",
                is_new=False,
            ),
        ]
        codex = {
            "id": "suozhang",
            "title": "测试",
            "version": "2026.7.15",
            "entryCount": 1,
            "imagedCount": 0,
            "tree": [],
            "entries": old,
        }

        applied, stats = build_applied_codex(
            codex, new, match_entries(old, new), "2026.8.14"
        )

        override = applied["entries"][1]
        self.assertEqual(override["id"], "suozhang-5704")
        self.assertTrue(override["isNew"])
        self.assertEqual(override["updateBatches"], ["2026.8.14"])
        self.assertEqual(stats["auditedNewOverrideIds"], ["suozhang-5704"])

    def test_audited_source_new_override_repairs_replay_input(self):
        source_entry = entry(
            None,
            "动画画风",
            ["各种风格"],
            "7::anime,anime screencap,anime coloring,official style,dense linework::,",
            is_new=False,
        )

        applied = apply_audited_source_new_overrides(
            [source_entry], "suozhang", "2026.8.14"
        )

        self.assertTrue(source_entry["isNew"])
        self.assertEqual(applied, ["suozhang-5704"])

    def test_audited_unhighlighted_new_override_survives_same_version_reapply(self):
        old_entry = entry(
            "suozhang-5704",
            "动画画风",
            ["各种风格"],
            "7::anime,anime screencap,anime coloring,official style,dense linework::,",
            is_new=True,
        )
        old_entry["updateBatches"] = ["2026.8.14"]
        source_entry = entry(
            None,
            "动画画风",
            ["各种风格"],
            old_entry["tags"],
            is_new=False,
        )
        codex = {
            "id": "suozhang",
            "title": "测试",
            "version": "2026.8.14",
            "entryCount": 1,
            "imagedCount": 0,
            "tree": [],
            "entries": [old_entry],
        }

        applied, stats = build_applied_codex(
            codex,
            [source_entry],
            match_entries([old_entry], [source_entry]),
            "2026.8.14",
            previous_update_filters=[
                {"id": "2026.8.14", "label": "8.14更新", "latest": True}
            ],
        )

        self.assertTrue(applied["entries"][0]["isNew"])
        self.assertEqual(applied["entries"][0]["updateBatches"], ["2026.8.14"])
        self.assertEqual(stats["auditedNewOverrideIds"], ["suozhang-5704"])

    def test_audited_new_override_is_version_scoped(self):
        old_entry = entry(
            "suozhang-5704",
            "动画画风",
            ["各种风格"],
            "7::anime,anime screencap,anime coloring,official style,dense linework::,",
            is_new=True,
        )
        old_entry["updateBatches"] = ["2026.8.14"]
        source_entry = {**old_entry, "id": None, "isNew": False}
        codex = {
            "id": "suozhang",
            "title": "测试",
            "version": "2026.8.14",
            "entryCount": 1,
            "imagedCount": 0,
            "tree": [],
            "entries": [old_entry],
        }

        applied, stats = build_applied_codex(
            codex,
            [source_entry],
            match_entries([old_entry], [source_entry]),
            "2026.8.15",
        )

        self.assertFalse(applied["entries"][0]["isNew"])
        self.assertEqual(applied["entries"][0]["updateBatches"], ["2026.8.14"])
        self.assertEqual(stats["auditedNewOverrideIds"], [])

    def test_audited_new_override_blocks_signature_drift(self):
        old_entry = entry(
            "suozhang-5704",
            "动画画风",
            ["各种风格"],
            "7::anime,anime screencap,anime coloring,official style,dense linework::,",
            is_new=True,
        )
        source_entry = entry(
            None,
            "动画画风",
            ["各种风格"],
            "changed tags,",
            is_new=False,
        )
        codex = {
            "id": "suozhang",
            "title": "测试",
            "version": "2026.7.15",
            "entryCount": 1,
            "imagedCount": 0,
            "tree": [],
            "entries": [old_entry],
        }

        with self.assertRaisesRegex(ValueError, "audited NEW override target drifted"):
            build_applied_codex(
                codex,
                [source_entry],
                match_entries([old_entry], [source_entry]),
                "2026.8.14",
            )

    def test_application_gate_requires_safe_word_and_strict_baseline(self):
        old = [entry("book-0001", "甲", ["分类"], "alpha,")]
        new_result = match_entries(old, [entry(None, "甲", ["分类"], "alpha,")])
        baseline_result = match_entries(
            old, [entry(None, "甲", ["分类"], "alpha,")]
        )
        normalization = {"blockers": []}
        structure = {
            "tables": 0,
            "drawings": 7,
            "textBoxes": 0,
            "trackedInsertions": 0,
            "trackedDeletions": 0,
            "commentsPart": False,
            "trackRevisionsEnabled": False,
        }

        gate = build_application_gate(
            new_result,
            normalization,
            structure,
            baseline_result=baseline_result,
            baseline_normalization=normalization,
        )
        self.assertTrue(gate["pass"])

        unsafe = dict(structure, tables=1)
        gate = build_application_gate(
            new_result,
            normalization,
            unsafe,
            baseline_result=baseline_result,
            baseline_normalization=normalization,
        )
        self.assertFalse(gate["pass"])


if __name__ == "__main__":
    unittest.main()
