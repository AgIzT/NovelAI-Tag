# -*- coding: utf-8 -*-
"""
Import images embedded in codex Excel files.

Default mode is a dry run:
  python tools/import_excel_images.py

Write files only when explicitly requested:
  python tools/import_excel_images.py --apply --codex-id suozhang --excel-dir 常规法典5-20版

The importer reads .xlsx as a zip file. It maps each picture anchor to the
nearest title/tag cell on its left, matches that tag string to the selected
codex JSON, then writes:
  originals/<codexId>/<entryId>.<ext>      original embedded image
  site/images/<codexId>/<entryId>.jpg      local thumbnail cache synced to R2
"""
import argparse
import hashlib
import io
import json
import os
import posixpath
import re
import unicodedata
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree as ET

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "site" / "data"
MAXDIM = 1100

NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "odr": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "xdr": "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}


@dataclass
class ImageRef:
    row: int
    col: int
    media: str


@dataclass
class ExcelCandidate:
    workbook: Path
    sheet: str
    row: int
    col: int
    title: str
    tags: str
    images: list[str]


@dataclass
class Match:
    entry: dict
    candidate: ExcelCandidate
    reason: str


def default_excel_dir():
    hits = [p for p in ROOT.glob("*5-20*") if p.is_dir()]
    if len(hits) != 1:
        raise SystemExit("Could not find exactly one *5-20* Excel directory; pass --excel-dir.")
    return hits[0]


def rels_path(part):
    p = Path(part)
    return str(p.parent / "_rels" / (p.name + ".rels")).replace("\\", "/")


def read_rels(zf, part):
    rp = rels_path(part)
    out = {}
    if rp not in zf.namelist():
        return out
    root = ET.fromstring(zf.read(rp))
    for rel in root:
        out[rel.attrib["Id"]] = rel.attrib["Target"]
    return out


def norm_target(src_part, target):
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(posixpath.dirname(src_part), target))


def excel_col(ref):
    m = re.match(r"([A-Z]+)", ref)
    if not m:
        return 0
    n = 0
    for ch in m.group(1):
        n = n * 26 + ord(ch) - 64
    return n


def load_shared_strings(zf):
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    values = []
    with zf.open("xl/sharedStrings.xml") as fh:
        for _, elem in ET.iterparse(fh, events=("end",)):
            if elem.tag.endswith("}si"):
                values.append("".join(t.text or "" for t in elem.iter() if t.tag.endswith("}t")))
                elem.clear()
    return values


def workbook_sheets(zf):
    wb = ET.fromstring(zf.read("xl/workbook.xml"))
    wb_rels = read_rels(zf, "xl/workbook.xml")
    sheets = []
    for sheet in wb.findall(".//main:sheets/main:sheet", NS):
        rid = sheet.attrib["{%s}id" % NS["odr"]]
        sheets.append((sheet.attrib["name"], norm_target("xl/workbook.xml", wb_rels[rid])))
    return sheets


def cell_text(cell, shared):
    typ = cell.attrib.get("t")
    if typ == "s":
        v = cell.find("main:v", NS)
        return shared[int(v.text)] if v is not None and v.text is not None else ""
    if typ == "inlineStr":
        return "".join(t.text or "" for t in cell.iter() if t.tag.endswith("}t"))
    v = cell.find("main:v", NS)
    return v.text if v is not None and v.text is not None else ""


def read_cells(zf, sheet_part, shared):
    cells = {}
    with zf.open(sheet_part) as fh:
        for _, row in ET.iterparse(fh, events=("end",)):
            if not row.tag.endswith("}row"):
                continue
            r = int(row.attrib.get("r", "0"))
            for cell in row:
                if not cell.tag.endswith("}c"):
                    continue
                ref = cell.attrib.get("r", "")
                c = excel_col(ref)
                if not r or not c:
                    continue
                text = cell_text(cell, shared).strip()
                if text:
                    cells[(r, c)] = text
            row.clear()
    return cells


