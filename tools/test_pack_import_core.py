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


if __name__ == "__main__":
    unittest.main()
