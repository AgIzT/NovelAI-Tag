"""Persistent local object store for offline experiments; no network backend."""
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import threading


_APPLICATION_ID = 0x4E415443
_SCHEMA = "CREATE TABLE objects (key TEXT PRIMARY KEY, body BLOB NOT NULL, metadata TEXT NOT NULL, etag TEXT NOT NULL)"
_DATABASE_NAME = "objects.sqlite3"


class PreconditionFailed(RuntimeError):
    """The object does not satisfy the caller's frozen write condition."""


@dataclass(frozen=True)
class ObjectRecord:
    body: bytes
    metadata: dict[str, str]
    etag: str


def _is_reparse(path):
    info = Path(path).lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _check_path(path, *, directory=False):
    try:
        info = path.lstat()
        reparse = _is_reparse(path)
    except FileNotFoundError:
        return
    if reparse:
        raise ValueError("local store paths must not be symlinks or reparse points")
    if directory and not stat.S_ISDIR(info.st_mode):
        raise ValueError("local store directory is not a directory")
    if not directory and not stat.S_ISREG(info.st_mode):
        raise ValueError("local store database is not a regular file")


def _validate_key(key):
    if not isinstance(key, str):
        raise TypeError("object key must be text")
    if (not key or key != key.strip() or len(key.encode("utf-8")) > 1024
            or any(character in key for character in "\\%:?#")
            or any(ord(character) < 32 or ord(character) == 127 for character in key)
            or any(part in ("", ".", "..") for part in key.split("/"))):
        raise ValueError("object key must be a safe relative POSIX path")


def _encode_metadata(metadata):
    if not isinstance(metadata, dict) or any(not isinstance(key, str) or not isinstance(value, str) for key, value in metadata.items()):
        raise TypeError("metadata must map text keys to text values")
    return json.dumps(metadata, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class SQLiteStore:
    """Each operation uses one immediate SQLite transaction, including its condition.

    Metrics are per instance. get/create/put count completed successful calls;
    attempts include invalid input and conflicts. bytes_written counts committed
    bodies only; bytes_read counts returned bodies, without metadata overhead.
    Content-derived ETags deliberately allow same-content ABA; pointer callers
    must include a unique operation ID in each new pointer body.
    """

    def __init__(self, directory):
        self.directory = Path(os.path.abspath(os.fspath(directory)))
        self.database = self.directory / _DATABASE_NAME
        self._metrics_lock = threading.Lock()
        self.metrics = {name: 0 for name in (
            "get", "get_attempts", "get_hits", "get_misses", "create", "create_attempts",
            "put", "put_attempts", "precondition_failed", "bytes_written", "bytes_read",
        )}
        self._check_directory()
        self.directory.mkdir(parents=True, exist_ok=True)
        self._check_directory()
        if not self.database.exists() and not self.database.is_symlink():
            self._initialize()
        self._check_database()
        with self._transaction():
            pass

    def _count(self, **counts):
        with self._metrics_lock:
            for name, count in counts.items():
                self.metrics[name] += count

    def _check_directory(self):
        for path in reversed((self.directory, *self.directory.parents)):
            _check_path(path, directory=True)

    def _check_database(self):
        self._check_directory()
        _check_path(self.database)
        for suffix in ("-journal", "-wal", "-shm"):
            _check_path(Path(str(self.database) + suffix))
        if not self.database.is_file():
            raise ValueError("local store database is missing")
        with self.database.open("rb") as source:
            header = source.read(100)
        if (len(header) != 100 or header[:16] != b"SQLite format 3\x00"
                or int.from_bytes(header[68:72], "big") != _APPLICATION_ID):
            raise ValueError("refusing a database not owned by the local CAS adapter")

    def _initialize(self):
        descriptor, temporary_name = tempfile.mkstemp(prefix=".cas-init-", suffix=".sqlite3", dir=self.directory)
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            connection = sqlite3.connect(temporary)
            try:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(f"PRAGMA application_id = {_APPLICATION_ID}")
                connection.execute("PRAGMA user_version = 1")
                connection.execute(_SCHEMA)
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
            finally:
                connection.close()
            self._check_directory()
            try:
                os.link(temporary, self.database)
            except FileExistsError:
                pass
        finally:
            temporary.unlink()

    @contextmanager
    def _transaction(self):
        self._check_database()
        connection = sqlite3.connect(self.database.as_uri() + "?mode=rw", uri=True, timeout=30)
        try:
            connection.execute("PRAGMA trusted_schema = OFF")
            connection.execute("BEGIN IMMEDIATE")
            application_id = connection.execute("PRAGMA application_id").fetchone()[0]
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            schema = connection.execute("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall()
            if application_id != _APPLICATION_ID or version != 1 or schema != [("table", "objects", _SCHEMA)]:
                raise ValueError("refusing an unrecognized local CAS database schema")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def get(self, key):
        self._count(get_attempts=1)
        _validate_key(key)
        with self._transaction() as connection:
            row = connection.execute("SELECT body, metadata, etag FROM objects WHERE key = ?", (key,)).fetchone()
            record = None if row is None else ObjectRecord(bytes(row[0]), json.loads(row[1]), row[2])
        self._count(get=1, get_hits=int(record is not None), get_misses=int(record is None), bytes_read=len(record.body) if record else 0)
        return record

    def create(self, key, body, metadata):
        self._count(create_attempts=1)
        return self._write(key, body, metadata, expected_etag=None, operation="create")

    def put(self, key, body, metadata, expected_etag):
        self._count(put_attempts=1)
        if expected_etag is not None and (not isinstance(expected_etag, str) or not expected_etag):
            raise TypeError("expected_etag must be nonempty text or None")
        return self._write(key, body, metadata, expected_etag=expected_etag, operation="put")

    def _write(self, key, body, metadata, *, expected_etag, operation):
        _validate_key(key)
        if not isinstance(body, bytes):
            raise TypeError("object body must be bytes")
        with self._transaction() as connection:
            row = connection.execute("SELECT etag FROM objects WHERE key = ?", (key,)).fetchone()
            if (row is not None and (expected_etag is None or row[0] != expected_etag)) or (row is None and expected_etag is not None):
                self._count(precondition_failed=1)
                raise PreconditionFailed("object write condition did not match")
            encoded_metadata = _encode_metadata(metadata)
            etag = hashlib.sha256(body).hexdigest()
            if row is None:
                connection.execute("INSERT INTO objects (key, body, metadata, etag) VALUES (?, ?, ?, ?)", (key, body, encoded_metadata, etag))
            else:
                connection.execute("UPDATE objects SET body = ?, metadata = ?, etag = ? WHERE key = ?", (body, encoded_metadata, etag, key))
            record = ObjectRecord(body, json.loads(encoded_metadata), etag)
        self._count(**{operation: 1, "bytes_written": len(body)})
        return record

    def close(self):
        """No persistent connections are held."""
