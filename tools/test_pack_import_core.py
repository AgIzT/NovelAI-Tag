from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image
from PIL.PngImagePlugin import PngInfo

from pack_import_core import (
    build_tree,
    inspect_image,
    make_staging_directory,
    mark_exact_duplicates,
    normalized_suffix,
    sha256_file,
    tree_counts,
    validate_asset,
    write_asset_bundle_from_paths,
    write_asset_from_path,
)


class PackImportCoreTests(unittest.TestCase):
    def test_import_normalizes_default_suffix_and_preserves_original_metadata(self) -> None:
        from import_community_ai_misc import validation_one
        from sd_metadata_inspector import extract_image_metadata

        suffix = "very aesthetic, masterpiece, no text"
        source_prompt = f"artist, 1girl, {suffix}, masterpiece, no text, very aesthetic,"
        negative = f"lowres, {suffix}"
        character = f"standing, {suffix}"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.png"
            info = PngInfo()
            info.add_text("Software", "NovelAI")
            info.add_text("Comment", json.dumps({
                "prompt": source_prompt,
                "uc": negative,
                "v4_prompt": {"caption": {
                    "base_caption": source_prompt,
                    "char_captions": [{"char_caption": character}],
                }},
            }))
            Image.new("RGB", (64, 80), (1, 2, 3)).save(source, pnginfo=info)
            digest = sha256_file(source)
            meta = extract_image_metadata(source)
            self.assertEqual(meta.prompt, source_prompt)

            row = inspect_image(source)
            self.assertEqual(row["error"], "")
            self.assertEqual(row["prompt"], "artist, 1girl")
            self.assertEqual(row["promptTagCount"], 2)
            self.assertEqual(row["negative"], negative)
            self.assertEqual(row["characterPrompts"], [{"label": "char1", "prompt": character}])

            thumbs, originals = root / "thumbs", root / "originals"
            thumbs.mkdir()
            originals.mkdir()
            asset = write_asset_bundle_from_paths({
                "entryId": "sample",
                "sources": [{
                    "sourcePath": str(source), "sha256": digest,
                    "imageFields": {"rawTag": source_prompt, "negative": negative},
                }],
                "thumbDir": str(thumbs), "originalDir": str(originals),
            })
            self.assertEqual(asset["images"][0]["rawTag"], "artist, 1girl")
            self.assertEqual(asset["images"][0]["negative"], negative)
            self.assertEqual(sha256_file(source), digest)
            self.assertEqual(sha256_file(originals / asset["original"]), digest)
            self.assertEqual(extract_image_metadata(originals / asset["original"]).prompt, source_prompt)
            entry = {
                "id": "sample", "tags": row["prompt"], "negative": negative,
                "characterPrompts": row["characterPrompts"],
                "imageWidth": asset["imageWidth"], "imageHeight": asset["imageHeight"],
            }
            validation = {
                "entry": entry, "original": str(originals / asset["original"]),
                "thumb": str(thumbs / asset["image"]),
            }
            self.assertEqual(validation_one(validation)["issues"], [])
            entry["tags"] = "artist, edited"
            self.assertIn("prompt_mismatch", validation_one(validation)["issues"])

    def test_backfill_and_installed_validation_accept_normalized_main_prompts(self) -> None:
        from backfill_pack_image_prompts import plan_entry
        from import_mengshen_korean_pack import installed_prompt_issues

        suffix = "very aesthetic, masterpiece, no text"
        characters = [{"label": "char1", "prompt": f"standing, {suffix}"}]
        rows = [
            {"prompt": f"artist, room, {suffix}, {suffix}", "negative": suffix, "characterPrompts": characters},
            {"prompt": f"artist, beach, no text, very aesthetic, masterpiece", "negative": suffix, "characterPrompts": characters},
        ]
        entry = {
            "id": "sample", "tags": "artist, room", "negative": suffix,
            "characterPrompts": characters, "perImagePrompts": True,
            "images": [
                {"path": "cover.jpg", "original": "cover.png", "rawTag": "artist, room"},
                {"path": "next.jpg", "original": "next.png", "rawTag": "artist, beach"},
            ],
        }
        self.assertEqual(installed_prompt_issues(entry, rows, "sample"), [])
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "book").mkdir()
            for image in entry["images"]:
                (root / "book" / image["original"]).write_bytes(b"fixture")
            by_name = dict(zip((image["original"] for image in entry["images"]), rows))
            def reader(path):
                row = by_name[path.name]
                return row["prompt"], row["negative"], row["characterPrompts"]
            targets, reason = plan_entry("book", entry, root, reader)
            self.assertEqual(reason, "")
            self.assertEqual(targets, [{"negative": None, "characterPrompts": None}])
            entry["images"][1]["rawTag"] = "artist, edited"
            self.assertEqual(plan_entry("book", entry, root, reader), (None, "[2] prompt_mismatch"))

    def test_character_backfill_normalizes_base_without_changing_character_or_negative(self) -> None:
        from backfill_pack_character_prompts import reconcile_prompt_field

        suffix = "very aesthetic, masterpiece, no text"
        source_base = f"artist, {suffix}, {suffix}"
        characters = [{"label": "char1", "prompt": f"standing, {suffix}"}]
        entry = {"tags": "artist"}
        self.assertEqual(reconcile_prompt_field(entry, "tags", source_base, characters, "prompt"), "already_base")
        entry = {"tags": source_base + "\n" + characters[0]["prompt"]}
        self.assertEqual(reconcile_prompt_field(entry, "tags", source_base, characters, "prompt"), "separated_flattened")
        self.assertEqual(entry["tags"], "artist")
        self.assertEqual(characters[0]["prompt"], f"standing, {suffix}")
        negative = {"negative": suffix}
        self.assertEqual(reconcile_prompt_field(negative, "negative", suffix, [], "negative"), "already_base")
        self.assertEqual(negative["negative"], suffix)

    def test_tree_counts_preserves_paths_counts_and_empty_categories(self) -> None:
        tree = [{"name": "root", "count": 1, "children": [
            {"name": "empty", "count": 0, "children": []},
            {"name": "active", "count": 1, "children": []},
        ]}]
        self.assertEqual(tree_counts(tree), {
            ("root",): 1, ("root", "empty"): 0, ("root", "active"): 1,
        })
        tree[0]["children"].reverse()
        self.assertEqual(tree_counts(tree)[("root", "active")], 1)

    def test_tree_counts_rejects_duplicate_sibling_paths(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate category"):
            tree_counts([
                {"name": "same", "count": 1, "children": []},
                {"name": "same", "count": 2, "children": []},
            ])

    def test_staging_directory_is_unique_and_renameable(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            parent = Path(temp) / "assets"
            first = make_staging_directory(parent, ".stage-")
            second = make_staging_directory(parent, ".stage-")
            final = parent / "final"
            first.rename(final)
            self.assertTrue(final.is_dir())
            self.assertTrue(second.is_dir())
            self.assertNotEqual(final, second)

    def test_tree_counts_nested_paths(self) -> None:
        tree = build_tree([
            {"path": ["单画师词典", "九七", "来源"]},
            {"path": ["单画师词典", "九七", "来源"]},
            {"path": ["画师串词典", "梦神", "来源"]},
        ])
        self.assertEqual(tree[0]["count"], 2)
        self.assertEqual(tree[0]["children"][0]["children"][0]["count"], 2)
        self.assertEqual(tree[1]["count"], 1)

    def test_duplicate_keeps_more_restrictive_copy(self) -> None:
        rows = [
            {"accepted": True, "sha256": "same", "rating": "restricted", "sourceIndex": 1, "relativePath": "a"},
            {"accepted": True, "sha256": "same", "rating": "r18", "sourceIndex": 2, "relativePath": "b"},
        ]
        mark_exact_duplicates(rows)
        self.assertFalse(rows[0]["accepted"])
        self.assertEqual(rows[0]["duplicateOf"], "b")
        self.assertTrue(rows[1]["accepted"])

    def test_normalized_suffix_accepts_decoder_extension(self) -> None:
        self.assertEqual(normalized_suffix("png"), ".png")
        self.assertEqual(normalized_suffix(".jpeg"), ".jpg")

    def test_preserved_small_display_keeps_png_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.png"
            thumbs = root / "thumbs"
            originals = root / "originals"
            thumbs.mkdir()
            originals.mkdir()
            Image.new("RGBA", (501, 501), (1, 2, 3, 128)).save(source)
            digest = sha256_file(source)
            asset = write_asset_from_path({
                "sourcePath": str(source),
                "entryId": "sample",
                "sha256": digest,
                "thumbDir": str(thumbs),
                "originalDir": str(originals),
                "preserveDisplay": True,
            })
            self.assertEqual(asset["image"], "sample.png")
            self.assertEqual(sha256_file(thumbs / asset["image"]), digest)
            self.assertEqual(sha256_file(originals / asset["original"]), digest)

    def test_multi_image_bundle_has_no_small_gallery_cap(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            thumbs = root / "thumbs"
            originals = root / "originals"
            thumbs.mkdir()
            originals.mkdir()
            sources = []
            for index in range(12):
                source = root / f"source-{index + 1:02d}.png"
                Image.new("RGB", (64 + index, 80), (index, 2, 3)).save(source)
                sources.append({
                    "sourcePath": str(source),
                    "sha256": sha256_file(source),
                    "imageFields": {"rawTag": f"prompt {index + 1}"},
                })
            asset = write_asset_bundle_from_paths({
                "entryId": "set",
                "sources": sources,
                "thumbDir": str(thumbs),
                "originalDir": str(originals),
            })
            self.assertEqual(len(asset["images"]), 12)
            self.assertEqual(asset["images"][0]["path"], "set.jpg")
            self.assertEqual(asset["images"][1]["path"], "set-02.jpg")
            self.assertEqual(asset["images"][11]["original"], "set-12.png")
            self.assertEqual(asset["images"][11]["rawTag"], "prompt 12")
            entry = {"id": "set", **{key: value for key, value in asset.items() if key != "entryId"}}
            self.assertEqual(validate_asset(entry, thumbs, originals), [])


class SerialTitleTests(unittest.TestCase):
    def test_serial_title_prefers_field_and_falls_back_to_title(self) -> None:
        from pack_import_core import serial_title

        self.assertEqual(serial_title({"title": "银发御姐·海边", "serialTitle": "韩网整理 012"}), "韩网整理 012")
        self.assertEqual(serial_title({"title": "韩网整理 013"}), "韩网整理 013")
        self.assertEqual(serial_title({"title": "韩网整理 014", "serialTitle": "  "}), "韩网整理 014")


class PerImagePromptTests(unittest.TestCase):
    """套图逐图负面 / 角色词：只写与封面不同的，负面为空也写空串，整组标 perImagePrompts。"""

    COVER_CHARS = [{"label": "char1", "prompt": "girl, sitting"}]
    OWN_CHARS = [{"label": "char1", "prompt": "girl, standing", "negative": "hat"}]

    def members(self) -> list[dict]:
        return [
            {"prompt": "a", "negative": "lowres", "characterPrompts": self.COVER_CHARS},
            {"prompt": "b", "negative": "lowres", "characterPrompts": self.OWN_CHARS},
            {"prompt": "c", "negative": "", "characterPrompts": []},
            {"prompt": "d", "negative": "lowres", "characterPrompts": self.COVER_CHARS},
        ]

    def entry(self) -> dict:
        return {
            "id": "set", "negative": "lowres", "characterPrompts": self.COVER_CHARS,
            "images": [{"path": f"{i}.jpg", "rawTag": p} for i, p in enumerate("abcd", 1)],
        }

    def test_attach_writes_only_differences_and_marker(self) -> None:
        from pack_import_core import PER_IMAGE_PROMPTS_MARKER, attach_per_image_prompts

        entry = attach_per_image_prompts(self.entry(), self.members())
        images = entry["images"]
        self.assertIs(entry[PER_IMAGE_PROMPTS_MARKER], True)
        self.assertEqual(images[0], {"path": "1.jpg", "rawTag": "a"}, "封面不写逐图字段")
        self.assertEqual(images[1]["characterPrompts"], self.OWN_CHARS)
        self.assertNotIn("negative", images[1])
        self.assertEqual((images[2]["negative"], images[2]["characterPrompts"]), ("", []))
        self.assertEqual(images[3], {"path": "4.jpg", "rawTag": "d"})

    def test_attach_replaces_stale_fields_and_skips_single_images(self) -> None:
        from pack_import_core import attach_per_image_prompts

        entry = self.entry()
        entry["images"][3]["negative"] = "stale"
        attach_per_image_prompts(entry, self.members())
        self.assertNotIn("negative", entry["images"][3])
        single = {"id": "one", "images": [{"path": "1.jpg"}]}
        self.assertEqual(attach_per_image_prompts(single, self.members()[:1]), {"id": "one", "images": [{"path": "1.jpg"}]})
        with self.assertRaises(ValueError):
            attach_per_image_prompts(self.entry(), self.members()[:3])

    def test_effective_prompts_and_issues(self) -> None:
        from pack_import_core import attach_per_image_prompts, effective_image_prompts, per_image_prompt_issues

        entry = attach_per_image_prompts(self.entry(), self.members())
        self.assertEqual(effective_image_prompts(entry, entry["images"], 0), ("lowres", self.COVER_CHARS))
        self.assertEqual(effective_image_prompts(entry, entry["images"], 2), ("", []))
        self.assertEqual(effective_image_prompts(entry, entry["images"], 3), ("lowres", self.COVER_CHARS))
        self.assertEqual(per_image_prompt_issues(entry, self.members(), "set"), [])
        entry["images"][1].pop("characterPrompts")
        del entry["perImagePrompts"]
        self.assertEqual(
            per_image_prompt_issues(entry, self.members(), "set"),
            ["set:per_image_prompts_marker", "set[2]:image_character_prompts"],
        )

    def test_set_note_no_longer_claims_cover_only(self) -> None:
        from pack_import_core import set_prompt_note

        self.assertEqual(set_prompt_note(17), "套图：17 张；提示词随当前图切换。")
        self.assertNotIn("封面", set_prompt_note(3))
        self.assertEqual(set_prompt_note(1), "套图：1 张。")


if __name__ == "__main__":
    unittest.main()
