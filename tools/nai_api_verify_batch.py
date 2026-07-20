#!/usr/bin/env python3
"""Independently verify a staged NAI candidate-image batch.

This verifier reopens every generated image and compares its real PNG metadata
and bytes against the frozen plan/request.  It does not trust the generation
manifest's existing ``verified`` status and never changes formal site data.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from nai_api_test_generate import (
    compose_prompt,
    inspect_image,
    load_json,
    load_template,
)


TOKEN_PATTERN = re.compile(r"nai_(?!api_)[A-Za-z0-9_-]{20,}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-dir", type=Path, required=True)
    parser.add_argument(
        "--report",
        type=Path,
        help="default: <batch-dir>/verification.json",
    )
    parser.add_argument(
        "--allow-applied-codex",
        action="store_true",
        help=(
            "after formal apply, accept the immutable pre-apply backup as the "
            "frozen codex hash source"
        ),
    )
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def add_issue(
    issues: list[str],
    condition: bool,
    message: str,
) -> None:
    if not condition:
        issues.append(message)


def scan_text_for_token(batch_dir: Path, report_path: Path) -> list[str]:
    matches: list[str] = []
    allowed_suffixes = {".json", ".md", ".txt", ".html", ".py"}
    for path in batch_dir.rglob("*"):
        if (
            not path.is_file()
            or path == report_path
            or path.suffix.lower() not in allowed_suffixes
        ):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if TOKEN_PATTERN.search(text):
            matches.append(str(path.relative_to(batch_dir)))
    return matches


def verify_batch(
    batch_dir: Path,
    report_path: Path,
    *,
    allow_applied_codex: bool = False,
) -> dict[str, Any]:
    issues: list[str] = []
    plan_path = batch_dir / "plan.json"
    manifest_path = batch_dir / "manifest.json"
    add_issue(issues, plan_path.is_file(), "plan.json is absent")
    add_issue(issues, manifest_path.is_file(), "manifest.json is absent")
    if issues:
        return {"status": "failed", "issues": issues}

    plan = load_json(plan_path)
    manifest = load_json(manifest_path)
    entries = list(plan.get("entries") or [])
    planned_ids = [str(entry.get("id")) for entry in entries]
    result_map = dict(manifest.get("results") or {})
    template_path = Path(plan["templateImage"])
    codex_path = Path(plan["codex"])

    add_issue(
        issues,
        int(plan.get("entryCount", -1)) == len(entries),
        "plan entryCount does not match entries",
    )
    add_issue(
        issues,
        len(planned_ids) == len(set(planned_ids)),
        "plan contains duplicate entry IDs",
    )
    add_issue(
        issues,
        set(result_map) == set(planned_ids),
        "manifest result IDs do not exactly match the plan",
    )
    add_issue(
        issues,
        template_path.is_file(),
        "template image is absent",
    )
    add_issue(
        issues,
        codex_path.is_file(),
        "codex file is absent",
    )
    if template_path.is_file():
        add_issue(
            issues,
            sha256_file(template_path) == plan.get("templateSha256"),
            "template hash changed after planning",
        )
    if codex_path.is_file():
        current_codex_matches = (
            sha256_file(codex_path) == plan.get("codexSha256")
        )
        if current_codex_matches:
            pass
        elif allow_applied_codex:
            backup_path = (
                batch_dir
                / "formal-apply"
                / "backups"
                / codex_path.name
            )
            add_issue(
                issues,
                backup_path.is_file()
                and sha256_file(backup_path) == plan.get("codexSha256"),
                "current codex changed and pre-apply backup does not match plan",
            )
        else:
            issues.append("codex hash changed after planning")

    if not template_path.is_file():
        return {"status": "failed", "issues": issues}
    template = load_template(template_path)
    expected_negative = str(template["uc"]).strip()
    expected_source = template.get("_source")
    n_samples = int(plan.get("nSamples", 0))
    add_issue(issues, n_samples == 2, "batch does not have two samples per entry")

    hashes: dict[str, str] = {}
    expected_image_paths: set[Path] = set()
    total_bytes = 0
    verified_entries = 0
    verified_images = 0

    for planned in entries:
        entry_id = str(planned["id"])
        prefix = f"{entry_id}: "
        entry_dir = batch_dir / "entries" / entry_id
        request_path = entry_dir / "request.json"
        result_path = entry_dir / "result.json"
        if not request_path.is_file():
            issues.append(prefix + "request.json is absent")
            continue
        if not result_path.is_file():
            issues.append(prefix + "result.json is absent")
            continue
        request = load_json(request_path)
        result = load_json(result_path)
        payload = request.get("payload") or {}
        parameters = payload.get("parameters") or {}
        expected_prompt = compose_prompt(
            str(template["prompt"]),
            str(planned.get("tags", "")),
        )

        add_issue(
            issues,
            (request.get("entry") or {}).get("id") == entry_id,
            prefix + "request entry ID mismatch",
        )
        add_issue(
            issues,
            payload.get("input") == expected_prompt,
            prefix + "request prompt differs from template + planned tags",
        )
        add_issue(
            issues,
            payload.get("model") == "nai-diffusion-4-5-full",
            prefix + "unexpected model",
        )
        add_issue(
            issues,
            payload.get("action") == "generate",
            prefix + "unexpected action",
        )
        add_issue(
            issues,
            str(parameters.get("negative_prompt", "")).strip()
            == expected_negative,
            prefix + "request negative prompt differs from template",
        )
        add_issue(
            issues,
            parameters.get("n_samples") == n_samples,
            prefix + "request sample count mismatch",
        )
        add_issue(
            issues,
            parameters.get("width") == int(template["width"])
            and parameters.get("height") == int(template["height"]),
            prefix + "request dimensions mismatch",
        )
        add_issue(
            issues,
            parameters.get("steps") == int(template["steps"]),
            prefix + "request steps mismatch",
        )
        add_issue(
            issues,
            parameters.get("scale") == float(template["scale"]),
            prefix + "request scale mismatch",
        )
        add_issue(
            issues,
            parameters.get("sampler") == str(template["sampler"]),
            prefix + "request sampler mismatch",
        )
        add_issue(
            issues,
            parameters.get("noise_schedule")
            == str(template.get("noise_schedule", "karras")),
            prefix + "request noise schedule mismatch",
        )
        add_issue(
            issues,
            parameters.get("use_coords") is False
            and (parameters.get("v4_prompt") or {}).get("use_coords") is False,
            prefix + "coordinates are not disabled for empty character prompts",
        )
        for rejected_field in ("controlnet_strength", "sm", "sm_dyn"):
            add_issue(
                issues,
                rejected_field not in parameters,
                prefix + f"incompatible field persisted: {rejected_field}",
            )

        result_images = list(result.get("images") or [])
        entry_issue_count = len(issues)
        add_issue(
            issues,
            result.get("status") == "verified",
            prefix + f"result status is {result.get('status')!r}",
        )
        add_issue(
            issues,
            len(result_images) == n_samples,
            prefix + f"expected {n_samples} result images",
        )
        seed = parameters.get("seed")
        add_issue(
            issues,
            isinstance(seed, int) and 1 <= seed <= 4_294_967_288,
            prefix + "request seed is invalid",
        )

        for index, image_record in enumerate(result_images, 1):
            filename = Path(str(image_record.get("file", ""))).name
            image_prefix = prefix + f"image {index}: "
            add_issue(
                issues,
                filename == image_record.get("file") and bool(filename),
                image_prefix + "unsafe or empty filename",
            )
            path = entry_dir / filename
            expected_image_paths.add(path.resolve())
            if not path.is_file():
                issues.append(image_prefix + "file is absent")
                continue
            blob_size = path.stat().st_size
            total_bytes += blob_size
            digest = sha256_file(path)
            prior = hashes.get(digest)
            if prior:
                issues.append(
                    image_prefix
                    + f"duplicate SHA-256 also used by {prior}"
                )
            else:
                hashes[digest] = f"{entry_id}/{filename}"
            add_issue(
                issues,
                image_record.get("sha256") == digest,
                image_prefix + "stored SHA-256 mismatch",
            )
            add_issue(
                issues,
                image_record.get("bytes") == blob_size,
                image_prefix + "stored byte count mismatch",
            )
            add_issue(
                issues,
                not (image_record.get("issues") or []),
                image_prefix + "generation-time issues are not empty",
            )
            try:
                info = inspect_image(path.read_bytes())
            except Exception as exc:
                issues.append(image_prefix + f"cannot inspect image: {exc}")
                continue
            add_issue(
                issues,
                info.get("format") == "PNG",
                image_prefix + "format is not PNG",
            )
            add_issue(
                issues,
                (info.get("width"), info.get("height"))
                == (int(template["width"]), int(template["height"])),
                image_prefix + "dimensions mismatch",
            )
            add_issue(
                issues,
                info.get("source") == expected_source,
                image_prefix + "source metadata mismatch",
            )
            add_issue(
                issues,
                info.get("prompt") == expected_prompt,
                image_prefix + "embedded prompt mismatch",
            )
            add_issue(
                issues,
                str(info.get("negative", "")).strip() == expected_negative,
                image_prefix + "embedded negative prompt mismatch",
            )
            for key in ("steps", "scale", "sampler"):
                add_issue(
                    issues,
                    info.get(key) == parameters.get(key),
                    image_prefix + f"embedded {key} mismatch",
                )
            add_issue(
                issues,
                info.get("seed") == seed + index - 1,
                image_prefix + "embedded seed mismatch",
            )
            add_issue(
                issues,
                bool(info.get("signedHash")),
                image_prefix + "signed_hash is absent",
            )
            verified_images += 1
        if len(issues) == entry_issue_count:
            verified_entries += 1

    actual_image_paths = {
        path.resolve()
        for path in (batch_dir / "entries").rglob("*")
        if path.is_file() and path.suffix.lower() in {".png", ".webp", ".jpg", ".jpeg"}
    }
    extra_images = sorted(actual_image_paths - expected_image_paths)
    missing_images = sorted(expected_image_paths - actual_image_paths)
    for path in extra_images:
        issues.append(
            "unregistered image file: "
            + str(path.relative_to(batch_dir.resolve()))
        )
    for path in missing_images:
        issues.append(
            "registered image file absent: "
            + str(path.relative_to(batch_dir.resolve()))
        )

    counts = manifest.get("counts") or {}
    add_issue(
        issues,
        counts.get("completed") == len(entries),
        "manifest completed count mismatch",
    )
    add_issue(
        issues,
        counts.get("verified") == len(entries),
        "manifest verified count mismatch",
    )
    add_issue(
        issues,
        counts.get("review") == 0,
        "manifest metadata-review count is not zero",
    )
    add_issue(
        issues,
        counts.get("failed") == 0,
        "manifest failed count is not zero",
    )
    add_issue(
        issues,
        counts.get("images") == len(entries) * n_samples,
        "manifest image count mismatch",
    )
    token_files = scan_text_for_token(batch_dir, report_path)
    for relative_path in token_files:
        issues.append(f"API-token-shaped text found in {relative_path}")

    return {
        "verifiedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "batch": str(batch_dir),
        "status": "passed" if not issues else "failed",
        "expected": {
            "entries": len(entries),
            "images": len(entries) * n_samples,
            "width": int(template["width"]),
            "height": int(template["height"]),
            "source": expected_source,
        },
        "actual": {
            "verifiedEntries": verified_entries,
            "verifiedImages": verified_images,
            "uniqueImageHashes": len(hashes),
            "totalBytes": total_bytes,
            "extraImages": len(extra_images),
            "missingImages": len(missing_images),
            "tokenFiles": len(token_files),
        },
        "issues": issues,
    }


def main() -> int:
    args = parse_args()
    batch_dir = args.batch_dir.resolve()
    report_path = (
        args.report.resolve()
        if args.report
        else batch_dir / "verification.json"
    )
    report = verify_batch(
        batch_dir,
        report_path,
        allow_applied_codex=args.allow_applied_codex,
    )
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"report: {report_path}")
    return 0 if report.get("status") == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