def drawing_part_for_sheet(zf, sheet_part):
    sheet_rels = read_rels(zf, sheet_part)
    with zf.open(sheet_part) as fh:
        for _, elem in ET.iterparse(fh, events=("end",)):
            if elem.tag.endswith("}drawing"):
                rid = elem.attrib["{%s}id" % NS["r"]]
                return norm_target(sheet_part, sheet_rels[rid])
            elem.clear()
    return None


def read_images(zf, drawing_part):
    drawing_rels = read_rels(zf, drawing_part)
    root = ET.fromstring(zf.read(drawing_part))
    out = []
    for anchor in root:
        if not (anchor.tag.endswith("}oneCellAnchor") or anchor.tag.endswith("}twoCellAnchor")):
            continue
        start = anchor.find("xdr:from", NS)
        blip = anchor.find(".//a:blip", NS)
        if start is None or blip is None:
            continue
        rid = blip.attrib.get("{%s}embed" % NS["r"])
        if not rid:
            continue
        media = norm_target(drawing_part, drawing_rels[rid])
        out.append(ImageRef(
            row=int(start.find("xdr:row", NS).text) + 1,
            col=int(start.find("xdr:col", NS).text) + 1,
            media=media,
        ))
    return sorted(out, key=lambda x: (x.row, x.col, x.media))


def looks_like_tags(text):
    if not text:
        return False
    tag_marks = ",，:{}[]_"
    return bool(re.search(r"[A-Za-z]", text) and any(mark in text for mark in tag_marks))


def candidate_key_for_image(img, cells):
    for row in (img.row, img.row - 1, img.row + 1):
        for col in range(img.col - 1, max(0, img.col - 5), -1):
            title = cells.get((row, col), "").strip()
            tags = cells.get((row + 1, col), "").strip()
            if title and looks_like_tags(tags):
                return row, col, title, tags
    return None


def extract_candidates(workbook):
    candidates = {}
    stats = Counter()
    with zipfile.ZipFile(workbook) as zf:
        shared = load_shared_strings(zf)
        for sheet_name, sheet_part in workbook_sheets(zf):
            if sheet_name == "目录" or sheet_name.startswith("Sheet"):
                continue
            drawing_part = drawing_part_for_sheet(zf, sheet_part)
            if not drawing_part:
                continue
            cells = read_cells(zf, sheet_part, shared)
            images = read_images(zf, drawing_part)
            stats["image_anchors"] += len(images)
            for img in images:
                key = candidate_key_for_image(img, cells)
                if key is None:
                    stats["unmapped_images"] += 1
                    continue
                row, col, title, tags = key
                full_key = (str(workbook), sheet_name, row, col, title, tags)
                if full_key not in candidates:
                    candidates[full_key] = ExcelCandidate(workbook, sheet_name, row, col, title, tags, [])
                candidates[full_key].images.append(img.media)
    stats["candidates"] = len(candidates)
    stats["multi_image_candidates"] = sum(1 for c in candidates.values() if len(c.images) > 1)
    return list(candidates.values()), stats


def norm_common(text):
    text = unicodedata.normalize("NFKC", text or "")
    text = text.replace("，", ",").replace("：", ":")
    return text.strip().lower()


def norm_tags(text):
    return re.sub(r"\s+", "", norm_common(text))


def norm_title(text):
    return re.sub(r"\s+", "", norm_common(text))


def codex_path(codex_id):
    return DATA_DIR / f"{codex_id}.json"


def load_codex(codex_id):
    path = codex_path(codex_id)
    if not path.exists():
        raise SystemExit(f"Unknown codex id or missing data file: {codex_id}")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def build_entry_indexes(entries):
    by_tags = defaultdict(list)
    by_title = defaultdict(list)
    for entry in entries:
        by_tags[norm_tags(entry.get("tags", ""))].append(entry)
        by_title[norm_title(entry.get("title", ""))].append(entry)
    return by_tags, by_title


def unsafe_unique_title_fallback(title):
    compact = norm_title(title)
    if compact in {"\u539f\u7248", "\u53e6\u4e00\u7248", "\u9644\u5e26\u539f\u7248"}:
        return True
    return re.fullmatch(r"\u5176\u4ed6\u7248\u672c\d*", compact) is not None


