# -*- coding: utf-8 -*-
"""Headless UI regression smoke checks for the NovelAI Tag Atlas.

This script intentionally uses only the Python standard library plus a local
Chrome/Edge executable. It starts the local preview server when needed, drives
the app through the Chrome DevTools Protocol, and writes a small report plus
screenshots to output/ui-regression/.
"""
from __future__ import annotations

import argparse
import base64
import datetime as _dt
import hashlib
import http.client
import json
import os
import random
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASE_URL = "http://localhost:8766/"


class CheckFailed(RuntimeError):
    pass


def log(msg: str) -> None:
    print(msg, flush=True)


def now_stamp() -> str:
    return _dt.datetime.now().strftime("%Y%m%d-%H%M%S")


def url_ok(url: str, timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return 200 <= resp.status < 500
    except Exception:
        return False


def wait_url(url: str, timeout: float = 10.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if url_ok(url):
            return True
        time.sleep(0.25)
    return False


def find_free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def start_preview(base_url: str) -> subprocess.Popen | None:
    if url_ok(base_url):
        return None
    parsed = urllib.parse.urlparse(base_url)
    port = parsed.port or 8766
    cmd = [sys.executable, str(ROOT / "tools" / "preview_server.py"), "--port", str(port)]
    proc = subprocess.Popen(cmd, cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if wait_url(base_url, timeout=12):
        return proc
    out = ""
    try:
        out = proc.stdout.read() if proc.stdout else ""
    except Exception:
        pass
    proc.terminate()
    raise RuntimeError(f"Preview server did not start at {base_url}\n{out}")


def find_chrome() -> str:
    env = os.environ.get("CHROME_PATH")
    candidates = []
    if env:
        candidates.append(env)
    local = os.environ.get("LOCALAPPDATA", "")
    program_files = [os.environ.get("PROGRAMFILES", ""), os.environ.get("PROGRAMFILES(X86)", "")]
    candidates.extend(
        [
            shutil.which("chrome"),
            shutil.which("chrome.exe"),
            shutil.which("msedge"),
            shutil.which("msedge.exe"),
            *(str(Path(p) / "Google" / "Chrome" / "Application" / "chrome.exe") for p in program_files if p),
            *(str(Path(p) / "Microsoft" / "Edge" / "Application" / "msedge.exe") for p in program_files if p),
            str(Path(local) / "Google" / "Chrome" / "Application" / "chrome.exe") if local else "",
        ]
    )
    for item in candidates:
        if item and Path(item).is_file():
            return str(Path(item))
    raise RuntimeError("Chrome/Edge was not found. Install Chrome, or set CHROME_PATH to chrome.exe.")


def http_json(url: str, timeout: float = 5.0):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def first_imaged_entry_id(codex_id: str) -> str:
    data_path = ROOT / "site" / "data" / f"{codex_id}.json"
    data = json.loads(data_path.read_text(encoding="utf-8"))
    for entry in data.get("entries", []):
        images = entry.get("images") or []
        if entry.get("image") or images:
            entry_id = entry.get("id")
            if entry_id:
                return str(entry_id)
    raise RuntimeError(f"No imaged entry was found in {data_path}")


def load_codex_list() -> list[dict]:
    """书目现况。分类下有几本会随收录变化，别在用例里写死。"""
    index_path = ROOT / "site" / "data" / "codexes.json"
    return json.loads(index_path.read_text(encoding="utf-8"))


def update_filter_config(codex_id: str) -> list[dict]:
    index_path = ROOT / "site" / "data" / "codexes.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    meta = next((item for item in index if item.get("id") == codex_id), None)
    if not meta:
        raise RuntimeError(f"No codex metadata is configured for {codex_id}")
    data_path = ROOT / "site" / "data" / f"{codex_id}.json"
    data = json.loads(data_path.read_text(encoding="utf-8"))
    filters = meta.get("updateFilters") if isinstance(meta.get("updateFilters"), list) else []
    if not filters and str(meta.get("newFilterLabel") or "").strip():
        filters = [{
            "id": str(meta.get("version") or "latest"),
            "label": str(meta["newFilterLabel"]).strip().removeprefix("本次"),
            "latest": True,
        }]
    result = []
    for item in filters:
        filter_id = str(item.get("id") or "").strip() if isinstance(item, dict) else ""
        label = str(item.get("label") or "").strip().removeprefix("本次") if isinstance(item, dict) else ""
        latest = item.get("latest") is True if isinstance(item, dict) else False
        if not filter_id or not label:
            continue
        count = sum(
            filter_id in [str(value) for value in (entry.get("updateBatches") or [])]
            or (latest and entry.get("isNew") is True)
            for entry in data.get("entries", [])
        )
        # 同一条可以被多批改到：记下这批里又带 isNew 的条数，
        # 让用例能挑一个与最新一期不重叠的历史批次去断言「NEW 角标应为 0」。
        new_overlap = sum(
            filter_id in [str(value) for value in (entry.get("updateBatches") or [])]
            and entry.get("isNew") is True
            for entry in data.get("entries", [])
        )
        if count <= 0:
            raise RuntimeError(f"Update filter {filter_id!r} has no entries in {data_path}")
        result.append({
            "id": filter_id, "label": label, "latest": latest,
            "count": count, "newOverlap": 0 if latest else new_overlap,
        })
    if not result:
        raise RuntimeError(f"No usable update filters are configured for {codex_id}")
    # 前端的 updateFilterDefinitions 按批次日期倒序渲染（codexes.json 里各书正序倒序都有），
    # 期望值必须用同一个口径排，否则换一本书就擞红。排不出日期的保留原次序并沉底。
    def _batch_time(value: str):
        parts = re.fullmatch(r"(\d{4})\.(\d{1,2})\.(\d{1,2})", value)
        if not parts:
            return None
        return (int(parts[1]), int(parts[2]), int(parts[3]))

    ordered = sorted(
        enumerate(result),
        key=lambda pair: (
            _batch_time(pair[1]["id"]) is None,
            tuple(-part for part in (_batch_time(pair[1]["id"]) or (0, 0, 0))),
            pair[0],
        ),
    )
    return [item for _, item in ordered]


class WebSocket:
    def __init__(self, ws_url: str):
        parsed = urllib.parse.urlparse(ws_url)
        if parsed.scheme != "ws":
            raise ValueError(f"Only ws:// URLs are supported: {ws_url}")
        self.host = parsed.hostname or "127.0.0.1"
        self.port = parsed.port or 80
        self.path = parsed.path
        if parsed.query:
            self.path += "?" + parsed.query
        self.sock = socket.create_connection((self.host, self.port), timeout=10)
        self.sock.settimeout(10)
        self._handshake()

    def _handshake(self) -> None:
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode("ascii"))
        data = b""
        while b"\r\n\r\n" not in data:
            data += self.sock.recv(4096)
        if b" 101 " not in data.split(b"\r\n", 1)[0]:
            raise RuntimeError(f"WebSocket handshake failed: {data[:200]!r}")

    def send_text(self, text: str) -> None:
        payload = text.encode("utf-8")
        header = bytearray([0x81])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        mask = os.urandom(4)
        header.extend(mask)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + masked)

    def recv_text(self) -> str:
        while True:
            first = self._read_exact(2)
            opcode = first[0] & 0x0F
            masked = bool(first[1] & 0x80)
            length = first[1] & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exact(8))[0]
            mask = self._read_exact(4) if masked else b""
            payload = self._read_exact(length) if length else b""
            if masked:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x8:
                raise RuntimeError("WebSocket closed")
            if opcode == 0x9:
                self._send_pong(payload)
                continue
            # TODO: CDP normally sends one text frame; add continuation support if large payloads need it.
            if opcode == 0x1:
                return payload.decode("utf-8")

    def _send_pong(self, payload: bytes) -> None:
        header = bytearray([0x8A, 0x80 | len(payload)])
        mask = os.urandom(4)
        header.extend(mask)
        header.extend(bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
        self.sock.sendall(header)

    def _read_exact(self, n: int) -> bytes:
        data = b""
        while len(data) < n:
            chunk = self.sock.recv(n - len(data))
            if not chunk:
                raise RuntimeError("Socket closed")
            data += chunk
        return data

    def close(self) -> None:
        try:
            self.sock.close()
        except Exception:
            pass


class CDP:
    def __init__(self, ws_url: str):
        self.ws = WebSocket(ws_url)
        self.next_id = 1
        self.events: list[dict] = []

    def command(self, method: str, params: dict | None = None, timeout: float = 10.0):
        msg_id = self.next_id
        self.next_id += 1
        self.ws.send_text(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        end = time.time() + timeout
        while time.time() < end:
            raw = self.ws.recv_text()
            msg = json.loads(raw)
            if msg.get("id") == msg_id:
                if "error" in msg:
                    raise RuntimeError(f"CDP {method} failed: {msg['error']}")
                return msg.get("result")
            self.events.append(msg)
        raise TimeoutError(f"Timed out waiting for {method}")

    def eval(self, expression: str, timeout: float = 10.0):
        result = self.command(
            "Runtime.evaluate",
            {
                "expression": expression,
                "awaitPromise": True,
                "returnByValue": True,
                "timeout": int(timeout * 1000),
            },
            timeout=timeout + 2,
        )
        value = result.get("result", {})
        if value.get("subtype") == "error":
            raise RuntimeError(value.get("description") or value.get("value") or "Runtime evaluation failed")
        if "exceptionDetails" in result:
            raise RuntimeError(json.dumps(result["exceptionDetails"], ensure_ascii=False))
        return value.get("value")

    def close(self) -> None:
        self.ws.close()


def start_chrome(out_dir: Path, port: int) -> subprocess.Popen:
    chrome = find_chrome()
    profile = out_dir / "chrome-profile"
    profile.mkdir(parents=True, exist_ok=True)
    cmd = [
        chrome,
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-scrollbars",
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile}",
        "--window-size=1280,720",
        "about:blank",
    ]
    return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def page_ws_url(port: int) -> str:
    base = f"http://127.0.0.1:{port}"
    end = time.time() + 10
    last = None
    while time.time() < end:
        try:
            pages = http_json(base + "/json/list")
            for page in pages:
                if page.get("type") == "page" and page.get("webSocketDebuggerUrl"):
                    return page["webSocketDebuggerUrl"]
            req = urllib.request.Request(base + "/json/new?about:blank", method="PUT")
            with urllib.request.urlopen(req, timeout=3) as resp:
                page = json.loads(resp.read().decode("utf-8"))
                return page["webSocketDebuggerUrl"]
        except Exception as exc:
            last = exc
            time.sleep(0.25)
    raise RuntimeError(f"Could not connect to Chrome DevTools: {last}")


def js_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def wait_for(cdp: CDP, expr: str, label: str, timeout: float = 12.0, interval: float = 0.25):
    # 近 2 万词条的真实数据 + 机器有其他负载时，8s 不够渲染完：copyable cards /
    # nsfw confirm 等用例会随机超时（失败点还会漂移，看着像回归其实是等不够）。
    # 条件一满足就立即返回，所以调高只延长「失败前的等待」，绿灯路径不会变慢。
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = cdp.eval(expr, timeout=3)
            if last:
                return last
        except Exception as exc:
            last = str(exc)
        time.sleep(interval)
    raise CheckFailed(f"Timed out waiting for {label}; last={last!r}")


def disable_motion(cdp: CDP) -> None:
    """截图器要的是静止帧：把「开场动画」偏好预置成关闭，全站动画/过渡时长随之压到 0。

    走文档启动脚本而不是 ?motion=off，是因为站点的 URL 由 atlasUrlForRoute 从路由重建，
    附加的查询参数会在第一次 syncUrlState 后消失，反而让「前进后退 URL 应完全一致」这类断言漂移。
    """
    cdp.command("Page.enable")
    cdp.command(
        "Page.addScriptToEvaluateOnNewDocument",
        {"source": "try{localStorage.setItem('fadian-motion','off')}catch(e){}"},
    )


def navigate(cdp: CDP, url: str) -> None:
    cdp.command("Page.navigate", {"url": url}, timeout=10)
    wait_for(cdp, "document.readyState === 'complete' || document.readyState === 'interactive'", "document ready", timeout=10)


def settle(cdp: CDP, ms: int = 350) -> None:
    cdp.command("Runtime.evaluate", {"expression": f"new Promise(r => setTimeout(r, {ms}))", "awaitPromise": True}, timeout=5)


def screenshot(cdp: CDP, out_dir: Path, name: str) -> str:
    data = cdp.command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False}, timeout=10)["data"]
    path = out_dir / f"{name}.png"
    path.write_bytes(base64.b64decode(data))
    return str(path.relative_to(out_dir.parent.parent))


def page_errors(cdp: CDP) -> list[str]:
    errors = cdp.eval("window.__qaErrors || []", timeout=3) or []
    event_errors = []
    for ev in cdp.events:
        if ev.get("method") == "Runtime.exceptionThrown":
            details = ev.get("params", {}).get("exceptionDetails", {})
            event_errors.append(details.get("text") or json.dumps(details, ensure_ascii=False))
    return [str(x) for x in errors + event_errors]


def clear_errors(cdp: CDP) -> None:
    cdp.events.clear()
    cdp.eval("window.__qaErrors = []", timeout=3)


def check_no_errors(cdp: CDP) -> None:
    errors = page_errors(cdp)
    if errors:
        raise CheckFailed("; ".join(errors[:5]))


def run_check(results: list[dict], name: str, func) -> None:
    started = time.time()
    try:
        detail = func() or {}
        results.append({"name": name, "ok": True, "seconds": round(time.time() - started, 2), "detail": detail})
        log(f"[OK] {name}")
    except Exception as exc:
        results.append({"name": name, "ok": False, "seconds": round(time.time() - started, 2), "error": str(exc)})
        log(f"[FAIL] {name}: {exc}")


def install_error_capture(cdp: CDP) -> None:
    source = r"""
(() => {
  window.__qaErrors = [];
  window.addEventListener('error', ev => {
    window.__qaErrors.push(`${ev.message || 'error'} @ ${ev.filename || ''}:${ev.lineno || 0}`);
  });
  window.addEventListener('unhandledrejection', ev => {
    window.__qaErrors.push(`unhandledrejection: ${ev.reason && (ev.reason.stack || ev.reason.message || ev.reason)}`);
  });
})();
"""
    cdp.command("Page.addScriptToEvaluateOnNewDocument", {"source": source})


