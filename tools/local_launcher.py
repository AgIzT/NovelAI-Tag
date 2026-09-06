# -*- coding: utf-8 -*-
"""法典图鉴独立本地版启动器。

该文件既可直接由 Python 运行，也可由 PyInstaller 打包为单个 EXE。
网页与用户数据始终放在 EXE 同目录，确保浏览器编辑后可以直接持久化。
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser

# 显式导入让 PyInstaller 稳定收集 Pillow；实际图片处理位于 edit_server。
import PIL  # noqa: F401

from edit_server import EditStore, Server, make_handler
from local_edition_version import VERSION


DEFAULT_PORT = 18769


def _configure_console():
    if os.name != "nt":
        return
    try:
        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
        ctypes.windll.kernel32.SetConsoleCP(65001)
        ctypes.windll.kernel32.SetConsoleTitleW(f"法典图鉴本地版 v{VERSION}")
    except Exception:
        pass
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def application_root(explicit_root=""):
    if explicit_root:
        return os.path.abspath(explicit_root)
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def ensure_local_layout(root):
    site = os.path.join(root, "site")
    data = os.path.join(site, "data")
    index_html = os.path.join(site, "index.html")
    if not os.path.isfile(index_html):
        raise RuntimeError("缺少 site/index.html，请保留 EXE 旁边的 site 文件夹。")
    os.makedirs(data, exist_ok=True)
    os.makedirs(os.path.join(site, "images"), exist_ok=True)
    os.makedirs(os.path.join(root, "originals"), exist_ok=True)
    os.makedirs(os.path.join(root, "output", "edit-backups"), exist_ok=True)

    index_path = os.path.join(data, "codexes.json")
    if not os.path.isfile(index_path):
        with open(index_path, "w", encoding="utf-8") as fh:
            fh.write("[]\n")
    media_path = os.path.join(data, "media.json")
    if not os.path.isfile(media_path):
        media = {
            "baseUrl": "",
            "imagePrefix": "images",
            "originalPrefix": "originals",
            "localFallback": True,
        }
        with open(media_path, "w", encoding="utf-8") as fh:
            json.dump(media, fh, ensure_ascii=False, indent=2)
            fh.write("\n")


class LocalEditStore(EditStore):
    def capabilities(self):
        info = super().capabilities()
        info["localEdition"] = True
        info["localVersion"] = VERSION
        info["pendingR2Sync"] = False
        return info

    def set_image(self, cid, eid, durl):
        result = super().set_image(cid, eid, durl)
        result["pendingR2Sync"] = False
        return result

    def create_entry_with_image(self, cid, payload, durl):
        result = super().create_entry_with_image(cid, payload, durl)
        result["pendingR2Sync"] = False
        return result

    def delete_image(self, cid, eid):
        result = super().delete_image(cid, eid)
        result["pendingR2Sync"] = False
        return result


def probe_local_edition(port, timeout=0.8):
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/__edit__/ping", timeout=timeout
        ) as response:
            data = json.loads(response.read())
        return bool(data.get("ok") and data.get("localEdition") is True)
    except (OSError, ValueError, urllib.error.URLError):
        return False


def wait_until_ready(port, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if probe_local_edition(port, timeout=0.3):
            return True
        time.sleep(0.05)
    return False


def open_site(port):
    return webbrowser.open(f"http://localhost:{port}/", new=1)


def pause_on_error(message):
    print(f"\n[启动失败] {message}")
    if sys.stdin and sys.stdin.isatty():
        try:
            input("\n按回车键退出……")
        except (EOFError, KeyboardInterrupt):
            pass


def run(root, port=DEFAULT_PORT, open_browser=True):
    ensure_local_layout(root)

    if probe_local_edition(port):
        print(f"法典图鉴本地版已经在运行：http://localhost:{port}/")
        if open_browser:
            open_site(port)
        return 0

    store = LocalEditStore(root)
    try:
        server = Server(("127.0.0.1", port), make_handler(store))
    except OSError as ex:
        raise RuntimeError(f"端口 {port} 已被其他程序占用：{ex}") from ex

    thread = threading.Thread(
        target=server.serve_forever,
        kwargs={"poll_interval": 0.1},
        daemon=True,
    )
    thread.start()
    if not wait_until_ready(port):
        server.shutdown()
        server.server_close()
        raise RuntimeError("本地服务未能按时启动。")

    print("=" * 56)
    print(f"法典图鉴本地版 v{VERSION} 正在运行")
    print(f"地址：http://localhost:{port}/")
    print("内容与图片只保存在本机，不需要 R2、Cloudflare 或 Git。")
    print("关闭这个窗口即可停止服务。")
    print("=" * 56)
    if open_browser:
        open_site(port)

    try:
        while thread.is_alive():
            thread.join(timeout=0.5)
    except KeyboardInterrupt:
        print("\n正在停止……")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    return 0


def main(argv=None):
    _configure_console()
    parser = argparse.ArgumentParser(description="启动法典图鉴独立本地版")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--root", default="", help=argparse.SUPPRESS)
    parser.add_argument("--no-browser", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        return run(application_root(args.root), args.port, not args.no_browser)
    except Exception as ex:
        pause_on_error(str(ex))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
