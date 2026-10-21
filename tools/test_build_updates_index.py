"""更新批次和书内样张的自动抽样、解锁标记与索引门控回归。"""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from datetime import datetime, timezone
from unittest.mock import patch

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

    def test_r18g_paths_are_excluded_from_every_sample_route(self):
        entries = [
            entry("safe", rating="safe"),
            entry("old-r18g", path=["r18g/重口", "分类"]),
            entry("safe-rated-r18g", rating="safe", path=["Examples", "R18G"]),
            entry("heavy", rating="safe", path=["Examples", "重口"]),
            entry("rated-r18g", rating="r18g"),
        ]
        pinned = [item["image"] for item in entries[1:]] + ["safe.webp"]
        for nsfw in (False, True):
            meta = {"nsfw": nsfw}
            for choose in (
                lambda: bui.pick_samples(meta, entries),
                lambda: bui.pick_samples(meta, entries, pinned),
                lambda: bui.pick_previews(meta, entries),
                lambda: bui.pick_previews({**meta, "previews": pinned}, entries),
            ):
                with self.subTest(nsfw=nsfw, choose=choose):
                    samples, _ = choose()
                    self.assertEqual([sample["id"] for sample in samples], ["safe"])
                    self.assertEqual(samples[0].get("nsfw", False), nsfw)

    def test_r18g_only_pins_fall_back_without_reintroducing_r18g(self):
        entries = [entry("r18g", path=["重口"]), entry("ordinary", rating="r18")]
        samples, notes = bui.pick_samples({"nsfw": True}, entries, ["r18g.webp"])
        self.assertEqual(samples, [{"id": "ordinary", "image": "ordinary.webp", "nsfw": True}])
        self.assertEqual(len(notes), 2)
        previews, notes = bui.pick_previews({"nsfw": True, "previews": ["r18g.webp"]}, entries)
        self.assertEqual(previews, samples)
        self.assertEqual(len(notes), 2)

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



class UpdateContentStabilityTest(unittest.TestCase):
    old_time = "2026-10-01T01:02:03Z"
    new_time = "2026-10-20T04:05:06Z"

    def seed(self, root):
        (root / "codexes.json").write_text(json.dumps([{
            "id": "book", "title": "Fixture 图鉴", "cover": "cover.webp",
            "updateFilters": [{"id": "2026.10.9", "label": "10.9", "latest": True}],
        }]), encoding="utf-8")
        (root / "book.json").write_text(json.dumps({"entries": [
            entry("cover"), entry("new", isNew=True), entry("preview"),
        ]}), encoding="utf-8")
        payload, _ = bui.build(root)
        payload["generatedAt"] = self.old_time
        return payload

    def run_main(self, root, *args):
        with patch.object(sys, "argv", ["build_updates_index.py", "--data-dir", str(root), *map(str, args)]):
            with patch.object(bui, "datetime") as clock, contextlib.redirect_stdout(io.StringIO()) as stdout:
                clock.now.return_value = datetime(2026, 10, 20, 4, 5, 6, tzinfo=timezone.utc)
                self.assertEqual(bui.main(), 0)
        return stdout.getvalue()

    def test_unchanged_content_preserves_old_time_raw_bytes_and_never_writes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            payload = self.seed(root)
            output = root / "updates.json"
            # Existing whitespace, Unicode escaping and field order are not a content change.
            original = (json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\r\n").encode("utf-8")
            output.write_bytes(original)
            original_mtime = output.stat().st_mtime_ns
            rebuilt, _ = bui.build(root)
            self.assertEqual(rebuilt["generatedAt"], self.old_time)
            with patch.object(Path, "write_text", side_effect=AssertionError("unchanged output must not be rewritten")):
                self.run_main(root)
            self.assertEqual(output.read_bytes(), original)
            self.assertEqual(output.stat().st_mtime_ns, original_mtime)

    def test_content_or_schema_changes_update_timestamp_and_write_new_payload(self):
        for key in ("schema", "batches", "previews"):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                payload = self.seed(root)
                changed = {"schema": 99, "batches": [], "previews": {}}
                old = {**payload, key: changed[key]}
                output = root / "updates.json"
                output.write_text(json.dumps(old), encoding="utf-8")
                self.run_main(root)
                actual = json.loads(output.read_text(encoding="utf-8"))
                self.assertEqual(actual["generatedAt"], self.new_time)
                self.assertEqual({field: actual[field] for field in ("schema", "batches", "previews")},
                                 {field: payload[field] for field in ("schema", "batches", "previews")})

    def test_custom_output_compares_its_own_previous_content(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            payload = self.seed(root)
            # Default output differs; --output must only use its explicitly selected file.
            (root / "updates.json").write_text(json.dumps({**payload, "batches": []}), encoding="utf-8")
            output = root / "custom" / "updates.json"
            output.parent.mkdir()
            original = (json.dumps(payload, indent=4) + "\n").encode("utf-8")
            output.write_bytes(original)
            with patch.object(Path, "write_text", side_effect=AssertionError("unchanged custom output must not be rewritten")):
                self.run_main(root, "--output", output)
            self.assertEqual(output.read_bytes(), original)

    def test_missing_corrupt_or_invalid_previous_output_is_rebuilt(self):
        for raw in (None, b"invalid json", b"[]", b"null"):
            with self.subTest(raw=raw), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                self.seed(root)
                output = root / "updates.json"
                if raw is not None:
                    output.write_bytes(raw)
                self.run_main(root)
                self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["generatedAt"], self.new_time)
        for timestamp in (None, "", 0, "invalid", "2026-02-30T01:02:03Z", "2026-10-20T24:00:00Z"):
            with self.subTest(timestamp=timestamp), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                payload = self.seed(root)
                payload["generatedAt"] = timestamp
                output = root / "updates.json"
                output.write_text(json.dumps(payload), encoding="utf-8")
                self.run_main(root)
                self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["generatedAt"], self.new_time)

    def test_non_index_input_edits_still_keep_existing_index_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            payload = self.seed(root)
            output = root / "updates.json"
            original = (json.dumps(payload) + "\n").encode("utf-8")
            output.write_bytes(original)
            book_path = root / "book.json"
            book = json.loads(book_path.read_text(encoding="utf-8"))
            book["entries"][0]["tags"] = "changed prompt without index effect"
            book_path.write_text(json.dumps(book), encoding="utf-8")
            with patch.object(Path, "write_text", side_effect=AssertionError("unrelated input edits must not rewrite the index")):
                self.run_main(root)
            self.assertEqual(output.read_bytes(), original)

    def test_json_boolean_is_not_equal_to_numeric_schema(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            payload = self.seed(root)
            output = root / "updates.json"
            output.write_text(json.dumps({**payload, "schema": True}), encoding="utf-8")
            self.run_main(root)
            actual = json.loads(output.read_text(encoding="utf-8"))
            self.assertIs(type(actual["schema"]), int)
            self.assertEqual(actual["generatedAt"], self.new_time)
    def test_dry_run_preserves_existing_bytes_and_does_not_create_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            payload = self.seed(root)
            output = root / "updates.json"
            original = (json.dumps(payload) + "\n").encode("utf-8")
            output.write_bytes(original)
            self.run_main(root, "--dry-run")
            self.assertEqual(output.read_bytes(), original)
            alternate = root / "absent.json"
            self.run_main(root, "--dry-run", "--output", alternate)
            self.assertFalse(alternate.exists())
if __name__ == "__main__":
    unittest.main()
