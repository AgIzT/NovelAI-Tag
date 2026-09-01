'use strict';

const APP_SHELL_PATH = '/index.html';
/* 这条路由返回的是 App 外壳本体：浏览器侧必须每次回源校验（跟静态 / 一致），
   否则发版后有人会拿着旧外壳；边缘留 60 秒只为削抓取器和转发带来的并发峰值。 */
const APP_SHELL_CACHE_CONTROL = 'public, max-age=0, must-revalidate, s-maxage=60';
const SITE_NAME = '法典图鉴';
const SITE_TITLE = '法典图鉴 | NovelAI Tag Atlas';
const SITE_DESCRIPTION = '按图挑选 NovelAI 提示词、画风串与法典条目。';
const RELEASE_RE = /^r-[0-9a-f]{20}$/;

function shareDataError(message, { transient = false, cause } = {}) {
  const error = new Error(message);
  error.transient = transient;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function isTransientShareDataError(error) {
  return error?.transient === true;
}

function htmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodePathPart(part) {
  try {
    return { ok: true, value: decodeURIComponent(String(part || '')) };
  } catch {
    return { ok: false, value: '' };
  }
}

function encodePathPart(part) {
  return encodeURIComponent(String(part || ''));
}

function parseSharePath(request) {
  const url = new URL(request.url);
  const rawParts = url.pathname.split('/').filter(Boolean);
  if (rawParts[0] !== 'share') return { ok: false, codexId: '', entryId: '' };
  const pathParts = rawParts.slice(1).filter(Boolean);
  if (pathParts.length > 2) {
    const decoded = pathParts.map(decodePathPart);
    if (decoded.some(part => !part.ok)) return { ok: false, codexId: '', entryId: '' };
    return { ok: true, codexId: decoded[0]?.value || '', entryId: decoded.slice(1).map(part => part.value).join('/') };
  }
  const codex = decodePathPart(pathParts[0] || '');
  const entry = decodePathPart(pathParts[1] || '');
  if (!codex.ok || !entry.ok) return { ok: false, codexId: '', entryId: '' };
  return { ok: true, codexId: codex.value, entryId: entry.value };
}

function originOf(request) {
  return new URL(request.url).origin;
}

function canonicalShareUrl(origin, codexId, entryId = '') {
  const path = entryId
    ? `/share/${encodePathPart(codexId)}/${encodePathPart(entryId)}`
    : `/share/${encodePathPart(codexId)}`;
  return new URL(path, origin).href;
}

function deepLinkUrl(origin, codexId, entryId = '') {
  const url = new URL('/', origin);
  if (codexId) url.searchParams.set('codex', codexId);
  if (entryId) url.searchParams.set('entry', entryId);
  return url.href;
}

function genericCard(origin, targetUrl = '', { transient = false } = {}) {
  return {
    kind: 'generic',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    image: null,
    canonicalUrl: new URL('/share', origin).href,
    targetUrl: targetUrl || new URL('/', origin).href,
    safe: false,
    transient,
  };
}

async function readAssetJson(context, pathname) {
  const url = new URL(pathname, context.request.url);
  const req = new Request(url.href, { method: 'GET', headers: { accept: 'application/json' } });
  const assets = context.env && context.env.ASSETS;
  let res;
  try {
    res = assets && typeof assets.fetch === 'function'
      ? await assets.fetch(req)
      : await fetch(req);
  } catch (ex) {
    throw shareDataError(`share asset fetch failed: ${pathname}`, { transient: true, cause: ex });
  }
  if (!res || !res.ok) {
    const status = Number(res?.status || 0);
    const transient = status === 408 || status === 425 || status === 429 || status >= 500;
    throw shareDataError(`share asset fetch failed: ${pathname}`, { transient });
  }
  try {
    return await res.json();
  } catch (ex) {
    throw shareDataError(`share asset JSON invalid: ${pathname}`, { transient: true, cause: ex });
  }
}

function normalizedDataPrefix(env) {
  const prefix = String(env?.ATLAS_DATA_PREFIX || 'data').trim().replace(/^\/+|\/+$/g, '');
  return prefix && !prefix.split('/').includes('..') ? prefix : 'data';
}

function publishedDataEnabled(context) {
  if (!context?.env?.ATLAS_DATA_BUCKET) return false;
  const hosts = String(context.env.ATLAS_DATA_HOSTS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const hostname = new URL(context.request.url).hostname;
  return hosts.includes('*') || hosts.includes(hostname);
}

async function readR2Json(bucket, key) {
  let object;
  try {
    object = await bucket.get(key);
  } catch (ex) {
    throw shareDataError(`share R2 read failed: ${key}`, { transient: true, cause: ex });
  }
  if (!object) throw shareDataError(`share R2 object missing: ${key}`);
  try {
    return await object.json();
  } catch (ex) {
    throw shareDataError(`share R2 JSON invalid: ${key}: ${ex.message || ex}`, { transient: true, cause: ex });
  }
}

async function loadShareDataset(context) {
  if (publishedDataEnabled(context)) {
    try {
      const prefix = normalizedDataPrefix(context.env);
      const current = await readR2Json(context.env.ATLAS_DATA_BUCKET, `${prefix}/current.json`);
      const release = String(current?.release || '');
      if (!RELEASE_RE.test(release)) throw new Error('share R2 current pointer is invalid');
      const releasePrefix = `${prefix}/releases/${release}`;
      const read = path => readR2Json(context.env.ATLAS_DATA_BUCKET, `${releasePrefix}/${path}`);
      const index = await read('share-index.json');
      return { index, read, release, source: 'r2' };
    } catch (ex) {
      console.warn(ex);
    }
  }

  const read = path => readAssetJson(context, `/data/${path}`);
  return {
    index: await read('share-index.json'),
    read,
    release: '',
    source: 'assets',
  };
}

function resolveCodex(index, rawCodexId) {
  if (!rawCodexId || !index || !index.codexes) return null;
  const canonicalId = index.aliases?.[rawCodexId] || rawCodexId;
  const codex = index.codexes[canonicalId];
  if (!codex || codex.id !== canonicalId) return null;
  return { id: canonicalId, codex };
}

function entryCandidates(rawEntryId, rawCodexId, codex) {
  const out = [];
  const add = value => {
    const id = String(value || '');
    if (id && !out.includes(id)) out.push(id);
  };
  add(rawEntryId);
  const aliases = [rawCodexId, ...(codex.aliases || [])].filter(Boolean);
  for (const alias of aliases) {
    if (alias === codex.id) continue;
    if (rawEntryId.startsWith(`${alias}-`)) add(codex.id + rawEntryId.slice(alias.length));
  }
  return out;
}

function safeImage(image) {
  if (!image || !/^https:\/\//i.test(String(image.url || ''))) return null;
  const width = Number(image.width || 0);
  const height = Number(image.height || 0);
  if (!width || !height) return null;
  return {
    url: String(image.url),
    width,
    height,
    alt: String(image.alt || SITE_NAME),
  };
}

async function resolveShareCard(context) {
  const origin = originOf(context.request);
  const path = parseSharePath(context.request);
  if (!path.ok || !path.codexId) return genericCard(origin);

  let dataset;
  try {
    dataset = await loadShareDataset(context);
  } catch (ex) {
    console.warn(ex);
    // 根索引不可用意味着整套分享数据不可用；即使末端错误是 404 也一律不缓存，
    // 避免修复 release / 部署后仍被 CDN 固化为通用卡。
    return genericCard(
      origin,
      deepLinkUrl(origin, path.codexId, path.entryId),
      { transient: true },
    );
  }
  const index = dataset.index;

  const resolved = resolveCodex(index, path.codexId);
  if (!resolved) return genericCard(origin);
  const { id: codexId, codex } = resolved;
  const fallbackEntryId = path.entryId
    ? entryCandidates(path.entryId, path.codexId, codex)[0] || path.entryId
    : '';
  const targetUrl = deepLinkUrl(origin, codexId, fallbackEntryId);

  // 分级：shareable 本出完整卡；titleOnly 本（整本 NSFW）只有词条名，书名/简介/图一律不出。
  if (codex.shareable !== true && codex.titleOnly !== true) return genericCard(origin, targetUrl);

  let codexShare;
  try {
    codexShare = await dataset.read(`share/${encodePathPart(codexId)}.json`);
  } catch (ex) {
    console.warn(ex);
    return genericCard(origin, targetUrl, { transient: isTransientShareDataError(ex) });
  }
  if (!codexShare || codexShare.id !== codexId) return genericCard(origin, targetUrl);
  const fullShard = codexShare.shareable === true;
  const titleOnlyShard = codexShare.titleOnly === true;
  if (!fullShard && !titleOnlyShard) return genericCard(origin, targetUrl);

  if (path.entryId) {
    const entries = codexShare.entries || {};
    const entry = entryCandidates(path.entryId, path.codexId, codexShare)
      .map(id => entries[id])
      .find(Boolean);
    if (!entry || !entry.id) return genericCard(origin, targetUrl);
    const entryTitle = String(entry.title || '').trim();
    if (entry.shareable !== true) {
      // 被门控的词条：只借出词条名，不带法典名/分类/提示词/配图。
      if (!entryTitle) return genericCard(origin, targetUrl);
      return {
        kind: 'entry',
        title: `${entryTitle} | ${SITE_NAME}`,
        description: SITE_DESCRIPTION,
        image: null,
        canonicalUrl: canonicalShareUrl(origin, codexId, entry.id),
        targetUrl: deepLinkUrl(origin, codexId, entry.id),
        safe: false,
        titleOnly: true,
      };
    }
    if (!fullShard) return genericCard(origin, targetUrl);
    return {
      kind: 'entry',
      title: `${entry.title} · ${codexShare.title} | ${SITE_NAME}`,
      description: entry.description || SITE_DESCRIPTION,
      image: safeImage(entry.image),
      canonicalUrl: canonicalShareUrl(origin, codexId, entry.id),
      targetUrl: deepLinkUrl(origin, codexId, entry.id),
      safe: true,
    };
  }

  // 法典级卡片只对 shareable 本开放；titleOnly 本连书名都不出。
  if (!fullShard) return genericCard(origin, targetUrl);
  return {
    kind: 'codex',
    title: `${codexShare.title} | ${SITE_NAME}`,
    description: codexShare.description || SITE_DESCRIPTION,
    image: safeImage(codexShare.cover),
    canonicalUrl: canonicalShareUrl(origin, codexId),
    targetUrl,
    safe: true,
  };
}

/* 卡片 head：注入到 App 外壳的 <head> 最前面，所以 charset 必须排第一（否则被 40 行
   preload 挤出前 1024 字节，中文标题会被猜成别的编码），<base> 必须排在任何相对 URL 之前。
   itemprop/image_src 是给只认老式标记的国内抓取器留的后路，与 og 同源不冲突。 */
function renderMeta(card, { forShell = false } = {}) {
  const image = card.image;
  const type = card.kind === 'entry' ? 'article' : 'website';
  const tags = [['meta', { charset: 'utf-8' }]];
  if (forShell) tags.push(['base', { href: '/' }]);
  else tags.push(['meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }]);
  // 出完整卡的页面就是这条深链的规范地址，允许收录；门控卡（只借词条名）保持不可收录。
  if (!card.safe) tags.push(['meta', { name: 'robots', content: 'noindex, nofollow' }]);
  tags.push(
    ['title', {}, card.title],
    ['link', { rel: 'canonical', href: card.canonicalUrl }],
    ['meta', { name: 'description', content: card.description }],
    ['meta', { property: 'og:site_name', content: SITE_NAME }],
    ['meta', { property: 'og:type', content: type }],
    ['meta', { property: 'og:locale', content: 'zh_CN' }],
    ['meta', { property: 'og:url', content: card.canonicalUrl }],
    ['meta', { property: 'og:title', content: card.title }],
    ['meta', { property: 'og:description', content: card.description }],
    ['meta', { name: 'twitter:card', content: image ? 'summary_large_image' : 'summary' }],
    ['meta', { name: 'twitter:title', content: card.title }],
    ['meta', { name: 'twitter:description', content: card.description }],
  );
  if (image) {
    tags.push(
      ['meta', { property: 'og:image', content: image.url }],
      ['meta', { property: 'og:image:secure_url', content: image.url }],
      ['meta', { property: 'og:image:width', content: image.width }],
      ['meta', { property: 'og:image:height', content: image.height }],
      ['meta', { property: 'og:image:alt', content: image.alt }],
      ['meta', { name: 'twitter:image', content: image.url }],
      ['meta', { name: 'twitter:image:alt', content: image.alt }],
      ['meta', { itemprop: 'image', content: image.url }],
      ['link', { rel: 'image_src', href: image.url }],
    );
  }
  return tags.map(tag => {
    const [name, attrs, text] = tag;
    const attrText = Object.entries(attrs || {})
      .map(([key, value]) => `${key}="${htmlEscape(value)}"`)
      .join(' ');
    if (name === 'title') return `<title>${htmlEscape(text)}</title>`;
    if (name === 'link' || name === 'base') return `<${name} ${attrText}>`;
    return attrText ? `<${name} ${attrText}>` : `<${name}>`;
  }).join('\n');
}

const HEAD_OPEN_RE = /<head\b[^>]*>/i;
const TITLE_RE = /<title\b[^>]*>[\s\S]*?<\/title>/i;

async function readAppShell(context) {
  const url = new URL(APP_SHELL_PATH, context.request.url);
  const req = new Request(url.href, { method: 'GET', headers: { accept: 'text/html' } });
  const assets = context.env && context.env.ASSETS;
  let res;
  try {
    res = assets && typeof assets.fetch === 'function' ? await assets.fetch(req) : await fetch(req);
  } catch (ex) {
    throw shareDataError('share app shell fetch failed', { transient: true, cause: ex });
  }
  if (!res || !res.ok) throw shareDataError('share app shell fetch failed', { transient: true });
  const html = await res.text();
  if (!HEAD_OPEN_RE.test(html)) throw shareDataError('share app shell has no <head>', { transient: true });
  return html;
}

/* 把卡片 head 塞进外壳：先摘掉外壳自带的 <title>（抓取器只认第一个，留着会打架），
   再整块插到 <head> 之后。真人拿到的是 App 本体，不再有跳转，地址栏就停在这条短链上。 */
function injectCardHead(shell, card) {
  const stripped = shell.replace(TITLE_RE, '');
  const open = stripped.match(HEAD_OPEN_RE);
  if (!open) return null;
  const at = stripped.indexOf(open[0]) + open[0].length;
  return `${stripped.slice(0, at)}\n${renderMeta(card, { forShell: true })}${stripped.slice(at)}`;
}

// 外壳取不到时的兜底：静态页 + 手动入口。不做自动跳转——那正是分享卡失效的老毛病。
function renderFallbackHtml(card) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
${renderMeta(card)}
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#2d2433;background:#f8f3fa}
main{max-width:36rem;padding:24px;text-align:center}
a{color:#7b4cc2}
</style>
</head>
<body>
<main>
<p>法典图鉴暂时没能加载。</p>
<p><a href="${htmlEscape(card.targetUrl)}">点这里继续浏览</a></p>
</main>
</body>
</html>`;
}

export async function renderShareResponse(context) {
  const card = await resolveShareCard(context);
  let body = null;
  let degraded = false;
  if (context.request.method !== 'HEAD') {
    try {
      body = injectCardHead(await readAppShell(context), card);
    } catch (ex) {
      console.warn(ex);
      body = null;
    }
    if (!body) {
      degraded = true;
      body = renderFallbackHtml(card);
    }
  }
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': card.transient || degraded ? 'no-store' : APP_SHELL_CACHE_CONTROL,
  };
  return new Response(body, { status: 200, headers });
}
