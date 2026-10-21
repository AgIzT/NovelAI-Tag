"""Verify the active v1/v2 publisher against an explicitly supplied offline snapshot.

Only copies JSON into project output and writes a local SQLite object store.
All sockets, production clients and production configuration reads are forbidden.
"""
import argparse
from collections import Counter, defaultdict
from contextlib import ExitStack, redirect_stdout
import io
import json
from pathlib import Path
import platform
import re
import socket
import sys
import threading
import time
import traceback
import urllib.request
from unittest.mock import patch

if __package__:
    from . import publish_data_r2 as pub, r2_data_protocol as cas, sync_r2
    from . import r2_local_client
    from .r2_data_snapshot import no_links, source_files
else:
    import publish_data_r2 as pub
    import r2_data_protocol as cas
    import sync_r2
    import r2_local_client
    from r2_data_snapshot import no_links, source_files


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def write_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def inventory(directory):
    no_links(directory)
    return {name: {"size": path.stat().st_size, "sha256": pub.sha256_path(path)}
            for name, path in source_files(directory).items()}


def inventory_hash(files):
    return cas.sha256(cas.json_bytes(files))


def copy_snapshot(source, target):
    no_links(source)
    no_links(target)
    require(source.is_dir(), "offline source directory is missing")
    require(not target.exists(), "refusing to overwrite a previous verification input")
    files = inventory(source)
    require(files, "offline source is empty")
    target.mkdir(parents=True)
    for name, meta in files.items():
        cas.valid_path(name)
        body = (source / name).read_bytes()
        cas.parse_json(body)
        require(len(body) == meta["size"] and cas.sha256(body) == meta["sha256"],
                "source changed during copy: " + name)
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("xb") as stream:
            stream.write(body)
    require(inventory(source) == files == inventory(target), "snapshot copy did not match source")
    return files


def category(key):
    if key.endswith("/current.json"):
        return "pointer"
    if "/objects/sha256/" in key:
        return "v2_blob"
    if "/v2/releases/" in key:
        return "v2_manifest"
    if key.endswith("/manifest.json"):
        return "v1_manifest"
    return "v1_file"


class MeasuredLocalDataClient(r2_local_client.LocalDataClient):
    def __init__(self, directory):
        super().__init__(directory)
        self.write_events = []
        self._event_lock = threading.Lock()

    def _event(self, operation, key, body):
        with self._event_lock:
            self.write_events.append({"operation": operation, "category": category(key),
                                      "key": key, "bytes": len(body)})

    def _legacy_write(self, kind, key, body, cache_control, content_type=cas.JSON_TYPE):
        super()._legacy_write(kind, key, body, cache_control, content_type)
        self._event(kind, key, body)

    def create_bytes(self, key, body, cache_control):
        status = super().create_bytes(key, body, cache_control)
        if status in (200, 201):
            self._event("create", key, body)
        return status

    def put_pointer(self, key, body, expected_etag):
        super().put_pointer(key, body, expected_etag)
        self._event("pointer", key, body)


def step(client, report, label, action):
    before = dict(client.store.metrics)
    start = len(client.write_events)
    started = time.perf_counter()
    result = action()
    elapsed = time.perf_counter() - started
    delta = {key: value - before[key] for key, value in client.store.metrics.items()}
    events = client.write_events[start:]
    categories = defaultdict(lambda: {"operations": 0, "bytes": 0})
    for event in events:
        categories[event["category"]]["operations"] += 1
        categories[event["category"]]["bytes"] += event["bytes"]
    require(sum(event["bytes"] for event in events) == delta["bytes_written"],
            "instrumented write bytes differ from SQLite committed bodies")
    value = {"status": "PASS", "elapsed_seconds": elapsed, "store_metrics_delta": delta,
             "write_operations": dict(Counter(event["operation"] for event in events)),
             "writes_by_category": dict(categories), "write_events": events,
             "client_upload_body_bytes": sum(event["bytes"] for event in events if event["operation"] != "copy"),
             "server_copy_body_bytes": sum(event["bytes"] for event in events if event["operation"] == "copy"),
             "result": result}
    report["steps"][label] = value
    return value


def plans_for(data):
    # This is the same shared frozen directory the active --format dual CLI uses.
    with pub.frozen_data_directory(data) as frozen:
        yield pub.build_release_plan(frozen), pub.build_v2_release_plan(frozen)


def publish_dual(client, data, expected):
    with pub.frozen_data_directory(data) as frozen:
        v1, v2 = pub.build_release_plan(frozen), pub.build_v2_release_plan(frozen)
        require(v1.manifest["files"] == v2.manifest["files"] == expected,
                "dual manifests differ from the exact frozen input bytes")
        return pub.publish_dual_release(client, v1, v2)


