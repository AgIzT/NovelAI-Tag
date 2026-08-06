# -*- coding: utf-8 -*-
"""migrate_suozhang_char_prompts 的拆分规则测试。"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from migrate_suozhang_char_prompts import (  # noqa: E402
    put_character_prompts,
    split_inline_char_prompts,
)


class SplitInlineCharPrompts(unittest.TestCase):
    def test_splits_fullwidth_colon_and_keeps_author_trailing_comma(self):
        out = split_inline_char_prompts("1girl,indoor,\nchar1：girl,blush,\nchar2：boy,nude,")
        self.assertEqual(out["positive"], "1girl,indoor,")
        self.assertEqual(out["prompts"], [
            {"label": "char1", "prompt": "girl,blush,"},
            {"label": "char2", "prompt": "boy,nude,"},
        ])
        self.assertTrue(out["lossless"])
        self.assertEqual(out["midlineMarkers"], [])

    def test_splits_halfwidth_colon_and_keeps_emoticon_tags(self):
        out = split_inline_char_prompts("solo,\nchar1:girl,:3,>_<,\nchar2:1other,")
        self.assertEqual([item["label"] for item in out["prompts"]], ["char1", "char2"])
        self.assertEqual(out["prompts"][0]["prompt"], "girl,:3,>_<,")

    def test_entry_without_positive_section(self):
        out = split_inline_char_prompts("char1：school uniform,white shirt,")
        self.assertEqual(out["positive"], "")
        self.assertEqual(out["prompts"], [{"label": "char1", "prompt": "school uniform,white shirt,"}])
        self.assertTrue(out["lossless"])

    def test_midline_marker_is_left_in_place_and_reported(self):
        out = split_inline_char_prompts("open door,in char3：front of image,clothed,")
        self.assertEqual(out["prompts"], [])
        self.assertEqual(out["positive"], "open door,in char3：front of image,clothed,")
        self.assertEqual(out["midlineMarkers"], ["char3："])

    def test_midline_marker_inside_a_char_block_is_reported_not_split(self):
        out = split_inline_char_prompts("cowboy shot,\nchar2：boy,short char2：boy,back view,")
        self.assertEqual(len(out["prompts"]), 1)
        self.assertEqual(out["prompts"][0]["prompt"], "boy,short char2：boy,back view,")
        self.assertEqual(out["midlineMarkers"], ["char2："])

    def test_bare_char_label_and_spacing(self):
        out = split_inline_char_prompts("solo,\n char 1 ： girl,smile,")
        self.assertEqual(out["prompts"], [{"label": "char1", "prompt": "girl,smile,"}])

    def test_empty_char_segment_is_reported(self):
        out = split_inline_char_prompts("solo,\nchar1：\nchar2：boy,")
        self.assertEqual(out["emptySegments"], ["char1"])
        self.assertEqual([item["label"] for item in out["prompts"]], ["char2"])

    def test_plain_entry_is_untouched(self):
        text = "1girl,{{smile}},2::detailed background::,"
        out = split_inline_char_prompts(text)
        self.assertEqual(out["positive"], text)
        self.assertEqual(out["prompts"], [])

    def test_idempotent(self):
        first = split_inline_char_prompts("1girl,\nchar1：girl,blush,")
        second = split_inline_char_prompts(first["positive"])
        self.assertEqual(second["positive"], first["positive"])
        self.assertEqual(second["prompts"], [])

    def test_crlf_normalized(self):
        out = split_inline_char_prompts("1girl,\r\nchar1：girl,")
        self.assertEqual(out["positive"], "1girl,")
        self.assertEqual(out["prompts"], [{"label": "char1", "prompt": "girl,"}])


class PutCharacterPrompts(unittest.TestCase):
    def test_character_prompts_sits_right_after_tags(self):
        entry = {"title": "t", "path": ["a"], "tags": "old", "isNew": False, "id": "x", "image": "x.jpg"}
        prompts = [{"label": "char1", "prompt": "girl,"}]
        out = put_character_prompts(entry, "new", prompts)
        self.assertEqual(list(out), ["title", "path", "tags", "characterPrompts", "isNew", "id", "image"])
        self.assertEqual(out["tags"], "new")
        self.assertEqual(out["characterPrompts"], prompts)

    def test_existing_field_is_replaced_not_duplicated(self):
        entry = {"tags": "old", "characterPrompts": [{"label": "char1", "prompt": "stale"}], "id": "x"}
        out = put_character_prompts(entry, "new", [{"label": "char1", "prompt": "fresh"}])
        self.assertEqual(list(out), ["tags", "characterPrompts", "id"])
        self.assertEqual(out["characterPrompts"], [{"label": "char1", "prompt": "fresh"}])


if __name__ == "__main__":
    unittest.main()
