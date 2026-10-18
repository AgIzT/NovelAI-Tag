"""Offline regressions for missing media and overlapping release decisions."""
import io
import json
import tempfile
import unittest
import urllib.error
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

from tools import publish_data_r2 as publisher, sync_r2
from tools.test_publish_data_r2 import FakeClient, make_data, write_json


class AtomicFakeClient(FakeClient):
    def get_json_snapshot(self, key):
        value = self.get_json(key)
        body = self.objects.get(key, {}).get("body")
        return value, ('"' + publisher.sha256_bytes(body) + '"') if body is not None else None

    def put_pointer(self, key, body, expected_etag):
        _value, actual = self.get_json_snapshot(key)
        if actual != expected_etag:
            raise RuntimeError("current pointer conflict; reload before retrying")
        self.put_bytes(key, body, publisher.POINTER_CACHE_CONTROL)


class MissingMediaReleaseTests(unittest.TestCase):
    def test_missing_required_media_stops_before_release_activation(self):
        for missing in ("thumbnail", "original", "secondary", "cover"):
            with self.subTest(missing=missing):
                code, client, requests = self.run_chain(missing, remote=False)
                self.assertEqual(code, 1, "missing referenced media must be fatal")
                self.assertNotIn("data/current.json", client.objects)

    def test_remote_readable_media_does_not_require_local_cache(self):
        for missing in ("thumbnail", "original", "secondary", "cover"):
            with self.subTest(missing=missing):
                code, client, requests = self.run_chain(missing, remote=True)
                self.assertEqual(code, 2, "local cache warnings remain nonfatal")
                self.assertIn("data/current.json", client.objects)
                self.assertTrue(requests, "remote media must actually be read")

    def test_optional_original_warning_does_not_block(self):
        code, client, _requests = self.run_chain("optional", remote=False)
        self.assertEqual(code, 2)
        self.assertIn("data/current.json", client.objects)

    def test_optional_secondary_original_warning_does_not_block(self):
        code, client, requests = self.run_chain("optional_secondary", remote=False)
        self.assertEqual(code, 2)
        self.assertIn("data/current.json", client.objects)
        self.assertNotIn("originals/demo/two.jpg", requests)

    def run_chain(self, missing, remote):
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            root = Path(tmp)
            data = root / "site" / "data"
            make_data(data)
            entry = {"id": "demo-1", "image": "one.jpg", "original": "one.png"}
            book = {"id": "demo", "entries": [entry]}
            if missing == "secondary":
                entry["images"] = [{"path": "two.jpg", "original": "two.png"}]
            if missing == "optional_secondary":
                entry["images"] = [{"path": "two.jpg"}]
                secondary = root / "site/images/demo/two.jpg"
                secondary.parent.mkdir(parents=True, exist_ok=True)
                secondary.write_bytes(b"synthetic secondary bytes")
            if missing == "cover":
                book["cover"] = "cover.jpg"
            if missing == "optional":
                del entry["original"]
            write_json(data / "demo.json", book)
            for folder, name in (("site/images/demo", "one.jpg"), ("originals/demo", "one.png")):
                if (missing == "thumbnail" and name == "one.jpg") or (missing in ("original", "optional") and name == "one.png"):
                    continue
                path = root / folder / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"synthetic media bytes")
            cfg = {"account_id": "fake", "access_key_id": "fake", "secret_access_key": "fake", "bucket": "fake",
                   "image_prefix": "images", "original_prefix": "originals"}
            requests = []
            class FakeMedia:
                def __init__(self, *_args):
                    pass
                def get(self, key, **_kwargs):
                    requests.append(key)
                    return (206, {"content-length": "1"}, b"x") if remote else (404, {}, b"")
                def list_objects_v2(self, *_args, **_kwargs):
                    return {}
                def put_file(self, *_args, **_kwargs):
                    return 200, {}, b""
            for name, value in (("ROOT", root), ("DATA_DIR", data), ("THUMB_DIR", root / "site/images"),
                                ("ORIG_DIR", root / "originals"), ("MEDIA_PATH", data / "media.json"),
                                ("MANIFEST_PATH", root / "manifest.json")):
                stack.enter_context(patch.object(sync_r2, name, value))
            stack.enter_context(patch.object(sync_r2, "load_config", return_value=cfg))
            stack.enter_context(patch.object(sync_r2, "R2Client", FakeMedia))
            stack.enter_context(patch.object(sync_r2, "image_dimensions", return_value=(1, 1)))
            stack.enter_context(patch("socket.create_connection", side_effect=AssertionError("network forbidden")))
            stack.enter_context(patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden")))
            stack.enter_context(patch("sys.argv", ["sync_r2.py"]))
            stack.enter_context(redirect_stdout(io.StringIO()))
            code = sync_r2.main()
            client = AtomicFakeClient()
            # Same accepted exit codes as the real Windows entrypoint (tested separately).
            if code in (0, 2):
                publisher.publish_release(client, publisher.build_release_plan(data))
            return code, client, requests


class PointerOverlapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        make_data(self.root)
        self.client = AtomicFakeClient()
        with redirect_stdout(io.StringIO()):
            self.old = publisher.build_release_plan(self.root)
            publisher.publish_release(self.client, self.old)
            write_json(self.root / "about.json", {"version": 2})
            self.current = publisher.build_release_plan(self.root)
            publisher.publish_release(self.client, self.current)
        write_json(self.root / "about.json", {"version": 3})
        self.next = publisher.build_release_plan(self.root)

    def test_publish_cannot_overwrite_a_concurrent_rollback(self):
        def rollback(_plan):
            publisher.activate_release(self.client, "data", self.old.release)
        with redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, "conflict"):
            publisher.publish_release(self.client, self.next, public_check=rollback)
        pointer = self.client.get_json("data/current.json")
        self.assertEqual(pointer["release"], self.old.release)
        self.assertEqual(pointer["previousRelease"], self.current.release)

    def test_activation_cannot_overwrite_a_concurrent_publish(self):
        original_head = self.client.head_metadata
        changed = False
        def head(key):
            nonlocal changed
            if not changed:
                changed = True
                publisher.publish_release(self.client, self.next)
            return original_head(key)
        with patch.object(self.client, "head_metadata", side_effect=head), redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, "conflict"):
            publisher.activate_release(self.client, "data", self.old.release)
        pointer = self.client.get_json("data/current.json")
        self.assertEqual(pointer["release"], self.next.release)
        self.assertEqual(pointer["previousRelease"], self.current.release)

    def test_first_publisher_cannot_overwrite_another_first_publisher(self):
        client = AtomicFakeClient()
        client.objects = {key: value.copy() for key, value in self.client.objects.items() if key != "data/current.json"}
        with redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, "conflict"):
            publisher.publish_release(client, self.next, public_check=lambda _plan: publisher.publish_release(client, self.old))
        self.assertEqual(client.get_json("data/current.json")["release"], self.old.release)

    def test_rollback_uses_the_snapshot_that_selected_its_target(self):
        real_load = publisher.load_remote_manifest
        changed = False
        def load(client, prefix, release):
            nonlocal changed
            if not changed:
                changed = True
                publisher.publish_release(client, self.next)
            return real_load(client, prefix, release)
        with patch.object(publisher, "load_config", return_value={}), patch.object(publisher, "R2DataClient", return_value=self.client), patch.object(publisher, "load_remote_manifest", side_effect=load), redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, "conflict"):
            publisher.main(["--rollback"])
        self.assertEqual(self.client.get_json("data/current.json")["release"], self.next.release)

    def test_same_release_decisions_change_etag_even_at_the_same_time(self):
        with redirect_stdout(io.StringIO()):
            before = self.client.get_json_snapshot("data/current.json")[1]
            publisher.activate_release(self.client, "data", self.current.release)
            after = self.client.get_json_snapshot("data/current.json")[1]
        self.assertNotEqual(before, after)
        pointer = publisher.build_pointer(self.current, published_at="2026-10-18T00:00:00+00:00")
        other = publisher.build_pointer(self.current, published_at=pointer["publishedAt"])
        self.assertNotEqual(publisher.json_bytes(pointer), publisher.json_bytes(other))

    def test_conflict_keeps_release_objects_and_can_be_replanned(self):
        with redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "conflict"):
                publisher.publish_release(self.client, self.next, public_check=lambda _plan: publisher.activate_release(self.client, "data", self.old.release))
            result = publisher.publish_release(self.client, self.next)
        self.assertEqual(result["uploaded"], 0)
        self.assertEqual(result["pointer"]["previousRelease"], self.old.release)


