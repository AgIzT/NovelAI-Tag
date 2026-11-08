import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const original = {
  fetch: globalThis.fetch,
  location: globalThis.location,
  document: globalThis.document,
  warn: console.warn,
};

let caseNumber = 0;
const release = 'r-0123456789abcdefabcd';
const indexHtml = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');

function extractInlineBootScript() {
  const marker = '/* 数据链提前起跑：';
  const markerIndex = indexHtml.indexOf(marker);
  assert.notEqual(markerIndex, -1, 'index.html should contain the data boot marker');
  const openTag = indexHtml.lastIndexOf('<script>', markerIndex);
  const closeTag = indexHtml.indexOf('</script>', markerIndex);
  assert.notEqual(openTag, -1, 'data boot should be inside a script tag');
  assert.notEqual(closeTag, -1, 'data boot script tag should be closed');
  return indexHtml.slice(openTag + '<script>'.length, closeTag);
}

const inlineBootScript = extractInlineBootScript();

function extractInlineConfigText() {
  const match = /<script type="application\/json" id="data-source-config">([\s\S]*?)<\/script>/.exec(indexHtml);
  assert.ok(match, 'index.html should inline the data source config before the boot script');
  assert.ok(indexHtml.indexOf(match[0]) < indexHtml.indexOf('/* 数据链提前起跑：'), 'inline config must be parsed before the boot script runs');
  return match[1];
}

const inlineConfigText = extractInlineConfigText();

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function config(remoteHosts = ['novelai.quicktagcloud.com']) {
  return jsonResponse({
    schemaVersion: 1,
    baseUrl: 'https://assets.quicktagcloud.com/data',
    pointer: 'current.json',
    remoteHosts,
  });
}

async function runInlineBootCase({ hostname, protocol = 'https:', responses, basePath = '/', inlineConfig = null }) {
  const href = protocol === 'file:'
    ? 'file:///index.html'
    : `${protocol}//${hostname}${basePath}`;
  const calls = [];
  const fetch = async (url, options = {}) => {
    const key = new URL(String(url), href).href;
    calls.push({ url: key, cache: options.cache, signal: options.signal });
    const response = responses[key];
    if (typeof response === 'function') return response(options);
    if (response instanceof Error) throw response;
    if (!response) throw new Error(`unexpected inline boot fetch ${key}`);
    return response;
  };
  const window = {};
  const document = {
    getElementById: id => (id === 'data-source-config' && inlineConfig !== null ? { textContent: inlineConfig } : null),
  };
  runInNewContext(inlineBootScript, {
    document,
    fetch,
    location: { href, hostname, protocol },
    window,
  }, { filename: 'site/index.html#data-boot' });
  const boot = window.__atlasBoot || null;
  if (boot) await Promise.allSettled([boot.config, boot.pointer]);
  return { boot, calls };
}

async function loadCase({ hostname, protocol = 'https:', responses, localEdition = false, basePath = '/', boot = null }) {
  caseNumber += 1;
  /* index.html 的内联脚本会把 data-source.json / current.json 提前发出去挂在这里；
     这里模拟"已经在飞的请求"，验证模块认领它、且认领失败能退回自己发。 */
  if (boot) globalThis.__atlasBoot = boot;
  else delete globalThis.__atlasBoot;
  const href = `${protocol}//${hostname}${basePath}`;
  globalThis.location = { href, hostname, protocol };
  globalThis.document = {
    baseURI: href,
    body: { classList: { contains: name => localEdition && name === 'local-edition' } },
  };
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const key = String(url);
    calls.push({ url: key, cache: options.cache, signal: options.signal });
    const response = responses[key];
    if (typeof response === 'function') return response(options);
    if (response instanceof Error) throw response;
    if (!response) throw new Error(`unexpected fetch ${key}`);
    return response;
  };
  const mod = await import(`../site/assets/data-source.js?case=${caseNumber}`);
  return { mod, calls };
}

