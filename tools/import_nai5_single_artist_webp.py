"""Controlled local import of the 2026-10 V5 single-artist WebP collection.

Default: freeze and inspect the source, writing a plan under output only.
--apply consumes that frozen plan; --validate reads the installed result.
--recover restores the precise files named in an interrupted transaction.
This adapter never uploads, publishes, commits, or removes source images.
"""
from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import json
import os
import secrets
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath
from typing import Any

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pack_import_core import (  # noqa: E402
    build_tree, make_staging_directory, run_parallel, sha256_file,
    tree_counts, validate_asset, write_asset_bundle_from_paths, write_json,
)
from sd_metadata_inspector import extract_image_metadata  # noqa: E402
from sync_r2 import rev_from_hashes  # noqa: E402


ROOT = Path(__file__).resolve().parents[1]
CODEX_ID = "artist_nai5_personal"
ID_PREFIX = f"{CODEX_ID}_baolong_"
AUTHOR = "MayRain"
SOURCE_PATH = ["单画师词典", AUTHOR, "V5 单画师例图（NAI5 Full）"]
BATCH = "2026.10.24"
SIDECARS = ("README.txt", "index.json", "index.csv", "codex-entries-draft.json")
FROZEN_TOOLS = ("sd_metadata_inspector.py", "pack_import_core.py", "sync_r2.py")
EXPECTED_IMAGES = 12779
EXPECTED_GROUPS = 12703
EXPECTED_MULTI = 70
EXPECTED_OLD = 5663
UC_PREFIX = ("lowres, bad hands, bad anatomy, artistic error, sepia, white haze, "
             "worst quality, very displeasing, jpeg artifacts, 0::ai-generated::, ")
NOTE = ("单画师例图；复制仅含画师标签。完整生成提示词、负面、角色与参数保留在原图中。"
        "模型：NovelAI V5 Full。")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def digest_json(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode("utf-8")).hexdigest()


