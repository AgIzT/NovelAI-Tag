"""Offline real Chromium checks for v1/v2 reading, hash checks and cancellation.

Uses cached playwright-cli, an isolated profile, dead external proxy, resolver
deny rules and CSP. Serves actual index.html/ESM with synthetic JSON only.
The HTTP fixture models R2 routes; Functions handlers are covered separately by
test_data_proxy/test_share_backend/test_r2_data_compat, not executed here.
"""
import argparse
import hashlib
import json
import mimetypes
import re
import shutil
import subprocess
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if __package__:
    from .verify_frontend_loading_recovery import asset_source
    from .verify_ui import find_chrome
    from .r2_data_protocol import json_bytes, make_manifest, object_key
    from .r2_data_snapshot import no_links
else:
    from verify_frontend_loading_recovery import asset_source
    from verify_ui import find_chrome
    from r2_data_protocol import json_bytes, make_manifest, object_key
    from r2_data_snapshot import no_links

ROOT = Path(__file__).resolve().parents[1]
V1 = 'r-0123456789abcdefabcd'
HOST = 'atlas-r2.local.test'
DIRECT = 'direct-r2.local.test'


def create_output_directory(value):
    """Only create a fresh dedicated directory beneath this worktree/output."""
    raw = (ROOT / Path(value)).absolute()
    output = (ROOT / 'output').absolute()
    # Inspect un-resolved paths first: resolving a junction would erase evidence
    # of the link and turn an unsafe path into an apparently ordinary directory.
    no_links(ROOT.absolute())
    no_links(output)
    no_links(raw)
    target, boundary = raw.resolve(), output.resolve()
    if target == boundary or not target.is_relative_to(boundary):
        raise ValueError('output must be a dedicated child inside this worktree/output')
    if raw.exists() or raw.is_symlink():
        raise FileExistsError('output already exists; choose a fresh verification directory')
    raw.parent.mkdir(parents=True, exist_ok=True)
    no_links(raw)
    raw.mkdir()
    no_links(raw)
    return raw.resolve()


def write_text_once(path, text):
    no_links(path.absolute())
    with path.open('x', encoding='utf8') as stream:
        stream.write(text)


