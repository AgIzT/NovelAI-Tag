from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from import_nai5_community_pack import (  # noqa: E402
    CODEX_ID,
    DREAM_MANUAL_TAKEDOWN_HASHES,
    DREAM_NSFW_PATH,
    DREAM_RESERVED_TAKEDOWN_IDS,
    DREAM_SAFE_PATH,
    SUOZHANG_PATH,
    SUOZHANG_MANUAL_TAKEDOWN_HASHES,
    codex_payload,
    batch_number_from_name,
    dream_entry_title,
    dream_takedown_state,
    finalize_groups,
    mark_batch_duplicates,
    mark_suozhang_manual_takedowns,
    model_family,
    suspicious_prompt_reason,
    suozhang_batch_path,
    suozhang_entry_title,
)


def row(entry_id: str, index: int, *, accepted: bool, reason: str, prompt: str) -> dict:
    return {
        "groupKey": entry_id,
        "entryId": entry_id,
        "imageIndex": index,
        "accepted": accepted,
        "reason": reason,
        "prompt": prompt,
        "negative": "negative",
        "characterPrompts": [],
    }


def group(entry_id: str, *, entry_order: int, path: tuple[str, ...], kind: str, input_count: int) -> dict:
    return {
        "groupKey": entry_id,
        "entryId": entry_id,
        "entryOrder": entry_order,
        "title": entry_id,
        "author": path[0],
        "kind": kind,
        "path": list(path),
        "rating": "safe" if path == DREAM_SAFE_PATH else "r18",
        "sourceFolder": "source",
        "inputImageCount": input_count,
    }


def asset(entry_id: str, prompts: list[str]) -> dict:
    images = []
    for index, prompt in enumerate(prompts, 1):
        base = entry_id if index == 1 else f"{entry_id}-{index:02d}"
        item = {"path": f"{base}.jpg", "original": f"{base}.png"}
        if len(prompts) > 1:
            item["rawTag"] = prompt
        images.append(item)
    return {
        "entryId": entry_id,
        "image": images[0]["path"],
        "imageWidth": 512,
        "imageHeight": 768,
        "original": images[0]["original"],
        "images": images,
        "assetRev": "0123456789abcdef",
    }


