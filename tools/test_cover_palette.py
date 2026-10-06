import tempfile
import unittest
from pathlib import Path

from PIL import Image
from build_updates_index import cover_palette


class CoverPaletteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "images"
        self.folder = self.root / "legacy"
        self.folder.mkdir(parents=True)
        image = Image.new("RGB", (64, 64))
        image.putdata([(220, 185, 150), (25, 40, 70), (70, 120, 150), (175, 70, 60)] * 1024)
        image.save(self.folder / "cover.png")
        self.meta = {"id": "merged", "coverCodexId": "legacy", "cover": "cover.png", "coverRev": "v2"}
        self.entries = [{"id": "entry", "assetCodexId": "legacy", "image": "cover.png", "rating": "safe"}]

    def test_colors_are_deterministic_and_keep_source_revision(self):
        result = cover_palette(self.meta, self.entries, self.root)
        self.assertEqual(result, cover_palette(self.meta, self.entries, self.root))
        self.assertEqual(len(result["colors"]), 4)
        self.assertEqual(set(result["colors"]), {"#dcb996", "#192846", "#467896", "#af463c"})
        self.assertEqual((result["assetCodexId"], result["assetRev"], result["id"]), ("legacy", "v2", "entry"))

    def test_missing_external_and_escaping_paths_are_omitted(self):
        self.assertIsNone(cover_palette({**self.meta, "cover": "missing.png"}, self.entries, self.root))
        self.assertIsNone(cover_palette({**self.meta, "cover": "../legacy/cover.png", "coverCodexId": ".."}, self.entries, self.root))
        self.assertIsNone(cover_palette({**self.meta, "assetPathMode": "relative"}, self.entries, self.root))
        self.assertIsNone(cover_palette({**self.meta, "dataUrl": "https://example.com/book.json"}, self.entries, self.root))

    def test_access_markers_and_low_information_cover(self):
        self.assertTrue(cover_palette(self.meta, [{**self.entries[0], "path": ["NSFW"]}], self.root)["nsfw"])
        self.assertIsNone(cover_palette(self.meta, [{**self.entries[0], "rating": "r18g"}], self.root))
        Image.new("RGB", (64, 64), "white").save(self.folder / "cover.png")
        self.assertIsNone(cover_palette(self.meta, self.entries, self.root))


if __name__ == "__main__":
    unittest.main()