def build_release(version):
    values = {
        'codexes.json': [{'id': 'demo', 'title': 'Fixture Atlas ' + version, 'entryCount': 1, 'version': '2026.10.20'}],
        'demo.json': {'id': 'demo', 'title': 'Fixture Atlas ' + version, 'entries': [{'id': 'demo-1', 'title': 'Fixture entry ' + version, 'tags': 'cat', 'path': ['Fixture']}]},
        'media.json': {}, 'about.json': {'links': [], 'tips': [], 'credits': []},
        'updates.json': [], 'tag_zh/core.json': {'schema': 1, 'm': {}, 'shards': []},
        'probe.json': {'version': version},
    }
    bodies = {key: json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode() for key, value in values.items()}
    manifest = make_manifest({key: {'sha256': hashlib.sha256(body).hexdigest(), 'size': len(body)} for key, body in bodies.items()})
    return {'values': values, 'bodies': bodies, 'manifest': manifest, 'release': manifest['release']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out-dir', default='output/r2-integration-20261020/browser')
    args = parser.parse_args()
    out = create_output_directory(args.out_dir)
    npx = shutil.which('npx.cmd') or shutil.which('npx')
    if not npx:
        raise SystemExit('cached npx/playwright-cli required; this script never installs dependencies')
    old, new = build_release('old'), build_release('new')
    releases = {item['release']: item for item in (old, new)}
    blobs = {object_key(meta['sha256']): item['bodies'][key] for item in (old, new) for key, meta in item['manifest']['files'].items()}
    probe_key = object_key(old['manifest']['files']['probe.json']['sha256'])
    controls = {'protocol': 'v1', 'current': old['release'], 'fail_probe': False, 'corrupt_probe': False, 'slow_probe': False, 'slow_manifest': False}
    index_bytes = (ROOT / 'site/index.html').read_bytes()
    sources = ('site/index.html', 'tools/verify_r2_reading_browser.py',
               'tools/verify_frontend_loading_recovery.py', 'tools/verify_ui.py',
               'tools/r2_data_protocol.py', 'tools/r2_data_snapshot.py')
    requests, cli_logs = [], []
    source_hashes = {name: hashlib.sha256(index_bytes if name == 'site/index.html' else (ROOT / name).read_bytes()).hexdigest() for name in sources}
    evidence = {'scope': 'actual site/index.html + actual ESM, synthetic loopback JSON; no production, credentials or user profile', 'checks': [], 'release': old['release'], 'scriptSha256': source_hashes['tools/verify_r2_reading_browser.py']}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            route = parsed.path
            direct = route.startswith('/direct/')
            if direct:
                route = route[len('/direct'):]
            requests.append({'path': route, 'direct': direct, 'host': self.headers.get('host'), 'time': time.monotonic()})
            status, content_type = 200, 'application/json; charset=utf-8'
            if route in ('/', '/index.html'):
                body = index_bytes
                # Preserve real app DOM, bootstrap and modules; remove external hints/fonts.
                body = re.sub(rb'<link\b[^>]*https://[^>]*>', b'', body)
                content_type = 'text/html; charset=utf-8'
            elif route == '/harness':
                body = b'<!doctype html><meta charset=utf-8><h1>CAS reading harness</h1><script type=module>window.source=await import("/assets/data-source.js");window.ready=true;</script>'
                content_type = 'text/html; charset=utf-8'
            elif route == '/data-source.json':
                config = {'schemaVersion': 1, 'baseUrl': 'https://' + DIRECT + '/data', 'remoteHosts': [HOST] if controls['protocol'] == 'direct' else []}
                if controls['protocol'] != 'v1':
                    config['v2Pointer'] = 'v2/current.json'
                body = json.dumps(config).encode()
            elif route == '/data/current.json':
                body = json.dumps({'release': V1}).encode()
            elif route == '/data/v2/current.json':
                release = controls['current']
                body = json.dumps({'schemaVersion': 2, 'release': release, 'contentHash': release[3:], 'manifest': 'data/v2/releases/' + release + '/manifest.json', 'publishedAt': '2026-10-20T00:00:00Z', 'operationId': '0' * 32}).encode()
            elif route.startswith('/data/releases/' + V1 + '/'):
                logical = route.split('/data/releases/' + V1 + '/', 1)[1]
                body = old['bodies'].get(logical)
                status = 200 if body else 404
            elif route.startswith('/data/v2/releases/'):
                parts = route.split('/')
                release, logical = parts[4], '/'.join(parts[5:])
                selected = releases.get(release)
                if logical == 'manifest.json' and controls['slow_manifest']:
                    time.sleep(1.5)
                body = json_bytes(selected['manifest']) if selected and logical == 'manifest.json' else selected['bodies'].get(logical) if selected else None
                status = 200 if body else 404
                if logical == 'probe.json':
                    if controls['slow_probe']:
                        time.sleep(1.5)
                    if controls['corrupt_probe']:
                        body = b'{"version":"bad"}'
            elif route.startswith('/data/objects/'):
                body = blobs.get(route.lstrip('/'))
                status = 200 if body else 404
                if route.lstrip('/') == probe_key:
                    if controls['slow_probe']:
                        time.sleep(1.5)
                    if controls['fail_probe']:
                        status, body = 503, b'{}'
                    elif controls['corrupt_probe']:
                        body = b'{"version":"bad"}'
            elif route.startswith('/assets/'):
                source = asset_source(ROOT, route)
                if source is None:
                    status, body = 404, b'{}'
                else:
                    body = source.read_bytes()
                    source_hashes[str(source.relative_to(ROOT))] = hashlib.sha256(body).hexdigest()
                    content_type = 'text/javascript' if route.endswith('.js') else mimetypes.guess_type(route)[0] or 'application/octet-stream'
            elif route == '/api/site-analytics/config':
                body = b'{"enabled":false}'
            elif route == '/manifest.webmanifest':
                body = b'{"name":"CAS fixture","start_url":"/"}'
            else:
                status, body = 404, b'{}'
            body = body if body is not None else b'{}'
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Content-Security-Policy', "default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://" + DIRECT + "; object-src 'none'")
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://{HOST}:{server.server_port}'
    loopback = f'http://127.0.0.1:{server.server_port}'
    session = 'r2-' + str(server.server_port)
    config_path = out / 'playwright.config.json'
    config = {'browser': {'browserName': 'chromium', 'isolated': True,
                         'launchOptions': {'executablePath': find_chrome(), 'headless': True, 'args': [
                             '--disable-background-networking', '--disable-component-update', '--disable-sync', '--metrics-recording-only', '--disable-default-apps',
                             '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=' + HOST + ';127.0.0.1;localhost',
                             '--host-resolver-rules=MAP ' + HOST + ' 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
                             '--unsafely-treat-insecure-origin-as-secure=' + origin]},
                         'contextOptions': {'viewport': {'width': 1280, 'height': 800}}},
              'outputDir': str(out / 'playwright-artifacts')}
    write_text_once(config_path, json.dumps(config, indent=2))
    prefix = [npx, '--offline', '--yes', '--package', '@playwright/cli', 'playwright-cli', '-s=' + session, '--raw']

    def cli(*arguments):
        result = subprocess.run(prefix + list(arguments), cwd=ROOT, capture_output=True, encoding='utf8', timeout=40, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        cli_logs.append({'args': list(arguments), 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
        if result.returncode:
            raise RuntimeError('playwright-cli failed: ' + result.stdout + result.stderr)
        # CLI raw errors may still have exit code zero.
        if result.stdout.startswith('### Error'):
            raise RuntimeError(result.stdout)
        return result.stdout.strip()

    def evaluate(code):
        raw = cli('eval', 'async () => (' + code + ')')
        return json.loads(raw)

    def record(name, observed, passed):
        evidence['checks'].append({'name': name, 'status': 'PASS' if passed else 'FAIL', 'observed': observed})
        print(name + ': ' + ('PASS' if passed else 'FAIL'), flush=True)

    def navigate(path='/'):
        cli('goto', origin + path)
        # Runtime assertions need direct evaluation; this does not bypass DOM refs.
        cli('run-code', "async page => { await page.waitForFunction(() => document.querySelector('#codexTitle')?.textContent==='Fixture Atlas old' && document.querySelectorAll('.card').length===1, {timeout:15000}); }")

    try:
        cli('open', 'about:blank', '--config', str(config_path))
        # Run-code is necessary for network isolation and protocol assertions;
        # ordinary DOM inspection still uses fresh CLI snapshots below.
        cli('run-code', "async page => { page.r2Network=[];page.r2Blocked=[];page.on('request',r=>page.r2Network.push(r.url()));await page.context().route('**/*', async route => { const u=new URL(route.request().url()); if(u.hostname==='" + HOST + "') return route.continue(); if(u.hostname==='" + DIRECT + "' && u.protocol==='https:') { const response=await page.request.get('" + loopback + "/direct'+u.pathname); return route.fulfill({response}); } page.r2Blocked.push(u.href);return route.abort('blockedbyclient'); }); await page.addInitScript(() => { window.r2Unhandled=[]; addEventListener('error',e=>r2Unhandled.push(e.message)); addEventListener('unhandledrejection',e=>r2Unhandled.push(String(e.reason))); localStorage.setItem('fadian-motion','off'); }); }")
        navigate()
        snapshot = cli('snapshot')
        skip = re.search(r'button "跳过"[^\n]*\[ref=([^\]]+)\]', snapshot)
        if skip:
            cli('click', skip.group(1))
            cli('snapshot')
        value = evaluate("(async()=>({source:(await import('/assets/data-source.js')).getDataSource(),secure:isSecureContext,crypto:!!crypto.subtle,title:document.querySelector('#codexTitle').textContent,cards:document.querySelectorAll('.card').length}))()")
        record('v1 default actual app bootstrap', value, value['source']['release'] == V1 and value['source']['mode'] == 'proxy' and value['cards'] == 1)

        controls.update(protocol='v2')
        navigate('/?phase=v2')
        cli('snapshot')
        value = evaluate("(async()=>({source:(await import('/assets/data-source.js')).getDataSource(),secure:isSecureContext,crypto:!!crypto.subtle,title:document.querySelector('#codexTitle').textContent,cards:document.querySelectorAll('.card').length,errors:r2Unhandled}))()")
        record('v2 actual app and WebCrypto bootstrap', value, value['source']['release'] == old['release'] and value['source']['mode'] == 'proxy' and value['secure'] and value['crypto'] and value['cards'] == 1 and not value['errors'])
        cli('screenshot', '--filename=' + str(out / 'v2-app.png'))

        controls['current'] = new['release']
        start = len(requests)
        value = evaluate("(async()=>{const m=await import('/assets/data-source.js');return await m.fetchDataJsonResult('probe.json')})()")
        record('proxy session remains on frozen release after current changes', value, value['release'] == old['release'] and value['data']['version'] == 'old' and not any(item['path'].endswith('/current.json') for item in requests[start:]))

        controls.update(protocol='direct', current=old['release'])
        navigate('/?phase=direct')
        controls.update(current=new['release'], fail_probe=True)
        start = len(requests)
        value = evaluate("(async()=>{const r=await (await import('/assets/data-source.js')).fetchDataJsonResult('probe.json');return {data:r.data,release:r.release,source:r.source,url:r.url}})()")
        record('direct failure falls back through same release proxy', {'result': value, 'requests': requests[start:]}, value['release'] == old['release'] and value['source'] == 'proxy-fallback' and value['data']['version'] == 'old' and not any(item['path'].endswith('/current.json') for item in requests[start:]))

        controls.update(fail_probe=False, corrupt_probe=True)
        value = evaluate("(async()=>{try{await (await import('/assets/data-source.js')).fetchDataJsonResult('probe.json',{allowFallback:false});return {rejected:false}}catch(e){return {rejected:true,error:String(e)}}})()")
        record('browser rejects hash-corrupted bytes', value, value['rejected'] and 'SHA-256' in value['error'])
        controls['corrupt_probe'] = False
        value = evaluate("(async()=>{const r=await (await import('/assets/data-source.js')).fetchDataJsonResult('probe.json');return {data:r.data,release:r.release}})()")
        record('same-release retry recovers after corrupt response', value, value['release'] == old['release'] and value['data']['version'] == 'old')

        controls['slow_probe'] = True
        value = evaluate("(async()=>{const m=await import('/assets/data-source.js');const c=new AbortController();const p=m.fetchDataJsonResult('probe.json',{signal:c.signal});setTimeout(()=>c.abort(),50);try{await p;return {cancelled:false}}catch(e){return {cancelled:e.name==='AbortError',name:e.name}}})()")
        controls['slow_probe'] = False
        recovered = evaluate("(async()=>{const r=await (await import('/assets/data-source.js')).fetchDataJsonResult('probe.json');return {data:r.data,release:r.release}})()")
        record('browser fetch cancellation permits same-release retry', {'cancel': value, 'recovered': recovered}, value['cancelled'] and recovered['release'] == old['release'] and recovered['data']['version'] == 'old')

        controls.update(protocol='v2', current=old['release'], slow_manifest=True)
        cli('goto', origin + '/harness?phase=shared')
        cli('run-code', 'async page => { await page.waitForFunction(() => window.ready); }')
        evaluate('source.initializeDataSource()')
        start = len(requests)
        value = evaluate("(async()=>{const c=new AbortController();const a=source.fetchDataJsonResult('probe.json',{signal:c.signal});const b=source.fetchDataJsonResult('probe.json');setTimeout(()=>c.abort(),50);const r=await Promise.allSettled([a,b]);return {first:r[0].status,firstName:r[0].reason?.name,second:r[1].status,data:r[1].value?.data,release:r[1].value?.release}})()")
        manifest_count = sum(item['path'].endswith('/manifest.json') for item in requests[start:])
        record('one cancelled manifest consumer preserves another consumer', {'result': value, 'manifestRequests': manifest_count}, value['first'] == 'rejected' and value['firstName'] == 'AbortError' and value['second'] == 'fulfilled' and value['release'] == old['release'] and manifest_count == 1)

        cli('goto', origin + '/harness?phase=abandoned')
        cli('run-code', 'async page => { await page.waitForFunction(() => window.ready); }')
        evaluate('source.initializeDataSource()')
        start = len(requests)
        value = evaluate("(async()=>{const c=new AbortController();const p=source.fetchDataJsonResult('probe.json',{signal:c.signal});setTimeout(()=>c.abort(),50);try{await p;return false}catch(e){return e.name==='AbortError'}})()")
        controls['slow_manifest'] = False
        recovered = evaluate("source.fetchDataJsonResult('probe.json').then(r=>({data:r.data,release:r.release}))")
        manifest_count = sum(item['path'].endswith('/manifest.json') for item in requests[start:])
        record('abandoned manifest request is evicted before retry', {'cancelled': value, 'recovered': recovered, 'manifestRequests': manifest_count}, value and recovered['release'] == old['release'] and manifest_count == 2)
        evidence['runtime'] = evaluate('({userAgent:navigator.userAgent,hostname:location.hostname,isSecureContext,crypto:!!crypto.subtle})')
        evidence['network'] = cli('requests')
        evidence['console'] = cli('console', 'warning')
        cli('run-code', 'async page => { await page.evaluate(value=>window.r2NetworkEvidence=value,{requests:page.r2Network,blocked:page.r2Blocked}); }')
        evidence['browserNetwork'] = evaluate('r2NetworkEvidence')
        record('browser only requested loopback or intercepted synthetic HTTPS', evidence['browserNetwork'], not evidence['browserNetwork']['blocked'] and all(urllib.parse.urlparse(url).hostname in (HOST, DIRECT) for url in evidence['browserNetwork']['requests']))
        record('fixture server received only local traffic', {'requestCount': len(requests), 'hosts': sorted({item['host'] for item in requests})}, all(urllib.parse.urlparse('http://' + item['host']).hostname in (HOST, '127.0.0.1') for item in requests))
    except Exception as error:
        record('browser harness completion', {'error': repr(error)}, False)
        raise
    finally:
        try:
            cli('close')
        except Exception:
            pass
        server.shutdown()
        evidence['sourceHashes'] = source_hashes
        evidence['configuration'] = config
        write_text_once(out / 'report.json', json.dumps(evidence, ensure_ascii=False, indent=2))
        write_text_once(out / 'requests.json', json.dumps(requests, ensure_ascii=False, indent=2))
        write_text_once(out / 'cli.json', json.dumps(cli_logs, ensure_ascii=False, indent=2))
        lines = ['# R2 浏览器本地验证', '', evidence['scope'], '', '浏览器：离线缓存 playwright-cli + 独立隔离 Chromium；死代理、DNS deny 规则、CSP 与路由白名单拦截外部流量。', '', '公开 HTTPS R2 由 Playwright route 转发至 127.0.0.1 合成夹具；未连接真实 R2，未执行 Functions（其契约由独立 Node 测试覆盖）。', '']
        lines += ['- ' + item['status'] + '：' + item['name'] for item in evidence['checks']]
        lines += ['', '验证脚本 SHA-256：`' + evidence['scriptSha256'] + '`。', '', '详细观察值与原始 HTML、验证依赖和模块字节哈希：`report.json`；请求日志：`requests.json`；CLI 原始输出：`cli.json`。']
        write_text_once(out / '报告.md', '\n'.join(lines) + '\n')
    return 0 if all(item['status'] == 'PASS' for item in evidence['checks']) else 1


if __name__ == '__main__':
    raise SystemExit(main())
