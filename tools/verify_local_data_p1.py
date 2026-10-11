"""Independent local-only Chrome checks for the seven reviewed P1 failures.

--source baseline serves immutable Git bytes from 10704e1; fixed serves this
worktree. Identical scenarios test safety in both runs. No site data is served
or edited. Browser profiles and evidence are isolated under --out-dir.
"""
import argparse
import hashlib
import json
import mimetypes
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from verify_ui import CDP, find_free_port, start_chrome, page_ws_url, wait_for

BASELINE = "10704e1c24c00922ccb59b793a5ea166ff0f675d"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", choices=("baseline", "fixed"), default="fixed")
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()
    out = (ROOT / args.out_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    asset_cache = {}

    def asset(path):
        if args.source == "fixed":
            return (ROOT / path).read_bytes()
        if path not in asset_cache:
            asset_cache[path] = subprocess.check_output(["git", "show", BASELINE + ":" + path], cwd=ROOT, stderr=subprocess.DEVNULL)
        return asset_cache[path]

    index = asset("site/index.html").decode("utf-8")
    start = index.index('<aside id="tagRelayRail"')
    end = index.index("</aside>", start) + len("</aside>")
    aside = index[start:end].replace('class="tag-relay-rail closed"', 'class="tag-relay-rail"')
    html = ("<!doctype html><meta charset=utf-8><title>Independent local data P1</title>"
            "<style>textarea{width:600px;height:65px}[hidden]{display:none!important}</style>"
            '<div id="toast" role="status"></div><div id="communityGrid"></div>' + aside + """
<script type=module>
window.fav=await import('/assets/community/favorites.js');
window.block=await import('/assets/app/content-blocking.js');
window.backupUi=await import('/assets/app/favorites-backup.js');
window.libraryCore=await import('/assets/app/favorites-library-core.js');
window.libraryStore=await import('/assets/app/favorites-library-store.js');
window.backupStore=await import('/assets/app/favorites-backup-store.js');
window.communityState=await import('/assets/community/state.js');
window.communityUi=await import('/assets/community/ui.js');
window.relayModel=await import('/assets/app/tag-relay-v4.js');
window.relayStore=await import('/assets/app/tag-relay-store.js');
window.compose=await import('/assets/app/tag-relay-compose.js');
backupUi.subscribeFavoritesChanges('community',()=>fav.reloadFavorites());
window.addEventListener('storage',block.receiveBlockingStorage);
window.ready=true;
</script>""").encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = urllib.parse.urlparse(self.path).path
            if path == "/harness":
                data, typ = html, "text/html; charset=utf-8"
            elif path.startswith("/assets/") and ".." not in path.split("/"):
                try:
                    data = asset("site/" + path.lstrip("/"))
                except (OSError, subprocess.CalledProcessError):
                    self.send_error(404)
                    return
                typ = "text/javascript" if path.endswith(".js") else mimetypes.guess_type(path)[0] or "application/octet-stream"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", typ)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/harness"
    browser_dir = out / "browser"
    browser_dir.mkdir(exist_ok=True)
    chrome_port = find_free_port()
    chrome = start_chrome(browser_dir, chrome_port)
    clients = []
    evidence = {"source": args.source, "baseline": BASELINE, "url": url, "checks": []}

    def fresh(cdp):
        cdp.eval("window.ready=false;window.previousDocument=true;true")
        cdp.command("Page.navigate", {"url": url + "?run=" + str(time.time_ns())})
        wait_for(cdp, "window.ready===true&&!window.previousDocument", "fresh production modules")

    def record(name, data, safe):
        item = {"name": name, "safe": bool(safe), "evidence": data}
        evidence["checks"].append(item)
        (out / "results.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        print(name + ": " + ("PASS" if safe else "FAIL"), flush=True)

    try:
        first = CDP(page_ws_url(chrome_port))
        clients.append(first)
        first.command("Page.enable")
        fresh(first)
        target = first.command("Target.createTarget", {"url": url, "newWindow": True})["targetId"]
        with urllib.request.urlopen(f"http://127.0.0.1:{chrome_port}/json/list") as response:
            pages = json.load(response)
        second = CDP(next(p["webSocketDebuggerUrl"] for p in pages if p["id"] == target))
        clients.append(second)
        second.command("Page.enable")
        wait_for(second, "window.ready===true", "second independent renderer")
        evidence["pageTargets"] = [p["id"] for p in pages if p.get("type") == "page"]
        evidence["platform"] = first.eval("({userAgent:navigator.userAgent,webLocks:typeof navigator.locks?.request==='function',lockQuery:typeof navigator.locks?.query==='function'})")
        with urllib.request.urlopen(f"http://127.0.0.1:{chrome_port}/json/version") as response:
            browser_info = json.load(response)
        browser_client = CDP(browser_info["webSocketDebuggerUrl"])
        try:
            evidence["rendererProcesses"] = [p for p in browser_client.command("SystemInfo.getProcessInfo")["processInfo"] if p["type"] == "renderer"]
        finally:
            browser_client.close()

        result = first.eval("""(async()=>{
          const key='community-favorites-v1';localStorage.setItem(key,'["existing"]');fav.reloadFavorites();
          const write=Storage.prototype.setItem;let returned,shown,disk;
          Storage.prototype.setItem=function(k,v){if(k===key)throw new DOMException('test quota','QuotaExceededError');return write.call(this,k,v)};
          try{returned=await fav.toggleFavorite({id:'quota-new'});shown=fav.isFavorite({id:'quota-new'});disk=JSON.parse(localStorage.getItem(key))}
          finally{Storage.prototype.setItem=write}
          fav.reloadFavorites();return{returned,shown,disk,afterReload:fav.isFavorite({id:'quota-new'})};
        })()""")
        record("1.4-community-write-failure", result,
               isinstance(result["returned"], dict) and not result["returned"].get("ok")
               and not result["shown"] and result["disk"] == ["existing"] and not result["afterReload"])

        result = first.eval("""(()=>{
          const key='community-favorites-v1';localStorage.setItem(key,'["existing"]');fav.reloadFavorites();
          Object.assign(communityState.state,{entries:[{id:'ui-quota',title:'Test',images:[],prompt:'test',category:[],tags:[],nsfw:false}],loading:false,onlyFavorites:false});
          communityUi.applyCommunityFilters();document.querySelector('#toast').textContent='';
          window.originalWrite=Storage.prototype.setItem;
          Storage.prototype.setItem=function(k,v){if(k===key)throw new DOMException('test quota','QuotaExceededError');return originalWrite.call(this,k,v)};
          document.querySelector('.card-fav-btn').click();return true;
        })()""")
        time.sleep(.3)
        result = first.eval("""(()=>{Storage.prototype.setItem=originalWrite;return{toast:document.querySelector('#toast').textContent,pressed:document.querySelector('.card-fav-btn').getAttribute('aria-pressed'),disk:JSON.parse(localStorage.getItem('community-favorites-v1'))}})()""")
        record("1.4-community-ui-feedback", result, result["pressed"] == "false" and result["disk"] == ["existing"] and result["toast"] not in ("已收藏", "已取消收藏", ""))

        def race(name, key, seed, reset, action):
            first.eval(f"localStorage.setItem({json.dumps(key)},{json.dumps(json.dumps(seed))})")
            time.sleep(.15)
            for client in clients:
                client.eval(reset)
            second._send_command("Runtime.evaluate", {"expression":
                "window.raceStarted=Date.now();while(Date.now()<raceStarted+850){};"
                "window.raceDone=false;Promise.resolve(" + action.replace("__ID__", '"B"') + ")"
                ".then(result=>{window.raceResult=result;window.raceEnded=Date.now();window.raceDone=true});true", "returnByValue": True})
            time.sleep(.15)
            first.eval("(async()=>{window.raceStarted=Date.now();window.raceResult=await (" + action.replace("__ID__", '"A"') + ");window.raceEnded=Date.now();return true})()")
            wait_for(second, "window.raceDone", "B async mutation completes")
            time.sleep(.12)
            data = {"tabs": [c.eval("({started:raceStarted,ended:raceEnded,result:raceResult})") for c in clients],
                    "disk": first.eval(f"JSON.parse(localStorage.getItem({json.dumps(key)}))")}
            disk_items = data["disk"] if isinstance(data["disk"], list) else data["disk"]["words"]
            added = ("A", "B") if isinstance(data["disk"], list) else ("a", "b")
            safe = "existing" in disk_items and all(item in disk_items for item in added)
            record(name, data, safe)

        race("1.3-community-two-renderers", "community-favorites-v1", ["existing"], "fav.reloadFavorites()", "fav.toggleFavorite({id:__ID__})")
        race("1.5-blocking-two-renderers", "fadian-content-blocking-v1", {"version": 1, "enabled": True, "words": ["existing"], "entries": []}, "block.loadContentBlocking()", "block.addBlockedWords(__ID__)")

        result = first.eval("""(async()=>{
          const key='fadian-content-blocking-v1';const old={version:1,enabled:false,words:['old-word'],entries:[{key:'book:entry-old',codexId:'book',title:'old card'}]};
          localStorage.setItem(key,JSON.stringify(old));block.loadContentBlocking();const read=Storage.prototype.getItem;
          Storage.prototype.getItem=function(k){if(k===key)throw new DOMException('test unavailable','SecurityError');return read.call(this,k)};
          try{block.loadContentBlocking()}finally{Storage.prototype.getItem=read}
          const afterReadFailure=block.getBlockingPreferences();const result=await block.addBlockedWords('new-word');
          return{old,afterReadFailure,result,disk:JSON.parse(localStorage.getItem(key))};
        })()""")
        record("1.6-blocking-read-recovery", result, result["result"].get("ok") and result["afterReadFailure"]["words"] == ["old-word"]
               and result["disk"]["words"] == ["old-word", "new-word"] and not result["disk"]["enabled"]
               and len(result["disk"]["entries"]) == 1 and all(result["disk"]["entries"][0][key] == value for key, value in result["old"]["entries"][0].items()))
        result = first.eval("""(async()=>{
          const key='community-favorites-v1';localStorage.setItem(key,'["old-one","old-two"]');fav.reloadFavorites();const read=Storage.prototype.getItem;
          Storage.prototype.getItem=function(k){if(k===key)throw new DOMException('test unavailable','SecurityError');return read.call(this,k)};
          try{fav.reloadFavorites()}finally{Storage.prototype.getItem=read}
          const keptMemory=fav.isFavorite({id:'old-one'})&&fav.isFavorite({id:'old-two'});const result=await fav.toggleFavorite({id:'new-one'});
          return{keptMemory,result,disk:JSON.parse(localStorage.getItem(key))};
        })()""")
        record("1.6-community-read-recovery", result, result["keptMemory"] and result["disk"] == ["old-one", "old-two", "new-one"])
        result = first.eval("""(async()=>{
          const bkey='fadian-content-blocking-v1',ckey='community-favorites-v1';const cases=[];
          for(const [key,raw] of [[bkey,'{oops'],[bkey,JSON.stringify({version:2,words:['future'],entries:[]})],[ckey,'{oops'],[ckey,JSON.stringify({version:2,ids:['future']})]]){
            localStorage.setItem(key,raw);const result=key===bkey?await block.addBlockedWords('new-word'):await fav.toggleFavorite({id:'new-one'});
            cases.push({key,raw,result,after:localStorage.getItem(key)});
          }return cases;
        })()""")
        record("1.6-corrupt-and-future-refuse-write", result, all(isinstance(r["result"], dict) and not r["result"].get("ok") and r["raw"] == r["after"] for r in result))

        result = first.eval(r"""(async()=>{
          const codexes=[{id:'book',entryAliases:{'old-one':'merged','old-two':'merged'}}];
          const notes=['first distinct note\n  原文 A  ','second distinct note\n\n原文 B\u0001'];
          const before={format:'novelai-tag-favorites-library',version:2,libraryId:'notes',presetsSeeded:1,migratedFrom:'v1',updatedAt:'2026-10-10T00:00:00.000Z',folders:[],memberships:[],items:[{key:'book:old-one',note:notes[0]},{key:'book:old-two',note:notes[1]}]};
          localStorage.setItem('fadian-favs-v2',JSON.stringify(before));
          const store=libraryStore.createLibraryStore({getCodexes:()=>codexes,notify:()=>{}});await store.ensureLibrary();
          const diskAfterLoad=JSON.parse(localStorage.getItem('fadian-favs-v2'));const result=await store.commitLibrary(lib=>libraryCore.createFolder(lib,'ordinary new folder'));
          const disk=JSON.parse(localStorage.getItem('fadian-favs-v2'));const serialized=backupStore.serializeLibraryFavorites({library:store.librarySnapshot(),communityIds:[],codexes});
          const parsed=libraryCore.parseLibraryBackup(serialized,codexes);const restarted=libraryStore.createLibraryStore({getCodexes:()=>codexes,notify:()=>{}});await restarted.ensureLibrary();
          const repeated=libraryCore.createLibraryRestorePlan({backup:parsed,currentLibrary:restarted.librarySnapshot(),codexes}).nextLibrary;
          return{notes,before,diskAfterLoad,result,disk,exported:JSON.parse(serialized),restarted:restarted.librarySnapshot(),repeated};
        })()""")
        parts = result["disk"]["items"][0].get("noteParts")
        record("1.7-note-alias-commit-restart-backup", result, result["before"] == result["diskAfterLoad"] and result["result"].get("ok") and len(result["disk"]["items"]) == 1
               and parts == result["notes"] and result["restarted"]["items"][0].get("noteParts") == parts and result["repeated"]["items"][0].get("noteParts") == parts
               and result["exported"]["favorites"]["atlas"][0].get("noteParts") == parts)

        # Fresh documents avoid previous scene state and release their fences.
        first.eval("localStorage.clear();true")
        for c in clients:
            fresh(c)
        first.eval("""(async()=>{const s=relayModel.normalizeRelayState(null);const p=relayModel.getActivePlan(s);relayModel.replacePlanText(s,p.id,{positive:{text:'base',folds:{}},negative:{text:'',folds:{}}},{expectedRevision:p.revision});localStorage.setItem(relayModel.TAG_RELAY_STORAGE_KEY,JSON.stringify(s));await relayStore.setupRelayStore();window.composeHandle=compose.setupRelayCompose(document.querySelector('#tagRelayPaneCompose'));await composeHandle.ready;return true})()""")
        first.eval("(()=>{const input=document.querySelector('#relayEditorSurface-positive textarea');input.focus();input.setSelectionRange(input.value.length,input.value.length);return true})()")
        first.command("Input.insertText", {"text": " local-first"})
        first.eval("""(()=>{const key=relayModel.TAG_RELAY_STORAGE_KEY;const s=JSON.parse(localStorage.getItem(key));const p=relayModel.getActivePlan(s);relayModel.replacePlanText(s,p.id,{positive:{text:'other-tab',folds:{}},negative:{text:'',folds:{}}},{expectedRevision:p.revision});localStorage.setItem(key,JSON.stringify(s));return true})()""")
        wait_for(first, "[...document.querySelectorAll('.relay-save-state button')].some(b=>b.textContent==='另存副本')", "revision conflict action")
        second.eval("window.lockReady=false;window.releaseLock=null;navigator.locks.request('fadian-tag-relay-v4:lock',async()=>{window.lockReady=true;await new Promise(r=>window.releaseLock=r)});true")
        wait_for(second, "lockReady", "other renderer holds Web Lock")
        first.eval("window.copyDone=false;[...document.querySelectorAll('.relay-save-state button')].find(b=>b.textContent==='另存副本').onclick().then(()=>copyDone=true);true")
        first.eval("(()=>{const input=document.querySelector('#relayEditorSurface-positive textarea');input.focus();input.setSelectionRange(input.value.length,input.value.length);return true})()")
        first.command("Input.insertText", {"text": " NEW-TAIL"})
        before = first.eval("({screen:document.querySelector('#relayEditorSurface-positive textarea').value,disk:JSON.parse(localStorage.getItem(relayModel.TAG_RELAY_STORAGE_KEY))})")
        second.eval("releaseLock();true")
        wait_for(first, "copyDone", "copy returns")
        time.sleep(.35)
        after = first.eval("({screen:document.querySelector('#relayEditorSurface-positive textarea').value,disk:JSON.parse(localStorage.getItem(relayModel.TAG_RELAY_STORAGE_KEY)),saveState:document.querySelector('.relay-save-state').textContent,hidden:document.querySelector('.relay-save-state').hidden})")
        tail_saved = any("NEW-TAIL" in p["positive"]["text"] for p in after["disk"]["plans"])
        retained = "NEW-TAIL" in after["screen"] and not after["hidden"] and ("保留" in after["saveState"] or "尚未保存" in after["saveState"])
        record("1.2-copy-during-real-typing", {"beforeRelease": before, "afterRelease": after}, "NEW-TAIL" in before["screen"] and (tail_saved or retained))
        if retained:
            first.eval("window.copyAgain=false;[...document.querySelectorAll('.relay-save-state button')].find(b=>b.textContent==='另存副本').onclick().then(()=>copyAgain=true);true")
            wait_for(first, "copyAgain", "retained draft copied a second time")
            second_copy = first.eval("({screen:document.querySelector('#relayEditorSurface-positive textarea').value,disk:JSON.parse(localStorage.getItem(relayModel.TAG_RELAY_STORAGE_KEY))})")
            record("1.2-retained-tail-can-save", second_copy, any("NEW-TAIL" in p["positive"]["text"] for p in second_copy["disk"]["plans"]))

        first.eval("localStorage.clear();true")
        for c in clients:
            fresh(c)
        first.eval("localStorage.setItem(relayModel.TAG_RELAY_STORAGE_KEY,JSON.stringify(relayModel.normalizeRelayState(null)));true")
        time.sleep(.1)
        for c in clients:
            c.eval("relayStore.setupRelayStore()")
        rounds, expected, all_ok = [], set(), True
        for n in range(30):
            for label, c in zip(("A", "B"), clients):
                name = f"race-{n}-{label}"
                expected.add(name)
                c._send_command("Runtime.evaluate", {"expression":
                    "window.concurrentCommit=relayStore.commitRelay(next=>{const p=relayModel.createPlan(next," + json.dumps(name) + ");return relayModel.replacePlanText(next,p.id,{positive:{text:" + json.dumps("user-prompt-" + name) + ",folds:{}},negative:{text:'',folds:{}}},{expectedRevision:p.revision})},{changed:'plan'});true", "returnByValue": True})
            results = [c.eval("concurrentCommit") for c in clients]
            all_ok = all_ok and all(r.get("ok") for r in results)
            time.sleep(.025)
            disk = first.eval("JSON.parse(localStorage.getItem(relayModel.TAG_RELAY_STORAGE_KEY))")
            names = {p["name"] for p in disk["plans"]}
            missing = sorted(expected - names)
            wrong_text = [p["name"] for p in disk["plans"] if p["name"] in expected and p["positive"]["text"] != "user-prompt-" + p["name"]]
            rounds.append({"round": n, "results": results, "expected": len(expected), "missing": missing, "wrongText": wrong_text})
            if missing or wrong_text or not all_ok:
                break
        other_disk = second.eval("JSON.parse(localStorage.getItem(relayModel.TAG_RELAY_STORAGE_KEY))")
        fresh(first)
        reload_disk = first.eval("JSON.parse(localStorage.getItem(relayModel.TAG_RELAY_STORAGE_KEY))")
        record("1.1-relay-two-renderers", {"rounds": rounds, "disk": disk, "otherTabDisk": other_disk, "afterNavigationDisk": reload_disk},
               all_ok and not rounds[-1]["missing"] and not rounds[-1]["wrongText"] and all(expected <= {p["name"] for p in value["plans"]} for value in (disk, other_disk, reload_disk)))
    except Exception as exc:
        evidence["fatal"] = repr(exc)
        print("FATAL: " + repr(exc), flush=True)
    finally:
        try:
            if clients:
                clients[0].command("Browser.close")
        except Exception:
            pass
        for client in clients:
            try:
                client.close()
            except Exception:
                pass
        try:
            chrome.wait(timeout=8)
        except Exception:
            chrome.terminate()
            chrome.wait(timeout=5)
        server.shutdown()
        server.server_close()
        evidence["cleanup"] = {"chromePid": chrome.pid, "exitCode": chrome.poll(), "httpPort": server.server_port, "cdpPort": chrome_port, "serverStopped": True}
        paths = ["site/assets/app/storage-coordinator.js", "site/assets/app/favorites-library-core.js", "site/assets/app/favorites-library-store.js", "site/assets/app/content-blocking.js", "site/assets/app/content-blocking-ui.js", "site/assets/app/tag-relay-store.js", "site/assets/app/tag-relay-compose.js", "site/assets/community/favorites.js", "site/assets/community/ui.js"]
        evidence["sourceSha256"] = {}
        for path in paths:
            try:
                evidence["sourceSha256"][path] = hashlib.sha256(asset(path)).hexdigest()
            except (OSError, subprocess.CalledProcessError):
                evidence["sourceSha256"][path] = None
        evidence["safe"] = "fatal" not in evidence and all(c["safe"] for c in evidence["checks"])
        (out / "results.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if evidence["safe"] else 1


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    raise SystemExit(main())
