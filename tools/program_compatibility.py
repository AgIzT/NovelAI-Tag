# -*- coding: utf-8 -*-
"""Refuse to activate data that the deployed program cannot render.

只做一件事：把新数据依赖的那几个程序文件，拿本地字节和**正式域上真实部署的字节**比一遍，
不一致或读不到就中止，不做任何 R2 写入。不改 Cloudflare 配置、不碰凭据、不动浏览器缓存。

⚠ **这里曾经还有一道「浏览器缓存等待窗口」，2026-09-01 由维护者定案去掉**（保留核对、去掉计时）。
原因：`required_program_files` 是从数据形态推导的，而并册后的数据**永远**满足条件，
于是那 5 个受监控文件的哈希被永久绑进指纹——**以后随便改动其中一个前端文件，
下一次发数据就要重新等满 4 小时**，哪怕数据改动只是修个错别字。这种形态升级并不常有，
不值得让日常发布长期交这笔税。

**代价是已知并被接受的**：线上 JS 是 `max-age=14400`，老访客最长 4 小时内仍持有旧程序。
所以**新增法典类型、并册这类会改变数据形态的升级，必须由人按顺序来**：
先发程序 → 确认 Pages 部署完成 → **自己等 ≥4 小时** → 再发数据。
本工具只能告诉你「线上程序是不是你本地这份」，不再替你计时。规程见
`docs/运维/R2数据发布与回滚.md`；不兼容窗口里会发生什么，见 `docs/decisions/法典重归类.md`。
"""

import hashlib
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SITE_ORIGIN = "https://novelai.quicktagcloud.com"
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


def ensure_program_ready(files, *, site_origin=DEFAULT_SITE_ORIGIN, site_dir=None, fetch_file=None):
    """本地那几个程序文件必须与正式域上部署的完全一致，否则中止。

    读不到、对不上一律算不通过（fail-closed）。通过只代表「程序已经部署」，
    **不代表老访客的浏览器缓存已经换掉**——那段等待是人的责任，见模块文档。
    """
    files = tuple(sorted(set(files)))
    if not files:
        return {"requiredFiles": [], "ready": True}
    site_dir = Path(site_dir) if site_dir is not None else ROOT / "site"
    fetch_file = fetch_file or fetch_program_file
    site_origin = str(site_origin).rstrip("/")
    parsed = urlsplit(site_origin)
    if parsed.scheme != "https" or not parsed.netloc or parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise ValueError("site_origin must be a public HTTPS origin without a path or credentials")

    problems = []

    def compare(relative):
        local = _program_hash((site_dir / relative).read_bytes())
        body, _ = fetch_file(f"{site_origin}/{relative}")
        return relative, local, _program_hash(body)

    with ThreadPoolExecutor(max_workers=min(6, len(files))) as pool:
        pending = {relative: pool.submit(compare, relative) for relative in files}
        for relative, future in pending.items():
            try:
                relative, local, remote = future.result()
                if local != remote:
                    problems.append(relative + " (deployed bytes differ)")
            except Exception as ex:
                problems.append(relative + " (unavailable: " + type(ex).__name__ + ")")

    if problems:
        raise ProgramCompatibilityError(
            "Deploy the compatible program first, then rerun the data publish/check. "
            "No data release was activated. Files: " + "; ".join(problems)
        )
    return {"requiredFiles": list(files), "ready": True}
