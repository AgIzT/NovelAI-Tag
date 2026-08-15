# -*- coding: utf-8 -*-
"""Audit or apply an incremental codex update from a DOCX source.

The default mode is a dry run.  ``--apply`` is available only after the new
source, baseline replay, Word structure, and source-normalization gates all
pass.  High-confidence matches keep their old IDs and non-source metadata;
new IDs are allocated after both current data and locally retained assets.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
import zipfile
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping
from xml.etree import ElementTree as ET


TOOLS_DIR = Path(__file__).resolve().parent
ROOT = TOOLS_DIR.parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

REVIEW_THRESHOLD = 0.58
MAX_REVIEW_CANDIDATES = 3
ASSET_KEYS = ("image", "original", "assetRev", "imageWidth", "imageHeight")
SOURCE_CONTENT_KEYS = ("title", "path", "tags", "isNew", "characterPrompts")
UPDATE_BATCHES_KEY = "updateBatches"
RISKY_STRUCTURE_KEYS = (
    "tables",
    "textBoxes",
    "trackedInsertions",
    "trackedDeletions",
)
AUDITED_NEW_OVERRIDES: dict[tuple[str, str], dict[str, dict[str, Any]]] = {
    ("suozhang", "2026.8.14"): {
        # The source omitted the pink highlight, but the 8.14 audit confirmed
        # this is a real addition. Keep the decision replayable on re-apply.
        "suozhang-5704": {
            "title": "动画画风",
            "path": ["各种风格"],
            "tags": (
                "7::anime,anime screencap,anime coloring,official style,"
                "dense linework::,"
            ),
            "isNew": True,
        },
    },
}


def _load_convert_module():
    # Lazy import keeps this matcher usable from convert.py without a cycle.
    import importlib

    return importlib.import_module("convert")


def norm_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).replace("\u00a0", " ")
    return re.sub(r"\s+", " ", text).strip().casefold()


def norm_path(entry: dict[str, Any]) -> tuple[str, ...]:
    return tuple(norm_text(part) for part in entry.get("path", []))


def norm_title(entry: dict[str, Any]) -> str:
    return norm_text(entry.get("title", ""))


def norm_tags_value(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).replace("\u00a0", " ")
    text = text.replace("，", ",").replace("：", ":")
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s*,\s*", ",", text)
    text = re.sub(r"\s*:\s*", ":", text)
    return text.strip().casefold()


def norm_tags(entry: dict[str, Any]) -> str:
    return norm_tags_value(entry.get("tags", ""))


def _source_signature(entry: Mapping[str, Any]) -> tuple[Any, ...]:
    return (norm_title(entry), norm_path(entry), norm_tags(entry))


def apply_audited_source_new_overrides(
    entries: list[dict[str, Any]],
    codex_id: str,
    version: str,
) -> list[str]:
    """Apply version-scoped NEW decisions before matching and replay gates."""
    overrides = AUDITED_NEW_OVERRIDES.get((str(codex_id), str(version)), {})
    if not overrides:
        return []

    applied: list[str] = []
    for entry_id, expected in overrides.items():
        expected_signature = _source_signature(expected)
        matches = [
            entry for entry in entries
            if _source_signature(entry) == expected_signature
        ]
        if len(matches) != 1:
            raise ValueError(
                "audited source NEW override must match exactly one entry: "
                f"{codex_id} {version} {entry_id} matched={len(matches)}"
            )
        matches[0]["isNew"] = bool(expected.get("isNew"))
        applied.append(entry_id)
    return sorted(applied)


def apply_audited_new_overrides(
    entries: list[dict[str, Any]],
    codex_id: str,
    version: str,
) -> list[str]:
    """Apply version-scoped NEW decisions after stable IDs are assigned."""
    overrides = AUDITED_NEW_OVERRIDES.get((str(codex_id), str(version)), {})
    if not overrides:
        return []

    by_id: dict[str, dict[str, Any]] = {}
    for entry in entries:
        entry_id = str(entry.get("id") or "")
        if entry_id in by_id:
            raise ValueError(f"duplicate entry ID before audited NEW overrides: {entry_id}")
        by_id[entry_id] = entry

    applied: list[str] = []
    for entry_id, expected in overrides.items():
        entry = by_id.get(entry_id)
        if entry is None:
            raise ValueError(
                f"audited NEW override target is missing: {codex_id} {version} {entry_id}"
            )
        actual_signature = _source_signature(entry)
        expected_signature = _source_signature(expected)
        if actual_signature != expected_signature:
            raise ValueError(
                f"audited NEW override target drifted: {codex_id} {version} {entry_id}"
            )
        entry["isNew"] = bool(expected.get("isNew"))
        applied.append(entry_id)
    return sorted(applied)


def norm_character_prompts(entry: dict[str, Any]) -> tuple[tuple[tuple[str, str], ...], ...]:
    """Return a stable semantic representation of ``characterPrompts``."""
    prompts = entry.get("characterPrompts") or []
    if not isinstance(prompts, list):
        return ((('value', norm_text(prompts)),),)
    normalized: list[tuple[tuple[str, str], ...]] = []
    for prompt in prompts:
        if not isinstance(prompt, dict):
            normalized.append((("value", norm_text(prompt)),))
            continue
        normalized.append(tuple(
            (norm_text(key), norm_tags_value(value))
            for key, value in sorted(prompt.items(), key=lambda item: str(item[0]))
        ))
    return tuple(normalized)


def norm_prompt_value(entry: dict[str, Any]) -> str:
    parts = [norm_tags(entry)]
    for prompt in norm_character_prompts(entry):
        parts.append("|".join(f"{key}:{value}" for key, value in prompt))
    return "\n".join(part for part in parts if part)


def tag_tokens(value: Any) -> frozenset[str]:
    text = norm_tags_value(value)
    return frozenset(
        token.strip()
        for token in re.split(r"[,\n]+", text)
        if token.strip()
    )


def entry_prompt_tokens(entry: dict[str, Any]) -> frozenset[str]:
    return tag_tokens(norm_prompt_value(entry))


def _source_entry(entry: dict[str, Any]) -> dict[str, Any]:
    """Strip report/formal-only fields from a source candidate."""
    return {
        key: value
        for key, value in entry.items()
        if key not in {"index", "id", *ASSET_KEYS}
        and not str(key).startswith("_")
    }


def normalize_suozhang_entries(
    entries: list[dict[str, Any]],
    old_entries: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Normalize inline 所长 role prompts before matching.

    The standard splitter and the audited variant table come from
    ``migrate_suozhang_char_prompts`` so an update cannot silently diverge from
    the post-conversion migration.  Variant rules are tied to stable old IDs
    whenever path/title uniquely identifies their source candidate.  If an
    audited variant changes shape, it becomes a blocker instead of being
    guessed.
    """
    from migrate_suozhang_char_prompts import (
        VARIANT_FIXES,
        apply_variant_fix,
        put_character_prompts,
        split_inline_char_prompts,
    )

    normalized = [_source_entry(dict(entry)) for entry in entries]
    audit: dict[str, Any] = {
        "entries": len(normalized),
        "changedEntries": 0,
        "standardChangedEntries": 0,
        "variantChangedEntries": 0,
        "variantInferredEntries": 0,
        "characterPromptBoxes": 0,
        "alreadyStructuredEntries": 0,
        "midlineMarkerEntries": [],
        "variantAmbiguities": [],
        "unmatchedVariantOldIds": [],
        "blockers": [],
    }

    old_groups = _group_indices(range(len(old_entries)), old_entries, lambda entry: (
        norm_path(entry), norm_title(entry)
    ))
    new_groups = _group_indices(range(len(normalized)), normalized, lambda entry: (
        norm_path(entry), norm_title(entry)
    ))
    variant_by_new: dict[int, tuple[str, dict[str, Any]]] = {}
    mapped_variant_ids: set[str] = set()
    for structure in old_groups.keys() & new_groups.keys():
        old_variants = [
            old_entries[index]
            for index in old_groups[structure]
            if old_entries[index].get("id") in VARIANT_FIXES
        ]
        if not old_variants:
            continue
        candidates = new_groups[structure]
        if len(old_variants) == 1 and len(candidates) == 1:
            old_id = str(old_variants[0]["id"])
            variant_by_new[candidates[0]] = (old_id, VARIANT_FIXES[old_id])
            mapped_variant_ids.add(old_id)
            continue
        # Generic headings can legitimately contain several audited variants.
        # Record the structural ambiguity, then let the rule table inspect each
        # concrete source body below; only an actual rule/body mismatch blocks.
        audit["variantAmbiguities"].append({
            "reason": "ambiguous_variant_source",
            "path": list(structure[0]),
            "title": structure[1],
            "oldIds": [entry.get("id") for entry in old_variants],
            "newIndices": list(candidates),
        })

    audit["unmatchedVariantOldIds"] = sorted(
        str(entry.get("id"))
        for entry in old_entries
        if entry.get("id") in VARIANT_FIXES
        and entry.get("id") not in mapped_variant_ids
    )

    for index, entry in enumerate(normalized):
        existing = entry.get("characterPrompts") or []
        mapped_variant = variant_by_new.get(index)
        if existing:
            audit["alreadyStructuredEntries"] += 1
            continue

        if mapped_variant:
            old_id, fix = mapped_variant
            built = apply_variant_fix(fix, entry.get("tags"))
            if built is None:
                audit["blockers"].append({
                    "index": index,
                    "oldId": old_id,
                    "reason": "variant_fix_mismatch",
                    "detail": fix.get("why", ""),
                })
                continue
            normalized[index] = put_character_prompts(
                entry, built["positive"], built["prompts"]
            )
            audit["changedEntries"] += 1
            audit["variantChangedEntries"] += 1
            audit["characterPromptBoxes"] += len(built["prompts"])
            continue

        # A moved/renamed audited variant may no longer share path/title with
        # its old entry.  Accept it only when the variant table produces one
        # unambiguous semantic result.
        inferred: dict[str, Any] = {}
        for fix in VARIANT_FIXES.values():
            built = apply_variant_fix(fix, entry.get("tags"))
            if built is None:
                continue
            key = json.dumps(built, ensure_ascii=False, sort_keys=True)
            inferred[key] = built
        if len(inferred) == 1:
            built = next(iter(inferred.values()))
            normalized[index] = put_character_prompts(
                entry, built["positive"], built["prompts"]
            )
            audit["changedEntries"] += 1
            audit["variantChangedEntries"] += 1
            audit["variantInferredEntries"] += 1
            audit["characterPromptBoxes"] += len(built["prompts"])
            continue

        split = split_inline_char_prompts(entry.get("tags"))
        if split["midlineMarkers"]:
            audit["midlineMarkerEntries"].append({
                "index": index,
                "title": entry.get("title", ""),
                "markers": list(split["midlineMarkers"]),
            })
        if split["emptySegments"] or not split["lossless"]:
            audit["blockers"].append({
                "index": index,
                "reason": "invalid_standard_character_prompts",
                "emptySegments": list(split["emptySegments"]),
                "lossless": bool(split["lossless"]),
            })
            continue
        if not split["prompts"]:
            continue
        normalized[index] = put_character_prompts(
            entry, split["positive"], split["prompts"]
        )
        audit["changedEntries"] += 1
        audit["standardChangedEntries"] += 1
        audit["characterPromptBoxes"] += len(split["prompts"])

    return normalized, audit


