"""Import the consolidated NovelAI 5 single-artist / artist-string dictionary.

The source is deliberately limited to four credited collections:

* 九七: DOCX table (artist label + embedded PNG)
* 无冕: one-page PDF board (300 labels + 300 embedded image patterns)
* 成川姬: loose N5 single-artist PNG files (legacy source folder / IDs use 所长 / suozhang)
* 梦神: the 95-image "第二弹" artist-string folder

The unrelated ``nai5鲍群+闲云群提示词收集.docx`` source is never opened.
Default mode is an audit-only dry run. ``--apply`` refuses to overwrite any
existing data or asset target. ``--correct-existing`` provides a separate,
idempotent three-entry repair path whose write still requires ``--apply``.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import shutil
import statistics
import sys
import tempfile
import zipfile
from collections import Counter
from datetime import date
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from PIL import Image
from pypdf import PdfReader
from pypdf.generic import ContentStream
from pypdf.generic._image_xobject import _xobj_to_image


ROOT = Path(__file__).resolve().parents[1]
RAW_ROOT = ROOT.parent / "新数据" / "N5图包"
DATA_DIR = ROOT / "site" / "data"
IMAGE_ROOT = ROOT / "site" / "images"
ORIGINAL_ROOT = ROOT / "originals"
OUTPUT_DIR = ROOT / "output" / "nai5_artist_dictionary_import"

CODEX_ID = "artist_nai5_personal"
TITLE = "NovelAI5画师词典"
VERSION = "2026.8.25"
CHENGCHUANJI = "成川姬"
LEGACY_SUOZHANG_SOURCE_MARKER = "所长"
AUTHOR = f"九七 / 无冕 / {CHENGCHUANJI} / 梦神"
EXCLUDED_SOURCE_NAME = "nai5鲍群+闲云群提示词收集.docx"
IMAGE_EXTS = {".png", ".webp", ".jpg", ".jpeg"}

SECTION_ORDER = {"九七": 0, "无冕": 1, CHENGCHUANJI: 2, "梦神": 3}
SECTION_CONFIG = {
    "九七": {
        "path": ["单画师词典", "九七(无原图)", "5F单artist画风炼度参考"],
        "idPrefix": "jiuqi",
        "rating": "safe",
    },
    "无冕": {
        "path": ["单画师词典", "无冕", "N5单画师300筛选"],
        "idPrefix": "wumian",
        "rating": "r18",
    },
    CHENGCHUANJI: {
        "path": ["单画师词典", CHENGCHUANJI, "N5F单画师测试（2025–2026）"],
        "idPrefix": "suozhang",
        "rating": "r18",
    },
    "梦神": {
        "path": ["画师串词典", "梦神", "N5暂时可用画风"],
        "idPrefix": "mengshen",
        "rating": "safe",
    },
}

# The PDF board contains three visible labels that conflict with the NovelAI
# prompt embedded in the image directly below them.  Pattern names are stable
# PDF asset identities, so keep the correction anchored to both the pattern and
# the final entry ID instead of relying on a mutable list position.
WUMIAN_SOURCE_TAG_CORRECTIONS = {
    "/P91": {
        "entryId": f"{CODEX_ID}_wumian_0032",
        "sourceLabel": "artist:chyoel",
        "correctedTags": "artist:channel (caststation)",
        "reason": "PDF 标签与原图 NovelAI prompt 冲突，以原图参数为准",
    },
    "/P94": {
        "entryId": f"{CODEX_ID}_wumian_0033",
        "sourceLabel": "artist:channel_(caststation)",
        "correctedTags": "artist:chyoel",
        "reason": "PDF 标签与原图 NovelAI prompt 冲突，以原图参数为准",
    },
    "/P754": {
        "entryId": f"{CODEX_ID}_wumian_0280",
        "sourceLabel": "artist:xuchuan",
        "correctedTags": "artist:xiumu bianzhou",
        "reason": "PDF 标签与原图 NovelAI prompt 冲突，以原图参数为准",
    },
}

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PR = "{http://schemas.openxmlformats.org/package/2006/relationships}"

sys.path.insert(0, str(ROOT / "tools"))
from pack_import_core import (  # noqa: E402
    build_tree,
    clean_text,
    inspect_image_task,
    make_staging_directory,
    metadata_note,
    normalized_suffix,
    run_parallel,
    sha256_bytes,
    sha256_file,
    validate_asset,
    write_asset_from_path,
    write_json,
)
from sd_metadata_inspector import extract_image_metadata, extract_png_metadata_from_bytes  # noqa: E402


def find_one(root: Path, pattern: str, label: str) -> Path:
    matches = sorted(root.glob(pattern), key=lambda path: path.name.casefold())
    if len(matches) != 1:
        raise RuntimeError(f"expected one {label}, found {len(matches)}: {matches}")
    return matches[0]


def discover_sources(raw_root: Path) -> dict[str, Path]:
    single_root = raw_root / "单画师型"
    string_root = raw_root / "画师串型"
    if not single_root.is_dir() or not string_root.is_dir():
        raise RuntimeError(f"N5 source layout missing below {raw_root}")

    word = find_one(single_root, "*九七*.docx", "九七 DOCX")
    pdf = find_one(single_root, "*无冕*.pdf", "无冕 PDF")
    suozhang_candidates = [
        path for path in single_root.rglob("*")
        if path.is_dir() and path.name == "nai5单画师测试" and LEGACY_SUOZHANG_SOURCE_MARKER in path.parent.name
    ]
    if len(suozhang_candidates) != 1:
        raise RuntimeError(f"expected one legacy 所长 single-artist folder, found: {suozhang_candidates}")
    mengshen_candidates = [
        path for path in string_root.rglob("*")
        if path.is_dir()
        and path.name == "n5暂时可用画风"
        and "第二弹" in path.parent.name
        and "密码梦神" in path.parent.name
    ]
    if len(mengshen_candidates) != 1:
        raise RuntimeError(f"expected one 梦神 第二弹 folder, found: {mengshen_candidates}")
    return {
        "word": word,
        "pdf": pdf,
        "suozhang": suozhang_candidates[0],
        "mengshen": mengshen_candidates[0],
    }


def model_family(value: Any) -> str:
    text = clean_text(value).lower()
    if "v4.5" in text or "naiv4.5" in text:
        return "nai45"
    if "diffusion v5" in text or "naiv5" in text or re.search(r"\bv5\b", text):
        return "nai5"
    return "unknown"


def artist_title(tags: str) -> str:
    value = clean_text(tags)
    value = re.sub(r"^[+-]?\d+(?:\.\d+)?::", "", value)
    value = re.sub(r"::$", "", value)
    value = re.sub(r"^artist\s*:\s*", "", value, flags=re.IGNORECASE)
    return value.strip(" ,:_") or clean_text(tags) or "未命名画师"


def first_style_tag(prompt: str, fallback: str) -> str:
    segment = clean_text(re.split(r"[,，\r\n]", str(prompt or ""), maxsplit=1)[0])
    weighted = re.fullmatch(r"[+-]?\d+(?:\.\d+)?::(.+?)::", segment)
    if weighted:
        segment = weighted.group(1).strip()
    return segment or clean_text(fallback)


def normalized_artist_key(tags: str) -> str:
    value = artist_title(tags).casefold().replace("_", " ")
    return re.sub(r"\s+", " ", value).strip()


def resolve_wumian_source_tag(
    pattern_name: str,
    source_tags: str,
    embedded_tags: str,
) -> tuple[str, str]:
    correction = WUMIAN_SOURCE_TAG_CORRECTIONS.get(pattern_name)
    if correction:
        if clean_text(source_tags) != correction["sourceLabel"]:
            raise RuntimeError(
                f"无冕已登记校正的 PDF 标签变化: {pattern_name}: "
                f"{source_tags!r} != {correction['sourceLabel']!r}"
            )
        if normalized_artist_key(embedded_tags) != normalized_artist_key(correction["correctedTags"]):
            raise RuntimeError(
                f"无冕已登记校正的原图 prompt 变化: {pattern_name}: "
                f"{embedded_tags!r} != {correction['correctedTags']!r}"
            )
        return correction["correctedTags"], "embedded_prompt_correction"

    if embedded_tags:
        if normalized_artist_key(source_tags) != normalized_artist_key(embedded_tags):
            source_compact = re.sub(r"\s+", "", clean_text(source_tags).casefold())
            embedded_compact = re.sub(r"\s+", "", clean_text(embedded_tags).casefold())
            if embedded_compact.endswith(source_compact):
                return source_tags, "embedded_prompt_suffix_equivalent"
            raise RuntimeError(
                f"无冕出现未登记的 PDF 标签/原图 prompt 冲突: {pattern_name}: "
                f"label={source_tags!r}, prompt={embedded_tags!r}"
            )
        if clean_text(source_tags) != clean_text(embedded_tags):
            return source_tags, "normalized_equivalent"
        return source_tags, "matched"
    return source_tags, "metadata_missing"


def image_info_from_bytes(raw: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(raw)) as image:
        image.verify()
    with Image.open(io.BytesIO(raw)) as image:
        return image.size


def paragraph_texts(cell: ET.Element) -> list[str]:
    values: list[str] = []
    for paragraph in cell.findall(f".//{W}p"):
        text = clean_text("".join(node.text or "" for node in paragraph.findall(f".//{W}t")))
        if text:
            values.append(text)
    return values


def word_rows(path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    with zipfile.ZipFile(path) as archive:
        doc = ET.fromstring(archive.read("word/document.xml"))
        rels = ET.fromstring(archive.read("word/_rels/document.xml.rels"))
        rel_map = {
            rel.attrib["Id"]: rel.attrib["Target"]
            for rel in rels.findall(f"{PR}Relationship")
        }
        rows = doc.findall(f".//{W}tbl/{W}tr")
        media = [name for name in archive.namelist() if name.startswith("word/media/")]
        for row_number, row in enumerate(rows, 1):
            cells = row.findall(f"{W}tc")
            if len(cells) < 2:
                continue
            labels = paragraph_texts(cells[0])
            if not labels:
                labels = paragraph_texts(cells[1])
            rel_ids = [
                node.attrib.get(f"{R}embed", "")
                for node in row.findall(f".//{A}blip")
                if node.attrib.get(f"{R}embed")
            ]
            members = ["word/" + rel_map[rel_id].lstrip("/") for rel_id in rel_ids if rel_id in rel_map]
            if not labels or not members:
                continue
            if len(members) != 1:
                raise RuntimeError(f"九七 DOCX row {row_number} has {len(members)} images")
            member = members[0]
            raw = archive.read(member)
            width, height = image_info_from_bytes(raw)
            meta = extract_png_metadata_from_bytes(raw, member) if member.lower().endswith(".png") else None
            source_label = labels[0]
            tags = first_style_tag(meta.prompt if meta else "", source_label)
            entry: dict[str, Any] = {
                "section": "九七",
                "sourceKind": "docx",
                "containerPath": str(path),
                "memberName": member,
                "sourceLabel": source_label,
                "sourceRow": row_number,
                "extension": normalized_suffix(member),
                "sha256": sha256_bytes(raw),
                "sourceWidth": width,
                "sourceHeight": height,
                "sourceBytes": len(raw),
                "title": artist_title(tags),
                "tags": tags,
                "negative": "",
                "characterPrompts": [],
                "note": metadata_note(meta) if meta else "来源：九七 · Word 内嵌原图",
                "sourceModel": clean_text(meta.fields.get("Source")) if meta else "",
                "accepted": True,
                "reason": "accepted",
            }
            if len(labels) > 1:
                entry["sourceAnnotation"] = " / ".join(labels[1:])
            entries.append(entry)

    if len(rows) != 440 or len(media) != 439 or len(entries) != 437:
        raise RuntimeError(
            f"九七 DOCX structure changed: rows={len(rows)}, media={len(media)}, mapped={len(entries)}"
        )
    report = {
        "container": str(path),
        "containerSha256": sha256_file(path),
        "tableRows": len(rows),
        "embeddedImages": len(media),
        "mappedArtistEntries": len(entries),
        "displayAssetPolicy": "原 PNG 已是 399–601px 缩略图；展示图保留源字节，不缩放、不转码",
        "dimensions": {
            "minLongestEdge": min(max(row["sourceWidth"], row["sourceHeight"]) for row in entries),
            "medianLongestEdge": statistics.median(max(row["sourceWidth"], row["sourceHeight"]) for row in entries),
            "maxLongestEdge": max(max(row["sourceWidth"], row["sourceHeight"]) for row in entries),
            "over1100": sum(max(row["sourceWidth"], row["sourceHeight"]) > 1100 for row in entries),
        },
        "sourceBytes": {
            "total": sum(row["sourceBytes"] for row in entries),
            "min": min(row["sourceBytes"] for row in entries),
            "median": int(statistics.median(row["sourceBytes"] for row in entries)),
            "max": max(row["sourceBytes"] for row in entries),
        },
        "excluded": [
            {"row": 2, "reason": "无提示词空跑基准图"},
            {"row": 440, "reason": "无文字标签的末尾图"},
        ],
    }
    return entries, report


def combine_point(cm: list[float], tm: list[float]) -> tuple[float, float]:
    x = cm[0] * tm[4] + cm[2] * tm[5] + cm[4]
    y = cm[1] * tm[4] + cm[3] * tm[5] + cm[5]
    return x, y


def normalize_pdf_artist_label(value: str) -> str:
    text = clean_text(value.replace("\x01", "_"))
    match = re.search(r"artist\s*:\s*([^,]+)", text, flags=re.IGNORECASE)
    if not match:
        return ""
    name = re.sub(r"\s+", "", match.group(1))
    name = re.sub(r"_+", "_", name).strip("_,")
    return f"artist:{name}" if name else ""


def pdf_labels(page: Any) -> list[dict[str, Any]]:
    labels: list[dict[str, Any]] = []
    page_height = float(page.mediabox.height)

    def visitor(text: str, cm: list[float], tm: list[float], _font: Any, font_size: float) -> None:
        if not 47 <= float(font_size) <= 49:
            return
        tags = normalize_pdf_artist_label(text or "")
        if not tags:
            return
        x, y = combine_point([float(value) for value in cm], [float(value) for value in tm])
        labels.append({"tags": tags, "x": x, "y": page_height - y})

    page.extract_text(visitor_text=visitor)
    return labels


def pdf_pattern_rects(page: Any) -> list[dict[str, Any]]:
    stream = ContentStream(page.get_contents(), page.pdf)
    translation = (0.0, 0.0)
    current_pattern = ""
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for operands, operator in stream.operations:
        if operator == b"cm" and len(operands) == 6:
            values = [float(value) for value in operands]
            if values[:4] == [1.0, 0.0, 0.0, 1.0]:
                translation = (values[4], values[5])
        elif operator in {b"SCN", b"scn"} and operands:
            candidate = str(operands[-1])
            if candidate.startswith("/P"):
                current_pattern = candidate
        elif operator == b"re" and current_pattern and current_pattern not in seen:
            x, y, width, height = [float(value) for value in operands]
            rows.append({
                "patternName": current_pattern,
                "x": x + translation[0],
                "y": y + translation[1],
                "width": width,
                "height": height,
            })
            seen.add(current_pattern)
    return rows


def match_pdf_labels(labels: list[dict[str, Any]], rects: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, float]]:
    if len(labels) != 300 or len(rects) != 300:
        raise RuntimeError(f"无冕 PDF mapping cardinality changed: labels={len(labels)}, images={len(rects)}")
    unmatched = list(rects)
    matches: list[dict[str, Any]] = []
    dx_values: list[float] = []
    dy_values: list[float] = []
    for label in labels:
        rect = min(
            unmatched,
            key=lambda item: abs(item["x"] - label["x"]) + abs(item["y"] - label["y"]),
        )
        dx = abs(rect["x"] - label["x"])
        dy = abs(rect["y"] - label["y"])
        if dx > 180 or dy > 120:
            raise RuntimeError(f"无冕 PDF label/image coordinate mismatch: {label} vs {rect}")
        unmatched.remove(rect)
        dx_values.append(dx)
        dy_values.append(dy)
        matches.append({
            **rect,
            "tags": label["tags"],
            "labelX": label["x"],
            "labelY": label["y"],
            "matchDx": dx,
            "matchDy": dy,
        })
    matches.sort(key=lambda item: (round(item["y"], 1), round(item["x"], 1)))
    return matches, {
        "maxDx": max(dx_values, default=0.0),
        "maxDy": max(dy_values, default=0.0),
        "meanDx": sum(dx_values) / len(dx_values),
        "meanDy": sum(dy_values) / len(dy_values),
    }


def pattern_image(pattern: Any) -> tuple[str, bytes, int, int]:
    resources = pattern.get("/Resources") or {}
    xobjects = (resources.get("/XObject") or {}).get_object()
    if len(xobjects) != 1:
        raise RuntimeError(f"PDF image pattern has {len(xobjects)} XObjects")
    xobject = next(iter(xobjects.values())).get_object()
    extension, byte_stream, image = _xobj_to_image(xobject)
    try:
        width, height = image.size
    finally:
        image.close()
    suffix = normalized_suffix(extension)
    return suffix, byte_stream, width, height


def pdf_rows(path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    reader = PdfReader(path)
    if len(reader.pages) != 1:
        raise RuntimeError(f"无冕 PDF page count changed: {len(reader.pages)}")
    page = reader.pages[0]
    labels = pdf_labels(page)
    rects = pdf_pattern_rects(page)
    matches, distances = match_pdf_labels(labels, rects)
    patterns = (page.get("/Resources").get("/Pattern") or {}).get_object()
    entries: list[dict[str, Any]] = []
    tag_conflicts: list[str] = []
    with tempfile.TemporaryDirectory(prefix="nai5-wumian-metadata-") as metadata_temp:
        metadata_root = Path(metadata_temp)
        for match in matches:
            pattern_name = match["patternName"]
            pattern = patterns[pattern_name].get_object()
            suffix, raw, width, height = pattern_image(pattern)
            meta = None
            if suffix == ".png":
                metadata_path = metadata_root / f"{pattern_name.lstrip('/')}.png"
                metadata_path.write_bytes(raw)
                try:
                    meta = extract_image_metadata(metadata_path)
                finally:
                    metadata_path.unlink(missing_ok=True)
            embedded_tags = first_style_tag(meta.prompt, "") if meta else ""
            try:
                tags, tag_decision = resolve_wumian_source_tag(pattern_name, match["tags"], embedded_tags)
            except RuntimeError as exc:
                tags, tag_decision = match["tags"], "unreviewed_conflict"
                tag_conflicts.append(str(exc))
            entries.append({
                "section": "无冕",
                "sourceKind": "pdf",
                "containerPath": str(path),
                "patternName": pattern_name,
                "extension": suffix,
                "sha256": sha256_bytes(raw),
                "sourceWidth": width,
                "sourceHeight": height,
                "title": artist_title(tags),
                "tags": tags,
                "sourceLabelTags": match["tags"],
                "embeddedPromptTags": embedded_tags,
                "tagDecision": tag_decision,
                "negative": "",
                "characterPrompts": [],
                "note": "来源：无冕 · PDF 内嵌原图",
                "sourceModel": "NovelAI 5（来源画板）",
                "accepted": True,
                "reason": "accepted",
                "sourceX": round(match["x"], 3),
                "sourceY": round(match["y"], 3),
            })
    if tag_conflicts:
        raise RuntimeError(
            f"无冕 PDF 有 {len(tag_conflicts)} 个未决标签冲突:\n" + "\n".join(tag_conflicts)
        )
    report = {
        "container": str(path),
        "containerSha256": sha256_file(path),
        "pages": 1,
        "pageWidth": float(page.mediabox.width),
        "pageHeight": float(page.mediabox.height),
        "artistLabels": len(labels),
        "embeddedImagePatterns": len(patterns),
        "mappedArtistEntries": len(entries),
        "embeddedPromptTagRows": sum(bool(row["embeddedPromptTags"]) for row in entries),
        "tagDecisions": dict(Counter(row["tagDecision"] for row in entries)),
        "tagCorrections": [
            {
                "pattern": row["patternName"],
                "sourceLabel": row["sourceLabelTags"],
                "embeddedPrompt": row["embeddedPromptTags"],
                "correctedTags": row["tags"],
                "reason": WUMIAN_SOURCE_TAG_CORRECTIONS[row["patternName"]]["reason"],
            }
            for row in entries
            if row["tagDecision"] == "embedded_prompt_correction"
        ],
        "coordinateMatch": {key: round(value, 3) for key, value in distances.items()},
    }
    return entries, report


def direct_tasks(sources: dict[str, Path]) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    source_index = 0
    for section, directory in ((CHENGCHUANJI, sources["suozhang"]), ("梦神", sources["mengshen"])):
        files = sorted(
            (path for path in directory.rglob("*") if path.is_file() and path.suffix.lower() in IMAGE_EXTS),
            key=lambda path: path.relative_to(directory).as_posix().casefold(),
        )
        expected = 87 if section == CHENGCHUANJI else 95
        if len(files) != expected:
            raise RuntimeError(f"{section} source count changed: expected={expected}, actual={len(files)}")
        for path in files:
            source_index += 1
            tasks.append({
                "sourceIndex": source_index,
                "section": section,
                "sourceRoot": str(directory),
                "sourcePath": str(path),
                "relativePath": path.relative_to(directory).as_posix(),
            })
    return tasks


def direct_rows(sources: dict[str, Path], workers: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    scanned = run_parallel("N5 direct metadata", inspect_image_task, direct_tasks(sources), workers)
    rows: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    section_positions = Counter()
    for row in scanned:
        section = row["section"]
        family = model_family(row.get("sourceModel") or row.get("sourceType"))
        reason = "accepted"
        if row.get("error"):
            reason = row["error"]
        elif not row.get("prompt"):
            reason = "no_prompt"
        elif family != "nai5":
            reason = f"not_nai5:{family}"
        if reason != "accepted":
            rejected.append({**row, "accepted": False, "reason": reason})
            continue
        section_positions[section] += 1
        if section == CHENGCHUANJI:
            source_title = Path(row["sourcePath"]).stem
            tags = first_style_tag(row["prompt"], source_title)
            title = source_title
        else:
            tags = row["prompt"]
            title = f"梦神 N5画风 {section_positions[section]:03d}"
        rows.append({
            **row,
            "sourceKind": "file",
            "extension": normalized_suffix(row["sourcePath"]),
            "title": title,
            "tags": tags,
            "accepted": True,
            "reason": "accepted",
        })
    expected = {CHENGCHUANJI: 87, "梦神": 95}
    accepted_counts = Counter(row["section"] for row in rows)
    if dict(accepted_counts) != expected:
        raise RuntimeError(
            f"direct N5 gate changed: accepted={dict(accepted_counts)}, rejected={Counter(row['reason'] for row in rejected)}"
        )
    report = {
        "input": len(scanned),
        "accepted": len(rows),
        "acceptedBySection": dict(accepted_counts),
        "rejected": len(rejected),
        "rejectedReasons": dict(Counter(row["reason"] for row in rejected)),
        "models": dict(Counter(row.get("sourceModel") or row.get("sourceType") for row in scanned)),
    }
    return rows, report


def assign_entry_fields(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows.sort(key=lambda row: (SECTION_ORDER[row["section"]], row.get("sourceRow", 0), row.get("sourceY", 0), row.get("sourceX", 0), row.get("relativePath", "").casefold()))
    positions = Counter()
    for row in rows:
        section = row["section"]
        positions[section] += 1
        config = SECTION_CONFIG[section]
        row["entryId"] = f"{CODEX_ID}_{config['idPrefix']}_{positions[section]:04d}"
        row["path"] = list(config["path"])
        row["rating"] = config["rating"]
        correction = WUMIAN_SOURCE_TAG_CORRECTIONS.get(row.get("patternName", ""))
        if correction and row["entryId"] != correction["entryId"]:
            raise RuntimeError(
                f"无冕校正项的稳定 ID 变化: {row.get('patternName')}: "
                f"{row['entryId']} != {correction['entryId']}"
            )
    return rows


def audit_sources(raw_root: Path, workers: int) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Path]]:
    sources = discover_sources(raw_root)
    word, word_report = word_rows(sources["word"])
    pdf, pdf_report = pdf_rows(sources["pdf"])
    direct, direct_report = direct_rows(sources, workers)
    rows = assign_entry_fields([*word, *pdf, *direct])
    expected = {"九七": 437, "无冕": 300, CHENGCHUANJI: 87, "梦神": 95}
    section_counts = Counter(row["section"] for row in rows)
    if dict(section_counts) != expected or len(rows) != 919:
        raise RuntimeError(f"dictionary source gate changed: {dict(section_counts)}")
    hashes = Counter(row["sha256"] for row in rows)
    duplicate_hashes = [digest for digest, count in hashes.items() if count > 1]
    report = {
        "codexId": CODEX_ID,
        "title": TITLE,
        "auditDate": date.today().isoformat(),
        "sourceRoot": str(raw_root),
        "entryCount": len(rows),
        "sections": dict(section_counts),
        "topLevelDirectories": ["单画师词典", "画师串词典"],
        "pathDepth": 3,
        "attributionRules": [
            {"filenameContains": "1984", "creditedAuthor": CHENGCHUANJI},
            {"filenameContains": "密码梦神", "creditedAuthor": "梦神"},
        ],
        "excludedSource": {
            "name": EXCLUDED_SOURCE_NAME,
            "reason": "用户明确要求暂时排除",
            "opened": False,
        },
        "documents": {"九七": word_report, "无冕": pdf_report},
        "directImages": direct_report,
        "exactDuplicateHashGroups": len(duplicate_hashes),
        "exactDuplicateHashes": duplicate_hashes,
    }
    return rows, report, sources


def manifest_row(row: dict[str, Any], raw_root: Path) -> dict[str, Any]:
    source_path = Path(row.get("sourcePath") or row.get("containerPath") or "")
    try:
        source_display = source_path.resolve().relative_to(raw_root.resolve()).as_posix()
    except (OSError, ValueError):
        source_display = str(source_path)
    return {
        "entryId": row["entryId"],
        "section": row["section"],
        "author": row["section"],
        "path": row["path"],
        "sourceKind": row["sourceKind"],
        "source": source_display,
        "member": row.get("memberName", ""),
        "pattern": row.get("patternName", ""),
        "sourceLabelTags": row.get("sourceLabelTags", ""),
        "embeddedPromptTags": row.get("embeddedPromptTags", ""),
        "finalTags": row.get("tags", ""),
        "tagDecision": row.get("tagDecision", ""),
        "sha256": row["sha256"],
        "model": row.get("sourceModel", ""),
        "decision": row.get("reason", "accepted"),
    }


def write_audit(rows: list[dict[str, Any]], report: dict[str, Any], raw_root: Path) -> dict[str, Any]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = [manifest_row(row, raw_root) for row in rows]
    manifest_path = OUTPUT_DIR / "source_manifest.json"
    report_path = OUTPUT_DIR / "report.json"
    csv_path = OUTPUT_DIR / "entries.csv"
    write_json(manifest_path, manifest)
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=[
            "entryId", "section", "title", "tags", "path", "sourceKind", "sha256",
        ])
        writer.writeheader()
        for row in rows:
            writer.writerow({
                "entryId": row["entryId"],
                "section": row["section"],
                "title": row["title"],
                "tags": row["tags"],
                "path": " / ".join(row["path"]),
                "sourceKind": row["sourceKind"],
                "sha256": row["sha256"],
            })
    report = {
        **report,
        "files": {
            "report": str(report_path),
            "manifest": str(manifest_path),
            "entries": str(csv_path),
        },
    }
    write_json(report_path, report)
    return report


def stage_embedded_sources(rows: list[dict[str, Any]], stage: Path, sources: dict[str, Path]) -> None:
    word_rows_by_member = {row["memberName"]: row for row in rows if row["sourceKind"] == "docx"}
    with zipfile.ZipFile(sources["word"]) as archive:
        for member, row in word_rows_by_member.items():
            raw = archive.read(member)
            if sha256_bytes(raw) != row["sha256"]:
                raise RuntimeError(f"DOCX embedded image hash changed: {member}")
            destination = stage / f"{row['entryId']}{row['extension']}"
            destination.write_bytes(raw)
            row["stagedSourcePath"] = str(destination)

    pdf_rows_only = [row for row in rows if row["sourceKind"] == "pdf"]
    reader = PdfReader(sources["pdf"])
    patterns = (reader.pages[0].get("/Resources").get("/Pattern") or {}).get_object()
    for row in pdf_rows_only:
        suffix, raw, _width, _height = pattern_image(patterns[row["patternName"]].get_object())
        if suffix != row["extension"] or sha256_bytes(raw) != row["sha256"]:
            raise RuntimeError(f"PDF embedded image changed: {row['patternName']}")
        destination = stage / f"{row['entryId']}{suffix}"
        destination.write_bytes(raw)
        row["stagedSourcePath"] = str(destination)


def codex_payload(rows: list[dict[str, Any]], assets: dict[str, dict[str, Any]]) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    for row in rows:
        entry = {
            "title": row["title"],
            "path": row["path"],
            "tags": row["tags"],
            **({"negative": row["negative"]} if clean_text(row.get("negative")) else {}),
            **({"characterPrompts": row["characterPrompts"]} if row.get("characterPrompts") else {}),
            **({"note": row["note"]} if clean_text(row.get("note")) else {}),
            "rating": row["rating"],
            "isNew": False,
            "id": row["entryId"],
            **{key: value for key, value in assets[row["entryId"]].items() if key != "entryId"},
        }
        entries.append(entry)
    first = entries[0]
    return {
        "id": CODEX_ID,
        "type": "string",
        "title": TITLE,
        "version": VERSION,
        "author": AUTHOR,
        "entryCount": len(entries),
        "imagedCount": len(entries),
        "hasOriginal": True,
        "source": f"九七 · 5F单artist画风炼度参考 / 无冕 · N5单画师300筛选 / {CHENGCHUANJI} · N5F单画师测试 / 梦神 · N5暂时可用画风",
        "contributors": [
            {"name": "九七", "role": "5F单artist画风炼度参考 · 词条整理 / 配图数据提供"},
            {"name": "无冕", "role": "N5单画师300筛选 · 词条整理 / 配图数据提供"},
            {"name": CHENGCHUANJI, "role": "N5F单画师测试 · 词条整理 / 配图数据提供"},
            {"name": "梦神", "role": "N5暂时可用画风 · 词条整理 / 配图数据提供"},
        ],
        "links": [],
        "cover": first["image"],
        "coverRev": first["assetRev"],
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
        (position + 1 for position, item in enumerate(index) if item.get("id") == "artist_nai45_strings"),
        len(index),
    )
    index.insert(insert_at, index_meta(codex))
    return index


def validate_payload(codex: dict[str, Any], thumb_dir: Path, original_dir: Path) -> dict[str, Any]:
    entries = codex.get("entries") or []
    issues: list[str] = []
    if "nsfw" in codex:
        issues.append("unexpected_codex_nsfw")
    if codex.get("entryCount") != 919 or codex.get("imagedCount") != 919 or len(entries) != 919:
        issues.append("entry_counts")
    ids = [entry.get("id") for entry in entries]
    if len(ids) != len(set(ids)):
        issues.append("duplicate_ids")
    expected_ratings = {tuple(config["path"]): config["rating"] for config in SECTION_CONFIG.values()}
    expected_paths = set(expected_ratings)
    entries_by_id = {entry.get("id"): entry for entry in entries}
    for entry in entries:
        if tuple(entry.get("path") or ()) not in expected_paths:
            issues.append(f"bad_path:{entry.get('id')}")
        elif entry.get("rating") != expected_ratings[tuple(entry.get("path") or ())]:
            issues.append(f"bad_rating:{entry.get('id')}")
        if len(entry.get("path") or []) != 3:
            issues.append(f"bad_path_depth:{entry.get('id')}")
        if not clean_text(entry.get("tags")):
            issues.append(f"empty_tags:{entry.get('id')}")
        issues.extend(validate_asset(entry, thumb_dir, original_dir))
    for correction in WUMIAN_SOURCE_TAG_CORRECTIONS.values():
        entry = entries_by_id.get(correction["entryId"])
        expected_tags = correction["correctedTags"]
        if not entry or entry.get("tags") != expected_tags or entry.get("title") != artist_title(expected_tags):
            issues.append(f"source_tag_correction:{correction['entryId']}")
    expected_tree = build_tree(entries)
    if codex.get("tree") != expected_tree:
        issues.append("tree_mismatch")
    public_meta = json.dumps({key: codex.get(key) for key in ("author", "source", "contributors", "tree")}, ensure_ascii=False)
    if "1984" in public_meta:
        issues.append("fake_1984_author_leaked")
    if LEGACY_SUOZHANG_SOURCE_MARKER in public_meta:
        issues.append("legacy_suozhang_credit_leaked")
    if EXCLUDED_SOURCE_NAME in json.dumps(codex, ensure_ascii=False):
        issues.append("excluded_source_leaked")
    if issues:
        raise RuntimeError("\n".join(issues[:100]))
    return {
        "codexId": CODEX_ID,
        "entries": len(entries),
        "uniqueIds": len(set(ids)),
        "pathDepth": 3,
        "missingAssets": 0,
        "badPaths": 0,
        "sourceTagCorrections": len(WUMIAN_SOURCE_TAG_CORRECTIONS),
    }


def apply_import(rows: list[dict[str, Any]], sources: dict[str, Path], workers: int) -> dict[str, Any]:
    data_path = DATA_DIR / f"{CODEX_ID}.json"
    final_thumbs = IMAGE_ROOT / CODEX_ID
    final_originals = ORIGINAL_ROOT / CODEX_ID
    if data_path.exists() or final_thumbs.exists() or final_originals.exists():
        raise RuntimeError(f"target already exists for {CODEX_ID}; refusing to overwrite")

    IMAGE_ROOT.mkdir(parents=True, exist_ok=True)
    ORIGINAL_ROOT.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    thumb_stage = make_staging_directory(IMAGE_ROOT, f".{CODEX_ID}-")
    original_stage = make_staging_directory(ORIGINAL_ROOT, f".{CODEX_ID}-")
    embedded_stage = Path(tempfile.mkdtemp(prefix=".embedded-", dir=OUTPUT_DIR))
    data_temp = DATA_DIR / f".{CODEX_ID}.json.tmp"
    index_temp = DATA_DIR / ".codexes.json.nai5.tmp"
    finalized = False
    try:
        stage_embedded_sources(rows, embedded_stage, sources)
        tasks = []
        for row in rows:
            source_path = row.get("stagedSourcePath") if row["sourceKind"] in {"docx", "pdf"} else row["sourcePath"]
            tasks.append({
                "sourcePath": source_path,
                "entryId": row["entryId"],
                "sha256": row["sha256"],
                "thumbDir": str(thumb_stage),
                "originalDir": str(original_stage),
                "preserveDisplay": row["section"] == "九七",
            })
        assets = run_parallel("N5 dictionary assets", write_asset_from_path, tasks, workers)
        assets_by_id = {asset["entryId"]: asset for asset in assets}
        codex = codex_payload(rows, assets_by_id)
        validation = validate_payload(codex, thumb_stage, original_stage)
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
            "thumbs": len(list(final_thumbs.iterdir())),
            "originals": len(list(final_originals.iterdir())),
        }
    finally:
        shutil.rmtree(embedded_stage, ignore_errors=True)
        if not finalized:
            shutil.rmtree(thumb_stage, ignore_errors=True)
            shutil.rmtree(original_stage, ignore_errors=True)
            data_temp.unlink(missing_ok=True)
            index_temp.unlink(missing_ok=True)


def embedded_artist_tag_from_original(path: Path) -> str:
    if not path.is_file():
        raise RuntimeError(f"original missing for source tag correction: {path}")
    if path.suffix.lower() != ".png":
        raise RuntimeError(f"source tag correction expects PNG original: {path}")
    meta = extract_image_metadata(path)
    if not meta or not clean_text(meta.prompt):
        raise RuntimeError(f"original prompt missing for source tag correction: {path}")
    return first_style_tag(meta.prompt, "")


def sync_existing_source_tag_corrections(apply: bool = False) -> dict[str, Any]:
    data_path = DATA_DIR / f"{CODEX_ID}.json"
    if not data_path.is_file():
        raise RuntimeError(f"codex data missing: {data_path}")
    codex = json.loads(data_path.read_text(encoding="utf-8"))
    entries_by_id = {entry.get("id"): entry for entry in codex.get("entries") or []}
    records: list[dict[str, Any]] = []
    pending = 0

    for pattern_name, correction in WUMIAN_SOURCE_TAG_CORRECTIONS.items():
        entry_id = correction["entryId"]
        entry = entries_by_id.get(entry_id)
        if not entry:
            raise RuntimeError(f"source tag correction entry missing: {entry_id}")
        original_path = ORIGINAL_ROOT / CODEX_ID / str(entry.get("original") or "")
        embedded_tags = embedded_artist_tag_from_original(original_path)
        expected_tags = correction["correctedTags"]
        expected_title = artist_title(expected_tags)
        if normalized_artist_key(embedded_tags) != normalized_artist_key(expected_tags):
            raise RuntimeError(
                f"source tag correction evidence changed: {entry_id}: "
                f"{embedded_tags!r} != {expected_tags!r}"
            )

        current_tags = clean_text(entry.get("tags"))
        current_title = clean_text(entry.get("title"))
        allowed_tags = {correction["sourceLabel"], expected_tags}
        allowed_titles = {artist_title(correction["sourceLabel"]), expected_title}
        if current_tags not in allowed_tags or current_title not in allowed_titles:
            raise RuntimeError(
                f"source tag correction refuses unexpected current value: {entry_id}: "
                f"title={current_title!r}, tags={current_tags!r}"
            )

        needs_change = current_tags != expected_tags or current_title != expected_title
        pending += int(needs_change)
        records.append({
            "entryId": entry_id,
            "pattern": pattern_name,
            "original": str(original_path),
            "embeddedPromptTags": embedded_tags,
            "oldTitle": current_title,
            "newTitle": expected_title,
            "oldTags": current_tags,
            "newTags": expected_tags,
            "reason": correction["reason"],
            "pending": needs_change,
        })
        if needs_change:
            entry["title"] = expected_title
            entry["tags"] = expected_tags

    backup_path = OUTPUT_DIR / f"{CODEX_ID}-pre-tag-corrections-{date.today().isoformat()}.json"
    if apply and pending:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        if backup_path.exists():
            raise RuntimeError(f"source tag correction backup already exists: {backup_path}")
        write_json(backup_path, json.loads(data_path.read_text(encoding="utf-8")), compact=True)
        temp_path = DATA_DIR / f".{CODEX_ID}.tag-corrections.tmp"
        try:
            write_json(temp_path, codex, compact=True)
            temp_path.replace(data_path)
        finally:
            temp_path.unlink(missing_ok=True)

    result = {
        "codexId": CODEX_ID,
        "mode": "existing-source-tag-corrections",
        "applied": bool(apply and pending),
        "pendingBefore": pending,
        "remainingAfter": 0 if apply else pending,
        "validatedOriginalPrompts": len(records),
        "backup": str(backup_path) if apply and pending else "",
        "entries": records,
    }
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    report_name = "tag-corrections-applied.json" if apply else "tag-corrections-plan.json"
    write_json(OUTPUT_DIR / report_name, result)
    return result


def validate_import() -> dict[str, Any]:
    data_path = DATA_DIR / f"{CODEX_ID}.json"
    codex = json.loads(data_path.read_text(encoding="utf-8"))
    index = json.loads((DATA_DIR / "codexes.json").read_text(encoding="utf-8"))
    meta = next((item for item in index if item.get("id") == CODEX_ID), None)
    if not meta:
        raise RuntimeError(f"codex index missing {CODEX_ID}")
    if "nsfw" in codex or "nsfw" in meta:
        raise RuntimeError("partial-NSFW codex must not use root nsfw")
    result = validate_payload(codex, IMAGE_ROOT / CODEX_ID, ORIGINAL_ROOT / CODEX_ID)
    for key in ("title", "version", "author", "entryCount", "imagedCount", "nsfw"):
        if meta.get(key) != codex.get(key):
            raise RuntimeError(f"index metadata mismatch: {key}")
    manifest = json.loads((OUTPUT_DIR / "source_manifest.json").read_text(encoding="utf-8"))
    hashes = {row["entryId"]: row["sha256"] for row in manifest}
    preserved_display_mismatches = 0
    for entry in codex["entries"]:
        original = ORIGINAL_ROOT / CODEX_ID / entry["original"]
        if sha256_file(original) != hashes.get(entry["id"]):
            raise RuntimeError(f"source/original hash mismatch: {entry['id']}")
        if str(entry["id"]).startswith(f"{CODEX_ID}_jiuqi_"):
            display = IMAGE_ROOT / CODEX_ID / entry["image"]
            if display.suffix.lower() != ".png" or sha256_file(display) != hashes.get(entry["id"]):
                preserved_display_mismatches += 1
    if preserved_display_mismatches:
        raise RuntimeError(f"九七 preserved display hash mismatches: {preserved_display_mismatches}")
    validated_correction_originals = 0
    entries_by_id = {entry["id"]: entry for entry in codex["entries"]}
    for correction in WUMIAN_SOURCE_TAG_CORRECTIONS.values():
        entry = entries_by_id[correction["entryId"]]
        original = ORIGINAL_ROOT / CODEX_ID / entry["original"]
        embedded_tags = embedded_artist_tag_from_original(original)
        if normalized_artist_key(embedded_tags) != normalized_artist_key(correction["correctedTags"]):
            raise RuntimeError(f"corrected original prompt mismatch: {entry['id']}")
        validated_correction_originals += 1
    return {
        **result,
        "sourceHashMismatches": 0,
        "preservedDisplayHashMismatches": 0,
        "indexMetadataMismatches": 0,
        "validatedCorrectionOriginals": validated_correction_originals,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=RAW_ROOT)
    parser.add_argument("--apply", action="store_true")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--validate", action="store_true")
    mode.add_argument("--correct-existing", action="store_true")
    parser.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1))
    args = parser.parse_args()
    if args.workers < 1:
        raise SystemExit("--workers must be at least 1")
    if args.validate:
        if args.apply:
            raise SystemExit("--validate cannot be combined with --apply")
        print(json.dumps(validate_import(), ensure_ascii=False, indent=2))
        return 0
    if args.correct_existing:
        print(json.dumps(sync_existing_source_tag_corrections(apply=args.apply), ensure_ascii=False, indent=2))
        return 0
    source = args.source.resolve()
    if not source.is_dir():
        raise SystemExit(f"source folder not found: {source}")
    rows, report, sources = audit_sources(source, args.workers)
    report = write_audit(rows, report, source)
    output: dict[str, Any] = {"audit": report}
    if args.apply:
        output["import"] = apply_import(rows, sources, args.workers)
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
