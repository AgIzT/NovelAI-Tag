"""Content-addressed release preparation and activation over the existing R2 client."""
import concurrent.futures
import datetime as dt
import time
import uuid

try:
    from . import r2_data_protocol as cas
    from .sync_r2 import RETRYABLE_REQUEST_EXCEPTIONS, RETRYABLE_UPLOAD_STATUSES, retry_delay
except ImportError:
    import r2_data_protocol as cas
    from sync_r2 import RETRYABLE_REQUEST_EXCEPTIONS, RETRYABLE_UPLOAD_STATUSES, retry_delay


def legacy():
    try:
        from . import publish_data_r2
    except ImportError:
        import publish_data_r2
    return publish_data_r2


def build_v2_release_plan(data_dir):
    old = legacy()
    files = old.collect_release_files(data_dir)
    manifest = cas.make_manifest({item.relative_path: {"sha256": item.sha256, "size": item.size} for item in files})
    return old.ReleasePlan(manifest["release"], manifest["contentHash"], files, manifest, cas.json_bytes(manifest))


def matches(remote, size, digest):
    return bool(remote and remote.get("size") == size and remote.get("sha256") == digest
                and remote.get("content_type") == cas.JSON_TYPE
                and remote.get("cache_control") == cas.IMMUTABLE_CACHE)


def verify_meta(client, key, size, digest):
    if not matches(client.head_metadata(key), size, digest):
        raise RuntimeError("immutable object verification failed: " + key)


def ensure_bytes(client, key, body):
    size, digest = len(body), cas.sha256(body)
    remote = client.head_metadata(key)
    if remote is not None:
        if not matches(remote, size, digest):
            raise RuntimeError("immutable object conflict; refusing overwrite: " + key)
        return "reused"
    retries = max(0, int(getattr(client, "retries", 0)))
    for attempt in range(retries + 1):
        status = None
        try:
            status = client.create_bytes(key, body, cas.IMMUTABLE_CACHE)
        except RETRYABLE_REQUEST_EXCEPTIONS:
            pass
        remote = client.head_metadata(key)
        if remote is not None:
            if not matches(remote, size, digest):
                raise RuntimeError("immutable object conflict after conditional create: " + key)
            return "uploaded" if status in (200, 201) else "reused"
        if status in (409, 412):
            raise RuntimeError("conditional object create conflict; replan before retry: " + key)
        if status is not None and status not in RETRYABLE_UPLOAD_STATUSES:
            raise RuntimeError(f"conditional object create failed ({status}): {key}")
        if attempt == retries:
            raise RuntimeError("conditional object create outcome unverified: " + key)
        time.sleep(retry_delay(getattr(client, "retry_base_delay", 0), attempt + 1))
    raise AssertionError("unreachable")


def snapshot(client, prefix):
    value, etag = legacy().pointer_snapshot(client, cas.current_key(prefix))
    if value:
        cas.validate_pointer(value, prefix)
    return value, etag


def verify_manifest_files(client, prefix, manifest):
    seen = set()
    for meta in cas.validate_manifest(manifest)["files"].values():
        key = cas.object_key(meta["sha256"], prefix)
        if key not in seen:
            verify_meta(client, key, meta["size"], meta["sha256"])
            seen.add(key)


def load_manifest(client, prefix, release):
    body = client.get_bytes(cas.manifest_key(release, prefix))
    if body is None:
        raise RuntimeError("v2 release manifest is missing")
    manifest = cas.parse_manifest_bytes(body)
    if manifest["release"] != release:
        raise RuntimeError("v2 release identity mismatch")
    verify_meta(client, cas.manifest_key(release, prefix), len(body), cas.sha256(body))
    return manifest