def title_similarity(a: dict[str, Any], b: dict[str, Any]) -> float:
    left, right = norm_title(a), norm_title(b)
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    return SequenceMatcher(None, left, right).ratio()


def path_similarity(a: dict[str, Any], b: dict[str, Any]) -> float:
    left, right = norm_path(a), norm_path(b)
    if left == right:
        return 1.0
    if not left or not right:
        return 0.0
    common = 0
    for x, y in zip(left, right):
        if x != y:
            break
        common += 1
    return common / max(len(left), len(right))


def tag_similarity(a: dict[str, Any], b: dict[str, Any]) -> float:
    left, right = norm_prompt_value(a), norm_prompt_value(b)
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0

    left_tokens = tag_tokens(left)
    right_tokens = tag_tokens(right)
    union = left_tokens | right_tokens
    jaccard = len(left_tokens & right_tokens) / len(union) if union else 0.0

    shorter, longer = (left, right) if len(left) <= len(right) else (right, left)
    prefix = (len(shorter) / len(longer)) if longer.startswith(shorter) else 0.0

    # Limit pathological long prompts while retaining both ends, where edits
    # and trailing additions commonly occur.
    def sample(text: str, limit: int = 1800) -> str:
        if len(text) <= limit:
            return text
        half = limit // 2
        return text[:half] + text[-half:]

    char_ratio = SequenceMatcher(None, sample(left), sample(right)).ratio()
    blended = 0.58 * char_ratio + 0.42 * jaccard
    # Prompt tags are a set semantically. SequenceMatcher can score repeated
    # punctuation/braces surprisingly low even when only one tag was removed,
    # so a strong token-set overlap must remain a valid lower bound.
    return max(blended, jaccard * 0.96, prefix * 0.96)


def entry_similarity(a: dict[str, Any], b: dict[str, Any]) -> dict[str, float]:
    tags = tag_similarity(a, b)
    title = title_similarity(a, b)
    path = path_similarity(a, b)
    score = 0.68 * tags + 0.22 * title + 0.10 * path
    return {
        "score": round(score, 6),
        "tags": round(tags, 6),
        "title": round(title, 6),
        "path": round(path, 6),
    }


def is_generic_title(entry: dict[str, Any]) -> bool:
    title = norm_text(entry.get("title", "")).rstrip(":")
    return title == "原版" or re.fullmatch(r"其他版本\d*", title) is not None


def _group_indices(
    indices: Iterable[int],
    entries: list[dict[str, Any]],
    key: Callable[[dict[str, Any]], Any],
) -> dict[Any, list[int]]:
    grouped: dict[Any, list[int]] = defaultdict(list)
    for index in indices:
        grouped[key(entries[index])].append(index)
    return grouped


def _entry_snapshot(entry: dict[str, Any], index: int) -> dict[str, Any]:
    result = {
        "index": index,
        "id": entry.get("id"),
        "title": entry.get("title", ""),
        "path": entry.get("path", []),
        "tags": entry.get("tags", ""),
        "isNew": bool(entry.get("isNew")),
    }
    if "characterPrompts" in entry:
        result["characterPrompts"] = entry.get("characterPrompts")
    for key in ASSET_KEYS:
        if key in entry:
            result[key] = entry.get(key)
    return result


def _change_list(old: dict[str, Any], new: dict[str, Any]) -> list[str]:
    changes = []
    if norm_path(old) != norm_path(new):
        changes.append("path")
    if norm_title(old) != norm_title(new):
        changes.append("title")
    if norm_tags(old) != norm_tags(new):
        changes.append("tags")
    if norm_character_prompts(old) != norm_character_prompts(new):
        changes.append("characterPrompts")
    if bool(old.get("isNew")) != bool(new.get("isNew")):
        changes.append("isNew")
    return changes


def _match_record(
    old_entries: list[dict[str, Any]],
    new_entries: list[dict[str, Any]],
    old_index: int,
    new_index: int,
    method: str,
    confidence: float,
) -> dict[str, Any]:
    old = old_entries[old_index]
    new = new_entries[new_index]
    changes = _change_list(old, new)
    return {
        "method": method,
        "confidence": round(confidence, 6),
        "changes": changes,
        "old": _entry_snapshot(old, old_index),
        "new": _entry_snapshot(new, new_index),
        "similarity": entry_similarity(old, new),
    }


def _pair_exact_fingerprints(
    old_entries: list[dict[str, Any]],
    new_entries: list[dict[str, Any]],
    unmatched_old: set[int],
    unmatched_new: set[int],
    matches: list[dict[str, Any]],
    warnings: list[dict[str, Any]],
) -> None:
    key = lambda entry: (
        norm_path(entry),
        norm_title(entry),
        norm_tags(entry),
        norm_character_prompts(entry),
    )
    old_groups = _group_indices(unmatched_old, old_entries, key)
    new_groups = _group_indices(unmatched_new, new_entries, key)
    for fingerprint in sorted(old_groups.keys() & new_groups.keys(), key=repr):
        old_group = sorted(old_groups[fingerprint])
        new_group = sorted(new_groups[fingerprint])
        if len(old_group) > 1 or len(new_group) > 1:
            warnings.append({
                "kind": "duplicate_exact_fingerprint",
                "oldCount": len(old_group),
                "newCount": len(new_group),
                "path": list(fingerprint[0]),
                "title": fingerprint[1],
            })
        for old_index, new_index in zip(old_group, new_group):
            matches.append(_match_record(
                old_entries, new_entries, old_index, new_index,
                "exact_fingerprint", 1.0,
            ))
            unmatched_old.remove(old_index)
            unmatched_new.remove(new_index)


