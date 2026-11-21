# -*- coding: utf-8 -*-
"""Lossless, deterministic template deduplication for codex entry notes.

Compresses repeated full notes and repeated parameterized note templates
(such as identical provenance headers with per-entry artist tags or seeds)
into a top-level `noteTemplates` table on each codex JSON.

Format:
  - `codex["noteTemplates"]`: list where each item is either:
      * `str` (exact repeated note) -> referenced as `entry["note"] = int_idx`
      * `list[str]` of length K+1 (parameterized segments) -> referenced as
        `entry["note"] = [int_idx, arg0, ..., arg_{K-1}]`
  - Unmatched/rare notes remain plain `str`, so hand-edited or newly imported
    entries coexist peacefully with packed entries.

Usage:
  python tools/codex_note_pack.py             # dry-run plan (default)
  python tools/codex_note_pack.py --apply     # pack eligible codex files
  python tools/codex_note_pack.py --unpack    # restore plain-string notes
"""

from __future__ import annotations

import argparse
import collections
import gzip
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "site" / "data"

EXACT_MIN_COUNT = 3
EXACT_MIN_SAVINGS = 512
PARAM_MIN_COUNT = 10
PARAM_MIN_SAVINGS = 4096
BOOK_MIN_SAVINGS = 4096

SEED_RE = re.compile(r"(?i)(\bseed(?:\s*[:：]\s*|\s+))(\d{4,15})(?!\d)")
ARTIST_LINE_RE = re.compile(r"(?m)^(artist:[^\r\n,]+)")


def resolve_entry_note(raw_note: Any, templates: Any) -> str:
    """Expand a plain or template-packed entry note back to its exact string."""
    if raw_note is None or raw_note == "":
        return ""
    if isinstance(raw_note, str):
        return raw_note
    if not isinstance(templates, list):
        return ""
    if isinstance(raw_note, int) and not isinstance(raw_note, bool):
        if 0 <= raw_note < len(templates):
            tpl = templates[raw_note]
            if isinstance(tpl, str):
                return tpl
            if isinstance(tpl, list) and len(tpl) == 1 and isinstance(tpl[0], str):
                return tpl[0]
        return ""
    if isinstance(raw_note, list) and raw_note:
        idx = raw_note[0]
        if isinstance(idx, int) and not isinstance(idx, bool) and 0 <= idx < len(templates):
            tpl = templates[idx]
            args = raw_note[1:]
            if isinstance(tpl, list) and len(tpl) == len(args) + 1:
                out: list[str] = []
                for i, part in enumerate(tpl):
                    out.append(str(part))
                    if i < len(args):
                        out.append(str(args[i]))
                return "".join(out)
    return ""