try {
  console.warn = () => {};

  {
    const responses = {
      'https://novelai.quicktagcloud.com/data-source.json': config(),
      'https://assets.quicktagcloud.com/data/current.json': jsonResponse({ release }),
      [`https://assets.quicktagcloud.com/data/releases/${release}/codexes.json`]: jsonResponse([{ id: 'remote' }]),
    };
    const { mod, calls } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses });
    const result = await mod.fetchDataJsonResult('codexes.json');
    assert.equal(result.source, 'r2');
    assert.equal(result.data[0].id, 'remote');
    assert.equal(calls[1].cache, 'no-store');
  }

  {
    const host = 'preview.novelai-tag.pages.dev';
    const { boot, calls: bootCalls } = await runInlineBootCase({
      hostname: host,
      responses: {
        [`https://${host}/data-source.json`]: config(),
      },
    });
    assert.ok(boot, 'Pages Preview should still prefetch the same-origin config');
    assert.equal(await boot.pointer, null, 'Pages Preview should not start the public R2 pointer request');
    assert.deepEqual(bootCalls.map(call => call.url), [`https://${host}/data-source.json`]);

    const responses = {
      [`https://${host}/data/current.json`]: jsonResponse({ release }),
      [`https://${host}/data/releases/${release}/codexes.json`]: jsonResponse([{ id: 'preview-proxy' }]),
    };
    const { mod, calls } = await loadCase({ hostname: host, responses, boot });
    const result = await mod.fetchDataJsonResult('codexes.json');
    assert.equal(result.source, 'proxy');
    assert.equal(result.data[0].id, 'preview-proxy');
    assert.equal(result.release, release);
    assert.equal([...bootCalls, ...calls].some(call => call.url.startsWith('https://assets.quicktagcloud.com/')), false);
    assert.equal(calls.some(call => call.url.endsWith('/data-source.json')), false, 'module should claim prefetched config');
  }

  {
    const responses = {
      'https://novelai.quicktagcloud.com/data-source.json': config(),
      'https://assets.quicktagcloud.com/data/current.json': new Error('public R2 failed'),
      'https://novelai.quicktagcloud.com/data/current.json': jsonResponse({ release }),
      [`https://novelai.quicktagcloud.com/data/releases/${release}/codexes.json`]: jsonResponse([{ id: 'proxy-init' }]),
    };
    const { mod } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses });
    const result = await mod.fetchDataJsonResult('codexes.json');
    assert.equal(result.source, 'proxy-fallback');
    assert.equal(result.data[0].id, 'proxy-init');
    assert.equal(mod.getDataSource().mode, 'proxy');
  }

  {
    const responses = {
      'https://novelai.quicktagcloud.com/data-source.json': config(),
      'https://assets.quicktagcloud.com/data/current.json': jsonResponse({ release }),
      [`https://assets.quicktagcloud.com/data/releases/${release}/demo.json`]: new Error('cors failed'),
      [`https://novelai.quicktagcloud.com/data/releases/${release}/demo.json`]: jsonResponse({ id: 'proxy-fallback' }),
    };
    const { mod } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses });
    const result = await mod.fetchDataJsonResult('demo.json');
    assert.equal(result.source, 'proxy-fallback');
    assert.equal(result.data.id, 'proxy-fallback');
    assert.equal(result.release, release);
  }

  /* 提前起跑：认领内联脚本发出的两跳，不应再重复请求 data-source.json 与 current.json */
  {
    const { boot, calls: bootCalls } = await runInlineBootCase({
      hostname: 'novelai.quicktagcloud.com',
      responses: {
        'https://novelai.quicktagcloud.com/data-source.json': config(),
        'https://assets.quicktagcloud.com/data/current.json': jsonResponse({ release }),
      },
    });
    assert.ok(boot, 'production should create the boot handoff');
    assert.deepEqual(bootCalls.map(call => call.url), [
      'https://novelai.quicktagcloud.com/data-source.json',
      'https://assets.quicktagcloud.com/data/current.json',
    ]);
    assert.equal(bootCalls.every(call => call.cache === 'no-store'), true);
    const responses = {
      [`https://assets.quicktagcloud.com/data/releases/${release}/codexes.json`]: jsonResponse([{ id: 'booted' }]),
    };
    const { mod, calls } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses, boot });
    const result = await mod.fetchDataJsonResult('codexes.json');
    assert.equal(result.source, 'r2');
    assert.equal(result.data[0].id, 'booted');
    assert.equal(result.release, release);
    // 只剩取数据那一发；两跳都被认领掉了
    assert.equal(calls.length, 1);
    assert.equal(calls.some(call => call.url.endsWith('/data-source.json')), false);
    assert.equal(calls.some(call => call.url.endsWith('/current.json')), false);
    // 认领是一次性的，用过即作废，避免失败后被反复复用
    assert.equal(globalThis.__atlasBoot.config, null);
    assert.equal(globalThis.__atlasBoot.pointer, null);
  }

  /* 内联配置：与 data-source.json 逐字段相同，且解析到就直接发指针，省掉取配置那一跳 */
  {
    const fileConfig = JSON.parse(readFileSync(new URL('../site/data-source.json', import.meta.url), 'utf8'));
    assert.deepEqual(JSON.parse(inlineConfigText), fileConfig, 'index.html 内联的数据源配置必须与 site/data-source.json 一致');

    const pointerUrl = `${String(fileConfig.baseUrl).replace(/\/+$/, '')}/${fileConfig.v2Pointer || fileConfig.pointer}`;
    const { boot, calls } = await runInlineBootCase({
      hostname: 'novelai.quicktagcloud.com',
      inlineConfig: inlineConfigText,
      responses: { [pointerUrl]: jsonResponse({ release }) },
    });
    assert.deepEqual(calls.map(call => call.url), [pointerUrl], 'inline config should skip the data-source.json request');
    assert.equal(calls[0].cache, 'no-store');
    // vm 沙箱里建的对象原型不同，按 JSON 值比较
    assert.deepEqual(JSON.parse(JSON.stringify(await boot.config)), fileConfig);
    assert.equal(boot.pointerPath, fileConfig.v2Pointer || fileConfig.pointer);
  }
  {
    const { boot, calls } = await runInlineBootCase({
      hostname: 'preview.novelai-tag.pages.dev',
      inlineConfig: inlineConfigText,
      responses: {},
    });
    assert.equal(calls.length, 0, 'Pages Preview with inline config should not send any boot request');
    assert.equal(await boot.pointer, null);
  }
  {
    const { boot, calls } = await runInlineBootCase({
      hostname: 'novelai.quicktagcloud.com',
      inlineConfig: '{not json',
      responses: {
        'https://novelai.quicktagcloud.com/data-source.json': config(),
        'https://assets.quicktagcloud.com/data/current.json': jsonResponse({ release }),
      },
    });
    assert.deepEqual(calls.map(call => call.url), [
      'https://novelai.quicktagcloud.com/data-source.json',
      'https://assets.quicktagcloud.com/data/current.json',
    ], 'broken inline config should fall back to fetching data-source.json');
    assert.equal((await boot.pointer).release, release);
  }

  /* localhost 与 file: 保持零 boot 请求，避免本地/离线版意外触网 */
  for (const runtime of [
    { hostname: 'localhost', protocol: 'http:' },
    { hostname: '', protocol: 'file:' },
  ]) {
    const { boot, calls } = await runInlineBootCase({ ...runtime, responses: {} });
    assert.equal(boot, null);
    assert.equal(calls.length, 0);
  }

  /* 提前起跑失败（离线/超时/被拦）时必须退回正常流程，不能把整站带崩 */
  {
    const boot = {
      config: Promise.reject(new Error('boot config failed')),
      pointer: Promise.reject(new Error('boot pointer failed')),
    };
    boot.config.catch(() => {});
    boot.pointer.catch(() => {});
    const responses = {
      'https://novelai.quicktagcloud.com/data-source.json': config(),
      'https://assets.quicktagcloud.com/data/current.json': jsonResponse({ release }),
      [`https://assets.quicktagcloud.com/data/releases/${release}/codexes.json`]: jsonResponse([{ id: 'boot-recovered' }]),
    };
    const { mod, calls } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses, boot });
    const result = await mod.fetchDataJsonResult('codexes.json');
    assert.equal(result.source, 'r2');
    assert.equal(result.data[0].id, 'boot-recovered');
    assert.equal(calls.some(call => call.url.endsWith('/data-source.json')), true);
    assert.equal(calls.some(call => call.url.endsWith('/current.json')), true);
  }

  {
    const responses = {
      'http://localhost/data/demo.json': jsonResponse({ id: 'local' }),
    };
    const { mod, calls } = await loadCase({ hostname: 'localhost', protocol: 'http:', responses });
    const result = await mod.fetchDataJsonResult('demo.json');
    assert.equal(result.source, 'local');
    assert.equal(result.data.id, 'local');
    assert.equal(calls.length, 1);
  }

  {
    const responses = {
      'https://novelai.quicktagcloud.com/data/demo.json': jsonResponse({ id: 'local-edition' }),
    };
    const { mod, calls } = await loadCase({
      hostname: 'novelai.quicktagcloud.com',
      responses,
      localEdition: true,
    });
    const result = await mod.fetchDataJsonResult('demo.json');
    assert.equal(result.source, 'local');
    assert.equal(result.data.id, 'local-edition');
    assert.equal(calls.length, 1);
  }

  {
    const host = 'agizt.github.io';
    const basePath = '/NovelAI-Tag/';
    const responses = {
      [`https://${host}${basePath}data-source.json`]: config(),
      [`https://${host}${basePath}data/current.json`]: new Error('no Pages Function'),
      [`https://${host}${basePath}data/codexes.json`]: jsonResponse([{ id: 'local-subpath' }]),
    };
    const { mod } = await loadCase({ hostname: host, basePath, responses });
    const result = await mod.fetchDataJsonResult('codexes.json');
    assert.equal(result.source, 'local');
    assert.equal(result.data[0].id, 'local-subpath');
  }

  {
    const responses = {
      'https://novelai.quicktagcloud.com/data-source.json': config(),
      'https://assets.quicktagcloud.com/data/current.json': jsonResponse({ release }),
      [`https://assets.quicktagcloud.com/data/releases/${release}/codexes.json`]: new Error('index failed'),
      [`https://novelai.quicktagcloud.com/data/releases/${release}/codexes.json`]: jsonResponse([{ id: 'proxy-index' }]),
      [`https://novelai.quicktagcloud.com/data/releases/${release}/demo.json`]: jsonResponse({ id: 'proxy-book' }),
    };
    const { mod, calls } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses });
    const index = await mod.fetchDataJsonResult('codexes.json');
    assert.equal(index.source, 'proxy-fallback');
    assert.equal(mod.getDataSource().mode, 'proxy');
    const book = await mod.fetchDataJsonResult('demo.json');
    assert.equal(book.source, 'proxy-fallback');
    assert.equal(book.data.id, 'proxy-book');
    assert.equal(calls.some(call => call.url.startsWith('https://assets.quicktagcloud.com/') && call.url.endsWith('demo.json')), false);
  }

  {
    const responses = {
      'https://novelai.quicktagcloud.com/data-source.json': config(),
      'https://assets.quicktagcloud.com/data/current.json': jsonResponse({ release }),
      [`https://assets.quicktagcloud.com/data/releases/${release}/codexes.json`]: async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return jsonResponse([{ id: 'r2-index-must-not-escape' }]);
      },
      [`https://assets.quicktagcloud.com/data/releases/${release}/media.json`]: new Error('media failed first'),
      [`https://assets.quicktagcloud.com/data/releases/${release}/about.json`]: jsonResponse({ intro: 'r2-about' }),
      [`https://novelai.quicktagcloud.com/data/releases/${release}/codexes.json`]: jsonResponse([{ id: 'proxy-index' }]),
      [`https://novelai.quicktagcloud.com/data/releases/${release}/media.json`]: jsonResponse({ baseUrl: 'proxy-media' }),
      [`https://novelai.quicktagcloud.com/data/releases/${release}/about.json`]: jsonResponse({ intro: 'proxy-about' }),
    };
    const { mod } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses });
    const [index, media, about] = await mod.fetchDataJsonBatch([
      { path: 'codexes.json', cache: 'no-store' },
      { path: 'media.json', cache: 'no-store' },
      { path: 'about.json', cache: 'no-store' },
    ]);
    assert.equal(mod.getDataSource().mode, 'proxy');
    assert.deepEqual([index.source, media.source, about.source], [
      'proxy-fallback', 'proxy-fallback', 'proxy-fallback',
    ]);
    assert.equal(index.data[0].id, 'proxy-index');
    assert.equal(media.data.baseUrl, 'proxy-media');
    assert.equal(about.data.intro, 'proxy-about');
  }

  /* Explicit v2 uses content objects and one shared, identity-bound manifest. */
  const v2Fixture = data => {
    const files = {};
    const objects = {};
    for (const [path, value] of Object.entries(data)) {
      const body = Buffer.from(JSON.stringify(value));
      const sha256 = createHash('sha256').update(body).digest('hex');
      files[path] = { sha256, size: body.length };
      objects[path] = { key: `objects/sha256/${sha256.slice(0, 2)}/${sha256}.json`, body };
    }
    const contentHash = createHash('sha256').update('r2-cas-v2\n' + Object.keys(files).sort().map(path => `${path}\0${files[path].sha256}\0${files[path].size}\n`).join('')).digest('hex');
    const release = `r2-${contentHash}`;
    const manifestPath = `v2/releases/${release}/manifest.json`;
    const manifest = { contentHash, files: Object.fromEntries(Object.keys(files).sort().map(path => [path, files[path]])), release, schemaVersion: 2 };
    const manifestBody = JSON.stringify(manifest) + '\n';
    const pointer = { schemaVersion: 2, release, contentHash, manifest: `data/${manifestPath}`, publishedAt: '2026-10-20T00:00:00Z', operationId: 'a'.repeat(32) };
    return { release, pointer, manifestPath, manifestBody, objects };
  };
  const v2Config = (hosts = ['novelai.quicktagcloud.com']) => jsonResponse({ schemaVersion: 1, baseUrl: 'https://assets.quicktagcloud.com/data', pointer: 'current.json', v2Pointer: 'v2/current.json', remoteHosts: hosts });
  const direct = 'https://assets.quicktagcloud.com/data/';
  const proxy = 'https://novelai.quicktagcloud.com/data/';
  {
    const lab = v2Fixture({ 'codexes.json': [{ id: 'v2' }], 'media.json': { baseUrl: 'v2-media' }, 'about.json': { intro: 'v2-about' } });
    const responses = {
      'https://novelai.quicktagcloud.com/data-source.json': v2Config(),
      [direct + 'v2/current.json']: jsonResponse(lab.pointer),
      [direct + lab.manifestPath]: () => new Response(lab.manifestBody),
      ...Object.fromEntries(Object.values(lab.objects).map(item => [direct + item.key, () => new Response(item.body)])),
    };
    // A v1 prefetch from an older HTML shell cannot be claimed as the v2 pointer.
    const boot = { pointer: Promise.resolve({ release }), pointerPath: 'current.json' };
    const { mod, calls } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses, boot });
    const results = await mod.fetchDataJsonBatch(['codexes.json', 'media.json', 'about.json']);
    assert.equal(results[0].data[0].id, 'v2');
    assert.equal(results.every(item => item.source === 'r2' && item.release === lab.release), true);
    assert.equal(results[0].url, direct + lab.objects['codexes.json'].key);
    assert.equal(calls.filter(item => item.url === direct + lab.manifestPath).length, 1);
    assert.equal(calls.some(item => item.url === direct + 'current.json'), false);
  }
  {
    const lab = v2Fixture({ 'demo.json': { id: 'same-release-proxy' } });
    const responses = {
      'https://novelai.quicktagcloud.com/data-source.json': v2Config(),
      [direct + 'v2/current.json']: jsonResponse(lab.pointer),
      [direct + lab.manifestPath]: new Error('public manifest unavailable'),
      [proxy + lab.manifestPath]: () => new Response(lab.manifestBody),
      [proxy + `v2/releases/${lab.release}/demo.json`]: () => new Response(lab.objects['demo.json'].body),
    };
    const { mod, calls } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses });
    const result = await mod.fetchDataJsonResult('demo.json');
    assert.equal(result.data.id, 'same-release-proxy');
    assert.equal(result.release, lab.release);
    assert.equal(result.source, 'proxy-fallback');
    assert.equal(calls.some(item => item.url === proxy + 'current.json' || item.url === proxy + 'v2/current.json'), false);
  }
  {
    const lab = v2Fixture({ 'codexes.json': [{ id: 'safe' }], 'media.json': { baseUrl: 'safe' }, 'about.json': { intro: 'safe' } });
    const responses = {
      'https://novelai.quicktagcloud.com/data-source.json': v2Config(),
      [direct + 'v2/current.json']: jsonResponse(lab.pointer),
      [direct + lab.manifestPath]: () => new Response(lab.manifestBody),
      [proxy + lab.manifestPath]: () => new Response(lab.manifestBody),
      ...Object.fromEntries(Object.entries(lab.objects).flatMap(([path, item]) => [
        [direct + item.key, () => new Response(path === 'media.json' ? Buffer.alloc(item.body.length, 32) : item.body)],
        [proxy + `v2/releases/${lab.release}/${path}`, () => new Response(item.body)],
      ])),
    };
    const { mod } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses });
    const results = await mod.fetchDataJsonBatch(['codexes.json', 'media.json', { path: 'about.json', fallbackValue: {} }]);
    assert.equal(results.every(item => item.source === 'proxy-fallback' && item.release === lab.release), true);
    assert.equal(mod.getDataSource().mode, 'proxy');
    assert.equal(results[1].data.baseUrl, 'safe');
  }
  {
    const lab = v2Fixture({ 'demo.json': { id: 'retry-manifest' } });
    let manifests = 0;
    const responses = {
      'https://novelai.quicktagcloud.com/data-source.json': v2Config(),
      [direct + 'v2/current.json']: jsonResponse(lab.pointer),
      [direct + lab.manifestPath]: () => { manifests += 1; if (manifests === 1) throw new Error('transient'); return new Response(lab.manifestBody); },
      [proxy + lab.manifestPath]: new Error('proxy transient'),
      [direct + lab.objects['demo.json'].key]: () => new Response(lab.objects['demo.json'].body),
    };
    const { mod } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses });
    await assert.rejects(mod.fetchDataJsonResult('demo.json'));
    const retried = await mod.fetchDataJsonResult('demo.json');
    assert.equal(retried.data.id, 'retry-manifest');
    assert.equal(manifests, 2, 'manifest failures must not poison the shared cache');
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(mod.fetchDataJsonResult('demo.json', { signal: aborted.signal }), { name: 'AbortError' });
  }
  {
    const host = 'preview.novelai-tag.pages.dev';
    const lab = v2Fixture({ 'demo.json': { id: 'preview-v2' } });
    const root = `https://${host}/data/`;
    const responses = {
      [`https://${host}/data-source.json`]: v2Config(),
      [root + 'v2/current.json']: jsonResponse(lab.pointer),
      [root + lab.manifestPath]: () => new Response(lab.manifestBody),
      [root + `v2/releases/${lab.release}/demo.json`]: () => new Response(lab.objects['demo.json'].body),
    };
    const { mod, calls } = await loadCase({ hostname: host, responses });
    const result = await mod.fetchDataJsonResult('demo.json');
    assert.equal(result.data.id, 'preview-v2');
    assert.equal(result.source, 'proxy');
    assert.equal(calls.some(item => item.url.startsWith(direct)), false);
  }
  {
    const lab = v2Fixture({ 'demo.json': { id: 'v2-boot' } });
    const { boot, calls: bootCalls } = await runInlineBootCase({ hostname: 'novelai.quicktagcloud.com', responses: {
      'https://novelai.quicktagcloud.com/data-source.json': v2Config(),
      [direct + 'v2/current.json']: jsonResponse(lab.pointer),
    } });
    assert.equal(boot.pointerPath, 'v2/current.json');
    assert.equal(boot.baseUrl, direct.slice(0, -1));
    const { mod, calls } = await loadCase({ hostname: 'novelai.quicktagcloud.com', boot, responses: {
      [direct + lab.manifestPath]: () => new Response(lab.manifestBody),
      [direct + lab.objects['demo.json'].key]: () => new Response(lab.objects['demo.json'].body),
    } });
    assert.equal((await mod.fetchDataJsonResult('demo.json')).data.id, 'v2-boot');
    assert.equal(bootCalls.length, 2);
    assert.equal(calls.length, 2, 'v2 adopts both boot requests without sending them again');
  }
  {
    const lab = v2Fixture({ 'demo.json': { id: 'shared-after-cancel' } });
    let finishManifest;
    let manifestStarted;
    const started = new Promise(resolve => { manifestStarted = resolve; });
    const responses = {
      'https://novelai.quicktagcloud.com/data-source.json': v2Config(),
      [direct + 'v2/current.json']: jsonResponse(lab.pointer),
      [direct + lab.manifestPath]: () => { manifestStarted(); return new Promise(resolve => { finishManifest = resolve; }); },
      [direct + lab.objects['demo.json'].key]: () => new Response(lab.objects['demo.json'].body),
    };
    const { mod, calls } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses });
    const controller = new AbortController();
    const canceled = mod.fetchDataJsonResult('demo.json', { signal: controller.signal });
    const survivor = mod.fetchDataJsonResult('demo.json');
    await started;
    controller.abort();
    let timer;
    await assert.rejects(Promise.race([canceled, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('canceled consumer hung on shared manifest')), 200); })]), { name: 'AbortError' });
    clearTimeout(timer);
    finishManifest(new Response(lab.manifestBody));
    assert.equal((await survivor).data.id, 'shared-after-cancel');
    assert.equal(calls.filter(item => item.url === direct + lab.manifestPath).length, 1);
    assert.equal(calls.filter(item => item.url === direct + lab.objects['demo.json'].key).length, 1);
    assert.equal(calls.some(item => item.url.startsWith(proxy)), false);
  }
  {
    const lab = v2Fixture({ 'demo.json': { id: 'pointer-proxy' } });
    const responses = {
      'https://novelai.quicktagcloud.com/data-source.json': v2Config(),
      [direct + 'v2/current.json']: new Error('public pointer unreachable'),
      [proxy + 'v2/current.json']: jsonResponse(lab.pointer),
      [proxy + lab.manifestPath]: () => new Response(lab.manifestBody),
      [proxy + `v2/releases/${lab.release}/demo.json`]: () => new Response(lab.objects['demo.json'].body),
    };
    const { mod, calls } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses });
    const result = await mod.fetchDataJsonResult('demo.json');
    assert.equal(result.data.id, 'pointer-proxy');
    assert.equal(result.source, 'proxy-fallback');
    assert.equal(calls.some(item => item.url.endsWith('/data/current.json')), false);
    const [optional] = await mod.fetchDataJsonBatch([{ path: 'absent.json', fallbackValue: { optional: true } }]);
    assert.deepEqual(optional.data, { optional: true });
    assert.equal(optional.release, lab.release);
  }
  {
    const lab = v2Fixture({ 'demo.json': { id: 'fresh-after-all-cancel' } });
    let manifestStarted;
    const started = new Promise(resolve => { manifestStarted = resolve; });
    let count = 0;
    const { mod, calls } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses: {
      'https://novelai.quicktagcloud.com/data-source.json': v2Config(),
      [direct + 'v2/current.json']: jsonResponse(lab.pointer),
      [direct + lab.manifestPath]: options => {
        count++;
        if (count > 1) return new Response(lab.manifestBody);
        manifestStarted();
        return new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      },
      [direct + lab.objects['demo.json'].key]: () => new Response(lab.objects['demo.json'].body),
    } });
    const controller = new AbortController();
    const canceled = mod.fetchDataJsonResult('demo.json', { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(canceled, { name: 'AbortError' });
    assert.equal(calls.find(item => item.url === direct + lab.manifestPath).signal?.aborted, true, 'all consumers gone aborts the underlying manifest request');
    assert.equal((await mod.fetchDataJsonResult('demo.json')).data.id, 'fresh-after-all-cancel');
    assert.equal(count, 2, 'next request starts a fresh manifest rather than inheriting a canceled promise');
  }
  for (const explicit of [false, true]) {
    const lab = v2Fixture({ 'demo.json': { id: 'custom-prefix' } });
    const base = explicit ? 'https://assets.quicktagcloud.com/mounted' : 'https://assets.quicktagcloud.com/archive/data';
    const pointer = { ...lab.pointer, manifest: `archive/data/${lab.manifestPath}` };
    const responses = {
      'https://novelai.quicktagcloud.com/data-source.json': jsonResponse({ schemaVersion: 1, baseUrl: base,
        v2Pointer: 'v2/current.json', remoteHosts: ['novelai.quicktagcloud.com'], ...(explicit ? { dataPrefix: 'archive/data' } : {}) }),
      [base + '/v2/current.json']: jsonResponse(pointer),
      [base + '/' + lab.manifestPath]: new Error('direct transient'),
      [proxy + lab.manifestPath]: () => new Response(lab.manifestBody),
      [proxy + `v2/releases/${lab.release}/demo.json`]: () => new Response(lab.objects['demo.json'].body),
    };
    const { mod, calls } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses });
    const result = await mod.fetchDataJsonResult('demo.json');
    assert.equal(result.data.id, 'custom-prefix');
    assert.equal(result.release, lab.release);
    assert.equal(result.source, 'proxy-fallback');
    assert.equal(calls.some(item => item.url.endsWith('/data/current.json')), false);
  }
  for (const broken of ['config', 'pointer']) {
    const responses = {
      'https://novelai.quicktagcloud.com/data-source.json': broken === 'config'
        ? jsonResponse({ schemaVersion: 1, baseUrl: 'http://invalid.test/data', v2Pointer: 'v2/current.json' })
        : v2Config(),
      [direct + 'v2/current.json']: new Error('v2 unavailable'),
      [proxy + 'v2/current.json']: () => { throw new Error('v2 proxy unavailable'); },
      [proxy + 'current.json']: () => jsonResponse({ release }),
      [proxy + `releases/${release}/demo.json`]: () => jsonResponse({ id: 'wrong-v1' }),
      [proxy + 'demo.json']: () => jsonResponse({ id: 'wrong-v1-logical' }),
    };
    const { mod, calls } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses });
    await assert.rejects(mod.fetchDataJsonResult('demo.json'), /v2 proxy unavailable/);
    assert.equal(calls.some(item => item.url === proxy + 'current.json' || item.url === proxy + 'demo.json'), false);
  }

  /* 首屏数据预热：提前发出的对象请求由应用认领一次，不重复下载；认领后照常校验 */
  const v2Responses = lab => ({
    'https://novelai.quicktagcloud.com/data-source.json': v2Config(),
    [direct + 'v2/current.json']: jsonResponse(lab.pointer),
    [direct + lab.manifestPath]: () => new Response(lab.manifestBody),
    ...Object.fromEntries(Object.values(lab.objects).map(item => [direct + item.key, () => new Response(item.body)])),
  });
  {
    const lab = v2Fixture({ 'codexes.json': [{ id: 'book' }], 'media.json': { baseUrl: 'm' }, 'book.json': { id: 'book-data' } });
    const { mod, calls } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses: v2Responses(lab) });
    const started = await mod.prewarmDataFiles(['codexes.json', 'book.json', 'absent.json']);
    assert.deepEqual(Object.keys(started).sort(), ['book.json', 'codexes.json'], 'absent logical files are skipped');
    await Promise.all(Object.values(started));
    const [index] = await mod.fetchDataJsonBatch(['codexes.json']);
    const book = await mod.fetchDataJsonResult('book.json');
    assert.equal(index.data[0].id, 'book');
    assert.equal(index.source, 'r2');
    assert.equal(book.data.id, 'book-data');
    const bookUrl = direct + lab.objects['book.json'].key;
    const countOf = url => calls.filter(item => item.url === url).length;
    assert.equal(countOf(direct + lab.objects['codexes.json'].key), 1, 'claimed prewarm must not download codexes.json again');
    assert.equal(countOf(bookUrl), 1, 'claimed prewarm must not download the book again');
    assert.equal(countOf(direct + lab.manifestPath), 1);
    // 认领只有一次：之后再读走普通请求
    await mod.fetchDataJsonResult('book.json');
    assert.equal(countOf(bookUrl), 2);
  }
  {
    const lab = v2Fixture({ 'book.json': { id: 'recovered' } });
    const bookUrl = direct + lab.objects['book.json'].key;
    let attempts = 0;
    const responses = { ...v2Responses(lab), [bookUrl]: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('prewarm network failure');
      return new Response(lab.objects['book.json'].body);
    } };
    const { mod } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses });
    const started = await mod.prewarmDataFiles(['book.json']);
    await assert.rejects(started['book.json']);
    const result = await mod.fetchDataJsonResult('book.json');
    assert.equal(result.data.id, 'recovered', 'a failed prewarm falls back to a normal request');
    assert.equal(result.source, 'r2');
    assert.equal(attempts, 2);
  }
  {
    const lab = v2Fixture({ 'book.json': { id: 'abort-claim' } });
    const { mod } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses: v2Responses(lab) });
    await mod.prewarmDataFiles(['book.json']);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(mod.fetchDataJsonResult('book.json', { signal: controller.signal }), { name: 'AbortError' });
  }
  for (const runtime of [
    { hostname: 'localhost', protocol: 'http:', responses: {} },
    { hostname: 'preview.novelai-tag.pages.dev', responses: (() => {
      const lab = v2Fixture({ 'codexes.json': [{ id: 'p' }] });
      const root = 'https://preview.novelai-tag.pages.dev/data/';
      return {
        'https://preview.novelai-tag.pages.dev/data-source.json': v2Config(),
        [root + 'v2/current.json']: jsonResponse(lab.pointer),
        [root + lab.manifestPath]: () => new Response(lab.manifestBody),
      };
    })() },
  ]) {
    const { mod, calls } = await loadCase(runtime);
    const before = calls.length;
    assert.deepEqual(await mod.prewarmDataFiles(['codexes.json']), {}, `${runtime.hostname} must not prewarm`);
    assert.equal(calls.slice(before).some(item => item.url.includes('/objects/')), false);
  }

  /* 预热模块端到端：选中与 init() 同一本书（别名、成人书锁定），只预热这一本，应用随后认领 */
  {
    const lab = v2Fixture({
      'codexes.json': [{ id: 'adult', nsfw: true }, { id: 'b', aliases: ['alias-b'] }, { id: 'c' }],
      'media.json': { baseUrl: 'media' },
      'about.json': { intro: 'about' },
      'adult.json': { id: 'adult-data' },
      'b.json': { id: 'b-data' },
      'c.json': { id: 'c-data' },
    });
    const calls = [];
    const responses = v2Responses(lab);
    globalThis.fetch = async (url, options = {}) => {
      const key = String(url);
      calls.push({ url: key, cache: options.cache });
      const response = responses[key];
      if (typeof response === 'function') return response(options);
      if (!response) throw new Error(`unexpected fetch ${key}`);
      return response;
    };
    globalThis.location = { href: 'https://novelai.quicktagcloud.com/?c=alias-b', hostname: 'novelai.quicktagcloud.com', protocol: 'https:', pathname: '/', search: '?c=alias-b' };
    globalThis.document = { baseURI: globalThis.location.href, body: null };
    globalThis.localStorage = { getItem: () => null };
    globalThis.__atlasBoot = {
      config: Promise.resolve(JSON.parse(inlineConfigText)),
      pointer: Promise.resolve(lab.pointer),
      pointerPath: 'v2/current.json',
      baseUrl: direct.slice(0, -1),
    };
    await import('../site/assets/first-screen-prewarm.js');
    const objectUrl = path => direct + lab.objects[path].key;
    for (let waited = 0; waited < 2000 && !calls.some(item => item.url === objectUrl('b.json')); waited += 10) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(calls.some(item => item.url === objectUrl('b.json')), 'prewarm should fetch the requested book (resolved through its alias)');
    assert.equal(calls.some(item => item.url === objectUrl('adult.json') || item.url === objectUrl('c.json')), false, 'only the first-screen book is prewarmed');
    assert.equal(calls.some(item => item.url.endsWith('/v2/current.json')), false, 'the boot pointer is adopted, not fetched again');
    const shared = await import('../site/assets/data-source.js');
    const before = calls.length;
    const [index, media, about] = await shared.fetchDataJsonBatch(['codexes.json', 'media.json', 'about.json']);
    const book = await shared.fetchDataJsonResult('b.json');
    assert.equal(index.data.length, 3);
    assert.equal(media.data.baseUrl, 'media');
    assert.equal(about.data.intro, 'about');
    assert.equal(book.data.id, 'b-data');
    assert.equal(calls.length, before, 'the app claims every prewarmed object without new requests');
    delete globalThis.__atlasBoot;
    delete globalThis.localStorage;
  }
  console.log('data-source tests passed');
} finally {
  globalThis.fetch = original.fetch;
  globalThis.location = original.location;
  globalThis.document = original.document;
  delete globalThis.__atlasBoot;
  console.warn = original.warn;
}
