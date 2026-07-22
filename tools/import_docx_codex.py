# -*- coding: utf-8 -*-
"""
Import a structured Word codex with embedded images into site/data.

This is intentionally separate from convert.py. Some community codexes are
semi-structured Word documents whose image/tag layout is regular enough to
parse, but not regular enough for the generic converter.
"""
import argparse
import hashlib
import io
import json
import posixpath
import re
import shutil
import zipfile
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from xml.etree import ElementTree as ET

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "site" / "data"
IMAGE_DIR = ROOT / "site" / "images"
ORIGINAL_DIR = ROOT / "originals"
OUTPUT_DIR = ROOT / "output"
MAXDIM = 1100

NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"

TITLE_STYLES = {"2p4pgv", "6abov9"}
SECTION_STYLES = {"2p4pgv"}


@dataclass
class Paragraph:
    idx: int
    style: str
    text: str
    blips: list[str]


def clean_text(value):
    return re.sub(r"\s+", " ", (value or "").replace("\u3000", " ")).strip()


def read_rels(zf, part):
    rels = {}
    rel_path = str(Path(part).parent / "_rels" / (Path(part).name + ".rels")).replace("\\", "/")
    if rel_path not in zf.namelist():
        return rels
    root = ET.fromstring(zf.read(rel_path))
    for rel in root.findall(f"{REL_NS}Relationship"):
        rid = rel.attrib.get("Id")
        target = rel.attrib.get("Target", "")
        if not rid or not target:
            continue
        if target.startswith("/"):
            rels[rid] = target.lstrip("/")
        else:
            rels[rid] = posixpath.normpath(posixpath.join(posixpath.dirname(part), target))
    return rels


def paragraph_style(p):
    style = p.find("w:pPr/w:pStyle", NS)
    return style.attrib.get(f"{{{NS['w']}}}val", "") if style is not None else ""


def paragraph_content_nodes(p):
    """Yield this paragraph's descendants without entering nested paragraphs.

    Word text boxes embed their own ``w:p`` elements below the surrounding body
    paragraph. ``load_paragraphs`` enumerates both levels, so descending into a
    nested paragraph here would emit the same text or image twice.
    """
    stack = list(reversed(list(p)))
    paragraph_tag = f"{{{NS['w']}}}p"
    while stack:
        node = stack.pop()
        if node.tag == paragraph_tag:
            continue
        yield node
        stack.extend(reversed(list(node)))


def paragraph_text(p):
    chunks = []
    for node in paragraph_content_nodes(p):
        tag = node.tag
        if tag == f"{{{NS['w']}}}t":
            chunks.append(node.text or "")
        elif tag == f"{{{NS['w']}}}tab":
            chunks.append(" ")
        elif tag == f"{{{NS['w']}}}br":
            chunks.append("\n")
    return clean_text("".join(chunks))


def paragraph_blips(p, rels):
    out = []
    for blip in paragraph_content_nodes(p):
        if blip.tag != f"{{{NS['a']}}}blip":
            continue
        rid = blip.attrib.get(f"{{{NS['r']}}}embed") or blip.attrib.get(f"{{{NS['r']}}}link")
        if rid and rid in rels:
            out.append(rels[rid])
    return out


def load_paragraphs(docx_path):
    with zipfile.ZipFile(docx_path) as zf:
        rels = read_rels(zf, "word/document.xml")
        root = ET.fromstring(zf.read("word/document.xml"))
        paragraphs = []
        for i, p in enumerate(root.findall(".//w:p", NS), start=1):
            text = paragraph_text(p)
            blips = paragraph_blips(p, rels)
            if text or blips:
                paragraphs.append(Paragraph(len(paragraphs), paragraph_style(p), text, blips))
    return paragraphs


def is_volume(text):
    return bool(re.fullmatch(r"第[0-9一二三四五六七八九十]+卷", clean_text(text)))


def is_url(text):
    return bool(re.match(r"^(https?://|www\.)", clean_text(text), re.I))


def label_kind(text):
    text = clean_text(text)
    if re.search(r"正面\s*tag\s*[：:]", text, re.I):
        return "positive"
    if re.search(r"反面\s*tag\s*[：:]", text, re.I):
        return "negative"
    if re.search(r"参数\s*[：:]", text):
        return "params"
    if re.search(r"编者注\s*[：:]", text):
        return "editor"
    return ""


def label_suffix(text, kind):
    patterns = {
        "positive": r"正面\s*tag\s*[：:]",
        "negative": r"反面\s*tag\s*[：:]",
        "params": r"参数\s*[：:]",
        "editor": r"编者注\s*[：:]",
    }
    m = re.search(patterns[kind], text, re.I)
    return clean_text(text[m.end():]) if m else ""


