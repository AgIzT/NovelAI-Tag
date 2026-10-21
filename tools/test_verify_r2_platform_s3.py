"""Synthetic guards only: no credentials, platform clients, or network access."""
from contextlib import ExitStack, redirect_stdout
import io
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
import urllib.request

from tools import verify_r2_platform_s3 as verifier


class PlatformSafetyTests(unittest.TestCase):
    def setUp(self):
        parent = verifier.OUTPUT / "r2-platform-guard-tests"
        parent.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.resources_path = self.directory / "resources.json"
        self.credentials_path = self.directory / "synthetic-credentials.json"
        self.out = self.directory / "fresh-report"
        self.resources = {"bucket": "novelai-tag-r2-acceptance-20261021-1234abcd",
                          "account_id": "a" * 32, "production_bucket_denied": "production-assets", "test_only": True}
        self.source = {"account_id": "a" * 32, "access_key_id": "synthetic-access-only",
                       "secret_access_key": "synthetic-secret-only", "region": "auto",
                       "bucket": "production-assets", "base_url": "https://production.invalid",
                       "endpoint": "https://production.invalid", "data_prefix": "data",
                       "http_pool_enabled": False, "request_retries": 99}
        self.write(self.resources_path, self.resources)
        self.write(self.credentials_path, self.source)
        stack = ExitStack()
        self.addCleanup(stack.close)
        for owner, name in ((socket, "socket"), (socket, "create_connection"), (urllib.request, "urlopen"),
                            (verifier.pub, "load_config"), (verifier.sync_r2, "load_config"),
                            (verifier.pub, "main"), (verifier.sync_r2, "main")):
            stack.enter_context(patch.object(owner, name, side_effect=AssertionError("network/default configuration forbidden")))
        stack.enter_context(patch.object(verifier.sync_r2, "proxy_route", return_value=(None, None)))

    @staticmethod
    def write(path, value):
        path.write_text(json.dumps(value), encoding="utf-8")

    def arguments(self, run=False):
        args = ["--resources", str(self.resources_path), "--credentials-source", str(self.credentials_path),
                "--out-dir", str(self.out)]
        return args + (["--run"] if run else [])

    def raw(self):
        cfg = verifier.credentials_for(self.credentials_path, self.resources)
        evidence = verifier.Evidence("acceptance/run-" + "b" * 32)
        raw = verifier.MeasuredR2Client(cfg, self.resources, evidence, "synthetic")
        self.addCleanup(raw.close)
        return raw, evidence

    def test_default_plan_never_reads_credentials_constructs_client_or_creates_output(self):
        self.credentials_path.unlink()
        with patch.object(verifier, "credentials_for", side_effect=AssertionError("credential read")) as creds, \
                patch.object(verifier, "MeasuredR2Client", side_effect=AssertionError("client constructed")) as client, \
                redirect_stdout(io.StringIO()) as output:
            self.assertEqual(verifier.main(self.arguments()), 0)
        result = json.loads(output.getvalue())
        self.assertEqual((result["status"], result["credential_reads"], result["network_requests"]), ("PLAN", 0, 0))
        self.assertFalse(self.out.exists())
        creds.assert_not_called()
        client.assert_not_called()

    def test_run_requires_explicit_credentials_before_output_creation(self):
        args = ["--resources", str(self.resources_path), "--out-dir", str(self.out), "--run"]
        with self.assertRaisesRegex(verifier.GuardError, "credentials-source"):
            verifier.main(args)
        self.assertFalse(self.out.exists())

    def test_resources_require_boolean_test_only(self):
        for value in (False, "true", 1, None):
            self.write(self.resources_path, {**self.resources, "test_only": value})
            with self.subTest(value=value), self.assertRaises(verifier.GuardError):
                verifier.validate_resources(self.resources_path)

    def test_bucket_allowlist_is_exact_and_excludes_production(self):
        for bucket in ("production-assets", self.resources["bucket"] + "-extra", "novelai-tag-r2-acceptance-20261021-ABCDEF12",
                       "novelai-tag-r2-acceptance-20261020-1234abcd", "", None):
            self.write(self.resources_path, {**self.resources, "bucket": bucket})
            with self.subTest(bucket=bucket), self.assertRaises(verifier.GuardError):
                verifier.validate_resources(self.resources_path)
        self.write(self.resources_path, {**self.resources, "production_bucket_denied": self.resources["bucket"]})
        with self.assertRaises(verifier.GuardError):
            verifier.validate_resources(self.resources_path)

    def test_account_and_production_exclusion_must_exist(self):
        for fields in ({"account_id": "wrong"}, {"account_id": None}, {"production_bucket_denied": ""}):
            self.write(self.resources_path, {**self.resources, **fields})
            with self.subTest(fields=fields), self.assertRaises(verifier.GuardError):
                verifier.validate_resources(self.resources_path)

    def test_credentials_select_four_fields_and_override_source_target(self):
        cfg = verifier.credentials_for(self.credentials_path, self.resources)
        self.assertEqual(cfg["bucket"], self.resources["bucket"])
        self.assertEqual(cfg["account_id"], self.resources["account_id"])
        self.assertEqual(cfg["request_retries"], 0)
        self.assertEqual(cfg["upload_retries"], 0)
        self.assertTrue(cfg["http_pool_enabled"])
        for name in ("base_url", "endpoint", "data_prefix"):
            self.assertNotIn(name, cfg)
        self.assertNotIn("production", json.dumps(cfg))

    def test_credential_account_mismatch_stops_before_client_and_output(self):
        self.write(self.credentials_path, {**self.source, "account_id": "c" * 32})
        with patch.object(verifier, "MeasuredR2Client") as client, self.assertRaisesRegex(verifier.GuardError, "account differs"):
            verifier.main(self.arguments(run=True))
        client.assert_not_called()
        self.assertFalse(self.out.exists())

    def test_missing_keys_or_invalid_region_are_rejected(self):
        for fields in ({"secret_access_key": ""}, {"access_key_id": None}, {"region": "auto/bad"}, {"region": []}):
            self.write(self.credentials_path, {**self.source, **fields})
            with self.subTest(fields=fields), self.assertRaises(verifier.GuardError):
                verifier.credentials_for(self.credentials_path, self.resources)

    def test_existing_output_and_sentinel_are_preserved_before_credential_read(self):
        self.out.mkdir()
        sentinel = self.out / "previous.json"
        sentinel.write_bytes(b"old evidence")
        with patch.object(verifier, "credentials_for") as credentials, self.assertRaises(verifier.GuardError):
            verifier.main(self.arguments(run=True))
        self.assertEqual(sentinel.read_bytes(), b"old evidence")
        credentials.assert_not_called()

    def test_output_root_and_outside_are_rejected(self):
        for target in (verifier.OUTPUT, self.directory.parent.parent.parent / "outside"):
            with self.subTest(target=target), self.assertRaises(verifier.GuardError):
                verifier.validate_output(target)

    def test_resources_output_and_credentials_link_checks_precede_reads_or_writes(self):
        original = verifier.no_links
        for forbidden in (self.resources_path, self.out, self.credentials_path):
            def check(path):
                if Path(path).absolute() == forbidden.absolute():
                    raise ValueError("synthetic reparse point")
                return original(path)
            with self.subTest(path=forbidden), patch.object(verifier, "no_links", side_effect=check), \
                    patch.object(verifier, "run_acceptance") as work, self.assertRaisesRegex(ValueError, "reparse"):
                verifier.main(self.arguments(run=True))
            self.assertFalse(self.out.exists())
            work.assert_not_called()

    def test_duplicate_inputs_are_rejected(self):
        args = ["--resources", str(self.resources_path), "--credentials-source", str(self.resources_path),
                "--out-dir", str(self.out), "--run"]
        with self.assertRaisesRegex(verifier.GuardError, "separate"):
            verifier.main(args)
        self.assertFalse(self.out.exists())

    def test_client_bucket_account_and_random_prefix_guards(self):
        cfg = verifier.credentials_for(self.credentials_path, self.resources)
        evidence = verifier.Evidence("acceptance/run-" + "b" * 32)
        for fields in ({"bucket": "production-assets"}, {"account_id": "c" * 32}):
            with self.subTest(fields=fields), self.assertRaises(verifier.GuardError):
                verifier.MeasuredR2Client({**cfg, **fields}, self.resources, evidence, "blocked")
        with self.assertRaises(verifier.GuardError):
            verifier.Evidence("data")

    def test_method_query_and_key_scope_guards_run_before_transport(self):
        raw, evidence = self.raw()
        good = evidence.prefix + "/safe.json"
        cases = [("DELETE", good, None), ("GET", "data/current.json", None),
                 ("PUT", evidence.prefix + "-sibling/file.json", None),
                 ("PUT", evidence.prefix + "/../file.json", None), ("PUT", evidence.prefix + "/x//file.json", None),
                 ("PUT", evidence.prefix + "/%2e%2e/file.json", None), ("GET", good, {"list-type": 2})]
        with patch.object(verifier.sync_r2.R2Client, "_request_once") as transport:
            for method, key, query in cases:
                with self.subTest(method=method, key=key), self.assertRaises(verifier.GuardError):
                    raw._request_once(method, key, query=query)
        transport.assert_not_called()
        self.assertEqual(evidence.requests, [])

    def test_copy_source_and_runtime_bucket_changes_are_blocked(self):
        raw, evidence = self.raw()
        key = evidence.prefix + "/copy.json"
        with patch.object(verifier.sync_r2.R2Client, "_request_once") as transport:
            with self.assertRaises(verifier.GuardError):
                raw._request_once("PUT", key, headers={"x-amz-copy-source": "/production-assets/data/source.json"})
            raw.bucket = "production-assets"
            with self.assertRaises(verifier.GuardError):
                raw._request_once("GET", key)
        transport.assert_not_called()

    def test_runtime_origin_changes_are_blocked_before_transport(self):
        for field, value in (("host", "production.invalid"), ("endpoint", "https://production.invalid")):
            raw, evidence = self.raw()
            setattr(raw, field, value)
            with self.subTest(field=field), patch.object(verifier.sync_r2.R2Client, "_request_once") as transport, \
                    self.assertRaisesRegex(verifier.GuardError, "origin"):
                raw._request_once("GET", evidence.prefix + "/safe.json")
            transport.assert_not_called()

    def test_tls_acceptance_rejects_eight_handshakes_or_missing_measurement(self):
        for count in (0, 8, 9):
            with self.subTest(count=count), self.assertRaises(verifier.CheckFailed):
                verifier.validate_tls_sequence({"requests": 8}, count)
        verifier.validate_tls_sequence({"requests": 8}, 1)
        with self.assertRaises(verifier.CheckFailed):
            verifier.validate_tls_sequence({"requests": 9}, 1)

    def test_raw_http_evidence_contains_no_body_signature_or_credentials(self):
        raw, evidence = self.raw()
        response = (412, {"etag": '"synthetic-etag"'}, b"<Code>PreconditionFailed</Code>")
        with patch.object(verifier.sync_r2.R2Client, "_request_once", return_value=response):
            self.assertEqual(raw._request_once("PUT", evidence.prefix + "/safe.json", body=b"synthetic")[0], 412)
        event = evidence.requests[0]
        self.assertEqual(event["status"], 412)
        self.assertEqual(event["service_error_code"], "PreconditionFailed")
        self.assertEqual(event["request_sha256"], verifier.digest(b"synthetic"))
        serialized = json.dumps(event)
        for secret in ("synthetic-access-only", "synthetic-secret-only", "Authorization", "<Code>"):
            self.assertNotIn(secret, serialized)

    def test_access_denied_records_status_and_reports_blocked(self):
        raw, evidence = self.raw()
        with patch.object(verifier.sync_r2.R2Client, "_request_once", return_value=(403, {}, b"<Code>AccessDenied</Code>")), \
                self.assertRaises(verifier.AccessBlocked):
            raw._request_once("HEAD", evidence.prefix + "/probe.json")
        self.assertEqual(len(evidence.requests), 1)
        self.assertEqual(evidence.requests[0]["status"], 403)
        with patch.object(verifier, "run_acceptance", side_effect=verifier.AccessBlocked("S3AccessDenied")), redirect_stdout(io.StringIO()):
            self.assertEqual(verifier.main(self.arguments(run=True)), 2)
        report = json.loads((self.out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(report["status"], "BLOCKED")
        self.assertTrue(all(step["status"] == "SKIP" for step in report["steps"].values()))

    def test_untrusted_transport_error_is_sanitized_in_output(self):
        with patch.object(verifier, "run_acceptance", side_effect=OSError("http://name:proxy-secret@proxy.invalid")), \
                redirect_stdout(io.StringIO()) as output:
            self.assertEqual(verifier.main(self.arguments(run=True)), 1)
        saved = (self.out / "report.json").read_text(encoding="utf-8")
        for secret in ("proxy-secret", "synthetic-secret-only", "synthetic-access-only"):
            self.assertNotIn(secret, saved + output.getvalue())

    def test_success_report_binds_source_and_resources_without_credentials(self):
        def synthetic_run(_cfg, _resources, _out, report):
            report["status"] = "PASS"
        with patch.object(verifier, "run_acceptance", side_effect=synthetic_run), redirect_stdout(io.StringIO()):
            self.assertEqual(verifier.main(self.arguments(run=True)), 0)
        report = json.loads((self.out / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(report["resources_sha256"], verifier.digest(self.resources_path.read_bytes()))
        self.assertEqual(report["source_sha256"]["tools/verify_r2_platform_s3.py"],
                         verifier.digest((verifier.ROOT / "tools/verify_r2_platform_s3.py").read_bytes()))
        self.assertNotIn("synthetic-secret-only", json.dumps(report))


if __name__ == "__main__":
    unittest.main()
