#!/usr/bin/env python3
"""Apply reviewed NAI candidates to the formal ``suozhang`` codex.

Default mode is a read-only dry-run.  ``--apply`` preserves each chosen PNG
byte-for-byte as the original, creates the standard <=1100 px JPEG thumbnail,
updates the codex/image counts, and writes a complete audit report below the
staging batch.  Formal assets are installed only after every source and staged
output validates successfully.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image

from nai_api_test_generate import inspect_image, load_json
from nai_api_verify_batch import sha256_file, verify_batch


ROOT = Path(__file__).resolve().parents[1]
CODEX_ID = "suozhang"
CODEX_PATH = ROOT / "site" / "data" / f"{CODEX_ID}.json"
INDEX_PATH = ROOT / "site" / "data" / "codexes.json"
THUMB_DIR = ROOT / "site" / "images" / CODEX_ID
ORIGINAL_DIR = ROOT / "originals" / CODEX_ID
MAX_DIMENSION = 1100
JPEG_QUALITY = 86


class ApplyError(RuntimeError):
    """A validation or atomic-apply failure."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-dir", type=Path, required=True)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="write formal images/data; omit for a read-only dry-run",
    )
    return parser.parse_args()


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def hash_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def asset_revision(thumb_hash: str, original_hash: str) -> str:
    digest = hashlib.sha256()
    digest.update(thumb_hash.encode("ascii"))
    digest.update(original_hash.encode("ascii"))
    return digest.hexdigest()[:16]


def render_json_like(path: Path, value: Any) -> bytes:
    before = path.read_text(encoding="utf-8")
    kwargs: dict[str, Any] = {"ensure_ascii": False}
    if before.startswith('{"id":"') or before.startswith("[{"):
        kwargs["separators"] = (",", ":")
    rendered = json.dumps(value, **kwargs)
    if before.endswith("\n"):
        rendered += "\n"
    return rendered.encode("utf-8")


def replace_index_counts(
    source: str,
    *,
    codex_id: str,
    entry_count: int,
    imaged_count: int,
) -> str:
    id_pos = source.find(f'"id": "{codex_id}"')
    if id_pos < 0:
        raise ApplyError(f"codexes.json has no {codex_id!r} item")
    start = source.rfind("  {", 0, id_pos)
    end = source.find("\n  }", id_pos)
    if start < 0 or end < 0:
        raise ApplyError(f"cannot isolate codexes.json block for {codex_id}")
    end += len("\n  }")
    block = source[start:end]
    replaced, entry_replacements = re.subn(
        r'("entryCount":\s*)\d+',
        lambda match: match.group(1) + str(entry_count),
        block,
        count=1,
    )
    replaced, image_replacements = re.subn(
        r'("imagedCount":\s*)\d+',
        lambda match: match.group(1) + str(imaged_count),
        replaced,
        count=1,
    )
    if entry_replacements != 1 or image_replacements != 1:
        raise ApplyError(f"cannot update counts for {codex_id}")
    return source[:start] + replaced + source[end:]


def atomic_write(path: Path, value: bytes) -> None:
    temporary = path.with_suffix(path.suffix + ".nai-import.tmp")
    temporary.write_bytes(value)
    os.replace(temporary, path)


