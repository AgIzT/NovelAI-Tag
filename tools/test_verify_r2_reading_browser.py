"""Browser evidence output isolation; synthetic paths, no browser or network."""
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

# The pre-fix CLI script used standalone imports; keep red-phase import possible.
with patch.object(sys, 'path', [str(Path(__file__).resolve().parent), *sys.path]):
    from tools import verify_r2_reading_browser as verifier


class BrowserOutputTests(unittest.TestCase):
    def setUp(self):
        parent = Path(__file__).resolve().parents[1] / 'output' / 'verification-safety-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'output').mkdir()
        self.root_patch = patch.object(verifier, 'ROOT', self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def test_existing_output_preserves_sentinel(self):
        out = self.root / 'output' / 'existing'
        out.mkdir()
        sentinel = out / 'report.json'
        sentinel.write_bytes(b'previous evidence')
        with self.assertRaisesRegex((ValueError, RuntimeError, FileExistsError), 'exist|fresh|overwrite'):
            verifier.create_output_directory('output/existing')
        self.assertEqual(sentinel.read_bytes(), b'previous evidence')

    def test_output_root_and_external_are_rejected(self):
        for path in ('output', '.', self.root.parent / 'external'):
            with self.subTest(path=path), self.assertRaises((ValueError, RuntimeError)):
                verifier.create_output_directory(path)

    def test_reparse_ancestor_is_rejected_before_resolve_or_creation(self):
        parent = self.root / 'output' / 'linked'
        parent.mkdir()
        target = parent / 'fresh'
        original = Path.lstat

        def lstat(path, *args, **kwargs):
            if path == parent:
                return SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400)
            return original(path, *args, **kwargs)

        with patch.object(Path, 'lstat', lstat), self.assertRaisesRegex(ValueError, 'reparse|links'):
            verifier.create_output_directory(target)
        self.assertFalse(target.exists())

    def test_fresh_dedicated_child_is_created(self):
        out = verifier.create_output_directory('output/fresh')
        self.assertEqual(out, self.root / 'output/fresh')
        self.assertTrue(out.is_dir())

    def test_log_writes_cannot_replace_existing_file(self):
        target = self.root / 'output' / 'report.json'
        target.write_bytes(b'previous')
        with self.assertRaises(FileExistsError):
            verifier.write_text_once(target, 'new evidence')
        self.assertEqual(target.read_bytes(), b'previous')


if __name__ == '__main__':
    unittest.main()
