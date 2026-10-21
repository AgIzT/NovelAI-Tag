"""Regression tests for trustworthy check results, using temporary local fixtures."""

import contextlib
from dataclasses import replace
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tools import run_project_checks as runner


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="atlas-check-tests-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.logs = self.root / "logs"
        self.logs.mkdir()
        self.script = self.root / "check.py"
        self.check = runner.Check("sample", "python", ("-B", "check.py"), ("check.py",), r"^DONE$")
        self.runtimes = {"python": {"available": True, "path": sys.executable}}
        self.env = runner.clean_environment(runtime_paths=[sys.executable])

    def execute(self, source, check=None):
        self.script.write_text(source, encoding="utf-8")
        return runner.execute_check(check or self.check, self.root, self.runtimes, self.env, self.logs)

    def test_success_requires_specific_completion_evidence(self):
        success = self.execute("print('DONE')\n")
        silent = self.execute("pass\n")
        unrelated = self.execute("print('other checks PASS')\n")
        duplicate = self.execute("print('DONE\\nDONE')\n")
        self.assertEqual(success["status"], "PASS")
        for result in [silent, unrelated, duplicate]:
            self.assertEqual(result["status"], "FAIL")
            self.assertTrue(result["executed"])
        self.assertIsNone(success["unittest_cases_reported"])

    def test_nonzero_cannot_be_cancelled_by_success_marker(self):
        result = self.execute("print('DONE')\nraise SystemExit(3)\n")
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(result["returncode"], 3)
        self.assertIn("DONE", (self.logs / "sample.log").read_text(encoding="utf-8"))

    def test_declared_blocked_exit_is_distinct_from_failure(self):
        check = replace(self.check, blocked_marker=r"^sample: BLOCKED \(not comparable\)$")
        blocked = self.execute("print('sample: BLOCKED (not comparable)')\nraise SystemExit(2)\n", check)
        self.assertEqual(blocked["status"], "BLOCKED")
        self.assertEqual(runner.summarize([blocked])["exit_code"], 2)
        for source in [
            "print('sample: BLOCKED (not comparable)')\nraise SystemExit(1)\n",
            "print('unrelated BLOCKED')\nraise SystemExit(2)\n",
            "print('sample: BLOCKED (not comparable)\\nDONE')\nraise SystemExit(2)\n",
        ]:
            self.assertEqual(self.execute(source, check)["status"], "FAIL")

    def test_skip_with_success_exit_is_not_pass(self):
        result = self.execute("print('missing fixture: SKIP\\nDONE')\n")
        self.assertEqual(result["status"], "BLOCKED")
        optional = self.execute("print('SKIP')\n", replace(self.check, required=False))
        self.assertEqual(optional["status"], "SKIP")
        self.assertNotEqual(runner.summarize([result])["exit_code"], 0)

    def test_timeout_is_failure_even_after_success_marker(self):
        result = self.execute("import time\nprint('DONE', flush=True)\ntime.sleep(30)\n", replace(self.check, timeout=0.2))
        self.assertEqual(result["status"], "FAIL")
        self.assertTrue(result["timed_out"])
        self.assertLess(result["seconds"], 12)
        self.assertIn("DONE", (self.logs / "sample.log").read_text(encoding="utf-8"))

    def test_missing_runtime_input_and_feature_block_before_execution(self):
        self.script.write_text("raise AssertionError('must not run')", encoding="utf-8")
        for check, runtimes in [
            (self.check, {}),
            (replace(self.check, inputs=("absent.json",)), self.runtimes),
            (replace(self.check, sqlite=True), self.runtimes),
            (replace(self.check, platform="never-this-platform"), self.runtimes),
        ]:
            with self.subTest(check=check, runtimes=runtimes):
                result = runner.execute_check(check, self.root, runtimes, self.env, self.logs)
                self.assertEqual(result["status"], "BLOCKED")
                self.assertFalse(result["executed"])
                self.assertEqual(result["argv"], [])

    def test_unstartable_runtime_is_blocked(self):
        self.script.write_text("pass", encoding="utf-8")
        runtimes = {"python": {"available": True, "path": str(self.root / "does-not-exist")}}
        result = runner.execute_check(self.check, self.root, runtimes, self.env, self.logs)
        self.assertEqual(result["status"], "BLOCKED")
        self.assertFalse(result["executed"])

    def test_real_unittest_reports_counts_and_does_not_recurse(self):
        source = "import unittest\nclass Example(unittest.TestCase):\n    def test_one(self):\n        self.assertTrue(True)\nunittest.main()\n"
        result = self.execute(source, replace(self.check, parser="unittest"))
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["unittest_cases_reported"], 1)
        self.assertEqual(result["unittest_skipped"], 0)

    def test_unittest_skip_and_zero_cases_are_not_pass(self):
        source = "import unittest\nclass Example(unittest.TestCase):\n    @unittest.skip('missing fixture')\n    def test_one(self):\n        pass\nunittest.main()\n"
        skipped = self.execute(source, replace(self.check, parser="unittest"))
        empty = self.execute("import unittest\nunittest.main()\n", replace(self.check, parser="unittest"))
        self.assertEqual(skipped["status"], "BLOCKED")
        self.assertEqual(skipped["unittest_skipped"], 1)
        self.assertEqual(skipped["unittest_cases_reported"], 1)
        self.assertEqual(empty["status"], "FAIL")
        self.assertEqual(empty["unittest_cases_reported"], 0)

    def test_failed_unittest_still_records_actual_reported_case_count(self):
        source = "import unittest\nclass Example(unittest.TestCase):\n    def test_one(self):\n        self.fail('known failure')\nunittest.main()\n"
        failed = self.execute(source, replace(self.check, parser="unittest"))
        self.assertEqual(failed["status"], "FAIL")
        self.assertEqual(failed["unittest_cases_reported"], 1)

    def test_unittest_missing_and_ambiguous_summaries_are_failures(self):
        for source in ["print('OK')\n", "print('Ran 1 test in 0.001s')\n",
                       "print('Ran 1 test in 0.001s\\nOK\\nRan 2 tests in 0.002s\\nOK')\n",
                       "print('Ran 1 test in 0.001s\\nOK (expected failures=1)')\n"]:
            with self.subTest(source=source):
                result = self.execute(source, replace(self.check, parser="unittest"))
                self.assertEqual(result["status"], "FAIL")

    def test_node_test_zero_skipped_summary_is_completed(self):
        output = "1..2\n# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n"
        result = self.execute("print(" + repr(output) + ")", replace(self.check, parser="node_test"))
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["node_test_cases_reported"], 2)

    def test_node_test_incomplete_and_skipped_summaries_are_not_pass(self):
        baseline = "1..2\n# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n"
        cases = [
            (baseline.replace("# skipped 0", "# skipped 1"), "BLOCKED"),
            (baseline.replace("# todo 0", "# todo 1"), "BLOCKED"),
            (baseline.replace("# fail 0", "# fail 1"), "FAIL"),
            (baseline.replace("# cancelled 0", "# cancelled 1"), "FAIL"),
            (baseline.replace("# pass 2", "# pass 1"), "FAIL"),
            (baseline.replace("# tests 2", "# tests 0"), "FAIL"),
            (baseline.replace("# skipped 0\n", ""), "FAIL"),
            (baseline + "# tests 2\n", "FAIL"),
        ]
        for output, expected in cases:
            with self.subTest(output=output):
                result = self.execute("print(" + repr(output) + ")", replace(self.check, parser="node_test"))
                self.assertEqual(result["status"], expected)

    def test_child_environment_removes_secrets_injection_and_proxies(self):
        injected = dict(os.environ, AWS_SECRET_ACCESS_KEY="secret", ADMIN_TOKEN="secret", CLOUDFLARE_API_TOKEN="secret",
                        HTTPS_PROXY="http://example.invalid", NODE_OPTIONS="--require malicious.js", PYTHONPATH="evil",
                        HOME="credential-home", USERPROFILE="credential-profile", GITHUB_TOKEN="secret")
        env = runner.clean_environment(injected, [sys.executable])
        for key in ["AWS_SECRET_ACCESS_KEY", "ADMIN_TOKEN", "CLOUDFLARE_API_TOKEN", "HTTPS_PROXY", "NODE_OPTIONS",
                    "PYTHONPATH", "HOME", "USERPROFILE", "GITHUB_TOKEN"]:
            self.assertNotIn(key, env)
        self.assertEqual(env["PYTHONDONTWRITEBYTECODE"], "1")
        self.script.write_text("import json,os\nprint(json.dumps(dict(os.environ)))\n", encoding="utf-8")
        actual = runner.run_process([sys.executable, "-B", str(self.script)], self.root, env, 10)
        self.assertEqual(actual["returncode"], 0)
        observed = json.loads(actual["output"])
        self.assertNotIn("ADMIN_TOKEN", observed)
        self.assertNotIn("HTTPS_PROXY", observed)
        self.assertNotIn("NODE_OPTIONS", observed)

    def test_output_must_be_new_and_inside_repository(self):
        for requested in [self.root, self.logs, self.root.parent / "outside", "../outside"]:
            with self.subTest(requested=requested), self.assertRaises(ValueError):
                runner.create_output_dir(self.root, requested)
        first = runner.create_output_dir(self.root)
        second = runner.create_output_dir(self.root)
        self.assertNotEqual(first, second)
        self.assertTrue((first / "logs").is_dir())
        sentinel = first / "report.json"
        sentinel.write_text("do not overwrite", encoding="utf-8")
        with self.assertRaises(ValueError):
            runner.create_output_dir(self.root, first)
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "do not overwrite")

    def test_output_rejects_link_or_reparse_metadata(self):
        outside = self.root / "target"
        outside.mkdir()
        link = self.root / "linked"
        if os.name == "nt":
            # Creating a real junction is denied by some managed Windows hosts.
            # Exercise the OS reparse attribute explicitly, never report a skip.
            original = Path.lstat
            def reparse_info(path, *args, **kwargs):
                if path == link:
                    return SimpleNamespace(st_mode=0, st_file_attributes=0x400)
                return original(path, *args, **kwargs)
            with patch.object(Path, "lstat", reparse_info):
                with self.assertRaisesRegex(ValueError, "symlink/junction"):
                    runner.create_output_dir(self.root, link / "run")
                with self.assertRaisesRegex(ValueError, "symlink/junction"):
                    runner.safe_path(self.root, link / "missing.json")
        else:
            link.symlink_to(outside, target_is_directory=True)
            self.addCleanup(lambda: link.unlink(missing_ok=True))
            with self.assertRaisesRegex(ValueError, "symlink/junction"):
                runner.create_output_dir(self.root, link / "run")
            with self.assertRaisesRegex(ValueError, "symlink/junction"):
                runner.safe_path(self.root, link / "missing.json")
        self.assertFalse((outside / "run").exists())

    def test_list_does_not_create_output_or_execute(self):
        report = self.root / "must-not-exist"
        with patch.object(runner, "ROOT", self.root), patch.object(runner, "discover_runtimes", side_effect=AssertionError("must not probe")), contextlib.redirect_stdout(io.StringIO()) as captured:
            self.assertEqual(runner.main(["--profile", "ci", "--list", "--output-dir", str(report)]), 0)
        output = json.loads(captured.getvalue())
        self.assertTrue(captured.getvalue().isascii())
        self.assertEqual(output["profile"], "ci")
        self.assertFalse(report.exists())
        self.assertTrue(output["known_baseline_limits"])
        self.assertTrue(all(check["network"] and check["credentials"] for check in output["checks"]))

    def test_private_fixture_names_cannot_escape_data_directory(self):
        data = self.root / "site/data"
        data.mkdir(parents=True)
        index = data / "codexes.json"
        check = replace(self.check, private_data=True, inputs=("site/data/codexes.json",))
        index.write_text('[{"id":"../../secret"}]', encoding="utf-8")
        inputs, errors = runner.check_inputs(check, self.root)
        self.assertTrue(errors)
        self.assertEqual(inputs, ["site/data/codexes.json"])
        index.write_text('[{"id":"demo"}]', encoding="utf-8")
        inputs, errors = runner.check_inputs(check, self.root)
        self.assertIn("site/data/demo.json", inputs)
        self.assertTrue(any("missing required input" in message for message in errors))
        (data / "demo.json").write_text('{"entries":[]}', encoding="utf-8")
        self.assertEqual(runner.check_inputs(check, self.root)[1], [])

    def test_source_hashes_change_when_ignored_fixture_changes(self):
        data = self.root / "site/data"
        data.mkdir(parents=True)
        (data / "codexes.json").write_text('[{"id":"demo"}]', encoding="utf-8")
        book = data / "demo.json"
        book.write_text('{"entries":[]}', encoding="utf-8")
        check = replace(self.check, private_data=True, inputs=("site/data/codexes.json",))
        before = runner.snapshot_inputs(self.root, [check])
        book.write_text('{"entries":[{"id":"one"}]}', encoding="utf-8")
        after = runner.snapshot_inputs(self.root, [check])
        self.assertNotEqual(before["sha256"], after["sha256"])
        self.assertIn("site/data/demo.json", after["files"])
        self.assertFalse(after["media_scanned"])

    def prepare_main_fixture(self):
        for relative in ["tools", "site/assets", "functions"]:
            (self.root / relative).mkdir(parents=True, exist_ok=True)
        (self.root / "tools/run_project_checks.py").write_text("# synthetic runner source\n", encoding="utf-8")
        dependency = self.root / "site/assets/dependency.js"
        dependency.write_text("// local synthetic dependency\n", encoding="utf-8")
        self.script.write_text(
            "with open('site/assets/dependency.js', encoding='utf-8') as source:\n"
            "    assert 'synthetic' in source.read()\nprint('DONE')\n", encoding="utf-8")
        return replace(self.check, inputs=("check.py", "site/assets/dependency.js")), dependency

    def run_fixture_main(self, check):
        with patch.object(runner, "ROOT", self.root), \
                patch.object(runner, "selected_checks", return_value=[check]), \
                patch.object(runner, "discover_runtimes", return_value=(self.runtimes, self.env)), \
                patch.object(runner, "git_metadata", return_value={"available": True, "head": "fixture-head"}), \
                contextlib.redirect_stdout(io.StringIO()):
            exit_code = runner.main(["--output-dir", "output/run"])
        report = json.loads((self.root / "output/run/report.json").read_text(encoding="utf-8"))
        return exit_code, report

    def test_main_blocks_repeated_fingerprint_read_failure_despite_passing_check(self):
        check, dependency = self.prepare_main_fixture()
        original_read_bytes = Path.read_bytes

        def deny_fingerprint(path):
            # Fault injection targets fingerprinting only; the real child still
            # reads its dependency. No actual file permissions are changed.
            if path == dependency:
                raise PermissionError("injected fingerprint read denial")
            return original_read_bytes(path)

        with patch.object(Path, "read_bytes", deny_fingerprint):
            exit_code, report = self.run_fixture_main(check)
        self.assertTrue(report["checks"][0]["executed"])
        self.assertEqual(report["checks"][0]["status"], "PASS")
        self.assertEqual(report["inputs_before"]["sha256"], report["inputs_after"]["sha256"])
        for key in ["inputs_before", "inputs_after"]:
            self.assertIn("injected fingerprint read denial", report[key]["files"]["site/assets/dependency.js"]["error"])
            self.assertTrue(any("injected fingerprint read denial" in error for error in report[key]["errors"]))
        self.assertFalse(report["evidence_stable"])
        self.assertEqual(report["summary"]["status"], "BLOCKED")
        self.assertEqual(exit_code, 2)

    def test_main_blocks_directory_walk_denial_despite_passing_check(self):
        check, _ = self.prepare_main_fixture()
        original_walk = os.walk

        def deny_directory(top, *, followlinks=False, onerror=None):
            # Simulate os.walk's documented onerror behavior. Real permissions
            # remain unchanged, so the selected child check genuinely passes.
            if Path(top) == self.root / "site/assets":
                if onerror is not None:
                    onerror(PermissionError(13, "injected directory walk denial", str(top)))
                return iter(())
            return original_walk(top, followlinks=followlinks, onerror=onerror)

        with patch.object(runner.os, "walk", deny_directory):
            exit_code, report = self.run_fixture_main(check)
        self.assertTrue(report["checks"][0]["executed"])
        self.assertEqual(report["checks"][0]["status"], "PASS")
        for key in ["inputs_before", "inputs_after"]:
            self.assertTrue(any("injected directory walk denial" in error for error in report[key]["errors"]))
        self.assertFalse(report["evidence_stable"])
        self.assertEqual(report["summary"]["status"], "BLOCKED")
        self.assertEqual(exit_code, 2)

    def test_summary_distinguishes_executed_scripts_cases_and_blocked(self):
        passed = self.execute("print('DONE')\n")
        blocked = {**passed, "status": "BLOCKED", "executed": False, "unittest_cases_reported": None}
        failed = {**passed, "status": "FAIL"}
        summary = runner.summarize([passed, blocked])
        self.assertEqual(summary["selected_checks"], 2)
        self.assertEqual(summary["executed_check_scripts"], 1)
        self.assertEqual(summary["unittest_cases_reported"], 0)
        self.assertIsNone(summary["node_internal_assertion_count"])
        self.assertEqual(summary["exit_code"], 2)
        self.assertEqual(runner.summarize([failed, blocked])["exit_code"], 1)
        self.assertEqual(runner.summarize([passed], evidence_stable=False)["exit_code"], 2)
        self.assertEqual(runner.summarize([passed])["exit_code"], 0)
        self.assertEqual(runner.summarize([])["status"], "BLOCKED")
        self.assertEqual(runner.summarize([])["exit_code"], 2)

    def test_profiles_do_not_silently_include_private_data_in_ci(self):
        for profile in ["quick", "ci", "windows", "r2_cas", "r2_integration"]:
            self.assertTrue(all(not check.private_data for check in runner.selected_checks(profile)))
        self.assertTrue(all(check.required for check in runner.CHECKS))
        self.assertEqual({check.id for check in runner.selected_checks("baseline")},
                         {"nai_default_tags_community", "search_benchmark", "search_legacy_comparison"})
        self.assertIn("nai_default_tags", runner.PROFILES["ci"])
        self.assertIn("search_benchmark_public", runner.PROFILES["ci"])
        self.assertIn("audit_entrypoints", runner.PROFILES["windows"])

    def test_r2_integration_keeps_old_readers_and_safety_checks(self):
        ids = set(runner.PROFILES["r2_integration"])
        self.assertTrue({"r2_publisher", "r2_pool", "r2_protocol", "r2_compat", "r2_verifier_safety",
                         "publish_safety", "publish_entrypoints", "data_source", "data_proxy", "share_backend",
                         "frontend_loading_recovery", "cache_buster"}.issubset(ids))
        by_id = {check.id: check for check in runner.CHECKS}
        for name in ("data_source", "data_proxy", "share_backend", "frontend_loading_recovery"):
            self.assertIn("site/assets/data-release.js", by_id[name].inputs)
        for name in ("data_proxy", "share_backend", "r2_compat"):
            self.assertIn("functions/_atlas_data.js", by_id[name].inputs)


if __name__ == "__main__":
    unittest.main()
