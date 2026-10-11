from __future__ import annotations

import sys
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image
from PIL.PngImagePlugin import PngInfo


TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from import_mengshen_korean_pack import (  # noqa: E402
    CONFIRMED_VISUAL_DUPLICATES,
    N5_COMMUNITY_NSFW_PATH,
    N5_COMMUNITY_SAFE_PATH,
    N5_BOOK_ID,
    _legacy_community_path,
    entry_from_group,
    index_cover_issue,
    index_meta,
    mark_source_duplicates,
    model_family,
    suspicious_prompt_reason,
    installed_book_issues,
    installed_path_issue,
    installed_prompt_issues,
    installed_target_entry,
    installed_source_coverage,
)
import import_mengshen_korean_pack as importer  # noqa: E402
from pack_import_core import build_tree  # noqa: E402


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


class KoreanSetEntryTests(unittest.TestCase):
    def test_set_entry_carries_per_image_negative_and_character_prompts(self) -> None:
        chars = [{"label": "char1", "prompt": "girl"}]
        own = [{"label": "char1", "prompt": "boy"}, {"label": "char3", "prompt": "text"}]
        members = [
            {"prompt": "a", "negative": "lowres", "characterPrompts": chars},
            {"prompt": "b", "negative": "lowres", "characterPrompts": own},
            {"prompt": "c", "negative": "blurry", "characterPrompts": chars},
        ]
        group = {
            "kind": "set", "acceptedMembers": members, "inputImageCount": 3,
            "targetTitle": "韩网套图 900", "path": ["梦神 · N5社区图包", "韩网整理", "NSFW"],
            "rating": "r18", "targetEntryId": "k900", "bookId": N5_BOOK_ID,
        }
        asset = {
            "entryId": "k900", "image": "k900.jpg", "original": "k900.webp", "assetRev": "0" * 16,
            "images": [{"path": f"k900-{i}.jpg", "original": f"k900-{i}.webp", "rawTag": m["prompt"]} for i, m in enumerate(members, 1)],
        }
        entry = entry_from_group(group, asset)
        self.assertIs(entry["perImagePrompts"], True)
        self.assertEqual(entry["note"], "套图：3 张；提示词随当前图切换。")
        self.assertEqual(entry["images"][1]["characterPrompts"], own)
        self.assertNotIn("negative", entry["images"][1])
        self.assertEqual(entry["images"][2]["negative"], "blurry")
        self.assertNotIn("characterPrompts", entry["images"][2])


class KoreanSerialNumberTests(unittest.TestCase):
    def test_maximum_title_reads_serial_field_of_named_entries(self) -> None:
        from import_mengshen_korean_pack import N45_NSFW_PATH, _maximum_title

        entries = [
            {"path": list(N45_NSFW_PATH), "title": "修女·触手拘束", "serialTitle": "R18 0733"},
            {"path": list(N45_NSFW_PATH), "title": "R18 0100"},
            {"path": ["其他"], "title": "R18 9999"},
        ]
        self.assertEqual(_maximum_title(entries, N45_NSFW_PATH, "R18"), 733)


