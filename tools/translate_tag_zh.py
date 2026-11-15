"""给 tag 中文对照跑 AI 长尾补译，结果写进 tools/data/tag_zh/AI译名.csv。

只翻「人工译名表和社区词库都没有」的键（口径与 build_tag_zh.py 完全一致），按全站出现条数
从多到少排，断点续跑：已经在 AI 表里的键直接跳过，中途停了再跑一次即可接着补。

负缓存：模型应答了但给不出译名的键（画师名、碎片、纯符号占大头）记进 无译名.csv，
下轮直接跳过，不再重复花钱问同一批；换模型后想重问用 --retry-empty。
单条明确被接口拦截时立即记进 拦截记录.csv，后续跑批始终跳过；网络或服务错误不记入。

渠道配置放在 Git 忽略的 tools/data/tag_zh/ai_config.json。Google 官方渠道用
api_key_credential 指向 Windows 凭据管理器；旧渠道仍兼容 api_key，不写日志或报告。

内容过滤：命中敏感词组合的键一律不送外部接口。渠道对这类组合会整批拒答、把同批正常的 tag
一起连累掉，本地先挡掉更省调用也更稳；报告里只留计数。

用法：
    python tools/translate_tag_zh.py --dry-run     只统计要翻多少、跳过多少
    python tools/translate_tag_zh.py --set-api-key 弹窗设置 Google 官方密钥和 Argon 模型
    python tools/translate_tag_zh.py --limit 300   先跑一小批看质量
    python tools/translate_tag_zh.py               跑完全部待翻译
跑完再跑 python tools/build_tag_zh.py 重新生成 site/data/tag_zh/ 分片。
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_tag_zh as btz  # noqa: E402


CONFIG_PATH = btz.SRC_DIR / "ai_config.json"
LOG_PATH = btz.REPORT_DIR / "翻译跑批.log"
REPORT_PATH = btz.REPORT_DIR / "翻译跑批报告.md"
FAILED_PATH = btz.REPORT_DIR / "跑批失败.csv"
EMPTY_PATH = btz.SRC_DIR / "无译名.csv"
BLOCKED_PATH = btz.SRC_DIR / "拦截记录.csv"
SOURCE_LABEL = ""
GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai"
GOOGLE_MODEL = "gemini-4-argon"
GOOGLE_CREDENTIAL = "NovelAI-Tag/tag-zh-gemini-official"


class FatalTranslationError(RuntimeError):
    """The relay rejected the key, model, route or request; splitting cannot help."""


class TransientTranslationError(RuntimeError):
    """A bounded network/service retry failed; keep the batch for a later run."""


class ContentBlockedError(RuntimeError):
    """The provider blocked this content; isolate and skip blocked single items."""


CONTENT_BLOCK_CODES = {
    "PROHIBITED_CONTENT", "SAFETY", "BLOCKLIST", "IMAGE_SAFETY",
    "CONTENT_FILTER", "CONTENT_POLICY_VIOLATION", "PROMPT_BLOCKED",
}


def content_block_reason(payload) -> str:
    """Read explicit provider safety signals, never the user's prompt text."""
    if not isinstance(payload, dict):
        return ""
    error = payload.get("error")
    if isinstance(error, str):
        error = {"message": error}
    if isinstance(error, dict):
        message = str(error.get("message") or "")
        lower = message.casefold()
        if any(marker in lower for marker in (
            "无权访问", "无权使用", "invalid api key", "invalid_api_key",
            "model_not_allowed", "model not allowed", "permission denied", "unauthorized",
        )):
            return ""
        for field in (error.get("code"), error.get("type")):
            code = str(field or "").upper()
            if code in CONTENT_BLOCK_CODES:
                return code
        matched = re.search(r"\b(PROHIBITED_CONTENT|CONTENT_FILTER|CONTENT_POLICY_VIOLATION|PROMPT_BLOCKED|IMAGE_SAFETY|BLOCKLIST)\b", message, re.IGNORECASE)
        if matched:
            return matched.group(1).upper()
        if re.search(r":\s*SAFETY\b", message, re.IGNORECASE):
            return "SAFETY"
    feedback = payload.get("promptFeedback") or payload.get("prompt_feedback")
    if isinstance(feedback, dict):
        code = str(feedback.get("blockReason") or feedback.get("block_reason") or "").upper()
        if code in CONTENT_BLOCK_CODES or code == "OTHER":
            return code
    for item in [*(payload.get("choices") or []), *(payload.get("candidates") or [])]:
        if not isinstance(item, dict):
            continue
        code = str(item.get("finish_reason") or item.get("finishReason") or "").strip().upper()
        # Google 兼容接口可能只返回 finish_reason="content_filter: OTHER"，不带 message。
        # 只匹配明确的 content_filter 前缀，普通 OTHER 仍作为不可用响应处理。
        kind, separator, detail = code.partition(":")
        if separator and kind.strip() == "CONTENT_FILTER":
            detail = detail.strip()
            return "CONTENT_FILTER" + (":" + detail if re.fullmatch(r"[A-Z_]{1,64}", detail) else "")
        if code in CONTENT_BLOCK_CODES:
            return code
        message = item.get("message")
        if isinstance(message, dict) and message.get("refusal"):
            return "MODEL_REFUSAL"
    return ""

