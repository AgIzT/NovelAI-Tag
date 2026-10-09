"""更新批次和书内样张的自动抽样、解锁标记与索引门控回归。"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_updates_index as bui  # noqa: E402


def entry(eid, **fields):
    return {"id": eid, "image": f"{eid}.webp", "path": ["Examples"], **fields}


class UpdateSamplesTest(unittest.TestCase):
    def test_adult_book_auto_samples_are_gated_and_keep_asset_identity(self):
        entries = [
            entry("plain", assetRev="rev-a", assetCodexId="source"),
            entry("safe", rating="safe"),
            entry("adult", level="R18"),
            entry("excluded", rating="r18g"),
            entry("no-image", image=""),
        ]
        samples, notes = bui.pick_samples({"nsfw": True}, entries)
        self.assertEqual([sample["id"] for sample in samples], ["plain", "safe", "adult"])
        self.assertTrue(all(sample.get("nsfw") is True for sample in samples))
        self.assertEqual(samples[0]["assetRev"], "rev-a")
        self.assertEqual(samples[0]["assetCodexId"], "source")
        self.assertEqual(notes, [])

    def test_public_book_auto_samples_only_include_public_entries(self):
        entries = [
            entry("plain"), entry("safe", rating="safe"),
            entry("adult", rating="nsfw"), entry("restricted", level="restricted"),
            entry("directory", path=["Examples", "NSFW"]),
            entry("excluded", rating="r18g"), entry("no-image", image=""),
        ]
        samples, _ = bui.pick_samples({}, entries)
        self.assertEqual([sample["id"] for sample in samples], ["plain", "safe"])
        self.assertTrue(all("nsfw" not in sample for sample in samples))

    def test_auto_samples_are_bounded_ordered_and_repeatable(self):
        entries = [entry(str(index)) for index in range(12)]
        first, _ = bui.pick_samples({"nsfw": True}, entries)
        second, _ = bui.pick_samples({"nsfw": True}, entries)
        self.assertEqual(first, second)
        self.assertEqual(len(first), 4)
        positions = [int(sample["id"]) for sample in first]
        self.assertEqual(positions, sorted(set(positions)))
        self.assertLess(positions[0], 4)
        self.assertGreater(positions[-1], 7)

    def test_pinned_samples_keep_order_and_gate_adult_entries(self):
        entries = [entry("safe"), entry("adult", rating="r18"), entry("excluded", rating="r18g")]
        samples, notes = bui.pick_samples({}, entries, ["adult.webp", "excluded.webp", "safe.webp"])
        self.assertEqual([sample["id"] for sample in samples], ["adult", "safe"])
        self.assertIs(samples[0].get("nsfw"), True)
        self.assertNotIn("nsfw", samples[1])
        self.assertEqual(len(notes), 1)

    def test_invalid_pins_fall_back_to_adult_auto_samples(self):
        entries = [entry("adult", rating="nsfw"), entry("excluded", rating="r18g")]
        samples, notes = bui.pick_samples({"nsfw": True}, entries, ["missing.webp", "excluded.webp"])
        self.assertEqual(samples, [{"id": "adult", "image": "adult.webp", "nsfw": True}])
        self.assertEqual(len(notes), 2)

    def test_previews_and_updates_share_eligibility_and_gating(self):
        entries = [entry("cover"), entry("a"), entry("b", rating="r18"), entry("c"), entry("excluded", rating="r18g")]
        meta = {"nsfw": True, "cover": "cover.webp"}
        previews, _ = bui.pick_previews(meta, entries)
        samples, _ = bui.pick_samples(meta, entries[1:])
        self.assertEqual(previews, samples)
        self.assertEqual(len(previews), 3)

    def test_build_keeps_adult_counts_hidden_but_generates_gated_samples(self):
        meta = {"id": "book", "nsfw": True, "updateFilters": [{"id": "2026.10.9", "label": "10.9", "latest": True}]}
        entries = [entry("adult", rating="nsfw", updateBatches=["2026.10.9"]), entry("excluded", rating="r18g", isNew=True)]
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            (data_dir / "codexes.json").write_text(json.dumps([meta]), encoding="utf-8")
            (data_dir / "book.json").write_text(json.dumps({"entries": entries}), encoding="utf-8")
            payload, notes = bui.build(data_dir)
        record = payload["batches"][0]["books"][0]
        self.assertEqual(record["count"], 2)
        self.assertEqual(record["safeCount"], 0)
        self.assertEqual(record["safeDirs"], [])
        self.assertEqual(record["samples"], [{"id": "adult", "image": "adult.webp", "nsfw": True}])
        self.assertEqual(notes, [])


if __name__ == "__main__":
    unittest.main()
