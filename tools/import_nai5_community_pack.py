"""Import and incrementally update the NovelAI 5 community image packs.

Source semantics are intentionally strict and mirror the human classification:

* 梦神: ``常规`` and ``nsfw`` are the complete two-level classification.
* 所长: every item is NSFW; a loose root image is one entry, while every
  immediate child directory is one multi-image set entry.

The default mode only audits the historical first-import source and writes
reports below ``output/``.  ``--apply`` performs that first-import transaction
and refuses to overwrite existing data or assets.  Numbered 所长 source packs
use the separately explicit ``--batch-plan`` / ``--batch-apply`` workflow so an
existing codex is never rebuilt accidentally.  No production upload or release
command is run by this importer.
"""
from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import json
import os
import re
import shutil
import sys
from collections import Counter, defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
RAW_ROOT = ROOT.parent / "新数据" / "N5图包" / "图包型"
BATCH_RAW_ROOT = ROOT.parent / "新数据" / "N5新图包"
DATA_DIR = ROOT / "site" / "data"
IMAGE_ROOT = ROOT / "site" / "images"
ORIGINAL_ROOT = ROOT / "originals"
OUTPUT_DIR = ROOT / "output" / "nai5_community_pack_import"

CODEX_ID = "nai5_community_pack"
TITLE = "NovelAI v5社区精选图包"
VERSION = "2026.8.26"
BATCH_VERSION = "2026.8.29"
AUTHOR = "梦神 / 所长"
PREFERRED_COVER_ENTRY_ID = f"{CODEX_ID}_mengshen_0006"

DREAM_SAFE_PATH = ("梦神 · N5精选图包", "常规")
DREAM_NSFW_PATH = ("梦神 · N5精选图包", "NSFW")
SUOZHANG_PATH = ("所长 · N5韩网精选", "NSFW")
SUOZHANG_ROOT_LABEL = "所长 · N5韩网精选"
EXPECTED_RATINGS = {
    DREAM_SAFE_PATH: "safe",
    DREAM_NSFW_PATH: "r18",
    SUOZHANG_PATH: "r18",
}


def dream_entry_title(number: int) -> str:
    return f"社区精选 {number:03d}"
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
            title=dream_entry_title(number),
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


def suozhang_batch_path(number: int) -> tuple[str, str]:
    if number < 1:
        raise ValueError(f"batch number must be positive: {number}")
    return SUOZHANG_ROOT_LABEL, f"筛选整理{number}"


def batch_number_from_name(name: str) -> int | None:
    match = re.search(r"筛选整理(?P<number>\d*)$", name.strip())
    if not match:
        return None
    return int(match.group("number") or "1")


def unwrap_single_directory(root: Path) -> Path:
    current = root
    while True:
        files = [path for path in current.iterdir() if path.is_file()]
        directories = [path for path in current.iterdir() if path.is_dir()]
        if files or len(directories) != 1:
            return current
        current = directories[0]


def discover_batch_sources(source: Path) -> list[dict[str, Any]]:
    batches: list[dict[str, Any]] = []
    ignored: list[str] = []
    for path in sorted(source.iterdir(), key=lambda item: natural_key(item.name)):
        if not path.is_dir():
            ignored.append(path.name)
            continue
        number = batch_number_from_name(path.name)
        if number is None:
            raise RuntimeError(f"unrecognized batch directory: {path}")
        batches.append({"number": number, "outer": path, "root": unwrap_single_directory(path)})
    numbers = [int(item["number"]) for item in batches]
    if not numbers:
        raise RuntimeError(f"no numbered source packs found below {source}")
    if len(numbers) != len(set(numbers)):
        raise RuntimeError(f"duplicate batch numbers: {numbers}")
    expected = list(range(1, max(numbers) + 1))
    if sorted(numbers) != expected:
        raise RuntimeError(f"batch numbers must be contiguous 1..{max(numbers)}: {numbers}")
    batches.sort(key=lambda item: int(item["number"]))
    for item in batches:
        item["ignoredRootFiles"] = ignored
    return batches


