from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "site" / "data"
SHARE_DIR = DATA_DIR / "share"
SHARE_INDEX = DATA_DIR / "share-index.json"
BLOCKED_RATINGS = {"restricted", "r18", "r18g", "nsfw"}
DESC_LIMIT = 180

# 整本 NSFW 的书（suozhang_r18 / mengshen_r18 等）是否也出「只给标题」的分享卡。
# ⚠ 关着。这些书的词条名本身就是露骨描述（"骑乘口交""夫目前犯"…），出卡等于把内容
#   摘要贴进聊天窗口给全群看，点都不用点；而且新版每条词条的地址栏 URL 都自带卡，
#   不再需要主动点分享，曝光面比以前大得多。维护者 2026-09-02 看过实际标题后决定关闭。
#   安全本里的门控词条不同，标题是"R18 0261"这类编号，不受此开关影响、始终只给标题。
#   真要开，改成 True 后重建索引——后端 functions/_share.js 的 titleOnly 分支一直在。
TITLE_ONLY_NSFW_BOOKS = False


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def clean_text(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def normalized_aliases(value: Any) -> list[str]:
    if not isinstance(value, (list, tuple, set)):
        return []
    return [alias for raw in value if (alias := clean_text(raw))]


def to_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def truncate(value: str, limit: int = DESC_LIMIT) -> str:
    text = clean_text(value)
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)].rstrip() + "..."


def is_absolute_url(value: Any) -> bool:
    text = str(value or "")
    return text.startswith("http://") or text.startswith("https://") or text.startswith("data:")


def normalize_base(value: Any) -> str:
    text = str(value or "").strip().rstrip("/")
    if text.startswith("//"):
        return "https:" + text
    if text and not text.startswith(("http://", "https://", "/")):
        return "https://" + text
    return text


def encode_asset_path(value: Any) -> str:
    return "/".join(quote(part, safe="") for part in str(value or "").split("/"))


def with_rev(url: str, entry: dict[str, Any]) -> str:
    rev = str(entry.get("assetRev") or "").strip()
    if not url or not rev:
        return url
    joiner = "&" if "?" in url else "?"
    return f"{url}{joiner}v={quote(rev, safe='')}"


def asset_url(kind: str, entry: dict[str, Any], codex: dict[str, Any], media: dict[str, Any]) -> str:
    file_name = entry.get("original") if kind == "original" else entry.get("image")
    if not file_name:
        return ""
    if is_absolute_url(file_name):
        return with_rev(str(file_name), entry)

    if codex.get("assetPathMode") == "relative":
        base = normalize_base(codex.get("assetBaseUrl"))
        if not base:
            return ""
        return with_rev(f"{base}/{encode_asset_path(file_name)}", entry)

    prefix = media.get("originalPrefix") if kind == "original" else media.get("imagePrefix")
    prefix = prefix or ("originals" if kind == "original" else "images")
    asset_codex_id = entry.get("assetCodexId") or codex.get("id")
    path = "/".join(encode_asset_path(part) for part in [prefix, asset_codex_id, file_name])
    base = normalize_base(media.get("baseUrl"))
    if not base:
        return ""
    return with_rev(f"{base}/{path}", entry)


def is_r18g_name(value: Any) -> bool:
    text = clean_text(value).lower()
    return "r18g" in text or "\u91cd\u53e3" in text


def is_nsfw_path_segment(value: Any) -> bool:
    return clean_text(value).lower() == "nsfw"


def entry_ratings(entry: dict[str, Any]) -> list[str]:
    """Return every declared rating marker, preserving a conservative gate.

    Some imported records use ``rating`` while older records use ``level``;
    checking them with ``or`` lets a benign value in one field mask a blocked
    value in the other.  Treat both fields as independent claims instead.
    """
    values: list[str] = []
    for key in ("rating", "level"):
        raw = entry.get(key)
        items = raw if isinstance(raw, (list, tuple, set)) else [raw]
        for item in items:
            marker = clean_text(item).lower()
            if marker:
                values.append(marker)
    return values