def run_suite(base_url: str, out_dir: Path, cdp: CDP, only: str = "") -> list[dict]:
    base = base_url.rstrip("/") + "/"
    results: list[dict] = []
    cdp.command("Page.enable")
    cdp.command("Runtime.enable")
    cdp.command("Log.enable")
    install_error_capture(cdp)
    entry_id = first_imaged_entry_id("suozhang")
    no_original_entry_id = first_imaged_entry_id("composition_style")
    update_filters = update_filter_config("suozhang")
    # 分类下有几本是会变的（2026-09 新增《更衣人偶》），按书目现况取，别写死。
    composition_ids = [
        str(item.get("id"))
        for item in load_codex_list()
        if str(item.get("type") or "") == "composition"
    ]
    # 挑最新的、且没有条目同时带 isNew 的历史批次：后面要用它断言
    # 「选了历史批次就不该混进最新一期的卡」，选到重叠批次会把自己撞红。
    old_update = next(
        (item for item in update_filters if not item["latest"] and not item["newOverlap"]),
        next((item for item in update_filters if not item["latest"]), None),
    )
    latest_update = next((item for item in update_filters if item["latest"]), None)
    r18_update_filters = update_filter_config("suozhang_r18")
    r18_latest_update = next((item for item in r18_update_filters if item["latest"]), None)
    if not old_update or not latest_update or not r18_latest_update:
        raise RuntimeError("Expected one historical and one latest update filter for the Suozhang regression")
    # 2026-08-31 两本社区图包并成 nai45_community_pack；这三个用例只取杂图那一片，
    # 深链仍按旧 id 进（下面几处 ?codex=community_ai_misc），顺带钉住别名路由没断。
    pack_data = json.loads((ROOT / "site" / "data" / "nai45_community_pack.json").read_text(encoding="utf-8"))
    pack_entries = [
        entry for entry in (pack_data.get("entries") or [])
        if str(entry.get("id") or "").startswith("community_ai_misc-")
    ]
    artist_data = json.loads((ROOT / "site" / "data" / "artist_nai45_personal.json").read_text(encoding="utf-8"))
    legacy_artist_entry = next(
        entry for entry in (artist_data.get("entries") or [])
        if entry.get("assetCodexId") == "artist_nai45_strings"
        and (entry.get("image") or entry.get("images"))
        and list(entry.get("path") or [])[:1] == ["画风组词典"]
    )
    legacy_artist_path = list(legacy_artist_entry["path"])
    legacy_artist_source_path = legacy_artist_path[1:]
    multi_character_entry = next(
        entry for entry in pack_entries
        if entry.get("rating") == "safe" and len(entry.get("characterPrompts") or []) >= 2
    )
    negative_character_entry = next(
        entry for entry in pack_entries
        if entry.get("rating") == "safe"
        and any(item.get("negative") for item in entry.get("characterPrompts") or [])
    )
    no_character_entry = next(
        entry for entry in pack_entries
        if entry.get("rating") == "safe" and not entry.get("characterPrompts")
    )

    def assert_copy_feedback(label: str, success_fragment: str = "已复制") -> dict:
        success_literal = js_string(success_fragment)
        outcome_expr = """
(() => {
  const toast = document.querySelector('#toast')?.textContent || '';
  return toast.includes(__SUCCESS__) || toast.includes('自动复制未成功');
})()
""".replace("__SUCCESS__", success_literal)
        wait_for(cdp, outcome_expr, label, timeout=6)

        snapshot_expr = """
(() => {
  const toast = document.querySelector('#toast')?.textContent || '';
  const mask = document.querySelector('#clipboardFallback');
  return {
    toast,
    success: toast.includes(__SUCCESS__),
    failure: toast.includes('自动复制未成功'),
    fallbackVisible: Boolean(mask && !mask.hidden && mask.classList.contains('show')),
    manualText: mask?.querySelector('.clipboard-fallback-text')?.value || '',
  };
})()
""".replace("__SUCCESS__", success_literal)
        feedback = cdp.eval(snapshot_expr)
        if feedback["success"] == feedback["failure"]:
            raise CheckFailed(f"Copy feedback was not a truthful exclusive outcome: {feedback}")
        if feedback["success"] and feedback["fallbackVisible"]:
            raise CheckFailed(f"Copy claimed success while the manual fallback was open: {feedback}")
        if feedback["failure"]:
            wait_for(
                cdp,
                """(() => {
                  const mask = document.querySelector('#clipboardFallback');
                  return Boolean(
                    mask
                    && !mask.hidden
                    && mask.classList.contains('show')
                    && mask.querySelector('.clipboard-fallback-text')?.value.trim()
                  );
                })()""",
                f"{label} manual fallback",
                timeout=6,
            )
            feedback = cdp.eval(snapshot_expr)
            if feedback["success"] or not feedback["fallbackVisible"] or not feedback["manualText"].strip():
                raise CheckFailed(f"Failed copy did not expose a truthful manual fallback: {feedback}")

        manual_text = feedback.pop("manualText", "") or ""
        feedback["manualLength"] = len(manual_text)
        if feedback["fallbackVisible"]:
            cdp.eval("document.querySelector('#clipboardFallback [data-clipboard-close]')?.click()")
            wait_for(
                cdp,
                "document.querySelector('#clipboardFallback')?.hidden === true && !document.querySelector('#clipboardFallback')?.classList.contains('show')",
                f"{label} fallback close",
                timeout=6,
            )
            feedback["fallbackClosed"] = True
        return feedback

    def desktop_load():
        cdp.command("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 720, "deviceScaleFactor": 1, "mobile": False})
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "desktop cards")
        settle(cdp)
        info = cdp.eval("({title: document.title, cards: document.querySelectorAll('.card').length, result: document.querySelector('#resultInfo')?.textContent || '', overlay: /Vite|Webpack|Next\\.js|Error Overlay/i.test(document.body.textContent)})")
        if info["overlay"]:
            raise CheckFailed("Framework error overlay text was found")
        check_no_errors(cdp)
        shot = screenshot(cdp, out_dir, "desktop-home")
        return {**info, "screenshot": shot}

    def tag_relay_responsive():
        """Exercise the relay as dock, drawer, and bottom sheet with real geometry."""
        fixture = {
            "version": 3,
            # 一屏化之后素材区必须一起验：它和编排区共用同一列高度，
            # 空着的话「两个分区同屏」这条断言等于只验了一半。
            "inbox": [{
                "key": f"entry:qa:{index}",
                "codexId": "qa",
                "entryId": f"qa-{index}",
                "title": title,
                "prompt": f"style sample {index}, soft lighting",
                "negative": "lowres" if index % 2 == 0 else "",
                "book": "UI 回归法典",
                "path": ["各种风格"],
                "image": "",
                "access": {"nsfw": False, "r18g": False},
                "accessKnown": True,
                "addedAt": "2026-08-19T00:00:00.000Z",
            } for index, title in enumerate([
                "厚涂 · 油画质感", "赛博霓虹", "水彩淡彩",
                "胶片颗粒", "日系动画风", "逆光剪影",
            ], start=1)],
            "plans": [{
                "id": "qa-plan",
                "name": "UI 回归方案",
                "items": [{
                    "id": f"qa-block-{index}",
                    "kind": "block",
                    "nodeType": "group",
                    "channel": "positive",
                    "access": {"nsfw": False, "r18g": False},
                    "accessKnown": True,
                    "title": f"测试块 {index}",
                    "prompt": f"portrait test segment {index}, detailed lighting, balanced composition",
                    "negative": f"artifact {index}, low quality",
                    "weight": 1,
                    "enabled": True,
                } for index in range(1, 9)],
                "createdAt": "2026-08-19T00:00:00.000Z",
                "updatedAt": "2026-08-19T00:00:00.000Z",
            }, {
                "id": "qa-plan-alt",
                "name": "UI 空方案",
                "items": [],
                "createdAt": "2026-08-19T00:00:00.000Z",
                "updatedAt": "2026-08-19T00:00:00.000Z",
            }],
            "activePlanId": "qa-plan",
            "history": [],
        }

        # Establish the origin before writing localStorage, then reload so the
        # store module reads the fixture rather than retaining its first load.
        cdp.command("Emulation.setDeviceMetricsOverride", {
            "width": 1440, "height": 820, "deviceScaleFactor": 1, "mobile": False,
        })
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "relay fixture app")
        cdp.eval(
            "localStorage.removeItem('fadian-tag-relay-v4'); localStorage.setItem('fadian-tag-relay-v3', "
            + js_string(json.dumps(fixture, ensure_ascii=False))
            + "); localStorage.setItem('fadian-tag-relay-rail', 'closed');"
            + " localStorage.setItem('fadian-onboarding-v1-done', '1'); true"
        )
        cdp.command("Page.reload", {})
        wait_for(
            cdp,
            "document.querySelectorAll('.card').length >= 1"
            " && document.querySelector('#tagRelayRail')?.classList.contains('closed')"
            " && document.querySelector('#tagRelayRail')?.inert === true",
            "relay fixture reload",
            timeout=15,
        )

        def assert_relay_undo_toast(label: str, expected_message: str = "已移出方案") -> dict:
            wait_for(
                cdp,
                "document.querySelector('#toast')?.classList.contains('show')"
                " && document.querySelector('#toast')?.classList.contains('has-action')"
                " && document.querySelector('#toast .toast-action')?.textContent.trim() === '撤销'",
                label,
            )
            data = cdp.eval(r"""
(() => {
  const toast = document.querySelector('#toast');
  const message = toast?.querySelector('.toast-message');
  const action = toast?.querySelector('.toast-action');
  const rect = toast?.getBoundingClientRect();
  const actionRect = action?.getBoundingClientRect();
  return {
    message: message?.textContent.trim() || '',
    action: action?.textContent.trim() || '',
    width: rect?.width || 0,
    height: rect?.height || 0,
    left: rect?.left ?? -1,
    right: rect?.right ?? -1,
    top: rect?.top ?? -1,
    bottom: rect?.bottom ?? -1,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    actionWidth: actionRect?.width || 0,
    actionHeight: actionRect?.height || 0,
    actionInside: Boolean(
      rect && actionRect
      && actionRect.left >= rect.left - 1
      && actionRect.right <= rect.right + 1
      && actionRect.top >= rect.top - 1
      && actionRect.bottom <= rect.bottom + 1
    ),
  };
})()
""")
            max_compact_width = min(280, data["viewportWidth"] - 24)
            if (
                expected_message not in data["message"]
                or data["action"] != "撤销"
                or data["width"] <= 0
                or data["width"] > max_compact_width + 1
                or data["height"] < 36
                or data["height"] > 45
                or data["left"] < 11
                or data["right"] > data["viewportWidth"] - 11
                or data["top"] < 8
                or data["bottom"] > data["viewportHeight"] - 8
                or data["actionWidth"] < 36
                or data["actionHeight"] < 36
                or not data["actionInside"]
            ):
                raise CheckFailed(f"{label} is oversized or outside the viewport: {data}")
            return data

        cases = [
            ("dock", 1440, 820, False, "dock"),
            # 1240px 以下必须转抽屉；继续停靠会把 440px 侧栏与 248px 目录
            # 同时压进页面，让主瀑布流退化成单列。
            ("edge-drawer", 1220, 720, False, "drawer"),
            ("drawer", 900, 620, False, "drawer"),
            ("sheet-boundary", 600, 760, False, "sheet"),
            ("sheet", 390, 640, True, "sheet"),
            ("sheet-short", 390, 600, True, "sheet"),
            ("sheet-small", 320, 640, True, "sheet"),
        ]
        details = {}
        shots = []

        for mode, width, height, mobile, shape in cases:
            clear_errors(cdp)
            cdp.command("Emulation.setDeviceMetricsOverride", {
                "width": width,
                "height": height,
                "deviceScaleFactor": 1,
                "mobile": mobile,
            })
            wait_for(cdp, f"innerWidth === {width} && innerHeight === {height}", f"relay {mode} viewport")
            settle(cdp, 120)

            cdp.eval("document.querySelector('#tagRelayBtn')?.click()")
            wait_for(
                cdp,
                "!document.querySelector('#tagRelayRail')?.classList.contains('closed')"
                " && document.querySelector('#tagRelayBtn')?.getAttribute('aria-expanded') === 'true'"
                " && document.querySelector('#tagRelayRail')?.inert === false",
                f"relay {mode} opens",
            )
            settle(cdp, 160)

            shell = cdp.eval(r"""
(() => {
  const rail = document.querySelector('#tagRelayRail');
  const main = document.querySelector('#main');
  const backdrop = document.querySelector('#tagRelayRailBackdrop');
  const sourceTabs = document.querySelector('.tag-relay-source-tabs');
  const sourceList = document.querySelector('#relaySourceList');
  const firstSourceChip = sourceList.querySelector('.tag-relay-chip');
  const sourceButtons = [...sourceTabs.querySelectorAll('[role="tab"]')];
  const sourceSlider = sourceTabs.querySelector('.tag-relay-source-slider');
  const planPicker = document.querySelector('#relayPlanPickerBtn');
  const planSelect = document.querySelector('#relayPlanSelect');
  const planList = document.querySelector('#relayPlanList');
  const rr = rail.getBoundingClientRect();
  const mr = main.getBoundingClientRect();
  const sr = sourceTabs.getBoundingClientRect();
  const clientWidth = document.documentElement.clientWidth;
  const first = sourceButtons[0]?.getBoundingClientRect();
  const last = sourceButtons.at(-1)?.getBoundingClientRect();
  const sourceSliderRect = sourceSlider?.getBoundingClientRect();
  const planPickerRect = planPicker?.getBoundingClientRect();
  const planSelectRect = planSelect?.getBoundingClientRect();
  const sourceListRect = sourceList.getBoundingClientRect();
  const firstSourceRect = firstSourceChip?.getBoundingClientRect();
  const relayFloat = document.querySelector('#tagRelayBtn');
  const randomFloat = document.querySelector('#randomBtn');
  const relayFloatRect = relayFloat?.getBoundingClientRect();
  const visibleFloatRects = [...document.querySelectorAll('.float-actions .float-btn')]
    .filter(button => button !== relayFloat)
    .filter(button => {
      const style = getComputedStyle(button);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > .01;
    })
    .map(button => button.getBoundingClientRect());
  const relayFloatStyle = relayFloat ? getComputedStyle(relayFloat) : null;
  const randomFloatStyle = randomFloat ? getComputedStyle(randomFloat) : null;
  return {
    position: getComputedStyle(rail).position,
    rail: {left: rr.left, top: rr.top, right: rr.right, bottom: rr.bottom, width: rr.width},
    main: {left: mr.left, right: mr.right, width: mr.width},
    backdropDisplay: getComputedStyle(backdrop).display,
    role: rail.getAttribute('role'),
    ariaModal: rail.getAttribute('aria-modal'),
    docked: document.body.classList.contains('rail-docked'),
    planZoneH: document.querySelector('.tag-relay-zone-plan')?.getBoundingClientRect().height || 0,
    sourceZoneH: document.querySelector('.tag-relay-zone-source')?.getBoundingClientRect().height || 0,
    planChips: document.querySelectorAll('#relayPlanLane .relay-editor-surface:not([hidden]) .relay-token.is-fold').length,
    sourceChips: document.querySelectorAll('#relaySourceList .tag-relay-chip').length,
    sourceListH: sourceListRect.height,
    firstSourceFullyVisible: !!firstSourceRect
      && firstSourceRect.height >= 29
      && firstSourceRect.top >= sourceListRect.top - 1
      && firstSourceRect.bottom <= Math.min(sourceListRect.bottom, innerHeight) + 1,
    outputCollapsed: document.querySelector('#relayOutputBoxes')?.hidden === true
      && getComputedStyle(document.querySelector('#relayOutputBoxes')).display === 'none',
    sourceTabCount: sourceButtons.length,
    sourceTabWidthDelta: first && last ? Math.abs(first.width - last.width) : 999,
    sourceRightGap: last ? Math.abs(sr.right - last.right) : 999,
    sourceSliderLeft: sourceSliderRect?.left ?? -1,
    sourceSliderWidth: sourceSliderRect?.width || 0,
    planPickerVisible: Boolean(
      planPickerRect
      && planPickerRect.width > 20
      && planPickerRect.height > 20
      && getComputedStyle(planPicker).display !== 'none'
      && getComputedStyle(planPicker).visibility !== 'hidden'
    ),
    planSelectHidden: Boolean(
      planSelect
      && planSelect.getAttribute('aria-hidden') === 'true'
      && planSelect.tabIndex === -1
      && planSelectRect
      && planSelectRect.width <= 2
      && planSelectRect.height <= 2
    ),
    planListInitiallyHidden: planList?.hidden === true
      && getComputedStyle(planList).display === 'none',
    relayFloatTopmost: Boolean(relayFloatRect)
      && visibleFloatRects.every(rect => relayFloatRect.bottom <= rect.top + 1),
    relayFloatMatchesGroup: Boolean(relayFloatStyle && randomFloatStyle)
      && relayFloatStyle.width === randomFloatStyle.width
      && relayFloatStyle.height === randomFloatStyle.height
      && relayFloatStyle.borderRadius === randomFloatStyle.borderRadius
      && relayFloatStyle.borderColor === randomFloatStyle.borderColor
      && relayFloatStyle.backgroundColor === randomFloatStyle.backgroundColor
      && relayFloatStyle.color === randomFloatStyle.color,
    documentOverflow: document.scrollingElement.scrollWidth - clientWidth,
    clientWidth,
    /* html uses scrollbar-gutter:stable. Fixed drawers are therefore positioned
       against its scrollport, which is narrower than window.innerWidth on desktop. */
    viewportRight: document.documentElement.getBoundingClientRect().right,
  };
})()
""")
            # 一屏化的核心不变式：素材与编排必须同时可见，不再有「当前页签」。
            if shell["planZoneH"] < 40 or shell["sourceZoneH"] < 40:
                raise CheckFailed(f"Relay {mode} does not show both zones at once: {shell}")
            if shell["planChips"] < 1 or shell["sourceChips"] < 1:
                raise CheckFailed(f"Relay {mode} did not render chips in both zones: {shell}")
            if shell["sourceListH"] < 30 or not shell["firstSourceFullyVisible"]:
                raise CheckFailed(f"Relay {mode} does not leave one complete clickable source row: {shell}")
            if not shell["outputCollapsed"]:
                raise CheckFailed(f"Relay {mode} output should start collapsed: {shell}")
            if shell["sourceTabCount"] != 2 or shell["sourceTabWidthDelta"] > 2 or shell["sourceRightGap"] > 8:
                raise CheckFailed(f"Relay {mode} source tabs do not fill two equal segments: {shell}")
            if (
                not shell["planPickerVisible"]
                or not shell["planSelectHidden"]
                or not shell["planListInitiallyHidden"]
            ):
                raise CheckFailed(f"Relay {mode} plan picker did not replace the legacy select cleanly: {shell}")
            if shell["sourceSliderWidth"] <= 8:
                raise CheckFailed(f"Relay {mode} source slider has no usable geometry: {shell}")
            if not shell["relayFloatTopmost"] or not shell["relayFloatMatchesGroup"]:
                raise CheckFailed(f"Relay {mode} floating entry is not the topmost matching quick action: {shell}")
            if shell["documentOverflow"] > 1:
                raise CheckFailed(f"Relay {mode} causes horizontal page overflow: {shell}")

            if shape == "dock":
                if (
                    shell["position"] != "sticky"
                    or not 430 <= shell["rail"]["width"] <= 450
                    or shell["main"]["right"] > shell["rail"]["left"] + 2
                    or shell["backdropDisplay"] != "none"
                    or shell["role"] is not None
                    or shell["ariaModal"] is not None
                    or not shell["docked"]
                ):
                    raise CheckFailed(f"Relay desktop dock shape is wrong: {shell}")
            elif shape == "drawer":
                if (
                   shell["position"] != "fixed"
                   or not 430 <= shell["rail"]["width"] <= 450
                    or abs(shell["rail"]["right"] - (shell["viewportRight"] - 8)) > 2
                   or shell["backdropDisplay"] == "none"
                   or shell["role"] != "dialog"
                    or shell["ariaModal"] != "true"
                    or shell["docked"]
                ):
                    raise CheckFailed(f"Relay tablet drawer shape is wrong: {shell}")
            else:
                if (
                   shell["position"] != "fixed"
                   or abs(shell["rail"]["left"]) > 2
                    or abs(shell["rail"]["right"] - shell["viewportRight"]) > 2
                   or abs(shell["rail"]["bottom"] - height) > 2
                   or shell["rail"]["top"] < 36
                    or shell["backdropDisplay"] == "none"
                    or shell["role"] != "dialog"
                    or shell["ariaModal"] != "true"
                    or shell["docked"]
                ):
                    raise CheckFailed(f"Relay mobile sheet shape is wrong: {shell}")

            # Collapsing gives the editor the released space and retains two
            # wrapped source rows. Hidden rows are not focusable.
            shelf = cdp.eval(r"""
(() => {
 const rail=document.querySelector('#tagRelayRail'),list=document.querySelector('#relaySourceList');
 const items=[...list.children],rows=[...new Set(items.map(e=>e.offsetTop))].sort((a,b)=>a-b);
 const visible=items.filter(e=>!e.inert),cutoff=rows[1]??rows[0];
 const panel=document.querySelector('#relaySourcePanel').getBoundingClientRect();
 const bottom=Math.max(...visible.map(e=>e.getBoundingClientRect().bottom));
 return {rows:rows.length,visibleRows:new Set(visible.map(e=>e.offsetTop)).size,
   firstTwoComplete:items.filter(e=>e.offsetTop<=cutoff).every(e=>!e.inert&&e.getBoundingClientRect().bottom<=panel.bottom+1),
   clippedInert:items.filter(e=>e.offsetTop>cutoff).every(e=>e.inert&&e.getAttribute('aria-hidden')==='true'),
   blankBelowRows:rail.getBoundingClientRect().bottom-bottom,
   collapsedHeight:rail.getBoundingClientRect().height,
   collapsedPlanHeight:rail.querySelector('.tag-relay-zone-plan').getBoundingClientRect().height,
   canExpand:!document.querySelector('#relayShelfToggle').hidden};
})()
""")
            if shelf['visibleRows'] != min(2, shelf['rows']) or not shelf['firstTwoComplete'] or not shelf['clippedInert']:
                raise CheckFailed(f"Relay {mode} collapsed source rows are clipped or focusable: {shelf}")
            if not 0 <= shelf['blankBelowRows'] <= 18:
                raise CheckFailed(f"Relay {mode} collapsed rail retained blank space: {shelf}")
            if shelf['canExpand']:
                cdp.eval("document.querySelector('#relayShelfToggle').click()")
                wait_for(cdp, "[...document.querySelectorAll('#relaySourceList>*')].every(e=>!e.inert&&e.getAttribute('aria-hidden')!== 'true')", f"relay {mode} expanded sources accessible")
                settle(cdp, 120)
                shelf['expandedHeight'] = cdp.eval("document.querySelector('#tagRelayRail').getBoundingClientRect().height")
                shelf['expandedPlanHeight'] = cdp.eval("document.querySelector('.tag-relay-zone-plan').getBoundingClientRect().height")
                if abs(shelf['collapsedHeight'] - shelf['expandedHeight']) > 1 or shelf['collapsedPlanHeight'] < shelf['expandedPlanHeight']:
                    raise CheckFailed(f"Relay {mode} shelf collapse shrank the rail instead of giving space to the editor: {shelf}")
                cdp.eval("document.querySelector('#relayShelfToggle').click()")
                wait_for(cdp, "document.querySelector('.tag-relay-zone-source').classList.contains('is-peek') && [...document.querySelectorAll('#relaySourceList>*')].some(e=>e.inert)", f"relay {mode} shelf recollapse")
                settle(cdp, 120)

            cdp.eval("document.querySelector('#relayPlanPickerBtn')?.click()")
            wait_for(cdp, "document.querySelector('#relayPlanList')?.hidden === false", f"relay {mode} plan picker")
            options = cdp.eval("document.querySelectorAll('#relayPlanList [role=option]').length")
            if options != 2:
                raise CheckFailed(f"Relay {mode} migrated plan options are missing: {options}")
            cdp.eval("document.querySelector('#relayPlanList [data-value=\"qa-plan-alt\"]')?.click()")
            wait_for(cdp, "document.querySelector('#relayPlanSelect')?.value === 'qa-plan-alt' && document.querySelector('#relayPlanLane .relay-editor-surface:not([hidden]) textarea')?.value === ''", f"relay {mode} empty plan")
            cdp.eval("document.querySelector('#relayPlanPickerBtn')?.click(); document.querySelector('#relayPlanList [data-value=\"qa-plan\"]')?.click()")
            wait_for(cdp, "document.querySelector('#relayPlanSelect')?.value === 'qa-plan' && document.querySelectorAll('#relayPlanLane .relay-editor-surface:not([hidden]) .relay-token.is-fold').length === 8", f"relay {mode} restored plan")

            # The source chip inserts one fold; its source remains available.
            original = cdp.eval("document.querySelector('#relayPlanLane .relay-editor-surface:not([hidden]) textarea').value")
            cdp.eval("document.querySelector('#relaySourceList .tag-relay-chip-main')?.click()")
            wait_for(cdp, "document.querySelectorAll('#relayPlanLane .relay-editor-surface:not([hidden]) .relay-token.is-fold').length === 9", f"relay {mode} source insertion")
            cdp.eval("import('./assets/app/tag-relay-compose.js').then(module => module.flushCompose())")
            wait_for(cdp, "JSON.parse(localStorage.getItem('fadian-tag-relay-v4') || '{}').plans?.find(plan => plan.id === 'qa-plan')?.positive.text.includes('厚涂')", f"relay {mode} source persisted")

            # Undo is the editor's existing text operation, not removed chip UI.
            cdp.eval("(() => { const input = document.querySelector('#relayPlanLane .relay-editor-surface:not([hidden]) textarea'); input.focus(); document.execCommand('undo'); })()")
            wait_for(cdp, "document.querySelector('#relayPlanLane .relay-editor-surface:not([hidden]) textarea').value === " + js_string(original), f"relay {mode} native undo insertion")

            # Keyboard selection opens the same contextual actions as a single
            # click; double-click expansion is covered by verify_relay_editor.
            cdp.eval(r"""
(() => {
 const input = document.querySelector('#relayPlanLane .relay-editor-surface:not([hidden]) textarea');
 input.focus(); input.setSelectionRange(0, 0);
 input.dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true}));
 input.dispatchEvent(new KeyboardEvent('keyup', {key:'Home', bubbles:true}));
 [...document.querySelectorAll('.relay-token-panel button')].find(button => button.textContent === '展开')?.click();
})()
""")
            wait_for(cdp, "document.querySelector('#relayPlanLane .relay-editor-surface:not([hidden]) textarea').value.includes('portrait test segment 1')", f"relay {mode} expand fold")
            undo = assert_relay_undo_toast(f"relay {mode} expand undo toast", "已展开")
            cdp.eval("document.querySelector('#toast .toast-action')?.click()")
            wait_for(cdp, "document.querySelector('#relayPlanLane .relay-editor-surface:not([hidden]) textarea').value === " + js_string(original), f"relay {mode} toast undo fold")

            compose = cdp.eval(r"""
(() => {
 const rail = document.querySelector('#tagRelayRail'), rect = rail.getBoundingClientRect();
 const surface = rail.querySelector('.relay-editor-surface:not([hidden])');
 const input = surface.querySelector('textarea'), mirror = surface.querySelector('.relay-editor-mirror');
 const keys = ['fontFamily','fontSize','fontWeight','fontStyle','fontStretch','fontVariant','lineHeight','letterSpacing','wordSpacing','textTransform','textIndent','textAlign','whiteSpace','overflowWrap','wordBreak','tabSize','boxSizing','paddingTop','paddingRight','paddingBottom','paddingLeft','borderWidth'];
 const a = getComputedStyle(input), b = getComputedStyle(mirror);
 const copyButton = rail.querySelector('.tag-relay-copy-main'), copy = copyButton.getBoundingClientRect();
 return {
   matchedCss: keys.filter(key => a[key] === b[key]).length,
   mismatchedCss: keys.filter(key => a[key] !== b[key]),
   contentWidthDelta: Math.abs(input.clientWidth - mirror.clientWidth),
   nativeEditor: input.tagName === 'TEXTAREA' && input.value.includes('\u200b#'),
   documentOverflow: document.scrollingElement.scrollWidth - document.documentElement.clientWidth,
   editorOverflow: surface.scrollWidth - surface.clientWidth,
   inputFillsSurface: input.getBoundingClientRect().height >= surface.getBoundingClientRect().height - 1,
   copyVisible: copy.left >= rect.left - 1 && copy.right <= rect.right + 1 && copy.top >= 0 && copy.bottom <= innerHeight + 1,
   sourceVisible: rail.querySelector('.tag-relay-zone-source').getBoundingClientRect().height >= 30,
   caption: copyButton.textContent,
   mainAction: copyButton.id,
   secondaryCaption: rail.querySelector('#relayCopyAll').textContent.trim(),
   summary: rail.querySelector('#relayOutputSummary').textContent.trim(),
   contextualActions: !rail.querySelector('.relay-token-actions-toggle') && !rail.querySelector('#relayAddBlock'),
   unifiedFrame: getComputedStyle(rail.querySelector('.relay-editor')).borderTopWidth === '1px'
     && rail.querySelector('.relay-editor').contains(rail.querySelector('[role=tablist]')),
 };
})()
""")
            if compose["matchedCss"] != 22 or compose["contentWidthDelta"] > 1:
                raise CheckFailed(f"Relay {mode} mirror/input alignment differs: {compose}")
            if not compose["nativeEditor"] or not compose["copyVisible"] or not compose["contextualActions"] or not compose["unifiedFrame"] or not compose["inputFillsSurface"]:
                raise CheckFailed(f"Relay {mode} editor/copy actions are inaccessible: {compose}")
            if compose["documentOverflow"] > 1 or compose["editorOverflow"] > 1:
                raise CheckFailed(f"Relay {mode} horizontal overflow: {compose}")
            if compose["mainAction"] != "relayCopyPositive" or "复制正向提示词" not in compose["caption"] or compose["secondaryCaption"] != "复制全部提示词" or not re.fullmatch(r"(NAI|SD|纯文本) · (逗号|逗号换行)", compose["summary"]):
                raise CheckFailed(f"Relay {mode} output labels differ: {compose}")
            shots.append(screenshot(cdp, out_dir, f"tag-relay-{mode}"))

            # Closing and reopening must not discard the input's unblurred tail.
            tail = f", tail-{mode}"
            cdp.eval("(() => { const input = document.querySelector('#relayPlanLane .relay-editor-surface:not([hidden]) textarea'); input.focus(); input.setSelectionRange(input.value.length,input.value.length); })()")
            cdp.command("Input.insertText", {"text": tail})
            cdp.eval("document.querySelector('#tagRelayRailClose')?.click()")
            wait_for(cdp, "document.querySelector('#tagRelayRail')?.inert === true", f"relay {mode} close inert")
            cdp.eval("document.querySelector('#tagRelayBtn')?.click()")
            wait_for(cdp, "document.querySelector('#relayPlanLane .relay-editor-surface:not([hidden]) textarea').value.endsWith(" + js_string(tail) + ")", f"relay {mode} close preserves tail")
            cdp.eval("(() => { const input = document.querySelector('#relayPlanLane .relay-editor-surface:not([hidden]) textarea'); input.focus(); document.execCommand('undo'); })()")
            wait_for(cdp, "document.querySelector('#relayPlanLane .relay-editor-surface:not([hidden]) textarea').value === " + js_string(original), f"relay {mode} restore fixture")
            cdp.eval("document.querySelector('#tagRelayRailClose')?.click()")
            wait_for(cdp, "document.querySelector('#tagRelayRail')?.inert === true && document.querySelector('#tagRelayRail')?.getAttribute('aria-hidden') === 'true'", f"relay {mode} final close")
            check_no_errors(cdp)
            details[mode] = {"shell": shell, "shelf": shelf, "compose": compose, "expandUndoToast": undo}

        # A keyboard-sized viewport must keep a usable editor even with token
        # actions open. The whole rail may scroll when all controls cannot fit.
        cdp.command("Emulation.setDeviceMetricsOverride", {"width":390,"height":440,"deviceScaleFactor":1,"mobile":True})
        cdp.eval("(() => {document.querySelector('#tagRelayBtn').click(); const i=document.querySelector('.relay-editor-surface:not([hidden]) textarea'); i.focus(); i.setSelectionRange(0,i.value.length)})()")
        cdp.command("Input.insertText", {"text":"blue sky, forest, soft lighting"})
        cdp.eval("(() => {const i=document.querySelector('.relay-editor-surface:not([hidden]) textarea'); i.setSelectionRange(2,2); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true})); i.dispatchEvent(new KeyboardEvent('keyup',{key:'Home',bubbles:true}))})()")
        settle(cdp, 120)
        short = cdp.eval(r"""
(() => {
 const rail=document.querySelector('#tagRelayRail'),surface=rail.querySelector('.relay-editor-surface:not([hidden])');
 const r=surface.getBoundingClientRect(),panel=rail.querySelector('.relay-token-panel');
 return {editorHeight:r.height,editorTop:r.top,editorBottom:r.bottom,panelVisible:!panel.hidden,
   railScrollable:rail.scrollHeight>rail.clientHeight&&getComputedStyle(rail).overflowY==='auto'};
})()
""")
        if short['editorHeight'] < 56 or short['editorTop'] < 0 or short['editorBottom'] > 440 or not short['panelVisible'] or not short['railScrollable']:
            raise CheckFailed(f"Relay short viewport squeezed away the editor: {short}")
        shots.append(screenshot(cdp, out_dir, 'tag-relay-keyboard-height'))
        cdp.eval("document.querySelector('#relayCopyPositive').scrollIntoView({block:'nearest'})")
        short['copyReachable'] = cdp.eval("(() => {const r=document.querySelector('#relayCopyPositive').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()")
        if not short['copyReachable']:
            raise CheckFailed(f"Relay short viewport copy button is unreachable: {short}")
        check_no_errors(cdp)
        return {"viewports": details, "shortViewport": short, "screenshots": shots}

    def announcements_panel():
        clear_errors(cdp)
        cdp.command("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 900, "deviceScaleFactor": 1, "mobile": False})
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "app before announcements")
        cdp.eval("document.querySelector('#announcementsBtn')?.click()")
        # ⚠ 桌面宽度下这颗按钮开的是顶栏动态气泡，不是三页签面板（见 ui.js 的 announceBtn.onclick）；
        #    面板要再点气泡里的「公告」才进。移动端才是一步直达。
        wait_for(
            cdp,
            "!document.querySelector('#updatesPopover')?.hidden",
            "updates popover",
            timeout=12,
        )
        cdp.eval("document.querySelector('#updatesPopover [data-updates-open=\"announcements\"]')?.click()")
        wait_for(cdp, "!document.querySelector('#announcementsPanel')?.hidden && document.querySelectorAll('.announcement-item').length >= 2", "announcements panel", timeout=12)
        settle(cdp, 280)
        data = cdp.eval("""
(() => {
  const panel = document.querySelector('#announcementsPanel .announcements-panel');
  const items = [...document.querySelectorAll('.announcement-item')];
  const probe = items.map(item => ({
    title: item.querySelector('h3')?.textContent.trim() || '',
    lead: item.querySelector('.announcement-lead strong')?.textContent.trim() || '',
    icon: item.querySelector('.announcement-icon')?.dataset.icon || '',
    iconSvg: Boolean(item.querySelector('.announcement-icon svg')),
    bodyLen: (item.querySelector('.announcement-body')?.textContent || '').trim().length,
  }));
  return {
    count: items.length,
    titled: probe.filter(item => item.title).length,
    leaded: probe.filter(item => item.lead).length,
    iconed: probe.filter(item => item.icon && item.iconSvg).length,
    bodied: probe.filter(item => item.bodyLen > 0).length,
    longestBody: probe.reduce((max, item) => Math.max(max, item.bodyLen), 0),
    icons: probe.map(item => item.icon),
    horizontalOverflow: panel ? panel.scrollWidth > panel.clientWidth + 1 : true,
  };
})()
""")
        # ⚠ 不要再断言具体公告的标题 / 顺序 / 正文原句。公告是维护者随时会改的**数据**，
        #   把文案写死意味着每编辑一次公告这条检查就红一次（2026-08 新增一条公告后就红了），
        #   而它真正要守的是**渲染契约**：每条都得渲染出标题、图标 svg 与正文，
        #   强调 lead 的 <strong> 通路还在，面板不横向溢出。
        if data["count"] < 2:
            raise CheckFailed(f"Announcements panel rendered too few items: {data}")
        if data["titled"] != data["count"] or data["bodied"] != data["count"]:
            raise CheckFailed(f"Some announcements rendered without a title or body: {data}")
        if data["iconed"] != data["count"]:
            raise CheckFailed(f"Announcement icons did not render as svg: {data}")
        if data["leaded"] < 1:
            raise CheckFailed(f"No announcement kept its <strong> lead emphasis: {data}")
        if data["longestBody"] < 40:
            raise CheckFailed(f"Announcement body text looks truncated: {data}")
        if data["horizontalOverflow"]:
            raise CheckFailed("Announcements panel has horizontal overflow")
        shot = screenshot(cdp, out_dir, "announcements-feedback-collaboration")
        cdp.eval("document.querySelector('#announcementsClose')?.click()")
        wait_for(cdp, "document.querySelector('#announcementsPanel')?.hidden === true", "close announcements")
        check_no_errors(cdp)
        return {**data, "screenshot": shot}

    def feedback_panel_responsive():
        def stub_public_feedback():
            cdp.eval(r"""
(() => {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!url.includes('/api/feedback-public')) return originalFetch(input, init);
    const now = Date.now();
    const progress = [
      ['unread', '待查看'],
      ['accepted', '已受理'],
      ['investigating', '调查中'],
      ['in_progress', '处理中'],
      ['completed', '已完成'],
      ['declined', '暂不采纳'],
    ];
    return Promise.resolve(new Response(JSON.stringify({
      ok: true,
      updatedAt: now,
      summary: {total: 6, open: 4, closed: 2},
      items: progress.map(([progressStatus, progressStatusLabel], index) => ({
        id: `qa-public-feedback-${index}`,
        type: 'suggestion',
        typeLabel: '建议 / 想法',
        description: index
          ? `用于验证高密度方形布局的公开反馈 ${index + 1}。`
          : '希望处理进度在手机上也能清晰查看。',
        progressStatus,
        progressStatusLabel,
        progressDescription: '维护者尚未查看这条反馈。',
        adminReply: index ? '' : '已收到，正在安排检查。',
        createdAt: now - ((index + 1) * 60000),
        progressStatusUpdatedAt: now,
        replyUpdatedAt: now,
        updatedAt: now - (index * 60000),
        context: {
          codex: {id: 'qa', title: '回归测试法典'},
          entry: {id: `entry-qa-${index}`, title: `响应式反馈 ${index + 1}`, path: ['体验', '反馈']},
        },
      })),
    }), {headers: {'content-type': 'application/json'}}));
  };
  return true;
})()
""")

        def open_feedback():
            cdp.eval("document.querySelector('#moreBtn')?.click()")
            wait_for(cdp, "document.querySelector('#moreMenu')?.hidden === false", "feedback menu")
            settle(cdp, 100)
            cdp.eval("document.querySelector('#globalReportBtn')?.click()")
            wait_for(
                cdp,
                "document.querySelector('#feedbackPanel')?.classList.contains('show') && document.querySelector('#feedbackSubmitTab')?.getAttribute('aria-selected') === 'true' && document.querySelector('#moreMenu')?.hidden === true",
                "feedback submit panel",
            )

        clear_errors(cdp)
        cdp.command("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 720, "deviceScaleFactor": 1, "mobile": False})
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "desktop app before feedback")
        stub_public_feedback()
        open_feedback()
        desktop = cdp.eval(r"""
(() => {
  const panel = document.querySelector('#feedbackPanel .feedback-panel');
  return {
    menuTitle: document.querySelector('#globalReportBtn b')?.textContent.trim() || '',
    menuSubtitle: document.querySelector('#globalReportBtn small')?.textContent.trim() || '',
    tabs: [...document.querySelectorAll('[data-feedback-tab]')].map(tab => tab.textContent.trim()),
    selected: document.querySelector('[data-feedback-tab][aria-selected="true"]')?.dataset.feedbackTab || '',
    privacyOptionPresent: Boolean(document.querySelector('#feedbackPrivate, .feedback-privacy-optout')),
    contactPlaceholder: document.querySelector('#feedbackContact')?.getAttribute('placeholder') || '',
    progressIntro: document.querySelector('.feedback-progress-intro span')?.textContent.trim() || '',
    panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : 999,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
})()
""")
        if desktop["menuTitle"] != "反馈与进度" or desktop["menuSubtitle"] != "提交反馈 · 查看处理进展":
            raise CheckFailed(f"Feedback menu wording mismatch: {desktop}")
        if (
            len(desktop["tabs"]) != 2
            or desktop["tabs"][0] != "提交反馈"
            or not desktop["tabs"][1].startswith("处理进度")  # 进度 tab 可带「已结案/总数」计数徽标
            or desktop["selected"] != "submit"
            or desktop["privacyOptionPresent"]
            or desktop["contactPlaceholder"] != "QQ / 邮箱等"
            or desktop["progressIntro"] != "这里只展示由维护者确认公开的反馈、处理进度和回复。"
        ):
            raise CheckFailed(f"Feedback submit defaults mismatch: {desktop}")
        if desktop["panelOverflow"] > 1 or desktop["pageOverflow"] > 1:
            raise CheckFailed(f"Desktop feedback panel overflowed: {desktop}")
        cdp.eval("document.querySelector('#feedbackProgressRefresh')?.setAttribute('aria-busy', 'true')")
        settle(cdp, 120)
        refresh_busy = cdp.eval(r"""
(() => {
  const button = document.querySelector('#feedbackProgressRefresh');
  const icon = button?.querySelector('span');
  const buttonStyle = button ? getComputedStyle(button) : null;
  const iconStyle = icon ? getComputedStyle(icon) : null;
  return {
    buttonAnimation: buttonStyle?.animationName || '',
    buttonTransform: buttonStyle?.transform || '',
    iconAnimation: iconStyle?.animationName || '',
    buttonOverflow: button ? button.scrollWidth - button.clientWidth : 999,
  };
})()
""")
        cdp.eval("document.querySelector('#feedbackProgressRefresh')?.removeAttribute('aria-busy')")
        if (
            refresh_busy["buttonAnimation"] != "none"
            or refresh_busy["buttonTransform"] != "none"
            or refresh_busy["iconAnimation"] != "feedbackSpin"
            or refresh_busy["buttonOverflow"] > 1
        ):
            raise CheckFailed(f"Feedback refresh should spin only its icon: {refresh_busy}")
        cdp.eval("document.querySelector('#feedbackProgressTab')?.click()")
        wait_for(cdp, "document.querySelectorAll('.feedback-public-card').length === 6", "desktop public feedback")
        desktop_grid = cdp.eval(r"""
(() => {
  const list = document.querySelector('#feedbackPublicList');
  const cards = [...document.querySelectorAll('.feedback-public-card')];
  const columns = getComputedStyle(list).gridTemplateColumns.split(/\s+/).filter(Boolean).length;
  return {
    columns,
    squareRatios: cards.map(card => {
      const rect = card.getBoundingClientRect();
      return rect.height ? rect.width / rect.height : 0;
    }),
  };
})()
""")
        if desktop_grid["columns"] != 3 or any(abs(ratio - 1) > 0.03 for ratio in desktop_grid["squareRatios"]):
            raise CheckFailed(f"Desktop feedback cards are not a three-column square grid: {desktop_grid}")
        cdp.eval("document.querySelector('.feedback-public-card summary')?.click()")
        settle(cdp, 300)
        desktop_progress = cdp.eval(r"""
(() => {
  const view = document.querySelector('#feedbackProgressView');
  const openCard = document.querySelector('.feedback-public-card[open]');
  const progressCopy = document.querySelector('.feedback-public-card[open] .feedback-public-progress-copy');
  const progressStyle = progressCopy ? getComputedStyle(progressCopy) : null;
  return {
    text: view?.innerText || '',
    openCardWidth: openCard?.getBoundingClientRect().width || 0,
    listWidth: document.querySelector('#feedbackPublicList')?.getBoundingClientRect().width || 0,
    progressEmphasis: progressStyle ? {
      fontSize: parseFloat(progressStyle.fontSize),
      fontWeight: parseInt(progressStyle.fontWeight, 10),
      backgroundColor: progressStyle.backgroundColor,
    } : null,
  };
})()
""")
        if (
            not all(text in desktop_progress["text"] for text in ["待查看", "维护者尚未查看这条反馈。", "已收到，正在安排检查。"])
            or abs(desktop_progress["openCardWidth"] - desktop_progress["listWidth"]) > 1
            or not desktop_progress["progressEmphasis"]
            or desktop_progress["progressEmphasis"]["fontSize"] < 13
            or desktop_progress["progressEmphasis"]["fontWeight"] < 700
            or desktop_progress["progressEmphasis"]["backgroundColor"] in ("transparent", "rgba(0, 0, 0, 0)")
        ):
            raise CheckFailed(f"Desktop public feedback content mismatch: {desktop_progress!r}")
        desktop_shot = screenshot(cdp, out_dir, "feedback-desktop")

        clear_errors(cdp)
        cdp.command("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": True})
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "mobile app before feedback")
        stub_public_feedback()
        open_feedback()
        mobile_submit = cdp.eval(r"""
(() => {
  const panel = document.querySelector('#feedbackPanel .feedback-panel');
  const rect = panel?.getBoundingClientRect();
  return {
    viewport: [innerWidth, innerHeight],
    panel: rect ? {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom} : null,
    panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : 999,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    privacyOptionPresent: Boolean(document.querySelector('#feedbackPrivate, .feedback-privacy-optout')),
    contactPlaceholder: document.querySelector('#feedbackContact')?.getAttribute('placeholder') || '',
    submitVisible: Boolean(document.querySelector('#feedbackSubmit')?.offsetParent),
  };
})()
""")
        panel = mobile_submit["panel"] or {}
        if (
            mobile_submit["viewport"] != [390, 844]
            or panel.get("left", -1) < -1
            or panel.get("right", 999) > 391
            or mobile_submit["panelOverflow"] > 1
            or mobile_submit["pageOverflow"] > 1
            or mobile_submit["privacyOptionPresent"]
            or mobile_submit["contactPlaceholder"] != "QQ / 邮箱等"
            or not mobile_submit["submitVisible"]
        ):
            raise CheckFailed(f"Mobile feedback submit panel is unusable: {mobile_submit}")
        cdp.eval("document.querySelector('#feedbackProgressTab')?.click()")
        wait_for(cdp, "document.querySelectorAll('.feedback-public-card').length === 6", "mobile public feedback")
        settle(cdp, 300)
        mobile_progress = cdp.eval(r"""
(() => {
  const view = document.querySelector('#feedbackProgressView');
  const list = document.querySelector('#feedbackPublicList');
  const cards = [...document.querySelectorAll('.feedback-public-card')];
  return {
    text: view?.innerText || '',
    viewOverflow: view ? view.scrollWidth - view.clientWidth : 999,
    cardOverflow: Math.max(...cards.map(card => card.scrollWidth - card.clientWidth)),
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    columns: getComputedStyle(list).gridTemplateColumns.split(/\s+/).filter(Boolean).length,
    squareRatios: cards.map(card => {
      const rect = card.getBoundingClientRect();
      return rect.height ? rect.width / rect.height : 0;
    }),
  };
})()
""")
        if (
            "待查看" not in mobile_progress["text"]
            or mobile_progress["columns"] != 2
            or any(abs(ratio - 1) > 0.03 for ratio in mobile_progress["squareRatios"])
            or any(
            mobile_progress[key] > 1 for key in ["viewOverflow", "cardOverflow", "pageOverflow"]
            )
        ):
            raise CheckFailed(f"Mobile feedback progress overflowed: {mobile_progress}")
        mobile_shot = screenshot(cdp, out_dir, "feedback-mobile")
        check_no_errors(cdp)
        return {
            "desktop": desktop,
            "refreshBusy": refresh_busy,
            "desktopGrid": desktop_grid,
            "mobileSubmit": mobile_submit,
            "mobileProgress": mobile_progress,
            "screenshots": [desktop_shot, mobile_shot],
        }

    def new_update_filter():
        clear_errors(cdp)
        cdp.command("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 720, "deviceScaleFactor": 1, "mobile": False})
        navigate(cdp, base + "?codex=suozhang")
        # 批次只增不减，所以最新一期常驻成 NEW 胶囊，其余全收进「往期更新」下拉。
        # ⚠ 不要写死期数：胶囊恒为 1 枚，往期项数＝总数 - 1，写死就等着下一批数据把它撞红。
        past_updates = [item for item in update_filters if not item["latest"]]
        wait_for(cdp, "document.querySelectorAll('#updateFilterControls [data-update-filter]').length === 1", "latest update chip")
        wait_for(cdp, f"document.querySelectorAll('#updateFilterControls .ui-select-option').length === {len(past_updates)}", "past update options")
        initial = cdp.eval("""
(() => {
  const chip = document.querySelector('#updateFilterControls [data-update-filter]');
  const select = document.querySelector('.update-filter-select');
  return {
    chip: chip && {id: chip.dataset.updateFilter, text: chip.innerText.replace(/\\s+/g,' ').trim(), pressed: chip.getAttribute('aria-pressed'), latest: chip.classList.contains('is-latest')},
    trigger: select?.querySelector('.ui-select-label')?.textContent || '',
    triggerActive: select ? select.classList.contains('is-active') : null,
    options: [...document.querySelectorAll('#updateFilterControls .ui-select-option')].map(opt => ({value: opt.dataset.value, label: opt.querySelector('.ui-select-option-label')?.textContent || '', note: opt.querySelector('.ui-select-option-note')?.textContent || ''})),
  };
})()
""")
        chip_expected = f"NEW {latest_update['label']} · {latest_update['count']}"
        chip = initial["chip"] or {}
        if chip.get("text") != chip_expected or chip.get("id") != latest_update["id"] \
                or chip.get("pressed") != "false" or not chip.get("latest"):
            raise CheckFailed(f"Latest update chip mismatch: expected={chip_expected!r}, actual={initial}")
        if initial["trigger"] != f"往期更新 · {len(past_updates)} 期" or initial["triggerActive"] is not False:
            raise CheckFailed(f"Past updates trigger mismatch: {initial}")
        expected_options = [
            {"value": item["id"], "label": f"{item['label']} · {item['count']}"}
            for item in past_updates
        ]
        actual_options = [{"value": item["value"], "label": item["label"]} for item in initial["options"]]
        if actual_options != expected_options:
            raise CheckFailed(f"Past update options mismatch: expected={expected_options!r}, actual={actual_options}")
        if any(not item["note"] for item in initial["options"]):
            raise CheckFailed(f"Past update options lost their relative-day note: {initial['options']}")

        old_id = json.dumps(old_update["id"], ensure_ascii=False)
        latest_id = json.dumps(latest_update["id"], ensure_ascii=False)
        # 往期批次现在只能从下拉里选；选完菜单要关、焦点要回到触发按钮。
        cdp.eval(f"""(() => {{
  const select = document.querySelector('.update-filter-select');
  select.querySelector('.ui-select-button').click();
  [...select.querySelectorAll('.ui-select-option')].find(opt => opt.dataset.value === {old_id}).click();
}})()""")
        wait_for(cdp, f"new URL(location.href).searchParams.get('update') === {old_id} && document.querySelector('.update-filter-select')?.classList.contains('is-active') === true && document.querySelector('.update-filter-select .ui-select-list')?.hidden === true", "historical update filter active")
        settle(cdp, 420)
        active = cdp.eval("""
(() => {
  const cards = [...document.querySelectorAll('.card')];
  return {
    chip: (() => { const btn = document.querySelector('#updateFilterControls [data-update-filter]'); return btn && {id: btn.dataset.updateFilter, pressed: btn.getAttribute('aria-pressed')}; })(),
    trigger: document.querySelector('.update-filter-select .ui-select-label')?.textContent || '',
    result: document.querySelector('#resultInfo')?.textContent || '',
    cards: cards.length,
    newCards: cards.filter(card => card.querySelector('.badge-new')?.hidden === false).length,
    url: location.href,
  };
})()
""")
        if old_update["label"] not in active["result"] or str(old_update["count"]) not in active["result"]:
            raise CheckFailed(f"Historical update result mismatch: expected={old_update!r}, actual={active}")
        if active["cards"] <= 0 or active["newCards"] != 0:
            raise CheckFailed(f"Historical update entries unexpectedly carry the latest NEW badge: {active}")
        if active["trigger"] != f"{old_update['label']} · {old_update['count']}":
            raise CheckFailed(f"Past updates trigger did not adopt the active batch: {active}")
        if not cdp.eval("document.activeElement === document.querySelector('.update-filter-select .ui-select-button')"):
            raise CheckFailed("Past updates trigger lost keyboard focus after rerender")
        shot = screenshot(cdp, out_dir, "new-update-filter")

        cdp.eval(f"(() => {{ const btn = [...document.querySelectorAll('[data-update-filter]')].find(item=>item.dataset.updateFilter==={latest_id}); btn.focus(); btn.click(); }})()")
        wait_for(cdp, f"document.querySelector('[data-update-filter=\"{latest_update['id']}\"]')?.getAttribute('aria-pressed') === 'true' && document.querySelectorAll('[data-update-filter][aria-pressed=\"true\"]').length === 1 && document.querySelector('.update-filter-select')?.classList.contains('is-active') === false && new URL(location.href).searchParams.get('update') === {latest_id}", "latest update filter active")
        settle(cdp, 320)
        latest_cards = cdp.eval("({cards:document.querySelectorAll('.card').length,newCards:[...document.querySelectorAll('.card')].filter(card=>card.querySelector('.badge-new')?.hidden===false).length,result:document.querySelector('#resultInfo')?.textContent||''})")
        if latest_cards["cards"] <= 0 or latest_cards["newCards"] != latest_cards["cards"] or latest_update["label"] not in latest_cards["result"]:
            raise CheckFailed(f"Latest update filter did not select only NEW entries: {latest_cards}")
        if cdp.eval("document.activeElement?.dataset?.updateFilter || ''") != latest_update["id"]:
            raise CheckFailed("Latest update filter lost keyboard focus after rerender")

        cdp.eval(f"[...document.querySelectorAll('[data-update-filter]')].find(btn=>btn.dataset.updateFilter==={latest_id}).click()")
        wait_for(cdp, "document.querySelectorAll('[data-update-filter][aria-pressed=\"true\"]').length === 0 && !new URL(location.href).searchParams.has('update')", "update filter exit")

        # Legacy ?new=1 links still resolve to the latest batch after deploy.
        navigate(cdp, base + "?codex=suozhang&new=1")
        wait_for(cdp, f"document.querySelector('[data-update-filter=\"{latest_update['id']}\"]')?.getAttribute('aria-pressed') === 'true'", "legacy NEW update URL", timeout=12)
        cdp.command("Page.reload", {"ignoreCache": True})
        wait_for(cdp, f"document.querySelector('[data-update-filter=\"{latest_update['id']}\"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('#resultInfo')?.textContent.includes({json.dumps(latest_update['label'], ensure_ascii=False)})", "NEW update reload", timeout=12)

        # The same data switch is enabled independently for the R18 codex.
        cdp.eval("localStorage.setItem('fadian-nsfw-ok','1'); localStorage.removeItem('fadian-r18g-ok')")
        navigate(cdp, base + "?codex=suozhang_r18&new=1")
        wait_for(cdp, f"document.body.classList.contains('nsfw-unlocked') && document.querySelector('[data-update-filter=\"{r18_latest_update['id']}\"]')?.getAttribute('aria-pressed') === 'true'", "R18 NEW update filter", timeout=12)
        r18_expected = f"NEW {r18_latest_update['label']} · {r18_latest_update['count']}"
        r18_text = cdp.eval("document.querySelector('#updateFilterControls .is-latest')?.innerText.replace(/\\s+/g,' ').trim() || ''")
        if r18_text != r18_expected:
            raise CheckFailed(f"R18 NEW update button mismatch: expected={r18_expected!r}, actual={r18_text!r}")

        # Removing the index field is sufficient to withdraw the entry; an
        # unsupported codex never exposes the generic control.
        cdp.eval("localStorage.removeItem('fadian-nsfw-ok'); localStorage.removeItem('fadian-r18g-ok')")
        navigate(cdp, base + "?codex=composition_style&update=2026.8.14")
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "codex without NEW update entry")
        if not cdp.eval("document.querySelector('#updateFilterControls')?.hidden === true"):
            raise CheckFailed("A codex without update filters exposed the update controls")
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "regular codex after NEW checks")
        check_no_errors(cdp)
        return {**active, "latest": latest_cards, "r18Text": r18_text, "unsupportedHidden": True, "screenshot": shot}

    def search_highlight():
        clear_errors(cdp)
        cdp.eval("""
(() => {
  const input = document.querySelector('#search');
  input.value = 'hair';
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'hair' }));
  return true;
})()
""")
        wait_for(cdp, "document.querySelector('#resultInfo')?.textContent.includes('hair')", "search result")
        settle(cdp, 350)
        data = cdp.eval("({result: document.querySelector('#resultInfo')?.textContent || '', marks: document.querySelectorAll('mark').length, cards: document.querySelectorAll('.card').length})")
        if data["marks"] <= 0:
            raise CheckFailed("Search did not render highlight marks")
        check_no_errors(cdp)
        return data

    def author_search():
        clear_errors(cdp)
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "app cards")
        cdp.eval("""
(() => {
  const input = document.querySelector('#search');
  input.value = 'author:戒红所';
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'author:戒红所' }));
  input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));
  return true;
})()
""")
        wait_for(cdp, "history.state?.route?.q === '' && history.state?.route?.searchFilters?.includes('author:戒红所') && document.querySelectorAll('.card').length > 0", "author filter chip result")
        settle(cdp, 350)
        data = cdp.eval("({result: document.querySelector('#resultInfo')?.textContent || '', filters: history.state?.route?.searchFilters || [], chips: document.querySelector('#searchFilterChips')?.textContent || '', cards: document.querySelectorAll('.card').length, marks: document.querySelectorAll('mark').length})")
        if data["cards"] <= 0:
            raise CheckFailed("Author search returned no cards")
        check_no_errors(cdp)
        return data

    def copy_card_feedback():
        clear_errors(cdp)
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "copyable cards")
        copied = cdp.eval("""
(() => {
  const card = [...document.querySelectorAll('.card')].find(node => !node.classList.contains('no-img')) || document.querySelector('.card');
  if (!card) return false;
  card.click();
  return true;
})()
""")
        if not copied:
            raise CheckFailed("No card was available to copy")
        feedback = assert_copy_feedback("copy feedback")
        data = {
            **feedback,
            "recent": cdp.eval("JSON.parse(localStorage.getItem('fadian-recent') || '[]').length"),
        }
        if data["recent"] <= 0:
            raise CheckFailed("Copy did not record a recent entry")
        check_no_errors(cdp)
        return data

    def pack_character_prompts():
        clear_errors(cdp)
        cdp.command("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 900, "deviceScaleFactor": 1, "mobile": False})
        multi_id = urllib.parse.quote(multi_character_entry["id"])
        navigate(cdp, base + f"?codex=community_ai_misc&entry={multi_id}")
        expected = multi_character_entry["characterPrompts"]
        wait_for(
            cdp,
            f"document.querySelector('#lightbox')?.classList.contains('is-open') && document.querySelectorAll('#lightboxCharacterPrompts .character-prompt').length === {len(expected)}",
            "multi-character prompt boxes",
            timeout=12,
        )
        settle(cdp, 350)
        data = cdp.eval("""
(() => {
  const items = [...document.querySelectorAll('#lightboxCharacterPrompts .character-prompt')];
  const info = document.querySelector('#lightboxInfo');
  return {
    hidden: document.querySelector('#characterPromptsBlock')?.hidden,
    labels: items.map(item => item.querySelector(':scope > .section-head .section-label')?.textContent || ''),
    // 中文对照默认打开：去掉中文小字后必须与原文逐字一致
    prompts: items.map(item => {
      const pre = item.querySelector(':scope > pre')?.cloneNode(true);
      pre?.querySelectorAll('.tag-zh-zh').forEach(node => node.remove());
      return pre?.textContent || '';
    }),
    copyAllHidden: document.querySelector('#copyAll')?.hidden,
    horizontalOverflow: info ? info.scrollWidth > info.clientWidth + 1 : true,
  };
})()
""")
        expected_labels = [item["label"] for item in expected]
        expected_prompts = [item.get("prompt", "") for item in expected]
        if data["hidden"] or data["labels"] != expected_labels or data["prompts"] != expected_prompts:
            raise CheckFailed(f"Character prompt boxes do not match pack data: expected={expected_labels}, actual={data}")
        if data["copyAllHidden"] or data["horizontalOverflow"]:
            raise CheckFailed(f"Character prompt actions overflowed or copy-all stayed hidden: {data}")
        cdp.eval("document.querySelector('#lightboxCharacterPrompts .character-prompt > .section-head button')?.click()")
        copy_feedback = assert_copy_feedback("character prompt copy feedback", "已复制 char1")
        data["toast"] = copy_feedback["toast"]
        data["copyFeedback"] = copy_feedback
        shot = screenshot(cdp, out_dir, "pack-character-prompts")

        negative_id = urllib.parse.quote(negative_character_entry["id"])
        navigate(cdp, base + f"?codex=community_ai_misc&entry={negative_id}")
        wait_for(cdp, "document.querySelector('#lightbox')?.classList.contains('is-open') && !!document.querySelector('.character-prompt-negative')", "character negative prompt box", timeout=12)
        negative_labels = cdp.eval("[...document.querySelectorAll('.character-prompt-negative .section-label')].map(node => node.textContent)")
        expected_negative_labels = [
            f"{item['label']} Negative"
            for item in negative_character_entry["characterPrompts"]
            if item.get("negative")
        ]
        if negative_labels != expected_negative_labels:
            raise CheckFailed(f"Character negative labels do not match pack data: {negative_labels}")

        no_character_id = urllib.parse.quote(no_character_entry["id"])
        navigate(cdp, base + f"?codex=community_ai_misc&entry={no_character_id}")
        wait_for(cdp, "document.querySelector('#lightbox')?.classList.contains('is-open')", "entry without character prompts", timeout=12)
        if not cdp.eval("document.querySelector('#characterPromptsBlock')?.hidden === true && document.querySelectorAll('#lightboxCharacterPrompts .character-prompt').length === 0"):
            raise CheckFailed("Character prompt block stayed visible on an entry without character prompts")
        check_no_errors(cdp)
        return {
            **data,
            "multiEntry": multi_character_entry["id"],
            "negativeEntry": negative_character_entry["id"],
            "emptyEntry": no_character_entry["id"],
            "negativeLabels": negative_labels,
            "screenshot": shot,
        }

    def deep_link_lightbox():
        clear_errors(cdp)
        navigate(cdp, base + f"?codex=suozhang&entry={entry_id}")
        wait_for(cdp, "document.querySelector('#lightbox')?.classList.contains('is-open')", "deep-link lightbox", timeout=10)
        settle(cdp, 500)
        data = cdp.eval("({url: location.href, title: document.querySelector('#lightboxTitle')?.textContent || '', open: document.querySelector('#lightbox')?.classList.contains('is-open')})")
        if not data["title"]:
            raise CheckFailed("Lightbox title is empty")
        shot = screenshot(cdp, out_dir, "deep-link-lightbox")
        cdp.eval("document.querySelector('#lightboxClose')?.click()")
        wait_for(cdp, "!document.querySelector('#lightbox')?.classList.contains('is-open')", "deep-link lightbox close")
        wait_for(cdp, "!new URL(location.href).searchParams.has('entry')", "deep-link URL normalization")
        data["closedUrl"] = cdp.eval("location.href")
        check_no_errors(cdp)
        return {**data, "screenshot": shot}

    def tag_zh_lightbox():
        """中文对照：默认打开、原文一个字符不改、开关双向同步、点 tag 出说明。没生成对照表就跳过。"""
        core_path = ROOT / "site" / "data" / "tag_zh" / "core.json"
        if not core_path.exists():
            return {"skipped": "site/data/tag_zh/core.json 不存在（未运行 build_tag_zh.py）"}
        import build_tag_zh as btz

        core = json.loads(core_path.read_text(encoding="utf-8"))
        known = set(core.get("m", {})) | set(core.get("d", {})) | set(core.get("a", {}))
        book = json.loads((ROOT / "site" / "data" / "suozhang.json").read_text(encoding="utf-8"))
        target = next(
            item for item in book.get("entries", [])
            if (item.get("image") or item.get("images")) and item.get("tags")
            and sum(btz.tag_key(piece) in known for piece in btz.split_pieces(item["tags"])) >= 3
        )
        navigate(cdp, base)
        wait_for(cdp, "document.readyState === 'complete'", "tag zh home ready")
        cdp.eval("localStorage.removeItem('fadian-tag-zh')")
        clear_errors(cdp)
        navigate(cdp, base + f"?codex=suozhang&entry={target['id']}")
        wait_for(cdp, "document.querySelector('#lightboxTags')?.classList.contains('tag-zh-on')", "tag zh rendered", timeout=15)
        raw_text = """(() => {
  const pre = document.querySelector('#lightboxTags').cloneNode(true);
  pre.querySelectorAll('.tag-zh-zh').forEach(node => node.remove());
  return pre.textContent;
})()"""
        state_expr = """({
  pressed: document.querySelector('#tagZhToggle')?.getAttribute('aria-pressed'),
  setting: document.querySelector('#tagZhSettingToggle')?.checked,
  on: document.querySelector('#lightboxTags')?.classList.contains('tag-zh-on'),
  boxes: document.querySelectorAll('#lightboxTags .tag-zh-tok').length,
  selectable: (() => { const zh = document.querySelector('#lightboxTags .tag-zh-zh'); return zh ? getComputedStyle(zh).userSelect : ''; })(),
  stored: localStorage.getItem('fadian-tag-zh'),
  title: document.querySelector('#lightboxTitle')?.textContent || '',
  html: (document.querySelector('#lightboxTags')?.innerHTML || '').slice(0, 160),
})"""
        before = cdp.eval(state_expr)
        if before["pressed"] != "true" or not before["setting"] or before["boxes"] < 3:
            raise CheckFailed(f"中文对照没有默认打开：{before}")
        if before["selectable"] != "none":
            raise CheckFailed(f"中文小字仍可被选中复制：{before['selectable']}")
        if cdp.eval(raw_text) != target["tags"]:
            raise CheckFailed("对照排版去掉中文后与词条原文不一致")
        shot = screenshot(cdp, out_dir, "tag-zh-lightbox")
        cdp.eval("document.querySelector('#lightboxTags .tag-zh-tok')?.click()")
        detail = wait_for(cdp, "document.querySelector('#lightboxInfo .tag-zh-detail')?.textContent || ''", "tag zh detail row")
        cdp.eval("document.querySelector('#tagZhToggle')?.click()")
        wait_for(cdp, "!document.querySelector('#lightboxTags')?.classList.contains('tag-zh-on')", "tag zh off")
        off = cdp.eval(state_expr)
        if off["pressed"] != "false" or off["setting"] or off["stored"] != "0" or cdp.eval("document.querySelector('#lightboxTags').textContent") != target["tags"]:
            raise CheckFailed(f"关闭中文对照后状态不对：{off}")
        if cdp.eval("!!document.querySelector('#lightboxInfo .tag-zh-detail')"):
            raise CheckFailed("关闭中文对照后说明行没有收起")
        cdp.eval("document.querySelector('#tagZhToggle')?.click()")
        wait_for(cdp, "document.querySelector('#lightboxTags')?.classList.contains('tag-zh-on')", "tag zh on again")
        cdp.eval("document.querySelector('#lightboxClose')?.click()")
        wait_for(cdp, "!document.querySelector('#lightbox')?.classList.contains('is-open')", "tag zh lightbox close")
        check_no_errors(cdp)
        return {"entry": target["id"], "boxes": before["boxes"], "detail": detail, "screenshot": shot}

    def theme_axes():
        """换肤/字体/深浅色三条轴：六套皮肤都能挂上、素墨深色档的前景色压得住、
        字体换档不碰 prompt 等宽、纯黑档压到真黑、auto 跟随系统且旧键继续同步。"""

        def contrast(fg, bg):
            def lin(c):
                c = c / 255
                return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

            def lum(rgb_):
                r, g, b = (lin(v) for v in rgb_)
                return 0.2126 * r + 0.7152 * g + 0.0722 * b

            hi, lo = sorted((lum(fg), lum(bg)), reverse=True)
            return (hi + 0.05) / (lo + 0.05)

        def rgb(text):
            # Chrome 对 color-mix() 结果回的是 color(srgb 0.049 0.043 0.087)，不是 rgb(0,0,0)；
            # 直接按整数扫会把小数拆成 0 / 490588 两段，必须分格式解析。
            nums = [float(n) for n in re.findall(r"-?\d*\.\d+|-?\d+", text)]
            if text.strip().startswith("color("):
                return tuple(max(0, min(255, round(v * 255))) for v in nums[:3])
            return tuple(int(v) for v in nums[:3])

        def emulate_scheme(value):
            features = [] if value is None else [{"name": "prefers-color-scheme", "value": value}]
            cdp.command("Emulation.setEmulatedMedia", {"features": features})

        cdp.command("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 900, "deviceScaleFactor": 1, "mobile": False})
        emulate_scheme("light")
        navigate(cdp, base)
        wait_for(cdp, "document.readyState === 'complete'", "theme axes ready")
        wait_for(cdp, "!!document.querySelector('#darkModeControl [aria-pressed=\"true\"]')", "theme axes bound", timeout=15)
        clear_errors(cdp)

        state_expr = """({
  body: document.body.className,
  accent: getComputedStyle(document.body).getPropertyValue('--accent').trim(),
  prompt: getComputedStyle(document.body).getPropertyValue('--font-prompt').trim().split(',')[0],
  uiFont: getComputedStyle(document.body).fontFamily.split(',')[0],
  brandFont: getComputedStyle(document.querySelector('.brand')).fontFamily.split(',')[0],
  darkMode: document.querySelector('#darkModeControl [aria-pressed="true"]')?.dataset.darkMode,
  font: document.querySelector('#fontControl [aria-pressed="true"]')?.dataset.font,
  skin: document.querySelector('#themeControl [aria-pressed="true"]')?.dataset.theme,
  legacy: localStorage.getItem('fadian-dark'),
})"""

        def click(sel):
            cdp.eval("document.querySelector(%s).click()" % json.dumps(sel))

        # 1) 六套皮肤都要真的换掉 accent，不许两套撞色
        accents = {}
        for skin in ["", "teal", "sakura", "amber", "indigo", "ink"]:
            click('#themeControl [data-theme="%s"]' % skin)
            settle(cdp, 120)
            now = cdp.eval(state_expr)
            if now["skin"] != skin:
                raise CheckFailed("皮肤 %r 没有被选中：%s" % (skin, now))
            accents[skin or "base"] = now["accent"]
        if len(set(accents.values())) != len(accents):
            raise CheckFailed("有皮肤共用同一个 accent：%s" % accents)

        # 2) 素墨深色档：accent 是亮灰，前景必须靠 --on-accent 压深，否则按钮上的字会糊掉
        click('#themeControl [data-theme="ink"]')
        click('#darkModeControl [data-dark-mode="dark"]')
        settle(cdp, 150)
        pair = cdp.eval("""(() => {
  const el = document.querySelector('#darkModeControl [aria-pressed="true"]');
  const s = getComputedStyle(el);
  return { color: s.color, background: s.backgroundColor };
})()""")
        ratio = contrast(rgb(pair["color"]), rgb(pair["background"]))
        if ratio < 4.5:
            raise CheckFailed("素墨深色档 accent 底上的前景对比度只有 %.2f:1（需 ≥4.5）：%s" % (ratio, pair))

        # 3) 深色就是纯黑：底色必须是真黑，面色靠 color-mix 掺 accent，所以既不是纯黑也不该等于底色
        page_bg = rgb(cdp.eval("getComputedStyle(document.body).backgroundColor"))
        if page_bg != (0, 0, 0):
            raise CheckFailed("深色档的底色不是纯黑：%s" % (page_bg,))
        panel = rgb(cdp.eval("getComputedStyle(document.body).getPropertyValue('--panel')"
                             " && (() => { const d = document.createElement('div');"
                             " d.style.background = 'var(--panel)'; document.body.appendChild(d);"
                             " const v = getComputedStyle(d).backgroundColor; d.remove(); return v; })()"))
        if panel == (0, 0, 0) or max(panel) > 60:
            raise CheckFailed("深色档的面色没有落在「近黑但可分辨」区间：%s" % (panel,))

        # 4) 字体三档换 UI/展示字族，prompt 永远等宽
        fonts = {}
        for fid in ["", "classic", "terminal"]:
            click('#fontControl [data-font="%s"]' % fid)
            settle(cdp, 120)
            now = cdp.eval(state_expr)
            if now["font"] != fid:
                raise CheckFailed("字体档 %r 没有被选中：%s" % (fid, now))
            if "IBM Plex Mono" not in now["prompt"]:
                raise CheckFailed("字体档 %r 动到了 prompt 等宽体：%s" % (fid, now["prompt"]))
            fonts[fid or "base"] = (now["uiFont"], now["brandFont"])
        if len(set(fonts.values())) != len(fonts):
            raise CheckFailed("字体档之间没有实际区别：%s" % fonts)

        # 5) 深浅色三档：显式档锁死、auto 跟随系统，legacy 键始终同步给 404/strings/review
        click('#themeControl [data-theme=""]')
        click('#fontControl [data-font=""]')
        click('#darkModeControl [data-dark-mode="light"]')
        settle(cdp, 120)
        light = cdp.eval(state_expr)
        if "dark" in light["body"].split() or light["legacy"] != "0":
            raise CheckFailed("显式浅色档不对：%s" % light)
        emulate_scheme("dark")
        settle(cdp, 300)
        if "dark" in cdp.eval("document.body.className").split():
            raise CheckFailed("显式浅色档不该被系统深色掰走")

        click('#darkModeControl [data-dark-mode="auto"]')
        settle(cdp, 200)
        auto_dark = cdp.eval(state_expr)
        if "dark" not in auto_dark["body"].split() or auto_dark["legacy"] != "1":
            raise CheckFailed("auto 档没跟上系统深色：%s" % auto_dark)
        emulate_scheme("light")
        settle(cdp, 400)
        auto_light = cdp.eval(state_expr)
        if "dark" in auto_light["body"].split() or auto_light["legacy"] != "0":
            raise CheckFailed("auto 档没跟上系统切回浅色（matchMedia change 没接住）：%s" % auto_light)

        # 6) 旧用户迁移：只有 fadian-dark 时必须落到对应的显式档，不能突然改成跟随系统
        cdp.eval("localStorage.removeItem('fadian-dark-mode');localStorage.setItem('fadian-dark','1')")
        navigate(cdp, base)
        wait_for(cdp, "!!document.querySelector('#darkModeControl [aria-pressed=\"true\"]')", "legacy migration bound", timeout=15)
        migrated = cdp.eval(state_expr)
        if migrated["darkMode"] != "dark" or "dark" not in migrated["body"].split():
            raise CheckFailed("旧 fadian-dark=1 没有迁成显式深色档：%s" % migrated)

        shot = screenshot(cdp, out_dir, "theme-axes")
        check_no_errors(cdp)
        # 收尾还原：这条用例是全套里唯一动 Emulation 媒体特性和主题键的，留脏会污染后面的用例
        emulate_scheme(None)
        cdp.eval("['fadian-dark-mode','fadian-dark','fadian-font','fadian-theme']"
                 ".forEach(k => localStorage.removeItem(k))")
        cdp.command("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 720, "deviceScaleFactor": 1, "mobile": False})
        return {"accents": accents, "fonts": {k: list(v) for k, v in fonts.items()},
                "inkContrast": round(ratio, 2), "screenshot": shot}

    def no_original_lightbox():
        clear_errors(cdp)
        navigate(cdp, base + "?codex=composition_style")
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "no-original codex cards", timeout=10)
        cdp.eval("""
(() => {
  performance.clearResourceTimings();
  const status = document.querySelector('#lightboxOriginalStatus');
  window.__qaOriginalStates = [];
  window.__qaOriginalObserver?.disconnect();
  const record = () => {
    const text = status?.textContent?.trim() || '';
    if (text && window.__qaOriginalStates.at(-1) !== text) window.__qaOriginalStates.push(text);
  };
  window.__qaOriginalObserver = new MutationObserver(record);
  window.__qaOriginalObserver.observe(status, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  record();
  const zoom = [...document.querySelectorAll('.card:not(.no-img) .zoom-btn')][0];
  if (!zoom) throw new Error('no image zoom button in no-original codex');
  zoom.click();
  return true;
})()
""")
        wait_for(cdp, "document.querySelector('#lightbox')?.classList.contains('is-open')", "no-original lightbox", timeout=10)
        settle(cdp, 700)
        data = cdp.eval("""
(() => {
  const button = document.querySelector('#viewOriginal');
  const status = document.querySelector('#lightboxOriginalStatus');
  return {
    states: window.__qaOriginalStates || [],
    status: status?.textContent?.trim() || '',
    statusState: status?.dataset.state || '',
    button: button?.textContent?.trim() || '',
    buttonDisabled: Boolean(button?.disabled),
    buttonHidden: Boolean(button?.hidden),
    tip: document.querySelector('#lightboxTip')?.textContent?.trim() || '',
    originalRequests: performance.getEntriesByType('resource')
      .map(item => item.name)
      .filter(name => /(?:^|[/])originals?(?:[/]|$)/i.test(new URL(name, location.href).pathname)),
  };
})()
""")
        forbidden = [state for state in data["states"] if state.startswith("原图加载中") or state == "原图 ✓"]
        if forbidden:
            raise CheckFailed(f"No-original codex entered original loading/ready states: {data}")
        if data["status"] != "无原图" or data["statusState"] != "unavailable":
            raise CheckFailed(f"No-original status is misleading: {data}")
        if data["button"] != "无原图" or not data["buttonDisabled"] or data["buttonHidden"]:
            raise CheckFailed(f"No-original action is not a visible disabled button: {data}")
        if data["originalRequests"]:
            raise CheckFailed(f"No-original codex requested original assets: {data['originalRequests']}")
        shot = screenshot(cdp, out_dir, "no-original-lightbox")
        cdp.eval("window.__qaOriginalObserver?.disconnect(); document.querySelector('#lightboxClose')?.click()")
        check_no_errors(cdp)
        return {**data, "entry": no_original_entry_id, "screenshot": shot}

    def random_explore():
        clear_errors(cdp)
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "document.querySelector('#randomBtn') && document.querySelectorAll('.card').length >= 1", "random button")
        cdp.eval("document.querySelector('#randomBtn').click()")
        wait_for(cdp, "document.querySelector('#lightbox')?.classList.contains('is-open')", "random lightbox", timeout=8)
        settle(cdp, 350)
        data = cdp.eval("({title: document.querySelector('#lightboxTitle')?.textContent || '', toast: document.querySelector('#toast')?.textContent || ''})")
        if not data["toast"] or (data["title"] and data["title"] not in data["toast"]):
            raise CheckFailed(f"Random explore toast was not shown: {data}")
        cdp.eval("document.querySelector('#lightboxClose')?.click()")
        check_no_errors(cdp)
        return data

    def resume_browse():
        clear_errors(cdp)
        navigate(cdp, base + "?codex=suozhang")
        cdp.eval("""
(() => {
  localStorage.setItem('fadian-last-browse', JSON.stringify({
    codexId:'suozhang',
    codexTitle:'所长常规NovelAI个人法典',
    path:['各式服装'],
    q:'',
    onlyFav:false,
    entryId:'',
    scrollY:420,
    at:Date.now()
  }));
  location.reload();
  return true;
})()
""")
        wait_for(cdp, "document.querySelector('#moreBtn') && document.querySelectorAll('.card').length >= 1", "reloaded app")
        cdp.eval("document.querySelector('#moreBtn').click(); document.querySelector('#historyBtn').click();")
        wait_for(cdp, "!document.querySelector('#historyPanel')?.hidden", "history panel")
        cdp.eval("document.querySelector('#resumeBrowse').click()")
        wait_for(cdp, "document.querySelector('#toast')?.textContent.includes('已恢复上次浏览位置')", "resume toast", timeout=6)
        wait_for(cdp, "window.scrollY >= 200", "resume scroll restore", timeout=8)
        data = cdp.eval("({toast: document.querySelector('#toast')?.textContent || '', url: location.href, y: Math.round(scrollY)})")
        if data["y"] < 200:
            raise CheckFailed("Scroll position was not restored")
        check_no_errors(cdp)
        return data

    def recent_entry_lightbox():
        clear_errors(cdp)
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "recent source cards")
        cdp.eval("localStorage.removeItem('fadian-recent'); location.reload(); true")
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "recent source cards after reset")
        cdp.eval("""
(() => {
  const card = [...document.querySelectorAll('.card')].find(node => !node.classList.contains('no-img')) || document.querySelector('.card');
  card?.click();
  return true;
})()
""")
        wait_for(
            cdp,
            "JSON.parse(localStorage.getItem('fadian-recent') || '[]').length === 1",
            "recent entry recorded",
            timeout=6,
        )
        copy_feedback = assert_copy_feedback("recent copy feedback")
        cdp.eval("document.querySelector('#moreBtn').click(); document.querySelector('#historyBtn').click();")
        wait_for(cdp, "!document.querySelector('#historyPanel')?.hidden && !!document.querySelector('.recent-item')", "recent history item", timeout=6)
        cdp.eval("document.querySelector('.recent-item').click()")
        wait_for(cdp, "document.querySelector('#lightbox')?.classList.contains('is-open')", "recent entry lightbox", timeout=10)
        settle(cdp, 350)
        data = cdp.eval("({url: location.href, title: document.querySelector('#lightboxTitle')?.textContent || '', open: document.querySelector('#lightbox')?.classList.contains('is-open')})")
        if not data["title"]:
            raise CheckFailed("Recent entry did not open a titled lightbox")
        cdp.eval("document.querySelector('#lightboxClose')?.click()")
        check_no_errors(cdp)
        return {**data, "copyFeedback": copy_feedback}

    def codex_switch():
        clear_errors(cdp)
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "document.querySelector('#codexBtn') && document.querySelectorAll('.card').length >= 1", "codex picker ready")
        cdp.eval(("""
(() => {
  document.querySelector('#codexBtn')?.click();
  const stringType = document.querySelector('#codexMenu .codex-type[data-type="string"]');
  if (!stringType) throw new Error('artist-string type item not found');
  stringType.click();
  const stringIds = [...document.querySelectorAll('#codexMenu .codex-item[data-id]')].map(node => node.dataset.id);
  // 2026-08-26 起画风串多了 V5 画师词典，按 codexes.json 的顺序排在最前。
  // 2026-08-31「构图」大分类拆走构图风格与千藤衣柜，v4.5 两本又合并成一册，
  // 画风这一类只剩 v5 与 v4.5 两本（decisions/法典重归类.md）。
  const expected = ['artist_nai5_personal', 'artist_nai45_personal'];
  if (JSON.stringify(stringIds) !== JSON.stringify(expected)) {
    throw new Error(`artist-string order mismatch: ${stringIds.join(',')}`);
  }
  const compositionType = document.querySelector('#codexMenu .codex-type[data-type="composition"]');
  if (!compositionType) throw new Error('composition type item not found');
  compositionType.click();
  const compositionIds = [...document.querySelectorAll('#codexMenu .codex-item[data-id]')].map(node => node.dataset.id);
  const expectedComposition = __COMPOSITION_IDS__;
  if (JSON.stringify(compositionIds) !== JSON.stringify(expectedComposition)) {
    throw new Error(`composition order mismatch: ${compositionIds.join(',')}`);
  }
  const target = document.querySelector('#codexMenu .codex-item[data-id="qianteng"]');
  if (!target) throw new Error('wardrobe codex item not found');
  target.click();
  return true;
})()
""").replace("__COMPOSITION_IDS__", json.dumps(composition_ids, ensure_ascii=False)))
        wait_for(cdp, "document.querySelector('#codexBtnText')?.textContent.includes('衣柜')", "wardrobe selected", timeout=10)
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "wardrobe cards", timeout=10)
        settle(cdp, 350)
        data = cdp.eval("({codex: document.querySelector('#codexBtnText')?.textContent || '', url: location.href, cards: document.querySelectorAll('.card').length, result: document.querySelector('#resultInfo')?.textContent || '', type: 'composition', position: 2})")
        if "衣柜" not in data["codex"]:
            raise CheckFailed("Codex switch did not select wardrobe")
        check_no_errors(cdp)
        return data

    def favorites_backup_entry():
        clear_errors(cdp)
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "favorite source cards")
        normal_hidden = cdp.eval("document.querySelector('#favoritesViewBackupBtn')?.hidden === true")
        favorite_keys = json.dumps([
            f"suozhang:{entry_id}",
            "mengshen_pack:mengshen_pack-0001",
            "codex_6e699406:codex_6e699406-0001",
        ])
        cdp.eval(
            "localStorage.setItem('fadian-nsfw-ok', '1'); "
            "localStorage.removeItem('fadian-favs-v2'); "
            "localStorage.removeItem('fadian-favs-v2:lock'); "
            "localStorage.removeItem('fadian-favs-v2:signal'); "
            f"localStorage.setItem('fadian-favs', JSON.stringify({favorite_keys}))"
        )
        # 故意仍按旧 id 进：合并后 artist_nai45_strings 只是别名，这一行顺带钉住别名路由没断
        navigate(cdp, base + "?codex=artist_nai45_strings&fav=1")
        wait_for(cdp, "!document.querySelector('#favoritesViewBackupBtn')?.hidden", "favorites backup entry")
        wait_for(cdp, "document.querySelectorAll('.card').length >= 3", "favorite cards", timeout=15)
        # 先清 V2 再整页导航，明确测试首次迁移，不能让旧镜像注入绕过唯一真相。
        migrated_library = cdp.eval("JSON.parse(localStorage.getItem('fadian-favs-v2') || 'null')")
        expected_keys = {
            f"suozhang:{entry_id}",
            "artist_nai45_personal:mengshen_pack-0001",
            "suozhang_r18:codex_6e699406-0001",
        }
        if (
            not migrated_library
            or migrated_library.get("migratedFrom") != "v1"
            or {item.get("key") for item in migrated_library.get("items", [])} != expected_keys
            or any(item.get("addedAt") is not None or not item.get("importedAt") for item in migrated_library.get("items", []))
            or [folder.get("name") for folder in migrated_library.get("folders", [])] != ['角色', '画风', '动作', '场景', '素材参考']
            or migrated_library.get("presetsSeeded") != 1
            or migrated_library.get("memberships") != []
        ):
            raise CheckFailed(f"Historical favorites did not migrate completely to unclassified V2: {migrated_library!r}")
        cdp.eval("document.querySelector('#favoritesViewBackupBtn').click()")
        wait_for(cdp, "!document.querySelector('#favoritesBackupPanel')?.hidden", "favorites backup dialog")
        settle(cdp, 250)
        data = cdp.eval("({button: document.querySelector('#favoritesViewBackupBtn')?.textContent.trim() || '', dialog: document.querySelector('#favoritesBackupTitle')?.textContent || '', atlas: document.querySelector('#favoritesCurrentAtlas')?.textContent || '', migrationTitle: document.querySelector('#favoritesMigrationTitle')?.textContent || '', migrationButton: document.querySelector('.favorites-migration-section [data-favorites-migration-start]')?.textContent.trim() || '', migrationFallback: document.querySelector('[data-favorites-migration-fallback]')?.href || '', result: document.querySelector('#resultInfo')?.textContent || '', cards: [...document.querySelectorAll('.card')].map(card => ({title: card.querySelector('.card-title')?.textContent || '', path: card.querySelector('.card-path')?.textContent || '', favorite: card.querySelector('.fav-btn')?.textContent || ''})), normalHidden: " + ("true" if normal_hidden else "false") + "})")
        if not data["normalHidden"]:
            raise CheckFailed("Favorites backup entry was visible outside the favorites view")
        if "备份与恢复" not in data["button"] or data["dialog"] != "收藏备份与恢复":
            raise CheckFailed("Favorites backup entry did not open the shared dialog")
        if data["atlas"] != "3" or "收藏：3 条" not in data["result"]:
            raise CheckFailed(f"Historical favorite owners did not render all three cards: {data!r}")
        dream_card = next((card for card in data["cards"] if card["title"] == "梦神NAI4.5F画风合集 0001"), None)
        if not dream_card or not dream_card["path"].startswith("NovelAI v4.5画师词典 ›"):
            raise CheckFailed(f"Moved mengshen favorite did not resolve to artist strings: {data['cards']!r}")
        if not any(card["path"].startswith("所长色色NovalAI个人法典（合并版） ›") for card in data["cards"]):
            raise CheckFailed(f"Legacy suozhang favorite did not resolve to the merged codex: {data['cards']!r}")
        if any(card["favorite"] != "★" for card in data["cards"]):
            raise CheckFailed(f"Resolved historical favorites lost their active star: {data['cards']!r}")
        if data["migrationTitle"] != "从旧 pages.dev 找回" or data["migrationButton"] != "找回旧收藏":
            raise CheckFailed("Favorites backup dialog is missing the permanent pages.dev migration entry")
        fallback_url = urllib.parse.urlparse(data["migrationFallback"])
        fallback_query = urllib.parse.parse_qs(fallback_url.query)
        if (
            fallback_url.netloc != "novelai-tag.pages.dev"
            or fallback_url.path != "/_favorites-migration-202607.html"
            or fallback_query.get("bridge") != ["20260721"]
        ):
            raise CheckFailed("Favorites migration fallback does not target the rescue page")
        cdp.eval("document.querySelector('#favoritesBackupClose')?.click(); localStorage.removeItem('fadian-favs'); localStorage.removeItem('fadian-favs-v2'); localStorage.removeItem('fadian-favs-v2:lock'); localStorage.removeItem('fadian-favs-v2:signal'); localStorage.removeItem('fadian-nsfw-ok')")
        check_no_errors(cdp)
        return data

    def nsfw_toggle():
        clear_errors(cdp)
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "document.querySelector('#moreBtn') && document.querySelectorAll('.card').length >= 1", "app ready")
        cdp.eval("document.querySelector('#moreBtn').click(); document.querySelector('#settingsBtn').click();")
        wait_for(cdp, "!document.querySelector('#settings')?.hidden", "settings panel")
        cdp.eval("""
(() => {
  const toggle = document.querySelector('#nsfwToggle');
  if (!toggle.checked) toggle.click();
  return true;
})()
""")
        wait_for(cdp, "!document.querySelector('#nsfwConfirm')?.hidden", "nsfw confirm")
        cdp.eval("document.querySelector('#nsfwAccept').click()")
        wait_for(cdp, "document.body.classList.contains('nsfw-unlocked')", "nsfw unlocked")
        cdp.eval("document.querySelector('#nsfwToggle').click()")
        wait_for(cdp, "!document.body.classList.contains('nsfw-unlocked')", "nsfw locked")
        cdp.eval("document.querySelector('#settingsClose')?.click(); document.querySelector('#codexBtn')?.click(); document.querySelector('#codexMenu .codex-type[data-type=\"codex\"]')?.click();")
        wait_for(cdp, "document.querySelectorAll('#codexMenu .codex-item').length >= 1", "codex menu rebuilt")
        data = cdp.eval("({checked: document.querySelector('#nsfwToggle')?.checked, lockedItems: document.querySelectorAll('#codexMenu .codex-item.locked').length, toast: document.querySelector('#toast')?.textContent || ''})")
        if data["lockedItems"] < 2:
            raise CheckFailed("NSFW codex items were not locked again")
        check_no_errors(cdp)
        return data

    def mobile_card_details():
        clear_errors(cdp)
        cdp.command("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": True})
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "document.querySelector('#masonry .card')", "mobile detail cards")
        cdp.eval("localStorage.setItem('fadian-onboarding-v1-done','1'); true")

        def key(value, code, number):
            params = {"type": "keyDown", "key": value, "code": code, "windowsVirtualKeyCode": number}
            if value == 'Enter':
                params['text'] = '\r'
            cdp.command("Input.dispatchKeyEvent", params)
            cdp.command("Input.dispatchKeyEvent", {"type": "keyUp", "key": value, "code": code, "windowsVirtualKeyCode": number})

        def click(selector):
            literal = js_string(selector)
            pos = cdp.eval(f"""(() => {{
              const e = document.querySelector({literal});
              e.scrollIntoView({{block:'nearest'}});
              const r = e.getBoundingClientRect();
              const x = r.x + r.width / 2, y = r.y + r.height / 2;
              if (!e.contains(document.elementFromPoint(x, y))) throw new Error('Control is covered: ' + {literal});
              return {{x, y}};
            }})()""")
            for kind in ["mousePressed", "mouseReleased"]:
                cdp.command("Input.dispatchMouseEvent", {"type": kind, "button": "left", "clickCount": 1, **pos})

        # Use a real text entry so reload exercises the persisted route and real data.
        text_entry = cdp.eval("""(async () => {
          const {state} = await import('./assets/app/state.js');
          const {hasEntryImage} = await import('./assets/app/media.js');
          const {renderList} = await import('./assets/app/masonry.js');
          const entry = state.list.find(e => !hasEntryImage(e));
          if (!entry) throw new Error('No accessible text entry for detail regression');
          state.list = [entry]; renderList({resetScroll:true});
          return {id:entry.id,title:entry.title};
        })()""")
        settle(cdp)
        click('#masonry .card-title')
        wait_for(cdp, "!document.querySelector('#lightbox').hidden", "text detail opens")
        detail_url = cdp.eval('location.href')
        click('#reportLightbox')
        wait_for(cdp, "document.querySelector('#feedbackPanel').classList.contains('show')", "text feedback opens")
        feedback = cdp.eval("({type:document.querySelector('#feedbackType').value,context:document.querySelector('#feedbackContextPreview').textContent})")
        if feedback['type'] != 'card_content' or text_entry['title'] not in feedback['context']:
            raise CheckFailed(f"Text feedback lost its entry context: {feedback}")
        # Only open the form; no feedback is submitted.
        key('Escape', 'Escape', 27)
        wait_for(cdp, "!document.querySelector('#feedbackPanel').classList.contains('show') && !document.querySelector('#lightbox').hidden", "feedback closes to detail")
        cdp.eval('history.back()')
        wait_for(cdp, "document.querySelector('#lightbox').hidden", "text detail back")
        cdp.eval('history.forward()')
        wait_for(cdp, "!document.querySelector('#lightbox').hidden", "text detail forward")
        if cdp.eval('location.href') != detail_url:
            raise CheckFailed('Forward lost the text detail URL')
        cdp.command('Page.reload')
        wait_for(cdp, "document.readyState === 'complete' && !document.querySelector('#lightbox').hidden && document.querySelector('#lightboxTitle').textContent === " + js_string(text_entry['title']), "text detail reload")
        if cdp.eval('location.href') != detail_url:
            raise CheckFailed('Reload lost the text detail URL')
        shot = screenshot(cdp, out_dir, 'mobile-text-detail')
        # Its keyboard entry works after refresh, and native Space does not scroll the page.
        click('#lightboxClose')
        wait_for(cdp, "document.querySelector('#lightbox').hidden", "text detail closes after reload")
        text_selector = cdp.eval("""(async () => {
          const {state} = await import('./assets/app/state.js');
          const i = state.list.findIndex(e => e.id === __ID__);
          return '#masonry .card[data-index="' + i + '"] .card-detail-btn';
        })()""".replace('__ID__', js_string(text_entry['id'])))
        cdp.eval('document.querySelector(' + js_string(text_selector) + ').focus();true')
        key(' ', 'Space', 32)
        wait_for(cdp, "!document.querySelector('#lightbox').hidden", "text detail keyboard Space")

        # A normal image card keeps native keyboard activation, visible focus, and independent star action.
        navigate(cdp, base + '?codex=suozhang')
        wait_for(cdp, "document.querySelector('#masonry .card:not(.no-img)')", "image card keyboard")
        settle(cdp)
        cdp.eval("document.querySelector('#masonry .card:not(.no-img) .card-detail-btn').focus();true")
        key('Tab', 'Tab', 9)
        # A failed image legitimately inserts its retry button before the star.
        if cdp.eval("document.activeElement.classList.contains('img-retry')"):
            key('Tab', 'Tab', 9)
        if cdp.eval('document.activeElement.className') != 'fav-btn':
            raise CheckFailed('Detail button is not followed by the independent favorite button: ' + cdp.eval('document.activeElement.outerHTML'))
        key('Tab', 'Tab', 9)
        focus = cdp.eval("({class:document.activeElement.className,opacity:getComputedStyle(document.activeElement).opacity,label:document.activeElement.getAttribute('aria-label'),index:document.activeElement.closest('.card')?.dataset.index})")
        if focus['class'] != 'card-detail-btn' or focus['opacity'] != '1':
            raise CheckFailed(f"Keyboard detail entry is unreachable or invisible: {focus}")
        screenshot(cdp, out_dir, 'mobile-detail-focus')
        key('Enter', 'Enter', 13)
        wait_for(cdp, "!document.querySelector('#lightbox').hidden", "image detail keyboard Enter")
        key('Escape', 'Escape', 27)
        wait_for(cdp, "document.querySelector('#lightbox').hidden && document.activeElement.classList.contains('card-detail-btn')", "detail keyboard return focus")
        key('Tab', 'Tab', 9)
        previous_star = cdp.eval('document.activeElement.textContent')
        key('Enter', 'Enter', 13)
        wait_for(cdp, 'document.activeElement.textContent !== ' + js_string(previous_star), 'favorite changes')
        if not cdp.eval("document.querySelector('#lightbox').hidden"):
            raise CheckFailed('Favorite keyboard action also opened detail')
        key('Enter', 'Enter', 13)
        wait_for(cdp, 'document.activeElement.textContent === ' + js_string(previous_star), 'favorite restored')
        # CSS switches the native entry off on desktop without needing card reconstruction.
        cdp.command('Emulation.setDeviceMetricsOverride', {'width': 601, 'height': 844, 'deviceScaleFactor': 1, 'mobile': True})
        wait_for(cdp, "getComputedStyle(document.querySelector('.card-detail-btn')).display === 'none'", 'desktop detail button hidden')
        check_no_errors(cdp)
        return {'textEntry': text_entry, 'feedback': feedback, 'keyboardFocus': focus, 'forward': True, 'reload': True, 'screenshot': shot}

    def mobile_home():
        clear_errors(cdp)
        cdp.command("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": True})
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "mobile cards")
        settle(cdp, 500)
        data = cdp.eval("({cards: document.querySelectorAll('.card').length, mobileSearch: !!document.querySelector('#mobileSearchBtn'), result: document.querySelector('#resultInfo')?.textContent || '', updates: [...document.querySelectorAll('#updateFilterControls [data-update-filter]')].map(btn=>btn.innerText.replace(/\\s+/g,' ').trim()), updateTrigger: document.querySelector('.update-filter-select .ui-select-label')?.textContent || '', updateRows: Math.round((document.querySelector('#updateFilterControls')?.getBoundingClientRect().height || 0) / 30), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth})")
        if not data["mobileSearch"]:
            raise CheckFailed("Mobile search button missing")
        # 重设的目的就是这一行不再随发版长高：手机上永远是一行两枚件。
        past_count = len([item for item in update_filters if not item["latest"]])
        expected_updates = [f"NEW {latest_update['label']} · {latest_update['count']}"]
        expected_trigger = f"往期更新 · {past_count} 期" if past_count else ""
        if data["updates"] != expected_updates or data["updateTrigger"] != expected_trigger or data["overflow"] > 1:
            raise CheckFailed(f"Mobile update controls are missing or overflowed: {data}")
        if data["updateRows"] > 1:
            raise CheckFailed(f"Mobile update controls must stay on a single row: {data}")
        check_no_errors(cdp)
        shot = screenshot(cdp, out_dir, "mobile-home")
        return {**data, "screenshot": shot}

    def legacy_codex_alias_routes():
        clear_errors(cdp)
        cdp.command("Emulation.clearDeviceMetricsOverride")
        navigate(cdp, base)
        cdp.eval("localStorage.setItem('fadian-onboarding-v1-done','1'); localStorage.setItem('fadian-nsfw-ok','0')")

        canonical_id = "artist_nai45_personal"
        legacy_id = "artist_nai45_strings"
        canonical_id_js = js_string(canonical_id)
        legacy_id_js = js_string(legacy_id)
        canonical_path_js = json.dumps(legacy_artist_path, ensure_ascii=False)
        entry_id_js = js_string(str(legacy_artist_entry["id"]))
        canonical_share_path_js = js_string(
            "/share/"
            + urllib.parse.quote(canonical_id, safe="")
            + "/"
            + urllib.parse.quote(str(legacy_artist_entry["id"]), safe="")
        )
        legacy_pairs = [("codex", legacy_id)]
        legacy_pairs.extend(("path", segment) for segment in legacy_artist_source_path)
        legacy_pairs.append(("path", ""))
        legacy_directory_url = base + "?" + urllib.parse.urlencode(legacy_pairs)

        # 首载旧书签：先用旧 id 迁目录，落稳后 URL/history 一律改成正式 id 和新目录。
        navigate(cdp, legacy_directory_url)
        wait_for(
            cdp,
            "history.state?.page === 'atlas'"
            + " && history.state.route.codex === " + canonical_id_js
            + " && new URL(location.href).searchParams.get('c') === " + canonical_id_js
            + " && new URL(location.href).searchParams.has('p')"
            + " && !new URL(location.href).searchParams.has('codex')"
            + " && !new URL(location.href).searchParams.has('path')"
            + " && JSON.stringify(history.state.route.path) === JSON.stringify(" + canonical_path_js + ")"
            + " && document.querySelectorAll('.card').length > 0",
            "legacy codex bookmark canonicalized",
            timeout=15,
        )
        bookmark = cdp.eval("({url:location.href,codex:history.state.route.codex,path:history.state.route.path})")

        # 词条深链同样保留词条并打开灯箱，但旧别名不能继续留在地址栏。
        legacy_entry_url = legacy_directory_url + "&entry=" + urllib.parse.quote(str(legacy_artist_entry["id"]), safe="")
        navigate(cdp, legacy_entry_url)
        wait_for(
            cdp,
            "document.querySelector('#lightbox')?.classList.contains('is-open')"
            + " && history.state?.route?.entry === " + entry_id_js
            + " && history.state.route.codex === " + canonical_id_js
            + " && location.pathname === " + canonical_share_path_js
            + " && location.search === ''"
            + " && JSON.stringify(history.state.route.path) === JSON.stringify(" + canonical_path_js + ")",
            "legacy codex entry deep link canonicalized",
            timeout=15,
        )
        deep_link = cdp.eval("({url:location.href,codex:history.state.route.codex,path:history.state.route.path,entry:history.state.route.entry})")

        # 旧部署留下的 Back 记录可能已经是新目录、却仍带旧书 id；此时 path 不变，
        # 也必须单独触发规范化。这正是地址栏曾残留旧别名的分支。
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "history.state?.page === 'atlas' && history.state.route.codex === 'suozhang'", "canonical history seed")
        adopted = cdp.eval(
            """
(() => {
  const target = structuredClone(history.state);
  target.route = {
    ...target.route,
    codex: __LEGACY_ID__, favorites: false, siteSearch: false, scope: 'codex',
    path: __CANONICAL_PATH__, searchReturnPath: [], q: '', entry: '', imageIndex: 0, updateFilter: '',
  };
  const targetUrl = new URL(location.href);
  targetUrl.search = '';
  targetUrl.searchParams.set('codex', __LEGACY_ID__);
  for (const segment of __CANONICAL_PATH__) targetUrl.searchParams.append('path', segment);
  history.replaceState(target, '', targetUrl);
  const dummy = structuredClone(target);
  dummy.id = `${target.id}-legacy-alias-${Date.now()}`;
  dummy.parentId = target.id;
  dummy.transition = 'route';
  dummy.route = {...target.route, codex:'suozhang', path:[]};
  history.pushState(dummy, '', '?codex=suozhang');
  history.back();
  return {id:target.id};
})()
"""
            .replace("__LEGACY_ID__", legacy_id_js)
            .replace("__CANONICAL_PATH__", canonical_path_js)
        )
        wait_for(
            cdp,
            "history.state?.id === " + js_string(adopted["id"])
            + " && history.state.route.codex === " + canonical_id_js
            + " && new URL(location.href).searchParams.get('c') === " + canonical_id_js
            + " && new URL(location.href).searchParams.has('p')"
            + " && !new URL(location.href).searchParams.has('codex')"
            + " && !new URL(location.href).searchParams.has('path')"
            + " && JSON.stringify(history.state.route.path) === JSON.stringify(" + canonical_path_js + ")"
            + " && document.querySelectorAll('.card').length > 0",
            "legacy codex Back record canonicalized",
            timeout=15,
        )
        back_record = cdp.eval("({url:location.href,codex:history.state.route.codex,path:history.state.route.path})")
        if cdp.eval("new URL(location.href).searchParams.get('c') === " + legacy_id_js):
            raise CheckFailed("Legacy codex alias remained in the address bar")
        check_no_errors(cdp)
        return {
            "sourcePath": legacy_artist_source_path,
            "bookmark": bookmark,
            "deepLink": deep_link,
            "backRecord": back_record,
        }

    def mobile_atlas_history():
        clear_errors(cdp)
        cdp.command("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": True})
        navigate(cdp, base + "?codex=suozhang")
        cdp.eval("localStorage.setItem('fadian-nsfw-ok','0'); localStorage.setItem('fadian-onboarding-v1-done','1'); localStorage.setItem('fadian-sidebar','closed')")
        cdp.command("Page.reload", {"ignoreCache": True})
        wait_for(cdp, "history.state?.page === 'atlas' && document.querySelectorAll('.card').length >= 1", "managed atlas history")
        initial = cdp.eval("({length:history.length,id:history.state.id,url:location.href})")
        initial_scroll = cdp.eval("Math.min(500, Math.max(0, document.documentElement.scrollHeight - innerHeight - 20))") or 0
        cdp.eval(f"scrollTo(0,{int(initial_scroll)})")
        settle(cdp, 220)

        # Escape closes the mobile codex picker exactly once and restores focus.
        cdp.eval("document.querySelector('#codexBtn')?.click()")
        wait_for(cdp, "!document.querySelector('#codexMenu')?.hidden && history.state?.layers?.at(-1)?.id === 'codex-menu'", "codex menu history layer")
        cdp.eval("""
(() => {
  const item = document.querySelector('#codexMenu .codex-item');
  if (!item) throw new Error('No codex menu item was found');
  item.focus();
  item.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}));
  return true;
})()
""")
        wait_for(cdp, "document.querySelector('#codexMenu')?.hidden && document.activeElement?.id === 'codexBtn' && history.state?.id === " + js_string(initial["id"]), "codex menu Escape focus return")

        # Selecting the already-active directory only closes the sidebar; it
        # must not leave an identical child route in browser history.
        cdp.eval("document.querySelector('#menuBtn')?.click()")
        wait_for(cdp, "history.state?.layers?.at(-1)?.id === 'mobile-sidebar'", "sidebar history layer for active category")
        cdp.eval("""
(() => {
  const row = document.querySelector('#tree .tree-row.active');
  if (!row) throw new Error('No active atlas category was found');
  row.click();
  return true;
})()
""")
        wait_for(cdp, "document.querySelector('#sidebar')?.classList.contains('closed') && history.state?.id === " + js_string(initial["id"]), "active category avoids duplicate history")
        cdp.eval(f"scrollTo(0,{int(initial_scroll)})")
        settle(cdp, 220)
        initial_scroll = cdp.eval("Math.round(scrollY)") or 0

        cdp.eval("document.querySelector('#menuBtn')?.click()")
        wait_for(cdp, "history.state?.layers?.at(-1)?.id === 'mobile-sidebar'", "sidebar history layer")
        cdp.eval("""
(() => {
  const row = [...document.querySelectorAll('#tree .tree-row[data-path]')].find(node => node.dataset.path);
  if (!row) throw new Error('No non-root atlas category was found');
  row.click();
  return true;
})()
""")
        wait_for(cdp, "document.querySelector('#sidebar')?.classList.contains('closed') && history.state?.route?.path?.length > 0", "category consumes sidebar")
        category_state = cdp.eval("({length:history.length,id:history.state.id,parentId:history.state.parentId,path:history.state.route.path,layers:history.state.layers})")
        if category_state["id"] == initial["id"] or category_state["parentId"] != initial["id"] or category_state["layers"]:
            raise CheckFailed(f"Sidebar/category history depth is wrong: {category_state}")

        # Return to the initial list, then verify detail push/forward and scroll restoration.
        cdp.eval("history.back()")
        wait_for(cdp, "history.state?.id === " + js_string(initial["id"]), "category back navigation")
        if initial_scroll > 80:
            wait_for(cdp, f"Math.abs(scrollY - {int(initial_scroll)}) < 90", "category scroll restoration", timeout=8)
        wait_for(cdp, "document.querySelectorAll('.zoom-btn').length >= 1", "atlas zoom controls")
        scroll_target = cdp.eval("Math.min(700, Math.max(0, document.documentElement.scrollHeight - innerHeight - 20))") or 0
        cdp.eval(f"scrollTo(0,{int(scroll_target)})")
        settle(cdp, 260)
        before_detail = cdp.eval("({length:history.length,y:Math.round(scrollY),saved:history.state.scrollY,id:history.state.id})")
        cdp.eval("document.querySelector('.zoom-btn')?.click()")
        wait_for(cdp, "history.state?.transition === 'detail' && document.querySelector('#lightbox')?.classList.contains('is-open')", "atlas detail history")
        detail = cdp.eval("({length:history.length,id:history.state.id,parentId:history.state.parentId,thumbs:document.querySelectorAll('#lightboxThumbs button').length,url:location.href})")
        if detail["id"] == before_detail["id"] or detail["parentId"] != before_detail["id"]:
            raise CheckFailed(f"Opening an atlas entry did not create a child history record: {detail}")
        if detail["thumbs"] > 1:
            cdp.eval("document.querySelectorAll('#lightboxThumbs button')[1]?.click()")
            settle(cdp, 120)
            if cdp.eval("history.length") != detail["length"]:
                raise CheckFailed("Atlas image paging increased history depth")

        cdp.eval("history.back()")
        wait_for(cdp, "!document.querySelector('#lightbox')?.classList.contains('is-open') && history.state?.id === " + js_string(before_detail["id"]), "atlas detail back")
        if not cdp.eval("matchMedia('(prefers-reduced-motion: reduce)').matches") and cdp.eval("document.querySelector('#lightbox')?.hidden"):
            raise CheckFailed("Atlas detail back skipped the lightbox close animation")
        if before_detail["y"] > 80:
            try:
                wait_for(cdp, f"Math.abs(scrollY - {before_detail['y']}) < 90", "atlas scroll restoration", timeout=8)
            except CheckFailed as exc:
                scroll_debug = cdp.eval("({y:Math.round(scrollY),saved:history.state?.scrollY,height:document.documentElement.scrollHeight,errors:window.__qaErrors||[]})")
                raise CheckFailed(f"{exc}; before={before_detail}; after={scroll_debug}") from exc
        cdp.eval("history.forward()")
        wait_for(cdp, "document.querySelector('#lightbox')?.classList.contains('is-open') && history.state?.transition === 'detail'", "atlas detail forward")
        cdp.eval("history.back()")
        wait_for(cdp, "!document.querySelector('#lightbox')?.classList.contains('is-open')", "atlas detail closes again")
        wait_for(cdp, "document.querySelector('#lightbox')?.hidden", "atlas detail close animation finishes", timeout=2)

        # Managed history entries written by older deployments still contain
        # onlyImaged/onlyNew. Adopt one through a real popstate, then prove a
        # detail Back takes the fast close path without flashing to the top.
        legacy_parent = cdp.eval("""
(() => {
  const target = structuredClone(history.state);
  delete target.route.updateFilter;
  target.route.onlyImaged = false;
  target.route.onlyNew = false;
  history.replaceState(target, '', location.href);
  const dummy = structuredClone(target);
  dummy.id = `${target.id}-legacy-adopt-${Date.now()}`;
  dummy.parentId = target.id;
  dummy.transition = 'route';
  history.pushState(dummy, '', location.href);
  history.back();
  return {id: target.id};
})()
""")
        wait_for(
            cdp,
            "history.state?.id === " + js_string(legacy_parent["id"])
            + " && !Object.hasOwn(history.state.route,'onlyImaged')"
            + " && !Object.hasOwn(history.state.route,'onlyNew')"
            + " && history.state.route.updateFilter === ''",
            "legacy atlas route canonicalized",
        )
        legacy_scroll_target = cdp.eval("Math.min(700, Math.max(0, document.documentElement.scrollHeight - innerHeight - 20))") or 0
        cdp.eval(f"scrollTo(0,{int(legacy_scroll_target)})")
        settle(cdp, 360)
        cdp.eval(f"scrollTo(0,{int(legacy_scroll_target)})")
        settle(cdp, 220)
        legacy_scroll_base = cdp.eval("Math.round(scrollY)") or 0
        if legacy_scroll_base > 120:
            cdp.eval("document.querySelector('.zoom-btn')?.click()")
            wait_for(cdp, "history.state?.transition === 'detail' && document.querySelector('#lightbox')?.classList.contains('is-open')", "legacy route detail history")
            cdp.eval("window.__legacyRouteScroll = []; window.__legacyRouteScrollOn = true; addEventListener('scroll', () => { if (window.__legacyRouteScrollOn) window.__legacyRouteScroll.push(Math.round(scrollY)); })")
            cdp.eval("history.back()")
            wait_for(cdp, "!document.querySelector('#lightbox')?.classList.contains('is-open') && history.state?.id === " + js_string(legacy_parent["id"]), "legacy route detail back")
            settle(cdp, 450)
            cdp.eval("window.__legacyRouteScrollOn = false")
            legacy_scroll_log = cdp.eval("window.__legacyRouteScroll || []") or []
            legacy_scroll_now = cdp.eval("Math.round(scrollY)") or 0
            if any(value < legacy_scroll_base - 90 for value in legacy_scroll_log):
                raise CheckFailed(
                    "Legacy detail Back flashed the list toward the top: "
                    f"base={legacy_scroll_base}, log={legacy_scroll_log}"
                )
            if abs(legacy_scroll_now - legacy_scroll_base) > 5:
                raise CheckFailed(
                    "Legacy detail Back drifted the list scroll: "
                    f"base={legacy_scroll_base}, now={legacy_scroll_now}, log={legacy_scroll_log}"
                )

        # The retired onlyNew flag maps to the selected codex's latest durable
        # update batch and is removed from the adopted history record.
        legacy_latest = cdp.eval("""
(() => {
  const target = structuredClone(history.state);
  delete target.route.updateFilter;
  target.route.onlyImaged = false;
  target.route.onlyNew = true;
  history.replaceState(target, '', location.href);
  const dummy = structuredClone(target);
  dummy.id = `${target.id}-legacy-latest-${Date.now()}`;
  dummy.parentId = target.id;
  dummy.transition = 'route';
  history.pushState(dummy, '', location.href);
  history.back();
  return {id: target.id};
})()
""")
        latest_id = js_string(latest_update["id"])
        wait_for(
            cdp,
            "history.state?.id === " + js_string(legacy_latest["id"])
            + " && history.state.route.updateFilter === " + latest_id
            + " && !Object.hasOwn(history.state.route,'onlyImaged')"
            + " && !Object.hasOwn(history.state.route,'onlyNew')"
            + " && document.querySelector('[data-update-filter=\"" + latest_update["id"] + "\"]')?.getAttribute('aria-pressed') === 'true'",
            "legacy NEW history route canonicalized",
            timeout=12,
        )
        cdp.eval("document.querySelector('[data-update-filter=\"" + latest_update["id"] + "\"]')?.click()")
        wait_for(cdp, "history.state?.route?.updateFilter === ''", "legacy NEW filter reset")

        # Closing an overlay must not move the list at all (no flash to top):
        # record every scroll change while the settings layer closes via back.
        flash_scroll = cdp.eval("Math.min(500, Math.max(0, document.documentElement.scrollHeight - innerHeight - 20))") or 0
        cdp.eval(f"scrollTo(0,{int(flash_scroll)})")
        settle(cdp, 400)
        cdp.eval(f"scrollTo(0,{int(flash_scroll)})")   # re-assert after masonry relayout settles
        settle(cdp, 260)
        flash_base = cdp.eval("Math.round(scrollY)") or 0
        if flash_base > 120:
            cdp.eval("window.__scrollFlash = []; window.__scrollFlashOn = true; addEventListener('scroll', () => { if (window.__scrollFlashOn) window.__scrollFlash.push(Math.round(scrollY)); })")
            cdp.eval("document.querySelector('#settingsBtn')?.click()")
            wait_for(cdp, "document.querySelector('#settings')?.classList.contains('show')", "flash check settings open")
            cdp.eval("history.back()")
            wait_for(cdp, "!document.querySelector('#settings')?.classList.contains('show')", "flash check settings closed")
            settle(cdp, 450)
            cdp.eval("window.__scrollFlashOn = false")
            flash_log = cdp.eval("window.__scrollFlash || []") or []
            flash_now = cdp.eval("Math.round(scrollY)") or 0
            if any(v < flash_base - 90 for v in flash_log):
                raise CheckFailed(f"Closing the settings layer scrolled the list (flash to top): base={flash_base}, log={flash_log}")
            if abs(flash_now - flash_base) > 5:
                raise CheckFailed(f"Scroll position drifted after closing the settings layer: base={flash_base}, now={flash_now}, log={flash_log}")

        # Settings -> NSFW confirmation is a nested pair of returnable layers.
        cdp.eval("document.querySelector('#settingsBtn')?.click()")
        wait_for(cdp, "document.querySelector('#settings')?.classList.contains('show')", "settings layer")
        cdp.eval("document.querySelector('#nsfwToggle')?.click()")
        wait_for(cdp, "document.querySelector('#nsfwConfirm')?.classList.contains('show')", "nested NSFW layer")
        nested_length = cdp.eval("history.length")
        cdp.eval("history.back()")
        wait_for(cdp, "!document.querySelector('#nsfwConfirm')?.classList.contains('show') && document.querySelector('#settings')?.classList.contains('show')", "nested confirm back")
        cdp.eval("history.back()")
        wait_for(cdp, "!document.querySelector('#settings')?.classList.contains('show')", "settings back")

        cdp.eval("document.querySelector('#settingsBtn')?.click(); document.querySelector('#nsfwToggle')?.click()")
        wait_for(cdp, "document.querySelector('#settings')?.classList.contains('show') && document.querySelector('#nsfwConfirm')?.classList.contains('show')", "rapid-back nested layers")
        cdp.eval("history.back(); setTimeout(() => history.back(), 10); true")
        wait_for(cdp, "!document.querySelector('#nsfwConfirm')?.classList.contains('show') && !document.querySelector('#settings')?.classList.contains('show')", "rapid consecutive back", timeout=8)

        # Mobile search uses one layer record plus one stable result record.
        cdp.eval("document.querySelector('#mobileSearchBtn')?.click()")
        wait_for(cdp, "document.body.classList.contains('search-mode')", "mobile search layer")
        cdp.eval("""
(() => {
  const input = document.querySelector('#search');
  input.value = 'hair';
  input.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:'hair'}));
})()
""")
        wait_for(cdp, "history.state?.sessionId && history.state?.route?.q === 'hair'", "first mobile search")
        search_length = cdp.eval("history.length")
        cdp.eval("""
(() => {
  const input = document.querySelector('#search');
  input.value = 'hair long';
  input.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:' long'}));
})()
""")
        wait_for(cdp, "history.state?.route?.q === 'hair long'", "continuous mobile search")
        cdp.eval("""
(() => {
  const input = document.querySelector('#search');
  input.value = 'has:image hair long';
  input.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:'has:image '}));
})()
""")
        wait_for(cdp, "history.state?.route?.q === 'hair long' && history.state?.route?.searchFilters?.includes('has:image')", "continuous mobile image filter chip")
        if cdp.eval("history.length") != search_length:
            raise CheckFailed("Continuous search/filtering increased atlas history depth")
        cdp.eval("history.back()")
        wait_for(cdp, "!document.body.classList.contains('search-mode') && history.state?.route?.q === 'hair long' && history.state?.route?.searchFilters?.includes('has:image')", "first search back")
        cdp.eval("history.back()")
        wait_for(cdp, "history.state?.route?.q === '' && !(history.state?.route?.searchFilters || []).length", "second search back")

        # Reload adopts the persisted managed record: identity and scroll
        # position survive pull-to-refresh instead of resetting to the top.
        reload_scroll = cdp.eval("Math.min(600, Math.max(0, document.documentElement.scrollHeight - innerHeight - 20))") or 0
        cdp.eval(f"scrollTo(0,{int(reload_scroll)})")
        settle(cdp, 260)
        saved_id = cdp.eval("history.state.id")
        cdp.command("Page.reload", {})
        wait_for(cdp, "history.state?.page === 'atlas' && document.querySelectorAll('.card').length >= 1", "atlas reload keeps managed state")
        if cdp.eval("history.state.id") != saved_id:
            raise CheckFailed("Reload did not adopt the persisted managed history record")
        if reload_scroll > 80:
            wait_for(cdp, f"Math.abs(scrollY - {int(reload_scroll)}) < 90", "reload scroll restoration", timeout=8)

        # A layer that disappears during reload must be collapsed before the
        # user presses Back; otherwise the first Back only consumes an
        # invisible child record and appears broken.
        reload_layer_parent = cdp.eval("history.state.id")
        cdp.eval("document.querySelector('#settingsBtn')?.click()")
        wait_for(cdp, "document.querySelector('#settings')?.classList.contains('show') && history.state?.layers?.at(-1)?.id === 'settings'", "reload ghost settings layer")
        reload_layer_length = cdp.eval("history.length")
        cdp.command("Page.reload", {})
        wait_for(
            cdp,
            "!document.querySelector('#settings')?.classList.contains('show') && history.state?.id === " + js_string(reload_layer_parent),
            "reload collapses discarded settings layer",
            timeout=12,
        )
        if cdp.eval("history.length") != reload_layer_length:
            raise CheckFailed("Collapsing the discarded settings layer changed physical history depth")

        # A recent-entry detail may switch list context (query cleared, path
        # changed) in a single record; back must restore the previous context
        # instead of only closing the lightbox.
        cdp.eval("document.querySelector('#mobileSearchBtn')?.click()")
        wait_for(cdp, "document.body.classList.contains('search-mode')", "recent-entry search layer")
        cdp.eval("""
(() => {
  const input = document.querySelector('#search');
  input.value = 'hair';
  input.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:'hair'}));
})()
""")
        wait_for(cdp, "history.state?.route?.q === 'hair'", "recent-entry search context")
        cdp.eval("history.back()")
        wait_for(cdp, "!document.body.classList.contains('search-mode') && history.state?.route?.q === 'hair'", "recent-entry search layer closed")
        cdp.eval("document.querySelector('#historyBtn')?.click()")
        wait_for(cdp, "document.querySelectorAll('#recentList .recent-item').length >= 1", "recent entries panel")
        cdp.eval("document.querySelector('#recentList .recent-item')?.click()")
        wait_for(cdp, "document.querySelector('#lightbox')?.classList.contains('is-open') && history.state?.transition === 'detail' && history.state?.route?.q === ''", "recent entry detail record")
        cdp.eval("history.back()")
        wait_for(cdp, "!document.querySelector('#lightbox')?.classList.contains('is-open') && history.state?.route?.q === 'hair' && document.querySelector('#search')?.value === 'hair'", "recent entry back restores context")
        check_no_errors(cdp)
        return {
            "initialLength": initial["length"],
            "categoryLength": category_state["length"],
            "detailLength": detail["length"],
            "nestedLength": nested_length,
            "searchLength": search_length,
            "scrollY": before_detail["y"],
            "reloadScroll": reload_scroll,
        }

    def community_history():
        clear_errors(cdp)
        navigate(cdp, base + "strings.html")
        cdp.eval("""
(() => {
  localStorage.setItem('community-only-favorites', 'false');
  localStorage.setItem('strings-nsfw', 'false');
  localStorage.removeItem('fadian-adult-confirmed-v1');
  localStorage.removeItem('fadian-nsfw-ok');
  localStorage.removeItem('fadian-r18g-ok');
})()
""")
        cdp.command("Page.reload", {"ignoreCache": True})
        try:
            wait_for(cdp, "history.state?.page === 'community' && document.querySelectorAll('.community-card').length >= 1", "managed community history", timeout=12)
        except CheckFailed as exc:
            boot = cdp.eval("({ready:document.readyState,state:history.state,cards:document.querySelectorAll('.community-card').length,errors:window.__qaErrors||[],text:document.querySelector('#resultInfo')?.textContent||''})")
            raise CheckFailed(f"{exc}; boot={boot}") from exc
        initial = cdp.eval("({length:history.length,id:history.state.id,url:location.href,path:location.pathname})")

        # The first NSFW enable is an adult-confirmation history layer. Accepting
        # it consumes that layer into a new list baseline and must never unlock
        # the main atlas's independent display preference.
        cdp.eval("document.querySelector('#nsfwBtn')?.click()")
        wait_for(
            cdp,
            "document.querySelector('#communityNsfwConfirm')?.classList.contains('show')",
            "community first adult confirmation",
        )
        confirm_layer = cdp.eval(
            "({length:history.length,id:history.state.id,url:location.href,layers:history.state.layers||[]})"
        )
        if confirm_layer["length"] != initial["length"] + 1:
            raise CheckFailed(f"Community adult confirmation did not add exactly one history layer: {confirm_layer}")
        if confirm_layer["url"] != initial["url"]:
            raise CheckFailed("Community adult confirmation changed the address bar")
        cdp.eval("document.querySelector('#communityNsfwConfirm [data-community-nsfw-accept]')?.click()")
        wait_for(
            cdp,
            """document.querySelector('#communityNsfwConfirm')?.hidden === true
               && !document.querySelector('#communityNsfwConfirm')?.classList.contains('show')
               && document.querySelector('#nsfwBtn')?.getAttribute('aria-pressed') === 'true'
               && localStorage.getItem('strings-nsfw') === 'true'
               && localStorage.getItem('fadian-adult-confirmed-v1') === '1'""",
            "community adult confirmation accepted",
        )
        initial = cdp.eval("""({
          length: history.length,
          id: history.state.id,
          url: location.href,
          path: location.pathname,
          adultConfirmed: localStorage.getItem('fadian-adult-confirmed-v1'),
          mainNsfw: localStorage.getItem('fadian-nsfw-ok'),
          nsfwPressed: document.querySelector('#nsfwBtn')?.getAttribute('aria-pressed'),
        })""")
        if initial["length"] != confirm_layer["length"]:
            raise CheckFailed("Accepting community adult confirmation added another history record")
        if initial["url"] != confirm_layer["url"]:
            raise CheckFailed("Accepting community adult confirmation changed the address bar")
        if initial["adultConfirmed"] != "1" or initial["nsfwPressed"] != "true":
            raise CheckFailed(f"Community adult confirmation did not enable NSFW cleanly: {initial}")
        if initial["mainNsfw"] is not None:
            raise CheckFailed("Community adult confirmation wrote the main atlas fadian-nsfw-ok key")

        initial_scroll = cdp.eval("Math.min(250, Math.max(0, document.documentElement.scrollHeight - innerHeight - 20))") or 0
        cdp.eval(f"scrollTo(0,{int(initial_scroll)})")
        settle(cdp, 200)

        cdp.eval("""
(() => {
  const category = document.querySelector('.community-card .card-meta span')?.textContent?.trim();
  const chip = [...document.querySelectorAll('#categoryRail .category-chip')].find(node => node.textContent.trim() === category);
  if (!chip) throw new Error(`No category chip for ${category}`);
  chip.click();
})()
""")
        wait_for(cdp, "history.state?.route?.category && document.querySelectorAll('.community-card').length >= 1", "community category route")
        category_state = cdp.eval("({length:history.length,id:history.state.id,parentId:history.state.parentId})")
        category_length = category_state["length"]
        if category_state["id"] == initial["id"] or category_state["parentId"] != initial["id"]:
            raise CheckFailed(f"Community category did not create a child history record: {category_state}")

        cdp.eval("""
(() => {
  const input = document.querySelector('#search');
  input.value = 'sample';
  input.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:'sample'}));
})()
""")
        wait_for(cdp, "history.state?.route?.q === 'sample' && history.state?.sessionId", "community first search")
        search_state = cdp.eval("({length:history.length,id:history.state.id,parentId:history.state.parentId})")
        search_length = search_state["length"]
        cdp.eval("""
(() => {
  const input = document.querySelector('#search');
  input.value = 'sample composition';
  input.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:' composition'}));
})()
""")
        wait_for(cdp, "history.state?.route?.q === 'sample composition'", "community continuous search")
        if cdp.eval("history.length") != search_length:
            raise CheckFailed("Continuous community search increased history depth")

        # Once adult confirmation exists, disabling/re-enabling NSFW and toggling
        # favorites are pure persistent filters: they replace the current record.
        cdp.eval("document.querySelector('#nsfwBtn')?.click(); document.querySelector('#nsfwBtn')?.click(); document.querySelector('#favFilterBtn')?.click(); document.querySelector('#favFilterBtn')?.click()")
        settle(cdp, 180)
        if cdp.eval("history.length") != search_length:
            raise CheckFailed("Community filters increased history depth")
        if cdp.eval("location.href") != initial["url"]:
            raise CheckFailed("Community route/filter state changed the address bar")
        filter_state = cdp.eval("""({
          nsfwPressed: document.querySelector('#nsfwBtn')?.getAttribute('aria-pressed'),
          favoritePressed: document.querySelector('#favFilterBtn')?.getAttribute('aria-pressed'),
          confirmVisible: document.querySelector('#communityNsfwConfirm')?.classList.contains('show') || false,
          adultConfirmed: localStorage.getItem('fadian-adult-confirmed-v1'),
          mainNsfw: localStorage.getItem('fadian-nsfw-ok'),
        })""")
        if (
            filter_state["nsfwPressed"] != "true"
            or filter_state["favoritePressed"] != "false"
            or filter_state["confirmVisible"]
            or filter_state["adultConfirmed"] != "1"
            or filter_state["mainNsfw"] is not None
        ):
            raise CheckFailed(f"Community persistent filters did not return to their confirmed baseline: {filter_state}")

        # The strings.html list context lives only in history.state; reload must
        # restore category/search from the persisted managed record.
        cdp.command("Page.reload", {})
        wait_for(cdp, "history.state?.page === 'community' && document.querySelector('#search')?.value === 'sample composition'", "community reload restores context", timeout=12)
        if cdp.eval("history.state?.route?.q") != "sample composition":
            raise CheckFailed("Community reload lost the search query")
        if not cdp.eval("history.state?.route?.category"):
            raise CheckFailed("Community reload lost the active category")
        if cdp.eval("history.length") != search_length:
            raise CheckFailed("Community reload changed history depth")

        cdp.eval("document.querySelector('.community-card')?.click()")
        wait_for(cdp, "history.state?.transition === 'detail' && document.querySelector('#detailMask')?.classList.contains('show')", "community detail route")
        detail_state = cdp.eval("({length:history.length,id:history.state.id,parentId:history.state.parentId})")
        detail_length = detail_state["length"]
        if detail_state["id"] == search_state["id"] or detail_state["parentId"] != search_state["id"]:
            raise CheckFailed(f"Community detail did not create a child history record: {detail_state}")
        thumbs = cdp.eval("document.querySelectorAll('[data-image-index]').length") or 0
        if thumbs > 1:
            cdp.eval("document.querySelectorAll('[data-image-index]')[1].click()")
            settle(cdp, 100)
            if cdp.eval("history.length") != detail_length:
                raise CheckFailed("Community image paging increased history depth")
        cdp.eval("history.back()")
        wait_for(cdp, "!document.querySelector('#detailMask')?.classList.contains('show') && history.state?.route?.q === 'sample composition'", "community detail back")

        # Shareable community details keep ?entry= in the address bar. Reload
        # must reopen the same gated detail without adding a physical record;
        # the next Back then returns to the exact list parent.
        reload_detail_parent = cdp.eval("history.state.id")
        cdp.eval("document.querySelector('.community-card')?.click()")
        wait_for(cdp, "history.state?.transition === 'detail' && document.querySelector('#detailMask')?.classList.contains('show')", "community detail before reload")
        reload_detail = cdp.eval(
            "({length:history.length,id:history.state.id,parentId:history.state.parentId,entry:history.state.route.entry})"
        )
        cdp.command("Page.reload", {})
        wait_for(
            cdp,
            "document.querySelector('#detailMask')?.classList.contains('show')"
            + " && history.state?.id === " + js_string(reload_detail["id"])
            + " && history.state?.route?.entry === " + js_string(reload_detail["entry"]),
            "community reload restores shareable detail",
            timeout=12,
        )
        if cdp.eval("history.length") != reload_detail["length"]:
            raise CheckFailed("Reloading the shareable community detail changed physical history depth")
        cdp.eval("history.back()")
        wait_for(
            cdp,
            "!document.querySelector('#detailMask')?.classList.contains('show')"
            + " && history.state?.id === " + js_string(reload_detail_parent)
            + " && !history.state?.route?.entry"
            + " && history.state?.route?.q === 'sample composition'",
            "community reloaded detail back",
        )

        # Form DOM survives same-document back/forward.
        cdp.eval("document.querySelector('#submitOpenBtn')?.click()")
        wait_for(cdp, "document.querySelector('#submitMask')?.classList.contains('show')", "community submit layer")
        cdp.eval("document.querySelector('#subTitle').value='history draft'")
        submit_length = cdp.eval("history.length")
        cdp.eval("history.back()")
        wait_for(cdp, "!document.querySelector('#submitMask')?.classList.contains('show')", "community submit back")
        cdp.eval("history.forward()")
        wait_for(cdp, "document.querySelector('#submitMask')?.classList.contains('show') && document.querySelector('#subTitle')?.value === 'history draft'", "community submit forward preserves form")
        cdp.eval("history.back()")
        wait_for(cdp, "!document.querySelector('#submitMask')?.classList.contains('show')", "community submit closes again")

        cdp.eval("document.querySelector('[data-favorites-backup-open]')?.click()")
        wait_for(cdp, "document.querySelector('#favoritesBackupPanel')?.classList.contains('show')", "community backup layer")
        migration_entry = cdp.eval("""({
          title: document.querySelector('#favoritesMigrationTitle')?.textContent || '',
          button: document.querySelector('.favorites-migration-section [data-favorites-migration-start]')?.textContent.trim() || '',
          fallback: document.querySelector('[data-favorites-migration-fallback]')?.href || '',
        })""")
        if migration_entry["title"] != "从旧 pages.dev 找回" or migration_entry["button"] != "找回旧收藏":
            raise CheckFailed("Community backup dialog is missing the permanent pages.dev migration entry")
        fallback_url = urllib.parse.urlparse(migration_entry["fallback"])
        fallback_query = urllib.parse.parse_qs(fallback_url.query)
        if (
            fallback_url.netloc != "novelai-tag.pages.dev"
            or fallback_url.path != "/_favorites-migration-202607.html"
            or fallback_query.get("bridge") != ["20260721"]
        ):
            raise CheckFailed("Community migration fallback does not target the rescue page")
        if cdp.eval("location.href") != initial["url"]:
            raise CheckFailed("Community modal state changed the address bar")
        cdp.eval("history.back()")
        wait_for(cdp, "!document.querySelector('#favoritesBackupPanel')?.classList.contains('show')", "community backup back")

        # Drain only managed parents; the following back must be the one that leaves strings.html.
        drained = 0
        baseline_scroll_checked = initial_scroll <= 80
        while cdp.eval("Boolean(history.state?.parentId)"):
            current_id = cdp.eval("history.state.id")
            cdp.eval("history.back()")
            wait_for(cdp, "history.state?.id !== " + js_string(current_id), "drain community history")
            if cdp.eval("location.pathname") != initial["path"]:
                raise CheckFailed("Community page exited before managed records were exhausted")
            if cdp.eval("history.state?.id") == initial["id"]:
                if initial_scroll > 80:
                    wait_for(
                        cdp,
                        f"Math.abs(scrollY - {int(initial_scroll)}) < 70",
                        "community scroll restoration",
                        timeout=8,
                    )
                baseline_scroll_checked = True
            drained += 1
            if drained > 12:
                raise CheckFailed("Community managed history did not terminate")
        if not baseline_scroll_checked:
            raise CheckFailed("Community history never restored the accepted adult-confirmation baseline")
        check_no_errors(cdp)
        cdp.eval("setTimeout(() => history.back(), 0); true")
        wait_for(cdp, "location.pathname !== '/strings.html'", "leave community after managed history", timeout=10)
        return {
            "initialLength": initial["length"],
            "categoryLength": category_length,
            "searchLength": search_length,
            "detailLength": detail_length,
            "submitLength": submit_length,
            "drainedRecords": drained,
            "urlStayed": initial["url"],
            "adultConfirmationLength": confirm_layer["length"],
            "adultConfirmationKey": initial["adultConfirmed"],
            "mainNsfwKey": initial["mainNsfw"],
        }

    checks = [
        ("desktop home renders", desktop_load),
        ("Tag relay responsive layout", tag_relay_responsive),
        ("announcements render", announcements_panel),
        ("feedback panel responsive", feedback_panel_responsive),
        ("NEW update filter", new_update_filter),
        ("search highlights text", search_highlight),
        ("author search syntax", author_search),
        ("copy card shows feedback", copy_card_feedback),
        ("pack character prompts render", pack_character_prompts),
        ("entry deep-link opens lightbox", deep_link_lightbox),
        ("tag zh lightbox", tag_zh_lightbox),
        ("theme axes", theme_axes),
        ("no-original codex disables original UI", no_original_lightbox),
        ("random explore opens lightbox", random_explore),
        ("resume last browse", resume_browse),
        ("recent entry opens lightbox", recent_entry_lightbox),
        ("codex switch loads wardrobe", codex_switch),
        ("favorites view opens backup dialog", favorites_backup_entry),
        ("legacy codex aliases canonicalize", legacy_codex_alias_routes),
        ("NSFW toggle locks back", nsfw_toggle),
        ("mobile home renders", mobile_home),
        ("mobile card details and keyboard", mobile_card_details),
        ("mobile atlas back stack", mobile_atlas_history),
        ("community internal back stack", community_history),
    ]
    if only:
        needle = only.casefold()
        checks = [(name, func) for name, func in checks if needle in name.casefold()]
        if not checks:
            raise CheckFailed(f"No UI check matched --only={only!r}")
    for name, func in checks:
        run_check(results, name, func)
    return results


