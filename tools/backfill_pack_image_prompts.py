"""图包套图的逐图负面与角色词回填。

图包导入时套图顶层 tags / negative / characterPrompts 取封面，逐图只存 rawTag。
本工具从原图内嵌参数读出非封面图的负面与角色词，与顶层不同的写进 images[]，
并给整组读全、封面核对无误的词条打 perImagePrompts:true（图上缺省字段即与顶层相同）。

只处理 codexes.json 里 type 为 pack 的法典；画风词典等顶层是人工整理内容，不能用原图参数覆盖。
默认只出计划；--apply 先备份再写，写完复跑计划必须零改动。可在每次图包导入后重跑。
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from pack_import_core import clean_character_prompts, clean_text  # noqa: E402
from sd_metadata_inspector import extract_image_metadata  # noqa: E402

ROOT = TOOLS.parent
DATA_DIR = ROOT / "site" / "data"
ORIGINAL_ROOT = ROOT / "originals"
OUTPUT_DIR = ROOT / "output" / "pack-image-prompts"
MARKER = "perImagePrompts"
IMAGE_FIELDS = ("negative", "characterPrompts")


LAYOUTS = ("indent", "compact")


def load_book(path: Path) -> tuple[dict[str, Any], tuple[str, str] | None]:
    """返回 (数据, 排版)。排版认不出时为 None：可以出计划，但拒绝写回。"""
    raw = path.read_bytes()
    newline = "\r\n" if b"\r\n" in raw else "\n"
    data = json.loads(raw.decode("utf-8"))
    for layout in LAYOUTS:
        if dump_book(data, (layout, newline)) == raw:
            return data, (layout, newline)
    return data, None


def dump_book(data: dict[str, Any], layout: tuple[str, str]) -> bytes:
    style, newline = layout
    if style == "compact":
        text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    else:
        text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    return text.replace("\n", newline).encode("utf-8")


def pack_codex_ids(data_dir: Path = DATA_DIR) -> list[str]:
    index = json.loads((data_dir / "codexes.json").read_text(encoding="utf-8"))
    return [str(item["id"]) for item in index if item.get("type") == "pack" and item.get("id")]


def read_image_prompts(path: Path) -> tuple[str, str, list[dict[str, str]]]:
    meta = extract_image_metadata(path)
    return clean_text(meta.prompt), clean_text(meta.negative), clean_character_prompts(meta.character_prompts)


def plan_entry(
    book_id: str,
    entry: dict[str, Any],
    original_root: Path = ORIGINAL_ROOT,
    reader=read_image_prompts,
) -> tuple[list[dict[str, Any]] | None, str]:
    """返回 (逐图目标值, 跳过原因)。目标值与 images[1:] 一一对应，None 表示该字段应缺省。"""
    images = entry.get("images") or []
    asset_id = clean_text(entry.get("assetCodexId")) or book_id
    top_negative = clean_text(entry.get("negative"))
    top_characters = clean_character_prompts(entry.get("characterPrompts"))
    targets: list[dict[str, Any]] = []
    for index, item in enumerate(images):
        position = f"[{index + 1}]"
        name = clean_text(item.get("original")) if isinstance(item, dict) else ""
        path = original_root / asset_id / name
        if not name or not path.is_file():
            return None, f"{position} original_missing"
        try:
            prompt, negative, characters = reader(path)
        except Exception as exc:  # noqa: BLE001 — 单张读不出只跳过这一组，不中断整本
            return None, f"{position} unreadable:{type(exc).__name__}"
        if not prompt:
            return None, f"{position} no_prompt"
        expected = clean_text(item.get("rawTag")) or (clean_text(entry.get("tags")) if index == 0 else "")
        if prompt != expected:
            return None, f"{position} prompt_mismatch"
        if index == 0:
            # 封面参数必须与顶层一致；不一致说明顶层被人工改过，原图参数不能再当真
            if negative != top_negative:
                return None, "cover_negative_mismatch"
            if characters != top_characters:
                return None, "cover_character_mismatch"
            continue
        targets.append({
            "negative": negative if negative != top_negative else None,
            "characterPrompts": characters if characters != top_characters else None,
        })
    return targets, ""


def apply_entry(entry: dict[str, Any], targets: list[dict[str, Any]]) -> bool:
    changed = False
    for item, target in zip(entry["images"][1:], targets):
        for key in IMAGE_FIELDS:
            value = target[key]
            if value is None:
                if key in item:
                    del item[key]
                    changed = True
            elif item.get(key) != value:
                item[key] = value
                changed = True
    if entry.get(MARKER) is not True:
        entry[MARKER] = True
        changed = True
    return changed


def plan_book(
    book_id: str,
    data: dict[str, Any],
    original_root: Path = ORIGINAL_ROOT,
    reader=read_image_prompts,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "multiImageEntries": 0,
        "entriesToChange": 0,
        "imagesWithNegative": 0,
        "imagesWithCharacters": 0,
        "skipped": [],
        "plans": {},
    }
    for entry in data.get("entries") or []:
        if len(entry.get("images") or []) < 2:
            continue
        result["multiImageEntries"] += 1
        targets, reason = plan_entry(book_id, entry, original_root, reader)
        if targets is None:
            result["skipped"].append({"id": entry.get("id"), "reason": reason})
            continue
        result["imagesWithNegative"] += sum(1 for item in targets if item["negative"] is not None)
        result["imagesWithCharacters"] += sum(1 for item in targets if item["characterPrompts"] is not None)
        probe = json.loads(json.dumps(entry, ensure_ascii=False))
        if apply_entry(probe, targets):
            result["entriesToChange"] += 1
            result["plans"][str(entry.get("id"))] = targets
    return result


def run(apply: bool, books: list[str] | None = None) -> dict[str, Any]:
    book_ids = books or pack_codex_ids()
    report: dict[str, Any] = {"apply": apply, "books": {}}
    loaded: dict[str, tuple[Path, dict[str, Any], str, dict[str, Any]]] = {}
    for book_id in book_ids:
        path = DATA_DIR / f"{book_id}.json"
        if not path.exists():
            report["books"][book_id] = {"missing": True}
            continue
        data, layout = load_book(path)
        plan = plan_book(book_id, data)
        loaded[book_id] = (path, data, layout, plan)
        report["books"][book_id] = {key: value for key, value in plan.items() if key != "plans"}
        if layout is None and plan["entriesToChange"]:
            report["books"][book_id]["blocker"] = "unrecognized JSON layout, refusing to rewrite"
    pending = {book_id: item for book_id, item in loaded.items() if item[3]["entriesToChange"]}
    report["blocked"] = any(item[2] is None for item in pending.values())
    if apply and pending and not report["blocked"]:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_dir = OUTPUT_DIR / "backups" / stamp
        suffix = 1
        while backup_dir.exists():
            suffix += 1
            backup_dir = OUTPUT_DIR / "backups" / f"{stamp}-{suffix}"
        backup_dir.mkdir(parents=True, exist_ok=False)
        for path, _, _, _ in pending.values():
            shutil.copy2(path, backup_dir / path.name)
        report["backup"] = str(backup_dir)
        for book_id, (path, data, layout, plan) in pending.items():
            by_id = {str(entry.get("id")): entry for entry in data.get("entries") or []}
            for entry_id, targets in plan["plans"].items():
                apply_entry(by_id[entry_id], targets)
            temp = path.with_suffix(path.suffix + ".tmp")
            temp.write_bytes(dump_book(data, layout))
            temp.replace(path)
        # 写完立刻复核：再算计划应当一条改动都没有
        for book_id, (path, _, _, _) in pending.items():
            data, _ = load_book(path)
            if plan_book(book_id, data)["entriesToChange"]:
                raise RuntimeError(f"apply is not idempotent for {book_id}; restore from {backup_dir}")
    report["written"] = bool(apply and pending and not report["blocked"])
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="从原图参数回填图包套图的逐图负面与角色词")
    parser.add_argument("--apply", action="store_true", help="备份后写入 site/data；默认只出计划")
    parser.add_argument("--book", action="append", help="只处理指定法典 id（可重复）；默认全部 pack 类")
    args = parser.parse_args()
    report = run(args.apply, args.book)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = OUTPUT_DIR / ("apply-report.json" if args.apply else "plan-report.json")
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for book_id, item in report["books"].items():
        if item.get("missing"):
            print(f"{book_id}: data file missing")
            continue
        print(
            f"{book_id}: multi={item['multiImageEntries']} change={item['entriesToChange']} "
            f"negative_images={item['imagesWithNegative']} character_images={item['imagesWithCharacters']} "
            f"skipped={len(item['skipped'])}{' BLOCKED' if item.get('blocker') else ''}"
        )
    print(f"written={report['written']} report={report_path.relative_to(ROOT)}")
    return 1 if report["blocked"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
