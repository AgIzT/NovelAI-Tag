# -*- coding: utf-8 -*-
"""Build lightweight opening slices (`site/data/opening/<id>.json`) for large codexes.

Allows the frontend to render the first ~50 visible cards and full sidebar tree
from a ~5-15 KB gzip payload, then silently fetch and upgrade to the full codex
in the background.

Usage:
  python tools/build_opening_slices.py            # build into site/data/opening/
  python tools/build_opening_slices.py --check    # print plan without writing
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

try:
    from .codex_note_pack import resolve_entry_note
    from .nai_default_tags import strip_nai_default_suffix
except ImportError:
    from codex_note_pack import resolve_entry_note
    from nai_default_tags import strip_nai_default_suffix


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "site" / "data"
OPENING_DIR_NAME = "opening"

OPENING_SCHEMA = 1
OPENING_MIN_BYTES = 1_000_000  # Generate opening slices for codexes >= 1 MB raw.
OPENING_LIMIT = 50
FEATURED_CODEX_ID = "artist_nai5_personal"
STYLE_CODEX_ID = "artist_nai5_personal"
SINGLE_ROOT = "单画师词典"
UNSORTED = "未归类"
SPECIMEN_SOURCE_ORDER = ("花枝鱼", "AgIzT", "九七", "雨燕", "nax.moe", "MayRain", "wwuumm")
FEATURED_DAYS_BACK = 2
FEATURED_DAYS_AHEAD = 90

NSFW_RATINGS = {"restricted", "r18", "r18g", "nsfw"}
NO_ORIG_SUFFIX_RE = re.compile(r"\s*[（(]无原图[)）]\s*$")
WWUUMM_RE = re.compile(r"^wwuumm(?:$|\s*[（(])", re.I)

HEADER_KEYS = (
    "id",
    "type",
    "title",
    "selectorTitle",
    "version",
    "author",
    "nsfw",
    "entryCount",
    "imagedCount",
    "hasOriginal",
    "originalSections",
    "exampleModel",
    "source",
    "contributors",
    "links",
    "aliases",
    "cover",
    "coverCodexId",
    "coverRev",
    "coverFraming",
    "categoryOrder",
    "emptyCategories",
    "updateFilters",
    "newFilterLabel",
    "tree",
)


def _entry_rating(entry: dict[str, Any]) -> str:
    return str(entry.get("rating") or entry.get("level") or "").lower()


def _is_nsfw_segment(name: Any) -> bool:
    return str(name or "").lower() == "nsfw"


def _is_r18g_name(name: Any) -> bool:
    low = str(name or "").lower()
    return "r18g" in low or "重口" in low


def _is_entry_nsfw(entry: dict[str, Any]) -> bool:
    return _entry_rating(entry) in NSFW_RATINGS


def _is_r18g_entry(entry: dict[str, Any]) -> bool:
    path = entry.get("path")
    return _entry_rating(entry) == "r18g" or (isinstance(path, list) and any(_is_r18g_name(s) for s in path))


def _is_entry_blocked(entry: dict[str, Any], *, allow_nsfw: bool, allow_r18g: bool) -> bool:
    if _is_r18g_entry(entry) and not allow_r18g:
        return True
    path = entry.get("path")
    nsfw_path = isinstance(path, list) and any(_is_nsfw_segment(s) for s in path)
    return (_is_entry_nsfw(entry) or nsfw_path) and not allow_nsfw


def _normalize_category_order(value: Any) -> list[list[str]]:
    if not isinstance(value, list):
        return []
    seen: set[str] = set()
    out: list[list[str]] = []
    for path in value:
        if not isinstance(path, list) or not path or any(not isinstance(p, str) or not p.strip() for p in path):
            continue
        key = json.dumps(path, ensure_ascii=False)
        if key in seen:
            continue
        seen.add(key)
        out.append(list(path))
    return out


def _sort_category_tree(tree: list[dict[str, Any]], category_order: Any) -> list[dict[str, Any]]:
    order = _normalize_category_order(category_order)
    if not order:
        return tree
    ranks = {json.dumps(path, ensure_ascii=False): i for i, path in enumerate(order)}

    def sort_level(nodes: list[dict[str, Any]], prefix: list[str]) -> list[dict[str, Any]]:
        decorated = []
        for idx, node in enumerate(nodes):
            path = [*prefix, node["name"]]
            children = node.get("children")
            new_node = {**node, "children": sort_level(children, path)} if isinstance(children, list) else node
            rank = ranks.get(json.dumps(path, ensure_ascii=False), 10**9)
            decorated.append((rank, idx, new_node))
        decorated.sort(key=lambda item: (item[0], item[1]))
        return [item[2] for item in decorated]

    return sort_level(tree, [])


def _sort_category_entries(entries: list[dict[str, Any]], tree: list[dict[str, Any]], category_order: Any) -> list[dict[str, Any]]:
    if not _normalize_category_order(category_order):
        return entries
    ranks: dict[str, int] = {}

    def walk(nodes: list[dict[str, Any]], prefix: list[str]) -> None:
        for node in nodes or []:
            path = [*prefix, node["name"]]
            ranks[json.dumps(path, ensure_ascii=False)] = len(ranks)
            walk(node.get("children") or [], path)

    walk(tree, [])
    decorated = [
        (ranks.get(json.dumps(e.get("path") or [], ensure_ascii=False), 10**9), idx, e)
        for idx, e in enumerate(entries)
    ]
    decorated.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in decorated]


def _build_tree_from_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    root: dict[str, Any] = {}
    for entry in entries:
        level = root
        for name in entry.get("path") or []:
            node = level.setdefault(name, {"name": name, "count": 0, "children": {}})
            node["count"] += 1
            level = node["children"]

    def to_list(mapping: dict[str, Any]) -> list[dict[str, Any]]:
        return [{"name": n["name"], "count": n["count"], "children": to_list(n["children"])} for n in mapping.values()]

    return to_list(root)


def _specimen_source_rank(entry: dict[str, Any]) -> int:
    path = entry.get("path") or []
    source = str(path[1] if len(path) >= 2 and path[0] == SINGLE_ROOT else "")
    cleaned = NO_ORIG_SUFFIX_RE.sub("", source.strip()).strip()
    try:
        return SPECIMEN_SOURCE_ORDER.index(cleaned)
    except ValueError:
        return len(SPECIMEN_SOURCE_ORDER)


def _load_style_context(codex: dict[str, Any], styles_raw: dict[str, Any] | None) -> dict[str, Any] | None:
    if codex.get("id") != STYLE_CODEX_ID or not isinstance(styles_raw, dict) or styles_raw.get("schema") != 3:
        return None
    prefix = str(styles_raw.get("idPrefix") or "")
    artists_raw = styles_raw.get("artists") or []
    groups_raw = styles_raw.get("groups") or []
    parents_raw = styles_raw.get("parents") or []
    if not artists_raw or not groups_raw or not parents_raw:
        return None

    artists: list[dict[str, Any]] = []
    by_entry: dict[str, int] = {}
    for index, a in enumerate(artists_raw):
        entry_id = prefix + a["e"]
        other_ids = [prefix + x for x in (a.get("x") or [])]
        canonical_id = prefix + (a.get("c") or a["e"])
        artist = {
            "index": index,
            "entryId": entry_id,
            "canonicalEntryId": canonical_id,
            "otherIds": other_ids,
            "post": a.get("p") if isinstance(a.get("p"), (int, float)) else None,
            "group": a["g"],
        }
        artists.append(artist)
        by_entry[entry_id] = index
        for oid in other_ids:
            by_entry[oid] = index

    entries = codex.get("entries") or []
    by_id = {e["id"]: e for e in entries if isinstance(e, dict) and e.get("id")}

    def group_path(g_idx: int) -> list[str]:
        g = groups_raw[g_idx]
        p = parents_raw[g["parent"]]
        return [SINGLE_ROOT, p["name"], g["name"]]

    present: set[int] = set()
    unsorted = 0
    for e in entries:
        path = e.get("path") or []
        if not path or path[0] != SINGLE_ROOT:
            continue
        idx = by_entry.get(e["id"])
        if idx is not None:
            present.add(idx)
        else:
            unsorted += 1

    tally: dict[str, int] = {}
    for idx in present:
        leaf = group_path(artists[idx]["group"])[-1]
        tally[leaf] = tally.get(leaf, 0) + 1

    children: list[dict[str, Any]] = []
    for parent in parents_raw:
        g_nodes = []
        for g_idx in parent["groups"]:
            g_name = groups_raw[g_idx]["name"]
            g_nodes.append({"name": g_name, "count": tally.get(g_name, 0), "children": []})
        children.append({
            "name": parent["name"],
            "count": sum(n["count"] for n in g_nodes),
            "children": g_nodes,
        })
    if unsorted:
        children.append({"name": UNSORTED, "count": unsorted, "children": []})

    raw_tree = codex.get("tree") or _build_tree_from_entries(entries)
    style_tree = [
        {**node, "count": len(present) + unsorted, "children": children} if node.get("name") == SINGLE_ROOT else node
        for node in raw_tree
    ]

    return {
        "artists": artists,
        "groups": groups_raw,
        "parents": parents_raw,
        "byEntry": by_entry,
        "byId": by_id,
        "styleTree": style_tree,
        "groupPath": group_path,
    }


def _deduplicate_style_entries(entries: list[dict[str, Any]], style_ctx: dict[str, Any]) -> list[dict[str, Any]]:
    artists = style_ctx["artists"]
    by_entry = style_ctx["byEntry"]

    def specimen_key(entry: dict[str, Any], artist: dict[str, Any]) -> tuple[int, int]:
        rank = _specimen_source_rank(entry)
        eid = entry["id"]
        if eid == artist["entryId"]:
            pos = 0
        else:
            try:
                pos = artist["otherIds"].index(eid) + 1
            except ValueError:
                pos = len(artist["otherIds"]) + 1
        return (rank, pos)

    picked: dict[int, tuple[tuple[int, int], dict[str, Any]]] = {}
    for entry in entries:
        path = entry.get("path") or []
        if not path or path[0] != SINGLE_ROOT:
            continue
        a_idx = by_entry.get(entry["id"])
        if a_idx is None:
            continue
        artist = artists[a_idx]
        key = specimen_key(entry, artist)
        cur = picked.get(a_idx)
        if cur is None or key < cur[0]:
            picked[a_idx] = (key, entry)

    seen: set[int] = set()
    result: list[dict[str, Any]] = []
    for entry in entries:
        path = entry.get("path") or []
        a_idx = by_entry.get(entry["id"]) if path and path[0] == SINGLE_ROOT else None
        if a_idx is None:
            result.append(entry)
        elif a_idx not in seen:
            seen.add(a_idx)
            result.append(picked[a_idx][1])
    return result


def _sort_style_entries(entries: list[dict[str, Any]], style_ctx: dict[str, Any]) -> list[dict[str, Any]]:
    ranks: dict[str, int] = {}

    def walk(nodes: list[dict[str, Any]], prefix: list[str]) -> None:
        for node in nodes or []:
            path = [*prefix, node["name"]]
            ranks[json.dumps(path, ensure_ascii=False)] = len(ranks)
            walk(node.get("children") or [], path)

    walk(style_ctx["styleTree"], [])
    artists = style_ctx["artists"]
    by_entry = style_ctx["byEntry"]
    group_path = style_ctx["groupPath"]

    decorated = []
    for idx, entry in enumerate(entries):
        path = entry.get("path") or []
        artist = None
        if path and path[0] == SINGLE_ROOT:
            a_idx = by_entry.get(entry["id"])
            if a_idx is not None:
                artist = artists[a_idx]
                eff_path = group_path(artist["group"])
            else:
                eff_path = [SINGLE_ROOT, UNSORTED]
        else:
            eff_path = path
        rank = ranks.get(json.dumps(eff_path, ensure_ascii=False), 10**9)
        post_key = -(artist["post"] if artist and artist["post"] is not None else -1) if artist else 0
        decorated.append((rank, post_key, idx, entry))
    decorated.sort(key=lambda item: (item[0], item[1], item[2]))
    return [item[3] for item in decorated]


def _build_access_view_for_tier(
    codex: dict[str, Any],
    style_ctx: dict[str, Any] | None,
    *,
    allow_nsfw: bool,
    allow_r18g: bool,
) -> dict[str, Any]:
    """Exact mirror of codex-ui.js buildAccessView for one permission tier."""
    entries = codex.get("entries") or []
    empty_paths = codex.get("emptyCategories") or []
    category_order = codex.get("categoryOrder")
    locked = bool(codex.get("nsfw")) and not allow_nsfw

    if locked:
        display_count = len(_deduplicate_style_entries(entries, style_ctx)) if style_ctx else len(entries)
        view: dict[str, Any] = {"tree": [], "hiddenCount": display_count}
        if style_ctx:
            view["visibleCount"] = 0
        return view

    display_count = len(_deduplicate_style_entries(entries, style_ctx)) if style_ctx else None
    root: dict[str, Any] = {}

    def tree_node(mapping: dict[str, Any], name: str) -> dict[str, Any]:
        node = mapping.get(name)
        if node is None:
            node = {"name": name, "count": 0, "nsfwCount": 0, "explicitNsfw": False, "children": {}}
            mapping[name] = node
        return node

    if style_ctx:
        single = next((n for n in style_ctx["styleTree"] if n.get("name") == SINGLE_ROOT), None)
        if single:
            top = tree_node(root, single["name"])
            for parent in single.get("children") or []:
                branch = tree_node(top["children"], parent["name"])
                for group in parent.get("children") or []:
                    tree_node(branch["children"], group["name"])

    hidden_count = 0
    accessible: list[dict[str, Any]] | None = [] if display_count is not None else None
    for entry in entries:
        if _is_entry_blocked(entry, allow_nsfw=allow_nsfw, allow_r18g=allow_r18g):
            hidden_count += 1
        elif accessible is not None:
            accessible.append(entry)

    counted: set[str] = set()
    if accessible is not None:
        safe_first = [
            e for e in accessible
            if not _is_entry_nsfw(e) and not any(_is_nsfw_segment(s) for s in (e.get("path") or []))
        ]
        tree_entries = [*safe_first, *entries]
    else:
        tree_entries = entries

    artists = style_ctx["artists"] if style_ctx else None
    by_entry = style_ctx["byEntry"] if style_ctx else None
    group_path = style_ctx["groupPath"] if style_ctx else None

    for entry in tree_entries:
        if not allow_r18g and _is_r18g_entry(entry):
            continue
        raw_path = entry.get("path") or []
        if accessible is not None and style_ctx:
            a_idx = by_entry.get(entry["id"]) if raw_path and raw_path[0] == SINGLE_ROOT else None
            key = artists[a_idx]["canonicalEntryId"] if a_idx is not None else entry["id"]
            if key in counted:
                continue
            counted.add(key)
            if raw_path and raw_path[0] == SINGLE_ROOT:
                path = group_path(artists[a_idx]["group"]) if a_idx is not None else [SINGLE_ROOT, UNSORTED]
            else:
                path = raw_path
        else:
            path = raw_path
        if not isinstance(path, list):
            continue
        entry_nsfw = _is_entry_nsfw(entry)
        explicit_nsfw_from = next((i for i, seg in enumerate(path) if _is_nsfw_segment(seg)), -1)
        level = root
        for idx, name in enumerate(path):
            cur = tree_node(level, name)
            cur["count"] += 1
            if entry_nsfw:
                cur["nsfwCount"] += 1
            if explicit_nsfw_from >= 0 and idx >= explicit_nsfw_from:
                cur["explicitNsfw"] = True
            level = cur["children"]

    for ep in empty_paths:
        if not isinstance(ep, list) or not ep:
            continue
        level = root
        for name in ep:
            level = tree_node(level, name)["children"]

    def to_list(mapping: dict[str, Any]) -> list[dict[str, Any]]:
        out = []
        for n in mapping.values():
            out.append({
                "name": n["name"],
                "count": n["count"],
                "locked": bool(n["explicitNsfw"] or (n["count"] > 0 and n["nsfwCount"] == n["count"])),
                "children": to_list(n["children"]),
            })
        return out

    result: dict[str, Any] = {
        "tree": _sort_category_tree(to_list(root), category_order),
        "hiddenCount": hidden_count,
    }
    if accessible is not None and display_count is not None:
        visible_count = len(_deduplicate_style_entries(accessible, style_ctx))
        result["visibleCount"] = visible_count
        result["hiddenCount"] = display_count - visible_count
    else:
        result["visibleCount"] = max(0, len(entries) - hidden_count)
    return result


def _fnv1a_32(text: str) -> int:
    h = 2166136261
    for ch in text:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def _is_featured_candidate(entry: dict[str, Any]) -> bool:
    if entry.get("rating") != "safe":
        return False
    if not entry.get("image"):
        return False
    tags = strip_nai_default_suffix(str(entry.get("tags") or entry.get("rawTags") or ""))
    if not tags.startswith("artist:"):
        return False
    path = entry.get("path") or []
    if not path or not str(path[0]).startswith("单画师"):
        return False
    if len(path) >= 2 and WWUUMM_RE.match(str(path[1]).strip()):
        return False
    try:
        return float(entry.get("imageHeight") or 0) > float(entry.get("imageWidth") or 0)
    except (TypeError, ValueError):
        return False


def _decorate_opening_entry(
    entry: dict[str, Any],
    style_ctx: dict[str, Any] | None,
    templates: Any,
) -> dict[str, Any]:
    out = dict(entry)
    # Expand packed note for opening slice entries (only ~50-140 entries, tiny after gzip, zero template coupling).
    if "note" in out and not isinstance(out["note"], str):
        out["note"] = resolve_entry_note(out["note"], templates)
    if style_ctx:
        path = out.get("path") or []
        if path and path[0] == SINGLE_ROOT:
            a_idx = style_ctx["byEntry"].get(out["id"])
            if a_idx is not None:
                artist = style_ctx["artists"][a_idx]
                group = style_ctx["groups"][artist["group"]]
                canon = style_ctx["byId"].get(artist["canonicalEntryId"])
                out["stylePath"] = style_ctx["groupPath"](artist["group"])
                out["styleArtistTitle"] = str((canon or out).get("title") or out.get("title") or "")
                out["styleGroupName"] = group["name"]
                out["stylePost"] = artist["post"]
                out["styleRep"] = True
            else:
                out["stylePath"] = [SINGLE_ROOT, UNSORTED]
    return out


def build_opening_slice(
    codex: dict[str, Any],
    *,
    styles_raw: dict[str, Any] | None = None,
    limit: int = OPENING_LIMIT,
    base_date: dt.date | None = None,
) -> dict[str, Any]:
    entries = codex.get("entries") or []
    templates = codex.get("noteTemplates")
    style_ctx = _load_style_context(codex, styles_raw)

    default_nsfw = bool(codex.get("nsfw"))
    visible = [e for e in entries if not _is_entry_blocked(e, allow_nsfw=default_nsfw, allow_r18g=False)]

    if style_ctx:
        deduped = _deduplicate_style_entries(visible, style_ctx)
        ordered = _sort_style_entries(deduped, style_ctx)
    else:
        raw_tree = codex.get("tree") or _build_tree_from_entries(entries)
        sorted_tree = _sort_category_tree(raw_tree, codex.get("categoryOrder"))
        ordered = _sort_category_entries(visible, sorted_tree, codex.get("categoryOrder"))

    slice_raw = ordered[:limit]
    slice_entries = [_decorate_opening_entry(e, style_ctx, templates) for e in slice_raw]
    slice_ids = {e["id"] for e in slice_entries}

    payload: dict[str, Any] = {"openingSchema": OPENING_SCHEMA}
    for key in HEADER_KEYS:
        if key in codex:
            payload[key] = codex[key]
    payload["entryCount"] = int(codex.get("entryCount") or len(entries))
    payload["imagedCount"] = int(codex.get("imagedCount") or sum(1 for e in entries if e.get("image")))
    payload["entries"] = slice_entries
    payload["openingAccessView"] = {
        "safe": _build_access_view_for_tier(codex, style_ctx, allow_nsfw=False, allow_r18g=False),
        "nsfw": _build_access_view_for_tier(codex, style_ctx, allow_nsfw=True, allow_r18g=False),
        "r18g": _build_access_view_for_tier(codex, style_ctx, allow_nsfw=True, allow_r18g=True),
    }

    if style_ctx:
        payload["openingStyleTree"] = style_ctx["styleTree"]

    if codex.get("id") == FEATURED_CODEX_ID:
        pool = [e for e in entries if _is_featured_candidate(e)]
        if pool:
            anchor = base_date or dt.date.today()
            # Map each artist index -> winning safe deduplicated card so pinned card matches full codex 1-to-1.
            winner_by_artist: dict[int, dict[str, Any]] = {}
            if style_ctx:
                for card in ordered:
                    a_idx = style_ctx["byEntry"].get(card["id"])
                    if a_idx is not None and a_idx not in winner_by_artist:
                        winner_by_artist[a_idx] = card
            featured_by_day: dict[str, str] = {}
            featured_entries: dict[str, dict[str, Any]] = {}
            for offset in range(-FEATURED_DAYS_BACK, FEATURED_DAYS_AHEAD):
                day_dt = anchor + dt.timedelta(days=offset)
                day_key = f"{day_dt.year}-{day_dt.month}-{day_dt.day}"
                raw_pick = pool[_fnv1a_32(day_key) % len(pool)]
                chosen = raw_pick
                if style_ctx:
                    a_idx = style_ctx["byEntry"].get(raw_pick["id"])
                    if a_idx is not None and a_idx in winner_by_artist:
                        chosen = winner_by_artist[a_idx]
                cid = chosen["id"]
                featured_by_day[day_key] = cid
                if cid not in slice_ids and cid not in featured_entries:
                    featured_entries[cid] = _decorate_opening_entry(chosen, style_ctx, templates)
            payload["openingFeaturedByDay"] = featured_by_day
            if featured_entries:
                payload["openingFeaturedEntries"] = featured_entries

    return payload


def _atomic_write(path: Path, body: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(body)
        os.replace(tmp_path, path)
    except BaseException:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def build_all(
    data_dir: Path = DATA_DIR,
    *,
    write: bool = True,
    min_bytes: int = OPENING_MIN_BYTES,
    limit: int = OPENING_LIMIT,
    base_date: dt.date | None = None,
) -> list[dict[str, Any]]:
    codexes_path = data_dir / "codexes.json"
    if not codexes_path.is_file():
        raise FileNotFoundError(f"missing {codexes_path}")
    codexes = json.loads(codexes_path.read_text(encoding="utf-8"))
    styles_path = data_dir / "artist_styles.json"
    styles_raw = json.loads(styles_path.read_text(encoding="utf-8")) if styles_path.is_file() else None

    opening_dir = data_dir / OPENING_DIR_NAME
    expected_files: set[str] = set()
    results: list[dict[str, Any]] = []

    for meta in codexes:
        if not isinstance(meta, dict) or meta.get("dataUrl"):
            continue
        cid = str(meta.get("id") or "").strip()
        if not cid:
            continue
        src_path = data_dir / f"{cid}.json"
        if not src_path.is_file():
            continue
        src_size = src_path.stat().st_size
        if src_size < min_bytes:
            continue
        codex = json.loads(src_path.read_text(encoding="utf-8"))
        slice_obj = build_opening_slice(
            codex,
            styles_raw=styles_raw if cid == STYLE_CODEX_ID else None,
            limit=limit,
            base_date=base_date,
        )
        body = json.dumps(slice_obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        gz_len = len(gzip.compress(body, compresslevel=6))
        out_name = f"{cid}.json"
        expected_files.add(out_name)
        out_path = opening_dir / out_name
        wrote = False
        if write and (not out_path.is_file() or out_path.read_bytes() != body):
            _atomic_write(out_path, body)
            wrote = True
        results.append({
            "id": cid,
            "entries": len(slice_obj["entries"]),
            "featuredEntries": len(slice_obj.get("openingFeaturedEntries") or {}),
            "srcBytes": src_size,
            "rawBytes": len(body),
            "gzBytes": gz_len,
            "wrote": wrote,
        })

    if write and opening_dir.is_dir():
        for stale in sorted(opening_dir.glob("*.json")):
            if stale.name not in expected_files:
                stale.unlink()

    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build lightweight opening slices for large codexes.")
    parser.add_argument("--check", action="store_true", help="Print plan without writing files.")
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR, help="Target data directory.")
    parser.add_argument("--limit", type=int, default=OPENING_LIMIT, help="Number of opening entries per book.")
    parser.add_argument("--min-bytes", type=int, default=OPENING_MIN_BYTES, help="Minimum raw book size to slice.")
    args = parser.parse_args(argv)

    rows = build_all(args.data_dir, write=not args.check, min_bytes=args.min_bytes, limit=args.limit)
    for row in rows:
        extra = f" (+{row['featuredEntries']} featured)" if row["featuredEntries"] else ""
        print(
            f"opening/{row['id']}.json: {row['entries']} entries{extra}, "
            f"{row['rawBytes']/1024:.1f} KB raw, {row['gzBytes']/1024:.1f} KB gzip "
            f"(full {row['srcBytes']/1024/1024:.2f} MiB)"
            + (" [WROTE]" if row["wrote"] else " [OK]" if not args.check else " [PLAN]")
        )
    print(f"opening slices: {len(rows)} books")
    return 0


if __name__ == "__main__":
    sys.exit(main())
