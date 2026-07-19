from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import shutil
import sys
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "site" / "data"
IMAGE_ROOT = ROOT / "site" / "images"
ORIGINAL_ROOT = ROOT / "originals"
OUTPUT_DIR = ROOT / "output" / "community_ai_misc_import"
DEFAULT_SOURCE = ROOT.parent / "新数据" / "AI杂图（带元数据）-N4.5最终版" / "人工分类"
CODEX_ID = "community_ai_misc"
TITLE = "社区AI杂图"
AUTHOR = "社区贡献者"
VERSION = "2026.7.20"
MAX_DIM = 1100
IMAGE_EXTS = {".png", ".webp", ".jpg", ".jpeg"}
EXCLUDED_FOLDER = "不予收录"


@dataclass(frozen=True)
class Category:
    folder: str
    path: tuple[str, ...]
    rating: str
    title: str


CATEGORIES = (
    Category("1常规级", ("常规",), "safe", "常规"),
    Category("2限制级别", ("NSFW-限制级别",), "restricted", "限制级"),
    Category("3r18", ("NSFW-限制级别", "r18"), "r18", "R18"),
    Category("4扶他", ("NSFW-限制级别", "扶他"), "r18", "扶他"),
    Category("5r18g", ("NSFW-限制级别", "r18g"), "r18g", "R18G"),
)
CATEGORY_BY_FOLDER = {item.folder: item for item in CATEGORIES}
CATEGORY_ORDER = {item.path: index for index, item in enumerate(CATEGORIES)}

