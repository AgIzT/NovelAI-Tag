"""Offline acceptance tests for the opt-in content-addressed publisher prototype."""

import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools.r2_cas_experiment import protocol as p
from tools.r2_cas_experiment.publisher import (
    activate, build_plan, freeze_data, publish, read_release, stable_updates,
)
from tools.r2_cas_experiment.store import SQLiteStore, PreconditionFailed
from tools.r2_cas_experiment.lab import main, run_lab


ROOT = Path(__file__).resolve().parents[1]
TEMP_ROOT = ROOT / "output" / "r2-cas-tests"


class CasExperimentTests(unittest.TestCase):
    def setUp(self):
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=TEMP_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "demo.json").write_bytes(b'{"id":"demo","n":1}\n')
        (self.source / "other.json").write_bytes(b'{"id":"other"}\n')
        self.store = SQLiteStore(self.root / "store")

    def plan(self, label):
        return build_plan(freeze_data(self.source, self.root / label))

    def test_first_publish_and_exact_read(self):
        plan = self.plan("a")
        result = publish(self.store, plan)
        self.assertEqual(result["uploaded"], 2)
        self.assertFalse(result["unchanged"])
        self.assertEqual(read_release(self.store, plan.release, "demo.json"), plan.files["demo.json"])

    def test_single_change_only_writes_one_content_object(self):
        a = self.plan("a")
        publish(self.store, a)
        (self.source / "demo.json").write_bytes(b'{"id":"demo","n":2}\n')
        b = self.plan("b")
        result = publish(self.store, b)
        self.assertEqual((result["uploaded"], result["reused"]), (1, 1))
        self.assertEqual(result["pointer"]["previousRelease"], a.release)
        self.assertEqual(read_release(self.store, a.release, "demo.json"), a.files["demo.json"])

    def test_noop_has_zero_writes_and_preserves_pointer_bytes(self):
        plan = self.plan("a")
        publish(self.store, plan)
        before = self.store.get(p.CURRENT_KEY)
        metrics = dict(self.store.metrics)
        result = publish(self.store, self.plan("b"))
        self.assertTrue(result["unchanged"])
        self.assertEqual(self.store.get(p.CURRENT_KEY), before)
        for name in ("create_attempts", "put_attempts", "bytes_written"):
            self.assertEqual(self.store.metrics[name], metrics[name])

    def test_deduplication_and_independent_snapshots(self):
        (self.source / "alias.json").write_bytes((self.source / "demo.json").read_bytes())
        result = publish(self.store, self.plan("a"))
        self.assertEqual(result["uploaded"], 2)
        self.assertEqual(result["logical_files"], 3)

    def test_rollback_and_repeated_activation_preserve_previous(self):
        a = self.plan("a")
        publish(self.store, a)
        (self.source / "demo.json").write_bytes(b'{"n":2}\n')
        b = self.plan("b")
        publish(self.store, b)
        result = activate(self.store, a.release)
        self.assertEqual(result["pointer"]["previousRelease"], b.release)
        pointer = self.store.get(p.CURRENT_KEY)
        self.assertTrue(activate(self.store, a.release)["unchanged"])
        self.assertEqual(self.store.get(p.CURRENT_KEY), pointer)

    def test_failure_does_not_activate_and_retry_reuses_objects(self):
        plan = self.plan("a")
        original = self.store.create
        count = 0

        def fail_second(key, body, metadata):
            nonlocal count
            if key.startswith(p.OBJECT_PREFIX):
                count += 1
                if count == 2:
                    raise OSError("injected before content write")
            return original(key, body, metadata)

        with patch.object(self.store, "create", fail_second):
            with self.assertRaises(OSError):
                publish(self.store, plan)
        self.assertIsNone(self.store.get(p.CURRENT_KEY))
        result = publish(self.store, plan)
        self.assertEqual((result["uploaded"], result["reused"]), (1, 1))

    def test_ambiguous_pointer_write_is_not_retried(self):
        plan = self.plan("a")
        original = self.store.put
        calls = []

        def written_but_lost(key, body, metadata, expected_etag):
            calls.append(key)
            original(key, body, metadata, expected_etag)
            raise OSError("injected response loss")

        with patch.object(self.store, "put", written_but_lost):
            with self.assertRaisesRegex(RuntimeError, "outcome unknown"):
                publish(self.store, plan)
        self.assertEqual(calls, [p.CURRENT_KEY])
        self.assertEqual(json.loads(self.store.get(p.CURRENT_KEY).body)["release"], plan.release)

    def test_shared_object_conflict_never_overwrites(self):
        plan = self.plan("a")
        key = p.object_key(plan.manifest["files"]["demo.json"]["sha256"])
        original = self.store.create(key, b"corrupt", {})
        with self.assertRaisesRegex(ValueError, "object"):
            publish(self.store, plan)
        self.assertEqual(self.store.get(key), original)
        self.assertIsNone(self.store.get(p.CURRENT_KEY))

    def test_pointer_conflict_does_not_overwrite_newer_decision(self):
        a = self.plan("a")
        publish(self.store, a)
        (self.source / "demo.json").write_bytes(b'{"n":2}\n')
        b = self.plan("b")
        original = self.store.put
        winner = None

        def other_decision(key, body, metadata, expected_etag):
            nonlocal winner
            value = json.loads(self.store.get(key).body)
            value["operationId"] = "a" * 32
            winner = p.json_bytes(value)
            original(key, winner, metadata, expected_etag)
            return original(key, body, metadata, expected_etag)

        with patch.object(self.store, "put", other_decision):
            with self.assertRaises(PreconditionFailed):
                publish(self.store, b)
        self.assertEqual(self.store.get(p.CURRENT_KEY).body, winner)

    def test_frozen_bytes_survive_source_edits(self):
        frozen = freeze_data(self.source, self.root / "snapshot")
        before = (frozen / "demo.json").read_bytes()
        (self.source / "demo.json").write_bytes(b'{"n":3}\n')
        self.assertEqual(build_plan(frozen).files["demo.json"], before)

    def test_nested_snapshot_and_existing_target_are_rejected(self):
        with self.assertRaises(ValueError):
            freeze_data(self.source, self.source / "nested")
        with self.assertRaises(ValueError):
            freeze_data(self.source, self.source)

    def test_freeze_detects_mutation_during_copy(self):
        original = Path.read_bytes
        touched = False

        def mutate_after_read(path):
            nonlocal touched
            body = original(path)
            if path == self.source / "demo.json" and not touched:
                touched = True
                path.write_bytes(b'{"n":987}\n')
            return body

        with patch.object(Path, "read_bytes", mutate_after_read):
            with self.assertRaisesRegex(ValueError, "changed"):
                freeze_data(self.source, self.root / "unstable")

    def test_manifest_digest_and_strict_paths(self):
        manifest = self.plan("a").manifest
        self.assertEqual(p.validate_manifest(manifest), manifest)
        for bad in ("../demo.json", "/demo.json", "x\\demo.json", "x%2fdemo.json", "x.json?y", "x.json/../y.json"):
            with self.subTest(path=bad), self.assertRaises(ValueError):
                p.make_manifest({bad: {"sha256": "a" * 64, "size": 1}})
        broken = copy.deepcopy(manifest)
        broken["files"]["demo.json"]["size"] += 1
        with self.assertRaises(ValueError):
            p.validate_manifest(broken)

    def test_existing_dotted_json_basename_is_supported(self):
        value = p.make_manifest({"tutorials/composition.draft.json": {"sha256": "a" * 64, "size": 2}})
        self.assertIn("tutorials/composition.draft.json", value["files"])

    def test_shared_digest_cannot_declare_different_sizes(self):
        digest = p.sha256(b"{}\n")
        with self.assertRaises(ValueError):
            p.make_manifest({"a.json": {"sha256": digest, "size": 3},
                             "b.json": {"sha256": digest, "size": 4}})

    def test_manifest_rejects_booleans_unknown_fields_and_duplicates(self):
        for size in (True, False, 0, -1, 2**53):
            with self.subTest(size=size), self.assertRaises(ValueError):
                p.make_manifest({"demo.json": {"sha256": "a" * 64, "size": size}})
        manifest = self.plan("a").manifest
        manifest["unexpected"] = 1
        with self.assertRaises(ValueError):
            p.validate_manifest(manifest)
        with self.assertRaises(ValueError):
            p.parse_json(b'{"schemaVersion":2,"schemaVersion":1}')

    def test_stable_update_timestamp_only_when_content_is_identical(self):
        previous = b'{"generatedAt":"old","batches":[1]}\n'
        candidate = {"generatedAt": "new", "batches": [1]}
        self.assertEqual(stable_updates(candidate, previous), previous)
        candidate["batches"] = [2]
        self.assertNotEqual(stable_updates(candidate, previous), previous)

    def test_no_production_client_or_network_is_constructed(self):
        with patch("socket.socket", side_effect=AssertionError("network forbidden")), \
             patch("tools.sync_r2.load_config", side_effect=AssertionError("production config forbidden")):
            plan = self.plan("a")
            publish(self.store, plan)
            activate(self.store, plan.release)

    def test_lost_content_response_is_resolved_by_actual_bytes(self):
        plan = self.plan("a")
        original = self.store.create
        triggered = False

        def response_lost(key, body, metadata):
            nonlocal triggered
            result = original(key, body, metadata)
            if key.startswith(p.OBJECT_PREFIX) and not triggered:
                triggered = True
                raise OSError("written but response lost")
            return result

        with patch.object(self.store, "create", response_lost):
            result = publish(self.store, plan)
        self.assertEqual(result["pointer"]["release"], plan.release)
        self.assertEqual(read_release(self.store, plan.release, "demo.json"), plan.files["demo.json"])

    def test_snapshot_change_after_freeze_is_rejected(self):
        frozen = freeze_data(self.source, self.root / "a")
        (frozen / "demo.json").write_bytes(b'{"changed":true}\n')
        with self.assertRaisesRegex(ValueError, "changed"):
            build_plan(frozen)

    def test_missing_reused_object_blocks_activation(self):
        plan = self.plan("a")
        publish(self.store, plan)
        pointer = self.store.get(p.CURRENT_KEY)
        key = p.object_key(plan.manifest["files"]["demo.json"]["sha256"])
        original = self.store.get
        with patch.object(self.store, "get", lambda item: None if item == key else original(item)):
            with self.assertRaisesRegex(ValueError, "missing"):
                activate(self.store, plan.release)
        self.assertEqual(self.store.get(p.CURRENT_KEY), pointer)

    def test_noop_detects_interleaved_pointer_decision(self):
        from tools.r2_cas_experiment import publisher
        plan = self.plan("a")
        publish(self.store, plan)
        original = publisher.verify_release

        def interleave(store, release):
            result = original(store, release)
            record = store.get(p.CURRENT_KEY)
            changed = p.parse_json(record.body)
            changed["operationId"] = "b" * 32
            store.put(p.CURRENT_KEY, p.json_bytes(changed), record.metadata, record.etag)
            return result

        with patch.object(publisher, "verify_release", interleave):
            with self.assertRaises(PreconditionFailed):
                publish(self.store, plan)

    def test_lab_compares_same_bytes_and_never_writes_on_noop(self):
        report = run_lab(self.root / "lab")
        self.assertEqual(report["status"], "PASS")
        self.assertEqual(report["changed_paths"], ["about.json"])
        first, noop, changed = report["scenarios"]
        self.assertEqual(noop["v2"]["bytes_written"], 0)
        self.assertEqual(changed["v2"]["result"]["uploaded"], 1)
        self.assertGreater(changed["v1"]["result"]["copied"], 0)
        self.assertEqual(changed["v2"]["result"]["copied"], 0)

    def test_cli_rejects_production_flags_and_configuration_sources(self):
        with self.assertRaises(SystemExit):
            main(["--output-dir", str(self.root / "unused"), "--publish"])
        with self.assertRaises(ValueError):
            freeze_data(ROOT, self.root / "forbidden-source")
        self.assertFalse((self.root / "forbidden-source").exists())

    def test_canonical_manifest_matches_raw_boundary(self):
        manifest = self.plan("a").manifest
        raw = p.json_bytes(manifest)
        self.assertEqual(p.parse_manifest_bytes(raw), manifest)
        for body in (b" " + raw, raw.rstrip(), raw.replace(b'"schemaVersion":2', b'"schemaVersion":2.0')):
            with self.assertRaises(ValueError):
                p.parse_manifest_bytes(body)


if __name__ == "__main__":
    unittest.main()