def is_safe_entry(entry: dict[str, Any]) -> bool:
    if any(marker in BLOCKED_RATINGS for marker in entry_ratings(entry)):
        return False
    raw_path = entry.get("path")
    # 缺失 path 的旧条目仍按无目录处理；但非数组值说明数据形状损坏，
    # 不能把字符串 "NSFW" 当成空路径而生成完整分享卡。
    if raw_path is not None and not isinstance(raw_path, list):
        return False
    path = raw_path or []
    if any(is_r18g_name(part) or is_nsfw_path_segment(part) for part in path):
        return False
    return True


def validated_entry_aliases(data: dict[str, Any], meta: dict[str, Any], entries: list[Any]) -> dict[str, str]:
    aliases = data.get("entryAliases", {})
    if not isinstance(aliases, dict) or aliases != meta.get("entryAliases", {}):
        raise ValueError(f"entryAliases must match codex index: {meta.get('id')}")
    current_ids = {entry.get("id") for entry in entries if isinstance(entry, dict)}
    for source, target in aliases.items():
        if (not isinstance(source, str) or not isinstance(target, str)
                or not source or not target or source.strip() != source or target.strip() != target
                or max(len(source), len(target)) > 128
                or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in source + target)
                or source in current_ids or target not in current_ids or target in aliases):
            raise ValueError(f"invalid entryAlias in {meta.get('id')}: {source!r} -> {target!r}")
    return aliases


def add_entry_aliases(entries: dict[str, Any], aliases: dict[str, str]) -> None:
    # 复用已完成门控的卡片，保留对象 id 为规范目标；别名键不参与词条计数。
    for source, target in aliases.items():
        if target in entries:
            entries[source] = entries[target]


def normalize_codex(data: dict[str, Any], meta: dict[str, Any]) -> dict[str, Any]:
    return {
        **data,
        "id": meta.get("id") or data.get("id"),
        "type": meta.get("type") or data.get("type") or "codex",
        "title": meta.get("title") or data.get("title") or data.get("id") or meta.get("id"),
        "selectorTitle": meta.get("selectorTitle") or data.get("selectorTitle") or "",
        "version": meta.get("version") or data.get("version") or "",
        "author": meta.get("author") or data.get("author") or "",
        "nsfw": bool(meta.get("nsfw") or data.get("nsfw")),
        "aliases": normalized_aliases(meta.get("aliases") or data.get("aliases")),
        "assetBaseUrl": normalize_base(meta.get("assetBaseUrl") or meta.get("baseUrl") or data.get("assetBaseUrl") or ""),
        "assetPathMode": meta.get("assetPathMode") or data.get("assetPathMode") or ("relative" if meta.get("dataUrl") else "codex"),
        "entryCount": meta.get("entryCount") or data.get("entryCount") or len(data.get("entries") or []),
    }


def first_image_item(entry: dict[str, Any]) -> dict[str, Any] | None:
    images = entry.get("images")
    if isinstance(images, list) and images:
        item = images[0]
        if isinstance(item, dict) and (item.get("path") or item.get("image")):
            return item
    if entry.get("image"):
        return {"path": entry.get("image"), "original": entry.get("original")}
    return None


def entry_image(entry: dict[str, Any], codex: dict[str, Any], media: dict[str, Any], warnings: list[str]) -> dict[str, Any] | None:
    item = first_image_item(entry)
    if not item:
        return None
    image_file = item.get("path") or item.get("image")
    image_entry = {
        **entry,
        "image": image_file,
        "original": item.get("original") or image_file,
    }
    url = asset_url("image", image_entry, codex, media)
    width = to_int(item.get("width") or entry.get("imageWidth") or 0)
    height = to_int(item.get("height") or entry.get("imageHeight") or 0)
    entry_id = str(entry.get("id") or "")
    if not url.startswith("https://"):
        warnings.append(f"image skipped for {codex.get('id')}:{entry_id}: no https url")
        return None
    if width <= 0 or height <= 0:
        warnings.append(f"image skipped for {codex.get('id')}:{entry_id}: missing size")
        return None
    return {
        "url": url,
        "width": width,
        "height": height,
        "alt": clean_text(entry.get("title") or codex.get("title") or "NovelAI tag image"),
    }


