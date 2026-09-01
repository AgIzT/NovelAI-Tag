import assert from 'node:assert/strict';
import { renderShareResponse } from '../functions/_share.js';

function r2Object(value) {
  if (value instanceof Error) return { json: async () => { throw value; } };
  return { json: async () => structuredClone(value) };
}

// 外壳只需最小结构：<head> 开标签、一个会被摘掉的 <title>、一条相对资源引用（验证 <base>）。
const APP_SHELL = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="UTF-8">',
  '<title>法典图鉴 · NovelAI 提示词</title>',
  '<link rel="stylesheet" href="assets/styles.css">',
  '</head>',
  '<body><div id="masonry"></div><script type="module" src="assets/app.js"></script></body>',
  '</html>',
].join('\n');

function makeContext({
  host,
  r2 = {},
  r2Errors = {},
  assets = {},
  atlasHosts = 'novelai.quicktagcloud.com',
  shell = APP_SHELL,
  path = '/share/demo/demo-0001',
}) {
  const r2Calls = [];
  const assetCalls = [];
  const shellCalls = [];
  return {
    context: {
      request: new Request(`https://${host}${path}`),
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
            const assetPath = new URL(request.url).pathname;
            // App 外壳与分享数据分开记账：数据降级断言只关心后者。
            if (assetPath === '/index.html') {
              shellCalls.push(assetPath);
              return shell === null
                ? new Response('not found', { status: 404 })
                : new Response(shell, { headers: { 'content-type': 'text/html; charset=utf-8' } });
            }
            assetCalls.push(assetPath);
            return Object.hasOwn(assets, assetPath)
              ? Response.json(assets[assetPath])
              : new Response('not found', { status: 404 });
          },
        },
      },
    },
    r2Calls,
    assetCalls,
    shellCalls,
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
      assert.match(html, /id="masonry"/, '瞬时分片故障也要照常交付 App 外壳，让前端自己去取数据');
      assert.doesNotMatch(html, /R2 词条|静态词条/, '拿不到分片时不得凭空编出词条名');
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
    assert.match(html, /id="masonry"/, '根数据集不可用时仍要交付 App 外壳');
  }

  // —— 分享路由现在直接交付 App 本体：不跳转，地址栏就停在这条短链上 ——
  {
    const { context, shellCalls } = makeContext({
      host: 'novelai.quicktagcloud.com',
      r2: {
        'data/current.json': { release },
        [`data/releases/${release}/share-index.json`]: remoteIndex,
        [`data/releases/${release}/share/demo.json`]: remoteBook,
      },
    });
    const response = await renderShareResponse(context);
    const html = await response.text();
    assert.deepEqual(shellCalls, ['/index.html'], '应当取 App 外壳');
    assert.match(html, /<script type="module" src="assets\/app\.js">/, '外壳原样交付');
    assert.match(html, /<base href="\/">/, '子路径下相对资源全靠 <base> 兜底');
    assert.doesNotMatch(html, /location\.replace/, '不得再自动跳走——那正是分享卡失效的老毛病');
    assert.doesNotMatch(html, /法典图鉴 · NovelAI 提示词/, '外壳自带的 <title> 必须被摘掉');
    assert.equal(html.match(/<title>/g).length, 1, '只能留一个 <title>');
    assert.match(html, /<title>R2 词条 · R2 法典 \| 法典图鉴<\/title>/);
    assert.match(html, /<meta name="description" content="remote">/, 'QQ\/微信优先读普通 description');
    assert.doesNotMatch(html, /name="robots"/, '安全卡是这条深链的规范地址，应当允许收录');
    // charset 必须落在前 1024 字节内，否则中文标题会被猜成别的编码
    assert.ok(html.indexOf('<meta charset="utf-8">') < 1024, 'charset 必须排在 head 最前');
  }

  // —— 门控词条：出卡但只给词条名 ——
  {
    const gatedIndex = {
      codexes: { demo: { id: 'demo', shareable: false, titleOnly: true } },
      aliases: {},
    };
    const gatedBook = {
      id: 'demo',
      shareable: false,
      titleOnly: true,
      entries: { 'demo-0001': { id: 'demo-0001', title: '被门控的词条', shareable: false } },
    };
    const { context } = makeContext({
      host: 'novelai.quicktagcloud.com',
      r2: {
        'data/current.json': { release },
        [`data/releases/${release}/share-index.json`]: gatedIndex,
        [`data/releases/${release}/share/demo.json`]: gatedBook,
      },
    });
    const html = await (await renderShareResponse(context)).text();
    assert.match(html, /<title>被门控的词条 \| 法典图鉴<\/title>/, '只借词条名');
    assert.doesNotMatch(html, /og:image/, '门控卡不得带图');
    assert.doesNotMatch(html, /R2 法典|静态法典/, '门控卡不得带法典名');
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/, '门控卡不得被收录');
  }

  // 整本门控时，法典级链接（无词条 id）仍然连书名都不给
  {
    const gatedIndex = {
      codexes: { demo: { id: 'demo', shareable: false, titleOnly: true } },
      aliases: {},
    };
    const { context } = makeContext({
      host: 'novelai.quicktagcloud.com',
      path: '/share/demo',
      r2: {
        'data/current.json': { release },
        [`data/releases/${release}/share-index.json`]: gatedIndex,
        [`data/releases/${release}/share/demo.json`]: {
          id: 'demo', shareable: false, titleOnly: true, title: '不该出现的书名', entries: {},
        },
      },
    });
    const html = await (await renderShareResponse(context)).text();
    assert.doesNotMatch(html, /不该出现的书名/, 'titleOnly 本连书名都不出');
    assert.match(html, /法典图鉴 \| NovelAI Tag Atlas/, '退回通用站点卡');
  }

  // 外壳取不到时降级为静态卡 + 手动入口，且不缓存
  {
    const { context } = makeContext({
      host: 'novelai.quicktagcloud.com',
      shell: null,
      r2: {
        'data/current.json': { release },
        [`data/releases/${release}/share-index.json`]: remoteIndex,
        [`data/releases/${release}/share/demo.json`]: remoteBook,
      },
    });
    const response = await renderShareResponse(context);
    const html = await response.text();
    assert.equal(response.headers.get('cache-control'), 'no-store', '降级页不得被缓存固化');
    assert.match(html, /codex=demo&amp;entry=demo-0001/, '降级页保留手动入口');
    assert.match(html, /<title>R2 词条 · R2 法典 \| 法典图鉴<\/title>/, '降级页仍要出卡');
  }

  // HEAD 只要头不要体
  {
    const { context } = makeContext({
      host: 'novelai.quicktagcloud.com',
      r2: {
        'data/current.json': { release },
        [`data/releases/${release}/share-index.json`]: remoteIndex,
        [`data/releases/${release}/share/demo.json`]: remoteBook,
      },
    });
    context.request = new Request(context.request.url, { method: 'HEAD' });
    const response = await renderShareResponse(context);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
  }

  console.log('share backend tests passed');
} finally {
  console.warn = originalWarn;
}