class PointerAdapterTests(unittest.TestCase):
    def client(self):
        return publisher.R2DataClient({"account_id": "fake", "access_key_id": "fake", "secret_access_key": "fake", "bucket": "fake"})

    def test_signed_pointer_put_conditions_are_sent_without_retries(self):
        client = self.client()
        for etag, header in ((None, {"If-None-Match": "*"}), ('"observed-etag"', {"If-Match": '"observed-etag"'})):
            with self.subTest(etag=etag), patch.object(client.raw, "_request", return_value=(200, {}, b"")) as request:
                client.put_pointer("data/current.json", b"{}", etag)
                options = request.call_args.kwargs
                for key, value in header.items():
                    self.assertEqual(options["headers"][key], value)
                self.assertEqual(options["retries"], 0)

    def test_conditions_are_included_in_the_real_sigv4_request(self):
        client = self.client()
        response = Mock(status=200, headers={}, read=Mock(return_value=b""))
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        for etag, header in ((None, "if-none-match"), ('"seen"', "if-match")):
            with self.subTest(etag=etag), patch("urllib.request.urlopen", return_value=response) as urlopen:
                client.put_pointer("data/current.json", b"{}", etag)
                request = urlopen.call_args.args[0]
                headers = {key.lower(): value for key, value in request.header_items()}
                self.assertEqual(headers[header], etag or "*")
                self.assertIn(header, headers["authorization"].split("SignedHeaders=", 1)[1].split(",", 1)[0].split(";"))

    def test_conflicts_and_uncertain_network_results_never_retry(self):
        for outcome in ((412, {}, b"conflict"), (409, {}, b"conflict"), (503, {}, b"unavailable"), urllib.error.URLError("lost response")):
            with self.subTest(outcome=outcome):
                client = self.client()
                put = Mock(side_effect=outcome) if isinstance(outcome, Exception) else Mock(return_value=outcome)
                with patch.object(client.raw, "put_bytes", put), self.assertRaises(RuntimeError):
                    client.put_pointer("data/current.json", b"{}", '"old"')
                self.assertEqual(put.call_count, 1)

    def test_snapshot_pairs_json_with_etag_from_one_get(self):
        client = self.client()
        with patch.object(client.raw, "get", return_value=(200, {"etag": '"snapshot"'}, b'{"release":"test"}')) as get:
            self.assertEqual(publisher.pointer_snapshot(client, "data/current.json"), ({"release": "test"}, '"snapshot"'))
            get.assert_called_once_with("data/current.json")
        with patch.object(client.raw, "get", return_value=(200, {}, b"{}")), self.assertRaisesRegex(RuntimeError, "no ETag"):
            publisher.pointer_snapshot(client, "data/current.json")


