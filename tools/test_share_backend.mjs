import assert from 'node:assert/strict';
import { renderShareResponse } from '../functions/_share.js';

function r2Object(value) {
  if (value instanceof Error) return { json: async () => { throw value; } };
  return { json: async () => structuredClone(value) };
}

function makeContext({ host, r2 = {}, r2Errors = {}, assets = {}, atlasHosts = 'novelai.quicktagcloud.com' }) {
  const r2Calls = [];
  const assetCalls = [];
  return {
    context: {
      request: new Request(`https://${host}/share/demo/demo-0001`),
      env: {
        ATLAS_DATA_HOSTS: atlasHosts,
        ATLAS_DATA_PREFIX: 'data',
        ATLAS_DATA_BUCKET: {
          get: async key => {
            r2Calls.push(key);
            if (Object.hasOwn(r2Errors, key)) throw r2Errors[key];
            return Object.hasOwn(r2, key) ? r2Object(r2[key]) : null;
          },
        },
        ASSETS: {
          fetch: async request => {
            const path = new URL(request.url).pathname;
            assetCalls.push(path);
            return Object.hasOwn(assets, path)
              ? Response.json(assets[path])
              : new Response('not found', { status: 404 });
          },
        },
      },
    },
    r2Calls,
    assetCalls,
  };
}

const release = 'r-0123456789abcdefabcd';
const remoteIndex = {
  codexes: { demo: { id: 'demo', shareable: true } },
  aliases: {},
};
const remoteBook = {
  id: 'demo',
  title: 'R2 法典',
  shareable: true,
  entries: {
    'demo-0001': {
      id: 'demo-0001',
      title: 'R2 词条',
      description: 'remote',
      shareable: true,
    },
  },
};
const staticIndex = {
  codexes: { demo: { id: 'demo', shareable: true } },
  aliases: {},
};
const staticBook = {
  ...remoteBook,
  title: '静态法典',
  entries: {
    'demo-0001': { ...remoteBook.entries['demo-0001'], title: '静态词条' },
  },
};

const originalWarn = console.warn;
console.warn = () => {};
try {
  {
    const { context, r2Calls, assetCalls } = makeContext({
      host: 'novelai.quicktagcloud.com',
      r2: {
        'data/current.json': { release },
        [`data/releases/${release}/share-index.json`]: remoteIndex,
        [`data/releases/${release}/share/demo.json`]: remoteBook,
      },
      assets: {
        '/data/share-index.json': staticIndex,
        '/data/share/demo.json': staticBook,
      },
    });
    const html = await (await renderShareResponse(context)).text();
    assert.match(html, /R2 词条 · R2 法典/);
    assert.deepEqual(assetCalls, []);
    assert.equal(r2Calls.at(-1), `data/releases/${release}/share/demo.json`);
  }

  {
    const { context, r2Calls, assetCalls } = makeContext({
      host: 'preview.novelai-tag.pages.dev',
      atlasHosts: '*',
      r2: {
        'data/current.json': { release },
        [`data/releases/${release}/share-index.json`]: remoteIndex,
        [`data/releases/${release}/share/demo.json`]: remoteBook,
      },
      assets: {
        '/data/share-index.json': staticIndex,
        '/data/share/demo.json': staticBook,
      },
    });
    const html = await (await renderShareResponse(context)).text();
    assert.match(html, /R2 词条 · R2 法典/);
    assert.equal(r2Calls.at(-1), `data/releases/${release}/share/demo.json`);
    assert.deepEqual(assetCalls, []);
  }

  {
    const { context, assetCalls } = makeContext({
      host: 'novelai.quicktagcloud.com',
      r2: {},
      assets: {
        '/data/share-index.json': staticIndex,
        '/data/share/demo.json': staticBook,
      },
    });
    const html = await (await renderShareResponse(context)).text();
    assert.match(html, /静态词条 · 静态法典/);
    assert.deepEqual(assetCalls, ['/data/share-index.json', '/data/share/demo.json']);
  }

  {
    const { context, assetCalls } = makeContext({
      host: 'novelai.quicktagcloud.com',
      r2: {
        'data/current.json': { release },
        [`data/releases/${release}/share-index.json`]: remoteIndex,
      },
      assets: {
        '/data/share-index.json': staticIndex,
        '/data/share/demo.json': staticBook,
      },
    });
    const response = await renderShareResponse(context);
    const html = await response.text();
    assert.doesNotMatch(html, /静态词条/);
    assert.match(html, /法典图鉴 \| NovelAI Tag Atlas/);
    assert.notEqual(response.headers.get('cache-control'), 'no-store', '有意 fail-closed 通用卡仍应沿用既定缓存');
    assert.deepEqual(assetCalls, []);
  }

  {
    const shardKey = `data/releases/${release}/share/demo.json`;
    for (const failureStage of ['get', 'json']) {
      const r2 = {
        'data/current.json': { release },
        [`data/releases/${release}/share-index.json`]: remoteIndex,
      };
      const r2Errors = {};
      if (failureStage === 'get') r2Errors[shardKey] = new Error('injected R2 get timeout');
      else r2[shardKey] = new Error('injected R2 body read failure');
      const { context, assetCalls } = makeContext({
        host: 'novelai.quicktagcloud.com',
        r2,
        r2Errors,
        assets: {
          '/data/share-index.json': staticIndex,
          '/data/share/demo.json': staticBook,
        },
      });
      const response = await renderShareResponse(context);
      const html = await response.text();
      assert.equal(response.headers.get('cache-control'), 'no-store', `R2 分片 ${failureStage} 异常不得缓存`);
      assert.match(html, /codex=demo&amp;entry=demo-0001/, '瞬时分片故障仍应保留请求的深链目标');
      assert.deepEqual(assetCalls, [], '锁定 R2 release 后不得用静态旧分片补洞');
    }
  }

  {
    const { context } = makeContext({
      host: 'novelai.quicktagcloud.com',
      r2: {},
      assets: {},
    });
    const response = await renderShareResponse(context);
    const html = await response.text();
    assert.equal(response.headers.get('cache-control'), 'no-store', '根数据集整体不可用的降级卡不得缓存');
    assert.match(html, /codex=demo&amp;entry=demo-0001/, '根数据集不可用时仍应保留请求的深链目标');
  }

  console.log('share backend tests passed');
} finally {
  console.warn = originalWarn;
}
