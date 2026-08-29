#!/usr/bin/env python3
"""Serve a local, resumable candidate review UI for a NAI batch.

The server binds to ``127.0.0.1`` by default.  It reads ``plan.json`` and the
generation ``manifest.json`` from a staging batch, serves candidate images, and
atomically saves choices to ``selections.json``.  Every entry defaults to image
1 and may contain between one and eight candidates.  This tool never changes
formal codex data or image directories.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import threading
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


MAX_POST_BYTES = 64 * 1024
WRITE_LOCK = threading.Lock()


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json_atomic(path: Path, value: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary.replace(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-dir", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18767)
    parser.add_argument(
        "--check",
        action="store_true",
        help="validate/initialize state, print counts, and exit",
    )
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


class ReviewState:
    def __init__(self, batch_dir: Path) -> None:
        self.batch_dir = batch_dir.resolve()
        self.plan_path = self.batch_dir / "plan.json"
        self.manifest_path = self.batch_dir / "manifest.json"
        self.selections_path = self.batch_dir / "selections.json"
        if not self.plan_path.is_file():
            raise ValueError(f"plan does not exist: {self.plan_path}")
        if not self.manifest_path.is_file():
            raise ValueError(f"manifest does not exist: {self.manifest_path}")
        self.plan = load_json(self.plan_path)
        self.entries = list(self.plan.get("entries") or [])
        self.entry_by_id = {
            str(entry["id"]): entry
            for entry in self.entries
        }
        if len(self.entry_by_id) != len(self.entries):
            raise ValueError("plan contains duplicate entry IDs")
        if int(self.plan.get("entryCount", -1)) != len(self.entries):
            raise ValueError("plan entryCount does not match entries")
        self.candidate_count = int(self.plan.get("nSamples", 0))
        if not 1 <= self.candidate_count <= 8:
            raise ValueError("review UI requires between one and eight candidates")
        self.candidate_count_by_id = {}
        for entry in self.entries:
            entry_id = str(entry["id"])
            count = int(entry.get("candidateCount") or self.candidate_count)
            if not 1 <= count <= self.candidate_count:
                raise ValueError(f"invalid candidate count for {entry_id}: {count}")
            self.candidate_count_by_id[entry_id] = count
        self._initialize_selections()

    def _selection_header(self) -> dict[str, Any]:
        header = {
            "templateSha256": self.plan.get("templateSha256"),
            "codexSha256": self.plan.get("codexSha256"),
            "entryCount": len(self.entries),
        }
        if self.plan.get("templates"):
            header["templateImages"] = [
                template.get("imageSha256")
                for template in self.plan.get("templates") or []
            ]
            header["nSamples"] = self.candidate_count
        return header

    def _initialize_selections(self) -> None:
        with WRITE_LOCK:
            changed = False
            if self.selections_path.exists():
                document = load_json(self.selections_path)
                expected_header = self._selection_header()
                if document.get("plan") != expected_header:
                    saved_header = document.get("plan") or {}
                    saved_templates = saved_header.get("templateImages") or []
                    expected_templates = expected_header.get("templateImages") or []
                    is_style_extension = (
                        saved_header.get("codexSha256")
                        == expected_header.get("codexSha256")
                        and saved_header.get("entryCount")
                        == expected_header.get("entryCount")
                        and bool(saved_templates)
                        and expected_templates[: len(saved_templates)] == saved_templates
                        and int(saved_header.get("nSamples") or 0)
                        <= int(expected_header.get("nSamples") or 0)
                    )
                    if not is_style_extension:
                        raise ValueError(
                            "selections.json belongs to a different batch plan"
                        )
                    document["plan"] = expected_header
                    changed = True
                selections = document.setdefault("selections", {})
            else:
                stamp = now_iso()
                document = {
                    "version": 1,
                    "createdAt": stamp,
                    "updatedAt": stamp,
                    "plan": self._selection_header(),
                    "selections": {},
                }
                selections = document["selections"]

            for entry_id in self.entry_by_id:
                if entry_id not in selections:
                    selections[entry_id] = {
                        "choice": 1,
                        "reviewed": False,
                        "rerun": False,
                        "updatedAt": None,
                    }
                    changed = True
                    continue
                selection = selections[entry_id]
                candidate_count = self.candidate_count_by_id[entry_id]
                if selection.get("choice") not in range(1, candidate_count + 1):
                    raise ValueError(f"invalid saved choice for {entry_id}")
                selection["reviewed"] = bool(selection.get("reviewed", False))
                selection["rerun"] = bool(selection.get("rerun", False))
            unknown = set(selections) - set(self.entry_by_id)
            if unknown:
                raise ValueError(
                    "selections.json contains unknown entry IDs: "
                    + ", ".join(sorted(unknown)[:5])
                )
            if changed or not self.selections_path.exists():
                document["updatedAt"] = now_iso()
                write_json_atomic(self.selections_path, document)

    def _manifest(self) -> dict[str, Any]:
        return load_json(self.manifest_path)

    def _selections(self) -> dict[str, Any]:
        return load_json(self.selections_path)

    def _result_for(
        self,
        entry_id: str,
        manifest: dict[str, Any],
    ) -> dict[str, Any] | None:
        result = (manifest.get("results") or {}).get(entry_id)
        if result:
            return result
        result_path = self.batch_dir / "entries" / entry_id / "result.json"
        if result_path.is_file():
            return load_json(result_path)
        return None

    def snapshot(self) -> dict[str, Any]:
        manifest = self._manifest()
        selection_document = self._selections()
        selections = selection_document["selections"]
        records: list[dict[str, Any]] = []
        generated_entries = 0
        generated_images = 0
        verified = 0
        review_status = 0
        failed = 0
        reviewed = 0
        rerun = 0
        choice_counts = [0] * self.candidate_count

        for entry in self.entries:
            entry_id = str(entry["id"])
            candidate_count = self.candidate_count_by_id[entry_id]
            result = self._result_for(entry_id, manifest)
            status = str((result or {}).get("status") or "pending")
            raw_images = list((result or {}).get("images") or [])
            images: list[dict[str, Any]] = []
            entry_dir = self.batch_dir / "entries" / entry_id
            for fallback_index, raw_image in enumerate(raw_images, 1):
                index = int(raw_image.get("styleIndex") or fallback_index)
                filename = Path(str(raw_image.get("file", ""))).name
                path = entry_dir / filename
                if not filename or not path.is_file():
                    continue
                images.append(
                    {
                        "index": index,
                        "file": filename,
                        "url": (
                            f"/image/{entry_id}/{filename}"
                        ),
                        "bytes": raw_image.get("bytes"),
                        "sha256": raw_image.get("sha256"),
                        "issues": raw_image.get("issues") or [],
                        "styleName": raw_image.get("styleName"),
                    }
                )
            images.sort(key=lambda image: image["index"])
            ready = (
                status in {"verified", "review"}
                and len(images) == candidate_count
                and {image["index"] for image in images}
                == set(range(1, candidate_count + 1))
            )
            if ready:
                generated_entries += 1
                generated_images += len(images)
            if status == "verified":
                verified += 1
            elif status == "review":
                review_status += 1
            elif status == "failed":
                failed += 1

            selection = selections[entry_id]
            is_reviewed = bool(selection.get("reviewed")) and ready
            is_rerun = bool(selection.get("rerun")) and ready
            if is_reviewed:
                reviewed += 1
            if is_rerun:
                rerun += 1
            choice = int(selection.get("choice", 1))
            choice_counts[choice - 1] += 1
            records.append(
                {
                    "id": entry_id,
                    "title": entry.get("title"),
                    "path": entry.get("path") or [],
                    "tags": entry.get("tags") or "",
                    "status": status,
                    "ready": ready,
                    "candidateCount": candidate_count,
                    "seed": (result or {}).get("seed"),
                    "attempts": len((result or {}).get("attempts") or []),
                    "error": (result or {}).get("error"),
                    "images": images,
                    "selection": {
                        "choice": int(selection.get("choice", 1)),
                        "reviewed": is_reviewed,
                        "rerun": is_rerun,
                        "updatedAt": selection.get("updatedAt"),
                    },
                }
            )

        total = len(records)
        return {
            "batch": {
                "path": str(self.batch_dir),
                "createdAt": self.plan.get("createdAt"),
                "templateSource": self.plan.get("templateSource"),
                "nSamples": self.plan.get("nSamples"),
                "minimumCandidates": min(self.candidate_count_by_id.values()),
                "maximumCandidates": max(self.candidate_count_by_id.values()),
            },
            "counts": {
                "total": total,
                "candidateImages": int(
                    self.plan.get(
                        "candidateImageCount", total * self.candidate_count
                    )
                ),
                "generatedEntries": generated_entries,
                "generatedImages": generated_images,
                "verified": verified,
                "metadataReview": review_status,
                "failed": failed,
                "pending": total - generated_entries - failed,
                "reviewed": reviewed,
                "rerun": rerun,
                "remainingReview": max(0, generated_entries - reviewed),
                "choiceOne": choice_counts[0],
                "choiceTwo": choice_counts[1] if self.candidate_count >= 2 else 0,
                "choiceCounts": choice_counts,
            },
            "selectionUpdatedAt": selection_document.get("updatedAt"),
            "entries": records,
        }

    def select(self, entry_id: str, choice: int) -> dict[str, Any]:
        if entry_id not in self.entry_by_id:
            raise ValueError(f"unknown entry: {entry_id}")
        candidate_count = self.candidate_count_by_id[entry_id]
        if choice not in range(1, candidate_count + 1):
            raise ValueError(f"choice must be between 1 and {candidate_count}")
        manifest = self._manifest()
        result = self._result_for(entry_id, manifest)
        if not result or result.get("status") not in {"verified", "review"}:
            raise ValueError("entry has no reviewable generation result")
        images = result.get("images") or []
        if len(images) != candidate_count:
            raise ValueError(
                f"entry does not have exactly {candidate_count} candidate images"
            )

        with WRITE_LOCK:
            document = self._selections()
            stamp = now_iso()
            document["selections"][entry_id] = {
                "choice": choice,
                "reviewed": True,
                "rerun": False,
                "decision": "select",
                "updatedAt": stamp,
            }
            document["updatedAt"] = stamp
            write_json_atomic(self.selections_path, document)
        return {
            "id": entry_id,
            "choice": choice,
            "reviewed": True,
            "rerun": False,
            "updatedAt": stamp,
        }

    def reject_all(self, entry_id: str) -> dict[str, Any]:
        if entry_id not in self.entry_by_id:
            raise ValueError(f"unknown entry: {entry_id}")
        manifest = self._manifest()
        result = self._result_for(entry_id, manifest)
        if not result or result.get("status") not in {"verified", "review"}:
            raise ValueError("entry has no reviewable generation result")
        images = result.get("images") or []
        candidate_count = self.candidate_count_by_id[entry_id]
        if len(images) != candidate_count:
            raise ValueError(
                f"entry does not have exactly {candidate_count} candidate images"
            )

        with WRITE_LOCK:
            document = self._selections()
            stamp = now_iso()
            previous = document["selections"][entry_id]
            document["selections"][entry_id] = {
                "choice": int(previous.get("choice", 1)),
                "reviewed": True,
                "rerun": True,
                "decision": "rerun",
                "updatedAt": stamp,
            }
            document["updatedAt"] = stamp
            write_json_atomic(self.selections_path, document)
        return {
            "id": entry_id,
            "choice": int(previous.get("choice", 1)),
            "reviewed": True,
            "rerun": True,
            "updatedAt": stamp,
        }

    def image_path(self, entry_id: str, filename: str) -> Path:
        if entry_id not in self.entry_by_id:
            raise ValueError("unknown entry")
        safe_name = Path(filename).name
        if safe_name != filename or not safe_name:
            raise ValueError("invalid image filename")
        manifest = self._manifest()
        result = self._result_for(entry_id, manifest) or {}
        allowed = {
            Path(str(image.get("file", ""))).name
            for image in result.get("images") or []
        }
        if safe_name not in allowed:
            raise ValueError("image is not registered in result")
        path = self.batch_dir / "entries" / entry_id / safe_name
        if not path.is_file():
            raise FileNotFoundError(path)
        return path


class ReviewHandler(BaseHTTPRequestHandler):
    server: "ReviewServer"

    def _send_bytes(
        self,
        body: bytes,
        content_type: str,
        *,
        status: HTTPStatus = HTTPStatus.OK,
        cache_control: str = "no-store",
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache_control)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(
        self,
        value: Any,
        *,
        status: HTTPStatus = HTTPStatus.OK,
    ) -> None:
        self._send_bytes(
            json.dumps(value, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8",
            status=status,
        )

    def _error(
        self,
        status: HTTPStatus,
        message: str,
    ) -> None:
        self._send_json({"error": message}, status=status)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            if path == "/":
                self._send_bytes(
                    REVIEW_HTML.encode("utf-8"),
                    "text/html; charset=utf-8",
                )
                return
            if path == "/api/state":
                self._send_json(self.server.review_state.snapshot())
                return
            if path == "/favicon.ico":
                self._send_bytes(b"", "image/x-icon", status=HTTPStatus.NO_CONTENT)
                return
            if path.startswith("/image/"):
                parts = path.split("/", 3)
                if len(parts) != 4:
                    raise ValueError("invalid image path")
                entry_id = unquote(parts[2])
                filename = unquote(parts[3])
                image_path = self.server.review_state.image_path(
                    entry_id,
                    filename,
                )
                content_type = (
                    mimetypes.guess_type(image_path.name)[0]
                    or "application/octet-stream"
                )
                self._send_bytes(
                    image_path.read_bytes(),
                    content_type,
                    cache_control="private, max-age=3600",
                )
                return
            self._error(HTTPStatus.NOT_FOUND, "not found")
        except FileNotFoundError:
            self._error(HTTPStatus.NOT_FOUND, "image not found")
        except ValueError as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
        except Exception as exc:  # pragma: no cover - defensive server boundary
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path not in {"/api/select", "/api/reject"}:
            self._error(HTTPStatus.NOT_FOUND, "not found")
            return
        try:
            raw_length = self.headers.get("Content-Length", "0")
            length = int(raw_length)
            if length <= 0 or length > MAX_POST_BYTES:
                raise ValueError("invalid request size")
            body = json.loads(self.rfile.read(length))
            entry_id = str(body.get("id", ""))
            if path == "/api/select":
                choice = int(body.get("choice", 0))
                selection = self.server.review_state.select(entry_id, choice)
            else:
                selection = self.server.review_state.reject_all(entry_id)
            self._send_json({"selection": selection})
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
        except Exception as exc:  # pragma: no cover - defensive server boundary
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

    def log_message(self, format: str, *args: Any) -> None:
        if self.server.verbose:
            super().log_message(format, *args)


class ReviewServer(ThreadingHTTPServer):
    def __init__(
        self,
        address: tuple[str, int],
        review_state: ReviewState,
        *,
        verbose: bool,
    ) -> None:
        super().__init__(address, ReviewHandler)
        self.review_state = review_state
        self.verbose = verbose


REVIEW_HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>所长法典 · 双图审核</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1018;
      --panel: rgba(23, 27, 39, .92);
      --panel-2: #1d2230;
      --line: #31384c;
      --text: #f3f5fa;
      --muted: #9ca6bc;
      --accent: #8d7cff;
      --accent-2: #62d9c3;
      --danger: #ff7285;
      --warn: #ffbd69;
      --shadow: 0 20px 60px rgba(0, 0, 0, .32);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background:
        radial-gradient(circle at 70% -10%, rgba(111, 91, 255, .22), transparent 38rem),
        radial-gradient(circle at -10% 80%, rgba(45, 202, 176, .12), transparent 35rem),
        var(--bg);
      font: 14px/1.5 Inter, "Microsoft YaHei", system-ui, sans-serif;
    }
    button, input, select { font: inherit; }
    button { color: inherit; }
    .app { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
    header {
      position: sticky;
      top: 0;
      z-index: 20;
      display: grid;
      grid-template-columns: minmax(220px, 1fr) minmax(320px, 1.4fr) auto;
      align-items: center;
      gap: 24px;
      min-height: 78px;
      padding: 14px 22px;
      border-bottom: 1px solid rgba(255, 255, 255, .07);
      background: rgba(13, 16, 24, .86);
      backdrop-filter: blur(18px);
    }
    .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .brand-mark {
      display: grid; place-items: center;
      width: 42px; height: 42px; flex: 0 0 auto;
      border-radius: 14px;
      background: linear-gradient(135deg, var(--accent), #6152cf);
      box-shadow: 0 8px 24px rgba(111, 91, 255, .28);
      font-weight: 900; font-size: 17px;
    }
    .brand h1 { margin: 0; font-size: 17px; letter-spacing: .02em; }
    .brand p { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
    .progress-wrap { min-width: 0; }
    .progress-labels {
      display: flex; justify-content: space-between; gap: 12px;
      margin-bottom: 7px; color: var(--muted); font-size: 12px;
    }
    .progress-labels strong { color: var(--text); }
    .progress {
      height: 8px; overflow: hidden; border-radius: 999px;
      background: #262b3a;
    }
    .progress > span {
      display: block; height: 100%; width: 0;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
      transition: width .35s ease;
    }
    .header-stats { display: flex; gap: 9px; }
    .stat {
      min-width: 74px; padding: 7px 10px;
      border: 1px solid var(--line); border-radius: 11px;
      background: rgba(255,255,255,.025);
      text-align: center;
    }
    .stat b { display: block; font-size: 16px; }
    .stat span { color: var(--muted); font-size: 11px; }
    .layout {
      min-height: 0;
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
    }
    aside {
      height: calc(100vh - 78px);
      position: sticky; top: 78px;
      display: grid; grid-template-rows: auto auto 1fr;
      border-right: 1px solid rgba(255,255,255,.07);
      background: rgba(16, 19, 28, .72);
    }
    .search { padding: 14px 14px 9px; }
    .search input {
      width: 100%; border: 1px solid var(--line); outline: none;
      border-radius: 11px; padding: 10px 12px;
      color: var(--text); background: var(--panel-2);
    }
    .search input:focus { border-color: var(--accent); }
    .filters { display: flex; gap: 7px; padding: 0 14px 12px; }
    .filter {
      flex: 1; border: 1px solid var(--line); border-radius: 9px;
      padding: 7px 5px; background: transparent; color: var(--muted);
      cursor: pointer;
    }
    .filter.active { color: white; border-color: var(--accent); background: rgba(141,124,255,.14); }
    .entry-list { min-height: 0; overflow: auto; padding: 0 9px 18px; }
    .entry-row {
      width: 100%; display: grid; grid-template-columns: 26px 1fr auto;
      gap: 8px; align-items: center; text-align: left;
      border: 1px solid transparent; border-radius: 10px;
      padding: 9px 8px; margin-bottom: 3px;
      background: transparent; cursor: pointer;
    }
    .entry-row:hover { background: rgba(255,255,255,.035); }
    .entry-row.active { background: rgba(141,124,255,.13); border-color: rgba(141,124,255,.55); }
    .entry-index { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 11px; }
    .entry-copy { min-width: 0; }
    .entry-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .entry-path { color: var(--muted); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .entry-state { width: 9px; height: 9px; border-radius: 50%; background: #495064; }
    .entry-state.ready { background: var(--accent-2); }
    .entry-state.reviewed { background: var(--accent); box-shadow: 0 0 0 3px rgba(141,124,255,.13); }
    .entry-state.failed { background: var(--danger); }
    main { min-width: 0; padding: 20px 24px 28px; }
    .entry-head {
      display: flex; justify-content: space-between; gap: 20px; align-items: flex-start;
      max-width: 1320px; margin: 0 auto 15px;
    }
    .eyebrow { color: var(--accent-2); font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
    .entry-head h2 { margin: 4px 0 3px; font-size: clamp(22px, 2.5vw, 32px); line-height: 1.2; }
    .meta { color: var(--muted); }
    .pill {
      flex: 0 0 auto; display: inline-flex; gap: 7px; align-items: center;
      padding: 7px 11px; border: 1px solid var(--line); border-radius: 999px;
      color: var(--muted); background: rgba(255,255,255,.025); font-size: 12px;
    }
    .pill.good { color: var(--accent-2); border-color: rgba(98,217,195,.35); }
    .pill.bad { color: var(--danger); border-color: rgba(255,114,133,.35); }
    .pill.wait { color: var(--warn); border-color: rgba(255,189,105,.35); }
    .compare {
      max-width: 1320px; margin: 0 auto;
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px;
    }
    .candidate {
      position: relative; min-width: 0; overflow: hidden;
      border: 2px solid transparent; border-radius: 18px;
      background: var(--panel); box-shadow: var(--shadow);
      cursor: pointer; transition: border-color .18s ease, transform .18s ease;
    }
    .candidate:hover { transform: translateY(-2px); }
    .candidate.selected { border-color: var(--accent); }
    .candidate.reviewed.selected { border-color: var(--accent-2); }
    .candidate-top {
      position: absolute; top: 12px; left: 12px; right: 12px; z-index: 3;
      display: flex; justify-content: space-between; pointer-events: none;
    }
    .candidate-badge, .chosen {
      padding: 6px 9px; border-radius: 9px; background: rgba(10,12,18,.78);
      backdrop-filter: blur(8px); font-weight: 700; font-size: 12px;
    }
    .candidate-badge {
      max-width: 78%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .chosen { display: none; color: var(--accent-2); }
    .selected .chosen { display: block; }
    .image-frame {
      position: relative; display: block; overflow: hidden; min-height: 360px;
      height: min(66vh, 720px); background:
        linear-gradient(45deg, #171b26 25%, transparent 25%) 0 0/22px 22px,
        linear-gradient(-45deg, #171b26 25%, transparent 25%) 0 11px/22px 22px,
        linear-gradient(45deg, transparent 75%, #171b26 75%) 11px -11px/22px 22px,
        linear-gradient(-45deg, transparent 75%, #171b26 75%) -11px 0/22px 22px,
        #131722;
    }
    .image-frame img {
      position: absolute; inset: 0; display: block;
      width: 100%; height: 100%; min-width: 0; min-height: 0;
      max-width: 100%; max-height: 100%; object-fit: contain;
    }
    .image-frame > .placeholder {
      position: absolute; inset: 0; display: grid; place-content: center;
    }
    .placeholder { color: var(--muted); text-align: center; padding: 30px; }
    .placeholder b { display: block; color: var(--text); margin-bottom: 5px; }
    .candidate-foot {
      display: flex; justify-content: space-between; gap: 10px; align-items: center;
      padding: 10px 13px; color: var(--muted); font-size: 12px;
    }
    .kbd {
      border: 1px solid #4a5165; border-bottom-width: 2px;
      border-radius: 6px; padding: 1px 6px; color: var(--text);
      background: #242938; font-size: 11px;
    }
    .controls {
      max-width: 1320px; margin: 16px auto 0;
      display: flex; justify-content: space-between; align-items: center; gap: 12px;
    }
    .controls-group { display: flex; gap: 9px; }
    .btn {
      border: 1px solid var(--line); border-radius: 11px;
      padding: 10px 14px; background: var(--panel-2); cursor: pointer;
    }
    .btn:hover:not(:disabled) { border-color: #5e6882; }
    .btn.primary { border-color: transparent; background: linear-gradient(135deg, var(--accent), #6658d7); }
    .btn.danger { color: #ffd7dd; border-color: rgba(255,114,133,.45); background: rgba(255,114,133,.1); }
    .btn:disabled { opacity: .42; cursor: not-allowed; }
    details {
      max-width: 1320px; margin: 15px auto 0;
      border: 1px solid var(--line); border-radius: 12px; background: rgba(255,255,255,.025);
    }
    summary { padding: 10px 13px; color: var(--muted); cursor: pointer; }
    .tags {
      padding: 0 13px 13px; color: #c4cada; font: 12px/1.65 ui-monospace, Consolas, monospace;
      overflow-wrap: anywhere;
    }
    .toast {
      position: fixed; right: 20px; bottom: 20px; z-index: 50;
      max-width: 360px; padding: 10px 14px; border-radius: 10px;
      background: #292f40; box-shadow: var(--shadow);
      opacity: 0; transform: translateY(8px); pointer-events: none;
      transition: .2s ease;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
    .toast.error { background: #5a2631; }
    @media (max-width: 960px) {
      header { grid-template-columns: 1fr auto; }
      .progress-wrap { grid-column: 1 / -1; grid-row: 2; }
      .layout { grid-template-columns: 1fr; }
      aside { position: static; height: auto; grid-template-rows: auto auto; border-right: 0; }
      .entry-list { display: none; }
      main { padding: 16px 13px 24px; }
      .image-frame { height: min(60vh, 620px); }
    }
    @media (max-width: 680px) {
      header { padding: 12px; gap: 12px; }
      .header-stats .stat:nth-child(1) { display: none; }
      .compare { grid-template-columns: 1fr; }
      .image-frame { height: 62vh; }
      .controls { align-items: stretch; flex-direction: column; }
      .controls-group { display: grid; grid-template-columns: 1fr 1fr; }
      .controls-group:last-child { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div class="brand">
        <div class="brand-mark">双</div>
        <div>
          <h1>所长法典 · 例图审核</h1>
          <p>每条两张，默认保留第一张</p>
        </div>
      </div>
      <div class="progress-wrap">
        <div class="progress-labels">
          <span>复核进度 <strong id="reviewProgress">0 / 0</strong></span>
          <span id="generateProgress">已出图 0 / 0</span>
        </div>
        <div class="progress"><span id="progressBar"></span></div>
      </div>
      <div class="header-stats">
        <div class="stat"><b id="candidateCount">0</b><span>候选图</span></div>
        <div class="stat"><b id="choiceTwoCount">0</b><span>改选图 2</span></div>
        <div class="stat"><b id="failedCount">0</b><span>失败</span></div>
      </div>
    </header>

    <div class="layout">
      <aside>
        <div class="search"><input id="search" type="search" placeholder="搜索标题、ID、路径或 Tag"></div>
        <div class="filters">
          <button class="filter active" data-filter="unreviewed">未复核</button>
          <button class="filter" data-filter="all">全部</button>
          <button class="filter" data-filter="rerun">已舍弃</button>
          <button class="filter" data-filter="problem">未出图</button>
        </div>
        <div class="entry-list" id="entryList"></div>
      </aside>

      <main>
        <div class="entry-head">
          <div>
            <div class="eyebrow" id="entryId">等待数据</div>
            <h2 id="entryTitle">正在读取批次……</h2>
            <div class="meta" id="entryMeta"></div>
          </div>
          <div class="pill wait" id="statusPill">等待</div>
        </div>

        <div class="compare" id="compare"></div>

        <div class="controls">
          <div class="controls-group">
            <button class="btn" id="previous">← 上一条</button>
            <button class="btn" id="next">下一条 →</button>
          </div>
          <div class="controls-group">
            <button class="btn danger" id="reject">全部舍弃，稍后处理 <span class="kbd">X</span></button>
            <button class="btn primary" id="accept">保留当前并下一条 <span class="kbd">Enter</span></button>
          </div>
        </div>

        <details>
          <summary>查看法典 Tag</summary>
          <div class="tags" id="tags"></div>
        </details>
      </main>
    </div>
  </div>
  <div class="toast" id="toast"></div>

  <script>
    const $ = (selector) => document.querySelector(selector);
    let state = null;
    let currentId = null;
    let filter = "unreviewed";
    let query = "";
    let refreshTimer = null;

    const esc = (value) => String(value ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

    function notify(message, error = false) {
      const toast = $("#toast");
      toast.textContent = message;
      toast.className = "toast show" + (error ? " error" : "");
      clearTimeout(toast._timer);
      toast._timer = setTimeout(() => toast.className = "toast", 2200);
    }

    function visibleEntries() {
      if (!state) return [];
      const needle = query.trim().toLowerCase();
      return state.entries.filter((entry) => {
        if (filter === "unreviewed" && (!entry.ready || entry.selection.reviewed)) return false;
        if (filter === "problem" && entry.ready) return false;
        if (filter === "rerun" && !entry.selection.rerun) return false;
        if (!needle) return true;
        return [
          entry.id, entry.title, (entry.path || []).join(" / "), entry.tags
        ].join("\n").toLowerCase().includes(needle);
      });
    }

    function currentEntry() {
      return state?.entries.find((entry) => entry.id === currentId) || null;
    }

    function ensureCurrent() {
      if (!state?.entries.length) return;
      if (currentEntry()) return;
      const preferred = state.entries.find((entry) => entry.ready && !entry.selection.reviewed)
        || state.entries.find((entry) => entry.ready)
        || state.entries[0];
      currentId = preferred.id;
    }

    function renderHeader() {
      const counts = state.counts;
      const denominator = counts.generatedEntries || counts.total;
      const percent = denominator ? Math.min(100, counts.reviewed / denominator * 100) : 0;
      const candidateTotal = Number(state.batch.nSamples) || 2;
      document.title = `所长法典 · ${candidateTotal} 图审核`;
      document.querySelector(".brand-mark").textContent = candidateTotal === 4 ? "四" : candidateTotal === 6 ? "六" : "选";
      const minimum = Number(state.batch.minimumCandidates) || candidateTotal;
      document.querySelector(".brand p").textContent = minimum === candidateTotal
        ? `每条 ${candidateTotal} 张，每种画风一张`
        : `已完成旧条 ${minimum} 张，其余 ${candidateTotal} 张`;
      $("#reviewProgress").textContent = `${counts.reviewed} / ${counts.generatedEntries}`;
      $("#generateProgress").textContent = `已出图 ${counts.generatedEntries} / ${counts.total}`;
      $("#progressBar").style.width = `${percent}%`;
      $("#candidateCount").textContent = `${counts.generatedImages}/${counts.candidateImages}`;
      $("#choiceTwoCount").textContent = (counts.choiceCounts || [counts.choiceOne, counts.choiceTwo])
        .map((count, index) => `${index + 1}:${count}`).join(" · ");
      $("#choiceTwoCount").nextElementSibling.textContent = "选择分布";
      $("#failedCount").textContent = `${counts.failed}/${counts.rerun || 0}`;
      $("#failedCount").nextElementSibling.textContent = "失败/舍弃";
    }

    function rowState(entry) {
      if (entry.status === "failed") return "failed";
      if (entry.selection.rerun) return "failed";
      if (entry.selection.reviewed) return "reviewed";
      if (entry.ready) return "ready";
      return "";
    }

    function renderList() {
      const entries = visibleEntries();
      $("#entryList").innerHTML = entries.map((entry) => {
        const originalIndex = state.entries.findIndex((item) => item.id === entry.id) + 1;
        return `<button class="entry-row ${entry.id === currentId ? "active" : ""}" data-id="${esc(entry.id)}">
          <span class="entry-index">${String(originalIndex).padStart(3, "0")}</span>
          <span class="entry-copy">
            <span class="entry-title">${esc(entry.title)}</span>
            <span class="entry-path">${esc((entry.path || []).join(" / "))}</span>
          </span>
          <span class="entry-state ${rowState(entry)}"></span>
        </button>`;
      }).join("") || `<div class="placeholder"><b>当前筛选没有词条</b>切换“全部”或清空搜索。</div>`;
      document.querySelectorAll(".entry-row").forEach((row) => {
        row.addEventListener("click", () => {
          currentId = row.dataset.id;
          render();
        });
      });
    }

    function statusInfo(entry) {
      if (entry.ready && entry.selection.rerun) return ["已全部舍弃", "bad"];
      if (entry.ready && entry.selection.reviewed) return ["已复核", "good"];
      if (entry.ready) return ["待选择", "good"];
      if (entry.status === "failed") return ["生成失败", "bad"];
      if (entry.status === "review") return ["元数据待复核", "wait"];
      return ["等待出图", "wait"];
    }

    function imageCard(entry, index) {
      const image = entry.images.find((candidate) => candidate.index === index);
      const selected = entry.selection.choice === index;
      const classes = ["candidate", selected ? "selected" : "", entry.selection.reviewed ? "reviewed" : ""].join(" ");
      const styleLabel = image?.styleName ? ` · ${image.styleName}` : "";
      const content = image
        ? `<img src="${esc(image.url)}" alt="${esc(entry.title)} 候选图 ${index}">`
        : `<div class="placeholder"><b>候选图 ${index} 尚未生成</b>页面会自动刷新生成进度。</div>`;
      const issueText = image?.issues?.length ? `${image.issues.length} 项元数据问题` : "元数据通过";
      return `<article class="${classes}" data-choice="${index}">
        <div class="candidate-top">
          <span class="candidate-badge" title="${esc(image?.styleName || "")}">图 ${index}${esc(styleLabel)}</span>
          <span class="chosen">当前选择 ✓</span>
        </div>
        <div class="image-frame">${content}</div>
        <div class="candidate-foot">
          <span>${image ? esc(issueText) : "等待中"}</span>
          <span>选择 <span class="kbd">${index}</span></span>
        </div>
      </article>`;
    }

    function renderMain() {
      const entry = currentEntry();
      if (!entry) return;
      $("#entryId").textContent = entry.id;
      $("#entryTitle").textContent = entry.title || "(无标题)";
      $("#entryMeta").textContent = (entry.path || []).join(" / ");
      $("#tags").textContent = entry.tags || "(无 Tag)";
      const [statusText, statusClass] = statusInfo(entry);
      $("#statusPill").textContent = statusText;
      $("#statusPill").className = `pill ${statusClass}`;
      const candidateTotal = Number(entry.candidateCount) || Number(state.batch.nSamples) || 2;
      $("#compare").innerHTML = Array.from(
        {length: candidateTotal},
        (_, index) => imageCard(entry, index + 1)
      ).join("");
      document.querySelectorAll(".candidate").forEach((card) => {
        card.addEventListener("click", () => choose(Number(card.dataset.choice)));
      });
      $("#accept").disabled = !entry.ready;
      $("#reject").disabled = !entry.ready;
      $("#previous").disabled = state.entries.indexOf(entry) === 0;
      $("#next").disabled = state.entries.indexOf(entry) === state.entries.length - 1;
    }

    function render() {
      if (!state) return;
      ensureCurrent();
      renderHeader();
      renderList();
      renderMain();
    }

    async function fetchState(silent = false) {
      try {
        const response = await fetch("/api/state", {cache: "no-store"});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state = await response.json();
        ensureCurrent();
        render();
        const terminalEntries = state.counts.generatedEntries + state.counts.failed;
        if (terminalEntries < state.counts.total && !refreshTimer) {
          refreshTimer = setInterval(() => fetchState(true), 5000);
        }
        if (terminalEntries >= state.counts.total && refreshTimer) {
          clearInterval(refreshTimer);
          refreshTimer = null;
        }
      } catch (error) {
        if (!silent) notify(`读取失败：${error.message}`, true);
      }
    }

    function move(delta, preferUnreviewed = false) {
      if (!state) return;
      const entries = preferUnreviewed
        ? state.entries.filter((entry) => entry.ready && !entry.selection.reviewed)
        : state.entries;
      if (!entries.length) return;
      const index = entries.findIndex((entry) => entry.id === currentId);
      const nextIndex = index < 0 ? 0 : Math.max(0, Math.min(entries.length - 1, index + delta));
      currentId = entries[nextIndex].id;
      render();
      document.querySelector(".entry-row.active")?.scrollIntoView({block: "nearest"});
    }

    function moveToNextUnreviewed(fromId) {
      const all = state.entries;
      const start = all.findIndex((entry) => entry.id === fromId);
      for (let offset = 1; offset <= all.length; offset++) {
        const candidate = all[(start + offset) % all.length];
        if (candidate.ready && !candidate.selection.reviewed) {
          currentId = candidate.id;
          return;
        }
      }
    }

    async function choose(choice) {
      const entry = currentEntry();
      if (!entry?.ready) {
        notify(`这个词条还没有 ${entry?.candidateCount || state.batch.nSamples} 张可选图片`, true);
        return;
      }
      try {
        const response = await fetch("/api/select", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({id: entry.id, choice})
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        entry.selection = data.selection;
        notify(`已保存：${entry.title} → 图 ${choice}`);
        moveToNextUnreviewed(entry.id);
        render();
      } catch (error) {
        notify(`保存失败：${error.message}`, true);
      }
    }

    async function rejectAll() {
      const entry = currentEntry();
      if (!entry?.ready) {
        notify(`这个词条还没有 ${entry?.candidateCount || state.batch.nSamples} 张可选图片`, true);
        return;
      }
      try {
        const response = await fetch("/api/reject", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({id: entry.id})
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        entry.selection = data.selection;
        notify(`已全部舍弃：${entry.title}`);
        moveToNextUnreviewed(entry.id);
        render();
      } catch (error) {
        notify(`保存失败：${error.message}`, true);
      }
    }

    $("#previous").addEventListener("click", () => move(-1));
    $("#next").addEventListener("click", () => move(1));
    $("#accept").addEventListener("click", () => {
      const entry = currentEntry();
      if (entry) choose(entry.selection.choice || 1);
    });
    $("#reject").addEventListener("click", rejectAll);
    $("#search").addEventListener("input", (event) => {
      query = event.target.value;
      renderList();
    });
    document.querySelectorAll(".filter").forEach((button) => {
      button.addEventListener("click", () => {
        filter = button.dataset.filter;
        document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button));
        renderList();
      });
    });
    document.addEventListener("keydown", (event) => {
      if (event.target.matches("input, textarea")) return;
      const numericChoice = Number(event.key);
      if (Number.isInteger(numericChoice)
          && numericChoice >= 1
          && numericChoice <= Number(currentEntry()?.candidateCount || state?.batch?.nSamples || 2)) {
        choose(numericChoice);
      }
      if (event.key.toLowerCase() === "x") rejectAll();
      if (event.key === "Enter") {
        const entry = currentEntry();
        if (entry) choose(entry.selection.choice || 1);
      }
      if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") move(-1);
      if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") move(1);
    });
    fetchState();
  </script>
</body>
</html>
"""


def main() -> int:
    args = parse_args()
    if not 1 <= args.port <= 65535:
        raise ValueError("--port must be between 1 and 65535")
    review_state = ReviewState(args.batch_dir)
    if args.check:
        snapshot = review_state.snapshot()
        print(
            json.dumps(
                {
                    "batch": snapshot["batch"]["path"],
                    "counts": snapshot["counts"],
                    "selections": str(review_state.selections_path),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    server = ReviewServer(
        (args.host, args.port),
        review_state,
        verbose=args.verbose,
    )
    print(f"NAI review -> http://{args.host}:{args.port}/", flush=True)
    print(f"Selections -> {review_state.selections_path}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
