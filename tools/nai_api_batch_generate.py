#!/usr/bin/env python3
"""Plan and generate a resumable NovelAI API candidate-image batch.

This tool is deliberately staging-only:

- API credentials come from an environment variable and are never persisted.
- images and manifests are written below ``output/``;
- formal codex JSON, ``site/images/``, ``originals/`` and R2 are untouched.

Typical use::

    python tools/nai_api_batch_generate.py plan \
      --template-image C:\path\template.png \
      --output-dir output\nai-api-fill\batch \
      --exclude-top-path 各种风格

    python tools/nai_api_batch_generate.py generate \
      --batch-dir output\nai-api-fill\batch --workers 2 --retries 2
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any

from nai_api_test_generate import (
    DEFAULT_CODEX,
    GenerateError,
    build_payload,
    compose_prompt,
    extract_images,
    image_extension,
    load_json,
    load_template,
    post_generate,
    random_seed,
    safe_error_text,
    verify_generated,
)


ROOT = Path(__file__).resolve().parents[1]
WRITE_LOCK = threading.Lock()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    plan = subparsers.add_parser("plan", help="create a dry generation plan")
    plan.add_argument("--template-image", type=Path, required=True)
    plan.add_argument("--codex", type=Path, default=DEFAULT_CODEX)
    plan.add_argument("--output-dir", type=Path, required=True)
    plan.add_argument("--base-url", default="https://touhounai.xyz")
    plan.add_argument("--exclude-top-path", action="append", default=[])
    plan.add_argument("--n-samples", type=int, default=2)

    generate = subparsers.add_parser(
        "generate", help="generate or resume candidates from plan.json"
    )
    generate.add_argument("--batch-dir", type=Path, required=True)
    generate.add_argument("--api-key-env", default="NAI_API_KEY")
    generate.add_argument("--workers", type=int, default=2)
    generate.add_argument("--retries", type=int, default=2)
    generate.add_argument("--timeout", type=int, default=240)
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def write_json_atomic(path: Path, value: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary.replace(path)


def top_path(entry: dict[str, Any]) -> str:
    path = entry.get("path") or []
    return str(path[0]) if path else ""


def create_plan(args: argparse.Namespace) -> int:
    if not 1 <= args.n_samples <= 8:
        raise GenerateError("--n-samples must be between 1 and 8")
    template_path = args.template_image.resolve()
    codex_path = args.codex.resolve()
    template = load_template(template_path)
    codex = load_json(codex_path)
    excluded = set(args.exclude_top_path)
    selected = []
    excluded_entries = []
    for entry in codex.get("entries", []):
        if not entry.get("isNew"):
            continue
        if entry.get("image") or entry.get("images"):
            continue
        record = {
            "id": entry["id"],
            "title": entry.get("title"),
            "path": entry.get("path"),
            "tags": entry.get("tags"),
        }
        if top_path(entry) in excluded:
            record["reason"] = f"excluded top path: {top_path(entry)}"
            excluded_entries.append(record)
        else:
            selected.append(record)
    if not selected:
        raise GenerateError("selection is empty")

    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=False)
    plan = {
        "createdAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "baseUrl": args.base_url.rstrip("/"),
        "templateImage": str(template_path),
        "templateSha256": sha256_file(template_path),
        "templateSource": template.get("_source"),
        "templateParameters": {
            "width": template["width"],
            "height": template["height"],
            "steps": template["steps"],
            "scale": template["scale"],
            "sampler": template["sampler"],
            "noiseSchedule": template.get("noise_schedule"),
            "sourceUseCoords": bool(
                (template.get("v4_prompt") or {}).get("use_coords")
            ),
            # Requests contain no character prompts, so the compatible service
            # requires coordinates to be disabled.
            "useCoords": False,
        },
        "codex": str(codex_path),
        "codexSha256": sha256_file(codex_path),
        "selection": {
            "isNew": True,
            "unimaged": True,
            "excludeTopPath": sorted(excluded),
        },
        "nSamples": args.n_samples,
        "entryCount": len(selected),
        "candidateImageCount": len(selected) * args.n_samples,
        "entries": selected,
        "excludedEntries": excluded_entries,
    }
    write_json_atomic(output_dir / "plan.json", plan)
    write_json_atomic(
        output_dir / "manifest.json",
        {
            "createdAt": plan["createdAt"],
            "updatedAt": plan["createdAt"],
            "entryCount": len(selected),
            "results": {},
        },
    )
    print(
        f"planned entries={len(selected)} candidates={len(selected) * args.n_samples} "
        f"excluded={len(excluded_entries)}"
    )
    print(f"output: {output_dir}")
    return 0


def is_transient_error(message: str) -> bool:
    lowered = message.lower()
    if "network error:" in lowered:
        return True
    if "http 410:" in lowered or "http 429:" in lowered:
        return True
    return any(f"http {status}:" in lowered for status in range(500, 600))


def write_entry_result(entry_dir: Path, result: dict[str, Any]) -> None:
    write_json_atomic(entry_dir / "result.json", result)


def generate_one(
    entry: dict[str, Any],
    *,
    template: dict[str, Any],
    plan: dict[str, Any],
    batch_dir: Path,
    api_key: str,
    retries: int,
    timeout: int,
) -> dict[str, Any]:
    entry_id = entry["id"]
    entry_dir = batch_dir / "entries" / entry_id
    entry_dir.mkdir(parents=True, exist_ok=True)
    existing_path = entry_dir / "result.json"
    previous_attempts: list[dict[str, Any]] = []
    if existing_path.exists():
        existing = load_json(existing_path)
        if existing.get("status") in {"verified", "review"} and len(
            existing.get("images", [])
        ) == plan["nSamples"]:
            existing["resumed"] = True
            return existing
        previous_attempts = list(existing.get("attempts") or [])

    prompt = compose_prompt(str(template["prompt"]), str(entry.get("tags", "")))
    request_path = entry_dir / "request.json"
    if request_path.exists():
        request_manifest = load_json(request_path)
        payload = request_manifest["payload"]
        seed = payload["parameters"]["seed"]
    else:
        seed = random_seed()
        payload = build_payload(
            template,
            prompt,
            n_samples=plan["nSamples"],
            seed=seed,
        )
        request_manifest = {"entry": entry, "payload": payload}
        write_json_atomic(request_path, request_manifest)

    result: dict[str, Any] = {
        "id": entry_id,
        "title": entry.get("title"),
        "seed": seed,
        "status": "pending",
        "attempts": previous_attempts,
        "images": [],
    }
    for attempt in range(retries + 1):
        attempt_number = len(result["attempts"]) + 1
        started = time.monotonic()
        try:
            status, content_type, body = post_generate(
                plan["baseUrl"],
                api_key,
                payload,
                timeout=timeout,
            )
            images = extract_images(body)
            if len(images) != plan["nSamples"]:
                raise GenerateError(
                    f"expected {plan['nSamples']} images, received {len(images)}"
                )
            saved = []
            for index, (blob, info) in enumerate(images, 1):
                name = (
                    f"{entry_id}-{index:02d}"
                    f"{image_extension(info.get('format'))}"
                )
                destination = entry_dir / name
                destination.write_bytes(blob)
                saved.append(
                    {
                        "file": name,
                        "bytes": len(blob),
                        "sha256": hashlib.sha256(blob).hexdigest(),
                        "metadata": info,
                        "issues": verify_generated(info, payload),
                    }
                )
            result["attempts"].append(
                {
                    "number": attempt_number,
                    "status": "success",
                    "seconds": round(time.monotonic() - started, 3),
                    "httpStatus": status,
                    "contentType": content_type,
                }
            )
            result["images"] = saved
            result["status"] = (
                "verified"
                if not any(image["issues"] for image in saved)
                else "review"
            )
            write_entry_result(entry_dir, result)
            return result
        except Exception as exc:
            message = safe_error_text(exc, api_key)
            result["attempts"].append(
                {
                    "number": attempt_number,
                    "status": "failed",
                    "seconds": round(time.monotonic() - started, 3),
                    "error": message,
                }
            )
            if attempt >= retries or not is_transient_error(message):
                result["status"] = "failed"
                result["error"] = message
                write_entry_result(entry_dir, result)
                return result
            delay = min(20.0, 2.0 * (2**attempt)) + random.uniform(0.2, 1.2)
            result["attempts"][-1]["retryDelaySeconds"] = round(delay, 3)
            write_entry_result(entry_dir, result)
            time.sleep(delay)
    raise AssertionError("retry loop ended unexpectedly")


def validate_plan_inputs(
    plan: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    template_path = Path(plan["templateImage"])
    codex_path = Path(plan["codex"])
    if sha256_file(template_path) != plan["templateSha256"]:
        raise GenerateError("template image changed after plan creation")
    codex = load_json(codex_path)
    current = {entry["id"]: entry for entry in codex.get("entries", [])}
    for planned in plan["entries"]:
        entry = current.get(planned["id"])
        if not entry:
            raise GenerateError(f"planned entry disappeared: {planned['id']}")
        if entry.get("image") or entry.get("images"):
            raise GenerateError(f"planned entry gained an image: {planned['id']}")
        if entry.get("tags") != planned.get("tags"):
            raise GenerateError(f"planned entry tags changed: {planned['id']}")
    return load_template(template_path), current


def update_manifest(
    manifest_path: Path,
    manifest: dict[str, Any],
    result: dict[str, Any],
) -> None:
    with WRITE_LOCK:
        manifest["results"][result["id"]] = result
        manifest["updatedAt"] = datetime.now().astimezone().isoformat(
            timespec="seconds"
        )
        results = manifest["results"].values()
        manifest["counts"] = {
            "completed": sum(
                result.get("status") in {"verified", "review"} for result in results
            ),
            "verified": sum(
                result.get("status") == "verified" for result in results
            ),
            "review": sum(result.get("status") == "review" for result in results),
            "failed": sum(result.get("status") == "failed" for result in results),
            "images": sum(len(result.get("images", [])) for result in results),
        }
        write_json_atomic(manifest_path, manifest)


def run_generation(args: argparse.Namespace) -> int:
    if not 1 <= args.workers <= 8:
        raise GenerateError("--workers must be between 1 and 8")
    if not 0 <= args.retries <= 5:
        raise GenerateError("--retries must be between 0 and 5")
    api_key = os.environ.get(args.api_key_env, "").strip()
    if not api_key:
        raise GenerateError(f"environment variable {args.api_key_env} is empty")

    batch_dir = args.batch_dir.resolve()
    plan = load_json(batch_dir / "plan.json")
    manifest_path = batch_dir / "manifest.json"
    manifest = load_json(manifest_path)
    template, current = validate_plan_inputs(plan)
    entries = [current[entry["id"]] for entry in plan["entries"]]

    completed = {
        entry_id
        for entry_id, result in manifest.get("results", {}).items()
        if result.get("status") in {"verified", "review"}
        and len(result.get("images", [])) == plan["nSamples"]
    }
    pending = [entry for entry in entries if entry["id"] not in completed]
    print(
        f"batch entries={len(entries)} completed={len(completed)} "
        f"pending={len(pending)} workers={args.workers}",
        flush=True,
    )
    if not pending:
        print("batch is already complete", flush=True)
        return 0

    futures: dict[Future[dict[str, Any]], dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        for entry in pending:
            future = executor.submit(
                generate_one,
                entry,
                template=template,
                plan=plan,
                batch_dir=batch_dir,
                api_key=api_key,
                retries=args.retries,
                timeout=args.timeout,
            )
            futures[future] = entry
        finished = len(completed)
        for future in as_completed(futures):
            entry = futures[future]
            try:
                result = future.result()
            except Exception as exc:
                result = {
                    "id": entry["id"],
                    "title": entry.get("title"),
                    "status": "failed",
                    "images": [],
                    "error": safe_error_text(exc, api_key),
                }
            update_manifest(manifest_path, manifest, result)
            finished += 1
            attempts = len(result.get("attempts", []))
            print(
                f"[{finished}/{len(entries)}] {entry['id']} "
                f"{result['status']} images={len(result.get('images', []))} "
                f"attempts={attempts}",
                flush=True,
            )

    counts = manifest.get("counts", {})
    print(
        "done "
        + " ".join(f"{key}={value}" for key, value in counts.items()),
        flush=True,
    )
    return 1 if counts.get("failed") else 0


def main() -> int:
    args = parse_args()
    if args.command == "plan":
        return create_plan(args)
    if args.command == "generate":
        return run_generation(args)
    raise GenerateError(f"unknown command: {args.command}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GenerateError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2)
