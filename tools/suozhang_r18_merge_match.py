# -*- coding: utf-8 -*-
"""Merge the two 所长色色 source books in memory, then audit or apply an update.

The default mode is read-only with respect to site/data.  It produces a merged
source snapshot plus per-half and combined match reports under output/.  The
``--apply`` mode is accepted only after the same combined matching gate passes.
The stable ID namespaces remain tied to their source halves:

* 上: codex_6e699406-*
* 下: codex_8489ac52-*

The historical merge keeps all upper entries, removes only the duplicated
lower 编纂者常用画师组, and keeps the lower 编纂者oc二则 section.
"""

from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import re
from typing import Any

from codex_update_match import (
    apply_current_update_batch,
    entry_update_batch_ids,
    inspect_docx_package,
    load_codex,
    match_entries,
    normalize_update_batches,
    normalize_suozhang_entries,
    norm_path,
    norm_tags,
    norm_title,
    parse_docx_items,
    previous_latest_update_batch_id,
    seed_previous_update_batch,
    update_filter_label,
    update_filter_history,
    validate_update_batch_contract,
    validate_codex_identity,
    write_json_pair_with_rollback,
    write_report,
)
import convert


ROOT = Path(__file__).resolve().parents[1]
UPPER_PREFIX = "codex_6e699406"
LOWER_PREFIX = "codex_8489ac52"
HALF_PREFIXES = {"upper": UPPER_PREFIX, "lower": LOWER_PREFIX}
RISKY_STRUCTURE_KEYS = (
    "tables",
    "drawings",
    "textBoxes",
    "trackedInsertions",
    "trackedDeletions",
)
CONTENT_KEYS = ("title", "path", "tags", "characterPrompts", "isNew")
ASSET_KEYS = ("image", "original", "assetRev", "imageWidth", "imageHeight")
MANUAL_MATCH_RULES = (
    {
        "key": "upper_desk_humping_three_to_one",
        "oldId": "codex_6e699406-2544",
        "newHalf": "upper",
        "newPath": ["各种涩涩", "1girl系列", "自慰"],
        "newTitle": "桌角自慰",
        "decision": (
            "2026.7.15 的主卡及两个“其他版本”在相同前后锚点间合并为一张重写主卡；"
            "保留旧主卡 ID 与图片，两个旧变体仍删除。"
        ),
    },
    {
        "key": "upper_face_closeup_831_rewrite",
        "oldId": "codex_6e699406-5475",
        "newHalf": "upper",
        "newPath": ["基础涩涩", "各种体位", "后入/背后位"],
        "newTitle": "脸部特写掐脸压身后入",
        "decision": (
            "2026.8.31 将“脸部特写全压身掐脸后入”改名，并把原 char1/char2 "
            "正文并回主串；提示词主体、目录和前后位置均连续，保留旧 ID 与图片。"
        ),
    },
)

KNOWN_SOURCE_TITLE_CORRECTIONS = (
    {
        "key": "upper_swapped_title_corrupted_after",
        "formalId": "codex_6e699406-4863",
        "half": "upper",
        "path": ["各种涩涩", "2+girl/+1boy系列", "协作侍奉"],
        "sourceTitle": "被胁迫预备摄影学生少女",
        "correctedTitle": "恶堕之后",
    },
    {
        "key": "upper_swapped_title_coerced_students",
        "formalId": "codex_6e699406-4864",
        "half": "upper",
        "path": ["各种涩涩", "2+girl/+1boy系列", "协作侍奉"],
        "sourceTitle": "恶堕之后",
        "correctedTitle": "被胁迫预备摄影学生少女",
    },
)


def fingerprint(entry: dict[str, Any]) -> tuple[tuple[str, ...], str, str]:
    return norm_path(entry), norm_title(entry), norm_tags(entry)


def is_artist_group_entry(entry: dict[str, Any]) -> bool:
    return entry.get("path", [])[-1:] == ["编纂者常用画师组"]


def is_compiler_oc_entry(entry: dict[str, Any]) -> bool:
    return convert.is_compiler_oc_path(entry.get("path", []))


def _annotate(entries: list[dict[str, Any]], half: str) -> list[dict[str, Any]]:
    return [
        {**entry, "sourceHalf": half, "sourceIndex": index}
        for index, entry in enumerate(entries)
    ]


def merge_source_halves(
    upper_entries: list[dict[str, Any]],
    lower_entries: list[dict[str, Any]],
) -> dict[str, Any]:
    """Apply the historical logical merge without assigning IDs or writing data."""
    upper_artist = [entry for entry in upper_entries if is_artist_group_entry(entry)]
    lower_artist = [entry for entry in lower_entries if is_artist_group_entry(entry)]
    upper_artist_counts = Counter(fingerprint(entry) for entry in upper_artist)
    lower_artist_counts = Counter(fingerprint(entry) for entry in lower_artist)
    conflicts = lower_artist_counts - upper_artist_counts
    if conflicts:
        details = [
            {"path": list(key[0]), "title": key[1], "tags": key[2], "count": count}
            for key, count in conflicts.items()
        ]
        raise ValueError(
            "Lower artist-group entries are not an exact subset of upper: "
            + json.dumps(details, ensure_ascii=False)
        )

    kept_lower = [entry for entry in lower_entries if not is_artist_group_entry(entry)]
    merged = _annotate(upper_entries, "upper") + _annotate(kept_lower, "lower")
    special = {
        "upperArtistCards": len(upper_artist),
        "lowerArtistCardsRemoved": len(lower_artist),
        "upperOcCards": sum(is_compiler_oc_entry(entry) for entry in upper_entries),
        "lowerOcCardsKept": sum(is_compiler_oc_entry(entry) for entry in kept_lower),
        "unnamedSpecialCards": sum(
            entry.get("title") == "(未命名)"
            for entry in merged
            if is_artist_group_entry(entry) or is_compiler_oc_entry(entry)
        ),
        "markerLeaks": sum(
            any(marker in str(entry.get("tags", "")) for marker in ("（本体）", "（服装）"))
            for entry in merged
            if is_compiler_oc_entry(entry)
        ),
    }
    return {
        "upper": [dict(entry) for entry in upper_entries],
        "lower": [dict(entry) for entry in kept_lower],
        "merged": merged,
        "stats": {
            "upperParsed": len(upper_entries),
            "lowerParsed": len(lower_entries),
            "lowerArtistCardsRemoved": len(lower_artist),
            "lowerKept": len(kept_lower),
            "mergedCount": len(merged),
            "artistSubsetVerified": True,
        },
        "special": special,
    }