def atomic_bytes(path: Path, data: bytes) -> None:
    temporary = path.with_name(f".{path.name}.single-artist-{secrets.token_hex(8)}.tmp")
    with temporary.open("xb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def save_state(report: Path, state: dict) -> None:
    body = (json.dumps(state, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    atomic_bytes(report / "transaction.json", body)


def source_file(source: Path, relative: str) -> Path:
    logical = PurePosixPath(str(relative))
    if (not str(relative) or "\\" in str(relative) or logical.is_absolute()
            or any(part in (".", "..") or ":" in part for part in logical.parts)):
        raise ValueError(f"invalid source path: {relative!r}")
    target = (source / relative).resolve()
    if not target.is_relative_to(source.resolve()) or not target.is_file():
        raise ValueError(f"source file missing or outside root: {relative!r}")
    return target


def verify_frozen_files(source: Path, manifest: dict, workers: int = 8) -> None:
    for name, expected in manifest["sidecars"].items():
        if sha256_file(source_file(source, name)) != expected:
            raise RuntimeError(f"source sidecar changed: {name}")
    images = manifest["images"]
    names = [row["file"] for row in images]
    if len(names) != len(set(names)):
        raise ValueError("duplicate source image paths")
    actual = {p.relative_to(source).as_posix() for p in (source / "images").rglob("*") if p.is_file()}
    if actual != set(names):
        raise RuntimeError("source image membership changed")
    paths = [source_file(source, name) for name in names]
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for row, actual_hash in zip(images, pool.map(sha256_file, paths)):
            if actual_hash != row["sha256"]:
                raise RuntimeError(f"source image changed: {row['file']}")


def group_rows(rows: list[dict]) -> list[dict]:
    groups: dict[str, dict] = {}
    for row in rows:
        artist = row.get("artist")
        if not isinstance(artist, str) or not artist.strip():
            raise ValueError("empty artist")
        if artist not in groups:
            groups[artist] = {"id": f"{ID_PREFIX}{len(groups) + 1:05d}", "title": artist,
                              "tags": f"artist:{artist}", "members": []}
        groups[artist]["members"].append(row)
    return list(groups.values())


def member_names(group: dict) -> list[tuple[str, str]]:
    return [(f"{group['id']}{'' if i == 0 else f'-{i + 1:02d}'}.jpg",
             f"{group['id']}{'' if i == 0 else f'-{i + 1:02d}'}.webp")
            for i, _ in enumerate(group["members"])]


def ensure_targets_absent(groups: list[dict], thumb_dir: Path, original_dir: Path) -> None:
    for group in groups:
        for thumb, original in member_names(group):
            for target in (thumb_dir / thumb, original_dir / original):
                if target.exists():
                    raise RuntimeError(f"refusing to overwrite media: {target}")


def flatten_paths(tree: list[dict], parent: tuple = ()) -> list[tuple]:
    return [path for node in tree for path in
            [(parent + (node["name"],)), *flatten_paths(node.get("children", []), parent + (node["name"],))]]


def ordered_tree(old_tree: list[dict], entries: list[dict]) -> list[dict]:
    result = copy.deepcopy(old_tree)
    roots = [node for node in result if node["name"] == SOURCE_PATH[0]]
    if len(roots) != 1:
        raise ValueError("single-artist root missing or ambiguous")
    children = roots[0]["children"]
    names = [node["name"] for node in children]
    if names.count("雨燕(无原图)") != 1 or names.count("无冕") != 1 or AUTHOR in names:
        raise ValueError("source insertion anchors missing or occupied")
    after, before = names.index("雨燕(无原图)"), names.index("无冕")
    if before != after + 1:
        raise ValueError("source insertion anchors are not adjacent")
    incoming = [entry for entry in entries if entry.get("path") == SOURCE_PATH]
    if not incoming:
        raise ValueError("new source has no entries")
    children.insert(before, build_tree(incoming)[0]["children"][0])
    counts = tree_counts(build_tree(entries))
    paths = flatten_paths(result)
    if set(paths) != set(counts):
        raise ValueError("tree and entry paths do not match")

    def update(nodes: list[dict], parent: tuple = ()) -> None:
        for node in nodes:
            path = parent + (node["name"],)
            node["count"] = counts[path]
            update(node.get("children", []), path)

    update(result)
    if paths != flatten_paths(build_tree(entries)):
        raise ValueError("entry first-appearance order does not match the directory tree")
    return result


def add_metadata(meta: dict, count: int, imaged: int, tree: list[dict]) -> dict:
    result = copy.deepcopy(meta)
    result.update(version=BATCH, entryCount=count, imagedCount=imaged, tree=copy.deepcopy(tree),
                  newFilterLabel="本次10.24更新")
    authors = str(result.get("author") or "").split(" / ")
    if AUTHOR not in authors:
        result["author"] = " / ".join([part for part in authors if part] + [AUTHOR])
    credit = {"name": AUTHOR, "role": "V5单画师例图 · 标签与原图提供"}
    credits = result.setdefault("contributors", [])
    if not any(item.get("name") == AUTHOR for item in credits):
        credits.append(credit)
    source = f"{AUTHOR} · {SOURCE_PATH[-1]}"
    if source not in str(result.get("source") or ""):
        result["source"] = (str(result.get("source") or "") + " / " + source).strip(" / ")
    filters = result.setdefault("updateFilters", [])
    if any(item.get("id") == BATCH for item in filters):
        raise ValueError("new update filter already exists")
    for item in filters:
        if item.get("latest") is True:
            item["latest"] = False
    filters.append({"id": BATCH, "label": "10.24更新", "latest": True})
    if "categoryOrder" in result:
        order = result["categoryOrder"]
        if not isinstance(order, list):
            raise ValueError("invalid categoryOrder")
        # Only the affected parent is changed; unrelated ordering declarations stay exact.
        affected = [list(path) for path in flatten_paths(tree) if len(path) == 2 and path[0] == SOURCE_PATH[0]]
        indices = [i for i, path in enumerate(order) if len(path) == 2 and path[0] == SOURCE_PATH[0]]
        position = indices[0] if indices else len(order)
        rest = [path for i, path in enumerate(order) if i not in indices]
        result["categoryOrder"] = rest[:position] + affected + rest[position:]
    return result


def compose_payload(old_book: dict, old_index: list[dict], groups: list[dict], assets: dict) -> tuple[dict, list[dict]]:
    old_entries = old_book["entries"]
    if any(str(entry.get("id", "")).startswith(ID_PREFIX) for entry in old_entries):
        raise RuntimeError("source already installed")
    new_entries = []
    old_ids = {entry["id"] for entry in old_entries}
    for group in groups:
        if group["id"] in old_ids or group["id"] not in assets:
            raise ValueError("duplicate entry ID or missing asset mapping")
        entry = {"id": group["id"], "title": group["title"], "tags": group["tags"],
                 "path": list(SOURCE_PATH), "rating": "safe", "isNew": True,
                 "updateBatches": [BATCH], "note": NOTE}
        entry.update(copy.deepcopy({key: value for key, value in assets[group["id"]].items() if key != "entryId"}))
        if len(entry["images"]) != len(group["members"]):
            raise ValueError("asset group length mismatch")
        for image in entry["images"]:
            image["rawTag"] = group["tags"]
        new_entries.append(entry)
    positions = [i for i, entry in enumerate(old_entries) if (entry.get("path") or [])[:2] == [SOURCE_PATH[0], "无冕"]]
    if not positions:
        raise ValueError("missing entry insertion anchor")
    position = positions[0]
    retained = expected_old_entries(old_book)
    entries = retained[:position] + new_entries + retained[position:]
    tree = ordered_tree(old_book["tree"], entries)
    imaged = sum(bool(entry.get("image") or entry.get("images")) for entry in entries)
    book = add_metadata(old_book, len(entries), imaged, tree)
    book["entries"] = entries
    index = copy.deepcopy(old_index)
    matches = [i for i, item in enumerate(index) if item["id"] == CODEX_ID]
    if len(matches) != 1:
        raise ValueError("book index target missing or ambiguous")
    index[matches[0]] = add_metadata(index[matches[0]], len(entries), imaged, tree)
    return book, index


def expected_old_entries(old_book: dict) -> list[dict]:
    retained = copy.deepcopy(old_book["entries"])
    # Only the historical new marker is cleared; batch membership remains exact.
    for entry in retained:
        if entry.get("isNew") is True:
            entry["isNew"] = False
    return retained


def inspect_source_row(task: dict) -> dict:
    row, path = task["row"], Path(task["path"])
    with Image.open(path) as image:
        image.load()
        if image.format != "WEBP" or image.size != (row["width"], row["height"]):
            raise ValueError(f"image format or dimensions differ: {row['file']}")
    meta = extract_image_metadata(path)
    payload = meta.fields.get("CommentJson")
    if not isinstance(payload, dict) or meta.source_type != "NovelAI-Stealth":
        raise ValueError(f"unexpected metadata format: {row['file']}")
    if meta.prompt != row["prompt"] or row["prompt"].count("artist:") != 1 or f"artist:{row['artist']}" not in meta.prompt:
        raise ValueError(f"source prompt or artist differs: {row['file']}")
    if row["model"] != "nai-diffusion-5-full" or not str(meta.fields.get("Source", "")).startswith("NovelAI Diffusion V5 "):
        raise ValueError(f"unexpected model: {row['file']}")
    for index_key, parameter_key in (("seed", "seed"), ("steps", "steps"), ("scale", "scale"),
                                     ("cfgRescale", "cfg_rescale"), ("width", "width"), ("height", "height"),
                                     ("sampler", "sampler"), ("noiseSchedule", "noise_schedule")):
        if row[index_key] != payload.get(parameter_key):
            raise ValueError(f"source parameter {index_key} differs: {row['file']}")
    negative = row["negativePrompt"]
    if meta.negative not in (negative, UC_PREFIX + negative):
        raise ValueError(f"unexpected negative difference: {row['file']}")
    chars = meta.character_prompts
    if (len(chars) != 1 or chars[0].get("label") != "char1" or chars[0].get("negative")
            or chars[0].get("prompt") not in ("plana (blue archive)", "dizzy (guilty gear)")):
        raise ValueError(f"unexpected character prompts: {row['file']}")
    return {"file": row["file"], "artist": row["artist"], "sourceIndex": task["sourceIndex"],
            "sha256": sha256_file(path), "width": row["width"], "height": row["height"],
            "ucPrefix": meta.negative != negative, "character": chars[0]["prompt"],
            "metadataType": meta.source_type, "metadataSha256": digest_json(payload)}


def read_source_rows(source: Path) -> list[dict]:
    rows = read_json(source / "index.json")
    draft = read_json(source / "codex-entries-draft.json")
    if len(rows) != EXPECTED_IMAGES or draft.get("entryCount") != len(rows) or len(draft["entries"]) != len(rows):
        raise ValueError("source collection counts changed")
    with (source / "index.csv").open(encoding="utf-8-sig", newline="") as handle:
        csv_rows = list(csv.DictReader(handle))
    if len(csv_rows) != len(rows):
        raise ValueError("CSV and JSON counts differ")
    for row, csv_row, entry in zip(rows, csv_rows, draft["entries"]):
        source_file(source, row["file"])
        if not row["file"].startswith("images/") or Path(row["file"]).suffix.lower() != ".webp":
            raise ValueError("source image is not a WebP below images/")
        if any(str(value) != csv_row.get(key) and not (isinstance(value, (float, int)) and float(csv_row.get(key, "nan")) == value)
               for key, value in row.items()):
            raise ValueError(f"CSV and JSON differ: {row['file']}")
        if (entry.get("title") != row["artist"] or entry.get("tags") != "artist:" + row["artist"]
                or entry.get("image") != row["file"] or entry.get("original") != row["file"]
                or len(entry.get("images", [])) != 1
                or entry["images"][0].get("rawTag") != entry["tags"]):
            raise ValueError(f"draft label or image differs: {row['file']}")
    return rows


def target_paths(root: Path) -> tuple[Path, Path, Path, Path]:
    return (root / "site/data" / f"{CODEX_ID}.json", root / "site/data/codexes.json",
            root / "site/images" / CODEX_ID, root / "originals" / CODEX_ID)


def create_plan(source: Path, report: Path, workers: int, root: Path = ROOT) -> dict:
    book_path, index_path, thumb_dir, original_dir = target_paths(root)
    if (report / "transaction.json").exists():
        state = read_json(report / "transaction.json")
        if state["status"] == "complete":
            return validate_installed(source, report, workers, root)
        raise RuntimeError("existing transaction requires --recover or a fresh report directory")
    if (report / "manifest.json").exists():
        raise RuntimeError("plan already exists; use --apply or choose a fresh report directory")
    old_book, old_index = read_json(book_path), read_json(index_path)
    old_book_hash, old_index_hash = sha256_file(book_path), sha256_file(index_path)
    if len(old_book["entries"]) != EXPECTED_OLD:
        raise ValueError("current dictionary count changed; investigate before importing")
    sidecars = {name: sha256_file(source_file(source, name)) for name in SIDECARS}
    rows = read_source_rows(source)
    tasks = [{"row": row, "path": str(source_file(source, row["file"])), "sourceIndex": i}
             for i, row in enumerate(rows, 1)]
    images = run_parallel("Inspect source", inspect_source_row, tasks, workers)
    if len({row["sha256"] for row in images}) != len(images):
        raise ValueError("source contains byte-identical images; explicit resolution required")
    groups = group_rows(images)
    roles = Counter(row["character"] for row in images)
    summary = {"images": len(images), "entries": len(groups), "multiImageEntries": sum(len(g["members"]) > 1 for g in groups),
               "ucPrefixImages": sum(row["ucPrefix"] for row in images), "characters": dict(roles),
               "pendingEntries": len(groups), "oldIsNewToClear": sum(e.get("isNew") is True for e in old_book["entries"]),
               "oldOtherFieldChanges": 0}
    if (len(groups) != EXPECTED_GROUPS or summary["multiImageEntries"] != EXPECTED_MULTI
            or summary["ucPrefixImages"] != 1512 or roles != {"plana (blue archive)": 12761, "dizzy (guilty gear)": 18}):
        raise ValueError("source metadata distribution changed")
    ensure_targets_absent(groups, thumb_dir, original_dir)
    if any(str(e.get("id", "")).startswith(ID_PREFIX) for e in old_book["entries"]):
        raise RuntimeError("source already installed")
    if sha256_file(book_path) != old_book_hash or sha256_file(index_path) != old_index_hash:
        raise RuntimeError("target data changed during source inspection")
    report.mkdir(parents=True, exist_ok=True)
    for path, name in ((book_path, "before-book.json"), (index_path, "before-index.json")):
        (report / name).write_bytes(path.read_bytes())
    manifest = {"schema": 1, "sourceRoot": str(source), "sidecars": sidecars, "images": images,
                "groups": [{"id": g["id"], "artist": g["title"], "files": [r["file"] for r in g["members"]]} for g in groups],
                "oldBookSha256": old_book_hash, "oldIndexSha256": old_index_hash,
                "parserSha256": sha256_file(ROOT / "tools/sd_metadata_inspector.py"),
                "toolSha256": {name: sha256_file(ROOT / "tools" / name) for name in FROZEN_TOOLS},
                "adapterSha256": sha256_file(Path(__file__)), "summary": summary}
    verify_frozen_files(source, manifest, workers)
    write_json(report / "manifest.json", manifest)
    write_json(report / "plan.json", {"status": "planned", **summary})
    return {"status": "planned", **summary}


def verify_baseline(manifest: dict, report: Path, root: Path) -> tuple[dict, list[dict]]:
    book_path, index_path, _, _ = target_paths(root)
    for path, backup, expected in ((book_path, "before-book.json", manifest["oldBookSha256"]),
                                   (index_path, "before-index.json", manifest["oldIndexSha256"])):
        if sha256_file(path) != expected or sha256_file(report / backup) != expected:
            raise RuntimeError(f"target or baseline snapshot changed: {path.name}")
    return read_json(report / "before-book.json"), read_json(report / "before-index.json")


def check_payload(book: dict, index: list[dict], old_book: dict, old_index: list[dict], groups: list[dict]) -> None:
    retained = [e for e in book["entries"] if not str(e["id"]).startswith(ID_PREFIX)]
    if retained != expected_old_entries(old_book):
        raise ValueError("old entries changed beyond clearing isNew, or were reordered")
    new = [e for e in book["entries"] if str(e["id"]).startswith(ID_PREFIX)]
    if len(new) != len(groups) or len({e["id"] for e in book["entries"]}) != len(book["entries"]):
        raise ValueError("entry membership or unique IDs differ")
    assets = {e["id"]: {k: e[k] for k in ("image", "original", "imageWidth", "imageHeight", "images", "assetRev")} for e in new}
    expected_book, expected_index = compose_payload(old_book, old_index, groups, assets)
    if book != expected_book or index != expected_index:
        raise ValueError("installed payload differs from the allowed source increment")
    if len(json.dumps(book, ensure_ascii=False).encode("utf-8")) > 32 * 1024 * 1024:
        raise ValueError("dictionary exceeds release object size limit")


def validate_group(task: dict) -> dict:
    entry, group = task["entry"], task["group"]
    thumb_dir, original_dir = Path(task["thumbDir"]), Path(task["originalDir"])
    issues = validate_asset(entry, thumb_dir, original_dir)
    if issues:
        raise ValueError("; ".join(issues))
    hashes = []
    for image, row, (thumb_name, original_name) in zip(entry["images"], group["members"], member_names(group)):
        if image != {"path": thumb_name, "original": original_name, "rawTag": group["tags"]}:
            raise ValueError(f"unexpected image fields: {entry['id']}")
        original, thumb = original_dir / original_name, thumb_dir / thumb_name
        if sha256_file(original) != row["sha256"]:
            raise ValueError(f"source/original hash mismatch: {entry['id']}")
        with Image.open(thumb) as opened:
            opened.load()
            if opened.format != "JPEG" or opened.mode not in ("RGB", "L"):
                raise ValueError("thumbnail is not an RGB/L JPEG")
            expected = (row["width"], row["height"])
            ratio = min(1, 1100 / max(expected))
            if any(abs(a - b * ratio) > 1 for a, b in zip(opened.size, expected)):
                raise ValueError("thumbnail dimensions differ")
        hashes.extend((sha256_file(thumb), row["sha256"]))
    expected_rev = rev_from_hashes(hashes)
    if entry["assetRev"] != expected_rev:
        raise ValueError(f"assetRev differs: {entry['id']}")
    return {"id": entry["id"], "images": len(hashes) // 2}


def write_source_asset(task: dict) -> dict:
    asset = write_asset_bundle_from_paths(task)
    hashes = []
    for image in asset["images"]:
        hashes.extend((sha256_file(Path(task["thumbDir"]) / image["path"]),
                       sha256_file(Path(task["originalDir"]) / image["original"])))
    # The active synchronizer hashes flattened member hashes. Keep this batch
    # stable through its later metadata-only publishing preparation.
    asset["assetRev"] = rev_from_hashes(hashes)
    return asset


def validate_media(book: dict, groups: list[dict], thumb_dir: Path, original_dir: Path, workers: int) -> list[dict]:
    entries = {e["id"]: e for e in book["entries"]}
    tasks = [{"entry": entries[g["id"]], "group": g, "thumbDir": str(thumb_dir), "originalDir": str(original_dir)} for g in groups]
    return run_parallel("Validate media", validate_group, tasks, workers)


def recover_transaction(report: Path, root: Path = ROOT) -> dict:
    state = read_json(report / "transaction.json")
    if state["status"] == "complete":
        raise RuntimeError("completed import requires a separately reviewed rollback")
    book_path, index_path, thumb_dir, original_dir = target_paths(root)
    manifest = read_json(report / "manifest.json")
    # Preflight every restore and move before modifying anything.
    restores = []
    for path, backup, old_hash, new_hash in ((book_path, "before-book.json", manifest["oldBookSha256"], state.get("bookSha256")),
                                           (index_path, "before-index.json", manifest["oldIndexSha256"], state.get("indexSha256"))):
        if sha256_file(report / backup) != old_hash or sha256_file(path) not in (old_hash, new_hash):
            raise RuntimeError(f"recovery refuses unknown target bytes: {path}")
        restores.append((path, (report / backup).read_bytes()))
    moves = read_json(report / "transaction-media.json") if (report / "transaction-media.json").exists() else []
    if moves:
        stages = state["staging"]
        thumb_stage, original_stage = Path(stages["thumbs"]), Path(stages["originals"])
        for stage, final, label in ((thumb_stage, thumb_dir, "thumbs"), (original_stage, original_dir, "originals")):
            if (stage.resolve().parent != final.resolve().parent
                    or not stage.name.startswith(f".{CODEX_ID}-baolong-{label}-") or not stage.is_dir()):
                raise RuntimeError("recovery staging path is outside the recorded media root")
        expected_moves = set()
        for group in group_rows(manifest["images"]):
            for thumb, original in member_names(group):
                expected_moves.add((str(thumb_stage / thumb), str(thumb_dir / thumb)))
                expected_moves.add((str(original_stage / original), str(original_dir / original)))
        actual_moves = [(move["source"], move["target"]) for move in moves]
        if len(actual_moves) != len(expected_moves) or set(actual_moves) != expected_moves:
            raise RuntimeError("recovery media journal does not match the frozen source")
    for move in moves:
        src, dst = Path(move["source"]), Path(move["target"])
        if dst.exists() and (src.exists() or sha256_file(dst) != move["sha256"]):
            raise RuntimeError(f"recovery refuses ambiguous media: {dst}")
    for path, data in restores:
        if path.read_bytes() != data:
            atomic_bytes(path, data)
    for move in reversed(moves):
        src, dst = Path(move["source"]), Path(move["target"])
        if dst.exists():
            dst.rename(src)
    state.update(status="rolled_back", recovery="old JSON restored; new media retained in staging")
    save_state(report, state)
    return {"status": "rolled_back", "staging": state.get("staging")}


def apply_plan(source: Path, report: Path, workers: int, root: Path = ROOT) -> dict:
    manifest = read_json(report / "manifest.json")
    if (report / "transaction.json").exists():
        state = read_json(report / "transaction.json")
        if state["status"] == "complete":
            return validate_installed(source, report, workers, root)
        raise RuntimeError("transaction already exists; recover before retrying with a fresh plan")
    if manifest["adapterSha256"] != sha256_file(Path(__file__)) or manifest["parserSha256"] != sha256_file(ROOT / "tools/sd_metadata_inspector.py"):
        raise RuntimeError("adapter or metadata parser changed after planning")
    if manifest.get("toolSha256") != {name: sha256_file(ROOT / "tools" / name) for name in FROZEN_TOOLS}:
        raise RuntimeError("shared import or synchronization code changed after planning")
    verify_frozen_files(source, manifest, workers)
    old_book, old_index = verify_baseline(manifest, report, root)
    groups = group_rows(manifest["images"])
    if [{"id": g["id"], "artist": g["title"], "files": [r["file"] for r in g["members"]]} for g in groups] != manifest["groups"]:
        raise ValueError("frozen groups changed")
    book_path, index_path, thumb_dir, original_dir = target_paths(root)
    if not thumb_dir.is_dir() or not original_dir.is_dir():
        raise RuntimeError("existing dictionary asset directories missing")
    ensure_targets_absent(groups, thumb_dir, original_dir)
    thumb_stage = make_staging_directory(thumb_dir.parent, f".{CODEX_ID}-baolong-thumbs-")
    original_stage = make_staging_directory(original_dir.parent, f".{CODEX_ID}-baolong-originals-")
    state = {"status": "staging", "staging": {"thumbs": str(thumb_stage), "originals": str(original_stage)},
             "moved": 0, "report": str(report)}
    save_state(report, state)
    try:
        tasks = [{"entryId": g["id"], "thumbDir": str(thumb_stage), "originalDir": str(original_stage),
                  "sources": [{"sourcePath": str(source_file(source, row["file"])), "sha256": row["sha256"],
                               "imageFields": {"rawTag": g["tags"]}} for row in g["members"]]} for g in groups]
        assets = {asset["entryId"]: asset for asset in run_parallel("Write staged media", write_source_asset, tasks, workers)}
        book, index = compose_payload(old_book, old_index, groups, assets)
        check_payload(book, index, old_book, old_index, groups)
        validate_media(book, groups, thumb_stage, original_stage, workers)
        write_json(report / "candidate-book.json", book)
        write_json(report / "candidate-index.json", index)
        state.update(bookSha256=sha256_file(report / "candidate-book.json"), indexSha256=sha256_file(report / "candidate-index.json"))
        moves = []
        for stage, final in ((thumb_stage, thumb_dir), (original_stage, original_dir)):
            for path in sorted(stage.iterdir()):
                moves.append({"source": str(path), "target": str(final / path.name), "sha256": sha256_file(path)})
        write_json(report / "transaction-media.json", moves)
        verify_baseline(manifest, report, root)
        ensure_targets_absent(groups, thumb_dir, original_dir)
        state["status"] = "moving_media"
        save_state(report, state)
        for i, move in enumerate(moves, 1):
            destination = Path(move["target"])
            if destination.exists():
                raise RuntimeError(f"media appeared during commit: {destination}")
            Path(move["source"]).rename(destination)
            if i % 500 == 0:
                state["moved"] = i
                save_state(report, state)
                print(f"Move media: {i}/{len(moves)}", flush=True)
        state.update(status="replacing_json", moved=len(moves))
        save_state(report, state)
        verify_baseline(manifest, report, root)
        atomic_bytes(book_path, (report / "candidate-book.json").read_bytes())
        atomic_bytes(index_path, (report / "candidate-index.json").read_bytes())
        state["status"] = "complete"
        save_state(report, state)
    except BaseException as exc:
        state["status"] = "apply_failed"
        state["error"] = f"{type(exc).__name__}: {exc}"
        save_state(report, state)
        try:
            recover_transaction(report, root)
        except BaseException as recovery_error:
            state.update(status="recovery_required", recoveryError=f"{type(recovery_error).__name__}: {recovery_error}")
            save_state(report, state)
        raise
    return {"status": "applied", **manifest["summary"], "pendingEntries": 0,
            "totalEntries": len(book["entries"]), "oldEntriesPreservedExceptIsNew": True}


def validate_installed(source: Path, report: Path, workers: int, root: Path = ROOT) -> dict:
    manifest = read_json(report / "manifest.json")
    verify_frozen_files(source, manifest, workers)
    old_book, old_index = read_json(report / "before-book.json"), read_json(report / "before-index.json")
    if sha256_file(report / "before-book.json") != manifest["oldBookSha256"] or sha256_file(report / "before-index.json") != manifest["oldIndexSha256"]:
        raise RuntimeError("baseline snapshots changed")
    book_path, index_path, thumb_dir, original_dir = target_paths(root)
    book, index = read_json(book_path), read_json(index_path)
    groups = group_rows(manifest["images"])
    check_payload(book, index, old_book, old_index, groups)
    results = validate_media(book, groups, thumb_dir, original_dir, workers)
    result = {"status": "validated", "entries": len(results), "images": sum(r["images"] for r in results),
              "oldEntriesPreservedExceptIsNew": True,
              "oldIsNewCleared": sum(e.get("isNew") is True for e in old_book["entries"]),
              "oldOtherFieldChanges": 0, "pendingEntries": 0, "totalEntries": len(book["entries"]),
              "bookSha256": sha256_file(book_path), "indexSha256": sha256_file(index_path)}
    write_json(report / "validation.json", result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT.parent / "新数据/单画师例图webp")
    parser.add_argument("--report-dir", type=Path, default=ROOT / "output/single-artist-import-20261024")
    parser.add_argument("--workers", type=int, default=8)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--validate", action="store_true")
    mode.add_argument("--recover", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.workers <= 32:
        parser.error("--workers must be between 1 and 32")
    source, report = args.source.resolve(), args.report_dir.resolve()
    if not report.is_relative_to((ROOT / "output").resolve()) or report == (ROOT / "output").resolve():
        parser.error("--report-dir must be a dedicated directory below project output/")
    try:
        if args.recover:
            result = recover_transaction(report)
        elif args.apply:
            result = apply_plan(source, report, args.workers)
        elif args.validate:
            result = validate_installed(source, report, args.workers)
        else:
            result = create_plan(source, report, args.workers)
        print(json.dumps(result, ensure_ascii=True), flush=True)
        return 0
    except Exception as exc:
        report.mkdir(parents=True, exist_ok=True)
        write_json(report / "error.json", {"type": type(exc).__name__, "message": str(exc)})
        print(f"FAILED: {type(exc).__name__}; see report-dir/error.json", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
