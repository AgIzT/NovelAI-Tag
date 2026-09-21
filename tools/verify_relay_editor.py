"""中转站文本内核浏览器回归；隔离 Chrome，只服务本地静态资源。

真实系统中文输入法和实体触屏不在自动化覆盖范围。测试使用 CDP 浏览器输入，
与手工验收分别报告。没有产品存储写入，不读取用户浏览器 profile。
"""
from __future__ import annotations

import argparse
import base64
import functools
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import time
import traceback
from urllib.parse import urlsplit

import verify_ui as ui


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "output" / "relay-plana-editor-20260921" / "browser-acceptance"
INPUT = ".relay-editor-input"
MIRROR = ".relay-editor-mirror"
ZW = "\u200b"
SOURCE_BODY = "artist:test, 1.2::backpack, gloves::, {{red hair, blue eyes}}, smile"

FIXTURE = r'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>中转站内核回归夹具</title>
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/ui-kit.css">
<link rel="stylesheet" href="/assets/styles.css">
<link rel="stylesheet" href="/assets/tag-relay.css">
<style>body{margin:20px}#fixture{width:408px;max-width:calc(100vw - 40px)}
#source{margin:24px 0;padding:10px}#result{white-space:pre-wrap;overflow-wrap:anywhere}
</style></head><body><main id="fixture"><div id="editor"></div>
<button id="source" draggable="true">测试素材</button><pre id="result"></pre></main>
<script type="module">
const mod = await import('/assets/app/tag-relay-editor.js');
const model = await import('/assets/app/tag-relay-text.js');
const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13"><rect width="13" height="13" fill="#715ce7"/></svg>');
const source={id:'fixture-entry',entryId:'fixture-entry',codexId:'fixture-book',title:'测试素材',
 prompt:'artist:test, 1.2::backpack, gloves::, {{red hair, blue eyes}}',negative:'lowres, bad hands',
 image,accessKnown:true,access:{nsfw:false,r18g:false},
 characterPrompts:[{name:'角色',prompt:'smile',negative:'bad feet'}]};
const source2={...source,id:'fixture-second',entryId:'fixture-second',title:'第二素材',prompt:'forest, soft lighting'};
const words={'blue sky':'蓝天','soft lighting':'柔和光线','forest':'森林','long hair':'长发'};
let changes=0;
const editor=mod.createRelayEditor({root:document.querySelector('#editor'),
 isLocked:()=>false,translate:token=>words[token.name]||'',onChange:()=>{changes+=1},
 onSourceDrop:(entry,options)=>editor.insertSource(entry,options)});
