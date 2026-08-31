import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from tools.program_compatibility import (
    BROWSER_CACHE_SECONDS, ProgramCompatibilityError, ensure_program_ready, required_program_files,
)


class ProgramCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.site = self.root / "site"
        self.file = self.site / "assets" / "app" / "codex-ui.js"
        self.file.parent.mkdir(parents=True)
        self.file.write_bytes(b"const compatible = true;\r\n")
        self.files = ("assets/app/codex-ui.js",)
        self.record = self.root / "observation.json"
        self.start = 1800000000
        self.fetch = Mock(return_value=(b"const compatible = true;\n", "max-age=14400"))

    def check(self, now, **kwargs):
        return ensure_program_ready(self.files, site_dir=self.site, observation_path=self.record,
                                    fetch_file=self.fetch, now=now, **kwargs)

    def begin_wait(self):
        with self.assertRaisesRegex(ProgramCompatibilityError, "Existing browser caches"):
            self.check(self.start)

    def test_legacy_data_needs_no_program_probe(self):
        self.assertEqual(required_program_files([{"id": "old", "type": "string"}]), ())
        result = ensure_program_ready((), fetch_file=self.fetch, observation_path=self.record)
        self.assertTrue(result["ready"])
        self.fetch.assert_not_called()
        self.assertFalse(self.record.exists())

    def test_known_new_shapes_and_unknown_types_are_guarded(self):
        self.assertEqual(required_program_files([{"id": "new", "type": "composition"}]), self.files)
        for meta in ({"id": "nai45_community_pack"},
                     {"id": "artist_nai45_personal", "aliases": ["artist_nai45_strings"]}):
            with self.subTest(meta=meta):
                files = required_program_files([meta])
                self.assertIn("assets/app/favorites-backup-core.js", files)
                self.assertIn("assets/app.js", files)
                self.assertIn("assets/app/history.js", files)
                self.assertIn("assets/app/codex-route-compat.js", files)
        with self.assertRaisesRegex(ValueError, "unsupported codex types"):
            required_program_files([{"id": "unknown", "type": "typo"}])

    def test_entire_existing_cache_window_must_pass(self):
        self.begin_wait()
        with self.assertRaises(ProgramCompatibilityError):
            self.check(self.start + BROWSER_CACHE_SECONDS - 1)
        self.assertTrue(self.check(self.start + BROWSER_CACHE_SECONDS)["ready"])
        self.assertEqual(json.loads(self.record.read_text())["firstObservedAt"], self.start)
        self.assertEqual(self.fetch.call_count, 3, "每次都重新核对生产，不能只信本地计时记录")

    def test_mismatch_or_unavailable_program_resets_wait(self):
        for failure in (False, True):
            with self.subTest(network_failure=failure):
                self.fetch.side_effect = None
                self.fetch.return_value = (b"const compatible = true;\n", "max-age=14400")
                self.begin_wait()
                if failure:
                    self.fetch.side_effect = OSError("network down")
                else:
                    self.fetch.return_value = (b"const compatible = false;\n", "max-age=14400")
                with self.assertRaisesRegex(ProgramCompatibilityError, "Deploy the compatible program first"):
                    self.check(self.start + BROWSER_CACHE_SECONDS)
                self.assertEqual(json.loads(self.record.read_text()), {})
                self.fetch.side_effect = None
                self.fetch.return_value = (b"const compatible = true;\n", "max-age=14400")
                with self.assertRaises(ProgramCompatibilityError):
                    self.check(self.start + BROWSER_CACHE_SECONDS + 1)

    def test_new_program_bytes_or_origin_start_new_wait(self):
        self.begin_wait()
        self.file.write_bytes(b"const compatible = 'new';\n")
        self.fetch.return_value = (self.file.read_bytes(), "no-cache")
        with self.assertRaises(ProgramCompatibilityError):
            self.check(self.start + BROWSER_CACHE_SECONDS)
        self.assertEqual(json.loads(self.record.read_text())["firstObservedAt"], self.start + BROWSER_CACHE_SECONDS)
        with self.assertRaises(ProgramCompatibilityError):
            self.check(self.start + 2 * BROWSER_CACHE_SECONDS, site_origin="https://other.example")

    def test_shorter_headers_do_not_expire_previously_stored_responses(self):
        self.fetch.return_value = (self.file.read_bytes(), "public, max-age=28800")
        self.begin_wait()
        self.fetch.return_value = (self.file.read_bytes(), "no-cache")
        with self.assertRaises(ProgramCompatibilityError):
            self.check(self.start + BROWSER_CACHE_SECONDS)
        self.assertTrue(self.check(self.start + 28800)["ready"])

    def test_broken_record_and_clock_reversal_restart_wait(self):
        self.record.write_text("{broken", encoding="utf-8")
        self.begin_wait()
        with self.assertRaises(ProgramCompatibilityError):
            self.check(self.start - 1)
        self.assertEqual(json.loads(self.record.read_text())["firstObservedAt"], self.start - 1)
        record = json.loads(self.record.read_text())
        record["firstObservedAt"] = True
        self.record.write_text(json.dumps(record), encoding="utf-8")
        with self.assertRaises(ProgramCompatibilityError):
            self.check(self.start + BROWSER_CACHE_SECONDS)


