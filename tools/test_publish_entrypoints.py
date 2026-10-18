import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


@unittest.skipUnless(os.name == "nt", "Windows maintenance batch files")
class PublishBatchTests(unittest.TestCase):
    """Run the real entrypoints with fake executables; never call real Git/Python/R2.

    只钉两件事：发布程序那条链不碰数据；发布数据那条链的顺序是 同步图片 → 分享索引 → 发布。
    （2026-09-01 维护者定案删除程序兼容闸门，相关用例随之移除。）
    """

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
                        CALL_LOG=str(self.log))
        (self.root / "r2_config.json").write_text("{}", encoding="utf-8")
        (self.bin / "git.cmd").write_text('@echo off\necho git %*>>"%CALL_LOG%"\nexit /b 0\n', encoding="ascii")
        (self.bin / "python.cmd").write_text(
            '@echo off\necho python %*>>"%CALL_LOG%"\n'
            'if "%~1"=="tools\\sync_r2.py" if defined SYNC_EXIT exit /b %SYNC_EXIT%\n'
            'if "%~1"=="tools\\build_share_index.py" if defined BUILD_EXIT exit /b %BUILD_EXIT%\n'
            'exit /b 0\n', encoding="ascii")

    def run_batch(self, name):
        wrapper = self.root / "run.cmd"
        wrapper.write_text('@echo off\nchcp 936 >nul\ncall "' + str(self.batch_dir / name) + '" --inner\n'
                           'set "RESULT=%ERRORLEVEL%"\nchcp > codepage.txt\nexit /b %RESULT%\n', encoding="gbk")
        completed = subprocess.run([str(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe"),
                                    "/d", "/c", str(wrapper)],
                                   cwd=self.root, env=self.env, capture_output=True, timeout=15)
        return completed.returncode, self.log.read_text(encoding="utf-8")

    def test_program_publish_never_uploads_data(self):
        code, calls = self.run_batch("发布.bat")
        self.assertEqual(code, 0)
        self.assertIn("git push", calls)
        self.assertNotIn("python", calls)

    def test_data_entrypoint_preserves_the_upload_order(self):
        code, calls = self.run_batch("发布数据.bat")
        self.assertEqual(code, 0)
        positions = [calls.index(action) for action in
                     ("sync_r2.py", "build_updates_index.py", "build_share_index.py",
                      "build_tag_zh.py", "build_artist_index.py", "--publish")]
        self.assertEqual(positions, sorted(positions))
        self.assertNotIn("git", calls)

    def test_missing_remote_media_exit_stops_all_publish_steps(self):
        self.env["SYNC_EXIT"] = "1"
        code, calls = self.run_batch("发布数据.bat")
        self.assertEqual(code, 1)
        self.assertNotIn("build_updates_index.py", calls)
        self.assertNotIn("--publish", calls)

    def test_metadata_warning_still_publishes(self):
        self.env["SYNC_EXIT"] = "2"
        code, calls = self.run_batch("发布数据.bat")
        self.assertEqual(code, 0)
        self.assertIn("--publish", calls)

    def test_data_entrypoint_restores_gbk_on_success_and_failures(self):
        for sync_exit, build_exit in (("0", "0"), ("1", "0"), ("2", "1")):
            with self.subTest(sync_exit=sync_exit, build_exit=build_exit):
                self.env.update(SYNC_EXIT=sync_exit, BUILD_EXIT=build_exit)
                code, _calls = self.run_batch("发布数据.bat")
                self.assertEqual(code, 1 if "1" in (sync_exit, build_exit) else 0)
                self.assertIn(b"936", (self.root / "codepage.txt").read_bytes())


if __name__ == "__main__":
    unittest.main()
