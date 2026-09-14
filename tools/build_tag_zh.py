"""生成 tag 中文对照分片 site/data/tag_zh/。

灯箱「中文对照」读这些分片，在每个 tag 下方标注中文译名；复制内容不受影响。

译名优先级：人工译名 > 社区词库 > AI 译名。
- 人工译名：tools/data/tag_zh/人工译名.csv（tag,中文,备注），维护者直接改，最高优先级，
  也用来纠正词库在提示词语境里译错的词（如负面里的 text 不是「文字焦点」）。
- 社区词库：Auto-NovelAI-Refactor 的 danbooru_tags_full_zh.csv（GPL-3.0），
  钉在固定提交下载并校验 SHA-256；缓存在 tools/data/tag_zh/，不进仓库。
- AI 译名：tools/data/tag_zh/AI译名.csv（tag,中文,来源,日期），只补前两层都没有的长尾，
  前端会标成「AI 机翻」；AI 结果只进这张表，不回写人工表。

分词与查表键必须和前端 site/assets/app/tag-zh-core.js 的 tagZhKey / splitPromptPieces
逐条一致，否则前端查不到；两边共用 tools/fixtures/tag_zh_keys.json 做防漂移回归。

输出：
- site/data/tag_zh/core.json：全站高频 tag 的译名，外加分片清单 shards；
- site/data/tag_zh/<codexId>.json：只在该书出现、没进 core 的译名；
- output/tag-zh/构建报告.md 与 待翻译.csv（按出现条数降序，供 AI 或人工补译）。
输出不含时间戳，内容不变时文件字节不变，R2 发布不会白传。

只读 site/data/*.json 与 tools/data/tag_zh/，只写 site/data/tag_zh/ 与 output/tag-zh/；
词库缺失时从固定 URL 下载一次。不碰图片、不碰 R2。
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import sys
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "site" / "data"
INDEX_PATH = DATA_DIR / "codexes.json"
OUT_DIR = DATA_DIR / "tag_zh"
SRC_DIR = ROOT / "tools" / "data" / "tag_zh"
DICT_PATH = SRC_DIR / "danbooru_tags_full_zh.csv"
MANUAL_PATH = SRC_DIR / "人工译名.csv"
AI_PATH = SRC_DIR / "AI译名.csv"
REPORT_DIR = ROOT / "output" / "tag-zh"
SCHEMA = 1

DICT_URL = (
    "https://raw.githubusercontent.com/zhulinyv/Auto-NovelAI-Refactor/"
    "7b2aa9d3394ef821c52577f33972ce8922a31512/assets/danbooru_tags_full_zh.csv"
)
DICT_SHA256 = "7ca87ff044f27b6efb49abe39915ca1445a33f095128092ae091cf91cf5097a2"
DICT_SOURCE = {
    "name": "Auto-NovelAI-Refactor 社区中文词库",
    "url": "https://github.com/zhulinyv/Auto-NovelAI-Refactor",
    "license": "GPL-3.0",
}
# Danbooru 分类：1 = 画师。画师名的「译名」多是音译或原样照抄，与 artist: 前缀的 tag 一样不标注。
ARTIST_CATEGORY = "1"

# 进 core 的门槛：在两本及以上的书里出现，或全站出现条数达到这个数。
CORE_MIN_ENTRIES = 3
# 超长的「tag」多半是整段粘进来的碎片，不查也不交给 AI。
MAX_KEY_LENGTH = 300

# ---- 分词与查表键（与 tag-zh-core.js 逐条一致）----

SEPARATOR = re.compile(r"(\r\n|\r|\n|,|，)")
WEIGHT_PREFIX = re.compile(r"^-?\d+(?:\.\d+)?::")
SD_WEIGHT_SUFFIX = re.compile(r":\s*-?\d+(?:\.\d+)?$")
LATIN = re.compile(r"[a-z]", re.IGNORECASE)
SPACES = re.compile(r"\s+")


def tag_key(piece: str) -> str:
    """一段 tag 原文 → 查表键；不值得查的（空、无英文字母、画师前缀、超长）返回空串。"""
    text = str(piece or "").replace("\\(", "\x01").replace("\\)", "\x02")
    for _ in range(12):
        before = text
        text = text.strip()
        text = WEIGHT_PREFIX.sub("", text)
        if text.endswith("::"):
            text = text[:-2]
        text = text.strip('{}[]"')
        while text.startswith("(") and text.count("(") > text.count(")"):
            text = text[1:]
        while text.endswith(")") and text.count(")") > text.count("("):
            text = text[:-1]
        if text.startswith("(") and text.endswith(")"):
            text = text[1:-1]
        text = SD_WEIGHT_SUFFIX.sub("", text)
        if text == before:
            break
    text = text.replace("\x01", "(").replace("\x02", ")")
    key = SPACES.sub(" ", text.replace("_", " ")).strip().lower()
    if not key or not LATIN.search(key) or key.startswith("artist:") or len(key) > MAX_KEY_LENGTH:
        return ""
    return key


MARKUP = re.compile(r"^</?[a-z][^>]*>$")


def ai_eligible(key: str) -> bool:
    """值得交给 AI 的缺译键：排除 <style> 这类标记、漏了逗号粘成一串的碎片和残留权重语法。"""
    if "::" in key or MARKUP.match(key) or len(key) > 200:
        return False
    return " " in key or len(key) <= 40


def split_pieces(text: str) -> list[str]:
    """按逗号 / 全角逗号 / 换行切段，返回每段原文（不含分隔符）。"""
    return [part for part in SEPARATOR.split(str(text or "")) if part and not SEPARATOR.fullmatch(part)]


def artist_name(piece: str) -> str:
    """artist:xxx 形式的画师名（归一后），不是则空串。"""
    text = str(piece or "").strip()
    for _ in range(6):
        before = text
        text = WEIGHT_PREFIX.sub("", text.strip()).strip("{}[]() ")
        if text.endswith("::"):
            text = text[:-2]
        if text == before:
            break
    lower = SPACES.sub(" ", text.replace("_", " ")).strip().lower()
    return lower[len("artist:"):].strip() if lower.startswith("artist:") else ""


# ---- 读取来源 ----


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def read_csv_rows(path: Path) -> list[list[str]]:
    """维护者可能用 Excel 另存，UTF-8（含 BOM）读不了就退回 GBK。"""
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "gbk"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ValueError(f"{path.name} 既不是 UTF-8 也不是 GBK")
    return [row for row in csv.reader(io.StringIO(text)) if row]


def ensure_dictionary(allow_download: bool) -> None:
    if DICT_PATH.exists() and sha256_file(DICT_PATH) == DICT_SHA256:
        return
    if not allow_download:
        raise SystemExit(f"缺少社区词库 {DICT_PATH}（或校验不符），去掉 --no-download 自动下载")
    SRC_DIR.mkdir(parents=True, exist_ok=True)
    print(f"下载社区词库：{DICT_URL}")
    with urllib.request.urlopen(DICT_URL, timeout=120) as resp:
        body = resp.read()
    digest = hashlib.sha256(body).hexdigest()
    if digest != DICT_SHA256:
        raise SystemExit(f"词库校验失败：期望 {DICT_SHA256}，实际 {digest}")
    DICT_PATH.write_bytes(body)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def first_translation(zh: str, key: str) -> str:
    """一格多译只取第一段；括号里的斜杠、逗号不切（「玉藻前（命运/额外）」），
    tag 本身带斜杠时斜杠也不算分隔（fate/zero）。"""
    separators = ",，、;；|｜" if "/" in key else ",，、/;；|｜"
    depth = 0
    for index, ch in enumerate(zh):
        if ch in "(（[［【":
            depth += 1
        elif ch in ")）]］】":
            depth = max(0, depth - 1)
        elif depth == 0 and ch in separators:
            return zh[:index].strip()
    return zh.strip()


def load_dictionary() -> tuple[dict[str, str], set[str]]:
    """返回（键 → 译名，画师键集合）。别名只在不串义时收：别名恰好是正名里的一个词
    （text → text focus）就跳过，那是泛词被登记成了具体 tag 的简称。"""
    main: dict[str, str] = {}
    artists: set[str] = set()
    aliases: dict[str, str] = {}
    with DICT_PATH.open(encoding="utf-8", newline="") as fh:
        for row in csv.reader(fh):
            if len(row) < 5:
                continue
            tag, category, _count, alias_text, zh = row[:5]
            key = SPACES.sub(" ", tag.replace("_", " ")).strip().lower()
            if not key:
                continue
            if category == ARTIST_CATEGORY:
                artists.add(key)
                continue
            translation = first_translation(zh, key) if zh else ""
            if translation and translation != key:
                main.setdefault(key, translation)
            if not translation:
                continue
            words = key.split(" ")
            for alias in alias_text.split(","):
                alias_key = SPACES.sub(" ", alias.replace("_", " ")).strip().lower()
                if not alias_key or alias_key.startswith("/"):
                    continue
                if len(words) > 1 and alias_key in words:
                    continue
                aliases.setdefault(alias_key, translation)
    for alias_key, translation in aliases.items():
        if alias_key not in main and alias_key not in artists:
            main[alias_key] = translation
    return main, artists


def load_table(path: Path) -> dict[str, str]:
    """人工 / AI 表：第一列 tag、第二列中文，首行表头；键按前端同一规则归一。"""
    if not path.exists():
        return {}
    table: dict[str, str] = {}
    for index, row in enumerate(read_csv_rows(path)):
        if index == 0 and row[0].strip().lower() in ("tag", "﻿tag"):
            continue
        if len(row) < 2:
            continue
        key = tag_key(row[0])
        zh = row[1].strip()
        if key and zh:
            table[key] = zh
    return table


# ---- 统计 ----


def prompt_fields(entry: dict) -> list[str]:
    fields = [entry.get("tags"), entry.get("negative")]
    for item in entry.get("characterPrompts") or []:
        if isinstance(item, dict):
            fields += [item.get("prompt"), item.get("negative")]
    return [value for value in fields if isinstance(value, str) and value.strip()]


def collect_usage(index: list[dict]):
    """键 → 出现条数、所属书、示例词条；以及全站 artist: 画师名（不带前缀出现时也不交给 AI）。"""
    entry_count: Counter[str] = Counter()
    codex_sets: dict[str, set[str]] = defaultdict(set)
    example: dict[str, str] = {}
    per_codex: dict[str, Counter[str]] = defaultdict(Counter)
    artist_names: set[str] = set()
    for meta in index:
        cid = str(meta.get("id") or "")
        path = DATA_DIR / f"{cid}.json"
        if not cid or not path.exists():
            continue
        for entry in read_json(path).get("entries", []):
            seen: set[str] = set()
            for field in prompt_fields(entry):
                for piece in split_pieces(field):
                    name = artist_name(piece)
                    if name:
                        artist_names.add(name)
                        continue
                    key = tag_key(piece)
                    if not key or key in seen:
                        continue
                    seen.add(key)
                    entry_count[key] += 1
                    codex_sets[key].add(cid)
                    per_codex[cid][key] += 1
                    example.setdefault(key, str(entry.get("id") or ""))
    return entry_count, codex_sets, example, per_codex, artist_names


# ---- 主流程 ----


def resolve(key, manual, dictionary, ai):
    if key in manual:
        return "m", manual[key]
    if key in dictionary:
        return "d", dictionary[key]
    if key in ai:
        return "a", ai[key]
    return "", ""


def shard_payload(keys, manual, dictionary, ai) -> dict:
    groups = {"m": {}, "d": {}, "a": {}}
    for key in sorted(keys):
        source, zh = resolve(key, manual, dictionary, ai)
        if source:
            groups[source][key] = zh
    return {"schema": SCHEMA, **groups}


def dump(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=False) + "\n").encode("utf-8")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="生成 tag 中文对照分片 site/data/tag_zh/")
    parser.add_argument("--dry-run", action="store_true", help="只统计并写报告，不写 site/data/tag_zh/")
    parser.add_argument("--no-download", action="store_true", help="词库缺失时报错而不是下载")
    args = parser.parse_args(argv)

    index = read_json(INDEX_PATH)
    ensure_dictionary(allow_download=not args.no_download)
    dictionary, dictionary_artists = load_dictionary()
    manual = load_table(MANUAL_PATH)
    ai = load_table(AI_PATH)
    entry_count, codex_sets, example, per_codex, artist_names = collect_usage(index)
    skip_artist = artist_names | dictionary_artists

    all_keys = [key for key in entry_count if key not in skip_artist]
    core_keys = {key for key in all_keys if len(codex_sets[key]) >= 2 or entry_count[key] >= CORE_MIN_ENTRIES}
    shards: dict[str, set[str]] = {}
    for cid, keys in per_codex.items():
        rest = {key for key in keys if key not in core_keys and key not in skip_artist}
        if any(resolve(key, manual, dictionary, ai)[0] for key in rest):
            shards[cid] = rest

    payloads = {"core.json": {**shard_payload(core_keys, manual, dictionary, ai),
                              "source": DICT_SOURCE, "shards": sorted(shards)}}
    for cid, keys in sorted(shards.items()):
        payloads[f"{cid}.json"] = shard_payload(keys, manual, dictionary, ai)

    if not args.dry_run:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        for name, payload in payloads.items():
            target = OUT_DIR / name
            body = dump(payload)
            if not target.exists() or target.read_bytes() != body:
                target.write_bytes(body)
        # 只清理本工具自己产出的旧分片（书被删或改名后留下的）
        for stale in OUT_DIR.glob("*.json"):
            if stale.name not in payloads:
                stale.unlink()

    write_report(index, entry_count, codex_sets, example, per_codex, skip_artist,
                 manual, dictionary, ai, payloads, dry_run=args.dry_run)
    return 0


def write_report(index, entry_count, codex_sets, example, per_codex, skip_artist,
                 manual, dictionary, ai, payloads, dry_run: bool) -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    keys = [key for key in entry_count if key not in skip_artist]
    total = sum(entry_count[key] for key in keys)
    by_source = Counter()
    occ_by_source = Counter()
    missing = []
    for key in keys:
        source, _ = resolve(key, manual, dictionary, ai)
        by_source[source or "none"] += 1
        occ_by_source[source or "none"] += entry_count[key]
        if not source and ai_eligible(key):
            missing.append(key)
    missing.sort(key=lambda key: (-entry_count[key], key))

    titles = {str(meta.get("id")): str(meta.get("title") or meta.get("id")) for meta in index}
    lines = [
        "# tag 中文对照构建报告",
        "",
        f"- 模式：{'预演（未写 site/data/tag_zh/）' if dry_run else '已写入 site/data/tag_zh/'}",
        f"- 参与统计的 tag（去重，已排除画师名）：{len(keys)}；按词条去重后的出现次数：{total}",
        f"- 人工译名表 {len(manual)} 条，AI 译名表 {len(ai)} 条，社区词库可用键 {len(dictionary)} 个",
        "",
        "| 来源 | 去重 tag 数 | 出现次数占比 |",
        "|---|---|---|",
    ]
    names = {"m": "人工译名", "d": "社区词库", "a": "AI 译名", "none": "暂无译名"}
    for source in ("m", "d", "a", "none"):
        share = occ_by_source[source] / total if total else 0
        lines.append(f"| {names[source]} | {by_source[source]} | {share:.1%} |")
    lines += ["", "## 分片", "", "| 文件 | 译名条数 | 大小 |", "|---|---|---|"]
    for name, payload in payloads.items():
        count = sum(len(payload[group]) for group in ("m", "d", "a"))
        lines.append(f"| {name} | {count} | {len(dump(payload)) / 1024:.0f} KB |")
    lines += ["", "## 各书覆盖（按出现次数）", "", "| 书 | 去重 tag | 有译名占比 |", "|---|---|---|"]
    for meta in index:
        cid = str(meta.get("id") or "")
        book = per_codex.get(cid, Counter())
        book_keys = [key for key in book if key not in skip_artist]
        if not book_keys:
            continue
        occ = sum(book[key] for key in book_keys)
        hit = sum(book[key] for key in book_keys if resolve(key, manual, dictionary, ai)[0])
        lines.append(f"| {titles.get(cid, cid)} | {len(book_keys)} | {hit / occ:.1%} |")
    lines += ["", f"## 待翻译（共 {len(missing)} 个，完整清单见 待翻译.csv）", ""]
    for key in missing[:40]:
        lines.append(f"- {entry_count[key]} 条 · {key}")
    (REPORT_DIR / "构建报告.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    with (REPORT_DIR / "待翻译.csv").open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["tag", "出现条数", "涉及法典", "示例词条"])
        for key in missing:
            writer.writerow([key, entry_count[key], "|".join(sorted(codex_sets[key])), example.get(key, "")])
    print(f"已写报告：{REPORT_DIR / '构建报告.md'}")


if __name__ == "__main__":
    sys.exit(main())
