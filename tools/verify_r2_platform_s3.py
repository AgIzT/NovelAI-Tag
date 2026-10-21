"""Explicit, synthetic-only S3 acceptance for the named isolated R2 test bucket.

Default is a credential-free, network-free plan. --run performs bounded writes;
no DELETE or cleanup exists. Do not call the production publisher CLI here.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
import datetime as dt
import hashlib
import io
import json
from pathlib import Path
import platform
import re
import sys
import threading
import time
import uuid

if __package__:
    from . import publish_data_r2 as pub, publish_data_r2_v2 as v2
    from . import r2_data_protocol as cas, r2_http_pool, sync_r2
    from .r2_data_snapshot import no_links
else:
    import publish_data_r2 as pub
    import publish_data_r2_v2 as v2
    import r2_data_protocol as cas
    import r2_http_pool
    import sync_r2
    from r2_data_snapshot import no_links

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output"
BUCKET_RE = re.compile(r"novelai-tag-r2-acceptance-20261021-[0-9a-f]{8}")
PREFIX_RE = re.compile(r"acceptance/run-[0-9a-f]{32}")
STEPS = ("conditional_create", "if_match", "cas_race", "aba", "immutable",
         "dual_publish_noop_rollback", "tls_sequential", "tls_bounded_idle")
SOURCES = ("tools/verify_r2_platform_s3.py", "tools/test_verify_r2_platform_s3.py",
           "tools/sync_r2.py", "tools/r2_http_pool.py", "tools/publish_data_r2.py",
           "tools/publish_data_r2_v2.py", "tools/r2_data_protocol.py",
           "tools/r2_data_snapshot.py")


class GuardError(RuntimeError):
    pass


class CheckFailed(RuntimeError):
    pass


class AccessBlocked(RuntimeError):
    pass


def require(value, message, error=GuardError):
    if not value:
        raise error(message)


def digest(body):
    return hashlib.sha256(body).hexdigest()


def read_json(path):
    path = Path(path).absolute()
    no_links(path)
    require(path.is_file(), "explicit JSON input is missing")
    raw = path.read_bytes()
    try:
        value = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeError, ValueError) as error:
        raise GuardError("explicit input must be UTF-8 JSON") from error
    require(isinstance(value, dict), "explicit JSON input must be an object")
    return value, digest(raw)


def validate_resources(path):
    value, sha = read_json(path)
    bucket = value.get("bucket")
    denied = value.get("production_bucket_denied")
    require(value.get("test_only") is True, "resources must explicitly set test_only=true")
    require(isinstance(bucket, str) and BUCKET_RE.fullmatch(bucket), "bucket is outside the isolated acceptance allowlist")
    require(isinstance(denied, str) and denied and bucket != denied, "production bucket exclusion is missing or violated")
    require(re.fullmatch(r"[0-9a-f]{32}", str(value.get("account_id", ""))), "resources account_id is invalid")
    return {"bucket": bucket, "account_id": value["account_id"],
            "production_bucket_denied": denied, "test_only": True}, sha


def validate_output(path):
    out = Path(path).absolute()
    no_links(out)
    require(out.resolve().is_relative_to(OUTPUT.resolve()) and out.resolve() != OUTPUT.resolve(),
            "out-dir must be a fresh child of this worktree output")
    require(not out.exists() and not out.is_symlink(), "refusing to reuse an existing output")
    return out


def credentials_for(path, resources):
    # Only called after --run and every resource/output guard succeeded.
    source, _unused_hash = read_json(path)
    selected = {name: source.get(name) for name in
                ("account_id", "access_key_id", "secret_access_key", "region")}
    require(selected["account_id"] == resources["account_id"], "credential account differs from resources account")
    for name in ("access_key_id", "secret_access_key"):
        require(isinstance(selected[name], str) and bool(selected[name].strip()), "required S3 credential field is missing")
    selected["region"] = "auto" if selected.get("region") in (None, "") else selected["region"]
    require(isinstance(selected["region"], str) and re.fullmatch(r"[A-Za-z0-9-]+", selected["region"]), "credential region is invalid")
    # Source bucket/base URLs, data paths, retries and pool settings are discarded.
    return {**selected, "bucket": resources["bucket"], "request_retries": 0,
            "upload_retries": 0, "retry_base_delay": 0, "request_timeout": 30,
            "http_pool_enabled": True, "http_pool_max_connections": 2,
            "http_pool_idle_timeout": 0.25}


class Evidence:
    def __init__(self, prefix):
        require(PREFIX_RE.fullmatch(prefix), "run prefix was not freshly generated")
        self.prefix = prefix
        self.lock = threading.Lock()
        self.requests = []
        self.tls = []
        self.keys = set()
        self.written = set()
        self.clients = []

    def event(self, event):
        with self.lock:
            event["sequence"] = len(self.requests) + 1
            self.requests.append(event)
            self.keys.add(event["key"])
            if event["method"] == "PUT" and event.get("status") in (200, 201):
                self.written.add(event["key"])

    def factory(self, label):
        def create(host, port, timeout, proxy):
            connection = r2_http_pool.https_connection(host, port, timeout, proxy)
            original = connection.connect
            def connect():
                event = {"client": label, "success": False, "proxy": bool(proxy)}
                try:
                    original()
                    sock = connection.sock
                    event.update(success=True, tls_version=sock.version(),
                                 tls_session_reused=bool(sock.session_reused),
                                 socket_identity=id(sock), local_port=sock.getsockname()[1])
                except BaseException as error:
                    event["error_type"] = type(error).__name__
                    raise
                finally:
                    with self.lock:
                        self.tls.append(event)
            connection.connect = connect
            return connection
        return create

    def tls_count(self, label):
        return sum(event["success"] for event in self.tls if event["client"] == label)


class MeasuredR2Client(sync_r2.R2Client):
    def __init__(self, cfg, resources, evidence, label):
        require(cfg.get("bucket") == resources["bucket"] and
                cfg.get("bucket") != resources["production_bucket_denied"], "client bucket escaped test resources")
        require(cfg.get("account_id") == resources["account_id"], "client account escaped test resources")
        require(PREFIX_RE.fullmatch(evidence.prefix), "client prefix is invalid")
        self.evidence = evidence
        self.label = label
        self._allowed_bucket = resources["bucket"]
        self._allowed_account = resources["account_id"]
        super().__init__(cfg, connection_factory=evidence.factory(label))
        evidence.clients.append(self)

    def _request_once(self, method, key, body=b"", headers=None, query=None, timeout=None):
        require(self.bucket == self._allowed_bucket and self.account_id == self._allowed_account,
                "runtime client target changed")
        expected_host = self._allowed_account + ".r2.cloudflarestorage.com"
        require(self.host == expected_host and self.endpoint == "https://" + expected_host,
                "runtime S3 origin changed")
        require(method in ("GET", "HEAD", "PUT"), "only GET/HEAD/PUT are allowed; cleanup is forbidden")
        require(isinstance(key, str) and key.startswith(self.evidence.prefix + "/") and
                all(re.fullmatch(r"[A-Za-z0-9_.-]+", part) and part not in (".", "..") for part in key.split("/")),
                "request key escaped this random run prefix")
        require(query is None, "bucket listing and custom queries are outside this acceptance")
        copy_source = (headers or {}).get("x-amz-copy-source")
        if copy_source:
            require(copy_source.startswith("/" + self._allowed_bucket + "/" + self.evidence.prefix + "/"),
                    "copy source escaped test run")
        event = {"client": self.label, "method": method, "key": key,
                 "request_bytes": len(body), "request_sha256": digest(body)}
        try:
            status, response_headers, response_body = super()._request_once(
                method, key, body, headers, query, timeout)
            event.update(status=status, etag=response_headers.get("etag"),
                         response_bytes=len(response_body), response_sha256=digest(response_body),
                         content_length=response_headers.get("content-length"),
                         cache_control=response_headers.get("cache-control"),
                         content_type=response_headers.get("content-type"),
                         metadata_sha256=response_headers.get("x-amz-meta-sha256"))
            code = re.search(rb"<Code>([A-Za-z0-9]+)</Code>", response_body[:4096])
            if code:
                event["service_error_code"] = code.group(1).decode("ascii")
            self.evidence.event(event)
            if status == 403:
                raise AccessBlocked("S3AccessDenied: test-bucket access is blocked; production permissions must not be expanded")
            return status, response_headers, response_body
        except AccessBlocked:
            raise
        except BaseException as error:
            event["error_type"] = type(error).__name__
            self.evidence.event(event)
            raise


class DataClient(pub.R2DataClient):
    def __init__(self, raw):
        self.raw = raw
        self.retries = 0
        self.retry_base_delay = 0


def put(raw, key, value, **conditions):
    body = cas.json_bytes(value)
    return raw.put_bytes(key, body, digest(body), cas.JSON_TYPE, "no-store", **conditions)


def check(condition, message):
    require(condition, message, CheckFailed)


def validate_tls_sequence(metrics, successful_tls_connections):
    check(metrics["requests"] == 8, "unexpected request retries in sequential TLS case")
    check(1 <= successful_tls_connections < 8, "eight HTTPS reads did not reuse a real TLS connection")


def conflict(action):
    try:
        action()
    except AccessBlocked:
        raise
    except RuntimeError as error:
        check("conflict" in str(error), "expected an explicit conflict")
        return
    raise CheckFailed("stale pointer unexpectedly succeeded")


def synthetic_input(out, version):
    directory = out / ("input-" + version)
    directory.mkdir()
    values = {name: {} for name in pub.REQUIRED_FILES}
    values.update({"codexes.json": [], "share-index.json": {"codexes": {}},
                   "about.json": {"synthetic": version}, "strings.json": [], "strings_index.json": []})
    hashes = {}
    for name, value in sorted(values.items()):
        body = cas.json_bytes(value)
        (directory / name).write_bytes(body)
        hashes[name] = {"sha256": digest(body), "size": len(body)}
    return directory, hashes


def run_acceptance(cfg, resources, out, report):
    evidence = Evidence("acceptance/run-" + uuid.uuid4().hex)
    report["run_prefix"] = evidence.prefix
    report["requests"] = evidence.requests
    report["tls_connections"] = evidence.tls
    raw = MeasuredR2Client(cfg, resources, evidence, "primary")
    client = DataClient(raw)
    prefix = evidence.prefix

    def step(name, action):
        report["active_step"] = name
        before, tls_before = len(evidence.requests), len(evidence.tls)
        started = time.perf_counter()
        report["steps"][name] = {"status": "RUNNING"}
        result = action()
        report["steps"][name] = {"status": "PASS", "result": result,
                                  "request_count": len(evidence.requests) - before,
                                  "tls_connect_attempts": len(evidence.tls) - tls_before,
                                  "elapsed_seconds": time.perf_counter() - started}
        return result

    try:
        def conditional_create():
            key = prefix + "/conditions/create.json"
            first = put(raw, key, {"winner": 1}, if_none_match="*")
            second = put(raw, key, {"winner": 2}, if_none_match="*")
            actual = raw.get(key)
            check(first[0] in (200, 201) and second[0] in (409, 412), "conditional create status mismatch")
            check(actual[0] == 200 and actual[2] == cas.json_bytes({"winner": 1}), "conditional create overwrote winner")
            return {"statuses": [first[0], second[0], actual[0]], "etag": actual[1].get("etag")}
        step("conditional_create", conditional_create)

        def if_match():
            key = prefix + "/conditions/match.json"
            put(raw, key, {"version": 0}, if_none_match="*")
            snap = raw.get(key)
            check(snap[1].get("etag"), "GET snapshot has no ETag")
            good = put(raw, key, {"version": 1}, if_match=snap[1]["etag"])
            stale = put(raw, key, {"version": 2}, if_match=snap[1]["etag"])
            actual = raw.get(key)
            check(good[0] in (200, 201) and stale[0] in (409, 412), "If-Match status mismatch")
            check(actual[2] == cas.json_bytes({"version": 1}), "stale If-Match changed current")
            return {"statuses": [good[0], stale[0]], "old_etag": snap[1]["etag"], "new_etag": actual[1].get("etag")}
        step("if_match", if_match)

        def race():
            key = prefix + "/conditions/race.json"
            put(raw, key, {"operationId": uuid.uuid4().hex}, if_none_match="*")
            other = MeasuredR2Client(cfg, resources, evidence, "race-peer")
            barrier = threading.Barrier(2, timeout=20)
            def contender(connection):
                snapshot = connection.get(key)
                check(snapshot[0] == 200 and snapshot[1].get("etag"), "race snapshot missing")
                value = {"operationId": uuid.uuid4().hex}
                barrier.wait()
                result = put(connection, key, value, if_match=snapshot[1]["etag"])
                return result[0], value, snapshot[1]["etag"]
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(contender, connection) for connection in (raw, other)]
                results = [future.result() for future in futures]
            check(results[0][2] == results[1][2], "racers did not freeze one ETag")
            winners = [value for status, value, _etag in results if status in (200, 201)]
            losers = [status for status, _value, _etag in results if status in (409, 412)]
            check(len(winners) == len(losers) == 1, "CAS race did not have exactly one winner")
            check(raw.get(key)[2] == cas.json_bytes(winners[0]), "race final body differs from winner")
            return {"statuses": [item[0] for item in results], "frozen_etag": results[0][2]}
        step("cas_race", race)

        def aba():
            key = prefix + "/conditions/aba/current.json"
            a = {"release": "A", "operationId": uuid.uuid4().hex}
            client.put_pointer(key, cas.json_bytes(a), None)
            frozen, old_etag = client.get_json_snapshot(key)
            b = {"release": "B", "operationId": uuid.uuid4().hex}
            client.put_pointer(key, cas.json_bytes(b), old_etag)
            _b, b_etag = client.get_json_snapshot(key)
            fresh_a = {"release": "A", "operationId": uuid.uuid4().hex}
            client.put_pointer(key, cas.json_bytes(fresh_a), b_etag)
            current, new_etag = client.get_json_snapshot(key)
            check(current["release"] == frozen["release"] and new_etag != old_etag and current != frozen,
                  "same-release ABA did not change decision bytes and ETag")
            conflict(lambda: client.put_pointer(key, cas.json_bytes({"release": "C", "operationId": uuid.uuid4().hex}), old_etag))
            check(client.get_json(key) == fresh_a, "stale ABA activation changed current")
            return {"old_etag": old_etag, "new_etag": new_etag, "same_release": True}
        step("aba", aba)

        def immutable():
            body = cas.json_bytes({"synthetic": "immutable"})
            key = cas.object_key(digest(body), prefix + "/immutable")
            first = v2.ensure_bytes(client, key, body)
            before = len(evidence.requests)
            second = v2.ensure_bytes(client, key, body)
            check(first == "uploaded" and second == "reused", "immutable same-byte reuse differs")
            check(not any(event["method"] == "PUT" for event in evidence.requests[before:]), "immutable reuse wrote bytes")
            bad_key = prefix + "/immutable/conflict.json"
            old = cas.json_bytes({"original": True})
            status = raw.put_bytes(bad_key, old, digest(old), cas.JSON_TYPE, cas.IMMUTABLE_CACHE)[0]
            check(status in (200, 201), "conflict fixture create failed")
            try:
                v2.ensure_bytes(client, bad_key, body)
            except AccessBlocked:
                raise
            except RuntimeError as error:
                check("refusing overwrite" in str(error), "immutable mismatch did not explicitly refuse overwrite")
            else:
                raise CheckFailed("immutable conflict was overwritten")
            check(client.get_bytes(bad_key) == old, "immutable conflict changed original bytes")
            return {"first": first, "second": second, "conflict_unchanged": True}
        step("immutable", immutable)

        def publication():
            data_a, hashes_a = synthetic_input(out, "a")
            data_b, hashes_b = synthetic_input(out, "b")
            report["synthetic_inputs"] = {"a": hashes_a, "b": hashes_b}
            v1a, v2a = pub.build_release_plan(data_a), pub.build_v2_release_plan(data_a)
            v2b = pub.build_v2_release_plan(data_b)
            publication_prefix = prefix + "/publication"
            pub.publish_dual_release(client, v1a, v2a, publication_prefix, workers=2)
            pointers = [client.get_bytes(key) for key in (publication_prefix + "/current.json", cas.current_key(publication_prefix))]
            before = len(evidence.requests)
            same = pub.publish_dual_release(client, v1a, v2a, publication_prefix, workers=2)
            writes = [event for event in evidence.requests[before:] if event["method"] == "PUT"]
            check(not writes and same["v1"]["unchanged"] and same["v2"]["unchanged"], "unchanged dual wrote objects")
            pub.publish_v2_release(client, v2b, publication_prefix, workers=2)
            pointer = client.get_json(cas.current_key(publication_prefix))
            check(pointer["previousRelease"] == v2a.release, "rollback target differs from prior release")
            before = len(evidence.requests)
            pub.activate_v2_release(client, publication_prefix, pointer["previousRelease"])
            rollback_writes = [event["key"] for event in evidence.requests[before:] if event["method"] == "PUT"]
            check(rollback_writes == [cas.current_key(publication_prefix)], "rollback wrote immutable content")
            check(client.get_json(cas.current_key(publication_prefix))["release"] == v2a.release, "rollback failed")
            pub.activate_v2_release(client, publication_prefix, v2b.release)
            check(client.get_bytes(publication_prefix + "/current.json") == pointers[0], "v2 activation changed v1 pointer")
            for plan in (v2a, v2b):
                v2.load_manifest(client, publication_prefix, plan.release)
                for item in plan.files:
                    check(client.get_bytes(cas.object_key(item.sha256, publication_prefix)) == item.path.read_bytes(), "historical release bytes differ")
            return {"v1_a": v1a.release, "v2_a": v2a.release, "v2_b": v2b.release,
                    "unchanged_dual_puts": 0, "rollback_pointer_only": True}
        step("dual_publish_noop_rollback", publication)

        key = prefix + "/conditions/create.json"
        def tls_sequential():
            connection = MeasuredR2Client(cfg, resources, evidence, "tls-sequential")
            check(connection.transport_info["mode"] == "pool", "TLS test requires the pool on the actual proxy route")
            for _ in range(8):
                check(connection.get(key)[0] == 200, "sequential HTTPS read failed")
            count = evidence.tls_count("tls-sequential")
            metrics = connection.transport_metrics()
            validate_tls_sequence(metrics, count)
            return {"requests": 8, "successful_tls_connections": count,
                    "observed_same_tls_connection_reuse": count < 8,
                    "transport": connection.transport_info, "pool_metrics": metrics,
                    "performance_claim": "none; connection objects are not TLS handshakes"}
        step("tls_sequential", tls_sequential)

        def tls_bounded_idle():
            connection = MeasuredR2Client(cfg, resources, evidence, "tls-bounded")
            check(connection.transport_info["mode"] == "pool", "bounded test requires pooled TLS")
            barrier = threading.Barrier(4, timeout=20)
            def read(_index):
                barrier.wait()
                return connection.get(key)[0]
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(read, range(4)))
            check(all(status == 200 for status in results), "bounded parallel HTTPS read failed")
            metrics = connection.transport_metrics()
            check(metrics["peak_in_use"] <= 2 and metrics["open"] <= 2, "connection pool exceeded configured bound")
            before = evidence.tls_count("tls-bounded")
            time.sleep(0.35)
            check(connection.head(key)[0] == 200, "idle replacement HEAD failed")
            after = evidence.tls_count("tls-bounded")
            check(after > before, "idle-expired connections did not create a new TLS connection")
            return {"parallel_requests": 4, "configured_max": 2, "before_idle_tls": before,
                    "after_idle_tls": after, "pool_metrics": connection.transport_metrics()}
        step("tls_bounded_idle", tls_bounded_idle)
        report["status"] = "PASS"
    finally:
        report["touched_keys"] = sorted(evidence.keys)
        report["successfully_written_keys"] = sorted(evidence.written)
        report["request_counts"] = dict(Counter(event["method"] for event in evidence.requests))
        report["pool_metrics"] = {connection.label: connection.transport_metrics() for connection in evidence.clients}
        for connection in evidence.clients:
            connection.close()
        report["cleanup"] = "not performed; all synthetic objects retained under run_prefix"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resources", required=True, type=Path)
    parser.add_argument("--credentials-source", type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args(argv)
    resources, resource_sha = validate_resources(args.resources)
    out = validate_output(args.out_dir)
    if not args.run:
        print(json.dumps({"status": "PLAN", "test_bucket": resources["bucket"], "steps": list(STEPS),
                          "out_dir": str(out), "credential_reads": 0, "network_requests": 0,
                          "deletes": 0, "requires": "explicit --run and --credentials-source"}, ensure_ascii=True))
        return 0
    require(args.credentials_source is not None, "--run requires an explicit --credentials-source")
    no_links(args.credentials_source)
    require(args.credentials_source.absolute() != args.resources.absolute(), "credentials and resources must be separate inputs")
    cfg = credentials_for(args.credentials_source, resources)
    # All guards precede creation of output or construction of a network client.
    out.parent.mkdir(parents=True, exist_ok=True)
    no_links(out)
    out.mkdir(exist_ok=False)
    report = {"status": "RUNNING", "resources": resources, "resources_sha256": resource_sha,
              "environment": {"python": sys.version, "platform": platform.platform()},
              "started_at": dt.datetime.now(dt.timezone.utc).isoformat(),
              "source_sha256": {name: digest((ROOT / name).read_bytes()) for name in SOURCES},
              "scope": "synthetic S3 objects in independent test bucket only; no production deployment or writes",
              "steps": {name: {"status": "SKIP", "reason": "not executed"} for name in STEPS}}
    try:
        with redirect_stdout(io.StringIO()):
            run_acceptance(cfg, resources, out, report)
    except BaseException as error:
        denied = isinstance(error, AccessBlocked) or any(event.get("status") == 403 for event in report.get("requests", []))
        report["status"] = "BLOCKED" if denied else "FAIL"
        # External transport exception messages may contain proxy credentials.
        safe_message = str(error) if isinstance(error, (GuardError, CheckFailed, AccessBlocked)) else "acceptance stopped; inspect sanitized request evidence"
        report["error"] = {"type": type(error).__name__, "message": safe_message}
        active = report.get("active_step")
        if active:
            report["steps"][active] = {"status": report["status"], "error": report["error"]}
    finally:
        cfg.clear()
        report["finished_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
        with (out / "report.json").open("x", encoding="utf-8") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    print(json.dumps({"status": report["status"], "report": str(out / "report.json"),
                      "error": report.get("error")}, ensure_ascii=True))
    return 0 if report["status"] == "PASS" else 2 if report["status"] == "BLOCKED" else 1


if __name__ == "__main__":
    sys.exit(main())