class InstalledValidationTests(unittest.TestCase):
    def test_installed_single_image_rejects_unexpected_raw_tag(self) -> None:
        entry = {
            "tags": "artist:wanke", "negative": "lowres",
            "images": [{"path": "a.jpg", "original": "a.png", "rawTag": "wrong prompt"}],
        }
        rows = [{"prompt": "artist:wanke", "negative": "lowres"}]
        self.assertEqual(installed_prompt_issues(entry, rows, "single"), ["single:unexpected_raw_tag"])
        entry["images"][0]["rawTag"] = ""
        self.assertEqual(installed_prompt_issues(entry, rows, "single"), [])

    def test_duplicate_source_hash_in_target_is_rejected_but_other_branches_are_reported(self) -> None:
        for book_id, target in (
            (N5_BOOK_ID, {"id": f"{N5_BOOK_ID}_mengshen_korean_0001", "path": [importer.N5_ROOT_LABEL, importer.N5_CREATOR_LABEL, "常规"]}),
            (importer.N45_BOOK_ID, {"id": "mengshen_pack-0259", "path": list(importer.N45_SAFE_PATH)}),
        ):
            with self.subTest(book_id=book_id):
                rows = [{"accepted": True, "bookId": book_id, "sha256": "same", "relativePath": "dup.png"}]
                states = {book_id: {"hashRefs": {"same": [
                    {"entryId": target["id"], "entry": target},
                    {"entryId": "another-id", "entry": {"id": "another-id", "path": ["other"]}},
                ]}}}
                coverage, issues = installed_source_coverage(rows, states, {})
                self.assertEqual(issues, [f"{book_id}:dup.png:duplicate_installed_source_hash:same"])
                self.assertEqual(len(coverage["preExistingDuplicateReferences"]), 1)
                states[book_id]["hashRefs"]["same"][0] = {"entryId": "other-id", "entry": {"id": "other-id", "path": ["other"]}}
                coverage, issues = installed_source_coverage(rows, states, {})
                self.assertEqual(issues, [])
                self.assertEqual(len(coverage["preExistingDuplicateReferences"]), 1)

    def test_source_hash_coverage_distinguishes_removal_from_unknown_missing_and_reentry(self) -> None:
        rows = [
            {"accepted": True, "bookId": N5_BOOK_ID, "sha256": digest, "relativePath": digest + ".png"}
            for digest in ("kept", "removed", "missing")
        ]
        states = {N5_BOOK_ID: {"hashRefs": {"kept": [{"entryId": "merged-current"}]}}}
        coverage, issues = installed_source_coverage(rows, states, {"removed": "old-id"})
        self.assertEqual(coverage["matchedImages"], 1)
        self.assertEqual(coverage["activeTakedownExclusions"][0]["removedEntryId"], "old-id")
        self.assertEqual(coverage["unmatchedImages"], 1)
        self.assertEqual(issues, [f"{N5_BOOK_ID}:missing.png:source_hash_not_installed:missing"])
        states[N5_BOOK_ID]["hashRefs"]["removed"] = [{"entryId": "changed-id"}]
        _coverage, issues = installed_source_coverage(rows, states, {"removed": "old-id"})
        self.assertIn(f"{N5_BOOK_ID}:removed.png:active_takedown_reintroduced:removed", issues)

    def test_creator_move_keeps_korean_identity_but_other_batches_are_out_of_scope(self) -> None:
        entry = {
            "id": f"{N5_BOOK_ID}_mengshen_korean_0039",
            "path": [importer.N5_ROOT_LABEL, importer.N5_CREATOR_LABEL, "常规"],
            "rating": "safe",
        }
        self.assertTrue(installed_target_entry(N5_BOOK_ID, entry))
        self.assertIsNone(installed_path_issue(N5_BOOK_ID, entry))
        entry["path"][1] = "未知目录"
        self.assertIn("path_or_rating", installed_path_issue(N5_BOOK_ID, entry) or "")
        entry["id"] = f"{N5_BOOK_ID}_mengshen_september_2026_0001"
        entry["path"][1] = "九月韩网整理"
        self.assertFalse(installed_target_entry(N5_BOOK_ID, entry))

    def test_current_tree_keeps_explicit_empty_categories_and_checks_counts(self) -> None:
        entry = {"id": "one", "path": ["book", "常规"], "image": "one.jpg"}
        codex = {
            "id": N5_BOOK_ID, "version": "2026.10.8", "entries": [entry],
            "entryCount": 1, "imagedCount": 1,
            "emptyCategories": [["book", "R18G"]],
            "tree": [{"name": "book", "count": 1, "children": [
                {"name": "R18G", "count": 0, "children": []},
                {"name": "常规", "count": 1, "children": []},
            ]}],
        }
        self.assertEqual(installed_book_issues(N5_BOOK_ID, codex), [])
        codex["tree"][0]["count"] = 2
        self.assertIn(f"{N5_BOOK_ID}:tree", installed_book_issues(N5_BOOK_ID, codex))

    def test_installed_set_checks_every_raw_prompt_negative_and_character(self) -> None:
        entry = {
            "id": "set", "tags": "cover", "negative": "lowres",
            "perImagePrompts": True,
            "images": [
                {"path": "a.jpg", "original": "a.png", "rawTag": "cover"},
                {"path": "b.jpg", "original": "b.png", "rawTag": "second", "negative": "blurry", "characterPrompts": [{"label": "char1", "prompt": "girl"}]},
            ],
        }
        rows = [{"prompt": "cover", "negative": "lowres"}, {"prompt": "second", "negative": "blurry", "characterPrompts": [{"label": "char1", "prompt": "girl"}]}]
        self.assertEqual(installed_prompt_issues(entry, rows, "set"), [])
        entry["images"][1]["rawTag"] = "wrong"
        entry["images"][1]["negative"] = "wrong"
        entry["images"][1]["characterPrompts"] = []
        issues = installed_prompt_issues(entry, rows, "set")
        self.assertIn("set[2]:raw_tag", issues)
        self.assertIn("set[2]:image_negative", issues)
        self.assertIn("set[2]:image_character_prompts", issues)

    def test_read_only_validation_uses_current_assets_and_writes_full_failure_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = root / "data"
            thumbs = root / "images"
            originals = root / "originals"
            reports = root / "reports"
            data.mkdir()
            books = {}
            for book_id, path, asset_id in (
                (N5_BOOK_ID, importer.N5_KOREAN_SAFE_PATH, N5_BOOK_ID),
                (importer.N45_BOOK_ID, importer.N45_SAFE_PATH, importer.N45_ASSET_ID),
            ):
                entry_id = f"{N5_BOOK_ID}_mengshen_korean_0001" if book_id == N5_BOOK_ID else "mengshen_pack-0259"
                (thumbs / asset_id).mkdir(parents=True)
                (originals / asset_id).mkdir(parents=True)
                pnginfo = PngInfo()
                pnginfo.add_text("Description", "artist:wanke")
                pnginfo.add_text("Comment", json.dumps({"prompt": "artist:wanke", "uc": "lowres"}))
                Image.new("RGB", (20, 10)).save(originals / asset_id / f"{entry_id}.png", pnginfo=pnginfo)
                Image.new("RGB", (20, 10)).save(thumbs / asset_id / f"{entry_id}.jpg")
                entry = {
                    "id": entry_id, "path": list(path), "rating": "safe",
                    "tags": "artist:wanke", "negative": "lowres",
                    "image": f"{entry_id}.jpg", "original": f"{entry_id}.png",
                    "imageWidth": 20, "imageHeight": 10,
                    "images": [{"path": f"{entry_id}.jpg", "original": f"{entry_id}.png"}],
                }
                if book_id != N5_BOOK_ID:
                    entry["assetCodexId"] = asset_id
                books[book_id] = {
                    "id": book_id, "version": "2026.10.8", "entries": [entry],
                    "entryCount": 1, "imagedCount": 1, "tree": build_tree([entry]),
                    "cover": entry["image"], "coverCodexId": asset_id,
                }
                (data / f"{book_id}.json").write_text(json.dumps(books[book_id]), encoding="utf-8")
            index = [importer.book_index_fields(codex) for codex in books.values()]
            index[0]["selectorTitle"] = "Picker only"
            (data / "codexes.json").write_text(json.dumps(index), encoding="utf-8")
            before = {path: path.read_bytes() for parent in (data, thumbs, originals) for path in parent.rglob("*") if path.is_file()}
            with (
                mock.patch.multiple(importer, DATA_DIR=data, IMAGE_ROOT=thumbs, ORIGINAL_ROOT=originals, OUTPUT_DIR=reports),
                mock.patch.object(importer, "run_parallel", side_effect=lambda label, fn, tasks, workers: [fn(task) for task in tasks]),
                mock.patch.object(importer, "run_plan", side_effect=AssertionError("must not replay source")),
                mock.patch.object(importer, "index_cover_issue", side_effect=lambda row: index_cover_issue(row, thumbs)),
            ):
                result = importer.validate_install(root / "absent-source", 1)
                self.assertTrue(result["valid"])
                self.assertFalse(result["sourceReplay"])
                self.assertEqual(result["installedImagesVerified"], 2)
                wrong = copy.deepcopy(books[N5_BOOK_ID])
                wrong["entries"][0]["tags"] = "wrong prompt"
                (data / f"{N5_BOOK_ID}.json").write_text(json.dumps(wrong), encoding="utf-8")
                with self.assertRaisesRegex(RuntimeError, "installed validation issues"):
                    importer.validate_install(root / "absent-source", 1)
                full_report = json.loads((reports / "validation.json").read_text(encoding="utf-8"))
                self.assertFalse(full_report["valid"])
                self.assertIn(f"{N5_BOOK_ID}:{wrong['entries'][0]['id']}:prompt", full_report["issues"])
                (data / f"{N5_BOOK_ID}.json").write_bytes(before[data / f"{N5_BOOK_ID}.json"])
                original = next(path for path in before if path.parent == originals / N5_BOOK_ID)
                original.unlink()
                with self.assertRaisesRegex(RuntimeError, "missing_original"):
                    importer.validate_install(root / "absent-source", 1)
                original.write_bytes(before[original])
            self.assertEqual(before, {path: path.read_bytes() for parent in (data, thumbs, originals) for path in parent.rglob("*") if path.is_file()})


if __name__ == "__main__":
    unittest.main()