class MissingMediaProbeTests(unittest.TestCase):
    def test_forbidden_empty_missing_and_unavailable_media_block(self):
        for outcome in ((403, {}, b"forbidden"), (200, {}, b""), (404, {}, b""), TimeoutError("offline")):
            with self.subTest(outcome=outcome):
                get = Mock(side_effect=outcome) if isinstance(outcome, Exception) else Mock(return_value=outcome)
                client = Mock(get=get)
                self.assertEqual(len(sync_r2.verify_missing_media(client, {"images/demo/missing.jpg"})), 1)
                get.assert_called_once_with("images/demo/missing.jpg", byte_range="bytes=0-0")

    def test_duplicate_references_only_read_once(self):
        client = Mock(get=Mock(return_value=(206, {}, b"x")))
        self.assertEqual(sync_r2.verify_missing_media(client, {"images/demo/one.jpg"}), [])
        self.assertEqual(client.get.call_count, 1)


class SyntheticPlanTests(unittest.TestCase):
    def test_plan_mode_uses_only_synthetic_data_and_never_loads_credentials_or_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_data(root)
            build = publisher.build_release_plan
            with patch.object(publisher, "build_release_plan", side_effect=lambda: build(root)), patch.object(publisher, "load_config", side_effect=AssertionError("credentials forbidden")), patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden")), patch("socket.create_connection", side_effect=AssertionError("network forbidden")), redirect_stdout(io.StringIO()) as output:
                self.assertEqual(publisher.main([]), 0)
            self.assertIn("plan only", output.getvalue())


if __name__ == "__main__":
    unittest.main()
