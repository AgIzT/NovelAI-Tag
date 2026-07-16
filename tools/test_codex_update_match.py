# -*- coding: utf-8 -*-

import json
import os
import tempfile
import unittest
from unittest.mock import patch

from codex_update_match import match_entries, norm_tags_value
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
    return result


class CodexUpdateMatchTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
