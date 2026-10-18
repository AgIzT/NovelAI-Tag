"""Exercise engineering-check BAT dispatch with fake Python; never run maintenance."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.name == "nt", "Windows BAT entrypoints require Windows")
class AuditEntrypointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="audit-entrypoints-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.single = self.root / "single"
        self.single.mkdir()
        self.entry = self.single / "checks.bat"
        shutil.copyfile(ROOT / "单项工具" / "工程自检.bat", self.entry)
        self.fake = self.root / "fake python.cmd"
        self.fake.write_text(
            '@echo off\necho %*>>"%CALL_LOG%"\nexit /b %FAKE_RESULT%\n',
            encoding="ascii",
        )
        self.log = self.root / "calls.log"
        self.cmd = str(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe")
        self.env = {
            key: value for key, value in os.environ.items()
            if key.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "PATHEXT"}
        }
        self.env.update(
            PATH=str(Path(os.environ["SystemRoot"]) / "System32"),
            PYTHON_EXE=str(self.fake), CALL_LOG=str(self.log), FAKE_RESULT="0",
        )

    def execute(self, command, *, stdin=None):
        return subprocess.run(
            [self.cmd, "/d", "/c", command], cwd=self.root, env=self.env,
            input=stdin, capture_output=True, timeout=15,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )

    def test_return_code_and_code_page_survive_fake_python(self):
        wrapper = self.root / "invoke.cmd"
        wrapper.write_text(
            '@echo off\ncall single\\checks.bat --no-pause\n'
            'set "CHECK_RC=%ERRORLEVEL%"\nchcp > codepage.txt\nexit /b %CHECK_RC%\n',
            encoding="ascii",
        )
        for result in (0, 1, 2):
            with self.subTest(result=result):
                self.env["FAKE_RESULT"] = str(result)
                completed = self.execute(str(wrapper))
                self.assertEqual(completed.returncode, result, completed.stderr)
                self.assertIn(b"936", (self.root / "codepage.txt").read_bytes())
        calls = self.log.read_text(encoding="ascii").splitlines()
        self.assertEqual(calls, ["-B tools\\run_project_checks.py --profile quick"] * 3)

    def test_missing_python_is_blocked_without_running_checks(self):
        self.env.pop("PYTHON_EXE")
        completed = self.execute(str(self.entry) + " --no-pause")
        self.assertEqual(completed.returncode, 2)
        self.assertIn(b"BLOCKED", completed.stdout)
        self.assertFalse(self.log.exists())

    def test_menu_action_delegates_to_single_action(self):
        menu = self.root / "menu.bat"
        source = (ROOT / "法典图鉴.bat").read_bytes()
        decoded = source.decode("gbk")
        self.assertEqual(decoded.encode("gbk"), source)
        self.assertIn('if "%c%"=="17" goto act_project_checks', decoded)
        # Execute the actual action and shared dispatcher, avoiding interactive
        # SET /P, whose console input is not available on headless CI runners.
        action = re.search(r"(?ms)^:act_project_checks\r?\n(.*?)(?=^:[a-z])", decoded)
        dispatch = re.search(r"(?ms)^:run\r?\n(.*?^exit /b 0)", decoded)
        self.assertIsNotNone(action)
        self.assertIsNotNone(dispatch)
        harness = (
            '@echo off\r\nchcp 936 >nul\r\ncd /d "%~dp0"\r\ngoto act_project_checks\r\n'
            ':act_project_checks\r\n' + action.group(1)
            + ':menu\r\nexit /b 0\r\n:run\r\n' + dispatch.group(1) + '\r\n'
        )
        menu.write_bytes(harness.encode("gbk"))
        action_dir = self.root / "单项工具"
        action_dir.mkdir()
        (action_dir / "工程自检.bat").write_text(
            '@echo off\necho audit>>"%CALL_LOG%"\nexit /b 0\n', encoding="ascii",
        )
        completed = self.execute(str(menu))
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(self.log.read_text(encoding="ascii").strip(), "audit")


if __name__ == "__main__":
    unittest.main()