def prepare_v2_release(client, plan, data_prefix="data", public_check=None, workers=8, expected_snapshot=None):
    prefix = cas.data_prefix(data_prefix)
    manifest = cas.validate_manifest(plan.manifest)
    if manifest["release"] != plan.release or cas.json_bytes(manifest) != plan.manifest_bytes:
        raise ValueError("invalid v2 plan identity")
    planned = {item.relative_path: {"size": item.size, "sha256": item.sha256} for item in plan.files}
    if len(planned) != len(plan.files) or planned != manifest["files"]:
        raise ValueError("v2 plan files differ from manifest")
    frozen = expected_snapshot if expected_snapshot is not None else snapshot(client, prefix)
    unique = {item.sha256: item for item in plan.files}
    counts = {"uploaded": 0, "reused": 0, "copied": 0}

    def prepare_file(item):
        body = item.path.read_bytes()
        if len(body) != item.size or cas.sha256(body) != item.sha256:
            raise RuntimeError("file changed after planning: " + item.relative_path)
        return ensure_bytes(client, cas.object_key(item.sha256, prefix), body)

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, int(workers))) as pool:
        for result in pool.map(prepare_file, unique.values()):
            counts[result] += 1
    # Reuse remains metadata-only on R2. The caller froze and hashed the sent bytes.
    ensure_bytes(client, cas.manifest_key(plan.release, prefix), plan.manifest_bytes)
    verify_manifest_files(client, prefix, manifest)
    if public_check:
        public_check(plan)
    return counts, frozen


def activate_prepared_v2(client, manifest, prefix, frozen):
    previous, etag = frozen
    key = cas.current_key(prefix)
    if previous.get("release") == manifest["release"]:
        value, current_etag = snapshot(client, prefix)
        if value != previous or current_etag != etag:
            raise RuntimeError("current pointer conflict during no-op verification")
        return {"pointer": previous, "unchanged": True}
    pointer = {"schemaVersion": 2, "release": manifest["release"], "contentHash": manifest["contentHash"],
               "manifest": cas.manifest_key(manifest["release"], prefix), "operationId": uuid.uuid4().hex,
               "publishedAt": dt.datetime.now(dt.timezone.utc).isoformat()}
    if previous.get("release"):
        pointer["previousRelease"] = previous["release"]
    client.put_pointer(key, cas.json_bytes(pointer), etag)
    if client.get_json(key) != pointer:
        raise RuntimeError("v2 current pointer verification failed")
    return {"pointer": pointer, "unchanged": False}


def publish_v2_release(client, plan, data_prefix="data", public_check=None, workers=8):
    counts, frozen = prepare_v2_release(client, plan, data_prefix, public_check, workers)
    return {**counts, **activate_prepared_v2(client, plan.manifest, data_prefix, frozen)}


def activate_v2_release(client, data_prefix, release):
    prefix = cas.data_prefix(data_prefix)
    frozen = snapshot(client, prefix)
    manifest = load_manifest(client, prefix, cas.valid_release(release))
    verify_manifest_files(client, prefix, manifest)
    return activate_prepared_v2(client, manifest, prefix, frozen)


def check_current_v2_release(client, data_prefix="data"):
    pointer, _etag = snapshot(client, data_prefix)
    if not pointer:
        raise RuntimeError("v2 current pointer is missing")
    manifest = load_manifest(client, data_prefix, pointer["release"])
    verify_manifest_files(client, data_prefix, manifest)
    return pointer, manifest


def publish_dual_release(client, v1_plan, v2_plan, data_prefix="data", public_check=None, workers=8):
    old = legacy()
    v1_files = {item.relative_path: {"sha256": item.sha256, "size": item.size} for item in v1_plan.files}
    if v1_files != v2_plan.manifest["files"]:
        raise ValueError("dual plans must describe the exact same frozen input")
    v1_frozen = old.pointer_snapshot(client, data_prefix + "/current.json")
    v2_frozen = snapshot(client, data_prefix)
    v1_counts, _ = old.prepare_release(client, v1_plan, data_prefix, public_check, workers, v1_frozen)
    v2_counts, _ = prepare_v2_release(client, v2_plan, data_prefix, public_check, workers, v2_frozen)
    # Both complete formats exist before either decision. They are two independent CAS writes.
    v2_result = activate_prepared_v2(client, v2_plan.manifest, data_prefix, v2_frozen)
    try:
        v1_result = old.activate_prepared_release(client, v1_plan, data_prefix, v1_frozen, skip_unchanged=True)
    except Exception as ex:
        raise RuntimeError("dual activation incomplete: v2 decision completed; v1 outcome must be checked before retry") from ex
    return {"v1": {**v1_counts, **v1_result}, "v2": {**v2_counts, **v2_result}}