def match_candidates(candidates, entries):
    by_tags, by_title = build_entry_indexes(entries)
    matches = []
    unmatched = []
    for cand in candidates:
        tag_hits = by_tags.get(norm_tags(cand.tags), [])
        if len(tag_hits) == 1:
            matches.append(Match(tag_hits[0], cand, "tags"))
            continue
        if len(tag_hits) > 1:
            title = norm_title(cand.title)
            narrowed = [e for e in tag_hits if norm_title(e.get("title", "")) == title]
            if len(narrowed) == 1:
                matches.append(Match(narrowed[0], cand, "tags+title"))
                continue
        title_hits = by_title.get(norm_title(cand.title), [])
        if len(title_hits) == 1 and not unsafe_unique_title_fallback(cand.title):
            matches.append(Match(title_hits[0], cand, "unique-title"))
            continue
        unmatched.append(cand)
    return matches, unmatched


def media_ext(media):
    ext = Path(media).suffix.lower().lstrip(".") or "png"
    return {"jpeg": "jpg"}.get(ext, ext)


def hash_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def asset_rev(*paths):
    h = hashlib.sha256()
    for path in paths:
        if path and path.exists():
            h.update(hash_file(path).encode("ascii"))
    return h.hexdigest()[:16]


def choose_image(zf, images, prefer):
    if prefer == "largest" and len(images) > 1:
        return max(images, key=lambda name: zf.getinfo(name).file_size)
    return sorted(images)[0]


def save_image(zf, media, entry_id, site_image_dir, original_dir):
    raw = zf.read(media)
    original_dir.mkdir(parents=True, exist_ok=True)
    site_image_dir.mkdir(parents=True, exist_ok=True)

    ext = media_ext(media)
    original_name = f"{entry_id}.{ext}"
    original_path = original_dir / original_name
    with open(original_path, "wb") as fh:
        fh.write(raw)

    image = Image.open(io.BytesIO(raw))
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    image.thumbnail((MAXDIM, MAXDIM), Image.LANCZOS)
    thumb_w, thumb_h = image.size
    thumb_name = f"{entry_id}.jpg"
    thumb_path = site_image_dir / thumb_name
    image.save(thumb_path, "JPEG", quality=86, optimize=True)
    return {
        "image": thumb_name,
        "imageWidth": thumb_w,
        "imageHeight": thumb_h,
        "original": original_name,
        "assetRev": asset_rev(thumb_path, original_path),
    }


