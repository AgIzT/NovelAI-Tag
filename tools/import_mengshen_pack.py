# -*- coding: utf-8 -*-
"""Import Mengshen image pack from the manually reviewed preview folder."""

import argparse
import gzip
import hashlib
import json
import re
import shutil
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT.parent / "新数据" / "梦神原图包_分类预览"
DATA_DIR = ROOT / "site" / "data"
THUMB_ROOT = ROOT / "site" / "images"
ORIG_ROOT = ROOT / "originals"
CODEX_ID = "mengshen_pack"
MOVED_TARGET_ID = "artist_nai45_strings"
MOVED_CHAPTER = "梦神NAI4.5F画风合集"
MAXDIM = 1100

TOP_ORDER = [
    "个人精选韩国图包",
    "贼不走空",
    "韩国大舞台",
    "基于novelai4.5full全原图画风合集",
]

EXCLUDED_TOPS = {
    "nai4.5预设画风",
}

DISPLAY_TOPS = {
    "基于novelai4.5full全原图画风合集": "基于NAI4.5F画风合集",
}

FULL_RESTRICTED_TOPS = {
    "基于novelai4.5full全原图画风合集",
}

CLASS_MAP = {
    "01_常规": ("常规", "safe"),
    "02_限制级": ("限制级", "restricted"),
    "03_R18": ("R18", "r18"),
    "04_R18G": ("R18G", "r18g"),
}

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".avif"}


def read_chunks(buf):
    if len(buf) < 8 or buf[:8].hex() != "89504e470d0a1a0a":
        return []
    out = []
    offset = 8
    while offset + 12 <= len(buf):
        length = int.from_bytes(buf[offset:offset + 4], "big")
        offset += 4
        name = buf[offset:offset + 4].decode("ascii", "replace")
        offset += 4
        data = buf[offset:offset + length]
        offset += length + 4
        out.append((name, data))
        if name == "IEND":
            break
    return out


def decode_text_chunk(data):
    try:
        pos = data.index(0)
    except ValueError:
        return None
    return data[:pos].decode("utf-8", "replace"), data[pos + 1:].decode("utf-8", "replace")


def decode_itxt_like_inspector(data):
    filtered = bytes(x for x in data if x != 0)
    header = filtered[:11].decode("utf-8", "replace")
    if header == "Description":
        return "Description", filtered[11:].decode("utf-8", "replace")
    return "Unknown", filtered.decode("utf-8", "replace")


class BitReader:
    def __init__(self, bits):
        self.bits = bits
        self.index = 0

    def read_bit(self):
        value = self.bits[self.index] if self.index < len(self.bits) else 0
        self.index += 1
        return value

    def read_byte(self):
        value = 0
        for i in range(8):
            value |= self.read_bit() << (7 - i)
        return value

    def read_bytes(self, count):
        return bytes(self.read_byte() for _ in range(count))

    def read_i32(self):
        return int.from_bytes(self.read_bytes(4), "big", signed=True)


def extract_stealth_pngcomp(path):
    try:
        image = Image.open(path).convert("RGBA")
    except Exception:
        return None
    width, height = image.size
    pixels = image.load()
    bits = []
    for x in range(width):
        for y in range(height):
            bits.append(pixels[x, y][3] & 1)
    reader = BitReader(bits)
    magic = b"stealth_pngcomp"
    if reader.read_bytes(len(magic)) != magic:
        return None
    bit_length = reader.read_i32()
    if bit_length <= 0 or bit_length % 8:
        return None
    byte_length = bit_length // 8
    if byte_length > (len(bits) - reader.index + 7) // 8:
        return None
    try:
        return json.loads(gzip.decompress(reader.read_bytes(byte_length)).decode("utf-8"))
    except Exception:
        return None


