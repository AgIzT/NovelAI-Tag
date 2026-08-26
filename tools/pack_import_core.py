"""Shared, source-agnostic helpers for image-backed codex importers.

Source adapters are responsible for discovery, attribution, paths, titles and
content classification. This module owns the byte-preserving asset pipeline,
metadata normalization, exact deduplication, tree building and validation.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import shutil
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any, Callable, Iterable

from PIL import Image, ImageOps


MAX_DIM = 1100
IMAGE_EXTS = {".png", ".webp", ".jpg", ".jpeg"}
RATING_RANK = {"safe": 0, "restricted": 1, "r18": 2, "r18g": 3}


def make_staging_directory(parent: Path, prefix: str) -> Path:
    """Create renameable staging without tempfile's private 0700 ACL."""
    parent.mkdir(parents=True, exist_ok=True)
    for _attempt in range(100):
        path = parent / f"{prefix}{secrets.token_hex(8)}"
        try:
            path.mkdir()
        except FileExistsError:
            continue
        return path
    raise FileExistsError(f"could not allocate a staging directory below {parent}")


def clean_text(value: Any) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()


def clean_character_prompts(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    out: list[dict[str, str]] = []
    for index, raw in enumerate(value):
        if not isinstance(raw, dict):
            continue
        prompt = clean_text(raw.get("prompt"))
        negative = clean_text(raw.get("negative"))
        if not prompt and not negative:
            continue
        item = {
            "label": clean_text(raw.get("label")) or f"char{index + 1}",
            "prompt": prompt,
        }
        if negative:
            item["negative"] = negative
        out.append(item)
    return out


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def normalized_suffix(value: str | Path) -> str:
    text = str(value).lower().strip()
    suffix = text if text.startswith(".") and "/" not in text and "\\" not in text else Path(value).suffix.lower()
    if not suffix and text in {"png", "webp", "jpg", "jpeg"}:
        suffix = "." + text
    if suffix == ".jpeg":
        return ".jpg"
    if suffix not in IMAGE_EXTS:
        raise ValueError(f"unsupported image extension: {suffix!r}")
    return suffix


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
    payload = fields.get("CommentJson") or fields.get("StealthJson") or fields.get("ExifJson") or {}
    if not isinstance(payload, dict):
        payload = {}
    if isinstance(payload.get("Comment"), str):
        try:
            nested = json.loads(payload["Comment"])
            if isinstance(nested, dict):
                payload = nested
        except (TypeError, ValueError, json.JSONDecodeError):
            pass
    parts: list[str] = []
    for label, value in (
        ("Steps", payload.get("steps")),
        ("Sampler", sampler_label(payload.get("sampler"))),
        ("CFG scale", payload.get("scale") or payload.get("cfg_scale")),
        ("CFG rescale", payload.get("cfg_rescale")),
        ("Seed", payload.get("seed")),
    ):
        if value not in (None, ""):
            parts.append(f"{label}: {value}")
    width = payload.get("width")
    height = payload.get("height")
    if width and height:
        parts.append(f"Size: {width}x{height}")
    if payload.get("noise_schedule"):
        parts.append(f"Noise schedule: {payload['noise_schedule']}")
    lines = ["参数：" + ", ".join(parts)] if parts else []
    lines.append(f"元数据：{clean_text(meta.source_type) or 'unknown'}")
    return "\n".join(lines)


def inspect_image(path: Path) -> dict[str, Any]:
    from sd_metadata_inspector import extract_image_metadata, split_prompt_tags

    result: dict[str, Any] = {
        "sourcePath": str(path),
        "extension": path.suffix.lower(),
        "sourceType": "unknown",
        "sourceModel": "",
        "prompt": "",
        "negative": "",
        "characterPrompts": [],
        "note": "",
        "promptTagCount": 0,
        "sha256": "",
        "width": 0,
        "height": 0,
        "readable": False,
        "error": "",
    }
    try:
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            result["width"], result["height"] = image.size
        result["readable"] = True
    except Exception as exc:
        result["error"] = f"unreadable_image:{type(exc).__name__}"
        return result
    try:
        meta = extract_image_metadata(path)
        result["sourceType"] = clean_text(meta.source_type) or "unknown"
        result["sourceModel"] = clean_text(meta.fields.get("Source") or meta.fields.get("Software"))
        result["prompt"] = clean_text(meta.prompt)
        result["negative"] = clean_text(meta.negative)
        result["characterPrompts"] = clean_character_prompts(meta.character_prompts)
        result["note"] = metadata_note(meta)
        result["promptTagCount"] = len(split_prompt_tags(result["prompt"]))
    except Exception as exc:
        result["error"] = f"metadata_error:{type(exc).__name__}"
        return result
    try:
        result["sha256"] = sha256_file(path)
    except Exception as exc:
        result["error"] = f"hash_error:{type(exc).__name__}"
    return result


def inspect_image_task(task: dict[str, Any]) -> dict[str, Any]:
    return {**task, **inspect_image(Path(task["sourcePath"]))}


def run_parallel(
    label: str,
    function: Callable[[dict[str, Any]], dict[str, Any]],
    tasks: list[dict[str, Any]],
    workers: int | None = None,
) -> list[dict[str, Any]]:
    if not tasks:
        return []
    count = max(1, workers or min(8, os.cpu_count() or 1))
    results: list[dict[str, Any]] = []
    print(f"{label}: 0/{len(tasks)}", flush=True)
    with ProcessPoolExecutor(max_workers=count) as pool:
        for index, result in enumerate(pool.map(function, tasks, chunksize=8), 1):
            results.append(result)
            if index % 100 == 0 or index == len(tasks):
                print(f"{label}: {index}/{len(tasks)}", flush=True)
    return results


def mark_exact_duplicates(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row.get("accepted") and row.get("sha256"):
            grouped[str(row["sha256"])].append(row)
    duplicate_rows: list[dict[str, Any]] = []
    for items in grouped.values():
        if len(items) < 2:
            continue
        keeper = max(
            items,
            key=lambda item: (
                RATING_RANK.get(str(item.get("rating") or ""), -1),
                -int(item.get("sourceIndex") or 0),
            ),
        )
        for item in items:
            if item is keeper:
                continue
            item["accepted"] = False
            item["reason"] = "exact_duplicate"
            item["duplicateOf"] = keeper.get("relativePath") or keeper.get("sourcePath")
            duplicate_rows.append(item)
    return duplicate_rows


def build_tree(entries: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    root: dict[str, Any] = {}
    for entry in entries:
        node = root
        for name in entry.get("path") or []:
            current = node.setdefault(name, {"name": name, "count": 0, "children": {}})
            current["count"] += 1
            node = current["children"]

    def serialize(node: dict[str, Any]) -> list[dict[str, Any]]:
        return [
            {"name": value["name"], "count": value["count"], "children": serialize(value["children"])}
            for value in node.values()
        ]

    return serialize(root)


def _thumbnail(source: Path, destination: Path) -> tuple[int, int]:
    with Image.open(source) as opened:
        image = ImageOps.exif_transpose(opened)
        if image.mode not in ("RGB", "L"):
            if "A" in image.getbands():
                rgba = image.convert("RGBA")
                background = Image.new("RGB", rgba.size, "white")
                background.paste(rgba, mask=rgba.getchannel("A"))
                image = background
            else:
                image = image.convert("RGB")
        image.thumbnail((MAX_DIM, MAX_DIM), Image.Resampling.LANCZOS)
        image.save(destination, "JPEG", quality=86, optimize=True)
        return image.size


def write_asset_from_path(task: dict[str, Any]) -> dict[str, Any]:
    source = Path(task["sourcePath"])
    entry_id = str(task["entryId"])
    thumb_dir = Path(task["thumbDir"])
    original_dir = Path(task["originalDir"])
    suffix = normalized_suffix(source)
    original_name = f"{entry_id}{suffix}"
    preserve_display = bool(task.get("preserveDisplay"))
    thumb_name = f"{entry_id}{suffix}" if preserve_display else f"{entry_id}.jpg"
    original = original_dir / original_name
    thumb = thumb_dir / thumb_name
    shutil.copy2(source, original)
    copied_sha = sha256_file(original)
    expected_sha = str(task.get("sha256") or "")
    if expected_sha and copied_sha != expected_sha:
        raise RuntimeError(f"original copy hash mismatch: {source}")
    if preserve_display:
        shutil.copy2(source, thumb)
        display_sha = sha256_file(thumb)
        if display_sha != copied_sha:
            raise RuntimeError(f"display copy hash mismatch: {source}")
        with Image.open(thumb) as image:
            width, height = image.size
        if max(width, height) > MAX_DIM:
            raise RuntimeError(f"preserved display image exceeds {MAX_DIM}px: {source}")
    else:
        width, height = _thumbnail(source, thumb)
    thumb_sha = sha256_file(thumb)
    asset_rev = hashlib.sha256((thumb_sha + copied_sha).encode("ascii")).hexdigest()[:16]
    return {
        "entryId": entry_id,
        "image": thumb_name,
        "imageWidth": width,
        "imageHeight": height,
        "original": original_name,
        "images": [{"path": thumb_name, "original": original_name}],
        "assetRev": asset_rev,
    }


def write_asset_bundle_from_paths(task: dict[str, Any]) -> dict[str, Any]:
    """Write one codex entry backed by one or more source images.

    The first image keeps the entry ID as its basename.  Later images use the
    repository's established ``-02``, ``-03`` ... suffix convention.  Source
    adapters may attach schema fields such as ``rawTag`` or ``label`` to an
    individual image through ``imageFields`` without making this shared layer
    source-aware.
    """
    entry_id = str(task["entryId"])
    sources = list(task.get("sources") or [])
    if not sources:
        raise ValueError(f"asset bundle has no sources: {entry_id}")

    written: list[dict[str, Any]] = []
    for index, source in enumerate(sources):
        if not isinstance(source, dict):
            raise TypeError(f"asset bundle source must be an object: {entry_id}:{index + 1}")
        asset_id = entry_id if index == 0 else f"{entry_id}-{index + 1:02d}"
        asset = write_asset_from_path({
            "sourcePath": source["sourcePath"],
            "entryId": asset_id,
            "sha256": source.get("sha256", ""),
            "thumbDir": task["thumbDir"],
            "originalDir": task["originalDir"],
            "preserveDisplay": source.get("preserveDisplay", task.get("preserveDisplay", False)),
        })
        image = dict(asset["images"][0])
        image_fields = source.get("imageFields") or {}
        if not isinstance(image_fields, dict):
            raise TypeError(f"imageFields must be an object: {entry_id}:{index + 1}")
        image.update({key: value for key, value in image_fields.items() if value not in (None, "")})
        written.append({**asset, "imageItem": image})

    first = written[0]
    revisions = [str(item["assetRev"]) for item in written]
    bundle_rev = (
        revisions[0]
        if len(revisions) == 1
        else hashlib.sha256("\n".join(revisions).encode("ascii")).hexdigest()[:16]
    )
    return {
        "entryId": entry_id,
        "image": first["image"],
        "imageWidth": first["imageWidth"],
        "imageHeight": first["imageHeight"],
        "original": first["original"],
        "images": [item["imageItem"] for item in written],
        "assetRev": bundle_rev,
    }


def validate_asset(entry: dict[str, Any], thumb_dir: Path, original_dir: Path) -> list[str]:
    issues: list[str] = []
    entry_id = str(entry.get("id") or "")
    image_items = entry.get("images") or []
    if not isinstance(image_items, list) or not image_items:
        image_items = [{"path": entry.get("image"), "original": entry.get("original")}]
    else:
        first = image_items[0] if isinstance(image_items[0], dict) else {}
        if first.get("path") != entry.get("image"):
            issues.append(f"{entry_id}:primary_thumb_mismatch")
        if first.get("original") != entry.get("original"):
            issues.append(f"{entry_id}:primary_original_mismatch")

    seen_thumbs: set[str] = set()
    seen_originals: set[str] = set()
    for index, item in enumerate(image_items, 1):
        label = entry_id if index == 1 else f"{entry_id}[{index}]"
        if not isinstance(item, dict):
            issues.append(f"{label}:bad_image_item")
            continue
        thumb_name = str(item.get("path") or "")
        original_name = str(item.get("original") or "")
        if not thumb_name or thumb_name in seen_thumbs:
            issues.append(f"{label}:missing_or_duplicate_thumb_name")
        if not original_name or original_name in seen_originals:
            issues.append(f"{label}:missing_or_duplicate_original_name")
        seen_thumbs.add(thumb_name)
        seen_originals.add(original_name)
        thumb = thumb_dir / thumb_name
        original = original_dir / original_name
        if not thumb.is_file():
            issues.append(f"{label}:missing_thumb")
        if not original.is_file():
            issues.append(f"{label}:missing_original")
        if thumb.is_file():
            try:
                with Image.open(thumb) as image:
                    if index == 1 and image.size != (entry.get("imageWidth"), entry.get("imageHeight")):
                        issues.append(f"{label}:thumb_dimensions")
                    if max(image.size) > MAX_DIM:
                        issues.append(f"{label}:thumb_too_large")
            except Exception as exc:
                issues.append(f"{label}:thumb_unreadable:{type(exc).__name__}")
        if original.is_file():
            try:
                with Image.open(original) as image:
                    image.verify()
            except Exception as exc:
                issues.append(f"{label}:original_unreadable:{type(exc).__name__}")
    return issues


def write_json(path: Path, payload: Any, *, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            payload,
            ensure_ascii=False,
            indent=None if compact else 2,
            separators=(",", ":") if compact else None,
        ) + "\n",
        encoding="utf-8",
    )