editor.setDedupe(false);
const sourceButton=document.querySelector('#source');
sourceButton.addEventListener('mousedown',event=>event.preventDefault());
sourceButton.addEventListener('click',()=>editor.insertSource(source));
sourceButton.addEventListener('dragstart',event=>{
 event.dataTransfer.setData('application/x-relay-source',JSON.stringify(source));
 event.dataTransfer.effectAllowed='copy';
});
window.qa={mod,model,editor,source,source2,changes:()=>changes,input:()=>document.querySelector('.relay-editor-input'),
 mirror:()=>document.querySelector('.relay-editor-mirror'),
 folds:()=>{const f=editor.getSession().positive.folds;return f instanceof Map?Object.fromEntries(f):f},
 text:()=>editor.getSession().positive.text,
 output:()=>{const s=editor.getSession();return model.outputOf(s.positive.text,s.positive.folds,{dedupe:s.dedupe})},
 point:(needle,offset=0)=>{
   const mirror=document.querySelector('.relay-editor-mirror');
   const walker=document.createTreeWalker(mirror,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement.closest('.zh')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
   const nodes=[];let all='',node;
   while(node=walker.nextNode()){nodes.push({node,start:all.length});all+=node.data}
   const at=all.indexOf(needle)+offset;if(at<offset)throw Error('missing geometry needle '+needle);
   const item=nodes.find(x=>at>=x.start&&at<x.start+x.node.length)||nodes.at(-1);
   const local=Math.min(item.node.length,at-item.start),range=document.createRange();
   range.setStart(item.node,local);range.setEnd(item.node,Math.min(item.node.length,local+1));
   const rect=range.getBoundingClientRect();
   return {x:rect.x+.15,y:rect.y+rect.height/2,at};
 }};
window.qaReady=true;
</script></body></html>'''


class FixtureHandler(SimpleHTTPRequestHandler):
    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError):
            # Chrome may close a keep-alive connection while the isolated page reloads.
            pass

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/fixture.html":
            body = FIXTURE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path.startswith("/assets/"):
            super().do_GET()
        else:
            self.send_error(404)

    def log_message(self, *_):
        pass


class Suite:
    def __init__(self, cdp, base, out):
        self.cdp, self.base, self.out = cdp, base, out
        self.results = []
        cdp.command("Page.enable")
        cdp.command("Runtime.enable")
        cdp.command("Emulation.setDeviceMetricsOverride", {
            "width": 900, "height": 900, "deviceScaleFactor": 1, "mobile": False,
        })
        ui.install_error_capture(cdp)

    def js(self, code):
        return self.cdp.eval("(async()=>{" + code + "})()", timeout=20)

    def check(self, condition, message):
        if not condition:
            raise ui.CheckFailed(message)

    def reset(self):
        self.cdp.events.clear()
        self.cdp.command("Page.navigate", {"url": self.base + "fixture.html?run=" + str(time.time_ns())})
        ui.wait_for(self.cdp, "window.qaReady===true", "editor fixture", timeout=20)
        self.js("await document.fonts.ready;")
        ui.settle(self.cdp, 60)
        ui.clear_errors(self.cdp)

    def key(self, name, modifiers=0):
        keycodes = {"Backspace": 8, "Delete": 46, "End": 35, "Home": 36,
                    "ArrowLeft": 37, "ArrowRight": 39, "Tab": 9, "Enter": 13,
                    "a": 65, "x": 88, "c": 67, "v": 86, "z": 90, "y": 89}
        event = {"key": name, "code": "Key" + name.upper() if len(name) == 1 else name,
                 "modifiers": modifiers, "windowsVirtualKeyCode": keycodes.get(name, 0)}
        self.cdp.command("Input.dispatchKeyEvent", {"type": "keyDown", **event})
        self.cdp.command("Input.dispatchKeyEvent", {"type": "keyUp", **event})
        ui.settle(self.cdp, 45)

    def type(self, text):
        self.cdp.command("Input.insertText", {"text": text})
        ui.settle(self.cdp, 50)

    def click_point(self, point, count=1):
        point = {k: point[k] for k in ("x", "y")}
        self.cdp.command("Input.dispatchMouseEvent", {"type": "mouseMoved", **point})
        self.cdp.command("Input.dispatchMouseEvent", {"type": "mousePressed", "button": "left", "clickCount": count, **point})
        self.cdp.command("Input.dispatchMouseEvent", {"type": "mouseReleased", "button": "left", "clickCount": count, **point})
        ui.settle(self.cdp, 70)

    def click(self, selector):
        point = self.js("const e=document.querySelector(" + json.dumps(selector) + ");if(!e)throw Error('missing click target');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();const p={x:r.x+r.width/2,y:r.y+r.height/2};const hit=document.elementFromPoint(p.x,p.y);if(!(e===hit||e.contains(hit)))throw Error('click target obscured');return p;")
        self.click_point(point)

    def panel(self, label):
        self.check(not self.js("return document.querySelector('.relay-token-panel').hidden;"), "contextual token actions did not open")
        point = self.js("const e=[...document.querySelectorAll('.relay-token-panel button')].find(e=>e.textContent.trim()===" + json.dumps(label) + ");if(!e)throw Error('missing panel button '+" + json.dumps(label) + ");const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};")
        self.click_point(point)

    def text(self):
        return self.js("return qa.input().value;")

    def output(self):
        return self.js("return qa.output();")

    def point(self, needle, offset=0):
        return self.js("return qa.point(" + json.dumps(needle) + "," + str(offset) + ");")

    def setup_text(self, text):
        self.click(INPUT)
        self.type(text)

    def select_token(self, needle):
        self.click_point(self.point(needle, min(2, len(needle) - 1)))

    def drag_points(self, start, end):
        self.cdp.command("Input.dispatchMouseEvent", {"type": "mousePressed", "button": "left", "buttons": 1, "clickCount": 1, "x": start["x"], "y": start["y"]})
        for n in range(1, 9):
            self.cdp.command("Input.dispatchMouseEvent", {"type": "mouseMoved", "button": "left", "buttons": 1,
                "x": start["x"] + (end["x"] - start["x"]) * n / 8, "y": start["y"] + (end["y"] - start["y"]) * n / 8})
        self.cdp.command("Input.dispatchMouseEvent", {"type": "mouseReleased", "button": "left", "clickCount": 1, "x": end["x"], "y": end["y"]})
        ui.settle(self.cdp, 70)

    def screenshot(self, name):
        # The small fixture is wholly inside this viewport; never capture a full atlas page.
        data = self.cdp.command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})["data"]
        (self.out / (name + ".png")).write_bytes(base64.b64decode(data))

    def test(self, name, callback):
        started = time.time()
        try:
            self.reset()
            detail = callback() or {}
            ui.check_no_errors(self.cdp)
            result = {"name": name, "ok": True, "detail": detail}
        except Exception:
            result = {"name": name, "ok": False, "error": traceback.format_exc()}
            try:
                self.screenshot("failure-" + name)
            except Exception as exc:
                result["screenshotError"] = str(exc)
        result["seconds"] = round(time.time() - started, 2)
        self.results.append(result)
        (self.out / "results.json").write_text(json.dumps(self.results, ensure_ascii=False, indent=2), encoding="utf-8")
        print(("PASS " if result["ok"] else "FAIL ") + name, flush=True)

    def geometry(self):
        return self.js(r'''
const input=qa.input(),mirror=qa.mirror(),a=getComputedStyle(input),b=getComputedStyle(mirror);
const props=['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','wordSpacing',
'whiteSpace','overflowWrap','wordBreak','tabSize','textTransform','textIndent','direction','paddingTop',
'paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderBottomWidth','fontKerning','fontVariantLigatures'];
const values=Object.fromEntries(props.map(p=>[p,{textarea:a[p],mirror:b[p]}]));
const width=(e,s)=>e.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight);
const fontProps=['fontFamily','fontSize','fontWeight','fontStyle','letterSpacing','wordSpacing'];
const tokenMismatches=[...mirror.querySelectorAll('.relay-token')].flatMap(t=>{
const s=getComputedStyle(t);return fontProps.filter(p=>s[p]!==a[p]).map(p=>({text:t.childNodes[0]?.textContent,property:p,token:s[p],textarea:a[p]}))});
const surface=document.querySelector('.relay-editor-surface');
return {values,mismatches:props.filter(p=>a[p]!==b[p]),tokenMismatches,
widths:[width(input,a),width(mirror,b)],scrollHeights:[input.scrollHeight,mirror.scrollHeight],
surface:{height:surface.clientHeight,scrollHeight:surface.scrollHeight,scrollTop:surface.scrollTop},
textareaOverflow:input.scrollWidth>input.clientWidth};''')

    def assert_geometry(self, label):
        evidence = self.geometry()
        self.check(not evidence["mismatches"], label + " CSS differences: " + repr(evidence))
        self.check(not evidence["tokenMismatches"], label + " token font changes advance widths: " + repr(evidence))
        self.check(evidence["widths"][0] == evidence["widths"][1], label + " content widths differ: " + repr(evidence))
        self.check(evidence["scrollHeights"][0] == evidence["scrollHeights"][1], label + " scroll heights differ: " + repr(evidence))
        self.check(not evidence["textareaOverflow"], label + " horizontal overflow")
        return evidence

    def undo_roundtrip(self, action):
        before = self.text()
        action()
        after = self.text()
        self.check(before != after, "test action did not change text")
        self.key("z", 2)
        undone = self.text()
        self.check(undone == before, "Ctrl+Z mismatch: " + repr({"before": before, "after": after, "undone": undone}))
        self.key("z", 10)
        redone = self.text()
        self.check(redone == after, "Ctrl+Shift+Z mismatch: " + repr({"after": after, "redone": redone}))
        return {"before": before, "after": after, "undo": undone, "redo": redone}

    def run(self, only=""):
        def mixed_geometry():
            self.click("#source")
            self.type(", blue sky, 中文混排, {{long hair}}, soft lighting, distant mountains, forest")
            result = self.assert_geometry("mixed")
            before = self.text()
            caret_hits = []
            for needle, offset in [("blue sky", 2), ("中文混排", 1), ("forest", 2)]:
                point = self.point(needle, offset)
                self.click_point(point)
                actual = self.js("return qa.input().selectionStart;")
                expected = before.index(needle) + offset
                caret_hits.append({"needle": needle, "point": point, "actual": actual, "expected": expected})
                self.check(actual == expected, "mirror character click did not hit native textarea caret: " + repr(caret_hits))
            result["caretHits"] = caret_hits
            self.screenshot("mixed-geometry")
            return result

        def long_geometry():
            self.setup_text("abcdefghijklmnopqrstuvwxyz" * 24)
            return self.assert_geometry("long-word")

        def scroll_geometry():
            self.setup_text("blue sky, 中文, soft lighting\n" * 55)
            self.js("const s=document.querySelector('.relay-editor-surface');s.scrollTop=s.scrollHeight;")
            result = self.assert_geometry("scrolled")
            self.check(result["surface"]["scrollTop"] > 0, "fixture did not reach max-height scrolling")
            self.screenshot("scrolled-geometry")
            return result

        def after_fold():
            self.click("#source")
            self.type(", blue sky, soft lighting")
            self.check(self.output() == SOURCE_BODY + ", blue sky, soft lighting", "fold expansion or outside tag order is wrong: " + self.output())
            return {"text": self.text(), "output": self.output()}

        def between_folds():
            self.click("#source")
            self.js("await qa.editor.insertSource(qa.source2);")
            before = self.text()
            at = before.index(",") + 2
            # The comma is a real text node in the mirror, so this is a real textarea hit.
            self.click_point(self.point(",", 1))
            caret = self.js("return qa.input().selectionStart;")
            self.check(0 < caret < len(before), "middle click went to the end")
            self.type(" blue sky,")
            self.check(self.text() == before[:caret] + " blue sky," + before[caret:], "middle typing did not insert at hit caret")
            self.check(self.output().index("blue sky") < self.output().index("forest"), "middle tag appended after second fold")
            return {"caret": caret, "before": before, "after": self.text(), "nominalGap": at}

        def undo_typing():
            self.click(INPUT)
            return self.undo_roundtrip(lambda: self.type("blue sky"))

        def undo_weight():
            self.setup_text("blue sky, forest")
            self.select_token("blue sky")
            return self.undo_roundtrip(lambda: self.panel("+"))

        def undo_disable():
            self.setup_text("blue sky, forest")
            self.select_token("blue sky")
            return self.undo_roundtrip(lambda: self.panel("禁用"))

        def undo_insert():
            self.setup_text("blue sky")
            self.key("End", 2)
            return self.undo_roundtrip(lambda: self.click("#source"))

        def undo_remove():
            self.click("#source")
            self.select_token("#测试素材")
            return self.undo_roundtrip(lambda: self.panel("删除"))

        def atomic_backspace():
            self.click("#source")
            before_folds = self.js("return qa.folds();")
            before = self.text()
            self.key("End", 2)
            detail = self.undo_roundtrip(lambda: self.key("Backspace"))
            self.check(detail["after"] == "", "Backspace left part of fold: " + repr(detail))
            self.key("z", 2)
            self.check(self.text() == before, "second undo did not restore fold")
            self.check(self.js("return qa.folds();") == before_folds, "restored fold lost source/body/image/access/characters")
            self.check(self.js("return Boolean(qa.mirror().querySelector('.pic'));"), "thumbnail did not return")
            self.check(self.output() == SOURCE_BODY, "restored fold body missing from output")
            return {**detail, "foldMetadata": before_folds}

        def atomic_delete():
            self.click("#source")
            self.key("Home", 2)
            detail = self.undo_roundtrip(lambda: self.key("Delete"))
            self.check(detail["after"] == "", "Delete left partial fold")
            return detail

        def selection_clipboard():
            self.setup_text("blue sky, forest, soft lighting")
            self.click_point(self.point("forest", 2), count=2)
            word = self.js("const i=qa.input();return i.value.slice(i.selectionStart,i.selectionEnd);")
            self.check(word.strip() == "forest", "double click did not select a system word: " + repr(word))
            start, end = self.point("blue sky", 5), self.point("soft lighting", 4)
            self.drag_points(start, end)
            selected = self.js("const i=qa.input();return i.value.slice(i.selectionStart,i.selectionEnd);")
            self.check(", forest," in selected, "drag selection did not cross tokens: " + repr(selected))
            self.screenshot("native-cross-token-selection")
            before = self.text()
            self.key("a", 2)
            self.check(self.js("return qa.input().selectionEnd-qa.input().selectionStart;") == len(before), "Ctrl+A did not select all")
            self.key("x", 2)
            self.check(self.text() == "", "Ctrl+X did not cut all")
            self.key("v", 2)
            self.check(self.text() == before, "Ctrl+V did not restore clipboard text")
            return {"doubleClick": word, "dragSelection": selected, "clipboardRestored": self.text()}

        def syntax():
            value = "1.2::backpack, gloves::, {{red hair, blue eyes}}"
            self.setup_text(value)
            count = self.js("return qa.mirror().querySelectorAll('.relay-token').length;")
            self.check(count == 2, "protected syntax split into " + str(count) + " tokens")
            self.check(self.text() == value and self.output() == value, "syntax bytes changed")
            return {"tokens": count, "text": self.text(), "output": self.output()}

        def duplicates():
            self.click("#source")
            self.click("#source")
            self.type(", blue sky")
            folds = self.js("return qa.folds();")
            self.check(len(folds) == 2, "duplicate source was collapsed")
            self.check(len(set(folds)) == 2, "fold names not unique")
            self.select_token("#测试素材")
            self.panel("+")
            output = self.output()
            self.check(output.endswith(SOURCE_BODY + ", blue sky"), "weight leaked into second group or handwritten text: " + output)
            self.check(output.startswith("{{" + SOURCE_BODY + "}}, "), "first group weight not scoped around body: " + output)
            return {"names": list(folds), "output": output}

        def drop_at_character():
            self.click("#source")
            self.type(", blue sky, forest, soft lighting")
            before = self.text()
            at = before.index("soft lighting") + 5
            point = self.point("soft lighting", 5)
            zh_count = self.js("return qa.mirror().querySelectorAll('.zh').length;")
            self.check(zh_count >= 2, "drop fixture needs preceding annotations")
            source_json = self.js("return JSON.stringify(qa.source);")
            payload = {"items": [{"mimeType": "application/x-relay-source", "data": source_json}], "dragOperationsMask": 1}
            for event_type in ("dragEnter", "dragOver", "drop"):
                self.cdp.command("Input.dispatchDragEvent", {"type": event_type, "x": point["x"], "y": point["y"], "data": payload})
            ui.settle(self.cdp, 100)
            after = self.text()
            left, right = before[:at], before[at:]
            self.check(after.startswith(left.rstrip()) and after.endswith(right.lstrip()), "drop did not preserve the exact character boundary: " + repr({"at": at, "before": before, "after": after}))
            self.check(len(self.js("return qa.folds();")) == 2, "drop did not insert source")
            inserted = after[len(left.rstrip()):len(after) - len(right.lstrip())]
            self.check(ZW + "#" in inserted, "placeholder missing at exact drop boundary")
            self.check(self.js("return qa.input().style.pointerEvents;") != "none", "textarea pointerEvents was not restored")
            return {"at": at, "annotations": zh_count, "before": before, "after": after, "inserted": inserted}

        def fallback():
            self.setup_text("blue sky, forest")
            self.select_token("blue sky")
            self.js("qa.nativeExec=document.execCommand;document.execCommand=()=>false;")
            detail = self.undo_roundtrip(lambda: self.panel("+"))
            self.js("document.execCommand=qa.nativeExec;")
            return detail

        def fallback_typing():
            self.setup_text("blue sky, forest")
            original = self.text()
            self.select_token("blue sky")
            self.js("qa.nativeExec=document.execCommand;document.execCommand=()=>false;")
            self.panel("+")
            weighted = self.text()
            self.key("End", 2)
            self.type(", long hair")
            typed = self.text()
            self.key("z", 2)
            self.check(self.text() == weighted, "fallback typing undo skipped the last input")
            self.key("z", 2)
            self.check(self.text() == original, "fallback undo did not restore pre-weight text")
            self.key("z", 10)
            self.check(self.text() == weighted, "fallback redo did not restore weight")
            self.key("z", 10)
            self.check(self.text() == typed, "fallback redo did not restore subsequent typing")
            self.js("document.execCommand=qa.nativeExec;")
            return {"original": original, "weighted": weighted, "typed": typed}

        def atomic_selection():
            self.setup_text("blue sky, ")
            self.click("#source")
            self.type(", forest")
            before = self.text()
            start = before.index(ZW + "#")
            end = before.index(ZW, start + 1) + 1
            self.js(f"qa.input().setSelectionRange({start + 2},{end - 2},'backward');")
            ui.settle(self.cdp, 60)
            selection = self.js("const i=qa.input();return {start:i.selectionStart,end:i.selectionEnd,direction:i.selectionDirection};")
            self.check(selection["start"] == start and selection["end"] == end, "partial selection did not expand to whole fold: " + repr(selection))
            self.check(selection["direction"] == "backward", "atomic expansion reversed backward selection")
            self.key("Backspace")
            self.check(ZW + "#" not in self.text(), "partial selection deletion left a damaged fold")
            self.key("z", 2)
            self.check(self.text() == before, "atomic selection delete undo lost text")
            return {"selection": selection, "foldRange": [start, end], "restored": self.text()}

        def scrub_guards():
            self.js("await qa.editor.insertSource({...qa.source,title:'含#名\\u200b称',prompt:'blue\\u200c sky, ~smile~, forest\\ufeff'});")
            self.js("await qa.editor.insertSource({...qa.source,title:'含#名\\u200b称',prompt:'blue\\u200c sky, ~smile~, forest\\ufeff'});")
            folds = self.js("return qa.folds();")
            self.check(all("#" not in name and not any("\u200b" <= ch <= "\u200f" or ch == "\ufeff" for ch in name) for name in folds), "unscrubbed fold key")
            output = self.output()
            self.check("~smile~" in output, "bare tilde text was treated as disabled")
            self.check(not any("\u200b" <= ch <= "\u200f" or ch == "\ufeff" for ch in output), "zero width leaked to output")
            return {"names": list(folds), "output": output}

        def weighted_atomic():
            self.click('#source')
            self.select_token('#测试素材')
            self.panel('+')
            self.key('End', 2)
            before = self.text()
            folds = self.js('return qa.folds();')
            result = self.undo_roundtrip(lambda: self.key('Backspace'))
            self.check(result['after'] == '', 'weighted fold left a broken wrapper')
            self.key('z', 2)
            self.check(self.text() == before and self.js('return qa.folds();') == folds, 'weighted fold undo lost metadata')
            return result

        def composition_supplement():
            self.setup_text('blue sky')
            self.js('document.execCommand=()=>false;qa.editor.splice(qa.input().value.length,qa.input().value.length,", ");')
            before = self.text()
            count = self.js('return qa.mirror().querySelectorAll(".relay-token").length;')
            self.cdp.command('Input.imeSetComposition', {'text': '中文, 测试', 'selectionStart': 6, 'selectionEnd': 6})
            self.check(self.js('return qa.mirror().querySelectorAll(".relay-token").length;') == count, 'composition repainted token boundaries early')
            self.type('中文, 测试')
            after = self.text()
            self.check(self.js('return qa.mirror().querySelectorAll(".relay-token").length;') > count, 'compositionend did not repaint')
            self.key('z', 2)
            self.check(self.text() == before, 'fallback composition undo skipped the composition transaction')
            self.key('z', 10)
            self.check(self.text() == after, 'fallback composition redo lost text')
            return {'before': before, 'after': after, 'scope': 'CDP composition protocol only; not system IME acceptance'}

        def weighted_syntax():
            self.setup_text('{cat, 1.3::dog::}')
            self.select_token('cat')
            self.panel('+')
            value = self.text()
            self.check('::dog::::' not in value, 'panel created ambiguous nested numeric weight')
            return {'weighted': value}

        def weight_domain():
            results = []
            for original, expected in [('-1', -.9), ('0', .1), ('12', 12.1), ('1.157625', 1.3)]:
                self.reset()
                self.setup_text(original + '::cat::')
                self.select_token('cat')
                self.panel('+')
                actual = self.js('return qa.model.tokens(qa.text())[0].mult;')
                self.check(actual == expected, 'weight button did not move to the next tenth')
                after = self.text()
                self.key('z', 2)
                self.check(self.text() == original + '::cat::', 'weight undo changed original text or handwritten precision')
                results.append({'original': original, 'expected': expected, 'after': after})
            # 连续操作跨过默认倍率1：正文与折叠词组都应按十分位走，并能逐步撤销。
            for folded in [False, True]:
                self.reset()
                if folded:
                    self.click('#source')
                    self.select_token('#测试素材')
                else:
                    self.setup_text('cat')
                    self.select_token('cat')
                original = self.text()
                folds = self.js('return qa.folds();')
                values = []
                for label, expected in [('−', .9), ('−', .8), ('+', .9), ('+', 1), ('+', 1.1), ('+', 1.2), ('+', 1.3)]:
                    self.panel(label)
                    actual = self.js('return qa.model.tokens(qa.text())[0].mult;')
                    self.check(actual == expected, 'consecutive weight edits left the 0.1 grid')
                    value = self.text()
                    self.check(value == (original if expected == 1 else f'{expected}::{original}::'), 'weight text contains float tails or changed the body')
                    values.append(actual)
                for _ in values:
                    self.key('z', 2)
                self.check(self.text() == original and self.js('return qa.folds();') == folds, 'weight sequence undo lost text or fold metadata')
                results.append({'folded': folded, 'sequence': values})
            return results

        def drop_on_fold():
            self.click('#source')
            self.select_token('#测试素材')
            self.panel('+')
            before = self.text()
            self.js('qa.editor.insertSource(qa.source2,{at:qa.input().value.indexOf("测试素材")+1});')
            after = self.text()
            self.check(before in after and len(self.js('return qa.folds();')) == 2, 'drop inside fold replaced existing material')
            return {'before': before, 'after': after}

        def plain_drop():
            self.setup_text('blue sky, forest')
            point = self.point('forest', 3)
            payload = {'items': [{'mimeType': 'text/plain', 'data': ZW+'~smile~'+ZW}], 'dragOperationsMask': 1}
            for event_type in ('dragEnter', 'dragOver', 'drop'):
                self.cdp.command('Input.dispatchDragEvent', {'type': event_type, 'x': point['x'], 'y': point['y'], 'data': payload})
            ui.settle(self.cdp, 70)
            self.check(ZW not in self.text() and '~smile~' in self.output(), 'external text drop injected an internal guard')
            return {'text': self.text(), 'output': self.output()}

        def plain_drop_on_fold():
            results = []
            for focused in (False, True):
                self.reset()
                self.click('#source')
                self.select_token('#测试素材')
                self.panel('+')
                before = self.text()
                folds = self.js('return qa.folds();')
                point = self.point('测试素材', 1)
                self.js('qa.input().focus();' if focused else 'document.querySelector("#source").focus();')
                self.check(self.js('return document.activeElement===qa.input();') == focused, 'drop focus setup failed')
                payload = {'items': [{'mimeType': 'text/plain', 'data': 'blue sky, '}], 'dragOperationsMask': 1}
                for kind in ('dragEnter', 'dragOver', 'drop'):
                    self.cdp.command('Input.dispatchDragEvent', {'type': kind, 'x': point['x'], 'y': point['y'], 'data': payload})
                ui.settle(self.cdp, 70)
                after = self.text()
                self.check(before in after and after != before, 'plain text drop split or replaced a weighted fold')
                self.check(self.js('return qa.folds();') == folds, 'plain text drop changed fold metadata')
                self.key('z', 2)
                self.check(self.text() == before, 'plain text drop undo did not restore weighted fold')
                results.append({'focused': focused, 'before': before, 'after': after})
            return results

        def expand_undo():
            self.click('#source')
            self.select_token('#测试素材')
            before_folds = self.js('return qa.folds();')
            result = self.undo_roundtrip(lambda: self.panel('展开'))
            self.check(ZW not in result['after'] and result['after'] == SOURCE_BODY, 'expanded body differs')
            self.key('z', 2)
            self.check(self.js('return qa.folds();') == before_folds, 'expand undo lost source metadata')
            self.check(self.js('return qa.mirror().querySelectorAll(".pic").length;') == 1, 'expand undo lost thumbnail')
            return result

        def scrolled_drop():
            self.setup_text('blue sky, 中文, soft lighting\n' * 40 + 'target forest')
            self.js('const s=document.querySelector(".relay-editor-surface");s.scrollTop=s.scrollHeight;')
            before = self.text()
            point = self.point('target forest', 9)
            source_json = self.js('return JSON.stringify(qa.source);')
            payload = {'items': [{'mimeType': 'application/x-relay-source', 'data': source_json}], 'dragOperationsMask': 1}
            for kind in ('dragEnter', 'dragOver', 'drop'):
                self.cdp.command('Input.dispatchDragEvent', {'type': kind, 'x': point['x'], 'y': point['y'], 'data': payload})
            ui.settle(self.cdp, 70)
            at = before.index('target forest') + 9
            after = self.text()
            self.check(after.startswith(before[:at]) and after.endswith(before[at:]), 'scrolled drop missed character boundary')
            return {'offset': at, 'tail': after[-80:]}

        def compact_empty():
            self.click(INPUT)
            empty = self.js(r'''
