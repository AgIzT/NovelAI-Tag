"""Pure synthetic guard checks. No HTTP, production config, token or real data."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools import verify_r2_platform_http as verifier


class PlatformHttpGuards(unittest.TestCase):
    def setUp(self):
        parent = verifier.OUTPUT / "r2-platform-guard-tests"
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.resources = {
            "bucket": "novelai-tag-r2-acceptance-20261021-0123abcd",
            "worker": "atlas-r2-acceptance-20261021-0123abcd",
            "worker_url": "https://atlas-r2-acceptance-20261021-0123abcd.synthetic.workers.dev",
            "account_id": "a" * 32, "test_only": True,
            "production_bucket_denied": "novelai-tag-assets",
        }
        self.resource_path = self.root / "resources.json"
        self.save()
        self.run_id = "1" * 32

    def save(self):
        self.resource_path.write_text(json.dumps(self.resources), encoding="utf-8")

    def arguments(self, out="fresh", extra=()):
        return ["--resources", str(self.resource_path), "--worker-url", self.resources["worker_url"],
                "--out-dir", str(self.root / out), "--run-id", self.run_id, *extra]

    def test_plan_never_reads_token_builds_http_or_starts_acceptance(self):
        with patch.object(verifier, "read_token", side_effect=AssertionError("token read")), \
             patch.object(verifier, "HttpClient", side_effect=AssertionError("network")), \
             patch.object(verifier, "run_acceptance", side_effect=AssertionError("acceptance")), \
             contextlib.redirect_stdout(io.StringIO()):
            result = verifier.main(self.arguments())
        self.assertEqual(result, 0)
        report = json.loads((self.root / "fresh/report.json").read_text(encoding="utf-8"))
        self.assertEqual(report["status"], "PLAN")
        self.assertEqual(report["requests"], [])
        self.assertTrue(all(key.startswith(("data/", "platform/" + self.run_id + "/binding/")) for key in report["plannedKeys"]))
        self.assertEqual(len(report["plannedKeys"]), 12)
        self.assertNotIn("Authorization", json.dumps(report))
        self.assertNotIn("ATLAS_R2_TEST_TOKEN", json.dumps(report))

    def test_invalid_resources_block_run_before_output_or_network(self):
        for field, value in (("test_only", False), ("test_only", "true"),
                             ("bucket", "novelai-tag-assets"), ("worker", "production"),
                             ("bucket", self.resources["bucket"] + "\n"),
                             ("production_bucket_denied", "other"),
                             ("account_id", "bad")):
            with self.subTest(field=field, value=value):
                old = self.resources[field]
                self.resources[field] = value
                self.save()
                with patch.object(verifier, "run_acceptance") as work, self.assertRaises(RuntimeError):
                    verifier.main(self.arguments(extra=("--run",)))
                work.assert_not_called()
                self.assertFalse((self.root / "fresh").exists())
                self.resources[field] = old
        self.save()

    def test_worker_url_must_be_exact_reviewed_origin(self):
        suffix = self.resources["worker"] + ".synthetic.workers.dev"
        for url in ("https://novelai.quicktagcloud.com", "https://" + self.resources["worker"] + ".attacker.workers.dev",
                    "http://" + suffix, "https://user@" + suffix, "https://" + suffix + ":443",
                    "https://" + suffix + "/", "https://" + suffix + "/data",
                    "https://" + suffix + "?other=1", "https://" + suffix + "#fragment",
                    "https://" + suffix + ".attacker.invalid", "https://" + suffix + "\n",
                    "https://" + self.resources["worker"] + ".a.b.workers.dev"):
            with self.subTest(url=url), self.assertRaises(RuntimeError):
                verifier.validate_worker_url(url, verifier.resources_from(self.resource_path))
        self.assertEqual(verifier.validate_worker_url(self.resources["worker_url"], verifier.resources_from(self.resource_path)),
                         self.resources["worker_url"])

    def test_invalid_declared_url_is_rejected_even_if_it_matches_argument(self):
        for url in ("https://novelai.quicktagcloud.com", self.resources["worker_url"] + "/",
                    "https://" + self.resources["worker"] + ".a.b.workers.dev"):
            with self.subTest(url=url):
                resources = verifier.resources_from(self.resource_path)
                resources["worker_url"] = url
                with self.assertRaises(RuntimeError):
                    verifier.validate_worker_url(url, resources)

    def test_output_must_be_fresh_before_token_or_network(self):
        out = self.root / "existing"
        out.mkdir()
        sentinel = out / "report.json"
        sentinel.write_bytes(b"old evidence")
        with patch.object(verifier, "run_acceptance") as work, self.assertRaises(RuntimeError):
            verifier.main(self.arguments("existing", ("--run",)))
        work.assert_not_called()
        self.assertEqual(sentinel.read_bytes(), b"old evidence")

    def test_output_root_or_outside_rejected(self):
        for path in (verifier.OUTPUT, verifier.ROOT, self.root / "../../../outside"):
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                verifier.create_output_directory(path)

    def test_reparse_guard_precedes_output_creation(self):
        original = verifier.no_links
        out = self.root / "fresh"
        def reject(path):
            if Path(path) == out:
                raise ValueError("synthetic reparse point")
            return original(path)
        with patch.object(verifier, "no_links", reject), self.assertRaisesRegex(ValueError, "reparse"):
            verifier.main(self.arguments())
        self.assertFalse(out.exists())

    def test_resource_reparse_guard_precedes_read(self):
        with patch.object(verifier, "no_links", side_effect=ValueError("synthetic reparse point")), \
             self.assertRaisesRegex(ValueError, "reparse"):
            verifier.resources_from(self.resource_path)

    def test_run_id_has_no_key_injection(self):
        for run_id in ("", "x" * 32, "../data", "1" * 32 + "\n", "1" * 31):
            with self.subTest(run_id=run_id), self.assertRaises(RuntimeError):
                verifier.build_fixture(run_id)
        fixture = verifier.build_fixture(self.run_id)
        self.assertEqual(fixture["summary"], verifier.build_fixture(self.run_id)["summary"])
        self.assertNotEqual(fixture["versions"]["old"]["summary"]["release"],
                            fixture["versions"]["new"]["summary"]["release"])

    def test_redirect_handler_never_returns_a_redirect_request(self):
        handler = verifier.NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 302, "redirect", {}, "https://novelai.quicktagcloud.com"))

    def test_probe_mismatch_stops_before_token_read(self):
        fake = type("FakeClient", (), {"request": lambda self, *args, **kwargs:
                    {"status": 200, "body": b'{"testOnly":true,"worker":"other","bucket":"other"}', "headers": {}}})()
        with patch.object(verifier, "HttpClient", return_value=fake), \
             patch.object(verifier, "read_token", side_effect=AssertionError("token read")) as token, \
             self.assertRaises(RuntimeError):
            verifier.run_acceptance(verifier.resources_from(self.resource_path), self.resources["worker_url"],
                                    self.run_id, verifier.build_fixture(self.run_id), {"checks": [], "requests": []})
        token.assert_not_called()

    def test_identified_tool_user_agent_passes_synthetic_edge_without_logging_credentials(self):
        expected_user_agent = "Atlas-R2-Platform-Acceptance/1.0"
        seen = []

        class EdgeResponse(io.BytesIO):
            def __init__(self, request, status):
                super().__init__(b"synthetic probe" if status == 200 else b"error code: 1010\n")
                self.status = status
                self.headers = {"Content-Type": "text/plain"}
                self.url = request.full_url

            def geturl(self):
                return self.url

        class SyntheticEdge:
            def open(self, request, timeout=30):
                user_agent = request.get_header("User-agent") or "Python-urllib/3.10"
                seen.append({"userAgent": user_agent, "authorization": request.get_header("Authorization")})
                return EdgeResponse(request, 200 if user_agent == expected_user_agent else 403)

        edge = SyntheticEdge()
        url = self.resources["worker_url"] + "/__test"
        # Freeze the observed edge policy without making a network request.
        for headers in ({}, {"User-Agent": "Python-urllib/3.10"}):
            with edge.open(verifier.urllib.request.Request(url, headers=headers)) as response:
                self.assertEqual(response.status, 403)
        events = []
        synthetic_token = "c" * 64
        caller_headers = {"Authorization": "Bearer " + synthetic_token, "User-Agent": "caller-value"}
        unchanged = dict(caller_headers)
        with patch.object(verifier.urllib.request, "build_opener", return_value=edge):
            client = verifier.HttpClient(self.resources["worker_url"], events)
            self.assertEqual(client.request("GET", "/__test")["status"], 200)
            self.assertEqual(client.request("POST", "/__test", caller_headers, b"{}")["status"], 200)
        self.assertEqual([item["userAgent"] for item in seen[-2:]], [expected_user_agent] * 2)
        self.assertIsNone(seen[-2]["authorization"])
        self.assertEqual(seen[-1]["authorization"], "Bearer " + synthetic_token)
        self.assertEqual(caller_headers, unchanged)
        self.assertNotIn(synthetic_token, json.dumps(events))
        self.assertNotIn("authorization", json.dumps(events).lower())


    def test_token_format_is_exact_and_does_not_appear_in_error(self):
        for value in ("", "a" * 63, "a" * 64 + "\n", "A" * 64):
            with self.subTest(value=value), patch.dict(verifier.os.environ, {"ATLAS_R2_TEST_TOKEN": value}), \
                 self.assertRaisesRegex(RuntimeError, "must be 64"):
                verifier.read_token()
        with patch.dict(verifier.os.environ, {"ATLAS_R2_TEST_TOKEN": "f" * 64}):
            self.assertEqual(verifier.read_token(), "f" * 64)


if __name__ == "__main__":
    unittest.main()
