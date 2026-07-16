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


def wait_for(cdp: CDP, expr: str, label: str, timeout: float = 8.0, interval: float = 0.25):
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
  return true;
})()
""")
        wait_for(cdp, "document.querySelector('#resultInfo')?.textContent.includes('author:戒红所')", "author search result")
        settle(cdp, 350)
        data = cdp.eval("({result: document.querySelector('#resultInfo')?.textContent || '', cards: document.querySelectorAll('.card').length, marks: document.querySelectorAll('mark').length})")
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
        wait_for(cdp, "document.querySelector('#toast')?.textContent.includes('已复制')", "copy toast", timeout=6)
        data = cdp.eval("({toast: document.querySelector('#toast')?.textContent || '', recent: JSON.parse(localStorage.getItem('fadian-recent') || '[]').length})")
        if data["recent"] <= 0:
            raise CheckFailed("Copy did not record a recent entry")
        check_no_errors(cdp)
        return data

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
    onlyImaged:false,
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
        cdp.eval("""
(() => {
  const card = [...document.querySelectorAll('.card')].find(node => !node.classList.contains('no-img')) || document.querySelector('.card');
  card?.click();
  return true;
})()
""")
        wait_for(cdp, "document.querySelector('#toast')?.textContent.includes('已复制')", "recent copy toast", timeout=6)
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
        return data

    def codex_switch():
        clear_errors(cdp)
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "document.querySelector('#codexBtn') && document.querySelectorAll('.card').length >= 1", "codex picker ready")
        cdp.eval("""