def is_by_line(text):
    return bool(re.match(r"^by\s*\S+", clean_text(text), re.I))


def parse_by_line(text):
    m = re.match(r"^(by\s*)(.+)$", clean_text(text), re.I)
    if not m:
        return "", ""
    credit = clean_text(m.group(0))
    author = clean_text(m.group(2))
    return credit, author


def is_title_candidate(item):
    text = clean_text(item.text)
    if not text or item.blips:
        return False
    if is_volume(text) or label_kind(text) or is_by_line(text) or is_url(text):
        return False
    if item.style in TITLE_STYLES:
        return True
    return False


def find_previous_positive(items, start):
    for i in range(start, -1, -1):
        if label_kind(items[i].text) == "positive":
            return i
    return -1


def find_title_for_positive(items, pos_idx):
    floor = find_previous_positive(items, pos_idx - 1)
    for i in range(pos_idx - 1, floor, -1):
        if is_title_candidate(items[i]):
            return i
    for i in range(pos_idx - 1, floor, -1):
        text = clean_text(items[i].text)
        if text and not items[i].blips and not label_kind(text) and not is_by_line(text) and not is_url(text):
            return i
    return -1


def build_valid_titles(items):
    valid = {}
    failures = []
    for i, item in enumerate(items):
        if label_kind(item.text) != "positive":
            continue
        title_idx = find_title_for_positive(items, i)
        if title_idx < 0:
            failures.append({"positiveIndex": item.idx, "text": item.text})
            continue
        valid[title_idx] = i
    return valid, failures


def path_for_title(items, title_idx, valid_title_indices):
    volume = ""
    volume_idx = -1
    for i in range(title_idx, -1, -1):
        if is_volume(items[i].text):
            volume = clean_text(items[i].text)
            volume_idx = i
            break
    path = [volume] if volume else []
    section = ""
    for i in range(volume_idx + 1, title_idx):
        item = items[i]
        text = clean_text(item.text)
        if (
            i not in valid_title_indices
            and item.style in SECTION_STYLES
            and text
            and not item.blips
            and not is_volume(text)
            and not label_kind(text)
            and not is_by_line(text)
            and not is_url(text)
        ):
            section = text
    if section:
        path.append(section)
    return path


def next_title_after(sorted_titles, title_idx):
    for candidate in sorted_titles:
        if candidate > title_idx:
            return candidate
    return None


def next_entry_boundary(items, sorted_titles, valid_title_indices, title_idx):
    next_title = next_title_after(sorted_titles, title_idx)
    end = next_title if next_title is not None else len(items)
    for i in range(title_idx + 1, end):
        if is_volume(items[i].text):
            return i
        if i not in valid_title_indices and is_title_candidate(items[i]):
            return i
    return end


def append_line(lines, text):
    text = clean_text(text)
    if text and (not lines or lines[-1] != text):
        lines.append(text)


def is_character_line(text):
    return bool(re.match(r"^(character|角色)\s*\d+\s*[：:]", clean_text(text), re.I))


def parse_entry(items, title_idx, end_idx, codex_id, seq, valid_title_indices):
    title_item = items[title_idx]
    entry_id = f"{codex_id}-{seq:04d}"
    positive = []
    negative = []
    params = []
    editor = []
    medias = []
    seen_media = set()
    credit = ""
    author = ""
    state = ""

    for item in items[title_idx + 1:end_idx]:
        for media in item.blips:
            if media not in seen_media:
                medias.append(media)
                seen_media.add(media)
        text = clean_text(item.text)
        if not text:
            continue

        if is_by_line(text):
            credit, author = parse_by_line(text)
            continue

        kind = label_kind(text)
        if kind:
            state = kind
            suffix = label_suffix(text, kind)
            if kind == "positive":
                append_line(positive, suffix)
            elif kind == "negative":
                append_line(negative, suffix)
            elif kind == "params":
                append_line(params, suffix)
            elif kind == "editor":
                append_line(editor, suffix)
            continue

        if state == "positive":
            append_line(positive, text)
        elif state == "negative":
            if is_character_line(text):
                append_line(positive, text)
                state = "positive"
            else:
                append_line(negative, text)
        elif state == "params":
            append_line(params, text)
        elif state == "editor":
            append_line(editor, text)

    note_parts = []
    if params:
        note_parts.append("参数：" + "\n".join(params))
    if editor:
        note_parts.append("编者注：" + "\n".join(editor))

    entry = {
        "title": clean_text(title_item.text),
        "path": path_for_title(items, title_idx, valid_title_indices),
        "tags": "\n".join(positive),
        "isNew": False,
        "id": entry_id,
    }
    if negative:
        entry["negative"] = "\n".join(negative)
    if note_parts:
        entry["note"] = "\n\n".join(note_parts)
    if credit:
        entry["credit"] = credit
    return entry, medias, {"author": author, "credit": credit}