def expand_codex_notes(codex: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Return a shallow-copied codex with all entry notes expanded to plain strings."""
    templates = codex.get("noteTemplates")
    entries = codex.get("entries")
    if not isinstance(entries, list):
        out = dict(codex)
        out.pop("noteTemplates", None)
        return out, 0
    changed = 0
    new_entries: list[Any] = []
    for entry in entries:
        if isinstance(entry, dict) and "note" in entry and not isinstance(entry["note"], str):
            expanded = resolve_entry_note(entry["note"], templates)
            if not expanded and entry["note"] not in (None, ""):
                raise ValueError(f"cannot expand packed note on entry {entry.get('id')!r}")
            ne = dict(entry)
            ne["note"] = expanded
            new_entries.append(ne)
            changed += 1
        else:
            new_entries.append(entry)
    out = dict(codex)
    out.pop("noteTemplates", None)
    out["entries"] = new_entries
    return out, changed


def _extract_param_skeleton(note: str, entry: dict[str, Any]) -> tuple[tuple[str, ...], list[str]] | None:
    """Split a note into (literal_parts, slot_values) by masking variable tokens."""
    spans: list[tuple[int, int]] = []

    for match in SEED_RE.finditer(note):
        spans.append((match.start(2), match.end(2)))

    for match in ARTIST_LINE_RE.finditer(note):
        spans.append((match.start(1), match.end(1)))

    tags = str(entry.get("tags") or "").strip()
    if 4 <= len(tags) <= 120 and "\n" not in tags and "\r" not in tags and tags.startswith("artist:"):
        start = 0
        while True:
            pos = note.find(tags, start)
            if pos < 0:
                break
            spans.append((pos, pos + len(tags)))
            start = pos + len(tags)

    if not spans:
        return None

    # Sort and drop overlapping spans (prefer earlier, longer span).
    spans.sort(key=lambda item: (item[0], -(item[1] - item[0])))
    merged: list[tuple[int, int]] = []
    for s, e in spans:
        if not merged or s >= merged[-1][1]:
            merged.append((s, e))

    if not merged or len(merged) > 8:
        return None

    parts: list[str] = []
    values: list[str] = []
    cursor = 0
    for s, e in merged:
        parts.append(note[cursor:s])
        values.append(note[s:e])
        cursor = e
    parts.append(note[cursor:])
    return tuple(parts), values


def _json_len(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def pack_codex_notes(codex: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Pack repeated notes into `noteTemplates`. Lossless and idempotent."""
    base, _ = expand_codex_notes(codex)
    entries = base.get("entries")
    if not isinstance(entries, list) or not entries:
        return base, {"packed": 0, "templates": 0, "savedBytes": 0}

    # Step 1: exact repeated notes.
    exact_counts: collections.Counter[str] = collections.Counter()
    for entry in entries:
        if isinstance(entry, dict):
            note = entry.get("note")
            if isinstance(note, str) and note:
                exact_counts[note] += 1

    exact_candidates: list[tuple[int, str]] = []
    for note, count in exact_counts.items():
        if count < EXACT_MIN_COUNT:
            continue
        raw_cost = _json_len(note) * count
        packed_cost = _json_len(note) + 3 + count * 2
        saved = raw_cost - packed_cost
        if saved >= EXACT_MIN_SAVINGS:
            exact_candidates.append((saved, note))

    exact_set = {note for _, note in exact_candidates}

    # Step 2: parameterized repeated templates for remaining notes.
    param_groups: dict[tuple[str, ...], list[tuple[int, list[str], str]]] = collections.defaultdict(list)
    for idx, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        note = entry.get("note")
        if not isinstance(note, str) or not note or note in exact_set:
            continue
        skel = _extract_param_skeleton(note, entry)
        if skel is None:
            continue
        parts, values = skel
        param_groups[parts].append((idx, values, note))

    param_candidates: list[tuple[int, tuple[str, ...]]] = []
    for parts, items in param_groups.items():
        if len(items) < PARAM_MIN_COUNT:
            continue
        raw_cost = sum(_json_len(note) for _, _, note in items)
        tpl_list = list(parts)
        packed_cost = _json_len(tpl_list) + 3 + sum(_json_len([0, *vals]) for _, vals, _ in items)
        saved = raw_cost - packed_cost
        if saved >= PARAM_MIN_SAVINGS:
            param_candidates.append((saved, parts))

    # Deterministic template ordering by savings desc, then serialized form.
    all_templates: list[tuple[int, str, Any]] = []
    for saved, note in exact_candidates:
        all_templates.append((saved, json.dumps(note, ensure_ascii=False), note))
    for saved, parts in param_candidates:
        tpl_list = list(parts)
        all_templates.append((saved, json.dumps(tpl_list, ensure_ascii=False), tpl_list))
    all_templates.sort(key=lambda item: (-item[0], item[1]))

    if not all_templates:
        return base, {"packed": 0, "templates": 0, "savedBytes": 0}

    templates: list[Any] = [item[2] for item in all_templates]
    exact_index = {tpl: i for i, tpl in enumerate(templates) if isinstance(tpl, str)}
    param_index = {tuple(tpl): i for i, tpl in enumerate(templates) if isinstance(tpl, list)}

    param_entry_map: dict[int, tuple[int, list[str]]] = {}
    for parts, t_idx in param_index.items():
        for entry_idx, values, _ in param_groups[parts]:
            param_entry_map[entry_idx] = (t_idx, values)

    new_entries: list[Any] = []
    packed_count = 0
    for idx, entry in enumerate(entries):
        if not isinstance(entry, dict):
            new_entries.append(entry)
            continue
        note = entry.get("note")
        if isinstance(note, str) and note in exact_index:
            ne = dict(entry)
            ne["note"] = exact_index[note]
            new_entries.append(ne)
            packed_count += 1
        elif idx in param_entry_map:
            t_idx, values = param_entry_map[idx]
            ne = dict(entry)
            ne["note"] = [t_idx, *values]
            new_entries.append(ne)
            packed_count += 1
        else:
            new_entries.append(entry)

    # Lossless verification on every single entry.
    for orig, packed in zip(entries, new_entries):
        if isinstance(orig, dict) and "note" in orig:
            restored = resolve_entry_note(packed.get("note"), templates)
            if restored != orig["note"]:
                raise RuntimeError(f"lossless note pack check failed on entry {orig.get('id')!r}")

    out = dict(base)
    out["noteTemplates"] = templates
    out["entries"] = new_entries

    orig_bytes = len(json.dumps(base, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    new_bytes = len(json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    saved_bytes = orig_bytes - new_bytes
    if saved_bytes < BOOK_MIN_SAVINGS:
        return base, {"packed": 0, "templates": 0, "savedBytes": 0}

    return out, {
        "packed": packed_count,
        "templates": len(templates),
        "savedBytes": saved_bytes,
        "origBytes": orig_bytes,
        "newBytes": new_bytes,
    }


def _serialize_codex(codex: dict[str, Any], raw_before: bytes) -> bytes:
    """Keep compact files compact and pretty files pretty."""
    # Heuristic: if the original file had no newline in its first 200 bytes, treat as compact.
    is_compact = b"\n" not in raw_before[:200]
    if is_compact:
        return json.dumps(codex, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return (json.dumps(codex, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _atomic_write(path: Path, body: bytes) -> None:
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(body)
        os.replace(tmp_path, path)
    except BaseException:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def process_data_dir(data_dir: Path = DATA_DIR, *, apply: bool = False, unpack: bool = False) -> list[dict[str, Any]]:
    codexes_path = data_dir / "codexes.json"
    if not codexes_path.is_file():
        raise FileNotFoundError(f"missing {codexes_path}")
    codexes = json.loads(codexes_path.read_text(encoding="utf-8"))
    results: list[dict[str, Any]] = []
    for item in codexes:
        if not isinstance(item, dict) or item.get("dataUrl"):
            continue
        cid = str(item.get("id") or "").strip()
        if not cid:
            continue
        path = data_dir / f"{cid}.json"
        if not path.is_file():
            continue
        raw_before = path.read_bytes()
        data = json.loads(raw_before.decode("utf-8"))
        if unpack:
            out, changed = expand_codex_notes(data)
            if not changed and "noteTemplates" not in data:
                continue
            body = _serialize_codex(out, raw_before)
            if apply and body != raw_before:
                _atomic_write(path, body)
            results.append({
                "id": cid,
                "action": "unpack",
                "changed": changed,
                "beforeBytes": len(raw_before),
                "afterBytes": len(body),
                "wrote": bool(apply and body != raw_before),
            })
            continue

        out, stats = pack_codex_notes(data)
        if stats["savedBytes"] <= 0:
            continue
        body = _serialize_codex(out, raw_before)
        gz_before = len(gzip.compress(raw_before, compresslevel=6))
        gz_after = len(gzip.compress(body, compresslevel=6))
        wrote = False
        if apply and body != raw_before:
            _atomic_write(path, body)
            wrote = True
        results.append({
            "id": cid,
            "action": "pack",
            "packed": stats["packed"],
            "templates": stats["templates"],
            "beforeBytes": len(raw_before),
            "afterBytes": len(body),
            "savedBytes": len(raw_before) - len(body),
            "gzBefore": gz_before,
            "gzAfter": gz_after,
            "wrote": wrote,
        })
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Deduplicate repeated codex entry notes via noteTemplates.")
    parser.add_argument("--apply", action="store_true", help="Write changes back to site/data (default is dry-run).")
    parser.add_argument("--unpack", action="store_true", help="Restore plain-string notes instead of packing.")
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR, help="Target data directory (default site/data).")
    args = parser.parse_args(argv)

    do_unpack = bool(args.unpack)
    do_apply = bool(args.apply)
    results = process_data_dir(args.data_dir, apply=do_apply, unpack=do_unpack)
    if not results:
        print("note pack: no codexes need changes")
        return 0
    for row in results:
        if row["action"] == "unpack":
            print(
                f"{row['id']}: unpack {row['changed']} notes "
                f"({row['beforeBytes']} -> {row['afterBytes']} B)"
                + (" [WROTE]" if row["wrote"] else " [PLAN]")
            )
        else:
            mb_before = row["beforeBytes"] / 1024 / 1024
            mb_after = row["afterBytes"] / 1024 / 1024
            mb_saved = row["savedBytes"] / 1024 / 1024
            print(
                f"{row['id']}: {row['packed']} notes -> {row['templates']} templates, "
                f"{mb_before:.2f} -> {mb_after:.2f} MiB (saved {mb_saved:.2f} MiB), "
                f"gzip {row['gzBefore']/1024:.1f} -> {row['gzAfter']/1024:.1f} KB"
                + (" [WROTE]" if row["wrote"] else " [PLAN]")
            )
    if not do_apply:
        print("plan only; pass --apply to write changes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