def entry_description(entry: dict[str, Any]) -> str:
    parts: list[str] = []
    path = entry.get("path") if isinstance(entry.get("path"), list) else []
    path_text = " / ".join(clean_text(part) for part in path if clean_text(part))
    if path_text:
        parts.append(path_text)
    tags = clean_text(entry.get("tags") or entry.get("prompt") or "")
    if tags:
        parts.append(tags)
    note = clean_text(entry.get("note") or entry.get("comment") or "")
    if note and not tags:
        parts.append(note)
    return truncate(" | ".join(parts) or "NovelAI tag atlas entry")


def codex_description(codex: dict[str, Any], share_count: int) -> str:
    title = clean_text(codex.get("title") or codex.get("id"))
    version = clean_text(codex.get("version"))
    author = clean_text(codex.get("author"))
    bits = [f"{share_count} shareable entries"]
    if author:
        bits.append(f"author: {author}")
    if version:
        bits.append(f"version: {version}")
    return truncate(f"{title} - " + " / ".join(bits))


def build_title_only_entry(entry: dict[str, Any]) -> dict[str, Any] | None:
    """被门控的词条只借出词条名——不带法典名、分类、提示词、配图。

    维护者 2026-09-01 定的分享策略：R18/受限词条也要出预览卡，但卡上只有标题。
    这里刻意不复用 build_entry，避免以后往那边加字段时顺手漏进门控词条。
    """
    entry_id = clean_text(entry.get("id"))
    title = clean_text(entry.get("title"))
    if not entry_id or not title:
        return None
    return {"id": entry_id, "title": title, "shareable": False}


def build_entry(entry: dict[str, Any], codex: dict[str, Any], media: dict[str, Any], warnings: list[str]) -> dict[str, Any] | None:
    entry_id = clean_text(entry.get("id"))
    if not entry_id:
        warnings.append(f"entry skipped in {codex.get('id')}: missing id")
        return None
    title = clean_text(entry.get("title")) or entry_id
    if title == entry_id:
        warnings.append(f"entry title fallback in {codex.get('id')}:{entry_id}")
    image = entry_image(entry, codex, media, warnings)
    return {
        "id": entry_id,
        "title": title,
        "description": entry_description(entry),
        "image": image,
        "shareable": True,
    }


