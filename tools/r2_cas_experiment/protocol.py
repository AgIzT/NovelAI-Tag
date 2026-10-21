"""Versioned, cross-language content identity. No credentials or network access."""

import hashlib
import json
import math
import re

CURRENT_KEY = "data/v2/current.json"
OBJECT_PREFIX = "data/objects/sha256/"
IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
JSON_TYPE = "application/json; charset=utf-8"
MAX_FILES = 4096
MAX_SIZE = 268435456
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
RELEASE_RE = re.compile(r"^r2-[0-9a-f]{64}$")
PATH_RE = re.compile(r"^(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.json$")


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"),
                       allow_nan=False) + "\n").encode("utf-8")


def sha256(body):
    return hashlib.sha256(body).hexdigest()


def parse_json(body):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON field")
            result[key] = value
        return result

    def invalid(value):
        raise ValueError("invalid JSON constant: " + value)

    return json.loads(body.decode("utf-8"), object_pairs_hook=pairs, parse_constant=invalid)


def valid_path(path):
    if not isinstance(path, str) or len(path) > 240 or not PATH_RE.fullmatch(path):
        raise ValueError("invalid logical JSON path")
    return path


def valid_release(release):
    if not isinstance(release, str) or not RELEASE_RE.fullmatch(release):
        raise ValueError("invalid v2 release")
    return release


def object_key(digest):
    if not isinstance(digest, str) or not HASH_RE.fullmatch(digest):
        raise ValueError("invalid object digest")
    return f"{OBJECT_PREFIX}{digest[:2]}/{digest}.json"


def manifest_key(release):
    return f"data/v2/releases/{valid_release(release)}/manifest.json"


def make_manifest(files):
    if type(files) is not dict or not 1 <= len(files) <= MAX_FILES:
        raise ValueError("invalid manifest file collection")
    identity = bytearray(b"r2-cas-v2\n")
    normalized = {}
    digest_sizes = {}
    for path in sorted(files):
        valid_path(path)
        meta = files[path]
        if type(meta) is not dict or set(meta) != {"sha256", "size"}:
            raise ValueError("invalid file metadata")
        digest, size = meta["sha256"], meta["size"]
        object_key(digest)
        if type(size) not in (int, float) or not math.isfinite(size) or not 1 <= size <= MAX_SIZE or int(size) != size:
            raise ValueError("invalid file size")
        size = int(size)
        if digest in digest_sizes and digest_sizes[digest] != size:
            raise ValueError("shared object digest has conflicting sizes")
        digest_sizes[digest] = size
        normalized[path] = {"sha256": digest, "size": size}
        identity.extend(f"{path}\0{digest}\0{size}\n".encode("utf-8"))
    digest = sha256(identity)
    return {"schemaVersion": 2, "release": "r2-" + digest,
            "contentHash": digest, "files": normalized}


def validate_manifest(value):
    if type(value) is not dict or set(value) != {"schemaVersion", "release", "contentHash", "files"}:
        raise ValueError("invalid manifest fields")
    if type(value["schemaVersion"]) not in (int, float) or value["schemaVersion"] != 2:
        raise ValueError("unsupported manifest schema")
    expected = make_manifest(value["files"])
    if value != expected:
        raise ValueError("manifest identity mismatch")
    return expected


def parse_manifest_bytes(body):
    value = validate_manifest(parse_json(body))
    if body != json_bytes(value):
        raise ValueError("manifest bytes are not canonical")
    return value


def validate_pointer(value):
    fields = {"schemaVersion", "release", "contentHash", "manifest", "publishedAt", "operationId"}
    if type(value) is not dict or set(value) not in (fields, fields | {"previousRelease"}):
        raise ValueError("invalid pointer fields")
    if type(value["schemaVersion"]) not in (int, float) or value["schemaVersion"] != 2:
        raise ValueError("unsupported pointer schema")
    release = valid_release(value["release"])
    if value["contentHash"] != release[3:] or value["manifest"] != manifest_key(release):
        raise ValueError("pointer identity mismatch")
    if not isinstance(value["operationId"], str) or not re.fullmatch(r"[0-9a-f]{32}", value["operationId"]):
        raise ValueError("invalid operation id")
    if not isinstance(value["publishedAt"], str) or not value["publishedAt"]:
        raise ValueError("invalid publication time")
    if "previousRelease" in value:
        valid_release(value["previousRelease"])
        if value["previousRelease"] == release:
            raise ValueError("invalid previous release")
    return value