SYSTEM_PROMPT = (
    "你是 NovelAI / Danbooru 提示词标签的中文译者。把每个标签翻成简短的中文词典释义；"
    "标签多为英文，也可能是韩文或日文的词句，一律译成简体中文。\n"
    "规则：\n"
    "1) 只给译名，不解释、不加引号、不加标点结尾；一般 2-12 个汉字，信息量贴近原文。\n"
    "2) 角色名、作品名、专有名词用通行中文译名；没有通行译名就音译。\n"
    "3) 明显拼写错误按本意翻译，并在末尾加「（原文拼写有误）」。\n"
    "4) 自然语言长句照句子翻译，保持原意，不要压缩成词。\n"
    "5) 画师名、无意义碎片、纯符号无法翻译时，返回空字符串。\n"
    "6) 成人向词汇按医学 / 常见中文用语直译，不回避、不评价。\n"
    "只输出 JSON 对象：键是输入编号（字符串），值是译名。不要输出别的内容。"
)

# 内容过滤：两组词同时命中才拦，单独命中照常翻。词表放在 Git 忽略的本地文件里，
# 脚本不带内置词表；文件缺失直接退出，不允许静默跳过这道过滤。
FILTER_PATH = btz.SRC_DIR / "过滤词.json"
_FILTER = None


def load_filter() -> tuple:
    global _FILTER
    if _FILTER is None:
        if not FILTER_PATH.exists():
            raise SystemExit(f"缺少本地词表 {FILTER_PATH}；脚本不带内置词表，补齐后再跑。")
        data = json.loads(FILTER_PATH.read_text(encoding="utf-8"))
        groups = []
        for name in ("a", "b"):
            terms = [str(t).strip() for t in (data.get(name) or []) if str(t).strip()]
            if not terms:
                raise SystemExit(f"{FILTER_PATH} 的 {name} 组是空的")
            # 英文按整词匹配；韩文、日文的词后面常直接粘着助词，只能按包含匹配
            words = [t for t in terms if t.isascii()]
            others = [t for t in terms if not t.isascii()]
            parts = []
            if words:
                parts.append(r"\b(?:" + "|".join(words) + r")\b")
            if others:
                parts.append("(?:" + "|".join(others) + ")")
            groups.append(re.compile("|".join(parts), re.IGNORECASE))
        _FILTER = tuple(groups)
    return _FILTER


QUOTES = "\"'“”‘’「」『』"


def credential_store():
    """Windows generic credential API; keys never go through a shell or a file."""
    import ctypes
    from ctypes import wintypes

    class Credential(ctypes.Structure):
        _fields_ = [
            ("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
            ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
            ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
            ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)), ("Persist", wintypes.DWORD),
            ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p),
            ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR),
        ]

    api = ctypes.WinDLL("advapi32", use_last_error=True)
    api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                             ctypes.POINTER(ctypes.POINTER(Credential))]
    api.CredReadW.restype = wintypes.BOOL
    api.CredWriteW.argtypes = [ctypes.POINTER(Credential), wintypes.DWORD]
    api.CredWriteW.restype = wintypes.BOOL
    api.CredFree.argtypes = [ctypes.c_void_p]
    api.CredFree.restype = None
    return ctypes, Credential, api


