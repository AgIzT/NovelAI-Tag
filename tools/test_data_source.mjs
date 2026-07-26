import assert from 'node:assert/strict';

const original = {
  fetch: globalThis.fetch,
  location: globalThis.location,
  document: globalThis.document,
  warn: console.warn,
};

let caseNumber = 0;

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function loadCase({ hostname, protocol = 'https:', responses, localEdition = false }) {
  caseNumber += 1;
  const href = `${protocol}//${hostname}/`;
  globalThis.location = { href, hostname, protocol };
  globalThis.document = { body: { classList: { contains: name => localEdition && name === 'local-edition' } } };
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const key = String(url);
    calls.push({ url: key, cache: options.cache });
    const response = responses[key];
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
      'https://novelai.quicktagcloud.com/data-source.json': jsonResponse({
        schemaVersion: 1,
        baseUrl: 'https://assets.quicktagcloud.com/data',
        pointer: 'current.json',
        remoteHosts: ['novelai.quicktagcloud.com'],
      }),
      'https://assets.quicktagcloud.com/data/current.json': jsonResponse({
        release: 'r-0123456789abcdefabcd',
        publishedAt: '2026-07-26T00:00:00+00:00',
      }),
      'https://assets.quicktagcloud.com/data/releases/r-0123456789abcdefabcd/codexes.json': jsonResponse([{ id: 'remote' }]),
    };
    const { mod, calls } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses });
    const result = await mod.fetchDataJsonResult('codexes.json');
    assert.equal(result.source, 'r2');
    assert.equal(result.data[0].id, 'remote');
    assert.equal(calls[1].cache, 'no-store');
  }

  {
    const responses = {
      'https://preview.novelai-tag.pages.dev/data-source.json': jsonResponse({
        schemaVersion: 1,
        baseUrl: 'https://assets.quicktagcloud.com/data',
        pointer: 'current.json',
        remoteHosts: ['novelai.quicktagcloud.com'],
      }),
      'https://preview.novelai-tag.pages.dev/data/codexes.json': jsonResponse([{ id: 'preview' }]),
    };
    const { mod, calls } = await loadCase({ hostname: 'preview.novelai-tag.pages.dev', responses });
    const result = await mod.fetchDataJsonResult('codexes.json');
    assert.equal(result.source, 'static');
    assert.equal(result.data[0].id, 'preview');
    assert.equal(calls.some(call => call.url.includes('/data/current.json')), false);
  }

  {
    const responses = {
      'https://novelai.quicktagcloud.com/data-source.json': jsonResponse({
        schemaVersion: 1,
        baseUrl: 'https://assets.quicktagcloud.com/data',
        pointer: 'current.json',
        remoteHosts: ['novelai.quicktagcloud.com'],
      }),
      'https://assets.quicktagcloud.com/data/current.json': jsonResponse({ release: 'r-0123456789abcdefabcd' }),
      'https://assets.quicktagcloud.com/data/releases/r-0123456789abcdefabcd/demo.json': new Error('cors failed'),
      'https://novelai.quicktagcloud.com/data/demo.json': jsonResponse({ id: 'fallback' }),
    };
    const { mod } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses });
    const result = await mod.fetchDataJsonResult('demo.json');
    assert.equal(result.source, 'static-fallback');
    assert.equal(result.data.id, 'fallback');
  }

  {
    const responses = {
      'http://localhost/data/demo.json': jsonResponse({ id: 'local' }),
    };
    const { mod, calls } = await loadCase({ hostname: 'localhost', protocol: 'http:', responses });
    const result = await mod.fetchDataJsonResult('demo.json');
    assert.equal(result.source, 'static');
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
    assert.equal(result.source, 'static');
    assert.equal(result.data.id, 'local-edition');
    assert.equal(calls.length, 1);
  }

  console.log('data-source tests passed');
} finally {
  globalThis.fetch = original.fetch;
  globalThis.location = original.location;
  globalThis.document = original.document;
  console.warn = original.warn;
}
