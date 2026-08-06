# -*- coding: utf-8 -*-
"""把所长两本法典 tags 里内联的 `char1：xxx` 角色词拆进结构化 characterPrompts。

来源 docx 把 NovelAI V4 的角色提示词直接写成正面 tag 块里的独立行
（`\\nchar1：girl,...`），站内因此把它们当普通 tag 一起复制出去——SD 用户
粘贴后会多出 `char1：girl` 这种垃圾词。图包类法典早就用 `characterPrompts`
结构化存放（见 docs/经验/统一图包类导入规范.md），前端渲染/复制/搜索也已
支持，所以这里只做数据侧的归位，不改前端契约。

**可重复运行**：只认行首的 `char\\d*[:：]` 标记；跑完一次后再跑是 0 改动。
所长法典每次从新 Word 重转/合并之后都应该再跑一次（见
docs/经验/Word法典增量更新.md「角色词拆分」一节）。

    python tools\\migrate_suozhang_char_prompts.py            # 预演，只出报告
    python tools\\migrate_suozhang_char_prompts.py --apply    # 写盘（先自动备份）
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import time
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "site" / "data"
OUTPUT_DIR = ROOT / "output" / "suozhang-char-prompts"
DEFAULT_CODEX_IDS = ("suozhang", "suozhang_r18")

# 只认「独占一行开头」的角色词标记：行中间出现的 char1： 是原文噪声（错字 / 重复粘贴），
# 拆了会把作者写的正文切碎，一律留在原地并进报告交人工看。
CHAR_LINE_RE = re.compile(r"^[ \t]*(char[ \t]*\d*)[ \t]*[:：][ \t]*", re.IGNORECASE | re.MULTILINE)
CHAR_ANY_RE = re.compile(r"char[ \t]*\d*[ \t]*[:：]", re.IGNORECASE)

# 2026-08-06 逐条人工核对的变体覆盖表。作者在 15 条里用了别的写法，通用规则一律不猜，
# 只在这里按「行号 → 角色」显式声明；其余两条判定为「不该拆」，见文件末的 NOT_SPLIT 说明。
# plan 每项 = (角色, 标签, 该行开头要吃掉的标记正则)；标记为 None 表示这一行没有标记。
# 只有原文行数与 plan 等长、且每个标记都能对上时才动它；对不上就进 blockers 等人工，
# 绝不会按猜测改写。若哪天源 Word 改了写法，这里会主动报错而不是悄悄错拆。
VARIANT_FIXES: dict[str, dict[str, Any]] = {
    # ── 标记写错 / 写法不同，但角色归属明确 ──────────────────────────────
    "codex_6e699406-0879": {  # 三人颜射：char2-4 是范围写法，作者让这三个角色共用一段
        "why": "char2-4：范围标签",
        "plan": [("tags", "", None), ("prompt", "char1", r"char1[ \t]*[:：]"),
                 ("prompt", "char2-4", r"char2[ \t]*-[ \t]*4[ \t]*[:：]")],
    },
    "codex_6e699406-0901": {  # 面对面拥抱素股：cher2 是 char2 的错字，标签归一
        "why": "cher2：错字",
        "plan": [("tags", "", None), ("prompt", "char1", r"char1[ \t]*[:：]"),
                 ("prompt", "char2", r"cher2[ \t]*[:：]")],
    },
    "codex_6e699406-2624": {  # 其他版本1：char2 后面漏了冒号，直接连着 boy
        "why": "char2boy 漏冒号",
        "plan": [("tags", "", None), ("prompt", "char1", r"char1[ \t]*[:：]"),
                 ("prompt", "char2", r"char2(?=[A-Za-z])")],
    },
    "codex_6e699406-1629": {  # 带子购买避孕套：整条用 c1/c2/c3 缩写
        "why": "c1/c2/c3 缩写",
        "plan": [("tags", "", None), ("prompt", "char1", r"c1[ \t]*[:：]"),
                 ("prompt", "char2", r"c2[ \t]*[:：]"), ("prompt", "char3", r"c3[ \t]*[:：]")],
    },
    "codex_6e699406-4504": {  # 用内裤自慰被发现：同上
        "why": "c1/c2 缩写",
        "plan": [("tags", "", None), ("prompt", "char1", r"c1[ \t]*[:：]"),
                 ("prompt", "char2", r"c2[ \t]*[:：]")],
    },
    "codex_6e699406-5081": {  # 母女盖饭：整条用中文「角色N」
        "why": "角色1/2/3 中文标签",
        "plan": [("tags", "", None), ("prompt", "char1", r"角色1[ \t]*[:：]"),
                 ("prompt", "char2", r"角色2[ \t]*[:：]"), ("prompt", "char3", r"角色3[ \t]*[:：]")],
    },
    # ── character N prompt/uc 全写法：uc = undesired content，进 negative ──
    "codex_6e699406-1556": {
        "why": "character N prompt/uc 全写法",
        "plan": [("tags", "", None),
                 ("prompt", "char1", r"character[ \t]*1[ \t]*prompt[ \t]*[:：]"),
                 ("negative", "char1", r"character[ \t]*1[ \t]*uc[ \t]*[:：]"),
                 ("prompt", "char2", r"character[ \t]*2[ \t]*prompt[ \t]*[:：]"),
                 ("negative", "char2", r"character[ \t]*2[ \t]*uc[ \t]*[:：]")],
    },
    "codex_6e699406-1560": {
        "why": "character N prompt/uc 全写法",
        "plan": [("tags", "", None),
                 ("prompt", "char1", r"character[ \t]*1[ \t]*prompt[ \t]*[:：]"),
                 ("negative", "char1", r"character[ \t]*1[ \t]*uc[ \t]*[:：]"),
                 ("prompt", "char2", r"character[ \t]*2[ \t]*prompt[ \t]*[:：]"),
                 ("negative", "char2", r"character[ \t]*2[ \t]*uc[ \t]*[:：]")],
    },
    "codex_6e699406-1680": {
        "why": "character N prompt/uc 全写法",
        "plan": [("tags", "", None),
                 ("prompt", "char1", r"character[ \t]*1[ \t]*prompt[ \t]*[:：]"),
                 ("negative", "char1", r"character[ \t]*1[ \t]*uc[ \t]*[:：]"),
                 ("prompt", "char2", r"character[ \t]*2[ \t]*prompt[ \t]*[:：]"),
                 ("negative", "char2", r"character[ \t]*2[ \t]*uc[ \t]*[:：]")],
    },
    "codex_8489ac52-1501": {
        "why": "character N prompt/uc 全写法",
        "plan": [("tags", "", None),
                 ("prompt", "char1", r"character[ \t]*1[ \t]*prompt[ \t]*[:：]"),
                 ("negative", "char1", r"character[ \t]*1[ \t]*uc[ \t]*[:：]"),
                 ("prompt", "char2", r"character[ \t]*2[ \t]*prompt[ \t]*[:：]"),
                 ("negative", "char2", r"character[ \t]*2[ \t]*uc[ \t]*[:：]")],
    },
    # ── 只有 uc 带标记、角色正面段完全没标记：按「uc 行紧跟其角色」推断 ──
    "codex_6e699406-0144": {  # L0 场景；L1 girl 女帝；L2 char1 uc；L3 black man
        "why": "只有 character 1uc 带标记，正面段靠 uc 位置推断",
        "plan": [("tags", "", None), ("prompt", "char1", None),
                 ("negative", "char1", r"character[ \t]*1[ \t]*uc[ \t]*[:：]"),
                 ("prompt", "char2", None)],
    },
    "codex_6e699406-1535": {  # L0 写明 1girl,2boys；L1 女高管 / L3 保安 / L5 路过男
        "why": "1girl,2boys 三角色，只有两条 uc 带标记",
        "plan": [("tags", "", None), ("prompt", "char1", None),
                 ("negative", "char1", r"character[ \t]*1[ \t]*uc[ \t]*[:：]"),
                 ("prompt", "char2", None),
                 ("negative", "char2", r"character[ \t]*2[ \t]*uc[ \t]*[:：]"),
                 ("prompt", "char3", None)],
    },
    # ── 标记被打到行中间 ──────────────────────────────────────────────
    "codex_6e699406-1579": {  # L0 写明 2girls,1boy；L3 是门口偷看的第二个女生，
                              # 作者把 char3： 误打进了 "in front of image" 中间
        "why": "char3 标记误插到行中间",
        "plan": [("tags", "", None), ("prompt", "char1", r"char1[ \t]*[:：]"),
                 ("prompt", "char2", r"char2[ \t]*[:：]"), ("prompt", "char3", None)],
        "inline_subs": {3: [("in char3：front of image", "in front of image")]},
    },
}

# 逐条核对后判定「不该拆」的（只记录，工具不动它们）：
#   codex_8489ac52-4537 / -4538「玩弄到脱力」「100分奖励预约」：char2 段内的
#   `short char2：boy,` 是重复粘贴的噪声，后面接的仍是同一个 boy 的外观描述；
#   内容归属明确、也没污染正面串，清理它属于改作者原文，留给维护者在源稿层面决定。


def clean_text(value: Any) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n")


def squeeze(value: str) -> str:
    return re.sub(r"\s+", "", value)


def split_inline_char_prompts(tags: Any) -> dict[str, Any]:
    """拆分一条 tags；返回正面段、角色词列表和两类异常。

    正面段只做 rstrip：作者原文的结尾逗号照抄不动（本站定位是忠实复刻法典）。
    """
    text = clean_text(tags)
    matches = list(CHAR_LINE_RE.finditer(text))
    result: dict[str, Any] = {
        "positive": text,
        "prompts": [],
        "emptySegments": [],
        "midlineMarkers": [],
        "lossless": True,
    }
    if not matches:
        result["midlineMarkers"] = [m.group(0) for m in CHAR_ANY_RE.finditer(text)]
        return result

    prompts: list[dict[str, str]] = []
    empty: list[str] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        label = re.sub(r"[ \t]+", "", match.group(1)).lower()
        body = text[match.end():end].strip()
        if not body:
            empty.append(label)
            continue
        prompts.append({"label": label, "prompt": body})

    result["positive"] = text[:matches[0].start()].rstrip()
    result["prompts"] = prompts
    result["emptySegments"] = empty

    # 无损校验：除了被吃掉的标记本身，一个字符都不许丢。
    kept = []
    cursor = 0
    for match in matches:
        kept.append(text[cursor:match.start()])
        cursor = match.end()
    kept.append(text[cursor:])
    expected = squeeze("".join(kept))
    actual = squeeze(result["positive"] + "".join(item["prompt"] for item in prompts))
    result["lossless"] = expected == actual

    body_text = result["positive"] + "\n" + "\n".join(item["prompt"] for item in prompts)
    result["midlineMarkers"] = [m.group(0) for m in CHAR_ANY_RE.finditer(body_text)]
    return result


def apply_variant_fix(fix: dict[str, Any], tags: Any) -> dict[str, Any] | None:
    """按覆盖表逐行拆一条变体；行数或标记对不上就返回 None（交给上层报人工）。"""
    text = clean_text(tags)
    lines = text.split("\n")
    plan = fix["plan"]
    if len(lines) != len(plan):
        return None

    positive_parts: list[str] = []
    boxes: dict[str, dict[str, str]] = {}
    order: list[str] = []
    for index, (line, (role, label, marker)) in enumerate(zip(lines, plan)):
        body = line
        if marker:
            match = re.match(r"[ \t]*(?:%s)[ \t]*" % marker, body, re.IGNORECASE)
            if not match:
                return None
            body = body[match.end():]
        for old, new in fix.get("inline_subs", {}).get(index, []):
            if old not in body:
                return None
            body = body.replace(old, new)
        body = body.strip()
        if role == "tags":
            positive_parts.append(body)
            continue
        if label not in boxes:
            boxes[label] = {"label": label, "prompt": ""}
            order.append(label)
        if role == "prompt":
            boxes[label]["prompt"] = body
        else:
            boxes[label]["negative"] = body

    prompts = [boxes[label] for label in order if boxes[label].get("prompt") or boxes[label].get("negative")]
    if not prompts:
        return None
    return {"positive": "\n".join(part for part in positive_parts if part).rstrip(), "prompts": prompts}


def put_character_prompts(entry: dict[str, Any], positive: str, prompts: list[dict[str, str]]) -> dict[str, Any]:
    """重建 entry，保持字段顺序：characterPrompts 紧跟在 tags 后面。"""
    out: dict[str, Any] = {}
    for key, value in entry.items():
        if key == "characterPrompts":
            continue
        out[key] = positive if key == "tags" else value
        if key == "tags":
            out["characterPrompts"] = prompts
    if "characterPrompts" not in out:
        out["characterPrompts"] = prompts
    return out


def process_codex(codex_id: str, apply: bool, sample_limit: int, stamp: str = "") -> dict[str, Any]:
    data_path = DATA_DIR / f"{codex_id}.json"
    raw = data_path.read_text(encoding="utf-8")
    data = json.loads(raw)
    # 这两本 JSON 是 json.dumps(..., ensure_ascii=False) 的默认排版；先证明能原样回写，
    # 免得一次迁移顺手把 7MB 文件整体重排、diff 和 R2 release 全变噪声。
    if json.dumps(data, ensure_ascii=False) != raw:
        raise RuntimeError(f"{codex_id}: 现有 JSON 排版与默认序列化不一致，拒绝写盘")

    entries = data.get("entries") if isinstance(data.get("entries"), list) else []
    stats: Counter[str] = Counter()
    labels: Counter[str] = Counter()
    blockers: list[dict[str, str]] = []
    midline: list[dict[str, str]] = []
    empty_positive: list[str] = []
    samples: list[dict[str, Any]] = []
    updated: list[dict[str, Any]] = []

    for original in entries:
        entry = dict(original)
        entry_id = str(entry.get("id") or "")
        existing = entry.get("characterPrompts") or []

        fix = VARIANT_FIXES.get(entry_id)
        if fix:
            built = apply_variant_fix(fix, entry.get("tags"))
            if built is None:
                # 已经拆过（跑第二遍）是正常的；既没拆过又对不上表才是漂移，要人工看。
                if not existing:
                    blockers.append({"id": entry_id, "reason": "变体覆盖表与当前文本对不上", "detail": fix["why"]})
                updated.append(entry)
                continue
            stats["variantFixed"] += 1
            stats["changedEntries"] += 1
            stats["characterPromptBoxes"] += len(built["prompts"])
            for item in built["prompts"]:
                labels[item["label"]] += 1
            if len(samples) < sample_limit:
                samples.append({
                    "id": entry_id,
                    "title": str(entry.get("title") or ""),
                    "variant": fix["why"],
                    "before": clean_text(entry.get("tags")),
                    "afterTags": built["positive"],
                    "afterCharacterPrompts": built["prompts"],
                })
            updated.append(put_character_prompts(entry, built["positive"], built["prompts"]))
            continue

        split = split_inline_char_prompts(entry.get("tags"))

        if split["midlineMarkers"]:
            midline.append({
                "id": entry_id,
                "title": str(entry.get("title") or ""),
                "markers": " ".join(split["midlineMarkers"]),
            })

        if not split["prompts"]:
            if split["emptySegments"]:
                blockers.append({"id": entry_id, "reason": "只有空的 char 段落", "detail": " ".join(split["emptySegments"])})
            updated.append(entry)
            continue

        if existing and existing != split["prompts"]:
            blockers.append({"id": entry_id, "reason": "已有 characterPrompts 且与拆分结果不一致", "detail": ""})
            updated.append(entry)
            continue
        if not split["lossless"]:
            blockers.append({"id": entry_id, "reason": "拆分前后文本不一致", "detail": ""})
            updated.append(entry)
            continue
        if split["emptySegments"]:
            blockers.append({"id": entry_id, "reason": "含空的 char 段落", "detail": " ".join(split["emptySegments"])})
            updated.append(entry)
            continue

        stats["changedEntries"] += 1
        stats["characterPromptBoxes"] += len(split["prompts"])
        for item in split["prompts"]:
            labels[item["label"]] += 1
        if not split["positive"].strip():
            stats["emptyPositive"] += 1
            if len(empty_positive) < 20:
                empty_positive.append(entry_id)
        if len(samples) < sample_limit:
            samples.append({
                "id": entry_id,
                "title": str(entry.get("title") or ""),
                "before": clean_text(entry.get("tags")),
                "afterTags": split["positive"],
                "afterCharacterPrompts": split["prompts"],
            })
        updated.append(put_character_prompts(entry, split["positive"], split["prompts"]))

    stats["entries"] = len(entries)
    stats["midlineMarkerEntries"] = len(midline)
    stats["blockers"] = len(blockers)
    data["entries"] = updated

    written = False
    if apply and stats["changedEntries"]:
        if blockers:
            raise RuntimeError(f"{codex_id}: 有 {len(blockers)} 条待人工处理，拒绝写盘")
        backup_dir = OUTPUT_DIR / "backup"
        backup_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(data_path, backup_dir / f"{codex_id}.{stamp or time.strftime('%Y%m%d-%H%M%S')}.json")
        temporary = data_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        temporary.replace(data_path)
        written = True

    return {
        "codexId": codex_id,
        "written": written,
        "stats": dict(sorted(stats.items())),
        "labels": dict(sorted(labels.items())),
        "emptyPositiveExamples": empty_positive,
        "midlineMarkerEntries": midline,
        "blockers": blockers,
        "samples": samples,
    }


def write_reports(output: dict[str, Any], report_path: Path) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines: list[str] = []
    for codex in output["codexes"]:
        lines.append(f"===== {codex['codexId']}  written={codex['written']}")
        lines.append(f"stats  {codex['stats']}")
        lines.append(f"labels {codex['labels']}")
        if codex["blockers"]:
            lines.append("---- 待人工处理")
            for row in codex["blockers"]:
                lines.append(f"  {row['id']}  {row['reason']}  {row['detail']}")
        if codex["midlineMarkerEntries"]:
            lines.append("---- 行中间的 char 标记（原文噪声，故意不拆）")
            for row in codex["midlineMarkerEntries"]:
                lines.append(f"  {row['id']}  {row['title']}  {row['markers']}")
        lines.append("---- 拆分样例")
        for sample in codex["samples"]:
            lines.append(f"  [{sample['id']}] {sample['title']}")
            lines.append(f"    before      : {sample['before']}")
            lines.append(f"    after.tags  : {sample['afterTags']}")
            for item in sample["afterCharacterPrompts"]:
                lines.append(f"    after.{item['label']:<6}: {item['prompt']}")
            lines.append("")
        lines.append("")
    report_path.with_suffix(".txt").write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex-id", action="append", dest="codex_ids")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--samples", type=int, default=12)
    parser.add_argument("--report", type=Path, default=OUTPUT_DIR / "report.json")
    args = parser.parse_args()

    stamp = time.strftime("%Y%m%d-%H%M%S")
    codex_ids = tuple(args.codex_ids or DEFAULT_CODEX_IDS)
    reports = [process_codex(codex_id, args.apply, max(0, args.samples), stamp) for codex_id in codex_ids]
    output = {"applied": args.apply, "stamp": stamp, "codexes": reports}
    report_path = args.report.resolve()
    write_reports(output, report_path)
    # 写盘那次的报告要和备份一起长期留档；默认报告路径固定，下一次预演就会把它冲掉。
    if any(codex["written"] for codex in reports):
        write_reports(output, OUTPUT_DIR / "backup" / f"report.{stamp}.json")

    # 控制台是 GBK，中文只写进 UTF-8 报告文件，stdout 保持 ASCII。
    print(f"mode: {'APPLY' if args.apply else 'DRY-RUN'}")
    for codex in reports:
        stats = codex["stats"]
        print(
            f"{codex['codexId']}: entries={stats.get('entries', 0)} "
            f"changed={stats.get('changedEntries', 0)} "
            f"boxes={stats.get('characterPromptBoxes', 0)} "
            f"emptyPositive={stats.get('emptyPositive', 0)} "
            f"midline={stats.get('midlineMarkerEntries', 0)} "
            f"blockers={stats.get('blockers', 0)} "
            f"written={codex['written']}"
        )
    print(f"report: {report_path}")
    print(f"report: {report_path.with_suffix('.txt')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
