"""收藏夹操作链：独立 Chrome、真实鼠标/键盘、动效开启；仅允许回环预览。"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import traceback
from pathlib import Path
from urllib.parse import urlsplit
import verify_ui as ui

ROOT = Path(__file__).resolve().parents[1]


def run(base, out, cdp):
    results = []
    cdp.command('Page.enable')
    cdp.command('Page.addScriptToEvaluateOnNewDocument', {'source': "localStorage.setItem('fadian-onboarding-v1','done');localStorage.setItem('fadian-resume-prompt','never');localStorage.setItem('fadian-motion','on');"})
    ui.install_error_capture(cdp)

    def js(code):
        return cdp.eval('(async()=>{' + code + '})()', timeout=30)

    def wait(expr, name='state'):
        return ui.wait_for(cdp, expr, name, timeout=30)

    def key(name, modifiers=0):
        code = 'Space' if name == ' ' else 'KeyA' if name == 'a' else name
        vk = {'a': 65, ' ': 32, 'Tab': 9, 'Enter': 13, 'Escape': 27, 'Home': 36, 'End': 35,
              'ArrowLeft': 37, 'ArrowUp': 38, 'ArrowRight': 39, 'ArrowDown': 40}.get(name, 0)
        event = {'key': name, 'code': code, 'modifiers': modifiers, 'windowsVirtualKeyCode': vk}
        cdp.command('Input.dispatchKeyEvent', {'type': 'keyDown', **event})
        cdp.command('Input.dispatchKeyEvent', {'type': 'keyUp', **event})
        ui.settle(cdp, 60)

    def click(selector, delay=300):
        # Scroll first, then measure after layout settles; verify the actual hit target.
        encoded = json.dumps(selector)
        wait("!document.documentElement.classList.contains('vt-codex')", 'view transition completed')
        if selector != '.n5-notice-close' and js("const b=document.querySelector('.n5-notice-close');if(!b)return false;const r=b.getBoundingClientRect(),t=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return Boolean(r.width&&(b===t||b.contains(t)));"):
            click('.n5-notice-close')
        js(f"const e=document.querySelector({encoded});if(!e)throw Error('missing '+{encoded});e.scrollIntoView({{block:'center',behavior:'instant'}});")
        ui.settle(cdp, 180)
        point = js(f"const e=document.querySelector({encoded}),r=e.getBoundingClientRect();return {{x:r.x+r.width/2,y:r.y+r.height/2}};")
        cdp.command('Input.dispatchMouseEvent', {'type': 'mouseMoved', **point})
        ui.settle(cdp, 100)
        hit = js(f"const e=document.querySelector({encoded}),t=document.elementFromPoint({point['x']},{point['y']});return {{ok:e===t||e.contains(t),target:t?.outerHTML.slice(0,240)}};")
        if not hit['ok']:
            raise ui.CheckFailed(f'click blocked: {selector}: {hit}')
        cdp.command('Input.dispatchMouseEvent', {'type': 'mousePressed', 'button': 'left', 'clickCount': 1, **point})
        cdp.command('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'button': 'left', 'clickCount': 1, **point})
        if delay:
            ui.settle(cdp, delay)

    def fill(selector, value):
        click(selector, 40)
        key('a', 2)
        cdp.command('Input.insertText', {'text': value})
        ui.settle(cdp, 80)
        check('document.querySelector(' + json.dumps(selector) + ').value===' + json.dumps(value), 'keyboard replacement entered the requested value')

    def viewport(width, height=900):
        cdp.command('Emulation.setDeviceMetricsOverride', {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': width < 600})
        ui.settle(cdp, 650)

    def check(condition, message):
        if not js('return Boolean(' + condition + ');'):
            focus = js("return {focus:document.activeElement?.outerHTML.slice(0,350),layers:history.state?.layers};")
            raise ui.CheckFailed(message + ': ' + str(focus))

    def test(name, callback):
        try:
            evidence = callback()
            ui.check_no_errors(cdp)
            results.append({'name': name, 'ok': True, 'evidence': evidence})
        except Exception:
            results.append({'name': name, 'ok': False, 'error': traceback.format_exc()})
            ui.screenshot(cdp, out, 'failure-' + str(len(results)))
            raise
        finally:
            (out / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
            print(('PASS ' if results[-1]['ok'] else 'FAIL ') + name, flush=True)

    def modules():
        js("window.qa={};for(const[n,f]of Object.entries({app:'../app.js',state:'state.js',view:'favorites-view.js',fav:'favorites.js',core:'favorites-library-core.js',store:'favorites-library-store.js',blocking:'content-blocking.js',lightbox:'lightbox.js',history:'browser-history.js'}))qa[n]=await import('/assets/app/'+f);qa.s=qa.state.state;")

    viewport(1280)
    ui.navigate(cdp, base + '?c=suozhang')
    wait("document.querySelectorAll('.card').length>0", 'source')
    modules()
    js("await qa.store.commitLibrary(d=>{d.items=[];d.folders=[];d.memberships=[];for(const e of qa.s.codex.entries.filter(e=>e.image||e.images?.length).slice(0,6))qa.core.addLibraryItem(d,'suozhang:'+e.id,{codexes:qa.s.codexes});});await qa.app.openFavoritesView({transition:'none'});")
    wait("document.querySelectorAll('.favorite-library-card').length===6", 'favorites')
    ui.settle(cdp, 900)
    if js("return Boolean(document.querySelector('.n5-notice-close'));"):
        click('.n5-notice-close')

    def create_name():
        click('.favorites-new-button', 0)
        timings = js("return document.querySelector('#favoritesDialog').getAnimations({subtree:true}).map(a=>a.effect.getTiming().duration);")
        fill('#favoritesFolderName', '画风参考与角色服装收藏夹')
        width = js("return document.querySelector('#favoritesFolderName').getBoundingClientRect().width;")
        check("document.querySelector('#favoritesDialog .panel-action') && document.querySelector('#favoritesDialog .settings-panel')", 'shared components')
        if width < 280 or not timings:
            raise ui.CheckFailed(f'name width/motion: {width}, {timings}')
        ui.screenshot(cdp, out, 'desktop-name')
        click('#favoritesDialog button[type=submit]')
        wait("!document.querySelector('#favoritesDialog').classList.contains('show')")
        ui.settle(cdp, 300)
        check("document.activeElement.classList.contains('favorites-folder-open')", 'created folder focus')
        js("qa.folderA=qa.store.librarySnapshot().folders[0].id;")
        return {'inputWidth': width, 'transitionDurations': timings}
    test('shared name dialog and successful focus', create_name)

    def busy_name_focus():
        click('.favorites-new-button')
        fill('#favoritesFolderName', '保存等待检查')
        js("qa.lockReady=false;qa.lockPromise=navigator.locks.request(qa.store.LIBRARY_LOCK_KEY,()=>new Promise(resolve=>{qa.releaseLock=resolve;qa.lockReady=true}));")
        wait('qa.lockReady')
        try:
            click('#favoritesDialog button[type=submit]', 60)
            check("document.querySelector('.favorites-name-form').getAttribute('aria-busy')==='true'", 'name save is waiting')
            for _ in range(4):
                key('Tab')
                check("document.querySelector('#favoritesDialog').contains(document.activeElement)", 'Tab stays inside pending name dialog')
            key('Tab', 8)
            check("document.querySelector('#favoritesDialog').contains(document.activeElement)", 'Shift Tab stays inside pending name dialog')
        finally:
            js('qa.releaseLock();await qa.lockPromise;')
        wait("!document.querySelector('#favoritesDialog').classList.contains('show')")
        ui.settle(cdp, 300)
        check("document.activeElement.classList.contains('favorites-folder-open')", 'pending save returns focus after success')
        return {'pendingTabSteps': 5, 'focusRestored': True}
    test('pending name save retains keyboard focus', busy_name_focus)

    def backup_focus():
        click('.favorites-head-more')
        click('#favoritesViewBackupBtn')
        check("document.querySelector('#favoritesBackupPanel').classList.contains('show')", 'backup opens from menu')
        key('Escape')
        ui.settle(cdp, 300)
        check("document.querySelector('#favoritesBackupPanel').hidden && document.activeElement.classList.contains('favorites-head-more')", 'backup closes back to current more button')
        return {'focus': 'favorites-head-more'}
    test('backup returns focus to the current more button', backup_focus)

    def organize_chain():
        click('.favorite-organize-button')
        fill('#favoritesOrganizeSearch', '不同于新名称的查询')
        click('#favoritesOrganizeCreate')
        fill('#favoritesFolderName', '角色参考')
        click('#favoritesDialog button[type=submit]')
        ui.settle(cdp, 300)
        check("document.activeElement.matches('[data-folder-check]')", 'new membership row focus')
        check("document.querySelector('#favoritesOrganizeSearch').value===''", 'new folder clears the previous search')
        js("qa.folderB=qa.store.librarySnapshot().folders.find(f=>f.name==='角色参考').id;")
        click('[data-folder-check="' + js('return qa.folderA;') + '"]')
        check("document.activeElement.matches('[data-folder-check]')", 'membership commit keeps row focus')
        key(' ')
        ui.settle(cdp, 250)
        check("document.activeElement.getAttribute('aria-checked')==='false'", 'Space removes one membership')
        key(' ')
        ui.settle(cdp, 250)
        check("document.activeElement.getAttribute('aria-checked')==='true'", 'Space restores one membership')
        key('?')
        check("document.querySelector('#shortcutHelp').hidden", 'help must not open under organize')
        key('Escape')
        ui.settle(cdp, 300)
        check("!document.querySelector('#favoritesOrganize').classList.contains('show') && document.activeElement.classList.contains('favorite-organize-button')", 'Esc closes and restores card action')
        return js('return {memberships:qa.store.librarySnapshot().memberships.length,focus:document.activeElement.className};')
    test('single item create membership and keyboard continuation', organize_chain)

    def sort_chain():
        click('.favorites-sort button')
        check("document.querySelector('.favorites-sort [role=listbox]') && !document.querySelector('select.favorites-sort')", 'custom shared listbox')
        key('End'); key('Enter')
        check("qa.s.favSort==='title' && document.activeElement.matches('.ui-select-button')", 'keyboard sort and return focus')
        click('.favorites-sort button')
        key('Home'); key('Enter')
        return js('return {sort:qa.s.favSort,label:document.querySelector(".favorites-sort button").textContent};')
    test('shared sort keyboard and focus', sort_chain)

    def batch_chain():
        click('.favorites-selection-toggle')
        click('.favorite-library-card')
        check('qa.s.favSelected.size===1', 'select one')
        click('.favorites-selection-toggle')
        check('!qa.s.favSelecting', 'second click exits')
        click('.favorites-selection-toggle'); click('.favorite-library-card')
        fill('#search', 'zzzznoresultzzzz')
        wait('qa.s.list.length===0', 'empty search')
        check("qa.s.favSelected.size===0 && document.querySelector('[data-fav-batch=\"取消收藏\"]').disabled", 'hidden selection excluded')
        check('qa.store.librarySnapshot().items.length===6', 'hidden items stay saved')
        click('#searchClear')
        wait('qa.s.list.length===6')
        check('qa.s.favSelected.size===0', 'cleared filter does not resurrect selection')
        click('.favorites-selection-toggle')
        return {'stored': 6, 'selectedAfterFilter': 0}
    test('batch toggle and filtering action scope', batch_chain)

    def batch_slow_save():
        click('.favorites-selection-toggle')
        click('.favorite-library-card')
        js("qa.removing=[...qa.s.favSelected][0];qa.nextKey=qa.fav.favKey(qa.s.list[1]);qa.lockReady=false;qa.lockPromise=navigator.locks.request(qa.store.LIBRARY_LOCK_KEY,()=>new Promise(resolve=>{qa.releaseLock=resolve;qa.lockReady=true}));")
        wait('qa.lockReady')
        try:
            click('[data-fav-batch="取消收藏"]', 80)
            click('[data-fav-batch="取消收藏"]', 80)
            check("document.querySelector('#favoritesBatchBar').getAttribute('aria-busy')==='true'", 'batch waits without reentry')
            click('.favorites-selection-toggle')
            click('.favorites-selection-toggle')
            click('[data-favorite-key=' + json.dumps(js('return qa.nextKey;')) + ']')
        finally:
            js('qa.releaseLock();await qa.lockPromise;')
        wait("document.querySelector('#favoritesBatchBar').getAttribute('aria-busy')==='false'")
        check('qa.store.librarySnapshot().items.length===5 && qa.s.favSelected.has(qa.nextKey)', 'old removal preserves new session choice')
        check("document.querySelector('#toast').getBoundingClientRect().bottom < document.querySelector('#favoritesBatchBar').getBoundingClientRect().top", 'undo message does not cover the batch controls')
        click('.toast-action')
        wait('qa.store.librarySnapshot().items.length===6')
        check('qa.store.librarySnapshot().items.some(i=>i.key===qa.removing)', 'double click leaves a working undo')
        check("getComputedStyle(document.querySelector('#toast')).pointerEvents==='none'", 'hidden actionable toast releases pointer input')
        click('.favorites-selection-toggle')
        click('[data-folder-id=' + json.dumps(js('return qa.folderA;')) + '] .favorites-folder-open')
        click('.favorites-selection-toggle'); click('.favorite-library-card')
        js("qa.lockReady=false;qa.lockPromise=navigator.locks.request(qa.store.LIBRARY_LOCK_KEY,()=>new Promise(resolve=>{qa.releaseLock=resolve;qa.lockReady=true}));")
        wait('qa.lockReady')
        try:
            click('[data-fav-batch="移出本夹"]', 80)
            click('[data-fav-batch="移出本夹"]', 80)
        finally:
            js('qa.releaseLock();await qa.lockPromise;')
        wait('qa.s.list.length===0')
        click('.toast-action')
        wait('qa.s.list.length===1')
        check('qa.store.librarySnapshot().items.length===6', 'membership undo retains saved items')
        click('.favorites-selection-toggle')
        click('[data-folder-id=""] .favorites-folder-open')
        return {'duplicateRemoveUndo': True, 'newSelectionKept': True, 'duplicateMoveUndo': True}
    test('slow batch reentry undo and new selection session', batch_slow_save)

    def empty_scope():
        js("await qa.store.commitLibrary(d=>qa.core.createFolder(d,'空夹',{id:'empty-qa'}));qa.blocking.hideContentEntry(qa.s.list[0]);")
        ui.settle(cdp, 400)
        click('[data-folder-id="empty-qa"] .favorites-folder-open')
        check("qa.s.list.length===0 && document.querySelector('#blockingResultBtn').hidden && !document.querySelector('#empty').textContent.includes('全部屏蔽')", 'empty folder scope')
        click('#empty .panel-action')
        check("qa.s.favFolder==='' && qa.s.favSelecting && qa.s.list.length===5", 'empty action has executable destination')
        click('.favorites-selection-toggle')
        check("document.querySelector('#blockingResultBtn').textContent.includes('1') && !document.querySelector('.favorite-library-card .hide-card-btn')", 'context count and card operation surface')
        return {'emptyCount': 0, 'allVisible': 5}
    test('empty folder blocked count and actionable guidance', empty_scope)

    def nested_keyboard():
        click('.favorite-library-card .zoom-btn')
        wait("document.querySelector('#lightbox').classList.contains('is-open')")
        js("qa.lightboxBefore=qa.s.lightbox.entry.id;await qa.view.openOrganize([qa.fav.favKey(qa.s.lightbox.entry)]);")
        ui.settle(cdp, 300)
        click('#favoritesOrganize .favorites-dialog-footer button:last-child', 0)
        # Reopen, then move focus without closing to exercise the modal over a live lightbox.
        ui.settle(cdp, 350)
        js("await qa.view.openOrganize([qa.fav.favKey(qa.s.lightbox.entry)]);document.querySelector('#favoritesOrganize .favorites-dialog-footer button:last-child').focus();")
        ui.settle(cdp, 300)
        key('ArrowRight'); key('?')
        check("qa.s.lightbox.entry.id===qa.lightboxBefore && document.querySelector('#shortcutHelp').hidden", 'underlying shortcuts isolated')
        key('Escape'); ui.settle(cdp, 300)
        check("!document.querySelector('#favoritesOrganize').classList.contains('show') && document.querySelector('#lightbox').classList.contains('is-open')", 'one Esc closes one layer')
        key('Escape'); ui.settle(cdp, 350)
        return {'lightboxKeptEntry': True}
    test('nested organize isolates help and lightbox keys', nested_keyboard)

    def mobile_chain(width):
        viewport(width, 844)
        click('#menuBtn')
        check("document.querySelector('#favoritesDrawer').classList.contains('show')", 'drawer opens')
        click('.favorites-new-button')
        fill('#favoritesFolderName', '移动端名称可完整输入')
        size = js("const r=document.querySelector('#favoritesFolderName').getBoundingClientRect();return {width:r.width,height:r.height};")
        ui.screenshot(cdp, out, 'mobile-name-' + str(width))
        key('Escape'); ui.settle(cdp, 300)
        check("document.querySelector('#favoritesDrawer').classList.contains('show') && document.activeElement.classList.contains('favorites-new-button')", 'cancel returns to mobile opener')
        key('Escape'); ui.settle(cdp, 300)
        click('.favorites-sort button')
        bounds = js("const r=document.querySelector('.favorites-sort [role=listbox]').getBoundingClientRect();return {left:r.left,right:r.right};")
        if bounds['left'] < 0 or bounds['right'] > width:
            raise ui.CheckFailed(f'sort outside mobile viewport: {bounds}')
        ui.screenshot(cdp, out, 'mobile-sort-' + str(width))
        key('Escape')
        wait("getComputedStyle(document.querySelector('.favorites-sort [role=listbox]')).display==='none'", 'sort exit completed before static screenshot')
        # 手机卡片主体统一开详情，整理走批量入口；隐藏的桌面整理按钮不能进入焦点序列。
        hidden_action = js("const b=document.querySelector('.favorite-organize-button');b.focus();return {hidden:!b.getClientRects().length,focusable:document.activeElement===b};")
        if not hidden_action['hidden'] or hidden_action['focusable']:
            raise ui.CheckFailed(f'desktop organize action exposed on mobile: {hidden_action}')
        click('.favorite-library-card .card-img-wrap')
        wait("document.querySelector('#lightbox').classList.contains('is-open')", 'mobile card opens detail')
        key('Escape'); ui.settle(cdp, 350)
        click('.favorites-selection-toggle')
        click('.favorite-library-card .card-img-wrap')
        check('qa.s.favSelected.size===1', 'mobile card selects one item')
        action = js("const b=document.querySelector('[data-fav-batch=\"加入收藏夹\"]'),r=b.getBoundingClientRect();return {width:r.width,height:r.height,disabled:b.disabled};")
        if action['height'] < 44 or action['width'] < 44 or action['disabled']:
            raise ui.CheckFailed(f'mobile organize action unavailable or small: {action}')
        click('[data-fav-batch="加入收藏夹"]')
        wait("document.querySelector('#favoritesOrganize').classList.contains('show')", 'mobile batch organize opens')
        check("document.querySelector('#favoritesOrganize').contains(document.activeElement)", 'mobile organize receives focus')
        key('Escape'); ui.settle(cdp, 350)
        check("document.activeElement.dataset.favBatch==='加入收藏夹'", 'mobile organize returns to batch opener')
        click('[data-fav-batch="完成"]')
        check('!qa.s.favSelecting', 'mobile batch selection closes')
        check('document.documentElement.scrollWidth<=innerWidth', 'no horizontal page overflow')
        ui.screenshot(cdp, out, 'mobile-library-' + str(width))
        return {'name': size, 'sortBounds': bounds, 'hiddenDesktopAction': hidden_action, 'detailOpened': True, 'batchOrganize': action}
    for width in (390, 320):
        test('mobile direct operations ' + str(width), lambda width=width: mobile_chain(width))

    def breakpoints():
        viewport(859)
        viewport(860)
        check("document.querySelector('#favoritesRail').parentElement.id==='sidebar'", '1px crossing moves rail')
        viewport(859)
        check("document.querySelector('#favoritesRail').parentElement.id==='favoritesDrawerRail'", '1px return moves rail')
        parent = js('return qa.history.getManagedHistoryEntry().id;')
        click('#menuBtn')
        viewport(1280)
        ui.settle(cdp, 350)
        check("!document.querySelector('#favoritesDrawer').classList.contains('show') && !document.body.classList.contains('favorites-modal-open') && qa.history.topHistoryLayerId()!=='favoritesDrawer'", 'resize closes drawer and layer')
        check('qa.history.getManagedHistoryEntry().id===' + json.dumps(parent), 'resize consumes original drawer session')
        return {'parentRestored': True}
    test('one pixel breakpoints and drawer history consumption', breakpoints)

    def late_open():
        js("qa.view.setFavoritesViewActions({prepareEntries:()=>new Promise(resolve=>qa.releasePrepare=resolve)});")
        click('.favorite-organize-button', 0)
        wait('typeof qa.releasePrepare==="function"')
        js("await qa.app.loadCodex('suozhang',{transition:'none'});qa.releasePrepare();")
        ui.settle(cdp, 400)
        check("!qa.s.favoritesView && !document.querySelector('#favoritesOrganize').classList.contains('show')", 'late request cannot reopen after navigation')
        return {'injection': 'controlled prepareEntries delay', 'reopened': False}
    test('navigation invalidates pending organize request', late_open)

    def no_image_item():
        js("qa.view.setFavoritesViewActions({prepareEntries:async()=>{}});const e=qa.s.codex.entries.find(e=>!e.image&&!e.images?.length);if(!e)throw Error('missing real no-image source fixture');qa.noImageKey=qa.fav.favKey(e);await qa.store.commitLibrary(d=>qa.core.addLibraryItem(d,qa.noImageKey,{codexes:qa.s.codexes}));await qa.app.openFavoritesView({transition:'none'});")
        wait("Boolean(document.querySelector('.favorite-library-card.no-img .card-title-row .favorite-organize-button'))")
        click('.favorite-library-card.no-img .favorite-organize-button')
        check("document.querySelector('#favoritesOrganize').classList.contains('show')", 'no-image item opens direct organize')
        ui.screenshot(cdp, out, 'no-image-organize')
        key('Escape'); ui.settle(cdp, 300)
        check("document.activeElement.closest('.card.no-img') && document.activeElement.classList.contains('favorite-organize-button')", 'no-image returns to title action')
        return {'realSourceKey': js('return qa.noImageKey;'), 'directAction': True}
    test('real no-image favorite supports direct organize', no_image_item)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--out-dir', default=str(ROOT/'output'/'favorites-experience'))
    args = parser.parse_args()
    url = urlsplit(args.base_url)
    if url.scheme != 'http' or url.hostname not in ('localhost', '127.0.0.1') or url.username or url.password:
        parser.error('Only loopback preview is allowed')
    out = Path(args.out_dir).resolve(); out.mkdir(parents=True, exist_ok=True)
    metadata = {'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip(),
                'dirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT)),
                'files': {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in sorted((ROOT/'site').rglob('*')) if p.is_file() and p.suffix in ('.js', '.css', '.html')}}
    (out/'version.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
    chrome = cdp = None
    try:
        if not ui.url_ok(args.base_url):
            raise RuntimeError('Start the configured preview before running this check: ' + args.base_url)
        port = ui.find_free_port(); chrome = ui.start_chrome(out, port); cdp = ui.CDP(ui.page_ws_url(port))
        results = run(args.base_url.rstrip('/')+'/', out, cdp)
        ui.write_report(out, args.base_url, results)
        print('PASS: '+str(len(results))+' experience chains')
        return 0
    except Exception:
        (out/'fatal.txt').write_text(traceback.format_exc(), encoding='utf-8')
        print(traceback.format_exc())
        return 1
    finally:
        if cdp: cdp.close()
        if chrome: chrome.terminate()


if __name__ == '__main__':
    raise SystemExit(main())
