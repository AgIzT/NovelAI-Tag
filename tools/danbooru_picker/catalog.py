"""Read and refresh the local Danbooru artist roster."""
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "tools/data/danbooru_picker"
CATALOG = DATA / "catalog.json"
FALLBACK = ROOT / "output/danbooru-artists-170plus-20261113/artists-170plus.json"
ORIGIN = "https://danbooru.donmai.us"
MIN_POSTS = 30


def api(path, params):
    request = Request(
        f"{ORIGIN}/{path}?{urlencode(params)}",
        headers={"Accept": "application/json", "User-Agent": "NovelAITagAtlasArtistPicker/1.0"},
    )
    with urlopen(request, timeout=12) as response:
        if response.url.split("/", 3)[:3] != ["https:", "", "danbooru.donmai.us"]:
            raise ValueError("Unexpected Danbooru API origin")
        data = json.loads(response.read(4_000_000))
    if not isinstance(data, list):
        raise ValueError("Danbooru returned an unexpected response")
    return data


def read_roster():
    if CATALOG.is_file():
        return json.loads(CATALOG.read_text(encoding="utf-8"))
    fallback = json.loads(FALLBACK.read_text(encoding="utf-8"))
    return {
        "snapshot": fallback["completed_at"],
        "minimum": 170,
        "artists": [[a["artist"], a["post_count"], a["tag_id"]] for a in fallback["artists"]],
    }


def refresh_roster():
    rows = []
    seen = set()
    cursor = None
    for page in range(1, 251):
        params = {
            "search[category]": 1,
            "search[post_count]": f">={MIN_POSTS}",
            "search[order]": "date",
            "search[hide_deprecated]": "true",
            "only": "id,name,category,post_count,is_deprecated",
            "limit": 1000,
        }
        if cursor is not None:
            params["search[id]"] = f"<{cursor}"
        tags = api("tags.json", params)
        if not tags:
            break
        for tag in tags:
            tag_id = tag["id"]
            if cursor is not None and tag_id >= cursor:
                raise ValueError("Artist tag cursor did not advance")
            if tag["category"] != 1 or tag["post_count"] < MIN_POSTS or tag["name"] in seen:
                raise ValueError("Unexpected artist tag in catalogue response")
            cursor = tag_id
            seen.add(tag["name"])
            if not tag["is_deprecated"]:
                rows.append([tag["name"], tag["post_count"], tag_id])
        print(f"Page {page}: {len(rows):,} artist tags", flush=True)
        time.sleep(0.55)
    else:
        raise ValueError("Artist catalogue did not reach the last page")
    if not rows:
        raise ValueError("Empty artist catalogue")
    DATA.mkdir(parents=True, exist_ok=True)
    temporary = CATALOG.with_name(f"catalog-{os.getpid()}.tmp")
    snapshot = datetime.now(timezone.utc).isoformat(timespec="seconds")
    temporary.write_text(json.dumps({"snapshot": snapshot, "minimum": MIN_POSTS, "artists": rows},
                                    ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(CATALOG)
    print(f"Saved {len(rows):,} artist tags", flush=True)


if __name__ == "__main__":
    refresh_roster()
