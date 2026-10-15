# -*- coding: utf-8 -*-
"""Read-only UI check with a loopback-only community API and abstract SVG fixtures.

Real site HTML/CSS/JS is served unchanged. Mutations can reach only this in-memory
fixture server; production services and the local data tree are never written.
"""
from __future__ import annotations

import copy
import json
import sys
import threading
import time
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from verify_ui import (CDP, ROOT, check_no_errors, disable_motion, find_free_port,
                       install_error_capture, navigate, page_ws_url, screenshot,
                       settle, start_chrome, wait_for)

OUT = ROOT / 'output' / 'playwright' / 'community-codex'
ENTRY_ID = 'qa-community-001'
ADULT_ID = 'qa-community-adult'
SAFE_TITLES = ['青岚·晨光', '折纸之城', '暮色群山', '海边来信', '月光庭院']


def fixture_entry(index, title, *, adult=False):
    return {
        'id': ADULT_ID if adult else f'qa-community-{index:03d}',
        'title': title, 'prompt': 'misty landscape, soft lighting, pastel colors',
        'negative': 'lowres, blurry',
        'comment': '用于兼容性验收的雾气说明' if index == 1 else '抽象图形测试作品；不包含实际成人素材。',
        'submitter': '测试画师 林青' if index == 1 else f'测试投稿人 {index}',
        'category': ['场景' if index % 2 else '构图'], 'tags': ['抽象', '测试'],
        'nsfw': adult, 'createdAt': 1791806400000 + index,
        'images': [{'file': f'/qa/{index}-a.svg', 'original': f'/qa/{index}-original.svg', 'width': 720, 'height': 920}]
                  + ([{'file': '/qa/1-b.svg', 'original': '/qa/1-b-original.svg', 'width': 920, 'height': 720}] if index == 1 else []),
        'likeCount': 3 + index, 'liked': False,
    }


class Fixtures:
    entries = [fixture_entry(i + 1, title) for i, title in enumerate(SAFE_TITLES)] + [fixture_entry(9, '成人分级测试（抽象图）', adult=True)]
    original = copy.deepcopy(entries)
    requests = []
    submitted = None
    fail_api = False


