# -*- coding: utf-8 -*-
"""Backfill structured NovelAI V4 character prompts for local image packs.

The command reads the already-published originals referenced by the current
pack JSON. It never reimports source folders or rewrites image assets.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "site" / "data"
ORIGINAL_ROOT = ROOT / "originals"
OUTPUT_DIR = ROOT / "output" / "pack_character_prompts"
DEFAULT_CODEX_IDS = ("mengshen_pack", "community_ai_misc")


def clean_text(value: Any) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()


def comparison_text(value: Any) -> str:
    return "\n".join(line.strip() for line in clean_text(value).split("\n") if line.strip())


def clean_character_prompts(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    out: list[dict[str, str]] = []
    for index, raw in enumerate(value):
        if isinstance(raw, str):
            raw = {"prompt": raw}
        if not isinstance(raw, dict):
            continue
        prompt = clean_text(raw.get("prompt") or raw.get("positive") or raw.get("char_caption"))
        negative = clean_text(raw.get("negative") or raw.get("uc"))
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


def resolve_original(codex_id: str, entry: dict[str, Any]) -> Path | None:
    original = clean_text(entry.get("original"))
    if not original:
        images = entry.get("images") if isinstance(entry.get("images"), list) else []
        first = images[0] if images else None
        original = clean_text(first.get("original")) if isinstance(first, dict) else ""
    if not original:
        return None
    normalized = original.replace("\\", "/").lstrip("/")
    if normalized.startswith("originals/"):
        return ROOT / Path(normalized)
    asset_codex_id = clean_text(entry.get("assetCodexId")) or codex_id
    return ORIGINAL_ROOT / asset_codex_id / Path(normalized)


def inspect_original(task: dict[str, str]) -> dict[str, Any]:
    sys.path.insert(0, str(ROOT / "tools"))
    from sd_metadata_inspector import extract_image_metadata

    result: dict[str, Any] = {
        "id": task["id"],
        "path": task["path"],
        "sourceType": "unknown",
        "prompt": "",
        "negative": "",
        "characterPrompts": [],
        "error": "",
    }
    try:
        meta = extract_image_metadata(Path(task["path"]))
        result["sourceType"] = clean_text(meta.source_type) or "unknown"
        result["prompt"] = clean_text(meta.prompt)
        result["negative"] = clean_text(meta.negative)
        result["characterPrompts"] = clean_character_prompts(meta.character_prompts)
    except Exception as exc:  # keep the full scan going and report the exact entry
        result["error"] = f"{type(exc).__name__}: {exc}"
    return result


def old_flattened_text(base: str, prompts: list[dict[str, str]], key: str) -> str:
    values = [clean_text(item.get(key)) for item in prompts]
    return "\n".join([clean_text(base), *(value for value in values if value)]).strip()


def reconcile_prompt_field(
    entry: dict[str, Any],
    field: str,
    base: str,
    prompts: list[dict[str, str]],
    prompt_key: str,
) -> str:
    current = clean_text(entry.get(field))
    base = clean_text(base)
    flattened = old_flattened_text(base, prompts, prompt_key)
    if comparison_text(current) == comparison_text(base):
        return "already_base"
    if comparison_text(current) == comparison_text(flattened) and comparison_text(flattened) != comparison_text(base):
        entry[field] = base
        return "separated_flattened"
    if not current and not base:
        return "both_empty"
    return "preserved_mismatch"


def replace_character_prompts(
    entry: dict[str, Any],
    prompts: list[dict[str, str]],
) -> dict[str, Any]:
    existing = clean_character_prompts(entry.get("characterPrompts"))
    if existing == prompts and (prompts or "characterPrompts" not in entry):
        return entry
    out: dict[str, Any] = {}
    inserted = False
    for key, value in entry.items():
        if key == "characterPrompts":
            continue
        out[key] = value
        if prompts and key == "negative":
            out["characterPrompts"] = prompts
            inserted = True
    if prompts and not inserted:
        rebuilt: dict[str, Any] = {}
        for key, value in out.items():
            rebuilt[key] = value
            if key == "tags":
                rebuilt["characterPrompts"] = prompts
                inserted = True
        out = rebuilt
    if prompts and not inserted:
        out["characterPrompts"] = prompts
    return out


def process_codex(codex_id: str, workers: int, apply: bool) -> dict[str, Any]:
    data_path = DATA_DIR / f"{codex_id}.json"
    data = json.loads(data_path.read_text(encoding="utf-8"))
    if data.get("type") != "pack":
        raise RuntimeError(f"{codex_id} is not a pack")
    entries = data.get("entries") if isinstance(data.get("entries"), list) else []
    tasks: list[dict[str, str]] = []
    missing_originals: list[str] = []
    for entry in entries:
        original = resolve_original(codex_id, entry)
        if not original or not original.is_file():
            missing_originals.append(clean_text(entry.get("id")))
            continue
        tasks.append({"id": clean_text(entry.get("id")), "path": str(original)})

    with ProcessPoolExecutor(max_workers=workers) as pool:
        rows = list(pool.map(inspect_original, tasks, chunksize=8))
    by_id = {row["id"]: row for row in rows}

    stats: Counter[str] = Counter()
    source_types: Counter[str] = Counter()
    mismatch_examples: list[dict[str, str]] = []
    error_examples: list[dict[str, str]] = []
    updated_entries: list[dict[str, Any]] = []
    for original_entry in entries:
        entry = dict(original_entry)
        entry_id = clean_text(entry.get("id"))
        row = by_id.get(entry_id)
        if not row:
            updated_entries.append(entry)
            continue
        source_types[row["sourceType"]] += 1
        if row["error"]:
            stats["metadataErrors"] += 1
            if len(error_examples) < 20:
                error_examples.append({"id": entry_id, "error": row["error"]})
            updated_entries.append(entry)
            continue

        prompts = clean_character_prompts(row["characterPrompts"])
        if prompts:
            stats["entriesWithCharacterPrompts"] += 1
            stats["characterPromptBoxes"] += len(prompts)
            stats[f"maxLabel:{prompts[-1]['label']}"] += 1
            positive_status = reconcile_prompt_field(entry, "tags", row["prompt"], prompts, "prompt")
            negative_status = reconcile_prompt_field(entry, "negative", row["negative"], prompts, "negative")
            stats[f"positive:{positive_status}"] += 1
            stats[f"negative:{negative_status}"] += 1
            if "mismatch" in positive_status or "mismatch" in negative_status:
                if len(mismatch_examples) < 20:
                    mismatch_examples.append({
                        "id": entry_id,
                        "positive": positive_status,
                        "negative": negative_status,
                    })
        elif entry.get("characterPrompts"):
            stats["staleCharacterPromptFieldsRemoved"] += 1

        entry = replace_character_prompts(entry, prompts)
        if entry != original_entry:
            stats["changedEntries"] += 1
        updated_entries.append(entry)

    stats["entries"] = len(entries)
    stats["originalsInspected"] = len(rows)
    stats["missingOriginals"] = len(missing_originals)
    data["entries"] = updated_entries
    if apply:
        if missing_originals or stats["metadataErrors"]:
            raise RuntimeError(
                f"refusing to write {codex_id}: missing={len(missing_originals)}, "
                f"metadataErrors={stats['metadataErrors']}"
            )
        temporary = data_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(data, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        temporary.replace(data_path)

    return {
        "codexId": codex_id,
        "applied": apply,
        "stats": dict(sorted(stats.items())),
        "metadataSources": dict(sorted(source_types.items())),
        "missingOriginalExamples": missing_originals[:20],
        "metadataErrorExamples": error_examples,
        "promptMismatchExamples": mismatch_examples,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex-id", action="append", dest="codex_ids")
    parser.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1))
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--report", type=Path, default=OUTPUT_DIR / "report.json")
    args = parser.parse_args()
    if args.workers < 1:
        raise SystemExit("--workers must be at least 1")

    codex_ids = tuple(args.codex_ids or DEFAULT_CODEX_IDS)
    reports = [process_codex(codex_id, args.workers, args.apply) for codex_id in codex_ids]
    output = {"applied": args.apply, "codexes": reports}
    report_path = args.report.resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
