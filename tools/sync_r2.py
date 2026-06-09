# -*- coding: utf-8 -*-
"""
Sync local image caches to Cloudflare R2 and keep JSON metadata in sync.

Local caches:
  site/images/<codexId>/<entryId>.jpg
  originals/<codexId>/<entryId>.<ext>

R2 keys:
  images/<codexId>/<entryId>.jpg
  originals/<codexId>/<entryId>.<ext>
"""
import argparse
import concurrent.futures
import datetime as dt
import hashlib
import hmac
import json
import mimetypes
import os
import posixpath
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "site" / "data"
THUMB_DIR = ROOT / "site" / "images"
ORIG_DIR = ROOT / "originals"
MEDIA_PATH = DATA_DIR / "media.json"
CONFIG_PATH = ROOT / "r2_config.json"
MANIFEST_PATH = ROOT / ".r2_sync_manifest.json"
DEFAULT_BUCKET = "novelai-tag-assets"
DEFAULT_IMAGE_PREFIX = "images"
DEFAULT_ORIGINAL_PREFIX = "originals"
ORIGINAL_PRIORITY = {"png": 0, "jpg": 1, "jpeg": 2, "webp": 3, "gif": 4, "avif": 5}
DEFAULT_UPLOAD_WORKERS = 16
DEFAULT_UPLOAD_RETRIES = 3
DEFAULT_RETRY_BASE_DELAY = 1.0
RETRYABLE_UPLOAD_STATUSES = {408, 409, 425, 429, 500, 502, 503, 504}


def load_json(path, default=None):
    if not path.exists():
        return default
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path, data, indent=None):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=indent)


