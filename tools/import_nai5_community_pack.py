"""Import the NovelAI 5 community selected image packs from 梦神 and 所长.

Source semantics are intentionally strict and mirror the human classification:

* 梦神: ``常规`` and ``nsfw`` are the complete two-level classification.
* 所长: every item is NSFW; a loose root image is one entry, while every
  immediate child directory is one multi-image set entry.

The default mode only audits and writes reports below ``output/``.  ``--apply``
performs a first-import transaction and refuses to overwrite existing data or
assets.  No production upload or release command is run by this importer.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
RAW_ROOT = ROOT.parent / "新数据" / "N5图包" / "图包型"
DATA_DIR = ROOT / "site" / "data"
IMAGE_ROOT = ROOT / "site" / "images"
ORIGINAL_ROOT = ROOT / "originals"
OUTPUT_DIR = ROOT / "output" / "nai5_community_pack_import"

CODEX_ID = "nai5_community_pack"
TITLE = "NovelAI5社区精选图包"
VERSION = "2026.8.26"
AUTHOR = "梦神 / 所长"
PREFERRED_COVER_ENTRY_ID = f"{CODEX_ID}_mengshen_0006"

DREAM_SAFE_PATH = ("梦神 · N5精选图包", "常规")
DREAM_NSFW_PATH = ("梦神 · N5精选图包", "NSFW")
SUOZHANG_PATH = ("所长 · N5韩网精选", "NSFW")
EXPECTED_RATINGS = {
    DREAM_SAFE_PATH: "safe",
    DREAM_NSFW_PATH: "r18",
    SUOZHANG_PATH: "r18",
}
PATH_ORDER = {path: index for index, path in enumerate(EXPECTED_RATINGS)}

EXPECTED_SOURCE_COUNTS = {
    "dreamSafeImages": 50,
    "dreamNsfwImages": 26,
    "suozhangLooseImages": 217,
    "suozhangSetDirectories": 34,
    "suozhangSetImages": 474,
}

sys.path.insert(0, str(ROOT / "tools"))
from pack_import_core import (  # noqa: E402
    IMAGE_EXTS,
    build_tree,
    clean_character_prompts,
    clean_text,
    inspect_image_task,
    make_staging_directory,
    mark_exact_duplicates,
    normalized_suffix,
    run_parallel,
    sha256_file,
    validate_asset,
    write_asset_bundle_from_paths,
    write_json,
)
from sd_metadata_inspector import extract_image_metadata  # noqa: E402


def natural_key(value: str | Path) -> tuple[Any, ...]:
    text = str(value).replace("\\", "/").casefold()
    return tuple(int(part) if part.isdigit() else part for part in re.split(r"(\d+)", text))


def model_family(value: Any) -> str:
    text = clean_text(value).lower()
    if "v4.5" in text or "naiv4.5" in text:
        return "nai45"
    if "diffusion v5" in text or "naiv5" in text or re.search(r"\bv5\b", text):
        return "nai5"
    return "unknown"


def one_matching_directory(root: Path, predicate: Any, label: str) -> Path:
    matches = sorted((path for path in root.iterdir() if path.is_dir() and predicate(path)), key=lambda p: p.name.casefold())
    if len(matches) != 1:
        raise RuntimeError(f"expected one {label} directory below {root}, found {matches}")
    return matches[0]


def discover_sources(source: Path) -> dict[str, Path]:
    dream_root = one_matching_directory(source, lambda path: "密码梦神" in path.name, "梦神")
    suozhang_root = one_matching_directory(source, lambda path: "所长" in path.name, "所长")
    n5_candidates = [path for path in dream_root.rglob("*") if path.is_dir() and path.name.casefold() == "n5"]
    if len(n5_candidates) != 1:
        raise RuntimeError(f"expected one 梦神 n5 directory, found {n5_candidates}")
    n5_root = n5_candidates[0]
    safe_dir = n5_root / "常规"
    nsfw_candidates = [path for path in n5_root.iterdir() if path.is_dir() and path.name.casefold() == "nsfw"]
    if not safe_dir.is_dir() or len(nsfw_candidates) != 1:
        raise RuntimeError(f"梦神分类目录不完整: 常规={safe_dir.is_dir()}, nsfw={nsfw_candidates}")
    return {
        "dreamRoot": dream_root,
        "dreamSafe": safe_dir,
        "dreamNsfw": nsfw_candidates[0],
        "suozhangRoot": suozhang_root,
    }


def supported_files(directory: Path, *, recursive: bool = False) -> tuple[list[Path], list[Path]]:
    candidates: Iterable[Path] = directory.rglob("*") if recursive else directory.iterdir()
    files = sorted((path for path in candidates if path.is_file()), key=lambda path: natural_key(path.relative_to(directory)))
    return (
        [path for path in files if path.suffix.lower() in IMAGE_EXTS],
        [path for path in files if path.suffix.lower() not in IMAGE_EXTS],
    )


def source_tasks(source: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    locations = discover_sources(source)
    tasks: list[dict[str, Any]] = []
    groups: list[dict[str, Any]] = []
    unsupported: list[str] = []
    layout_issues: list[str] = []
    source_index = 0
    entry_order = 0

    def add_group(
        *,
        entry_id: str,
        title: str,
        author: str,
        kind: str,
        path: tuple[str, ...],
        rating: str,
        source_folder: Path,
        members: list[Path],
    ) -> None:
        nonlocal source_index, entry_order
        entry_order += 1
        group = {
            "groupKey": entry_id,
            "entryId": entry_id,
            "entryOrder": entry_order,
            "title": title,
            "author": author,
            "kind": kind,
            "path": list(path),
            "rating": rating,
            "sourceFolder": str(source_folder),
            "inputImageCount": len(members),
        }
        groups.append(group)
        for image_index, image_path in enumerate(members, 1):
            source_index += 1
            tasks.append({
                "sourceIndex": source_index,
                "sourcePath": str(image_path),
                "relativePath": image_path.relative_to(source).as_posix(),
                "groupKey": entry_id,
                "entryId": entry_id,
                "entryOrder": entry_order,
                "imageIndex": image_index,
                "author": author,
                "kind": kind,
                "path": list(path),
                "rating": rating,
                "accepted": False,
                "reason": "unscanned",
                "duplicateOf": "",
            })

    dream_files: dict[str, list[Path]] = {}
    for label, directory in (("safe", locations["dreamSafe"]), ("nsfw", locations["dreamNsfw"])):
        files, other = supported_files(directory)
        dream_files[label] = files
        unsupported.extend(path.relative_to(source).as_posix() for path in other)
        child_dirs = [path for path in directory.iterdir() if path.is_dir()]
        layout_issues.extend(f"unexpected 梦神 child directory: {path.relative_to(source).as_posix()}" for path in child_dirs)

    dream_numbers: dict[int, tuple[Path, tuple[str, ...], str]] = {}
    for files, path, rating in (
        (dream_files["safe"], DREAM_SAFE_PATH, "safe"),
        (dream_files["nsfw"], DREAM_NSFW_PATH, "r18"),
    ):
        for image_path in files:
            if not image_path.stem.isdigit():
                layout_issues.append(f"梦神文件名不是数字: {image_path.relative_to(source).as_posix()}")
                continue
            number = int(image_path.stem)
            if number in dream_numbers:
                layout_issues.append(f"梦神编号重复: {number}")
                continue
            dream_numbers[number] = (image_path, path, rating)
    if sorted(dream_numbers) != list(range(1, 77)):
        layout_issues.append(f"梦神编号应为 1..76，实际为 {sorted(dream_numbers)}")
    for number, (image_path, path, rating) in sorted(dream_numbers.items()):
        add_group(
            entry_id=f"{CODEX_ID}_mengshen_{number:04d}",
            title=f"梦神精选 {number:03d}",
            author="梦神",
            kind="single",
            path=path,
            rating=rating,
            source_folder=image_path.parent,
            members=[image_path],
        )

    suozhang_root = locations["suozhangRoot"]
    loose_files, loose_other = supported_files(suozhang_root)
    unsupported.extend(path.relative_to(source).as_posix() for path in loose_other)
    set_dirs = sorted((path for path in suozhang_root.iterdir() if path.is_dir()), key=lambda path: natural_key(path.name))
    set_image_total = 0
    for index, image_path in enumerate(loose_files, 1):
        add_group(
            entry_id=f"{CODEX_ID}_suozhang_{index:04d}",
            title=f"所长精选 {index:04d}",
            author="所长",
            kind="single",
            path=SUOZHANG_PATH,
            rating="r18",
            source_folder=suozhang_root,
            members=[image_path],
        )
    for index, directory in enumerate(set_dirs, 1):
        files, other = supported_files(directory)
        unsupported.extend(path.relative_to(source).as_posix() for path in other)
        nested_dirs = [path for path in directory.iterdir() if path.is_dir()]
        layout_issues.extend(f"unexpected 所长 nested directory: {path.relative_to(source).as_posix()}" for path in nested_dirs)
        if not files:
            layout_issues.append(f"empty 所长 set directory: {directory.relative_to(source).as_posix()}")
            continue
        set_image_total += len(files)
        add_group(
            entry_id=f"{CODEX_ID}_suozhang_set_{index:04d}",
            title=f"所长套图 {index:03d}",
            author="所长",
            kind="set",
            path=SUOZHANG_PATH,
            rating="r18",
            source_folder=directory,
            members=files,
        )

    actual_counts = {
        "dreamSafeImages": len(dream_files["safe"]),
        "dreamNsfwImages": len(dream_files["nsfw"]),
        "suozhangLooseImages": len(loose_files),
        "suozhangSetDirectories": len(set_dirs),
        "suozhangSetImages": set_image_total,
    }
    if actual_counts != EXPECTED_SOURCE_COUNTS:
        layout_issues.append(f"source cardinality changed: {actual_counts} != {EXPECTED_SOURCE_COUNTS}")
    source_info = {
        "locations": {key: str(value) for key, value in locations.items()},
        "sourceCounts": actual_counts,
        "candidateEntries": len(groups),
        "inputImages": len(tasks),
        "unsupportedFiles": unsupported,
        "layoutIssues": layout_issues,
    }
    return tasks, groups, source_info


def classify_scanned_rows(rows: list[dict[str, Any]]) -> None:
    for row in rows:
        reason = "accepted"
        family = model_family(row.get("sourceModel") or row.get("sourceType"))
        row["modelFamily"] = family
        if row.get("error"):
            reason = str(row["error"])
        elif not row.get("prompt"):
            reason = "no_prompt"
        elif not row.get("promptTagCount"):
            reason = "no_tags_after_parse"
        elif family != "nai5":
            reason = f"not_nai5:{family}"
        row["accepted"] = reason == "accepted"
        row["reason"] = reason
        row["duplicateOf"] = ""


def duplicate_groups(rows: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    by_hash: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row.get("sha256"):
            by_hash[str(row["sha256"])].append(row)
    return [items for items in by_hash.values() if len(items) > 1]


def finalize_groups(rows: list[dict[str, Any]], groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_group: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_group[str(row["groupKey"])].append(row)
    for group in groups:
        members = sorted(by_group[group["groupKey"]], key=lambda row: int(row["imageIndex"]))
        accepted = [row for row in members if row.get("accepted")]
        non_duplicate_rejections = [row for row in members if not row.get("accepted") and row.get("reason") != "exact_duplicate"]
        group["members"] = members
        group["acceptedMembers"] = accepted
        group["acceptedImageCount"] = len(accepted)
        group["duplicateImagesRemoved"] = sum(row.get("reason") == "exact_duplicate" for row in members)
        group["excludedImages"] = len(non_duplicate_rejections)
        # A source folder is the set boundary.  Invalid members are reported
        # and omitted, but the remaining valid N5 members must stay together
        # instead of causing the whole set to disappear.
        group["accepted"] = bool(accepted)
        group["reason"] = (
            "accepted_with_exclusions"
            if group["accepted"] and non_duplicate_rejections
            else "accepted" if group["accepted"]
            else "source_image_rejected" if non_duplicate_rejections else "all_images_are_duplicates"
        )
        group["promptVariants"] = len({clean_text(row.get("prompt")) for row in accepted})
        group["negativeVariants"] = len({clean_text(row.get("negative")) for row in accepted})
        group["characterPromptVariants"] = len({
            json.dumps(clean_character_prompts(row.get("characterPrompts")), ensure_ascii=False, sort_keys=True)
            for row in accepted
        })
    return [group for group in groups if group.get("accepted")]


def expected_output_names(entry_id: str, position: int, extension: str) -> tuple[str, str]:
    base = entry_id if position == 1 else f"{entry_id}-{position:02d}"
    return f"{base}.jpg", f"{base}{normalized_suffix(extension)}"


def relative_source(path: str | Path, source: Path) -> str:
    try:
        return Path(path).resolve().relative_to(source.resolve()).as_posix()
    except (OSError, ValueError):
        return str(path)


def write_audit_files(
    rows: list[dict[str, Any]],
    groups: list[dict[str, Any]],
    source_info: dict[str, Any],
    source: Path,
) -> dict[str, Any]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    accepted_groups = [group for group in groups if group.get("accepted")]
    group_by_key = {group["groupKey"]: group for group in groups}
    for group in accepted_groups:
        for output_position, row in enumerate(group["acceptedMembers"], 1):
            thumb, original = expected_output_names(group["entryId"], output_position, row["extension"])
            row["outputPosition"] = output_position
            row["outputThumb"] = thumb
            row["outputOriginal"] = original

    manifest = []
    for row in rows:
        group = group_by_key[row["groupKey"]]
        manifest.append({
            "entryId": row["entryId"],
            "entryTitle": group["title"],
            "author": row["author"],
            "kind": row["kind"],
            "path": row["path"],
            "rating": row["rating"],
            "sourceIndex": row["sourceIndex"],
            "sourceImageIndex": row["imageIndex"],
            "source": relative_source(row["sourcePath"], source),
            "sourceSha256": row.get("sha256", ""),
            "sourceModel": row.get("sourceModel", ""),
            "sourceType": row.get("sourceType", ""),
            "modelFamily": row.get("modelFamily", ""),
            "prompt": row.get("prompt", ""),
            "negative": row.get("negative", ""),
            "characterPrompts": clean_character_prompts(row.get("characterPrompts")),
            "promptSha256": hashlib.sha256(clean_text(row.get("prompt")).encode("utf-8")).hexdigest(),
            "decision": row.get("reason", ""),
            "duplicateOf": row.get("duplicateOf", ""),
            "groupAccepted": bool(group["accepted"]),
            "groupDecision": group["reason"],
            "outputPosition": row.get("outputPosition", ""),
            "outputThumb": row.get("outputThumb", ""),
            "outputOriginal": row.get("outputOriginal", ""),
        })

    manifest_path = OUTPUT_DIR / "source_manifest.json"
    groups_path = OUTPUT_DIR / "entries.csv"
    duplicates_path = OUTPUT_DIR / "duplicate_hashes.csv"
    report_path = OUTPUT_DIR / "report.json"
    write_json(manifest_path, manifest)
    with groups_path.open("w", encoding="utf-8-sig", newline="") as handle:
        fields = [
            "entryId", "title", "author", "kind", "displayPath", "rating",
            "inputImages", "acceptedImages", "duplicateImagesRemoved",
            "excludedImages", "promptVariants", "negativeVariants",
            "characterPromptVariants", "decision", "sourceFolder",
        ]
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for group in groups:
            writer.writerow({
                "entryId": group["entryId"],
                "title": group["title"],
                "author": group["author"],
                "kind": group["kind"],
                "displayPath": " / ".join(group["path"]),
                "rating": group["rating"],
                "inputImages": group["inputImageCount"],
                "acceptedImages": group["acceptedImageCount"],
                "duplicateImagesRemoved": group["duplicateImagesRemoved"],
                "excludedImages": group["excludedImages"],
                "promptVariants": group["promptVariants"],
                "negativeVariants": group["negativeVariants"],
                "characterPromptVariants": group["characterPromptVariants"],
                "decision": group["reason"],
                "sourceFolder": relative_source(group["sourceFolder"], source),
            })

    duplicates = duplicate_groups(rows)
    with duplicates_path.open("w", encoding="utf-8-sig", newline="") as handle:
        fields = ["sha256", "copies", "authors", "entries", "sources"]
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for items in duplicates:
            writer.writerow({
                "sha256": items[0]["sha256"],
                "copies": len(items),
                "authors": " | ".join(sorted({str(item["author"]) for item in items})),
                "entries": " | ".join(str(item["entryId"]) for item in items),
                "sources": " | ".join(relative_source(item["sourcePath"], source) for item in items),
            })

    rejected_rows = [row for row in rows if not row.get("accepted")]
    excluded_rows = [row for row in rejected_rows if row.get("reason") != "exact_duplicate"]
    rejected_groups = [group for group in groups if not group.get("accepted")]
    imported_images = sum(group["acceptedImageCount"] for group in accepted_groups)
    model_counts = Counter(row.get("sourceModel") or row.get("sourceType") or "unknown" for row in rows)
    set_groups = [group for group in groups if group["kind"] == "set"]
    blockers = [*source_info["layoutIssues"]]
    blockers.extend(f"unsupported file: {path}" for path in source_info["unsupportedFiles"])
    report = {
        "codexId": CODEX_ID,
        "title": TITLE,
        "auditDate": date.today().isoformat(),
        "source": str(source),
        **source_info,
        "acceptedEntries": len(accepted_groups),
        "rejectedEntries": len(rejected_groups),
        "importedImages": imported_images,
        "rejectedImages": len(rejected_rows),
        "excludedNonDuplicateImages": len(excluded_rows),
        "rejectedImageReasons": dict(Counter(row.get("reason") for row in rejected_rows)),
        "models": dict(model_counts),
        "modelFamilies": dict(Counter(row.get("modelFamily") for row in rows)),
        "metadataSources": dict(Counter(row.get("sourceType") for row in rows)),
        "exactDuplicateGroups": len(duplicates),
        "exactDuplicateExtraCopies": sum(len(items) - 1 for items in duplicates),
        "pathSummary": {
            " / ".join(path): {
                "rating": rating,
                "entries": sum(group.get("accepted") and tuple(group["path"]) == path for group in groups),
                "images": sum(group["acceptedImageCount"] for group in groups if group.get("accepted") and tuple(group["path"]) == path),
            }
            for path, rating in EXPECTED_RATINGS.items()
        },
        "sets": {
            "input": len(set_groups),
            "accepted": sum(group.get("accepted") for group in set_groups),
            "minImages": min((group["acceptedImageCount"] for group in set_groups if group.get("accepted")), default=0),
            "maxImages": max((group["acceptedImageCount"] for group in set_groups if group.get("accepted")), default=0),
            "withMultiplePositivePrompts": sum(group.get("accepted") and group["promptVariants"] > 1 for group in set_groups),
            "withMultipleNegativePrompts": sum(group.get("accepted") and group["negativeVariants"] > 1 for group in set_groups),
            "withMultipleCharacterPrompts": sum(group.get("accepted") and group["characterPromptVariants"] > 1 for group in set_groups),
            "perImagePositivePromptPolicy": "images[].rawTag 保存每张原图正向提示词；顶层 tags/negative/characterPrompts 取封面",
        },
        "blockers": blockers,
        "files": {
            "report": str(report_path),
            "manifest": str(manifest_path),
            "entries": str(groups_path),
            "duplicates": str(duplicates_path),
        },
    }
    write_json(report_path, report)
    return report


def audit_sources(source: Path, workers: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    tasks, groups, source_info = source_tasks(source)
    rows = run_parallel("N5 community metadata", inspect_image_task, tasks, workers)
    classify_scanned_rows(rows)
    mark_exact_duplicates(rows)
    finalize_groups(rows, groups)
    report = write_audit_files(rows, groups, source_info, source)
    return rows, groups, report


def codex_payload(groups: list[dict[str, Any]], assets: dict[str, dict[str, Any]]) -> dict[str, Any]:
    accepted = sorted(
        (group for group in groups if group.get("accepted")),
        key=lambda group: (PATH_ORDER[tuple(group["path"])], int(group["entryOrder"])),
    )
    entries: list[dict[str, Any]] = []
    for group in accepted:
        rows = group["acceptedMembers"]
        cover = rows[0]
        note_parts: list[str] = []
        if group["kind"] == "set":
            note_parts.append(
                f"套图：{len(rows)} 张；每张图的正向提示词已绑定为当前图 raw tag，"
                "负面词与角色词展示取封面。"
            )
            if len(rows) != group["inputImageCount"]:
                note_parts.append(
                    f"源文件夹共 {group['inputImageCount']} 张；按 NAI5 且带 prompt 的导入门槛，"
                    f"本条收录 {len(rows)} 张，其余已在导入报告中列出。"
                )
        if clean_text(cover.get("note")):
            note_parts.append(clean_text(cover["note"]))
        entry = {
            "title": group["title"],
            "path": group["path"],
            "tags": cover["prompt"],
            **({"negative": cover["negative"]} if clean_text(cover.get("negative")) else {}),
            **({"characterPrompts": clean_character_prompts(cover.get("characterPrompts"))} if cover.get("characterPrompts") else {}),
            **({"note": "\n".join(note_parts)} if note_parts else {}),
            "rating": group["rating"],
            "isNew": False,
            "id": group["entryId"],
            **{key: value for key, value in assets[group["entryId"]].items() if key != "entryId"},
        }
        entries.append(entry)
    if not entries:
        raise RuntimeError("no accepted entries")
    cover = next((entry for entry in entries if entry["id"] == PREFERRED_COVER_ENTRY_ID), None)
    if cover is None:
        cover = next((entry for entry in entries if entry["rating"] == "safe"), entries[0])
    return {
        "id": CODEX_ID,
        "type": "pack",
        "title": TITLE,
        "version": VERSION,
        "author": AUTHOR,
        "entryCount": len(entries),
        "imagedCount": len(entries),
        "hasOriginal": True,
        "source": "梦神 · N5精选图包 / 所长 · 韩网N5作品筛选整理",
        "contributors": [
            {"name": "梦神", "role": "N5精选图包 · 原图与参数整理 / 常规与 NSFW 分类"},
            {"name": "所长", "role": "韩网N5作品筛选整理 · 原图与参数整理 / 套图归组"},
        ],
        "links": [],
        "cover": cover["image"],
        "coverRev": cover["assetRev"],
        "tree": build_tree(entries),
        "entries": entries,
    }


def index_meta(codex: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in codex.items() if key not in {"tree", "entries"}}


def updated_index(codex: dict[str, Any]) -> list[dict[str, Any]]:
    index_path = DATA_DIR / "codexes.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    if any(item.get("id") == CODEX_ID for item in index):
        raise RuntimeError(f"codex index already contains {CODEX_ID}")
    insert_at = next(
        (position + 1 for position, item in enumerate(index) if item.get("id") == "artist_nai5_personal"),
        len(index),
    )
    index.insert(insert_at, index_meta(codex))
    return index


def validate_payload(
    codex: dict[str, Any],
    groups: list[dict[str, Any]],
    thumb_dir: Path,
    original_dir: Path,
) -> dict[str, Any]:
    accepted = [group for group in groups if group.get("accepted")]
    expected_by_id = {group["entryId"]: group for group in accepted}
    entries = codex.get("entries") or []
    issues: list[str] = []
    if "nsfw" in codex:
        issues.append("unexpected_codex_nsfw")
    if codex.get("entryCount") != len(entries) or codex.get("imagedCount") != len(entries):
        issues.append("entry_counts")
    if len(entries) != len(accepted):
        issues.append("accepted_entry_count")
    ids = [entry.get("id") for entry in entries]
    if len(ids) != len(set(ids)):
        issues.append("duplicate_ids")
    if set(ids) != set(expected_by_id):
        issues.append("entry_id_set")
    for entry in entries:
        entry_id = str(entry.get("id") or "")
        group = expected_by_id.get(entry_id)
        if not group:
            continue
        path = tuple(entry.get("path") or ())
        if len(path) != 2 or path not in EXPECTED_RATINGS:
            issues.append(f"{entry_id}:bad_path")
        elif entry.get("rating") != EXPECTED_RATINGS[path]:
            issues.append(f"{entry_id}:bad_rating")
        rows = group["acceptedMembers"]
        images = entry.get("images") or []
        if len(images) != len(rows):
            issues.append(f"{entry_id}:image_count")
        if clean_text(entry.get("tags")) != clean_text(rows[0].get("prompt")):
            issues.append(f"{entry_id}:cover_prompt")
        if clean_text(entry.get("negative")) != clean_text(rows[0].get("negative")):
            issues.append(f"{entry_id}:cover_negative")
        if clean_character_prompts(entry.get("characterPrompts")) != clean_character_prompts(rows[0].get("characterPrompts")):
            issues.append(f"{entry_id}:cover_character_prompts")
        for position, (item, row) in enumerate(zip(images, rows), 1):
            if len(rows) > 1 and clean_text(item.get("rawTag")) != clean_text(row.get("prompt")):
                issues.append(f"{entry_id}[{position}]:raw_tag")
            if len(rows) == 1 and item.get("rawTag"):
                issues.append(f"{entry_id}:unexpected_single_raw_tag")
        issues.extend(validate_asset(entry, thumb_dir, original_dir))
    if codex.get("tree") != build_tree(entries):
        issues.append("tree_mismatch")
    cover_entry = next((entry for entry in entries if entry.get("image") == codex.get("cover")), None)
    if (
        not cover_entry
        or cover_entry.get("id") != PREFERRED_COVER_ENTRY_ID
        or cover_entry.get("rating") != "safe"
        or tuple(cover_entry.get("path") or ()) != DREAM_SAFE_PATH
    ):
        issues.append("unsafe_cover")
    if issues:
        raise RuntimeError("\n".join(issues[:100]))
    return {
        "codexId": CODEX_ID,
        "entries": len(entries),
        "images": sum(len(entry.get("images") or []) for entry in entries),
        "multiImageEntries": sum(len(entry.get("images") or []) > 1 for entry in entries),
        "maxImagesPerEntry": max((len(entry.get("images") or []) for entry in entries), default=0),
        "uniqueIds": len(set(ids)),
        "missingAssets": 0,
        "badPathsOrRatings": 0,
        "perImageRawTagMismatches": 0,
    }


def apply_import(groups: list[dict[str, Any]], report: dict[str, Any], workers: int) -> dict[str, Any]:
    if report.get("blockers"):
        raise RuntimeError("source audit has blockers:\n" + "\n".join(report["blockers"][:100]))
    data_path = DATA_DIR / f"{CODEX_ID}.json"
    final_thumbs = IMAGE_ROOT / CODEX_ID
    final_originals = ORIGINAL_ROOT / CODEX_ID
    if data_path.exists() or final_thumbs.exists() or final_originals.exists():
        raise RuntimeError(f"target already exists for {CODEX_ID}; refusing to overwrite")

    IMAGE_ROOT.mkdir(parents=True, exist_ok=True)
    ORIGINAL_ROOT.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    thumb_stage = make_staging_directory(IMAGE_ROOT, f".{CODEX_ID}-")
    original_stage = make_staging_directory(ORIGINAL_ROOT, f".{CODEX_ID}-")
    data_temp = DATA_DIR / f".{CODEX_ID}.json.tmp"
    index_temp = DATA_DIR / f".codexes.json.{CODEX_ID}.tmp"
    finalized = False
    try:
        accepted = sorted(
            (group for group in groups if group.get("accepted")),
            key=lambda group: (PATH_ORDER[tuple(group["path"])], int(group["entryOrder"])),
        )
        asset_tasks = []
        for group in accepted:
            multi = len(group["acceptedMembers"]) > 1
            asset_tasks.append({
                "entryId": group["entryId"],
                "thumbDir": str(thumb_stage),
                "originalDir": str(original_stage),
                "sources": [
                    {
                        "sourcePath": row["sourcePath"],
                        "sha256": row["sha256"],
                        "imageFields": {"rawTag": row["prompt"]} if multi else {},
                    }
                    for row in group["acceptedMembers"]
                ],
            })
        assets = run_parallel("N5 community assets", write_asset_bundle_from_paths, asset_tasks, workers)
        assets_by_id = {asset["entryId"]: asset for asset in assets}
        codex = codex_payload(groups, assets_by_id)
        validation = validate_payload(codex, groups, thumb_stage, original_stage)
        index = updated_index(codex)
        write_json(data_temp, codex, compact=True)
        write_json(index_temp, index)

        thumb_stage.rename(final_thumbs)
        original_stage.rename(final_originals)
        data_temp.replace(data_path)
        index_temp.replace(DATA_DIR / "codexes.json")
        finalized = True
        return {
            **validation,
            "data": str(data_path),
            "thumbFiles": len(list(final_thumbs.iterdir())),
            "originalFiles": len(list(final_originals.iterdir())),
        }
    finally:
        if not finalized:
            shutil.rmtree(thumb_stage, ignore_errors=True)
            shutil.rmtree(original_stage, ignore_errors=True)
            if final_thumbs.exists():
                shutil.rmtree(final_thumbs, ignore_errors=True)
            if final_originals.exists():
                shutil.rmtree(final_originals, ignore_errors=True)
            data_temp.unlink(missing_ok=True)
            index_temp.unlink(missing_ok=True)
            data_path.unlink(missing_ok=True)


def validate_import() -> dict[str, Any]:
    data_path = DATA_DIR / f"{CODEX_ID}.json"
    report_path = OUTPUT_DIR / "report.json"
    manifest_path = OUTPUT_DIR / "source_manifest.json"
    if not data_path.is_file() or not report_path.is_file() or not manifest_path.is_file():
        raise RuntimeError("installed data or import audit files are missing")
    codex = json.loads(data_path.read_text(encoding="utf-8"))
    report = json.loads(report_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    index = json.loads((DATA_DIR / "codexes.json").read_text(encoding="utf-8"))
    meta = next((item for item in index if item.get("id") == CODEX_ID), None)
    if not meta:
        raise RuntimeError(f"codex index missing {CODEX_ID}")
    if "nsfw" in codex or "nsfw" in meta:
        raise RuntimeError("partial-NSFW codex must not use root nsfw")

    entries = codex.get("entries") or []
    issues: list[str] = []
    if len(entries) != report.get("acceptedEntries"):
        issues.append("report_entry_count")
    expected_images = int(report.get("importedImages") or 0)
    actual_images = sum(len(entry.get("images") or []) for entry in entries)
    if actual_images != expected_images:
        issues.append("report_image_count")
    if len(list((IMAGE_ROOT / CODEX_ID).iterdir())) != expected_images:
        issues.append("thumb_file_count")
    if len(list((ORIGINAL_ROOT / CODEX_ID).iterdir())) != expected_images:
        issues.append("original_file_count")
    for key in ("title", "version", "author", "nsfw", "entryCount", "imagedCount", "cover", "coverRev"):
        if meta.get(key) != codex.get(key):
            issues.append(f"index_metadata:{key}")

    manifest_by_original = {
        row["outputOriginal"]: row
        for row in manifest
        if row.get("decision") == "accepted" and row.get("groupAccepted") and row.get("outputOriginal")
    }
    seen_originals: set[str] = set()
    for entry in entries:
        entry_id = str(entry.get("id") or "")
        path = tuple(entry.get("path") or ())
        if len(path) != 2 or path not in EXPECTED_RATINGS or entry.get("rating") != EXPECTED_RATINGS.get(path):
            issues.append(f"{entry_id}:path_or_rating")
        images = entry.get("images") or []
        issues.extend(validate_asset(entry, IMAGE_ROOT / CODEX_ID, ORIGINAL_ROOT / CODEX_ID))
        for position, item in enumerate(images, 1):
            original_name = str(item.get("original") or "")
            record = manifest_by_original.get(original_name)
            if not record:
                issues.append(f"{entry_id}[{position}]:manifest")
                continue
            seen_originals.add(original_name)
            original_path = ORIGINAL_ROOT / CODEX_ID / original_name
            if sha256_file(original_path) != record.get("sourceSha256"):
                issues.append(f"{entry_id}[{position}]:source_hash")
            try:
                metadata = extract_image_metadata(original_path)
            except Exception as exc:
                issues.append(f"{entry_id}[{position}]:metadata:{type(exc).__name__}")
                continue
            prompt = clean_text(metadata.prompt)
            expected_prompt = clean_text(item.get("rawTag")) if len(images) > 1 else clean_text(entry.get("tags"))
            if prompt != expected_prompt or prompt != clean_text(record.get("prompt")):
                issues.append(f"{entry_id}[{position}]:prompt")
            if position == 1:
                if clean_text(metadata.negative) != clean_text(entry.get("negative")):
                    issues.append(f"{entry_id}:negative")
                if clean_character_prompts(metadata.character_prompts) != clean_character_prompts(entry.get("characterPrompts")):
                    issues.append(f"{entry_id}:character_prompts")
    if seen_originals != set(manifest_by_original):
        issues.append("manifest_output_set")
    if codex.get("tree") != build_tree(entries):
        issues.append("tree")
    cover_entry = next((entry for entry in entries if entry.get("image") == codex.get("cover")), None)
    if (
        not cover_entry
        or cover_entry.get("id") != PREFERRED_COVER_ENTRY_ID
        or cover_entry.get("rating") != "safe"
        or tuple(cover_entry.get("path") or ()) != DREAM_SAFE_PATH
    ):
        issues.append("unsafe_cover")
    if issues:
        raise RuntimeError("\n".join(issues[:100]))
    return {
        "codexId": CODEX_ID,
        "entries": len(entries),
        "images": actual_images,
        "multiImageEntries": sum(len(entry.get("images") or []) > 1 for entry in entries),
        "maxImagesPerEntry": max((len(entry.get("images") or []) for entry in entries), default=0),
        "sourceHashMismatches": 0,
        "promptMismatches": 0,
        "negativeMismatches": 0,
        "characterPromptMismatches": 0,
        "missingAssets": 0,
        "indexMetadataMismatches": 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=RAW_ROOT)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--validate", action="store_true")
    parser.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1))
    args = parser.parse_args()
    if args.workers < 1:
        raise SystemExit("--workers must be at least 1")
    if args.validate:
        print(json.dumps(validate_import(), ensure_ascii=False, indent=2))
        return 0
    source = args.source.resolve()
    if not source.is_dir():
        raise SystemExit(f"source folder not found: {source}")
    _rows, groups, report = audit_sources(source, args.workers)
    output: dict[str, Any] = {"audit": report}
    if args.apply:
        output["import"] = apply_import(groups, report, args.workers)
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
