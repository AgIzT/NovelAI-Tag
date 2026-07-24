# -*- coding: utf-8 -*-
"""
Migrate suozhang_r18 assets from legacy R2/local prefixes to suozhang_r18.

Default mode is a dry run:
  python tools/migrate_asset_prefix.py

Apply only after the dry run reports zero issues:
  python tools/migrate_asset_prefix.py --apply
"""
import argparse
import hashlib
import json
import os
import shutil
import tempfile
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "site" / "data" / "suozhang_r18.json"
THUMB_DIR = ROOT / "site" / "images"
ORIG_DIR = ROOT / "originals"
TARGET_PREFIX = "suozhang_r18"
LEGACY_PREFIXES = {"codex_6e699406", "codex_8489ac52"}


def sha256_hex(path, cache):
    if path not in cache:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                h.update(chunk)
        cache[path] = h.hexdigest()
    return cache[path]


def atomic_write_json(path, data):
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False)
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def collect_plan(data):
    hash_cache = {}
    entries = data.get("entries") or []
    candidates = []
    copy_files = []
    same_existing = []
    missing_src = []
    conflicts = []
    unexpected_asset_ids = []
    missing_metadata = []
    asset_counts = Counter()

    for entry in entries:
        asset_id = entry.get("assetCodexId")
        if not asset_id:
            continue

        if asset_id not in LEGACY_PREFIXES:
            unexpected_asset_ids.append((entry.get("id"), entry.get("title"), asset_id))
            continue

        asset_counts[asset_id] += 1
        image_name = entry.get("image")
        original_name = entry.get("original")
        if not image_name or not original_name:
            missing_metadata.append((entry.get("id"), entry.get("title"), asset_id, image_name, original_name))
            continue

        candidates.append(entry)
        for kind, base_dir, filename in (
            ("image", THUMB_DIR, image_name),
            ("original", ORIG_DIR, original_name),
        ):
            src = base_dir / asset_id / filename
            dst = base_dir / TARGET_PREFIX / filename
            if not src.exists():
                missing_src.append((entry.get("id"), kind, str(src.relative_to(ROOT))))
                continue

            if dst.exists():
                src_hash = sha256_hex(src, hash_cache)
                dst_hash = sha256_hex(dst, hash_cache)
                if src_hash == dst_hash:
                    same_existing.append((entry.get("id"), kind, filename))
                else:
                    conflicts.append((entry.get("id"), kind, filename, asset_id, TARGET_PREFIX))
                continue

            copy_files.append((src, dst))

    issues = {
        "missing_src": missing_src,
        "conflicts": conflicts,
        "unexpected_asset_ids": unexpected_asset_ids,
        "missing_metadata": missing_metadata,
    }
    return {
        "entries": entries,
        "candidates": candidates,
        "copy_files": copy_files,
        "same_existing": same_existing,
        "asset_counts": asset_counts,
        "issues": issues,
    }


def print_examples(title, items, limit=8):
    print(f"{title}: {len(items)}")
    for item in items[:limit]:
        print(f"  - {item}")


def print_report(plan):
    issues = plan["issues"]
    print("Asset prefix migration: suozhang_r18")
    print(f"legacy prefixes: {', '.join(sorted(LEGACY_PREFIXES))}")
    print(f"target prefix: {TARGET_PREFIX}")
    print(f"entries to migrate: {len(plan['candidates'])}")
    print(f"legacy entry counts: {dict(plan['asset_counts'])}")
    print(f"files to copy: {len(plan['copy_files'])}")
    print(f"same existing files: {len(plan['same_existing'])}")
    print(f"missing_src: {len(issues['missing_src'])}")
    print(f"conflicts: {len(issues['conflicts'])}")
    print(f"unexpected_assetCodexId: {len(issues['unexpected_asset_ids'])}")
    print(f"missing_metadata: {len(issues['missing_metadata'])}")

    for title, key in (
        ("Missing source examples", "missing_src"),
        ("Conflict examples", "conflicts"),
        ("Unexpected assetCodexId examples", "unexpected_asset_ids"),
        ("Missing metadata examples", "missing_metadata"),
    ):
        if issues[key]:
            print_examples(title, issues[key])


def has_issues(plan):
    return any(plan["issues"].values())


def apply_plan(data, plan):
    for src, dst in plan["copy_files"]:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)

    for entry in plan["candidates"]:
        entry.pop("assetCodexId", None)

    atomic_write_json(DATA_PATH, data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Copy files and clear assetCodexId after a full preflight.")
    args = parser.parse_args()

    with open(DATA_PATH, encoding="utf-8") as fh:
        data = json.load(fh)

    plan = collect_plan(data)
    print_report(plan)

    if has_issues(plan):
        print("\nPreflight failed. No files were copied and JSON was not modified.")
        return 2

    if not args.apply:
        print("\nDry run only. Re-run with --apply to migrate.")
        return 0

    apply_plan(data, plan)
    print(f"\nCopied {len(plan['copy_files'])} file(s).")
    print(f"Cleared assetCodexId on {len(plan['candidates'])} entrie(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
