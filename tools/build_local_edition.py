# -*- coding: utf-8 -*-
"""构建不含官方数据的「法典图鉴本地版」Windows 发行包。

输出：
  output/local-edition/法典图鉴本地版/
  output/local-edition/法典图鉴本地版-YYYYMMDD.zip

需要：Pillow（项目运行依赖）与 PyInstaller（仅构建机需要）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent.parent
OUTPUT_ROOT = ROOT / "output" / "local-edition"
PRODUCT_NAME = "法典图鉴本地版"


LOCAL_CSS = """
/* 独立本地版：隐藏需要线上后端或公开站点上下文的入口。 */
body.local-edition #globalReportBtn,
body.local-edition .more-item[href*="github.com/AgIzT/NovelAI-Tag"],
body.local-edition #announcementsBtn,
body.local-edition #editToggle,
body.local-edition #announcementsFeedbackLink,
body.local-edition #announcementsPanel,
body.local-edition #feedbackPanel,
body.local-edition #onboarding,
body.local-edition #reportLightbox,
body.local-edition #shareLightbox,
body.local-edition .report-card-btn,
body.local-edition [data-favorites-migration-banner],
body.local-edition .favorites-migration-section,
body.local-edition .favorites-backup-stats > :nth-child(2) { display: none !important; }
body.local-edition .favorites-backup-stats { grid-template-columns: minmax(0, 1fr); }
""".lstrip()


LOCAL_ABOUT = {
    "intro": "这是你的本地法典图鉴。法典、词条、原图和缩略图都只保存在当前文件夹中。",
    "links": [],
    "credits": ["本地版只提供软件与演示数据，请使用你自己的词条和图片。"],
    "tips": [
        "当前内置一本可自由修改或删除的示例法典。",
        "编辑模式默认开启，点击卡片即可修改词条或上传图片。",
        "点击顶部法典名称，在菜单底部进入法典管理，可创建自己的法典。",
        "每次保存前都会自动备份到 output/edit-backups。",
        "关闭“法典图鉴本地版”窗口即可停止本地服务。",
    ],
}


LOCAL_ANNOUNCEMENTS = []


LOCAL_HTML_REPLACEMENTS = {
    "用 JSON 文件搬运法典图鉴与共创广场收藏。": "用 JSON 文件备份和恢复本地法典收藏。",
    "只包含两处收藏标识，不含浏览记录、设置、图片或 Prompt；文件只在当前设备处理，不会上传。":
        "只包含本地法典收藏标识，不含浏览记录、设置、图片或 Prompt；文件只在当前设备处理，不会上传。",
    "一份文件会同时包含两处收藏。": "备份文件只包含本地法典收藏。",
    "这会同时替换法典图鉴与共创广场收藏。": "这会替换当前设备的本地法典收藏。",
    "用备份同时替换两处收藏，执行前会再次确认。":
        "用备份替换本地法典收藏，执行前会再次确认。",
}


LOCAL_HTML_BLOCKS_TO_REMOVE = (
    ('<aside class="favorites-migration-banner"', "</aside>"),
    ('<section class="favorites-backup-section favorites-migration-section"', "</section>"),
)


LOCAL_ASSET_IGNORE = shutil.ignore_patterns(
    "admin",
    "admin.js",
    "admin.css",
    "community",
    "community.js",
    "community.css",
)


def _safe_remove_tree(path: Path):
    path = path.resolve()
    allowed = OUTPUT_ROOT.resolve()
    if path == allowed or allowed not in path.parents:
        raise RuntimeError(f"拒绝删除构建目录之外的路径：{path}")
    if path.exists():
        shutil.rmtree(path)


def _write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _remove_html_block(text: str, start_marker: str, end_marker: str):
    """Remove a known, non-nested template block and fail loudly on template drift."""
    start = text.find(start_marker)
    if start < 0:
        raise RuntimeError(f"本地版待移除 HTML 块不存在：{start_marker}")
    end = text.find(end_marker, start)
    if end < 0:
        raise RuntimeError(f"本地版 HTML 块缺少结束标记：{start_marker}")
    return text[:start] + text[end + len(end_marker):]


def _font(size, bold=False):
    fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    candidates = [fonts / ("arialbd.ttf" if bold else "arial.ttf"), fonts / "segoeui.ttf"]
    for candidate in candidates:
        try:
            return ImageFont.truetype(str(candidate), size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def _make_demo_image(path: Path, palette, number, title):
    width, height = 900, 1200
    image = Image.new("RGB", (width, height), palette[0])
    draw = ImageDraw.Draw(image)
    for y in range(height):
        ratio = y / max(1, height - 1)
        color = tuple(
            round(start * (1 - ratio) + end * ratio)
            for start, end in zip(palette[0], palette[1])
        )
        draw.line((0, y, width, y), fill=color)
    draw.rounded_rectangle(
        (90, 100, 810, 1100), radius=48, outline=(255, 255, 255), width=5
    )
    draw.ellipse(
        (190, 260, 710, 780), fill=palette[2], outline=(255, 255, 255), width=4
    )
    draw.rounded_rectangle((250, 420, 650, 950), radius=180, fill=palette[3])
    draw.text(
        (130, 145),
        f"DEMO {number:02d}",
        font=_font(56, bold=True),
        fill=(255, 255, 255),
    )
    draw.text(
        (130, 1010),
        title,
        font=_font(40, bold=True),
        fill=(255, 255, 255),
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, "JPEG", quality=91, optimize=True)
    return image


def _asset_rev(*payloads):
    digest = hashlib.sha256()
    for payload in payloads:
        digest.update(hashlib.sha256(payload).hexdigest().encode("ascii"))
    return digest.hexdigest()[:16]


def create_demo_data(product: Path):
    data_dir = product / "site" / "data"
    thumb_dir = product / "site" / "images" / "demo"
    original_dir = product / "originals" / "demo"
    entries = []
    specs = [
        (
            "demo-0001",
            "暖色人物示例",
            "1girl, solo, warm lighting, soft shadow",
            ["示例分类", "带图词条"],
            ((228, 118, 91), (84, 34, 70), (250, 190, 112), (95, 52, 92)),
            "WARM LIGHT",
        ),
        (
            "demo-0002",
            "冷色场景示例",
            "scenery, night, blue hour, cinematic lighting",
            ["示例分类", "带图词条"],
            ((53, 118, 176), (23, 37, 84), (103, 209, 218), (44, 67, 130)),
            "BLUE HOUR",
        ),
    ]
    for seq, (eid, title, tags, path, palette, art_title) in enumerate(specs, 1):
        original_path = original_dir / f"{eid}.jpg"
        source = _make_demo_image(original_path, palette, seq, art_title)
        thumb = source.copy()
        thumb.thumbnail((1100, 1100), Image.Resampling.LANCZOS)
        thumb_path = thumb_dir / f"{eid}.jpg"
        thumb_path.parent.mkdir(parents=True, exist_ok=True)
        thumb.save(thumb_path, "JPEG", quality=86, optimize=True)
        original_bytes = original_path.read_bytes()
        thumb_bytes = thumb_path.read_bytes()
        entry = {
            "id": eid,
            "seq": seq,
            "path": path,
            "title": title,
            "tags": tags,
            "note": "点击这张卡片即可修改标题、Tag、分类或图片。",
            "rating": "safe",
            "isNew": seq == 1,
            "image": f"{eid}.jpg",
            "original": f"{eid}.jpg",
            "imageWidth": thumb.width,
            "imageHeight": thumb.height,
            "assetRev": _asset_rev(thumb_bytes, original_bytes),
        }
        if seq == 2:
            entry["negative"] = "low quality, blurry"
        entries.append(entry)
    entries.append({
        "id": "demo-0003",
        "seq": 3,
        "path": ["示例分类", "无图词条"],
        "title": "等待补图的示例",
        "tags": "your prompt tags here",
        "note": "这是无图词条示例。编辑模式下仍可点开，并为它补上一张图片。",
        "rating": "safe",
    })

    tree = [{
        "name": "示例分类",
        "count": 3,
        "children": [
            {"name": "带图词条", "count": 2, "children": []},
            {"name": "无图词条", "count": 1, "children": []},
        ],
    }]
    meta = {
        "id": "demo",
        "type": "codex",
        "title": "欢迎使用 · 示例法典",
        "selectorTitle": "示例法典",
        "version": "1.0",
        "author": "本地版演示",
        "entryCount": 3,
        "imagedCount": 2,
        "source": "可自由修改或删除的本地演示数据",
    }
    book = dict(meta)
    book.update({"editorMaxSeq": 3, "tree": tree, "entries": entries})
    _write_json(data_dir / "codexes.json", [meta])
    _write_json(data_dir / "demo.json", book)
    _write_json(data_dir / "media.json", {
        "baseUrl": "",
        "imagePrefix": "images",
        "originalPrefix": "originals",
        "localFallback": True,
    })
    _write_json(data_dir / "about.json", LOCAL_ABOUT)
    _write_json(data_dir / "announcements.json", LOCAL_ANNOUNCEMENTS)
    _write_json(data_dir / "strings_index.json", {"collections": [], "imagedCount": 0})


def create_local_site(product: Path):
    site = product / "site"
    shutil.copytree(
        ROOT / "site" / "assets",
        site / "assets",
        ignore=LOCAL_ASSET_IGNORE,
    )
    html = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
    html = html.replace(
        "<title>法典图鉴 · NovelAI 提示词</title>",
        "<title>法典图鉴本地版</title>",
    )
    html = html.replace("<body>", '<body class="local-edition">', 1)
    html = html.replace(
        '<link rel="stylesheet" href="assets/favorites-backup.css">',
        '<link rel="stylesheet" href="assets/favorites-backup.css">\n'
        '<link rel="stylesheet" href="assets/local-edition.css">',
        1,
    )
    for source, target in LOCAL_HTML_REPLACEMENTS.items():
        if source not in html:
            raise RuntimeError(f"本地版文案替换目标不存在：{source}")
        html = html.replace(source, target)
    for start_marker, end_marker in LOCAL_HTML_BLOCKS_TO_REMOVE:
        html = _remove_html_block(html, start_marker, end_marker)
    filtered = []
    for line in html.splitlines():
        if any(host in line for host in (
            "assets.quicktagcloud.com",
            "fonts.googleapis.com",
            "fonts.gstatic.com",
        )):
            continue
        filtered.append(line)
    site.mkdir(parents=True, exist_ok=True)
    (site / "index.html").write_text("\n".join(filtered) + "\n", encoding="utf-8")
    (site / "assets" / "local-edition.css").write_text(LOCAL_CSS, encoding="utf-8")
    create_demo_data(product)


def create_icon(path: Path):
    image = Image.new("RGBA", (256, 256), (20, 137, 128, 255))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (18, 18, 238, 238),
        radius=52,
        fill=(20, 137, 128, 255),
        outline=(235, 250, 247, 255),
        width=10,
    )
    draw.rounded_rectangle((60, 52, 196, 204), radius=18, fill=(245, 249, 247, 255))
    draw.line((128, 54, 128, 202), fill=(20, 137, 128, 255), width=7)
    draw.line((82, 92, 112, 92), fill=(20, 137, 128, 255), width=7)
    draw.line((144, 92, 174, 92), fill=(20, 137, 128, 255), width=7)
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(
        path,
        format="ICO",
        sizes=[(256, 256), (128, 128), (64, 64), (32, 32), (16, 16)],
    )


def build_executable(product: Path, build_root: Path):
    icon = build_root / "local-edition.ico"
    create_icon(icon)
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--console",
        "--name",
        PRODUCT_NAME,
        "--icon",
        str(icon),
        "--distpath",
        str(product),
        "--workpath",
        str(build_root / "work"),
        "--specpath",
        str(build_root / "spec"),
        str(ROOT / "tools" / "local_launcher.py"),
    ]
    subprocess.run(command, cwd=ROOT, check=True)


def write_readme(product: Path):
    text = """法典图鉴本地版
