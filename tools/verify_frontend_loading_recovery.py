"""Loopback-only real Chromium checks for AUD-003/AUD-011.

Serve actual JS modules plus synthetic JSON (never site/data). Own isolated
profile; dead proxy and resolver rules prevent external traffic, CSP restricts
page requests to self. --source before uses the task's frozen source bytes.
"""
import argparse
import hashlib
import json
import stat
import subprocess
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from verify_ui import CDP, find_chrome, find_free_port, page_ws_url, wait_for

ROOT = Path(__file__).resolve().parents[1]
BEFORE = ROOT / "output/audit-remaining-20261018/before"


def asset_source(root, request_path):
    """Allow ordinary files inside site/assets, never Windows path aliases or links."""
    if not request_path.startswith("/assets/") or any(char in request_path for char in ("\\", "%", ":", "\0")):
        return None
    parts = request_path.lstrip("/").split("/")
    if any(part in ("", ".", "..") or part.rstrip(" .") != part for part in parts):
        return None
    source = Path(root)
    try:
        for part in (None, "site", *parts):
            if part is not None:
                source /= part
            info = source.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                return None
        if not source.resolve().is_relative_to((Path(root) / "site/assets").resolve()) or not source.is_file():
            return None
    except (OSError, ValueError):
        return None
    return source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", choices=("before", "fixed"), default="fixed")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--only-relay", action="store_true", help="Focused real compose caller recovery checks")
    args = parser.parse_args()
    out = (ROOT / args.out_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    profile = out / "chrome-profile"
    profile.mkdir(exist_ok=True)
    stop = threading.Event()
    shard_release = threading.Event()
    controls = {"tag_ok": False, "slow_ok": False, "full_app": False,
                "relay": False, "relay_shard_ok": False, "tag_missing": False, "tag_empty": False}
    requests = []
    hashes = {}
    html = b"""<!doctype html><meta charset=utf-8><title>Loading recovery fixture</title>
<h1>Loading recovery</h1><button id=tag>Load translations</button><pre id=prompt>cat</pre>
<button id=search>Search all books</button><p id=status>Idle</p><ul id=results></ul>
<script type=module>
window.tag=await import('/assets/app/tag-zh.js');
window.search=await import('/assets/app/site-search.js');
window.data=await import('/assets/app/data.js');
window.state=(await import('/assets/app/state.js')).state;
state.codexes=[{id:'ok',entryCount:1},{id:'slow',entryCount:1},{id:'locked',nsfw:true,entryCount:1}];
document.querySelector('#tag').onclick=async()=>{
 const shards=await tag.loadTagZh('');
 tag.renderTagZhPrompt(document.querySelector('#prompt'),'cat',{shards});window.tagDone=true;
};
document.querySelector('#search').onclick=async()=>{
 document.querySelector('#status').textContent='Loading';
 const result=await search.buildSiteSearchCodex();window.searchResult=result;
 document.querySelector('#status').textContent=result.dataNotice||'Complete';
 document.querySelector('#results').replaceChildren(...result.entries.map(entry=>{
   const li=document.createElement('li');li.textContent=entry.id;return li;
 }));
};
window.ready=true;
</script>"""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            request_path = parsed.path
            requests.append(request_path)
            status = 200
            content_type = "application/json"
            if request_path == "/harness":
                payload, content_type = html, "text/html; charset=utf-8"
            elif request_path == "/control":
                controls.update({key: value[-1] == "1" for key, value in urllib.parse.parse_qs(parsed.query).items() if key in controls})
                payload = b"{}"
            elif request_path == "/full-app":
                controls["full_app"] = True
                payload = (ROOT / "site/index.html").read_bytes()
                # Keep the real DOM and module entry, but remove remote font requests.
                import re
                payload = re.sub(rb'<link\b[^>]*https://[^>]*>', b'', payload)
                content_type = "text/html; charset=utf-8"
            elif request_path == "/data/codexes.json":
                payload = json.dumps([{"id": "ok", "title": "Fixture OK", "entryCount": 1},
                                      {"id": "slow", "title": "Fixture Slow", "entryCount": 1}]).encode()
            elif request_path == "/data/media.json":
                payload = b"{}"
            elif request_path == "/data/about.json":
                payload = b'{"links":[],"tips":[],"credits":[]}'
            elif request_path == "/data/updates.json":
                payload = b"[]"
            elif request_path == "/data/tag_zh/core.json":
                status = 404 if controls["tag_missing"] else (200 if controls["tag_ok"] else 503)
                payload = json.dumps({"schema": 1, "m": {} if controls["full_app"] else {"cat": "\u732b"},
                                      "shards": ["ok"] if controls["full_app"] and not controls["tag_empty"] else []}).encode()
            elif request_path == "/data/tag_zh/ok.json":
                if controls["relay"]:
                    status = 200 if controls["relay_shard_ok"] else 503
                else:
                    shard_release.wait(45)
                payload = json.dumps({"schema": 1, "m": {"cat": "\u732b"}}).encode()
            elif request_path in ("/data/ok.json", "/data/slow.json"):
                if request_path.endswith("slow.json") and not controls["slow_ok"]:
                    # Keep HTTP headers unreturned until teardown: a real unresolved fetch.
                    stop.wait(45)
                    return
                book_id = request_path.rsplit("/", 1)[1][:-5]
                payload = json.dumps({"id": book_id, "entries": [{"id": book_id + "-entry", "title": book_id, "tags": "cat"}]}).encode()
            elif request_path.startswith("/assets/"):
                relative = "site/" + request_path.lstrip("/")
                source = asset_source(BEFORE, request_path) if args.source == "before" else None
                if source is None:
                    source = asset_source(ROOT, request_path)
                if source is None:
                    self.send_error(404)
                    return
                try:
                    payload = source.read_bytes()
                except OSError:
                    self.send_error(404)
                    return
                hashes[relative] = hashlib.sha256(payload).hexdigest()
                content_type = "text/css" if request_path.endswith(".css") else "text/javascript"
            else:
                self.send_error(404)
                return
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/harness"
    port = find_free_port()
    command = [find_chrome(), "--headless=new", "--disable-gpu", "--no-first-run",
               "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
               "--disable-sync", "--metrics-recording-only", "--disable-default-apps",
               "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=127.0.0.1;localhost",
               "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
               f"--remote-debugging-port={port}", f"--user-data-dir={profile}", "--window-size=1280,720", "about:blank"]
    chrome_log = (out / "chrome.log").open("wb")
    chrome = subprocess.Popen(command, stdout=chrome_log, stderr=chrome_log,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    cdp = None
    evidence = {"source": args.source, "url": url, "checks": [], "scope": "synthetic loopback page using actual modules; no production or user profile"}

    def record(name, value, passed):
        evidence["checks"].append({"name": name, "status": "PASS" if passed else "FAIL", "observed": value})
        print(name + ": " + ("PASS" if passed else "FAIL"), flush=True)

    try:
        cdp = CDP(page_ws_url(port))
        cdp.command("Network.enable")
        cdp.command("Page.enable")
        if args.only_relay:
            for scenario in ["core503", "shard503", "missing404", "empty"]:
                controls.update(relay=True, slow_ok=True, tag_ok=scenario != "core503",
                                relay_shard_ok=scenario != "shard503", tag_missing=scenario == "missing404",
                                tag_empty=scenario == "empty")
                start = len(requests)
                cdp.command("Page.navigate", {"url": url.replace("/harness", "/full-app") + "?relay=" + scenario})
                wait_for(cdp, "document.querySelector('#codexTitle')?.textContent==='Fixture OK' && Boolean(document.querySelector('#relayEditorSurface-positive textarea'))", "actual relay bootstrap")
                cdp.eval("""(async()=>{
                  window.compose=await import('/assets/app/tag-relay-compose.js');window.rail=await import('/assets/app/tag-relay-rail.js');
                  window.liveTag=await import('/assets/app/tag-zh.js');window.appState=(await import('/assets/app/state.js')).state;
                  const snap=await import('/assets/app/tag-relay-snapshot.js');
                  await compose.setupRelayCompose(document.querySelector('#tagRelayPaneCompose')).ready;
                  rail.openRelayRail();window.fixtureSource=snap.snapshotFragment(appState.codex.entries[0],{text:'cat',channel:'positive'});
                  await compose.addSourceToPlan(fixtureSource,{focus:false});
                  const input=document.querySelector('#relayEditorSurface-positive textarea');input.value='cat';
                  input.dispatchEvent(new Event('input',{bubbles:true}));await compose.flushCompose();return true;
                })()""")
                time.sleep(.2)
                before = cdp.eval("({complete:liveTag.isTagZhComplete('ok'),zh:[...document.querySelectorAll('#relayEditorSurface-positive .zh')].map(n=>n.textContent)})")
                time.sleep(1.1)
                controls.update(tag_ok=True, relay_shard_ok=True)
                cdp.eval("rail.closeRelayRail();rail.openRelayRail();true")
                time.sleep(.3)
                after = cdp.eval("({complete:liveTag.isTagZhComplete('ok'),zh:[...document.querySelectorAll('#relayEditorSurface-positive .zh')].map(n=>n.textContent)})")
                if scenario in ("core503", "shard503"):
                    record("AUD-003 real relay reopens after " + scenario, {"before": before, "after": after},
                           not before["complete"] and after["complete"] and "\u732b" in after["zh"])
                else:
                    record("AUD-003 real relay terminal " + scenario, {"before": before, "after": after},
                           before["complete"] and after["complete"] and not after["zh"])
                requests_before = sum(path.startswith("/data/tag_zh/") for path in requests[start:])
                cdp.eval("for(let i=0;i<25;i++){rail.closeRelayRail();rail.openRelayRail()}true")
                time.sleep(.2)
                cdp.eval("window.relayMutations=0;window.relayObserver=new MutationObserver(records=>{relayMutations+=records.length});relayObserver.observe(document.querySelector('#relayPlanLane'),{subtree:true,childList:true,characterData:true});true")
                time.sleep(.5)
                changes = cdp.eval("relayObserver.disconnect();relayMutations")
                requests_after = sum(path.startswith("/data/tag_zh/") for path in requests[start:])
                record("AUD-003 real relay settles without request/repaint loop " + scenario,
                       {"beforeRequests": requests_before, "afterRequests": requests_after, "idleMutations": changes},
                       requests_before == requests_after and changes == 0)
            evidence["runtime"] = cdp.eval("({userAgent:navigator.userAgent,width:innerWidth,height:innerHeight})")
            network = [event["params"]["request"]["url"] for event in cdp.events if event.get("method") == "Network.requestWillBeSent"]
            record("relay page network is loopback or embedded data", network,
                   all(urllib.parse.urlparse(item).scheme == "data" or urllib.parse.urlparse(item).hostname in ("127.0.0.1", "localhost") for item in network))
            return 0 if all(item["status"] == "PASS" for item in evidence["checks"]) else 1
        cdp.command("Page.navigate", {"url": url})
        wait_for(cdp, "window.ready===true", "real module imports")
        evidence["runtime"] = cdp.eval("({userAgent:navigator.userAgent,width:innerWidth,height:innerHeight})")
        cdp.eval("document.querySelector('#tag').click();true")
        wait_for(cdp, "window.tagDone===true", "initial temporary failure")
        cdp.eval("fetch('/control?tag_ok=1').then(()=>true)")
        time.sleep(1.1)
        cdp.eval("window.tagDone=false;document.querySelector('#tag').click();true")
        wait_for(cdp, "window.tagDone===true", "retry translation")
        value = cdp.eval("({text:document.querySelector('#prompt').textContent,unavailable:tag.isTagZhUnavailable()})")
        record("AUD-003 visible translation recovers", value, "\u732b" in value["text"] and not value["unavailable"])

        cdp.eval("document.querySelector('#search').click();true")
        time.sleep(11)
        value = cdp.eval("({status:document.querySelector('#status').textContent,ids:[...document.querySelectorAll('#results li')].map(n=>n.textContent),slowCached:state.codexCache.has('slow')})")
        record("AUD-011 hung source finishes within 11 seconds", value,
               value["ids"] == ["ok-entry"] and "\u52a0\u8f7d\u5931\u8d25" in value["status"] and not value["slowCached"])
        if value["status"] != "Loading":
            cdp.eval("fetch('/control?slow_ok=1').then(()=>true)")
            cdp.eval("window.searchResult=null;document.querySelector('#search').click();true")
            wait_for(cdp, "window.searchResult?.entryCount===2", "failed source retry")
            value = cdp.eval("({status:document.querySelector('#status').textContent,ids:searchResult.entries.map(e=>e.id)})")
            record("AUD-011 retry recovers without reloading page", value, value["ids"] == ["ok-entry", "slow-entry"] and value["status"] != "Loading")
        else:
            evidence["checks"].append({"name": "AUD-011 retry recovers without reloading page", "status": "BLOCKED", "reason": "initial build remains unresolved"})
        record("locked source never requested", requests, "/data/locked.json" not in requests)

        if args.source == "fixed":
            # Admin requests are fulfilled in memory, with a finally restoring fetch.
            value = cdp.eval("""(async()=>{
              const api=await import('/assets/admin/api.js');const original=window.fetch;const runs=[];
              try {
                let calls=0;window.fetch=async()=>{calls++;return Response.json(calls<3?{indexing:true}:{ok:true,items:[{id:'fixture'}]},{status:calls<3?202:200})};
                const recovered=await api.getFeedback('pending');runs.push({name:'202 recovery',calls,ids:recovered.items.map(x=>x.id)});
                calls=0;window.fetch=async()=>{calls++;return Response.json({indexing:true},{status:202})};
                try{await api.getFeedback('pending');runs.push({name:'202 bound',calls,error:''})}catch(e){runs.push({name:'202 bound',calls,error:e.message})}
                calls=0;const controller=new AbortController();window.fetch=async()=>{calls++;controller.abort();return Response.json({indexing:true},{status:202})};
                try{await api.getFeedback('pending',{signal:controller.signal});runs.push({name:'202 abort',calls,error:''})}catch(e){runs.push({name:'202 abort',calls,error:e.name})}
              } finally { window.fetch=original; }
              return runs;
            })()""")
            record("AUD-004 admin 202 batches recover", value[0], value[0]["calls"] == 3 and value[0]["ids"] == ["fixture"])
            record("AUD-004 admin 202 batches bounded", value[1], value[1]["calls"] == 8 and "\u5237\u65b0\u53cd\u9988" in value[1]["error"])
            record("AUD-004 admin cancellation stops batches", value[2], value[2]["calls"] == 1 and value[2]["error"] == "AbortError")

        if args.source == "fixed":
            controls["slow_ok"] = False
            cdp.command("Page.navigate", {"url": url.replace("/harness", "/full-app")})
            wait_for(cdp, "document.querySelector('#codexTitle')?.textContent==='Fixture OK'", "actual app bootstrap")
            cdp.eval("""(async()=>{window.app=await import('/assets/app.js');window.appState=(await import('/assets/app/state.js')).state;
              appState.query='cat';appState.searchScope='site';window.firstSearch=app.applySearch({transition:'none'});return true})()""")
            time.sleep(11)
            value = cdp.eval("({view:appState.siteSearchView,ids:appState.codex.entries.map(e=>e.id),complete:appState.codex._siteSearchComplete})")
            record("AUD-011 real app renders partial result", value, value["view"] and value["ids"] == ["ok-entry"] and value["complete"] is False)
            controls["slow_ok"] = True
            cdp.eval("appState.query='cat';app.applySearch({transition:'none'}).then(()=>true)")
            value = cdp.eval("({view:appState.siteSearchView,ids:appState.codex.entries.map(e=>e.id),complete:appState.codex._siteSearchComplete})")
            record("AUD-011 actual applySearch recovers existing partial view", value, value["view"] and value["ids"] == ["ok-entry", "slow-entry"] and value["complete"] is True)

            cdp.eval("""(async()=>{window.lightbox=await import('/assets/app/lightbox.js');window.liveTag=await import('/assets/app/tag-zh.js');
              await liveTag.loadTagZh('');lightbox.openLightbox(appState.codex.entries[0],0,null,{allowEmpty:true,recordRecent:false,historyMode:'none'});return true})()""")
            wait_for(cdp, "appState.lightbox?.entry?.id==='ok-entry'", "real lightbox opens")
            deadline = time.monotonic() + 5
            while "/data/tag_zh/ok.json" not in requests and time.monotonic() < deadline:
                time.sleep(.05)
            if "/data/tag_zh/ok.json" not in requests:
                raise RuntimeError("lightbox never requested synthetic shard")
            cdp.eval("lightbox.closeLightbox({immediate:true,historyMode:'none'});true")
            before_close = cdp.eval("document.querySelector('#lightboxTags').textContent")
            shard_release.set()
            wait_for(cdp, "liveTag.isTagZhComplete('ok')", "shard arrives after close")
            value = cdp.eval("({hidden:document.querySelector('#lightbox').hidden,entry:appState.lightbox.entry,text:document.querySelector('#lightboxTags').textContent})")
            record("AUD-003 closing lightbox ignores late translation", value, value["hidden"] and value["entry"] is None and value["text"] == before_close)
            cdp.eval("lightbox.openLightbox(appState.codex.entries[0],0,null,{allowEmpty:true,recordRecent:false,historyMode:'none'});true")
            value = cdp.eval("({text:document.querySelector('#lightboxTags').textContent,hidden:document.querySelector('#lightbox').hidden})")
            record("AUD-003 reopened lightbox uses completed shared shard", value, "\u732b" in value["text"] and not value["hidden"])

        network = [event["params"]["request"]["url"] for event in cdp.events if event.get("method") == "Network.requestWillBeSent"]
        record("all page network requests are loopback or embedded data", network,
               all(urllib.parse.urlparse(item).scheme == "data" or urllib.parse.urlparse(item).hostname in ("127.0.0.1", "localhost") for item in network))
        evidence["assetHashes"] = hashes
        evidence["requests"] = requests
    finally:
        evidence["assetHashes"] = hashes
        evidence["requests"] = requests
        (out / "results.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        if cdp:
            cdp.close()
        chrome.terminate()
        try:
            chrome.wait(timeout=10)
        except subprocess.TimeoutExpired:
            chrome.kill()
            chrome.wait(timeout=5)
        stop.set()
        shard_release.set()
        chrome_log.close()
        server.shutdown()
        server.server_close()
    return 0 if all(item["status"] == "PASS" for item in evidence["checks"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