def build() -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    warnings: list[str] = []
    codexes = read_json(DATA_DIR / "codexes.json", [])
    media = read_json(DATA_DIR / "media.json", {})
    if not isinstance(codexes, list):
        warnings.append("codexes.json is not a list")
        codexes = []
    if not isinstance(media, dict):
        warnings.append("media.json is not an object")
        media = {}

    index: dict[str, Any] = {
        "schema": 1,
        "site": {
            "name": "\u6cd5\u5178\u56fe\u9274",
            "title": "\u6cd5\u5178\u56fe\u9274 | NovelAI Tag Atlas",
            "description": "\u6309\u56fe\u6311\u9009 NovelAI \u63d0\u793a\u8bcd\u3001\u753b\u98ce\u4e32\u4e0e\u6cd5\u5178\u6761\u76ee\u3002",
        },
        "aliases": {},
        "codexes": {},
    }
    per_codex: dict[str, Any] = {}

    for meta in codexes:
        if not isinstance(meta, dict):
            warnings.append("codex metadata skipped: not an object")
            continue
        codex_id = clean_text(meta.get("id"))
        if not codex_id:
            warnings.append("codex metadata skipped: missing id")
            continue
        aliases = normalized_aliases(meta.get("aliases"))
        for alias in aliases:
            index["aliases"][alias] = codex_id

        data = read_json(DATA_DIR / f"{codex_id}.json", {})
        if not isinstance(data, dict):
            data = {}
            warnings.append(f"codex data missing or invalid: {codex_id}")
        codex = normalize_codex(data, meta)
        nsfw = bool(codex.get("nsfw"))
        base_index = {
            "id": codex_id,
            "aliases": aliases,
            "shareable": not nsfw,
        }
        raw_entries = data.get("entries") if isinstance(data.get("entries"), list) else []
        entry_aliases = validated_entry_aliases(data, meta, raw_entries)
        if not raw_entries:
            warnings.append(f"codex has no entries: {codex_id}")

        if nsfw and not TITLE_ONLY_NSFW_BOOKS:
            index["codexes"][codex_id] = base_index
            continue

        if nsfw:
            # 整本门控：索引里依旧不放书名/简介/封面，只多一张按 id 查词条名的表。
            title_only = {}
            for raw_entry in raw_entries:
                if not isinstance(raw_entry, dict):
                    continue
                item = build_title_only_entry(raw_entry)
                if item:
                    title_only[item["id"]] = item
            add_entry_aliases(title_only, entry_aliases)
            index["codexes"][codex_id] = {**base_index, "titleOnly": True}
            per_codex[codex_id] = {
                "schema": 1,
                "id": codex_id,
                "aliases": aliases,
                "shareable": False,
                "titleOnly": True,
                "entries": title_only,
            }
            continue

        entries: dict[str, Any] = {}
        safe_with_image: dict[str, Any] | None = None
        for raw_entry in raw_entries:
            if not isinstance(raw_entry, dict):
                warnings.append(f"entry skipped in {codex_id}: not an object")
                continue
            if not is_safe_entry(raw_entry):
                # 安全本里的门控词条同样只留词条名，其余字段一概不进索引。
                gated = build_title_only_entry(raw_entry)
                if gated:
                    entries[gated["id"]] = gated
                continue
            share_entry = build_entry(raw_entry, codex, media, warnings)
            if not share_entry:
                continue
            entries[share_entry["id"]] = share_entry
            if safe_with_image is None and share_entry.get("image"):
                safe_with_image = share_entry

        cover = safe_with_image.get("image") if safe_with_image else None
        # 只数出完整卡的词条；门控词条虽然也在 entries 里，但不算"可分享"。
        share_count = sum(1 for item in entries.values() if item.get("shareable") is True)
        add_entry_aliases(entries, entry_aliases)
        index["codexes"][codex_id] = {
            **base_index,
            "title": clean_text(codex.get("title") or codex_id),
            "selectorTitle": clean_text(codex.get("selectorTitle")),
            "type": clean_text(codex.get("type") or "codex"),
            "entryCount": to_int(codex.get("entryCount") or len(raw_entries) or 0),
            "shareCount": share_count,
            "cover": cover,
        }
        per_codex[codex_id] = {
            "schema": 1,
            "id": codex_id,
            "aliases": aliases,
            "shareable": True,
            "title": clean_text(codex.get("title") or codex_id),
            "selectorTitle": clean_text(codex.get("selectorTitle")),
            "type": clean_text(codex.get("type") or "codex"),
            "description": codex_description(codex, share_count),
            "entryCount": to_int(codex.get("entryCount") or len(raw_entries) or 0),
            "shareCount": share_count,
            "cover": cover,
            "entries": entries,
        }

    return index, per_codex, warnings


def main() -> int:
    if len(sys.argv) > 1:
        print("Usage: python tools/build_share_index.py")
        return 2

    index, per_codex, warnings = build()
    SHARE_DIR.mkdir(parents=True, exist_ok=True)
    for path in SHARE_DIR.glob("*.json"):
        path.unlink()
    write_json(SHARE_INDEX, index)
    for codex_id, data in per_codex.items():
        write_json(SHARE_DIR / f"{codex_id}.json", data)

    print(f"OK: wrote {SHARE_INDEX.relative_to(ROOT).as_posix()}")
    print(f"OK: wrote {len(per_codex)} codex share files")
    total_entries = sum(int(data.get("shareCount") or 0) for data in per_codex.values())
    print(f"OK: indexed {total_entries} safe entries")
    if warnings:
        print(f"WARNINGS: {len(warnings)}")
        for item in warnings[:200]:
            print(f"WARN: {item}")
        if len(warnings) > 200:
            print(f"WARN: truncated {len(warnings) - 200} additional warnings")
    return 0


if __name__ == "__main__":
    sys.exit(main())
