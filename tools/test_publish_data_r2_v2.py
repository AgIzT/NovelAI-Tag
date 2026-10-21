"""Production publisher v2/dual paths, with local SQLite and synthetic data only."""
import contextlib
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

from tools import publish_data_r2 as pub
from tools import r2_data_protocol as cas
from tools.r2_local_client import LocalDataClient
from tools.test_publish_data_r2 import make_data

ROOT = Path(__file__).resolve().parents[1]


class V2PublishTests(unittest.TestCase):
    def setUp(self):
        parent = ROOT / "output" / "v2-tests"
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / "data"
        make_data(self.data)
        self.client = LocalDataClient(self.root / "store")

    def v2(self):
        return pub.build_v2_release_plan(self.data)

    def test_first_increment_noop_and_historical_activation(self):
        a = self.v2()
        first = pub.publish_v2_release(self.client, a)
        self.assertEqual(first["uploaded"], len({f.sha256 for f in a.files}))
        before = dict(self.client.store.metrics)
        pointer = self.client.get_bytes(cas.CURRENT_KEY)
        again = pub.publish_v2_release(self.client, a)
        self.assertTrue(again["unchanged"])
        self.assertEqual(self.client.store.metrics["bytes_written"], before["bytes_written"])
        self.assertEqual(self.client.get_bytes(cas.CURRENT_KEY), pointer)
        (self.data / "about.json").write_text('{"changed":true}', encoding="utf-8")
        b = self.v2()
        result = pub.publish_v2_release(self.client, b)
        self.assertEqual(result["uploaded"], 1)
        self.assertEqual(result["pointer"]["previousRelease"], a.release)
        rolled = pub.activate_v2_release(self.client, "data", a.release)
        self.assertEqual(rolled["pointer"]["previousRelease"], b.release)

    def test_dual_prepares_both_before_any_pointer_write(self):
        a, b = pub.build_release_plan(self.data), self.v2()
        result = pub.publish_dual_release(self.client, a, b)
        self.assertEqual(result["v1"]["pointer"]["release"], a.release)
        self.assertEqual(result["v2"]["pointer"]["release"], b.release)
        pointer_ops = [index for index, (kind, _key) in enumerate(self.client.operations) if kind == "pointer"]
        object_ops = [index for index, (kind, _key) in enumerate(self.client.operations) if kind in ("file", "bytes", "create", "copy")]
        self.assertGreater(min(pointer_ops), max(object_ops))

    def test_dual_preparation_failure_keeps_both_pointers(self):
        a, b = pub.build_release_plan(self.data), self.v2()
        original = self.client.create_bytes
        def fail(key, *args):
            if "/v2/releases/" in key:
                raise RuntimeError("injected manifest failure")
            return original(key, *args)
        with patch.object(self.client, "create_bytes", fail):
            with self.assertRaises(RuntimeError):
                pub.publish_dual_release(self.client, a, b)
        self.assertIsNone(self.client.get_bytes("data/current.json"))
        self.assertIsNone(self.client.get_bytes(cas.CURRENT_KEY))

    def test_shared_key_conflict_never_overwrites(self):
        plan = self.v2()
        item = plan.files[0]
        key = cas.object_key(item.sha256)
        self.client.store.create(key, b"bad", {})
        with self.assertRaises(RuntimeError):
            pub.publish_v2_release(self.client, plan)
        self.assertEqual(self.client.get_bytes(key), b"bad")
        self.assertIsNone(self.client.get_bytes(cas.CURRENT_KEY))

    def test_conditional_create_lost_response_is_resolved(self):
        plan = self.v2()
        original = self.client.create_bytes
        lost = False
        def response_lost(key, *args):
            nonlocal lost
            value = original(key, *args)
            if not lost:
                lost = True
                raise OSError("response lost after conditional commit")
            return value
        with patch.object(self.client, "create_bytes", response_lost):
            self.assertEqual(pub.publish_v2_release(self.client, plan)["pointer"]["release"], plan.release)

    def test_custom_prefix_and_cli_local_mode_never_load_remote_configuration(self):
        with patch.object(pub, "load_config", side_effect=AssertionError("no production config")), \
             patch.object(socket, "socket", side_effect=AssertionError("no network")), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(pub.main(["--format", "dual", "--data-dir", str(self.data),
                                       "--local-store", str(self.root / "cli-store"), "--publish"]), 0)
        plan = self.v2()
        pub.publish_v2_release(self.client, plan, data_prefix="custom/data")
        self.assertIsNotNone(self.client.get_bytes("custom/data/v2/current.json"))
        self.assertIsNone(self.client.get_bytes("data/v2/current.json"))

    def test_snapshot_is_frozen_and_source_untouched(self):
        original = (self.data / "demo.json").read_bytes()
        with pub.frozen_data_directory(self.data) as frozen:
            plan = pub.build_v2_release_plan(frozen)
            (self.data / "demo.json").write_bytes(b'{"id":"demo","entries":[1]}')
            pub.publish_v2_release(self.client, plan)
            self.assertEqual((frozen / "demo.json").read_bytes(), original)

    def test_public_v2_check_uses_separate_manifest_path(self):
        plan = self.v2()
        class Response:
            headers = {"Access-Control-Allow-Origin": "https://site.invalid"}
            def __enter__(self): return self
            def __exit__(self, *_args): pass
            def read(self): return plan.manifest_bytes
        with patch.object(pub.urllib.request, "urlopen", return_value=Response()) as request:
            pub.check_public_release("https://assets.invalid/data", "https://site.invalid", "data", plan)
        self.assertIn("/data/v2/releases/" + plan.release + "/manifest.json", request.call_args.args[0].full_url)

    def test_publisher_protocol_rejects_files_larger_than_all_readers_support(self):
        files = {"codexes.json": {"sha256": "a" * 64, "size": 32 * 1024 * 1024}}
        self.assertEqual(cas.make_manifest(files)["files"], files)
        files["codexes.json"]["size"] += 1
        with self.assertRaisesRegex(ValueError, "size"):
            cas.make_manifest(files)

    def test_root_manifest_name_is_reserved_by_release_reader(self):
        (self.data / "manifest.json").write_text('{"logical":true}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "path"):
            self.v2()
        self.assertEqual(self.client.operations, [])
        self.assertEqual(cas.valid_path("tag_zh/manifest.json"), "tag_zh/manifest.json")

    def change(self, value):
        (self.data / "about.json").write_text(json.dumps({"change": value}), encoding="utf-8")
        return self.v2()

    def test_concurrent_activation_and_aba_cannot_be_overwritten(self):
        a = self.v2()
        pub.publish_v2_release(self.client, a)
        b = self.change("b")
        pub.publish_v2_release(self.client, b)
        pub.activate_v2_release(self.client, "data", a.release)
        c = self.change("c")
        def concurrent(_plan):
            pub.activate_v2_release(self.client, "data", b.release)
            pub.activate_v2_release(self.client, "data", a.release)
        with self.assertRaisesRegex(RuntimeError, "conflict"):
            pub.publish_v2_release(self.client, c, public_check=concurrent)
        self.assertEqual(self.client.get_json(cas.CURRENT_KEY)["release"], a.release)
        with self.assertRaisesRegex(RuntimeError, "conflict"):
            pub.publish_v2_release(self.client, a, public_check=concurrent)

    def test_pointer_lost_response_is_never_blindly_retried(self):
        plan = self.v2()
        original = self.client.put_pointer
        calls = []
        def commit_then_lose(*args):
            calls.append(args[0])
            original(*args)
            raise RuntimeError("pointer outcome unknown")
        with patch.object(self.client, "put_pointer", commit_then_lose):
            with self.assertRaisesRegex(RuntimeError, "outcome unknown"):
                pub.publish_v2_release(self.client, plan)
        self.assertEqual(calls, [cas.CURRENT_KEY])
        self.assertEqual(self.client.get_json(cas.CURRENT_KEY)["release"], plan.release)

    def test_dual_second_decision_failure_reports_partial_state_without_rollback(self):
        old_v1, old_v2 = pub.build_release_plan(self.data), self.v2()
        pub.publish_dual_release(self.client, old_v1, old_v2)
        new_v2 = self.change("new dual")
        new_v1 = pub.build_release_plan(self.data)
        original = self.client.put_pointer
        def v1_conflict(key, *args):
            if key == "data/current.json":
                raise RuntimeError("injected v1 conflict")
            return original(key, *args)
        with patch.object(self.client, "put_pointer", v1_conflict):
            with self.assertRaisesRegex(RuntimeError, "v2 decision completed; v1 outcome must be checked"):
                pub.publish_dual_release(self.client, new_v1, new_v2)
        self.assertEqual(self.client.get_json("data/current.json")["release"], old_v1.release)
        self.assertEqual(self.client.get_json(cas.CURRENT_KEY)["release"], new_v2.release)
        self.assertIsNotNone(self.client.get_bytes(cas.manifest_key(old_v2.release)))

    def test_activation_rejects_missing_or_false_metadata_before_pointer_write(self):
        a = self.v2()
        pub.publish_v2_release(self.client, a)
        b = self.change("b")
        pub.publish_v2_release(self.client, b)
        original = self.client.head_metadata
        key = cas.object_key(a.manifest["files"]["about.json"]["sha256"])
        pointer = self.client.get_bytes(cas.CURRENT_KEY)
        for meta in (None, {"size": 1, "sha256": "a" * 64}):
            with self.subTest(meta=meta), patch.object(self.client, "head_metadata", lambda target: meta if target == key else original(target)):
                with self.assertRaisesRegex(RuntimeError, "verification failed"):
                    pub.activate_v2_release(self.client, "data", a.release)
            self.assertEqual(self.client.get_bytes(cas.CURRENT_KEY), pointer)

    def test_dual_mismatched_input_is_rejected_before_writes(self):
        a = pub.build_release_plan(self.data)
        b = self.change("different")
        with self.assertRaisesRegex(ValueError, "same frozen input"):
            pub.publish_dual_release(self.client, a, b)
        self.assertEqual(self.client.operations, [])

    def test_cli_publish_check_rollback_and_activate_are_local_only(self):
        store = str(self.root / "cli-actions")
        def run(*args):
            return pub.main(["--local-store", store, "--format", "v2", "--data-dir", str(self.data), *args])
        with patch.object(pub, "load_config", side_effect=AssertionError("no credentials")), \
             patch.object(socket, "socket", side_effect=AssertionError("no network")), \
             contextlib.redirect_stdout(io.StringIO()):
            a = self.v2()
            self.assertEqual(run("--publish"), 0)
            b = self.change("second")
            self.assertEqual(run("--publish"), 0)
            self.assertEqual(run("--check-current"), 0)
            self.assertEqual(run("--rollback"), 0)
            client = LocalDataClient(Path(store))
            self.assertEqual(client.get_json(cas.CURRENT_KEY)["release"], a.release)
            self.assertEqual(run("--activate-release", b.release), 0)
            self.assertEqual(client.get_json(cas.CURRENT_KEY)["release"], b.release)

    def test_snapshot_rejects_source_mutation_during_freeze(self):
        from tools import r2_data_snapshot as freezing
        original = freezing.source_files
        calls = 0
        def scan(directory):
            nonlocal calls
            calls += 1
            if calls == 2:
                (self.data / "about.json").write_text('{"changed": true}', encoding="utf-8")
            return original(directory)
        with patch.object(freezing, "source_files", scan), self.assertRaisesRegex(RuntimeError, "source file changed"):
            with pub.frozen_data_directory(self.data):
                self.fail("must reject before publishing")


if __name__ == "__main__":
    unittest.main()
