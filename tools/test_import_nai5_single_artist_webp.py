from __future__ import annotations

import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import import_nai5_single_artist_webp as importer
from PIL import Image
from pack_import_core import build_tree, tree_counts
from sync_r2 import rev_from_hashes


class Nai5SingleArtistWebpTests(unittest.TestCase):
    def rows(self, artists: list[str]) -> list[dict]:
        return [{
            "sourceIndex": index,
            "artist": artist,
            "file": f"images/source-{index}.webp",
            "sha256": hashlib.sha256(f"source-{index}".encode()).hexdigest(),
            "prompt": f"solo, artist:{artist}",
            "negativePrompt": "nsfw",
            "model": "nai-diffusion-5-full",
            "seed": index,
            "steps": 28,
            "scale": 5,
            "sampler": "k_dpmpp_2m_sde",
            "noiseSchedule": "karras",
            "cfgRescale": 0,
            "width": 1024,
            "height": 1024,
        } for index, artist in enumerate(artists, 1)]

    def old_book(self) -> dict:
        entries = [{
            "id": f"old-{index}",
            "title": name,
            "path": ["单画师词典", name, "已有来源"],
            "tags": f"artist:old-{index}",
            "rating": "r18" if name == "无冕" else "safe",
            "isNew": index == 2,
            "image": f"old-{index}.jpg",
            "original": f"old-{index}.png",
            "images": [{"path": f"old-{index}.jpg", "original": f"old-{index}.png",
                        "_hasOriginal": False, "rawTag": "作者手写的复制词"}],
            "note": "已经手工修订的备注",
            "updateBatches": ["2026.10.7"],
            "privateExtra": {"keep": [index]},
        } for index, name in enumerate(["花枝鱼", "雨燕(无原图)", "无冕", "成川姬"], 1)]
        return {
            "id": importer.CODEX_ID,
            "type": "string",
            "title": "NovelAI v5画师词典",
            "author": "旧作者",
            "source": "旧作者 · 来源",
            "contributors": [{"name": "旧作者", "role": "整理", "url": "https://example.com"}],
            "links": [{"label": "已有链接", "url": "https://example.com/source"}],
            "version": "2026.10.7",
            "entryCount": len(entries),
            "imagedCount": len(entries),
            "hasOriginal": True,
            "cover": "old-cover.png",
            "coverRev": "abcdef0123456789",
            "updateFilters": [{"id": "2026.10.7", "label": "10.7更新", "latest": True}],
            "tree": build_tree(entries),
            "entries": entries,
        }

    def assets(self, groups: list[dict]) -> dict:
        result = {}
        for group in groups:
            image_items = []
            for index, _member in enumerate(group["members"], 1):
                stem = group["id"] if index == 1 else f"{group['id']}-{index:02d}"
                image_items.append({"path": f"{stem}.jpg", "original": f"{stem}.webp",
                                    "rawTag": group["tags"]})
            result[group["id"]] = {
                "entryId": group["id"], "image": image_items[0]["path"],
                "original": image_items[0]["original"], "imageWidth": 1024,
                "imageHeight": 1024, "images": image_items,
                "assetRev": "0123456789abcdef",
            }
        return result

    def test_exact_artist_groups_keep_first_appearance_and_member_order(self) -> None:
        rows = self.rows(["A_b", "a b", "A  b", "A_b", "A b"])
        groups = importer.group_rows(rows)
        self.assertEqual([group["title"] for group in groups], ["A_b", "a b", "A  b", "A b"])
        self.assertEqual(groups[0]["members"], [rows[0], rows[3]])
        self.assertEqual([group["tags"] for group in groups],
                         ["artist:A_b", "artist:a b", "artist:A  b", "artist:A b"])
        self.assertEqual([group["id"] for group in groups],
                         [f"{importer.ID_PREFIX}{index:05d}" for index in range(1, 5)])
        self.assertEqual(importer.group_rows(rows), groups)

    def test_directory_insertion_keeps_other_siblings_and_counts(self) -> None:
        old = self.old_book()
        entries = (old["entries"][:2] + [{"path": list(importer.SOURCE_PATH)}] * 2
                   + old["entries"][2:])
        before = copy.deepcopy(old["tree"])
        tree = importer.ordered_tree(old["tree"], entries)
        self.assertEqual(old["tree"], before)
        source_names = [node["name"] for node in tree[0]["children"]]
        self.assertEqual(source_names,
                         ["花枝鱼", "雨燕(无原图)", "MayRain", "无冕", "成川姬"])
        self.assertEqual(tree_counts(tree), tree_counts(build_tree(entries)))

    def test_directory_requires_both_named_anchors(self) -> None:
        for missing in ("雨燕(无原图)", "无冕"):
            with self.subTest(missing=missing):
                old = self.old_book()
                old["entries"] = [e for e in old["entries"] if e["path"][1] != missing]
                old["tree"] = build_tree(old["entries"])
                entries = old["entries"] + [{"path": list(importer.SOURCE_PATH)}]
                with self.assertRaises((ValueError, RuntimeError)):
                    importer.ordered_tree(old["tree"], entries)

    def test_unknown_old_directory_cannot_silently_move_to_end(self) -> None:
        old = self.old_book()
        entries = old["entries"] + [{"path": ["单画师词典", "未映射旧来源", "未知"]},
                                    {"path": list(importer.SOURCE_PATH)}]
        with self.assertRaises((ValueError, RuntimeError)):
            importer.ordered_tree(old["tree"], entries)

    def test_compose_only_clears_old_new_flag_and_preserves_other_fields(self) -> None:
        old = self.old_book()
        meta = {key: copy.deepcopy(value) for key, value in old.items() if key != "entries"}
        meta["selectorTitle"] = "索引独有短名"
        meta["coverCodexId"] = "old_media_owner"
        meta["coverFraming"] = {"x": 50, "y": 12, "scale": 1.2}
        meta["updateFilters"][0]["samples"] = [{"id": "old-1", "image": "old-1.jpg"}]
        unrelated = {"id": "other", "entryCount": 777, "unknown": {"unchanged": True}}
        old_index = [unrelated, meta]
        before_book, before_index = copy.deepcopy(old), copy.deepcopy(old_index)
        groups = importer.group_rows(self.rows(["new", "new", "other-new"]))
        book, index = importer.compose_payload(old, old_index, groups, self.assets(groups))
        self.assertEqual(old, before_book)
        self.assertEqual(old_index, before_index)
        old_ids = {entry["id"] for entry in old["entries"]}
        expected_old_entries = copy.deepcopy(old["entries"])
        expected_old_entries[1]["isNew"] = False
        self.assertEqual([entry for entry in book["entries"] if entry["id"] in old_ids], expected_old_entries)
        self.assertEqual(index[0], unrelated)
        self.assertEqual(book["entryCount"], len(old["entries"]) + 2)
        self.assertEqual(book["imagedCount"], book["entryCount"])
        updated_meta = next(value for value in index if value["id"] == importer.CODEX_ID)
        for key in ("selectorTitle", "cover", "coverRev", "coverCodexId", "coverFraming"):
            self.assertEqual(updated_meta[key], meta[key], key)
        old_filter = next(value for value in updated_meta["updateFilters"] if value["id"] == "2026.10.7")
        self.assertEqual(old_filter["samples"], meta["updateFilters"][0]["samples"])
        self.assertEqual(updated_meta["entryCount"], book["entryCount"])
        self.assertIn({"name": "旧作者", "role": "整理", "url": "https://example.com"},
                      book["contributors"])
        self.assertTrue(any(value["name"] == "MayRain" for value in book["contributors"]))
        new_entries = [entry for entry in book["entries"] if entry["id"] not in old_ids]
        self.assertEqual([entry["id"] for entry in book["entries"]],
                         ["old-1", "old-2", groups[0]["id"], groups[1]["id"], "old-3", "old-4"])
        self.assertEqual([len(value["images"]) for value in new_entries], [2, 1])
        for entry in new_entries:
            self.assertEqual(entry["path"], list(importer.SOURCE_PATH))
            self.assertEqual(entry["rating"], "safe")
            self.assertNotIn("assetCodexId", entry)
            self.assertFalse(entry.get("negative"))
            self.assertFalse(entry.get("characterPrompts"))
            self.assertEqual(entry["tags"], "artist:" + entry["title"])
            self.assertTrue(all(value["rawTag"] == entry["tags"] for value in entry["images"]))

    def test_payload_validation_rejects_polluted_raw_tag_without_mutating_candidate(self) -> None:
        old = self.old_book()
        old_index = [{key: copy.deepcopy(value) for key, value in old.items() if key != "entries"}]
        groups = importer.group_rows(self.rows(["new", "new"]))
        book, index = importer.compose_payload(old, old_index, groups, self.assets(groups))
        importer.check_payload(book, index, old, old_index, groups)
        new_entry = next(entry for entry in book["entries"] if entry["id"] == groups[0]["id"])
        new_entry["images"][1]["rawTag"] = "artist:new, solo, street"
        before_book, before_index = copy.deepcopy(book), copy.deepcopy(index)
        before_groups = copy.deepcopy(groups)
        with self.assertRaises((ValueError, RuntimeError)):
            importer.check_payload(book, index, old, old_index, groups)
        self.assertEqual(book, before_book)
        self.assertEqual(index, before_index)
        self.assertEqual(groups, before_groups)

    def test_target_collision_refuses_and_unrelated_media_is_untouched(self) -> None:
        groups = importer.group_rows(self.rows(["x", "x"]))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            thumbs, originals = root / "thumbs", root / "originals"
            thumbs.mkdir()
            originals.mkdir()
            unrelated = thumbs / "old.jpg"
            unrelated.write_bytes(b"do not overwrite")
            importer.ensure_targets_absent(groups, thumbs, originals)
            collision = originals / f"{groups[0]['id']}-02.webp"
            collision.write_bytes(b"already here")
            with self.assertRaises((ValueError, RuntimeError, FileExistsError)):
                importer.ensure_targets_absent(groups, thumbs, originals)
            self.assertEqual(collision.read_bytes(), b"already here")
            self.assertEqual(unrelated.read_bytes(), b"do not overwrite")

    def frozen_fixture(self, root: Path) -> dict:
        (root / "images").mkdir()
        (root / "index.json").write_bytes(b"[]")
        (root / "images" / "x.webp").write_bytes(b"source webp fixture")
        digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        return {
            "sidecars": {"index.json": digest(root / "index.json")},
            "images": [{"file": "images/x.webp", "sha256": digest(root / "images/x.webp")}],
        }

    def test_changed_source_or_sidecar_refuses_frozen_plan(self) -> None:
        for relative in ("index.json", "images/x.webp"):
            with self.subTest(file=relative), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                manifest = self.frozen_fixture(root)
                importer.verify_frozen_files(root, manifest)
                (root / relative).write_bytes(b"changed after plan")
                with self.assertRaises((ValueError, RuntimeError)):
                    importer.verify_frozen_files(root, manifest)

    def test_added_or_missing_source_image_refuses_frozen_plan(self) -> None:
        for extra in (False, True):
            with self.subTest(extra=extra), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                manifest = self.frozen_fixture(root)
                if extra:
                    (root / "images/y.webp").write_bytes(b"unexpected image")
                else:
                    (root / "images/x.webp").unlink()
                with self.assertRaises((ValueError, RuntimeError, FileNotFoundError)):
                    importer.verify_frozen_files(root, manifest)

    def test_manifest_cannot_escape_source_root(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "source"
            root.mkdir()
            manifest = self.frozen_fixture(root)
            outside = root.parent / "outside.webp"
            outside.write_bytes(b"not part of source")
            manifest["images"].append({"file": "../outside.webp",
                                       "sha256": hashlib.sha256(outside.read_bytes()).hexdigest()})
            with self.assertRaises((ValueError, RuntimeError)):
                importer.verify_frozen_files(root, manifest)

    def test_real_multi_image_assets_use_current_sync_revision(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            thumbs, originals = root / "thumbs", root / "originals"
            thumbs.mkdir()
            originals.mkdir()
            rows = self.rows(["example", "example"])
            for number, (row, size, color) in enumerate(
                    zip(rows, [(32, 24), (24, 32)], ["red", "blue"]), 1):
                path = root / f"source-{number}.webp"
                Image.new("RGB", size, color).save(path, "WEBP", lossless=True)
                row.update(file=path.name, width=size[0], height=size[1],
                           sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            group = importer.group_rows(rows)[0]
            asset = importer.write_source_asset({
                "entryId": group["id"], "thumbDir": str(thumbs), "originalDir": str(originals),
                "sources": [{"sourcePath": str(root / row["file"]), "sha256": row["sha256"],
                             "imageFields": {"rawTag": group["tags"]}} for row in rows],
            })
            hashes = []
            for image in asset["images"]:
                hashes.extend(hashlib.sha256(path.read_bytes()).hexdigest()
                              for path in [thumbs / image["path"], originals / image["original"]])
            self.assertEqual(asset["assetRev"], rev_from_hashes(hashes))
            entry = {"id": group["id"], "tags": group["tags"],
                     **{key: value for key, value in asset.items() if key != "entryId"}}
            self.assertEqual(importer.validate_group({
                "entry": entry, "group": group, "thumbDir": str(thumbs),
                "originalDir": str(originals),
            }), {"id": group["id"], "images": 2})

    def test_recovery_restores_partial_json_and_media_without_touching_existing_assets(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report = root / "output" / "fixture"
            report.mkdir(parents=True)
            book_path, index_path, thumbs, originals = importer.target_paths(root)
            book_path.parent.mkdir(parents=True)
            thumbs.mkdir(parents=True)
            originals.mkdir(parents=True)
            thumb_stage = thumbs.parent / f".{importer.CODEX_ID}-baolong-thumbs-fixture"
            original_stage = originals.parent / f".{importer.CODEX_ID}-baolong-originals-fixture"
            thumb_stage.mkdir()
            original_stage.mkdir()
            old_book, old_index = b'{"before":"book"}\n', b'[{"before":"index"}]\n'
            new_book, new_index = b'{"after":"book"}\n', b'[{"after":"index"}]\n'
            digest = lambda data: hashlib.sha256(data).hexdigest()
            book_path.write_bytes(new_book)
            index_path.write_bytes(old_index)
            (report / "before-book.json").write_bytes(old_book)
            (report / "before-index.json").write_bytes(old_index)
            (thumbs / "existing.jpg").write_bytes(b"old display stays here")
            (originals / "existing.webp").write_bytes(b"old source stays here")
            source_bytes, thumb_bytes = b"new source", b"new thumbnail"
            rows = [{"artist": "example", "file": "images/example.webp", "sha256": digest(source_bytes)}]
            group = importer.group_rows(rows)[0]
            thumb_name, original_name = importer.member_names(group)[0]
            (thumbs / thumb_name).write_bytes(thumb_bytes)
            (original_stage / original_name).write_bytes(source_bytes)
            state = {
                "status": "replacing_json", "bookSha256": digest(new_book),
                "indexSha256": digest(new_index),
                "staging": {"thumbs": str(thumb_stage), "originals": str(original_stage)},
            }
            manifest = {"images": rows, "oldBookSha256": digest(old_book), "oldIndexSha256": digest(old_index)}
            moves = [
                {"source": str(thumb_stage / thumb_name), "target": str(thumbs / thumb_name),
                 "sha256": digest(thumb_bytes)},
                {"source": str(original_stage / original_name), "target": str(originals / original_name),
                 "sha256": digest(source_bytes)},
            ]
            for name, data in [("transaction.json", state), ("manifest.json", manifest),
                               ("transaction-media.json", moves)]:
                (report / name).write_text(json.dumps(data), encoding="utf-8")
            result = importer.recover_transaction(report, root=root)
            self.assertEqual(result["status"], "rolled_back")
            self.assertEqual(book_path.read_bytes(), old_book)
            self.assertEqual(index_path.read_bytes(), old_index)
            self.assertEqual((thumb_stage / thumb_name).read_bytes(), thumb_bytes)
            self.assertEqual((original_stage / original_name).read_bytes(), source_bytes)
            self.assertFalse((thumbs / thumb_name).exists())
            self.assertFalse((originals / original_name).exists())
            self.assertEqual((thumbs / "existing.jpg").read_bytes(), b"old display stays here")
            self.assertEqual((originals / "existing.webp").read_bytes(), b"old source stays here")


if __name__ == "__main__":
    unittest.main()