def batch_source_tasks(source: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    batches = discover_batch_sources(source)
    tasks: list[dict[str, Any]] = []
    groups: list[dict[str, Any]] = []
    unsupported: list[str] = []
    layout_issues: list[str] = []
    source_index = 0
    entry_order = 0

    def add_group(
        *,
        batch: int,
        kind: str,
        folder: str,
        source_folder: Path,
        members: list[Path],
        content_root: Path,
    ) -> None:
        nonlocal source_index, entry_order
        entry_order += 1
        group_key = f"batch:{batch}:{kind}:{entry_order:04d}:{folder}"
        group = {
            "groupKey": group_key,
            "entryOrder": entry_order,
            "batch": batch,
            "kind": kind,
            "folder": folder,
            "path": list(suozhang_batch_path(batch)),
            "rating": "r18",
            "author": "所长",
            "sourceFolder": str(source_folder),
            "inputImageCount": len(members),
        }
        groups.append(group)
        for image_index, image_path in enumerate(members, 1):
            source_index += 1
            tasks.append({
                "sourceIndex": source_index,
                "sourcePath": str(image_path),
                "relativePath": f"筛选整理{batch}/{image_path.relative_to(content_root).as_posix()}",
                "groupKey": group_key,
                "entryOrder": entry_order,
                "imageIndex": image_index,
                "batch": batch,
                "kind": kind,
                "folder": folder,
                "author": "所长",
                "path": list(suozhang_batch_path(batch)),
                "rating": "r18",
                "accepted": False,
                "reason": "unscanned",
                "duplicateOf": "",
            })

    batch_counts: dict[str, Any] = {}
    for item in batches:
        batch = int(item["number"])
        content_root = Path(item["root"])
        loose_files, loose_other = supported_files(content_root)
        unsupported.extend(str(path) for path in loose_other)
        set_directories = sorted(
            (path for path in content_root.iterdir() if path.is_dir()),
            key=lambda path: natural_key(path.name),
        )
        set_images = 0
        for image_path in loose_files:
            add_group(
                batch=batch,
                kind="single",
                folder=".",
                source_folder=content_root,
                members=[image_path],
                content_root=content_root,
            )
        for directory in set_directories:
            files, other = supported_files(directory)
            unsupported.extend(str(path) for path in other)
            nested = [path for path in directory.iterdir() if path.is_dir()]
            layout_issues.extend(f"unexpected nested set directory: {path}" for path in nested)
            if not files:
                layout_issues.append(f"empty set directory: {directory}")
                continue
            set_images += len(files)
            add_group(
                batch=batch,
                kind="set",
                folder=directory.name,
                source_folder=directory,
                members=files,
                content_root=content_root,
            )
        batch_counts[str(batch)] = {
            "sourceDirectory": str(item["outer"]),
            "contentRoot": str(content_root),
            "looseImages": len(loose_files),
            "setDirectories": len(set_directories),
            "setImages": set_images,
            "inputImages": len(loose_files) + set_images,
        }
    return tasks, groups, {
        "source": str(source),
        "batches": batch_counts,
        "inputImages": len(tasks),
        "candidateEntries": len(groups),
        "unsupportedFiles": unsupported,
        "layoutIssues": layout_issues,
        "ignoredRootFiles": batches[0].get("ignoredRootFiles", []),
    }


def mark_batch_duplicates(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deduplicate by batch, preferring a real set folder over a loose copy."""
    by_hash: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row.get("accepted") and row.get("sha256"):
            by_hash[str(row["sha256"])].append(row)
    removed: list[dict[str, Any]] = []
    for items in by_hash.values():
        if len(items) < 2:
            continue
        keeper = min(
            items,
            key=lambda row: (
                int(row.get("batch") or 0),
                0 if row.get("kind") == "set" else 1,
                int(row.get("sourceIndex") or 0),
            ),
        )
        for row in items:
            if row is keeper:
                continue
            row["accepted"] = False
            row["reason"] = "exact_duplicate"
            row["duplicateOf"] = keeper.get("relativePath") or keeper.get("sourcePath")
            removed.append(row)
    return removed


def audit_batch_sources(
    source: Path,
    workers: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    tasks, groups, source_info = batch_source_tasks(source)
    rows = run_parallel("N5 numbered pack metadata", inspect_image_task, tasks, workers)
    classify_scanned_rows(rows)
    mark_batch_duplicates(rows)
    accepted_groups = finalize_groups(rows, groups)
    batch_summary: dict[str, Any] = {}
    for batch in sorted({int(row["batch"]) for row in rows}):
        batch_rows = [row for row in rows if int(row["batch"]) == batch]
        batch_groups = [group for group in groups if int(group["batch"]) == batch]
        batch_summary[str(batch)] = {
            **source_info["batches"][str(batch)],
            "acceptedImages": sum(row.get("accepted") for row in batch_rows),
            "acceptedEntries": sum(group.get("accepted") for group in batch_groups),
            "rejectedImageReasons": dict(Counter(row.get("reason") for row in batch_rows if not row.get("accepted"))),
            "sets": sum(group.get("accepted") and group.get("kind") == "set" for group in batch_groups),
            "maxSetImages": max(
                (int(group.get("acceptedImageCount") or 0) for group in batch_groups if group.get("accepted") and group.get("kind") == "set"),
                default=0,
            ),
        }
    source_info["batches"] = batch_summary
    source_info["acceptedImages"] = sum(row.get("accepted") for row in rows)
    source_info["acceptedEntries"] = len(accepted_groups)
    source_info["rejectedImageReasons"] = dict(Counter(row.get("reason") for row in rows if not row.get("accepted")))
    source_info["exactDuplicateExtraCopies"] = sum(row.get("reason") == "exact_duplicate" for row in rows)
    source_info["blockers"] = list(source_info["layoutIssues"])
    return rows, groups, source_info


def current_batch_state(codex: dict[str, Any]) -> dict[str, Any]:
    entry_by_id: dict[str, dict[str, Any]] = {}
    entry_order: dict[str, int] = {}
    entry_hashes: dict[str, list[str]] = {}
    hash_refs: dict[str, dict[str, Any]] = {}
    dream_entries: list[dict[str, Any]] = []
    suozhang_entries: list[dict[str, Any]] = []
    original_dir = ORIGINAL_ROOT / CODEX_ID
    for order, entry in enumerate(codex.get("entries") or []):
        entry_id = str(entry.get("id") or "")
        entry_by_id[entry_id] = entry
        entry_order[entry_id] = order
        if (entry.get("path") or [""])[0] != SUOZHANG_ROOT_LABEL:
            dream_entries.append(entry)
            continue
        suozhang_entries.append(entry)
        images = list(entry.get("images") or [])
        if not images:
            images = [{"path": entry.get("image"), "original": entry.get("original")}]
        hashes: list[str] = []
        for image_index, image in enumerate(images, 1):
            original_name = str(image.get("original") or "")
            original = original_dir / original_name
            if not original.is_file():
                raise RuntimeError(f"missing current original: {entry_id}[{image_index}] {original}")
            value = sha256_file(original)
            if value in hash_refs:
                other = hash_refs[value]
                raise RuntimeError(f"duplicate current original hash: {entry_id} and {other['entryId']}")
            hashes.append(value)
            hash_refs[value] = {
                "entryId": entry_id,
                "entry": entry,
                "imageIndex": image_index,
                "image": image,
                "prompt": clean_text(image.get("rawTag")) if len(images) > 1 else clean_text(entry.get("tags")),
            }
        entry_hashes[entry_id] = hashes
    return {
        "entryById": entry_by_id,
        "entryOrder": entry_order,
        "entryHashes": entry_hashes,
        "hashRefs": hash_refs,
        "dreamEntries": dream_entries,
        "suozhangEntries": suozhang_entries,
    }


def _maximum_id(entries: Iterable[dict[str, Any]], pattern: str) -> int:
    expression = re.compile(pattern)
    values = []
    for entry in entries:
        match = expression.fullmatch(str(entry.get("id") or ""))
        if match:
            values.append(int(match.group(1)))
    return max(values, default=0)


def _maximum_set_title(entries: Iterable[dict[str, Any]]) -> int:
    values = []
    for entry in entries:
        match = re.fullmatch(r"所长套图\s+(\d+)", clean_text(entry.get("title")))
        if match:
            values.append(int(match.group(1)))
    return max(values, default=0)


def bind_batch_groups(
    rows: list[dict[str, Any]],
    groups: list[dict[str, Any]],
    codex: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    state = current_batch_state(codex)
    blockers: list[str] = []
    accepted_groups = sorted(
        (group for group in groups if group.get("accepted")),
        key=lambda group: int(group["entryOrder"]),
    )
    source_hashes = {
        str(row["sha256"])
        for row in rows
        if row.get("accepted") and row.get("sha256")
    }
    current_hashes = set(state["hashRefs"])
    missing_current = sorted(current_hashes - source_hashes)
    if missing_current:
        blockers.append(f"{len(missing_current)} current 所长 originals are absent from accepted numbered packs")

    hash_to_group: dict[str, str] = {}
    for group in accepted_groups:
        for row in group["acceptedMembers"]:
            value = str(row["sha256"])
            if value in hash_to_group:
                blockers.append(f"accepted source hash appears in multiple groups: {value}")
            hash_to_group[value] = str(group["groupKey"])
    for entry_id, hashes in state["entryHashes"].items():
        mapped = {hash_to_group.get(value) for value in hashes}
        if None in mapped or len(mapped) != 1:
            blockers.append(f"current entry spans source groups: {entry_id} -> {sorted(str(value) for value in mapped)}")

    single_number = _maximum_id(
        state["suozhangEntries"],
        rf"{re.escape(CODEX_ID)}_suozhang_(\d+)",
    )
    set_number = _maximum_id(
        state["suozhangEntries"],
        rf"{re.escape(CODEX_ID)}_suozhang_set_(\d+)",
    )
    set_title_number = _maximum_set_title(state["suozhangEntries"])
    removed_ids: list[str] = []
    new_groups: list[str] = []
    regrouped_groups: list[dict[str, Any]] = []
    path_changes: list[dict[str, Any]] = []

    for group in accepted_groups:
        members = list(group["acceptedMembers"])
        hashes = [str(row["sha256"]) for row in members]
        existing_ids = sorted(
            {str(state["hashRefs"][value]["entryId"]) for value in hashes if value in state["hashRefs"]},
            key=lambda entry_id: int(state["entryOrder"][entry_id]),
        )
        existing_images = sum(value in state["hashRefs"] for value in hashes)
        group["acceptedHashes"] = hashes
        group["existingEntryIds"] = existing_ids
        group["new"] = not existing_ids
        group["regroup"] = False
        if existing_images not in (0, len(hashes)):
            blockers.append(
                f"source group mixes {existing_images} existing and {len(hashes) - existing_images} new images: {group['groupKey']}"
            )
            continue
        if not existing_ids:
            if group["kind"] == "single":
                single_number += 1
                target_id = f"{CODEX_ID}_suozhang_{single_number:04d}"
                target_title = f"所长精选 {single_number:04d}"
            else:
                set_number += 1
                set_title_number += 1
                target_id = f"{CODEX_ID}_suozhang_set_{set_number:04d}"
                target_title = f"所长套图 {set_title_number:03d}"
            new_groups.append(str(group["groupKey"]))
        elif len(existing_ids) == 1:
            target_id = existing_ids[0]
            target_title = clean_text(state["entryById"][target_id].get("title"))
            if state["entryHashes"][target_id] != hashes:
                blockers.append(f"existing set order or membership changed: {target_id}")
        else:
            if group["kind"] != "set" or any(len(state["entryHashes"][entry_id]) != 1 for entry_id in existing_ids):
                blockers.append(f"cannot safely regroup existing entries: {group['groupKey']} -> {existing_ids}")
                continue
            first_ref = state["hashRefs"][hashes[0]]
            target_id = str(first_ref["entryId"])
            set_title_number += 1
            target_title = f"所长套图 {set_title_number:03d}"
            group["regroup"] = True
            removed = [entry_id for entry_id in existing_ids if entry_id != target_id]
            removed_ids.extend(removed)
            regrouped_groups.append({
                "groupKey": group["groupKey"],
                "targetEntryId": target_id,
                "mergedEntryIds": existing_ids,
                "removedEntryIds": removed,
                "images": len(hashes),
            })
        group["targetEntryId"] = target_id
        group["targetTitle"] = target_title
        if target_id in state["entryById"]:
            old_path = list(state["entryById"][target_id].get("path") or [])
            if old_path != group["path"]:
                path_changes.append({"entryId": target_id, "from": old_path, "to": group["path"]})

        for position, row in enumerate(members, 1):
            row["targetEntryId"] = target_id
            row["outputPosition"] = position
            current_ref = state["hashRefs"].get(str(row["sha256"]))
            if current_ref:
                row["outputThumb"] = current_ref["image"].get("path", "")
                row["outputOriginal"] = current_ref["image"].get("original", "")
            else:
                thumb, original = expected_output_names(target_id, position, str(row["extension"]))
                row["outputThumb"] = thumb
                row["outputOriginal"] = original

    target_ids = [str(group.get("targetEntryId") or "") for group in accepted_groups if group.get("targetEntryId")]
    if len(target_ids) != len(set(target_ids)):
        blockers.append("multiple accepted source groups resolve to the same target entry ID")
    final_suozhang_entries = len(accepted_groups)
    final_images = sum(int(group.get("acceptedImageCount") or 0) for group in accepted_groups)
    meta_changes = []
    expected_source = "梦神 · N5精选图包 / 所长 · 韩网N5作品筛选整理1–4"
    if codex.get("version") != BATCH_VERSION:
        meta_changes.append({"field": "version", "from": codex.get("version"), "to": BATCH_VERSION})
    if codex.get("source") != expected_source:
        meta_changes.append({"field": "source", "from": codex.get("source"), "to": expected_source})
    plan = {
        "codexId": CODEX_ID,
        "old": {
            "entries": len(codex.get("entries") or []),
            "suozhangEntries": len(state["suozhangEntries"]),
            "suozhangImages": len(current_hashes),
            "version": codex.get("version"),
        },
        "new": {
            "entries": len(state["dreamEntries"]) + final_suozhang_entries,
            "suozhangEntries": final_suozhang_entries,
            "suozhangImages": final_images,
            "version": BATCH_VERSION,
        },
        "coverage": {
            "currentHashes": len(current_hashes),
            "acceptedSourceHashes": len(source_hashes),
            "currentMissingFromSource": len(current_hashes - source_hashes),
            "acceptedSourceMissingFromCurrent": len(source_hashes - current_hashes),
        },
        "changes": {
            "newEntries": len(new_groups),
            "newImages": sum(int(group["acceptedImageCount"]) for group in accepted_groups if group.get("new")),
            "removedEntriesForRegrouping": len(removed_ids),
            "removedEntryIds": removed_ids,
            "regrouped": regrouped_groups,
            "pathChanges": path_changes,
            "metadataChanges": meta_changes,
        },
        "pathSummary": {
            " / ".join(suozhang_batch_path(batch)): {
                "entries": sum(group.get("accepted") and int(group["batch"]) == batch for group in groups),
                "images": sum(int(group.get("acceptedImageCount") or 0) for group in groups if group.get("accepted") and int(group["batch"]) == batch),
                "rating": "r18",
            }
            for batch in sorted({int(group["batch"]) for group in groups})
        },
        "blockers": blockers,
    }
    plan["wouldChange"] = bool(
        blockers
        or new_groups
        or removed_ids
        or path_changes
        or meta_changes
        or plan["old"]["suozhangEntries"] != plan["new"]["suozhangEntries"]
        or plan["old"]["suozhangImages"] != plan["new"]["suozhangImages"]
    )
    return state, plan


def write_batch_reports(
    rows: list[dict[str, Any]],
    groups: list[dict[str, Any]],
    source_info: dict[str, Any],
    plan: dict[str, Any],
) -> dict[str, str]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = OUTPUT_DIR / "batch_update_report.json"
    manifest_path = OUTPUT_DIR / "batch_source_manifest.json"
    entries_path = OUTPUT_DIR / "batch_entries.csv"
    report = {
        "auditDate": date.today().isoformat(),
        "sourceAudit": source_info,
        "plan": plan,
    }
    manifest = [
        {
            "batch": row.get("batch"),
            "groupKey": row.get("groupKey"),
            "kind": row.get("kind"),
            "sourceIndex": row.get("sourceIndex"),
            "sourceImageIndex": row.get("imageIndex"),
            "source": row.get("relativePath"),
            "sourceSha256": row.get("sha256", ""),
            "sourceModel": row.get("sourceModel", ""),
            "sourceType": row.get("sourceType", ""),
            "modelFamily": row.get("modelFamily", ""),
            "prompt": row.get("prompt", ""),
            "negative": row.get("negative", ""),
            "characterPrompts": clean_character_prompts(row.get("characterPrompts")),
            "decision": row.get("reason", ""),
            "duplicateOf": row.get("duplicateOf", ""),
            "targetEntryId": row.get("targetEntryId", ""),
            "outputPosition": row.get("outputPosition", ""),
            "outputThumb": row.get("outputThumb", ""),
            "outputOriginal": row.get("outputOriginal", ""),
        }
        for row in rows
    ]
    write_json(report_path, report)
    write_json(manifest_path, manifest)
    with entries_path.open("w", encoding="utf-8-sig", newline="") as handle:
        fields = [
            "batch", "displayPath", "kind", "sourceFolder", "inputImages",
            "acceptedImages", "duplicateImagesRemoved", "excludedImages",
            "targetEntryId", "targetTitle", "existingEntryIds", "decision",
        ]
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for group in groups:
            writer.writerow({
                "batch": group["batch"],
                "displayPath": " / ".join(group["path"]),
                "kind": group["kind"],
                "sourceFolder": group["sourceFolder"],
                "inputImages": group["inputImageCount"],
                "acceptedImages": group.get("acceptedImageCount", 0),
                "duplicateImagesRemoved": group.get("duplicateImagesRemoved", 0),
                "excludedImages": group.get("excludedImages", 0),
                "targetEntryId": group.get("targetEntryId", ""),
                "targetTitle": group.get("targetTitle", ""),
                "existingEntryIds": " | ".join(group.get("existingEntryIds") or []),
                "decision": group.get("reason", ""),
            })
    return {
        "report": str(report_path),
        "manifest": str(manifest_path),
        "entries": str(entries_path),
    }


def run_batch_plan(
    source: Path,
    workers: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    data_path = DATA_DIR / f"{CODEX_ID}.json"
    if not data_path.is_file():
        raise RuntimeError(f"installed codex is missing: {data_path}")
    codex = json.loads(data_path.read_text(encoding="utf-8"))
    rows, groups, source_info = audit_batch_sources(source, workers)
    state, plan = bind_batch_groups(rows, groups, codex)
    source_info["blockers"] = list(source_info.get("blockers") or []) + list(plan.get("blockers") or [])
    plan["blockers"] = source_info["blockers"]
    files = write_batch_reports(rows, groups, source_info, plan)
    return rows, groups, source_info, state, plan, {"codex": codex, "files": files}


def _asset_revision(images: list[dict[str, Any]]) -> str:
    revisions = []
    thumb_dir = IMAGE_ROOT / CODEX_ID
    original_dir = ORIGINAL_ROOT / CODEX_ID
    for image in images:
        thumb_sha = sha256_file(thumb_dir / str(image["path"]))
        original_sha = sha256_file(original_dir / str(image["original"]))
        revisions.append(hashlib.sha256((thumb_sha + original_sha).encode("ascii")).hexdigest()[:16])
    return revisions[0] if len(revisions) == 1 else hashlib.sha256("\n".join(revisions).encode("ascii")).hexdigest()[:16]


def _regrouped_asset(group: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    images: list[dict[str, Any]] = []
    for row in group["acceptedMembers"]:
        current = state["hashRefs"][str(row["sha256"])]
        image = copy.deepcopy(current["image"])
        image["rawTag"] = clean_text(row.get("prompt"))
        images.append(image)
    first = images[0]
    with Image.open(IMAGE_ROOT / CODEX_ID / str(first["path"])) as opened:
        width, height = opened.size
    return {
        "image": first["path"],
        "imageWidth": width,
        "imageHeight": height,
        "original": first["original"],
        "images": images,
        "assetRev": _asset_revision(images),
    }


def _new_or_regrouped_entry(
    group: dict[str, Any],
    asset: dict[str, Any],
    *,
    is_new: bool,
) -> dict[str, Any]:
    rows = list(group["acceptedMembers"])
    cover = rows[0]
    note_parts = []
    if group["kind"] == "set":
        note_parts.append(
            f"套图：{len(rows)} 张；每张图的正向提示词已绑定为当前图 raw tag，"
            "负面词与角色词展示取封面。"
        )
        if len(rows) != int(group["inputImageCount"]):
            note_parts.append(
                f"源文件夹共 {group['inputImageCount']} 张；按原图去重及 NAI5 且带 prompt 的导入门槛，"
                f"本条收录 {len(rows)} 张，其余已在导入报告中列出。"
            )
    if clean_text(cover.get("note")):
        note_parts.append(clean_text(cover["note"]))
    return {
        "title": group["targetTitle"],
        "path": group["path"],
        "tags": clean_text(cover.get("prompt")),
        **({"negative": clean_text(cover.get("negative"))} if clean_text(cover.get("negative")) else {}),
        **({"characterPrompts": clean_character_prompts(cover.get("characterPrompts"))} if cover.get("characterPrompts") else {}),
        **({"note": "\n".join(note_parts)} if note_parts else {}),
        "rating": "r18",
        "isNew": is_new,
        "id": group["targetEntryId"],
        **{key: value for key, value in asset.items() if key != "entryId"},
    }


def updated_batch_payload(
    old_codex: dict[str, Any],
    groups: list[dict[str, Any]],
    state: dict[str, Any],
    new_assets: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    entries = [copy.deepcopy(entry) for entry in state["dreamEntries"]]
    for group in sorted((item for item in groups if item.get("accepted")), key=lambda item: int(item["entryOrder"])):
        target_id = str(group["targetEntryId"])
        if group.get("new"):
            entry = _new_or_regrouped_entry(group, new_assets[target_id], is_new=True)
        elif group.get("regroup"):
            entry = _new_or_regrouped_entry(group, _regrouped_asset(group, state), is_new=False)
        else:
            entry = copy.deepcopy(state["entryById"][target_id])
            entry["path"] = list(group["path"])
            entry["rating"] = "r18"
        entries.append(entry)
    cover = next((entry for entry in entries if entry.get("id") == PREFERRED_COVER_ENTRY_ID), None)
    if not cover:
        raise RuntimeError(f"preferred safe cover entry is missing: {PREFERRED_COVER_ENTRY_ID}")
    codex = copy.deepcopy(old_codex)
    codex.update({
        "version": BATCH_VERSION,
        "entryCount": len(entries),
        "imagedCount": len(entries),
        "source": "梦神 · N5精选图包 / 所长 · 韩网N5作品筛选整理1–4",
        "contributors": [
            {"name": "梦神", "role": "N5精选图包 · 原图与参数整理 / 常规与 NSFW 分类"},
            {"name": "所长", "role": "韩网N5作品筛选整理1–4 · 原图与参数整理 / 套图归组"},
        ],
        "cover": cover["image"],
        "coverRev": cover["assetRev"],
        "tree": build_tree(entries),
        "entries": entries,
    })
    codex.pop("nsfw", None)
    return codex


def validate_batch_payload(codex: dict[str, Any], groups: list[dict[str, Any]]) -> dict[str, Any]:
    issues: list[str] = []
    accepted_groups = [group for group in groups if group.get("accepted")]
    expected_by_id = {str(group["targetEntryId"]): group for group in accepted_groups}
    entries = list(codex.get("entries") or [])
    suozhang_entries = [entry for entry in entries if (entry.get("path") or [""])[0] == SUOZHANG_ROOT_LABEL]
    if "nsfw" in codex:
        issues.append("unexpected_codex_nsfw")
    if codex.get("version") != BATCH_VERSION:
        issues.append("version")
    if codex.get("entryCount") != len(entries) or codex.get("imagedCount") != len(entries):
        issues.append("entry_counts")
    if set(expected_by_id) != {str(entry.get("id") or "") for entry in suozhang_entries}:
        issues.append("suozhang_entry_ids")
    seen_hashes: set[str] = set()
    thumb_dir = IMAGE_ROOT / CODEX_ID
    original_dir = ORIGINAL_ROOT / CODEX_ID
    all_images = [image for entry in entries for image in (entry.get("images") or [])]
    all_thumbs = [str(image.get("path") or "") for image in all_images]
    all_originals = [str(image.get("original") or "") for image in all_images]
    if len(all_thumbs) != len(set(all_thumbs)) or len(all_originals) != len(set(all_originals)):
        issues.append("cross_entry_asset_name_duplicate")
    if set(all_thumbs) != {path.name for path in thumb_dir.iterdir() if path.is_file()}:
        issues.append("thumb_directory_reference_set")
    if set(all_originals) != {path.name for path in original_dir.iterdir() if path.is_file()}:
        issues.append("original_directory_reference_set")
    for entry in entries:
        if (entry.get("path") or [""])[0] != SUOZHANG_ROOT_LABEL:
            issues.extend(validate_asset(entry, thumb_dir, original_dir))
    for entry in suozhang_entries:
        entry_id = str(entry.get("id") or "")
        group = expected_by_id.get(entry_id)
        if not group:
            continue
        if list(entry.get("path") or []) != list(group["path"]) or entry.get("rating") != "r18":
            issues.append(f"{entry_id}:path_or_rating")
        rows = list(group["acceptedMembers"])
        images = list(entry.get("images") or [])
        if len(images) != len(rows):
            issues.append(f"{entry_id}:image_count")
        if clean_text(entry.get("tags")) != clean_text(rows[0].get("prompt")):
            issues.append(f"{entry_id}:cover_prompt")
        if clean_text(entry.get("negative")) != clean_text(rows[0].get("negative")):
            issues.append(f"{entry_id}:cover_negative")
        if clean_character_prompts(entry.get("characterPrompts")) != clean_character_prompts(rows[0].get("characterPrompts")):
            issues.append(f"{entry_id}:cover_character_prompts")
        issues.extend(validate_asset(entry, thumb_dir, original_dir))
        for position, (image, row) in enumerate(zip(images, rows), 1):
            original = original_dir / str(image.get("original") or "")
            value = sha256_file(original) if original.is_file() else ""
            if value != row.get("sha256"):
                issues.append(f"{entry_id}[{position}]:source_hash")
            if value in seen_hashes:
                issues.append(f"{entry_id}[{position}]:duplicate_hash")
            seen_hashes.add(value)
            expected_prompt = clean_text(image.get("rawTag")) if len(images) > 1 else clean_text(entry.get("tags"))
            if expected_prompt != clean_text(row.get("prompt")):
                issues.append(f"{entry_id}[{position}]:raw_tag")
            try:
                metadata = extract_image_metadata(original)
            except Exception as exc:
                issues.append(f"{entry_id}[{position}]:metadata:{type(exc).__name__}")
                continue
            if clean_text(metadata.prompt) != clean_text(row.get("prompt")):
                issues.append(f"{entry_id}[{position}]:original_prompt")
            if position == 1:
                if clean_text(metadata.negative) != clean_text(entry.get("negative")):
                    issues.append(f"{entry_id}:original_negative")
                if clean_character_prompts(metadata.character_prompts) != clean_character_prompts(entry.get("characterPrompts")):
                    issues.append(f"{entry_id}:original_character_prompts")
    expected_hashes = {
        str(row["sha256"])
        for group in accepted_groups
        for row in group["acceptedMembers"]
    }
    if seen_hashes != expected_hashes:
        issues.append("source_hash_set")
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
        "images": sum(len(entry.get("images") or []) for entry in entries),
        "suozhangEntries": len(suozhang_entries),
        "suozhangImages": len(seen_hashes),
        "multiImageEntries": sum(len(entry.get("images") or []) > 1 for entry in entries),
        "maxImagesPerEntry": max((len(entry.get("images") or []) for entry in entries), default=0),
        "sourceHashMismatches": 0,
        "promptMismatches": 0,
        "missingAssets": 0,
    }


def updated_batch_index(codex: dict[str, Any]) -> list[dict[str, Any]]:
    index_path = DATA_DIR / "codexes.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    position = next((index for index, item in enumerate(index) if item.get("id") == CODEX_ID), None)
    if position is None:
        raise RuntimeError(f"codex index missing {CODEX_ID}")
    index[position] = index_meta(codex)
    return index


def apply_batch_update(
    groups: list[dict[str, Any]],
    source_info: dict[str, Any],
    state: dict[str, Any],
    plan: dict[str, Any],
    old_codex: dict[str, Any],
    workers: int,
) -> dict[str, Any]:
    blockers = list(source_info.get("blockers") or []) + list(plan.get("blockers") or [])
    if blockers:
        raise RuntimeError("batch update has blockers:\n" + "\n".join(dict.fromkeys(blockers)))
    write_json(OUTPUT_DIR / "batch_applied_plan.json", {
        "auditDate": date.today().isoformat(),
        "sourceAudit": source_info,
        "plan": plan,
    })
    data_path = DATA_DIR / f"{CODEX_ID}.json"
    index_path = DATA_DIR / "codexes.json"
    thumb_dir = IMAGE_ROOT / CODEX_ID
    original_dir = ORIGINAL_ROOT / CODEX_ID
    if not data_path.is_file() or not index_path.is_file() or not thumb_dir.is_dir() or not original_dir.is_dir():
        raise RuntimeError("installed codex data/assets are incomplete")

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = OUTPUT_DIR / "backups" / stamp
    backup_dir.mkdir(parents=True, exist_ok=False)
    shutil.copy2(data_path, backup_dir / data_path.name)
    shutil.copy2(index_path, backup_dir / index_path.name)

    thumb_stage = make_staging_directory(IMAGE_ROOT, f".{CODEX_ID}-batch-")
    original_stage = make_staging_directory(ORIGINAL_ROOT, f".{CODEX_ID}-batch-")
    data_temp = DATA_DIR / f".{CODEX_ID}.batch.tmp"
    index_temp = DATA_DIR / f".codexes.json.{CODEX_ID}.batch.tmp"
    moved_files: list[Path] = []
    data_replaced = False
    index_replaced = False
    try:
        asset_tasks = []
        for group in groups:
            if not group.get("accepted") or not group.get("new"):
                continue
            multi = int(group["acceptedImageCount"]) > 1
            asset_tasks.append({
                "entryId": group["targetEntryId"],
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
        assets = run_parallel("N5 numbered pack assets", write_asset_bundle_from_paths, asset_tasks, workers)
        new_assets = {str(asset["entryId"]): asset for asset in assets}
        expected_new_ids = {
            str(group["targetEntryId"])
            for group in groups
            if group.get("accepted") and group.get("new")
        }
        if set(new_assets) != expected_new_ids:
            raise RuntimeError("new asset task result set mismatch")
        for stage, final in ((thumb_stage, thumb_dir), (original_stage, original_dir)):
            for source_file in sorted(stage.iterdir(), key=lambda path: natural_key(path.name)):
                destination = final / source_file.name
                if destination.exists():
                    raise RuntimeError(f"new asset would overwrite existing file: {destination}")
                source_file.rename(destination)
                moved_files.append(destination)

        codex = updated_batch_payload(old_codex, groups, state, new_assets)
        validation = validate_batch_payload(codex, groups)
        index = updated_batch_index(codex)
        write_json(data_temp, codex, compact=True)
        write_json(index_temp, index)
        data_temp.replace(data_path)
        data_replaced = True
        index_temp.replace(index_path)
        index_replaced = True
        result = {
            **validation,
            "addedEntries": plan["changes"]["newEntries"],
            "addedImages": plan["changes"]["newImages"],
            "regroupedEntriesRemoved": plan["changes"]["removedEntriesForRegrouping"],
            "backup": str(backup_dir),
            "thumbFiles": len(list(thumb_dir.iterdir())),
            "originalFiles": len(list(original_dir.iterdir())),
        }
        write_json(OUTPUT_DIR / "batch_applied_result.json", result)
        return result
    except Exception:
        if data_replaced:
            shutil.copy2(backup_dir / data_path.name, data_path)
        if index_replaced or data_replaced:
            shutil.copy2(backup_dir / index_path.name, index_path)
        for path in reversed(moved_files):
            path.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(thumb_stage, ignore_errors=True)
        shutil.rmtree(original_stage, ignore_errors=True)
        data_temp.unlink(missing_ok=True)
        index_temp.unlink(missing_ok=True)


def validate_batch_install(source: Path, workers: int) -> dict[str, Any]:
    rows, groups, source_info, state, plan, context = run_batch_plan(source, workers)
    if source_info.get("blockers"):
        raise RuntimeError("batch validation blockers:\n" + "\n".join(source_info["blockers"][:100]))
    if plan.get("wouldChange"):
        raise RuntimeError("batch update is not idempotent:\n" + json.dumps(plan, ensure_ascii=False, indent=2))
    codex = context["codex"]
    validation = validate_batch_payload(codex, groups)
    index = json.loads((DATA_DIR / "codexes.json").read_text(encoding="utf-8"))
    meta = next((item for item in index if item.get("id") == CODEX_ID), None)
    if meta != index_meta(codex):
        raise RuntimeError("codex index metadata differs from installed book")
    result = {
        **validation,
        "batchPaths": plan["pathSummary"],
        "idempotentChanges": 0,
        "indexMetadataMismatches": 0,
        "reports": context["files"],
    }
    write_json(OUTPUT_DIR / "batch_validation.json", result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=RAW_ROOT)
    parser.add_argument("--batch-source", type=Path, default=BATCH_RAW_ROOT)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--validate", action="store_true")
    mode.add_argument("--batch-plan", action="store_true")
    mode.add_argument("--batch-apply", action="store_true")
    mode.add_argument("--batch-validate", action="store_true")
    parser.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1))
    args = parser.parse_args()
    if args.workers < 1:
        raise SystemExit("--workers must be at least 1")
    if args.batch_plan or args.batch_apply or args.batch_validate:
        batch_source = args.batch_source.resolve()
        if not batch_source.is_dir():
            raise SystemExit(f"batch source folder not found: {batch_source}")
        if args.batch_validate:
            print(json.dumps(validate_batch_install(batch_source, args.workers), ensure_ascii=False, indent=2))
            return 0
        _rows, groups, source_info, state, plan, context = run_batch_plan(batch_source, args.workers)
        output: dict[str, Any] = {
            "sourceAudit": source_info,
            "plan": plan,
            "reports": context["files"],
        }
        if args.batch_apply:
            output["apply"] = apply_batch_update(
                groups,
                source_info,
                state,
                plan,
                context["codex"],
                args.workers,
            )
            output["validation"] = validate_batch_install(batch_source, args.workers)
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0
    if args.validate:
        installed = json.loads((DATA_DIR / f"{CODEX_ID}.json").read_text(encoding="utf-8"))
        has_numbered_paths = any(
            (entry.get("path") or [""])[0] == SUOZHANG_ROOT_LABEL
            and len(entry.get("path") or []) == 2
            and str((entry.get("path") or ["", ""])[1]).startswith("筛选整理")
            for entry in installed.get("entries") or []
        )
        result = validate_batch_install(args.batch_source.resolve(), args.workers) if has_numbered_paths else validate_import()
        print(json.dumps(result, ensure_ascii=False, indent=2))
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
