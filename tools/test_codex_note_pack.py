# -*- coding: utf-8 -*-
"""Unit tests for tools/codex_note_pack.py and tools/build_opening_slices.py."""

import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

from tools.codex_note_pack import (
    expand_codex_notes,
    pack_codex_notes,
    process_data_dir,
    resolve_entry_note,
)
from tools.build_opening_slices import (
    OPENING_SCHEMA,
    build_all,
    build_opening_slice,
)
from tools.build_share_index import entry_description


def _make_sample_codex():
    entries = []
    # 12 exact-duplicate notes (MayRain style)
    mayrain_note = "单画师例图；复制仅含画师标签。完整生成提示词、负面、角色与参数保留在原图中。模型：NovelAI V5 Full。"
    for i in range(12):
        entries.append({
            "id": f"demo_mr_{i:04d}",
            "title": f"mr_{i}",
            "tags": f"artist:mr_{i}",
            "path": ["单画师词典", "MayRain"],
            "rating": "safe",
            "image": f"mr_{i}.jpg",
            "imageWidth": 700,
            "imageHeight": 1000,
            "note": mayrain_note,
        })
    # 20 parameterized notes (nax.moe style: same long boilerplate, varying artist line)
    for i in range(20):
        entries.append({
            "id": f"demo_nax_{i:04d}",
            "title": f"nax_{i}",
            "tags": f"artist:nax_{i}",
            "path": ["单画师词典", "nax.moe(无原图)"],
            "rating": "safe",
            "image": f"nax_{i}.jpg",
            "imageWidth": 700,
            "imageHeight": 1000,
            "note": (
                "nax.moe（u/Carlyone）· Artist Tags - Loose Prompt；许可 CC BY 4.0。无原图。\n"
                "模型 NovelAI V5 Full。28步 / CFG 4 / 质量词开 / 负面预设 Heavy。所有画师同一种子 2138582679。\n"
                "复制仅保留画师词。完整提示词：\n"
                f"artist:nax_{i}, cowboy shot, -2::panties, huge breasts::\n"
                "角色 1：girl, facing viewer, fully clothed\n"
                "来源：https://nax.moe/?gallery=danbooru-artist-tags-2-v5"
            ),
        })
    # 20 parameterized notes (AgIzT style: varying seeds + artist twice)
    for i in range(20):
        entries.append({
            "id": f"demo_ag_{i:04d}",
            "title": f"ag_{i}",
            "tags": f"artist:ag_{i}",
            "path": ["单画师词典", "AgIzT"],
            "rating": "safe",
            "image": f"ag_{i}.jpg",
            "imageWidth": 700,
            "imageHeight": 1000,
            "note": (
                "AgIzT · 单画师横竖例图；模型 NovelAI V5 Full。未加年份词。28步 / CFG 6。\n"
                f"portrait（seed {1000000000 + i}）：\n"
                "1girl, solo,\n"
                f"artist:ag_{i},\n"
                "very aesthetic, amazing quality, no text\n"
                f"landscape（seed {2000000000 + i}）：\n"
                "1girl, solo,\n"
                f"artist:ag_{i},\n"
                "0.75::wide shot::, amazing quality, no text"
            ),
        })
    # 1 unique note + 1 entry without note
    entries.append({
        "id": "demo_unique_1",
        "title": "unique",
        "tags": "",
        "path": ["其他"],
        "rating": "safe",
        "image": "u1.jpg",
        "imageWidth": 700,
        "imageHeight": 1000,
        "note": "这是一条完全独一无二的手写备注。",
    })
    entries.append({
        "id": "demo_nsfw_1",
        "title": "nsfw_item",
        "tags": "nsfw_tag",
        "path": ["NSFW"],
        "rating": "r18",
        "image": "nsfw1.jpg",
        "imageWidth": 700,
        "imageHeight": 1000,
    })
    return {"id": "demo", "title": "Demo Codex", "entries": entries}


