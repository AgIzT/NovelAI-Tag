"""重建跨书更新索引 site/data/updates.json。

把每本书 codexes.json 里的 updateFilters（批次）与该书 <id>.json 里词条的
updateBatches / isNew 对上，按批次日期跨书聚合成一条倒序时间线，供顶栏动态气泡
和「公告 / 更新 / 反馈」面板的更新页签读取。每本书每批另带几张样图（samples），
供法典选择器卷头的「最近新增」扇使用；成人书的样图带解锁标记。

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
# 法典选择器卷头「最近新增」扇用的样图：每本书每个批次最多几张。
SAMPLES_PER_BOOK = 4
# 法典选择器 4 本卷「样张条」：封面之外再并排几张书内样图。
PREVIEWS_PER_BOOK = 3
# 对齐前端 access.js 的 isNsfwRating。
NSFW_RATINGS = {"restricted", "r18", "r18g", "nsfw"}


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
        pinned = raw.get("samples")
        definitions.append({
            "id": fid,
            "label": label,
            "latest": raw.get("latest") is True,
            # 维护者给这一批单独指定的样图（图片文件名）；没写就按默认规则挑
            "pinned": [str(name) for name in pinned if name] if isinstance(pinned, list) else [],
            # 这本书的这一批不进选择器「最近新增」（顶栏更新列表照常列出）
            "pickerHidden": raw.get("pickerHidden") is True,
        })
    if not any(item["latest"] for item in definitions) and clean_label(meta.get("newFilterLabel")):
        fid = str(meta.get("version") or "").strip() or "latest"
        if fid not in seen:
            definitions.append({
                "id": fid,
                "label": clean_label(meta.get("newFilterLabel")),
                "latest": True,
                "pinned": [],
                "pickerHidden": False,
            })
    return definitions


def entry_matches(entry: dict, definition: dict) -> bool:
    """对齐 data.js 的 entryMatchesUpdateFilter。"""
    batches = entry.get("updateBatches")
    batches = batches if isinstance(batches, list) else []
    if any(str(value) == definition["id"] for value in batches):
        return True
    return definition["latest"] and entry.get("isNew") is True


def entry_segments(entry: dict) -> list[str]:
    path = entry.get("path")
    return [str(segment).strip() for segment in (path if isinstance(path, list) else str(path or "").split("/")) if str(segment).strip()]


def entry_rating(entry: dict) -> str:
    return str(entry.get("rating") or entry.get("level") or "").strip().lower()


def is_safe_entry(entry: dict) -> bool:
    """成人档 rating（对齐 access.js）或目录里有名为 NSFW 的一级，都算未解锁访客看不到。"""
    if entry_rating(entry) in NSFW_RATINGS:
        return False
    return not any(segment.lower() == "nsfw" for segment in entry_segments(entry))


def sample_of(entry: dict, nsfw: bool = False) -> dict:
    sample = {"id": str(entry.get("id") or ""), "image": str(entry["image"])}
    for key in ("assetRev", "assetCodexId"):
        if entry.get(key):
            sample[key] = str(entry[key])
    if nsfw:
        sample["nsfw"] = True  # 前端只给已解锁 NSFW 的访客看
    return sample


def pick_auto_samples(meta: dict, entries: list[dict], limit: int, *, exclude_image: str = "") -> list[dict]:
    """更新批次与书内样张共用的默认抽样：按书内顺序均匀取，成人书标记解锁。"""
    nsfw_book = bool(meta.get("nsfw"))
    pool = [
        entry for entry in entries
        if isinstance(entry, dict) and entry.get("image") and str(entry["image"]) != exclude_image
        and (entry_rating(entry) != "r18g" if nsfw_book else is_safe_entry(entry))
    ]
    if not pool:
        return []
    count = min(limit, len(pool))
    step = len(pool) / count
    return [sample_of(pool[int(index * step + step / 2)], nsfw_book) for index in range(count)]


def pick_samples(meta: dict, entries: list[dict], pinned: list[str] = ()) -> tuple[list[dict], list[str]]:
    """给这一批新增挑几张样图。

    默认规则与书内样张一致：按书里的顺序均匀取有图词条，同一批数据每次挑出来都一样；
    整本 NSFW 的书标记解锁，其余书只取能公开的词条。
    这一批在 codexes.json 里写了 samples（图片文件名）就按它来、顺序照写的：维护者可以指定
    成人档的图，这类样图带 nsfw 标记、前端只给已解锁的访客看；R18G 一律不收。
    写的图不在这一批或没图会被跳过并报出来，一张都对不上时退回默认规则。"""
    notes: list[str] = []
    if pinned:
        by_image = {str(entry["image"]): entry for entry in entries if entry.get("image")}
        chosen, missing = [], []
        for name in pinned:
            entry = by_image.get(name)
            if entry is None or entry_rating(entry) == "r18g":
                missing.append(name)
            else:
                chosen.append(entry)
        if missing:
            notes.append(f"指定样图不在这一批、没图或属 R18G：{'、'.join(missing)}")
        if chosen:
            nsfw_book = bool(meta.get("nsfw"))
            return [sample_of(entry, nsfw_book or not is_safe_entry(entry)) for entry in chosen[:SAMPLES_PER_BOOK]], notes
        notes.append("指定样图一张都用不上，改按默认规则挑")
    return pick_auto_samples(meta, entries, SAMPLES_PER_BOOK), notes


def pick_previews(meta: dict, entries: list[dict]) -> tuple[list[dict], list[str]]:
    """法典选择器 4 本卷「样张条」：封面旁边并排的几张书内样图。

    codexes.json 里这本书写了 previews（图片文件名）就照它、顺序照写的；否则在封面之外
    按书里的顺序均匀取几张。整本 NSFW 的书取图都带 nsfw 标记（前端只给已解锁访客看），
    其余书只取能公开的词条；R18G 一律不收。"""
    notes: list[str] = []
    # 外部源的书图片按对方站的相对路径解析，本地词条文件里的图名对不上，不出预览
    if str(meta.get("dataUrl") or "").startswith(("http://", "https://")) or meta.get("assetPathMode") == "relative":
        return [], notes
    nsfw_book = bool(meta.get("nsfw"))
    cover = str(meta.get("cover") or "")
    imaged = [entry for entry in entries if isinstance(entry, dict) and entry.get("image")]
    pinned = meta.get("previews")
    if isinstance(pinned, list) and pinned:
        by_image = {str(entry["image"]): entry for entry in imaged}
        chosen, missing = [], []
        for name in (str(item) for item in pinned if item):
            entry = by_image.get(name)
            if entry is None or entry_rating(entry) == "r18g":
                missing.append(name)
            else:
                chosen.append(entry)
        if missing:
            notes.append(f"指定预览图不在这本书、没图或属 R18G：{'、'.join(missing)}")
        if chosen:
            return [sample_of(entry, nsfw_book or not is_safe_entry(entry)) for entry in chosen[:PREVIEWS_PER_BOOK]], notes
        notes.append("指定预览图一张都用不上，改按默认规则挑")
    return pick_auto_samples(meta, imaged, PREVIEWS_PER_BOOK, exclude_image=cover), notes


def dir_distribution(entries: list[dict], limit: int = 3) -> list[list]:
    """这一批新增落在哪几个目录、各多少条（取前几名）。整批都在同一个一级目录下时往下看一级，
    最多看到第三级——图包常是「来源 › 整理批次 › …」，只报一级等于没说。"""
    paths = [entry_segments(entry) for entry in entries]
    paths = [path for path in paths if path]
    if not paths:
        return []
    depth = 0
    while depth < 2 and all(len(path) > depth + 1 for path in paths) and len({path[depth] for path in paths}) == 1:
        depth += 1
    counts: dict[str, int] = {}
    for path in paths:
        if len(path) > depth:
            counts[path[depth]] = counts.get(path[depth], 0) + 1
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:limit]
    return [[name, count] for name, count in ranked]


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
    previews: dict[str, list[dict]] = {}
    for meta in codexes:
        if not isinstance(meta, dict):
            continue
        codex_id = str(meta.get("id") or "").strip()
        if not codex_id:
            continue
        definitions = update_filter_definitions(meta)

        book = read_json(data_dir / f"{codex_id}.json")
        entries = book.get("entries") if isinstance(book, dict) else None
        if not isinstance(entries, list):
            if definitions:
                notes.append(f"{codex_id}：读不到词条（外部源或缺文件），该书批次跳过")
            continue

        book_previews, preview_notes = pick_previews(meta, entries)
        notes.extend(f"{codex_id} 预览图：{note}" for note in preview_notes)
        if book_previews:
            previews[codex_id] = book_previews

        for definition in definitions:
            when = batch_date(definition["id"])
            if when is None:
                notes.append(f"{codex_id}：批次 id「{definition['id']}」不是日期，跳过")
                continue
            matched = [entry for entry in entries if isinstance(entry, dict) and entry_matches(entry, definition)]
            count = len(matched)
            if count <= 0:
                # 与前端 codexUpdateFilters 一致：数不出词条的批次不展示。
                continue
            samples, sample_notes = pick_samples(meta, matched, definition["pinned"])
            notes.extend(f"{codex_id} {definition['id']}：{note}" for note in sample_notes)
            bucket = grouped.setdefault(definition["id"], {
                "id": definition["id"],
                "date": when.isoformat(),
                "books": [],
            })
            safe = [] if meta.get("nsfw") else [entry for entry in matched if is_safe_entry(entry)]
            record = {
                "codexId": codex_id,
                "title": str(meta.get("title") or "").strip(),
                "type": str(meta.get("type") or "").strip(),
                "label": definition["label"],
                "latest": definition["latest"],
                "count": count,
                # 未解锁 NSFW 的访客能看到的条数：整本 NSFW 的书为 0，其余去掉成人档词条
                "safeCount": len(safe),
                "samples": samples,
                # 这一批没图可看时，选择器改画「新增分布」：全部 / 未解锁访客各一份
                "dirs": dir_distribution(matched),
                "safeDirs": dir_distribution(safe),
            }
            if definition["pickerHidden"]:
                record["pickerHidden"] = True
            bucket["books"].append(record)

    batches = sorted(grouped.values(), key=lambda item: item["date"], reverse=True)
    for batch in batches:
        batch["books"].sort(key=lambda book: (-book["count"], book["codexId"]))
        batch["count"] = sum(book["count"] for book in batch["books"])

    payload = {
        "schema": SCHEMA,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "batches": batches,
        # 法典选择器 4 本卷「样张条」用的书内样图，按书 id 索引；与更新批次无关，只是借这份索引一起发布
        "previews": previews,
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
