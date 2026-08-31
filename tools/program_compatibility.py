# -*- coding: utf-8 -*-
"""Block incompatible data activation until the deployed program's cache window passes.

No Cloudflare settings, credentials, browser caches or production data are changed.
Only a local record of successfully observed program bytes is written under output/.
"""

import datetime as dt
import hashlib
import json
import math
import os
import re
import tempfile
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SITE_ORIGIN = "https://novelai.quicktagcloud.com"
# 已有访客可能仍持有该期限的旧响应；即使现在缩短响应头，也不能立刻消除它。
BROWSER_CACHE_SECONDS = 4 * 60 * 60
OBSERVATION_PATH = ROOT / "output" / "program-compatibility" / "observation.json"
MERGED_PROGRAM_FILES = (
    "assets/app.js",
    "assets/app/codex-route-compat.js",
    "assets/app/history.js",
    "assets/app/favorites-backup-core.js",
)


class ProgramCompatibilityError(RuntimeError):
    """An expected release stop, not a failed R2 upload."""


def required_program_files(index):
    """已知不兼容数据形状的部署前提；旧数据回滚不受新程序前提阻拦。"""
    if not isinstance(index, list) or any(not isinstance(item, dict) for item in index):
        raise ValueError("codexes.json must contain an array of objects")
    types = {item.get("type") or "codex" for item in index}
    unknown = types - {"codex", "string", "composition", "pack"}
    if unknown:
        raise ValueError("unsupported codex types: " + ", ".join(sorted(unknown)))
    files = set()
    if "composition" in types:
        files.add("assets/app/codex-ui.js")
    if any(
        item.get("id") == "nai45_community_pack"
        or (item.get("id") == "artist_nai45_personal" and "artist_nai45_strings" in (item.get("aliases") or []))
        for item in index
    ):
        files.update(MERGED_PROGRAM_FILES)
    return tuple(sorted(files))


def _program_hash(body):
    # Git for Windows 的 CRLF 与 Pages 的 LF 是同一程序；除此之外按字节比较。
    return hashlib.sha256(body.replace(b"\r\n", b"\n")).hexdigest()


def fetch_program_file(url):
    request = urllib.request.Request(url, headers={
        "User-Agent": "NovelAI-Tag-Program-Check/1.0",
        "Cache-Control": "no-cache",
        "Accept": "text/javascript, */*;q=0.1",
    })
    with urllib.request.urlopen(request, timeout=20) as response:
        body = response.read(2 * 1024 * 1024 + 1)
        if len(body) > 2 * 1024 * 1024:
            raise ValueError("program file exceeds size limit")
        return body, response.headers.get("Cache-Control", "")


def _read_observation(path):
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
        return record if isinstance(record, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_observation(path, record):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="observation-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(record, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def ensure_program_ready(files, *, site_origin=DEFAULT_SITE_ORIGIN, site_dir=None,
                         observation_path=None, fetch_file=None, now=None):
    """Verify exact compatible files, then require the existing browser TTL to elapse.

    A failed/mismatched observation resets the local waiting record. Subsequent
    calls recheck production; a local clock reversal also restarts the wait.
    """
    files = tuple(sorted(set(files)))
    if not files:
        return {"requiredFiles": [], "ready": True}
    site_dir = Path(site_dir) if site_dir is not None else ROOT / "site"
    observation_path = Path(observation_path) if observation_path is not None else OBSERVATION_PATH
    fetch_file = fetch_file or fetch_program_file
    site_origin = str(site_origin).rstrip("/")
    parsed = urlsplit(site_origin)
    if parsed.scheme != "https" or not parsed.netloc or parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise ValueError("site_origin must be a public HTTPS origin without a path or credentials")

    cache_seconds = BROWSER_CACHE_SECONDS
    expected = {}
    problems = []

    def compare(relative):
        local = _program_hash((site_dir / relative).read_bytes())
        body, cache_control = fetch_file(f"{site_origin}/{relative}")
        match = re.search(r"(?:^|,)\s*max-age\s*=\s*\"?(\d+)", cache_control, re.I)
        return relative, local, _program_hash(body), int(match.group(1)) if match else 0

    with ThreadPoolExecutor(max_workers=min(6, len(files))) as pool:
        pending = {relative: pool.submit(compare, relative) for relative in files}
        for relative, future in pending.items():
            try:
                relative, local, remote, ttl = future.result()
                expected[relative] = local
                cache_seconds = max(cache_seconds, ttl)
                if local != remote:
                    problems.append(relative + " (deployed bytes differ)")
            except Exception as ex:
                problems.append(relative + " (unavailable: " + type(ex).__name__ + ")")

    if problems:
        if observation_path.exists():
            _write_observation(observation_path, {})
        raise ProgramCompatibilityError(
            "Deploy the compatible program first, then rerun the data publish/check. "
            "No data release was activated. Files: " + "; ".join(problems)
        )

    fingerprint = hashlib.sha256(json.dumps({
        "origin": site_origin, "files": expected,
    }, sort_keys=True).encode("utf-8")).hexdigest()
    # 以全部探测完成时开始计时，不能把网络请求耗时算进安全窗口。
    now = time.time() if now is None else now
    previous = _read_observation(observation_path)
    first_seen = previous.get("firstObservedAt")
    last_seen = previous.get("lastCheckedAt")
    valid_times = all(type(value) in (int, float) and math.isfinite(value) for value in (first_seen, last_seen))
    if (previous.get("schemaVersion") != 1 or previous.get("fingerprint") != fingerprint
            or not valid_times or not 0 < first_seen <= last_seen <= now):
        first_seen = now
    else:
        # 若曾观察到更长的 max-age，不能靠后一次短响应头缩短旧缓存窗口。
        previous_ttl = previous.get("cacheSeconds")
        if type(previous_ttl) in (int, float) and math.isfinite(previous_ttl):
            cache_seconds = max(cache_seconds, previous_ttl)
    record = {
        "schemaVersion": 1, "origin": site_origin, "fingerprint": fingerprint,
        "files": expected, "firstObservedAt": first_seen, "lastCheckedAt": now,
        "cacheSeconds": cache_seconds,
    }
    _write_observation(observation_path, record)
    ready_at = first_seen + cache_seconds
    if now < ready_at:
        local_time = dt.datetime.fromtimestamp(ready_at, dt.timezone.utc).astimezone().isoformat(timespec="seconds")
        raise ProgramCompatibilityError(
            f"Compatible program verified. Existing browser caches may still be old; "
            f"rerun data publish at or after {local_time} ({math.ceil(ready_at - now)} seconds remaining). "
            "No data release was activated. Keep the compatible program deployed during this window."
        )
    return {"requiredFiles": list(files), "ready": True, "readyAt": ready_at}
