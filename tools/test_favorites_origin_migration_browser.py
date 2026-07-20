# -*- coding: utf-8 -*-
"""Real-browser, dual-origin regression for the pages.dev favorites rescue bridge."""
from __future__ import annotations

import base64
import json
import tempfile
import threading
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from verify_ui import CDP, find_free_port, page_ws_url, start_chrome, wait_for


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
RESCUE_PATH = "/_favorites-migration-202607.html"
RESCUE_CACHE_BUSTER = "20260721"
MARKER_KEY = "novelai-tag-favorites-origin-migration-v1"
ATLAS_KEY = "fadian-favs"
COMMUNITY_KEY = "community-favorites-v1"


class QuietThreadingHTTPServer(ThreadingHTTPServer):
    def handle_error(self, _request, _client_address) -> None:
        # Headless Chrome may reset keep-alive sockets while popup targets close.
        return


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def make_handler(old_origin: str, new_origin: str):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(SITE), **kwargs)

        def log_message(self, _format: str, *_args) -> None:
            return

        def end_headers(self) -> None:
            if urllib.parse.urlparse(self.path).path == RESCUE_PATH:
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Robots-Tag", "noindex, nofollow")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("Cross-Origin-Opener-Policy", "unsafe-none")
            super().end_headers()

        def do_GET(self) -> None:
            if urllib.parse.urlparse(self.path).path != "/__migration-harness.html":
                super().do_GET()
                return

            migration_path = (
                f"{RESCUE_PATH}?targetOrigin={urllib.parse.quote(new_origin, safe='')}"
            )
            html = f"""<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>favorites migration harness</title></head>
<body>
  <aside data-favorites-migration-banner hidden>
    <button type="button" data-favorites-migration-start>banner start</button>
    <button type="button" data-favorites-migration-dismiss>dismiss</button>
    <span data-favorites-migration-feedback hidden></span>
  </aside>
  <button id="permanentStart" type="button" data-favorites-migration-start>permanent start</button>
  <p data-favorites-migration-feedback hidden></p>
  <a data-favorites-migration-fallback>fallback</a>
  <script type="module">
    import {{ setupFavoritesOriginMigration }} from '/assets/app/favorites-origin-migration.js';
    window.__migrationReady = false;
    window.__migrationChanges = 0;
    window.__migrationRefreshes = 0;
    window.__migrationError = '';
    try {{
      window.__migrationController = setupFavoritesOriginMigration({{
        oldOrigin: {json.dumps(old_origin)},
        newOrigin: {json.dumps(new_origin)},
        currentOrigin: location.origin,
        migrationPath: {json.dumps(migration_path)},
        now: Date.parse('2026-07-20T00:00:00+08:00'),
        getCodexes: async () => [
          {{ id: 'alpha', aliases: ['old_alpha'] }},
          {{ id: 'beta' }},
        ],
        onChanged: () => {{ window.__migrationChanges += 1; }},
        refreshCounts: async () => {{ window.__migrationRefreshes += 1; }},
      }});
      window.__migrationReady = true;
    }} catch (error) {{
      window.__migrationError = String(error && (error.stack || error.message) || error);
    }}
  </script>
</body>
</html>"""
            payload = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

    return Handler