const input=qa.input(),mirror=qa.mirror(),surface=input.parentElement;
const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
const a=getComputedStyle(input),s=getComputedStyle(surface),p=getComputedStyle(mirror,'::after');
const native=Boolean(input.placeholder),hint=native?getComputedStyle(input,'::placeholder'):p;
const frame=surface.parentElement,frameStyle=getComputedStyle(frame);
return {surface:rect(surface),input:rect(input),root:rect(document.querySelector('#editor')),
 frameContentWidth:frame.clientWidth-parseFloat(frameStyle.paddingLeft)-parseFloat(frameStyle.paddingRight),
 emptyClass:surface.classList.contains('empty'),placeholder:input.placeholder||p.content,
 nativePlaceholder:native,placeholderLineHeight:hint.lineHeight,inputLineHeight:a.lineHeight,
 placeholderTop:native?parseFloat(a.paddingTop):parseFloat(p.top),inputTop:parseFloat(a.paddingTop),
 placeholderLeft:native?parseFloat(a.paddingLeft):parseFloat(p.left),inputLeft:parseFloat(a.paddingLeft),
 border:s.borderTopWidth,shadow:s.boxShadow,selection:[input.selectionStart,input.selectionEnd],
 panelHidden:document.querySelector('.relay-token-panel').hidden};''')
            self.check(not empty['emptyClass'], 'editor reused the site-wide empty layout class')
            self.check(empty['surface']['height'] <= 66, 'empty editor is still a tall box: ' + repr(empty))
            self.check(abs(empty['surface']['width'] - empty['frameContentWidth']) <= 1, 'empty editor does not span its padded frame')
            self.check(empty['border'] == '0px' and empty['shadow'] == 'none', 'empty editor still has a framed focus box')
            self.check(empty['placeholder'] not in ('', 'none', 'normal'), 'empty editor lost its hint')
            self.check(empty['placeholderLineHeight'] == empty['inputLineHeight'] and
                       abs(empty['placeholderTop'] - empty['inputTop']) < .5 and
                       abs(empty['placeholderLeft'] - empty['inputLeft']) < .5,
                       'placeholder and caret line origins differ: ' + repr(empty))
            self.check(empty['selection'] == [0, 0] and empty['panelHidden'], 'empty editor focus or actions state is wrong')
            self.screenshot('compact-empty-focused')
            self.type('blue sky')
            typed = self.assert_geometry('compact-one-line')
            self.check(typed['surface']['height'] <= 66, 'one line immediately opens a tall editor')
            self.type('\nforest\nsoft lighting')
            grown = self.geometry()
            self.check(grown['surface']['height'] > typed['surface']['height'], 'editor did not grow with text')
            return {'empty': empty, 'oneLine': typed['surface'], 'threeLines': grown['surface']}

        def plain_unframed():
            self.setup_text('blue sky, forest, {soft lighting}')
            before = self.text()
            point = self.point('forest', 3)
            self.click_point(point)
            styles = self.js(r'''
