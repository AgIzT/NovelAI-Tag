from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from import_nai5_artist_dictionary import (
    CHENGCHUANJI,
    SECTION_CONFIG,
    TITLE,
    artist_title,
    codex_payload,
    first_style_tag,
    model_family,
    normalize_pdf_artist_label,
    normalized_artist_key,
    resolve_wumian_source_tag,
)


class Nai5ArtistDictionaryTests(unittest.TestCase):
    def test_current_book_and_jiuqi_directory_names(self) -> None:
        self.assertEqual(TITLE, "NovelAI5画师词典")
        self.assertEqual(SECTION_CONFIG["九七"]["path"][1], "九七(无原图)")

    def test_partial_nsfw_uses_entry_ratings_without_root_lock(self) -> None:
        self.assertEqual(
            {name: config["rating"] for name, config in SECTION_CONFIG.items()},
            {"九七": "safe", "无冕": "r18", CHENGCHUANJI: "r18", "梦神": "safe"},
        )
        self.assertEqual(
            SECTION_CONFIG[CHENGCHUANJI]["path"],
            ["单画师词典", "成川姬", "N5F单画师测试（2025–2026）"],
        )
        entry_id = "artist_nai5_personal_test_0001"
        payload = codex_payload(
            [{
                "title": "test",
                "path": SECTION_CONFIG["九七"]["path"],
                "tags": "artist:test",
                "rating": "safe",
                "entryId": entry_id,
            }],
            {entry_id: {
                "entryId": entry_id,
                "image": "test.jpg",
                "original": "test.png",
                "assetRev": "test",
            }},
        )
        self.assertNotIn("nsfw", payload)

    def test_filename_attribution_model_gate(self) -> None:
        self.assertEqual(model_family("NovelAI Diffusion V5 0ADF9AB7"), "nai5")
        self.assertEqual(model_family("DiffusionModelMetaName.NAIv5 9B720222"), "nai5")
        self.assertEqual(model_family("NovelAI Diffusion V4.5 4BDE2A90"), "nai45")

    def test_pdf_artist_label_repairs_font_spacing(self) -> None:
        self.assertEqual(normalize_pdf_artist_label("artist:cle_m asahiro,\x01"), "artist:cle_masahiro")
        self.assertEqual(normalize_pdf_artist_label("artist:ask\x01(askzy),"), "artist:ask_(askzy)")

    def test_artist_title_strips_prompt_prefix(self) -> None:
        self.assertEqual(artist_title("artist:ciloranko"), "ciloranko")
        self.assertEqual(artist_title("1.2::artist:anmi::"), "anmi")

    def test_first_style_tag_preserves_artist_parentheses(self) -> None:
        self.assertEqual(
            first_style_tag("chelizi (weibo 5986313927), year2025", "fallback"),
            "chelizi (weibo 5986313927)",
        )

    def test_first_style_tag_stops_at_newline_without_comma(self) -> None:
        self.assertEqual(
            first_style_tag("artist:xiumu bianzhou\nyear 2025, nsfw", "fallback"),
            "artist:xiumu bianzhou",
        )

    def test_first_style_tag_stops_at_fullwidth_comma(self) -> None:
        self.assertEqual(
            first_style_tag("artist:shikisokuzeku76，year 2025", "fallback"),
            "artist:shikisokuzeku76",
        )

    def test_artist_key_treats_spaces_and_underscores_as_equivalent(self) -> None:
        self.assertEqual(
            normalized_artist_key("artist:yuming_li"),
            normalized_artist_key("artist:yuming li"),
        )

    def test_registered_pdf_label_conflict_uses_embedded_prompt(self) -> None:
        self.assertEqual(
            resolve_wumian_source_tag(
                "/P91",
                "artist:chyoel",
                "artist:channel (caststation)",
            ),
            ("artist:channel (caststation)", "embedded_prompt_correction"),
        )

    def test_unknown_pdf_label_conflict_is_blocked(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "未登记"):
            resolve_wumian_source_tag("/P999", "artist:first", "artist:second")

    def test_malformed_embedded_prefix_keeps_complete_source_label(self) -> None:
        self.assertEqual(
            resolve_wumian_source_tag(
                "/P487",
                "artist:seito_edaha",
                "artist:sartist:seito_edaha",
            ),
            ("artist:seito_edaha", "embedded_prompt_suffix_equivalent"),
        )


if __name__ == "__main__":
    unittest.main()
