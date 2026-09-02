"""把「梦神整理社区图包」与「社区AI杂图」合并成「NovelAI v4.5社区精选图包」（2026-08-31）。

形态对齐 v5 图包：顶层放两个来源，各自保留原来的二级结构。

    NovelAI v4.5社区精选图包（6,842 条）
    ├── 梦神 · 社区图包   ← mengshen_pack 原三个来源目录整体降一层
    └── 社区 · AI杂图     ← community_ai_misc 原「常规 / NSFW-限制级别」降一层

**词条 id 一个不改、图一张不搬**：两边的词条都补上 `assetCodexId`（`mengshen_pack` /
`community_ai_misc`），图片继续从原目录取。

⚠ **收藏兼容必须走 `ATLAS_FAVORITE_OWNER_MIGRATIONS`，不能只靠 aliases**：
别名路径在「词条 id 带旧书 id 前缀」时会把 id 前缀一起换掉
（`favorites-backup-core.js` 的 `canonicalizeAtlasFavorite`），而这两本的词条 id 正是
`mengshen_pack-NNNN` / `community_ai_misc-NNNN` 这种形态，换了就找不到词条。
迁移表那条路径原样保留 entryId，所以收藏走迁移表、路由与分享链接走 aliases，两者并存。
本脚本只动数据；迁移表那两条规则是代码改动，见 `favorites-backup-core.js`。

⚠ 梦神那本的 `0001–0258` 早在 2026-07 就迁进了画师串词典（现已并入 v4.5 画师词典），
所以给它的新规则必须从 **0259** 起算，别把老规则盖掉。

决策与取舍见 `docs/decisions/法典重归类.md`。默认只预演；`--apply` 才写盘，写前备份。
**幂等**：已经合并过再跑会直接报「无需合并」并退出 0。
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
IMAGE_ROOT = ROOT / "site" / "images"
BACKUP_ROOT = ROOT / "output" / "edit-backups"
OUTPUT_DIR = ROOT / "output"

TARGET_ID = "nai45_community_pack"
MERGED_TITLE = "NovelAI v4.5社区精选图包"
# (分书 id, 合并后的顶层目录名)；顺序即合并后的排列顺序
SOURCES = (
    ("mengshen_pack", "梦神 · 社区图包"),
    ("community_ai_misc", "社区 · AI杂图"),
)


def read_json(path: Path) -> Any:
    return json.loads(io.open(path, encoding="utf-8").read())


def write_book(path: Path, payload: Any) -> None:
    io.open(path, "w", encoding="utf-8", newline="").write(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    )


def write_index(path: Path, payload: Any) -> None:
    io.open(path, "w", encoding="utf-8", newline="").write(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    )


def prefixed_entries(entries: list[dict], top: str, source_id: str) -> list[dict]:
    out = []
    for entry in entries:
        item = dict(entry)
        item["path"] = [top, *(entry.get("path") or [])]
        # 图仍在原目录，路由必须写死来源身份
        item.setdefault("assetCodexId", source_id)
        out.append(item)
    return out


def merge_contributors(books: list[dict]) -> list[dict]:
    """按署名人归并：同名的角色去掉被别的角色包含的那条，剩下的用 / 连起来。"""
    order: list[str] = []
    roles: dict[str, list[str]] = {}
    for book in books:
        for person in book.get("contributors") or []:
            name = str(person.get("name") or "").strip()
            if not name:
                continue
            if name not in roles:
                roles[name] = []
                order.append(name)
            role = str(person.get("role") or "").strip()
            if role and role not in roles[name]:
                roles[name].append(role)
    out = []
    for name in order:
        kept = [r for r in roles[name] if not any(r != other and r in other for other in roles[name])]
        out.append({"name": name, "role": " / ".join(kept)})
    return out


def join_unique(values: list[str], sep: str = " / ") -> str:
    seen, out = set(), []
    for value in values:
        for part in str(value or "").split(sep):
            part = part.strip()
            if part and part not in seen:
                seen.add(part)
                out.append(part)
    return sep.join(out)


def merge_packs(books: list[dict]) -> dict:
    """按 SOURCES 顺序传入两本分书 → 合并册分书。纯函数，测试直接喂字典。"""
    entries: list[dict] = []
    tree: list[dict] = []
    for (source_id, top), book in zip(SOURCES, books):
        book_entries = prefixed_entries(book.get("entries") or [], top, source_id)
        entries.extend(book_entries)
        tree.append({
            "name": top,
            "count": len(book_entries),
            "children": [dict(node) for node in book.get("tree") or []],
        })
    return {
        "id": TARGET_ID,
        "aliases": [source_id for source_id, _ in SOURCES],
        "type": "pack",
        "title": MERGED_TITLE,
        "version": max(str(book.get("version") or "") for book in books),
        "author": join_unique([book.get("author") for book in books]),
        "entryCount": len(entries),
        "imagedCount": sum(1 for e in entries if e.get("image") or e.get("images")),
        "hasOriginal": all(bool(book.get("hasOriginal")) for book in books),
        "source": join_unique([book.get("source") for book in books]),
        "contributors": merge_contributors(books),
        "tree": tree,
        "entries": entries,
    }


def merge_index(index: list[dict], merged: dict, covers: dict[str, Any]) -> list[dict]:
    """合并册占第一本来源的位次，第二本那行删除。"""
    first_id = SOURCES[0][0]
    rows = {c.get("id"): c for c in index}
    for source_id, _ in SOURCES:
        if source_id not in rows:
            raise RuntimeError(f"codexes.json 里找不到来源行: {source_id}")

    row = dict(rows[first_id])
    row["id"] = TARGET_ID
    for key in ("aliases", "type", "title", "version", "author",
                "entryCount", "imagedCount", "hasOriginal", "source", "contributors"):
        row[key] = merged[key]
    row.update(covers)

    out = []
    for item in index:
        if item.get("id") == first_id:
            out.append(row)
        elif item.get("id") in {sid for sid, _ in SOURCES}:
            continue
        else:
            out.append(item)
    return out


def validate(merged: dict, index: list[dict]) -> list[str]:
    problems = []
    entries = merged["entries"]
    ids = [e["id"] for e in entries]
    if len(ids) != len(set(ids)):
        problems.append("合并后存在重复词条 id")
    if merged["entryCount"] != len(entries):
        problems.append("entryCount 与实际条目数不符")
    tops = {e["path"][0] for e in entries}
    if tops != {top for _, top in SOURCES}:
        problems.append(f"顶层目录异常: {sorted(tops)}")
    for (source_id, top) in SOURCES:
        wrong = [
            e["id"] for e in entries
            if e["path"][0] == top and e.get("assetCodexId") != source_id
        ]
        if wrong:
            problems.append(f"{top} 下有 {len(wrong)} 条 assetCodexId 不是 {source_id}，首个 {wrong[0]}")
        missing_image = [
            e["id"] for e in entries
            if e["path"][0] == top and e.get("image")
            and not (IMAGE_ROOT / source_id / str(e["image"])).is_file()
        ]
        if missing_image:
            problems.append(f"{top} 下有 {len(missing_image)} 条主图找不到文件，首个 {missing_image[0]}")
    if any(len(e.get("path") or []) < 2 for e in entries):
        problems.append("存在没有降层的词条")
    if merged.get("nsfw"):
        problems.append("混合分级图包不得写整本 nsfw，应走条目级 rating")
    row = next((c for c in index if c.get("id") == TARGET_ID), None)
    if not row:
        problems.append("索引里缺合并册")
    elif row.get("entryCount") != merged["entryCount"] or row.get("title") != merged["title"]:
        problems.append("索引行与分书元数据不一致")
    for source_id, _ in SOURCES:
        if any(c.get("id") == source_id for c in index):
            problems.append(f"索引里仍留着来源行: {source_id}")
    return problems


def already_merged(index: list[dict]) -> bool:
    return any(c.get("id") == TARGET_ID for c in index)


def main() -> int:
    parser = argparse.ArgumentParser(description="合并两本 v4.5 社区图包")
    parser.add_argument("--apply", action="store_true", help="真正写盘（默认只预演）")
    args = parser.parse_args()

    index_path = DATA_DIR / "codexes.json"
    index = read_json(index_path)
    if already_merged(index):
        print("已经合并过，无需重跑。")
        return 0

    paths = [DATA_DIR / f"{source_id}.json" for source_id, _ in SOURCES]
    for path in paths:
        if not path.is_file():
            raise RuntimeError(f"缺少来源分书: {path}")
    books = [read_json(path) for path in paths]

    merged = merge_packs(books)
    rows = {c.get("id"): c for c in index}
    first_id = SOURCES[0][0]
    covers = {
        "cover": rows[first_id].get("cover"),
        "coverRev": rows[first_id].get("coverRev"),
        # 封面文件仍在来源目录里，得显式路由
        "coverCodexId": first_id,
    }
    next_index = merge_index(index, merged, covers)
    problems = validate(merged, next_index)

    ratings: dict[str, int] = {}
    for entry in merged["entries"]:
        key = str(entry.get("rating") or "(无)")
        ratings[key] = ratings.get(key, 0) + 1

    report = {
        "merged": {
            "id": merged["id"],
            "title": merged["title"],
            "version": merged["version"],
            "entryCount": merged["entryCount"],
            "imagedCount": merged["imagedCount"],
            "aliases": merged["aliases"],
            "author": merged["author"],
            "contributors": merged["contributors"],
            "tree": [(n["name"], n["count"], [c["name"] for c in n["children"]]) for n in merged["tree"]],
        },
        "before": {source_id: len(book.get("entries") or []) for (source_id, _), book in zip(SOURCES, books)},
        "ratings": ratings,
        "problems": problems,
        "applied": False,
    }

    if problems:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        print("[ERROR] 校验不通过，未写盘。")
        return 1

    if args.apply:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = BACKUP_ROOT / f"{stamp}-merge-nai45-packs"
        backup.mkdir(parents=True, exist_ok=True)
        for path in [*paths, index_path]:
            shutil.copy2(path, backup / path.name)
        for source_id, _ in SOURCES:
            shard = SHARE_DIR / f"{source_id}.json"
            if shard.is_file():
                shutil.copy2(shard, backup / f"share-{source_id}.json")
                shard.unlink()
        write_book(DATA_DIR / f"{TARGET_ID}.json", merged)
        write_index(index_path, next_index)
        for path in paths:
            path.unlink()
        report["applied"] = True
        report["backup"] = str(backup)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = OUTPUT_DIR / "merge_nai45_packs_report.json"
    io.open(report_path, "w", encoding="utf-8", newline="").write(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    )
    print(json.dumps({**report, "report": str(report_path)}, ensure_ascii=False, indent=2))
    if not args.apply:
        print("\n[预演] 以上为计划结果，加 --apply 才写盘。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