def start_server(origin_port: int, handler) -> tuple[ThreadingHTTPServer, threading.Thread]:
    server = QuietThreadingHTTPServer(("127.0.0.1", origin_port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def navigate(cdp: CDP, url: str) -> None:
    cdp.command("Page.navigate", {"url": url}, timeout=10)
    wait_for(
        cdp,
        "document.readyState === 'complete' || document.readyState === 'interactive'",
        f"document ready at {url}",
        timeout=10,
    )


def click(cdp: CDP, selector: str) -> None:
    cdp.command("Page.bringToFront")
    rect = cdp.eval(
        f"""(() => {{
          const element = document.querySelector({json.dumps(selector)});
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return {{ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }};
        }})()"""
    )
    check(bool(rect), f"missing click target: {selector}")
    for event_type, buttons in (("mousePressed", 1), ("mouseReleased", 0)):
        cdp.command(
            "Input.dispatchMouseEvent",
            {
                "type": event_type,
                "x": rect["x"],
                "y": rect["y"],
                "button": "left",
                "buttons": buttons,
                "clickCount": 1,
            },
        )


def set_storage(cdp: CDP, atlas_raw: str | None, community_raw: str | None) -> None:
    cdp.eval(
        f"""(() => {{
          localStorage.clear();
          const atlas = {json.dumps(atlas_raw)};
          const community = {json.dumps(community_raw)};
          if (atlas !== null) localStorage.setItem({json.dumps(ATLAS_KEY)}, atlas);
          if (community !== null) localStorage.setItem({json.dumps(COMMUNITY_KEY)}, community);
          return true;
        }})()"""
    )


def read_storage(cdp: CDP) -> dict:
    return cdp.eval(
        f"""(() => ({{
          atlasRaw: localStorage.getItem({json.dumps(ATLAS_KEY)}),
          communityRaw: localStorage.getItem({json.dumps(COMMUNITY_KEY)}),
          marker: JSON.parse(localStorage.getItem({json.dumps(MARKER_KEY)}) || 'null'),
        }}))()"""
    )


def wait_for_migration(cdp: CDP, changes: int = 1) -> dict:
    wait_for(
        cdp,
        f"""(() => {{
          const marker = JSON.parse(localStorage.getItem({json.dumps(MARKER_KEY)}) || 'null');
          return marker && marker.status && window.__migrationChanges >= {changes};
        }})()""",
        f"migration #{changes}",
        timeout=12,
    )
    return cdp.eval(
        f"""(() => ({{
          storage: {{
            atlas: JSON.parse(localStorage.getItem({json.dumps(ATLAS_KEY)}) || '[]'),
            community: JSON.parse(localStorage.getItem({json.dumps(COMMUNITY_KEY)}) || '[]'),
            marker: JSON.parse(localStorage.getItem({json.dumps(MARKER_KEY)}) || 'null'),
          }},
          changes: window.__migrationChanges,
          refreshes: window.__migrationRefreshes,
          feedback: [...document.querySelectorAll('[data-favorites-migration-feedback]')]
            .map(element => element.textContent),
          bannerHidden: document.querySelector('[data-favorites-migration-banner]').hidden,
          error: window.__migrationError,
        }}))()"""
    )


def run() -> None:
    old_port = find_free_port()
    new_port = find_free_port()
    while new_port == old_port:
        new_port = find_free_port()
    old_origin = f"http://127.0.0.1:{old_port}"
    new_origin = f"http://127.0.0.1:{new_port}"
    handler = make_handler(old_origin, new_origin)
    old_server, old_thread = start_server(old_port, handler)
    new_server, new_thread = start_server(new_port, handler)
    artifact_dir = ROOT / "output" / "playwright" / "favorites-origin-migration"
    artifact_dir.mkdir(parents=True, exist_ok=True)

    chrome = None
    cdp = None
    profile_temp = None
    try:
        with urllib.request.urlopen(f"{old_origin}{RESCUE_PATH}", timeout=5) as response:
            check(response.status == 200, "local rescue path must return 200")
            check(response.headers.get("Cache-Control") == "no-store", "rescue path must be no-store")
            check(
                "noindex" in (response.headers.get("X-Robots-Tag") or ""),
                "rescue path must be noindex",
            )

        profile_temp = tempfile.TemporaryDirectory(
            prefix="chrome-profile-",
            dir=str(artifact_dir),
        )
        devtools_port = find_free_port()
        chrome = start_chrome(Path(profile_temp.name), devtools_port)
        cdp = CDP(page_ws_url(devtools_port))
        cdp.command("Page.enable")
        cdp.command("Runtime.enable")

        old_atlas_raw = json.dumps(
            [
                "old_alpha:old_alpha-1",
                "alpha:alpha-existing",
                "old_alpha:old_alpha-1",
            ]
        )
        old_community_raw = json.dumps(
            ["community-old", "community-existing", "community-old"]
        )
        navigate(cdp, f"{old_origin}{RESCUE_PATH}")
        set_storage(cdp, old_atlas_raw, old_community_raw)

        navigate(cdp, f"{new_origin}/__migration-harness.html")
        wait_for(cdp, "window.__migrationReady === true", "migration harness")
        fallback_url = cdp.eval(
            "document.querySelector('[data-favorites-migration-fallback]').href"
        )
        fallback_query = urllib.parse.parse_qs(urllib.parse.urlparse(fallback_url).query)
        check(
            fallback_query.get("bridge") == [RESCUE_CACHE_BUSTER],
            f"fallback URL lacks 301-cache bypass: {fallback_url!r}",
        )
        check(
            fallback_query.get("targetOrigin") == [new_origin],
            f"fallback URL lost target origin: {fallback_url!r}",
        )
        set_storage(
            cdp,
            json.dumps(["alpha:alpha-existing", "beta:beta-new-domain"]),
            json.dumps(["community-existing"]),
        )
        click(cdp, "#permanentStart")
        first = wait_for_migration(cdp, 1)
        check(first["error"] == "", f"harness error: {first['error']}")
        check(
            first["storage"]["atlas"]
            == [
                "alpha:alpha-1",
                "alpha:alpha-existing",
                "beta:beta-new-domain",
            ],
            f"atlas merge mismatch: {first['storage']['atlas']!r}",
        )
        check(
            first["storage"]["community"]
            == ["community-existing", "community-old"],
            f"community merge mismatch: {first['storage']['community']!r}",
        )
        check(first["storage"]["marker"]["added"] == 2, "first migration should add 2")
        check(first["storage"]["marker"]["duplicate"] == 2, "first migration duplicate count")
        check(first["changes"] == 1 and first["refreshes"] == 1, "both UIs must refresh")
        check(first["bannerHidden"] is True, "successful check must hide temporary banner")

        screenshot_data = cdp.command(
            "Page.captureScreenshot",
            {"format": "png", "captureBeyondViewport": False},
            timeout=10,
        )["data"]
        (artifact_dir / "merged.png").write_bytes(base64.b64decode(screenshot_data))

        click(cdp, "#permanentStart")
        second = wait_for_migration(cdp, 2)
        check(second["storage"]["marker"]["added"] == 0, "repeat migration must be idempotent")
        check(
            second["storage"]["marker"]["duplicate"] == 4,
            "repeat migration must count four unique incoming duplicates",
        )
        check(second["storage"]["atlas"] == first["storage"]["atlas"], "repeat changed atlas")
        check(
            second["storage"]["community"] == first["storage"]["community"],
            "repeat changed community",
        )

        navigate(cdp, f"{old_origin}{RESCUE_PATH}")
        old_after = read_storage(cdp)
        check(old_after["atlasRaw"] == old_atlas_raw, "old atlas storage was modified")
        check(old_after["communityRaw"] == old_community_raw, "old community storage was modified")

        # A single damaged key must not block recovery of the other valid collection.
        set_storage(cdp, "{broken", json.dumps(["community-salvage"]))
        navigate(cdp, f"{new_origin}/__migration-harness.html")
        wait_for(cdp, "window.__migrationReady === true", "fresh migration harness")
        set_storage(cdp, None, json.dumps(["community-new"]))
        click(cdp, "#permanentStart")
        partial = wait_for_migration(cdp, 1)
        check(partial["storage"]["atlas"] == [], "damaged atlas key must be skipped")
        check(
            partial["storage"]["community"] == ["community-new", "community-salvage"],
            "valid community key was not salvaged",
        )
        check(partial["storage"]["marker"]["added"] == 1, "partial recovery add count")

        # Direct/manual opening has no opener and must expose the JSON fallback.
        navigate(cdp, f"{old_origin}{RESCUE_PATH}")
        fallback = cdp.eval(
            """(() => ({
              status: document.getElementById('status').textContent,
              downloadHidden: document.getElementById('downloadBtn').hidden,
              atlasRaw: localStorage.getItem('fadian-favs'),
              communityRaw: localStorage.getItem('community-favorites-v1'),
            }))()"""
        )
        check("JSON" in fallback["status"], f"manual fallback missing: {fallback['status']!r}")
        check(fallback["downloadHidden"] is False, "manual JSON download should be available")
        check(fallback["atlasRaw"] == "{broken", "damaged old key must remain untouched")
        check(
            fallback["communityRaw"] == json.dumps(["community-salvage"]),
            "valid old key must remain untouched",
        )
        cdp.eval(
            """(() => {
              window.__downloadedBackup = '';
              URL.createObjectURL = blob => {
                blob.text().then(text => { window.__downloadedBackup = text; });
                return 'blob:test-backup';
              };
              URL.revokeObjectURL = () => {};
              HTMLAnchorElement.prototype.click = () => {};
              document.getElementById('downloadBtn').click();
              return true;
            })()"""
        )
        wait_for(cdp, "Boolean(window.__downloadedBackup)", "manual JSON backup")
        downloaded = cdp.eval("JSON.parse(window.__downloadedBackup)")
        check(downloaded["format"] == "novelai-tag-favorites", "fallback format mismatch")
        check(downloaded["version"] == 1, "fallback version mismatch")
        check(downloaded["favorites"]["atlas"] == [], "damaged atlas leaked into fallback")
        check(
            downloaded["favorites"]["community"] == ["community-salvage"],
            "fallback community payload mismatch",
        )

        cdp.eval("true")
        runtime_errors = [
            event
            for event in cdp.events
            if event.get("method") == "Runtime.exceptionThrown"
        ]
        check(not runtime_errors, f"browser runtime errors: {runtime_errors!r}")
    finally:
        if cdp is not None:
            cdp.close()
        if chrome is not None:
            chrome.terminate()
            try:
                chrome.wait(timeout=5)
            except Exception:
                chrome.kill()
        if profile_temp is not None:
            profile_temp.cleanup()
        old_server.shutdown()
        new_server.shutdown()
        old_server.server_close()
        new_server.server_close()
        old_thread.join(timeout=2)
        new_thread.join(timeout=2)


if __name__ == "__main__":
    run()
    print("favorites origin migration browser: all tests passed")
