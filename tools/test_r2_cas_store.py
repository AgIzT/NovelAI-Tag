"""Offline persistence and conditional-write checks using synthetic output fixtures."""
import concurrent.futures
import hashlib
import multiprocessing
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch

from tools.r2_cas_experiment.store import PreconditionFailed, SQLiteStore


ROOT = Path(__file__).resolve().parents[1]


def process_create(directory, barrier, results):
    store = SQLiteStore(directory)
    barrier.wait(timeout=15)
    try:
        store.create("data/race.json", b"winner", {})
        results.put("success")
    except PreconditionFailed:
        results.put("conflict")
    except Exception as exc:
        results.put(type(exc).__name__)


def process_replace(directory, etag, barrier, results):
    store = SQLiteStore(directory)
    barrier.wait(timeout=15)
    try:
        store.put("data/pointer.json", b"replacement", {}, etag)
        results.put("success")
    except PreconditionFailed:
        results.put("conflict")
    except Exception as exc:
        results.put(type(exc).__name__)


class SQLiteStoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / "output").mkdir(exist_ok=True)
        cls.fixtures = Path(tempfile.mkdtemp(prefix="r2-cas-store-tests-", dir=ROOT / "output"))

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="case-", dir=self.fixtures))
        self.store = SQLiteStore(self.directory)

    def test_create_conflict_preserves_record_and_metadata(self):
        metadata = {"content-type": "application/json"}
        record = self.store.create("data/example.json", b"{}", metadata)
        metadata["content-type"] = "changed"
        self.assertEqual(record.etag, hashlib.sha256(b"{}").hexdigest())
        self.assertEqual(self.store.get("data/example.json").metadata, {"content-type": "application/json"})
        with self.assertRaises(PreconditionFailed):
            self.store.create("data/example.json", b"changed", {})
        self.assertEqual(self.store.get("data/example.json").body, b"{}")
        self.assertEqual(self.store.metrics["create_attempts"], 2)
        self.assertEqual(self.store.metrics["create"], 1)
        self.assertEqual(self.store.metrics["bytes_written"], 2)

    def test_put_requires_absence_or_matching_etag(self):
        self.assertIsNone(self.store.get("data/pointer.json"))
        first = self.store.put("data/pointer.json", b"first", {}, None)
        for expected in (None, "incorrect"):
            with self.subTest(expected=expected), self.assertRaises(PreconditionFailed):
                self.store.put("data/pointer.json", b"bad", {}, expected)
        second = self.store.put("data/pointer.json", b"second", {"generation": "2"}, first.etag)
        self.assertEqual(self.store.get("data/pointer.json"), second)
        with self.assertRaises(PreconditionFailed):
            self.store.put("data/missing.json", b"bad", {}, first.etag)
        self.assertIsNone(self.store.get("data/missing.json"))

    def test_same_body_has_same_etag_after_conditional_replace(self):
        first = self.store.create("data/a.json", b"same", {})
        second = self.store.put("data/a.json", b"same", {"different": "metadata"}, first.etag)
        self.assertEqual(first.etag, second.etag)
        self.assertEqual(second.etag, self.store.create("data/b.json", b"same", {}).etag)

    def test_persistent_reopen_and_unicode_key(self):
        record = self.store.create("data/合成.json", b"fixture", {"purpose": "synthetic"})
        reopened = SQLiteStore(self.directory)
        self.assertEqual(reopened.get("data/合成.json"), record)
        self.assertEqual(reopened.metrics["bytes_written"], 0)

    def test_thread_race_only_one_create_succeeds(self):
        barrier = threading.Barrier(2)
        def write():
            barrier.wait(timeout=10)
            try:
                self.store.create("data/thread.json", b"same", {})
                return "success"
            except PreconditionFailed:
                return "conflict"
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(lambda _n: write(), range(2)))
        self.assertCountEqual(outcomes, ["success", "conflict"])
        self.assertEqual(self.store.metrics["create"], 1)

    def test_process_race_only_one_create_succeeds(self):
        self.assert_process_race(process_create, (str(self.directory),))
        self.assertEqual(self.store.get("data/race.json").body, b"winner")

    def test_simultaneous_initialization_and_create_are_safe(self):
        directory = self.directory / "new-store"
        self.assert_process_race(process_create, (str(directory),))
        self.assertEqual(SQLiteStore(directory).get("data/race.json").body, b"winner")

    def test_process_race_only_one_etag_replacement_succeeds(self):
        first = self.store.create("data/pointer.json", b"original", {})
        self.assert_process_race(process_replace, (str(self.directory), first.etag))
        self.assertEqual(self.store.get("data/pointer.json").body, b"replacement")

    def assert_process_race(self, target, arguments):
        context = multiprocessing.get_context("spawn")
        barrier = context.Barrier(2)
        results = context.Queue()
        processes = [context.Process(target=target, args=(*arguments, barrier, results)) for _ in range(2)]
        for process in processes:
            process.start()
        outcomes = [results.get(timeout=30) for _ in processes]
        for process in processes:
            process.join(timeout=30)
            self.assertEqual(process.exitcode, 0)
        self.assertCountEqual(outcomes, ["success", "conflict"])

    def test_invalid_keys_do_not_write_and_store_remains_readable(self):
        invalid = ("", "/absolute", "../outside", "a/../b", "a/./b", "a//b", "a/", "a\\b", "C:/outside", "%2e%2e/outside", "a/%252e%252e/b", "a\x00b", "https://example/x", " a")
        good = self.store.create("data/good.json", b"safe", {})
        for key in invalid:
            for operation in (lambda: self.store.get(key), lambda: self.store.create(key, b"bad", {}), lambda: self.store.put(key, b"bad", {}, None)):
                with self.subTest(key=key), self.assertRaises((ValueError, TypeError)):
                    operation()
        self.assertEqual(self.store.get("data/good.json"), good)
        self.assertEqual(self.store.metrics["bytes_written"], 4)

    def test_rejects_foreign_database_without_changing_bytes(self):
        directory = Path(tempfile.mkdtemp(prefix="foreign-", dir=self.fixtures))
        database = directory / "objects.sqlite3"
        with sqlite3.connect(database) as connection:
            connection.execute("CREATE TABLE user_data (value TEXT)")
            connection.execute("INSERT INTO user_data VALUES ('preserve')")
        before = database.read_bytes()
        with self.assertRaises(ValueError):
            SQLiteStore(directory)
        self.assertEqual(database.read_bytes(), before)

    def test_rejects_symlink_or_reparse_directory_and_database(self):
        from tools.r2_cas_experiment import store as module
        original = module._is_reparse
        for rejected in (self.directory, self.directory / "objects.sqlite3"):
            with self.subTest(path=str(rejected)), patch.object(module, "_is_reparse", side_effect=lambda path: Path(path) == rejected or original(path)):
                with self.assertRaises(ValueError):
                    SQLiteStore(self.directory)

    def test_failure_inside_transaction_rolls_back(self):
        from tools.r2_cas_experiment import store as module
        first = self.store.create("data/a.json", b"original", {})
        connect = sqlite3.connect
        class FailingConnection:
            def __init__(self, *args, **kwargs):
                self.inner = connect(*args, **kwargs)
            def __getattr__(self, name):
                return getattr(self.inner, name)
            def execute(self, query, *args):
                result = self.inner.execute(query, *args)
                if query.startswith("UPDATE objects"):
                    raise RuntimeError("synthetic failure after writing")
                return result
        with patch.object(module.sqlite3, "connect", FailingConnection):
            with self.assertRaises(RuntimeError):
                self.store.put("data/a.json", b"changed", {}, first.etag)
        self.assertEqual(self.store.get("data/a.json"), first)
        self.store.put("data/a.json", b"valid", {}, first.etag)
        self.assertEqual(self.store.get("data/a.json").body, b"valid")

    def test_body_and_metadata_types_are_strict(self):
        for body, metadata in (("text", {}), (b"ok", {"key": 1}), (b"ok", {1: "value"}), (b"ok", [])):
            with self.subTest(body=body, metadata=metadata), self.assertRaises((TypeError, ValueError)):
                self.store.create("data/invalid.json", body, metadata)
        self.assertIsNone(self.store.get("data/invalid.json"))


if __name__ == "__main__":
    unittest.main()
