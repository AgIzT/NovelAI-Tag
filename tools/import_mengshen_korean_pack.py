"""Import the classified 梦神 Korean packs into the existing N5/N4.5 books.

The default mode is a read-only plan. ``--apply`` quarantines confirmed source
duplicates, appends only unseen entries, inserts the N5 community/korean
directory level, and updates both books in one rollback-capable transaction.
``--validate`` independently re-scans the installed assets and must be
idempotent.  No R2 upload, release, commit, or push is performed.
"""
from __future__ import annotations

import argparse
import copy
import csv
import json
import os
import re
import shutil
from collections import Counter, defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable

from pack_import_core import (
    IMAGE_EXTS,
    RATING_RANK,
    build_tree,
    clean_character_prompts,
    clean_text,
    inspect_image_task,
    make_staging_directory,
    run_parallel,
    sha256_file,
    validate_asset,
    write_asset_bundle_from_paths,
    write_json,
)
from sd_metadata_inspector import extract_image_metadata


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = (
    ROOT.parent / "新数据" / "N5图包" / "图包型" / "韩网" / "韩网"
)
DATA_DIR = ROOT / "site" / "data"
IMAGE_ROOT = ROOT / "site" / "images"
ORIGINAL_ROOT = ROOT / "originals"
OUTPUT_DIR = ROOT / "output" / "mengshen_korean_pack_import"

N5_BOOK_ID = "nai5_community_pack"
N45_BOOK_ID = "nai45_community_pack"
N45_ASSET_ID = "mengshen_pack"
VERSION = "2026.9.1"

N5_ROOT_LABEL = "梦神 · N5社区图包"
N5_LEGACY_ROOT_LABEL = "梦神 · N5精选图包"
N5_LEGACY_SAFE_PATH = (N5_ROOT_LABEL, "常规")
N5_LEGACY_NSFW_PATH = (N5_ROOT_LABEL, "NSFW")
N5_COMMUNITY_SAFE_PATH = (N5_ROOT_LABEL, "社区整理", "常规")
N5_COMMUNITY_NSFW_PATH = (N5_ROOT_LABEL, "社区整理", "NSFW")
N5_KOREAN_SAFE_PATH = (N5_ROOT_LABEL, "韩网整理", "常规")
N5_KOREAN_NSFW_PATH = (N5_ROOT_LABEL, "韩网整理", "NSFW")

N45_TARGET_PREFIX = ("梦神 · 社区图包", "个人精选韩国图包")
N45_SAFE_PATH = (*N45_TARGET_PREFIX, "常规")
N45_NSFW_PATH = (*N45_TARGET_PREFIX, "NSFW", "R18")

PATH_ORDER = {
    N5_KOREAN_SAFE_PATH: 0,
    N5_KOREAN_NSFW_PATH: 1,
    N45_SAFE_PATH: 2,
    N45_NSFW_PATH: 3,
}
EXPECTED_RATINGS = {
    N5_KOREAN_SAFE_PATH: "safe",
    N5_KOREAN_NSFW_PATH: "r18",
    N45_SAFE_PATH: "safe",
    N45_NSFW_PATH: "r18",
}

# 2026-09-01 像素近似审计唯一强匹配，维护者要求去重后经目视确认是同图。
# 保留套图3中的 PNG，移除外层 NSFW 散图 WebP。
CONFIRMED_VISUAL_DUPLICATES = {
    "1c2abdbdb92db6fc1bafe5a14e08260e36035df9e11cb5ce6bc9314ed59d4006":
        "35288a9f52bdfc0bfb568a1bec394b6d7e685497a8d426fcfc5dcc9449f17fd3",
}

SUSPICIOUS_PROMPT_URL_RE = re.compile(
    r"(?i)(?:https?://|www\.|file://|discord\.gg/|t\.me/|"
    r"(?:pixiv|twitter|x|weibo|bilibili|github)\.com/|"
    r"\b[a-z0-9][a-z0-9.-]*\.(?:com|net|org|cn|io|gg|me|tv|ai)(?:/\S*)?)"
)
SUSPICIOUS_PROMPT_NUMBER_RE = re.compile(r"^[\s\d+.,;:_-]+$")
SUSPICIOUS_PROMPT_PLACEHOLDERS = {
    "test", "testing", "prompt", "prompts", "tag", "tags", "none",
    "null", "unknown", "untitled", "n/a", "na", "xxx", "todo",
    "placeholder",
}


def natural_key(value: str | Path) -> tuple[Any, ...]:
    return tuple(
        int(part) if part.isdigit() else part.casefold()
        for part in re.split(r"(\d+)", str(value).replace("\\", "/"))
    )


def model_family(value: Any) -> str:
    text = clean_text(value).casefold().replace(" ", "")
    if "v4.5" in text or "v45" in text:
        return "nai45"
    if "v5" in text:
        return "nai5"
    return "unknown"


def suspicious_prompt_reason(value: Any) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    if SUSPICIOUS_PROMPT_NUMBER_RE.fullmatch(text) and re.search(r"\d", text):
        return "suspicious_prompt:pure_numeric"
    if SUSPICIOUS_PROMPT_URL_RE.search(text):
        return "suspicious_prompt:url"
    if text.casefold() in SUSPICIOUS_PROMPT_PLACEHOLDERS:
        return "suspicious_prompt:placeholder"
    return None


def supported_direct(directory: Path) -> tuple[list[Path], list[Path]]:
    files: list[Path] = []
    unsupported: list[Path] = []
    for path in sorted(directory.iterdir(), key=lambda item: natural_key(item.name)):
        if not path.is_file():
            continue
        if path.suffix.casefold() in IMAGE_EXTS:
            files.append(path)
        else:
            unsupported.append(path)
    return files, unsupported


def _required_category(model_root: Path, name: str) -> Path:
    matches = [
        path for path in model_root.iterdir()
        if path.is_dir() and path.name.casefold() == name.casefold()
    ]
    if len(matches) != 1:
        raise RuntimeError(f"expected one {name!r} directory below {model_root}, found {matches}")
    return matches[0]


