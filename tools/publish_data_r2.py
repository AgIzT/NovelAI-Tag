# -*- coding: utf-8 -*-
"""Publish site/data JSON as an immutable, atomic R2 release."""

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

try:
    from .sync_r2 import (
        DEFAULT_RETRY_BASE_DELAY,
        DEFAULT_UPLOAD_RETRIES,
        R2Client,
        RETRYABLE_UPLOAD_STATUSES,
        load_config,
        request_config,
    )
except ImportError:
    from sync_r2 import (
        DEFAULT_RETRY_BASE_DELAY,
        DEFAULT_UPLOAD_RETRIES,
        R2Client,
        RETRYABLE_UPLOAD_STATUSES,
        load_config,
        request_config,
    )


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "site" / "data"
SCHEMA_VERSION = 1
DEFAULT_DATA_PREFIX = "data"
RELEASE_CACHE_CONTROL = "public, max-age=31536000, immutable"
POINTER_CACHE_CONTROL = "no-store"
RELEASE_RE = re.compile(r"^r-[0-9a-f]{20}$")
REQUIRED_FILES = {
    "about.json",
    "announcements.json",
    "codexes.json",
    "media.json",
    "share-index.json",
    "strings.json",
    "strings_index.json",
}


@dataclass(frozen=True)
class ReleaseFile:
    relative_path: str
    path: Path
    size: int
    sha256: str


@dataclass(frozen=True)
class ReleasePlan:
    release: str
    content_hash: str
    files: tuple
    manifest: dict
    manifest_bytes: bytes


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def sha256_path(path):
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_prefix(value):
    value = str(value or DEFAULT_DATA_PREFIX).strip().strip("/")
    if not value or ".." in value.split("/"):
        raise ValueError("data_prefix must be a safe, non-empty R2 prefix")
    return value


def normalize_release(value):
    value = str(value or "").strip()
    if not RELEASE_RE.fullmatch(value):
        raise ValueError(f"invalid release id: {value!r}")
    return value


def safe_release(value):
    """把不可信来源（远端指针）的 release 洗成合法值或空串，不抛异常。"""
    value = str(value or "").strip()
    return value if RELEASE_RE.fullmatch(value) else ""


def previous_release_for(current_pointer, release):
    """算回滚目标：换版时记住刚才那版；重发同一版时保留原有回滚目标，别把回滚网抹掉。"""
    pointer = current_pointer if isinstance(current_pointer, dict) else {}
    current = safe_release(pointer.get("release"))
    if current and current != release:
        return current
    carried = safe_release(pointer.get("previousRelease"))
    return carried if carried != release else ""


def collect_release_files(data_dir=DATA_DIR):
    data_dir = Path(data_dir).resolve()
    paths = sorted(data_dir.rglob("*.json"))

    relative = {path.relative_to(data_dir).as_posix(): path for path in paths}
    missing = sorted(REQUIRED_FILES - set(relative))
    if missing:
        raise ValueError("missing required data files: " + ", ".join(missing))

    parsed = {}
    files = []
    for name, path in sorted(relative.items()):
        try:
            parsed[name] = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as ex:
            raise ValueError(f"invalid JSON {name}: {ex}") from ex
        files.append(ReleaseFile(name, path, path.stat().st_size, sha256_path(path)))

    index = parsed.get("codexes.json")
    if not isinstance(index, list):
        raise ValueError("codexes.json must contain an array")
    seen = set()
    for item in index:
        cid = str(item.get("id") or "") if isinstance(item, dict) else ""
        if not cid or cid in seen:
            raise ValueError(f"codexes.json contains invalid or duplicate id: {cid!r}")
        seen.add(cid)
        filename = f"{cid}.json"
        if filename not in relative:
            raise ValueError(f"codex data file is missing: {filename}")
        body = parsed[filename]
        if not isinstance(body, dict) or body.get("id") != cid:
            raise ValueError(f"codex file id mismatch: {filename}")

    share_index = parsed.get("share-index.json")
    share_codexes = share_index.get("codexes") if isinstance(share_index, dict) else None
    if not isinstance(share_codexes, dict):
        raise ValueError("share-index.json must contain a codexes object")
    for cid, entry in sorted(share_codexes.items()):
        if not isinstance(entry, dict) or not entry.get("shareable"):
            continue
        shard = f"share/{cid}.json"
        if shard not in relative:
            raise ValueError(f"share shard is missing for a shareable codex: {shard}")
    return tuple(files)