================

使用方法
--------
1. 双击“法典图鉴本地版.exe”（也可双击备用的“启动法典图鉴.bat”）。
2. 浏览器会自动打开，编辑模式默认开启。
3. 内置“示例法典”可以自由修改或删除；点击顶部法典名称，在菜单底部进入“法典管理”即可新建自己的法典。
4. 关闭启动器窗口即可停止本地服务。

文件保存位置
------------
- 法典数据：site\\data\\
- 缩略图：site\\images\\
- 原图：originals\\
- 自动备份：output\\edit-backups\\

本地版不需要安装 Python，不需要 Git、R2 或 Cloudflare，也不会自动上传任何内容。
请完整保留整个文件夹，不要只移动 EXE。
"""
    (product / "使用说明.txt").write_text(text, encoding="utf-8-sig")
    bat = """@echo off
REM Encoding: GBK/936
chcp 936 >nul
cd /d "%~dp0"
start "" "%~dp0法典图鉴本地版.exe"
"""
    (product / "启动法典图鉴.bat").write_bytes(bat.encode("gbk"))
    license_path = ROOT / "LICENSE"
    if license_path.is_file():
        shutil.copy2(license_path, product / "LICENSE.txt")


def create_zip(product: Path, target: Path):
    if target.exists():
        target.unlink()
    with zipfile.ZipFile(
        target,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as archive:
        for path in sorted(product.rglob("*")):
            if path.is_file():
                archive.write(path, Path(PRODUCT_NAME) / path.relative_to(product))


def main(argv=None):
    parser = argparse.ArgumentParser(description="构建法典图鉴独立本地版")
    parser.add_argument("--date", default=time.strftime("%Y%m%d"), help="发行包日期标识")
    args = parser.parse_args(argv)

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    product = OUTPUT_ROOT / PRODUCT_NAME
    _safe_remove_tree(product)
    build_root = Path(tempfile.mkdtemp(prefix="build-", dir=OUTPUT_ROOT))
    try:
        product.mkdir(parents=True)
        create_local_site(product)
        write_readme(product)
        build_executable(product, build_root)
        zip_path = OUTPUT_ROOT / f"{PRODUCT_NAME}-{args.date}.zip"
        create_zip(product, zip_path)
    finally:
        _safe_remove_tree(build_root)

    digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    print(f"Product: {product}")
    print(f"Archive: {zip_path}")
    print(f"SHA256: {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