class CodexNotePackTest(unittest.TestCase):
    def test_lossless_pack_idempotent_and_unpack(self):
        orig = _make_sample_codex()
        packed, stats = pack_codex_notes(orig)
        self.assertGreater(stats["savedBytes"], 4096)
        self.assertEqual(stats["packed"], 52)
        self.assertEqual(stats["templates"], 3)
        self.assertIn("noteTemplates", packed)

        # Every entry expands back to the exact original string.
        templates = packed["noteTemplates"]
        for raw_e, pk_e in zip(orig["entries"], packed["entries"]):
            self.assertEqual(resolve_entry_note(pk_e.get("note"), templates), raw_e.get("note", ""))

        # Packing an already-packed codex is strictly idempotent.
        repacked, _ = pack_codex_notes(packed)
        self.assertEqual(
            json.dumps(packed, ensure_ascii=False, separators=(",", ":")),
            json.dumps(repacked, ensure_ascii=False, separators=(",", ":")),
        )

        # Unpacking restores exact original structure without noteTemplates.
        expanded, changed = expand_codex_notes(packed)
        self.assertEqual(changed, 52)
        self.assertNotIn("noteTemplates", expanded)
        self.assertEqual(expanded["entries"], orig["entries"])

        # Share index description resolves packed notes cleanly.
        packed_mr_no_tags = dict(packed["entries"][0], tags="")
        self.assertIn("NovelAI V5 Full", entry_description(packed_mr_no_tags, templates))

    def test_mixed_hand_edited_string_and_packed_notes(self):
        orig = _make_sample_codex()
        packed, _ = pack_codex_notes(orig)
        # Simulate local edit_server overwriting one entry's note with a plain string.
        packed["entries"][0]["note"] = "手动修改后的备注"
        self.assertEqual(resolve_entry_note(packed["entries"][0]["note"], packed["noteTemplates"]), "手动修改后的备注")
        repacked, _ = pack_codex_notes(packed)
        self.assertEqual(resolve_entry_note(repacked["entries"][0]["note"], repacked["noteTemplates"]), "手动修改后的备注")

    def test_process_data_dir_pack_and_unpack(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            codex = _make_sample_codex()
            (root / "codexes.json").write_text(json.dumps([{"id": "demo", "title": "Demo"}]), encoding="utf-8")
            (root / "demo.json").write_text(json.dumps(codex, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            orig_size = (root / "demo.json").stat().st_size

            # Dry-run does not modify file.
            plan = process_data_dir(root, apply=False)
            self.assertEqual(len(plan), 1)
            self.assertFalse(plan[0]["wrote"])
            self.assertEqual((root / "demo.json").stat().st_size, orig_size)

            # Apply shrinks file.
            applied = process_data_dir(root, apply=True)
            self.assertTrue(applied[0]["wrote"])
            self.assertLess((root / "demo.json").stat().st_size, orig_size)

            # Unpack restores exact entries.
            unpacked = process_data_dir(root, apply=True, unpack=True)
            self.assertTrue(unpacked[0]["wrote"])
            restored = json.loads((root / "demo.json").read_text(encoding="utf-8"))
            self.assertEqual(restored["entries"], codex["entries"])


class OpeningSliceTest(unittest.TestCase):
    def test_build_opening_slice_and_access_views(self):
        orig = _make_sample_codex()
        packed, _ = pack_codex_notes(orig)
        sl = build_opening_slice(packed, limit=15, base_date=dt.date(2026, 11, 21))
        self.assertEqual(sl["openingSchema"], OPENING_SCHEMA)
        self.assertEqual(len(sl["entries"]), 15)
        self.assertEqual(sl["entryCount"], len(orig["entries"]))
        # Notes in opening slice are expanded to plain strings.
        self.assertIsInstance(sl["entries"][0]["note"], str)
        self.assertIn("NovelAI V5 Full", sl["entries"][0]["note"])
        # Safe tier hides the 1 NSFW entry; NSFW tier includes it.
        self.assertEqual(sl["openingAccessView"]["safe"]["hiddenCount"], 1)
        self.assertEqual(sl["openingAccessView"]["safe"]["visibleCount"], len(orig["entries"]) - 1)
        self.assertEqual(sl["openingAccessView"]["nsfw"]["hiddenCount"], 0)
        self.assertEqual(sl["openingAccessView"]["nsfw"]["visibleCount"], len(orig["entries"]))

    def test_build_all_cleans_stale_opening_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            codex = _make_sample_codex()
            (root / "codexes.json").write_text(json.dumps([{"id": "demo", "title": "Demo"}]), encoding="utf-8")
            (root / "demo.json").write_text(json.dumps(codex, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            stale = root / "opening" / "removed.json"
            stale.parent.mkdir(parents=True, exist_ok=True)
            stale.write_text("{}", encoding="utf-8")

            rows = build_all(root, write=True, min_bytes=100, limit=10)
            self.assertEqual(len(rows), 1)
            self.assertTrue((root / "opening" / "demo.json").is_file())
            self.assertFalse(stale.exists())


if __name__ == "__main__":
    unittest.main()