return [...qa.mirror().querySelectorAll('.relay-token')].map(e=>{
 const s=getComputedStyle(e);return {text:e.firstChild.textContent,background:s.backgroundColor,
 shadow:s.boxShadow,border:s.borderTopWidth,outline:s.outlineStyle}
});''')
            for style in styles:
                self.check(style['background'] == 'rgba(0, 0, 0, 0)' and style['shadow'] == 'none' and
                           style['border'] == '0px' and style['outline'] == 'none',
                           'plain token acquired a decorative frame: ' + repr(style))
            caret = self.js('const i=qa.input();return [i.selectionStart,i.selectionEnd];')
            expected = before.index('forest') + 3
            self.check(caret == [expected, expected], 'plain token click was intercepted instead of moving caret')
            self.check(self.js('return !document.querySelector(".relay-token-panel").hidden;'), 'plain token click did not open contextual actions')
            self.type('X')
            self.check(self.text() == before[:expected] + 'X' + before[expected:], 'ordinary token cannot be edited at its clicked character')
            self.check(self.js('return document.querySelector(".relay-token-panel").hidden;'), 'typing left stale token actions visible')
            self.screenshot('plain-tags-unframed')
            return {'styles': styles, 'caret': caret, 'text': self.text()}

        def thumbnail_below_title():
            self.click('#source')
            self.type('\nblue sky')
            evidence = self.js(r'''