def build_release_plan(data_dir=DATA_DIR):
    files = collect_release_files(data_dir)
    digest = hashlib.sha256()
    for item in files:
        digest.update(item.relative_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(item.sha256.encode("ascii"))
        digest.update(b"\n")
    content_hash = digest.hexdigest()
    release = f"r-{content_hash[:20]}"
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "release": release,
        "contentHash": content_hash,
        "files": {
            item.relative_path: {"sha256": item.sha256, "size": item.size}
            for item in files
        },
    }
    return ReleasePlan(release, content_hash, files, manifest, json_bytes(manifest))


def build_pointer(plan_or_manifest, previous_release="", published_at=None):
    release = normalize_release(plan_or_manifest["release"] if isinstance(plan_or_manifest, dict) else plan_or_manifest.release)
    content_hash = plan_or_manifest["contentHash"] if isinstance(plan_or_manifest, dict) else plan_or_manifest.content_hash
    published_at = published_at or dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    pointer = {
        "schemaVersion": SCHEMA_VERSION,
        "release": release,
        "contentHash": content_hash,
        "manifest": f"releases/{release}/manifest.json",
        "publishedAt": published_at,
    }
    if previous_release and previous_release != release:
        pointer["previousRelease"] = normalize_release(previous_release)
    return pointer


class R2DataClient:
    def __init__(self, cfg):
        self.raw = R2Client(request_config(cfg, argparse.Namespace(
            request_timeout=None,
            request_retries=None,
            retry_base_delay=None,
        )))
        self.retries = max(0, int(cfg.get("upload_retries", DEFAULT_UPLOAD_RETRIES)))
        self.retry_base_delay = float(cfg.get("retry_base_delay", DEFAULT_RETRY_BASE_DELAY))

    def _put_with_retries(self, callback, label):
        attempts = self.retries + 1
        for attempt in range(1, attempts + 1):
            try:
                status, headers, body = callback()
            except Exception as ex:
                if attempt >= attempts:
                    raise
                wait = self.retry_base_delay * (2 ** (attempt - 1))
                print(f"upload retry {attempt}/{self.retries} {label}: {ex}; wait {wait:.1f}s", flush=True)
                if wait:
                    time.sleep(wait)
                continue
            if status in (200, 201):
                return status, headers, body
            if status not in RETRYABLE_UPLOAD_STATUSES or attempt >= attempts:
                raise RuntimeError(f"upload failed {label}: {status} {body[:200]!r}")
            wait = self.retry_base_delay * (2 ** (attempt - 1))
            print(f"upload retry {attempt}/{self.retries} {label}; wait {wait:.1f}s", flush=True)
            if wait:
                time.sleep(wait)
        raise RuntimeError(f"upload failed {label}")

    def head_metadata(self, key):
        status, headers, body = self.raw.head(key)
        if status == 404:
            return None
        if status >= 400:
            raise RuntimeError(f"HEAD failed {key}: {status} {body[:200]!r}")
        return {
            "size": int(headers.get("content-length") or 0),
            "sha256": headers.get("x-amz-meta-sha256") or "",
        }

    def put_file(self, key, item, cache_control):
        return self._put_with_retries(
            lambda: self.raw.put_file(key, item.path, item.sha256, cache_control),
            key,
        )

    def put_bytes(self, key, body, cache_control):
        sha = sha256_bytes(body)
        return self._put_with_retries(
            lambda: self.raw.put_bytes(key, body, sha, "application/json; charset=utf-8", cache_control),
            key,
        )

    def get_json(self, key):
        status, _headers, body = self.raw.get(key)
        if status == 404:
            return None
        if status >= 400:
            raise RuntimeError(f"GET failed {key}: {status} {body[:200]!r}")
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as ex:
            raise RuntimeError(f"invalid remote JSON {key}: {ex}") from ex


