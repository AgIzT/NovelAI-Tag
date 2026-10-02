"""生成画师样张索引 site/data/artist_index.json。

灯箱「画师」一栏读这份索引：把提示词里的 artist:xxx 逐个对到画师词典里的单画师样张，
显示缩略图，点开看大图或跳到那条词条。

- 样张只取画师词典里「整条 tags 只有一个 artist:」的词条（画风组词条不算），
  按 v4.5 / v5 两本分开存；同一画师有多条时取书里第一条，另记条数。
- 只收常规分级、有图的词条；画师名的归一与前端 artist-core.js 的 artistKey 一致
  （都建立在 build_tag_zh.bare_tag / tag-zh-core.js bareTag 上）。
- codexModel 按书名里的 v4.5 / N4.5 / v5 / N5 推出各书默认看哪一版样张。

输出不含时间戳，内容不变时文件字节不变。另写 output/artist-index/构建报告.md：
覆盖率，以及各书提示词里出现最多、但词典里还没有单画师样张的画师。

只读 site/data/*.json，只写 site/data/artist_index.json 与 output/artist-index/。
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_tag_zh import bare_tag, split_pieces  # noqa: E402


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "site" / "data"
OUT_FILE = DATA / "artist_index.json"
REPORT_DIR = ROOT / "output" / "artist-index"

SCHEMA = 1
BOOKS = {"n45": "artist_nai45_personal", "n5": "artist_nai5_personal"}
MODEL_PATTERNS = (
    ("n45", re.compile(r"(?:v|n|nai)\s*4\.5", re.IGNORECASE)),
    ("n5", re.compile(r"(?:v|n|nai)\s*5(?![\d.])", re.IGNORECASE)),
)
SAFE_RATINGS = {"", "safe", "general", "sfw"}
REPORT_TOP = 60


ARTIST_PREFIX = re.compile(r"artist\s*:", re.IGNORECASE)
PREFIX_MARK = "artist\x03"


def artist_key(piece: str) -> str:
    """一段 tag 原文 → 归一后的画师名；不是 artist: 前缀返回空串。
    前缀的冒号先换成占位符，免得 artist:382 这种纯数字名被当成 SD 权重剥掉。
    BOM（U+FEFF）在 JS 的 trim 里算空白、Python 的 strip 不算，先去掉以免两边认出的画师不同。"""
    text = bare_tag(ARTIST_PREFIX.sub(PREFIX_MARK, str(piece or "").replace("﻿", ""), count=1))
    return text[len(PREFIX_MARK):].strip() if text.startswith(PREFIX_MARK) else ""


def compact_key(name: str) -> str:
    """去掉全部空白的画师名：提示词里常把「ie (raarami)」写成「ie(raarami)」，精确对不上时用它兜底。"""
    return re.sub(r"\s+", "", name)


def prompt_artists(text: str) -> list[str]:
    seen: list[str] = []
    for piece in split_pieces(text):
        name = artist_key(piece)
        if name and name not in seen:
            seen.append(name)
    return seen


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def codex_model(meta: dict) -> str:
    title = str(meta.get("title") or "")
    for version, pattern in MODEL_PATTERNS:
        if pattern.search(title):
            return version
    return ""


def entry_rating(entry: dict) -> str:
    return str(entry.get("rating") or entry.get("level") or "").strip().lower()


def directory_order(tree) -> dict[tuple, int]:
    """目录树深度优先的先后序号，和站内目录栏从上到下一致。"""
    order: dict[tuple, int] = {}

    def walk(nodes, prefix):
        for node in nodes if isinstance(nodes, list) else []:
            name = node.get("name") if isinstance(node, dict) else None
            if not name:
                continue
            path = prefix + (str(name),)
            order.setdefault(path, len(order))
            walk(node.get("children"), path)

    walk(tree, ())
    return order


def build_samples(book_id: str):
    data = read_json(DATA / f"{book_id}.json")
    paths: dict[tuple, int] = {}
    firsts: dict[str, dict] = {}
    counts: Counter = Counter()
    # 同一画师有多张时按目录栏顺序取第一张（单画师词典在画风组词典前面），同目录内按词条顺序；
    # 不在目录树里的路径排最后。JSON 数组顺序不一定等于目录顺序（后导入的书常追加在末尾）。
    rank = directory_order(data.get("tree"))
    entries = data.get("entries", [])
    ordered = sorted(range(len(entries)), key=lambda i: (rank.get(tuple(entries[i].get("path") or []), len(rank)), i))
    for entry in (entries[i] for i in ordered):
        if entry_rating(entry) not in SAFE_RATINGS or not entry.get("image"):
            continue
        names = prompt_artists(entry.get("tags") or "")
        if len(names) != 1:
            continue
        counts[names[0]] += 1
        firsts.setdefault(names[0], entry)
    samples: dict[str, list] = {}
    for name, entry in firsts.items():
        entry_id = str(entry["id"])
        image = str(entry["image"])
        asset_codex = str(entry.get("assetCodexId") or "")
        path_index = paths.setdefault(tuple(entry.get("path") or []), len(paths))
        # [词条 id, 图片, assetRev, 目录序号, assetCodexId, 条数]；
        # 图片等于「id.jpg」、assetCodexId 等于书 id、条数为 1 时写空值，末尾的空值整段省掉。
        record = [
            entry_id,
            "" if image == f"{entry_id}.jpg" else image,
            str(entry.get("assetRev") or ""),
            path_index,
            "" if asset_codex in ("", book_id) else asset_codex,
            counts[name] if counts[name] > 1 else 0,
        ]
        while record[-1] in ("", 0) and len(record) > 4:
            record.pop()
        samples[name] = record
    return {
        "book": book_id,
        "paths": [list(key) for key in sorted(paths, key=paths.get)],
        "samples": dict(sorted(samples.items())),
    }


def main() -> int:
    codexes = read_json(DATA / "codexes.json")
    versions = {version: build_samples(book) for version, book in BOOKS.items()}
    models = {}
    for meta in codexes:
        model = codex_model(meta)
        if model:
            models[str(meta["id"])] = model
    payload = {"schema": SCHEMA, "versions": versions, "codexModel": dict(sorted(models.items()))}
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=False).encode("utf-8")
    if not OUT_FILE.exists() or OUT_FILE.read_bytes() != body:
        OUT_FILE.write_bytes(body)
    write_report(codexes, versions, len(body))
    print(f"已写 {OUT_FILE.relative_to(ROOT)}（{len(body) / 1024:.0f} KB）")
    return 0


def write_report(codexes: list[dict], versions: dict, size: int) -> None:
    known = {version: set(info["samples"]) for version, info in versions.items()}
    every = set().union(*known.values())
    every_compact = {compact_key(name) for name in every}
    lines = ["# 画师样张索引构建报告", ""]
    lines.append(f"索引 {size / 1024:.0f} KB；" + "，".join(
        f"{versions[v]['book']} 有样张画师 {len(known[v])} 位" for v in versions) + f"；合计 {len(every)} 位，两版都有 {len(known['n45'] & known['n5'])} 位。")
    lines.append("")
    lines.append("## 各书提示词里的画师覆盖")
    lines.append("")
    lines.append("| 书 | 默认版本 | 含画师的词条 | 提到画师（次） | 有样张（次） | 覆盖率 |")
    lines.append("|---|---|---:|---:|---:|---:|")
    missing: dict[str, Counter] = defaultdict(Counter)
    for meta in codexes:
        codex_id = str(meta["id"])
        if codex_id in BOOKS.values():
            continue
        path = DATA / f"{codex_id}.json"
        if not path.exists():
            continue
        entries = read_json(path).get("entries", [])
        model = codex_model(meta)
        with_artists = mentions = covered = 0
        for entry in entries:
            names = prompt_artists(entry.get("tags") or "")
            if not names:
                continue
            with_artists += 1
            for name in names:
                mentions += 1
                if name in every or compact_key(name) in every_compact:
                    covered += 1
                else:
                    missing[name][codex_id] += 1
        if mentions:
            lines.append(f"| {codex_id} | {model or '—'} | {with_artists} | {mentions} | {covered} | {covered / mentions:.0%} |")
    lines.append("")
    lines.append(f"## 还没有单画师样张、提到次数最多的 {REPORT_TOP} 位")
    lines.append("")
    lines.append("| 画师 | 提到次数 | 出现在 |")
    lines.append("|---|---:|---|")
    ranked = sorted(missing.items(), key=lambda item: (-sum(item[1].values()), item[0]))
    for name, per_codex in ranked[:REPORT_TOP]:
        where = "、".join(f"{cid} {n}" for cid, n in per_codex.most_common())
        lines.append(f"| `artist:{name}` | {sum(per_codex.values())} | {where} |")
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    (REPORT_DIR / "构建报告.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
