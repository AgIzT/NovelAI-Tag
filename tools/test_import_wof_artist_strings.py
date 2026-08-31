from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, PngImagePlugin

sys.path.insert(0, str(Path(__file__).resolve().parent))

import import_wof_artist_strings as wof  # noqa: E402


class WofExistingUpdateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.original_constants = {
            "DATA_DIR": wof.DATA_DIR,
            "IMAGE_ROOT": wof.IMAGE_ROOT,
            "ORIGINAL_ROOT": wof.ORIGINAL_ROOT,
            "OUTPUT_DIR": wof.OUTPUT_DIR,
        }
        wof.DATA_DIR = self.root / "data"
        wof.IMAGE_ROOT = self.root / "images"
        wof.ORIGINAL_ROOT = self.root / "originals"
        wof.OUTPUT_DIR = self.root / "output"
        for path in (wof.DATA_DIR, wof.IMAGE_ROOT, wof.ORIGINAL_ROOT, wof.OUTPUT_DIR):
            path.mkdir(parents=True)

    def tearDown(self) -> None:
        for name, value in self.original_constants.items():
            setattr(wof, name, value)
        self.temp_dir.cleanup()

    @staticmethod
    def make_png(path: Path, prompt: str, color: tuple[int, int, int]) -> None:
        info = PngImagePlugin.PngInfo()
        info.add_text("Description", prompt)
        Image.new("RGB", (12, 10), color).save(path, pnginfo=info)

    @staticmethod
    def make_thumb(source: Path, destination: Path) -> None:
        with Image.open(source) as image:
            image.convert("RGB").save(destination, "JPEG", quality=86, optimize=True)

    def install_old_asset(self, codex_id: str, base: str, prompt: str, color: tuple[int, int, int]) -> dict[str, str]:
        original_dir = wof.ORIGINAL_ROOT / codex_id
        thumb_dir = wof.IMAGE_ROOT / codex_id
        original_dir.mkdir(exist_ok=True)
        thumb_dir.mkdir(exist_ok=True)
        original_name = base + ".png"
        thumb_name = base + ".jpg"
        self.make_png(original_dir / original_name, prompt, color)
        self.make_thumb(original_dir / original_name, thumb_dir / thumb_name)
        return {"path": thumb_name, "original": original_name}

    def test_full_pack_update_is_stable_and_lossless(self) -> None:
        # 2026-08-31 合并后：数据落在合并册 book_id，W.O.F 的词条 id 前缀与图片目录仍是系列 id
        codex_id = "artist_nai45_strings"
        book_id = "artist_nai45_personal"
        prompt_old = "artist:a, masterpiece"
        prompt_missing = "artist:missing, masterpiece"
        image_1 = self.install_old_asset(codex_id, f"{codex_id}_0001", prompt_old, (10, 20, 30))
        image_2 = self.install_old_asset(codex_id, f"{codex_id}_0001-02", prompt_old, (20, 30, 40))
        image_missing = self.install_old_asset(
            codex_id,
            f"{codex_id}_0002",
            prompt_missing,
            (30, 40, 50),
        )
        existing = {
            "id": book_id,
            "type": "string",
            "title": "NovelAI v4.5画师词典",
            "version": "2026.7.10",
            "author": "PieDriver / 梦神",
            "source": "unchanged source",
            "contributors": [{"name": "PieDriver"}, {"name": "梦神"}],
            "entryCount": 4,
            "imagedCount": 4,
            "hasOriginal": True,
            "tree": [
                {"name": "单画师词典", "count": 1, "children": [
                    {"name": "300画师(4.5F版)", "count": 1, "children": []},
                ]},
                {"name": "画师串词典", "count": 3, "children": [
                    {"name": "W.O.F_画风", "count": 2, "children": []},
                    {"name": "梦神NAI4.5F画风合集", "count": 1, "children": []},
                ]},
            ],
            "entries": [
                {
                    "id": "artist_300_0001",
                    "title": "ask_(askzy)",
                    "path": ["单画师词典", "300画师(4.5F版)"],
                    "tags": "artist:ask",
                    "image": "artist_300_0001.jpg",
                    "images": [{"path": "artist_300_0001.jpg", "original": "artist_300_0001.png"}],
                    "assetCodexId": "artist_300",
                },
                {
                    "id": f"{codex_id}_0001",
                    "title": "W.O.F 001",
                    "path": ["画师串词典", "W.O.F_画风"],
                    "tags": prompt_old,
                    "isNew": False,
                    "image": image_1["path"],
                    "original": image_1["original"],
                    "images": [image_1, image_2],
                },
                {
                    "id": f"{codex_id}_0002",
                    "title": "W.O.F 002",
                    "path": ["画师串词典", "W.O.F_画风"],
                    "tags": prompt_missing,
                    "isNew": False,
                    "image": image_missing["path"],
                    "original": image_missing["original"],
                    "images": [image_missing],
                },
                {
                    "id": "mengshen_pack-0001",
                    "title": "梦神 001",
                    "path": ["画师串词典", "梦神NAI4.5F画风合集"],
                    "tags": "dream",
                    "image": "mengshen_pack-0001.jpg",
                    "images": [{"path": "mengshen_pack-0001.jpg", "original": "mengshen_pack-0001.png"}],
                    "assetCodexId": "mengshen_pack",
                },
            ],
        }

        source = self.root / "source"
        source.mkdir()
        shutil.copy2(wof.ORIGINAL_ROOT / codex_id / image_1["original"], source / "a-old.png")
        self.make_png(source / "b-new.png", "artist:new, masterpiece", (90, 80, 70))
        groups, _ = wof.scan_source(source)
        items, summary = wof.plan_existing_update(groups, existing, codex_id)

        self.assertEqual(summary["promptMatches"], 1)
        self.assertEqual(summary["preservedExistingEntriesMissingFromSource"], 1)
        self.assertEqual(summary["preservedOldImagesMissingFromSource"], 2)
        self.assertEqual(summary["changedExistingEntries"], 0)
        self.assertEqual(summary["newEntries"], 1)
        self.assertEqual(summary["newIdFirst"], f"{codex_id}_0003")
        self.assertEqual([item["entryId"] for item in items], [
            f"{codex_id}_0001",
            f"{codex_id}_0002",
            f"{codex_id}_0003",
        ])

        entries, _, _ = wof.stage_update_assets(items, codex_id, "2026.8.23")
        for entry in entries:
            self.assertEqual(entry["path"], ["画师串词典", "W.O.F_画风"])
            # 合并册里 W.O.F 的图仍在 images/artist_nai45_strings/，路由必须写死系列身份
            self.assertEqual(entry["assetCodexId"], codex_id)
        self.assertEqual(len(entries[0]["images"]), 2)
        self.assertFalse(entries[0]["isNew"])
        self.assertNotIn("updateBatches", entries[0])
        self.assertFalse(entries[1]["isNew"])
        self.assertTrue(entries[2]["isNew"])
        self.assertEqual(entries[2]["updateBatches"], ["2026.8.23"])

        merged = wof.merge_existing_codex(existing, entries, "2026.8.23")
        self.assertEqual(merged["author"], existing["author"])
        self.assertEqual(merged["source"], existing["source"])
        self.assertEqual(merged["contributors"], existing["contributors"])
        self.assertEqual(merged["entryCount"], 5)
        self.assertEqual(merged["tree"][0], existing["tree"][0])  # 单画师词典那一枝一根手指都没碰
        strings_branch = merged["tree"][1]
        self.assertEqual(strings_branch["count"], 4)  # 3 条 W.O.F + 1 条梦神
        self.assertEqual(strings_branch["children"][0], {"name": "W.O.F_画风", "count": 3, "children": []})
        self.assertEqual(strings_branch["children"][1]["count"], 1)
        # W.O.F 块回到原位：单画师词典在前、梦神在后，别被顶到全书最前
        self.assertEqual([entry["id"] for entry in merged["entries"]], [
            "artist_300_0001",
            f"{codex_id}_0001",
            f"{codex_id}_0002",
            f"{codex_id}_0003",
            "mengshen_pack-0001",
        ])

        index = [{
            "id": book_id,
            "version": "2026.7.10",
            "author": existing["author"],
            "source": existing["source"],
            "contributors": existing["contributors"],
            "cover": image_1["path"],
        }]
        updated_index = wof.updated_index_payload(index, merged, "2026.8.23")
        meta = updated_index[0]
        self.assertEqual(meta["author"], existing["author"])
        self.assertEqual(meta["source"], existing["source"])
        self.assertEqual(meta["newFilterLabel"], "本次8.23更新")
        self.assertEqual(meta["updateFilters"], [
            {"id": "2026.8.23", "label": "8.23更新", "latest": True},
        ])


if __name__ == "__main__":
    unittest.main()