def read_api_key(target: str) -> str:
    ctypes, Credential, api = credential_store()
    pointer = ctypes.POINTER(Credential)()
    if not api.CredReadW(target, 1, 0, ctypes.byref(pointer)):
        error = ctypes.get_last_error()
        if error == 1168:  # ERROR_NOT_FOUND
            return ""
        raise OSError(error, "读取 Windows 凭据失败")
    try:
        credential = pointer.contents
        return bytes(credential.CredentialBlob[:credential.CredentialBlobSize]).decode("utf-8")
    finally:
        api.CredFree(pointer)


def write_api_key(key: str) -> None:
    ctypes, Credential, api = credential_store()
    blob = key.encode("utf-8")
    buffer = (ctypes.c_ubyte * len(blob)).from_buffer_copy(blob)
    credential = Credential(Type=1, TargetName=GOOGLE_CREDENTIAL,
                            CredentialBlobSize=len(blob), CredentialBlob=buffer,
                            Persist=2, UserName="gemini")
    if not api.CredWriteW(ctypes.byref(credential), 0):
        raise OSError(ctypes.get_last_error(), "保存 Windows 凭据失败")


def google_config(cfg: dict) -> dict:
    cfg = dict(cfg)
    cfg.pop("api_key", None)
    cfg.update(base_url=GOOGLE_BASE_URL, model=GOOGLE_MODEL,
               api_key_credential=GOOGLE_CREDENTIAL, reasoning_effort="high")
    cfg.setdefault("batch_size", 30)
    cfg.setdefault("concurrency", 4)
    return cfg


def set_api_key() -> int:
    import tkinter as tk
    from tkinter import messagebox, simpledialog

    window = tk.Tk()
    window.withdraw()
    window.attributes("-topmost", True)
    try:
        key = simpledialog.askstring(
            "中文对照 · Google Gemini 4 Argon",
            "粘贴 Google AI Studio 的 API 密钥：\n\n"
            "密钥保存到 Windows 凭据管理器。\n保存后即可关闭窗口，再从菜单运行付费补译。",
            show="*", parent=window,
        )
        if not key or not key.strip():
            return 0
        key = key.strip()
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8")) if CONFIG_PATH.exists() else {}
            write_api_key(key)
            CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
            temporary = CONFIG_PATH.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(google_config(cfg), ensure_ascii=False, indent=2) + "\n",
                                 encoding="utf-8")
            temporary.replace(CONFIG_PATH)
        except Exception as error:
            messagebox.showerror("保存失败", str(error).replace(key, "[redacted]"), parent=window)
            return 1
        messagebox.showinfo("已保存", "密钥已保存。\n中文对照付费补译已使用 Google 官方 Gemini 4 Argon。", parent=window)
        return 0
    finally:
        window.destroy()


def load_config(resolve_key: bool = True) -> dict:
    if not CONFIG_PATH.exists():
        raise SystemExit(f"缺少渠道配置 {CONFIG_PATH}；可用 --set-api-key 弹窗设置 Google 官方渠道")
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    for field in ("base_url", "model"):
        if not str(cfg.get(field) or "").strip():
            raise SystemExit(f"渠道配置缺少 {field}")
    target = str(cfg.get("api_key_credential") or "").strip()
    if resolve_key:
        if target:
            cfg["api_key"] = read_api_key(target)
        if not str(cfg.get("api_key") or "").strip():
            raise SystemExit("缺少 API 密钥；运行 python tools/translate_tag_zh.py --set-api-key 填写")
    return cfg


def filtered(key: str) -> bool:
    first, second = load_filter()
    return bool(first.search(key) and second.search(key))


def load_empty_keys() -> set[str]:
    """已知「模型给不出译名」的键（负缓存）。这类键多是画师名、碎片和纯符号，
    问一次就够了，不记下来每轮都会重新花钱问同一批。"""
    if not EMPTY_PATH.exists():
        return set()
    keys = set()
    for index, row in enumerate(btz.read_csv_rows(EMPTY_PATH)):
        if index == 0 and row and row[0].strip().lower() in ("tag", "﻿tag"):
            continue
        key = btz.tag_key(row[0]) if row else ""
        if key:
            keys.add(key)
    return keys


def load_blocked_keys() -> set[str]:
    """持久保存的单条内容拦截；不受 --retry-empty 影响。"""
    if not BLOCKED_PATH.exists():
        return set()
    keys = set()
    for index, row in enumerate(btz.read_csv_rows(BLOCKED_PATH)):
        if index == 0 and row and row[0].strip().lower() in ("tag", "﻿tag"):
            continue
        key = btz.tag_key(row[0]) if row else ""
        if key:
            keys.add(key)
    return keys


