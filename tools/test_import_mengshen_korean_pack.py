from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from import_mengshen_korean_pack import (  # noqa: E402
    CONFIRMED_VISUAL_DUPLICATES,
    N5_COMMUNITY_NSFW_PATH,
    N5_COMMUNITY_SAFE_PATH,
    _legacy_community_path,
    index_cover_issue,
    index_meta,
    mark_source_duplicates,
    model_family,
    suspicious_prompt_reason,
)


class MengshenKoreanPackTests(unittest.TestCase):
    def test_model_split_accepts_nai5_and_nai45(self) -> None:
        self.assertEqual(model_family("NovelAI Diffusion V5 0ADF9AB7"), "nai5")
        self.assertEqual(model_family("NovelAI Diffusion V4.5 4BDE2A90"), "nai45")
        self.assertEqual(model_family("unknown"), "unknown")

    def test_legacy_n5_paths_gain_the_community_level(self) -> None:
        self.assertEqual(
            _legacy_community_path(["梦神 · N5社区图包", "常规"]),
            list(N5_COMMUNITY_SAFE_PATH),
        )
        self.assertEqual(
            _legacy_community_path(["梦神 · N5社区图包", "NSFW"]),
            list(N5_COMMUNITY_NSFW_PATH),
        )
        self.assertIsNone(_legacy_community_path(["梦神 · N5社区图包", "韩网整理", "常规"]))

    def test_exact_duplicate_prefers_suite_then_stricter_rating(self) -> None:
        loose = {
            "accepted": True, "sha256": "same", "rating": "r18", "kind": "single",
            "sourceIndex": 1, "relativePath": "N5/nsfw/loose.png",
        }
        suite = {
            "accepted": True, "sha256": "same", "rating": "r18", "kind": "set",
            "sourceIndex": 2, "relativePath": "N5/nsfw/套图/a.png",
        }
        safe = {
            "accepted": True, "sha256": "same", "rating": "safe", "kind": "set",
            "sourceIndex": 3, "relativePath": "N5/常规/a.png",
        }
        mark_source_duplicates([loose, suite, safe])
        self.assertTrue(suite["accepted"])
        self.assertFalse(loose["accepted"])
        self.assertFalse(safe["accepted"])
        self.assertEqual(loose["duplicateOf"], suite["relativePath"])

    def test_confirmed_reencoded_duplicate_keeps_reviewed_suite_copy(self) -> None:
        rejected_hash, keeper_hash = next(iter(CONFIRMED_VISUAL_DUPLICATES.items()))
        loose = {
            "accepted": True, "sha256": rejected_hash, "rating": "r18", "kind": "single",
            "sourceIndex": 1, "relativePath": "loose.webp",
        }
        suite = {
            "accepted": True, "sha256": keeper_hash, "rating": "r18", "kind": "set",
            "sourceIndex": 2, "relativePath": "set.png",
        }
        mark_source_duplicates([loose, suite])
        self.assertFalse(loose["accepted"])
        self.assertEqual(loose["reason"], "confirmed_visual_duplicate")
        self.assertEqual(loose["duplicateOf"], "set.png")
        self.assertTrue(suite["accepted"])

    def test_scrubbed_prompt_gate_is_conservative(self) -> None:
        self.assertEqual(suspicious_prompt_reason("123"), "suspicious_prompt:pure_numeric")
        self.assertEqual(suspicious_prompt_reason("https://example.com/a"), "suspicious_prompt:url")
        self.assertEqual(suspicious_prompt_reason("unknown"), "suspicious_prompt:placeholder")
        self.assertIsNone(suspicious_prompt_reason("artist:wanke"))

    def test_index_update_preserves_picker_only_cover_fields(self) -> None:
        existing = {
            "id": "nai45_community_pack",
            "entryCount": 6842,
            "links": [],
            "cover": "mengshen_pack-0259.jpg",
            "coverRev": "a4fbaa67f4bb359c",
            "coverCodexId": "mengshen_pack",
        }
        codex = {
            "id": "nai45_community_pack",
            "entryCount": 6855,
            "tree": [],
            "entries": [],
        }
        merged = index_meta(codex, existing)
        self.assertEqual(merged["entryCount"], 6855)
        self.assertEqual(merged["cover"], "mengshen_pack-0259.jpg")
        self.assertEqual(merged["coverRev"], "a4fbaa67f4bb359c")
        self.assertEqual(merged["coverCodexId"], "mengshen_pack")
        self.assertEqual(merged["links"], [])
        self.assertNotIn("tree", merged)
        self.assertNotIn("entries", merged)
        self.assertEqual(existing["entryCount"], 6842, "must not mutate the existing index row")

    def test_index_cover_resolves_through_cover_codex_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            owner = root / "mengshen_pack"
            owner.mkdir()
            (owner / "mengshen_pack-0259.jpg").write_bytes(b"cover")
            row = {
                "id": "nai45_community_pack",
                "cover": "mengshen_pack-0259.jpg",
                "coverCodexId": "mengshen_pack",
            }
            self.assertIsNone(index_cover_issue(row, root))
            row.pop("coverCodexId")
            self.assertIn("index_cover_asset_missing", index_cover_issue(row, root) or "")


if __name__ == "__main__":
    unittest.main()