MANUAL_CLASSIFICATION_OVERRIDES = {
    f"{CODEX_ID}-0035": {
        "path": ("NSFW-限制级别", "r18"),
        "rating": "r18",
        "title": "R18 1764",
        "reason": "用户确认原“常规 0035”为 R18",
    },
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def clean_text(value: Any) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()


def sampler_label(value: Any) -> str:
    labels = {
        "k_euler_ancestral": "Euler A",
        "k_euler": "Euler",
        "ddim": "DDIM",
        "k_dpmpp_2m": "DPM++ 2M",
        "k_dpmpp_2m_sde": "DPM++ 2M SDE",
        "k_dpmpp_sde": "DPM++ SDE",
    }
    text = clean_text(value)
    return labels.get(text, text)


def metadata_note(meta: Any) -> str:
    fields = meta.fields if isinstance(meta.fields, dict) else {}
    payload = fields.get("CommentJson") or fields.get("StealthJson") or {}
    if not isinstance(payload, dict):
        payload = {}
    parts: list[str] = []
    values = (
        ("Steps", payload.get("steps")),
        ("Sampler", sampler_label(payload.get("sampler"))),
        ("CFG scale", payload.get("scale") or payload.get("cfg_scale")),
        ("CFG rescale", payload.get("cfg_rescale")),
        ("Seed", payload.get("seed")),
    )
    for label, value in values:
        if value not in (None, ""):
            parts.append(f"{label}: {value}")
    width = payload.get("width")
    height = payload.get("height")
    if width and height:
        parts.append(f"Size: {width}x{height}")
    if payload.get("noise_schedule"):
        parts.append(f"Noise schedule: {payload['noise_schedule']}")

    lines: list[str] = []
    if parts:
        lines.append("参数：" + ", ".join(parts))
    parameters_other = clean_text(fields.get("parameters_other"))
    if parameters_other and not parts:
        lines.append("参数：" + " ".join(parameters_other.split()))
    lines.append(f"元数据：{meta.source_type}")
    return "\n".join(lines)


def scan_one(task: dict[str, Any]) -> dict[str, Any]:
    sys.path.insert(0, str(ROOT / "tools"))
    from sd_metadata_inspector import extract_image_metadata, split_prompt_tags

    path = Path(task["sourcePath"])
    result = {
        **task,
        "extension": path.suffix.lower(),
        "sourceType": "unknown",
        "prompt": "",
        "negative": "",
        "note": "",
        "promptTagCount": 0,
        "sha256": "",
        "width": 0,
        "height": 0,
        "accepted": False,
        "reason": "",
        "duplicateOf": "",
    }
    try:
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            result["width"], result["height"] = image.size
    except Exception as exc:
        result["reason"] = f"unreadable_image:{type(exc).__name__}"
        return result

    try:
        meta = extract_image_metadata(path)
        result["sourceType"] = clean_text(meta.source_type) or "unknown"
        result["prompt"] = clean_text(meta.prompt)
        result["negative"] = clean_text(meta.negative)
        result["note"] = metadata_note(meta)
        result["promptTagCount"] = len(split_prompt_tags(result["prompt"]))
    except Exception as exc:
        result["reason"] = f"metadata_error:{type(exc).__name__}"
        return result

    try:
        result["sha256"] = sha256_file(path)
    except Exception as exc:
        result["reason"] = f"hash_error:{type(exc).__name__}"
        return result

    if not result["prompt"]:
        result["reason"] = "no_prompt"
        return result
    if not result["promptTagCount"]:
        result["reason"] = "no_tags_after_parse"
        return result
    result["accepted"] = True
    result["reason"] = "accepted"
    return result


def asset_one(task: dict[str, Any]) -> dict[str, Any]:
    source = Path(task["sourcePath"])
    entry_id = task["entryId"]
    thumb_dir = Path(task["thumbDir"])
    original_dir = Path(task["originalDir"])
    original_ext = ".jpg" if source.suffix.lower() == ".jpeg" else source.suffix.lower()
    thumb_name = f"{entry_id}.jpg"
    original_name = f"{entry_id}{original_ext}"
    thumb_path = thumb_dir / thumb_name
    original_path = original_dir / original_name

    shutil.copy2(source, original_path)
    copied_sha = sha256_file(original_path)
    if copied_sha != task["sha256"]:
        raise RuntimeError(f"original copy hash mismatch: {source}")

    with Image.open(source) as opened:
        image = ImageOps.exif_transpose(opened)
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")
        image.thumbnail((MAX_DIM, MAX_DIM), Image.Resampling.LANCZOS)
        image.save(thumb_path, "JPEG", quality=86, optimize=True)
        width, height = image.size

    thumb_sha = sha256_file(thumb_path)
    rev = hashlib.sha256((thumb_sha + copied_sha).encode("ascii")).hexdigest()[:16]
    return {
        "entryId": entry_id,
        "image": thumb_name,
        "imageWidth": width,
        "imageHeight": height,
        "original": original_name,
        "images": [{"path": thumb_name, "original": original_name}],
        "assetRev": rev,
    }


def validation_one(task: dict[str, Any]) -> dict[str, Any]:
    sys.path.insert(0, str(ROOT / "tools"))
    from sd_metadata_inspector import extract_image_metadata

    entry = task["entry"]
    original = Path(task["original"])
    thumb = Path(task["thumb"])
    issues: list[str] = []
    if not original.is_file():
        issues.append("missing_original")
    if not thumb.is_file():
        issues.append("missing_thumb")
    if issues:
        return {"id": entry["id"], "issues": issues}
    try:
        meta = extract_image_metadata(original)
    except Exception as exc:
        return {"id": entry["id"], "issues": [f"metadata_error:{type(exc).__name__}"]}
    if clean_text(meta.prompt) != clean_text(entry.get("tags")):
        issues.append("prompt_mismatch")
    if clean_text(meta.negative) != clean_text(entry.get("negative")):
        issues.append("negative_mismatch")
    try:
        with Image.open(thumb) as image:
            if image.size != (entry.get("imageWidth"), entry.get("imageHeight")):
                issues.append("thumb_dimensions_mismatch")
    except Exception as exc:
        issues.append(f"thumb_error:{type(exc).__name__}")
    return {"id": entry["id"], "issues": issues}


def source_tasks(source: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    unsupported: list[str] = []
    source_index = 0
    category_counts: dict[str, int] = {}
    for category in CATEGORIES:
        directory = source / category.folder
        if not directory.is_dir():
            raise RuntimeError(f"missing category folder: {directory}")
        files = sorted(
            (path for path in directory.rglob("*") if path.is_file()),
            key=lambda path: path.relative_to(directory).as_posix().casefold(),
        )
        category_counts[category.folder] = 0
        for path in files:
            if path.suffix.lower() not in IMAGE_EXTS:
                unsupported.append(str(path.relative_to(source)))
                continue
            source_index += 1
            category_counts[category.folder] += 1
            tasks.append({
                "sourceIndex": source_index,
                "sourcePath": str(path),
                "relativePath": path.relative_to(source).as_posix(),
                "folder": category.folder,
                "path": list(category.path),
                "rating": category.rating,
                "titlePrefix": category.title,
            })

    excluded_dir = source / EXCLUDED_FOLDER
    excluded_images = []
    excluded_other = []
    if excluded_dir.is_dir():
        for path in sorted(excluded_dir.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(source).as_posix()
            if path.suffix.lower() in IMAGE_EXTS:
                excluded_images.append(rel)
            else:
                excluded_other.append(rel)
    return tasks, {
        "categoryInputCounts": category_counts,
        "unsupportedIncludedFiles": unsupported,
        "excludedFolder": EXCLUDED_FOLDER,
        "excludedImageCount": len(excluded_images),
        "excludedOtherFiles": excluded_other,
        "excludedExamples": excluded_images[:30],
    }


def run_parallel(label: str, function: Any, tasks: list[dict[str, Any]], workers: int) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    print(f"{label}: 0/{len(tasks)}", flush=True)
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for index, result in enumerate(pool.map(function, tasks, chunksize=8), 1):
            results.append(result)
            if index % 250 == 0 or index == len(tasks):
                print(f"{label}: {index}/{len(tasks)}", flush=True)
    return results


def mark_exact_duplicates(results: list[dict[str, Any]]) -> None:
    rating_rank = {"safe": 0, "restricted": 1, "r18": 2, "r18g": 3}
    hashes: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in results:
        if row.get("accepted") and row.get("sha256"):
            hashes[row["sha256"]].append(row)
    for items in hashes.values():
        if len(items) < 2:
            continue
        keeper = max(
            items,
            key=lambda item: (
                rating_rank.get(item["rating"], -1),
                -int(item["sourceIndex"]),
            ),
        )
        for item in items:
            if item is keeper:
                continue
            item["accepted"] = False
            item["reason"] = "exact_duplicate"
            item["duplicateOf"] = keeper["relativePath"]


def apply_manual_classification_overrides(results: list[dict[str, Any]]) -> None:
    found: set[str] = set()
    for row in results:
        entry_id = f"{CODEX_ID}-{row['sourceIndex']:04d}"
        override = MANUAL_CLASSIFICATION_OVERRIDES.get(entry_id)
        if not override:
            continue
        if not row.get("accepted"):
            raise RuntimeError(f"manual classification target is not importable: {entry_id}")
        row["path"] = list(override["path"])
        row["rating"] = override["rating"]
        row["entryTitleOverride"] = override["title"]
        row["classificationOverride"] = override["reason"]
        found.add(entry_id)
    missing = set(MANUAL_CLASSIFICATION_OVERRIDES) - found
    if missing:
        raise RuntimeError(f"manual classification targets missing: {sorted(missing)}")


def write_audit_files(results: list[dict[str, Any]], source_info: dict[str, Any], source: Path) -> dict[str, Any]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    rows_path = OUTPUT_DIR / "all_files.csv"
    no_tags_path = OUTPUT_DIR / "not_imported_no_tags.csv"
    duplicates_path = OUTPUT_DIR / "duplicate_hashes.csv"
    fields = [
        "sourceIndex", "relativePath", "folder", "displayPath", "rating",
        "classificationOverride", "extension", "sourceType", "width", "height",
        "promptTagCount", "accepted", "reason", "duplicateOf", "sha256",
    ]
    with rows_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows({
            key: (
                "/".join(row.get("path") or ())
                if key == "displayPath"
                else row.get(key, "")
            )
            for key in fields
        } for row in results)

    rejected = [row for row in results if not row["accepted"]]
    rejected_no_tags = [row for row in rejected if row["reason"] != "exact_duplicate"]
    with no_tags_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows({
            key: (
                "/".join(row.get("path") or ())
                if key == "displayPath"
                else row.get(key, "")
            )
            for key in fields
        } for row in rejected_no_tags)

    hashes: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in results:
        if row.get("sha256"):
            hashes[row["sha256"]].append(row)
    duplicate_groups = [items for items in hashes.values() if len(items) > 1]
    with duplicates_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["sha256", "copies", "folders", "paths"])
        writer.writeheader()
        for items in duplicate_groups:
            writer.writerow({
                "sha256": items[0]["sha256"],
                "copies": len(items),
                "folders": " | ".join(sorted({item["folder"] for item in items})),
                "paths": " | ".join(item["relativePath"] for item in items),
            })

    category_summary = {}
    for category in CATEGORIES:
        items = [
            row for row in results
            if tuple(row["path"]) == category.path and row["rating"] == category.rating
        ]
        category_summary[category.folder] = {
            "displayPath": list(category.path),
            "rating": category.rating,
            "input": len(items),
            "accepted": sum(row["accepted"] for row in items),
            "noTag": sum(
                not row["accepted"] and row["reason"] != "exact_duplicate"
                for row in items
            ),
            "duplicateSkipped": sum(row["reason"] == "exact_duplicate" for row in items),
        }
    accepted = [row for row in results if row["accepted"]]
    cross_category_duplicates = sum(
        1 for items in duplicate_groups if len({item["folder"] for item in items}) > 1
    )
    report = {
        "codexId": CODEX_ID,
        "title": TITLE,
        "source": str(source),
        "auditDate": date.today().isoformat(),
        "inputImages": len(results),
        "accepted": len(accepted),
        "notImported": len(rejected),
        "notImportedNoTags": len(rejected_no_tags),
        "notImportedDuplicates": sum(row["reason"] == "exact_duplicate" for row in rejected),
        "notImportedReasons": dict(Counter(row["reason"] for row in rejected)),
        "metadataSourcesAccepted": dict(Counter(row["sourceType"] for row in accepted)),
        "categorySummary": category_summary,
        "manualClassificationOverrides": [
            {
                "id": f"{CODEX_ID}-{row['sourceIndex']:04d}",
                "source": row["relativePath"],
                "path": row["path"],
                "rating": row["rating"],
                "title": row["entryTitleOverride"],
                "reason": row["classificationOverride"],
            }
            for row in results
            if row.get("classificationOverride")
        ],
        "exactDuplicateGroups": len(duplicate_groups),
        "exactDuplicateExtraCopies": sum(len(items) - 1 for items in duplicate_groups),
        "crossCategoryDuplicateGroups": cross_category_duplicates,
        **source_info,
        "files": {
            "all": str(rows_path),
            "notImported": str(no_tags_path),
            "duplicates": str(duplicates_path),
        },
    }
    report_path = OUTPUT_DIR / "report.json"
    report["files"]["report"] = str(report_path)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def build_tree(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    root: dict[str, Any] = {}
    for entry in entries:
        node = root
        for name in entry["path"]:
            current = node.setdefault(name, {"name": name, "count": 0, "children": {}})
            current["count"] += 1
            node = current["children"]

    def serialize(node: dict[str, Any]) -> list[dict[str, Any]]:
        return [
            {
                "name": value["name"],
                "count": value["count"],
                "children": serialize(value["children"]),
            }
            for value in node.values()
        ]

    return serialize(root)


def codex_payload(entries: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": CODEX_ID,
        "type": "pack",
        "title": TITLE,
        "version": VERSION,
        "author": AUTHOR,
        "entryCount": len(entries),
        "imagedCount": len(entries),
        "hasOriginal": True,
        "source": "社区贡献者 · AI杂图（带元数据）-N4.5最终版",
        "contributors": [
            {"name": "社区贡献者", "role": "原图与参数收集 / 人工分类"},
        ],
        "links": [],
        "tree": build_tree(entries),
        "entries": entries,
    }


def update_index(codex: dict[str, Any]) -> None:
    index_path = DATA_DIR / "codexes.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    if any(item.get("id") == CODEX_ID for item in index):
        raise RuntimeError(f"index already contains {CODEX_ID}")
    meta = {
        key: codex[key]
        for key in (
            "id", "type", "title", "version", "author", "entryCount",
            "imagedCount", "hasOriginal", "source", "contributors", "links",
        )
    }
    insert_at = next(
        (position + 1 for position, item in enumerate(index) if item.get("id") == "mengshen_pack"),
        len(index),
    )
    index.insert(insert_at, meta)
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def apply_import(results: list[dict[str, Any]], workers: int) -> dict[str, Any]:
    data_path = DATA_DIR / f"{CODEX_ID}.json"
    thumb_dir = IMAGE_ROOT / CODEX_ID
    original_dir = ORIGINAL_ROOT / CODEX_ID
    if data_path.exists() or thumb_dir.exists() or original_dir.exists():
        raise RuntimeError(f"target already exists for {CODEX_ID}; refusing to overwrite")
    thumb_dir.mkdir(parents=True)
    original_dir.mkdir(parents=True)

    accepted_by_source = sorted(
        (row for row in results if row["accepted"]),
        key=lambda row: int(row["sourceIndex"]),
    )
    source_title_counts: Counter[str] = Counter()
    for row in accepted_by_source:
        source_title_counts[row["folder"]] += 1
        row["defaultEntryTitle"] = (
            f"{row['titlePrefix']} {source_title_counts[row['folder']]:04d}"
        )
    accepted = sorted(
        accepted_by_source,
        key=lambda row: (
            CATEGORY_ORDER[tuple(row["path"])],
            bool(row.get("classificationOverride")),
            int(row["sourceIndex"]),
        ),
    )
    asset_tasks = []
    for row in accepted:
        entry_id = f"{CODEX_ID}-{row['sourceIndex']:04d}"
        row["entryId"] = entry_id
        row["entryTitle"] = row.get("entryTitleOverride") or row["defaultEntryTitle"]
        asset_tasks.append({
            "sourcePath": row["sourcePath"],
            "entryId": entry_id,
            "sha256": row["sha256"],
            "thumbDir": str(thumb_dir),
            "originalDir": str(original_dir),
        })

    assets = run_parallel("assets", asset_one, asset_tasks, workers)
    asset_by_id = {asset["entryId"]: asset for asset in assets}
    entries = []
    for row in accepted:
        entry = {
            "title": row["entryTitle"],
            "path": row["path"],
            "tags": row["prompt"],
            "negative": row["negative"],
            "note": row["note"],
            "rating": row["rating"],
            "id": row["entryId"],
            "isNew": False,
            **{key: value for key, value in asset_by_id[row["entryId"]].items() if key != "entryId"},
        }
        entries.append(entry)

    codex = codex_payload(entries)
    data_path.write_text(
        json.dumps(codex, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    update_index(codex)
    return {
        "codexId": CODEX_ID,
        "entries": len(entries),
        "thumbs": len(list(thumb_dir.iterdir())),
        "originals": len(list(original_dir.iterdir())),
        "data": str(data_path),
    }


def validate_import(workers: int) -> dict[str, Any]:
    data_path = DATA_DIR / f"{CODEX_ID}.json"
    codex = json.loads(data_path.read_text(encoding="utf-8"))
    entries = codex.get("entries") or []
    issues: list[str] = []
    ids = [entry.get("id") for entry in entries]
    if len(ids) != len(set(ids)):
        issues.append("duplicate_ids")
    if codex.get("entryCount") != len(entries) or codex.get("imagedCount") != len(entries):
        issues.append("metadata_counts")
    expected = {
        tuple(category.path): category.rating
        for category in CATEGORIES
    }
    for entry in entries:
        path = tuple(entry.get("path") or ())
        if path not in expected:
            issues.append(f"bad_path:{entry.get('id')}")
        elif entry.get("rating") != expected[path]:
            issues.append(f"bad_rating:{entry.get('id')}")
        if not clean_text(entry.get("tags")):
            issues.append(f"empty_tags:{entry.get('id')}")
    by_id = {entry.get("id"): entry for entry in entries}
    for entry_id, override in MANUAL_CLASSIFICATION_OVERRIDES.items():
        entry = by_id.get(entry_id)
        if not entry:
            issues.append(f"missing_manual_override:{entry_id}")
            continue
        if tuple(entry.get("path") or ()) != tuple(override["path"]):
            issues.append(f"bad_manual_override_path:{entry_id}")
        if entry.get("rating") != override["rating"]:
            issues.append(f"bad_manual_override_rating:{entry_id}")
        if entry.get("title") != override["title"]:
            issues.append(f"bad_manual_override_title:{entry_id}")

    tasks = [
        {
            "entry": entry,
            "original": str(ORIGINAL_ROOT / CODEX_ID / entry.get("original", "")),
            "thumb": str(IMAGE_ROOT / CODEX_ID / entry.get("image", "")),
        }
        for entry in entries
    ]
    rows = run_parallel("validate", validation_one, tasks, workers)
    for row in rows:
        issues.extend(f"{row['id']}:{issue}" for issue in row["issues"])
    if issues:
        raise RuntimeError("\n".join(issues[:100]))
    return {
        "codexId": CODEX_ID,
        "entries": len(entries),
        "uniqueIds": len(set(ids)),
        "promptMismatches": 0,
        "negativeMismatches": 0,
        "missingAssets": 0,
        "badPathsOrRatings": 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--validate", action="store_true")
    parser.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1))
    args = parser.parse_args()
    if args.workers < 1:
        raise SystemExit("--workers must be at least 1")
    if args.validate:
        print(json.dumps(validate_import(args.workers), ensure_ascii=False, indent=2))
        return 0
    source = args.source.resolve()
    if not source.is_dir():
        raise SystemExit(f"source folder not found: {source}")

    tasks, source_info = source_tasks(source)
    results = run_parallel("metadata", scan_one, tasks, args.workers)
    apply_manual_classification_overrides(results)
    mark_exact_duplicates(results)
    report = write_audit_files(results, source_info, source)
    output: dict[str, Any] = {"audit": report}
    if args.apply:
        output["import"] = apply_import(results, args.workers)
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