def pending_keys(skip_empty: bool = True) -> tuple[list[tuple[str, int]], int, dict]:
    """返回（待翻译键+出现条数，被过滤掉的键数，统计）。口径与 build_tag_zh 一致。"""
    index = btz.read_json(btz.INDEX_PATH)
    dictionary, dictionary_artists = btz.load_dictionary()
    manual = btz.load_table(btz.MANUAL_PATH)
    ai = btz.load_table(btz.AI_PATH)
    entry_count, _codex_sets, _example, _per_codex, artist_names = btz.collect_usage(index)
    skip_artist = artist_names | dictionary_artists
    known_empty = load_empty_keys()
    known_blocked = load_blocked_keys()
    pending, held, skipped_empty, skipped_blocked = [], 0, 0, 0
    for key, count in entry_count.items():
        if key in skip_artist or not btz.ai_eligible(key):
            continue
        if btz.resolve(key, manual, dictionary, ai)[0]:
            continue
        if filtered(key):
            held += 1
        elif key in known_blocked:
            skipped_blocked += 1
        elif skip_empty and key in known_empty:
            skipped_empty += 1
        else:
            pending.append((key, count))
    pending.sort(key=lambda item: (-item[1], item[0]))
    stats = {"总 tag": len(entry_count), "已有译名": sum(1 for k in entry_count
                                                    if btz.resolve(k, manual, dictionary, ai)[0]),
             "AI 表现有": len(ai), "已知无译名": len(known_empty),
             "本轮跳过无译名": skipped_empty, "过滤跳过": held,
             "已知拦截": len(known_blocked), "本轮跳过拦截": skipped_blocked}
    return pending, held, stats


def log(message: str) -> None:
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {message}"
    with LOG_LOCK:
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
        print(line, flush=True)


LOG_LOCK = threading.Lock()
CSV_LOCK = threading.Lock()


def append_rows(rows: list[tuple[str, str]]) -> None:
    """追加写 AI 译名表；文件不存在先补表头。"""
    with CSV_LOCK:
        new_file = not btz.AI_PATH.exists()
        with btz.AI_PATH.open("a", encoding="utf-8-sig" if new_file else "utf-8", newline="") as fh:
            writer = csv.writer(fh)
            if new_file:
                writer.writerow(["tag", "中文", "来源", "日期"])
            today = datetime.now().strftime("%Y-%m-%d")
            for key, zh in rows:
                writer.writerow([key, zh, SOURCE_LABEL, today])


def append_empty(keys: list[str]) -> None:
    """追加写负缓存：模型应答了但给不出译名的键，下轮不再问。
    只记「问过且有应答」的，请求失败的不记——那可能只是网络或渠道一时抽风。"""
    if not keys:
        return
    with CSV_LOCK:
        new_file = not EMPTY_PATH.exists()
        with EMPTY_PATH.open("a", encoding="utf-8-sig" if new_file else "utf-8", newline="") as fh:
            writer = csv.writer(fh)
            if new_file:
                writer.writerow(["tag", "模型", "日期"])
            today = datetime.now().strftime("%Y-%m-%d")
            for key in keys:
                writer.writerow([key, SOURCE_LABEL, today])


def append_blocked(rows: list[tuple[str, int, str]]) -> None:
    """单条明确被拦即落盘；去重追加，避免下轮再次送出。"""
    if not rows:
        return
    with CSV_LOCK:
        known = load_blocked_keys()
        additions = []
        for raw_key, count, reason in rows:
            key = btz.tag_key(raw_key)
            if key and key not in known:
                additions.append((key, count, reason))
                known.add(key)
        if not additions:
            return
        new_file = not BLOCKED_PATH.exists() or BLOCKED_PATH.stat().st_size == 0
        with BLOCKED_PATH.open("a", encoding="utf-8-sig" if new_file else "utf-8", newline="") as fh:
            writer = csv.writer(fh)
            if new_file:
                writer.writerow(["tag", "出现条数", "原因", "模型", "日期"])
            today = datetime.now().strftime("%Y-%m-%d")
            for key, count, reason in additions:
                writer.writerow([key, count, reason, SOURCE_LABEL, today])