def update_codex_images(codex_id, codex, updates):
    update_map = dict(updates)
    for entry in codex["entries"]:
        if entry["id"] in update_map:
            entry.update(update_map[entry["id"]])
    codex["imagedCount"] = sum(1 for entry in codex["entries"] if entry.get("image"))
    with open(codex_path(codex_id), "w", encoding="utf-8") as fh:
        json.dump(codex, fh, ensure_ascii=False)

    index_path = DATA_DIR / "codexes.json"
    with open(index_path, encoding="utf-8") as fh:
        index = json.load(fh)
    for item in index:
        if item.get("id") == codex_id:
            item["entryCount"] = codex["entryCount"]
            item["imagedCount"] = codex["imagedCount"]
            break
    with open(index_path, "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=2)


def print_examples(title, items, limit=12):
    print(f"\n{title}: {len(items)}")
    for item in items[:limit]:
        print(f"- {item.title[:80]} | {item.sheet} | row {item.row} | images {len(item.images)}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex-id", default="suozhang", help="Codex id under site/data, for example suozhang.")
    parser.add_argument("--excel-dir", type=Path, default=None)
    parser.add_argument("--excel-file", type=Path, action="append", default=[], help="Specific .xlsx file to read. Can be passed multiple times.")
    parser.add_argument("--only-title", action="append", default=[], help="Import only entries with this title. Can be passed multiple times.")
    parser.add_argument("--only-entry-id", action="append", default=[], help="Import only this entry id. Can be passed multiple times.")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--limit", type=int, default=0, help="Maximum images to write in --apply mode.")
    parser.add_argument("--prefer", choices=("first", "largest"), default="largest")
    args = parser.parse_args()

    if args.excel_file:
        workbooks = [path.resolve() for path in args.excel_file]
        missing = [str(path) for path in workbooks if not path.exists()]
        if missing:
            raise SystemExit("Missing Excel file(s): " + ", ".join(missing))
        excel_dir = None
    else:
        excel_dir = args.excel_dir or default_excel_dir()
        workbooks = sorted(excel_dir.glob("*.xlsx"))
    if not workbooks:
        raise SystemExit("No .xlsx files found.")

    codex = load_codex(args.codex_id)
    site_image_dir = ROOT / "site" / "images" / args.codex_id
    original_dir = ROOT / "originals" / args.codex_id
    only_titles = {norm_title(title) for title in args.only_title}
    only_entry_ids = set(args.only_entry_id)

    all_candidates = []
    total_stats = Counter()
    print(f"Codex id: {args.codex_id}")
    if excel_dir:
        print(f"Excel dir: {excel_dir}")
    else:
        print(f"Excel files: {len(workbooks)}")
    if only_titles or only_entry_ids:
        print(f"Entry filter: titles={len(only_titles)} ids={len(only_entry_ids)}")
    for workbook in workbooks:
        candidates, stats = extract_candidates(workbook)
        all_candidates.extend(candidates)
        total_stats.update(stats)
        print(
            f"{workbook.name}: candidates={stats['candidates']} "
            f"anchors={stats['image_anchors']} multi={stats['multi_image_candidates']} "
            f"unmapped={stats['unmapped_images']}"
        )

    matches, unmatched = match_candidates(all_candidates, codex["entries"])
    pre_filter_matches = len(matches)
    if only_titles or only_entry_ids:
        matches = [
            match for match in matches
            if match.entry.get("id") in only_entry_ids or norm_title(match.entry.get("title", "")) in only_titles
        ]
    matched_by_entry = defaultdict(list)
    for match in matches:
        matched_by_entry[match.entry["id"]].append(match)
    duplicate_entry_matches = {eid: ms for eid, ms in matched_by_entry.items() if len(ms) > 1}

    usable = []
    already = []
    for eid, ms in matched_by_entry.items():
        entry = ms[0].entry
        if entry.get("image") and not args.overwrite:
            already.append(ms[0])
        else:
            usable.append(ms[0])

    print("\nSummary")
    print(f"image anchors: {total_stats['image_anchors']}")
    print(f"excel candidates: {len(all_candidates)}")
    print(f"matched candidates: {len(matches)}")
    if only_titles or only_entry_ids:
        print(f"matched candidates before filter: {pre_filter_matches}")
    print(f"matched unique entries: {len(matched_by_entry)}")
    print(f"ready to import: {len(usable)}")
    print(f"already imaged skipped: {len(already)}")
    print(f"unmatched candidates: {len(unmatched)}")
    print(f"entries with multiple Excel matches: {len(duplicate_entry_matches)}")
    print_examples("Unmatched examples", unmatched)

    if not args.apply:
        print("\nDry run only. Re-run with --apply to write images.")
        return

    updates = []
    written = 0
    matches_by_workbook = defaultdict(list)
    for match in usable:
        matches_by_workbook[match.candidate.workbook].append(match)

    for workbook, workbook_matches in matches_by_workbook.items():
        with zipfile.ZipFile(workbook) as zf:
            for match in workbook_matches:
                if args.limit and written >= args.limit:
                    break
                media = choose_image(zf, match.candidate.images, args.prefer)
                asset = save_image(zf, media, match.entry["id"], site_image_dir, original_dir)
                updates.append((match.entry["id"], asset))
                written += 1
        if args.limit and written >= args.limit:
            break

    update_codex_images(args.codex_id, codex, updates)
    print(f"\nImported {written} image(s).")


if __name__ == "__main__":
    main()
