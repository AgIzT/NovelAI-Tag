# -*- coding: utf-8 -*-
"""
Inspect Stable Diffusion / NovelAI image metadata and audit codex image matches.

This is a small command-line companion for the browser-oriented
Akegarasu/stable-diffusion-inspector workflow. It focuses on the parts needed
for this project: PNG text chunks, NovelAI Description/Comment fields, and
WebUI-style parameters.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import struct
import sys
import unicodedata
import zlib
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "site" / "data"
ORIG_DIR = ROOT / "originals"
ORIGINAL_PRIORITY = {"png": 0, "jpg": 1, "jpeg": 2, "webp": 3, "gif": 4, "avif": 5}


@dataclass
class Metadata:
    path: Path
    source_type: str
    prompt: str
    negative: str
    fields: dict[str, Any]
    chunks: list[dict[str, str]]
    character_prompts: list[dict[str, str]] = field(default_factory=list)


def decode_text(data: bytes) -> str:
    for enc in ("utf-8", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "replace")


def parse_png_itxt(data: bytes) -> tuple[str, str]:
    parts: list[bytes] = []
    rest = data
    for _ in range(5):
        head, sep, tail = rest.partition(b"\x00")
        parts.append(head)
        rest = tail if sep else b""
        if not sep:
            break
    keyword = decode_text(parts[0]) if parts else ""
    if len(parts) >= 5:
        compressed = parts[1] == b"\x01"
        text = zlib.decompress(rest) if compressed else rest
    else:
        text = rest or data
    return keyword, decode_text(text)


def read_png_text_chunks_from_bytes(raw: bytes) -> list[dict[str, str]]:
    if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return []
    out: list[dict[str, str]] = []
    pos = 8
    while pos + 8 <= len(raw):
        size = struct.unpack(">I", raw[pos:pos + 4])[0]
        name = raw[pos + 4:pos + 8].decode("latin-1", "replace")
        data = raw[pos + 8:pos + 8 + size]
        pos += 12 + size
        if name == "tEXt":
            keyword, _, text = data.partition(b"\x00")
            out.append({"type": name, "keyword": decode_text(keyword), "text": decode_text(text)})
        elif name == "iTXt":
            keyword, text = parse_png_itxt(data)
            out.append({"type": name, "keyword": keyword, "text": text})
        elif name == "zTXt":
            keyword, _, payload = data.partition(b"\x00")
            text = ""
            if payload:
                try:
                    text = decode_text(zlib.decompress(payload[1:]))
                except Exception:
                    text = ""
            out.append({"type": name, "keyword": decode_text(keyword), "text": text})
        if name == "IEND":
            break
    return out


def read_png_text_chunks(path: Path) -> list[dict[str, str]]:
    return read_png_text_chunks_from_bytes(path.read_bytes())


def split_webui_parameters(text: str) -> tuple[str, str, str]:
    prompts, sep, other = text.partition("Steps: ")
    prompt, sep2, negative_and_rest = prompts.partition("Negative prompt: ")
    if sep2:
        negative = negative_and_rest
    else:
        negative = ""
    return prompt.strip(), negative.strip(), ("Steps: " + other).strip() if sep else ""


def nai_v4_caption_parts(data: dict[str, Any], key: str) -> tuple[str, list[str]]:
    caption = (((data.get(key) or {}).get("caption") or {}) if isinstance(data.get(key), dict) else {})
    base = str(caption.get("base_caption") or "").strip()
    characters: list[str] = []
    for item in caption.get("char_captions") or []:
        value = str(item.get("char_caption") or "").strip() if isinstance(item, dict) else ""
        characters.append(value)
    return base, characters


def nai_v4_caption_text(data: dict[str, Any], key: str) -> str:
    base, characters = nai_v4_caption_parts(data, key)
    parts = [base, *(value for value in characters if value)]
    return "\n".join(parts).strip()


def nai_v4_character_prompts(data: dict[str, Any]) -> list[dict[str, str]]:
    _, positive = nai_v4_caption_parts(data, "v4_prompt")
    _, negative = nai_v4_caption_parts(data, "v4_negative_prompt")
    out: list[dict[str, str]] = []
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


def _json_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def metadata_from_png_chunks(path: Path, chunks: list[dict[str, str]]) -> Metadata:
    fields = {c["keyword"]: c["text"] for c in chunks}
    prompt = ""
    negative = ""
    character_prompts: list[dict[str, str]] = []
    source_type = fields.get("Software") or fields.get("Source") or "png"
    comment = fields.get("Comment")
    if comment:
        try:
            comment_json = json.loads(comment)
            fields["CommentJson"] = comment_json
            prompt = nai_v4_caption_parts(comment_json, "v4_prompt")[0] or str(comment_json.get("prompt") or "")
            negative = (
                nai_v4_caption_parts(comment_json, "v4_negative_prompt")[0]
                or str(comment_json.get("uc") or comment_json.get("negative_prompt") or "")
            )
            character_prompts = nai_v4_character_prompts(comment_json)
            source_type = "NovelAI" if fields.get("Software") == "NovelAI" else source_type
        except Exception:
            pass
    if not prompt and fields.get("Description"):
        prompt = fields["Description"]
        source_type = "NovelAI" if fields.get("Software") == "NovelAI" else source_type
    if not prompt and fields.get("parameters"):
        prompt, negative, other = split_webui_parameters(fields["parameters"])
        fields["parameters_other"] = other
        source_type = "SD-WEBUI"
    return Metadata(
        path=path,
        source_type=source_type,
        prompt=prompt,
        negative=negative,
        fields=fields,
        chunks=chunks,
        character_prompts=character_prompts,
    )


def decode_exif_user_comment(value: bytes | str) -> str:
    """Decode EXIF UserComment payloads used by WebUI and NovelAI exports."""
    if isinstance(value, str):
        return value.strip("\x00")
    payload = value
    if payload.startswith(b"ASCII\x00\x00\x00"):
        return decode_text(payload[8:]).strip("\x00")
    if payload.startswith(b"UNICODE\x00"):
        payload = payload[8:]
        for encoding in ("utf-16", "utf-16-be", "utf-16-le"):
            try:
                return payload.decode(encoding).strip("\x00")
            except (UnicodeDecodeError, UnicodeError):
                continue
    return decode_text(payload.replace(b"\x00", b"")).strip()


def metadata_from_exif_user_comment(path: Path, value: bytes | str) -> Metadata:
    text = decode_exif_user_comment(value)
    try:
        payload = json.loads(text)
    except (TypeError, ValueError, json.JSONDecodeError):
        payload = None
    if isinstance(payload, dict) and any(
        key in payload for key in ("Description", "Comment", "Software", "Source", "v4_prompt")
    ):
        chunks = [
            {"type": "EXIF", "keyword": str(key), "text": _json_text(item)}
            for key, item in payload.items()
        ]
        meta = metadata_from_png_chunks(path, chunks)
        meta.fields["UserComment"] = text
        meta.fields["ExifJson"] = payload
        if str(payload.get("Title") or "").startswith("NovelAI generated image"):
            meta.source_type = "NovelAI-EXIF"
        return meta

    prompt, negative, other = split_webui_parameters(text)
    return Metadata(
        path=path,
        source_type="SD-WEBUI",
        prompt=prompt,
        negative=negative,
        fields={"UserComment": text, "parameters_other": other},
        chunks=[],
    )


def _read_lsb_byte(bit_iter) -> int:
    value = 0
    for i in range(8):
        value |= next(bit_iter) << (7 - i)
    return value


def _alpha_lsb_bits(path: Path):
    from PIL import Image

    with Image.open(path) as im:
        alpha = im.convert("RGBA").getchannel("A")
        pixels = alpha.load()
        width, height = alpha.size
        for x in range(width):
            for y in range(height):
                yield pixels[x, y] & 1


def read_stealth_pngcomp(path: Path) -> dict[str, Any] | None:
    """Read Akegarasu / NovelAI stealth_pngcomp metadata from alpha-channel LSBs."""
    magic = b"stealth_pngcomp"
    try:
        bits = _alpha_lsb_bits(path)
        found_magic = bytes(_read_lsb_byte(bits) for _ in range(len(magic)))
        if found_magic != magic:
            return None
        bit_length = int.from_bytes(bytes(_read_lsb_byte(bits) for _ in range(4)), "big", signed=True)
        if bit_length <= 0:
            return None
        byte_length = (bit_length + 7) // 8
        compressed = bytes(_read_lsb_byte(bits) for _ in range(byte_length))
        raw = zlib.decompress(compressed, 16 + zlib.MAX_WBITS)
        decoded = json.loads(raw.decode("utf-8"))
        return decoded if isinstance(decoded, dict) else None
    except (EOFError, StopIteration, OSError, ValueError, json.JSONDecodeError, zlib.error):
        return None


def metadata_from_stealth_pngcomp(path: Path, payload: dict[str, Any]) -> Metadata:
    chunks = [
        {"type": "stealth_pngcomp", "keyword": str(key), "text": _json_text(value)}
        for key, value in payload.items()
    ]
    meta = metadata_from_png_chunks(path, chunks)
    meta.source_type = "NovelAI-Stealth"
    meta.fields["StealthMagic"] = "stealth_pngcomp"
    meta.fields["StealthJson"] = payload
    if not meta.prompt:
        meta.prompt = (
            nai_v4_caption_parts(payload, "v4_prompt")[0]
            or str(payload.get("prompt") or payload.get("positive_prompt") or payload.get("Description") or "")
        ).strip()
    if not meta.negative:
        meta.negative = (
            nai_v4_caption_parts(payload, "v4_negative_prompt")[0]
            or str(payload.get("uc") or payload.get("negative_prompt") or payload.get("negative") or "")
        ).strip()
    if not meta.character_prompts:
        meta.character_prompts = nai_v4_character_prompts(payload)
    return meta


def extract_png_metadata_from_bytes(raw: bytes, name: str = "<bytes>") -> Metadata:
    return metadata_from_png_chunks(Path(name), read_png_text_chunks_from_bytes(raw))


def extract_image_metadata(path: Path) -> Metadata:
    path = path.resolve()
    chunks: list[dict[str, str]] = []
    fields: dict[str, Any] = {}
    prompt = ""
    negative = ""
    source_type = "unknown"

    if path.suffix.lower() == ".png":
        meta = metadata_from_png_chunks(path, read_png_text_chunks(path))
        if meta.prompt:
            return meta
        stealth = read_stealth_pngcomp(path)
        if stealth:
            return metadata_from_stealth_pngcomp(path, stealth)
        return meta
    else:
        # Pillow is optional for this project path; PNG originals do not need it.
        try:
            from PIL import Image
            with Image.open(path) as im:
                exif = im.getexif()
                user_comment = exif.get(0x9286)
                if isinstance(user_comment, (bytes, str)):
                    return metadata_from_exif_user_comment(path, user_comment)
        except Exception:
            pass
        if not prompt:
            stealth = read_stealth_pngcomp(path)
            if stealth:
                return metadata_from_stealth_pngcomp(path, stealth)

    return Metadata(path=path, source_type=source_type, prompt=prompt, negative=negative, fields=fields, chunks=chunks)


def normalize_common(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "")
    text = text.replace("，", ",").replace("：", ":")
    text = text.replace("\u00a0", " ")
    return text.lower().strip()


def strip_weight_wrappers(text: str) -> str:
    text = normalize_common(text)
    text = re.sub(r"^[+-]?\d+(?:\.\d+)?::(.+?)::$", r"\1", text)
    text = re.sub(r"^[{\[(]+", "", text)
    text = re.sub(r"[}\])]+$", "", text)
    text = re.sub(r"\s+", " ", text).strip(" ,")
    return text


def split_prompt_tags(text: str) -> list[str]:
    text = normalize_common(text).replace("\r", "\n")
    parts = re.split(r"[,\n;]+", text)
    out: list[str] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        part = strip_weight_wrappers(part)
        if not part or part in {"?", "无"}:
            continue
        out.append(part)
    return out


def variants_for_tag(tag: str) -> list[str]:
    tag = strip_weight_wrappers(tag)
    variants = [tag]
    char_stripped = re.sub(r"^char\d+\s*:\s*", "", tag).strip()
    if char_stripped and char_stripped != tag:
        variants.append(char_stripped)
    for value in list(variants):
        no_outer = strip_weight_wrappers(value)
        if no_outer and no_outer not in variants:
            variants.append(no_outer)
        space_alt = value.replace("_", " ")
        if space_alt and space_alt not in variants:
            variants.append(space_alt)
        underscore_alt = value.replace(" ", "_")
        if underscore_alt and underscore_alt not in variants:
            variants.append(underscore_alt)
    return [v for v in variants if v and len(v) > 1]


def search_blob(text: str) -> tuple[str, str]:
    norm = normalize_common(text)
    compact = re.sub(r"\s+", "", norm)
    return norm, compact


def tag_in_prompt(tag: str, prompt_norm: str, prompt_compact: str) -> bool:
    for variant in variants_for_tag(tag):
        norm = normalize_common(variant)
        compact = re.sub(r"\s+", "", norm)
        if norm and norm in prompt_norm:
            return True
        if compact and compact in prompt_compact:
            return True
    return False


def compare_tags_to_prompt(tags: str, prompt: str) -> dict[str, Any]:
    site_tags = split_prompt_tags(tags)
    prompt_norm, prompt_compact = search_blob(prompt)
    found: list[str] = []
    missing: list[str] = []
    for tag in site_tags:
        if tag_in_prompt(tag, prompt_norm, prompt_compact):
            found.append(tag)
        else:
            missing.append(tag)
    total = len(site_tags)
    return {
        "total": total,
        "found": len(found),
        "missing": len(missing),
        "coverage": round(len(found) / total, 4) if total else 0.0,
        "missingTags": missing,
    }


def load_json(path: Path) -> Any:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def first_original(asset_cid: str, entry_id: str, preferred: str | None) -> Path | None:
    cdir = ORIG_DIR / asset_cid
    if preferred:
        candidate = cdir / preferred
        if candidate.exists():
            return candidate
    matches = sorted(
        cdir.glob(entry_id + ".*"),
        key=lambda p: (ORIGINAL_PRIORITY.get(p.suffix.lower().lstrip("."), 99), p.name),
    )
    return matches[0] if matches else None


def audit_codex(args: argparse.Namespace) -> int:
    codex_id = args.codex_id
    data = load_json(DATA_DIR / f"{codex_id}.json")
    rows: list[dict[str, Any]] = []
    inspected = 0
    no_original = 0
    no_prompt = 0
    for entry in data.get("entries", []):
        if not entry.get("image"):
            continue
        asset_cid = entry.get("assetCodexId") or codex_id
        original = first_original(asset_cid, entry.get("id", ""), entry.get("original"))
        if not original:
            no_original += 1
            continue
        meta = extract_image_metadata(original)
        if not meta.prompt:
            no_prompt += 1
            continue
        inspected += 1
        result = compare_tags_to_prompt(entry.get("tags", ""), meta.prompt)
        if result["coverage"] <= args.max_coverage or args.all:
            rows.append({
                "id": entry.get("id"),
                "title": entry.get("title"),
                "path": " › ".join(entry.get("path") or []),
                "assetCodexId": asset_cid,
                "original": str(original.relative_to(ROOT)),
                "sourceType": meta.source_type,
                "coverage": result["coverage"],
                "found": result["found"],
                "total": result["total"],
                "missing": result["missing"],
                "missingTags": ", ".join(result["missingTags"][:args.missing_limit]),
                "promptSha16": sha256(meta.prompt.encode("utf-8")).hexdigest()[:16],
            })
    rows.sort(key=lambda r: (r["coverage"], -r["total"], r["id"] or ""))

    output = Path(args.output) if args.output else ROOT / "output" / f"sd_tag_audit_{codex_id}.csv"
    output.parent.mkdir(parents=True, exist_ok=True)
    with open(output, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=[
            "id", "title", "path", "assetCodexId", "original", "sourceType",
            "coverage", "found", "total", "missing", "missingTags", "promptSha16",
        ])
        writer.writeheader()
        writer.writerows(rows)

    print(json.dumps({
        "codexId": codex_id,
        "inspected": inspected,
        "reported": len(rows),
        "noOriginal": no_original,
        "noPrompt": no_prompt,
        "maxCoverage": args.max_coverage,
        "output": str(output),
    }, ensure_ascii=False, indent=2))
    return 0


def inspect_one(args: argparse.Namespace) -> int:
    meta = extract_image_metadata(Path(args.image))
    if args.json:
        print(json.dumps({
            "path": str(meta.path),
            "sourceType": meta.source_type,
            "prompt": meta.prompt,
            "negative": meta.negative,
            "characterPrompts": meta.character_prompts,
            "fields": meta.fields,
            "chunks": meta.chunks,
        }, ensure_ascii=False, indent=2))
    else:
        print(f"path: {meta.path}")
        print(f"source: {meta.source_type}")
        print("\n[prompt]\n" + (meta.prompt or "<empty>"))
        if meta.negative:
            print("\n[negative]\n" + meta.negative)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_inspect = sub.add_parser("inspect")
    p_inspect.add_argument("image")
    p_inspect.add_argument("--json", action="store_true")
    p_inspect.set_defaults(func=inspect_one)

    p_audit = sub.add_parser("audit-codex")
    p_audit.add_argument("--codex-id", required=True)
    p_audit.add_argument("--max-coverage", type=float, default=0.35)
    p_audit.add_argument("--missing-limit", type=int, default=30)
    p_audit.add_argument("--all", action="store_true")
    p_audit.add_argument("--output")
    p_audit.set_defaults(func=audit_codex)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
