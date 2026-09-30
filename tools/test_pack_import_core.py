from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image

from pack_import_core import (
    build_tree,
    make_staging_directory,
    mark_exact_duplicates,
    normalized_suffix,
    sha256_file,
    validate_asset,
    write_asset_bundle_from_paths,
    write_asset_from_path,
)


class PackImportCoreTests(unittest.TestCase):
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
