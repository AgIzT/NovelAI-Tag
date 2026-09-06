import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from tools import sync_r2


class CollectAssetsCoverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / "site" / "data"
        self.thumbs = self.root / "site" / "images"
        self.originals = self.root / "originals"
        self.data.mkdir(parents=True)
        self.thumbs.mkdir(parents=True)
        self.originals.mkdir()
        for name, value in (("DATA_DIR", self.data), ("THUMB_DIR", self.thumbs), ("ORIG_DIR", self.originals)):
            patcher = patch.object(sync_r2, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.write_json("codexes.json", [])

    def write_json(self, filename, value):
        path = self.data / filename
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def book(self, cid="demo", **extra):
        value = {"id": cid, "entryCount": 0, "imagedCount": 0, "entries": [], **extra}
        self.write_json(cid + ".json", value)
        return value

    def picture(self, cid, filename, original=False):
        path = (self.originals if original else self.thumbs) / cid / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (12, 18), "navy").save(path)
        return path

    def test_standalone_root_cover_is_collected_without_synthetic_entry_or_metadata_write(self):
        cover = self.picture("demo", "cover-winter.png")
        self.book(cover=cover.name, coverRev="manual-cover-revision")
        before = (self.data / "demo.json").read_bytes()
        assets, issues, changed, stats = sync_r2.collect_assets()
        self.assertEqual(assets, [("image", "demo", cover.name, cover, sync_r2.sha256_hex(cover))])
        self.assertEqual(issues, [])
        self.assertEqual(changed, [])
        self.assertEqual(stats, {"hit": 0, "miss": 1})
        self.assertEqual((self.data / "demo.json").read_bytes(), before)

    def test_index_only_cover_uses_borrowed_asset_owner(self):
        cover = self.picture("legacy", "selector.png")
        self.book()
        self.write_json("codexes.json", [{"id": "demo", "cover": cover.name, "coverCodexId": "legacy"}])
        assets, issues, _, _ = sync_r2.collect_assets()
        self.assertEqual(assets[0][1:4], ("legacy", "selector.png", cover))
        self.assertEqual(len(assets), 1)
        self.assertEqual(issues, [])

    def test_distinct_root_and_index_covers_are_both_collected(self):
        self.picture("demo", "root.png")
        self.picture("demo", "selector.png")
        self.book(cover="root.png")
        self.write_json("codexes.json", [{"id": "demo", "cover": "selector.png"}])
        assets, issues, _, _ = sync_r2.collect_assets()
        self.assertEqual([asset[2] for asset in assets], ["root.png", "selector.png"])
        self.assertEqual(issues, [])

    def test_cover_references_deduplicate_and_leave_entry_revision_unchanged(self):
        thumb = self.picture("demo", "demo-0001.jpg")
        original = self.picture("demo", "demo-0001.png", original=True)
        secondary = self.picture("demo", "demo-0001-02.jpg")
        secondary_original = self.picture("demo", "demo-0001-02.png", original=True)
        revision = sync_r2.rev_from_hashes([sync_r2.sha256_hex(p) for p in (thumb, original, secondary, secondary_original)])
        entry = {"id": "demo-0001", "tags": "coat", "image": thumb.name, "original": original.name,
                 "imageWidth": 12, "imageHeight": 18, "assetRev": revision,
                 "images": [{"path": thumb.name, "original": original.name},
                            {"path": secondary.name, "original": secondary_original.name}]}
        self.book(cover=thumb.name, coverRev=revision, entryCount=1, imagedCount=1, entries=[entry])
        self.write_json("codexes.json", [{"id": "demo", "entryCount": 1, "imagedCount": 1,
                                          "cover": secondary.name, "coverRev": revision},
                                         {"id": "borrower", "cover": thumb.name, "coverCodexId": "demo"}])
        assets, issues, changed, stats = sync_r2.collect_assets(apply_metadata=True)
        self.assertEqual(len(assets), 4)
        self.assertEqual(len({(a[0], a[1], a[2]) for a in assets}), 4)
        self.assertEqual(issues, [])
        self.assertEqual(changed, [])
        self.assertEqual(stats, {"hit": 0, "miss": 4})
        self.assertEqual(sync_r2.load_json(self.data / "demo.json")["entries"], [entry])
        self.assertEqual(sync_r2.load_json(self.data / "demo.json")["coverRev"], revision)

    def test_external_and_relative_mode_covers_are_not_local_uploads(self):
        self.book(cover="https://example.com/cover.png")
        self.write_json("codexes.json", [
            {"id": "a", "cover": "HTTP://example.com/cover.png"},
            {"id": "b", "cover": "data:image/png;base64,AA=="},
            {"id": "c", "cover": "//example.com/cover.png"},
            {"id": "d", "cover": "images/cover.png", "assetPathMode": "relative", "assetBaseUrl": "https://example.com"},
        ])
        assets, issues, _, stats = sync_r2.collect_assets()
        self.assertEqual(assets, [])
        self.assertEqual(issues, [])
        self.assertEqual(stats, {"hit": 0, "miss": 0})

    def test_index_data_url_implies_relative_cover_paths(self):
        self.book()
        self.write_json("codexes.json", [{"id": "demo", "cover": "images/cover.png",
                                          "dataUrl": "https://example.com/data.json"}])
        assets, issues, _, _ = sync_r2.collect_assets()
        self.assertEqual(assets, [])
        self.assertEqual(issues, [])

    def test_index_external_metadata_applies_to_root_cover(self):
        self.book(cover="images/cover.png", assetPathMode="codex")
        self.write_json("codexes.json", [{"id": "demo", "assetPathMode": "relative",
                                          "assetBaseUrl": "https://example.com"}])
        assets, issues, _, _ = sync_r2.collect_assets()
        self.assertEqual(assets, [])
        self.assertEqual(issues, [])

    def test_explicit_index_codex_mode_overrides_root_relative_and_data_url(self):
        cover = self.picture("demo", "cover.png")
        self.book(cover=cover.name, assetPathMode="relative")
        self.write_json("codexes.json", [{"id": "demo", "assetPathMode": "codex",
                                          "dataUrl": "https://example.com/data.json"}])
        assets, issues, _, _ = sync_r2.collect_assets()
        self.assertEqual(assets[0][1:4], ("demo", cover.name, cover))
        self.assertEqual(len(assets), 1)
        self.assertEqual(issues, [])

    def test_missing_cover_reports_once_across_root_and_index(self):
        self.book(cover="missing.png")
        self.write_json("codexes.json", [{"id": "demo", "cover": "missing.png"}])
        assets, issues, changed, _ = sync_r2.collect_assets()
        self.assertEqual(assets, [])
        self.assertEqual(issues, ["missing cover: demo/missing.png"])
        self.assertEqual(changed, [])

    def test_cover_hash_cache_uses_configured_image_prefix(self):
        cover = self.picture("demo", "cover.png")
        self.book(cover=cover.name)
        sha = sync_r2.sha256_hex(cover)
        manifest = {"art/demo/cover.png": sync_r2.manifest_entry(cover, sha)}
        with patch.object(sync_r2, "sha256_hex", side_effect=AssertionError("cache was not used")):
            assets, issues, _, stats = sync_r2.collect_assets(cfg={"image_prefix": "art"}, manifest_objects=manifest)
        self.assertEqual(assets[0][-1], sha)
        self.assertEqual(issues, [])
        self.assertEqual(stats, {"hit": 1, "miss": 0})

    def test_cover_cannot_escape_its_local_cache_directory(self):
        self.book(cover="../../private.txt")
        assets, issues, _, _ = sync_r2.collect_assets()
        self.assertEqual(assets, [])
        self.assertEqual(issues, ["invalid cover path: demo/../../private.txt"])


if __name__ == "__main__":
    unittest.main()
