"""Independent loopback Chrome checks for PR 41's two relay review fixes.

Baseline serves immutable --baseline Git bytes; fixed serves this worktree.
All mutation and failure injection uses isolated browser storage. --preview
also checks production app wiring through the local read-only preview server.
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
from verify_ui import CDP, find_free_port, page_ws_url, start_chrome, wait_for, wait_url

BASELINE = "c04f6f14703bca690e65fa2c0022bacdf406830a"
SNAPSHOT = """(()=>({
  disk:JSON.parse(localStorage.getItem(relayModel.TAG_RELAY_STORAGE_KEY)),
  memory:relayStore.relayState(),issue:relayStore.getRelayStorageIssue(),
  positive:document.querySelector('#relayEditorSurface-positive textarea')?.value,
  negative:document.querySelector('#relayEditorSurface-negative textarea')?.value,
  status:document.querySelector('.relay-save-state')?.textContent,
  hidden:document.querySelector('.relay-save-state')?.hidden,
  buttons:[...document.querySelectorAll('.relay-save-state button')].map(b=>b.textContent),
  toast:document.querySelector('#toast')?.textContent,errors:window.errors||[]
}))()"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", choices=("baseline", "fixed"), default="fixed")
    parser.add_argument("--baseline", default=BASELINE)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args()
    out = (ROOT / args.out_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    assets = {}

    def asset(path):
        if path not in assets:
            assets[path] = ((ROOT / path).read_bytes() if args.source == "fixed" else
                            subprocess.check_output(["git", "show", args.baseline + ":" + path], cwd=ROOT, stderr=subprocess.DEVNULL))
        return assets[path]

    index = asset("site/index.html").decode("utf-8")
    start = index.index('<aside id="tagRelayRail"')
    aside = index[start:index.index("</aside>", start) + len("</aside>")]
    aside = aside.replace('class="tag-relay-rail closed"', 'class="tag-relay-rail"')
    html = ("<!doctype html><meta charset=utf-8><title>Independent relay review fixes</title>"
            "<style>textarea{width:600px;height:65px}[hidden]{display:none!important}</style>"
            '<div id="toast" role="status"></div>' + aside + """
<script>window.errors=[];addEventListener('error',e=>errors.push(String(e.message)));addEventListener('unhandledrejection',e=>errors.push(String(e.reason?.stack||e.reason)));</script>
<script type=module>
window.relayModel=await import('/assets/app/tag-relay-v4.js');
window.relayStore=await import('/assets/app/tag-relay-store.js');
window.compose=await import('/assets/app/tag-relay-compose.js');
await relayStore.setupRelayStore();
window.composeHandle=compose.setupRelayCompose(document.querySelector('#tagRelayPaneCompose'));
await composeHandle.ready;
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
    port = find_free_port()
    chrome = start_chrome(out, port)
    clients, preview, preview_log = [], None, None
    evidence = {"source": args.source, "baseline": args.baseline, "url": url, "checks": []}

    def record(name, data, safe):
        evidence["checks"].append({"name": name, "safe": bool(safe), "evidence": data})
        (out / "results.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        print(name + ": " + ("PASS" if safe else "FAIL"), flush=True)

    def fresh(client):
        client.eval("window.previousDocument=true;true")
        client.command("Page.navigate", {"url": url + "?run=" + str(time.time_ns())})
        try:
            client.command("Page.handleJavaScriptDialog", {"accept": True})
        except Exception:
            pass
        wait_for(client, "window.ready===true&&!window.previousDocument", "fresh production relay modules")

    def seed():
        first.eval("""(()=>{localStorage.clear();const s=relayModel.normalizeRelayState(null);const p=relayModel.getActivePlan(s);relayModel.replacePlanText(s,p.id,{positive:{text:'disk original',folds:{}},negative:{text:'',folds:{}}},{expectedRevision:p.revision});localStorage.setItem(relayModel.TAG_RELAY_STORAGE_KEY,JSON.stringify(s));return true})()""")
        fresh(first)
        fresh(second)

    def type_text(client, channel, text, replace=False):
        client.eval("(()=>{document.querySelector('#relayEditorTab-" + channel + "').click();const input=document.querySelector('#relayEditorSurface-" + channel + " textarea');input.focus();input.setSelectionRange(" + ("0,input.value.length" if replace else "input.value.length,input.value.length") + ");return true})()")
        client.command("Input.insertText", {"text": text})

    def copy_queue(conflict=False):
        seed()
        if conflict:
            type_text(first, "positive", "click snapshot", replace=True)
            first.eval("""(async()=>{const key=relayModel.TAG_RELAY_STORAGE_KEY;const s=JSON.parse(localStorage.getItem(key));const p=relayModel.getActivePlan(s);relayModel.replacePlanText(s,p.id,{positive:{text:'other saved revision',folds:{}},negative:{text:'',folds:{}}},{expectedRevision:p.revision});localStorage.setItem(key,JSON.stringify(s));await relayStore.initializeRelay();return true})()""")
            wait_for(first, "document.querySelector('.relay-save-state')?.textContent.includes('另一页面')", "existing draft conflict")
        else:
            first.eval("""(()=>{window.originalRead=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k===relayModel.TAG_RELAY_STORAGE_KEY)throw new DOMException('pageshow unavailable','SecurityError');return originalRead.call(this,k)};try{dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))}finally{Storage.prototype.getItem=originalRead}return true})()""")
            wait_for(first, "relayStore.getRelayStorageIssue()==='storage'", "only global storage issue")
        second.eval("window.lockReady=false;window.releaseLock=null;navigator.locks.request('fadian-tag-relay-v4:lock',async()=>{window.lockReady=true;await new Promise(r=>window.releaseLock=r)});true")
        wait_for(second, "lockReady", "real lock held in the second renderer")
        if not conflict:
            type_text(first, "positive", "click snapshot", replace=True)
        first.eval("window.copyDone=false;window.copyResult=null;[...document.querySelectorAll('.relay-save-state button')].find(b=>b.textContent==='另存副本').onclick().then(result=>{window.copyResult=result;window.copyDone=true});true")
        type_text(first, "positive", ", NEW-TAIL")
        type_text(first, "negative", "NEGATIVE-TAIL", replace=True)
        # The latest 160 ms debounce must run while copy is still blocked.
        time.sleep(.55)
        before = first.eval(SNAPSHOT)
        second.eval("releaseLock();true")
        wait_for(first, "copyDone", "queued copy action returns")
        time.sleep(.75)
        after = first.eval(SNAPSHOT)
        complete_saved = any("NEW-TAIL" in p["positive"]["text"] and "NEGATIVE-TAIL" in p["negative"]["text"] for p in after["disk"]["plans"])
        retained = "NEW-TAIL" in (after["positive"] or "") and "NEGATIVE-TAIL" in (after["negative"] or "") and not after["hidden"] and ("保留" in (after["status"] or "") or "尚未保存" in (after["status"] or ""))
        if conflict:
            safe = retained and not complete_saved and any(p["positive"]["text"] == "other saved revision" for p in after["disk"]["plans"])
        else:
            safe = complete_saved or retained
        record("copy-conflict-control" if conflict else "copy-global-issue-debounce-consumed", {"beforeRelease": before, "afterRelease": after, "fullTailSaved": complete_saved, "visibleRetainedDraft": retained}, safe)
        if not conflict:
            flushed = first.eval("compose.flushCompose()")
            final = first.eval(SNAPSHOT)
            record("copy-retained-input-can-save", {"flush": flushed, "afterFlush": final}, bool(flushed) and any("NEW-TAIL" in p["positive"]["text"] and "NEGATIVE-TAIL" in p["negative"]["text"] for p in final["disk"]["plans"]))

    def fault():
        first.eval("""(()=>{window.originalWrite=Storage.prototype.setItem;window.originalRaw=localStorage.getItem(relayModel.TAG_RELAY_STORAGE_KEY);window.writeAttempts=[];window.signalFailed=false;window.faultActive=true;Storage.prototype.setItem=function(k,v){writeAttempts.push({key:k,value:String(v)});if(faultActive&&k===relayModel.TAG_RELAY_STORAGE_KEY+':signal'){signalFailed=true;throw new DOMException('signal rejected','SecurityError')}if(faultActive&&signalFailed&&k===relayModel.TAG_RELAY_STORAGE_KEY&&String(v)===originalRaw)throw new DOMException('compensation rejected','SecurityError');return originalWrite.call(this,k,v)};return true})()""")

    def outcome(expression):
        return first.eval("(async()=>{const r=await (" + expression + ");return{ok:r.ok,reason:r.reason,error:r.error?.name,rollbackErrors:r.rollbackErrors?.map(({key,error})=>({key,error:error?.name}))}})()")

    def rollback_case(kind):
        seed()
        if kind == "plan":
            type_text(first, "positive", "local conflicted input", replace=True)
            first.eval("""(async()=>{const key=relayModel.TAG_RELAY_STORAGE_KEY;const s=JSON.parse(localStorage.getItem(key));const p=relayModel.getActivePlan(s);relayModel.replacePlanText(s,p.id,{positive:{text:'peer saved revision',folds:{}},negative:{text:'',folds:{}}},{expectedRevision:p.revision});localStorage.setItem(key,JSON.stringify(s));await relayStore.initializeRelay();return true})()""")
            wait_for(first, "document.querySelector('.relay-save-state')?.textContent.includes('另一页面')", "conflict precondition before global rollback")
        fault()
        first.eval("window.mutations=0;true")
        operation = "relayStore.commitRelay(next=>{mutations++;return relayModel.createPlan(next,'one intended plan')},{changed:'plan'})"
        if kind == "history":
            operation = "relayStore.commitRelay(next=>{mutations++;return relayModel.recordCopyHistory(next,{label:'one intended copy',output:{positive:'same output',negative:'',positiveCount:1,negativeCount:0}})},{changed:'history'})"
        result = outcome(operation)
        failed = first.eval(SNAPSHOT)
        metadata = result.get("reason") == "rollback" and result.get("error") == "SecurityError" and any(item["key"] == "fadian-tag-relay-v4" and item["error"] == "SecurityError" for item in result.get("rollbackErrors", []))
        clear_ui = failed["issue"] == "rollback" and not failed["hidden"] and "重试保存" not in failed["buttons"] and "另存副本" not in failed["buttons"] and ("确认" in (failed["status"] or "") or "不确定" in (failed["status"] or ""))
        record("rollback-" + kind + "-metadata-and-ui", {"result": result, "failed": failed}, metadata and clear_ui)
        first.eval("faultActive=false;window.writesAfterFailure=writeAttempts.length;true")
        guard_results = [outcome(operation), outcome("relayStore.commitRelay(next=>{mutations++;return relayModel.createPlan(next,'must stay gated')},{changed:'plan'})"), outcome("relayStore.commitRelay(next=>{mutations++;return relayModel.recordCopyHistory(next,{label:'must stay gated',output:{positive:'blocked',negative:'',positiveCount:1,negativeCount:0}})},{changed:'history'})"), outcome("relayStore.initializeRelay()"), outcome("relayStore.setupRelayStore()")]
        first.eval("dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));dispatchEvent(new StorageEvent('storage',{storageArea:localStorage,key:relayModel.TAG_RELAY_STORAGE_KEY,newValue:localStorage.getItem(relayModel.TAG_RELAY_STORAGE_KEY)}));true")
        time.sleep(.2)
        gated = first.eval(SNAPSHOT)
        counts = first.eval("({mutations,writesAfterFailure,writesAfterGuards:writeAttempts.length})")
        record("rollback-" + kind + "-page-lifetime-write-gate", {"attempts": guard_results, "counts": counts, "afterAttempts": gated}, all(r.get("reason") == "rollback" for r in guard_results) and counts["mutations"] == 1 and counts["writesAfterFailure"] == counts["writesAfterGuards"] and gated["disk"] == failed["disk"] and gated["issue"] == "rollback")
        first.eval("Storage.prototype.setItem=originalWrite;true")
        fresh(first)
        reloaded = first.eval(SNAPSHOT)
        recovery = outcome("relayStore.commitRelay(next=>relayModel.createPlan(next,'reviewed recovery action'),{changed:'plan'})")
        saved = first.eval(SNAPSHOT)
        original_count = len([p for p in saved["disk"]["plans"] if p["name"] == "one intended plan"]) if kind == "plan" else len([h for h in saved["disk"]["history"] if h["label"] == "one intended copy"])
        record("rollback-" + kind + "-real-navigation-recovers", {"afterNavigation": reloaded, "result": recovery, "afterRecovery": saved}, reloaded["issue"] is None and recovery["ok"] and original_count == 1)

    def queued_rollback():
        seed()
        fault()
        second.eval("window.lockReady=false;window.releaseLock=null;navigator.locks.request('fadian-tag-relay-v4:lock',async()=>{window.lockReady=true;await new Promise(r=>window.releaseLock=r)});true")
        wait_for(second, "lockReady", "real lock queues both commits")
        first.eval("window.mutations=0;window.queuedDone=false;window.queuedResults=null;Promise.all(['first queued action','second queued action'].map(name=>relayStore.commitRelay(next=>{mutations++;return relayModel.createPlan(next,name)},{changed:'plan'}))).then(results=>{queuedResults=results.map(r=>({ok:r.ok,reason:r.reason,error:r.error?.name,rollbackErrors:r.rollbackErrors?.map(({key,error})=>({key,error:error?.name}))}));queuedDone=true});true")
        wait_for(second, "navigator.locks.query().then(s=>s.pending.filter(l=>l.name==='fadian-tag-relay-v4:lock').length>=2)", "both mutations are already queued in the lock service")
        second.eval("releaseLock();true")
        wait_for(first, "queuedDone", "both queued requests return")
        data = first.eval("({results:queuedResults,mutations,writes:writeAttempts,snapshot:" + SNAPSHOT + "})")
        names = [p["name"] for p in data["snapshot"]["disk"]["plans"]]
        record("rollback-already-queued-second-mutation-blocked", data, all(r.get("reason") == "rollback" for r in data["results"]) and data["mutations"] == 1 and len(data["writes"]) == 3 and names.count("first queued action") == 1 and "second queued action" not in names and data["snapshot"]["issue"] == "rollback")
        first.eval("Storage.prototype.setItem=originalWrite;true")

    try:
        first = CDP(page_ws_url(port))
        clients.append(first)
        first.command("Page.enable")
        first.command("Runtime.enable")
        fresh(first)
        target = first.command("Target.createTarget", {"url": url, "newWindow": True})["targetId"]
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list") as response:
            pages = json.load(response)
        second = CDP(next(p["webSocketDebuggerUrl"] for p in pages if p["id"] == target))
        clients.append(second)
        second.command("Page.enable")
        wait_for(second, "window.ready===true", "second real renderer")
        evidence["platform"] = first.eval("({userAgent:navigator.userAgent,webLocks:typeof navigator.locks?.request,lockQuery:typeof navigator.locks?.query})")
        copy_queue()
        copy_queue(conflict=True)
        rollback_case("plan")
        rollback_case("history")
        queued_rollback()
        if args.preview:
            if args.source != "fixed":
                raise ValueError("--preview requires --source fixed")
            preview_port = find_free_port()
            preview_log = (out / "preview.log").open("w", encoding="utf-8")
            preview = subprocess.Popen([sys.executable, "-B", str(ROOT / "tools/preview_server.py"), "--port", str(preview_port)], cwd=ROOT, stdout=preview_log, stderr=subprocess.STDOUT)
            preview_url = f"http://127.0.0.1:{preview_port}/"
            if not wait_url(preview_url):
                raise RuntimeError("read-only preview failed to start")
            first.command("Page.addScriptToEvaluateOnNewDocument", {"source": "try{localStorage.setItem('fadian-motion','off')}catch(e){};window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));"})
            first.command("Page.navigate", {"url": preview_url})
            wait_for(first, "Boolean(document.querySelector('#densityQuickBtn')?.onclick)", "actual app ready", timeout=30)
            first.eval("(async()=>{window.relayModel=await import('/assets/app/tag-relay-v4.js');window.relayStore=await import('/assets/app/tag-relay-store.js');window.compose=await import('/assets/app/tag-relay-compose.js');document.querySelector('#tagRelayBtn').click();return true})()")
            first.eval("if(localStorage.getItem(relayModel.TAG_RELAY_STORAGE_KEY)===null)localStorage.setItem(relayModel.TAG_RELAY_STORAGE_KEY,JSON.stringify(relayStore.relayState()));true")
            fault()
            result = outcome("relayStore.commitRelay(next=>relayModel.createPlan(next,'preview single action'),{changed:'plan'})")
            time.sleep(.1)
            shown = first.eval(SNAPSHOT)
            record("actual-preview-rollback-feedback", {"result": result, "snapshot": shown}, result.get("reason") == "rollback" and shown["issue"] == "rollback" and not shown["hidden"] and "重新加载页面" in shown["buttons"] and "重试保存" not in shown["buttons"] and "另存副本" not in shown["buttons"] and not shown["errors"])
            first.eval("faultActive=false;window.writesAfterFailure=writeAttempts.length;true")
            guarded = outcome("relayStore.commitRelay(next=>relayModel.createPlan(next,'preview single action'),{changed:'plan'})")
            counts = first.eval("({before:writesAfterFailure,after:writeAttempts.length})")
            record("actual-preview-rollback-retry-blocked", {"result": guarded, "counts": counts}, guarded.get("reason") == "rollback" and counts["before"] == counts["after"])
            first.eval("Storage.prototype.setItem=originalWrite;window.previousPreview=true;[...document.querySelectorAll('.relay-save-state button')].find(b=>b.textContent==='重新加载页面').click();true")
            wait_for(first, "!window.previousPreview&&Boolean(document.querySelector('#densityQuickBtn')?.onclick)", "explicit UI reload creates a new document", timeout=30)
            first.eval("(async()=>{window.relayModel=await import('/assets/app/tag-relay-v4.js');window.relayStore=await import('/assets/app/tag-relay-store.js');window.compose=await import('/assets/app/tag-relay-compose.js');return true})()")
            recovered = first.eval(SNAPSHOT)
            record("actual-preview-explicit-reload-checks-disk", recovered, recovered["issue"] is None and len([p for p in recovered["disk"]["plans"] if p["name"] == "preview single action"]) == 1 and not recovered["errors"])
            evidence["preview"] = {"url": preview_url, "pid": preview.pid}
    except Exception as error:
        evidence["fatal"] = repr(error)
        try:
            evidence["lastPage"] = first.eval(SNAPSHOT)
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
            preview_log.close()
        server.shutdown()
        server.server_close()
        evidence["cleanup"] = {"chromePid": chrome.pid, "chromeExit": chrome.poll(), "serverStopped": True, "previewExit": preview.poll() if preview else None}
        paths = ["site/assets/app/tag-relay-compose.js", "site/assets/app/tag-relay-store.js", "site/assets/app/tag-relay-v4.js", "site/assets/app/storage-coordinator.js", "site/index.html"]
        evidence["sourceSha256"] = {path: hashlib.sha256(asset(path)).hexdigest() for path in paths}
        evidence["sourceChangedDuringRun"] = [path for path in paths if args.source == "fixed" and (ROOT / path).read_bytes() != asset(path)]
        evidence["safe"] = "fatal" not in evidence and not evidence["sourceChangedDuringRun"] and all(c["safe"] for c in evidence["checks"])
        (out / "results.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if evidence["safe"] else 1


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    raise SystemExit(main())
