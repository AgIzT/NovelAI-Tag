"""Serve the local Danbooru artist picker and persist review decisions."""
import argparse
import json
import sqlite3
import sys
import threading
import time
import webbrowser
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

from catalog import DATA, ROOT, api, read_roster, refresh_roster

sys.path.insert(0, str(ROOT / "tools"))
from build_artist_index import prompt_artists


HERE = Path(__file__).resolve().parent
DB = DATA / "picker.sqlite3"
FILES = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"),
         "/style.css": ("style.css", "text/css")}
POST_FIELDS = "id,rating,is_deleted,is_banned,tag_string_artist,tag_string_meta,media_asset[variants,is_public,status,file_ext]"
PAGE_SIZE = 12
CACHE_TTL = 7 * 86400
REQUEST_SLOTS = threading.BoundedSemaphore(3)
IMAGE_SLOTS = threading.BoundedSemaphore(6)
REQUEST_PACING = threading.Lock()
NEXT_REQUEST = 0.0
STATES = {"selected", "skipped", "none"}
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"}


def compact(name):
    return "".join(name.lower().replace("_", " ").split())


def generated_names():
    names = set()
    book_path = ROOT / "site/data/artist_nai5_personal.json"
    if book_path.is_file():
        book = json.loads(book_path.read_text(encoding="utf-8-sig"))
        for entry in book.get("entries", []):
            if entry["id"].startswith("artist_nai5_personal_agizt_") and entry.get("image"):
                names.update(compact(name) for name in prompt_artists(entry.get("tags", "")))
    return names


def connect():
    return sqlite3.connect(DB, timeout=5, isolation_level=None)