def write_report(out_dir: Path, base_url: str, results: list[dict]) -> None:
    ok = all(r["ok"] for r in results)
    report = {
        "ok": ok,
        "baseUrl": base_url,
        "generatedAt": _dt.datetime.now().isoformat(timespec="seconds"),
        "results": results,
    }
    (out_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = [
        "# UI Regression Report",
        "",
        f"- Base URL: `{base_url}`",
        f"- Generated: `{report['generatedAt']}`",
        f"- Result: `{'PASS' if ok else 'FAIL'}`",
        "",
        "| Check | Result | Details |",
        "| --- | --- | --- |",
    ]
    for item in results:
        status = "PASS" if item["ok"] else "FAIL"
        detail = item.get("detail") if item["ok"] else item.get("error")
        if isinstance(detail, dict):
            small = {k: v for k, v in detail.items() if k != "screenshot"}
            detail_text = json.dumps(small, ensure_ascii=False)
        else:
            detail_text = str(detail)
        detail_text = detail_text.replace("|", "\\|")
        lines.append(f"| {item['name']} | {status} | {detail_text} |")
    screenshots = [r.get("detail", {}).get("screenshot") for r in results if r.get("ok") and isinstance(r.get("detail"), dict) and r["detail"].get("screenshot")]
    if screenshots:
        lines.extend(["", "## Screenshots", ""])
        for shot in screenshots:
            lines.append(f"- `{shot}`")
    (out_dir / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run headless UI regression checks for site/index.html")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Preview base URL, default http://localhost:8766/")
    parser.add_argument("--out-dir", default="", help="Output directory. Defaults to output/ui-regression/<timestamp>")
    parser.add_argument("--keep-browser", action="store_true", help="Keep Chrome running after checks")
    parser.add_argument("--only", default="", help="Run checks whose names contain this text")
    args = parser.parse_args()

    out_dir = Path(args.out_dir) if args.out_dir else ROOT / "output" / "ui-regression" / now_stamp()
    out_dir.mkdir(parents=True, exist_ok=True)
    base_url = args.base_url.rstrip("/") + "/"
    preview_proc = None
    chrome_proc = None
    cdp = None
    try:
        preview_proc = start_preview(base_url)
        port = find_free_port()
        chrome_proc = start_chrome(out_dir, port)
        ws_url = page_ws_url(port)
        cdp = CDP(ws_url)
        disable_motion(cdp)
        results = run_suite(base_url, out_dir, cdp, only=args.only)
        write_report(out_dir, base_url, results)
        log("")
        log(f"Report: {out_dir / 'report.md'}")
        log("Result: " + ("PASS" if all(r["ok"] for r in results) else "FAIL"))
        return 0 if all(r["ok"] for r in results) else 1
    except Exception as exc:
        (out_dir / "fatal.txt").write_text(traceback.format_exc(), encoding="utf-8")
        log(f"[FATAL] {exc}")
        log(f"Output: {out_dir}")
        return 1
    finally:
        if cdp:
            cdp.close()
        if chrome_proc and not args.keep_browser:
            chrome_proc.terminate()
        if preview_proc:
            preview_proc.terminate()


if __name__ == "__main__":
    raise SystemExit(main())
