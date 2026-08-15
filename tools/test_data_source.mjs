import assert from 'node:assert/strict';
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

async function runInlineBootCase({ hostname, protocol = 'https:', responses, basePath = '/' }) {
  const href = protocol === 'file:'
    ? 'file:///index.html'
    : `${protocol}//${hostname}${basePath}`;
  const calls = [];
  const fetch = async (url, options = {}) => {
    const key = new URL(String(url), href).href;
    calls.push({ url: key, cache: options.cache });
    const response = responses[key];
    if (typeof response === 'function') return response();
    if (response instanceof Error) throw response;
    if (!response) throw new Error(`unexpected inline boot fetch ${key}`);
    return response;
  };
  const window = {};
  runInNewContext(inlineBootScript, {
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
    calls.push({ url: key, cache: options.cache });
    const response = responses[key];
    if (typeof response === 'function') return response();
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

  console.log('data-source tests passed');
} finally {
  globalThis.fetch = original.fetch;
  globalThis.location = original.location;
  globalThis.document = original.document;
  delete globalThis.__atlasBoot;
  console.warn = original.warn;
}