class Nai5CommunityPackTests(unittest.TestCase):
    def test_dream_takedown_guard_survives_without_ignored_report(self) -> None:
        expected_ids = {
            f"{CODEX_ID}_mengshen_0323",
            f"{CODEX_ID}_mengshen_0334",
        }
        expected_hashes = {
            "51ac7d83442f4e6becfc23d738a8b6a06e7db09b681a4d84f407548e4c83e2eb",
            "8aa33515da4814fc9ddc90e21586da1f6c38147deacade86e9cf2a891f6b0ede",
        }

        self.assertLessEqual(expected_ids, DREAM_RESERVED_TAKEDOWN_IDS)
        self.assertLessEqual(expected_hashes, DREAM_MANUAL_TAKEDOWN_HASHES)
        active_ids, active_hashes = dream_takedown_state()
        self.assertLessEqual(expected_ids, active_ids)
        self.assertLessEqual(expected_hashes, active_hashes)

    def test_dream_branch_uses_community_entry_titles(self) -> None:
        self.assertEqual(dream_entry_title(1), "社区精选 001")
        self.assertEqual(dream_entry_title(76), "社区精选 076")

    def test_current_first_level_directory_names(self) -> None:
        self.assertEqual(DREAM_SAFE_PATH, ("梦神 · N5社区图包", "社区整理", "常规"))
        self.assertEqual(DREAM_NSFW_PATH, ("梦神 · N5社区图包", "社区整理", "NSFW"))
        self.assertEqual(SUOZHANG_PATH, ("所长·N5韩网图包", "NSFW"))

    def test_numbered_batch_paths_use_the_requested_directory_names(self) -> None:
        self.assertEqual(suozhang_batch_path(1), ("所长·N5韩网图包", "筛选整理1"))
        self.assertEqual(suozhang_batch_path(4), ("所长·N5韩网图包", "筛选整理4"))
        self.assertEqual(batch_number_from_name("（1984）韩网N5作品筛选整理"), 1)
        self.assertEqual(batch_number_from_name("（1984）韩网N5作品筛选整理4"), 4)
        self.assertIsNone(batch_number_from_name("unrelated"))

    def test_suozhang_titles_share_one_display_sequence(self) -> None:
        self.assertEqual(suozhang_entry_title("single", 1), "韩网整理 001")
        self.assertEqual(suozhang_entry_title("set", 2), "整理套图 002")

    def test_same_batch_duplicate_prefers_the_set_folder_copy(self) -> None:
        loose = {
            "accepted": True,
            "sha256": "same",
            "batch": 1,
            "kind": "single",
            "sourceIndex": 1,
            "relativePath": "筛选整理1/loose.png",
        }
        set_member = {
            "accepted": True,
            "sha256": "same",
            "batch": 1,
            "kind": "set",
            "sourceIndex": 2,
            "relativePath": "筛选整理1/set/001.png",
        }
        mark_batch_duplicates([loose, set_member])
        self.assertFalse(loose["accepted"])
        self.assertEqual(loose["reason"], "exact_duplicate")
        self.assertTrue(set_member["accepted"])

    def test_earlier_batch_wins_before_folder_preference(self) -> None:
        first = {
            "accepted": True,
            "sha256": "same",
            "batch": 1,
            "kind": "single",
            "sourceIndex": 1,
            "relativePath": "筛选整理1/loose.png",
        }
        later_set = {
            "accepted": True,
            "sha256": "same",
            "batch": 2,
            "kind": "set",
            "sourceIndex": 2,
            "relativePath": "筛选整理2/set/001.png",
        }
        mark_batch_duplicates([first, later_set])
        self.assertTrue(first["accepted"])
        self.assertFalse(later_set["accepted"])

    def test_manual_suozhang_r18g_takedown_is_hash_stable(self) -> None:
        removed_hash = next(iter(SUOZHANG_MANUAL_TAKEDOWN_HASHES))
        removed = {
            "accepted": True,
            "reason": "accepted",
            "sha256": removed_hash,
            "duplicateOf": "source",
        }
        kept = {
            "accepted": True,
            "reason": "accepted",
            "sha256": "not-moderated",
            "duplicateOf": "",
        }
        result = mark_suozhang_manual_takedowns([removed, kept])
        self.assertEqual(result, [removed])
        self.assertFalse(removed["accepted"])
        self.assertEqual(removed["reason"], "manual_takedown:r18g")
        self.assertEqual(removed["duplicateOf"], "")
        self.assertTrue(kept["accepted"])

    def test_model_gate_recognizes_nai5_and_rejects_nai45(self) -> None:
        self.assertEqual(model_family("NovelAI Diffusion V5 0ADF9AB7"), "nai5")
        self.assertEqual(model_family("NovelAI Diffusion V4.5 4BDE2A90"), "nai45")

    def test_dream_increment_rejects_unmistakably_scrubbed_prompt_values(self) -> None:
        self.assertEqual(suspicious_prompt_reason("1"), "suspicious_prompt:pure_numeric")
        self.assertEqual(
            suspicious_prompt_reason("https://www.pixiv.net/users/23611513"),
            "suspicious_prompt:url",
        )
        self.assertEqual(suspicious_prompt_reason("unknown"), "suspicious_prompt:placeholder")
        self.assertIsNone(suspicious_prompt_reason("artist:kz oji"))
        self.assertIsNone(suspicious_prompt_reason("1girl, solo, outdoors"))

    def test_partial_source_set_keeps_valid_members_together(self) -> None:
        entry_id = f"{CODEX_ID}_suozhang_set_0001"
        rows = [
            row(entry_id, 1, accepted=True, reason="accepted", prompt="first"),
            row(entry_id, 2, accepted=False, reason="no_prompt", prompt=""),
            row(entry_id, 3, accepted=True, reason="accepted", prompt="third"),
        ]
        groups = [group(entry_id, entry_order=1, path=SUOZHANG_PATH, kind="set", input_count=3)]
        accepted = finalize_groups(rows, groups)
        self.assertEqual(len(accepted), 1)
        self.assertEqual(groups[0]["reason"], "accepted_with_exclusions")
        self.assertEqual([item["imageIndex"] for item in groups[0]["acceptedMembers"]], [1, 3])
        payload = codex_payload(groups, {entry_id: asset(entry_id, ["first", "third"])})
        self.assertEqual(len(payload["entries"][0]["images"]), 2)
        self.assertIn("源文件夹共 3 张", payload["entries"][0]["note"])

    def test_safe_directory_is_first_and_supplies_cover(self) -> None:
        nsfw_id = f"{CODEX_ID}_suozhang_0001"
        safe_id = f"{CODEX_ID}_mengshen_0001"
        rows = [
            row(nsfw_id, 1, accepted=True, reason="accepted", prompt="nsfw"),
            row(safe_id, 1, accepted=True, reason="accepted", prompt="safe"),
        ]
        groups = [
            group(nsfw_id, entry_order=1, path=SUOZHANG_PATH, kind="single", input_count=1),
            group(safe_id, entry_order=2, path=DREAM_SAFE_PATH, kind="single", input_count=1),
        ]
        finalize_groups(rows, groups)
        payload = codex_payload(groups, {
            nsfw_id: asset(nsfw_id, ["nsfw"]),
            safe_id: asset(safe_id, ["safe"]),
        })
        self.assertEqual(payload["entries"][0]["id"], safe_id)
        self.assertEqual(payload["cover"], payload["entries"][0]["image"])
        self.assertNotIn("nsfw", payload)


if __name__ == "__main__":
    unittest.main()
