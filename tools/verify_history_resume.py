"""Isolated full-app history/rail regression with synthetic loopback data only.

Own server/profile; exact origin Fetch gate plus dead proxy and CSP. Baseline
assets come from git HEAD, never another checkout or real site/data.
"""
import argparse
import hashlib
import json
import re
import stat
import subprocess
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from verify_ui import CDP, disable_motion, find_chrome, find_free_port, navigate, page_ws_url, reload, wait_for
from verify_frontend_loading_recovery import asset_source

ROOT = Path(__file__).resolve().parents[1]
CHANGED = {'site/assets/app.js', 'site/assets/app/history.js', 'site/assets/app/browser-history.js', 'site/assets/app/tag-relay-rail.js'}


def fresh_output(root, raw):
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = root / candidate
    candidate = candidate.absolute()
    if '..' in candidate.parts or not candidate.is_relative_to((root / 'output').absolute()) or candidate.exists():
        raise ValueError('Require a fresh output/ directory')
    for ancestor in [candidate, *candidate.parents]:
        try:
            info = ancestor.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('Output ancestors cannot be symlinks or junctions')
    candidate.mkdir(parents=True)
    return candidate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', choices=['baseline', 'fixed'], default='fixed')
    parser.add_argument('--baseline', help='Required immutable git commit/ref with --source baseline')
    parser.add_argument('--out-dir', required=True)
    args = parser.parse_args()
    if args.source == 'baseline' and (not args.baseline or args.baseline.startswith('-')):
        parser.error('--source baseline requires --baseline <git commit/ref>')
    baseline_ref = subprocess.check_output(['git', 'rev-parse', '--verify', args.baseline + '^{commit}'], cwd=ROOT, text=True).strip() if args.source == 'baseline' else ''
    try:
        out = fresh_output(ROOT, args.out_dir)
    except ValueError as error:
        parser.error(str(error))
    books = {key: {'id': key, 'title': 'Fixture ' + key, 'entries': [
        {'id': key + '-' + str(i), 'title': ('Cat ' if i % 2 else 'Dog ') + str(i), 'tags': 'cat' if i % 2 else 'dog',
         'path': ['Group'], 'images': [{'path': '/fixture.svg'}] if i else [{'path': '/fixture.svg?v=' + str(n)} for n in range(4)]}
        for i in range(24)]} for key in ['a', 'b']}
    fixtures = {'/data/codexes.json': [{'id': key, 'title': 'Fixture ' + key, 'entryCount': 24} for key in books],
                '/data/media.json': {}, '/data/about.json': {}, '/data/updates.json': [],
                '/data/tag_zh/core.json': {'schema': 1, 'm': {}, 'shards': []},
                **{'/data/' + key + '.json': value for key, value in books.items()}}
    encoded = {key: json.dumps(value, ensure_ascii=False).encode() for key, value in fixtures.items()}
    hashes, requests, blocked = {}, [], set()
    baseline = {path: subprocess.check_output(['git', 'show', baseline_ref + ':' + path], cwd=ROOT) for path in CHANGED} if args.source == 'baseline' else {}
    html = re.sub(rb'<link\b[^>]*https://[^>]*>', b'', (ROOT / 'site/index.html').read_bytes())
    html = html.replace(b'<head>', b'<head><base href="/">', 1)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = urlparse(self.path).path
            requests.append(path)
            content_type = 'application/json'
            if path == '/' or path.startswith('/share/'):
                payload, content_type = html, 'text/html; charset=utf-8'
            elif path in encoded:
                payload = encoded[path]
            elif path == '/fixture.svg':
                payload, content_type = b'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="navy"/></svg>', 'image/svg+xml'
            elif path.startswith('/assets/'):
                source = asset_source(ROOT, path)
                if source is None:
                    self.send_error(404)
                    return
                relative = 'site/' + path.lstrip('/')
                payload = baseline.get(relative, source.read_bytes())
                hashes[relative] = hashlib.sha256(payload).hexdigest()
                content_type = 'text/css' if path.endswith('.css') else 'text/javascript'
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Security-Policy', "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'")
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    port = find_free_port()
    command = [find_chrome(), '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
               '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
               '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1',
               '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
               f'--remote-debugging-port={port}', f'--user-data-dir={out / "profile"}', '--window-size=1440,820', 'about:blank']
    log = (out / 'chrome.log').open('wb')
    chrome = subprocess.Popen(command, stdout=log, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    cdp = None
    checks = []
    env = {}

    def record(name, value, passed):
        checks.append({'name': name, 'status': 'PASS' if passed else 'FAIL', 'observed': value})
        print(name + ': ' + checks[-1]['status'], flush=True)

    def setup():
        cdp.command('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-reduced-motion', 'value': 'reduce'}]})
        cdp.command('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 820, 'deviceScaleFactor': 1, 'mobile': False})
        navigate(cdp, base + '?c=a')
        wait_for(cdp, "document.querySelectorAll('.card').length > 0", 'fixture cards')
        attach()

    def attach():
        cdp.eval("""(async()=>{window.s=(await import('/assets/app/state.js')).state;window.h=await import('/assets/app/history.js');
          window.app=await import('/assets/app.js');window.r=await import('/assets/app/router.js');window.lb=await import('/assets/app/lightbox.js');
          window.rail=await import('/assets/app/tag-relay-rail.js');window.modal=await import('/assets/app/modal.js');
          window.store=await import('/assets/app/favorites-library-store.js');window.core=await import('/assets/app/favorites-library-core.js');
          window.nativeTimer=window.setTimeout.bind(window);window.heldTimers=[];
          window.setTimeout=(fn,ms,...rest)=>{if(ms===120||ms===160||ms===180){heldTimers.push(()=>fn(...rest));return 0;}return nativeTimer(fn,ms,...rest)};
          window.drain=()=>{const held=heldTimers.splice(0);for(const fn of held)fn()};
          window.pop=()=>new Promise(resolve=>{addEventListener('popstate',()=>resolve(true),{once:true});history.back()});
          window.forward=()=>new Promise(resolve=>{addEventListener('popstate',()=>resolve(true),{once:true});history.forward()});return true})()""")

    def seed_favorites():
        cdp.eval("""(async()=>{const result=await store.commitLibrary(doc=>{if(!doc.folders.some(f=>f.id==='folder-42'))core.createFolder(doc,'Saved',{id:'folder-42'});
          for(const key of ['a:a-1','b:b-1','b:b-3'])core.addLibraryItem(doc,key,{codexes:s.codexes});
          core.setFolderMembership(doc,['b:b-1','b:b-3'],'folder-42',true)});if(!result.ok)throw Error('seed failed');return true})()""")

    try:
        cdp = CDP(page_ws_url(port))
        original_receive = cdp.ws.recv_text

        def receive():
            raw = original_receive()
            message = json.loads(raw)
            if message.get('method') == 'Fetch.requestPaused':
                params = message['params']
                parsed = urlparse(params['request']['url'])
                if parsed.scheme == 'http' and parsed.hostname == '127.0.0.1' and parsed.port == server.server_port:
                    cdp._send_command('Fetch.continueRequest', {'requestId': params['requestId']})
                else:
                    blocked.add(parsed.scheme + '://' + str(parsed.hostname))
                    cdp._send_command('Fetch.failRequest', {'requestId': params['requestId'], 'errorReason': 'BlockedByClient'})
            return raw

        cdp.ws.recv_text = receive
        cdp.command('Fetch.enable', {'patterns': [{'urlPattern': '*'}]})
        cdp.command('Runtime.enable')
        cdp.command('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-reduced-motion', 'value': 'reduce'}]})
        disable_motion(cdp)
        cdp.command('Page.addScriptToEvaluateOnNewDocument', {'source': "try{localStorage.setItem('fadian-onboarding-v1-done','1');localStorage.setItem('fadian-tag-relay-rail','closed')}catch(e){}"})
        env = {'browser': cdp.command('Browser.getVersion'), 'viewports': [[1440, 820], [1100, 820]], 'motion': 'off', 'prefersReducedMotion': True}
        setup()
        value = cdp.eval("""(async()=>{s.searchScope='codex';s.query='cat';app.applyFilter({transition:'none'});const saved=h.currentBrowseSnapshot('');
          s.query='';s.searchScope='site';app.applyFilter({transition:'none'});s.lastBrowse=saved;await h.resumeLastBrowse();
          return {scope:s.searchScope,button:document.querySelector('#searchScopeBtn').dataset.scope,site:s.siteSearchView,
            q:s.query,url:location.href,route:history.state.route,list:s.list.map(e=>e.id)}})()""")
        record('local scope agrees with control, URL and list', value, value['scope'] == 'codex' and value['button'] == 'codex' and not value['site'] and 'scope=codex' in value['url'] and len(value['list']) == 12)
        reload(cdp)
        wait_for(cdp, "document.querySelectorAll('.card').length > 0", 'reload cards')
        value = cdp.eval("(async()=>{const s=(await import('/assets/app/state.js')).state;return {scope:s.searchScope,site:s.siteSearchView,count:s.list.length}})()")
        record('restored local search survives reload', value, value == {'scope': 'codex', 'site': False, 'count': 12})

        setup()
        value = cdp.eval("""(async()=>{s.lastBrowse=h.normalizeLastBrowse({codexId:'b',q:'cat',searchScope:'codex'});await h.resumeLastBrowse();
          return {codex:s.codex.id,scope:s.searchScope,site:s.siteSearchView,count:s.list.length,url:location.href}})()""")
        record('cross-book local scope restores list and URL', value, value['codex'] == 'b' and value['scope'] == 'codex' and not value['site'] and value['count'] == 12 and 'scope=codex' in value['url'])

        setup()
        value = cdp.eval("""(async()=>{s.activePath=['Group'];app.applyFilter({transition:'none'});r.syncUrlState({historyMode:'replace'});
          s.lastBrowse=h.normalizeLastBrowse({codexId:'a',siteSearchView:true,q:'cat',searchScope:'site'});await h.resumeLastBrowse();
          return {scope:s.searchScope,site:s.siteSearchView,count:s.list.length,url:location.href}})()""")
        record('site search resumes from a directory', value, value['scope'] == 'site' and value['site'] and value['count'] == 24 and 'scope=site' in value['url'])

        setup()
        cdp.command('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-reduced-motion', 'value': 'no-preference'}]})
        value = cdp.eval("""(async()=>{document.documentElement.classList.remove('motion-off');lb.openLightbox(s.codex.entries[1],0,null,{allowEmpty:true});
          await h.openRecentEntry({codexId:'b',entryId:'b-1',path:['Group']});drain();return {codex:s.codex.id,entry:s.lightbox.entry?.id,route:history.state.route}})()""")
        record('animated cross-book recent replaces the previous detail', value, value['codex'] == 'b' and value.get('entry') == 'b-1' and value['route']['entry'] == 'b-1')

        setup()
        cdp.eval("scrollTo(0,500);h.restoreBrowseScroll(500);document.activeElement?.blur();true")
        cdp.command('Input.dispatchKeyEvent', {'type': 'keyDown', 'key': 'Home', 'code': 'Home', 'windowsVirtualKeyCode': 36})
        cdp.command('Input.dispatchKeyEvent', {'type': 'keyUp', 'key': 'Home', 'code': 'Home', 'windowsVirtualKeyCode': 36})
        wait_for(cdp, 'scrollY===0', 'real Home scroll')
        value = cdp.eval('(()=>{drain();return {scrollY}})()')
        record('real Home key cancels pending restore', value, value['scrollY'] == 0)

        setup()
        value = cdp.eval("""(async()=>{lb.openLightbox(s.codex.entries[0],3,null,{allowEmpty:true});const saved=h.currentBrowseSnapshot();
          lb.closeLightbox({historyMode:'none',immediate:true});s.lastBrowse=saved;await h.resumeLastBrowse();drain();
          return {saved:saved.imageIndex,index:s.lightbox.index,entry:s.lightbox.entry?.id,routeIndex:history.state.route.imageIndex}})()""")
        record('pack fourth image resumes', value, value.get('saved') == 3 and value['index'] == 3 and value['routeIndex'] == 3)

        setup()
        seed_favorites()
        value = cdp.eval("""(async()=>{const {encodePathCode}=await import('/assets/app/path-code.js');
          await app.openFavoritesView({urlState:{favorites:true,codex:'a',folderCode:encodePathCode(['Saved']),favSource:'b',favSort:'title',scope:'codex'}});
          const saved=h.currentBrowseSnapshot('');await store.commitLibrary(doc=>core.renameFolder(doc,'folder-42','Renamed'));
          await app.loadCodex('a',{transition:'none'});s.lastBrowse=saved;await h.resumeLastBrowse();drain();
          return {folder:s.favFolder,source:s.favSource,sort:s.favSort,list:s.list.map(e=>e.id),route:history.state.route,url:location.href}})()""")
        record('favorites resume uses stable renamed folder, source and sort', value, value['folder'] == 'folder-42' and value['source'] == 'b' and value['sort'] == 'title' and len(value['list']) == 2 and bool(value['route'].get('folderCode')))

        setup()
        value = cdp.eval("""(async()=>{const events=[];addEventListener('popstate',()=>events.push({id:history.state.id,entry:history.state.route.entry}));
          await h.openRecentEntry({codexId:'a',entryId:'a-1',path:['Group']},{landOnCard:true});const before=history.state.id;
          await pop();await new Promise(requestAnimationFrame);const back={id:history.state.id,entry:s.lightbox.entry?.id||''};drain();
          return {before,back,events,final:{id:history.state.id,entry:s.lightbox.entry?.id||'',route:history.state.route}}})()""")
        record('Back prevents delayed recent detail and new history', value, not value['final']['entry'] and value['back']['id'] == value['final']['id'])

        for mode in ['recent', 'resume', 'favorites', 'site']:
            setup()
            if mode == 'favorites':
                seed_favorites()
            cdp.eval("""(()=>{s.codexCache.delete('b');const original=fetch;window.fetch=async(...args)=>{const response=await original(...args);
              if(String(args[0]).includes('/b.json'))await new Promise(resolve=>{window.releaseFetch=resolve});return response};return true})()""")
            cdp.eval("""(()=>{const mode=""" + json.dumps(mode) + """;s.lastBrowse=h.normalizeLastBrowse({codexId:mode==='recent'||mode==='resume'?'b':'a',
              entryId:'b-1',q:mode==='site'?'cat':'',favoritesView:mode==='favorites',siteSearchView:mode==='site',searchScope:mode==='site'?'site':'codex'});
              window.pendingWork=mode==='recent'?h.openRecentEntry({codexId:'b',entryId:'b-1',path:['Group']},{landOnCard:true}):h.resumeLastBrowse();return true})()""")
            wait_for(cdp, 'typeof releaseFetch === "function"', mode + ' fetch gate')
            value = cdp.eval("""(async()=>{s.searchScope='codex';s.query='dog';app.applyFilter({transition:'none'});r.syncUrlState({historyMode:'push',entry:''});
              const newer=history.state.id;await pop();await new Promise(requestAnimationFrame);await forward();await new Promise(requestAnimationFrame);
              const before={id:history.state.id,codex:s.codex.id,q:s.query,entry:s.lightbox.entry?.id||'',url:location.href};
              releaseFetch();await pendingWork;drain();return {newer,before,after:{id:history.state.id,codex:s.codex.id,q:s.query,entry:s.lightbox.entry?.id||'',url:location.href}}})()""")
            record('pending ' + mode + ' ignores Back/Forward ABA', value, value['before'] == value['after'] and value['after']['id'] == value['newer'])

        for animated in [False, True]:
            setup()
            if animated:
                cdp.command('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-reduced-motion', 'value': 'no-preference'}]})
                cdp.eval("document.documentElement.classList.remove('motion-off');true")
            cdp.eval("""(()=>{s.codexCache.delete('b');const original=fetch;window.fetch=async(...args)=>{const response=await original(...args);
              if(String(args[0]).includes('/b.json'))await new Promise(resolve=>{window.releaseFetch=resolve});return response};
              window.pendingWork=h.openRecentEntry({codexId:'b',entryId:'b-1',path:['Group']},{landOnCard:true});return true})()""")
            wait_for(cdp, 'typeof releaseFetch === "function"', 'modal cancellation fetch gate')
            value = cdp.eval("""(async()=>{modal.openMask(document.querySelector('#settings'));await new Promise(requestAnimationFrame);
              const snapshot=()=>({count:document.querySelectorAll('.card').length,title:document.querySelector('#codexTitle').textContent,
                banner:document.querySelector('#codexBtnText').textContent,input:document.querySelector('#search').value,url:location.href});
              const before=snapshot();releaseFetch();await pendingWork;drain();const during=snapshot();
              await pop();await new Promise(requestAnimationFrame);return {before,during,after:snapshot(),codex:s.codex.id,
                entry:s.lightbox.entry?.id||'',layers:history.state.layers}})()""")
            record('settings cancellation retains visible view, motion=' + str(animated), value, value['before']['count'] > 0 and value['before'] == value['during'] == value['after'] and value['after']['title'] == 'Fixture a' and value['codex'] == 'a' and not value['entry'] and not value['layers'])

            setup()
            if animated:
                cdp.command('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-reduced-motion', 'value': 'no-preference'}]})
                cdp.eval("document.documentElement.classList.remove('motion-off');true")
            value = cdp.eval("""(async()=>{s.codexCache.delete('b');s.query='dog';s.searchScope='codex';document.querySelector('#search').value='dog';
              app.applyFilter({transition:'none'});r.syncUrlState({historyMode:'replace'});
              const snapshot=()=>({count:document.querySelectorAll('.card').length,title:document.querySelector('#codexTitle').textContent,
                banner:document.querySelector('#codexBtnText').textContent,input:document.querySelector('#search').value,url:location.href,id:history.state.id});
              const before=snapshot();const original=fetch;window.fetch=(...args)=>String(args[0]).includes('/b.json')?Promise.resolve(new Response('{}',{status:503})):original(...args);
              await h.openRecentEntry({codexId:'b',entryId:'b-1',path:['Group']},{landOnCard:true});drain();
              return {before,after:snapshot(),error:document.querySelector('#loading').textContent,codex:s.codex.id}})()""")
            record('failed history view retains cards, banner, input and URL, motion=' + str(animated), value, value['before']['count'] > 0 and value['before'] == value['after'] and value['codex'] == 'a' and bool(value['error']))

        for foreground in ['lightbox', 'settings']:
            setup()
            cdp.eval("""(()=>{rail.openRelayRail(document.querySelector('#tagRelayBtn'));""" + ("lb.openLightbox(s.codex.entries[1],0,null,{allowEmpty:true});" if foreground == 'lightbox' else "modal.openMask(document.querySelector('#settings'));" ) + "return true})()")
            wait_for(cdp, "Boolean(document.activeElement.closest('#lightbox,#settings'))", 'foreground focus')
            before = cdp.eval("({id:history.state.id,focus:document.activeElement.id,layers:history.state.layers})")
            cdp.command('Emulation.setDeviceMetricsOverride', {'width': 1100, 'height': 820, 'deviceScaleFactor': 1, 'mobile': False})
            wait_for(cdp, "matchMedia('(max-width:1240px)').matches", 'narrow viewport')
            cdp.eval('new Promise(requestAnimationFrame)')
            value = cdp.eval("({id:history.state.id,focus:document.activeElement.id,layers:history.state.layers,closed:document.querySelector('#tagRelayRail').classList.contains('closed'),preference:localStorage.getItem('fadian-tag-relay-rail')})")
            record(foreground + ' retains focus/history across narrow breakpoint', {'before': before, 'after': value}, value['id'] == before['id'] and value['focus'] == before['focus'] and value['layers'] == before['layers'] and value['closed'] and value['preference'] == 'open')
            cdp.command('Input.dispatchKeyEvent', {'type': 'keyDown', 'key': 'Tab', 'code': 'Tab', 'windowsVirtualKeyCode': 9, 'modifiers': 8})
            cdp.command('Input.dispatchKeyEvent', {'type': 'keyUp', 'key': 'Tab', 'code': 'Tab', 'windowsVirtualKeyCode': 9, 'modifiers': 8})
            tab = cdp.eval("({inside:!!document.activeElement.closest('#lightbox,#settings'),focus:document.activeElement.id})")
            record(foreground + ' Shift+Tab remains in foreground', tab, tab['inside'])
            cdp.command('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 820, 'deviceScaleFactor': 1, 'mobile': False})
            cdp.eval('new Promise(requestAnimationFrame)')
            value = cdp.eval("(async()=>{await pop();await new Promise(requestAnimationFrame);return {layers:history.state.layers,entry:s.lightbox.entry?.id||'',settings:!document.querySelector('#settings').hidden,rail:rail.isRelayRailOpen()}})()")
            record(foreground + ' first Back closes foreground without rail ghost', value, not value['layers'] and not value['entry'] and not value['settings'] and not value['rail'])
            cdp.command('Emulation.setDeviceMetricsOverride', {'width': 1100, 'height': 820, 'deviceScaleFactor': 1, 'mobile': False})
            cdp.eval('new Promise(requestAnimationFrame)')
            value = cdp.eval("(async()=>{rail.openRelayRail(document.querySelector('#tagRelayBtn'));const open={focus:document.activeElement.id,layers:history.state.layers};await pop();await new Promise(requestAnimationFrame);return {open,closed:!rail.isRelayRailOpen(),layers:history.state.layers}})()")
            record(foreground + ' later explicit rail open owns one Back layer', value, value['open']['focus'] == 'tagRelayRailClose' and len(value['open']['layers']) == 1 and value['closed'] and not value['layers'])

        for foreground in ['lightbox', 'settings']:
            setup()
            initial = cdp.eval('history.state.id')
            cdp.command('Emulation.setDeviceMetricsOverride', {'width': 1100, 'height': 820, 'deviceScaleFactor': 1, 'mobile': False})
            cdp.eval('new Promise(requestAnimationFrame)')
            cdp.eval("(()=>{rail.openRelayRail(document.querySelector('#tagRelayBtn'));" + ("lb.openLightbox(s.codex.entries[1],0,null,{allowEmpty:true});" if foreground == 'lightbox' else "modal.openMask(document.querySelector('#settings'));") + "return true})()")
            wait_for(cdp, "Boolean(document.activeElement.closest('#lightbox,#settings'))", 'reverse foreground focus')
            before = cdp.eval('({id:history.state.id,focus:document.activeElement.id})')
            cdp.command('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 820, 'deviceScaleFactor': 1, 'mobile': False})
            cdp.eval('new Promise(requestAnimationFrame)')
            value = cdp.eval('({id:history.state.id,focus:document.activeElement.id,layers:history.state.layers})')
            record(foreground + ' widening retires lower rail without Back/focus change', {'before': before, 'after': value}, value['id'] == before['id'] and value['focus'] == before['focus'] and all(layer['id'] != 'tag-relay-rail' for layer in value['layers']))
            cdp.eval('pop()')
            wait_for(cdp, 'history.state.id===' + json.dumps(initial), 'retired rail Back collapse')
            value = cdp.eval("({entry:s.lightbox.entry?.id||'',settings:!document.querySelector('#settings').hidden,layers:history.state.layers,codex:s.codex.id})")
            record(foreground + ' one Back skips retired rail opening', value, not value['entry'] and not value['settings'] and not value['layers'] and value['codex'] == 'a')
            cdp.eval('forward()')
            try:
                wait_for(cdp, 'history.state.id===' + json.dumps(before['id']), 'retired rail Forward collapse', timeout=3)
            except RuntimeError:
                pass  # The failed target identity is recorded below, including on the old baseline.
            value = cdp.eval("({entry:s.lightbox.entry?.id||'',settings:!document.querySelector('#settings').hidden,layers:history.state.layers,focus:document.activeElement.id})")
            value['id'] = cdp.eval('history.state.id')
            record(foreground + ' one Forward restores foreground without retired rail', value, value['id'] == before['id'] and (bool(value['entry']) if foreground == 'lightbox' else value['settings']) and all(layer['id'] != 'tag-relay-rail' for layer in value['layers']))

        for mode in ['failed-resume', 'cancelled-resume', 'failed-recent', 'successful-resume']:
            setup()
            seed_favorites()
            cdp.eval("""(async()=>{await app.openFavoritesView({transition:'none'});s.codexCache.delete('b');
              window.controlSnapshot=()=>({onlyFav:s.onlyFav,checked:document.querySelector('#onlyFav').checked,filter:s.updateFilter,
                input:document.querySelector('#search').value,title:document.querySelector('#codexTitle').textContent,
                count:document.querySelectorAll('.card').length,route:history.state.route});window.controlsBefore=controlSnapshot();return true})()""")
            if mode in ['cancelled-resume', 'successful-resume']:
                cdp.eval("""(()=>{const original=fetch;window.fetch=async(...args)=>{const response=await original(...args);
                  if(String(args[0]).includes('/b.json'))await new Promise(resolve=>{window.releaseFetch=resolve});return response};return true})()""")
            else:
                cdp.eval("""(()=>{const original=fetch;window.fetch=(...args)=>String(args[0]).includes('/b.json')?Promise.resolve(new Response('{}',{status:503})):original(...args);return true})()""")
            cdp.eval("""(()=>{const mode=""" + json.dumps(mode) + """;s.lastBrowse=h.normalizeLastBrowse({codexId:'b',searchScope:'codex'});
              window.controlWork=mode==='failed-recent'?h.openRecentEntry({codexId:'b',entryId:'b-1'}):h.resumeLastBrowse();return true})()""")
            if mode in ['cancelled-resume', 'successful-resume']:
                wait_for(cdp, 'typeof releaseFetch === "function"', 'favorites control fetch gate')
                pending = cdp.eval('controlSnapshot()')
                if mode == 'cancelled-resume':
                    cdp.eval("modal.openMask(document.querySelector('#settings'));true")
                cdp.eval('releaseFetch();true')
            else:
                pending = None
            cdp.eval('controlWork')
            if mode == 'cancelled-resume':
                cdp.eval('pop()')
            value = cdp.eval('(()=>{drain();return {before:controlsBefore,pending:' + json.dumps(pending) + ',after:controlSnapshot(),codex:s.codex.id}})()')
            if mode == 'successful-resume':
                passed = value['before'] == value['pending'] and value['codex'] == 'b' and not value['after']['onlyFav'] and not value['after']['checked'] and not value['after']['route']['favorites']
            else:
                passed = value['before'] == value['after'] and (value['pending'] is None or value['before'] == value['pending'])
            record('favorites controls commit atomically: ' + mode, value, passed)

        for intervening_route in [False, True]:
            setup()
            initial = cdp.eval('history.state.id')
            cdp.command('Emulation.setDeviceMetricsOverride', {'width': 1100, 'height': 820, 'deviceScaleFactor': 1, 'mobile': False})
            cdp.eval('new Promise(requestAnimationFrame)')
            cdp.eval("rail.openRelayRail(document.querySelector('#tagRelayBtn'));true")
            if intervening_route:
                cdp.eval("s.activePath=['Group'];app.applyFilter({transition:'none'});r.syncUrlState({historyMode:'push',entry:''});true")
            list_id = cdp.eval('history.state.id') if intervening_route else initial
            cdp.eval('lb.openLightbox(s.codex.entries[1],0,null,{allowEmpty:true});true')
            detail_id = cdp.eval('history.state.id')
            cdp.command('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 820, 'deviceScaleFactor': 1, 'mobile': False})
            cdp.eval('new Promise(requestAnimationFrame)')
            reload(cdp)
            wait_for(cdp, "document.querySelectorAll('.card').length > 0", 'retirement reload cards')
            attach()
            wait_for(cdp, "s.lightbox.entry?.id==='a-1'", 'detail restored after retirement reload')
            cdp.eval('pop()')
            wait_for(cdp, 'history.state.id===' + json.dumps(list_id), 'post-reload Back target')
            value = cdp.eval('({id:history.state.id,layers:history.state.layers,entry:s.lightbox.entry?.id||"",retired:history.state.retiredLayerIds||[]})')
            record('retirement survives reload and preserves real ancestor=' + str(intervening_route), value, value['id'] == list_id and not value['layers'] and not value['entry'])
            if intervening_route:
                reload(cdp)
                wait_for(cdp, "document.querySelectorAll('.card').length > 0", 'ancestor reload cards')
                attach()
                cdp.eval('pop()')
                wait_for(cdp, 'history.state.id===' + json.dumps(initial), 'retired opener skipped after second reload')
            reload(cdp)
            wait_for(cdp, "document.querySelectorAll('.card').length > 0", 'parent reload cards')
            attach()
            cdp.eval('forward()')
            wait_for(cdp, 'history.state.id===' + json.dumps(list_id if intervening_route else detail_id), 'persisted Forward skip')
            if intervening_route:
                cdp.eval('forward()')
                wait_for(cdp, 'history.state.id===' + json.dumps(detail_id), 'Forward detail after real ancestor')
            wait_for(cdp, "s.lightbox.entry?.id==='a-1'", 'Forward restored detail')
            value = cdp.eval('({id:history.state.id,layers:history.state.layers,entry:s.lightbox.entry?.id||""})')
            record('retired opening Forward survives another reload, real ancestor=' + str(intervening_route), value, value['id'] == detail_id and not value['layers'] and value['entry'] == 'a-1')
            cdp.eval('pop()')
            wait_for(cdp, 'history.state.id===' + json.dumps(list_id), 'close restored detail before reopening rail')
            cdp.command('Emulation.setDeviceMetricsOverride', {'width': 1100, 'height': 820, 'deviceScaleFactor': 1, 'mobile': False})
            cdp.eval('new Promise(requestAnimationFrame)')
            value = cdp.eval("(async()=>{rail.openRelayRail(document.querySelector('#tagRelayBtn'));const opened={layers:history.state.layers,focus:document.activeElement.id,retired:history.state.retiredLayerIds||[]};await pop();return {opened,id:history.state.id,layers:history.state.layers}})()")
            record('same rail id reopens after persisted retirement, real ancestor=' + str(intervening_route), value, len(value['opened']['layers']) == 1 and not value['opened']['retired'] and value['opened']['focus'] == 'tagRelayRailClose' and value['id'] == list_id and not value['layers'])

        def virtual_origin(origin):
            setup()
            seed_favorites()
            cdp.eval("""(async()=>{await store.commitLibrary(doc=>{core.addLibraryItem(doc,'b:b-0',{codexes:s.codexes});core.setFolderMembership(doc,['b:b-0'],'folder-42',true)});
              s.activePath=['Group'];app.applyFilter({transition:'none'});r.syncUrlState({historyMode:'replace',entry:''});return true})()""")
            if origin == 'favorites':
                cdp.eval("app.openFavoritesView({transition:'none'})")
            elif origin == 'site':
                cdp.eval("app.openSiteSearchView({transition:'none',urlState:{codex:'a',scope:'site',q:'cat'}})")
            cdp.eval("""(()=>{window.virtualSnapshot=()=>({codex:s.codex.id,browse:s.browseCodex?.id||'',favorites:s.favoritesView,site:s.siteSearchView,
              onlyFav:s.onlyFav,checked:document.querySelector('#onlyFav').checked,title:document.querySelector('#codexTitle').textContent,
              input:document.querySelector('#search').value,scope:s.searchScope,returnPath:s.searchReturnPath,path:s.activePath,
              source:s.favSource,sort:s.favSort,folder:s.favFolder,url:location.href,route:history.state.route,list:s.list.map(e=>e.id),
              cards:document.querySelectorAll('.card').length});window.originalVirtual=virtualSnapshot();return true})()""")

        def hold_virtual_source(source):
            cdp.eval("""(async()=>{(await import('/assets/app/site-search.js')).invalidateSiteSearchCodex();s.codexCache.delete(""" + json.dumps(source) + """);
              const original=fetch;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).includes('/""" + source + """.json'))
                await new Promise(resolve=>{window.releaseVirtual=resolve});return response};return true})()""")

        for origin, target in [('favorites', 'favorites'), ('ordinary', 'favorites'), ('favorites', 'site'), ('site', 'site')]:
            for completion in ['cancel', 'success']:
                virtual_origin(origin)
                hold_virtual_source('a')
                cdp.eval("""(()=>{const target=""" + json.dumps(target) + """;s.lastBrowse=h.normalizeLastBrowse({codexId:'b',favoritesView:target==='favorites',siteSearchView:target==='site',
                  searchScope:target==='site'?'site':'codex',favFolder:'folder-42',favSource:'b',favSort:'title',q:'dog',entryId:'b-0',imageIndex:3});
                  window.virtualWork=h.resumeLastBrowse();return true})()""")
                wait_for(cdp, 'typeof releaseVirtual === "function"', 'virtual final-source gate')
                pending = cdp.eval('virtualSnapshot()')
                if completion == 'cancel':
                    cdp.eval("modal.openMask(document.querySelector('#settings'));true")
                cdp.eval('releaseVirtual();true')
                cdp.eval('virtualWork')
                if completion == 'cancel':
                    cdp.eval('pop()')
                value = cdp.eval('(()=>{drain();return {before:originalVirtual,pending:' + json.dumps(pending) + ',after:virtualSnapshot(),image:s.lightbox.index}})()')
                if completion == 'cancel':
                    passed = value['before'] == value['pending'] == value['after']
                else:
                    after = value['after']
                    passed = value['before'] == value['pending'] and after['browse'] == 'b' and value['image'] == 3 and after['route']['imageIndex'] == 3 and after['input'] == 'dog'
                    passed = passed and ((after['favorites'] and after['source'] == 'b' and after['sort'] == 'title' and after['folder'] == 'folder-42' and after['scope'] == 'codex') if target == 'favorites' else (after['site'] and after['scope'] == 'site'))
                record('virtual preparation commits once: ' + origin + ' to ' + target + ' ' + completion, value, passed)

        for target in ['favorites', 'site']:
            virtual_origin('favorites')
            value = cdp.eval("""(async()=>{s.codexCache.delete('b');const original=fetch;window.fetch=(...args)=>String(args[0]).includes('/b.json')?Promise.resolve(new Response('{}',{status:503})):original(...args);
              const target=""" + json.dumps(target) + """;s.lastBrowse=h.normalizeLastBrowse({codexId:'b',favoritesView:target==='favorites',siteSearchView:target==='site',searchScope:target==='site'?'site':'codex',q:'dog'});
              await h.resumeLastBrowse();drain();return {before:originalVirtual,after:virtualSnapshot(),error:document.querySelector('#loading').textContent}})()""")
            record('failed virtual base preparation retains original view: ' + target, value, value['before'] == value['after'] and bool(value['error']))

            virtual_origin('favorites')
            cdp.eval('s.browseCodex=null;window.originalVirtual=virtualSnapshot();true')
            hold_virtual_source('b')
            cdp.eval("""(()=>{window.allowVirtual=true;window.virtualWork=""" + ('app.openFavoritesView' if target == 'favorites' else 'app.openSiteSearchView') + """({isCurrent:()=>allowVirtual,
              urlState:""" + ('{favorites:true}' if target == 'favorites' else "{scope:'site',q:'dog'}") + """});return true})()""")
            wait_for(cdp, 'typeof releaseVirtual === "function"', 'fallback virtual-source gate')
            value = cdp.eval("""(async()=>{const pending=virtualSnapshot();allowVirtual=false;releaseVirtual();await virtualWork;drain();return {before:originalVirtual,pending,after:virtualSnapshot()}})()""")
            record('initial fallback base stays private until virtual commit: ' + target, value, value['before'] == value['pending'] == value['after'])

        virtual_origin('favorites')
        hold_virtual_source('a')
        cdp.eval("s.lastBrowse=h.normalizeLastBrowse({codexId:'b',favoritesView:true});window.virtualWork=h.resumeLastBrowse();true")
        wait_for(cdp, 'typeof releaseVirtual === "function"', 'newer virtual-intent gate')
        value = cdp.eval("""(async()=>{s.query='cat';s.searchScope='codex';document.querySelector('#search').value='cat';app.applyFilter({transition:'none'});r.syncUrlState({historyMode:'push',entry:''});
          const newer=virtualSnapshot();releaseVirtual();await virtualWork;drain();return {newer,after:virtualSnapshot()}})()""")
        record('cancelled virtual preparation never rolls back newer user state', value, value['newer'] == value['after'])

        setup()
        cdp.eval("""(()=>{s.searchScope='codex';s.query='cat';document.querySelector('#search').value='cat';app.applyFilter({transition:'none'});
          r.syncUrlState({historyMode:'replace',entry:''});s.query='dog';document.querySelector('#search').value='dog';app.applyFilter({transition:'none'});
          r.syncUrlState({historyMode:'push',entry:''});s.codexCache.delete('b');const original=fetch;window.fetch=async(...args)=>{const response=await original(...args);
            if(String(args[0]).includes('/b.json'))await new Promise(resolve=>{window.releaseUiLoad=resolve});return response};
          window.uiLoad=app.loadCodex('b',{transition:'none'});return true})()""")
        wait_for(cdp, 'typeof releaseUiLoad === "function"', 'ordinary UI load gate')
        cdp.eval('pop()')
        wait_for(cdp, "s.query==='cat'&&s.codex.id==='a'&&document.querySelectorAll('.card').length>0", 'Back to same-book search')
        value = cdp.eval("""(async()=>{const snapshot=()=>({codex:s.codex.id,q:s.query,input:document.querySelector('#search').value,
          title:document.querySelector('#codexTitle').textContent,list:s.list.map(e=>e.id),url:location.href,id:history.state.id,route:history.state.route});
          const before=snapshot();releaseUiLoad();await uiLoad;drain();return {before,after:snapshot()}})()""")
        record('Back to same-book search cancels an ordinary UI book load', value, value['before'] == value['after'])
    except Exception:
        (out / 'fatal.txt').write_text(traceback.format_exc(), encoding='utf-8')
        raise
    finally:
        (out / 'results.json').write_text(json.dumps({'source': args.source, 'baseline': baseline_ref, 'checks': checks}, ensure_ascii=False, indent=2), encoding='utf-8')
        (out / 'environment.json').write_text(json.dumps(env, indent=2), encoding='utf-8')
        (out / 'inputs.json').write_text(json.dumps({'assets': hashes, 'fixtures': {key: hashlib.sha256(value).hexdigest() for key, value in encoded.items()}}, indent=2), encoding='utf-8')
        (out / 'network-boundary.json').write_text(json.dumps({'allowed': base, 'blocked': sorted(blocked), 'requests': requests}, indent=2), encoding='utf-8')
        if cdp:
            cdp.close()
        chrome.terminate()
        chrome.wait(timeout=15)
        log.close()
        server.shutdown()
        server.server_close()
    if any(check['status'] != 'PASS' for check in checks):
        raise SystemExit(1)
    print(f'history/rail browser: PASS ({len(checks)} cases)', flush=True)


if __name__ == '__main__':
    main()