def initialize():
    DATA.mkdir(parents=True, exist_ok=True)
    with closing(connect()) as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS decisions (
                artist TEXT PRIMARY KEY, state TEXT NOT NULL, updated REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS previews (
                artist TEXT NOT NULL, sort TEXT NOT NULL, page INTEGER NOT NULL,
                fetched REAL NOT NULL, body TEXT NOT NULL, PRIMARY KEY (artist, sort, page)
            );
        """)


def preview_url(value):
    parsed = urlsplit(value or "")
    if (parsed.scheme == "https" and parsed.netloc == "cdn.donmai.us"
            and not parsed.query and not parsed.fragment
            and parsed.path.startswith(("/180x180/", "/360x360/", "/720x720/"))):
        return value
    return None


def preview_post(post, artist):
    if (post.get("rating") != "g" or post.get("is_deleted") is not False or post.get("is_banned") is not False
            or artist not in post.get("tag_string_artist", "").split()
            or "ai-generated" in post.get("tag_string_meta", "").split()):
        return None
    asset = post.get("media_asset") or {}
    if asset.get("is_public") is not True or asset.get("status") != "active":
        return None
    variants = {item["type"]: preview_url(item.get("url")) for item in asset.get("variants", [])}
    thumb = variants.get("360x360") or variants.get("180x180")
    if not thumb:
        return None
    return {"id": post["id"], "thumb": thumb, "large": variants.get("720x720") or thumb}


def read_posts(artist, sort, page):
    global NEXT_REQUEST
    key = (artist, sort, page)
    with closing(connect()) as db:
        cached = db.execute("SELECT fetched, body FROM previews WHERE artist=? AND sort=? AND page=?", key).fetchone()
        if cached and time.time() - cached[0] < CACHE_TTL:
            return json.loads(cached[1])

        query = f"{artist} rating:g" + (" order:score" if sort == "score" else "")
        try:
            with REQUEST_SLOTS:
                with REQUEST_PACING:
                    time.sleep(max(0, NEXT_REQUEST - time.monotonic()))
                    NEXT_REQUEST = time.monotonic() + 0.35
                rows = api("posts.json", {"tags": query, "limit": PAGE_SIZE, "page": page, "only": POST_FIELDS})
        except (URLError, ValueError, TimeoutError, OSError):
            if cached:
                return {**json.loads(cached[1]), "stale": True}
            raise
        posts = [clean for row in rows if (clean := preview_post(row, artist))]
        response = {"posts": posts, "more": len(rows) == PAGE_SIZE}
        db.execute("INSERT OR REPLACE INTO previews VALUES (?, ?, ?, ?, ?)", (*key, time.time(), json.dumps(response)))
        return response


class PickerServer(ThreadingHTTPServer):
    def __init__(self, port, roster):
        super().__init__(("127.0.0.1", port), Handler)
        self.origin = f"http://127.0.0.1:{self.server_port}"
        self.names = {row[0] for row in roster["artists"]}
        self.catalog = json.dumps(roster, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.media = {}
        self.media_lock = threading.Lock()

    def local_previews(self, payload):
        posts = []
        with self.media_lock:
            for post in payload["posts"]:
                local = {"id": post["id"]}
                for size in ("thumb", "large"):
                    url = post[size]
                    path = "/preview" + urlsplit(url).path
                    self.media[path] = url
                    local[size] = path
                posts.append(local)
            while len(self.media) > 20000:
                del self.media[next(iter(self.media))]
        return {**payload, "posts": posts}


class Handler(BaseHTTPRequestHandler):
    def respond(self, body, media_type="application/json", status=200, max_age=0):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", media_type if media_type in IMAGE_TYPES else media_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", f"private, max-age={max_age}" if max_age else "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        try:
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def allowed_host(self):
        return self.headers.get("Host") == self.server.origin.removeprefix("http://")

    def get_preview(self, path):
        with self.server.media_lock:
            target = self.server.media.get(path)
        if not preview_url(target):
            return self.respond({"error": "not_found"}, status=404)
        try:
            request = Request(target, headers={"User-Agent": "NovelAITagAtlasArtistPicker/1.0"})
            with IMAGE_SLOTS, urlopen(request, timeout=12) as response:
                content_type = response.headers.get_content_type()
                if not preview_url(response.url) or content_type not in IMAGE_TYPES:
                    raise ValueError("Unexpected CDN response")
                image = response.read(3_000_001)
                if not 0 < len(image) <= 3_000_000:
                    raise ValueError("Unexpected preview size")
        except (URLError, ValueError, TimeoutError, OSError):
            return self.respond({"error": "preview"}, status=502)
        return self.respond(image, content_type, max_age=86400)

    def do_GET(self):
        if not self.allowed_host():
            return self.respond({"error": "host"}, status=403)
        url = urlsplit(self.path)
        if url.path.startswith("/preview/"):
            return self.get_preview(url.path)
        if url.path in FILES:
            name, media_type = FILES[url.path]
            return self.respond((HERE / name).read_bytes(), media_type)
        if url.path == "/api/catalog":
            return self.respond(self.server.catalog)
        if url.path == "/api/decisions":
            with closing(connect()) as db:
                rows = db.execute("SELECT artist, state FROM decisions ORDER BY updated, artist").fetchall()
            return self.respond({"decisions": rows})
        if url.path == "/api/posts":
            query = parse_qs(url.query)
            artist = query.get("artist", [""])[0]
            sort = query.get("sort", ["recent"])[0]
            page = query.get("page", ["1"])[0]
            if artist not in self.server.names or sort not in ("recent", "score") or not (
                page.isascii() and page.isdecimal() and len(page) <= 3 and 1 <= int(page) <= 500
            ):
                return self.respond({"error": "query"}, status=400)
            try:
                return self.respond(self.server.local_previews(read_posts(artist, sort, int(page))))
            except HTTPError as error:
                return self.respond({"error": "upstream", "status": error.code}, status=502)
            except (URLError, ValueError, TimeoutError, OSError):
                return self.respond({"error": "upstream"}, status=502)
        return self.respond({"error": "not_found"}, status=404)

    def do_POST(self):
        if not self.allowed_host() or self.headers.get("Origin") != self.server.origin:
            return self.respond({"error": "origin"}, status=403)
        if self.path != "/api/decisions":
            return self.respond({"error": "not_found"}, status=404)
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size < 2048:
                raise ValueError("request size")
            payload = json.loads(self.rfile.read(size))
            artist, state = payload["artist"], payload["state"]
            if artist not in self.server.names or state not in STATES:
                raise ValueError("invalid decision")
        except (ValueError, KeyError, TypeError):
            return self.respond({"error": "decision"}, status=400)
        with closing(connect()) as db:
            if state == "none":
                db.execute("DELETE FROM decisions WHERE artist=?", (artist,))
            else:
                db.execute("INSERT OR REPLACE INTO decisions VALUES (?, ?, ?)", (artist, state, time.time()))
        return self.respond({"saved": True})

    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18769)
    parser.add_argument("--open", action="store_true", help="Open the ready page in the default browser")
    parser.add_argument("--refresh-catalog", action="store_true")
    options = parser.parse_args()
    if options.refresh_catalog or not ((DATA / "catalog.json").is_file() or
                                       (ROOT / "output/danbooru-artists-170plus-20261113/artists-170plus.json").is_file()):
        refresh_roster()
    roster = read_roster()
    roster["generated"] = sorted(generated_names())
    initialize()
    with PickerServer(options.port, roster) as server:
        print(f"Local: {server.origin}/", flush=True)
        if options.open:
            webbrowser.open(server.origin + "/")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