def clean(value, key: str) -> str:
    """模型返回值 → 可用译名；不合格返回空串（这个键留给下次跑批或人工）。"""
    text = str(value or "").strip().strip(QUOTES).strip()
    text = re.sub(r"\s+", " ", text)
    if not text or len(text) > 160:
        return ""
    if text.lower() == key.lower():
        return ""
    if not re.search(r"[一-鿿]", text):  # 一个汉字都没有 = 没翻译
        return ""
    return text


def translate_batch(cfg: dict, batch: list[tuple[str, int]], attempt_budget: int = 4):
    """一批 tag → {键: 译名}；失败返回 None。429 / 5xx / 超时按退避重试。"""
    keys = [key for key, _ in batch]
    body = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": "\n".join(f"{i + 1}. {key}" for i, key in enumerate(keys))},
        ],
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }
    if cfg.get("reasoning_effort"):
        body["reasoning_effort"] = cfg["reasoning_effort"]
    body = json.dumps(body).encode("utf-8")
    url = cfg["base_url"].rstrip("/")
    if not url.endswith("/chat/completions"):
        url += "/chat/completions" if url.endswith(("/openai", "/v1")) else "/v1/chat/completions"
    delay = 4.0
    for attempt in range(1, attempt_budget + 1):
        try:
            request = urllib.request.Request(url, data=body, headers={
                "Authorization": "Bearer " + cfg["api_key"],
                "Content-Type": "application/json",
            })
            with urllib.request.urlopen(request, timeout=float(cfg.get("request_timeout") or 300)) as response:
                payload = json.loads(response.read().decode("utf-8"))
            blocked = content_block_reason(payload)
            if blocked:
                raise ContentBlockedError(blocked)
            choices = payload.get("choices") or []
            if not choices:
                # 渠道偶尔 200 但不给 choices（上游过载 / 错误对象），把它的说法记下来再退避重试
                detail = payload.get("error") or {k: v for k, v in payload.items() if k != "usage"}
                raise ValueError("空 choices：" + json.dumps(detail, ensure_ascii=False)[:160])
            choice = choices[0]
            if not isinstance(choice, dict):
                raise ValueError("choices[0] 不是对象")
            finish = str(choice.get("finish_reason") or choice.get("finishReason") or "UNKNOWN").strip().upper()
            finish = finish if re.fullmatch(r"[A-Z_]{1,64}", finish) else "UNKNOWN"
            message = choice.get("message")
            if not isinstance(message, dict):
                raise ValueError(f"响应缺少 message（finish_reason={finish}）")
            text = message.get("content")
            if not isinstance(text, str) or not text.strip():
                raise ValueError(f"响应没有可用文本（finish_reason={finish}）")
            start, end = text.find("{"), text.rfind("}")
            if start < 0 or end < 0:
                raise ValueError("返回里没有 JSON 对象")
            data = json.loads(text[start:end + 1])
            usage = payload.get("usage") or {}
            return {keys[int(i) - 1]: value for i, value in data.items()
                    if str(i).isdigit() and 1 <= int(i) <= len(keys)}, usage
        except ContentBlockedError:
            raise
        except Exception as ex:
            secret = str(cfg.get("api_key") or "")
            message = str(ex).replace(secret, "[redacted]") if secret else str(ex)
            reason = f"{type(ex).__name__}: {message[:120]}"
            if isinstance(ex, urllib.error.HTTPError):
                error_payload = None
                try:
                    detail = ex.read(8192).decode("utf-8", errors="replace")
                    if secret:
                        detail = detail.replace(secret, "[redacted]")
                    try:
                        payload = json.loads(detail)
                        error_payload = payload
                        error = payload.get("error")
                        detail = str(error.get("message") or error) if isinstance(error, dict) else str(error or detail)
                    except (ValueError, TypeError, AttributeError):
                        pass
                    detail = re.sub(r"\s+", " ", detail).strip()[:240]
                except Exception:
                    detail = ""
                finally:
                    ex.close()
                reason = f"HTTP {ex.code}" + (f"：{detail}" if detail else "")
                if ex.code in (400, 403, 422):
                    blocked = content_block_reason(error_payload)
                    if blocked:
                        raise ContentBlockedError(blocked) from None
                if 400 <= ex.code < 500 and ex.code != 429:
                    raise FatalTranslationError(reason) from None
            # 空 choices 是上游把整批挡了（单独问同一个键往往就能过），重试没用，早点交给拆分
            budget = 2 if "空 choices" in str(ex) else attempt_budget
            if attempt >= budget:
                log(f"批次失败（{len(keys)} 个，{reason}）")
                if isinstance(ex, (ValueError, KeyError, IndexError, TypeError)):
                    return None, {}
                raise TransientTranslationError(reason) from None
            log(f"请求失败（{len(keys)} 个，第 {attempt}/{budget} 次，{reason}）；{delay:g} 秒后重试")
            time.sleep(delay)
            delay = min(delay * 2, 60)
    return None, {}


