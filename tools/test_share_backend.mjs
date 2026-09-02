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
  withBucket = true,
  atlasHosts = 'novelai.quicktagcloud.com',
  shell = APP_SHELL,
  path = '/share/demo/demo-0001',
}) {
  const r2Calls = [];
  const assetCalls = [];
  const shellCalls = [];
  const env = {
      ATLAS_DATA_HOSTS: atlasHosts,
      ATLAS_DATA_PREFIX: 'data',
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
    };
  if (withBucket) {
    env.ATLAS_DATA_BUCKET = {
      get: async key => {
        r2Calls.push(key);
        if (Object.hasOwn(r2Errors, key)) throw r2Errors[key];
        return Object.hasOwn(r2, key) ? r2Object(r2[key]) : null;
      },
    };
  }
  return {
    context: {
      request: new Request(`https://${host}${path}`),
      env,
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
    const response = await renderShareResponse(context);
    const html = await response.text();
    assert.match(html, /R2 词条 · R2 法典/);
    assert.equal(r2Calls.at(-1), `data/releases/${release}/share/demo.json`);
    assert.deepEqual(assetCalls, []);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow', '预览域的安全卡也不得被收录');
  }

  // 合并册只规范化书级 alias；分片里沿用来源前缀的真实 entry id，分享卡必须仍能命中。
  {
    const mergedIndex = {
      codexes: {
        nai45_community_pack: {
          id: 'nai45_community_pack',
          aliases: ['community_ai_misc'],
          shareable: true,
        },
      },
      aliases: { community_ai_misc: 'nai45_community_pack' },
    };
    const mergedBook = {
      id: 'nai45_community_pack',
      aliases: ['community_ai_misc'],
      title: '合并社区图包',
      shareable: true,
      entries: {
        'community_ai_misc-0001': {
          id: 'community_ai_misc-0001',
          title: '社区来源词条',
          description: 'merged entry',
          shareable: true,
        },
      },
    };
    const { context } = makeContext({
      host: 'novelai.quicktagcloud.com',
      path: '/share/community_ai_misc/community_ai_misc-0001',
      r2: {
        'data/current.json': { release },
        [`data/releases/${release}/share-index.json`]: mergedIndex,
        [`data/releases/${release}/share/nai45_community_pack.json`]: mergedBook,
      },
    });
    const response = await renderShareResponse(context);
    const html = await response.text();
    assert.match(html, /<title>社区来源词条 · 合并社区图包 \| 法典图鉴<\/title>/);
    assert.match(
      html,
      /<link rel="canonical" href="https:\/\/novelai\.quicktagcloud\.com\/share\/nai45_community_pack\/community_ai_misc-0001">/,
      'canonical 只归一法典 ID，必须保留真实 entry ID',
    );
    assert.doesNotMatch(html, /nai45_community_pack-0001/, '不得凭空改写合并册 entry 前缀');
  }

  // 旧 canonicalizer 生成过 canonical 前缀链接；只有一个明确 alias 候选时才反解。
  {
    const { context } = makeContext({
      host: 'novelai.quicktagcloud.com',
      path: '/share/nai45_community_pack/nai45_community_pack-0001',
      r2: {
        'data/current.json': { release },
        [`data/releases/${release}/share-index.json`]: {
          codexes: {
            nai45_community_pack: {
              id: 'nai45_community_pack',
              aliases: ['community_ai_misc'],
              shareable: true,
            },
          },
          aliases: {},
        },
        [`data/releases/${release}/share/nai45_community_pack.json`]: {
          id: 'nai45_community_pack',
          aliases: ['community_ai_misc'],
          title: '合并社区图包',
          shareable: true,
          entries: {
            'community_ai_misc-0001': {
              id: 'community_ai_misc-0001',
              title: '旧链接唯一候选',
              description: 'legacy canonical link',
              shareable: true,
            },
          },
        },
      },
    });
    const response = await renderShareResponse(context);
    const html = await response.text();
    assert.match(html, /<title>旧链接唯一候选 · 合并社区图包 \| 法典图鉴<\/title>/);
    assert.match(html, /share\/nai45_community_pack\/community_ai_misc-0001/);
    assert.doesNotMatch(html, /nai45_community_pack-0001/, '唯一反解后的 canonical 不得继续保留旧错误 entry id');
  }

  // canonical 前缀丢失来源信息时可能对应多个 alias；宁可通用卡，也不能猜错词条。
  {
    const { context } = makeContext({
      host: 'novelai.quicktagcloud.com',
      path: '/share/nai45_community_pack/nai45_community_pack-0001',
      r2: {
        'data/current.json': { release },
        [`data/releases/${release}/share-index.json`]: {
          codexes: {
            nai45_community_pack: {
              id: 'nai45_community_pack',
              aliases: ['mengshen_pack', 'community_ai_misc'],
              shareable: true,
            },
          },
          aliases: {},
        },
        [`data/releases/${release}/share/nai45_community_pack.json`]: {
          id: 'nai45_community_pack',
          aliases: ['mengshen_pack', 'community_ai_misc'],
          title: '合并社区图包',
          shareable: true,
          entries: {
            'mengshen_pack-0001': { id: 'mengshen_pack-0001', title: '来源 A', shareable: true },
            'community_ai_misc-0001': { id: 'community_ai_misc-0001', title: '来源 B', shareable: true },
          },
        },
      },
    });
    const response = await renderShareResponse(context);
    const html = await response.text();
    assert.match(html, /法典图鉴 \| NovelAI Tag Atlas/);
    assert.doesNotMatch(html, /来源 A|来源 B/, '歧义旧链接不得猜测来源');
  }

  // R2 分片里的 aliases 形状损坏时，分享请求仍应安全降级/正常出卡，不能 Function 500。
  {
    const malformedIndex = {
      codexes: { demo: { id: 'demo', aliases: { broken: true }, shareable: true } },
      aliases: {},
    };
    const malformedBook = { ...remoteBook, aliases: { broken: true } };
    const { context } = makeContext({
      host: 'novelai.quicktagcloud.com',
      r2: {
        'data/current.json': { release },
        [`data/releases/${release}/share-index.json`]: malformedIndex,
        [`data/releases/${release}/share/demo.json`]: malformedBook,
      },
    });
    const response = await renderShareResponse(context);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /<title>R2 词条 · R2 法典 \| 法典图鉴<\/title>/);
  }

  {
    const { context, assetCalls } = makeContext({
      host: 'localhost',
      withBucket: false,
      assets: {
        '/data/share-index.json': staticIndex,
        '/data/share/demo.json': staticBook,
      },
    });
    const html = await (await renderShareResponse(context)).text();
    assert.match(html, /静态词条 · 静态法典/);
    assert.deepEqual(assetCalls, ['/data/share-index.json', '/data/share/demo.json']);
  }

  // 生产/预览一旦启用 R2，R2 故障不得回落到旧静态快照。
  {
    const { context, assetCalls } = makeContext({
      host: 'novelai.quicktagcloud.com',
      r2: {},
      assets: {
        '/data/share-index.json': staticIndex,
        '/data/share/demo.json': staticBook,
      },
    });
    const response = await renderShareResponse(context);
    const html = await response.text();
    assert.match(html, /法典图鉴 \| NovelAI Tag Atlas/);
    assert.doesNotMatch(html, /静态词条|静态法典/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(assetCalls, [], 'R2 已启用时不能读静态旧数据');
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
    assert.equal(response.headers.get('x-robots-tag'), null, '只有正式域的安全卡允许收录');
    // charset 必须落在前 1024 字节内，否则中文标题会被猜成别的编码
    assert.ok(html.indexOf('<meta charset="utf-8">') < 1024, 'charset 必须排在 head 最前');
  }

  // 正式域的后缀仿冒不能命中索引白名单，即便拿到的也是完整安全卡。
  {
    const { context } = makeContext({
      host: 'novelai.quicktagcloud.com.evil.test',
      atlasHosts: '*',
      r2: {
        'data/current.json': { release },
        [`data/releases/${release}/share-index.json`]: remoteIndex,
        [`data/releases/${release}/share/demo.json`]: remoteBook,
      },
    });
    const response = await renderShareResponse(context);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
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
    const response = await renderShareResponse(context);
    const html = await response.text();
    assert.match(html, /<title>被门控的词条 \| 法典图鉴<\/title>/, '只借词条名');
    assert.doesNotMatch(html, /og:image/, '门控卡不得带图');
    assert.doesNotMatch(html, /R2 法典|静态法典/, '门控卡不得带法典名');
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/, '门控卡不得被收录');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow', '门控卡在响应层也必须禁止收录');
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
    assert.equal(response.headers.get('cache-control'), 'no-store', 'HEAD 不应在未探测外壳时声明可缓存');
  }

  // HEAD 与 GET 的缓存策略必须一致地偏向安全；外壳故障时尤其不能留下可缓存头。
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
    context.request = new Request(context.request.url, { method: 'HEAD' });
    const response = await renderShareResponse(context);
    assert.equal(response.headers.get('cache-control'), 'no-store', 'shell 故障的 HEAD 不得缓存');
  }

  // 索引和分片的分级标志若互相矛盾，必须 fail-closed；不能以误标的
  // shareable 分片绕过 titleOnly 本的隐私策略，也不能反向把完整本当成门控本。
  for (const [indexFlags, shardFlags, label] of [
    [{ shareable: false, titleOnly: true }, { shareable: true }, 'titleOnly 索引 + 完整分片'],
    [{ shareable: true }, { shareable: false, titleOnly: true }, '完整索引 + titleOnly 分片'],
  ]) {
    const { context } = makeContext({
      host: 'novelai.quicktagcloud.com',
      path: '/share/demo/demo-0001',
      r2: {
        'data/current.json': { release },
        [`data/releases/${release}/share-index.json`]: {
          codexes: { demo: { id: 'demo', ...indexFlags } },
          aliases: {},
        },
        [`data/releases/${release}/share/demo.json`]: {
          id: 'demo',
          title: '不应泄露的法典',
          ...shardFlags,
          entries: {
            'demo-0001': {
              id: 'demo-0001',
              title: '不应泄露的完整词条',
              shareable: true,
              description: 'sensitive details',
            },
          },
        },
      },
    });
    const response = await renderShareResponse(context);
    const html = await response.text();
    assert.match(html, /法典图鉴 \| NovelAI Tag Atlas/, `${label} 应退回通用卡`);
    assert.doesNotMatch(html, /不应泄露的法典|不应泄露的完整词条|sensitive details/, `${label} 不得泄露分片内容`);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow', `${label} 必须 noindex`);
  }

  // 正式域只有 HTTPS 默认端口才可索引；HTTP/非默认端口即使主机名相同也必须 noindex。
  for (const [url, label] of [
    ['http://novelai.quicktagcloud.com/share/demo/demo-0001', 'HTTP 正式域'],
    ['https://novelai.quicktagcloud.com:8443/share/demo/demo-0001', '非默认端口正式域'],
  ]) {
    const { context } = makeContext({
      host: 'novelai.quicktagcloud.com',
      r2: {
        'data/current.json': { release },
        [`data/releases/${release}/share-index.json`]: remoteIndex,
        [`data/releases/${release}/share/demo.json`]: remoteBook,
      },
    });
    context.request = new Request(url);
    const response = await renderShareResponse(context);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow', `${label} 必须 noindex`);
  }

  console.log('share backend tests passed');
} finally {
  console.warn = originalWarn;
}
