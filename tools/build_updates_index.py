"""重建跨书更新索引 site/data/updates.json。

把每本书 codexes.json 里的 updateFilters（批次）与该书 <id>.json 里词条的
updateBatches / isNew 对上，按批次日期跨书聚合成一条倒序时间线，供顶栏动态气泡
和「公告 / 更新 / 反馈」面板的更新页签读取。

判定规则与前端 site/assets/app/data.js 的 updateFilterDefinitions /
entryMatchesUpdateFilter 逐条对齐——两边算出的条数必须一致，否则页签里的数字
会和进书后的「NEW x.xx更新」筛选对不上。改动其中一侧时必须同步另一侧。

只读 site/data/*.json，只写 site/data/updates.json；不碰图片、不碰 R2。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "site" / "data"
INDEX_PATH = DATA_DIR / "codexes.json"
OUTPUT_PATH = DATA_DIR / "updates.json"
SCHEMA = 1

# 批次 id 就是版本日期串（"2026.8.31"）。排不进时间线的 id（"latest"、"外部源"…）
# 会被跳过并在报告里点名，不静默吞掉。
DATE_ID = re.compile(r"^(\d{4})\.(\d{1,2})\.(\d{1,2})$")


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def clean_label(value: Any) -> str:
    """对齐 data.js 的 cleanUpdateLabel：去空白，去掉开头的「本次」。"""
    return str(value or "").strip().removeprefix("本次")


def update_filter_definitions(meta: dict) -> list[dict]:
    """对齐 data.js 的 updateFilterDefinitions（meta 与 codex 在这里是同一份）。"""
    definitions: list[dict] = []
    seen: set[str] = set()
    raw_filters = meta.get("updateFilters")
    for raw in raw_filters if isinstance(raw_filters, list) else []:
        if not isinstance(raw, dict):
            continue
        fid = str(raw.get("id") or "").strip()
        label = clean_label(raw.get("label"))
        if not fid or not label or fid in seen:
            continue
        seen.add(fid)
        definitions.append({"id": fid, "label": label, "latest": raw.get("latest") is True})
    if not any(item["latest"] for item in definitions) and clean_label(meta.get("newFilterLabel")):
        fid = str(meta.get("version") or "").strip() or "latest"
        if fid not in seen:
            definitions.append({
                "id": fid,
                "label": clean_label(meta.get("newFilterLabel")),
                "latest": True,
            })
    return definitions


def entry_matches(entry: dict, definition: dict) -> bool:
    """对齐 data.js 的 entryMatchesUpdateFilter。"""
    batches = entry.get("updateBatches")
    batches = batches if isinstance(batches, list) else []
    if any(str(value) == definition["id"] for value in batches):
        return True
    return definition["latest"] and entry.get("isNew") is True


def batch_date(batch_id: str) -> date | None:
    matched = DATE_ID.match(batch_id)
    if not matched:
        return None
    year, month, day = (int(part) for part in matched.groups())
    try:
        return date(year, month, day)
    except ValueError:
        return None


def build(data_dir: Path) -> tuple[dict, list[str]]:
    notes: list[str] = []
    codexes = read_json(data_dir / "codexes.json", [])
    if not isinstance(codexes, list):
        raise SystemExit("codexes.json 不是数组，先修数据再重建更新索引")

    grouped: dict[str, dict] = {}
    for meta in codexes:
        if not isinstance(meta, dict):
            continue
        codex_id = str(meta.get("id") or "").strip()
        if not codex_id:
            continue
        definitions = update_filter_definitions(meta)
        if not definitions:
            continue

        book = read_json(data_dir / f"{codex_id}.json")
        entries = book.get("entries") if isinstance(book, dict) else None
        if not isinstance(entries, list):
            notes.append(f"{codex_id}：读不到词条（外部源或缺文件），该书批次跳过")
            continue

        for definition in definitions:
            when = batch_date(definition["id"])
            if when is None:
                notes.append(f"{codex_id}：批次 id「{definition['id']}」不是日期，跳过")
                continue
            count = sum(1 for entry in entries if isinstance(entry, dict) and entry_matches(entry, definition))
            if count <= 0:
                # 与前端 codexUpdateFilters 一致：数不出词条的批次不展示。
                continue
            bucket = grouped.setdefault(definition["id"], {
                "id": definition["id"],
                "date": when.isoformat(),
                "books": [],
            })
            bucket["books"].append({
                "codexId": codex_id,
                "title": str(meta.get("title") or "").strip(),
                "type": str(meta.get("type") or "").strip(),
                "label": definition["label"],
                "latest": definition["latest"],
                "count": count,
            })

    batches = sorted(grouped.values(), key=lambda item: item["date"], reverse=True)
    for batch in batches:
        batch["books"].sort(key=lambda book: (-book["count"], book["codexId"]))
        batch["count"] = sum(book["count"] for book in batch["books"])

    payload = {
        "schema": SCHEMA,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "batches": batches,
    }
    return payload, notes


def main() -> int:
    parser = argparse.ArgumentParser(description="重建跨书更新索引 site/data/updates.json")
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR, help="site/data 目录")
    parser.add_argument("--output", type=Path, default=None, help="输出路径，默认 <data-dir>/updates.json")
    parser.add_argument("--dry-run", action="store_true", help="只打印结果，不写文件")
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help="把中文报告另存为 UTF-8 文件；Windows 控制台是 GBK，AI 与脚本读这个文件而不是 stdout",
    )
    args = parser.parse_args()

    data_dir = args.data_dir
    output = args.output or (data_dir / "updates.json")
    payload, notes = build(data_dir)

    lines = [f"批次 {len(payload['batches'])} 个："]
    for batch in payload["batches"]:
        books = "、".join(f"{book['codexId']} +{book['count']}" for book in batch["books"])
        lines.append(f"  {batch['date']}  共 {batch['count']} 条  {books}")
    lines.extend(f"  ! {note}" for note in notes)

    if args.dry_run:
        lines.append(f"[dry-run] 未写入 {output}")
    else:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        lines.append(f"已写入 {output}")

    report = "\n".join(lines)
    # Windows 控制台是 GBK：中文报告落 UTF-8 文件供调用方读取，stdout 只兜底。
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(report + "\n", encoding="utf-8")
    print(report.encode(getattr(sys.stdout, "encoding", None) or "utf-8", "replace")
          .decode(getattr(sys.stdout, "encoding", None) or "utf-8", "replace"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
