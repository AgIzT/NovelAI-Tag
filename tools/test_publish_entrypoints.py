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
            '@echo off\necho python %*>>"%CALL_LOG%"\nexit /b 0\n', encoding="ascii")

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

    def test_data_entrypoint_preserves_the_upload_order(self):
        code, calls = self.run_batch("发布数据.bat")
        self.assertEqual(code, 0)
        positions = [calls.index(action) for action in
                     ("sync_r2.py", "build_updates_index.py", "build_share_index.py", "--publish")]
        self.assertEqual(positions, sorted(positions))
        self.assertNotIn("git", calls)


if __name__ == "__main__":
    unittest.main()