def split_legacy_oc_blocks(tags: str) -> list[str]:
    """Split one legacy giant OC tag into 本体+服装 blocks."""
    blocks: list[list[str]] = []
    current: list[str] | None = None
    for raw_line in str(tags or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parsed = convert.split_compiler_oc_marker(line)
        if parsed is None:
            if current is None:
                return []
            current.append(line)
            continue
        body, marker = parsed
        if marker == "本体":
            if current:
                blocks.append(current)
            current = [body] if body else []
        else:
            if current is None:
                return []
            if body:
                current.append(body)
    if current:
        blocks.append(current)
    return ["\n".join(parts).strip() for parts in blocks if any(parts)]


def normalize_legacy_oc_entries(
    entries: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Map a legacy giant OC card to OC(1), recording virtual OC(2..N) cards."""
    normalized: list[dict[str, Any]] = []
    records: list[dict[str, Any]] = []
    for entry in entries:
        blocks = (
            split_legacy_oc_blocks(str(entry.get("tags", "")))
            if is_compiler_oc_entry(entry)
            else []
        )
        if len(blocks) < 2:
            normalized.append(dict(entry))
            continue

        first = dict(entry)
        first["title"] = "编纂者OC(1)"
        first["tags"] = blocks[0]
        normalized.append(first)
        structural_entries = [
            {
                "title": f"编纂者OC({index})",
                "path": list(entry.get("path", [])),
                "tags": block,
                "isNew": bool(entry.get("isNew", False)),
            }
            for index, block in enumerate(blocks[1:], 2)
        ]
        records.append({
            "oldId": entry.get("id"),
            "path": list(entry.get("path", [])),
            "blockCount": len(blocks),
            "retainedAs": first["title"],
            "structuralEntries": structural_entries,
        })
    return normalized, records


def partition_formal_entries(entries: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    result = {"upper": [], "lower": []}
    unknown: list[str] = []
    for entry in entries:
        entry_id = str(entry.get("id", ""))
        if entry_id.startswith(UPPER_PREFIX + "-"):
            result["upper"].append(entry)
        elif entry_id.startswith(LOWER_PREFIX + "-"):
            result["lower"].append(entry)
        else:
            unknown.append(entry_id)
    if unknown:
        raise ValueError(f"Unknown merged-book ID namespaces: {unknown[:20]}")
    return result


def apply_known_source_title_corrections(
    entries: list[dict[str, Any]],
    formal_entries: list[dict[str, Any]],
    *,
    half: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Replay narrowly audited local title fixes still absent from source Word.

    The correction is allowed only when the formal stable ID, path, corrected
    title and normalized tags all identify the same unique source card.  This
    prevents a title-only rule from swallowing a real later edit.
    """
    corrected_entries = [dict(entry) for entry in entries]
    audit: list[dict[str, Any]] = []
    for rule in KNOWN_SOURCE_TITLE_CORRECTIONS:
        if rule["half"] != half:
            continue

        formal_hits = [
            entry
            for entry in formal_entries
            if entry.get("id") == rule["formalId"]
        ]
        if len(formal_hits) != 1:
            raise ValueError(
                f"known source title correction {rule['key']} expected one formal ID "
                f"{rule['formalId']}, found {len(formal_hits)}"
            )
        formal = formal_hits[0]
        if (
            norm_path(formal) != tuple(rule["path"])
            or norm_title(formal) != norm_title({"title": rule["correctedTitle"]})
        ):
            raise ValueError(
                f"known source title correction {rule['key']} no longer matches the "
                "formal path/title"
            )

        source_hits = [
            index
            for index, entry in enumerate(corrected_entries)
            if norm_path(entry) == tuple(rule["path"])
            and str(entry.get("title", ""))
            in {rule["sourceTitle"], rule["correctedTitle"]}
            and norm_tags(entry) == norm_tags(formal)
        ]
        if len(source_hits) != 1:
            raise ValueError(
                f"known source title correction {rule['key']} expected one source "
                f"card with stable tags, found {len(source_hits)}"
            )

        source_index = source_hits[0]
        original_title = str(corrected_entries[source_index].get("title", ""))
        status = "already_correct"
        if original_title != rule["correctedTitle"]:
            corrected_entries[source_index] = {
                **corrected_entries[source_index],
                "title": rule["correctedTitle"],
            }
            status = "applied"
        audit.append(
            {
                "key": rule["key"],
                "formalId": rule["formalId"],
                "sourceIndex": source_index,
                "sourceTitle": original_title,
                "correctedTitle": rule["correctedTitle"],
                "status": status,
            }
        )
    return corrected_entries, audit


def resolve_manual_match_overrides(
    old_entries: list[dict[str, Any]],
    new_entries: list[dict[str, Any]],
    *,
    context: str,
) -> tuple[dict[int, int], list[dict[str, Any]]]:
    """Resolve audited stable-ID rules against exact, unique source content.

    ``context`` is either ``upper``, ``lower``, or ``global``.  The global
    merged candidates must carry ``sourceHalf`` so a same-title card in the
    other source book can never activate an upper-book rule.
    """
    if context not in {"upper", "lower", "global"}:
        raise ValueError(f"invalid manual override context: {context}")

    forced_pairs: dict[int, int] = {}
    audit: list[dict[str, Any]] = []
    for rule in MANUAL_MATCH_RULES:
        record = {
            "key": rule["key"],
            "context": context,
            "oldId": rule["oldId"],
            "newHalf": rule["newHalf"],
            "newPath": list(rule["newPath"]),
            "newTitle": rule["newTitle"],
            "decision": rule["decision"],
            "applied": False,
        }
        if context != "global" and context != rule["newHalf"]:
            record["status"] = "not_applicable_to_half"
            audit.append(record)
            continue

        old_hits = [
            index
            for index, entry in enumerate(old_entries)
            if entry.get("id") == rule["oldId"]
        ]
        new_hits = [
            index
            for index, entry in enumerate(new_entries)
            if list(entry.get("path", [])) == rule["newPath"]
            and str(entry.get("title", "")) == rule["newTitle"]
            and (
                context != "global"
                or entry.get("sourceHalf") == rule["newHalf"]
            )
        ]
        if len(old_hits) > 1:
            raise ValueError(
                f"manual override {rule['key']} old ID is not unique: {old_hits}"
            )
        if len(new_hits) > 1:
            raise ValueError(
                f"manual override {rule['key']} new locator is not unique: {new_hits}"
            )
        if not old_hits or not new_hits:
            missing = []
            if not old_hits:
                missing.append("old")
            if not new_hits:
                missing.append("new")
            record["status"] = "not_applied_missing_" + "_and_".join(missing)
            audit.append(record)
            continue

        old_index = old_hits[0]
        new_index = new_hits[0]
        forced_pairs[old_index] = new_index
        record.update({
            "applied": True,
            "status": "applied",
            "oldIndex": old_index,
            "newIndex": new_index,
            "oldTitle": old_entries[old_index].get("title", ""),
            "oldPath": list(old_entries[old_index].get("path", [])),
            "newTags": new_entries[new_index].get("tags", ""),
        })
        audit.append(record)

    return forced_pairs, audit


def collect_reserved_asset_ids() -> set[str]:
    """Reserve IDs already present in local merged-book asset directories."""
    reserved: set[str] = set()
    for base in (ROOT / "site" / "images" / "suozhang_r18", ROOT / "originals" / "suozhang_r18"):
        if not base.is_dir():
            continue
        for path in base.iterdir():
            if not path.is_file():
                continue
            stem = path.stem
            if any(re.fullmatch(re.escape(prefix) + r"-\d+", stem) for prefix in HALF_PREFIXES.values()):
                reserved.add(stem)
    return reserved


def build_applied_codex(
    codex: dict[str, Any],
    merged_entries: list[dict[str, Any]],
    match_result: dict[str, Any],
    new_version: str,
    *,
    reserved_ids: set[str] | None = None,
    previous_update_filters: Any = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Build the exact formal JSON without writing it.

    Matched candidates inherit the original ID and every existing asset field.
    Unmatched candidates receive a fresh ID in their source half's namespace.
    """
    if match_result["validationIssues"]:
        raise ValueError(f"cannot apply with validation issues: {match_result['validationIssues']}")
    if match_result["review"]:
        raise ValueError("cannot apply with unresolved match review items")

    old_entries = codex["entries"]
    old_by_new: dict[int, int] = {}
    used_old_indices: set[int] = set()
    for match in match_result["matches"]:
        new_index = int(match["new"]["index"])
        old_index = int(match["old"]["index"])
        if new_index in old_by_new or old_index in used_old_indices:
            raise ValueError("match result reuses an old or new entry index")
        old_by_new[new_index] = old_index
        used_old_indices.add(old_index)

    addition_indices = {int(entry["index"]) for entry in match_result["additions"]}
    expected_additions = set(range(len(merged_entries))) - set(old_by_new)
    if addition_indices != expected_additions:
        raise ValueError("match additions do not cover every unmatched merged entry exactly once")

    old_ids = {str(entry.get("id")) for entry in old_entries if entry.get("id")}
    reserved = set(reserved_ids or ()) | old_ids
    max_numbers = {half: 0 for half in HALF_PREFIXES}
    for entry_id in reserved:
        for half, prefix in HALF_PREFIXES.items():
            match = re.fullmatch(re.escape(prefix) + r"-(\d+)", entry_id)
            if match:
                max_numbers[half] = max(max_numbers[half], int(match.group(1)))

    next_numbers = {half: number + 1 for half, number in max_numbers.items()}
    used_ids: set[str] = set()
    assigned: dict[str, list[str]] = {half: [] for half in HALF_PREFIXES}

    def fresh_id(half: str) -> str:
        if half not in HALF_PREFIXES:
            raise ValueError(f"merged entry has unknown sourceHalf: {half!r}")
        prefix = HALF_PREFIXES[half]
        while True:
            entry_id = f"{prefix}-{next_numbers[half]:04d}"
            next_numbers[half] += 1
            if entry_id not in reserved and entry_id not in used_ids:
                assigned[half].append(entry_id)
                return entry_id

    final_entries: list[dict[str, Any]] = []
    metadata_mismatches: list[dict[str, Any]] = []
    previous_batch_id = previous_latest_update_batch_id(
        codex.get("version"), previous_update_filters
    )
    for new_index, candidate in enumerate(merged_entries):
        source_entry = {
            "title": candidate.get("title", ""),
            "path": list(candidate.get("path", [])),
            "tags": candidate.get("tags", ""),
            "isNew": bool(candidate.get("isNew")),
        }
        if candidate.get("characterPrompts"):
            source_entry["characterPrompts"] = [
                dict(item) for item in candidate["characterPrompts"]
            ]
        old_index = old_by_new.get(new_index)
        if old_index is None:
            entry = source_entry
            entry["id"] = fresh_id(str(candidate.get("sourceHalf", "")))
            entry["image"] = None
        else:
            old = old_entries[old_index]
            entry = {
                key: value
                for key, value in old.items()
                if key not in {"assetCodexId", "sourceHalf", "sourceIndex"}
            }
            seed_previous_update_batch(entry, previous_batch_id)
            for key in CONTENT_KEYS:
                if key in source_entry:
                    entry[key] = source_entry[key]
                elif key == "characterPrompts":
                    entry.pop(key, None)
            entry["id"] = old["id"]
            if "image" not in entry:
                entry["image"] = None
            old_meta = {"image": old.get("image")}
            new_meta = {"image": entry.get("image")}
            for key in ASSET_KEYS[1:]:
                if key in old:
                    old_meta[key] = old[key]
                if key in entry:
                    new_meta[key] = entry[key]
            if old_meta != new_meta:
                metadata_mismatches.append({
                    "id": old.get("id"),
                    "old": old_meta,
                    "new": new_meta,
                })

        apply_current_update_batch(entry, new_version)

        entry_id = str(entry["id"])
        if entry_id in used_ids:
            raise ValueError(f"duplicate final ID: {entry_id}")
        used_ids.add(entry_id)
        final_entries.append(entry)

    is_new_ids = {
        str(entry.get("id")) for entry in final_entries if entry.get("isNew") is True
    }
    latest_batch_ids = {
        str(entry.get("id"))
        for entry in final_entries
        if new_version in normalize_update_batches(entry)
    }
    if is_new_ids != latest_batch_ids:
        raise ValueError("isNew entries must exactly match the latest update batch")

    if metadata_mismatches:
        raise ValueError(f"asset metadata inheritance drift: {metadata_mismatches[:10]}")
    if len(final_entries) != len(merged_entries) or len(used_ids) != len(final_entries):
        raise ValueError("final entry coverage or ID uniqueness failed")
    if any("sourceHalf" in entry or "sourceIndex" in entry for entry in final_entries):
        raise ValueError("source-only annotations leaked into formal entries")
    if any("assetCodexId" in entry for entry in final_entries):
        raise ValueError("legacy assetCodexId must not return to suozhang_r18")

    removed = [
        entry for index, entry in enumerate(old_entries) if index not in used_old_indices
    ]
    applied = dict(codex)
    applied.update({
        "version": new_version,
        "entryCount": len(final_entries),
        "imagedCount": sum(bool(entry.get("image")) for entry in final_entries),
        "tree": convert.build_tree(final_entries),
        "entries": final_entries,
    })
    assignment_summary = {
        half: {
            "count": len(ids),
            "first": ids[0] if ids else None,
            "last": ids[-1] if ids else None,
        }
        for half, ids in assigned.items()
    }
    stats = {
        "finalEntryCount": applied["entryCount"],
        "finalImagedCount": applied["imagedCount"],
        "matchedInherited": len(old_by_new),
        "matchedImagedInherited": sum(
            bool(old_entries[index].get("image")) for index in used_old_indices
        ),
        "newIdCount": sum(len(ids) for ids in assigned.values()),
        "newIds": assignment_summary,
        "removedCount": len(removed),
        "removedImagedCount": sum(bool(entry.get("image")) for entry in removed),
        "removedIds": [entry.get("id") for entry in removed],
        "reservedAssetIdCount": len(set(reserved_ids or ())),
        "metadataMismatches": 0,
        "latestUpdateBatchCount": sum(
            new_version in normalize_update_batches(entry)
            for entry in final_entries
        ),
    }
    return applied, stats


def build_updated_codex_index(
    index: list[dict[str, Any]], applied_codex: dict[str, Any]
) -> list[dict[str, Any]]:
    """Refresh only generated summary fields while preserving index metadata."""
    updated: list[dict[str, Any]] = []
    found = 0
    for item in index:
        if item.get("id") != "suozhang_r18":
            updated.append(dict(item))
            continue
        found += 1
        value = dict(item)
        batch_ids = entry_update_batch_ids(applied_codex.get("entries", []))
        filters = update_filter_history(
            value.get("updateFilters"),
            applied_codex["version"],
            required_batch_ids=batch_ids,
        )
        validate_update_batch_contract(applied_codex, filters)
        value.update({
            "version": applied_codex["version"],
            "entryCount": applied_codex["entryCount"],
            "imagedCount": applied_codex["imagedCount"],
            "newFilterLabel": update_filter_label(applied_codex["version"]),
            "updateFilters": filters,
        })
        updated.append(value)
    if found != 1:
        raise ValueError(f"expected one suozhang_r18 index item, found {found}")
    return updated


def _consume_known_additions(
    additions: list[dict[str, Any]],
    structural_entries: list[dict[str, Any]],
    baseline_unmatched_new: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    structural_counts = Counter(fingerprint(entry) for entry in structural_entries)
    baseline_counts = Counter(fingerprint(entry) for entry in baseline_unmatched_new)
    structural: list[dict[str, Any]] = []
    preexisting_source: list[dict[str, Any]] = []
    genuine: list[dict[str, Any]] = []
    for entry in additions:
        key = fingerprint(entry)
        if structural_counts[key]:
            structural_counts[key] -= 1
            if baseline_counts[key]:
                baseline_counts[key] -= 1
            structural.append(entry)
        elif baseline_counts[key]:
            baseline_counts[key] -= 1
            preexisting_source.append(entry)
        else:
            genuine.append(entry)
    return structural, preexisting_source, genuine


def classify_half(
    baseline_result: dict[str, Any],
    new_result: dict[str, Any],
    normalization_records: list[dict[str, Any]],
) -> dict[str, Any]:
    structural_entries = [
        entry
        for record in normalization_records
        for entry in record["structuralEntries"]
    ]
    structural, preexisting_source, genuine_additions = _consume_known_additions(
        new_result["additions"],
        structural_entries,
        baseline_result["unmatchedNew"],
    )
    baseline_old_ids = {
        entry.get("id") for entry in baseline_result["unmatchedOld"] if entry.get("id")
    }
    preexisting_formal = [
        entry for entry in new_result["removals"] if entry.get("id") in baseline_old_ids
    ]
    genuine_removals = [
        entry for entry in new_result["removals"] if entry.get("id") not in baseline_old_ids
    ]
    content_changes = [
        match
        for match in new_result["matches"]
        if any(change != "isNew" for change in match["changes"])
    ]
    flag_only = [
        match for match in new_result["matches"] if match["changes"] == ["isNew"]
    ]
    return {
        "structuralOcSplits": structural,
        "preexistingSourceOnlyAdditions": preexisting_source,
        "genuineAdditions": genuine_additions,
        "preexistingFormalOnlyRemovals": preexisting_formal,
        "genuineRemovals": genuine_removals,
        "contentChanges": content_changes,
        "flagOnlyChanges": flag_only,
        "review": new_result["review"],
    }


def _entry_line(entry: dict[str, Any]) -> str:
    path = " > ".join(entry.get("path", []))
    prefix = f"`{entry.get('id')}` " if entry.get("id") else ""
    return f"{prefix}{path} › {entry.get('title', '')}"


def _append_entries(
    lines: list[str], title: str, entries: list[dict[str, Any]], limit: int = 300
) -> None:
    lines.extend([f"## {title}", ""])
    if not entries:
        lines.extend(["无。", ""])
        return
    for entry in entries[:limit]:
        lines.append(f"- {_entry_line(entry)}")
    if len(entries) > limit:
        lines.append(f"- ……其余 {len(entries) - limit} 条见 JSON。")
    lines.append("")


def _structure_safe(structure: dict[str, Any]) -> bool:
    return (
        not any(structure.get(key) for key in RISKY_STRUCTURE_KEYS)
        and not structure.get("commentsPart")
        and not structure.get("trackRevisionsEnabled")
    )


def build_summary_payload(
    *,
    codex: dict[str, Any],
    old_version: str,
    baseline_version: str,
    new_version: str,
    old_merge: dict[str, Any],
    new_merge: dict[str, Any],
    structures: dict[str, dict[str, Any]],
    baseline_global: dict[str, Any],
    new_global: dict[str, Any],
    classification_global: dict[str, Any],
    baseline_results: dict[str, dict[str, Any]],
    new_results: dict[str, dict[str, Any]],
    classifications: dict[str, dict[str, Any]],
    global_normalizations: list[dict[str, Any]],
    normalizations: dict[str, list[dict[str, Any]]],
    character_normalization: dict[str, dict[str, dict[str, Any]]],
    manual_match_overrides: dict[str, Any],
    sources: dict[str, str],
    report_paths: dict[str, str],
) -> dict[str, Any]:
    validation_issues = (
        len(baseline_global["validationIssues"])
        + len(new_global["validationIssues"])
    )
    baseline_reviews = baseline_global["review"]
    baseline_content_drift = baseline_global["summary"]["contentChanged"]
    baseline_strict_replay = bool(
        baseline_global["summary"].get("strictReplayPass")
    )
    reviews = classification_global["review"]
    change_counts = Counter(
        change
        for match in classification_global["contentChanges"]
        for change in match["changes"]
    )
    character_normalization_blockers = sum(
        len(audit.get("blockers", []))
        for stage in character_normalization.values()
        for audit in stage.values()
    )
    special = new_merge["special"]
    gate_pass = (
        validation_issues == 0
        and baseline_strict_replay
        and not baseline_reviews
        and baseline_content_drift == 0
        and not reviews
        and character_normalization_blockers == 0
        and all(_structure_safe(structure) for structure in structures.values())
        and special["upperArtistCards"] > 0
        and special["lowerArtistCardsRemoved"] > 0
        and special["upperOcCards"] > 0
        and special["lowerOcCardsKept"] > 0
        and special["unnamedSpecialCards"] == 0
        and special["markerLeaks"] == 0
    )
    payload = {
        "schema": 1,
        "codexId": "suozhang_r18",
        "oldVersion": old_version,
        "baselineVersion": baseline_version,
        "newVersion": new_version,
        "formalDataUnchanged": True,
        "matchingGatePass": gate_pass,
        "sources": sources,
        "reports": report_paths,
        "wordStructures": structures,
        "merge": {
            "old": old_merge["stats"],
            "new": new_merge["stats"],
            "newSpecialHandling": special,
            "rule": "upper all + lower without duplicated 编纂者常用画师组; keep lower OC",
        },
        "formal": {
            "entryCount": codex.get("entryCount"),
            "imagedCount": codex.get("imagedCount"),
        },
        "baseline": {
            "global": {
                "summary": baseline_global["summary"],
                "unmatchedOld": baseline_global["unmatchedOld"],
                "unmatchedNew": baseline_global["unmatchedNew"],
                "review": baseline_global["review"],
            },
            "perHalf": {
                half: {
                    "summary": baseline_results[half]["summary"],
                    "unmatchedOld": baseline_results[half]["unmatchedOld"],
                    "unmatchedNew": baseline_results[half]["unmatchedNew"],
                    "review": baseline_results[half]["review"],
                }
                for half in ("upper", "lower")
            },
        },
        "newMatch": {
            "global": {"summary": new_global["summary"], **classification_global},
            "perHalf": {
                half: {
                    "summary": new_results[half]["summary"],
                    **classifications[half],
                }
                for half in ("upper", "lower")
            },
        },
        "legacyOcNormalizations": {
            "global": global_normalizations,
            "perHalf": normalizations,
        },
        "characterPromptNormalization": character_normalization,
        "manualMatchOverrides": manual_match_overrides,
        "summary": {
            "oldFormalCount": int(codex.get("entryCount", len(codex["entries"]))),
            "newMergedCount": new_merge["stats"]["mergedCount"],
            "netChangeRaw": new_merge["stats"]["mergedCount"] - len(codex["entries"]),
            "matched": new_global["summary"]["matched"],
            "manualOverridesApplied": sum(
                bool(record.get("applied"))
                for record in manual_match_overrides["global"]
            ),
            "structuralOcSplits": len(classification_global["structuralOcSplits"]),
            "preexistingSourceOnlyAdditions": len(classification_global["preexistingSourceOnlyAdditions"]),
            "genuineAdditions": len(classification_global["genuineAdditions"]),
            "preexistingFormalOnlyRemovals": len(classification_global["preexistingFormalOnlyRemovals"]),
            "genuineRemovals": len(classification_global["genuineRemovals"]),
            "contentChanges": len(classification_global["contentChanges"]),
            "pathChanges": change_counts["path"],
            "titleChanges": change_counts["title"],
            "tagChanges": change_counts["tags"],
            "characterPromptChanges": change_counts["characterPrompts"],
            "flagOnlyChanges": len(classification_global["flagOnlyChanges"]),
            "baselineContentDrift": baseline_content_drift,
            "baselineStrictReplayPass": baseline_strict_replay,
            "baselineReview": len(baseline_reviews),
            "review": len(reviews),
            "matchedImaged": new_global["summary"]["matchedImaged"],
            "validationIssues": validation_issues,
            "characterNormalizationBlockers": character_normalization_blockers,
        },
    }
    return payload


def render_summary(payload: dict[str, Any]) -> str:
    summary = payload["summary"]
    merge = payload["merge"]
    special = merge["newSpecialHandling"]
    new_version = payload["newVersion"]
    baseline_version = payload["baselineVersion"]
    lines = [
        f"# 所长色色 {new_version} 上下册合并、增量匹配与应用",
        "",
        f"- 现有正式版本：`{payload['oldVersion']}`",
        f"- 输入版本：`{payload['newVersion']}`",
        (
            "- 已按合并后全局映射写入 `site/data/suozhang_r18.json`。"
            if not payload["formalDataUnchanged"]
            else "- 本次只生成 output 审计产物；没有改写 `site/data/suozhang_r18.json`。"
        ),
        "",
        "## 先合并",
        "",
        "| 项目 | 数量 |",
        "|---|---:|",
        f"| 上册解析 | {merge['new']['upperParsed']} |",
        f"| 下册解析 | {merge['new']['lowerParsed']} |",
        f"| 下册重复画师组移除 | {merge['new']['lowerArtistCardsRemoved']} |",
        f"| 下册实际保留 | {merge['new']['lowerKept']} |",
        f"| 合并候选 | {merge['new']['mergedCount']} |",
        "",
        f"合并规则：{merge['rule']}。下册画师组已验证为上册画师组的精确子集。",
        "",
        "## 开场特殊区",
        "",
        "| 项目 | 数量 |",
        "|---|---:|",
        f"| 上册画师组独立卡 | {special['upperArtistCards']} |",
        f"| 上册 OC 独立卡 | {special['upperOcCards']} |",
        f"| 下册画师组去重 | {special['lowerArtistCardsRemoved']} |",
        f"| 下册 OC 独立卡（保留） | {special['lowerOcCardsKept']} |",
        f"| `(未命名)` 特殊卡 | {special['unnamedSpecialCards']} |",
        f"| 本体/服装标记泄漏 | {special['markerLeaks']} |",
        "",
        "## 增量汇总",
        "",
        "| 项目 | 数量 |",
        "|---|---:|",
        f"| 当前正式条目 | {summary['oldFormalCount']} |",
        f"| {new_version} 合并候选 | {summary['newMergedCount']} |",
        f"| 原始净变化 | {summary['netChangeRaw']:+d} |",
        f"| 匹配并继承旧 ID | {summary['matched']} |",
        f"| 其中人工稳定 ID 覆盖 | {summary['manualOverridesApplied']} |",
        f"| OC 历史大卡结构拆分 | {summary['structuralOcSplits']} |",
        f"| 旧源已有、正式 JSON 曾漏入 | {summary['preexistingSourceOnlyAdditions']} |",
        f"| {new_version} 明确新增 | {summary['genuineAdditions']} |",
        f"| 正式 JSON 历史遗留、旧源已无 | {summary['preexistingFormalOnlyRemovals']} |",
        f"| {new_version} 明确删除 | {summary['genuineRemovals']} |",
        f"| 内容修改 | {summary['contentChanges']} |",
        f"| 其中目录移动 | {summary['pathChanges']} |",
        f"| 其中 tag 修改 | {summary['tagChanges']} |",
        f"| 其中角色词修改 | {summary['characterPromptChanges']} |",
        f"| 其中标题修改 | {summary['titleChanges']} |",
        f"| 仅 isNew 变化 | {summary['flagOnlyChanges']} |",
        f"| {baseline_version} 回放内容漂移 | {summary['baselineContentDrift']} |",
        f"| {baseline_version} 严格回放 | {'通过' if summary['baselineStrictReplayPass'] else '未通过'} |",
        f"| {baseline_version} 回放待人工复核 | {summary['baselineReview']} |",
        f"| 角色词规范化 blocker | {summary['characterNormalizationBlockers']} |",
        f"| 待人工复核 | {summary['review']} |",
        f"| 已匹配带图旧条目 | {summary['matchedImaged']} |",
        "",
        f"## {baseline_version} 回放说明",
        "",
        f"旧上下册按同一规则合并后为 {merge['old']['mergedCount']} 条；当前正式 JSON 为 {summary['oldFormalCount']} 条。",
        f"差额会在下方区分为“旧源已有但正式漏入”和“正式历史遗留但旧源已无”，不会伪装成 {new_version} 的新增/删除。",
        "",
        "## Word 结构",
        "",
    ]
    for half in ("upper", "lower"):
        lines.append(f"- `{half}`：`{json.dumps(payload['wordStructures'][half], ensure_ascii=False)}`")
    lines.append("")

    lines.extend(["## 人工稳定 ID 覆盖", ""])
    lines.append("这些规则只作用于本次新版本的分册与合并后匹配；旧版本 baseline 回放不使用人工覆盖。")
    lines.append("")
    applied_overrides = [
        record
        for record in payload["manualMatchOverrides"]["global"]
        if record.get("applied")
    ]
    if not applied_overrides:
        lines.extend(["无规则启用。", ""])
    else:
        for record in applied_overrides:
            lines.append(
                f"- `{record['oldId']}` → `{record['newHalf']}` "
                f"{' > '.join(record['newPath'])} › {record['newTitle']}："
                f"{record['decision']}"
            )
        lines.append("")

    combined = lambda key: payload["newMatch"]["global"][key]
    _append_entries(lines, f"OC 结构拆分（非 {new_version} 新内容）", combined("structuralOcSplits"))
    _append_entries(lines, "旧源已有、正式 JSON 曾漏入", combined("preexistingSourceOnlyAdditions"))
    _append_entries(lines, f"{new_version} 明确新增", combined("genuineAdditions"))
    _append_entries(lines, "正式 JSON 历史遗留、旧源已无", combined("preexistingFormalOnlyRemovals"))
    _append_entries(lines, f"{new_version} 明确删除", combined("genuineRemovals"))

    lines.extend(["## 内容修改", ""])
    changes = combined("contentChanges")
    if not changes:
        lines.extend(["无。", ""])
    else:
        for match in changes[:300]:
            lines.append(
                f"- `{match['old'].get('id')}` {', '.join(match['changes'])}："
                f"{_entry_line(match['old'])} → {_entry_line(match['new'])}"
            )
        if len(changes) > 300:
            lines.append(f"- ……其余 {len(changes) - 300} 条见 JSON。")
        lines.append("")

    lines.extend(["## 待人工复核", ""])
    reviews = combined("review")
    if not reviews:
        lines.extend(["无。", ""])
    else:
        for item in reviews:
            lines.append(f"- 新：{_entry_line(item['new'])}")
            for candidate in item["candidates"]:
                lines.append(
                    f"  - 候选 {candidate['similarity']['score']:.3f}："
                    f"{_entry_line(candidate['old'])}"
                )
        lines.append("")

    application = payload.get("application")
    if application:
        stats = application["stats"]
        lines.extend([
            "## 正式应用结果" if application["applied"] else "## 正式应用预演",
            "",
            f"- 最终条目：{stats['finalEntryCount']}",
            f"- 最终有图：{stats['finalImagedCount']}",
            f"- 继承旧 ID：{stats['matchedInherited']}",
            f"- 继承带图旧项：{stats['matchedImagedInherited']}",
            f"- 新 ID：{stats['newIdCount']}",
            f"- 上册新 ID：{stats['newIds']['upper']['count']}（`{stats['newIds']['upper']['first']}` → `{stats['newIds']['upper']['last']}`）",
            f"- 下册新 ID：{stats['newIds']['lower']['count']}（`{stats['newIds']['lower']['first']}` → `{stats['newIds']['lower']['last']}`）",
            f"- 删除旧项：{stats['removedCount']}（其中有图 {stats['removedImagedCount']}）",
            f"- 图片元数据继承差异：{stats['metadataMismatches']}",
            "",
        ])

    lines.extend([
        "## 门禁结果",
        "",
        f"- matchingGatePass：`{str(payload['matchingGatePass']).lower()}`",
        f"- validationIssues：{summary['validationIssues']}",
        f"- review：{summary['review']}",
        f"- 正式数据写入：{'是' if not payload['formalDataUnchanged'] else '否'}。",
        "",
    ])
    return "\n".join(lines)


def _write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_merged_source_snapshot(path: Path) -> tuple[dict[str, Any], str]:
    """Load a previously gated merged-source snapshot as the replay baseline."""
    with path.open(encoding="utf-8") as stream:
        payload = json.load(stream)
    if payload.get("codexId") != "suozhang_r18":
        raise ValueError(f"baseline snapshot has wrong codexId: {payload.get('codexId')!r}")
    entries = payload.get("entries")
    if not isinstance(entries, list):
        raise ValueError("baseline snapshot has no entries list")
    declared = payload.get("entryCount")
    if declared is not None and int(declared) != len(entries):
        raise ValueError(
            f"baseline snapshot entryCount mismatch: {declared} vs {len(entries)}"
        )

    halves: dict[str, list[dict[str, Any]]] = {"upper": [], "lower": []}
    for index, raw in enumerate(entries):
        if not isinstance(raw, dict):
            raise ValueError(f"baseline snapshot entry {index} is not an object")
        half = raw.get("sourceHalf")
        if half not in halves:
            raise ValueError(
                f"baseline snapshot entry {index} has invalid sourceHalf: {half!r}"
            )
        halves[str(half)].append(dict(raw))

    special = dict(payload.get("specialHandling") or {})
    removed_artist = int(special.get("lowerArtistCardsRemoved") or 0)
    stats = dict(payload.get("stats") or {})
    stats.update({
        "upperParsed": len(halves["upper"]),
        "lowerParsed": len(halves["lower"]) + removed_artist,
        "lowerArtistCardsRemoved": removed_artist,
        "lowerKept": len(halves["lower"]),
        "mergedCount": len(entries),
        "artistSubsetVerified": bool(stats.get("artistSubsetVerified", True)),
    })
    version = str(payload.get("version") or "").strip()
    if not version:
        raise ValueError("baseline snapshot has no version")
    return {
        "upper": halves["upper"],
        "lower": halves["lower"],
        "merged": [dict(entry) for entry in entries],
        "stats": stats,
        "special": special,
    }, version


def snapshot_structure(path: Path) -> dict[str, Any]:
    return {
        "snapshot": True,
        "source": str(path),
        "tables": 0,
        "drawings": 0,
        "textBoxes": 0,
        "trackedInsertions": 0,
        "trackedDeletions": 0,
        "commentsPart": False,
        "trackRevisionsEnabled": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Merge 所长色色 upper/lower DOCX sources, audit stable IDs, and optionally apply."
    )
    parser.add_argument("upper", type=Path)
    parser.add_argument("lower", type=Path)
    parser.add_argument("--baseline-upper", type=Path)
    parser.add_argument("--baseline-lower", type=Path)
    parser.add_argument(
        "--baseline-merged-json",
        type=Path,
        help="Previously gated merged-source.json used when the old DOCX pair is unavailable.",
    )
    parser.add_argument(
        "--data", type=Path, default=ROOT / "site" / "data" / "suozhang_r18.json"
    )
    parser.add_argument(
        "--index", type=Path, default=ROOT / "site" / "data" / "codexes.json"
    )
    parser.add_argument(
        "--out-dir", type=Path, default=ROOT / "output" / "所长色色-合并匹配测试"
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write the gated merged result to suozhang_r18.json and refresh its codex index summary.",
    )
    args = parser.parse_args()

    has_baseline_docs = bool(args.baseline_upper and args.baseline_lower)
    has_partial_baseline_docs = bool(args.baseline_upper) != bool(args.baseline_lower)
    if has_partial_baseline_docs:
        parser.error("--baseline-upper and --baseline-lower must be provided together")
    if bool(args.baseline_merged_json) == has_baseline_docs:
        parser.error(
            "provide exactly one replay baseline: the old upper/lower DOCX pair "
            "or --baseline-merged-json"
        )

    paths = {
        "upper": args.upper.resolve(),
        "lower": args.lower.resolve(),
        "data": args.data.resolve(),
        "index": args.index.resolve(),
    }
    if has_baseline_docs:
        paths["baselineUpper"] = args.baseline_upper.resolve()
        paths["baselineLower"] = args.baseline_lower.resolve()
    else:
        paths["baselineMergedJson"] = args.baseline_merged_json.resolve()
    for label, path in paths.items():
        if not path.is_file():
            parser.error(f"{label} not found: {path}")

    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    codex = load_codex(paths["data"])
    validate_codex_identity(codex, "suozhang_r18")
    formal_halves = partition_formal_entries(codex["entries"])
    normalized_formal_all, global_normalizations = normalize_legacy_oc_entries(
        codex["entries"]
    )
    normalized_formal: dict[str, list[dict[str, Any]]] = {}
    normalizations: dict[str, list[dict[str, Any]]] = {}
    for half in ("upper", "lower"):
        normalized_formal[half], normalizations[half] = normalize_legacy_oc_entries(
            formal_halves[half]
        )

    _, new_upper_version, _ = convert.parse_meta(paths["upper"].stem)
    _, new_lower_version, _ = convert.parse_meta(paths["lower"].stem)
    if new_upper_version != new_lower_version:
        raise ValueError(
            f"Upper/lower version mismatch: {new_upper_version} vs {new_lower_version}"
        )

    parsed_new = {
        "upper": parse_docx_items(paths["upper"]),
        "lower": parse_docx_items(paths["lower"]),
    }
    new_raw: dict[str, list[dict[str, Any]]] = {}
    character_normalization: dict[str, dict[str, dict[str, Any]]] = {
        "new": {},
        "baseline": {},
    }
    for half in ("upper", "lower"):
        new_raw[half], character_normalization["new"][half] = (
            normalize_suozhang_entries(parsed_new[half], normalized_formal[half])
        )
        new_raw[half], correction_audit = apply_known_source_title_corrections(
            new_raw[half], normalized_formal[half], half=half
        )
        character_normalization["new"][half][
            "knownSourceTitleCorrections"
        ] = correction_audit
    new_merge = merge_source_halves(new_raw["upper"], new_raw["lower"])

    if has_baseline_docs:
        parsed_baseline = {
            "upper": parse_docx_items(paths["baselineUpper"]),
            "lower": parse_docx_items(paths["baselineLower"]),
        }
        _, old_upper_version, _ = convert.parse_meta(paths["baselineUpper"].stem)
        _, old_lower_version, _ = convert.parse_meta(paths["baselineLower"].stem)
        if old_upper_version != old_lower_version:
            raise ValueError(
                f"Baseline version mismatch: {old_upper_version} vs {old_lower_version}"
            )
        baseline_version = old_upper_version
        baseline_raw: dict[str, list[dict[str, Any]]] = {}
        for half in ("upper", "lower"):
            baseline_raw[half], character_normalization["baseline"][half] = (
                normalize_suozhang_entries(
                    parsed_baseline[half], normalized_formal[half]
                )
            )
            baseline_raw[half], correction_audit = apply_known_source_title_corrections(
                baseline_raw[half], normalized_formal[half], half=half
            )
            character_normalization["baseline"][half][
                "knownSourceTitleCorrections"
            ] = correction_audit
        old_merge = merge_source_halves(
            baseline_raw["upper"], baseline_raw["lower"]
        )
        baseline_structures = {
            "upper": inspect_docx_package(paths["baselineUpper"]),
            "lower": inspect_docx_package(paths["baselineLower"]),
        }
        baseline_sources = {
            "upper": paths["baselineUpper"],
            "lower": paths["baselineLower"],
        }
    else:
        snapshot_path = paths["baselineMergedJson"]
        snapshot_merge, baseline_version = load_merged_source_snapshot(snapshot_path)
        normalized_snapshot_halves: dict[str, list[dict[str, Any]]] = {}
        for half in ("upper", "lower"):
            normalized_snapshot_halves[half], character_normalization["baseline"][half] = (
                normalize_suozhang_entries(
                    snapshot_merge[half], normalized_formal[half]
                )
            )
            normalized_snapshot_halves[half], correction_audit = (
                apply_known_source_title_corrections(
                    normalized_snapshot_halves[half],
                    normalized_formal[half],
                    half=half,
                )
            )
            character_normalization["baseline"][half][
                "knownSourceTitleCorrections"
            ] = correction_audit
        normalized_snapshot_stats = {
            **snapshot_merge["stats"],
            "upperParsed": len(normalized_snapshot_halves["upper"]),
            "lowerParsed": (
                len(normalized_snapshot_halves["lower"])
                + int(snapshot_merge["stats"].get("lowerArtistCardsRemoved") or 0)
            ),
            "lowerKept": len(normalized_snapshot_halves["lower"]),
            "mergedCount": sum(
                len(normalized_snapshot_halves[half])
                for half in ("upper", "lower")
            ),
        }
        old_merge = {
            **snapshot_merge,
            "upper": normalized_snapshot_halves["upper"],
            "lower": normalized_snapshot_halves["lower"],
            "merged": (
                normalized_snapshot_halves["upper"]
                + normalized_snapshot_halves["lower"]
            ),
            "stats": normalized_snapshot_stats,
        }
        baseline_structures = {
            "upper": snapshot_structure(snapshot_path),
            "lower": snapshot_structure(snapshot_path),
        }
        baseline_sources = {"upper": snapshot_path, "lower": snapshot_path}

    merged_source_path = out_dir / "merged-source.json"
    baseline_merged_source_path = out_dir / "baseline-merged-source.json"
    _write_json(merged_source_path, {
        "schema": 1,
        "codexId": "suozhang_r18",
        "version": new_upper_version,
        "sources": {"upper": str(paths["upper"]), "lower": str(paths["lower"])},
        "mergeRule": "upper all + lower without duplicated 编纂者常用画师组; keep lower OC",
        "entryCount": new_merge["stats"]["mergedCount"],
        "stats": new_merge["stats"],
        "specialHandling": new_merge["special"],
        "characterPromptNormalization": character_normalization["new"],
        "entries": new_merge["merged"],
    })
    _write_json(baseline_merged_source_path, {
        "schema": 1,
        "codexId": "suozhang_r18",
        "version": baseline_version,
        "sources": {key: str(value) for key, value in baseline_sources.items()},
        "mergeRule": "upper all + lower without duplicated 编纂者常用画师组; keep lower OC",
        "entryCount": old_merge["stats"]["mergedCount"],
        "stats": old_merge["stats"],
        "specialHandling": old_merge["special"],
        "characterPromptNormalization": character_normalization["baseline"],
        "entries": old_merge["merged"],
    })

    structures = {
        "upper": inspect_docx_package(paths["upper"]),
        "lower": inspect_docx_package(paths["lower"]),
    }
    baseline_results: dict[str, dict[str, Any]] = {}
    new_results: dict[str, dict[str, Any]] = {}
    manual_override_audits: dict[str, Any] = {
        "baselineApplied": False,
        "perHalf": {},
        "global": [],
    }
    report_paths: dict[str, str] = {}
    for half in ("upper", "lower"):
        baseline_results[half] = match_entries(
            normalized_formal[half], old_merge[half]
        )
        forced_pairs, override_audit = resolve_manual_match_overrides(
            normalized_formal[half], new_merge[half], context=half
        )
        manual_override_audits["perHalf"][half] = override_audit
        new_results[half] = match_entries(
            normalized_formal[half],
            new_merge[half],
            forced_pairs=forced_pairs,
        )
        baseline_json, baseline_md = write_report(
            out_dir,
            f"baseline-{half}-replay",
            baseline_results[half],
            label=f"suozhang_r18 {baseline_version} {half} 回放",
            source=baseline_sources[half],
            structure=baseline_structures[half],
            old_version=str(codex.get("version", "")),
            new_version=baseline_version,
        )
        new_json, new_md = write_report(
            out_dir,
            f"new-{half}-match",
            new_results[half],
            label=f"suozhang_r18 {new_upper_version} {half} 增量匹配",
            source=paths[half],
            structure=structures[half],
            old_version=str(codex.get("version", "")),
            new_version=new_upper_version,
        )
        report_paths[f"baseline{half.title()}Json"] = str(baseline_json)
        report_paths[f"baseline{half.title()}Markdown"] = str(baseline_md)
        report_paths[f"new{half.title()}Json"] = str(new_json)
        report_paths[f"new{half.title()}Markdown"] = str(new_md)

    classifications = {
        half: classify_half(baseline_results[half], new_results[half], normalizations[half])
        for half in ("upper", "lower")
    }
    baseline_global = match_entries(normalized_formal_all, old_merge["merged"])
    global_forced_pairs, global_override_audit = resolve_manual_match_overrides(
        normalized_formal_all, new_merge["merged"], context="global"
    )
    manual_override_audits["global"] = global_override_audit
    new_global = match_entries(
        normalized_formal_all,
        new_merge["merged"],
        forced_pairs=global_forced_pairs,
    )
    classification_global = classify_half(
        baseline_global, new_global, global_normalizations
    )
    baseline_global_json, baseline_global_md = write_report(
        out_dir,
        "baseline-merged-replay",
        baseline_global,
        label=f"suozhang_r18 {baseline_version} 合并后全局回放",
        source=baseline_merged_source_path,
        structure={"upper": baseline_structures["upper"], "lower": baseline_structures["lower"]},
        old_version=str(codex.get("version", "")),
        new_version=baseline_version,
    )
    new_global_json, new_global_md = write_report(
        out_dir,
        "new-merged-match",
        new_global,
        label=f"suozhang_r18 {new_upper_version} 合并后全局增量匹配",
        source=merged_source_path,
        structure={"upper": structures["upper"], "lower": structures["lower"]},
        old_version=str(codex.get("version", "")),
        new_version=new_upper_version,
    )
    report_paths["mergedSource"] = str(merged_source_path)
    report_paths["baselineMergedSource"] = str(baseline_merged_source_path)
    report_paths["baselineMergedJson"] = str(baseline_global_json)
    report_paths["baselineMergedMarkdown"] = str(baseline_global_md)
    report_paths["newMergedJson"] = str(new_global_json)
    report_paths["newMergedMarkdown"] = str(new_global_md)

    payload = build_summary_payload(
        codex=codex,
        old_version=str(codex.get("version", "")),
        baseline_version=baseline_version,
        new_version=new_upper_version,
        old_merge=old_merge,
        new_merge=new_merge,
        structures=structures,
        baseline_global=baseline_global,
        new_global=new_global,
        classification_global=classification_global,
        baseline_results=baseline_results,
        new_results=new_results,
        classifications=classifications,
        global_normalizations=global_normalizations,
        normalizations=normalizations,
        character_normalization=character_normalization,
        manual_match_overrides=manual_override_audits,
        sources={key: str(value) for key, value in paths.items()},
        report_paths=report_paths,
    )

    if args.apply and not payload["matchingGatePass"]:
        raise ValueError("refusing --apply because matchingGatePass is false")

    application = None
    if payload["matchingGatePass"]:
        with paths["index"].open(encoding="utf-8") as stream:
            current_index = json.load(stream)
        if not isinstance(current_index, list):
            raise ValueError(f"Codex index must be a list: {paths['index']}")
        current_meta = [
            item for item in current_index if item.get("id") == "suozhang_r18"
        ]
        if len(current_meta) != 1:
            raise ValueError(
                "expected one suozhang_r18 index item, "
                f"found {len(current_meta)}"
            )
        reserved_asset_ids = collect_reserved_asset_ids()
        applied_codex, application_stats = build_applied_codex(
            codex,
            new_merge["merged"],
            new_global,
            new_upper_version,
            reserved_ids=reserved_asset_ids,
            previous_update_filters=current_meta[0].get("updateFilters"),
        )
        updated_index = build_updated_codex_index(current_index, applied_codex)
        preview_data = out_dir / "formal-apply-preview.json"
        preview_index = out_dir / "codexes-apply-preview.json"
        _write_json(preview_data, applied_codex)
        _write_json(preview_index, updated_index)
        report_paths["formalApplyPreview"] = str(preview_data)
        report_paths["codexesApplyPreview"] = str(preview_index)
        application = {
            "applied": bool(args.apply),
            "dataPath": str(paths["data"]),
            "indexPath": str(paths["index"]),
            "previewData": str(preview_data),
            "previewIndex": str(preview_index),
            "stats": application_stats,
        }
        if args.apply:
            write_json_pair_with_rollback(
                paths["data"], applied_codex, paths["index"], updated_index
            )

    payload["formalDataUnchanged"] = not args.apply
    payload["application"] = application
    payload["reports"] = report_paths
    summary_json = out_dir / "merge-match-summary.json"
    summary_md = out_dir / "merge-match-summary.md"
    _write_json(summary_json, payload)
    summary_md.write_text(render_summary(payload), encoding="utf-8")
    print(json.dumps({
        "outDir": str(out_dir),
        "mergedSource": str(merged_source_path),
        "applied": bool(args.apply),
        "matchingGatePass": payload["matchingGatePass"],
        "summary": payload["summary"],
    }, ensure_ascii=False))
    return 0 if payload["matchingGatePass"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