@unittest.skipUnless(os.name == "nt", "Windows maintenance batch files")
class PublishBatchTests(unittest.TestCase):
    """Run the real entrypoints with fake executables; never call real Git/Python/R2."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.batch_dir = self.root / "single"
        self.batch_dir.mkdir()
        source = Path(__file__).resolve().parents[1] / "单项工具"
        for name in ("发布.bat", "发布数据.bat"):
            shutil.copy2(source / name, self.batch_dir / name)
        self.log = self.root / "calls.log"
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + str(Path(os.environ["SystemRoot"]) / "System32"),
                        CALL_LOG=str(self.log), PROGRAM_CHECK_RC="0")
        (self.root / "r2_config.json").write_text("{}", encoding="utf-8")
        (self.bin / "git.cmd").write_text('@echo off\necho git %*>>"%CALL_LOG%"\nexit /b 0\n', encoding="ascii")
        (self.bin / "python.cmd").write_text(
            '@echo off\necho python %*>>"%CALL_LOG%"\n'
            'if "%~2"=="--check-program" exit /b %PROGRAM_CHECK_RC%\nexit /b 0\n', encoding="ascii")

    def run_batch(self, name):
        completed = subprocess.run([str(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe"),
                                    "/d", "/c", str(self.batch_dir / name), "--inner"],
                                   cwd=self.root, env=self.env, capture_output=True, timeout=15)
        return completed.returncode, self.log.read_text(encoding="utf-8")

    def test_program_publish_never_uploads_data(self):
        code, calls = self.run_batch("发布.bat")
        self.assertEqual(code, 0)
        self.assertIn("git push", calls)
        self.assertNotIn("python", calls)

    def test_not_ready_stops_data_entrypoint_before_any_upload(self):
        self.env["PROGRAM_CHECK_RC"] = "2"
        code, calls = self.run_batch("发布数据.bat")
        self.assertNotEqual(code, 0)
        self.assertIn("--check-program", calls)
        self.assertNotIn("sync_r2.py", calls)
        self.assertNotIn("--publish", calls)
        self.assertNotIn("git", calls)

    def test_ready_data_entrypoint_preserves_the_upload_order(self):
        code, calls = self.run_batch("发布数据.bat")
        self.assertEqual(code, 0)
        positions = [calls.index(action) for action in ("--check-program", "sync_r2.py", "build_share_index.py", "--publish")]
        self.assertEqual(positions, sorted(positions))
        self.assertNotIn("git", calls)


if __name__ == "__main__":
    unittest.main()
