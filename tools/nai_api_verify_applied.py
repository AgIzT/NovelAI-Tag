#!/usr/bin/env python3
"""Verify a reviewed NAI batch after formal local application."""

from __future__ import annotations

import argparse
import copy
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image

from nai_api_apply_selections import (
    CODEX_ID,
    CODEX_PATH,
    INDEX_PATH,
    ORIGINAL_DIR,
    THUMB_DIR,
    asset_revision,
    replace_index_counts,
)
from nai_api_test_generate import inspect_image, load_json
from nai_api_verify_batch import sha256_file


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-dir", type=Path, required=True)
    return parser.parse_args()


def verify(batch_dir: Path) -> dict[str, Any]:
    apply_dir = batch_dir / "formal-apply"
    report_path = apply_dir / "apply-report.json"
    before_codex_path = apply_dir / "backups" / CODEX_PATH.name
    before_index_path = apply_dir / "backups" / INDEX_PATH.name
    issues: list[str] = []
    for path in (report_path, before_codex_path, before_index_path):
        if not path.is_file():
            issues.append(f"missing apply artifact: {path}")
    if issues:
        return {"status": "failed", "issues": issues}

    report = load_json(report_path)
    before = load_json(before_codex_path)
    after = load_json(CODEX_PATH)
    before_entries = list(before.get("entries") or [])
    after_entries = list(after.get("entries") or [])
    before_by_id = {str(entry["id"]): entry for entry in before_entries}
    after_by_id = {str(entry["id"]): entry for entry in after_entries}
    audit = list(report.get("entries") or [])
    audit_by_id = {str(item["id"]): item for item in audit}
    target_ids = set(audit_by_id)

    if report.get("status") != "applied":
        issues.append("apply report status is not applied")
    if len(audit) != 154 or len(target_ids) != 154:
        issues.append("apply report does not contain 154 unique entries")
    if [entry["id"] for entry in before_entries] != [
        entry["id"] for entry in after_entries
    ]:
        issues.append("formal entry order or IDs changed")
    if set(before_by_id) != set(after_by_id):
        issues.append("formal entry ID set changed")

    before_root = {key: value for key, value in before.items() if key != "imagedCount"}
    after_root = {key: value for key, value in after.items() if key != "imagedCount"}
    before_root["entries"] = []
    after_root["entries"] = []
    if before_root != after_root:
        issues.append("non-count codex root metadata changed")
    if after.get("imagedCount") != 5200:
        issues.append(f"formal imagedCount is {after.get('imagedCount')}, expected 5200")
    computed_imaged = sum(bool(entry.get("image")) for entry in after_entries)
    if computed_imaged != 5200:
        issues.append(f"computed formal imagedCount is {computed_imaged}, expected 5200")

    original_hashes: set[str] = set()
    verified_entries = 0
    verified_originals = 0
    verified_thumbnails = 0
    for entry_id, before_entry in before_by_id.items():
        after_entry = after_by_id.get(entry_id)
        if after_entry is None:
            continue
        if entry_id not in target_ids:
            if after_entry != before_entry:
                issues.append(f"{entry_id}: non-target entry changed")
            continue

        item = audit_by_id[entry_id]
        expected = copy.deepcopy(before_entry)
        expected.update(
            {
                "image": item["thumbnail"],
                "imageWidth": item["thumbnailWidth"],
                "imageHeight": item["thumbnailHeight"],
                "original": item["original"],
                "assetRev": item["assetRev"],
            }
        )
        expected.pop("assetCodexId", None)
        entry_start_issues = len(issues)
        if after_entry != expected:
            issues.append(f"{entry_id}: formal entry fields differ from apply report")

        candidate = batch_dir / item["candidate"]
        original = ORIGINAL_DIR / item["original"]
        thumbnail = THUMB_DIR / item["thumbnail"]
        if not candidate.is_file():
            issues.append(f"{entry_id}: reviewed candidate is absent")
        if not original.is_file():
            issues.append(f"{entry_id}: formal original is absent")
        if not thumbnail.is_file():
            issues.append(f"{entry_id}: formal thumbnail is absent")
        if not candidate.is_file() or not original.is_file() or not thumbnail.is_file():
            continue

        candidate_hash = sha256_file(candidate)
        original_hash = sha256_file(original)
        thumbnail_hash = sha256_file(thumbnail)
        if candidate_hash != item["candidateSha256"]:
            issues.append(f"{entry_id}: reviewed candidate hash changed")
        if original_hash != candidate_hash:
            issues.append(f"{entry_id}: formal original is not byte-identical to choice")
        if original_hash in original_hashes:
            issues.append(f"{entry_id}: selected original duplicates another selected image")
        original_hashes.add(original_hash)
        if thumbnail_hash != item["thumbnailSha256"]:
            issues.append(f"{entry_id}: formal thumbnail hash differs from apply report")
        if asset_revision(thumbnail_hash, original_hash) != item["assetRev"]:
            issues.append(f"{entry_id}: assetRev does not match formal files")

        request_path = batch_dir / "entries" / entry_id / "request.json"
        request = load_json(request_path)
        payload = request["payload"]
        parameters = payload["parameters"]
        info = inspect_image(original.read_bytes())
        if info.get("format") != "PNG":
            issues.append(f"{entry_id}: formal original is not PNG")
        if (info.get("width"), info.get("height")) != (832, 1216):
            issues.append(f"{entry_id}: formal original dimensions mismatch")
        if info.get("prompt") != payload.get("input"):
            issues.append(f"{entry_id}: formal original prompt mismatch")
        if str(info.get("negative", "")).strip() != str(
            parameters.get("negative_prompt", "")
        ).strip():
            issues.append(f"{entry_id}: formal original negative prompt mismatch")
        for key in ("steps", "scale", "sampler"):
            if info.get(key) != parameters.get(key):
                issues.append(f"{entry_id}: formal original {key} mismatch")
        if not info.get("signedHash"):
            issues.append(f"{entry_id}: formal original signed_hash is absent")
        with Image.open(thumbnail) as image:
            image.load()
            if image.format != "JPEG":
                issues.append(f"{entry_id}: formal thumbnail is not JPEG")
            if image.size != (
                item["thumbnailWidth"],
                item["thumbnailHeight"],
            ):
                issues.append(f"{entry_id}: formal thumbnail dimensions mismatch")
        verified_originals += 1
        verified_thumbnails += 1
        if len(issues) == entry_start_issues:
            verified_entries += 1

    before_index = before_index_path.read_text(encoding="utf-8")
    expected_index = replace_index_counts(
        before_index,
        codex_id=CODEX_ID,
        entry_count=int(after.get("entryCount", len(after_entries))),
        imaged_count=5200,
    )
    current_index = INDEX_PATH.read_text(encoding="utf-8")
    if current_index != expected_index:
        issues.append("codexes.json has changes beyond the suozhang counts")
    index = load_json(INDEX_PATH)
    index_item = next(
        (item for item in index if item.get("id") == CODEX_ID),
        None,
    )
    if not index_item:
        issues.append("codexes.json has no suozhang item")
    elif (
        index_item.get("entryCount"),
        index_item.get("imagedCount"),
    ) != (5546, 5200):
        issues.append("codexes.json suozhang counts are not 5546 / 5200")

    return {
        "verifiedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "status": "passed" if not issues else "failed",
        "batch": str(batch_dir),
        "codex": str(CODEX_PATH),
        "actual": {
            "targetEntries": len(target_ids),
            "verifiedEntries": verified_entries,
            "verifiedOriginals": verified_originals,
            "verifiedThumbnails": verified_thumbnails,
            "uniqueOriginalHashes": len(original_hashes),
            "entryCount": after.get("entryCount"),
            "imagedCount": after.get("imagedCount"),
        },
        "issues": issues,
    }


def main() -> int:
    args = parse_args()
    batch_dir = args.batch_dir.resolve()
    result = verify(batch_dir)
    destination = batch_dir / "formal-apply" / "verification.json"
    destination.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"report: {destination}")
    return 0 if result.get("status") == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
