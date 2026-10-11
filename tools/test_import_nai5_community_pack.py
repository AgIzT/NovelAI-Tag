from __future__ import annotations

import sys
import unittest
import copy
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from PIL import Image

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
import import_nai5_community_pack as importer  # noqa: E402


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

    def test_set_entries_carry_per_image_negative_and_character_prompts(self) -> None:
        entry_id = f"{CODEX_ID}_suozhang_set_0002"
        chars = [{"label": "char1", "prompt": "girl, standing"}]
        rows = [
            row(entry_id, 1, accepted=True, reason="accepted", prompt="first"),
            {**row(entry_id, 2, accepted=True, reason="accepted", prompt="second"), "characterPrompts": chars},
            {**row(entry_id, 3, accepted=True, reason="accepted", prompt="third"), "negative": ""},
        ]
        groups = [group(entry_id, entry_order=1, path=SUOZHANG_PATH, kind="set", input_count=3)]
        finalize_groups(rows, groups)
        payload = codex_payload(groups, {entry_id: asset(entry_id, ["first", "second", "third"])})
        entry = payload["entries"][0]
        self.assertIs(entry["perImagePrompts"], True)
        self.assertEqual(entry["note"].split("\n")[0], "套图：3 张；提示词随当前图切换。")
        self.assertNotIn("characterPrompts", entry["images"][0])
        self.assertEqual(entry["images"][1]["characterPrompts"], chars)
        self.assertNotIn("negative", entry["images"][1])
        self.assertEqual(entry["images"][2]["negative"], "")
        self.assertNotIn("characterPrompts", entry["images"][2])

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


class SuozhangSerialNumberTests(unittest.TestCase):
    def test_named_entries_still_count_toward_next_display_number(self) -> None:
        from import_nai5_community_pack import _maximum_suozhang_title

        entries = [
            {"title": "银发御姐·男女后入", "serialTitle": "韩网整理 040"},
            {"title": "整理套图 012"},
            {"title": "未编号的名字·无编号"},
        ]
        self.assertEqual(_maximum_suozhang_title(entries), 40)


class CurrentDreamValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        evidence = Path(__file__).resolve().parents[1] / "output" / "codex-review-20261011" / "05-导入器校验与真机走查"
        evidence.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="B-test-", dir=evidence)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.thumbs = self.root / "site" / "images" / CODEX_ID
        self.originals = self.root / "originals" / CODEX_ID
        self.thumbs.mkdir(parents=True)
        self.originals.mkdir(parents=True)
        self.addCleanup(mock.patch.stopall)
        mock.patch.multiple(importer, ROOT=self.root, IMAGE_ROOT=self.thumbs.parent, ORIGINAL_ROOT=self.originals.parent).start()
        mock.patch.object(importer, "dream_takedown_state", return_value=(set(), set())).start()
        mock.patch.object(importer, "extract_image_metadata", return_value=SimpleNamespace(
            prompt="1girl, outdoors", negative="bad quality", character_prompts=[],
        )).start()
        self.entry = self.make_entry(f"{CODEX_ID}_mengshen_0006", DREAM_SAFE_PATH, "red")
        self.rows = [self.source_row(self.entry)]
        self.book = {
            "id": CODEX_ID, "type": "pack", "title": "Book", "version": "2026.10.8",
            "entryCount": 1, "imagedCount": 1, "cover": self.entry["image"], "coverRev": "cover-rev",
            "tree": importer.build_tree([self.entry]), "entries": [self.entry],
        }
        self.index = [{**importer.index_meta(self.book), "selectorTitle": "人工选择器标题"}]
        self.suspension = {"entries": [], "assets": []}

    def make_entry(self, entry_id: str, path: tuple[str, ...], color: str) -> dict:
        Image.new("RGB", (64, 64), color).save(self.thumbs / f"{entry_id}.jpg")
        Image.new("RGB", (64, 64), color).save(self.originals / f"{entry_id}.png")
        return {
            "id": entry_id, "title": "人工译名", "serialTitle": "社区精选 006",
            "path": list(path), "rating": "safe", "tags": "1girl, outdoors", "negative": "bad quality",
            "image": f"{entry_id}.jpg", "original": f"{entry_id}.png", "imageWidth": 64, "imageHeight": 64,
            "images": [{"path": f"{entry_id}.jpg", "original": f"{entry_id}.png"}], "assetRev": "rev",
        }

    def source_row(self, entry: dict) -> dict:
        return {"accepted": True, "sha256": importer.sha256_file(self.originals / entry["original"]), "relativePath": "6.png", "sourceNumber": 6}

    def validate(self) -> dict:
        return importer.validate_current_dream_payload(self.book, self.rows, {"blockers": []}, self.index, self.suspension)

    def test_current_version_manual_title_and_index_only_fields_are_valid(self) -> None:
        result = self.validate()
        self.assertEqual(result["issues"], [])
        self.assertTrue(result["ok"])

    def test_whole_book_nsfw_is_rejected_even_when_index_matches(self) -> None:
        self.book["nsfw"] = True
        self.index[0]["nsfw"] = True
        result = self.validate()
        self.assertIn("unexpected_codex_nsfw", result["issues"])
        self.assertFalse(result["ok"])

    def test_missing_or_blank_version_is_rejected_even_when_index_matches(self) -> None:
        for value in (None, "", "   "):
            with self.subTest(value=value):
                if value is None:
                    self.book.pop("version", None)
                    self.index[0].pop("version", None)
                else:
                    self.book["version"] = self.index[0]["version"] = value
                result = self.validate()
                self.assertIn("version_missing", result["issues"])
                self.assertFalse(result["ok"])

    def test_prompt_negative_and_character_tampering_is_reported(self) -> None:
        for field, value, issue in (
            ("tags", "tampered", "original_prompt"),
            ("negative", "tampered", "original_negative"),
            ("characterPrompts", [{"label": "char1", "prompt": "tampered"}], "original_character_prompts"),
        ):
            with self.subTest(field=field):
                changed = copy.deepcopy(self.book)
                changed["entries"][0][field] = value
                result = importer.validate_current_dream_payload(changed, self.rows, {"blockers": []}, self.index, self.suspension)
                self.assertIn(f"{self.entry['id']}:{issue}", result["issues"])

    def test_missing_media_and_index_count_fail(self) -> None:
        (self.thumbs / self.entry["image"]).unlink()
        self.index[0]["entryCount"] = 2
        result = self.validate()
        self.assertIn(f"{self.entry['id']}:missing_thumb", result["issues"])
        self.assertIn("index_metadata:entryCount", result["issues"])
        self.assertIn("index_cover_asset_missing", result["issues"])

    def test_asset_names_are_unique_per_owner_across_entries(self) -> None:
        other = self.make_entry(f"{CODEX_ID}_mengshen_korean_0001", (importer.DREAM_ROOT_LABEL, "韩网整理", "常规"), "blue")
        other["image"] = other["images"][0]["path"] = self.entry["image"]
        self.book.update({"entries": [self.entry, other], "entryCount": 2, "imagedCount": 2})
        self.book["tree"] = importer.build_tree(self.book["entries"])
        self.index = [importer.index_meta(self.book)]
        result = self.validate()
        self.assertTrue(any("cross_entry_thumb_name_duplicate" in issue for issue in result["issues"]))

        owner = "another-asset-owner"
        owner_thumbs, owner_originals = self.thumbs.parent / owner, self.originals.parent / owner
        owner_thumbs.mkdir()
        owner_originals.mkdir()
        (owner_thumbs / self.entry["image"]).write_bytes((self.thumbs / self.entry["image"]).read_bytes())
        (owner_originals / self.entry["original"]).write_bytes((self.originals / other["original"]).read_bytes())
        other["assetCodexId"] = owner
        other["original"] = other["images"][0]["original"] = self.entry["original"]
        self.assertEqual(self.validate()["issues"], [])

    def test_unknown_accepted_source_is_never_silently_exempted(self) -> None:
        self.rows.append({"accepted": True, "relativePath": "unknown.png", "sha256": "f" * 64})
        result = self.validate()
        self.assertEqual(result["sourceCoverage"]["unknownMissingSourceImages"][0]["source"], "unknown.png")
        self.assertFalse(result["ok"])

    def test_current_original_missing_from_source_fails(self) -> None:
        self.rows.clear()
        result = self.validate()
        self.assertEqual(len(result["sourceCoverage"]["currentDreamHashesAbsentFromSource"]), 1)
        self.assertFalse(result["ok"])

    def test_explicit_empty_categories_and_maintained_tree_order_are_valid(self) -> None:
        self.book["emptyCategories"] = [["手工空分类"]]
        self.book["tree"].insert(0, {"name": "手工空分类", "count": 0, "children": []})
        self.index = [importer.index_meta(self.book)]
        self.assertEqual(self.validate()["issues"], [])
        self.book["tree"][1]["count"] = 999
        self.assertIn("tree", self.validate()["issues"])

    def test_private_active_takedown_requires_exact_registered_original_hash(self) -> None:
        path = self.root / "tools" / "data" / "image_takedowns.json"
        path.parent.mkdir(parents=True)
        removed_id = f"{CODEX_ID}_mengshen_0224"
        registered_hash = "f" * 64
        path.write_text(json.dumps({"schemaVersion": 1, "cases": [{
            "caseId": "confirmed-removal", "status": "active", "members": [{
                "scope": "entry", "entryId": removed_id,
                "assets": [{"kind": "original", "r2Key": f"originals/{CODEX_ID}/{removed_id}.png", "sha256": registered_hash}],
            }],
        }]}), encoding="utf-8")
        self.rows.append({"accepted": True, "relativePath": "224.png", "sha256": registered_hash})
        result = self.validate()
        self.assertEqual(result["issues"], [])
        self.assertEqual(result["sourceCoverage"]["registeredTakedownMatches"][0]["entryId"], removed_id)
        self.rows[-1]["sha256"] = "a" * 64
        self.assertFalse(self.validate()["ok"])

    def suspend_entry(self) -> None:
        self.suspension = {
            "entries": [copy.deepcopy(self.entry)],
            "assets": [
                {"entryId": self.entry["id"], "kind": kind, "local": f"{folder}/{CODEX_ID}/{name}", "sha256": importer.sha256_file(directory / name)}
                for kind, folder, directory, name in (
                    ("image", "site/images", self.thumbs, self.entry["image"]),
                    ("original", "originals", self.originals, self.entry["original"]),
                )
            ],
        }
        cover = self.make_entry(f"{CODEX_ID}_mengshen_korean_0001", (importer.DREAM_ROOT_LABEL, "韩网整理", "常规"), "blue")
        self.book.update({"entries": [cover], "tree": importer.build_tree([cover]), "cover": cover["image"]})
        self.index = [{**importer.index_meta(self.book), "selectorTitle": "人工选择器标题"}]

    def test_exact_suspension_hashes_and_replacement_cover_are_valid(self) -> None:
        self.suspend_entry()
        result = self.validate()
        self.assertEqual(result["issues"], [])
        self.assertEqual(result["sourceCoverage"]["suspendedHashMatches"], 1)
        self.assertEqual(result["unreferencedAssetFiles"], [])

    def test_retained_original_alias_needs_exact_hash_and_registered_target(self) -> None:
        self.suspend_entry()
        alias = self.make_entry(f"{CODEX_ID}_mengshen_0388", DREAM_SAFE_PATH, "green")
        self.suspension["aliases"] = {alias["id"]: self.entry["id"]}
        self.index = [importer.index_meta(self.book)]
        self.rows.append(self.source_row(alias))
        result = self.validate()
        self.assertEqual(result["issues"], [])
        self.assertEqual(result["sourceCoverage"]["registeredAliasMatches"][0]["targetEntryId"], self.entry["id"])
        self.rows[-1]["sha256"] = "f" * 64
        self.assertFalse(self.validate()["ok"])

    def test_registered_suspended_media_cannot_be_corrupted_or_republished(self) -> None:
        self.suspend_entry()
        (self.originals / self.entry["original"]).write_bytes(b"changed")
        result = self.validate()
        self.assertIn(f"{self.entry['id']}:original:suspended_asset_hash", result["issues"])
        self.book["entries"].append(self.entry)
        result = self.validate()
        self.assertIn(f"{self.entry['id']}:registered_removed_entry_is_public", result["issues"])

    def test_suspension_registry_requires_complete_precise_asset_set(self) -> None:
        self.suspend_entry()
        report = self.root / "suspension.json"
        payload = {
            "status": "temporary_suspension", "mediaPolicy": "retain_local_and_r2_no_delete",
            "codexId": CODEX_ID, "pathPrefix": [importer.DREAM_ROOT_LABEL, "社区整理"],
            "entryCount": 1, "imageCount": 1, "removedEntries": self.suspension["entries"], "assets": self.suspension["assets"],
        }
        mock.patch.object(importer, "DREAM_SUSPENSION_REPORT", report).start()
        before = report.parent / "before-data" / f"{CODEX_ID}.json"
        before.parent.mkdir()
        before.write_text(json.dumps({"id": CODEX_ID, "entries": self.suspension["entries"], "entryAliases": {
            f"{CODEX_ID}_mengshen_0388": self.entry["id"],
            f"{CODEX_ID}_mengshen_0999": "unknown-target",
        }}), encoding="utf-8")
        report.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        state = importer.dream_suspension_state()
        self.assertEqual(len(state["assets"]), 2)
        self.assertEqual(state["aliases"], {f"{CODEX_ID}_mengshen_0388": self.entry["id"]})
        payload["assets"].pop()
        report.write_text(json.dumps(payload), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "incomplete"):
            importer.dream_suspension_state()

    def test_validation_writes_failure_report_and_returns_nonzero(self) -> None:
        (self.root / "data").mkdir()
        (self.root / "data" / f"{CODEX_ID}.json").write_text(json.dumps(self.book), encoding="utf-8")
        (self.root / "data" / "codexes.json").write_text(json.dumps(self.index), encoding="utf-8")
        self.rows.append({"accepted": True, "relativePath": "unknown.png", "sha256": "f" * 64})
        with mock.patch.multiple(importer, DATA_DIR=self.root / "data", DREAM_OUTPUT_DIR=self.root / "reports"), \
             mock.patch.object(importer, "audit_dream_update_source", return_value=(self.rows, [], {"blockers": []})), \
             mock.patch.object(importer, "dream_suspension_state", return_value=self.suspension):
            with self.assertRaisesRegex(RuntimeError, "source_missing_from_current"):
                importer.validate_dream_install(self.root, 1)
        saved = json.loads((self.root / "reports" / "validation.json").read_text(encoding="utf-8"))
        self.assertFalse(saved["ok"])


if __name__ == "__main__":
    unittest.main()
