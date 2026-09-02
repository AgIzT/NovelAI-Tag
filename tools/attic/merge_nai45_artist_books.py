"""把 NovelAI v4.5 的单画师词典与画师串词典合并成一册（2026-08-31）。

目标形态对齐 v5 那本：同一册里两个顶层目录。

    NovelAI v4.5画师词典
    ├── 单画师词典   ← artist_nai45_personal 原有三个顶层目录整体降一层
    └── 画师串词典   ← artist_nai45_strings 原有两个顶层目录整体降一层

不动的东西（这也是这次合并便宜的原因）：

* **词条 id 一个都不改**，`images/` 与 `originals/` 一张都不搬。
  画师串那 876 条 W.O.F 原本没有 `assetCodexId`、靠书 id 找图，合并进来后会被
  解析到 `images/artist_nai45_personal/`，所以脚本给它们补上
  `assetCodexId: artist_nai45_strings` 把路由钉回原目录；梦神那 258 条本来就挂着
  `mengshen_pack`，原样保留。
* 收藏与分享深链靠书级 `aliases` 归一，脚本会把 `artist_nai45_strings` 写进
  合并册的 aliases。`ATLAS_FAVORITE_OWNER_MIGRATIONS` 里那条
  `mengshen_pack-0001..0258 → artist_nai45_strings` 不用改：它的 target 是经
  `byAnyId`（含 aliases）查的，会自动落到合并册。

决策与取舍见 `docs/decisions/法典重归类.md`。默认只预演；`--apply` 才写盘，
写前把两本分书与 `codexes.json` 备份到 `output/edit-backups/`。**幂等**：
已经合并过再跑会直接报「无需合并」并退出 0。
"""

from __future__ import annotations

import argparse
import io
import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]  # tools/attic/ 比 tools/ 深一层
DATA_DIR = ROOT / "site" / "data"
SHARE_DIR = DATA_DIR / "share"
BACKUP_ROOT = ROOT / "output" / "edit-backups"
OUTPUT_DIR = ROOT / "output"

TARGET_ID = "artist_nai45_personal"
SOURCE_ID = "artist_nai45_strings"
TOP_PERSONAL = "单画师词典"
TOP_STRINGS = "画师串词典"
MERGED_TITLE = "NovelAI v4.5画师词典"


def read_json(path: Path) -> Any:
    return json.loads(io.open(path, encoding="utf-8").read())


def write_book(path: Path, payload: Any) -> None:
    """分书是紧凑 JSON、结尾无换行——保持与现有文件同一形态，别让 diff 变成整文件。"""
    io.open(path, "w", encoding="utf-8", newline="").write(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    )


def write_index(path: Path, payload: Any) -> None:
    io.open(path, "w", encoding="utf-8", newline="").write(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    )


def prefixed_entries(entries: list[dict], top: str, asset_fallback: str | None) -> list[dict]:
    """把一本书的词条整体降一层；需要时补 assetCodexId 把图片路由钉回原书目录。"""
    out = []
    for entry in entries:
        item = dict(entry)
        item["path"] = [top, *(entry.get("path") or [])]
        if asset_fallback and not item.get("assetCodexId"):
            item["assetCodexId"] = asset_fallback
        out.append(item)
    return out


def merge_tree(personal: dict, strings: dict) -> list[dict]:
    return [
        {
            "name": TOP_PERSONAL,
            "count": len(personal.get("entries") or []),
            "children": [dict(node) for node in personal.get("tree") or []],
        },
        {
            "name": TOP_STRINGS,
            "count": len(strings.get("entries") or []),
            "children": [dict(node) for node in strings.get("tree") or []],
        },
    ]


def join_unique(*values: str, sep: str = " / ") -> str:
    seen, out = set(), []
    for value in values:
        for part in str(value or "").split(sep):
            part = part.strip()
            if part and part not in seen:
                seen.add(part)
                out.append(part)
    return sep.join(out)


def merge_books(personal: dict, strings: dict) -> dict:
    """两本分书 → 合并册分书。纯函数，测试直接喂字典。"""
    entries = (
        prefixed_entries(personal.get("entries") or [], TOP_PERSONAL, None)
        + prefixed_entries(strings.get("entries") or [], TOP_STRINGS, SOURCE_ID)
    )
    aliases = [*(personal.get("aliases") or [])]
    if SOURCE_ID not in aliases:
        aliases.append(SOURCE_ID)
    imaged = sum(1 for e in entries if e.get("image") or e.get("images"))
    return {
        "id": TARGET_ID,
        "aliases": aliases,
        "type": personal.get("type") or "string",
        "title": MERGED_TITLE,
        # 版本取两本里较新的一份：合并不产生新内容，别凭空造版本号
        "version": max(str(personal.get("version") or ""), str(strings.get("version") or "")),
        "author": join_unique(personal.get("author"), strings.get("author")),
        "entryCount": len(entries),
        "imagedCount": imaged,
        "hasOriginal": bool(personal.get("hasOriginal") or strings.get("hasOriginal")),
        "source": join_unique(personal.get("source"), strings.get("source")),
        "contributors": [*(personal.get("contributors") or []), *(strings.get("contributors") or [])],
        "tree": merge_tree(personal, strings),
        "entries": entries,
    }