def build_tree(entries):
    root = {}
    for entry in entries:
        node = root
        for name in entry.get("path", []):
            cur = node.setdefault(name, {"name": name, "count": 0, "children": {}})
            cur["count"] += 1
            node = cur["children"]

    def emit(node_map):
        return [
            {"name": item["name"], "count": item["count"], "children": emit(item["children"])}
            for item in node_map.values()
        ]

    return emit(root)


def media_ext(media, raw):
    suffix = Path(media).suffix.lower().lstrip(".")
    if suffix == "jpeg":
        suffix = "jpg"
    if suffix in {"jpg", "png", "webp", "gif", "bmp"}:
        return suffix
    try:
        fmt = Image.open(io.BytesIO(raw)).format
        return (fmt or "png").lower().replace("jpeg", "jpg")
    except Exception:
        return "bin"


def hash_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def asset_rev(paths):
    h = hashlib.sha256()
    for path in paths:
        if path and path.exists():
            h.update(hash_file(path).encode("ascii"))
    return h.hexdigest()[:16]


def save_one_image(zf, media, base_name, site_image_dir, original_dir):
    raw = zf.read(media)
    ext = media_ext(media, raw)
    original_name = f"{base_name}.{ext}"
    thumb_name = f"{base_name}.jpg"
    original_path = original_dir / original_name
    thumb_path = site_image_dir / thumb_name

    original_dir.mkdir(parents=True, exist_ok=True)
    site_image_dir.mkdir(parents=True, exist_ok=True)
    with open(original_path, "wb") as fh:
        fh.write(raw)

    image = Image.open(io.BytesIO(raw))
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    image.thumbnail((MAXDIM, MAXDIM), Image.LANCZOS)
    thumb_w, thumb_h = image.size
    image.save(thumb_path, "JPEG", quality=86, optimize=True)
    return {
        "path": thumb_name,
        "original": original_name,
        "width": thumb_w,
        "height": thumb_h,
        "thumbPath": thumb_path,
        "originalPath": original_path,
    }


def write_images(docx_path, codex_id, entries, entry_medias):
    site_image_dir = IMAGE_DIR / codex_id
    original_dir = ORIGINAL_DIR / codex_id
    if site_image_dir.exists():
        shutil.rmtree(site_image_dir)
    if original_dir.exists():
        shutil.rmtree(original_dir)

    written = 0
    with zipfile.ZipFile(docx_path) as zf:
        for entry in entries:
            medias = entry_medias.get(entry["id"], [])
            assets = []
            for i, media in enumerate(medias, start=1):
                suffix = "" if i == 1 else f"-{i:02d}"
                assets.append(save_one_image(zf, media, entry["id"] + suffix, site_image_dir, original_dir))
            if not assets:
                entry["image"] = None
                continue
            primary = assets[0]
            entry["image"] = primary["path"]
            entry["imageWidth"] = primary["width"]
            entry["imageHeight"] = primary["height"]
            entry["original"] = primary["original"]
            entry["images"] = [{"path": a["path"], "original": a["original"]} for a in assets]
            entry["assetRev"] = asset_rev([p for a in assets for p in (a["thumbPath"], a["originalPath"])])
            written += len(assets)
    return written


def parse_docx(docx_path, codex_id):
    items = load_paragraphs(docx_path)
    valid_titles, title_failures = build_valid_titles(items)
    sorted_titles = sorted(valid_titles)
    valid_title_indices = set(valid_titles)
    entries = []
    entry_medias = {}
    author_info = {}
    for seq, title_idx in enumerate(sorted_titles, start=1):
        end_idx = next_entry_boundary(items, sorted_titles, valid_title_indices, title_idx)
        entry, medias, info = parse_entry(items, title_idx, end_idx, codex_id, seq, valid_title_indices)
        entries.append(entry)
        entry_medias[entry["id"]] = medias
        author_info[entry["id"]] = info
    return items, entries, entry_medias, title_failures, author_info


def entry_has_image(entry, entry_medias):
    return bool(entry.get("image") or entry_medias.get(entry["id"]))