def sha256_hex(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def manifest_entry(path, sha):
    stat = path.stat()
    return {
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "sha256": sha,
    }


def sha256_cached(path, key, manifest_objects, hash_stats=None):
    stat = path.stat()
    cached = (manifest_objects or {}).get(key) or {}
    if (
        cached.get("sha256")
        and cached.get("size") == stat.st_size
        and cached.get("mtime_ns") == stat.st_mtime_ns
    ):
        if hash_stats is not None:
            hash_stats["hit"] += 1
        return cached["sha256"]

    if hash_stats is not None:
        hash_stats["miss"] += 1
    return sha256_hex(path)


def file_rev(paths):
    h = hashlib.sha256()
    for path in paths:
        if path and path.exists():
            h.update(sha256_hex(path).encode("ascii"))
    return h.hexdigest()[:16] if h.digest_size else ""


def rev_from_hashes(hashes):
    h = hashlib.sha256()
    used = False
    for value in hashes:
        if value:
            h.update(value.encode("ascii"))
            used = True
    return h.hexdigest()[:16] if used else ""


def image_dimensions(path):
    if not path or not path.exists():
        return None
    try:
        with Image.open(path) as im:
            return im.size
    except Exception:
        return None


def guess_type(path):
    typ = mimetypes.guess_type(str(path))[0]
    return typ or "application/octet-stream"


def normalize_prefix(value, default):
    value = (value or default).strip().strip("/")
    return value or default


def load_config(required=False):
    cfg = load_json(CONFIG_PATH, {}) or {}
    env_map = {
        "account_id": "R2_ACCOUNT_ID",
        "access_key_id": "R2_ACCESS_KEY_ID",
        "secret_access_key": "R2_SECRET_ACCESS_KEY",
        "bucket": "R2_BUCKET",
        "public_base_url": "R2_PUBLIC_BASE_URL",
        "region": "R2_REGION",
    }
    for key, env in env_map.items():
        if os.environ.get(env):
            cfg[key] = os.environ[env]

    cfg.setdefault("bucket", DEFAULT_BUCKET)
    cfg.setdefault("region", "auto")
    cfg["image_prefix"] = normalize_prefix(cfg.get("image_prefix"), DEFAULT_IMAGE_PREFIX)
    cfg["original_prefix"] = normalize_prefix(cfg.get("original_prefix"), DEFAULT_ORIGINAL_PREFIX)
    cfg.setdefault("cache_control", "public, max-age=31536000, immutable")

    missing = [k for k in ("account_id", "access_key_id", "secret_access_key", "bucket") if not cfg.get(k)]
    if required and missing:
        raise SystemExit(
            "Missing R2 config: "
            + ", ".join(missing)
            + "\nCopy r2_config.example.json to r2_config.json and fill it in."
        )
    return cfg


def media_from_config(cfg):
    existing = load_json(MEDIA_PATH, {}) or {}
    return {
        "baseUrl": (cfg.get("public_base_url") or existing.get("baseUrl") or "").rstrip("/"),
        "bucket": cfg.get("bucket") or existing.get("bucket") or DEFAULT_BUCKET,
        "imagePrefix": cfg.get("image_prefix") or existing.get("imagePrefix") or DEFAULT_IMAGE_PREFIX,
        "originalPrefix": cfg.get("original_prefix") or existing.get("originalPrefix") or DEFAULT_ORIGINAL_PREFIX,
        "localFallback": existing.get("localFallback", True),
    }


def codex_files():
    for path in sorted(DATA_DIR.glob("*.json")):
        if path.name in ("codexes.json", "media.json"):
            continue
        yield path


def first_original(cid, eid, preferred=None):
    cdir = ORIG_DIR / cid
    if preferred:
        candidate = cdir / preferred
        if candidate.exists():
            return preferred, candidate, False
    matches = sorted(cdir.glob(eid + ".*"), key=lambda p: (ORIGINAL_PRIORITY.get(p.suffix.lower().lstrip("."), 99), p.name))
    if not matches:
        return preferred, (cdir / preferred if preferred else None), False
    return matches[0].name, matches[0], len(matches) > 1


def key_for(prefix, cid, filename):
    return posixpath.join(prefix.strip("/"), cid, filename).replace("\\", "/")


def collect_strings_assets():
    assets = []
    strings_dir = THUMB_DIR / "strings"
    if not strings_dir.is_dir():
        return assets
    for path in sorted(strings_dir.iterdir()):
        if path.is_file():
            sha = sha256_hex(path)
            assets.append(("strings-image", "strings", path.name, path, sha))
    return assets


def collect_assets(apply_metadata=False, cfg=None, manifest_objects=None):
    assets = []
    issues = []
    changed_files = []
    hash_stats = {"hit": 0, "miss": 0}
    cfg = cfg or {}
    manifest_objects = manifest_objects or {}
    image_prefix = cfg.get("image_prefix") or DEFAULT_IMAGE_PREFIX
    original_prefix = cfg.get("original_prefix") or DEFAULT_ORIGINAL_PREFIX

    for codex_path in codex_files():
        codex = load_json(codex_path)
        cid = codex.get("id") or codex_path.stem
        changed = False
        imaged = 0

        for entry in codex.get("entries", []):
            image = entry.get("image")
            if not image:
                for key in ("original", "assetRev", "imageWidth", "imageHeight", "assetCodexId"):
                    if key in entry:
                        entry.pop(key, None)
                        changed = True
                continue

            imaged += 1
            eid = entry.get("id")
            asset_cid = entry.get("assetCodexId") or cid
            thumb_path = THUMB_DIR / asset_cid / image
            if not thumb_path.exists():
                issues.append(f"missing thumbnail: {asset_cid}/{image}")
            else:
                dims = image_dimensions(thumb_path)
                if dims and (entry.get("imageWidth") != dims[0] or entry.get("imageHeight") != dims[1]):
                    entry["imageWidth"], entry["imageHeight"] = dims
                    changed = True

            original_name, original_path, duplicate = first_original(asset_cid, eid, entry.get("original"))
            if duplicate:
                issues.append(f"multiple originals for {eid}; using {original_name}")
            if original_name and original_path and original_path.exists():
                if entry.get("original") != original_name:
                    entry["original"] = original_name
                    changed = True
            elif entry.get("original"):
                issues.append(f"missing original: {asset_cid}/{entry['original']}")
            else:
                issues.append(f"missing original for imaged entry: {eid}")

            thumb_key = key_for(image_prefix, asset_cid, image)
            original_key = key_for(original_prefix, asset_cid, original_name) if original_name else ""
            thumb_sha = sha256_cached(thumb_path, thumb_key, manifest_objects, hash_stats) if thumb_path.exists() else ""
            original_sha = (
                sha256_cached(original_path, original_key, manifest_objects, hash_stats)
                if original_key and original_path and original_path.exists()
                else ""
            )
            if thumb_sha:
                rev = rev_from_hashes([thumb_sha, original_sha])
                if entry.get("assetRev") != rev:
                    entry["assetRev"] = rev
                    changed = True

            if thumb_path.exists():
                assets.append(("image", asset_cid, image, thumb_path, thumb_sha))
            if original_name and original_path and original_path.exists():
                assets.append(("original", asset_cid, original_name, original_path, original_sha))

        if codex.get("imagedCount") != imaged:
            codex["imagedCount"] = imaged
            changed = True

        if changed and apply_metadata:
            write_json(codex_path, codex)
            changed_files.append(codex_path)

    update_index(apply_metadata=apply_metadata, changed_files=changed_files)
    return assets, issues, changed_files, hash_stats


def update_index(apply_metadata=False, changed_files=None):
    index_path = DATA_DIR / "codexes.json"
    index = load_json(index_path, [])
    changed = False
    by_id = {}
    for codex_path in codex_files():
        codex = load_json(codex_path)
        by_id[codex.get("id") or codex_path.stem] = codex
    for item in index:
        cid = item.get("id")
        if cid in by_id:
            codex = by_id[cid]
            for key in ("entryCount", "imagedCount"):
                if item.get(key) != codex.get(key):
                    item[key] = codex.get(key)
                    changed = True
    if changed and apply_metadata:
        write_json(index_path, index, indent=2)
        if changed_files is not None:
            changed_files.append(index_path)


class R2Client:
    def __init__(self, cfg):
        self.account_id = cfg["account_id"]
        self.access_key = cfg["access_key_id"]
        self.secret_key = cfg["secret_access_key"]
        self.bucket = cfg["bucket"]
        self.region = cfg.get("region") or "auto"
        self.endpoint = f"https://{self.account_id}.r2.cloudflarestorage.com"
        self.host = f"{self.account_id}.r2.cloudflarestorage.com"

    def _signing_key(self, datestamp):
        def sign(key, msg):
            return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()
        k_date = sign(("AWS4" + self.secret_key).encode("utf-8"), datestamp)
        k_region = sign(k_date, self.region)
        k_service = sign(k_region, "s3")
        return sign(k_service, "aws4_request")

    def _canonical_query(self, query):
        if not query:
            return ""
        pairs = []
        for name, value in query.items():
            if value is None:
                continue
            if isinstance(value, (list, tuple)):
                values = value
            else:
                values = [value]
            for item in values:
                pairs.append((
                    urllib.parse.quote(str(name), safe="-_.~"),
                    urllib.parse.quote(str(item), safe="-_.~"),
                ))
        pairs.sort()
        return "&".join(f"{name}={value}" for name, value in pairs)

    def _request(self, method, key, body=b"", headers=None, query=None):
        headers = dict(headers or {})
        now = dt.datetime.now(dt.timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        datestamp = now.strftime("%Y%m%d")
        payload_hash = hashlib.sha256(body).hexdigest()
        path = "/" + self.bucket + ("/" + key if key else "")
        canonical_uri = urllib.parse.quote(path, safe="/~")
        canonical_query = self._canonical_query(query)

        headers.update({
            "host": self.host,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amz_date,
        })
        canonical_headers = "".join(f"{k.lower()}:{str(headers[k]).strip()}\n" for k in sorted(headers, key=str.lower))
        signed_headers = ";".join(k.lower() for k in sorted(headers, key=str.lower))
        canonical_request = "\n".join([
            method,
            canonical_uri,
            canonical_query,
            canonical_headers,
            signed_headers,
            payload_hash,
        ])
        credential_scope = f"{datestamp}/{self.region}/s3/aws4_request"
        string_to_sign = "\n".join([
            "AWS4-HMAC-SHA256",
            amz_date,
            credential_scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ])
        signature = hmac.new(self._signing_key(datestamp), string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
        headers["Authorization"] = (
            "AWS4-HMAC-SHA256 "
            f"Credential={self.access_key}/{credential_scope}, "
            f"SignedHeaders={signed_headers}, "
            f"Signature={signature}"
        )

        url = self.endpoint + canonical_uri
        if canonical_query:
            url += "?" + canonical_query
        req = urllib.request.Request(url, data=body if method != "HEAD" else None, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return res.status, {k.lower(): v for k, v in res.headers.items()}, res.read()
        except urllib.error.HTTPError as ex:
            return ex.code, {k.lower(): v for k, v in ex.headers.items()}, ex.read()

    def head(self, key):
        return self._request("HEAD", key)

    def put_file(self, key, path, sha, cache_control):
        with open(path, "rb") as fh:
            body = fh.read()
        headers = {
            "Content-Type": guess_type(path),
            "Content-Length": str(len(body)),
            "Cache-Control": cache_control,
            "x-amz-meta-sha256": sha,
        }
        return self._request("PUT", key, body=body, headers=headers)

    def list_objects_v2(self, prefix):
        objects = {}
        token = None
        pages = 0
        prefix = prefix.strip("/")
        if prefix:
            prefix += "/"
        while True:
            query = {
                "list-type": "2",
                "max-keys": "1000",
                "prefix": prefix,
            }
            if token:
                query["continuation-token"] = token
            status, _headers, body = self._request("GET", "", query=query)
            if status >= 400:
                raise RuntimeError(f"list failed for {prefix or '<bucket>'}: {status} {body[:200]!r}")
            pages += 1
            root = ET.fromstring(body)
            for item in root.findall("./{*}Contents"):
                key = item.findtext("./{*}Key")
                size = item.findtext("./{*}Size")
                if not key:
                    continue
                try:
                    size = int(size or "0")
                except ValueError:
                    size = 0
                objects[key] = {
                    "size": size,
                    "etag": (item.findtext("./{*}ETag") or "").strip('"'),
                    "last_modified": item.findtext("./{*}LastModified") or "",
                }
            truncated = (root.findtext("./{*}IsTruncated") or "").lower() == "true"
            token = root.findtext("./{*}NextContinuationToken")
            print(
                f"listed {len(objects)} remote objects under {prefix or '<bucket>'} "
                f"({pages} page(s))",
                flush=True,
            )
            if not truncated or not token:
                break
        return objects


def load_manifest():
    manifest = load_json(MANIFEST_PATH, {}) or {}
    objects = manifest.get("objects")
    if not isinstance(objects, dict):
        objects = {}
    return objects


def write_manifest(cfg, objects):
    data = {
        "version": 2,
        "bucket": cfg.get("bucket") or DEFAULT_BUCKET,
        "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "objects": objects,
    }
    write_json(MANIFEST_PATH, data, indent=2)


def list_remote_objects(client, prefixes):
    remote = {}
    for prefix in prefixes:
        remote.update(client.list_objects_v2(prefix))
    return remote


def remote_needs_upload(remote_objects, manifest_objects, key, path, sha):
    local_size = path.stat().st_size
    remote = remote_objects.get(key)
    manifest = manifest_objects.get(key) or {}
    if not remote:
        return True, f"missing remote object, local size {local_size}"
    remote_size = remote.get("size")
    if remote_size != local_size:
        return True, f"size changed, remote {remote_size}, local {local_size}"
    if manifest.get("sha256") and manifest.get("sha256") != sha:
        return True, "local sha256 changed since last successful sync"
    if manifest.get("sha256") == sha:
        return False, "same size and local sha256 unchanged"
    return False, "same size"


def put_file_with_retries(client, key, path, sha, cache_control, retries, base_delay, log_retry=None):
    attempts = max(1, int(retries) + 1)
    delay = max(0.0, float(base_delay))
    for attempt in range(1, attempts + 1):
        try:
            status, headers, body = client.put_file(key, path, sha, cache_control)
        except Exception as ex:
            if attempt >= attempts:
                raise
            wait = delay * (2 ** (attempt - 1))
            if log_retry:
                log_retry(f"retry {attempt}/{attempts - 1} {key}: {ex}; wait {wait:.1f}s")
            if wait:
                time.sleep(wait)
            continue

        if status in (200, 201):
            return status, headers, body, attempt
        if status not in RETRYABLE_UPLOAD_STATUSES or attempt >= attempts:
            return status, headers, body, attempt

        wait = delay * (2 ** (attempt - 1))
        if log_retry:
            log_retry(f"retry {attempt}/{attempts - 1} {key}: status {status}; wait {wait:.1f}s")
        if wait:
            time.sleep(wait)

    return 0, {}, b"", attempts


def sync_strings_assets(args, cfg, assets):
    if not assets:
        return {"checked": 0, "upload": 0, "skip": 0, "fail": 0}, []

    client = R2Client(cfg)
    cache_control = cfg.get("cache_control") or "public, max-age=31536000, immutable"
    workers = max(1, int(getattr(args, "workers", None) or cfg.get("upload_workers") or DEFAULT_UPLOAD_WORKERS))
    retries = max(0, int(getattr(args, "retries", None) if getattr(args, "retries", None) is not None else cfg.get("upload_retries", DEFAULT_UPLOAD_RETRIES)))
    retry_base_delay = float(
        getattr(args, "retry_base_delay", None)
        if getattr(args, "retry_base_delay", None) is not None
        else cfg.get("retry_base_delay", DEFAULT_RETRY_BASE_DELAY)
    )
    counts = {"checked": 0, "upload": 0, "skip": 0, "fail": 0}
    failures = []
    lock = threading.Lock()

    print("listing remote strings images", flush=True)
    remote_objects = client.list_objects_v2("images/strings")
    print(f"remote strings objects: {len(remote_objects)}", flush=True)

    manifest_objects = load_manifest()
    next_manifest = {}

    pending = []
    for kind, cid, filename, path, sha in assets:
        key = "images/strings/" + filename
        counts["checked"] += 1
        try:
            needs_upload, reason = remote_needs_upload(remote_objects, manifest_objects, key, path, sha)
        except Exception as ex:
            counts["fail"] += 1
            failures.append(f"{key}: {ex}")
            continue
        if not needs_upload:
            counts["skip"] += 1
            next_manifest[key] = manifest_entry(path, sha)
            continue
        counts["upload"] += 1
        if args.dry_run or args.check_only:
            print(f"would upload {key}: {reason}")
            continue
        pending.append((key, path, sha))

    if pending:
        print(f"uploading {len(pending)} strings image(s) with {workers} worker(s), {retries} retries", flush=True)
        done = [0]

        def _upload(item):
            key, path, sha = item
            def _log_retry(message):
                with lock:
                    print(message, flush=True)
            try:
                status, _headers, body, attempts = put_file_with_retries(
                    client, key, path, sha, cache_control, retries, retry_base_delay, log_retry=_log_retry,
                )
                if status not in (200, 201):
                    with lock:
                        counts["fail"] += 1
                        failures.append(f"{key}: {status} {body[:200]!r}")
                else:
                    with lock:
                        next_manifest[key] = manifest_entry(path, sha)
            except Exception as ex:
                with lock:
                    counts["fail"] += 1
                    failures.append(f"{key}: {ex}")
            finally:
                with lock:
                    done[0] += 1
                if done[0] % 250 == 0 or done[0] == len(pending):
                    print(f"strings upload: {done[0]}/{len(pending)}, fail {counts['fail']}", flush=True)

        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(_upload, pending))

    if not args.dry_run and not args.check_only and not failures:
        full_manifest = load_manifest()
        full_manifest.update(next_manifest)
        write_manifest(cfg, full_manifest)

    return counts, failures


def sync_assets(args, cfg, assets, manifest_objects=None):
    client = R2Client(cfg)
    image_prefix = cfg["image_prefix"]
    original_prefix = cfg["original_prefix"]
    cache_control = cfg.get("cache_control") or "public, max-age=31536000, immutable"
    workers = max(1, int(getattr(args, "workers", None) or cfg.get("upload_workers") or DEFAULT_UPLOAD_WORKERS))
    retries = max(0, int(getattr(args, "retries", None) if getattr(args, "retries", None) is not None else cfg.get("upload_retries", DEFAULT_UPLOAD_RETRIES)))
    retry_base_delay = float(
        getattr(args, "retry_base_delay", None)
        if getattr(args, "retry_base_delay", None) is not None
        else cfg.get("retry_base_delay", DEFAULT_RETRY_BASE_DELAY)
    )
    counts = {"checked": 0, "upload": 0, "skip": 0, "fail": 0}
    failures = []
    prefixes = sorted({image_prefix, original_prefix})
    manifest_objects = manifest_objects or {}
    next_manifest = {}
    lock = threading.Lock()

    print("listing remote objects", flush=True)
    remote_objects = list_remote_objects(client, prefixes)
    print(f"remote objects loaded: {len(remote_objects)}", flush=True)

    # Pass 1 (in-memory, fast): diff local vs remote/manifest -> decide skip vs upload.
    pending = []
    for kind, cid, filename, path, sha in assets:
        prefix = image_prefix if kind == "image" else original_prefix
        key = key_for(prefix, cid, filename)
        counts["checked"] += 1
        try:
            needs_upload, reason = remote_needs_upload(remote_objects, manifest_objects, key, path, sha)
        except Exception as ex:
            counts["fail"] += 1
            failures.append(f"{key}: {ex}")
            continue
        if not needs_upload:
            counts["skip"] += 1
            next_manifest[key] = manifest_entry(path, sha)
            if args.verbose:
                print(f"skip {key}: {reason}")
            continue
        counts["upload"] += 1
        if args.dry_run or args.check_only:
            print(f"would upload {key}: {reason}")
            continue
        pending.append((key, path, sha))

    # Pass 2 (parallel): upload only the files that actually need it.
    if pending:
        print(
            f"uploading {len(pending)} object(s) with {workers} parallel worker(s), "
            f"{retries} retries",
            flush=True,
        )
        done = [0]

        def _upload(item):
            key, path, sha = item
            def _log_retry(message):
                with lock:
                    print(message, flush=True)

            try:
                status, _headers, body, attempts = put_file_with_retries(
                    client,
                    key,
                    path,
                    sha,
                    cache_control,
                    retries,
                    retry_base_delay,
                    log_retry=_log_retry,
                )
                if status not in (200, 201):
                    with lock:
                        counts["fail"] += 1
                        failures.append(f"upload failed {key} after {attempts} attempt(s): {status} {body[:200]!r}")
                else:
                    with lock:
                        next_manifest[key] = manifest_entry(path, sha)
                        if attempts > 1:
                            print(f"uploaded {key} after {attempts} attempts", flush=True)
                    if args.verbose:
                        print(f"uploaded {key}")
            except Exception as ex:
                with lock:
                    counts["fail"] += 1
                    failures.append(f"{key}: {ex}")
            finally:
                with lock:
                    done[0] += 1
                    n, nfail = done[0], counts["fail"]
                if n % 250 == 0 or n == len(pending):
                    print(f"upload progress: {n}/{len(pending)}, fail {nfail}", flush=True)

        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(_upload, pending))

    if not args.dry_run and not args.check_only and not failures:
        write_manifest(cfg, next_manifest)
        print(f"local sync manifest updated: {MANIFEST_PATH.name}", flush=True)

    return counts, failures


def write_media(cfg, dry_run=False):
    media = media_from_config(cfg)
    if dry_run:
        return False
    before = load_json(MEDIA_PATH, {}) or {}
    if before != media:
        write_json(MEDIA_PATH, media, indent=2)
        return True
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Report work without writing metadata or uploading.")
    parser.add_argument("--metadata-only", action="store_true", help="Only update JSON metadata and media.json; do not contact R2.")
    parser.add_argument("--check-only", action="store_true", help="Check that configured R2 objects exist; do not upload.")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--workers", type=int, default=None,
                        help="Parallel upload workers (default %d)." % DEFAULT_UPLOAD_WORKERS)
    parser.add_argument("--retries", type=int, default=None,
                        help="Retry failed uploads this many times (default %d)." % DEFAULT_UPLOAD_RETRIES)
    parser.add_argument("--retry-base-delay", type=float, default=None,
                        help="Initial retry backoff in seconds (default %.1f)." % DEFAULT_RETRY_BASE_DELAY)
    args = parser.parse_args()

    need_cfg = not args.metadata_only and not args.dry_run
    cfg = load_config(required=need_cfg)
    apply_metadata = not args.dry_run
    manifest_objects = load_manifest()
    assets, issues, changed_files, hash_stats = collect_assets(
        apply_metadata=apply_metadata,
        cfg=cfg,
        manifest_objects=manifest_objects,
    )

    strings_assets = collect_strings_assets()

    media_changed = False
    if not args.dry_run and not MEDIA_PATH.exists():
        media_changed = write_media(cfg)

    print("R2 sync scan")
    print(f"codex assets found: {len(assets)}")
    print(f"strings images: {len(strings_assets)}")
    print(f"issues: {len(issues)}")
    print(f"hash cache: hit {hash_stats['hit']}, miss {hash_stats['miss']}")
    for issue in issues[:30]:
        print(f"- {issue}")
    if len(issues) > 30:
        print(f"... {len(issues) - 30} more issue(s)")
    if changed_files:
        print(f"metadata files updated: {len(changed_files)}")
    if media_changed:
        print("media config updated: site/data/media.json")

    if args.metadata_only:
        print("metadata-only mode complete.")
        return 0 if not issues else 2

    if args.dry_run and not all(cfg.get(k) for k in ("account_id", "access_key_id", "secret_access_key", "bucket")):
        print("dry-run skipped remote checks because r2_config.json is incomplete.")
        return 0 if not issues else 2

    counts, failures = sync_assets(args, cfg, assets, manifest_objects=manifest_objects)
    print("remote sync")
    for key in ("checked", "upload", "skip", "fail"):
        print(f"{key}: {counts[key]}")

    strings_counts, strings_failures = sync_strings_assets(args, cfg, strings_assets)
    print("strings sync")
    for key in ("checked", "upload", "skip", "fail"):
        print(f"{key}: {strings_counts[key]}")

    all_failures = failures + strings_failures
    for failure in all_failures[:20]:
        print(f"- {failure}")
    if len(all_failures) > 20:
        print(f"... {len(all_failures) - 20} more failure(s)")
    if all_failures:
        return 1
    if args.check_only and counts["upload"]:
        print("check-only found missing or changed remote objects.")
        return 1
    return 0 if not issues else 2


if __name__ == "__main__":
    sys.exit(main())