def read_all(client, report, label, files, input_dir, v1_release, v2_release):
    v1_manifest = pub.load_remote_manifest(client, "data", v1_release)
    v2_manifest = pub.v2_module().load_manifest(client, "data", v2_release)
    require(v1_manifest["files"] == v2_manifest["files"] == files, "stored manifests differ")
    for name, meta in files.items():
        expected = (input_dir / name).read_bytes()
        old = client.get_bytes(f"data/releases/{v1_release}/{name}")
        new = client.get_bytes(cas.object_key(meta["sha256"]))
        require(old == new == expected, "read bytes differ: " + name)
    report["read_checks"][label] = {"status": "PASS", "files_per_format": len(files),
                                    "bytes_per_format": sum(item["size"] for item in files.values()),
                                    "inventory_hash": inventory_hash(files)}


def cli(client, store, arguments):
    # Keep the actual CLI rollback/activate/check path, supplying the same local adapter.
    with patch.object(r2_local_client, "LocalDataClient", return_value=client):
        value = pub.main(["--local-store", str(store), *arguments])
    require(value == 0, "local CLI action failed")
    return {"exit_code": value}


def verify(source, out, expected_files, report):
    marker = source / "_SNAPSHOT"
    require(marker.is_file(), "source must be a completed offline experiment snapshot")
    report["source_marker_sha256"] = pub.sha256_path(marker)
    input_a, input_b, store = out / "input-a", out / "input-b", out / "local-store"
    files_a = copy_snapshot(source, input_a)
    require(len(files_a) == expected_files, "source file count differs from explicit expected count")
    copy_snapshot(input_a, input_b)
    # Change one file's bytes without changing its JSON value or any real source.
    with (input_b / "about.json").open("ab") as stream:
        stream.write(b"\n")
    files_b = inventory(input_b)
    require([key for key in files_a if files_a[key] != files_b[key]] == ["about.json"],
            "incremental fixture must change only about.json")
    write_json(out / "input-a.manifest.json", files_a)
    write_json(out / "input-b.manifest.json", files_b)
    report["input"] = {"source": str(source), "a": str(input_a), "b": str(input_b),
                       "files": len(files_a), "bytes_a": sum(value["size"] for value in files_a.values()),
                       "inventory_sha256_a": inventory_hash(files_a), "inventory_sha256_b": inventory_hash(files_b),
                       "change": "append one newline to output/input-b/about.json; JSON value unchanged"}
    atlas_source = (ROOT / "functions/_atlas_data.js").read_text(encoding="utf-8")
    match = re.search(r"const MAX_OBJECT_BYTES = (\d+) \* 1024 \* 1024;", atlas_source)
    require(match is not None, "backend object size guard cannot be identified")
    limit = int(match.group(1)) * 1024 * 1024
    maximum = max(files_a, key=lambda key: files_a[key]["size"])
    report["maximum_json"] = {"path": maximum, **files_a[maximum], "backend_limit_bytes": limit,
                              "within_backend_limit": files_a[maximum]["size"] <= limit,
                              "backend_limit_source": "functions/_atlas_data.js:MAX_OBJECT_BYTES"}
    require(report["maximum_json"]["within_backend_limit"], "largest JSON exceeds backend object size guard")
    require(not store.exists(), "refusing to reuse previous local verification store")
    client = MeasuredLocalDataClient(store)
    first = step(client, report, "01_first_dual", lambda: publish_dual(client, input_a, files_a))
    a1 = first["result"]["v1"]["pointer"]["release"]
    a2 = first["result"]["v2"]["pointer"]["release"]
    unique_a = len({value["sha256"] for value in files_a.values()})
    require(first["result"]["v2"]["uploaded"] == unique_a, "first release did not upload all unique blobs")
    read_all(client, report, "01_dual_a", files_a, input_a, a1, a2)
    pointers = [client.get_bytes(key) for key in ("data/current.json", cas.CURRENT_KEY)]
    same = step(client, report, "02_unchanged_dual", lambda: publish_dual(client, input_a, files_a))
    require(same["store_metrics_delta"]["bytes_written"] == 0 and not same["write_events"],
            "unchanged release wrote content, manifest or pointer")
    require(pointers == [client.get_bytes(key) for key in ("data/current.json", cas.CURRENT_KEY)],
            "unchanged publication changed pointer bytes")

    def publish_b_v2():
        with pub.frozen_data_directory(input_b) as frozen:
            return pub.publish_v2_release(client, pub.build_v2_release_plan(frozen))
    changed = step(client, report, "03_one_changed_v2", publish_b_v2)
    b2 = changed["result"]["pointer"]["release"]
    require(changed["result"]["uploaded"] == 1 and changed["result"]["reused"] == unique_a - 1,
            "single changed JSON did not create exactly one blob")
    require(changed["writes_by_category"]["v2_blob"]["operations"] == 1, "unexpected v2 blob writes")
    require(client.get_bytes("data/current.json") == pointers[0], "v2 publication moved legacy pointer")

    def publish_b_v1():
        with pub.frozen_data_directory(input_b) as frozen:
            return pub.publish_release(client, pub.build_release_plan(frozen))
    legacy = step(client, report, "04_legacy_copy_reuse", publish_b_v1)
    b1 = legacy["result"]["pointer"]["release"]
    require(legacy["result"]["copied"] == len(files_a) - 1, "legacy unchanged files did not use copy reuse")
    require(legacy["writes_by_category"]["v1_file"]["operations"] == len(files_a), "legacy release is incomplete")
    read_all(client, report, "04_dual_b", files_b, input_b, b1, b2)
    read_all(client, report, "04_historical_a", files_a, input_a, a1, a2)
    same_b = step(client, report, "05_unchanged_dual_b", lambda: publish_dual(client, input_b, files_b))
    require(not same_b["write_events"] and same_b["store_metrics_delta"]["bytes_written"] == 0,
            "unchanged changed-snapshot dual wrote objects")
    rolled = step(client, report, "06_cli_v2_rollback", lambda: cli(client, store, ["--format", "v2", "--rollback"]))
    pointer = client.get_json(cas.CURRENT_KEY)
    require(pointer["release"] == a2 and pointer["previousRelease"] == b2, "rollback pointer is incorrect")
    require(rolled["write_operations"] == {"pointer": 1}, "rollback rewrote immutable content")
    activated = step(client, report, "07_cli_v2_activate", lambda: cli(client, store,
                     ["--format", "v2", "--activate-release", b2]))
    require(client.get_json(cas.CURRENT_KEY)["release"] == b2, "reactivation failed")
    require(activated["write_operations"] == {"pointer": 1}, "reactivation rewrote immutable content")
    step(client, report, "08_cli_check_both_formats", lambda: cli(client, store, ["--format", "dual", "--check-current"]))
    client.close()
    reopened = r2_local_client.LocalDataClient(store)
    require(reopened.get_json(cas.CURRENT_KEY)["release"] == b2, "SQLite reopen lost active v2 pointer")
    read_all(reopened, report, "09_reopened_b", files_b, input_b, b1, b2)
    reopened.close()
    require(inventory(source) == files_a == inventory(input_a), "original source or copied baseline changed")
    require(pub.sha256_path(marker) == report["source_marker_sha256"], "original snapshot marker changed")
    report["source_unchanged"] = True
    report["releases"] = {"a_v1": a1, "a_v2": a2, "b_v1": b1, "b_v2": b2}
    report["status"] = "PASS"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--expected-files", default=58, type=int)
    args = parser.parse_args(argv)
    source, out = args.source.absolute(), args.out_dir.absolute()
    no_links(source)
    no_links(out)
    require(out.resolve().is_relative_to(OUTPUT.resolve()) and out.resolve() != OUTPUT.resolve(),
            "all verification writes must stay below this worktree output")
    require(source != out and not out.is_relative_to(source) and not source.is_relative_to(out),
            "verification output must be separate from its read-only source")
    require(any(parent.name == "output" for parent in source.parents), "source must be an isolated output snapshot")
    require(not out.exists() and not out.is_symlink(), "refusing to reuse a verification output directory")
    out.parent.mkdir(parents=True, exist_ok=True)
    no_links(out)
    out.mkdir(exist_ok=False)
    no_links(out)
    dependencies = ["tools/publish_data_r2.py", "tools/publish_data_r2_v2.py", "tools/r2_data_protocol.py",
                    "tools/r2_data_snapshot.py", "tools/r2_local_client.py", "tools/r2_cas_experiment/store.py",
                    "tools/sync_r2.py", "tools/r2_http_pool.py", "tools/verify_r2_cas_integration.py",
                    "functions/_atlas_data.js"]
    report = {"status": "RUNNING", "environment": {"python": sys.version, "platform": platform.platform()},
              "scope": "offline frozen JSON, SQLite only; no R2, no production configuration",
              "source_sha256": {name: pub.sha256_path(ROOT / name) for name in dependencies},
              "steps": {}, "read_checks": {}}
    output = io.StringIO()
    try:
        with ExitStack() as stack, redirect_stdout(output):
            for owner, name in ((socket, "socket"), (socket, "create_connection"), (urllib.request, "urlopen"),
                                (pub, "R2DataClient"), (pub, "load_config"), (sync_r2, "R2Client"), (sync_r2, "load_config")):
                stack.enter_context(patch.object(owner, name, side_effect=AssertionError("network/production configuration forbidden")))
            verify(source, out, args.expected_files, report)
    except BaseException as error:
        report["status"] = "FAIL"
        report["error"] = {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}
    finally:
        with (out / "publisher-output.txt").open("x", encoding="utf-8") as stream:
            stream.write(output.getvalue())
        write_json(out / "report.json", report)
    maximum = report.get("maximum_json", {})
    print(json.dumps({"status": report["status"], "report": str(out / "report.json"),
                      "maximum_json": maximum, "error": report.get("error", {}).get("message")}, ensure_ascii=True))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
