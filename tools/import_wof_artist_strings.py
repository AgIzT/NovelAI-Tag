"""Import PieDriver's W.O.F NovelAI 4.5 artist-string image pack.

The source contains PNGs named from truncated prompts. The complete reusable
artist string is recovered from NovelAI's PNG Description metadata. Images
with the same Description become a single multi-image entry.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import tempfile
from collections import OrderedDict
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "site" / "data"
IMAGE_ROOT = ROOT / "site" / "images"
ORIGINAL_ROOT = ROOT / "originals"
OUTPUT_DIR = ROOT / "output"
MAX_DIM = 1100

# 2026-08-31 两本 v4.5 合并成一册后，这个脚本身上有了两个身份，别混用：
#   book_id  ＝ 数据落点（合并册 artist_nai45_personal.json 与它的索引行）
#   codex_id ＝ W.O.F 的系列身份：词条 id 前缀、images/ 与 originals/ 目录、assetCodexId
# 合并时图一张没搬，所以系列身份仍是 artist_nai45_strings。
# W.O.F 分区也从顶层降到了「画师串词典」下面一层——认分区一律走 WOF_PATH，别再写字面量。
# 见 docs/decisions/法典重归类.md。
DEFAULT_BOOK_ID = "artist_nai45_personal"
DEFAULT_SERIES_ID = "artist_nai45_strings"
WOF_TOP = "画师串词典"
WOF_SECTION = "W.O.F_画风"
WOF_PATH = [WOF_TOP, WOF_SECTION]

sys.path.insert(0, str(ROOT / "tools"))
from sd_metadata_inspector import extract_image_metadata  # noqa: E402


def clean_text(value: object) -> str:
    return " ".join(str(value or "").replace("\r", "\n").split())


def style_prompt(meta) -> str:
    prompt = clean_text(meta.fields.get("Description"))
    if prompt:
        return prompt
    comment_json = meta.fields.get("CommentJson")
    if isinstance(comment_json, dict):
        v4_prompt = comment_json.get("v4_prompt")
        if isinstance(v4_prompt, dict):
            caption = v4_prompt.get("caption")
            if isinstance(caption, dict):
                return clean_text(caption.get("base_caption"))
    return ""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def png_visual_hash(path: Path) -> str:
    """Hash PNG chunks that affect rendering while ignoring textual prompt metadata."""
    digest = hashlib.sha256()
    visual_chunks = {b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"cHRM", b"gAMA", b"iCCP", b"sRGB"}
    with path.open("rb") as handle:
        signature = handle.read(8)
        if signature != b"\x89PNG\r\n\x1a\n":
            raise RuntimeError(f"not a PNG file: {path}")
        while True:
            raw_length = handle.read(4)
            if len(raw_length) != 4:
                raise RuntimeError(f"truncated PNG: {path}")
            length = int.from_bytes(raw_length, "big")
            chunk_type = handle.read(4)
            chunk_data = handle.read(length)
            crc = handle.read(4)
            if len(chunk_type) != 4 or len(chunk_data) != length or len(crc) != 4:
                raise RuntimeError(f"truncated PNG chunk: {path}")
            if chunk_type in visual_chunks:
                digest.update(chunk_type)
                digest.update(chunk_data)
            if chunk_type == b"IEND":
                break
    return digest.hexdigest()


def asset_rev(paths: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in paths:
        digest.update(sha256_file(path).encode("ascii"))
    return digest.hexdigest()[:16]


def scan_source(source: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    files = sorted(source.glob("*.png"), key=lambda path: path.name.casefold())
    if not files:
        raise RuntimeError(f"no PNG files found in {source}")

    groups: OrderedDict[str, list[dict[str, Any]]] = OrderedDict()
    missing_prompt: list[str] = []
    all_prompts: set[str] = set()
    seen_hashes: dict[str, str] = {}
    duplicate_hashes: list[dict[str, str]] = []

    for path in files:
        meta = extract_image_metadata(path)
        prompt = style_prompt(meta)
        if not prompt:
            missing_prompt.append(path.name)
            continue
        all_prompts.add(prompt)
        full_prompt = clean_text(meta.prompt)
        digest = sha256_file(path)
        visual_digest = png_visual_hash(path)
        if digest in seen_hashes:
            duplicate_hashes.append({"sha256": digest, "first": seen_hashes[digest], "duplicate": path.name})
            continue
        seen_hashes[digest] = path.name

        groups.setdefault(prompt, []).append({
            "source": path,
            "fullPrompt": full_prompt,
            "sha256": digest,
            "visualSha256": visual_digest,
        })

    groups = OrderedDict((prompt, images) for prompt, images in groups.items() if images)
    report = {
        "source": str(source),
        "sourceFiles": len(files),
        "uniqueStylePrompts": len(all_prompts),
        "importedEntries": len(groups),
        "importedImages": sum(len(images) for images in groups.values()),
        "missingPromptImages": len(missing_prompt),
        "missingPromptFiles": missing_prompt,
        "duplicateImages": len(duplicate_hashes),
        "duplicateDetails": duplicate_hashes,
        "contentReview": "沿用站内既有 W.O.F 分级与作者信息；本工具只校验数据和资源，不替代人工视觉分级。",
    }
    return [{"prompt": prompt, "images": images} for prompt, images in groups.items()], report


def make_thumbnail(source: Path, destination: Path) -> tuple[int, int]:
    with Image.open(source) as image:
        if image.mode not in ("RGB", "L"):
            if "A" in image.getbands():
                rgba = image.convert("RGBA")
                background = Image.new("RGB", rgba.size, "white")
                background.paste(rgba, mask=rgba.getchannel("A"))
                image = background
            else:
                image = image.convert("RGB")
        image.thumbnail((MAX_DIM, MAX_DIM), Image.Resampling.LANCZOS)
        width, height = image.size
        image.save(destination, "JPEG", quality=86, optimize=True)
    return width, height


def write_assets(groups: list[dict[str, Any]], codex_id: str) -> list[dict[str, Any]]:
    final_images = IMAGE_ROOT / codex_id
    final_originals = ORIGINAL_ROOT / codex_id
    if final_images.exists() or final_originals.exists():
        raise RuntimeError(f"asset target already exists for {codex_id}; refusing to replace it")

    IMAGE_ROOT.mkdir(parents=True, exist_ok=True)
    ORIGINAL_ROOT.mkdir(parents=True, exist_ok=True)
    image_stage = Path(tempfile.mkdtemp(prefix=f".{codex_id}-", dir=IMAGE_ROOT))
    original_stage = Path(tempfile.mkdtemp(prefix=f".{codex_id}-", dir=ORIGINAL_ROOT))
    entries: list[dict[str, Any]] = []
    try:
        for index, group in enumerate(groups, start=1):
            entry_id = f"{codex_id}_{index:04d}"
            assets: list[dict[str, Any]] = []
            rev_paths: list[Path] = []
            for image_index, image_info in enumerate(group["images"], start=1):
                suffix = "" if image_index == 1 else f"-{image_index:02d}"
                base = entry_id + suffix
                original_name = base + ".png"
                thumb_name = base + ".jpg"
                original_path = original_stage / original_name
                thumb_path = image_stage / thumb_name
                shutil.copy2(image_info["source"], original_path)
                existing_thumb = image_info.get("existingThumb")
                if isinstance(existing_thumb, Path) and existing_thumb.is_file():
                    shutil.copy2(existing_thumb, thumb_path)
                    with Image.open(thumb_path) as thumb:
                        width, height = thumb.size
                else:
                    width, height = make_thumbnail(image_info["source"], thumb_path)
                assets.append({
                    "path": thumb_name,
                    "original": original_name,
                    "width": width,
                    "height": height,
                })
                rev_paths.extend([thumb_path, original_path])

            primary = assets[0]
            entry: dict[str, Any] = {
                "title": f"W.O.F {index:03d}",
                "path": list(WOF_PATH),
                "tags": group["prompt"],
                "isNew": False,
                "id": entry_id,
                "image": primary["path"],
                "imageWidth": primary["width"],
                "imageHeight": primary["height"],
                "original": primary["original"],
                "images": [{"path": asset["path"], "original": asset["original"]} for asset in assets],
                "assetRev": asset_rev(rev_paths),
            }
            entries.append(entry)

        image_stage.rename(final_images)
        original_stage.rename(final_originals)
        return entries
    except Exception:
        shutil.rmtree(image_stage, ignore_errors=True)
        shutil.rmtree(original_stage, ignore_errors=True)
        raise


def codex_payload(args: argparse.Namespace, entries: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": args.codex_id,
        "type": "string",
        "title": args.title,
        "version": args.version,
        "author": args.author,
        "entryCount": len(entries),
        "imagedCount": len(entries),
        "hasOriginal": True,
        "source": f"{args.author} · {WOF_SECTION}",
        "contributors": [{"name": args.author, "role": "词条整理 / 配图数据提供"}],
        "tree": [{"name": WOF_TOP, "count": len(entries),
                  "children": [{"name": WOF_SECTION, "count": len(entries), "children": []}]}],
        "entries": entries,
    }


def write_json(path: Path, payload: object, *, compact: bool = False) -> None:
    path.write_text(
        json.dumps(
            payload,
            ensure_ascii=False,
            indent=None if compact else 2,
            separators=(",", ":") if compact else None,
        )
        + "\n",
        encoding="utf-8",
    )


def entry_number(entry_id: str, codex_id: str) -> int | None:
    match = re.fullmatch(re.escape(codex_id) + r"_(\d+)", entry_id)
    return int(match.group(1)) if match else None


def update_batch_label(version: str) -> str:
    match = re.fullmatch(r"\d{4}\.(\d{1,2})\.(\d{1,2})", version.strip())
    if not match:
        raise RuntimeError(f"update version must be YYYY.M.D, got {version!r}")
    return f"{int(match.group(1))}.{int(match.group(2))}更新"


def prompt_similarity(left: str, right: str) -> dict[str, float | int]:
    left_clean = clean_text(left).casefold()
    right_clean = clean_text(right).casefold()
    left_parts = {part.strip() for part in left_clean.split(",") if part.strip()}
    right_parts = {part.strip() for part in right_clean.split(",") if part.strip()}
    union = left_parts | right_parts
    overlap = left_parts & right_parts
    char_ratio = SequenceMatcher(None, left_clean, right_clean, autojunk=False).ratio()
    jaccard = len(overlap) / len(union) if union else 0.0
    return {
        "score": round((char_ratio + jaccard) / 2, 6),
        "characterRatio": round(char_ratio, 6),
        "segmentJaccard": round(jaccard, 6),
        "sharedSegments": len(overlap),
    }


def original_hashes(entry: dict[str, Any], codex_id: str) -> list[str]:
    asset_codex_id = str(entry.get("assetCodexId") or codex_id)
    hashes: list[str] = []
    for image in entry.get("images") or []:
        original_name = str(image.get("original") or "")
        original_path = ORIGINAL_ROOT / asset_codex_id / original_name
        if not original_name or not original_path.is_file():
            raise RuntimeError(f"missing existing original for {entry.get('id')}: {original_path}")
        hashes.append(sha256_file(original_path))
    if not hashes:
        raise RuntimeError(f"existing W.O.F entry has no originals: {entry.get('id')}")
    return hashes


def original_visual_hashes(entry: dict[str, Any], codex_id: str) -> list[str]:
    asset_codex_id = str(entry.get("assetCodexId") or codex_id)
    hashes: list[str] = []
    for image in entry.get("images") or []:
        original_name = str(image.get("original") or "")
        original_path = ORIGINAL_ROOT / asset_codex_id / original_name
        if not original_name or not original_path.is_file():
            raise RuntimeError(f"missing existing original for {entry.get('id')}: {original_path}")
        hashes.append(png_visual_hash(original_path))
    if not hashes:
        raise RuntimeError(f"existing W.O.F entry has no originals: {entry.get('id')}")
    return hashes


def existing_image_infos(entry: dict[str, Any], codex_id: str) -> list[dict[str, Any]]:
    asset_codex_id = str(entry.get("assetCodexId") or codex_id)
    infos: list[dict[str, Any]] = []
    for image in entry.get("images") or []:
        original_path = ORIGINAL_ROOT / asset_codex_id / str(image.get("original") or "")
        thumb_path = IMAGE_ROOT / asset_codex_id / str(image.get("path") or "")
        if not original_path.is_file() or not thumb_path.is_file():
            raise RuntimeError(f"missing existing asset pair for {entry.get('id')}: {thumb_path} / {original_path}")
        infos.append({
            "source": original_path,
            "fullPrompt": "",
            "sha256": sha256_file(original_path),
            "visualSha256": png_visual_hash(original_path),
            "existingThumb": thumb_path,
        })
    return infos


def merge_group_with_existing_assets(
    group: dict[str, Any],
    entry: dict[str, Any],
    codex_id: str,
) -> tuple[dict[str, Any], int]:
    """Keep every old example image; a full-pack update may add but never silently remove."""
    old_images = existing_image_infos(entry, codex_id)
    new_images = list(group["images"])
    used_new: set[int] = set()
    merged: list[dict[str, Any]] = []
    preserved_old = 0
    for old_image in old_images:
        match_index = next(
            (
                index for index, new_image in enumerate(new_images)
                if index not in used_new and new_image["sha256"] == old_image["sha256"]
            ),
            None,
        )
        if match_index is None:
            match_index = next(
                (
                    index for index, new_image in enumerate(new_images)
                    if index not in used_new
                    and new_image["visualSha256"] == old_image["visualSha256"]
                ),
                None,
            )
        if match_index is None:
            merged.append(old_image)
            preserved_old += 1
            continue
        used_new.add(match_index)
        selected = dict(new_images[match_index])
        selected["existingThumb"] = old_image["existingThumb"]
        merged.append(selected)
    merged.extend(new_image for index, new_image in enumerate(new_images) if index not in used_new)
    return {"prompt": group["prompt"], "images": merged}, preserved_old


def plan_existing_update(
    groups: list[dict[str, Any]],
    existing: dict[str, Any],
    codex_id: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    old_entries = [
        entry for entry in existing.get("entries") or []
        if entry.get("path") == WOF_PATH
    ]
    if not old_entries:
        raise RuntimeError(f"existing codex has no entries under {WOF_PATH}")

    old_by_prompt: dict[str, dict[str, Any]] = {}
    old_hashes: dict[str, list[str]] = {}
    old_visual_hashes: dict[str, list[str]] = {}
    old_by_hash: dict[str, str] = {}
    old_by_visual_hash: dict[str, str] = {}
    max_number = 0
    all_ids = {str(entry.get("id") or "") for entry in existing.get("entries") or []}
    for entry in old_entries:
        entry_id = str(entry.get("id") or "")
        prompt = clean_text(entry.get("tags"))
        if not entry_id or not prompt:
            raise RuntimeError(f"existing W.O.F entry lacks id or tags: {entry!r}")
        if prompt in old_by_prompt:
            raise RuntimeError(
                f"existing W.O.F entries share one prompt: {old_by_prompt[prompt].get('id')} / {entry_id}"
            )
        old_by_prompt[prompt] = entry
        hashes = original_hashes(entry, codex_id)
        visual_hashes = original_visual_hashes(entry, codex_id)
        old_hashes[entry_id] = hashes
        old_visual_hashes[entry_id] = visual_hashes
        for digest in hashes:
            other_id = old_by_hash.get(digest)
            if other_id and other_id != entry_id:
                raise RuntimeError(f"existing original hash belongs to two entries: {other_id} / {entry_id}")
            old_by_hash[digest] = entry_id
        for digest in visual_hashes:
            other_id = old_by_visual_hash.get(digest)
            if other_id and other_id != entry_id:
                raise RuntimeError(f"existing visual hash belongs to two entries: {other_id} / {entry_id}")
            old_by_visual_hash[digest] = entry_id
        number = entry_number(entry_id, codex_id)
        if number is None:
            raise RuntimeError(f"unexpected W.O.F entry id: {entry_id}")
        max_number = max(max_number, number)

    used_old_ids: set[str] = set()
    by_old_id: dict[str, dict[str, Any]] = {}
    new_items: list[dict[str, Any]] = []
    next_number = max_number + 1
    prompt_matches = 0
    hash_matches = 0
    visual_hash_matches = 0
    unchanged = 0
    changed_existing_ids: list[str] = []
    changed_existing_details: list[dict[str, Any]] = []

    for group in groups:
        prompt = group["prompt"]
        group_hashes = [str(image["sha256"]) for image in group["images"]]
        group_visual_hashes = [str(image["visualSha256"]) for image in group["images"]]
        prompt_entry = old_by_prompt.get(prompt)
        hash_ids = {old_by_hash[digest] for digest in group_hashes if digest in old_by_hash}
        visual_hash_ids = {
            old_by_visual_hash[digest]
            for digest in group_visual_hashes
            if digest in old_by_visual_hash
        }
        if len(hash_ids) > 1:
            raise RuntimeError(f"new group overlaps multiple existing entries: {sorted(hash_ids)}")
        if len(visual_hash_ids) > 1:
            raise RuntimeError(f"new group visually overlaps multiple existing entries: {sorted(visual_hash_ids)}")
        hash_id = next(iter(hash_ids), "")
        visual_hash_id = next(iter(visual_hash_ids), "")
        prompt_id = str(prompt_entry.get("id") or "") if prompt_entry else ""
        evidence_ids = {value for value in (prompt_id, hash_id, visual_hash_id) if value}
        if len(evidence_ids) > 1:
            raise RuntimeError(
                f"prompt/hash match conflict: prompt={prompt_id}, hash={hash_id}, visual={visual_hash_id}"
            )

        old_entry = prompt_entry
        match_method = "prompt" if prompt_entry else ""
        if not old_entry and hash_id:
            old_entry = next(entry for entry in old_entries if entry.get("id") == hash_id)
            match_method = "sha256"
        if not old_entry and visual_hash_id:
            old_entry = next(entry for entry in old_entries if entry.get("id") == visual_hash_id)
            match_method = "png-visual"
        if old_entry:
            entry_id = str(old_entry["id"])
            if entry_id in used_old_ids:
                raise RuntimeError(f"existing entry matched more than once: {entry_id}")
            used_old_ids.add(entry_id)
            if match_method == "prompt":
                prompt_matches += 1
            elif match_method == "sha256":
                hash_matches += 1
            else:
                visual_hash_matches += 1
            merged_group, preserved_old_images = merge_group_with_existing_assets(group, old_entry, codex_id)
            merged_hashes = [str(image["sha256"]) for image in merged_group["images"]]
            changed = clean_text(old_entry.get("tags")) != prompt or old_hashes[entry_id] != merged_hashes
            if changed:
                changed_existing_ids.append(entry_id)
                changed_existing_details.append({
                    "id": entry_id,
                    "promptChanged": clean_text(old_entry.get("tags")) != prompt,
                    "oldImages": len(old_hashes[entry_id]),
                    "sourceImages": len(group_hashes),
                    "resultImages": len(merged_hashes),
                    "sharedImages": len(set(old_hashes[entry_id]) & set(group_hashes)),
                    "preservedOldImages": preserved_old_images,
                })
            else:
                unchanged += 1
            item = {
                "group": merged_group,
                "oldEntry": old_entry,
                "entryId": entry_id,
                "title": str(old_entry.get("title") or f"W.O.F {entry_number(entry_id, codex_id):03d}"),
                "matchMethod": match_method,
                "changed": changed,
                "isNew": False,
                "preservedOldImages": preserved_old_images,
            }
            by_old_id[entry_id] = item
            continue

        while f"{codex_id}_{next_number:04d}" in all_ids:
            next_number += 1
        entry_id = f"{codex_id}_{next_number:04d}"
        item = {
            "group": group,
            "oldEntry": None,
            "entryId": entry_id,
            "title": f"W.O.F {next_number:03d}",
            "matchMethod": "new",
            "changed": True,
            "isNew": True,
        }
        all_ids.add(entry_id)
        new_items.append(item)
        next_number += 1

    missing_old_ids = [
        str(entry.get("id") or "") for entry in old_entries
        if str(entry.get("id") or "") not in used_old_ids
    ]
    missing_details: list[dict[str, Any]] = []
    old_by_id = {str(entry.get("id") or ""): entry for entry in old_entries}
    for entry_id in missing_old_ids:
        old_prompt = clean_text(old_by_id[entry_id].get("tags"))
        candidates: list[dict[str, Any]] = []
        for item in new_items:
            candidate_prompt = str(item["group"]["prompt"])
            candidates.append({
                "id": item["entryId"],
                "title": item["title"],
                "prompt": candidate_prompt,
                **prompt_similarity(old_prompt, candidate_prompt),
            })
        candidates.sort(key=lambda value: (value["score"], value["characterRatio"]), reverse=True)
        missing_details.append({
            "id": entry_id,
            "title": old_by_id[entry_id].get("title"),
            "prompt": old_prompt,
            "closestNewCandidates": candidates[:5],
        })
        old_entry = old_by_id[entry_id]
        by_old_id[entry_id] = {
            "group": {"prompt": old_prompt, "images": existing_image_infos(old_entry, codex_id)},
            "oldEntry": old_entry,
            "entryId": entry_id,
            "title": str(old_entry.get("title") or ""),
            "matchMethod": "preserved-missing-source",
            "changed": False,
            "isNew": False,
            "preservedOldImages": len(old_entry.get("images") or []),
        }
    ordered_items = [by_old_id[str(entry["id"])] for entry in old_entries if str(entry["id"]) in by_old_id]
    ordered_items.extend(new_items)
    new_ids = [str(item["entryId"]) for item in new_items]
    preserved_old_images = sum(int(item.get("preservedOldImages") or 0) for item in ordered_items)
    summary = {
        "existingWofEntries": len(old_entries),
        "promptMatches": prompt_matches,
        "sha256Matches": hash_matches,
        "pngVisualMatches": visual_hash_matches,
        "matchedExistingEntries": len(used_old_ids),
        "preservedExistingEntriesMissingFromSource": len(missing_old_ids),
        "unchangedExistingEntries": unchanged + len(missing_old_ids),
        "changedExistingEntries": len(changed_existing_ids),
        "changedExistingIds": changed_existing_ids,
        "changedExistingDetails": changed_existing_details,
        "missingExistingEntries": 0,
        "missingExistingIds": [],
        "sourceMissingExistingEntries": len(missing_old_ids),
        "sourceMissingExistingIds": missing_old_ids,
        "sourceMissingExistingDetails": missing_details,
        "preservedOldImagesMissingFromSource": preserved_old_images,
        "newEntries": len(new_items),
        "newIdFirst": new_ids[0] if new_ids else "",
        "newIdLast": new_ids[-1] if new_ids else "",
        "resultWofEntries": len(ordered_items),
        "resultWofImages": sum(len(item["group"]["images"]) for item in ordered_items),
    }
    return ordered_items, summary


def stage_update_assets(
    items: list[dict[str, Any]],
    codex_id: str,
    update_batch: str,
) -> tuple[list[dict[str, Any]], Path, Path]:
    IMAGE_ROOT.mkdir(parents=True, exist_ok=True)
    ORIGINAL_ROOT.mkdir(parents=True, exist_ok=True)
    image_stage = Path(tempfile.mkdtemp(prefix=f".{codex_id}-update-", dir=IMAGE_ROOT))
    original_stage = Path(tempfile.mkdtemp(prefix=f".{codex_id}-update-", dir=ORIGINAL_ROOT))
    entries: list[dict[str, Any]] = []
    try:
        for item in items:
            entry_id = str(item["entryId"])
            assets: list[dict[str, Any]] = []
            rev_paths: list[Path] = []
            for image_index, image_info in enumerate(item["group"]["images"], start=1):
                suffix = "" if image_index == 1 else f"-{image_index:02d}"
                base = entry_id + suffix
                original_name = base + ".png"
                thumb_name = base + ".jpg"
                original_path = original_stage / original_name
                thumb_path = image_stage / thumb_name
                shutil.copy2(image_info["source"], original_path)
                width, height = make_thumbnail(image_info["source"], thumb_path)
                assets.append({
                    "path": thumb_name,
                    "original": original_name,
                    "width": width,
                    "height": height,
                })
                rev_paths.extend([thumb_path, original_path])

            primary = assets[0]
            entry = dict(item.get("oldEntry") or {})
            # 合并册里 W.O.F 的图仍在 images/artist_nai45_strings/，assetCodexId 必须写死系列身份；
            # 以前这里是 pop 掉（当时书 id 就等于系列 id），合并后再 pop 就会把图路由到合并册目录。
            entry["assetCodexId"] = codex_id
            entry.update({
                "title": item["title"],
                "path": list(WOF_PATH),
                "tags": item["group"]["prompt"],
                "isNew": bool(item["isNew"]),
                "id": entry_id,
                "image": primary["path"],
                "imageWidth": primary["width"],
                "imageHeight": primary["height"],
                "original": primary["original"],
                "images": [{"path": asset["path"], "original": asset["original"]} for asset in assets],
                "assetRev": asset_rev(rev_paths),
            })
            batches = [str(value) for value in entry.get("updateBatches") or [] if str(value)]
            if item["changed"] and update_batch not in batches:
                batches.append(update_batch)
            if batches:
                entry["updateBatches"] = batches
            else:
                entry.pop("updateBatches", None)
            entries.append(entry)
        return entries, image_stage, original_stage
    except Exception:
        shutil.rmtree(image_stage, ignore_errors=True)
        shutil.rmtree(original_stage, ignore_errors=True)
        raise


def merge_wof_tree(tree: list[dict[str, Any]], wof_count: int) -> list[dict[str, Any]]:
    """只更新「画师串词典 › W.O.F_画风」那一枝的计数，别的枝（梦神、单画师词典）原样保留。"""
    out: list[dict[str, Any]] = []
    saw_top = False
    for raw_top in tree:
        top = dict(raw_top)
        if top.get("name") == WOF_TOP:
            saw_top = True
            children: list[dict[str, Any]] = []
            saw_section = False
            for raw_child in top.get("children") or []:
                child = dict(raw_child)
                if child.get("name") == WOF_SECTION:
                    child["count"] = wof_count
                    saw_section = True
                children.append(child)
            if not saw_section:
                children.insert(0, {"name": WOF_SECTION, "count": wof_count, "children": []})
            top["children"] = children
            top["count"] = sum(int(c.get("count") or 0) for c in children)
        out.append(top)
    if not saw_top:
        out.append({
            "name": WOF_TOP,
            "count": wof_count,
            "children": [{"name": WOF_SECTION, "count": wof_count, "children": []}],
        })
    return out


def merge_existing_codex(
    existing: dict[str, Any],
    wof_entries: list[dict[str, Any]],
    version: str,
) -> dict[str, Any]:
    old_entries = existing.get("entries") or []
    other_entries = [entry for entry in old_entries if entry.get("path") != WOF_PATH]
    # 新 W.O.F 块放回它原来所在的位置。合并册里它排在单画师词典之后，
    # 旧写法 `wof_entries + other_entries` 会把整块顶到全书最前，打乱「全部」视图的卡序。
    first_wof = next((i for i, e in enumerate(old_entries) if e.get("path") == WOF_PATH), len(old_entries))
    offset = sum(1 for e in old_entries[:first_wof] if e.get("path") != WOF_PATH)
    entries = other_entries[:offset] + list(wof_entries) + other_entries[offset:]
    tree = merge_wof_tree(existing.get("tree") or [], len(wof_entries))
    payload = dict(existing)
    payload.update({
        "version": version,
        "entryCount": len(entries),
        "imagedCount": sum(1 for entry in entries if entry.get("image") or entry.get("images")),
        "hasOriginal": True,
        "tree": tree,
        "entries": entries,
    })
    return payload


def updated_index_payload(
    index: list[dict[str, Any]],
    codex: dict[str, Any],
    update_batch: str,
) -> list[dict[str, Any]]:
    matches = [position for position, item in enumerate(index) if item.get("id") == codex["id"]]
    if len(matches) != 1:
        raise RuntimeError(f"expected one index row for {codex['id']}, found {len(matches)}")
    position = matches[0]
    meta = dict(index[position])
    label = update_batch_label(update_batch)
    filters: list[dict[str, Any]] = []
    found_batch = False
    for raw_filter in meta.get("updateFilters") or []:
        item = dict(raw_filter)
        item.pop("latest", None)
        if str(item.get("id") or "") == update_batch:
            item["label"] = label
            item["latest"] = True
            found_batch = True
        filters.append(item)
    if not found_batch:
        filters.append({"id": update_batch, "label": label, "latest": True})

    cover = str(meta.get("cover") or "")
    cover_entry = next((entry for entry in codex["entries"] if entry.get("image") == cover), None)
    if not cover_entry:
        cover_entry = next((entry for entry in codex["entries"] if entry.get("image")), None)
        cover = str(cover_entry.get("image") or "") if cover_entry else ""
    meta.update({
        "version": codex["version"],
        "entryCount": codex["entryCount"],
        "imagedCount": codex["imagedCount"],
        "hasOriginal": codex["hasOriginal"],
        "cover": cover,
        "coverRev": str(cover_entry.get("assetRev") or "") if cover_entry else "",
        "newFilterLabel": f"本次{label}",
        "updateFilters": filters,
    })
    updated = list(index)
    updated[position] = meta
    return updated


def apply_existing_update(
    args: argparse.Namespace,
    items: list[dict[str, Any]],
) -> tuple[dict[str, Any], Path]:
    data_path = DATA_DIR / f"{args.book_id}.json"
    index_path = DATA_DIR / "codexes.json"
    existing = json.loads(data_path.read_text(encoding="utf-8"))
    index = json.loads(index_path.read_text(encoding="utf-8"))
    entries, image_stage, original_stage = stage_update_assets(items, args.codex_id, args.version)
    codex = merge_existing_codex(existing, entries, args.version)
    updated_index = updated_index_payload(index, codex, args.version)

    backup_dir = OUTPUT_DIR / "edit-backups" / (
        datetime.now().strftime("%Y%m%d-%H%M%S") + f"-{args.codex_id}-{args.version}-update"
    )
    backup_dir.mkdir(parents=True, exist_ok=False)
    shutil.copy2(data_path, backup_dir / data_path.name)
    shutil.copy2(index_path, backup_dir / index_path.name)

    final_images = IMAGE_ROOT / args.codex_id
    final_originals = ORIGINAL_ROOT / args.codex_id
    backup_images = backup_dir / "site-images"
    backup_originals = backup_dir / "originals"
    swapped_images = False
    swapped_originals = False
    try:
        final_images.rename(backup_images)
        image_stage.rename(final_images)
        swapped_images = True
        final_originals.rename(backup_originals)
        original_stage.rename(final_originals)
        swapped_originals = True
        write_json(data_path, codex, compact=True)
        write_json(index_path, updated_index)
        validation = validate_import(args.codex_id, args.book_id)
        return validation, backup_dir
    except Exception:
        if swapped_images and final_images.exists():
            final_images.rename(backup_dir / "failed-new-site-images")
        if backup_images.exists():
            backup_images.rename(final_images)
        if swapped_originals and final_originals.exists():
            final_originals.rename(backup_dir / "failed-new-originals")
        if backup_originals.exists():
            backup_originals.rename(final_originals)
        shutil.copy2(backup_dir / data_path.name, data_path)
        shutil.copy2(backup_dir / index_path.name, index_path)
        if image_stage.exists():
            shutil.rmtree(image_stage, ignore_errors=True)
        if original_stage.exists():
            shutil.rmtree(original_stage, ignore_errors=True)
        raise


def update_index(codex: dict[str, Any]) -> None:
    index_path = DATA_DIR / "codexes.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    if any(item.get("id") == codex["id"] for item in index):
        raise RuntimeError(f"codex index already contains {codex['id']}")
    meta = {key: value for key, value in codex.items() if key not in {"tree", "entries"}}
    insert_at = next(
        (position + 1 for position, item in enumerate(index) if item.get("id") == "artist_nai45_personal"),
        len(index),
    )
    index.insert(insert_at, meta)
    write_json(index_path, index)


def validate_import(codex_id: str, book_id: str = DEFAULT_BOOK_ID) -> dict[str, Any]:
    """codex_id ＝ W.O.F 系列（词条 id 前缀 / 图片目录）；book_id ＝ 合并册数据落点。"""
    data_path = DATA_DIR / f"{book_id}.json"
    data = json.loads(data_path.read_text(encoding="utf-8"))
    index = json.loads((DATA_DIR / "codexes.json").read_text(encoding="utf-8"))
    entries = [
        entry
        for entry in (data.get("entries") or [])
        if entry.get("path") == WOF_PATH
    ]
    ids: set[str] = set()
    referenced_thumbs: set[str] = set()
    referenced_originals: set[str] = set()
    checked_images = 0
    mismatches: list[str] = []
    all_entries = data.get("entries") or []
    if data.get("entryCount") != len(all_entries):
        mismatches.append(f"entryCount mismatch: {data.get('entryCount')} != {len(all_entries)}")
    actual_imaged = sum(1 for entry in all_entries if entry.get("image") or entry.get("images"))
    if data.get("imagedCount") != actual_imaged:
        mismatches.append(f"imagedCount mismatch: {data.get('imagedCount')} != {actual_imaged}")
    tree_counts = {
        str(node.get("name") or ""): int(node.get("count") or 0)
        for node in data.get("tree") or []
    }
    actual_counts: dict[str, int] = {}
    for entry in all_entries:
        top = str((entry.get("path") or [""])[0])
        actual_counts[top] = actual_counts.get(top, 0) + 1
    if tree_counts != actual_counts:
        mismatches.append(f"tree counts mismatch: {tree_counts!r} != {actual_counts!r}")

    index_rows = [item for item in index if item.get("id") == book_id]
    if len(index_rows) != 1:
        mismatches.append(f"index row count: {len(index_rows)}")
    else:
        meta = index_rows[0]
        for field in ("version", "entryCount", "imagedCount", "hasOriginal"):
            if meta.get(field) != data.get(field):
                mismatches.append(f"index {field} mismatch: {meta.get(field)!r} != {data.get(field)!r}")
        filters = meta.get("updateFilters") or []
        latest = [item for item in filters if item.get("latest") is True]
        if filters and (len(latest) != 1 or str(latest[0].get("id") or "") != str(data.get("version") or "")):
            mismatches.append(f"latest update filter mismatch: {latest!r}")

    for entry in entries:
        entry_id = str(entry.get("id") or "")
        if not entry_id or entry_id in ids:
            mismatches.append(f"duplicate or empty entry id: {entry_id!r}")
        ids.add(entry_id)
        if entry.get("path") != WOF_PATH:
            mismatches.append(f"bad path: {entry_id}")
        images = entry.get("images") or []
        rev_paths: list[Path] = []
        for image in images:
            thumb_name = str(image.get("path") or "")
            original_name = str(image.get("original") or "")
            thumb = IMAGE_ROOT / codex_id / thumb_name
            original = ORIGINAL_ROOT / codex_id / original_name
            if not thumb.is_file() or not original.is_file():
                mismatches.append(f"missing asset: {entry_id}:{image}")
                continue
            if thumb_name in referenced_thumbs or original_name in referenced_originals:
                mismatches.append(f"asset referenced more than once: {entry_id}:{image}")
            referenced_thumbs.add(thumb_name)
            referenced_originals.add(original_name)
            rev_paths.extend([thumb, original])
            metadata_prompt = style_prompt(extract_image_metadata(original))
            if metadata_prompt != entry.get("tags"):
                mismatches.append(f"prompt mismatch: {entry_id}:{original.name}")
            checked_images += 1
        if images:
            with Image.open(IMAGE_ROOT / codex_id / images[0]["path"]) as primary:
                if primary.size != (entry.get("imageWidth"), entry.get("imageHeight")):
                    mismatches.append(f"primary dimensions mismatch: {entry_id}")
        if rev_paths and entry.get("assetRev") != asset_rev(rev_paths):
            mismatches.append(f"assetRev mismatch: {entry_id}")

    actual_thumbs = {path.name for path in (IMAGE_ROOT / codex_id).glob("*.jpg")}
    actual_originals = {path.name for path in (ORIGINAL_ROOT / codex_id).glob("*.png")}
    if actual_thumbs != referenced_thumbs:
        missing = sorted(referenced_thumbs - actual_thumbs)
        extra = sorted(actual_thumbs - referenced_thumbs)
        mismatches.append(f"thumbnail set mismatch: missing={missing[:10]!r}, extra={extra[:10]!r}")
    if actual_originals != referenced_originals:
        missing = sorted(referenced_originals - actual_originals)
        extra = sorted(actual_originals - referenced_originals)
        mismatches.append(f"original set mismatch: missing={missing[:10]!r}, extra={extra[:10]!r}")
    if mismatches:
        raise RuntimeError("\n".join(mismatches[:50]))
    return {
        "codexId": codex_id,
        "bookId": book_id,
        "version": data.get("version"),
        "totalEntries": len(all_entries),
        "entries": len(entries),
        "images": checked_images,
        "uniqueIds": len(ids),
        "promptMismatches": 0,
        "missingAssets": 0,
        "extraAssets": 0,
        "indexParity": True,
        "treeParity": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path(r"D:\program\NOVEL\新数据\W.O.F_画风_2026.7.10\画风"))
    # codex_id ＝ W.O.F 系列身份（词条 id 前缀 / images / originals / assetCodexId），合并后没变；
    # book_id  ＝ 数据落点，2026-08-31 起是合并册 artist_nai45_personal。
    parser.add_argument("--codex-id", default=DEFAULT_SERIES_ID)
    parser.add_argument("--book-id", default=DEFAULT_BOOK_ID)
    parser.add_argument("--title", default="NovelAI v4.5画师串词典")
    parser.add_argument("--author", default="PieDriver")
    parser.add_argument("--version", default="2026.7.10")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument(
        "--update-existing",
        action="store_true",
        help="replace only W.O.F_画风 in an existing merged codex while preserving stable ids and other categories",
    )
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()

    if args.validate:
        print(json.dumps(validate_import(args.codex_id, args.book_id), ensure_ascii=False, indent=2))
        return 0

    groups, report = scan_source(args.source)
    report.update({
        "codexId": args.codex_id,
        "bookId": args.book_id,
        "title": args.title,
        "author": args.author,
        "version": args.version,
        "category": "W.O.F_画风",
        "applied": False,
    })
    data_path = DATA_DIR / f"{args.book_id}.json"
    if args.update_existing:
        if not data_path.is_file():
            raise RuntimeError(f"existing data target not found: {data_path}")
        existing = json.loads(data_path.read_text(encoding="utf-8"))
        items, comparison = plan_existing_update(groups, existing, args.codex_id)
        report["comparison"] = comparison
        if comparison["missingExistingEntries"]:
            report["blockedReason"] = "full package is missing existing W.O.F entries; refusing to remove them"
        elif args.apply:
            validation, backup_dir = apply_existing_update(args, items)
            report["applied"] = True
            report["backup"] = str(backup_dir)
            report["validation"] = validation
    elif args.apply:
        if data_path.exists():
            raise RuntimeError(f"data target already exists: {data_path}")
        entries = write_assets(groups, args.codex_id)
        codex = codex_payload(args, entries)
        write_json(data_path, codex, compact=True)
        update_index(codex)
        report["applied"] = True

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    report_name = "wof_artist_strings_update_report.json" if args.update_existing else "wof_artist_strings_import_report.json"
    report_path = OUTPUT_DIR / report_name
    write_json(report_path, report)
    print(json.dumps({**report, "report": str(report_path)}, ensure_ascii=False, indent=2))
    if report.get("blockedReason"):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
