"""Offline publisher prototype. All storage is supplied explicitly by the caller."""

from dataclasses import dataclass
from datetime import datetime, timezone
import os
from pathlib import Path
import stat
from types import MappingProxyType
import uuid

from . import protocol as p
from .store import PreconditionFailed

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "output"
SNAPSHOT_MARKER = "_SNAPSHOT"


def reject_links(path):
    path = Path(path).absolute()
    for part in (path, *path.parents):
        if part.exists() or part.is_symlink():
            info = part.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ValueError("symlink or reparse path is not allowed")
    return path


def safe_output(path, *, fresh=False):
    path = reject_links(path)
    if not path.resolve().is_relative_to(OUTPUT.resolve()) or path.resolve() == OUTPUT.resolve():
        raise ValueError("experiment writes must stay below project output")
    if fresh and path.exists():
        raise ValueError("output target already exists")
    return path


def json_paths(directory):
    directory = reject_links(directory)
    result = {}
    for parent, dirs, files in os.walk(directory, followlinks=False):
        for name in dirs + files:
            reject_links(Path(parent) / name)
        for name in files:
            if name.endswith(".json"):
                path = Path(parent) / name
                logical = path.relative_to(directory).as_posix()
                p.valid_path(logical)
                result[logical] = path
    return dict(sorted(result.items()))


def freeze_data(source, target):
    source = reject_links(source).resolve()
    target = safe_output(target, fresh=True)
    if not source.is_dir() or not (source == ROOT / "site" / "data" or source.is_relative_to(OUTPUT.resolve())):
        raise ValueError("source must be local site/data or an isolated output fixture")
    if target.resolve().is_relative_to(source) or source.is_relative_to(target.resolve()):
        raise ValueError("snapshot must be separate from source")
    paths = json_paths(source)
    if not paths:
        raise ValueError("empty snapshot")
    initial_stats = {name: (path.stat().st_size, path.stat().st_mtime_ns) for name, path in paths.items()}
    if any(not 1 <= size <= p.MAX_SIZE for size, _mtime in initial_stats.values()):
        raise ValueError("invalid source object size")
    target.mkdir(parents=True)
    files = {}
    for name, path in paths.items():
        body = path.read_bytes()
        p.parse_json(body)
        files[name] = {"sha256": p.sha256(body), "size": len(body)}
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("xb") as stream:
            stream.write(body)
    if set(json_paths(source)) != set(paths):
        raise ValueError("source file collection changed while freezing")
    for name, path in paths.items():
        current = (path.stat().st_size, path.stat().st_mtime_ns)
        if current != initial_stats[name] or p.sha256(path.read_bytes()) != files[name]["sha256"]:
            raise ValueError("source changed while freezing")
    # A failed/partial copy has no completion marker and cannot become a plan.
    manifest = p.make_manifest(files)
    with (target / SNAPSHOT_MARKER).open("xb") as stream:
        stream.write(p.json_bytes(manifest))
    return target


@dataclass(frozen=True)
class Plan:
    directory: Path
    files: object
    manifest: dict

    @property
    def release(self):
        return self.manifest["release"]


def build_plan(snapshot):
    snapshot = reject_links(snapshot)
    expected = p.parse_manifest_bytes((snapshot / SNAPSHOT_MARKER).read_bytes())
    files = {}
    for name, path in json_paths(snapshot).items():
        body = path.read_bytes()
        p.parse_json(body)
        files[name] = body
    actual = p.make_manifest({name: {"sha256": p.sha256(body), "size": len(body)}
                              for name, body in files.items()})
    if actual != expected:
        raise ValueError("snapshot changed after freezing")
    return Plan(snapshot, MappingProxyType(files), actual)


def stable_updates(candidate, existing_bytes=None):
    """Preserve the exact old bytes when generatedAt is the only difference."""
    if not isinstance(candidate, dict):
        raise ValueError("update index must be an object")
    if existing_bytes is not None:
        existing = p.parse_json(existing_bytes)
        if isinstance(existing, dict):
            previous = {key: value for key, value in existing.items() if key != "generatedAt"}
            proposed = {key: value for key, value in candidate.items() if key != "generatedAt"}
            if previous == proposed:
                return existing_bytes
    return p.json_bytes(candidate)


def metadata(body, cache=p.IMMUTABLE_CACHE):
    return {"sha256": p.sha256(body), "content_type": p.JSON_TYPE, "cache_control": cache}


