"""Explicit disposable Workers/R2 HTTP acceptance; plan mode never reads a token.

Only the exact resources.worker_url may receive requests. Protected cases use an
environment-only 64-hex token. Objects are synthetic, bounded and never deleted.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

if __package__:
    from . import r2_data_protocol as cas
    from .r2_data_snapshot import no_links
else:
    import r2_data_protocol as cas
    from r2_data_snapshot import no_links

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output"
BUCKET_RE = re.compile(r"novelai-tag-r2-acceptance-[0-9]{8}-[0-9a-f]{8}")
WORKER_RE = re.compile(r"atlas-r2-acceptance-[0-9]{8}-[0-9a-f]{8}")
RUN_RE = re.compile(r"[0-9a-f]{32}")
TOKEN_RE = re.compile(r"[0-9a-f]{64}")
ALLOWED_ORIGIN = "https://allowed.invalid"
DENIED_ORIGIN = "https://denied.invalid"
MAX_RESPONSE = 65536
USER_AGENT = "Atlas-R2-Platform-Acceptance/1.0"
HEADERS = {"etag", "cache-control", "content-type", "content-length", "content-range",
           "accept-ranges", "x-atlas-data-release", "access-control-allow-origin",
           "access-control-expose-headers", "access-control-allow-methods",
           "access-control-allow-headers", "vary", "cf-ray", "date", "server"}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(body):
    return hashlib.sha256(body).hexdigest()


def json_body(value):
    return (json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n").encode()


def resources_from(path):
    raw = (ROOT / Path(path)).absolute()
    no_links(raw)
    require(raw.resolve().is_relative_to(OUTPUT.resolve()), "resources must be inside this worktree/output")
    require(raw.is_file() and raw.stat().st_size <= 32768, "resources file missing or too large")
    value = json.loads(raw.read_text(encoding="utf-8"))
    require(type(value) is dict and value.get("test_only") is True, "resources must declare test_only true")
    bucket, worker = value.get("bucket"), value.get("worker")
    require(type(bucket) is str and BUCKET_RE.fullmatch(bucket), "invalid disposable test bucket")
    require(type(worker) is str and WORKER_RE.fullmatch(worker), "invalid disposable test Worker")
    require(worker == bucket.replace("novelai-tag-r2-", "atlas-r2-", 1), "test resource suffixes differ")
    require(value.get("production_bucket_denied") == "novelai-tag-assets", "production deny marker missing")
    require(type(value.get("account_id")) is str and re.fullmatch(r"[0-9a-f]{32}", value["account_id"]), "invalid account id")
    # Never copy arbitrary resources fields to reports.
    return {key: value.get(key) for key in ("bucket", "worker", "worker_url", "account_id", "test_only")}


def validate_worker_url(value, resources):
    require(type(value) is str and value == resources.get("worker_url"),
            "worker URL must exactly match resources.worker_url")
    parts = urllib.parse.urlsplit(value)
    hostname = parts.hostname or ""
    expected = re.escape(resources["worker"]) + r"\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev"
    require(parts.scheme == "https" and re.fullmatch(expected, hostname)
            and parts.netloc == hostname and parts.path == "" and not parts.query and not parts.fragment,
            "only the exact HTTPS disposable workers.dev origin is permitted")
    return value


def create_output_directory(value):
    raw = (ROOT / Path(value)).absolute()
    no_links(ROOT.absolute())
    no_links(OUTPUT.absolute())
    no_links(raw)
    target = raw.resolve()
    require(target != OUTPUT.resolve() and target.is_relative_to(OUTPUT.resolve()),
            "output must be a dedicated child inside this worktree/output")
    require(not raw.exists() and not raw.is_symlink(), "output already exists; choose a fresh directory")
    raw.parent.mkdir(parents=True, exist_ok=True)
    no_links(raw)
    raw.mkdir()
    no_links(raw)
    return raw.resolve()


def write_json(path, value):
    no_links(path)
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def build_fixture(run_id):
    require(type(run_id) is str and RUN_RE.fullmatch(run_id), "invalid run id")
    versions, keys = {}, []
    for version in ("old", "new", "bad"):
        body = json_body({"kind": "r2-platform-fixture", "runId": run_id, "version": version})
        sha = digest(body)
        manifest = cas.make_manifest({"demo.json": {"sha256": sha, "size": len(body)}})
        value = {"release": manifest["release"], "v1Release": "r-" + sha[:20],
                 "sha256": sha, "size": len(body), "blobKey": cas.object_key(sha),
                 "manifestKey": cas.manifest_key(manifest["release"])}
        versions[version] = {"summary": value, "body": body, "manifest": cas.json_bytes(manifest)}
        if version != "bad":
            keys.append("data/releases/" + value["v1Release"] + "/demo.json")
        keys.extend((value["blobKey"], value["manifestKey"]))
    keys.extend(("data/current.json", "data/v2/current.json"))
    summary = {"keys": keys, "versions": {key: value["summary"] for key, value in versions.items()}}
    return {"versions": versions, "summary": summary,
            "bindingKeys": ["platform/" + run_id + "/binding/" + name + ".json" for name in ("conditional", "race")]}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


class HttpClient:
    def __init__(self, origin, events):
        self.origin = origin
        self.events = events
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, method, path, headers=None, body=None):
        require(method in {"GET", "HEAD", "OPTIONS", "POST"}, "invalid request method")
        require(type(path) is str and path.startswith("/") and not path.startswith("//")
                and not any(c in path for c in ("\r", "\n", "#")), "invalid request path")
        url = self.origin + path
        require(urllib.parse.urlsplit(url).netloc == urllib.parse.urlsplit(self.origin).netloc,
                "request escaped the fixed test origin")
        request = urllib.request.Request(url, data=body, headers=dict(headers or {}), method=method)
        request.add_header("User-Agent", USER_AGENT)
        started = time.monotonic()
        try:
            try:
                response = self.opener.open(request, timeout=30)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                require(response.geturl() == url, "redirected response is forbidden")
                response_body = response.read(MAX_RESPONSE + 1)
                require(len(response_body) <= MAX_RESPONSE, "test response exceeded byte budget")
                result = {"status": response.status,
                          "headers": {key.lower(): value for key, value in response.headers.items() if key.lower() in HEADERS},
                          "body": response_body}
        except Exception:
            self.events.append({"method": method, "path": path, "transport": "FAILED",
                                "elapsedMs": round((time.monotonic() - started) * 1000)})
            # Do not echo transport exceptions or request headers.
            raise RuntimeError("fixed test endpoint request failed") from None
        self.events.append({"method": method, "path": path, "status": result["status"],
                            "headers": result["headers"], "bodySize": len(result["body"]),
                            "bodySha256": digest(result["body"]),
                            "elapsedMs": round((time.monotonic() - started) * 1000)})
        return result


def checked(report, label, condition):
    report["checks"].append({"name": label, "status": "PASS" if condition else "FAIL"})
    require(condition, "acceptance check failed: " + label)


def read_token():
    value = os.environ.get("ATLAS_R2_TEST_TOKEN")
    require(type(value) is str and TOKEN_RE.fullmatch(value), "ATLAS_R2_TEST_TOKEN must be 64 lowercase hex characters")
    return value


def parse_response_json(response):
    try:
        return json.loads(response["body"])
    except (ValueError, UnicodeError):
        raise RuntimeError("test endpoint did not return valid JSON") from None


def run_acceptance(resources, origin, run_id, fixture, report):
    client = HttpClient(origin, report["requests"])
    # Verify the endpoint before reading or transmitting the protected token.
    response = client.request("GET", "/__test")
    expected_probe = {"bucket": resources["bucket"], "worker": resources["worker"], "testOnly": True}
    checked(report, "unauthenticated resource probe", response["status"] == 200 and parse_response_json(response) == expected_probe)
    token = read_token()
    auth = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}

    def post(case):
        response = client.request("POST", "/__test", auth, json_body({"case": case, "runId": run_id}))
        checked(report, case + " status", response["status"] == 200)
        value = parse_response_json(response)
        checked(report, case + " envelope", type(value) is dict and set(value) == {"case", "runId", "result"}
                and value["case"] == case and value["runId"] == run_id)
        return value["result"]

    response = client.request("POST", "/__test", {"Content-Type": "application/json"},
                              json_body({"case": "probe", "runId": run_id}))
    checked(report, "write interface requires token", response["status"] == 401)
    for invalid in ({"case": "seed", "runId": run_id, "key": "unapproved"},
                    {"case": "seed", "runId": "../unapproved"},
                    {"case": "delete", "runId": run_id}):
        response = client.request("POST", "/__test", auth, json_body(invalid))
        checked(report, "fixed test request shape " + str(len(report["checks"])), response["status"] == 400)
    checked(report, "query cannot select another test route", client.request("GET", "/__test?case=seed")["status"] == 404)
    checked(report, "protected probe", post("probe") == expected_probe)
    binding = post("binding")
    check_names = {"createOnly", "duplicateNull", "wrongEtagNull", "correctEtag", "staleNull", "raceOneWinner", "raceFinalBytes"}
    checked(report, "binding fixed keys", binding.get("keys") == fixture["bindingKeys"])
    checked(report, "binding condition and CAS assertions", type(binding.get("checks")) is dict
            and set(binding["checks"]) == check_names and all(value is True for value in binding["checks"].values()))
    final = binding.get("final", {})
    candidates = [json_body({"runId": run_id, "value": value}) for value in ("one", "two")]
    checked(report, "binding race metadata", final.get("key") == fixture["bindingKeys"][1]
            and final.get("sha256") in {digest(body) for body in candidates}
            and final.get("size") in {len(body) for body in candidates}
            and type(final.get("etag")) is str and 1 <= len(final["etag"]) <= 128)
    report["binding"] = {"keys": fixture["bindingKeys"], "checks": binding["checks"],
                         "final": {key: final[key] for key in ("key", "etag", "size", "sha256")}}
    checked(report, "seed fixed synthetic fixtures", post("seed") == fixture["summary"])
    old, new, bad = (fixture["versions"][version] for version in ("old", "new", "bad"))
    old_summary, new_summary = old["summary"], new["summary"]

    def exact_get(label, path, body, release, immutable=True):
        response = client.request("GET", path)
        headers = response["headers"]
        checked(report, label + " bytes", response["status"] == 200 and response["body"] == body)
        checked(report, label + " release", headers.get("x-atlas-data-release") == release)
        checked(report, label + " cache", ("immutable" in headers.get("cache-control", "")) if immutable
                else headers.get("cache-control") == "no-store")
        checked(report, label + " ETag", type(headers.get("etag")) is str and bool(headers["etag"]))
        return response

    old_urls = [("/data/releases/" + old_summary["v1Release"] + "/demo.json", old_summary["v1Release"]),
                ("/data/releases/" + old_summary["release"] + "/demo.json", old_summary["release"]),
                ("/data/v2/releases/" + old_summary["release"] + "/demo.json", old_summary["release"])]
    for index, (path, release) in enumerate(old_urls):
        label = "historical route " + str(index)
        full = exact_get(label, path, old["body"], release)
        etag = full["headers"]["etag"]
        response = client.request("HEAD", path)
        checked(report, label + " HEAD", response["status"] == 200 and response["body"] == b""
                and response["headers"].get("etag") == etag
                and response["headers"].get("x-atlas-data-release") == release
                and (index == 0 or response["headers"].get("content-length") == str(len(old["body"]))))
        for conditional in (etag, "W/" + etag):
            response = client.request("GET", path, {"If-None-Match": conditional})
            checked(report, label + " 304 " + conditional[:2], response["status"] == 304 and response["body"] == b"")
        for range_value, start, end in (("bytes=0-7", 0, 7), ("bytes=-8", len(old["body"]) - 8, len(old["body"]) - 1)):
            response = client.request("GET", path, {"Range": range_value})
            checked(report, label + " Range " + range_value, response["status"] == 206
                    and response["body"] == old["body"][start:end + 1]
                    and response["headers"].get("content-range") == "bytes " + str(start) + "-" + str(end) + "/" + str(len(old["body"])))
        response = client.request("GET", path, {"Range": "bytes=99999-"})
        checked(report, label + " unsatisfiable Range", response["status"] == 416
                and response["headers"].get("content-range") == "bytes */" + str(len(old["body"])))
        response = client.request("GET", path, {"Range": "bytes=0-7", "If-Range": '"wrong"'})
        checked(report, label + " If-Range mismatch", response["status"] == 200 and response["body"] == old["body"])

    for prefix, release in (("", old_summary["v1Release"]), ("v2/", old_summary["release"])):
        response = client.request("GET", "/data/" + prefix + "current.json")
        checked(report, prefix + "old current pointer", response["status"] == 200
                and parse_response_json(response).get("release") == release and response["headers"].get("cache-control") == "no-store")
        exact_get(prefix + "old current logical", "/data/" + prefix + "demo.json", old["body"], release, False)
    response = client.request("GET", "/data/" + old_summary["manifestKey"].removeprefix("data/"))
    checked(report, "canonical active manifest", response["status"] == 200 and response["body"] == old["manifest"])
    response = client.request("GET", "/data/" + old_summary["blobKey"].removeprefix("data/"))
    checked(report, "content object bytes", response["status"] == 200 and response["body"] == old["body"])

    cors_path = old_urls[1][0]
    response = client.request("GET", cors_path, {"Origin": ALLOWED_ORIGIN})
    checked(report, "CORS allowed origin", response["status"] == 200 and response["headers"].get("access-control-allow-origin") == ALLOWED_ORIGIN
            and "ETag" in response["headers"].get("access-control-expose-headers", ""))
    response = client.request("GET", cors_path, {"Origin": DENIED_ORIGIN})
    checked(report, "CORS denied origin", response["status"] == 200 and "access-control-allow-origin" not in response["headers"])
    for origin_value, method, requested_headers, status in (
            (ALLOWED_ORIGIN, "GET", "Range", 204), (DENIED_ORIGIN, "GET", "Range", 403),
            (ALLOWED_ORIGIN, "POST", "Range", 403), (ALLOWED_ORIGIN, "GET", "Authorization", 403)):
        response = client.request("OPTIONS", cors_path, {"Origin": origin_value,
            "Access-Control-Request-Method": method, "Access-Control-Request-Headers": requested_headers})
        checked(report, "CORS preflight " + str(len(report["checks"])), response["status"] == status)
    for path in ("/data/releases/" + bad["summary"]["release"] + "/demo.json",
                 "/data/" + bad["summary"]["blobKey"].removeprefix("data/")):
        for method in ("GET", "HEAD"):
            response = client.request(method, path)
            checked(report, "corrupt body fails closed " + method + path, response["status"] == 503
                    and response["headers"].get("cache-control") == "no-store")
    checked(report, "missing historical object", client.request("GET", "/data/releases/" + old_summary["release"] + "/missing.json")["status"] == 404)
    checked(report, "outside data is absent", client.request("GET", "/images/unapproved.json")["status"] == 404)
    checked(report, "data POST prohibited", client.request("POST", old_urls[0][0], body=b"{}")["status"] == 405)

    switched = post("switch")
    checked(report, "switch fixture identity", type(switched) is dict
            and {key: switched.get(key) for key in ("keys", "versions")} == fixture["summary"]
            and {item.get("key") for item in switched.get("changed", [])} == {"data/current.json", "data/v2/current.json"})
    for prefix, release in (("", new_summary["v1Release"]), ("v2/", new_summary["release"])):
        response = client.request("GET", "/data/" + prefix + "current.json")
        checked(report, prefix + "new current pointer", response["status"] == 200
                and parse_response_json(response).get("release") == release)
        exact_get(prefix + "new current logical", "/data/" + prefix + "demo.json", new["body"], release, False)
    for index, (path, release) in enumerate(old_urls):
        exact_get("old URL after current switch " + str(index), path, old["body"], release)
    report["historicalUrls"] = [path for path, _ in old_urls]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resources", required=True)
    parser.add_argument("--worker-url", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--run", action="store_true", help="explicitly run fixed test-bucket HTTP cases")
    args = parser.parse_args(argv)
    resources = resources_from(args.resources)
    origin = validate_worker_url(args.worker_url, resources)
    run_id = args.run_id or uuid.uuid4().hex
    fixture = build_fixture(run_id)
    out = create_output_directory(args.out_dir)
    report = {"status": "PLAN", "scope": "disposable test bucket; synthetic fixed fixtures; no deletion or production",
              "resources": resources, "runId": run_id, "plannedKeys": fixture["summary"]["keys"] + fixture["bindingKeys"],
              "fixture": fixture["summary"], "checks": [], "requests": [],
              "sourceSha256": {name: digest((ROOT / name).read_bytes()) for name in (
                  "workers/r2-platform-test/worker.js", "workers/r2-data-compat/worker.js",
                  "functions/_atlas_data.js", "site/assets/data-release.js",
                  "tools/verify_r2_platform_http.py", "tools/r2_data_protocol.py")}}
    if args.run:
        try:
            run_acceptance(resources, origin, run_id, fixture, report)
            report["status"] = "PASS"
        except Exception:
            report["status"] = "FAIL"
            report["error"] = "Acceptance stopped; inspect recorded fixed requests and checks. No mutation was retried."
    write_json(out / "report.json", report)
    print(json.dumps({"status": report["status"], "report": str(out / "report.json"),
                      "checks": len(report["checks"]), "requests": len(report["requests"])}))
    return 1 if report["status"] == "FAIL" else 0


if __name__ == "__main__":
    sys.exit(main())
