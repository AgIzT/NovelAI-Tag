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
import datetime as dt
import hashlib
import hmac
import json
import mimetypes
import os
import posixpath
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "site" / "data"
THUMB_DIR = ROOT / "site" / "images"
ORIG_DIR = ROOT / "originals"
MEDIA_PATH = DATA_DIR / "media.json"
CONFIG_PATH = ROOT / "r2_config.json"
DEFAULT_BUCKET = "novelai-tag-assets"
DEFAULT_IMAGE_PREFIX = "images"
DEFAULT_ORIGINAL_PREFIX = "originals"
ORIGINAL_PRIORITY = {"png": 0, "jpg": 1, "jpeg": 2, "webp": 3, "gif": 4, "avif": 5}


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


def file_rev(paths):
    h = hashlib.sha256()
    for path in paths:
        if path and path.exists():
            h.update(sha256_hex(path).encode("ascii"))
    return h.hexdigest()[:16] if h.digest_size else ""


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


def collect_assets(apply_metadata=False):
    assets = []
    issues = []
    changed_files = []

    for codex_path in codex_files():
        codex = load_json(codex_path)
        cid = codex.get("id") or codex_path.stem
        changed = False
        imaged = 0

        for entry in codex.get("entries", []):
            image = entry.get("image")
            if not image:
                entry.pop("original", None)
                entry.pop("assetRev", None)
                continue

            imaged += 1
            eid = entry.get("id")
            thumb_path = THUMB_DIR / cid / image
            if not thumb_path.exists():
                issues.append(f"missing thumbnail: {cid}/{image}")

            original_name, original_path, duplicate = first_original(cid, eid, entry.get("original"))
            if duplicate:
                issues.append(f"multiple originals for {eid}; using {original_name}")
            if original_name and original_path and original_path.exists():
                if entry.get("original") != original_name:
                    entry["original"] = original_name
                    changed = True
            elif entry.get("original"):
                issues.append(f"missing original: {cid}/{entry['original']}")
            else:
                issues.append(f"missing original for imaged entry: {eid}")

            rev_paths = [thumb_path]
            if original_path and original_path.exists():
                rev_paths.append(original_path)
            if thumb_path.exists():
                rev = file_rev(rev_paths)
                if entry.get("assetRev") != rev:
                    entry["assetRev"] = rev
                    changed = True

            if thumb_path.exists():
                assets.append(("image", cid, image, thumb_path, entry.get("assetRev") or ""))
            if original_name and original_path and original_path.exists():
                assets.append(("original", cid, original_name, original_path, entry.get("assetRev") or ""))

        if codex.get("imagedCount") != imaged:
            codex["imagedCount"] = imaged
            changed = True

        if changed and apply_metadata:
            write_json(codex_path, codex)
            changed_files.append(codex_path)

    update_index(apply_metadata=apply_metadata, changed_files=changed_files)
    return assets, issues, changed_files


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

    def _request(self, method, key, body=b"", headers=None):
        headers = dict(headers or {})
        now = dt.datetime.now(dt.timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        datestamp = now.strftime("%Y%m%d")
        payload_hash = hashlib.sha256(body).hexdigest()
        path = "/" + self.bucket + "/" + key
        canonical_uri = urllib.parse.quote(path, safe="/~")

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
            "",
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


def remote_needs_upload(client, key, path):
    sha = sha256_hex(path)
    status, headers, _ = client.head(key)
    if status == 404:
        return True, sha, "missing"
    if status >= 400:
        return True, sha, f"head failed {status}"
    if headers.get("x-amz-meta-sha256") == sha:
        return False, sha, "same sha256"
    if headers.get("content-length") == str(path.stat().st_size) and not headers.get("x-amz-meta-sha256"):
        return False, sha, "same size, no metadata"
    return True, sha, "changed"


def sync_assets(args, cfg, assets):
    client = R2Client(cfg)
    image_prefix = cfg["image_prefix"]
    original_prefix = cfg["original_prefix"]
    cache_control = cfg.get("cache_control") or "public, max-age=31536000, immutable"
    counts = {"checked": 0, "upload": 0, "skip": 0, "fail": 0}
    failures = []

    for kind, cid, filename, path, _rev in assets:
        prefix = image_prefix if kind == "image" else original_prefix
        key = key_for(prefix, cid, filename)
        counts["checked"] += 1
        try:
            needs_upload, sha, reason = remote_needs_upload(client, key, path)
            if not needs_upload:
                counts["skip"] += 1
                if args.verbose:
                    print(f"skip {key}: {reason}")
                continue
            counts["upload"] += 1
            if args.dry_run or args.check_only:
                print(f"would upload {key}: {reason}")
                continue
            status, _headers, body = client.put_file(key, path, sha, cache_control)
            if status not in (200, 201):
                counts["fail"] += 1
                failures.append(f"upload failed {key}: {status} {body[:200]!r}")
            elif args.verbose:
                print(f"uploaded {key}")
        except Exception as ex:
            counts["fail"] += 1
            failures.append(f"{key}: {ex}")

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
    args = parser.parse_args()

    need_cfg = not args.metadata_only and not args.dry_run
    cfg = load_config(required=need_cfg)
    apply_metadata = not args.dry_run
    assets, issues, changed_files = collect_assets(apply_metadata=apply_metadata)

    media_changed = False
    if not args.dry_run:
        media_changed = write_media(cfg)

    print("R2 sync scan")
    print(f"assets found: {len(assets)}")
    print(f"issues: {len(issues)}")
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

    counts, failures = sync_assets(args, cfg, assets)
    print("remote sync")
    for key in ("checked", "upload", "skip", "fail"):
        print(f"{key}: {counts[key]}")
    for failure in failures[:20]:
        print(f"- {failure}")
    if failures:
        return 1
    if args.check_only and counts["upload"]:
        print("check-only found missing or changed remote objects.")
        return 1
    return 0 if not issues else 2


if __name__ == "__main__":
    sys.exit(main())
