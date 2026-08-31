import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from tools.program_compatibility import (
    ProgramCompatibilityError, ensure_program_ready, required_program_files,
)


class ProgramCompatibilityTests(unittest.TestCase):
    """闸门只回答一个问题：正式域上部署的程序，是不是本地这一份。

    2026-09-01 起不再有等待窗口——形态升级时「先发程序、自己等 4 小时」是人的规程，
    工具不替你计时（原因见 program_compatibility 模块文档）。
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.site = self.root / "site"
        self.file = self.site / "assets" / "app" / "codex-ui.js"
        self.file.parent.mkdir(parents=True)
        self.file.write_bytes(b"const compatible = true;" + bytes([13, 10]))  # CRLF 本地
        self.files = ("assets/app/codex-ui.js",)
        self.fetch = Mock(return_value=(b"const compatible = true;" + bytes([10]), "max-age=14400"))  # LF 线上

    def check(self, **kwargs):
        return ensure_program_ready(self.files, site_dir=self.site, fetch_file=self.fetch, **kwargs)

    def test_legacy_data_needs_no_program_probe(self):
        self.assertEqual(required_program_files([{"id": "old", "type": "string"}]), ())
        result = ensure_program_ready((), fetch_file=self.fetch)
        self.assertTrue(result["ready"])
        self.fetch.assert_not_called()

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

    def test_deployed_program_matching_local_passes_immediately(self):
        """字节一致就放行——CRLF 与 LF 视为同一程序，且不再有任何等待。"""
        result = self.check()
        self.assertEqual(result, {"requiredFiles": list(self.files), "ready": True})

    def test_deployed_bytes_differing_stops_the_release(self):
        self.fetch.return_value = (b"const compatible = false;" + bytes([10]), "max-age=14400")
        with self.assertRaisesRegex(ProgramCompatibilityError, "deployed bytes differ"):
            self.check()

    def test_unreadable_program_file_stops_the_release(self):
        self.fetch.side_effect = TimeoutError("boom")
        with self.assertRaisesRegex(ProgramCompatibilityError, "unavailable"):
            self.check()

    def test_origin_must_be_a_bare_public_https_origin(self):
        for bad in ("http://novelai.quicktagcloud.com", "https://site/path", "https://u:p@site"):
            with self.subTest(origin=bad), self.assertRaisesRegex(ValueError, "site_origin"):
                self.check(site_origin=bad)


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
