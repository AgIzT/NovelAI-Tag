# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from backfill_pack_character_prompts import reconcile_prompt_field
from sd_metadata_inspector import (
    metadata_from_png_chunks,
    nai_v4_character_prompts,
)


class CharacterPromptMetadataTests(unittest.TestCase):
    def setUp(self) -> None:
        self.payload = {
            "prompt": "legacy base",
            "uc": "legacy negative",
            "v4_prompt": {
                "caption": {
                    "base_caption": "base prompt",
                    "char_captions": [
                        {"char_caption": "first character"},
                        {"char_caption": ""},
                        {"char_caption": "third character"},
                    ],
                },
            },
            "v4_negative_prompt": {
                "caption": {
                    "base_caption": "base negative",
                    "char_captions": [
                        {"char_caption": "first negative"},
                        {"char_caption": ""},
                        {"char_caption": "third negative"},
                    ],
                },
            },
        }

    def test_character_labels_keep_original_indexes(self) -> None:
        self.assertEqual(
            nai_v4_character_prompts(self.payload),
            [
                {"label": "char1", "prompt": "first character", "negative": "first negative"},
                {"label": "char3", "prompt": "third character", "negative": "third negative"},
            ],
        )

    def test_metadata_keeps_base_and_character_prompts_separate(self) -> None:
        meta = metadata_from_png_chunks(
            Path("sample.png"),
            [
                {"type": "tEXt", "keyword": "Software", "text": "NovelAI"},
                {"type": "tEXt", "keyword": "Comment", "text": json.dumps(self.payload)},
            ],
        )
        self.assertEqual(meta.prompt, "base prompt")
        self.assertEqual(meta.negative, "base negative")
        self.assertEqual(len(meta.character_prompts), 2)

    def test_backfill_separates_old_flattened_text_with_blank_lines(self) -> None:
        entry = {"tags": "base prompt\n\nfirst character"}
        status = reconcile_prompt_field(
            entry,
            "tags",
            "base prompt",
            [{"label": "char1", "prompt": "first character"}],
            "prompt",
        )
        self.assertEqual(status, "separated_flattened")
        self.assertEqual(entry["tags"], "base prompt")

    def test_backfill_preserves_unrelated_existing_prompt(self) -> None:
        entry = {"tags": "manually curated prompt"}
        status = reconcile_prompt_field(
            entry,
            "tags",
            "base prompt",
            [{"label": "char1", "prompt": "first character"}],
            "prompt",
        )
        self.assertEqual(status, "preserved_mismatch")
        self.assertEqual(entry["tags"], "manually curated prompt")


if __name__ == "__main__":
    unittest.main()
