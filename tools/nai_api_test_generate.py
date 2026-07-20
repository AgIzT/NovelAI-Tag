#!/usr/bin/env python3
"""Generate a small, review-only NovelAI API test batch.

The API key is read from ``NAI_API_KEY`` (or ``--api-key-env``).  It is never
written to the request manifests.  Generated files stay under ``output/`` and
this tool never modifies formal codex JSON or image directories.
"""

from __future__ import annotations

import argparse
import http.client
import io
import json
import os
import secrets
import socket
import sys
import urllib.error
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CODEX = ROOT / "site" / "data" / "suozhang.json"
MAX_RESPONSE_BYTES = 80 * 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024


class GenerateError(RuntimeError):
    """A redacted API or response error."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="https://touhounai.xyz")
    parser.add_argument("--api-key-env", default="NAI_API_KEY")
    parser.add_argument("--template-image", type=Path, required=True)
    parser.add_argument("--codex", type=Path, default=DEFAULT_CODEX)
    parser.add_argument("--entry-id", action="append", dest="entry_ids", required=True)
    parser.add_argument("--n-samples", type=int, default=2)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--timeout", type=int, default=240)
    return parser.parse_args()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_template(path: Path) -> dict[str, Any]:
    with Image.open(path) as image:
        comment_text = image.info.get("Comment")
        source = image.info.get("Source")
    if not comment_text:
        raise GenerateError(f"template has no NovelAI Comment metadata: {path}")
    try:
        comment = json.loads(comment_text)
    except json.JSONDecodeError as exc:
        raise GenerateError(f"template Comment is not JSON: {exc}") from exc
    required = ("prompt", "uc", "width", "height", "steps", "scale", "sampler")
    missing = [key for key in required if key not in comment]
    if missing:
        raise GenerateError(f"template metadata is missing: {', '.join(missing)}")
    comment["_source"] = source
    return comment


def compose_prompt(template_prompt: str, entry_tags: str) -> str:
    blocks = [block.strip() for block in template_prompt.split("\n\n") if block.strip()]
    if not blocks:
        raise GenerateError("template prompt is empty")
    style_prefix = blocks[0].rstrip(",")
    if len(blocks) == 1:
        return f"{style_prefix},\n{entry_tags.strip()}"
    quality_tail = "\n\n".join(blocks[1:])
    return f"{style_prefix},\n{entry_tags.strip()}\n\n{quality_tail}"


def random_seed() -> int:
    # NovelAI clients reserve the last few uint32 values.
    return secrets.randbelow(4_294_967_288) + 1


def build_payload(
    template: dict[str, Any],
    prompt: str,
    *,
    n_samples: int,
    seed: int,
) -> dict[str, Any]:
    negative = str(template["uc"]).strip()
    template_prompt = str(template["prompt"]).strip()
    quality_suffixes = (
        ", location, very aesthetic, masterpiece, no text",
        ", very aesthetic, masterpiece, no text",
        ", no text, best quality, very aesthetic, absurdres",
    )
    quality_toggle = any(
        template_prompt.endswith(suffix) for suffix in quality_suffixes
    )
    template_v4_prompt = template.get("v4_prompt") or {}
    # Coordinates only apply to character prompts.  This workflow deliberately
    # sends none, and the compatible API rejects use_coords=true in that case
    # even when the source PNG metadata contains it.
    use_coords = False
    use_order = bool(template_v4_prompt.get("use_order", True))
    parameters = {
        "params_version": 3,
        "width": int(template["width"]),
        "height": int(template["height"]),
        "scale": float(template["scale"]),
        "sampler": str(template["sampler"]),
        "steps": int(template["steps"]),
        "n_samples": n_samples,
        "ucPreset": 0,
        "qualityToggle": quality_toggle,
        "autoSmea": False,
        "dynamic_thresholding": bool(template.get("dynamic_thresholding", False)),
        # This compatible service rejects controlnet_strength for text-to-image.
        "legacy": False,
        "add_original_image": True,
        "cfg_rescale": float(template.get("cfg_rescale", 0.0)),
        "noise_schedule": str(template.get("noise_schedule", "karras")),
        "legacy_v3_extend": bool(template.get("legacy_v3_extend", False)),
        "skip_cfg_above_sigma": template.get("skip_cfg_above_sigma", 58.0),
        "use_coords": use_coords,
        "legacy_uc": False,
        "normalize_reference_strength_multiple": True,
        "seed": seed,
        "characterPrompts": [],
        "v4_prompt": {
            "caption": {"base_caption": prompt, "char_captions": []},
            "use_coords": use_coords,
            "use_order": use_order,
        },
        "v4_negative_prompt": {
            "caption": {"base_caption": negative, "char_captions": []},
            "legacy_uc": False,
        },
        "negative_prompt": negative,
        "deliberate_euler_ancestral_bug": bool(
            template.get("deliberate_euler_ancestral_bug", False)
        ),
        "prefer_brownian": bool(template.get("prefer_brownian", True)),
        # This compatible service rejects sm/sm_dyn for V4.5 even when false.
    }
    return {
        "input": prompt,
        "model": "nai-diffusion-4-5-full",
        "action": "generate",
        "parameters": parameters,
    }


def post_generate(
    base_url: str,
    api_key: str,
    payload: dict[str, Any],
    *,
    timeout: int,
) -> tuple[int, str, bytes]:
    request_body = json.dumps(
        payload, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    request = urllib.request.Request(
        base_url.rstrip("/") + "/ai/generate-image",
        data=request_body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "*/*",
            "User-Agent": "NovelAI-Tag-Atlas/NAI-Test",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
            status = response.status
            content_type = response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        body = exc.read(8192)
        detail = body.decode("utf-8", "replace").replace(api_key, "[REDACTED]")
        raise GenerateError(f"HTTP {exc.code}: {detail[:2000]}") from exc
    except (
        urllib.error.URLError,
        TimeoutError,
        ConnectionError,
        http.client.HTTPException,
        socket.timeout,
    ) as exc:
        detail = getattr(exc, "reason", exc)
        raise GenerateError(f"network error: {detail}") from exc
    if len(body) > MAX_RESPONSE_BYTES:
        raise GenerateError("response exceeds the 80 MiB safety limit")
    return status, content_type, body


def image_extension(format_name: str | None) -> str:
    return {
        "PNG": ".png",
        "WEBP": ".webp",
        "JPEG": ".jpg",
    }.get(format_name or "", ".img")


def inspect_image(blob: bytes) -> dict[str, Any]:
    try:
        with Image.open(io.BytesIO(blob)) as image:
            image.load()
            comment_text = image.info.get("Comment")
            source = image.info.get("Source")
            result = {
                "format": image.format,
                "width": image.width,
                "height": image.height,
                "source": source,
            }
    except Exception as exc:
        raise GenerateError(f"response member is not a readable image: {exc}") from exc
    if comment_text:
        try:
            comment = json.loads(comment_text)
        except json.JSONDecodeError:
            result["commentJson"] = False
        else:
            result["commentJson"] = True
            result["prompt"] = comment.get("prompt")
            result["negative"] = comment.get("uc")
            result["steps"] = comment.get("steps")
            result["scale"] = comment.get("scale")
            result["sampler"] = comment.get("sampler")
            result["seed"] = comment.get("seed")
            result["signedHash"] = bool(comment.get("signed_hash"))
    else:
        result["commentJson"] = False
    return result


def extract_images(body: bytes) -> list[tuple[bytes, dict[str, Any]]]:
    blobs: list[bytes] = []
    if body.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(io.BytesIO(body)) as archive:
                for info in archive.infolist():
                    if info.is_dir() or info.file_size > MAX_IMAGE_BYTES:
                        continue
                    candidate = archive.read(info)
                    try:
                        inspect_image(candidate)
                    except GenerateError:
                        continue
                    blobs.append(candidate)
        except zipfile.BadZipFile as exc:
            raise GenerateError(f"invalid ZIP response: {exc}") from exc
    elif body.startswith(b"\x89PNG") or body.startswith(b"RIFF"):
        blobs.append(body)
    else:
        try:
            parsed = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise GenerateError(f"unknown response bytes: {body[:32].hex()}") from None
        if isinstance(parsed, dict):
            keys = ", ".join(sorted(map(str, parsed)))
            raise GenerateError(f"unexpected JSON response with keys: {keys}")
        raise GenerateError(f"unexpected JSON response type: {type(parsed).__name__}")
    return [(blob, inspect_image(blob)) for blob in blobs]


def verify_generated(
    info: dict[str, Any],
    payload: dict[str, Any],
) -> list[str]:
    parameters = payload["parameters"]
    issues: list[str] = []
    if (info["width"], info["height"]) != (
        parameters["width"],
        parameters["height"],
    ):
        issues.append("dimensions do not match request")
    if info.get("prompt") != payload["input"]:
        issues.append("embedded prompt does not match request")
    if str(info.get("negative", "")).strip() != str(
        parameters["negative_prompt"]
    ).strip():
        issues.append("embedded negative prompt does not match request")
    for key in ("steps", "scale", "sampler"):
        if info.get(key) != parameters[key]:
            issues.append(f"embedded {key} does not match request")
    if not info.get("signedHash"):
        issues.append("signed_hash is absent")
    return issues


def safe_error_text(exc: Exception, api_key: str) -> str:
    return str(exc).replace(api_key, "[REDACTED]")


def main() -> int:
    args = parse_args()
    if not 1 <= args.n_samples <= 8:
        raise GenerateError("--n-samples must be between 1 and 8")
    api_key = os.environ.get(args.api_key_env, "").strip()
    if not api_key:
        raise GenerateError(f"environment variable {args.api_key_env} is empty")

    template = load_template(args.template_image)
    codex = load_json(args.codex)
    entries = {entry["id"]: entry for entry in codex.get("entries", [])}
    selected = []
    for entry_id in args.entry_ids:
        entry = entries.get(entry_id)
        if not entry:
            raise GenerateError(f"entry does not exist: {entry_id}")
        if entry.get("image") or entry.get("images"):
            raise GenerateError(f"entry already has image data: {entry_id}")
        selected.append(entry)

    output_dir = args.output_dir
    if output_dir is None:
        batch_name = datetime.now().strftime("%Y%m%d-%H%M%S")
        output_dir = ROOT / "output" / "nai-api-test" / batch_name
    output_dir.mkdir(parents=True, exist_ok=False)

    batch_manifest: dict[str, Any] = {
        "createdAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "baseUrl": args.base_url.rstrip("/"),
        "templateImage": str(args.template_image.resolve()),
        "templateSource": template.get("_source"),
        "codex": str(args.codex.resolve()),
        "nSamples": args.n_samples,
        "entries": [],
    }
    failed = False
    for entry in selected:
        entry_id = entry["id"]
        entry_dir = output_dir / entry_id
        entry_dir.mkdir()
        prompt = compose_prompt(str(template["prompt"]), str(entry.get("tags", "")))
        seed = random_seed()
        payload = build_payload(
            template,
            prompt,
            n_samples=args.n_samples,
            seed=seed,
        )
        request_manifest = {
            "entry": {
                "id": entry_id,
                "title": entry.get("title"),
                "path": entry.get("path"),
                "tags": entry.get("tags"),
            },
            "payload": payload,
        }
        (entry_dir / "request.json").write_text(
            json.dumps(request_manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        record: dict[str, Any] = {
            "id": entry_id,
            "title": entry.get("title"),
            "seed": seed,
            "status": "pending",
            "images": [],
        }
        try:
            status, content_type, body = post_generate(
                args.base_url,
                api_key,
                payload,
                timeout=args.timeout,
            )
            images = extract_images(body)
            if len(images) != args.n_samples:
                raise GenerateError(
                    f"expected {args.n_samples} images, received {len(images)}"
                )
            for index, (blob, info) in enumerate(images, 1):
                name = f"{entry_id}-{index:02d}{image_extension(info.get('format'))}"
                (entry_dir / name).write_bytes(blob)
                issues = verify_generated(info, payload)
                record["images"].append(
                    {
                        "file": name,
                        "bytes": len(blob),
                        "metadata": info,
                        "issues": issues,
                    }
                )
            record["status"] = (
                "verified"
                if not any(image["issues"] for image in record["images"])
                else "review"
            )
            record["httpStatus"] = status
            record["contentType"] = content_type
        except Exception as exc:
            record["status"] = "failed"
            record["error"] = safe_error_text(exc, api_key)
            failed = True
        batch_manifest["entries"].append(record)
        (entry_dir / "result.json").write_text(
            json.dumps(record, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(
            f"{entry_id}: {record['status']} "
            f"images={len(record['images'])}"
            + (f" error={record['error']}" if record.get("error") else "")
        )
        if failed:
            break

    (output_dir / "manifest.json").write_text(
        json.dumps(batch_manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"output: {output_dir.resolve()}")
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GenerateError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2)