def selection_records(batch_dir: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    plan_path = batch_dir / "plan.json"
    selections_path = batch_dir / "selections.json"
    manifest_path = batch_dir / "manifest.json"
    for path in (plan_path, selections_path, manifest_path):
        if not path.is_file():
            raise ApplyError(f"required batch file is absent: {path}")
    plan = load_json(plan_path)
    selections_document = load_json(selections_path)
    manifest = load_json(manifest_path)
    planned_entries = list(plan.get("entries") or [])
    planned_ids = {str(entry["id"]) for entry in planned_entries}
    selections = dict(selections_document.get("selections") or {})
    if set(selections) != planned_ids:
        raise ApplyError("selection IDs do not exactly match plan IDs")
    if int(plan.get("entryCount", -1)) != len(planned_entries):
        raise ApplyError("plan entryCount does not match entries")
    if int(plan.get("nSamples", 0)) != 2:
        raise ApplyError("formal apply requires exactly two candidates per entry")
    if len(planned_entries) != 154:
        raise ApplyError(f"expected 154 planned entries, found {len(planned_entries)}")
    if any(not bool(selections[entry_id].get("reviewed")) for entry_id in planned_ids):
        raise ApplyError("not every planned entry has been reviewed")

    records: list[dict[str, Any]] = []
    chosen_hashes: set[str] = set()
    results = dict(manifest.get("results") or {})
    for planned in planned_entries:
        entry_id = str(planned["id"])
        selection = selections[entry_id]
        choice = selection.get("choice")
        if choice not in {1, 2}:
            raise ApplyError(f"{entry_id}: invalid choice {choice!r}")
        result = results.get(entry_id) or {}
        images = list(result.get("images") or [])
        if result.get("status") != "verified" or len(images) != 2:
            raise ApplyError(f"{entry_id}: generation result is not verified")
        image_record = images[int(choice) - 1]
        filename = Path(str(image_record.get("file", ""))).name
        if not filename or filename != image_record.get("file"):
            raise ApplyError(f"{entry_id}: unsafe candidate filename")
        source_path = batch_dir / "entries" / entry_id / filename
        if not source_path.is_file():
            raise ApplyError(f"{entry_id}: chosen candidate is absent")
        source_hash = sha256_file(source_path)
        if source_hash != image_record.get("sha256"):
            raise ApplyError(f"{entry_id}: chosen candidate hash mismatch")
        if source_hash in chosen_hashes:
            raise ApplyError(f"{entry_id}: chosen candidate duplicates another choice")
        chosen_hashes.add(source_hash)
        records.append(
            {
                "id": entry_id,
                "title": planned.get("title"),
                "path": planned.get("path") or [],
                "tags": planned.get("tags") or "",
                "choice": int(choice),
                "reviewedAt": selection.get("updatedAt"),
                "source": source_path,
                "sourceRelative": str(source_path.relative_to(batch_dir)),
                "sourceSha256": source_hash,
            }
        )
    return plan, records


def validate_preconditions(
    batch_dir: Path,
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    verification = verify_batch(batch_dir, batch_dir / "verification.json")
    if verification.get("status") != "passed":
        preview = "; ".join((verification.get("issues") or [])[:5])
        raise ApplyError(f"independent batch verification failed: {preview}")
    plan, records = selection_records(batch_dir)
    planned_codex = Path(plan["codex"]).resolve()
    if planned_codex != CODEX_PATH.resolve():
        raise ApplyError(f"plan targets unexpected codex: {planned_codex}")
    if sha256_file(CODEX_PATH) != plan.get("codexSha256"):
        raise ApplyError("formal suozhang.json changed after batch planning")

    codex = load_json(CODEX_PATH)
    current = {str(entry["id"]): entry for entry in codex.get("entries") or []}
    for record in records:
        entry_id = record["id"]
        entry = current.get(entry_id)
        if not entry:
            raise ApplyError(f"{entry_id}: formal entry is absent")
        if entry.get("tags") != record["tags"]:
            raise ApplyError(f"{entry_id}: formal tags changed after planning")
        if entry.get("image") or entry.get("original") or entry.get("images"):
            raise ApplyError(f"{entry_id}: formal entry already has image data")
        if not entry.get("isNew"):
            raise ApplyError(f"{entry_id}: formal entry is no longer marked isNew")
        thumb_path = THUMB_DIR / f"{entry_id}.jpg"
        original_path = ORIGINAL_DIR / f"{entry_id}.png"
        if thumb_path.exists():
            raise ApplyError(f"{entry_id}: target thumbnail already exists")
        if original_path.exists():
            raise ApplyError(f"{entry_id}: target original already exists")

    return plan, records, codex


def dry_run_summary(
    batch_dir: Path,
    plan: dict[str, Any],
    records: list[dict[str, Any]],
    codex: dict[str, Any],
) -> dict[str, Any]:
    choice_one = sum(record["choice"] == 1 for record in records)
    choice_two = sum(record["choice"] == 2 for record in records)
    before_imaged = sum(
        bool(entry.get("image"))
        for entry in codex.get("entries") or []
    )
    return {
        "checkedAt": now_iso(),
        "status": "ready",
        "mode": "dry-run",
        "batch": str(batch_dir),
        "codex": str(CODEX_PATH),
        "entryCount": int(codex.get("entryCount", len(codex.get("entries") or []))),
        "selectedEntries": len(records),
        "choiceOne": choice_one,
        "choiceTwo": choice_two,
        "imagedCountBefore": before_imaged,
        "imagedCountAfter": before_imaged + len(records),
        "originalsToAdd": len(records),
        "thumbnailsToAdd": len(records),
        "sourceBytes": sum(record["source"].stat().st_size for record in records),
        "templateSha256": plan.get("templateSha256"),
        "codexSha256": plan.get("codexSha256"),
        "conflicts": 0,
    }


def remove_empty_tree(path: Path, stop: Path) -> None:
    current = path
    while current != stop and current.exists():
        try:
            current.rmdir()
        except OSError:
            break
        current = current.parent


def apply_batch(
    batch_dir: Path,
    plan: dict[str, Any],
    records: list[dict[str, Any]],
    codex: dict[str, Any],
) -> dict[str, Any]:
    apply_dir = batch_dir / "formal-apply"
    if apply_dir.exists():
        raise ApplyError(
            f"formal apply directory already exists; refusing a second apply: {apply_dir}"
        )
    staging = apply_dir / "staging"
    stage_thumbs = staging / "site" / "images" / CODEX_ID
    stage_originals = staging / "originals" / CODEX_ID
    backups = apply_dir / "backups"
    stage_thumbs.mkdir(parents=True)
    stage_originals.mkdir(parents=True)
    backups.mkdir(parents=True)
    shutil.copy2(CODEX_PATH, backups / CODEX_PATH.name)
    shutil.copy2(INDEX_PATH, backups / INDEX_PATH.name)

    entries_by_id = {
        str(entry["id"]): entry
        for entry in codex.get("entries") or []
    }
    audit: list[dict[str, Any]] = []
    for record in records:
        entry_id = record["id"]
        raw = record["source"].read_bytes()
        if hash_bytes(raw) != record["sourceSha256"]:
            raise ApplyError(f"{entry_id}: source changed during apply")
        info = inspect_image(raw)
        if (
            info.get("format") != "PNG"
            or info.get("width") != 832
            or info.get("height") != 1216
            or not info.get("signedHash")
        ):
            raise ApplyError(f"{entry_id}: selected source failed final PNG validation")

        original_name = f"{entry_id}.png"
        thumb_name = f"{entry_id}.jpg"
        staged_original = stage_originals / original_name
        staged_thumb = stage_thumbs / thumb_name
        staged_original.write_bytes(raw)
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            if image.mode not in ("RGB", "L"):
                image = image.convert("RGB")
            image.thumbnail(
                (MAX_DIMENSION, MAX_DIMENSION),
                Image.Resampling.LANCZOS,
            )
            thumb_width, thumb_height = image.size
            image.save(
                staged_thumb,
                "JPEG",
                quality=JPEG_QUALITY,
                optimize=True,
            )
        with Image.open(staged_thumb) as thumbnail:
            thumbnail.load()
            if thumbnail.format != "JPEG" or thumbnail.size != (
                thumb_width,
                thumb_height,
            ):
                raise ApplyError(f"{entry_id}: staged thumbnail validation failed")
        if sha256_file(staged_original) != record["sourceSha256"]:
            raise ApplyError(f"{entry_id}: staged original is not byte-identical")
        thumb_hash = sha256_file(staged_thumb)
        revision = asset_revision(thumb_hash, record["sourceSha256"])
        entry = entries_by_id[entry_id]
        entry["image"] = thumb_name
        entry["imageWidth"] = thumb_width
        entry["imageHeight"] = thumb_height
        entry["original"] = original_name
        entry["assetRev"] = revision
        entry.pop("assetCodexId", None)
        audit.append(
            {
                "id": entry_id,
                "title": record["title"],
                "path": record["path"],
                "choice": record["choice"],
                "reviewedAt": record["reviewedAt"],
                "candidate": record["sourceRelative"],
                "candidateSha256": record["sourceSha256"],
                "thumbnail": thumb_name,
                "thumbnailSha256": thumb_hash,
                "thumbnailBytes": staged_thumb.stat().st_size,
                "thumbnailWidth": thumb_width,
                "thumbnailHeight": thumb_height,
                "original": original_name,
                "originalBytes": len(raw),
                "assetRev": revision,
            }
        )

    codex["imagedCount"] = sum(
        bool(entry.get("image"))
        for entry in codex.get("entries") or []
    )
    expected_imaged = 5046 + len(records)
    if codex["imagedCount"] != expected_imaged:
        raise ApplyError(
            f"unexpected target imagedCount: {codex['imagedCount']} != {expected_imaged}"
        )
    codex_bytes = render_json_like(CODEX_PATH, codex)
    parsed_codex = json.loads(codex_bytes)
    if parsed_codex.get("imagedCount") != expected_imaged:
        raise ApplyError("rendered codex did not preserve target imagedCount")
    index_before = INDEX_PATH.read_text(encoding="utf-8")
    index_after = replace_index_counts(
        index_before,
        codex_id=CODEX_ID,
        entry_count=int(codex.get("entryCount", len(codex.get("entries") or []))),
        imaged_count=expected_imaged,
    )
    json.loads(index_after)
    (apply_dir / "suozhang.preview.json").write_bytes(codex_bytes)
    (apply_dir / "codexes.preview.json").write_text(
        index_after,
        encoding="utf-8",
    )

    report: dict[str, Any] = {
        "appliedAt": None,
        "status": "staged",
        "batch": str(batch_dir),
        "codex": str(CODEX_PATH),
        "selectedEntries": len(records),
        "choiceOne": sum(record["choice"] == 1 for record in records),
        "choiceTwo": sum(record["choice"] == 2 for record in records),
        "imagedCountBefore": 5046,
        "imagedCountAfter": expected_imaged,
        "originalsAdded": len(records),
        "thumbnailsAdded": len(records),
        "templateSha256": plan.get("templateSha256"),
        "codexSha256Before": plan.get("codexSha256"),
        "entries": audit,
    }
    write_json(apply_dir / "apply-report.json", report)

    placed: list[Path] = []
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    ORIGINAL_DIR.mkdir(parents=True, exist_ok=True)
    try:
        for item in audit:
            staged_original = stage_originals / item["original"]
            final_original = ORIGINAL_DIR / item["original"]
            staged_thumb = stage_thumbs / item["thumbnail"]
            final_thumb = THUMB_DIR / item["thumbnail"]
            if final_original.exists() or final_thumb.exists():
                raise ApplyError(f"{item['id']}: target appeared during apply")
            os.replace(staged_original, final_original)
            placed.append(final_original)
            os.replace(staged_thumb, final_thumb)
            placed.append(final_thumb)

        atomic_write(CODEX_PATH, codex_bytes)
        atomic_write(INDEX_PATH, index_after.encode("utf-8"))
    except Exception:
        shutil.copy2(backups / CODEX_PATH.name, CODEX_PATH)
        shutil.copy2(backups / INDEX_PATH.name, INDEX_PATH)
        for path in reversed(placed):
            try:
                path.unlink()
            except FileNotFoundError:
                pass
        raise

    report["status"] = "applied"
    report["appliedAt"] = now_iso()
    report["codexSha256After"] = sha256_file(CODEX_PATH)
    report["thumbnailBytes"] = sum(item["thumbnailBytes"] for item in audit)
    report["originalBytes"] = sum(item["originalBytes"] for item in audit)
    write_json(apply_dir / "apply-report.json", report)
    remove_empty_tree(stage_thumbs, apply_dir)
    remove_empty_tree(stage_originals, apply_dir)
    return report


def main() -> int:
    args = parse_args()
    batch_dir = args.batch_dir.resolve()
    try:
        plan, records, codex = validate_preconditions(batch_dir)
        summary = dry_run_summary(batch_dir, plan, records, codex)
        if not args.apply:
            report_path = batch_dir / "apply-dry-run.json"
            write_json(report_path, summary)
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            print(f"report: {report_path}")
            return 0

        result = apply_batch(batch_dir, plan, records, codex)
        print(
            json.dumps(
                {
                    key: result[key]
                    for key in (
                        "status",
                        "selectedEntries",
                        "choiceOne",
                        "choiceTwo",
                        "imagedCountBefore",
                        "imagedCountAfter",
                        "originalsAdded",
                        "thumbnailsAdded",
                        "originalBytes",
                        "thumbnailBytes",
                    )
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        print(f"report: {batch_dir / 'formal-apply' / 'apply-report.json'}")
        return 0
    except ApplyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
