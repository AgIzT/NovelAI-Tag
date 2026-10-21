"""Output isolation regression; no browser, production clients or real data."""
import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools import verify_r2_cas_integration as verifier


class VerificationOutputTests(unittest.TestCase):
    def setUp(self):
        parent = verifier.ROOT / "output" / "verification-safety-tests"
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()

    def test_existing_output_is_rejected_before_verification_or_overwriting_logs(self):
        out = self.root / "existing"
        out.mkdir()
        sentinel = out / "publisher-output.txt"
        sentinel.write_bytes(b"previous evidence")
        rejected = False
        with patch.object(verifier, "verify", side_effect=RuntimeError("fixture stop")) as work, contextlib.redirect_stdout(io.StringIO()):
            try:
                verifier.main(["--source", str(self.source), "--out-dir", str(out)])
            except RuntimeError:
                rejected = True
        self.assertEqual(sentinel.read_bytes(), b"previous evidence")
        self.assertTrue(rejected)
        work.assert_not_called()

    def test_output_root_and_outside_directory_are_rejected(self):
        for out in (verifier.OUTPUT, self.root.parent.parent.parent):
            with self.subTest(out=out), self.assertRaises(RuntimeError), contextlib.redirect_stdout(io.StringIO()):
                verifier.main(["--source", str(self.source), "--out-dir", str(out)])

    def test_parent_reparse_rejection_happens_before_output_creation(self):
        out = self.root / "fresh"
        original = verifier.no_links
        def reject(path):
            if Path(path) == out:
                raise ValueError("synthetic reparse point")
            return original(path)
        with patch.object(verifier, "no_links", reject), self.assertRaisesRegex(ValueError, "reparse"):
            verifier.main(["--source", str(self.source), "--out-dir", str(out)])
        self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