def merge_index(index: list[dict], merged: dict) -> list[dict]:
    """索引里合并册占原单画师词典的位次，画师串那行删除；书级更新筛选跟着搬过来。"""
    personal_row = next((c for c in index if c.get("id") == TARGET_ID), None)
    strings_row = next((c for c in index if c.get("id") == SOURCE_ID), None)
    if not personal_row or not strings_row:
        raise RuntimeError("codexes.json 里找不到待合并的两行")

    row = dict(personal_row)
    for key in ("aliases", "title", "version", "author", "entryCount", "imagedCount", "source", "contributors"):
        row[key] = merged[key]
    # 「本次更新」是书级筛选，合并后按整本算（维护者 2026-08-31 裁定）
    for key in ("newFilterLabel", "updateFilters"):
        if strings_row.get(key) is not None:
            row[key] = strings_row[key]

    out = []
    for item in index:
        if item.get("id") == SOURCE_ID:
            continue
        out.append(row if item.get("id") == TARGET_ID else item)
    return out


def validate(merged: dict, index: list[dict]) -> list[str]:
    problems = []
    entries = merged["entries"]
    ids = [e["id"] for e in entries]
    if len(ids) != len(set(ids)):
        problems.append("合并后存在重复词条 id")
    if merged["entryCount"] != len(entries):
        problems.append("entryCount 与实际条目数不符")
    tops = {tuple(e["path"])[0] for e in entries}
    if tops != {TOP_PERSONAL, TOP_STRINGS}:
        problems.append(f"顶层目录异常: {sorted(tops)}")
    if any(len(e.get("path") or []) < 2 for e in entries):
        problems.append("存在没有降层的词条")
    for entry in entries:
        if entry["path"][0] != TOP_STRINGS:
            continue
        if not entry.get("assetCodexId"):
            problems.append(f"画师串词条缺 assetCodexId: {entry['id']}")
            break
    row = next((c for c in index if c.get("id") == TARGET_ID), None)
    if not row:
        problems.append("索引里缺合并册")
    elif row.get("entryCount") != merged["entryCount"] or row.get("title") != merged["title"]:
        problems.append("索引行与分书元数据不一致")
    if any(c.get("id") == SOURCE_ID for c in index):
        problems.append("索引里仍留着画师串那一行")
    return problems


def already_merged(index: list[dict], strings_path: Path) -> bool:
    row = next((c for c in index if c.get("id") == TARGET_ID), None)
    merged_row = bool(row and SOURCE_ID in (row.get("aliases") or []))
    return merged_row and not strings_path.is_file()


def main() -> int:
    parser = argparse.ArgumentParser(description="合并 v4.5 单画师词典与画师串词典")
    parser.add_argument("--apply", action="store_true", help="真正写盘（默认只预演）")
    args = parser.parse_args()

    personal_path = DATA_DIR / f"{TARGET_ID}.json"
    strings_path = DATA_DIR / f"{SOURCE_ID}.json"
    index_path = DATA_DIR / "codexes.json"
    index = read_json(index_path)

    if already_merged(index, strings_path):
        print("已经合并过，无需重跑。")
        return 0
    if not strings_path.is_file():
        raise RuntimeError(f"缺少来源分书: {strings_path}")

    personal = read_json(personal_path)
    strings = read_json(strings_path)
    merged = merge_books(personal, strings)
    next_index = merge_index(index, merged)
    problems = validate(merged, next_index)

    report = {
        "merged": {
            "id": merged["id"],
            "title": merged["title"],
            "version": merged["version"],
            "entryCount": merged["entryCount"],
            "imagedCount": merged["imagedCount"],
            "aliases": merged["aliases"],
            "tree": [(n["name"], n["count"], len(n["children"])) for n in merged["tree"]],
        },
        "before": {
            TARGET_ID: len(personal.get("entries") or []),
            SOURCE_ID: len(strings.get("entries") or []),
        },
        "assetCodexIdBackfilled": sum(
            1 for e in merged["entries"]
            if e["path"][0] == TOP_STRINGS and e.get("assetCodexId") == SOURCE_ID
        ),
        "problems": problems,
        "applied": False,
    }

    if problems:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        print("[ERROR] 校验不通过，未写盘。")
        return 1

    if args.apply:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = BACKUP_ROOT / f"{stamp}-merge-nai45-artist"
        backup.mkdir(parents=True, exist_ok=True)
        for path in (personal_path, strings_path, index_path):
            shutil.copy2(path, backup / path.name)
        share_shard = SHARE_DIR / f"{SOURCE_ID}.json"
        if share_shard.is_file():
            shutil.copy2(share_shard, backup / f"share-{SOURCE_ID}.json")
            share_shard.unlink()
        write_book(personal_path, merged)
        write_index(index_path, next_index)
        strings_path.unlink()
        report["applied"] = True
        report["backup"] = str(backup)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = OUTPUT_DIR / "merge_nai45_artist_report.json"
    io.open(report_path, "w", encoding="utf-8", newline="").write(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    )
    print(json.dumps({**report, "report": str(report_path)}, ensure_ascii=False, indent=2))
    if not args.apply:
        print("\n[预演] 以上为计划结果，加 --apply 才写盘。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
