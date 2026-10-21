"""Reproducible local v1/v2 comparison. This module has no R2 transport."""

import argparse
from collections import Counter
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import platform
import socket
import sys
import time
from unittest.mock import patch

from . import protocol as p
from .publisher import (ROOT, activate, build_plan, freeze_data, publish, read_release,
                        safe_output, verify_release)
from .store import SQLiteStore
from tools import publish_data_r2 as v1


class LocalV1Client:
    """Run the unmodified v1 algorithm against the same kind of local test store."""
    def __init__(self, store):
        self.store = store
        self.calls = Counter()

    def head_metadata(self, key):
        self.calls["HEAD"] += 1
        record = self.store.get(key)
        return ({"size": len(record.body), **record.metadata} if record else None)

    def put_file(self, key, item, cache_control):
        self.calls["PUT_FILE"] += 1
        body = item.path.read_bytes()
        if p.sha256(body) != item.sha256:
            raise ValueError("v1 fixture changed")
        self.store.create(key, body, {"sha256": item.sha256, "cache_control": cache_control,
                                     "content_type": v1.guess_type(item.path)})

    def copy_file(self, source_key, key, item, cache_control):
        self.calls["COPY"] += 1
        record = self.store.get(source_key)
        if record is None:
            raise ValueError("v1 source is missing")
        self.store.create(key, record.body, {"sha256": item.sha256, "cache_control": cache_control,
                                            "content_type": v1.guess_type(item.path)})

    def put_bytes(self, key, body, cache_control):
        self.calls["PUT_MANIFEST"] += 1
        self.store.create(key, body, {"sha256": p.sha256(body), "cache_control": cache_control,
                                     "content_type": p.JSON_TYPE})

    def get_json_snapshot(self, key):
        self.calls["GET_JSON"] += 1
        record = self.store.get(key)
        return (p.parse_json(record.body), record.etag) if record else (None, None)

    def get_json(self, key):
        return self.get_json_snapshot(key)[0]

    def put_pointer(self, key, body, expected_etag):
        self.calls["PUT_POINTER"] += 1
        self.store.put(key, body, {"sha256": p.sha256(body), "cache_control": "no-store",
                                  "content_type": p.JSON_TYPE}, expected_etag)


def synthetic_source(directory):
    directory.mkdir()
    values = {
        "codexes.json": [{"id": "demo"}], "demo.json": {"id": "demo", "entries": []},
        "about.json": {"text": "offline experiment"}, "announcements.json": [],
        "media.json": {}, "strings_index.json": {}, "strings.json": {},
        "updates.json": {"schema": 1, "generatedAt": "fixed", "batches": []},
        "share-index.json": {"codexes": {"demo": {"id": "demo", "shareable": True}}},
        "share/demo.json": {"id": "demo"},
    }
    for logical, value in values.items():
        target = directory / logical
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(p.json_bytes(value))
    return directory


def measure(store, callback, client=None):
    before = dict(store.metrics)
    calls = dict(client.calls) if client else {}
    started = time.perf_counter()
    with redirect_stdout(io.StringIO()):
        value = callback()
    result = {key: number - before[key] for key, number in store.metrics.items()}
    result["local_seconds"] = round(time.perf_counter() - started, 6)
    if client:
        result["logical_requests"] = {key: number - calls.get(key, 0) for key, number in client.calls.items()}
    result["result"] = value
    return result