def main(argv=None) -> int:
    global SOURCE_LABEL
    parser = argparse.ArgumentParser(description="AI 补译 tag 中文对照的长尾")
    parser.add_argument("--limit", type=int, default=0, help="只翻出现条数最多的前 N 个（0 = 全部）")
    parser.add_argument("--dry-run", action="store_true", help="只统计，不调接口")
    parser.add_argument("--set-api-key", action="store_true", help="弹窗设置 Google 官方 Gemini 4 Argon 密钥")
    parser.add_argument("--batch-size", type=int, default=0, help="每次请求几个 tag（默认读配置）")
    parser.add_argument("--concurrency", type=int, default=0, help="并发请求数（默认读配置）")
    parser.add_argument("--retry-empty", action="store_true",
                        help="连「已知无译名」的键也重新问一遍（换模型后才需要）")
    args = parser.parse_args(argv)
    if args.set_api_key:
        return set_api_key()

    btz.REPORT_DIR.mkdir(parents=True, exist_ok=True)
    cfg = load_config(resolve_key=not args.dry_run)
    SOURCE_LABEL = str(cfg["model"]).strip()
    batch_size = args.batch_size or int(cfg.get("batch_size") or 50)
    concurrency = args.concurrency or int(cfg.get("concurrency") or 4)

    pending, held, stats = pending_keys(skip_empty=not args.retry_empty)
    if args.limit:
        pending = pending[:args.limit]
    log(f"待翻译 {len(pending)}；跳过已知无译名 {stats['本轮跳过无译名']}；"
        f"跳过已知拦截 {stats.get('本轮跳过拦截', 0)}；过滤跳过 {held}；"
        f"模型 {SOURCE_LABEL}；批大小 {batch_size}，并发 {concurrency}")
    if args.dry_run or not pending:
        print(json.dumps({**stats, "本次待翻译": len(pending)}, ensure_ascii=False))
        return 0

    batches = [pending[i:i + batch_size] for i in range(0, len(pending), batch_size)]
    started = time.time()
    counters = {"done": 0, "written": 0, "empty": 0, "failed": 0, "blocked": 0, "service_failed": 0,
                "prompt_tokens": 0, "completion_tokens": 0}
    failures: list[tuple[str, int, str]] = []
    stopped = threading.Event()
    fatal_reason = ""

    def failed(batch, reason="响应不可用", kind="response"):
        if kind == "content":
            append_blocked([(key, count, reason) for key, count in batch])
        with LOG_LOCK:
            counters["failed"] += len(batch)
            counters["blocked"] += len(batch) if kind == "content" else 0
            counters["service_failed"] += len(batch) if kind == "service" else 0
            failures.extend((key, count, reason) for key, count in batch)

    def run(batch, depth=0):
        if stopped.is_set():
            return
        blocked_reason = ""
        try:
            result, usage = translate_batch(cfg, batch)
        except ContentBlockedError as error:
            result, usage = None, {}
            blocked_reason = str(error)
        except FatalTranslationError as error:
            failed(batch, str(error), "fatal")
            stopped.set()
            raise
        except TransientTranslationError as error:
            failed(batch, str(error), "service")
            log(f"本批保留待重试，不继续拆分：{error}")
            return
        rows, empty_keys = [], []
        if result is None and len(batch) > 1:
            # 上游按整批挡内容：对半拆到单条，把真被挡的那几个隔离出来，别连累同批其它 tag
            half = len(batch) // 2
            log(f"{'内容拦截 ' + blocked_reason if blocked_reason else '响应不可用'}；二分 {len(batch)} → {half}+{len(batch)-half}")
            run(batch[:half], depth + 1)
            run(batch[half:], depth + 1)
            return
        if result is None:
            failed(batch, blocked_reason or "响应不可用", "content" if blocked_reason else "response")
            log(f"单条内容拦截 {blocked_reason}；已存入拦截记录，下轮跳过" if blocked_reason
                else "单条响应不可用；已记录，继续后续翻译")
        else:
            for key, count in batch:
                zh = clean(result.get(key), key)
                if zh:
                    rows.append((key, zh))
                else:
                    empty_keys.append(key)
            if rows:
                append_rows(rows)
            append_empty(empty_keys)
        with LOG_LOCK:
            counters["written"] += len(rows)
            counters["empty"] += len(empty_keys)
            counters["prompt_tokens"] += int(usage.get("prompt_tokens") or 0)
            counters["completion_tokens"] += int(usage.get("completion_tokens") or 0)

    def run_top(batch):
        """一个顶层批次（含拆分重试）跑完才记一次进度，拆分不会把进度算重。"""
        if stopped.is_set():
            return
        try:
            run(batch)
        finally:
            with LOG_LOCK:
                counters["done"] += 1
                done = counters["done"]
            elapsed = time.time() - started
            speed = done / elapsed if elapsed else 0
            remain = (len(batches) - done) / speed if speed else 0
            log(f"{done}/{len(batches)} 批 · 已写 {counters['written']} 条 · 空 {counters['empty']} · "
                f"跳过/失败 {counters['failed']}（内容拦截 {counters['blocked']}） · 用时 {elapsed / 60:.1f} 分 · 预计还要 {remain / 60:.1f} 分")

    try:
        log(f"先检查首批请求（{len(batches[0])} 个）；通过后再启动并发")
        run_top(batches[0])
        if counters["service_failed"] and not (counters["written"] or counters["empty"]):
            fatal_reason = "首批没有取得可用应答，本轮停止；检查渠道后可断点重跑"
            stopped.set()
        elif len(batches) > 1:
            with ThreadPoolExecutor(max_workers=concurrency) as pool:
                list(pool.map(run_top, batches[1:]))
    except FatalTranslationError as error:
        stopped.set()
        fatal_reason = str(error)
    if fatal_reason:
        log("已停止：" + fatal_reason)

    with FAILED_PATH.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["tag", "出现条数", "原因"])
        writer.writerows(sorted(failures, key=lambda item: -item[1]))

    elapsed = time.time() - started
    unprocessed = len(pending) - counters["written"] - counters["empty"] - counters["failed"]
    lines = [
        "# tag 中文对照 · AI 跑批报告",
        "",
        f"- 时间：{datetime.now(timezone.utc).astimezone().strftime('%Y-%m-%d %H:%M')}，用时 {elapsed / 60:.1f} 分钟",
        f"- 模型：{cfg['model']}（批大小 {batch_size}，并发 {concurrency}）",
        f"- 本次待翻译 {len(pending)} 个，写入 {counters['written']} 条，模型给不出译名 {counters['empty']} 个，"
        f"跳过/失败 {counters['failed']} 个（内容拦截 {counters['blocked']} 个），未处理 {unprocessed} 个（清单见 跑批失败.csv）",
        f"- 状态：{'已停止：' + fatal_reason if fatal_reason else ('已完成，有跳过/失败项' if counters['failed'] else '完成')}",
        f"- token：输入 {counters['prompt_tokens']:,}，输出 {counters['completion_tokens']:,}",
        f"- 本轮按负缓存跳过 {stats['本轮跳过无译名']} 个键，新记入 {counters['empty']} 个"
        f"（表：{EMPTY_PATH.name}，共 {stats['已知无译名'] + counters['empty']} 条；"
        f"换模型后想重问用 --retry-empty）",
        f"- 本轮跳过已知拦截 {stats.get('本轮跳过拦截', 0)} 个，新记录 {counters['blocked']} 个"
        f"（表：{BLOCKED_PATH.name}；记录后不再进入后续翻译，--retry-empty 不会重试拦截项）",
        f"- 内容过滤跳过 {held} 个键，没有送出外部接口",
        "",
        "跑完记得执行 `python tools/build_tag_zh.py` 重新生成 site/data/tag_zh/ 分片。",
    ]
    REPORT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"written": counters["written"], "empty": counters["empty"],
                      "failed": counters["failed"], "blocked": counters["blocked"],
                      "minutes": round(elapsed / 60, 1)}, ensure_ascii=False))
    return 1 if fatal_reason or counters["service_failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
