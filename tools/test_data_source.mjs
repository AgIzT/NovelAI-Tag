import assert from 'node:assert/strict';

const original = {
  fetch: globalThis.fetch,
  location: globalThis.location,
  document: globalThis.document,
  warn: console.warn,
};

let caseNumber = 0;
const release = 'r-0123456789abcdefabcd';

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

async function loadCase({ hostname, protocol = 'https:', responses, localEdition = false, basePath = '/' }) {
  caseNumber += 1;
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
    const responses = {
      [`https://${host}/data-source.json`]: config(),
      [`https://${host}/data/current.json`]: jsonResponse({ release }),
      [`https://${host}/data/releases/${release}/codexes.json`]: jsonResponse([{ id: 'preview-proxy' }]),
    };
    const { mod, calls } = await loadCase({ hostname: host, responses });
    const result = await mod.fetchDataJsonResult('codexes.json');
    assert.equal(result.source, 'proxy');
    assert.equal(result.data[0].id, 'preview-proxy');
    assert.equal(result.release, release);
    assert.equal(calls.some(call => call.url.startsWith('https://assets.quicktagcloud.com/')), false);
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
  console.warn = original.warn;
}