const token=qa.mirror().querySelector('.is-fold'),pic=token.querySelector('.pic'),note=token.querySelector('.zh');
const range=document.createRange();range.selectNodeContents(token.firstChild);
const rect=r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height});
const a=range.getBoundingClientRect(),b=pic.getBoundingClientRect();
const count=document.createRange();count.selectNodeContents(note.lastChild);const c=count.getBoundingClientRect();
const next=document.createRange();next.selectNodeContents(token.nextElementSibling.firstChild);const d=next.getBoundingClientRect();
return {title:rect(a),image:rect(b),count:rect(c),nextTitle:rect(d),imageInNote:note.contains(pic),
 overlaps:Math.min(a.right,b.right)>Math.max(a.left,b.left)&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top),
 tokenBackground:getComputedStyle(token).backgroundColor,tokenShadow:getComputedStyle(token).boxShadow,
 panelHidden:document.querySelector('.relay-token-panel').hidden};''')
            self.check(evidence['imageInNote'], 'thumbnail is outside the annotation row')
            self.check(not evidence['overlaps'], 'thumbnail covers the material title: ' + repr(evidence))
            self.check(evidence['image']['right'] <= evidence['count']['left'], 'thumbnail covers the item count')
            self.check(evidence['count']['top'] >= evidence['title']['bottom'], 'item count covers the material title')
            self.check(max(evidence['image']['bottom'], evidence['count']['bottom']) <= evidence['nextTitle']['top'], 'annotation overlaps the next text line')
            self.check(evidence['tokenBackground'] == 'rgba(0, 0, 0, 0)' and evidence['tokenShadow'] == 'none', 'fold still has a persistent theme-color box')
            self.check(evidence['panelHidden'], 'inserting material opened optional actions')
            self.screenshot('thumbnail-annotation-row')
            return evidence

        def click_fold_actions_and_edit():
            self.setup_text('blue sky, ')
            self.click('#source')
            self.type(', forest')
            before = self.text()
            metadata = self.js('return qa.folds();')
            start = before.index(ZW + '#')
            end = before.index(ZW, start + 1) + 1
            expanded = before[:start] + SOURCE_BODY + before[end:]
            self.click_point(self.point('测试素材', 2))
            self.check(self.text() == before, 'single material click changed the folded group')
            actions = self.js('return [...document.querySelectorAll(".relay-token-panel button")].map(e=>e.textContent);')
            self.check(not self.js('return document.querySelector(".relay-token-panel").hidden;') and '+' in actions and '禁用' in actions and '展开' in actions, 'single material click did not expose group actions: ' + repr(actions))
            self.check(not self.js('return !!document.querySelector(".relay-token-actions-toggle");'), 'obsolete standalone actions toggle remains')
            self.click_point(self.point('测试素材', 2), count=2)
            self.check(self.text() == expanded, 'double material click did not expand in place')
            selection = self.js('const i=qa.input();return {start:i.selectionStart,end:i.selectionEnd,focused:document.activeElement===i};')
            self.check(selection == {'start': start, 'end': start, 'focused': True}, 'direct edit did not preserve focus and place caret at body start: ' + repr(selection))
            self.check(self.js('return document.querySelector(".relay-token-panel").hidden;'), 'expanding left stale group actions visible')
            self.key('z', 2)
            self.check(self.text() == before and self.js('return qa.folds();') == metadata, 'one undo did not restore original group and metadata')
            self.click_point(self.point('测试素材', 2), count=2)
            self.check(self.text() == expanded, 'double click did not restore in-place expansion')
            self.type('portrait, ')
            typed = before[:start] + 'portrait, ' + SOURCE_BODY + before[end:]
            self.check(self.text() == typed, 'typing after expansion did not edit the group body directly')
            self.key('z', 2)
            self.check(self.text() == expanded, 'typing was merged into the expansion undo transaction')
            self.key('z', 2)
            self.check(self.text() == before and self.js('return qa.folds();') == metadata, 'undo after typing did not restore fold metadata')
            self.check(self.js('return qa.mirror().querySelectorAll(".pic").length;') == 1, 'undo lost group thumbnail')
            self.screenshot('direct-edit-undo-restored')
            return {'before': before, 'expanded': expanded, 'typed': typed, 'selectionAfterClick': selection}

        def drag_across_fold():
            self.setup_text('blue sky, ')
            self.click('#source')
            self.type(', forest')
            before = self.text()
            metadata = self.js('return qa.folds();')
            # Include a drag starting on the group label: mouse release must not
            # turn a completed native selection into a group expansion.
            selections = []
            for left, right in [(('blue sky', 3), ('forest', 3)), (('测试素材', 1), ('forest', 4))]:
                self.key('End', 2)
                self.drag_points(self.point(*left), self.point(*right))
                selected = self.js('const i=qa.input();return i.value.slice(i.selectionStart,i.selectionEnd);')
                self.check(ZW + '#测试素材' in selected, 'drag selection did not include the whole group: ' + repr({'selected': selected, 'text': self.text(), 'from': left, 'to': right}))
                self.check(self.text() == before and self.js('return qa.folds();') == metadata, 'drag selection expanded or changed a group')
                self.check(self.js('return !document.querySelector(".relay-token-panel").hidden && document.querySelector(".relay-token-panel").textContent.includes("展开所选词组");'), 'drag selection did not expose group selection actions')
                selections.append(selected)
            self.screenshot('drag-fold-selection')
            return {'text': before, 'selections': selections}

        def shift_select_fold():
            self.setup_text('blue sky, ')
            self.click('#source')
            self.type(', forest')
            before = self.text()
            self.click_point(self.point('blue sky', 3))
            point = self.point('测试素材', 2)
            for kind in ('mousePressed', 'mouseReleased'):
                self.cdp.command('Input.dispatchMouseEvent', {'type': kind, 'button': 'left', 'clickCount': 1,
                    'modifiers': 8, 'x': point['x'], 'y': point['y']})
            ui.settle(self.cdp, 70)
            selected = self.js('const i=qa.input();return i.value.slice(i.selectionStart,i.selectionEnd);')
            self.check(self.text() == before, 'Shift+click expanded a group instead of extending selection')
            self.check(ZW + '#测试素材' in selected, 'Shift+click did not extend native selection into the group')
            self.check(self.js('return !document.querySelector(".relay-token-panel").hidden && document.querySelector(".relay-token-panel").textContent.includes("展开所选词组");'), 'Shift+click did not expose selection actions')
            return {'text': before, 'selection': selected}

        def plain_click_and_fold_selection():
            self.setup_text('blue sky, forest, soft lighting')
            before = self.text()
            self.select_token('forest')
            self.check(self.js('return !document.querySelector(".relay-token-panel").hidden && document.querySelector(".relay-token-name").textContent === "forest";'), 'single plain tag click did not open its own actions')
            self.panel('+')
            self.check('1.1::forest::' in self.text(), 'single tag weight action did not work')
            self.key('z', 2)
            self.check(self.text() == before, 'single tag weight undo changed other content')
            self.drag_points(self.point('blue sky'), self.point('forest', 6))
            selected = self.js('const i=qa.input();return i.value.slice(i.selectionStart,i.selectionEnd);')
            self.check(selected == 'blue sky, forest', 'native drag did not select the expected text: ' + repr(selected))
            self.panel('折叠为词组')
            self.check(self.text() == ZW + '#词组' + ZW + ', soft lighting', 'selection did not fold in place')
            self.check(self.js('return qa.folds()["词组"].body;') == selected and self.output() == before, 'folding changed copied output')
            self.key('z', 2)
            self.check(self.text() == before, 'one undo did not restore the selected text')
            self.screenshot('selection-fold-undo')
            return {'selected': selected, 'output': self.output()}

        def selected_groups_to_text():
            self.setup_text('blue sky, ')
            self.click('#source')
            self.type(', forest')
            before, output = self.text(), self.output()
            self.key('a', 2)
            self.panel('展开所选词组')
            self.check(ZW not in self.text() and self.output() == output, 'expanding selected groups changed output')
            self.panel('折叠为词组')
            self.check(self.text() == ZW + '#词组' + ZW and self.output() == output, 'group selection did not fold into one group')
            self.key('z', 2)
            self.key('z', 2)
            self.check(self.text() == before, 'two undos did not restore the original selected groups')
            return {'output': output}

        def channel_keyboard():
            self.setup_text('blue sky')
            self.click('#relayEditorTab-positive')
            self.key('ArrowRight')
            self.check(self.js('return document.activeElement.id === "relayEditorTab-negative" && document.querySelector("#relayEditorTab-negative").getAttribute("aria-selected") === "true";'), 'ArrowRight did not switch and focus the negative tab')
            self.click('#relayEditorSurface-negative textarea')
            self.type('lowres')
            self.click('#relayEditorTab-negative')
            self.key('Home')
            result = self.js('return {positive:qa.input().value,negative:qa.editor.getSession().negative.text,surfaces:document.querySelectorAll(".relay-editor-surface:not([hidden])").length,frames:document.querySelectorAll(".relay-editor-frame:not([hidden])").length,panelHidden:document.querySelector(".relay-token-panel").hidden};')
            self.check(result == {'positive': 'blue sky', 'negative': 'lowres', 'surfaces': 1, 'frames': 1, 'panelHidden': True}, 'channel switching lost text or exposed both editors: ' + repr(result))
            return result

        cases = [("01-layout-mixed", mixed_geometry), ("01-layout-long-word", long_geometry),
                 ("01-layout-scroll", scroll_geometry), ("02-type-after-fold", after_fold),
                 ("03-type-between-folds", between_folds), ("05-undo-typing", undo_typing),
                 ("05-undo-weight", undo_weight), ("05-undo-disable", undo_disable),
                 ("05-undo-insert", undo_insert), ("05-undo-panel-delete", undo_remove),
                 ("06-atomic-backspace", atomic_backspace), ("06-atomic-delete", atomic_delete),
                 ("06-atomic-selection", atomic_selection),
                 ("07-native-selection-clipboard", selection_clipboard), ("08-syntax-boundaries", syntax),
                 ("09-duplicate-weight-scope", duplicates), ("10-character-drop", drop_at_character),
                 ("10-splice-fallback", fallback), ("10-fallback-typing-order", fallback_typing),
                 ("10-zero-width-guards", scrub_guards)]
        cases += [('06-weighted-atomic', weighted_atomic), ('04-composition-protocol', composition_supplement),
                  ('10-weighted-syntax', weighted_syntax), ('10-weight-domain', weight_domain),
                  ('10-drop-on-fold', drop_on_fold), ('10-plain-drop', plain_drop),
                  ('10-plain-drop-on-fold', plain_drop_on_fold),
                  ('05-expand-undo-metadata', expand_undo), ('10-scrolled-character-drop', scrolled_drop)]
        cases += [('11-compact-empty', compact_empty), ('11-plain-unframed', plain_unframed),
                  ('11-thumbnail-below-title', thumbnail_below_title), ('11-click-fold-actions-double-edit', click_fold_actions_and_edit),
                  ('11-drag-fold-no-expansion', drag_across_fold), ('11-shift-fold-no-expansion', shift_select_fold)]
        cases += [('12-plain-click-selection-fold', plain_click_and_fold_selection),
                  ('12-selected-groups-fold', selected_groups_to_text), ('12-channel-keyboard', channel_keyboard)]
        for name, callback in cases:
            if not only or only in name:
                self.test(name, callback)
        return self.results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--only", default="", help="只跑名称包含此字符串的测试")
    args = parser.parse_args()
    out = args.out_dir.resolve()
    out.mkdir(parents=True, exist_ok=True)
    # Only site/assets plus the in-memory fixture are served, never private repository files.
    handler = functools.partial(FixtureHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}/"
    chrome = cdp = None
    results = []
    try:
        port = ui.find_free_port()
        chrome = ui.start_chrome(out, port)
        cdp = ui.CDP(ui.page_ws_url(port))
        results = Suite(cdp, base, out).run(args.only)
    finally:
        if cdp:
            cdp.close()
        if chrome:
            chrome.terminate()
            try:
                chrome.wait(timeout=5)
            except Exception:
                chrome.kill()
        server.shutdown()
        server.server_close()
    hashes = {}
    for filename in ["site/assets/app/tag-relay-editor.js", "site/assets/app/tag-relay-text.js", "site/assets/tag-relay.css", "tools/verify_relay_editor.py"]:
        path = ROOT / filename
        hashes[filename] = hashlib.sha256(path.read_bytes()).hexdigest()
    metadata = {"browser": ui.find_chrome(), "sourceSha256": hashes,
                "coverage": "隔离 Chrome 内核夹具；真实 CSS；CDP 鼠标/键盘/拖放。不是完整侧栏或实体设备验收。",
                "notVerified": ["第 4 项：真实系统中文输入法", "第 7 项：维护者真机手感复核", "实体手机软键盘/长按选择"]}
    (out / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = ["# 编辑器内核自动化验收", "", metadata["coverage"], "", "| 用例 | 结果 |", "| --- | --- |"]
    lines.extend(f"| {r['name']} | {'通过' if r['ok'] else '失败'} |" for r in results)
    lines.extend(["", "未验：" + "；".join(metadata["notVerified"]), "", "逐项证据：results.json；浏览器与源码哈希：metadata.json。"])
    (out / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    passed = sum(r["ok"] for r in results)
    print(f"{passed}/{len(results)} passed; report: {out / 'report.md'}", flush=True)
    return 0 if results and passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