def svg_image(path):
    number = int(path.split('/')[-1].split('-')[0])
    palettes = [('d2e5db', '658c92', '334965'), ('f6dfc9', 'c88874', '775c7e'),
                ('c7d7ed', '6987b9', '374f80'), ('d6eae2', '83b4aa', '396c77'),
                ('e2d9f2', 'b397ce', '675990')]
    a, b, c = palettes[(number - 1) % len(palettes)]
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="720" height="920" viewBox="0 0 720 920">
      <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#{a}"/><stop offset="1" stop-color="#{b}"/></linearGradient></defs>
      <rect width="720" height="920" fill="url(#sky)"/><circle cx="510" cy="218" r="91" fill="#fff" opacity=".66"/>
      <path d="M-70 750L185 260 475 750Z" fill="#{b}"/><path d="M250 720L534 340 860 800Z" fill="#{c}" opacity=".72"/>
      <path d="M0 680Q190 580 410 745T760 720V920H0Z" fill="#{c}"/>
      <path d="M0 803Q230 739 425 836T760 825V920H0Z" fill="#{b}" opacity=".65"/>
      <text x="48" y="860" fill="#fff" font-family="sans-serif" font-size="20" letter-spacing="5">COMMUNITY / {number:02d}</text></svg>'''.encode()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / 'site'), **kwargs)

    def log_message(self, *_):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def reply(self, payload, *, status=200, content_type='application/json; charset=utf-8'):
        body = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        Fixtures.requests.append(('GET', path))
        if path == '/api/community':
            return self.reply({'error': 'fixture offline'}, status=503) if Fixtures.fail_api else self.reply({
                'title': '共创法典', 'entries': Fixtures.entries, 'features': {'likes': True}, 'revision': str(len(Fixtures.requests))})
        if path.startswith('/api/') or path.startswith('/__edit__/'):
            return self.reply({'error': 'fixture only'}, status=404)
        if path.startswith('/qa/'):
            return self.reply(svg_image(path), content_type='image/svg+xml')
        if path == '/data/codexes.json':
            return self.reply([{'id': 'sample', 'title': '测试法典', 'type': 'codex', 'author': '界面验收',
                                'entryCount': 1, 'imagedCount': 1, 'hasOriginal': False, 'nsfw': False}])
        if path == '/data/sample.json':
            return self.reply({'id': 'sample', 'title': '测试法典', 'type': 'codex', 'entries': [
                {'id': 'sample-0001', 'title': '主站抽象示例', 'tags': 'abstract landscape', 'path': ['示例'],
                 'image': f'http://{self.headers["Host"]}/qa/2-a.svg', 'rating': 'safe'}]})
        if path == '/data/media.json':
            return self.reply({})
        if path == '/data/about.json':
            return self.reply({'links': [], 'tips': [], 'credits': []})
        if path == '/data/announcements.json':
            return self.reply([])
        if path.startswith('/data/'):
            return self.reply({})
        if path == '/strings':
            self.path = '/strings.html' + ('?' + urlparse(self.path).query if urlparse(self.path).query else '')
        if path.startswith('/share/'):
            self.path = '/index.html'
        return super().do_GET()

    def mutate(self):
        path = urlparse(self.path).path
        Fixtures.requests.append((self.command, path))
        if self.command == 'POST' and path == '/api/submit':
            body = self.rfile.read(min(int(self.headers.get('Content-Length', 0)), 1024 * 1024))
            Fixtures.submitted = {'hasImages': b'name="images"' in body,
                                  'hasOriginals': b'name="originals"' in body,
                                  'hasImagesMeta': b'name="imagesMeta"' in body,
                                  'hasNsfw': b'name="nsfw"' in body,
                                  'bytes': len(body)}
            return self.reply({'ok': True, 'id': 'qa-submitted-local'})
        if self.command in ['PUT', 'DELETE'] and path.startswith('/api/community-likes/'):
            entry = next((entry for entry in Fixtures.entries if entry['id'] == path.rsplit('/', 1)[-1]), None)
            if not entry:
                return self.reply({'error': 'not found'}, status=404)
            liked = self.command == 'PUT'
            entry['likeCount'] += int(liked) - int(entry['liked'])
            entry['liked'] = liked
            return self.reply({'ok': True, 'id': entry['id'], 'liked': liked, 'likeCount': entry['likeCount']})
        return self.reply({'error': 'fixture refuses submission'}, status=405)

    do_PUT = mutate
    do_DELETE = mutate
    do_POST = mutate


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    chrome = start_chrome(OUT / str(int(time.time())), find_free_port())
    # Read the port from the exact process argv passed by the existing driver.
    port = int(next(arg.split('=', 1)[1] for arg in chrome.args if str(arg).startswith('--remote-debugging-port=')))
    cdp = None
    results = []
    try:
        cdp = CDP(page_ws_url(port))
        cdp.command('Runtime.enable')
        disable_motion(cdp)
        install_error_capture(cdp)
        seed = """try{if(!localStorage.getItem('qa-community-seeded')){
          localStorage.clear();localStorage.setItem('qa-community-seeded','1');
          localStorage.setItem('fadian-motion','off');localStorage.setItem('fadian-onboarding-v1-done','1');
          localStorage.setItem('fadian-dark-mode','light');localStorage.setItem('fadian-search-scope','codex');
          localStorage.setItem('community-favorites-v1',JSON.stringify(['qa-community-001']));
          localStorage.setItem('fadian-community-submissions-v1',JSON.stringify([
            {id:'qa-community-001',title:'青岚·晨光',createdAt:Date.now()},
            {id:'qa-pending',title:'等待审核的测试投稿',createdAt:Date.now()}]));
        }}catch(e){}"""
        cdp.command('Page.addScriptToEvaluateOnNewDocument', {'source': seed})

        def check(name, function):
            started = time.time()
            try:
                result = function() or {}
                check_no_errors(cdp)
                results.append({'name': name, 'ok': True, 'seconds': round(time.time() - started, 2), 'detail': result})
                print(f'PASS {name}', flush=True)
            except Exception as error:
                detail = {'error': str(error), 'trace': traceback.format_exc()}
                try:
                    detail['dom'] = cdp.eval("({url:location.href,text:document.body.innerText.slice(0,900),errors:window.__qaErrors||[]})")
                    screenshot(cdp, OUT, 'failure-' + str(len(results)))
                except Exception:
                    pass
                results.append({'name': name, 'ok': False, **detail})
                print(f'FAIL {name}: {error}', flush=True)
            (OUT / 'report.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')

        def viewport(width, height):
            cdp.command('Emulation.setDeviceMetricsOverride', {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': width < 600})

        def click(selector):
            wait_for(cdp, f'Boolean(document.querySelector({json.dumps(selector)}))', selector)
            cdp.eval(f'document.querySelector({json.dumps(selector)}).click()')
            settle(cdp, 160)

        def visit(path='?c=community'):
            navigate(cdp, base + path)
            wait_for(cdp, "document.querySelector('#codexBtnText')?.textContent !== '加载中…'", 'app loaded')
            wait_for(cdp, "document.querySelectorAll('.card').length > 0 || Boolean(document.querySelector('#lightbox.show'))", 'cards or detail')
            settle(cdp, 250)

        def state(expression):
            return cdp.eval(f"(async()=>{{const{{state}}=await import('/assets/app/state.js');return {expression};}})()")

        def list_ids():
            return state('state.list.map(entry=>entry.id)')

        def wait_state(expression, label):
            return wait_for(cdp, f"(async()=>{{const{{state}}=await import('/assets/app/state.js');return {expression};}})()", label)

        def selector_check():
            viewport(1440, 1000)
            visit('?c=sample')
            click('#codexBtn')
            click('.codex-type[data-type="pack"]')
            wait_for(cdp, "Boolean(document.querySelector('.codex-item[data-id=" + '\"community\"' + "]'))", 'community book')
            screenshot(cdp, OUT, 'desktop-selector')
            click('.codex-item[data-id="community"]')
            wait_state("state.codex.id === 'community' && state.list.length === 5", 'community selected')
            assert not cdp.eval("document.querySelector('#communityCodexActions').hidden")
            assert not cdp.eval("Boolean(document.querySelector('a[href=\"strings.html\"]'))")
            screenshot(cdp, OUT, 'desktop-main')
            return {'visibleSafeEntries': len(list_ids()), 'url': cdp.eval('location.href')}

        check('desktop selector and shared masonry', selector_check)

        def search_check():
            for text in ['测试画师 林青', '雾气说明', '抽象']:
                cdp.eval(f"(()=>{{const input=document.querySelector('#search');input.value={json.dumps(text)};input.dispatchEvent(new Event('input',{{bubbles:true}}));}})()")
                wait_state('state.list.length === ' + ('5' if text == '抽象' else '1'), 'search ' + text)
            visit()
            return {'queries': ['投稿人', '说明', '标签'], 'usesMainSearch': True}

        check('main search recalls submitter note and labels', search_check)

        def links_check():
            visit(f'?c=community&entry={ENTRY_ID}&image=2')
            wait_state('state.lightbox.index === 1', 'second image')
            wait_for(cdp, "document.querySelector('#lightboxImg').currentSrc.includes('/qa/1-b') && document.querySelector('#lightboxImg').naturalWidth > 0", 'second image bytes')
            assert state('state.lightbox.entry.author') == '测试画师 林青'
            assert state('state.lightbox.entry.note') == '用于兼容性验收的雾气说明'
            screenshot(cdp, OUT, 'desktop-lightbox')
            for path in ['strings.html', 'strings']:
                visit(f'{path}?entry={ENTRY_ID}&image=2')
                wait_state('state.lightbox.index === 1', 'legacy second image')
                wait_for(cdp, "document.querySelector('#lightboxImg').currentSrc.includes('/qa/1-b') && document.querySelector('#lightboxImg').naturalWidth > 0", 'legacy second image bytes')
                assert state('state.lightbox.entry.id') == ENTRY_ID
                assert '/strings' not in cdp.eval('location.pathname')
            return {'legacyPaths': ['strings.html', 'strings'], 'sameImageIndex': 1, 'originalButton': cdp.eval("!document.querySelector('#viewOriginal').hidden")}

        check('same entry image and originals through old links', links_check)

        def likes_check():
            click('[data-like-entry="qa-community-001"]')
            wait_for(cdp, "document.querySelector('[data-like-entry]')?.getAttribute('aria-pressed')==='true'", 'liked')
            assert Fixtures.entries[0]['liked']
            click('[data-like-entry="qa-community-001"]')
            wait_for(cdp, "document.querySelector('[data-like-entry]')?.getAttribute('aria-pressed')==='false'", 'unliked')
            return {'putAndDelete': True, 'count': Fixtures.entries[0]['likeCount']}

        check('existing anonymous likes API', likes_check)

        def favorites_check():
            assert state("state.favs.has('community:qa-community-001')"), 'legacy favorite missing'
            visit('?c=community&view=favorites')
            wait_state('state.favoritesView === true', 'favorites view')
            assert ENTRY_ID in list_ids()
            assert '共创法典' in cdp.eval('document.body.innerText')
            screenshot(cdp, OUT, 'desktop-favorites')
            click('#favoritesViewBackupBtn')
            backup = json.dumps({'format': 'novelai-tag-favorites', 'version': 1,
                                 'favorites': {'atlas': [], 'community': ['qa-community-002']}})
            cdp.eval(f"document.querySelector('#favoritesImportText').value={json.dumps(backup)};document.querySelector('#favoritesImportText').closest('details').open=true")
            click('#favoritesImportTextBtn')
            wait_for(cdp, "!document.querySelector('#favoritesRestoreBtn').disabled", 'legacy backup preview')
            click('#favoritesRestoreBtn')
            wait_state("state.favs.has('community:qa-community-002')", 'legacy backup restored')
            click('#favoritesBackupClose')
            return {'legacyStorageMigrated': True, 'unifiedFavorites': True, 'legacyV1BackupRestored': True}

        check('legacy favorites migrate into unified favorites wall', favorites_check)

        def submission_check():
            visit()
            click('#communityCodexActions [data-open-submit]')
            wait_for(cdp, "document.querySelector('#submitMask')?.classList.contains('show')", 'submission form')
            assert cdp.eval("Boolean(document.querySelector('#subNsfw')&&document.querySelector('#subName')&&document.querySelector('#subComment'))")
            screenshot(cdp, OUT, 'desktop-submit')
            click('#subMore summary')
            assert cdp.eval("document.querySelector('#subMore').open")
            click('[data-close-submit]')
            click('#communityCodexActions [data-my-submissions-open]')
            wait_for(cdp, "document.querySelector('#mySubmissionsPanel')?.classList.contains('show')", 'my submissions')
            text = cdp.eval("document.querySelector('#mySubmissionsPanel').innerText")
            assert '已发布' in text and '尚未公开' in text
            click('[data-my-submission-id="qa-community-001"]')
            wait_state("state.lightbox.entry?.id === 'qa-community-001'", 'owned submission detail')
            assert cdp.eval("!(history.state.layers||[]).some(layer=>layer.id==='mySubmissionsPanel')")
            click('#lightboxClose')
            click('#communityCodexActions [data-open-submit]')
            # Synthetic image upload remains inside the loopback fixture; no production mutation.
            cdp.eval("""(async()=>{const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;
              const context=canvas.getContext('2d');context.fillStyle='#aaccdd';context.fillRect(0,0,32,32);
              const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
              const files=new DataTransfer();files.items.add(new File([blob],'fixture.png',{type:'image/png'}));
              const input=document.querySelector('#subFile');input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));
              document.querySelector('#subPrompt').value='abstract landscape, soft lighting';
              document.querySelector('#subTitle').value='本地验收投稿';document.querySelector('#subName').value='界面测试';
              document.querySelector('#subComment').value='仅发送给回环夹具服务器。';})()""")
            wait_for(cdp, "document.querySelectorAll('.sub-preview').length === 1", 'upload preview')
            click('#subGo')
            wait_for(cdp, "!document.querySelector('#subSuccess').hidden", 'submission success')
            assert Fixtures.submitted and all(Fixtures.submitted[key] for key in ['hasImages', 'hasOriginals', 'hasImagesMeta', 'hasNsfw'])
            click('#subSuccess [data-my-submissions-open]')
            wait_for(cdp, "document.querySelector('#mySubmissionsPanel')?.classList.contains('show')", 'success to owned panel')
            assert cdp.eval("!(history.state.layers||[]).some(layer=>layer.id==='submitMask')")
            assert '本地验收投稿' in cdp.eval("document.querySelector('#mySubmissionsPanel').innerText")
            return {'existingOwnershipKey': True, 'localFixtureUpload': Fixtures.submitted, 'successReplacesSubmitHistoryLayer': True}

        check('submission form and local my submissions', submission_check)

        def access_check():
            visit()
            assert ADULT_ID not in list_ids()
            visit(f'?c=community&entry={ADULT_ID}')
            assert not state('Boolean(state.lightbox.entry)')
            click('#settingsBtn')
            click('#nsfwToggle')
            wait_for(cdp, "document.querySelector('#nsfwConfirm')?.classList.contains('show')", 'adult consent')
            click('#nsfwAccept')
            wait_state('state.allowNsfw === true', 'adult enabled')
            wait_state(f"state.lightbox.entry?.id === '{ADULT_ID}'", 'consent resumes blocked deep link')
            click('#settingsClose')
            # Revoke as a second tab would, while the adult fixture is still open.
            cdp.eval("localStorage.setItem('fadian-nsfw-ok','0');window.dispatchEvent(new StorageEvent('storage',{key:'fadian-nsfw-ok',oldValue:'1',newValue:'0',storageArea:localStorage}))")
            wait_state('state.allowNsfw === false && !state.lightbox.entry', 'adult revoked while detail open')
            assert ADULT_ID not in list_ids()
            visit(f'?c=community&entry={ADULT_ID}')
            assert not state('Boolean(state.lightbox.entry)')
            return {'locked': True, 'consentRequired': True, 'blockedLinkResumesAfterConsent': True, 'revokedAndDeepLinkBlocked': True}

        check('main adult grading unlock revoke and deep link gate', access_check)

        def refresh_check():
            visit(f'?c=community&entry={ENTRY_ID}&image=2')
            Fixtures.entries = [entry for entry in Fixtures.entries if entry['id'] != ENTRY_ID]
            cdp.eval("window.dispatchEvent(new Event('focus'))")
            wait_state("!state.lightbox.entry && !state.codex.entries.some(entry=>entry.id==='qa-community-001')", 'withdrawal refresh')
            click('#communityCodexActions [data-my-submissions-open]')
            wait_for(cdp, "document.querySelector('[data-my-submission-id=\"qa-community-001\"]')?.disabled", 'withdrawn owned status')
            Fixtures.entries.append(copy.deepcopy(Fixtures.original[0]))
            cdp.eval("window.dispatchEvent(new Event('focus'))")
            wait_for(cdp, "document.querySelector('[data-my-submission-id=\"qa-community-001\"]')?.disabled === false", 'already open owned panel refresh')
            Fixtures.entries = [entry for entry in Fixtures.entries if entry['id'] != ENTRY_ID]
            cdp.eval("window.dispatchEvent(new Event('focus'))")
            wait_for(cdp, "document.querySelector('[data-my-submission-id=\"qa-community-001\"]')?.disabled", 'already open owned panel withdrawal')
            click('[data-my-submissions-close]')
            Fixtures.entries.append(fixture_entry(7, '刚通过审核的作品'))
            cdp.eval("window.dispatchEvent(new Event('focus'))")
            wait_state("state.codex.entries.some(entry=>entry.id==='qa-community-007')", 'approval refresh')
            visit('?c=community&view=favorites')
            assert ENTRY_ID not in list_ids()
            Fixtures.entries = copy.deepcopy(Fixtures.original)
            visit()
            return {'removedEntryAndLightboxCleared': True, 'approvedEntryAppeared': True, 'withdrawnFavoriteHidden': True}

        check('approval withdrawal and favorites refresh', refresh_check)

        def unavailable_check():
            visit(f'?c=community&entry={ENTRY_ID}')
            Fixtures.fail_api = True
            cdp.eval("window.dispatchEvent(new Event('focus'))")
            try:
                wait_state('!state.lightbox.entry && state.codex.entries.length === 0', 'API outage closes stale content')
                assert ENTRY_ID not in list_ids()
            finally:
                Fixtures.fail_api = False
            cdp.eval("window.dispatchEvent(new Event('focus'))")
            wait_state('state.codex.entries.length === 6', 'API recovered')
            return {'staleContentHidden': True, 'noFallbackResurrection': True, 'recovered': True}

        check('API failure clears stale community content and recovers', unavailable_check)

        def mobile_check():
            viewport(390, 844)
            visit()
            assert cdp.eval('document.documentElement.scrollWidth <= innerWidth + 1')
            screenshot(cdp, OUT, 'mobile-main')
            click('#codexBtn')
            wait_for(cdp, "Boolean(document.querySelector('.codex-item[data-id=\"community\"]'))", 'mobile community book')
            screenshot(cdp, OUT, 'mobile-selector')
            click('.codex-item[data-id="community"]')
            visit(f'?c=community&entry={ENTRY_ID}&image=2')
            wait_state('state.lightbox.index === 1', 'mobile second image')
            screenshot(cdp, OUT, 'mobile-lightbox')
            click('#lightboxClose')
            click('#communityCodexActions [data-open-submit]')
            wait_for(cdp, "document.querySelector('#submitMask')?.classList.contains('show')", 'mobile submit')
            screenshot(cdp, OUT, 'mobile-submit')
            assert cdp.eval('document.documentElement.scrollWidth <= innerWidth + 1')
            return {'viewport': [390, 844], 'horizontalOverflow': False}

        check('mobile selector masonry detail and submission layouts', mobile_check)

        # Main-page network errors are expected only for the deliberately unimplemented editor probe.
        (OUT / 'fixture-requests.json').write_text(json.dumps(Fixtures.requests, indent=2), encoding='utf-8')
        return 0 if all(result['ok'] for result in results) else 1
    finally:
        if cdp:
            cdp.close()
        chrome.terminate()
        chrome.wait(timeout=10)
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    raise SystemExit(main())