def _best_rankings(
    old_group: list[int],
    new_group: list[int],
    old_entries: list[dict[str, Any]],
    new_entries: list[dict[str, Any]],
) -> tuple[dict[int, list[tuple[float, int]]], dict[int, list[tuple[float, int]]]]:
    by_new: dict[int, list[tuple[float, int]]] = {}
    by_old: dict[int, list[tuple[float, int]]] = {}
    for new_index in new_group:
        ranked = sorted(
            ((tag_similarity(old_entries[old_index], new_entries[new_index]), old_index)
             for old_index in old_group),
            reverse=True,
        )
        by_new[new_index] = ranked
    for old_index in old_group:
        ranked = sorted(
            ((tag_similarity(old_entries[old_index], new_entries[new_index]), new_index)
             for new_index in new_group),
            reverse=True,
        )
        by_old[old_index] = ranked
    return by_new, by_old


def _pair_same_structure(
    old_entries: list[dict[str, Any]],
    new_entries: list[dict[str, Any]],
    unmatched_old: set[int],
    unmatched_new: set[int],
    matches: list[dict[str, Any]],
    warnings: list[dict[str, Any]],
) -> None:
    key = lambda entry: (norm_path(entry), norm_title(entry))
    while True:
        old_groups = _group_indices(unmatched_old, old_entries, key)
        new_groups = _group_indices(unmatched_new, new_entries, key)
        paired_any = False

        for structure in sorted(old_groups.keys() & new_groups.keys(), key=repr):
            old_group = sorted(old_groups[structure])
            new_group = sorted(new_groups[structure])
            if len(old_group) == 1 and len(new_group) == 1:
                old_index, new_index = old_group[0], new_group[0]
                similarity = tag_similarity(old_entries[old_index], new_entries[new_index])
                if is_generic_title(new_entries[new_index]) and similarity < 0.58:
                    continue
                matches.append(_match_record(
                    old_entries, new_entries, old_index, new_index,
                    "same_path_title", 0.995 if not is_generic_title(new_entries[new_index]) else 0.9,
                ))
                unmatched_old.remove(old_index)
                unmatched_new.remove(new_index)
                paired_any = True
                continue

            by_new, by_old = _best_rankings(
                old_group, new_group, old_entries, new_entries,
            )
            accepted: list[tuple[int, int, float]] = []
            for new_index, ranked_old in by_new.items():
                if not ranked_old:
                    continue
                score, old_index = ranked_old[0]
                ranked_new = by_old.get(old_index, [])
                if not ranked_new or ranked_new[0][1] != new_index:
                    continue
                new_margin = score - (ranked_old[1][0] if len(ranked_old) > 1 else 0.0)
                old_margin = score - (ranked_new[1][0] if len(ranked_new) > 1 else 0.0)
                threshold = 0.74 if is_generic_title(new_entries[new_index]) else 0.64
                if score >= 0.92 or (
                    score >= threshold and new_margin >= 0.08 and old_margin >= 0.08
                ):
                    accepted.append((old_index, new_index, score))

            used_old: set[int] = set()
            used_new: set[int] = set()
            for old_index, new_index, score in sorted(accepted, key=lambda item: item[2], reverse=True):
                if old_index in used_old or new_index in used_new:
                    continue
                used_old.add(old_index)
                used_new.add(new_index)
                matches.append(_match_record(
                    old_entries, new_entries, old_index, new_index,
                    "same_path_title_tag_similarity", 0.86 + 0.12 * score,
                ))
                unmatched_old.remove(old_index)
                unmatched_new.remove(new_index)
                paired_any = True

            if not accepted:
                warnings.append({
                    "kind": "ambiguous_same_path_title",
                    "oldCount": len(old_group),
                    "newCount": len(new_group),
                    "path": list(structure[0]),
                    "title": structure[1],
                })

        if not paired_any:
            return


def _pair_unique_exact_tags(
    old_entries: list[dict[str, Any]],
    new_entries: list[dict[str, Any]],
    unmatched_old: set[int],
    unmatched_new: set[int],
    matches: list[dict[str, Any]],
    warnings: list[dict[str, Any]],
) -> None:
    key = lambda entry: (norm_tags(entry), norm_character_prompts(entry))
    old_groups = _group_indices(unmatched_old, old_entries, key)
    new_groups = _group_indices(unmatched_new, new_entries, key)
    empty_prompt = ("", ())
    for prompt in sorted((old_groups.keys() & new_groups.keys()) - {empty_prompt}, key=repr):
        old_group = old_groups[prompt]
        new_group = new_groups[prompt]
        if len(old_group) == 1 and len(new_group) == 1:
            old_index, new_index = old_group[0], new_group[0]
            matches.append(_match_record(
                old_entries, new_entries, old_index, new_index,
                "unique_exact_tags", 0.97,
            ))
            unmatched_old.remove(old_index)
            unmatched_new.remove(new_index)
        else:
            warnings.append({
                "kind": "ambiguous_exact_tags",
                "oldCount": len(old_group),
                "newCount": len(new_group),
                "tags": prompt[0][:240],
            })


def _pair_unique_same_title(
    old_entries: list[dict[str, Any]],
    new_entries: list[dict[str, Any]],
    unmatched_old: set[int],
    unmatched_new: set[int],
    matches: list[dict[str, Any]],
) -> None:
    key = norm_title
    old_groups = _group_indices(unmatched_old, old_entries, key)
    new_groups = _group_indices(unmatched_new, new_entries, key)
    for title in sorted((old_groups.keys() & new_groups.keys()) - {""}):
        old_group = old_groups[title]
        new_group = new_groups[title]
        if len(old_group) != 1 or len(new_group) != 1:
            continue
        old_index, new_index = old_group[0], new_group[0]
        if is_generic_title(new_entries[new_index]):
            continue
        similarity = tag_similarity(old_entries[old_index], new_entries[new_index])
        if similarity < 0.70:
            continue
        matches.append(_match_record(
            old_entries, new_entries, old_index, new_index,
            "unique_title_similar_tags", 0.82 + 0.14 * similarity,
        ))
        unmatched_old.remove(old_index)
        unmatched_new.remove(new_index)


def _rare_token_index(
    old_entries: list[dict[str, Any]], unmatched_old: set[int]
) -> dict[str, set[int]]:
    token_index: dict[str, set[int]] = defaultdict(set)
    for old_index in unmatched_old:
        for token in entry_prompt_tokens(old_entries[old_index]):
            if len(token) >= 4:
                token_index[token].add(old_index)
    return {token: indices for token, indices in token_index.items() if len(indices) <= 24}


def _review_candidates(
    old_entries: list[dict[str, Any]],
    new_entries: list[dict[str, Any]],
    unmatched_old: set[int],
    unmatched_new: set[int],
) -> list[dict[str, Any]]:
    old_by_title = _group_indices(unmatched_old, old_entries, norm_title)
    old_by_path = _group_indices(unmatched_old, old_entries, norm_path)
    rare_tokens = _rare_token_index(old_entries, unmatched_old)
    reviews = []

    for new_index in sorted(unmatched_new):
        new = new_entries[new_index]
        candidate_indices: set[int] = set(old_by_title.get(norm_title(new), []))
        candidate_indices.update(old_by_path.get(norm_path(new), []))
        for token in entry_prompt_tokens(new):
            candidate_indices.update(rare_tokens.get(token, set()))

        if len(candidate_indices) > 320:
            candidate_indices = set(sorted(
                candidate_indices,
                key=lambda old_index: abs(old_index - new_index),
            )[:320])

        ranked = []
        for old_index in candidate_indices:
            similarity = entry_similarity(old_entries[old_index], new)
            if similarity["score"] < REVIEW_THRESHOLD:
                continue
            ranked.append({
                "old": _entry_snapshot(old_entries[old_index], old_index),
                "similarity": similarity,
            })
        ranked.sort(key=lambda item: item["similarity"]["score"], reverse=True)
        if ranked:
            reviews.append({
                "new": _entry_snapshot(new, new_index),
                "candidates": ranked[:MAX_REVIEW_CANDIDATES],
            })
    return reviews


