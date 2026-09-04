# -*- coding: utf-8 -*-
"""按稳定 entry ID 下架图包词条（权利人要求 / 内容问题），默认预演。

流程与边界见 ``docs/运维/恶意标签元数据应急下线.md``：数据下线先于图片删除，
名单必须是稳定 entry ID，删除前留完整资产清单。本工具只做「数据层下线 + 留档 + 出清单」，
**不碰 R2**（删或改名由维护者按报告里的清单另行执行），也不发布。

用法：
  python tools/takedown_pack_entries.py --entry-id A --entry-id B --reason 作者要求下架
  # 当前 --apply 被门禁锁死；以下步骤仅记录待补齐的执行设计。

设计中的 --apply 会做这些事（都在一个报告目录里留痕）：
  1. 备份改动前的书 JSON 与 codexes.json
  2. 把词条从书里摘掉，重算 entryCount / imagedCount / tree
  3. 同步 codexes.json 的计数
  4. 把展示图与原图**复制**一份进报告目录 assets/（原位文件不删，留给维护者处置）
  5. 从 .r2_sync_manifest.json 去掉这批 key
  6. 写 takedown.json（含 r2KeysPendingDelete 精确清单，供 R2 操作与防回流登记使用）
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "site" / "data"
THUMB_DIR = ROOT / "site" / "images"
ORIGINAL_DIR = ROOT / "originals"
MANIFEST_PATH = ROOT / ".r2_sync_manifest.json"
IMAGE_PREFIX = "images"
ORIGINAL_PREFIX = "originals"

# 现行 runbook 要求先补齐跨文件事务、正式资产隔离与失败回滚，再开放实际写入。
# 在这些门完成并经过闭环测试前，脚本只作为精确名单计划器使用。
APPLY_BLOCKED_REASON = (
    "--apply 尚未开放：跨文件事务、正式资产隔离与失败回滚门禁仍未闭合；"
    "当前只能生成预演计划"
)


def load_json(path: Path):
    return json.loads(path.read_bytes().decode("utf-8"))


def save_json(path: Path, payload) -> None:
    """站内 data JSON 一律 UTF-8 + 2 空格 + CRLF，改动不带无关字节漂移。"""
    blob = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").replace("\n", "\r\n")
    path.write_bytes(blob.encode("utf-8"))


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def decrement_tree(tree, path, amount, issues) -> None:
    """沿分类路径把每层 count 减掉 amount；路径对不上就记问题、不猜。"""
    nodes = tree
    for depth, name in enumerate(path):
        node = next((n for n in nodes if n.get("name") == name), None)
        if node is None:
            issues.append(f"tree 缺少节点 {' / '.join(path[: depth + 1])}")
            return
        node["count"] = int(node.get("count", 0)) - amount
        if node["count"] < 0:
            issues.append(f"tree 节点计数变负: {' / '.join(path[: depth + 1])}")
        nodes = node.get("children") or []


def entry_assets(entry, codex_id):
    """一条词条涉及的展示图 + 原图（含套图成员），返回本地路径与 R2 key。"""
    asset_codex = entry.get("assetCodexId") or codex_id
    seen = set()
    rows = []

    def add(kind, name):
        if not name or (kind, name) in seen:
            return
        seen.add((kind, name))
        if kind == "image":
            local = THUMB_DIR / asset_codex / name
            key = f"{IMAGE_PREFIX}/{asset_codex}/{name}"
        else:
            local = ORIGINAL_DIR / asset_codex / name
            key = f"{ORIGINAL_PREFIX}/{asset_codex}/{name}"
        rows.append({
            "entryId": entry.get("id"),
            "kind": kind,
            "local": local.relative_to(ROOT).as_posix(),
            "absolute": local,
            "r2Key": key,
            "exists": local.is_file(),
        })

    add("image", entry.get("image") or "")
    add("original", entry.get("original") or "")
    for member in entry.get("images") or []:
        add("image", member.get("path") or "")
        add("original", member.get("original") or "")
    return rows


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--book-id", default="nai5_community_pack", help="site/data/<book-id>.json")
    parser.add_argument("--entry-id", action="append", required=True, help="要下架的稳定 entry ID（可重复）")
    parser.add_argument("--reason", required=True, help="下架原因，写进报告")
    parser.add_argument("--apply", action="store_true", help="真正改数据；默认只预演")
    args = parser.parse_args(argv)

    if args.apply:
        print(f"FAIL: {APPLY_BLOCKED_REASON}")
        return 2

    book_path = DATA_DIR / f"{args.book_id}.json"
    if not book_path.is_file():
        print(f"FAIL: missing {book_path}")
        return 2
    book = load_json(book_path)
    entries = book.get("entries") or []
    wanted = list(dict.fromkeys(args.entry_id))

    issues = []
    targets = []
    for eid in wanted:
        hits = [e for e in entries if e.get("id") == eid]
        if len(hits) != 1:
            issues.append(f"entry ID 命中 {len(hits)} 次（必须唯一）: {eid}")
        else:
            targets.append(hits[0])

    assets = []
    for entry in targets:
        assets.extend(entry_assets(entry, book.get("id") or args.book_id))
    for row in assets:
        if not row["exists"]:
            issues.append(f"本地资产缺失: {row['local']}")

    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    report_dir = ROOT / "output" / f"takedown-{stamp}-{args.book_id}"

    lines = [
        f"book: {args.book_id} | entries: {len(entries)}",
        f"reason: {args.reason}",
        f"requested: {len(wanted)} | matched: {len(targets)}",
    ]
    for entry in targets:
        lines.append(
            f"  - {entry.get('id')} | {entry.get('title')} | rating={entry.get('rating')} "
            f"| path={' / '.join(entry.get('path') or [])} | images={len(entry.get('images') or [])}"
        )
    lines.append(f"assets: {len(assets)} (展示图+原图)")
    for row in assets:
        lines.append(f"  - {row['r2Key']}  {'OK' if row['exists'] else 'MISSING'}")
    if issues:
        lines.append("issues:")
        lines.extend(f"  ! {msg}" for msg in issues)

    (ROOT / "output").mkdir(exist_ok=True)

    if not args.apply:
        lines.append("")
        lines.append("plan only; pass --apply to write")
        plan_path = ROOT / "output" / f"takedown-plan-{stamp}-{args.book_id}.txt"
        plan_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"plan written: {plan_path.relative_to(ROOT).as_posix()}")
        print(f"matched {len(targets)}/{len(wanted)} entries, {len(assets)} assets, {len(issues)} issues")
        return 1 if issues else 0

    if issues:
        print(f"FAIL: {len(issues)} issue(s); nothing written.")
        for msg in issues:
            print(f"  ! {msg}")
        return 2

    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / "assets").mkdir(exist_ok=True)
    codexes_path = DATA_DIR / "codexes.json"
    shutil.copy2(book_path, report_dir / f"{args.book_id}.before.json")
    shutil.copy2(codexes_path, report_dir / "codexes.before.json")

    removed_ids = [e.get("id") for e in targets]
    removed_entries = json.loads(json.dumps(targets, ensure_ascii=False))

    tree = book.get("tree") or []
    for entry in targets:
        decrement_tree(tree, list(entry.get("path") or []), 1, issues)
    if issues:
        print("FAIL: tree 对不上，已中止（数据未写）。")
        for msg in issues:
            print(f"  ! {msg}")
        return 2

    book["entries"] = [e for e in entries if e.get("id") not in set(removed_ids)]
    book["entryCount"] = len(book["entries"])
    book["imagedCount"] = sum(1 for e in book["entries"] if e.get("image"))
    save_json(book_path, book)

    codexes = load_json(codexes_path)
    for meta in codexes:
        if meta.get("id") == book.get("id"):
            meta["entryCount"] = book["entryCount"]
            meta["imagedCount"] = book["imagedCount"]
    save_json(codexes_path, codexes)

    asset_rows = []
    for row in assets:
        src = row["absolute"]
        shutil.copy2(src, report_dir / "assets" / src.name)
        asset_rows.append({
            "entryId": row["entryId"],
            "local": row["local"],
            "r2Key": row["r2Key"],
            "bytes": src.stat().st_size,
            "sha256": sha256_of(src),
        })

    dropped = []
    if MANIFEST_PATH.is_file():
        manifest = load_json(MANIFEST_PATH)
        objects = manifest.get("objects") or {}
        for row in asset_rows:
            if row["r2Key"] in objects:
                objects.pop(row["r2Key"])
                dropped.append(row["r2Key"])
        # 一个 key 都没命中就别动这个 13MB 记账文件；写法对齐 sync_r2.write_json
        # （text 模式 → CRLF、无末尾换行），免得下次同步前留下无意义的整文件漂移。
        if dropped:
            manifest["objects"] = objects
            with MANIFEST_PATH.open("w", encoding="utf-8") as handle:
                json.dump(manifest, handle, ensure_ascii=False, indent=2)

    report = {
        "takedownAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "reason": args.reason,
        "codexId": book.get("id"),
        "removedEntryIds": removed_ids,
        "removedEntries": removed_entries,
        "assets": asset_rows,
        "r2KeysPendingDelete": [row["r2Key"] for row in asset_rows],
        "manifestKeysDropped": dropped,
        "counts": {
            "entryCountAfter": book["entryCount"],
            "imagedCountAfter": book["imagedCount"],
        },
    }
    (report_dir / "takedown.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    shutil.copy2(book_path, report_dir / f"{args.book_id}.json")
    shutil.copy2(codexes_path, report_dir / "codexes.json")

    print(f"applied: removed {len(removed_ids)} entries -> entryCount={book['entryCount']}")
    print(f"report: {report_dir.relative_to(ROOT).as_posix()}")
    print("next: register takedown guard -> build_share_index.py -> publish_data_r2.py -> handle R2 objects")
    return 0


if __name__ == "__main__":
    sys.exit(main())