def verify_record(record, body=None, *, size=None, digest=None):
    if record is None:
        raise ValueError("required object is missing")
    if body is not None:
        size, digest = len(body), p.sha256(body)
    if len(record.body) != size or p.sha256(record.body) != digest:
        raise ValueError("object bytes do not match content identity")
    if record.metadata != metadata(record.body):
        raise ValueError("object metadata conflict")


def ensure_immutable(store, key, body):
    record = store.get(key)
    if record is not None:
        verify_record(record, body)
        return False
    try:
        store.create(key, body, metadata(body))
    except (PreconditionFailed, OSError):
        # Conditional-create conflict or lost response can be resolved by exact bytes.
        record = store.get(key)
        if record is None:
            raise
        verify_record(record, body)
        return False
    verify_record(store.get(key), body)
    return True


def read_manifest(store, release):
    record = store.get(p.manifest_key(release))
    if record is None:
        raise ValueError("release manifest is missing")
    manifest = p.parse_manifest_bytes(record.body)
    if manifest["release"] != release:
        raise ValueError("release manifest identity mismatch")
    verify_record(record, p.json_bytes(manifest))
    return manifest


def verify_release(store, release):
    manifest = read_manifest(store, release)
    seen = set()
    for meta in manifest["files"].values():
        key = p.object_key(meta["sha256"])
        if key not in seen:
            verify_record(store.get(key), size=meta["size"], digest=meta["sha256"])
            seen.add(key)
    return manifest


def read_release(store, release, logical):
    p.valid_path(logical)
    manifest = read_manifest(store, release)
    if logical not in manifest["files"]:
        raise ValueError("file is not in the selected release")
    meta = manifest["files"][logical]
    record = store.get(p.object_key(meta["sha256"]))
    verify_record(record, size=meta["size"], digest=meta["sha256"])
    return record.body


def pointer_snapshot(store):
    record = store.get(p.CURRENT_KEY)
    return (p.validate_pointer(p.parse_json(record.body)), record) if record else ({}, None)


def switch_pointer(store, manifest, previous, snapshot):
    release = manifest["release"]
    if previous.get("release") == release:
        current = store.get(p.CURRENT_KEY)
        if current != snapshot:
            raise PreconditionFailed("current pointer changed during no-op verification")
        return {"pointer": previous, "unchanged": True}
    pointer = {"schemaVersion": 2, "release": release,
               "contentHash": manifest["contentHash"], "manifest": p.manifest_key(release),
               "publishedAt": datetime.now(timezone.utc).isoformat(), "operationId": uuid.uuid4().hex}
    if previous.get("release"):
        pointer["previousRelease"] = previous["release"]
    body = p.json_bytes(pointer)
    try:
        store.put(p.CURRENT_KEY, body, metadata(body, "no-store"), snapshot.etag if snapshot else None)
    except PreconditionFailed:
        raise
    except Exception as ex:
        raise RuntimeError("current pointer write outcome unknown; inspect local store before retry") from ex
    if store.get(p.CURRENT_KEY).body != body:
        raise RuntimeError("current pointer verification failed")
    return {"pointer": pointer, "unchanged": False}


def publish(store, plan):
    expected = p.make_manifest({path: {"sha256": p.sha256(body), "size": len(body)}
                              for path, body in plan.files.items()})
    if p.validate_manifest(plan.manifest) != expected:
        raise ValueError("plan bytes changed")
    previous, snapshot = pointer_snapshot(store)
    counts = {"uploaded": 0, "reused": 0, "logical_files": len(plan.files), "copied": 0}
    unique = {p.sha256(body): body for body in plan.files.values()}
    if previous.get("release") == plan.release:
        if verify_release(store, plan.release) != expected:
            raise ValueError("current release differs from plan")
        counts["reused"] = len(unique)
    else:
        for digest, body in sorted(unique.items()):
            created = ensure_immutable(store, p.object_key(digest), body)
            counts["uploaded" if created else "reused"] += 1
        ensure_immutable(store, p.manifest_key(plan.release), p.json_bytes(expected))
        verify_release(store, plan.release)
    return {**counts, **switch_pointer(store, expected, previous, snapshot)}


def activate(store, release):
    previous, snapshot = pointer_snapshot(store)
    manifest = verify_release(store, release)
    return switch_pointer(store, manifest, previous, snapshot)
