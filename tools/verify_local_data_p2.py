"""Independent Chrome red/green checks for reviewed local-data P2 failures.

Baseline serves immutable --baseline Git bytes; fixed serves this worktree.
The same safety assertions exercise original production markup and event
handlers in isolated loopback pages. --preview additionally loads the actual
preview_server app, without opening restricted content or writing remote APIs.
"""
import argparse
import hashlib
import json
import mimetypes
import re
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
from verify_ui import CDP, find_free_port, page_ws_url, start_chrome, wait_for, wait_url

KEYS = ["fadian-density", "fadian-dark-mode", "fadian-dark", "fadian-theme",
        "fadian-font", "fadian-sdmode", "fadian-card-zoom", "fadian-search-scope"]
SEED = dict(zip(KEYS, ["standard", "light", "0", "", "", "0", "0", "site"]))
SETTINGS = [
    ("density", "fadian-density", '[data-density="comfort"]', "comfort"),
    ("dark-mode", "fadian-dark-mode", '[data-dark-mode="dark"]', "dark"),
    ("theme", "fadian-theme", '[data-theme="teal"]', "teal"),
    ("font", "fadian-font", '[data-font="classic"]', "classic"),
    ("sd-mode", "fadian-sdmode", '#sdModeToggle', "1"),
    ("card-zoom", "fadian-card-zoom", '#cardZoomToggle', "1"),
]
SNAPSHOT = """(()=>({
  disk:Object.fromEntries(window.settingKeys.map(k=>[k,window.originalRead.call(localStorage,k)])),
  state:{density:stateModule.state.density,sdMode:stateModule.state.sdMode,cardZoom:stateModule.state.cardZoom,searchScope:stateModule.state.searchScope},
  body:document.body.className.split(' ').filter(c=>/^(density-|theme-|font-|dark$|sd-mode$)/.test(c)).sort(),
  colorScheme:document.documentElement.style.colorScheme,
  controls:[...document.querySelectorAll('[data-density],[data-dark-mode],[data-theme],[data-font],#sdModeToggle,#cardZoomToggle')].map(n=>({key:n.dataset.density??n.dataset.darkMode??n.dataset.theme??n.dataset.font??n.id,pressed:n.getAttribute('aria-pressed'),checked:n.checked})),
  quick:document.querySelector('#densityQuickBtn')?.getAttribute('aria-label'),theme:document.querySelector('#themeBtn')?.getAttribute('aria-label')
}))()"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", choices=("baseline", "fixed"), default="fixed")
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args()
    out = (ROOT / args.out_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    assets = {}

    def asset(path):
        if args.source == "fixed":
            return (ROOT / path).read_bytes()
        if path not in assets:
            assets[path] = subprocess.check_output(["git", "show", args.baseline + ":" + path], cwd=ROOT, stderr=subprocess.DEVNULL)
        return assets[path]

    index = asset("site/index.html").decode("utf-8")
    body = index[index.index("<body"):index.rindex("</body>")]
    body = re.sub(r'<script\b[^>]*>.*?</script>', '', body, flags=re.S)
    html = ("<!doctype html><meta charset=utf-8><title>Independent local data P2</title>"
            "<style>[hidden]{display:none!important}</style>" + body + """