def source_tasks(source: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    groups: list[dict[str, Any]] = []
    unsupported: list[str] = []
    layout_issues: list[str] = []
    source_index = 0

    expected_roots = {"N5", "N4.5"}
    actual_roots = {path.name for path in source.iterdir() if path.is_dir()}
    missing_roots = sorted(expected_roots - actual_roots)
    unexpected_roots = sorted(actual_roots - expected_roots)
    layout_issues.extend(f"missing model directory: {name}" for name in missing_roots)
    layout_issues.extend(f"unexpected model directory: {name}" for name in unexpected_roots)

    def add_group(
        *,
        book_id: str,
        model: str,
        kind: str,
        path: tuple[str, ...],
        rating: str,
        source_folder: Path,
        files: list[Path],
    ) -> None:
        nonlocal source_index
        if not files:
            return
        group_key = f"{book_id}:{source_folder.relative_to(source).as_posix()}"
        entry_order = len(groups) + 1
        group = {
            "groupKey": group_key,
            "entryOrder": entry_order,
            "bookId": book_id,
            "assetCodexId": N5_BOOK_ID if book_id == N5_BOOK_ID else N45_ASSET_ID,
            "modelFamily": model,
            "kind": kind,
            "path": list(path),
            "rating": rating,
            "author": "梦神",
            "sourceFolder": str(source_folder),
            "relativePath": source_folder.relative_to(source).as_posix(),
            "inputImageCount": len(files),
        }
        groups.append(group)
        for image_index, image_path in enumerate(files, 1):
            source_index += 1
            tasks.append({
                "sourceIndex": source_index,
                "sourcePath": str(image_path),
                "relativePath": image_path.relative_to(source).as_posix(),
                "groupKey": group_key,
                "entryOrder": entry_order,
                "imageIndex": image_index,
                "bookId": book_id,
                "assetCodexId": group["assetCodexId"],
                "expectedModelFamily": model,
                "kind": kind,
                "path": list(path),
                "rating": rating,
                "author": "梦神",
                "accepted": False,
                "reason": "unscanned",
                "duplicateOf": "",
            })

    if not missing_roots:
        for folder_name, book_id, model, safe_path, nsfw_path in (
            ("N5", N5_BOOK_ID, "nai5", N5_KOREAN_SAFE_PATH, N5_KOREAN_NSFW_PATH),
            ("N4.5", N45_BOOK_ID, "nai45", N45_SAFE_PATH, N45_NSFW_PATH),
        ):
            model_root = source / folder_name
            safe_dir = _required_category(model_root, "常规")
            nsfw_dir = _required_category(model_root, "nsfw")
            unexpected = [
                path for path in model_root.iterdir()
                if path.is_dir() and path not in {safe_dir, nsfw_dir}
            ]
            layout_issues.extend(f"unexpected category directory: {path}" for path in unexpected)
            nested_safe = [path for path in safe_dir.iterdir() if path.is_dir()]
            layout_issues.extend(f"unexpected safe child directory: {path}" for path in nested_safe)

            safe_files, safe_other = supported_direct(safe_dir)
            nsfw_files, nsfw_other = supported_direct(nsfw_dir)
            unsupported.extend(path.relative_to(source).as_posix() for path in [*safe_other, *nsfw_other])
            for image_path in safe_files:
                add_group(
                    book_id=book_id,
                    model=model,
                    kind="single",
                    path=safe_path,
                    rating="safe",
                    source_folder=image_path,
                    files=[image_path],
                )
            for image_path in nsfw_files:
                add_group(
                    book_id=book_id,
                    model=model,
                    kind="single",
                    path=nsfw_path,
                    rating="r18",
                    source_folder=image_path,
                    files=[image_path],
                )

            suite_dirs = sorted(
                (path for path in nsfw_dir.iterdir() if path.is_dir()),
                key=lambda item: natural_key(item.name),
            )
            if model == "nai45" and suite_dirs:
                layout_issues.extend(f"unexpected N4.5 suite directory: {path}" for path in suite_dirs)
            if model == "nai5":
                for suite_dir in suite_dirs:
                    nested = [path for path in suite_dir.iterdir() if path.is_dir()]
                    layout_issues.extend(f"unexpected nested suite directory: {path}" for path in nested)
                    files, other = supported_direct(suite_dir)
                    unsupported.extend(path.relative_to(source).as_posix() for path in other)
                    add_group(
                        book_id=book_id,
                        model=model,
                        kind="set",
                        path=nsfw_path,
                        rating="r18",
                        source_folder=suite_dir,
                        files=files,
                    )

    return tasks, groups, {
        "source": str(source),
        "inputImages": len(tasks),
        "candidateEntries": len(groups),
        "unsupportedFiles": unsupported,
        "layoutIssues": layout_issues,
    }


def classify_rows(rows: list[dict[str, Any]]) -> None:
    for row in rows:
        row["bytes"] = Path(row["sourcePath"]).stat().st_size if Path(row["sourcePath"]).is_file() else 0
        family = model_family(row.get("sourceModel") or row.get("sourceType"))
        row["modelFamily"] = family
        reason = "accepted"
        if row.get("error"):
            reason = str(row["error"])
        elif not clean_text(row.get("prompt")):
            reason = "no_prompt"
        elif not row.get("promptTagCount"):
            reason = "no_tags_after_parse"
        elif family != row.get("expectedModelFamily"):
            reason = f"wrong_model:{family}"
        else:
            anomaly = suspicious_prompt_reason(row.get("prompt"))
            if anomaly:
                reason = anomaly
        row["accepted"] = reason == "accepted"
        row["reason"] = reason
        row["duplicateOf"] = ""


def mark_source_duplicates(rows: list[dict[str, Any]]) -> None:
    by_hash: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row.get("accepted") and row.get("sha256"):
            by_hash[str(row["sha256"])].append(row)
    for items in by_hash.values():
        if len(items) < 2:
            continue
        keeper = max(
            items,
            key=lambda row: (
                RATING_RANK.get(str(row.get("rating") or ""), -1),
                int(row.get("kind") == "set"),
                -int(row.get("sourceIndex") or 0),
            ),
        )
        for row in items:
            if row is keeper:
                continue
            row["accepted"] = False
            row["reason"] = "exact_duplicate"
            row["duplicateOf"] = keeper["relativePath"]

    accepted_by_hash = {
        str(row["sha256"]): row
        for row in rows if row.get("accepted") and row.get("sha256")
    }
    for row in rows:
        keeper_hash = CONFIRMED_VISUAL_DUPLICATES.get(str(row.get("sha256") or ""))
        keeper = accepted_by_hash.get(str(keeper_hash or ""))
        if not row.get("accepted") or not keeper:
            continue
        row["accepted"] = False
        row["reason"] = "confirmed_visual_duplicate"
        row["duplicateOf"] = keeper["relativePath"]


def finalize_groups(rows: list[dict[str, Any]], groups: list[dict[str, Any]]) -> None:
    by_group: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_group[str(row["groupKey"])].append(row)
    for group in groups:
        members = sorted(by_group.get(str(group["groupKey"]), []), key=lambda row: int(row["imageIndex"]))
        accepted = [row for row in members if row.get("accepted")]
        group["members"] = members
        group["acceptedMembers"] = accepted
        group["acceptedImageCount"] = len(accepted)
        group["duplicateImagesRemoved"] = sum(
            row.get("reason") in {"exact_duplicate", "confirmed_visual_duplicate"}
            for row in members
        )
        group["excludedImages"] = sum(
            not row.get("accepted")
            and row.get("reason") not in {"exact_duplicate", "confirmed_visual_duplicate"}
            for row in members
        )
        group["accepted"] = bool(accepted)
        group["reason"] = "accepted" if accepted else "all_images_rejected"


def audit_source(source: Path, workers: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    tasks, groups, source_info = source_tasks(source)
    rows = run_parallel("Mengshen Korean metadata", inspect_image_task, tasks, workers)
    classify_rows(rows)
    mark_source_duplicates(rows)
    finalize_groups(rows, groups)
    source_info.update({
        "acceptedImages": sum(bool(row.get("accepted")) for row in rows),
        "acceptedEntries": sum(bool(group.get("accepted")) for group in groups),
        "rejectedImageReasons": dict(Counter(
            str(row.get("reason") or "") for row in rows if not row.get("accepted")
        )),
        "modelFamilies": dict(Counter(str(row.get("modelFamily") or "") for row in rows)),
        "metadataSources": dict(Counter(str(row.get("sourceType") or "") for row in rows)),
    })
    return rows, groups, source_info


def image_items(entry: dict[str, Any]) -> list[dict[str, Any]]:
    items = entry.get("images") or []
    if isinstance(items, list) and items:
        return [item for item in items if isinstance(item, dict)]
    return [{"path": entry.get("image"), "original": entry.get("original")}]


def entry_asset_id(book_id: str, entry: dict[str, Any]) -> str:
    return clean_text(entry.get("assetCodexId")) or book_id


def original_path(book_id: str, entry: dict[str, Any], item: dict[str, Any]) -> Path:
    return ORIGINAL_ROOT / entry_asset_id(book_id, entry) / clean_text(item.get("original"))


def is_target_entry(book_id: str, entry: dict[str, Any]) -> bool:
    path = tuple(entry.get("path") or ())
    if book_id == N5_BOOK_ID:
        return path[:2] == (N5_ROOT_LABEL, "韩网整理")
    return path[:2] == N45_TARGET_PREFIX


def current_hash_state(
    book_id: str,
    codex: dict[str, Any],
    candidate_sizes: set[int],
) -> dict[str, Any]:
    hash_refs: dict[str, list[dict[str, Any]]] = defaultdict(list)
    entry_hashes: dict[str, list[str]] = {}
    entry_by_id: dict[str, dict[str, Any]] = {}
    for entry in codex.get("entries") or []:
        entry_id = clean_text(entry.get("id"))
        entry_by_id[entry_id] = entry
        hashes: list[str] = []
        all_candidate_sizes = True
        for position, item in enumerate(image_items(entry), 1):
            path = original_path(book_id, entry, item)
            if not path.is_file():
                raise RuntimeError(f"missing current original: {book_id}/{entry_id}[{position}] {path}")
            if path.stat().st_size not in candidate_sizes:
                all_candidate_sizes = False
                hashes.append("")
                continue
            digest = sha256_file(path)
            hashes.append(digest)
            hash_refs[digest].append({
                "entryId": entry_id,
                "entry": entry,
                "position": position,
                "item": item,
                "target": is_target_entry(book_id, entry),
            })
        if all_candidate_sizes:
            entry_hashes[entry_id] = hashes
    return {
        "entryById": entry_by_id,
        "hashRefs": hash_refs,
        "entryHashes": entry_hashes,
    }


def _legacy_community_path(path: Iterable[Any]) -> list[str] | None:
    value = tuple(str(part) for part in path)
    aliases = {N5_ROOT_LABEL, N5_LEGACY_ROOT_LABEL}
    if len(value) == 2 and value[0] in aliases and value[1] == "常规":
        return list(N5_COMMUNITY_SAFE_PATH)
    if len(value) == 2 and value[0] in aliases and value[1] == "NSFW":
        return list(N5_COMMUNITY_NSFW_PATH)
    if len(value) >= 3 and value[0] == N5_LEGACY_ROOT_LABEL:
        return [N5_ROOT_LABEL, *value[1:]]
    return None


def _maximum_id(entries: Iterable[dict[str, Any]], pattern: str) -> int:
    values: list[int] = []
    regex = re.compile(pattern)
    for entry in entries:
        match = regex.fullmatch(clean_text(entry.get("id")))
        if match:
            values.append(int(match.group(1)))
    return max(values, default=0)


def _maximum_title(entries: Iterable[dict[str, Any]], path: tuple[str, ...], prefix: str) -> int:
    values: list[int] = []
    regex = re.compile(rf"{re.escape(prefix)}\s+(\d+)")
    for entry in entries:
        if tuple(entry.get("path") or ()) != path:
            continue
        match = regex.fullmatch(clean_text(entry.get("title")))
        if match:
            values.append(int(match.group(1)))
    return max(values, default=0)


def bind_groups(
    rows: list[dict[str, Any]],
    groups: list[dict[str, Any]],
    n5: dict[str, Any],
    n45: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    candidate_sizes = {
        int(row.get("bytes") or 0)
        for row in rows if row.get("accepted") and row.get("bytes")
    }
    states = {
        N5_BOOK_ID: current_hash_state(N5_BOOK_ID, n5, candidate_sizes),
        N45_BOOK_ID: current_hash_state(N45_BOOK_ID, n45, candidate_sizes),
    }
    blockers: list[str] = []

    # Existing hashes outside the requested destination are exclusions, not
    # new entries. Existing hashes inside the destination are retained for the
    # idempotent second run and bound below.
    for row in rows:
        if not row.get("accepted"):
            continue
        refs = states[str(row["bookId"])]["hashRefs"].get(str(row["sha256"]), [])
        outside = [ref for ref in refs if not ref["target"]]
        inside = [ref for ref in refs if ref["target"]]
        if outside and inside:
            blockers.append(f"current hash exists both inside and outside target: {row['relativePath']}")
        elif outside:
            row["accepted"] = False
            row["reason"] = "exact_duplicate_current"
            row["duplicateOf"] = outside[0]["entryId"]
    finalize_groups(rows, groups)

    n5_single_id = _maximum_id(
        n5.get("entries") or [],
        rf"{re.escape(N5_BOOK_ID)}_mengshen_korean_(\d+)",
    )
    n5_set_id = _maximum_id(
        n5.get("entries") or [],
        rf"{re.escape(N5_BOOK_ID)}_mengshen_korean_set_(\d+)",
    )
    n5_single_title = _maximum_title(n5.get("entries") or [], N5_KOREAN_SAFE_PATH, "韩网精选")
    n5_single_title = max(
        n5_single_title,
        _maximum_title(n5.get("entries") or [], N5_KOREAN_NSFW_PATH, "韩网精选"),
    )
    n5_set_title = _maximum_title(n5.get("entries") or [], N5_KOREAN_NSFW_PATH, "韩网套图")
    n45_id = _maximum_id(n45.get("entries") or [], r"mengshen_pack-(\d+)")
    n45_safe_title = _maximum_title(n45.get("entries") or [], N45_SAFE_PATH, "常规")
    n45_nsfw_title = _maximum_title(n45.get("entries") or [], N45_NSFW_PATH, "R18")

    accepted_groups = sorted(
        (group for group in groups if group.get("accepted")),
        key=lambda group: (PATH_ORDER[tuple(group["path"])], int(group["entryOrder"])),
    )
    for group in accepted_groups:
        book_id = str(group["bookId"])
        state = states[book_id]
        members = list(group["acceptedMembers"])
        matched_refs = [
            [ref for ref in state["hashRefs"].get(str(row["sha256"]), []) if ref["target"]]
            for row in members
        ]
        if all(len(refs) == 1 for refs in matched_refs):
            entry_ids = {refs[0]["entryId"] for refs in matched_refs}
            if len(entry_ids) != 1:
                blockers.append(f"one source group maps to multiple current entries: {group['relativePath']}")
                continue
            target_id = next(iter(entry_ids))
            expected_hashes = [str(row["sha256"]) for row in members]
            if state["entryHashes"].get(target_id) != expected_hashes:
                blockers.append(f"current set membership/order differs: {group['relativePath']} -> {target_id}")
                continue
            current = state["entryById"][target_id]
            group.update({
                "new": False,
                "targetEntryId": target_id,
                "targetTitle": clean_text(current.get("title")),
                "existingEntryIds": [target_id],
            })
        elif any(matched_refs):
            blockers.append(f"partially installed source group: {group['relativePath']}")
            continue
        else:
            if book_id == N5_BOOK_ID and group["kind"] == "set":
                n5_set_id += 1
                n5_set_title += 1
                target_id = f"{N5_BOOK_ID}_mengshen_korean_set_{n5_set_id:04d}"
                title = f"韩网套图 {n5_set_title:03d}"
            elif book_id == N5_BOOK_ID:
                n5_single_id += 1
                n5_single_title += 1
                target_id = f"{N5_BOOK_ID}_mengshen_korean_{n5_single_id:04d}"
                title = f"韩网精选 {n5_single_title:04d}"
            else:
                n45_id += 1
                target_id = f"mengshen_pack-{n45_id:04d}"
                if tuple(group["path"]) == N45_SAFE_PATH:
                    n45_safe_title += 1
                    title = f"常规 {n45_safe_title:04d}"
                else:
                    n45_nsfw_title += 1
                    title = f"R18 {n45_nsfw_title:04d}"
            if target_id in state["entryById"]:
                blockers.append(f"new ID collision: {target_id}")
            group.update({
                "new": True,
                "targetEntryId": target_id,
                "targetTitle": title,
                "existingEntryIds": [],
            })

        for output_position, row in enumerate(members, 1):
            row["targetEntryId"] = group.get("targetEntryId", "")
            row["outputPosition"] = output_position

    unresolved = [group["relativePath"] for group in accepted_groups if not group.get("targetEntryId")]
    blockers.extend(f"unresolved accepted group: {value}" for value in unresolved)
    target_ids = [str(group.get("targetEntryId") or "") for group in accepted_groups]
    if len(target_ids) != len(set(target_ids)):
        blockers.append("multiple accepted groups resolve to the same entry ID")

    path_changes = []
    for entry in n5.get("entries") or []:
        replacement = _legacy_community_path(entry.get("path") or [])
        if replacement and replacement != entry.get("path"):
            path_changes.append({
                "entryId": entry.get("id"),
                "from": entry.get("path"),
                "to": replacement,
            })
        path = tuple(entry.get("path") or ())
        if path and path[0] in {N5_ROOT_LABEL, N5_LEGACY_ROOT_LABEL}:
            normalized = tuple(replacement or path)
            if normalized[:2] not in {
                (N5_ROOT_LABEL, "社区整理"),
                (N5_ROOT_LABEL, "韩网整理"),
            }:
                blockers.append(f"unknown N5 dream path: {entry.get('id')} {path}")

    plan = {
        "books": {
            N5_BOOK_ID: {
                "oldEntries": len(n5.get("entries") or []),
                "oldImages": sum(len(image_items(entry)) for entry in n5.get("entries") or []),
                "newEntries": sum(group.get("new") for group in accepted_groups if group["bookId"] == N5_BOOK_ID),
                "newImages": sum(
                    group["acceptedImageCount"] for group in accepted_groups
                    if group["bookId"] == N5_BOOK_ID and group.get("new")
                ),
                "communityPathChanges": path_changes,
            },
            N45_BOOK_ID: {
                "oldEntries": len(n45.get("entries") or []),
                "oldImages": sum(len(image_items(entry)) for entry in n45.get("entries") or []),
                "newEntries": sum(group.get("new") for group in accepted_groups if group["bookId"] == N45_BOOK_ID),
                "newImages": sum(
                    group["acceptedImageCount"] for group in accepted_groups
                    if group["bookId"] == N45_BOOK_ID and group.get("new")
                ),
            },
        },
        "paths": {
            " / ".join(path): {
                "entries": sum(group.get("accepted") and tuple(group["path"]) == path for group in groups),
                "images": sum(
                    group.get("acceptedImageCount", 0)
                    for group in groups if group.get("accepted") and tuple(group["path"]) == path
                ),
                "rating": EXPECTED_RATINGS[path],
            }
            for path in PATH_ORDER
        },
        "blockers": list(dict.fromkeys(blockers)),
    }
    plan["wouldChange"] = bool(
        plan["blockers"]
        or path_changes
        or plan["books"][N5_BOOK_ID]["newEntries"]
        or plan["books"][N45_BOOK_ID]["newEntries"]
        or n5.get("version") != VERSION
        or n45.get("version") != VERSION
    )
    return states, plan


def write_reports(
    rows: list[dict[str, Any]],
    groups: list[dict[str, Any]],
    source_info: dict[str, Any],
    plan: dict[str, Any],
) -> dict[str, str]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = OUTPUT_DIR / "update_report.json"
    manifest_path = OUTPUT_DIR / "source_manifest.json"
    entries_path = OUTPUT_DIR / "entries.csv"
    duplicates_path = OUTPUT_DIR / "duplicate_manifest.json"
    write_json(report_path, {
        "auditDate": date.today().isoformat(),
        "sourceAudit": source_info,
        "plan": plan,
    })
    write_json(manifest_path, [
        {
            "source": row.get("relativePath"),
            "sha256": row.get("sha256", ""),
            "bytes": row.get("bytes", 0),
            "bookId": row.get("bookId"),
            "path": row.get("path"),
            "rating": row.get("rating"),
            "kind": row.get("kind"),
            "sourceModel": row.get("sourceModel", ""),
            "modelFamily": row.get("modelFamily", ""),
            "sourceType": row.get("sourceType", ""),
            "prompt": row.get("prompt", ""),
            "negative": row.get("negative", ""),
            "characterPrompts": clean_character_prompts(row.get("characterPrompts")),
            "decision": row.get("reason", ""),
            "duplicateOf": row.get("duplicateOf", ""),
            "targetEntryId": row.get("targetEntryId", ""),
            "outputPosition": row.get("outputPosition", ""),
        }
        for row in rows
    ])
    write_json(duplicates_path, [
        {
            "source": row.get("relativePath"),
            "sha256": row.get("sha256", ""),
            "reason": row.get("reason"),
            "keeper": row.get("duplicateOf", ""),
        }
        for row in rows
        if row.get("reason") in {"exact_duplicate", "confirmed_visual_duplicate"}
    ])
    with entries_path.open("w", encoding="utf-8-sig", newline="") as handle:
        fields = [
            "source", "bookId", "kind", "displayPath", "rating",
            "inputImages", "acceptedImages", "targetEntryId", "targetTitle",
            "new", "decision",
        ]
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for group in groups:
            writer.writerow({
                "source": group["relativePath"],
                "bookId": group["bookId"],
                "kind": group["kind"],
                "displayPath": " / ".join(group["path"]),
                "rating": group["rating"],
                "inputImages": group["inputImageCount"],
                "acceptedImages": group.get("acceptedImageCount", 0),
                "targetEntryId": group.get("targetEntryId", ""),
                "targetTitle": group.get("targetTitle", ""),
                "new": group.get("new", ""),
                "decision": group.get("reason", ""),
            })
    return {
        "report": str(report_path),
        "manifest": str(manifest_path),
        "entries": str(entries_path),
        "duplicates": str(duplicates_path),
    }


def load_books() -> tuple[dict[str, Any], dict[str, Any]]:
    n5_path = DATA_DIR / f"{N5_BOOK_ID}.json"
    n45_path = DATA_DIR / f"{N45_BOOK_ID}.json"
    if not n5_path.is_file() or not n45_path.is_file():
        raise RuntimeError("installed N5/N4.5 community books are incomplete")
    return (
        json.loads(n5_path.read_text(encoding="utf-8")),
        json.loads(n45_path.read_text(encoding="utf-8")),
    )


def run_plan(
    source: Path,
    workers: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any], dict[str, Any], dict[str, Any]]:
    n5, n45 = load_books()
    rows, groups, source_info = audit_source(source, workers)
    _states, plan = bind_groups(rows, groups, n5, n45)
    blockers = [
        *(source_info.get("layoutIssues") or []),
        *(f"unsupported file: {path}" for path in source_info.get("unsupportedFiles") or []),
        *(plan.get("blockers") or []),
    ]
    source_info["acceptedImages"] = sum(bool(row.get("accepted")) for row in rows)
    source_info["acceptedEntries"] = sum(bool(group.get("accepted")) for group in groups)
    source_info["rejectedImageReasons"] = dict(Counter(
        str(row.get("reason") or "") for row in rows if not row.get("accepted")
    ))
    source_info["blockers"] = list(dict.fromkeys(blockers))
    plan["blockers"] = source_info["blockers"]
    plan["wouldChange"] = bool(plan["wouldChange"] or plan["blockers"])
    files = write_reports(rows, groups, source_info, plan)
    return rows, groups, source_info, plan, {"n5": n5, "n45": n45, "files": files}


def entry_from_group(group: dict[str, Any], asset: dict[str, Any]) -> dict[str, Any]:
    rows = list(group["acceptedMembers"])
    cover = rows[0]
    notes: list[str] = []
    if group["kind"] == "set":
        notes.append(
            f"套图：{len(rows)} 张；每张正向提示词保存在对应图片 raw tag，"
            "顶层正向、负面与角色框取封面。"
        )
        if len(rows) != int(group["inputImageCount"]):
            notes.append(
                f"源文件夹 {group['inputImageCount']} 张，去重/校验后保留 {len(rows)} 张。"
            )
    if clean_text(cover.get("note")):
        notes.append(clean_text(cover["note"]))
    entry = {
        "title": group["targetTitle"],
        "path": list(group["path"]),
        "tags": clean_text(cover.get("prompt")),
        **({"negative": clean_text(cover.get("negative"))} if clean_text(cover.get("negative")) else {}),
        **({"characterPrompts": clean_character_prompts(cover.get("characterPrompts"))} if cover.get("characterPrompts") else {}),
        **({"note": "\n".join(notes)} if notes else {}),
        "rating": group["rating"],
        "isNew": True,
        "id": group["targetEntryId"],
        **{key: value for key, value in asset.items() if key != "entryId"},
    }
    if group["bookId"] == N45_BOOK_ID:
        entry["assetCodexId"] = N45_ASSET_ID
    return entry


def build_payloads(
    old_n5: dict[str, Any],
    old_n45: dict[str, Any],
    groups: list[dict[str, Any]],
    assets: dict[tuple[str, str], dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    new_groups = [group for group in groups if group.get("accepted") and group.get("new")]
    n5_additions = [
        entry_from_group(group, assets[(N5_BOOK_ID, str(group["targetEntryId"]))])
        for group in new_groups if group["bookId"] == N5_BOOK_ID
    ]
    n45_additions = [
        entry_from_group(group, assets[(N45_BOOK_ID, str(group["targetEntryId"]))])
        for group in new_groups if group["bookId"] == N45_BOOK_ID
    ]

    community: list[dict[str, Any]] = []
    korean: list[dict[str, Any]] = []
    other: list[dict[str, Any]] = []
    for original in old_n5.get("entries") or []:
        entry = copy.deepcopy(original)
        replacement = _legacy_community_path(entry.get("path") or [])
        if replacement:
            entry["path"] = replacement
        path = tuple(entry.get("path") or ())
        if path[:2] == (N5_ROOT_LABEL, "社区整理"):
            community.append(entry)
        elif path[:2] == (N5_ROOT_LABEL, "韩网整理"):
            korean.append(entry)
        else:
            other.append(entry)
    korean.extend(n5_additions)
    n5_entries = [*community, *korean, *other]
    n5 = copy.deepcopy(old_n5)
    n5.update({
        "version": VERSION,
        "entryCount": len(n5_entries),
        "imagedCount": sum(bool(entry.get("image")) for entry in n5_entries),
        "tree": build_tree(n5_entries),
        "entries": n5_entries,
    })
    n5.pop("nsfw", None)

    n45_entries = copy.deepcopy(old_n45.get("entries") or [])
    for path in (N45_SAFE_PATH, N45_NSFW_PATH):
        additions = [entry for entry in n45_additions if tuple(entry["path"]) == path]
        if not additions:
            continue
        positions = [index for index, entry in enumerate(n45_entries) if tuple(entry.get("path") or ()) == path]
        if not positions:
            raise RuntimeError(f"target N4.5 path is missing: {path}")
        insert_at = positions[-1] + 1
        n45_entries[insert_at:insert_at] = additions
    n45 = copy.deepcopy(old_n45)
    n45.update({
        "version": VERSION,
        "entryCount": len(n45_entries),
        "imagedCount": sum(bool(entry.get("image")) for entry in n45_entries),
        "tree": build_tree(n45_entries),
        "entries": n45_entries,
    })
    n45.pop("nsfw", None)
    return n5, n45


def book_index_fields(codex: dict[str, Any]) -> dict[str, Any]:
    return {
        key: copy.deepcopy(value)
        for key, value in codex.items()
        if key not in {"tree", "entries"}
    }


def index_meta(
    codex: dict[str, Any],
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Update book-owned metadata without deleting index-only picker fields."""
    result = copy.deepcopy(existing) if existing is not None else {}
    result.update(book_index_fields(codex))
    return result


def index_cover_issue(item: dict[str, Any], image_root: Path = IMAGE_ROOT) -> str | None:
    book_id = clean_text(item.get("id"))
    cover = clean_text(item.get("cover"))
    if not cover:
        return f"{book_id}:index_cover_missing"
    if item.get("assetPathMode") == "relative":
        return None
    asset_id = clean_text(item.get("coverCodexId")) or book_id
    if not (image_root / asset_id / cover).is_file():
        return f"{book_id}:index_cover_asset_missing:{asset_id}/{cover}"
    return None


def index_contract_issues(
    index: list[dict[str, Any]],
    books: dict[str, dict[str, Any]],
) -> list[str]:
    rows = {clean_text(item.get("id")): item for item in index}
    issues: list[str] = []
    for book_id, codex in books.items():
        row = rows.get(book_id)
        if row is None:
            issues.append(f"{book_id}:index_row_missing")
            continue
        for key, value in book_index_fields(codex).items():
            if row.get(key) != value:
                issues.append(f"{book_id}:index_metadata_mismatch:{key}")
        cover_issue = index_cover_issue(row)
        if cover_issue:
            issues.append(cover_issue)
    return issues


def updated_index(n5: dict[str, Any], n45: dict[str, Any]) -> list[dict[str, Any]]:
    index = json.loads((DATA_DIR / "codexes.json").read_text(encoding="utf-8"))
    replacements = {N5_BOOK_ID: n5, N45_BOOK_ID: n45}
    seen: set[str] = set()
    for position, item in enumerate(index):
        book_id = str(item.get("id") or "")
        if book_id in replacements:
            index[position] = index_meta(replacements[book_id], item)
            seen.add(book_id)
    if seen != set(replacements):
        raise RuntimeError(f"codex index is missing books: {sorted(set(replacements) - seen)}")
    return index


def validate_payloads(
    n5: dict[str, Any],
    n45: dict[str, Any],
    groups: list[dict[str, Any]],
    *,
    old_n5: dict[str, Any] | None = None,
    old_n45: dict[str, Any] | None = None,
) -> dict[str, Any]:
    issues: list[str] = []
    hash_cache: dict[Path, str] = {}
    entries_by_book: dict[str, dict[str, dict[str, Any]]] = {}
    imported_ids: dict[str, set[str]] = {
        book_id: {
            str(group.get("targetEntryId") or "")
            for group in groups
            if group.get("accepted") and group.get("targetEntryId") and group.get("bookId") == book_id
        }
        for book_id in (N5_BOOK_ID, N45_BOOK_ID)
    }
    preexisting_duplicate_pairs = 0

    for book_id, codex in ((N5_BOOK_ID, n5), (N45_BOOK_ID, n45)):
        entries = list(codex.get("entries") or [])
        ids = [clean_text(entry.get("id")) for entry in entries]
        entries_by_book[book_id] = {clean_text(entry.get("id")): entry for entry in entries}
        if "nsfw" in codex:
            issues.append(f"{book_id}:unexpected_book_nsfw")
        if codex.get("version") != VERSION:
            issues.append(f"{book_id}:version")
        if len(ids) != len(set(ids)):
            issues.append(f"{book_id}:duplicate_entry_ids")
        if codex.get("entryCount") != len(entries):
            issues.append(f"{book_id}:entry_count")
        if codex.get("imagedCount") != sum(bool(entry.get("image")) for entry in entries):
            issues.append(f"{book_id}:imaged_count")
        if codex.get("tree") != build_tree(entries):
            issues.append(f"{book_id}:tree")

        seen_hashes: dict[str, tuple[str, str]] = {}
        for index, entry in enumerate(entries, 1):
            entry_id = clean_text(entry.get("id"))
            asset_id = entry_asset_id(book_id, entry)
            thumb_dir = IMAGE_ROOT / asset_id
            original_dir = ORIGINAL_ROOT / asset_id
            issues.extend(validate_asset(entry, thumb_dir, original_dir))
            for position, item in enumerate(image_items(entry), 1):
                thumb_name = clean_text(item.get("path"))
                original_name = clean_text(item.get("original"))
                original = original_dir / original_name
                if not original.is_file():
                    continue
                if original not in hash_cache:
                    hash_cache[original] = sha256_file(original)
                digest = hash_cache[original]
                label = f"{entry.get('id')}[{position}]"
                if digest in seen_hashes:
                    previous_id, previous_label = seen_hashes[digest]
                    if entry_id in imported_ids[book_id] or previous_id in imported_ids[book_id]:
                        issues.append(f"{book_id}:{label}:duplicate_hash_with:{previous_label}")
                    else:
                        preexisting_duplicate_pairs += 1
                else:
                    seen_hashes[digest] = (entry_id, label)
            if index % 500 == 0 or index == len(entries):
                print(f"validate {book_id}: {index}/{len(entries)}", flush=True)

    # ``mengshen_pack`` is intentionally shared by the merged N4.5 community
    # book and the artist book (the migrated style chapter).  Build the
    # reference set from every installed local book, overlaying the two payloads
    # under validation, instead of misreporting cross-book assets as orphans.
    installed_books: dict[str, dict[str, Any]] = {}
    for data_path in DATA_DIR.glob("*.json"):
        try:
            payload = json.loads(data_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict) and isinstance(payload.get("entries"), list) and payload.get("id"):
            installed_books[str(payload["id"])] = payload
    installed_books[N5_BOOK_ID] = n5
    installed_books[N45_BOOK_ID] = n45
    global_thumbs: dict[str, set[str]] = defaultdict(set)
    global_originals: dict[str, set[str]] = defaultdict(set)
    for owner_id, payload in installed_books.items():
        for entry in payload.get("entries") or []:
            asset_id = entry_asset_id(owner_id, entry)
            for item in image_items(entry):
                global_thumbs[asset_id].add(clean_text(item.get("path")))
                global_originals[asset_id].add(clean_text(item.get("original")))
    for asset_id in {N5_BOOK_ID, N45_ASSET_ID}:
        thumb_actual = {path.name for path in (IMAGE_ROOT / asset_id).iterdir() if path.is_file()}
        original_actual = {path.name for path in (ORIGINAL_ROOT / asset_id).iterdir() if path.is_file()}
        thumb_expected = global_thumbs[asset_id]
        original_expected = global_originals[asset_id]
        if thumb_expected != thumb_actual:
            issues.append(
                f"{asset_id}:thumb_reference_set missing={len(thumb_expected - thumb_actual)} "
                f"orphan={len(thumb_actual - thumb_expected)}"
            )
        if original_expected != original_actual:
            issues.append(
                f"{asset_id}:original_reference_set missing={len(original_expected - original_actual)} "
                f"orphan={len(original_actual - original_expected)}"
            )

    # Old entry fields are frozen. The N5 change is path-only for the legacy
    # community branch; N4.5 existing entries must remain byte-for-byte equal.
    if old_n5 is not None:
        current = entries_by_book[N5_BOOK_ID]
        for old in old_n5.get("entries") or []:
            entry_id = clean_text(old.get("id"))
            expected = copy.deepcopy(old)
            replacement = _legacy_community_path(expected.get("path") or [])
            if replacement:
                expected["path"] = replacement
            if current.get(entry_id) != expected:
                issues.append(f"{N5_BOOK_ID}:{entry_id}:unexpected_existing_field_change")
    if old_n45 is not None:
        current = entries_by_book[N45_BOOK_ID]
        for old in old_n45.get("entries") or []:
            entry_id = clean_text(old.get("id"))
            if current.get(entry_id) != old:
                issues.append(f"{N45_BOOK_ID}:{entry_id}:unexpected_existing_field_change")

    checked_images = 0
    for group in groups:
        if not group.get("accepted") or not group.get("targetEntryId"):
            continue
        book_id = str(group["bookId"])
        entry = entries_by_book[book_id].get(str(group["targetEntryId"]))
        if not entry:
            issues.append(f"{book_id}:{group['targetEntryId']}:missing_target_entry")
            continue
        if list(entry.get("path") or []) != list(group["path"]) or entry.get("rating") != group["rating"]:
            issues.append(f"{book_id}:{group['targetEntryId']}:path_or_rating")
        rows = list(group["acceptedMembers"])
        items = image_items(entry)
        if len(items) != len(rows):
            issues.append(f"{book_id}:{group['targetEntryId']}:image_count")
            continue
        cover = rows[0]
        if clean_text(entry.get("tags")) != clean_text(cover.get("prompt")):
            issues.append(f"{book_id}:{group['targetEntryId']}:prompt")
        if clean_text(entry.get("negative")) != clean_text(cover.get("negative")):
            issues.append(f"{book_id}:{group['targetEntryId']}:negative")
        if clean_character_prompts(entry.get("characterPrompts")) != clean_character_prompts(cover.get("characterPrompts")):
            issues.append(f"{book_id}:{group['targetEntryId']}:character_prompts")
        for position, (item, row) in enumerate(zip(items, rows), 1):
            checked_images += 1
            if len(rows) > 1 and clean_text(item.get("rawTag")) != clean_text(row.get("prompt")):
                issues.append(f"{book_id}:{group['targetEntryId']}[{position}]:raw_tag")
            if len(rows) == 1 and item.get("rawTag"):
                issues.append(f"{book_id}:{group['targetEntryId']}:unexpected_raw_tag")
            original = original_path(book_id, entry, item)
            if original.is_file():
                digest = hash_cache.get(original) or sha256_file(original)
                if digest != row.get("sha256"):
                    issues.append(f"{book_id}:{group['targetEntryId']}[{position}]:source_hash")
                try:
                    metadata = extract_image_metadata(original)
                except Exception as exc:
                    issues.append(f"{book_id}:{group['targetEntryId']}[{position}]:metadata:{type(exc).__name__}")
                    continue
                if clean_text(metadata.prompt) != clean_text(row.get("prompt")):
                    issues.append(f"{book_id}:{group['targetEntryId']}[{position}]:original_prompt")
                if clean_text(metadata.negative) != clean_text(row.get("negative")):
                    issues.append(f"{book_id}:{group['targetEntryId']}[{position}]:original_negative")
                if clean_character_prompts(metadata.character_prompts) != clean_character_prompts(row.get("characterPrompts")):
                    issues.append(f"{book_id}:{group['targetEntryId']}[{position}]:original_character_prompts")
        if checked_images and checked_images % 200 == 0:
            print(f"validate source metadata: {checked_images}", flush=True)

    n5_cover = next(
        (entry for entry in n5.get("entries") or [] if entry.get("image") == n5.get("cover")),
        None,
    )
    if (
        not n5_cover
        or n5_cover.get("rating") != "safe"
        or tuple(n5_cover.get("path") or ()) != N5_COMMUNITY_SAFE_PATH
    ):
        issues.append("nai5_community_pack:unsafe_or_moved_cover")

    if issues:
        raise RuntimeError("\n".join(issues[:200]))
    return {
        "books": {
            N5_BOOK_ID: {
                "entries": len(n5.get("entries") or []),
                "images": sum(len(image_items(entry)) for entry in n5.get("entries") or []),
                "communityEntries": sum(
                    tuple(entry.get("path") or ())[:2] == (N5_ROOT_LABEL, "社区整理")
                    for entry in n5.get("entries") or []
                ),
                "koreanEntries": sum(
                    tuple(entry.get("path") or ())[:2] == (N5_ROOT_LABEL, "韩网整理")
                    for entry in n5.get("entries") or []
                ),
            },
            N45_BOOK_ID: {
                "entries": len(n45.get("entries") or []),
                "images": sum(len(image_items(entry)) for entry in n45.get("entries") or []),
                "targetEntries": sum(
                    tuple(entry.get("path") or ())[:2] == N45_TARGET_PREFIX
                    for entry in n45.get("entries") or []
                ),
            },
        },
        "sourceImagesVerified": checked_images,
        "sourceHashMismatches": 0,
        "promptMismatches": 0,
        "negativeMismatches": 0,
        "characterPromptMismatches": 0,
        "missingAssets": 0,
        "duplicateInstalledHashes": 0,
        "preExistingDuplicatePairsIgnored": preexisting_duplicate_pairs,
    }


def quarantine_duplicates(
    rows: list[dict[str, Any]],
    source: Path,
    stamp: str,
) -> tuple[Path | None, list[tuple[Path, Path]]]:
    rejected = [
        row for row in rows
        if row.get("reason") in {"exact_duplicate", "confirmed_visual_duplicate"}
    ]
    if not rejected:
        return None, []
    backup = (source.parent / f"_源内重复备份_{stamp}").resolve()
    source = source.resolve()
    if backup.parent != source.parent or backup == source or backup.exists():
        raise RuntimeError(f"unsafe or existing source duplicate backup: {backup}")

    verified: list[tuple[Path, Path]] = []
    for row in rejected:
        path = Path(str(row["sourcePath"])).resolve(strict=True)
        relative = path.relative_to(source)
        if sha256_file(path) != row.get("sha256"):
            raise RuntimeError(f"source changed before dedupe: {relative.as_posix()}")
        destination = (backup / relative).resolve()
        destination.relative_to(backup)
        verified.append((path, destination))

    moved: list[tuple[Path, Path]] = []
    backup.mkdir(parents=False, exist_ok=False)
    try:
        for path, destination in verified:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(path), str(destination))
            moved.append((path, destination))
        write_json(backup / "_dedupe_manifest.json", {
            "source": str(source),
            "backup": str(backup),
            "movedFiles": len(moved),
            "reasons": dict(Counter(
                str(row.get("reason") or "") for row in rejected
            )),
            "files": [
                {
                    "relativePath": row["relativePath"],
                    "sha256": row["sha256"],
                    "reason": row["reason"],
                    "keeper": row.get("duplicateOf", ""),
                }
                for row in rejected
            ],
        })
    except Exception:
        restore_quarantine(backup, moved)
        raise
    return backup, moved


def restore_quarantine(backup: Path | None, moved: list[tuple[Path, Path]]) -> None:
    for source, destination in reversed(moved):
        source.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() and not source.exists():
            shutil.move(str(destination), str(source))
    if backup and backup.exists():
        shutil.rmtree(backup)


def apply_update(
    source: Path,
    rows: list[dict[str, Any]],
    groups: list[dict[str, Any]],
    source_info: dict[str, Any],
    plan: dict[str, Any],
    old_n5: dict[str, Any],
    old_n45: dict[str, Any],
    workers: int,
) -> dict[str, Any]:
    if source_info.get("blockers") or plan.get("blockers"):
        raise RuntimeError("update has blockers:\n" + "\n".join(source_info.get("blockers") or plan.get("blockers")))
    if not plan.get("wouldChange"):
        return {"changed": False, "message": "already up to date"}

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = OUTPUT_DIR / "backups" / stamp
    backup_dir.mkdir(parents=True, exist_ok=False)
    paths = {
        N5_BOOK_ID: DATA_DIR / f"{N5_BOOK_ID}.json",
        N45_BOOK_ID: DATA_DIR / f"{N45_BOOK_ID}.json",
        "index": DATA_DIR / "codexes.json",
    }
    for name, path in paths.items():
        shutil.copy2(path, backup_dir / path.name)

    quarantine: Path | None = None
    quarantined_files: list[tuple[Path, Path]] = []
    stages: dict[str, tuple[Path, Path]] = {}
    moved_assets: list[Path] = []
    replaced: set[str] = set()
    temp_paths = {
        N5_BOOK_ID: DATA_DIR / f".{N5_BOOK_ID}.korean.tmp",
        N45_BOOK_ID: DATA_DIR / f".{N45_BOOK_ID}.korean.tmp",
        "index": DATA_DIR / ".codexes.json.korean.tmp",
    }
    try:
        # Source dedupe is reversible and happens before any asset/data write.
        quarantine, quarantined_files = quarantine_duplicates(rows, source, stamp)

        new_groups = [group for group in groups if group.get("accepted") and group.get("new")]
        asset_ids = sorted({str(group["assetCodexId"]) for group in new_groups})
        for asset_id in asset_ids:
            thumb_final = IMAGE_ROOT / asset_id
            original_final = ORIGINAL_ROOT / asset_id
            if not thumb_final.is_dir() or not original_final.is_dir():
                raise RuntimeError(f"installed asset directory is missing: {asset_id}")
            stages[f"thumb:{asset_id}"] = (
                make_staging_directory(IMAGE_ROOT, f".{asset_id}-korean-thumb-"),
                thumb_final,
            )
            stages[f"original:{asset_id}"] = (
                make_staging_directory(ORIGINAL_ROOT, f".{asset_id}-korean-original-"),
                original_final,
            )

        asset_tasks = []
        for group in new_groups:
            asset_id = str(group["assetCodexId"])
            members = list(group["acceptedMembers"])
            asset_tasks.append({
                "entryId": group["targetEntryId"],
                "thumbDir": str(stages[f"thumb:{asset_id}"][0]),
                "originalDir": str(stages[f"original:{asset_id}"][0]),
                "sources": [
                    {
                        "sourcePath": row["sourcePath"],
                        "sha256": row["sha256"],
                        "imageFields": {"rawTag": row["prompt"]} if len(members) > 1 else {},
                    }
                    for row in members
                ],
            })
        written = run_parallel(
            "Mengshen Korean assets",
            write_asset_bundle_from_paths,
            asset_tasks,
            workers,
        )
        written_by_id = {str(asset["entryId"]): asset for asset in written}
        expected_ids = {str(group["targetEntryId"]) for group in new_groups}
        if set(written_by_id) != expected_ids:
            raise RuntimeError("asset task result set mismatch")

        for stage, final in stages.values():
            for file in sorted(stage.iterdir(), key=lambda path: natural_key(path.name)):
                destination = final / file.name
                if destination.exists():
                    raise RuntimeError(f"new asset would overwrite existing file: {destination}")
                # Some long-lived Windows asset directories carry compatible
                # inherited write ACLs but reject cross-directory ``rename``
                # from a freshly created staging directory.  A verified copy
                # followed by unlink uses the same transaction semantics and
                # avoids that ACL edge case.
                source_hash = sha256_file(file)
                shutil.copy2(file, destination)
                if sha256_file(destination) != source_hash:
                    destination.unlink(missing_ok=True)
                    raise RuntimeError(f"staged asset copy hash mismatch: {destination}")
                file.unlink()
                moved_assets.append(destination)

        assets = {
            (str(group["bookId"]), str(group["targetEntryId"])): written_by_id[str(group["targetEntryId"])]
            for group in new_groups
        }
        n5, n45 = build_payloads(old_n5, old_n45, groups, assets)
        index = updated_index(n5, n45)
        validation = validate_payloads(
            n5,
            n45,
            groups,
            old_n5=old_n5,
            old_n45=old_n45,
        )
        index_issues = index_contract_issues(index, {N5_BOOK_ID: n5, N45_BOOK_ID: n45})
        if index_issues:
            raise RuntimeError("index contract mismatch:\n" + "\n".join(index_issues))

        write_json(temp_paths[N5_BOOK_ID], n5, compact=True)
        write_json(temp_paths[N45_BOOK_ID], n45, compact=True)
        write_json(temp_paths["index"], index)
        for key in (N5_BOOK_ID, N45_BOOK_ID, "index"):
            temp_paths[key].replace(paths[key])
            replaced.add(key)

        result = {
            "changed": True,
            "deduplicatedSourceFiles": len(quarantined_files),
            "sourceDuplicateBackup": str(quarantine) if quarantine else "",
            "dataBackup": str(backup_dir),
            "added": {
                N5_BOOK_ID: {
                    "entries": plan["books"][N5_BOOK_ID]["newEntries"],
                    "images": plan["books"][N5_BOOK_ID]["newImages"],
                },
                N45_BOOK_ID: {
                    "entries": plan["books"][N45_BOOK_ID]["newEntries"],
                    "images": plan["books"][N45_BOOK_ID]["newImages"],
                },
            },
            "validation": validation,
        }
        write_json(OUTPUT_DIR / "applied_result.json", result)
        return result
    except Exception:
        for key in (N5_BOOK_ID, N45_BOOK_ID, "index"):
            if key in replaced:
                shutil.copy2(backup_dir / paths[key].name, paths[key])
        for path in reversed(moved_assets):
            path.unlink(missing_ok=True)
        restore_quarantine(quarantine, quarantined_files)
        raise
    finally:
        for stage, _final in stages.values():
            shutil.rmtree(stage, ignore_errors=True)
        for path in temp_paths.values():
            path.unlink(missing_ok=True)


def validate_install(source: Path, workers: int) -> dict[str, Any]:
    _rows, groups, source_info, plan, context = run_plan(source, workers)
    if source_info.get("blockers"):
        raise RuntimeError("validation blockers:\n" + "\n".join(source_info["blockers"][:100]))
    if plan.get("wouldChange"):
        raise RuntimeError("update is not idempotent:\n" + json.dumps(plan, ensure_ascii=False, indent=2))
    n5 = context["n5"]
    n45 = context["n45"]
    validation = validate_payloads(n5, n45, groups)
    index = json.loads((DATA_DIR / "codexes.json").read_text(encoding="utf-8"))
    index_issues = index_contract_issues(index, {N5_BOOK_ID: n5, N45_BOOK_ID: n45})
    if index_issues:
        raise RuntimeError("index contract mismatch:\n" + "\n".join(index_issues))
    result = {
        **validation,
        "idempotentChanges": 0,
        "indexMetadataMismatches": 0,
        "sourceAudit": source_info,
        "paths": plan["paths"],
        "reports": context["files"],
    }
    write_json(OUTPUT_DIR / "validation.json", result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--validate", action="store_true")
    parser.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1))
    args = parser.parse_args()
    if args.workers < 1:
        raise SystemExit("--workers must be at least 1")
    source = args.source.resolve()
    if not source.is_dir():
        raise SystemExit(f"source folder not found: {source}")
    if args.validate:
        print(json.dumps(validate_install(source, args.workers), ensure_ascii=False, indent=2))
        return 0

    rows, groups, source_info, plan, context = run_plan(source, args.workers)
    output: dict[str, Any] = {
        "sourceAudit": source_info,
        "plan": plan,
        "reports": context["files"],
    }
    if args.apply:
        output["apply"] = apply_update(
            source,
            rows,
            groups,
            source_info,
            plan,
            context["n5"],
            context["n45"],
            args.workers,
        )
        output["validation"] = validate_install(source, args.workers)
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