def run_lab(output, source=None):
    source_files = sorted(Path(__file__).parent.glob("*.py")) + [
        Path(__file__).parent / "reader.mjs", ROOT / "tools" / "publish_data_r2.py", ROOT / "tools" / "sync_r2.py",
    ]
    source_hashes = {path.relative_to(ROOT).as_posix(): p.sha256(path.read_bytes()) for path in source_files}
    output = safe_output(output, fresh=True)
    output.mkdir(parents=True)
    source = Path(source).absolute() if source else synthetic_source(output / "synthetic-source")
    started = time.perf_counter()
    snapshot_a = freeze_data(source, output / "snapshot-a")
    a = build_plan(snapshot_a)
    old_a = v1.build_release_plan(snapshot_a)  # Existing data-contract validator, no configuration loaded.
    freeze_seconds = time.perf_counter() - started
    source_b = output / "synthetic-change-source"
    source_b.mkdir()
    for logical, body in a.files.items():
        target = source_b / logical
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
    about = p.parse_json(a.files["about.json"])
    if not isinstance(about, dict):
        raise ValueError("experiment requires about.json to be an object")
    about["_r2CasExperiment"] = "isolated single-file change"
    (source_b / "about.json").write_bytes(p.json_bytes(about))
    snapshot_b = freeze_data(source_b, output / "snapshot-b")
    b = build_plan(snapshot_b)
    old_b = v1.build_release_plan(snapshot_b)
    changed = [name for name in a.files if a.files[name] != b.files[name]]
    if changed != ["about.json"]:
        raise AssertionError("single-file comparison input is not controlled")

    legacy_store = SQLiteStore(output / "v1-store")
    store = SQLiteStore(output / "v2-store")
    legacy = LocalV1Client(legacy_store)
    scenarios = []
    for name, plan, old_plan in (("first", a, old_a), ("no_change", a, old_a), ("one_file_change", b, old_b)):
        old_result = measure(legacy_store, lambda: v1.publish_release(legacy, old_plan), legacy)
        result = measure(store, lambda: publish(store, plan))
        # Check all logical bytes after every scenario, not just object counts.
        for logical, body in plan.files.items():
            if read_release(store, plan.release, logical) != body:
                raise AssertionError("v2 logical bytes differ")
            old_record = legacy_store.get(f"data/releases/{old_plan.release}/{logical}")
            if old_record is None or old_record.body != body:
                raise AssertionError("v1 logical bytes differ")
        scenarios.append({"name": name, "v1": old_result, "v2": result})

    # Reopen persisted storage before rollback; no source files are needed by activate/read.
    reopened = SQLiteStore(output / "v2-store")
    rollback = measure(reopened, lambda: activate(reopened, a.release))
    for logical, body in a.files.items():
        if read_release(reopened, a.release, logical) != body:
            raise AssertionError("rollback did not restore exact logical bytes")
    verify_release(reopened, b.release)
    if scenarios[1]["v2"]["bytes_written"] != 0 or scenarios[1]["v2"]["put_attempts"] != 0:
        raise AssertionError("no-op wrote storage")
    if scenarios[2]["v2"]["result"]["uploaded"] != 1:
        raise AssertionError("single-file delta did not create exactly one content object")

    (output / "manifest-a.json").write_bytes(p.json_bytes(a.manifest))
    (output / "manifest-b.json").write_bytes(p.json_bytes(b.manifest))
    report = {
        "status": "PASS", "scope": "offline SQLite model; no production data writes or network",
        "python": platform.python_version(), "logical_files": len(a.files),
        "unique_content_objects": len({meta["sha256"] for meta in a.manifest["files"].values()}),
        "input_bytes": sum(len(body) for body in a.files.values()), "input_content_hash": a.manifest["contentHash"],
        "changed_paths": changed, "freeze_and_validation_seconds": round(freeze_seconds, 6),
        "source_hashes_before": source_hashes,
        "source_hashes_after": {path.relative_to(ROOT).as_posix(): p.sha256(path.read_bytes()) for path in source_files},
        "scenarios": scenarios, "rollback_after_reopen": rollback,
        "boundaries": ["No production credentials/configuration loaded", "No network transport exists in this prototype",
                       "v1 and v2 use local SQLite; byte counters describe storage writes, not upload bandwidth",
                       "No claim of R2 latency, SDK connection pooling, live CORS or old-client deployment acceptance",
                       "Full media synchronization and v1 compatibility dual-write cost are outside this JSON model"],
    }
    if report["source_hashes_after"] != source_hashes:
        raise RuntimeError("experiment source changed during the run; comparison is not stable")
    (output / "report.json").write_bytes(p.json_bytes(report))
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description="Offline-only R2 CAS experiment; never reads r2_config.json")
    parser.add_argument("--output-dir", required=True, type=Path, help="New directory below project output")
    parser.add_argument("--source", type=Path, help="Read local site/data or an isolated output fixture; default synthetic")
    args = parser.parse_args(argv)
    # Also fail closed if an accidental import/extension later tries to use the network/config loader.
    with patch.object(socket, "socket", side_effect=RuntimeError("network forbidden in local experiment")), \
         patch("tools.sync_r2.load_config", side_effect=RuntimeError("production configuration forbidden")), \
         patch.object(v1, "load_config", side_effect=RuntimeError("production configuration forbidden")), \
         patch.object(v1, "R2DataClient", side_effect=RuntimeError("R2 transport forbidden")):
        report = run_lab(args.output_dir, args.source)
    print(json.dumps({"status": report["status"], "files": report["logical_files"],
                      "input_bytes": report["input_bytes"], "report": str(args.output_dir / "report.json")}, ensure_ascii=True))
    return 0