def entry_image_count(entry, entry_medias):
    if entry.get("images"):
        return len(entry["images"])
    return len(entry_medias.get(entry["id"], []))


def make_report(docx_path, codex, items, entry_medias, title_failures, author_info):
    all_blips = sum(len(item.blips) for item in items)
    used_blips = sum(len(v) for v in entry_medias.values())
    volume_counts = Counter(entry["path"][0] if entry["path"] else "(missing)" for entry in codex["entries"])
    section_counts = Counter(" / ".join(entry["path"]) for entry in codex["entries"])
    missing = {
        "path": [e["id"] for e in codex["entries"] if not e.get("path")],
        "tags": [e["id"] for e in codex["entries"] if not e.get("tags")],
        "image": [e["id"] for e in codex["entries"] if not entry_has_image(e, entry_medias)],
        "negative": [e["id"] for e in codex["entries"] if not e.get("negative")],
        "note": [e["id"] for e in codex["entries"] if not e.get("note")],
        "credit": [e["id"] for e in codex["entries"] if not e.get("credit")],
    }
    chinese_in_tags = [
        {"id": e["id"], "title": e["title"], "sample": e["tags"][:160]}
        for e in codex["entries"]
        if re.search(r"[\u4e00-\u9fff]", e.get("tags", ""))
    ]
    multi_image = [
        {"id": e["id"], "title": e["title"], "images": entry_image_count(e, entry_medias)}
        for e in codex["entries"]
        if entry_image_count(e, entry_medias) > 1
    ]
    return {
        "source": str(docx_path),
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "codexId": codex["id"],
        "title": codex["title"],
        "entryCount": codex["entryCount"],
        "imagedCount": codex["imagedCount"],
        "paragraphCount": len(items),
        "documentImageBlips": all_blips,
        "usedImageBlips": used_blips,
        "titleFailures": title_failures,
        "volumeCounts": dict(volume_counts),
        "pathCounts": dict(section_counts),
        "missingCounts": {k: len(v) for k, v in missing.items()},
        "missingSamples": {k: v[:20] for k, v in missing.items() if v},
        "multiImageCount": len(multi_image),
        "multiImageSamples": multi_image[:50],
        "chineseInTagsCount": len(chinese_in_tags),
        "chineseInTagsSamples": chinese_in_tags[:50],
        "creditSamples": [
            {"id": eid, **info}
            for eid, info in list(author_info.items())[:30]
            if info.get("credit")
        ],
    }


def write_json(path, payload, compact=False):
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":") if compact else None, indent=None if compact else 2)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text + "\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("docx", type=Path)
    ap.add_argument("--codex-id", default="jiegou_yuandian")
    ap.add_argument("--title", default="解构原典")
    ap.add_argument("--version", default="2025.7.18")
    ap.add_argument("--author", default="解构原典编撰组")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    docx_path = args.docx.resolve()
    if not docx_path.exists():
        raise SystemExit(f"Missing docx: {docx_path}")

    items, entries, entry_medias, title_failures, author_info = parse_docx(docx_path, args.codex_id)
    codex = {
        "id": args.codex_id,
        "title": args.title,
        "version": args.version,
        "author": args.author,
        "entryCount": len(entries),
        "imagedCount": 0,
        "tree": build_tree(entries),
        "entries": entries,
    }

    if args.apply:
        written_images = write_images(docx_path, args.codex_id, entries, entry_medias)
        codex["imagedCount"] = sum(1 for e in entries if e.get("image"))
        write_json(DATA_DIR / f"{args.codex_id}.json", codex, compact=True)
    else:
        written_images = 0
        codex["imagedCount"] = sum(1 for e in entries if entry_medias.get(e["id"]))

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    report_dir = OUTPUT_DIR / f"{args.codex_id}_import_{stamp}"
    report = make_report(docx_path, codex, items, entry_medias, title_failures, author_info)
    report["apply"] = bool(args.apply)
    report["writtenImages"] = written_images
    write_json(report_dir / "report.json", report)

    summary = {
        "apply": bool(args.apply),
        "codexId": args.codex_id,
        "entries": codex["entryCount"],
        "imagedEntries": codex["imagedCount"],
        "documentImageBlips": report["documentImageBlips"],
        "usedImageBlips": report["usedImageBlips"],
        "writtenImages": written_images,
        "titleFailures": len(title_failures),
        "missingCounts": report["missingCounts"],
        "multiImageCount": report["multiImageCount"],
        "chineseInTagsCount": report["chineseInTagsCount"],
        "report": str(report_dir / "report.json"),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