def parse_json(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return None
    return None


def v4_caption_parts(payload, key):
    node = payload.get(key) if isinstance(payload, dict) else None
    caption = node.get("caption") if isinstance(node, dict) else None
    caption = caption if isinstance(caption, dict) else {}
    base = str(caption.get("base_caption") or "").strip()
    characters = []
    for item in caption.get("char_captions") or []:
        characters.append(str(item.get("char_caption") or "").strip() if isinstance(item, dict) else "")
    return base, characters


def character_prompts_from_payload(payload):
    _, positive = v4_caption_parts(payload, "v4_prompt")
    _, negative = v4_caption_parts(payload, "v4_negative_prompt")
    out = []
    for index in range(max(len(positive), len(negative))):
        prompt = positive[index] if index < len(positive) else ""
        uc = negative[index] if index < len(negative) else ""
        if not prompt and not uc:
            continue
        item = {"label": f"char{index + 1}", "prompt": prompt}
        if uc:
            item["negative"] = uc
        out.append(item)
    return out


def extract_from_object(obj):
    prompt = ""
    negative = ""
    for key in ("Description", "description", "prompt", "Prompt", "parameters"):
        if not prompt and isinstance(obj.get(key), str):
            prompt = obj[key]
    for key in ("uc", "negative", "Negative prompt", "negative_prompt"):
        if not negative and isinstance(obj.get(key), str):
            negative = obj[key]
    comment = parse_json(obj.get("Comment"))
    if comment:
        if not prompt and isinstance(comment.get("prompt"), str):
            prompt = comment["prompt"]
        if not negative and isinstance(comment.get("uc"), str):
            negative = comment["uc"]
        if not negative and isinstance(comment.get("negative_prompt"), str):
            negative = comment["negative_prompt"]
    payload = comment or obj
    base_prompt, _ = v4_caption_parts(payload, "v4_prompt")
    base_negative, _ = v4_caption_parts(payload, "v4_negative_prompt")
    return (
        base_prompt or prompt.strip(),
        base_negative or negative.strip(),
        comment or {},
        character_prompts_from_payload(payload),
    )


def extract_metadata(path):
    if path.suffix.lower() != ".png":
        return "", "", {}, [], "none"
    try:
        buf = path.read_bytes()
    except Exception:
        return "", "", {}, [], "unreadable"

    rows = {}
    for name, data in read_chunks(buf):
        if name == "tEXt":
            item = decode_text_chunk(data)
        elif name == "iTXt":
            item = decode_itxt_like_inspector(data)
        else:
            item = None
        if item:
            rows[item[0]] = item[1]
    if rows:
        prompt, negative, comment, character_prompts = extract_from_object(rows)
        return prompt, negative, comment, character_prompts, "text"

    stealth = extract_stealth_pngcomp(path)
    if stealth:
        prompt, negative, comment, character_prompts = extract_from_object(stealth)
        return prompt, negative, comment or stealth, character_prompts, "stealth"
    return "", "", {}, [], "none"


def sampler_label(value):
    value = str(value or "").strip()
    labels = {
        "k_euler_ancestral": "Euler A",
        "k_euler": "Euler",
        "ddim": "DDIM",
        "k_dpmpp_2m": "DPM++ 2M",
        "k_dpmpp_2m_sde": "DPM++ 2M SDE",
        "k_dpmpp_sde": "DPM++ SDE",
    }
    return labels.get(value, value)


def format_note(params, metadata_kind, no_prompt=False):
    pieces = []
    if params.get("steps") not in (None, ""):
        pieces.append(f"Steps: {params['steps']}")
    if params.get("sampler"):
        pieces.append(f"Sampler: {sampler_label(params['sampler'])}")
    if params.get("scale") not in (None, ""):
        pieces.append(f"CFG scale: {params['scale']}")
    if params.get("cfg_rescale") not in (None, ""):
        pieces.append(f"CFG rescale: {params['cfg_rescale']}")
    if params.get("seed") not in (None, ""):
        pieces.append(f"Seed: {params['seed']}")
    width = params.get("width")
    height = params.get("height")
    if width and height:
        pieces.append(f"Size: {width}x{height}")
    if params.get("noise_schedule"):
        pieces.append(f"Noise schedule: {params['noise_schedule']}")

    lines = []
    if pieces:
        lines.append("参数：" + ", ".join(map(str, pieces)))
    if metadata_kind in {"text", "stealth"}:
        lines.append(f"元数据：{metadata_kind}")
    if no_prompt:
        lines.append("备注：NAI 可读，但站内脚本未解析出 tags，先作为无 tag 图片导入。")
    return "\n".join(lines)


def normalize_class_dir(name):
    return CLASS_MAP.get(name, (re.sub(r"^\d+_", "", name), "safe"))


def rating_for(top, class_dir):
    if top in FULL_RESTRICTED_TOPS and not class_dir:
        return "restricted"
    if class_dir:
        return normalize_class_dir(class_dir)[1]
    return "safe"


def display_top(top):
    return DISPLAY_TOPS.get(top, top)


def path_for(top, class_dir):
    top_label = display_top(top)
    if not class_dir:
        return [top_label]
    label, rating = normalize_class_dir(class_dir)
    if rating in {"restricted", "r18"}:
        return [top_label, "NSFW", label]
    return [top_label, label]


def iter_image_sources(source):
    tops = [source / name for name in TOP_ORDER if (source / name).is_dir()]
    extra = sorted(
        p for p in source.iterdir()
        if p.is_dir() and not p.name.startswith("_") and p.name not in TOP_ORDER and p.name not in EXCLUDED_TOPS
    )
    for top_dir in tops + extra:
        direct = sorted(p for p in top_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS)
        for path in direct:
            yield top_dir.name, "", path
        for class_dir in sorted(p for p in top_dir.iterdir() if p.is_dir()):
            files = sorted(p for p in class_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS)
            for path in files:
                yield top_dir.name, class_dir.name, path


def sha256_hex(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def asset_rev(*paths):
    h = hashlib.sha256()
    used = False
    for path in paths:
        if path and path.exists():
            h.update(sha256_hex(path).encode("ascii"))
            used = True
    return h.hexdigest()[:16] if used else ""


def save_assets(src, entry_id, thumb_dir, original_dir):
    thumb_dir.mkdir(parents=True, exist_ok=True)
    original_dir.mkdir(parents=True, exist_ok=True)

    ext = ".jpg" if src.suffix.lower() == ".jpeg" else src.suffix.lower()
    original_name = f"{entry_id}{ext}"
    thumb_name = f"{entry_id}.jpg"
    original_path = original_dir / original_name
    thumb_path = thumb_dir / thumb_name
    shutil.copy2(src, original_path)

    image = Image.open(src)
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    image.thumbnail((MAXDIM, MAXDIM), Image.LANCZOS)
    image.save(thumb_path, "JPEG", quality=86, optimize=True)
    width, height = image.size
    return {
        "image": thumb_name,
        "imageWidth": width,
        "imageHeight": height,
        "original": original_name,
        "images": [{"path": thumb_name, "original": original_name}],
        "assetRev": asset_rev(thumb_path, original_path),
    }


def build_tree(entries):
    root = {}
    for entry in entries:
        node = root
        for name in entry.get("path", []):
            cur = node.setdefault(name, {"name": name, "count": 0, "children": {}})
            cur["count"] += 1
            node = cur["children"]

    def to_list(node):
        out = []
        for value in node.values():
            out.append({
                "name": value["name"],
                "count": value["count"],
                "children": to_list(value["children"]),
            })
        return out

    return to_list(root)


def write_json(path, data, indent=None):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=indent)


def upsert_codex_index(codex):
    index_path = DATA_DIR / "codexes.json"
    with open(index_path, encoding="utf-8") as fh:
        index = json.load(fh)
    meta = {
        "id": codex["id"],
        "type": "pack",
        "title": codex["title"],
        "version": codex["version"],
        "author": codex["author"],
        "entryCount": codex["entryCount"],
        "imagedCount": codex["imagedCount"],
        "hasOriginal": True,
        "source": codex["source"],
        "contributors": codex["contributors"],
        "links": codex.get("links", []),
    }
    for i, item in enumerate(index):
        if item.get("id") == CODEX_ID:
            index[i] = {**item, **meta}
            break
    else:
        index.append(meta)
    write_json(index_path, index, indent=2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    source = args.source
    if not source.is_dir():
        raise SystemExit(f"Source folder not found: {source}")
    moved_target_path = DATA_DIR / f"{MOVED_TARGET_ID}.json"
    if args.apply and moved_target_path.is_file():
        moved_target = json.loads(moved_target_path.read_text(encoding="utf-8"))
        if any(
            entry.get("path") and entry["path"][0] == MOVED_CHAPTER
            for entry in moved_target.get("entries", [])
        ):
            raise SystemExit(
                f"{MOVED_CHAPTER} has moved to {MOVED_TARGET_ID}; "
                "update the split import flow intentionally before reapplying this legacy importer"
            )

    entries = []
    skipped = []
    thumb_dir = THUMB_ROOT / CODEX_ID
    original_dir = ORIG_ROOT / CODEX_ID

    if args.apply:
        if thumb_dir.exists():
            shutil.rmtree(thumb_dir)
        if original_dir.exists():
            shutil.rmtree(original_dir)

    serial = 1
    path_counts = {}
    for top, class_dir, src in iter_image_sources(source):
        prompt, negative, params, character_prompts, metadata_kind = extract_metadata(src)
        no_prompt = not bool(prompt)
        is_webp = src.suffix.lower() == ".webp"
        if no_prompt and not is_webp:
            skipped.append((src, metadata_kind))
            continue

        entry_id = f"{CODEX_ID}-{serial:04d}"
        entry_path = path_for(top, class_dir)
        path_key = " / ".join(entry_path)
        path_counts[path_key] = path_counts.get(path_key, 0) + 1
        title = f"{entry_path[-1]} {path_counts[path_key]:04d}" if len(entry_path) > 1 else f"{entry_path[0]} {path_counts[path_key]:04d}"
        rating = rating_for(top, class_dir)

        asset = {}
        if args.apply:
            asset = save_assets(src, entry_id, thumb_dir, original_dir)

        entries.append({
            "title": title,
            "path": entry_path,
            "tags": prompt,
            "negative": negative,
            **({"characterPrompts": character_prompts} if character_prompts else {}),
            "note": format_note(params or {}, metadata_kind, no_prompt=no_prompt),
            "rating": rating,
            "id": entry_id,
            "isNew": False,
            **asset,
        })
        serial += 1

    codex = {
        "id": CODEX_ID,
        "type": "pack",
        "title": "梦神整理社区图包",
        "version": "2026.6.27",
        "author": "梦神整理",
        "entryCount": len(entries),
        "imagedCount": len(entries),
        "hasOriginal": True,
        "source": "梦神整理 · 社区收集原图包",
        "contributors": [
            {"name": "梦神", "role": "图包整理 / 数据来源"},
            {"name": "社区贡献者", "role": "原图与参数收集"},
        ],
        "links": [],
        "tree": build_tree(entries),
        "entries": entries,
    }

    print(f"source: {source}")
    print(f"entries: {len(entries)}")
    print(f"skipped no-prompt PNG: {len(skipped)}")
    if skipped[:10]:
        print("skipped examples:")
        for src, kind in skipped[:10]:
            print(f"- {src.relative_to(source)} ({kind})")

    if not args.apply:
        print("dry run only; pass --apply to write files")
        return

    write_json(DATA_DIR / f"{CODEX_ID}.json", codex)
    upsert_codex_index(codex)
    print(f"wrote {DATA_DIR / (CODEX_ID + '.json')}")
    print(f"wrote images under {thumb_dir}")
    print(f"wrote originals under {original_dir}")


if __name__ == "__main__":
    main()