(() => {
  document.querySelector('#codexBtn')?.click();
  const stringType = document.querySelector('#codexMenu .codex-type[data-type="string"]');
  if (!stringType) throw new Error('artist-string type item not found');
  stringType.click();
  const stringIds = [...document.querySelectorAll('#codexMenu .codex-item[data-id]')].map(node => node.dataset.id);
  const expected = ['artist_nai45_personal', 'artist_nai45_strings', 'composition_style', 'qianteng'];
  if (JSON.stringify(stringIds) !== JSON.stringify(expected)) {
    throw new Error(`artist-string order mismatch: ${stringIds.join(',')}`);
  }
  const target = document.querySelector('#codexMenu .codex-item[data-id="qianteng"]');
  if (!target) throw new Error('wardrobe codex item not found');
  target.click();
  return true;
})()
""")
        wait_for(cdp, "document.querySelector('#codexBtnText')?.textContent.includes('衣柜')", "wardrobe selected", timeout=10)
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "wardrobe cards", timeout=10)
        settle(cdp, 350)
        data = cdp.eval("({codex: document.querySelector('#codexBtnText')?.textContent || '', url: location.href, cards: document.querySelectorAll('.card').length, result: document.querySelector('#resultInfo')?.textContent || '', type: 'string', position: 4})")
        if "衣柜" not in data["codex"]:
            raise CheckFailed("Codex switch did not select wardrobe")
        check_no_errors(cdp)
        return data

    def favorites_backup_entry():
        clear_errors(cdp)
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "favorite source cards")
        normal_hidden = cdp.eval("document.querySelector('#favoritesViewBackupBtn')?.hidden === true")
        cdp.eval(f"localStorage.setItem('fadian-favs', JSON.stringify(['suozhang:{entry_id}']))")
        navigate(cdp, base + "?codex=suozhang&fav=1")
        wait_for(cdp, "!document.querySelector('#favoritesViewBackupBtn')?.hidden", "favorites backup entry", timeout=10)
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "favorite cards", timeout=10)
        cdp.eval("document.querySelector('#favoritesViewBackupBtn').click()")
        wait_for(cdp, "!document.querySelector('#favoritesBackupPanel')?.hidden", "favorites backup dialog")
        settle(cdp, 250)
        data = cdp.eval("({button: document.querySelector('#favoritesViewBackupBtn')?.textContent.trim() || '', dialog: document.querySelector('#favoritesBackupTitle')?.textContent || '', atlas: document.querySelector('#favoritesCurrentAtlas')?.textContent || '', normalHidden: " + ("true" if normal_hidden else "false") + "})")
        if not data["normalHidden"]:
            raise CheckFailed("Favorites backup entry was visible outside the favorites view")
        if "备份与恢复" not in data["button"] or data["dialog"] != "收藏备份与恢复":
            raise CheckFailed("Favorites backup entry did not open the shared dialog")
        cdp.eval("document.querySelector('#favoritesBackupClose')?.click(); localStorage.removeItem('fadian-favs')")
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

    def mobile_home():
        clear_errors(cdp)
        cdp.command("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": True})
        navigate(cdp, base + "?codex=suozhang")
        wait_for(cdp, "document.querySelectorAll('.card').length >= 1", "mobile cards")
        settle(cdp, 500)
        data = cdp.eval("({cards: document.querySelectorAll('.card').length, mobileSearch: !!document.querySelector('#mobileSearchBtn'), result: document.querySelector('#resultInfo')?.textContent || ''})")
        if not data["mobileSearch"]:
            raise CheckFailed("Mobile search button missing")
        check_no_errors(cdp)
        shot = screenshot(cdp, out_dir, "mobile-home")
        return {**data, "screenshot": shot}

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

        # Filter changes made inside settings belong to the underlying route
        # and must survive when the settings history layer closes.
        cdp.eval("document.querySelector('#settingsBtn')?.click()")
        wait_for(cdp, "document.querySelector('#settings')?.classList.contains('show')", "settings filter layer")
        cdp.eval("document.querySelector('#onlyImaged')?.click()")
        wait_for(cdp, "document.querySelector('#onlyImaged')?.checked && history.state?.route?.onlyImaged === true", "settings filter route update")
        cdp.eval("history.back()")
        wait_for(cdp, "!document.querySelector('#settings')?.classList.contains('show') && document.querySelector('#onlyImaged')?.checked && history.state?.route?.onlyImaged === true", "settings filter survives close")
        cdp.eval("document.querySelector('#settingsBtn')?.click(); document.querySelector('#onlyImaged')?.click()")
        wait_for(cdp, "document.querySelector('#settings')?.classList.contains('show') && !document.querySelector('#onlyImaged')?.checked && history.state?.route?.onlyImaged === false", "settings filter reset")
        cdp.eval("history.back()")
        wait_for(cdp, "!document.querySelector('#settings')?.classList.contains('show') && history.state?.route?.onlyImaged === false", "reset filter survives close")

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
        cdp.eval("document.querySelector('#onlyImaged')?.click()")
        settle(cdp, 180)
        if cdp.eval("history.length") != search_length:
            raise CheckFailed("Continuous search/filtering increased atlas history depth")
        cdp.eval("history.back()")
        wait_for(cdp, "!document.body.classList.contains('search-mode') && history.state?.route?.q === 'hair long'", "first search back")
        cdp.eval("history.back()")
        wait_for(cdp, "history.state?.route?.q === ''", "second search back")

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
        cdp.eval("localStorage.setItem('community-only-favorites','false'); localStorage.setItem('strings-nsfw','false')")
        cdp.command("Page.reload", {"ignoreCache": True})
        try:
            wait_for(cdp, "history.state?.page === 'community' && document.querySelectorAll('.community-card').length >= 1", "managed community history", timeout=12)
        except CheckFailed as exc:
            boot = cdp.eval("({ready:document.readyState,state:history.state,cards:document.querySelectorAll('.community-card').length,errors:window.__qaErrors||[],text:document.querySelector('#resultInfo')?.textContent||''})")
            raise CheckFailed(f"{exc}; boot={boot}") from exc
        initial = cdp.eval("({length:history.length,id:history.state.id,url:location.href,path:location.pathname})")
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

        # Persistent safety/favorite filters replace the current record and never touch the URL.
        cdp.eval("document.querySelector('#nsfwBtn')?.click(); document.querySelector('#favFilterBtn')?.click(); document.querySelector('#favFilterBtn')?.click()")
        settle(cdp, 180)
        if cdp.eval("history.length") != search_length:
            raise CheckFailed("Community filters increased history depth")
        if cdp.eval("location.href") != initial["url"]:
            raise CheckFailed("Community route/filter state changed the address bar")

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
        if cdp.eval("location.href") != initial["url"]:
            raise CheckFailed("Community modal state changed the address bar")
        cdp.eval("history.back()")
        wait_for(cdp, "!document.querySelector('#favoritesBackupPanel')?.classList.contains('show')", "community backup back")

        # Drain only managed parents; the following back must be the one that leaves strings.html.
        drained = 0
        while cdp.eval("Boolean(history.state?.parentId)"):
            current_id = cdp.eval("history.state.id")
            cdp.eval("history.back()")
            wait_for(cdp, "history.state?.id !== " + js_string(current_id), "drain community history")
            if cdp.eval("location.pathname") != initial["path"]:
                raise CheckFailed("Community page exited before managed records were exhausted")
            drained += 1
            if drained > 12:
                raise CheckFailed("Community managed history did not terminate")
        if initial_scroll > 80:
            wait_for(cdp, f"Math.abs(scrollY - {int(initial_scroll)}) < 70", "community scroll restoration", timeout=8)
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
        }

    checks = [
        ("desktop home renders", desktop_load),
        ("search highlights text", search_highlight),
        ("author search syntax", author_search),
        ("copy card shows feedback", copy_card_feedback),
        ("entry deep-link opens lightbox", deep_link_lightbox),
        ("random explore opens lightbox", random_explore),
        ("resume last browse", resume_browse),
        ("recent entry opens lightbox", recent_entry_lightbox),
        ("codex switch loads wardrobe", codex_switch),
        ("favorites view opens backup dialog", favorites_backup_entry),
        ("NSFW toggle locks back", nsfw_toggle),
        ("mobile home renders", mobile_home),
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