def validate_inputs(
    old_entries: list[dict[str, Any]], new_entries: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    issues = []
    old_ids = [entry.get("id") for entry in old_entries]
    missing_ids = [index for index, value in enumerate(old_ids) if not value]
    duplicate_ids = sorted(value for value, count in Counter(old_ids).items() if value and count > 1)
    if missing_ids:
        issues.append({"kind": "missing_old_ids", "indices": missing_ids})
    if duplicate_ids:
        issues.append({"kind": "duplicate_old_ids", "ids": duplicate_ids})
    for label, entries in (("old", old_entries), ("new", new_entries)):
        empty_tags = [
            index
            for index, entry in enumerate(entries)
            if not norm_tags(entry) and not norm_character_prompts(entry)
        ]
        if empty_tags:
            issues.append({"kind": f"empty_{label}_tags", "indices": empty_tags})
    return issues


def match_entries(
    old_entries: list[dict[str, Any]],
    new_entries: list[dict[str, Any]],
    *,
    forced_pairs: Mapping[int, int] | None = None,
) -> dict[str, Any]:
    unmatched_old = set(range(len(old_entries)))
    unmatched_new = set(range(len(new_entries)))
    matches: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []

    forced_items = list((forced_pairs or {}).items())
    seen_old: set[int] = set()
    seen_new: set[int] = set()
    for old_index, new_index in forced_items:
        if type(old_index) is not int or type(new_index) is not int:
            raise ValueError("forced pair indices must be integers")
        if not 0 <= old_index < len(old_entries):
            raise ValueError(f"forced old index out of range: {old_index}")
        if not 0 <= new_index < len(new_entries):
            raise ValueError(f"forced new index out of range: {new_index}")
        if old_index in seen_old:
            raise ValueError(f"forced old index is duplicated: {old_index}")
        if new_index in seen_new:
            raise ValueError(f"forced new index is duplicated: {new_index}")
        seen_old.add(old_index)
        seen_new.add(new_index)

    for old_index, new_index in forced_items:
        matches.append(
            _match_record(
                old_entries,
                new_entries,
                old_index,
                new_index,
                "manual_override",
                1.0,
            )
        )
        unmatched_old.remove(old_index)
        unmatched_new.remove(new_index)

    _pair_exact_fingerprints(
        old_entries, new_entries, unmatched_old, unmatched_new, matches, warnings,
    )
    _pair_same_structure(
        old_entries, new_entries, unmatched_old, unmatched_new, matches, warnings,
    )
    _pair_unique_exact_tags(
        old_entries, new_entries, unmatched_old, unmatched_new, matches, warnings,
    )
    _pair_unique_same_title(
        old_entries, new_entries, unmatched_old, unmatched_new, matches,
    )

    reviews = _review_candidates(
        old_entries, new_entries, unmatched_old, unmatched_new,
    )
    reviewed_new = {item["new"]["index"] for item in reviews}
    reviewed_old = {
        candidate["old"]["index"]
        for item in reviews
        for candidate in item["candidates"]
    }
    additions = [
        _entry_snapshot(new_entries[index], index)
        for index in sorted(unmatched_new - reviewed_new)
    ]
    removals = [
        _entry_snapshot(old_entries[index], index)
        for index in sorted(unmatched_old - reviewed_old)
    ]

    matches.sort(key=lambda item: item["new"]["index"])
    method_counts = Counter(item["method"] for item in matches)
    change_counts = Counter(
        change for item in matches for change in item["changes"]
    )
    unchanged = sum(1 for item in matches if not item["changes"])
    flag_only = sum(1 for item in matches if item["changes"] == ["isNew"])
    changed = len(matches) - unchanged
    content_changed = sum(
        1 for item in matches if any(change != "isNew" for change in item["changes"])
    )
    matched_imaged = sum(1 for item in matches if item["old"].get("image"))
    unmatched_old_imaged = sum(
        1 for index in unmatched_old if old_entries[index].get("image")
    )

    summary = {
        "oldCount": len(old_entries),
        "newCount": len(new_entries),
        "netChange": len(new_entries) - len(old_entries),
        "matched": len(matches),
        "unchanged": unchanged,
        "changed": changed,
        "contentChanged": content_changed,
        "flagOnlyChanged": flag_only,
        "unmatchedOld": len(unmatched_old),
        "unmatchedNew": len(unmatched_new),
        "reviewNew": len(reviews),
        "reviewOld": len(reviewed_old),
        "clearAdditions": len(additions),
        "clearRemovals": len(removals),
        "matchedImaged": matched_imaged,
        "unmatchedOldImaged": unmatched_old_imaged,
        "matchRate": round(len(matches) / len(new_entries), 6) if new_entries else 1.0,
        "methodCounts": dict(sorted(method_counts.items())),
        "changeCounts": dict(sorted(change_counts.items())),
    }
    summary["strictReplayPass"] = bool(
        len(old_entries) == len(new_entries)
        and len(matches) == len(old_entries)
        and content_changed == 0
        and not unmatched_old
        and not unmatched_new
    )

    return {
        "summary": summary,
        "validationIssues": validate_inputs(old_entries, new_entries),
        "warnings": warnings,
        "matches": matches,
        "review": reviews,
        "additions": additions,
        "removals": removals,
        "unmatchedNew": [
            _entry_snapshot(new_entries[index], index) for index in sorted(unmatched_new)
        ],
        "unmatchedOld": [
            _entry_snapshot(old_entries[index], index) for index in sorted(unmatched_old)
        ],
    }


def inspect_docx_package(path: Path) -> dict[str, Any]:
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        document = ET.fromstring(archive.read("word/document.xml"))
        settings = (
            ET.fromstring(archive.read("word/settings.xml"))
            if "word/settings.xml" in names
            else None
        )
        return {
            "paragraphs": len(document.findall(".//w:p", ns)),
            "tables": len(document.findall(".//w:tbl", ns)),
            "drawings": len(document.findall(".//w:drawing", ns)),
            "textBoxes": len(document.findall(".//w:txbxContent", ns)),
            "trackedInsertions": len(document.findall(".//w:ins", ns)),
            "trackedDeletions": len(document.findall(".//w:del", ns)),
            "commentsPart": "word/comments.xml" in names,
            "trackRevisionsEnabled": bool(
                settings is not None and settings.find(".//w:trackRevisions", ns) is not None
            ),
        }


def parse_docx_items(path: Path) -> list[dict[str, Any]]:
    convert = _load_convert_module()
    doc = convert.Document(str(path))
    return convert.parse_standard_docx_items(doc)


def load_codex(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
        raise ValueError(f"Not a codex JSON: {path}")
    return data


def validate_codex_identity(codex: dict[str, Any], expected_id: str) -> None:
    actual_id = str(codex.get("id") or "")
    if actual_id != expected_id:
        raise ValueError(
            f"codex ID mismatch: --codex-id={expected_id!r}, data id={actual_id!r}"
        )


def load_baseline_json(path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Load an entries snapshot or rebuild source candidates from a match report."""
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"Baseline JSON must be an object: {path}")

    direct = payload.get("entries")
    if isinstance(direct, list):
        entries = [_source_entry(entry) for entry in direct if isinstance(entry, dict)]
        if len(entries) != len(direct):
            raise ValueError(f"Baseline entries contain non-object values: {path}")
    else:
        by_index: dict[int, dict[str, Any]] = {}

        def add_snapshot(snapshot: Any) -> None:
            if not isinstance(snapshot, dict) or not isinstance(snapshot.get("index"), int):
                return
            index = int(snapshot["index"])
            candidate = _source_entry(snapshot)
            previous = by_index.get(index)
            if previous is not None and previous != candidate:
                raise ValueError(f"Conflicting baseline snapshots at index {index}: {path}")
            by_index[index] = candidate

        for match in payload.get("matches", []):
            if isinstance(match, dict):
                add_snapshot(match.get("new"))
        for snapshot in payload.get("unmatchedNew", []):
            add_snapshot(snapshot)
        # Older/custom reports may omit unmatchedNew while retaining the two
        # classified views.  They are safe to merge by source index.
        for snapshot in payload.get("additions", []):
            add_snapshot(snapshot)
        for review in payload.get("review", []):
            if isinstance(review, dict):
                add_snapshot(review.get("new"))

        if not by_index:
            raise ValueError(f"Baseline JSON has neither entries nor source snapshots: {path}")
        expected = list(range(max(by_index) + 1))
        if sorted(by_index) != expected:
            missing = sorted(set(expected) - set(by_index))
            raise ValueError(f"Baseline report is missing source indices {missing[:20]}: {path}")
        entries = [by_index[index] for index in expected]

    metadata = {
        "version": str(payload.get("version") or payload.get("newVersion") or ""),
        "source": str(payload.get("source") or path),
        "structure": payload.get("docxStructure")
        if isinstance(payload.get("docxStructure"), dict)
        else {"sourceType": "json"},
    }
    return entries, metadata


def word_structure_safe(structure: dict[str, Any]) -> bool:
    return (
        not any(structure.get(key) for key in RISKY_STRUCTURE_KEYS)
        and not structure.get("commentsPart")
        and not structure.get("trackRevisionsEnabled")
    )


def collect_reserved_ids(
    codex_id: str,
    old_entries: list[dict[str, Any]],
    *,
    image_root: Path | None = None,
    original_root: Path | None = None,
) -> set[str]:
    """Collect current and orphaned local IDs so deleted numbers stay reserved."""
    reserved = {
        str(entry.get("id"))
        for entry in old_entries
        if entry.get("id")
    }
    roots = (
        image_root or ROOT / "site" / "images",
        original_root or ROOT / "originals",
    )
    pattern = re.compile(r"^" + re.escape(codex_id) + r"-\d+$")
    for root in roots:
        directory = root / codex_id
        if not directory.is_dir():
            continue
        for asset in directory.rglob("*"):
            if asset.is_file() and pattern.fullmatch(asset.stem):
                reserved.add(asset.stem)
    return reserved


def normalize_update_batches(entry: Mapping[str, Any]) -> list[str]:
    """Return a validated, de-duplicated update-batch list for an entry."""
    raw = entry.get(UPDATE_BATCHES_KEY)
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError(f"{UPDATE_BATCHES_KEY} must be a list")
    result: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, str) or not item.strip():
            raise ValueError(
                f"{UPDATE_BATCHES_KEY} values must be non-empty strings"
            )
        value = item.strip()
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def apply_current_update_batch(entry: dict[str, Any], version: str) -> None:
    """Preserve history and append ``version`` when the source marks NEW.

    ``isNew`` deliberately keeps its existing meaning: it marks only the
    latest source update.  ``updateBatches`` is the durable history used by
    update-filter controls after a later source clears that flag.
    """
    batch_id = str(version).strip()
    if not batch_id:
        raise ValueError("update batch version must not be empty")
    batches = [
        value for value in normalize_update_batches(entry)
        if value != batch_id
    ]
    if bool(entry.get("isNew")) and batch_id not in batches:
        batches.append(batch_id)
    if batches:
        entry[UPDATE_BATCHES_KEY] = batches
    else:
        entry.pop(UPDATE_BATCHES_KEY, None)


def previous_latest_update_batch_id(
    codex_version: Any,
    update_filters: Any = None,
) -> str:
    """Resolve the previous latest batch, with legacy-version fallback."""
    fallback = str(codex_version or "").strip()
    latest_ids: list[str] = []
    if update_filters is not None:
        if not isinstance(update_filters, list):
            raise ValueError("updateFilters must be a list")
        for raw in update_filters:
            if not isinstance(raw, Mapping):
                raise ValueError("updateFilters entries must be objects")
            if raw.get("latest") is True:
                filter_id = str(raw.get("id") or "").strip()
                if not filter_id:
                    raise ValueError("latest updateFilters entry requires an id")
                latest_ids.append(filter_id)
    if len(latest_ids) > 1:
        raise ValueError("updateFilters must contain at most one latest entry")
    if latest_ids:
        latest_id = latest_ids[0]
        if fallback and latest_id != fallback:
            raise ValueError(
                "latest updateFilters id must match the current codex version"
            )
        return latest_id
    if not fallback:
        raise ValueError("current codex version is required to seed legacy isNew")
    return fallback


def seed_previous_update_batch(entry: dict[str, Any], batch_id: str) -> None:
    """Promote a legacy ``isNew`` flag into durable history before overwrite."""
    batches = normalize_update_batches(entry)
    if bool(entry.get("isNew")) and batch_id not in batches:
        batches.append(batch_id)
    if batches:
        entry[UPDATE_BATCHES_KEY] = batches
    else:
        entry.pop(UPDATE_BATCHES_KEY, None)


def short_update_filter_label(version: str) -> str:
    """Render a compact update-filter label such as ``8.14更新``."""
    value = str(version).strip()
    matched = re.fullmatch(r"\d{4}\.(\d{1,2})\.(\d{1,2})", value)
    short_version = f"{matched.group(1)}.{matched.group(2)}" if matched else value
    return f"{short_version}更新"


def update_filter_history(
    existing: Any,
    latest_version: str,
    *,
    required_batch_ids: Iterable[str] = (),
) -> list[dict[str, Any]]:
    """Preserve historical filter metadata and mark one latest batch."""
    if existing is None:
        existing = []
    if not isinstance(existing, list):
        raise ValueError("updateFilters must be a list")

    latest_id = str(latest_version).strip()
    if not latest_id:
        raise ValueError("latest update-filter version must not be empty")
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    found_latest = False
    for raw in existing:
        if not isinstance(raw, Mapping):
            raise ValueError("updateFilters entries must be objects")
        filter_id = str(raw.get("id") or "").strip()
        if not filter_id:
            raise ValueError("updateFilters entries require a non-empty id")
        if filter_id in seen:
            raise ValueError(f"duplicate updateFilters id: {filter_id}")
        seen.add(filter_id)
        value = dict(raw)
        value["id"] = filter_id
        value.pop("latest", None)
        if filter_id == latest_id:
            value["label"] = short_update_filter_label(latest_id)
            value["latest"] = True
            found_latest = True
        result.append(value)

    required: list[str] = []
    for raw_batch_id in required_batch_ids:
        batch_id = str(raw_batch_id or "").strip()
        if not batch_id:
            raise ValueError("update batch IDs must be non-empty strings")
        if batch_id not in required:
            required.append(batch_id)
    for batch_id in required:
        if batch_id == latest_id or batch_id in seen:
            continue
        result.append({
            "id": batch_id,
            "label": short_update_filter_label(batch_id),
        })
        seen.add(batch_id)

    if not found_latest:
        result.append({
            "id": latest_id,
            "label": short_update_filter_label(latest_id),
            "latest": True,
        })
    return result


def entry_update_batch_ids(entries: Iterable[Mapping[str, Any]]) -> set[str]:
    """Collect every durable batch referenced by formal entries."""
    result: set[str] = set()
    for entry in entries:
        result.update(normalize_update_batches(entry))
    return result


def validate_update_batch_contract(
    codex: Mapping[str, Any],
    update_filters: Any,
) -> dict[str, Any]:
    """Enforce the entry/filter invariants before a formal write."""
    version = str(codex.get("version") or "").strip()
    entries = codex.get("entries")
    if not version:
        raise ValueError("codex version is required for update-batch validation")
    if not isinstance(entries, list):
        raise ValueError("codex entries are required for update-batch validation")
    if not isinstance(update_filters, list):
        raise ValueError("updateFilters must be a list")

    filter_ids: set[str] = set()
    latest_ids: list[str] = []
    for raw in update_filters:
        if not isinstance(raw, Mapping):
            raise ValueError("updateFilters entries must be objects")
        filter_id = str(raw.get("id") or "").strip()
        if not filter_id:
            raise ValueError("updateFilters entries require a non-empty id")
        if filter_id in filter_ids:
            raise ValueError(f"duplicate updateFilters id: {filter_id}")
        filter_ids.add(filter_id)
        if raw.get("latest") is True:
            latest_ids.append(filter_id)
    if latest_ids != [version]:
        raise ValueError(
            "updateFilters must contain exactly one latest entry matching codex version"
        )

    batch_ids = entry_update_batch_ids(entries)
    missing_filters = sorted(batch_ids - filter_ids)
    if missing_filters:
        raise ValueError(
            f"entry update batches have no matching updateFilters: {missing_filters}"
        )
    is_new_ids = {
        str(entry.get("id"))
        for entry in entries
        if entry.get("isNew") is True
    }
    latest_batch_ids = {
        str(entry.get("id"))
        for entry in entries
        if version in normalize_update_batches(entry)
    }
    if is_new_ids != latest_batch_ids:
        raise ValueError(
            "isNew entries must exactly match the latest update batch"
        )
    return {
        "latest": version,
        "latestCount": len(latest_batch_ids),
        "batchIds": sorted(batch_ids),
        "filterIds": sorted(filter_ids),
    }


def build_applied_codex(
    codex: dict[str, Any],
    new_entries: list[dict[str, Any]],
    match_result: dict[str, Any],
    new_version: str,
    *,
    reserved_ids: Iterable[str] = (),
    previous_update_filters: Any = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Build the exact formal codex without writing it."""
    convert = _load_convert_module()
    old_entries = codex["entries"]
    old_by_new: dict[int, int] = {}
    used_old: set[int] = set()
    for match in match_result["matches"]:
        new_index = int(match["new"]["index"])
        old_index = int(match["old"]["index"])
        if new_index in old_by_new or old_index in used_old:
            raise ValueError("match result reuses an old or new entry index")
        old_by_new[new_index] = old_index
        used_old.add(old_index)

    addition_indices = {int(entry["index"]) for entry in match_result["additions"]}
    if set(range(len(new_entries))) != set(old_by_new) | addition_indices:
        raise ValueError("match result does not resolve every new entry")

    codex_id = str(codex.get("id") or "")
    id_pattern = re.compile(r"^" + re.escape(codex_id) + r"-(\d+)$")
    reserved_input = set(str(value) for value in reserved_ids)
    reserved = set(reserved_input)
    reserved.update(
        str(entry.get("id")) for entry in old_entries if entry.get("id")
    )
    max_number = max(
        (int(match.group(1)) for value in reserved if (match := id_pattern.fullmatch(value))),
        default=0,
    )
    next_number = max_number + 1

    def fresh_id() -> str:
        nonlocal next_number
        while True:
            value = f"{codex_id}-{next_number:04d}"
            next_number += 1
            if value not in reserved:
                reserved.add(value)
                return value

    final_entries: list[dict[str, Any]] = []
    new_ids: list[str] = []
    previous_batch_id = previous_latest_update_batch_id(
        codex.get("version"), previous_update_filters
    )
    for new_index, raw_candidate in enumerate(new_entries):
        candidate = _source_entry(raw_candidate)
        old_index = old_by_new.get(new_index)
        if old_index is not None:
            value = dict(old_entries[old_index])
            seed_previous_update_batch(value, previous_batch_id)
            for key in SOURCE_CONTENT_KEYS:
                if key in candidate:
                    value[key] = candidate[key]
                elif key == "characterPrompts":
                    value.pop(key, None)
            value["id"] = old_entries[old_index]["id"]
        else:
            entry_id = fresh_id()
            value = {"id": entry_id, **candidate}
            value.update(convert.image_metadata(codex_id, entry_id))
            new_ids.append(entry_id)
        final_entries.append(value)

    audited_new_override_ids = apply_audited_new_overrides(
        final_entries, codex_id, new_version
    )
    for value in final_entries:
        apply_current_update_batch(value, new_version)

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

    applied = dict(codex)
    applied.update({
        "version": new_version,
        "entryCount": len(final_entries),
        "imagedCount": sum(bool(entry.get("image")) for entry in final_entries),
        "tree": convert.build_tree(final_entries),
        "entries": final_entries,
    })
    removed = [
        entry for index, entry in enumerate(old_entries) if index not in used_old
    ]
    stats = {
        "entryCount": applied["entryCount"],
        "imagedCount": applied["imagedCount"],
        "matchedInherited": len(old_by_new),
        "matchedImagedInherited": sum(
            bool(old_entries[index].get("image")) for index in used_old
        ),
        "newIdCount": len(new_ids),
        "newIds": new_ids,
        "removedCount": len(removed),
        "removedImagedCount": sum(bool(entry.get("image")) for entry in removed),
        "removedIds": [entry.get("id") for entry in removed],
        "reservedIdCount": len(reserved_input),
        "latestUpdateBatchCount": sum(
            new_version in normalize_update_batches(entry)
            for entry in final_entries
        ),
        "auditedNewOverrideIds": audited_new_override_ids,
    }
    return applied, stats


def build_updated_codex_index(
    index: list[dict[str, Any]],
    applied_codex: dict[str, Any],
    codex_id: str,
) -> list[dict[str, Any]]:
    """Refresh only generated summary fields and preserve curated metadata."""
    updated: list[dict[str, Any]] = []
    found = 0
    for item in index:
        if item.get("id") != codex_id:
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
        raise ValueError(f"expected one {codex_id} index item, found {found}")
    return updated


def update_filter_label(version: str) -> str:
    """Render the UI's update filter label from a codex version."""
    value = str(version).strip()
    matched = re.fullmatch(r"\d{4}\.(\d{1,2})\.(\d{1,2})", value)
    short_version = f"{matched.group(1)}.{matched.group(2)}" if matched else value
    return f"本次{short_version}更新"


def build_application_gate(
    result: dict[str, Any],
    normalization: dict[str, Any],
    structure: dict[str, Any],
    *,
    baseline_result: dict[str, Any] | None,
    baseline_normalization: dict[str, Any] | None,
) -> dict[str, Any]:
    baseline_provided = baseline_result is not None
    gate = {
        "baselineProvided": baseline_provided,
        "baselineStrictReplayPass": bool(
            baseline_result and baseline_result["summary"]["strictReplayPass"]
        ),
        "baselineValidationIssues": len(
            baseline_result["validationIssues"] if baseline_result else []
        ),
        "baselineNormalizationBlockers": len(
            (baseline_normalization or {}).get("blockers", [])
        ),
        "newReview": len(result["review"]),
        "newValidationIssues": len(result["validationIssues"]),
        "newNormalizationBlockers": len(normalization.get("blockers", [])),
        "wordStructureSafe": word_structure_safe(structure),
    }
    gate["pass"] = bool(
        gate["baselineProvided"]
        and gate["baselineStrictReplayPass"]
        and gate["baselineValidationIssues"] == 0
        and gate["baselineNormalizationBlockers"] == 0
        and gate["newReview"] == 0
        and gate["newValidationIssues"] == 0
        and gate["newNormalizationBlockers"] == 0
        and gate["wordStructureSafe"]
    )
    return gate


def _write_json(path: Path, value: Any, *, indent: int | None = 2) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=indent) + ("\n" if indent else ""),
        encoding="utf-8",
    )


def write_json_pair_with_rollback(
    data_path: Path,
    data_value: Any,
    index_path: Path,
    index_value: Any,
) -> None:
    """Replace data and index per-file atomically, rolling back a partial pair."""
    original_data = data_path.read_bytes()
    original_index = index_path.read_bytes()
    data_tmp = data_path.with_suffix(data_path.suffix + ".tmp")
    index_tmp = index_path.with_suffix(index_path.suffix + ".tmp")
    data_restore = data_path.with_suffix(data_path.suffix + ".rollback")
    index_restore = index_path.with_suffix(index_path.suffix + ".rollback")
    _write_json(data_tmp, data_value, indent=None)
    _write_json(index_tmp, index_value)
    data_replaced = False
    index_replaced = False
    preserved_restores: set[Path] = set()
    try:
        data_tmp.replace(data_path)
        data_replaced = True
        index_tmp.replace(index_path)
        index_replaced = True
    except BaseException as error:
        rollback_errors: list[str] = []
        for replaced, target, restore, content in (
            (data_replaced, data_path, data_restore, original_data),
            (index_replaced, index_path, index_restore, original_index),
        ):
            if not replaced:
                continue
            try:
                restore.write_bytes(content)
                restore.replace(target)
            except BaseException as rollback_error:
                preserved_restores.add(restore)
                rollback_errors.append(
                    f"{target} (recovery copy: {restore}): {rollback_error}"
                )
        if rollback_errors:
            raise RuntimeError(
                "data/index write failed and rollback was incomplete: "
                + "; ".join(rollback_errors)
            ) from error
        raise
    finally:
        for leftover in (data_tmp, index_tmp):
            leftover.unlink(missing_ok=True)
        for restore in (data_restore, index_restore):
            if restore not in preserved_restores:
                restore.unlink(missing_ok=True)


def _short(value: Any, limit: int = 180) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _entry_label(entry: dict[str, Any]) -> str:
    path = " > ".join(entry.get("path", []))
    prefix = f"`{entry.get('id')}` " if entry.get("id") else ""
    return f"{prefix}{path} › {entry.get('title', '')}"


def _append_entry_list(
    lines: list[str], title: str, entries: list[dict[str, Any]], limit: int = 250
) -> None:
    lines.extend([f"## {title}", ""])
    if not entries:
        lines.extend(["无。", ""])
        return
    for entry in entries[:limit]:
        lines.append(f"- {_entry_label(entry)}")
        lines.append(f"  - tags: `{_short(entry.get('tags'))}`")
        if entry.get("characterPrompts"):
            lines.append(
                f"  - characterPrompts: {len(entry['characterPrompts'])} 组"
            )
    if len(entries) > limit:
        lines.append(f"- ……其余 {len(entries) - limit} 条见 JSON 报告。")
    lines.append("")


def render_markdown(
    result: dict[str, Any],
    *,
    label: str,
    source: Path,
    structure: dict[str, Any],
    old_version: str,
    new_version: str,
) -> str:
    summary = result["summary"]
    lines = [
        f"# {label}",
        "",
        f"- 现有版本：`{old_version}`",
        f"- 输入版本：`{new_version}`",
        f"- 输入文件：`{source}`",
        "- 本报告记录匹配预演；正式数据是否写入见 `update-summary.md`。",
        "",
        "## 汇总",
        "",
        "| 项目 | 数量 |",
        "|---|---:|",
        f"| 旧条目 | {summary['oldCount']} |",
        f"| 新条目 | {summary['newCount']} |",
        f"| 净变化 | {summary['netChange']:+d} |",
        f"| 自动匹配 | {summary['matched']} |",
        f"| 完全未变 | {summary['unchanged']} |",
        f"| 已匹配但有变化 | {summary['changed']} |",
        f"| 待人工复核的新条目 | {summary['reviewNew']} |",
        f"| 明确新增 | {summary['clearAdditions']} |",
        f"| 明确减少 | {summary['clearRemovals']} |",
        f"| 未匹配旧条目中带图 | {summary['unmatchedOldImaged']} |",
        f"| 匹配率 | {summary['matchRate']:.2%} |",
        "",
        "## Word 结构安全检查",
        "",
        "| 项目 | 数量/状态 |",
        "|---|---:|",
    ]
    for key, value in structure.items():
        lines.append(f"| `{key}` | {value} |")
    lines.append("")

    normalization = result.get("normalizationAudit") or {}
    if normalization:
        lines.extend([
            "## 角色词规范化",
            "",
            f"- 规范化条目：{normalization.get('changedEntries', 0)}",
            f"- 标准写法：{normalization.get('standardChangedEntries', 0)}",
            f"- 变体写法：{normalization.get('variantChangedEntries', 0)}",
            f"- blocker：{len(normalization.get('blockers', []))}",
            "",
        ])
        for blocker in normalization.get("blockers", [])[:100]:
            lines.append(f"- `{json.dumps(blocker, ensure_ascii=False)}`")
        if normalization.get("blockers"):
            lines.append("")

    lines.extend(["## 自动匹配方法", ""])
    for method, count in summary["methodCounts"].items():
        lines.append(f"- `{method}`：{count}")
    lines.append("")

    changed = [item for item in result["matches"] if item["changes"]]
    lines.extend(["## 已自动匹配的变化", ""])
    if not changed:
        lines.extend(["无。", ""])
    else:
        for item in changed[:300]:
            old = item["old"]
            new = item["new"]
            lines.append(
                f"- `{old.get('id')}` `{item['method']}` "
                f"(confidence {item['confidence']:.3f})："
                f"{', '.join(item['changes'])}"
            )
            lines.append(f"  - 旧：{_entry_label(old)}")
            lines.append(f"  - 新：{_entry_label(new)}")
            if "tags" in item["changes"]:
                lines.append(f"  - 旧 tags：`{_short(old.get('tags'))}`")
                lines.append(f"  - 新 tags：`{_short(new.get('tags'))}`")
            if "characterPrompts" in item["changes"]:
                lines.append(
                    "  - 角色词组数："
                    f"{len(old.get('characterPrompts') or [])} → "
                    f"{len(new.get('characterPrompts') or [])}"
                )
        if len(changed) > 300:
            lines.append(f"- ……其余 {len(changed) - 300} 条见 JSON 报告。")
        lines.append("")

    lines.extend(["## 待人工复核", ""])
    if not result["review"]:
        lines.extend(["无。", ""])
    else:
        for item in result["review"][:250]:
            lines.append(f"- 新：{_entry_label(item['new'])}")
            for candidate in item["candidates"]:
                score = candidate["similarity"]["score"]
                lines.append(
                    f"  - 候选 {score:.3f}：{_entry_label(candidate['old'])}"
                )
        if len(result["review"]) > 250:
            lines.append(f"- ……其余 {len(result['review']) - 250} 条见 JSON 报告。")
        lines.append("")

    _append_entry_list(lines, "明确新增", result["additions"])
    _append_entry_list(lines, "明确减少", result["removals"])

    if result["validationIssues"] or result["warnings"]:
        lines.extend(["## 结构警告", ""])
        for item in result["validationIssues"]:
            lines.append(f"- validation: `{json.dumps(item, ensure_ascii=False)}`")
        for item in result["warnings"][:100]:
            lines.append(f"- matcher: `{json.dumps(item, ensure_ascii=False)}`")
        if len(result["warnings"]) > 100:
            lines.append(f"- ……其余 {len(result['warnings']) - 100} 条见 JSON 报告。")
        lines.append("")

    return "\n".join(lines)


def write_report(
    out_dir: Path,
    stem: str,
    result: dict[str, Any],
    *,
    label: str,
    source: Path,
    structure: dict[str, Any],
    old_version: str,
    new_version: str,
) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / f"{stem}.json"
    md_path = out_dir / f"{stem}.md"
    payload = {
        "label": label,
        "source": str(source),
        "oldVersion": old_version,
        "newVersion": new_version,
        "docxStructure": structure,
        **result,
    }
    json_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    md_path.write_text(
        render_markdown(
            result,
            label=label,
            source=source,
            structure=structure,
            old_version=old_version,
            new_version=new_version,
        ),
        encoding="utf-8",
    )
    return json_path, md_path


def _default_out_dir(codex_id: str, docx: Path) -> Path:
    convert = _load_convert_module()
    version = convert.parse_meta(docx.stem)[1] or "unknown"
    safe_version = re.sub(r"[^0-9A-Za-z._-]+", "-", version)
    return ROOT / "output" / f"codex-update-{codex_id}-{safe_version}"


def main() -> int:
    convert = _load_convert_module()
    parser = argparse.ArgumentParser(
        description="Audit or apply a gated DOCX codex update with stable IDs."
    )
    parser.add_argument("docx", type=Path, help="New regular codex DOCX.")
    parser.add_argument("--codex-id", default="suozhang")
    parser.add_argument("--data", type=Path, help="Existing codex JSON.")
    baseline_group = parser.add_mutually_exclusive_group()
    baseline_group.add_argument(
        "--baseline-docx", type=Path, help="Previous DOCX for replay gate."
    )
    baseline_group.add_argument(
        "--baseline-json",
        type=Path,
        help="Previous source snapshot or new-version-match JSON for replay gate.",
    )
    parser.add_argument(
        "--index", type=Path, default=ROOT / "site" / "data" / "codexes.json"
    )
    parser.add_argument("--out-dir", type=Path)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write data/index with rollback protection after every matching gate passes.",
    )
    args = parser.parse_args()

    docx = args.docx.resolve()
    data_path = (args.data or ROOT / "site" / "data" / f"{args.codex_id}.json").resolve()
    index_path = args.index.resolve()
    out_dir = (args.out_dir or _default_out_dir(args.codex_id, docx)).resolve()
    if not docx.is_file():
        parser.error(f"DOCX not found: {docx}")
    if not data_path.is_file():
        parser.error(f"Codex JSON not found: {data_path}")
    if args.apply and not (args.baseline_docx or args.baseline_json):
        parser.error("--apply requires --baseline-docx or --baseline-json")

    codex = load_codex(data_path)
    validate_codex_identity(codex, args.codex_id)
    old_entries = codex["entries"]
    new_structure = inspect_docx_package(docx)
    parsed_new_entries = parse_docx_items(docx)
    _, new_version, _ = convert.parse_meta(docx.stem)
    if args.codex_id == "suozhang":
        new_entries, new_normalization = normalize_suozhang_entries(
            parsed_new_entries, old_entries
        )
    else:
        new_entries = [_source_entry(entry) for entry in parsed_new_entries]
        new_normalization = {
            "entries": len(new_entries),
            "changedEntries": 0,
            "standardChangedEntries": 0,
            "variantChangedEntries": 0,
            "blockers": [],
        }
    new_normalization["auditedNewOverrideIds"] = (
        apply_audited_source_new_overrides(
            new_entries, args.codex_id, new_version
        )
    )
    result = match_entries(old_entries, new_entries)
    result["normalizationAudit"] = new_normalization
    new_json, new_md = write_report(
        out_dir,
        "new-version-match",
        result,
        label=f"{args.codex_id} 新版本增量匹配预演",
        source=docx,
        structure=new_structure,
        old_version=str(codex.get("version", "")),
        new_version=new_version,
    )

    baseline_result: dict[str, Any] | None = None
    baseline_normalization: dict[str, Any] | None = None
    baseline_json_path: Path | None = None
    baseline_md_path: Path | None = None
    if args.baseline_docx or args.baseline_json:
        if args.baseline_docx:
            baseline = args.baseline_docx.resolve()
            if not baseline.is_file():
                parser.error(f"Baseline DOCX not found: {baseline}")
            baseline_structure = inspect_docx_package(baseline)
            parsed_baseline_entries = parse_docx_items(baseline)
            _, baseline_version, _ = convert.parse_meta(baseline.stem)
        else:
            baseline = args.baseline_json.resolve()
            if not baseline.is_file():
                parser.error(f"Baseline JSON not found: {baseline}")
            parsed_baseline_entries, baseline_metadata = load_baseline_json(baseline)
            baseline_structure = baseline_metadata["structure"]
            baseline_version = baseline_metadata["version"]

        if args.codex_id == "suozhang":
            baseline_entries, baseline_normalization = normalize_suozhang_entries(
                parsed_baseline_entries, old_entries
            )
        else:
            baseline_entries = [_source_entry(entry) for entry in parsed_baseline_entries]
            baseline_normalization = {
                "entries": len(baseline_entries),
                "changedEntries": 0,
                "standardChangedEntries": 0,
                "variantChangedEntries": 0,
                "blockers": [],
            }
        baseline_normalization["auditedNewOverrideIds"] = (
            apply_audited_source_new_overrides(
                baseline_entries, args.codex_id, baseline_version
            )
        )
        baseline_result = match_entries(old_entries, baseline_entries)
        baseline_result["normalizationAudit"] = baseline_normalization
        baseline_json_path, baseline_md_path = write_report(
            out_dir,
            "baseline-replay",
            baseline_result,
            label=f"{args.codex_id} 旧版本回放基线",
            source=baseline,
            structure=baseline_structure,
            old_version=str(codex.get("version", "")),
            new_version=baseline_version,
        )

    gate = build_application_gate(
        result,
        new_normalization,
        new_structure,
        baseline_result=baseline_result,
        baseline_normalization=baseline_normalization,
    )

    reports: dict[str, str] = {
        "newJson": str(new_json),
        "newMarkdown": str(new_md),
    }
    if baseline_json_path and baseline_md_path:
        reports.update({
            "baselineJson": str(baseline_json_path),
            "baselineMarkdown": str(baseline_md_path),
        })

    application: dict[str, Any] | None = None
    if gate["pass"]:
        if not index_path.is_file():
            raise ValueError(f"Codex index not found: {index_path}")
        with index_path.open(encoding="utf-8") as handle:
            current_index = json.load(handle)
        if not isinstance(current_index, list):
            raise ValueError(f"Codex index must be a list: {index_path}")
        current_meta = [
            item for item in current_index if item.get("id") == args.codex_id
        ]
        if len(current_meta) != 1:
            raise ValueError(
                f"expected one {args.codex_id} index item, found {len(current_meta)}"
            )
        reserved_ids = collect_reserved_ids(args.codex_id, old_entries)
        applied_codex, application_stats = build_applied_codex(
            codex,
            new_entries,
            result,
            new_version,
            reserved_ids=reserved_ids,
            previous_update_filters=current_meta[0].get("updateFilters"),
        )
        updated_index = build_updated_codex_index(
            current_index, applied_codex, args.codex_id
        )
        preview_data = out_dir / "formal-apply-preview.json"
        preview_index = out_dir / "codexes-apply-preview.json"
        _write_json(preview_data, applied_codex)
        _write_json(preview_index, updated_index)
        reports.update({
            "formalApplyPreview": str(preview_data),
            "codexesApplyPreview": str(preview_index),
        })
        application = {
            "applied": bool(args.apply),
            "dataPath": str(data_path),
            "indexPath": str(index_path),
            "stats": application_stats,
        }
        if args.apply:
            write_json_pair_with_rollback(
                data_path, applied_codex, index_path, updated_index
            )

    summary_payload = {
        "schema": 1,
        "codexId": args.codex_id,
        "oldVersion": str(codex.get("version", "")),
        "newVersion": new_version,
        "matchingGatePass": gate["pass"],
        "formalDataUnchanged": not (args.apply and gate["pass"]),
        "gate": gate,
        "newMatch": result["summary"],
        "baseline": baseline_result["summary"] if baseline_result else None,
        "normalization": {
            "new": new_normalization,
            "baseline": baseline_normalization,
        },
        "application": application,
        "reports": reports,
    }
    summary_json = out_dir / "update-summary.json"
    summary_md = out_dir / "update-summary.md"
    reports.update({"summaryJson": str(summary_json), "summaryMarkdown": str(summary_md)})
    summary_payload["reports"] = reports
    _write_json(summary_json, summary_payload)
    summary_md.write_text(
        "\n".join([
            f"# {args.codex_id} {new_version} 增量更新门禁",
            "",
            f"- 门禁：{'通过' if gate['pass'] else '未通过'}",
            f"- 正式写入：{'是' if args.apply and gate['pass'] else '否'}",
            f"- 旧/新条目：{result['summary']['oldCount']} → {result['summary']['newCount']}",
            f"- 自动匹配/新增/减少：{result['summary']['matched']} / {result['summary']['clearAdditions']} / {result['summary']['clearRemovals']}",
            f"- 待复核/validation/blocker：{gate['newReview']} / {gate['newValidationIssues']} / {gate['newNormalizationBlockers']}",
            f"- 基线严格回放：{'通过' if gate['baselineStrictReplayPass'] else '未通过'}",
            f"- Word 结构：{'安全' if gate['wordStructureSafe'] else '有风险'}",
            "",
        ]),
        encoding="utf-8",
    )

    if args.apply and not gate["pass"]:
        raise ValueError("refusing --apply because matching gate did not pass")

    baseline_pass = bool(
        baseline_result is None or baseline_result["summary"]["strictReplayPass"]
    )
    console_summary = {
        "outDir": str(out_dir),
        "applied": bool(args.apply and gate["pass"]),
        "matchingGatePass": gate["pass"],
        "baselinePass": baseline_pass,
        "new": result["summary"],
        "normalization": {
            "changedEntries": new_normalization.get("changedEntries", 0),
            "blockers": len(new_normalization.get("blockers", [])),
        },
        "trackedChanges": {
            "insertions": new_structure["trackedInsertions"],
            "deletions": new_structure["trackedDeletions"],
        },
    }
    print(json.dumps(console_summary, ensure_ascii=True))
    return 0 if gate["pass"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