<script>
window.errors=[];
addEventListener('error',e=>errors.push(String(e.message)));
addEventListener('unhandledrejection',e=>errors.push(String(e.reason?.stack||e.reason)));
window.originalRead=Storage.prototype.getItem;
window.originalWrite=Storage.prototype.setItem;
</script>
<script type=module>
window.stateModule=await import('/assets/app/state.js');
window.uiModule=await import('/assets/app/ui.js');
window.backupUi=await import('/assets/app/favorites-backup.js');
window.libraryCore=await import('/assets/app/favorites-library-core.js');
window.libraryStore=await import('/assets/app/favorites-library-store.js');
window.fav=await import('/assets/community/favorites.js');
window.codexes=[{id:'book'}];
stateModule.state.codexes=codexes;
uiModule.applyDensity(localStorage.getItem('fadian-density')||'standard',{render:false});
uiModule.bindUI();
backupUi.setupFavoritesBackup({getCodexes:()=>codexes});
window.ready=true;
</script></body>""").encode("utf-8")

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
    chrome_port = find_free_port()
    chrome = start_chrome(out, chrome_port)
    clients, preview = [], None
    evidence = {"source": args.source, "baseline": args.baseline, "url": url, "checks": []}

    def record(name, data, safe):
        evidence["checks"].append({"name": name, "safe": bool(safe), "evidence": data})
        (out / "results.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        print(name + ": " + ("PASS" if safe else "FAIL"), flush=True)

    def fresh(client, destination=url):
        client.eval("window.previousDocument=true;true")
        client.command("Page.navigate", {"url": destination + ("&" if "?" in destination else "?") + "run=" + str(time.time_ns())})
        wait_for(client, "window.ready===true&&!window.previousDocument", "fresh production handlers")
        client.eval("window.settingKeys=" + json.dumps(KEYS) + ";true")

    def click(client, selector):
        client.eval("document.querySelector(" + json.dumps(selector) + ").click();true")

    def reset_settings():
        first.eval("Storage.prototype.setItem=originalWrite;Storage.prototype.getItem=originalRead;" +
                   "Object.entries(" + json.dumps(SEED) + ").forEach(([k,v])=>localStorage.setItem(k,v));true")
        fresh(first)

    def import_replace():
        first.eval("""(()=>{
          const library=libraryCore.normalizeLibrary({presetsSeeded:1,items:[{key:'book:keep'}]},{codexes});
          const backup=libraryCore.createLibraryBackup({library,communityIds:['community-keep'],codexes});
          const file=new File([JSON.stringify(backup)],'independent.json',{type:'application/json'});
          const input=document.querySelector('#favoritesImportFile');const dt=new DataTransfer();dt.items.add(file);input.files=dt.files;
          document.querySelector('#favoritesBackupPanel').hidden=false;
          input.dispatchEvent(new Event('change',{bubbles:true}));return true;
        })()""")
        wait_for(first, "!document.querySelector('#favoritesImportPreview').hidden", "backup file preview")
        first.eval("""(()=>{const input=document.querySelector('input[name="favoritesRestoreMode"][value="replace"]');input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#favoritesRestoreBtn').click();return true})()""")
        wait_for(first, "!document.querySelector('#favoritesReplaceConfirm').hidden", "original overwrite confirmation")

    def backup_snapshot(client):
        return client.eval("""(()=>({raw:localStorage.getItem('fadian-favs-v2'),communityRaw:localStorage.getItem('community-favorites-v1'),message:document.querySelector('#favoritesReplaceMessage').textContent,error:document.querySelector('#favoritesBackupError').textContent,visible:!document.querySelector('#favoritesReplaceConfirm').hidden,busy:document.querySelector('#favoritesReplaceConfirmBtn').disabled}))()""")

    def backup_case(kind):
        first.eval("""(()=>{localStorage.clear();const library=libraryCore.normalizeLibrary({libraryId:'review-fixture',migratedFrom:'v1',presetsSeeded:1,items:[{key:'book:keep'},{key:'book:old'}]},{codexes});localStorage.setItem('fadian-favs-v2',JSON.stringify(library));localStorage.setItem('community-favorites-v1','["community-keep","community-old"]');return true})()""")
        fresh(first)
        fresh(second)
        import_replace()
        shown = backup_snapshot(first)
        queued = kind == "lock-queue"
        if queued:
            second.eval("window.lockReady=false;window.releaseLock=null;navigator.locks.request('fadian-favs-v2:lock',async()=>{window.lockReady=true;await new Promise(r=>window.releaseLock=r)});true")
            wait_for(second, "lockReady", "other renderer holds real library lock")
            click(first, "#favoritesReplaceConfirmBtn")
            time.sleep(.15)
            second.eval("""(()=>{const library=JSON.parse(localStorage.getItem('fadian-favs-v2'));libraryCore.addLibraryItem(library,'book:queued-new');localStorage.setItem('fadian-favs-v2',JSON.stringify(library));return true})()""")
            modified = backup_snapshot(second)
            second.eval("releaseLock();true")
        else:
            mutate = "libraryCore.addLibraryItem(lib,'book:concurrent-new')"
            if kind == "equal-count-identity":
                mutate = "{libraryCore.removeLibraryItems(lib,['book:old']);return libraryCore.addLibraryItem(lib,'book:replacement-old')}"
            if kind == "retained-note":
                mutate = "{lib.items.find(item=>item.key==='book:keep').note='late original note 原文';return true}"
            if kind == "new-folder":
                mutate = "libraryCore.createFolder(lib,'late personal folder')"
            if kind == "community":
                second.eval("(async()=>{fav.reloadFavorites();return await fav.toggleFavorite({id:'community-concurrent'})})()")
            else:
                second.eval("(async()=>{await libraryStore.ensureLibrary({codexes});return await libraryStore.commitLibrary(lib=>" + mutate + ",{codexes,silent:true})})()")
            time.sleep(.15)
            modified = backup_snapshot(second)
            click(first, "#favoritesReplaceConfirmBtn")
        wait_for(first, "!document.querySelector('#favoritesReplaceConfirmBtn').disabled", "overwrite attempt completes")
        time.sleep(.18)
        refused = backup_snapshot(first)
        safe = refused["raw"] == modified["raw"] and refused["communityRaw"] == modified["communityRaw"] and refused["visible"] and bool(refused["error"])
        if kind in ("new-atlas", "lock-queue"):
            safe = safe and "2 条" in refused["message"]
        record("1.8-" + kind + "-reject-old-confirm", {"shown": shown, "modified": modified, "refused": refused}, safe)
        if safe:
            click(first, "#favoritesReplaceConfirmBtn")
            wait_for(first, "!document.querySelector('#favoritesReplaceConfirmBtn').disabled", "second deliberate overwrite completes")
            time.sleep(.2)
            saved = backup_snapshot(first)
            saved_library = json.loads(saved["raw"])
            record("1.8-" + kind + "-second-confirm", saved,
                   not saved["visible"] and not saved["error"] and [i["key"] for i in saved_library["items"]] == ["book:keep"] and json.loads(saved["communityRaw"]) == ["community-keep"])

    try:
        first = CDP(page_ws_url(chrome_port))
        clients.append(first)
        first.command("Page.enable")
        first.command("Runtime.enable")
        fresh(first)
        target = first.command("Target.createTarget", {"url": url, "newWindow": True})["targetId"]
        with urllib.request.urlopen(f"http://127.0.0.1:{chrome_port}/json/list") as response:
            pages = json.load(response)
        second = CDP(next(p["webSocketDebuggerUrl"] for p in pages if p["id"] == target))
        clients.append(second)
        second.command("Page.enable")
        wait_for(second, "window.ready===true", "other production renderer")
        evidence["platform"] = first.eval("({userAgent:navigator.userAgent,locks:typeof navigator.locks?.request,query:typeof navigator.locks?.query})")
        for kind in ("new-atlas", "equal-count-identity", "community", "lock-queue", "retained-note", "new-folder"):
            backup_case(kind)
        for name, key, selector, desired in SETTINGS:
            for error in ("QuotaExceededError", "SecurityError"):
                reset_settings()
                before = first.eval(SNAPSHOT)
                first.eval("window.errors=[];document.querySelector('#toast').textContent='';Storage.prototype.setItem=function(k,v){if(k===" + json.dumps(key) + ")throw new DOMException('independent fault'," + json.dumps(error) + ");return originalWrite.call(this,k,v)};true")
                click(first, selector)
                time.sleep(.1)
                after = first.eval(SNAPSHOT)
                feedback = first.eval("({errors:[...errors],toast:document.querySelector('#toast').textContent})")
                record("1.9-" + name + "-" + error, {"before": before, "after": after, **feedback}, before == after and not feedback["errors"] and "未保存" in feedback["toast"])
                first.eval("Storage.prototype.setItem=originalWrite;errors=[];true")
                click(first, selector)
                time.sleep(.1)
                after_retry = first.eval(SNAPSHOT)
                record("1.9-" + name + "-retry-" + error, after_retry, after_retry["disk"][key] == desired and after_retry != before and not first.eval("errors"))
        reset_settings()
        before = first.eval(SNAPSHOT)
        first.eval("window.errors=[];document.querySelector('#toast').textContent='';Storage.prototype.setItem=function(k,v){if(k==='fadian-dark')throw new DOMException('second key fault','QuotaExceededError');return originalWrite.call(this,k,v)};true")
        click(first, '[data-dark-mode="dark"]')
        time.sleep(.1)
        after = first.eval(SNAPSHOT)
        feedback = first.eval("({errors:[...errors],toast:document.querySelector('#toast').textContent})")
        record("1.9-dark-secondary-write-rollback", {"before": before, "after": after, **feedback}, before == after and not feedback["errors"] and "未保存" in feedback["toast"])
        reset_settings()
        fresh(second)
        first.eval("window.localWrites=[];Object.assign(stateModule.state,{allowNsfw:true,allowR18g:true});document.body.classList.add('nsfw-unlocked','r18g-unlocked');document.querySelector('#nsfwToggle').checked=true;document.querySelector('#r18gToggle').checked=true;Storage.prototype.setItem=function(k,v){if(k==='fadian-nsfw-ok'||k==='fadian-r18g-ok'||k==='fadian-adult-confirmed-v1')localWrites.push({key:k,value:v});return originalWrite.call(this,k,v)};true")
        second.eval("localStorage.setItem('fadian-nsfw-ok','0');true")
        time.sleep(.35)
        synced = first.eval("({nsfw:stateModule.state.allowNsfw,r18g:stateModule.state.allowR18g,nsfwChecked:document.querySelector('#nsfwToggle').checked,r18gChecked:document.querySelector('#r18gToggle').checked,body:document.body.className})")
        writes = first.eval("localWrites")
        record("existing-access-cross-tab-revoke-no-rewrite", {"snapshot": synced, "localWrites": writes}, not synced["nsfw"] and not synced["r18g"] and not synced["nsfwChecked"] and not synced["r18gChecked"] and not writes)
        first.eval("Storage.prototype.setItem=originalWrite;true")
        if args.preview:
            if args.source != "fixed":
                raise ValueError("--preview is for the fixed working tree only")
            port = find_free_port()
            log = (out / "preview.log").open("w", encoding="utf-8")
            preview = subprocess.Popen([sys.executable, "-B", str(ROOT / "tools/preview_server.py"), "--port", str(port)], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
            preview_url = f"http://127.0.0.1:{port}/"
            if not wait_url(preview_url, timeout=12):
                raise RuntimeError("actual preview failed to start")
            first.command("Page.addScriptToEvaluateOnNewDocument", {"source": "try{localStorage.setItem('fadian-motion','off');localStorage.setItem('fadian-density','standard');localStorage.setItem('fadian-theme','')}catch(e){};window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));"})
            first.command("Page.navigate", {"url": preview_url})
            wait_for(first, "Boolean(document.querySelector('#densityQuickBtn')?.onclick&&document.querySelector('#themeBtn')?.onclick)", "actual app initializes UI handlers", timeout=30)
            first.eval("(async()=>{window.stateModule=await import('/assets/app/state.js');window.originalWrite=Storage.prototype.setItem;window.originalRead=Storage.prototype.getItem;window.settingKeys=" + json.dumps(KEYS) + ";return true})()")
            before = first.eval(SNAPSHOT)
            first.eval("errors=[];document.querySelector('#toast').textContent='';Storage.prototype.setItem=function(k,v){if(k==='fadian-density')throw new DOMException('preview quota','QuotaExceededError');return originalWrite.call(this,k,v)};true")
            click(first, "#densityQuickBtn")
            time.sleep(.12)
            after = first.eval(SNAPSHOT)
            feedback = first.eval("({errors:[...errors],toast:document.querySelector('#toast').textContent})")
            record("1.9-actual-app-density-failure", {"before": before, "after": after, **feedback}, before == after and not feedback["errors"] and "未保存" in feedback["toast"])
            first.eval("Storage.prototype.setItem=originalWrite;true")
            click(first, "#densityQuickBtn")
            time.sleep(.2)
            saved = first.eval(SNAPSHOT)
            record("1.9-actual-app-density-retry", saved, saved["disk"]["fadian-density"] != "standard" and saved["state"]["density"] == saved["disk"]["fadian-density"] and not first.eval("errors"))
            first.command("Page.addScriptToEvaluateOnNewDocument", {"source": "window.originalStorageProperty=Object.getOwnPropertyDescriptor(window,'localStorage');Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('bootstrap unavailable','SecurityError')}});"})
            first.eval("window.previousPreview=true;true")
            first.command("Page.navigate", {"url": preview_url + "?unavailable=1"})
            wait_for(first, "!window.previousPreview&&Boolean(document.querySelector('#densityQuickBtn')?.onclick&&document.querySelector('#themeBtn')?.onclick)", "actual app binds despite localStorage property denial", timeout=30)
            boot = first.eval("({errors:[...errors],densityControls:[...document.querySelectorAll('[data-density]')].map(n=>({density:n.dataset.density,pressed:n.getAttribute('aria-pressed')})),body:document.body.className})")
            record("1.9-actual-app-storage-property-denied-startup", boot, not boot["errors"] and len(boot["densityControls"]) == 3)
            first.eval("(async()=>{Object.defineProperty(window,'localStorage',originalStorageProperty);window.stateModule=await import('/assets/app/state.js');window.originalRead=Storage.prototype.getItem;window.originalWrite=Storage.prototype.setItem;window.settingKeys=" + json.dumps(KEYS) + ";errors=[];return true})()")
            click(first, "#densityQuickBtn")
            time.sleep(.15)
            recovered = first.eval(SNAPSHOT)
            record("1.9-actual-app-property-denial-recover-retry", recovered, recovered["state"]["density"] == recovered["disk"]["fadian-density"] and not first.eval("errors"))
            evidence["preview"] = {"url": preview_url, "pid": preview.pid}
    except Exception as error:
        evidence["fatal"] = repr(error)
        try:
            evidence["lastPage"] = first.eval("({url:location.href,errors:window.errors||[],themeBound:Boolean(document.querySelector('#themeBtn')?.onclick),densityBound:Boolean(document.querySelector('#densityQuickBtn')?.onclick),loading:document.querySelector('#loading')?.textContent,toast:document.querySelector('#toast')?.textContent})")
            evidence["runtimeEvents"] = [event for event in first.events if event.get('method') in ('Runtime.exceptionThrown', 'Runtime.consoleAPICalled')][-12:]
        except Exception:
            pass
        print("FATAL: " + repr(error), flush=True)
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
        if preview:
            preview.terminate()
            preview.wait(timeout=5)
            log.close()
        server.shutdown()
        server.server_close()
        evidence["cleanup"] = {"chromePid": chrome.pid, "chromeExit": chrome.poll(), "serverStopped": True, "previewExit": preview.poll() if preview else None}
        paths = ["site/assets/app.js", "site/assets/app/favorites-backup.js", "site/assets/app/favorites-backup-store.js", "site/assets/app/favorites-library-core.js", "site/assets/app/ui.js", "site/assets/app/preferences-storage.js", "site/assets/app/tag-zh.js", "site/assets/app/tag-relay-v4.js", "site/assets/app/storage-coordinator.js"]
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
