"""把起好的名字套用到社区图包词条的 title，编号标题留在 serialTitle。

用法：
  python tools/apply_pack_names.py                  预演：只写计划报告，不改正式数据
  python tools/apply_pack_names.py --apply          备份两本书后写入
  python tools/apply_pack_names.py --names 名单.json  换一份名单（默认用 output 里的全量名单）

名单是 JSON 数组，每行至少有 book、id、oldTitle、newTitle：
  - newTitle 非空：title 改成这个名字
  - newTitle 为空：title 退回编号（撤销起名就这样做）
  - 名单里没有的词条：title 不动
每条词条第一次经过这里时，会把当前编号标题补进 serialTitle。
oldTitle 必须等于词条现在的编号标题，对不上说明数据在出名单后变过，整批拒绝写入。
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from pack_import_core import clean_text, serial_title  # noqa: E402

DATA_DIR = ROOT / "site" / "data"
OUTPUT_DIR = ROOT / "output" / "pack_names_apply"
DEFAULT_NAMES = ROOT / "output" / "pack-naming-20260914" / "全量名单.json"
BOOKS = ("nai5_community_pack", "nai45_community_pack")
SERIAL_RE = re.compile(
    r"(?:常规|限制级|扶他|R18|R18G|社区精选|韩网整理|整理套图|所长精选|所长套图|韩网精选|韩网套图|DC)\s+\d+"
)


def load_book(path: Path) -> tuple[dict[str, Any], bool]:
    text = path.read_text(encoding="utf-8")
    compact = text.startswith('{"')
    data = json.loads(text)
    if dump_book(data, compact).replace("\r\n", "\n") != text.replace("\r\n", "\n"):
        # 重新序列化和原文件对不上，说明格式不是这里认得的两种，宁可不写
        raise RuntimeError(f"unrecognized JSON layout, refusing to rewrite: {path.name}")
    return data, compact


def dump_book(data: dict[str, Any], compact: bool) -> str:
    if compact:
        return json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def load_names(path: Path) -> dict[str, dict[str, dict[str, Any]]]:
    rows = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(rows, list):
        raise RuntimeError("names file must be a JSON array")
    by_book: dict[str, dict[str, dict[str, Any]]] = {book: {} for book in BOOKS}
    for row in rows:
        book = row.get("book")
        entry_id = clean_text(row.get("id"))
        if book not in by_book or not entry_id:
            raise RuntimeError(f"bad names row: {row}")
        if entry_id in by_book[book]:
            raise RuntimeError(f"duplicate names row: {book}:{entry_id}")
        new_title = row.get("newTitle") or ""
        if not isinstance(new_title, str) or new_title != new_title.strip() or "\n" in new_title:
            raise RuntimeError(f"bad newTitle: {book}:{entry_id}")
        by_book[book][entry_id] = row
    return by_book


def inferred_serial(entry: dict[str, Any], row: dict[str, Any] | None) -> str:
    """还没有 serialTitle 的词条：title 本身是编号就用它；已被手改成名字时才借名单里的 oldTitle。"""
    title = clean_text(entry.get("title"))
    if SERIAL_RE.fullmatch(title):
        return title
    old = clean_text(row.get("oldTitle")) if row else ""
    return old if SERIAL_RE.fullmatch(old) else ""


def plan_book(data: dict[str, Any], names: dict[str, dict[str, Any]]) -> dict[str, Any]:
    blockers: list[str] = []
    changes: list[dict[str, Any]] = []
    backfilled = 0
    by_id = {entry.get("id"): entry for entry in data.get("entries") or []}
    for entry_id in names:
        if entry_id not in by_id:
            blockers.append(f"missing entry: {entry_id}")
    for entry in data.get("entries") or []:
        entry_id = entry.get("id")
        row = names.get(entry_id)
        serial = serial_title(entry)
        if not clean_text(entry.get("serialTitle")):
            serial = inferred_serial(entry, row)
            if not serial:
                blockers.append(f"cannot infer serial title: {entry_id}")
                continue
            backfilled += 1
        if row is None:
            continue
        if clean_text(row.get("oldTitle")) != serial:
            blockers.append(f"serial title changed since the list was made: {entry_id}")
            continue
        target = row.get("newTitle") or serial
        if clean_text(entry.get("title")) != target:
            changes.append({"id": entry_id, "serialTitle": serial, "from": entry.get("title"), "to": target})
    return {"blockers": blockers, "changes": changes, "backfilled": backfilled}


def apply_book(data: dict[str, Any], names: dict[str, dict[str, Any]]) -> None:
    for entry in data.get("entries") or []:
        row = names.get(entry.get("id"))
        if not clean_text(entry.get("serialTitle")):
            entry["serialTitle"] = inferred_serial(entry, row)
        if row is not None:
            entry["title"] = row.get("newTitle") or entry["serialTitle"]


def run(names_path: Path, apply: bool) -> dict[str, Any]:
    names = load_names(names_path)
    report: dict[str, Any] = {"names": str(names_path), "apply": apply, "books": {}}
    loaded = {}
    for book in BOOKS:
        path = DATA_DIR / f"{book}.json"
        data, compact = load_book(path)
        plan = plan_book(data, names[book])
        loaded[book] = (path, data, compact)
        report["books"][book] = {
            "entries": len(data.get("entries") or []),
            "namesRows": len(names[book]),
            "serialBackfill": plan["backfilled"],
            "titleChanges": len(plan["changes"]),
            "blockers": plan["blockers"],
            "sampleChanges": plan["changes"][:20],
        }
    blocked = any(item["blockers"] for item in report["books"].values())
    report["blocked"] = blocked
    if apply and not blocked:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_dir = OUTPUT_DIR / "backups" / stamp
        suffix = 1
        while backup_dir.exists():
            suffix += 1
            backup_dir = OUTPUT_DIR / "backups" / f"{stamp}-{suffix}"
        backup_dir.mkdir(parents=True, exist_ok=False)
        for book, (path, _, _) in loaded.items():
            shutil.copy2(path, backup_dir / path.name)
        report["backup"] = str(backup_dir)
        for book, (path, data, compact) in loaded.items():
            apply_book(data, names[book])
            temp = path.with_suffix(path.suffix + ".tmp")
            temp.write_text(dump_book(data, compact), encoding="utf-8")
            temp.replace(path)
        # 写完立刻复核一次：再算计划应当一条改动都没有
        for book, (path, _, _) in loaded.items():
            data, _ = load_book(path)
            again = plan_book(data, names[book])
            if again["changes"] or again["blockers"] or again["backfilled"]:
                raise RuntimeError(f"apply is not idempotent for {book}; restore from {backup_dir}")
    report["written"] = bool(apply and not blocked)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="把名单里的名字套用到社区图包词条标题")
    parser.add_argument("--names", type=Path, default=DEFAULT_NAMES)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    report = run(args.names, args.apply)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = OUTPUT_DIR / ("apply-report.json" if args.apply else "plan-report.json")
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for book, item in report["books"].items():
        print(f"{book}: entries={item['entries']} rows={item['namesRows']} "
              f"serialBackfill={item['serialBackfill']} titleChanges={item['titleChanges']} "
              f"blockers={len(item['blockers'])}")
    print(f"blocked={report['blocked']} written={report['written']} report={report_path.relative_to(ROOT).as_posix()}")
    return 1 if report["blocked"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
