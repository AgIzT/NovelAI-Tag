"""Import PieDriver's W.O.F NovelAI 4.5 artist-string image pack.

The source contains PNGs named from truncated prompts. The complete reusable
artist string is recovered from NovelAI's PNG Description metadata. Images
with the same Description become a single multi-image entry.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
from collections import OrderedDict
from pathlib import Path
from typing import Any

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "site" / "data"
IMAGE_ROOT = ROOT / "site" / "images"
ORIGINAL_ROOT = ROOT / "originals"
OUTPUT_DIR = ROOT / "output"
MAX_DIM = 1100

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
        if digest in seen_hashes:
            duplicate_hashes.append({"sha256": digest, "first": seen_hashes[digest], "duplicate": path.name})
            continue
        seen_hashes[digest] = path.name

        groups.setdefault(prompt, []).append({
            "source": path,
            "fullPrompt": full_prompt,
            "sha256": digest,
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
        "contentReview": "用户已视觉检查，确认例图无 NSFW 级内容；全量收录且不做条目级 NSFW 标记。",
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
                "path": ["W.O.F_画风"],
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
        "source": f"{args.author} · W.O.F_画风",
        "contributors": [{"name": args.author, "role": "词条整理 / 配图数据提供"}],
        "tree": [{"name": "W.O.F_画风", "count": len(entries), "children": []}],
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


def validate_import(codex_id: str) -> dict[str, Any]:
    data_path = DATA_DIR / f"{codex_id}.json"
    data = json.loads(data_path.read_text(encoding="utf-8"))
    entries = [
        entry
        for entry in (data.get("entries") or [])
        if entry.get("path") == ["W.O.F_画风"]
    ]
    ids: set[str] = set()
    checked_images = 0
    mismatches: list[str] = []
    for entry in entries:
        entry_id = str(entry.get("id") or "")
        if not entry_id or entry_id in ids:
            mismatches.append(f"duplicate or empty entry id: {entry_id!r}")
        ids.add(entry_id)
        if entry.get("path") != ["W.O.F_画风"]:
            mismatches.append(f"bad path: {entry_id}")
        images = entry.get("images") or []
        for image in images:
            thumb = IMAGE_ROOT / codex_id / str(image.get("path") or "")
            original = ORIGINAL_ROOT / codex_id / str(image.get("original") or "")
            if not thumb.is_file() or not original.is_file():
                mismatches.append(f"missing asset: {entry_id}:{image}")
                continue
            metadata_prompt = style_prompt(extract_image_metadata(original))
            if metadata_prompt != entry.get("tags"):
                mismatches.append(f"prompt mismatch: {entry_id}:{original.name}")
            checked_images += 1
        if images:
            with Image.open(IMAGE_ROOT / codex_id / images[0]["path"]) as primary:
                if primary.size != (entry.get("imageWidth"), entry.get("imageHeight")):
                    mismatches.append(f"primary dimensions mismatch: {entry_id}")
    if mismatches:
        raise RuntimeError("\n".join(mismatches[:50]))
    return {
        "codexId": codex_id,
        "entries": len(entries),
        "images": checked_images,
        "uniqueIds": len(ids),
        "promptMismatches": 0,
        "missingAssets": 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path(r"D:\program\NOVEL\新数据\W.O.F_画风_2026.7.10\画风"))
    parser.add_argument("--codex-id", default="artist_nai45_strings")
    parser.add_argument("--title", default="NovelAI4.5画师串词典")
    parser.add_argument("--author", default="PieDriver")
    parser.add_argument("--version", default="2026.7.10")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()

    if args.validate:
        print(json.dumps(validate_import(args.codex_id), ensure_ascii=False, indent=2))
        return 0

    groups, report = scan_source(args.source)
    report.update({
        "codexId": args.codex_id,
        "title": args.title,
        "author": args.author,
        "version": args.version,
        "category": "W.O.F_画风",
        "applied": bool(args.apply),
    })
    if args.apply:
        data_path = DATA_DIR / f"{args.codex_id}.json"
        if data_path.exists():
            raise RuntimeError(f"data target already exists: {data_path}")
        entries = write_assets(groups, args.codex_id)
        codex = codex_payload(args, entries)
        write_json(data_path, codex, compact=True)
        update_index(codex)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = OUTPUT_DIR / "wof_artist_strings_import_report.json"
    write_json(report_path, report)
    print(json.dumps({**report, "report": str(report_path)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