def metadata_matches(remote, size, sha):
    return bool(remote and remote.get("size") == size and remote.get("sha256") == sha)


def object_matches(client, key, size, sha):
    return metadata_matches(client.head_metadata(key), size, sha)


def verify_object(client, key, size, sha):
    if not object_matches(client, key, size, sha):
        raise RuntimeError(f"remote verification failed: {key}")


def check_public_release(base_url, site_origin, data_prefix, plan, timeout=30):
    if not base_url:
        raise RuntimeError("public_base_url or data_public_base_url is required for the public CORS check")
    public_data_base = base_url.rstrip("/")
    if not public_data_base.endswith("/" + data_prefix):
        public_data_base += "/" + data_prefix
    url = f"{public_data_base}/releases/{plan.release}/manifest.json"
    request = urllib.request.Request(
        url,
        headers={
            "Origin": site_origin,
            "Accept": "application/json",
            # Cloudflare may challenge Python urllib's default user agent even when
            # the public object and CORS policy are both valid.
            "User-Agent": "NovelAI-Tag-Data-Publisher/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
            allow_origin = response.headers.get("Access-Control-Allow-Origin") or ""
    except (OSError, urllib.error.URLError, urllib.error.HTTPError) as ex:
        raise RuntimeError(f"public release check failed: {url}: {ex}") from ex
    if allow_origin not in ("*", site_origin):
        raise RuntimeError(f"R2 CORS does not allow {site_origin}: {allow_origin or '<missing>'}")
    remote = json.loads(body.decode("utf-8"))
    if remote.get("release") != plan.release or remote.get("contentHash") != plan.content_hash:
        raise RuntimeError("public manifest does not match the release just uploaded")


def publish_release(client, plan, data_prefix=DEFAULT_DATA_PREFIX, public_check=None):
    data_prefix = normalize_prefix(data_prefix)
    release_prefix = f"{data_prefix}/releases/{plan.release}"
    uploaded = 0
    skipped = 0
    for item in plan.files:
        key = f"{release_prefix}/{item.relative_path}"
        # HEAD 已经证明远端对象与本地 size+SHA 一致，跳过时不必再验一次。
        if metadata_matches(client.head_metadata(key), item.size, item.sha256):
            skipped += 1
            continue
        client.put_file(key, item, RELEASE_CACHE_CONTROL)
        uploaded += 1
        verify_object(client, key, item.size, item.sha256)

    manifest_key = f"{release_prefix}/manifest.json"
    manifest_sha = sha256_bytes(plan.manifest_bytes)
    if metadata_matches(client.head_metadata(manifest_key), len(plan.manifest_bytes), manifest_sha):
        skipped += 1
    else:
        client.put_bytes(manifest_key, plan.manifest_bytes, RELEASE_CACHE_CONTROL)
        uploaded += 1
        verify_object(client, manifest_key, len(plan.manifest_bytes), manifest_sha)

    if public_check:
        public_check(plan)

    current_key = f"{data_prefix}/current.json"
    previous = client.get_json(current_key) or {}
    pointer = build_pointer(plan, previous_release=previous_release_for(previous, plan.release))
    pointer_bytes = json_bytes(pointer)
    client.put_bytes(current_key, pointer_bytes, POINTER_CACHE_CONTROL)
    remote_pointer = client.get_json(current_key) or {}
    if remote_pointer.get("release") != plan.release or remote_pointer.get("contentHash") != plan.content_hash:
        raise RuntimeError("current pointer verification failed")
    return {"uploaded": uploaded, "skipped": skipped, "pointer": pointer}


def load_remote_manifest(client, data_prefix, release):
    release = normalize_release(release)
    key = f"{normalize_prefix(data_prefix)}/releases/{release}/manifest.json"
    manifest = client.get_json(key)
    if not isinstance(manifest, dict) or manifest.get("release") != release:
        raise RuntimeError(f"release manifest is missing or invalid: {release}")
    if not isinstance(manifest.get("files"), dict) or not manifest.get("contentHash"):
        raise RuntimeError(f"release manifest is incomplete: {release}")
    return manifest


def verify_manifest_files(client, data_prefix, release, manifest):
    for relative_path, meta in manifest["files"].items():
        key = f"{data_prefix}/releases/{release}/{relative_path}"
        verify_object(client, key, int(meta.get("size") or 0), str(meta.get("sha256") or ""))


def activate_release(client, data_prefix, release):
    data_prefix = normalize_prefix(data_prefix)
    manifest = load_remote_manifest(client, data_prefix, release)
    verify_manifest_files(client, data_prefix, release, manifest)
    current_key = f"{data_prefix}/current.json"
    current = client.get_json(current_key) or {}
    pointer = build_pointer(manifest, previous_release=previous_release_for(current, release))
    pointer_bytes = json_bytes(pointer)
    client.put_bytes(current_key, pointer_bytes, POINTER_CACHE_CONTROL)
    verified = client.get_json(current_key) or {}
    if verified.get("release") != release:
        raise RuntimeError("current pointer verification failed")
    return pointer


def check_current_release(client, data_prefix=DEFAULT_DATA_PREFIX):
    data_prefix = normalize_prefix(data_prefix)
    pointer = client.get_json(f"{data_prefix}/current.json")
    if not isinstance(pointer, dict):
        raise RuntimeError("current data pointer is missing")
    release = normalize_release(pointer.get("release"))
    manifest = load_remote_manifest(client, data_prefix, release)
    verify_manifest_files(client, data_prefix, release, manifest)
    return pointer, manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--publish", action="store_true", help="Upload and activate the local JSON release.")
    actions.add_argument("--check-current", action="store_true", help="Verify the active remote release.")
    actions.add_argument("--activate-release", metavar="RELEASE", help="Activate an existing release after validation.")
    actions.add_argument("--rollback", action="store_true", help="Activate current.json previousRelease.")
    parser.add_argument("--skip-public-check", action="store_true", help="Skip public custom-domain CORS verification.")
    args = parser.parse_args(argv)

    local_action = args.publish or not any((args.check_current, args.activate_release, args.rollback))
    plan = build_release_plan() if local_action else None
    if plan:
        total_size = sum(item.size for item in plan.files)
        print(f"release: {plan.release}")
        print(f"files: {len(plan.files)}")
        print(f"bytes: {total_size}")
    if not any((args.publish, args.check_current, args.activate_release, args.rollback)):
        print("plan only; pass --publish to upload and activate")
        return 0

    cfg = load_config(required=True)
    data_prefix = normalize_prefix(cfg.get("data_prefix") or DEFAULT_DATA_PREFIX)
    client = R2DataClient(cfg)
    if args.check_current:
        pointer, manifest = check_current_release(client, data_prefix)
        print(f"active release OK: {pointer['release']} ({len(manifest['files'])} files)")
        return 0
    if args.activate_release:
        pointer = activate_release(client, data_prefix, args.activate_release)
        print(f"activated release: {pointer['release']}")
        return 0
    if args.rollback:
        current = client.get_json(f"{data_prefix}/current.json") or {}
        target = current.get("previousRelease") or ""
        if not target:
            raise SystemExit("current pointer has no previousRelease")
        pointer = activate_release(client, data_prefix, target)
        print(f"rolled back to: {pointer['release']}")
        return 0

    public_check = None
    if not args.skip_public_check:
        base_url = cfg.get("data_public_base_url") or cfg.get("public_base_url") or ""
        site_origin = str(cfg.get("site_origin") or "https://novelai.quicktagcloud.com").rstrip("/")
        public_check = lambda release_plan: check_public_release(
            base_url, site_origin, data_prefix, release_plan
        )
    result = publish_release(client, plan, data_prefix, public_check=public_check)
    print(f"uploaded: {result['uploaded']}")
    print(f"skipped: {result['skipped']}")
    print(f"activated: {result['pointer']['release']}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, RuntimeError) as ex:
        print(f"ERROR: {ex}", file=sys.stderr)
        sys.exit(1)
