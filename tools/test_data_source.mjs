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

  {
    // 子路径自部署（GitHub Pages 项目站）：所有数据路径都必须相对文档基址解析。
    const responses = {
      'https://agizt.github.io/NovelAI-Tag/data-source.json': jsonResponse({
        schemaVersion: 1,
        baseUrl: 'https://assets.quicktagcloud.com/data',
        pointer: 'current.json',
        remoteHosts: ['novelai.quicktagcloud.com'],
      }),
      'https://agizt.github.io/NovelAI-Tag/data/codexes.json': jsonResponse([{ id: 'subpath' }]),
    };
    const { mod } = await loadCase({
      hostname: 'agizt.github.io',
      basePath: '/NovelAI-Tag/',
      responses,
    });
    const result = await mod.fetchDataJsonResult('codexes.json');
    assert.equal(result.source, 'static');
    assert.equal(result.data[0].id, 'subpath');
  }

  {
    // 索引回退必须把整个会话降级，后续分书不能再混读 R2。
    const responses = {
      'https://novelai.quicktagcloud.com/data-source.json': jsonResponse({
        schemaVersion: 1,
        baseUrl: 'https://assets.quicktagcloud.com/data',
        pointer: 'current.json',
        remoteHosts: ['novelai.quicktagcloud.com'],
      }),
      'https://assets.quicktagcloud.com/data/current.json': jsonResponse({ release: 'r-0123456789abcdefabcd' }),
      'https://assets.quicktagcloud.com/data/releases/r-0123456789abcdefabcd/codexes.json': new Error('cors failed'),
      'https://novelai.quicktagcloud.com/data/codexes.json': jsonResponse([{ id: 'snapshot' }]),
      'https://novelai.quicktagcloud.com/data/demo.json': jsonResponse({ id: 'snapshot-book' }),
    };
    const { mod, calls } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses });
    const index = await mod.fetchDataJsonResult('codexes.json');
    assert.equal(index.source, 'static-fallback');
    assert.equal(mod.getDataSource().mode, 'static');

    const book = await mod.fetchDataJsonResult('demo.json');
    assert.equal(book.source, 'static-fallback');
    assert.equal(book.data.id, 'snapshot-book');
    assert.equal(calls.some(call => call.url.includes('/releases/') && call.url.endsWith('demo.json')), false);
  }

  {
    // 启动批次中 media 先失败、codexes 后成功时，也必须丢弃已经成功的 R2 索引。
    const release = 'r-0123456789abcdefabcd';
    const responses = {
      'https://novelai.quicktagcloud.com/data-source.json': jsonResponse({
        schemaVersion: 1,
        baseUrl: 'https://assets.quicktagcloud.com/data',
        pointer: 'current.json',
        remoteHosts: ['novelai.quicktagcloud.com'],
      }),
      'https://assets.quicktagcloud.com/data/current.json': jsonResponse({ release }),
      [`https://assets.quicktagcloud.com/data/releases/${release}/codexes.json`]: async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return jsonResponse([{ id: 'r2-index-must-not-escape' }]);
      },
      [`https://assets.quicktagcloud.com/data/releases/${release}/media.json`]: new Error('media failed first'),
      [`https://assets.quicktagcloud.com/data/releases/${release}/about.json`]: jsonResponse({ intro: 'r2-about' }),
      'https://novelai.quicktagcloud.com/data/codexes.json': jsonResponse([{ id: 'snapshot-index' }]),
      'https://novelai.quicktagcloud.com/data/media.json': jsonResponse({ baseUrl: 'snapshot-media' }),
      'https://novelai.quicktagcloud.com/data/about.json': jsonResponse({ intro: 'snapshot-about' }),
    };
    const { mod } = await loadCase({ hostname: 'novelai.quicktagcloud.com', responses });
    const [index, media, about] = await mod.fetchDataJsonBatch([
      { path: 'codexes.json', cache: 'no-store' },
      { path: 'media.json', cache: 'no-store' },
      { path: 'about.json', cache: 'no-store' },
    ]);
    assert.equal(mod.getDataSource().mode, 'static');
    assert.deepEqual([index.source, media.source, about.source], [
      'static-fallback', 'static-fallback', 'static-fallback',
    ]);
    assert.equal(index.data[0].id, 'snapshot-index');
    assert.equal(media.data.baseUrl, 'snapshot-media');
    assert.equal(about.data.intro, 'snapshot-about');
  }

  console.log('data-source tests passed');
} finally {
  globalThis.fetch = original.fetch;
  globalThis.location = original.location;
  globalThis.document = original.document;
  console.warn = original.warn;
}
