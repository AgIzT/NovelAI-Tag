# -*- coding: utf-8 -*-
"""Dry-run matcher for incrementally updating a codex from a DOCX source.

The matcher never writes ``site/data``.  It parses the new DOCX with the same
pure parser used by ``convert.py``, preserves only high-confidence old IDs, and
separates unresolved candidates from clear additions/removals.
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
from typing import Any, Callable, Iterable
from xml.etree import ElementTree as ET


TOOLS_DIR = Path(__file__).resolve().parent
ROOT = TOOLS_DIR.parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

REVIEW_THRESHOLD = 0.58
MAX_REVIEW_CANDIDATES = 3


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


def tag_tokens(value: Any) -> frozenset[str]:
    text = norm_tags_value(value)
    return frozenset(
        token.strip()
        for token in re.split(r"[,\n]+", text)
        if token.strip()
    )


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
    left, right = norm_tags(a), norm_tags(b)
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
    for key in ("image", "original", "assetRev", "imageWidth", "imageHeight"):
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
    key = lambda entry: (norm_path(entry), norm_title(entry), norm_tags(entry))
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
    key = norm_tags
    old_groups = _group_indices(unmatched_old, old_entries, key)
    new_groups = _group_indices(unmatched_new, new_entries, key)
    for tags in sorted((old_groups.keys() & new_groups.keys()) - {""}):
        old_group = old_groups[tags]
        new_group = new_groups[tags]
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
                "tags": tags[:240],
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
        for token in tag_tokens(old_entries[old_index].get("tags", "")):
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
        for token in tag_tokens(new.get("tags", "")):
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
        empty_tags = [index for index, entry in enumerate(entries) if not norm_tags(entry)]
        if empty_tags:
            issues.append({"kind": f"empty_{label}_tags", "indices": empty_tags})
    return issues


def match_entries(
    old_entries: list[dict[str, Any]], new_entries: list[dict[str, Any]]
) -> dict[str, Any]:
    unmatched_old = set(range(len(old_entries)))
    unmatched_new = set(range(len(new_entries)))
    matches: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []

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
        "- 本报告为只读预演；没有改写 `site/data`。",
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
        description="Dry-run a DOCX codex update and report stable-ID matches."
    )
    parser.add_argument("docx", type=Path, help="New regular codex DOCX.")
    parser.add_argument("--codex-id", default="suozhang")
    parser.add_argument("--data", type=Path, help="Existing codex JSON.")
    parser.add_argument("--baseline-docx", type=Path, help="Previous DOCX for replay gate.")
    parser.add_argument("--out-dir", type=Path)
    args = parser.parse_args()

    docx = args.docx.resolve()
    data_path = (args.data or ROOT / "site" / "data" / f"{args.codex_id}.json").resolve()
    out_dir = (args.out_dir or _default_out_dir(args.codex_id, docx)).resolve()
    if not docx.is_file():
        parser.error(f"DOCX not found: {docx}")
    if not data_path.is_file():
        parser.error(f"Codex JSON not found: {data_path}")

    codex = load_codex(data_path)
    old_entries = codex["entries"]
    new_structure = inspect_docx_package(docx)
    new_entries = parse_docx_items(docx)
    _, new_version, _ = convert.parse_meta(docx.stem)
    result = match_entries(old_entries, new_entries)
    write_report(
        out_dir,
        "new-version-match",
        result,
        label=f"{args.codex_id} 新版本增量匹配预演",
        source=docx,
        structure=new_structure,
        old_version=str(codex.get("version", "")),
        new_version=new_version,
    )

    baseline_pass = True
    if args.baseline_docx:
        baseline = args.baseline_docx.resolve()
        if not baseline.is_file():
            parser.error(f"Baseline DOCX not found: {baseline}")
        baseline_structure = inspect_docx_package(baseline)
        baseline_entries = parse_docx_items(baseline)
        _, baseline_version, _ = convert.parse_meta(baseline.stem)
        baseline_result = match_entries(old_entries, baseline_entries)
        write_report(
            out_dir,
            "baseline-replay",
            baseline_result,
            label=f"{args.codex_id} 旧版本回放基线",
            source=baseline,
            structure=baseline_structure,
            old_version=str(codex.get("version", "")),
            new_version=baseline_version,
        )
        baseline_pass = baseline_result["summary"]["strictReplayPass"]

    console_summary = {
        "outDir": str(out_dir),
        "baselinePass": baseline_pass,
        "new": result["summary"],
        "trackedChanges": {
            "insertions": new_structure["trackedInsertions"],
            "deletions": new_structure["trackedDeletions"],
        },
    }
    print(json.dumps(console_summary, ensure_ascii=True))
    return 0 if baseline_pass else 2


if __name__ == "__main__":
    raise SystemExit(main())
