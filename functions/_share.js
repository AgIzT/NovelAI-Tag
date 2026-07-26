'use strict';

const CACHE_CONTROL = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';
const SITE_NAME = '法典图鉴';
const SITE_TITLE = '法典图鉴 | NovelAI Tag Atlas';
const SITE_DESCRIPTION = '按图挑选 NovelAI 提示词、画风串与法典条目。';
const RELEASE_RE = /^r-[0-9a-f]{20}$/;

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

function genericCard(origin, targetUrl = '') {
  return {
    kind: 'generic',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    image: null,
    canonicalUrl: new URL('/share', origin).href,
    targetUrl: targetUrl || new URL('/', origin).href,
    safe: false,
  };
}

async function readAssetJson(context, pathname) {
  const url = new URL(pathname, context.request.url);
  const req = new Request(url.href, { method: 'GET', headers: { accept: 'application/json' } });
  const assets = context.env && context.env.ASSETS;
  const res = assets && typeof assets.fetch === 'function'
    ? await assets.fetch(req)
    : await fetch(req);
  if (!res || !res.ok) throw new Error(`share asset fetch failed: ${pathname}`);
  return res.json();
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
  const object = await bucket.get(key);
  if (!object) throw new Error(`share R2 object missing: ${key}`);
  try {
    return await object.json();
  } catch (ex) {
    throw new Error(`share R2 JSON invalid: ${key}: ${ex.message || ex}`);
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
    return genericCard(origin);
  }
  const index = dataset.index;

  const resolved = resolveCodex(index, path.codexId);
  if (!resolved) return genericCard(origin);
  const { id: codexId, codex } = resolved;
  const fallbackEntryId = path.entryId
    ? entryCandidates(path.entryId, path.codexId, codex)[0] || path.entryId
    : '';
  const targetUrl = deepLinkUrl(origin, codexId, fallbackEntryId);

  if (codex.shareable !== true) return genericCard(origin, targetUrl);

  let codexShare;
  try {
    codexShare = await dataset.read(`share/${encodePathPart(codexId)}.json`);
  } catch (ex) {
    console.warn(ex);
    return genericCard(origin, targetUrl);
  }
  if (!codexShare || codexShare.id !== codexId || codexShare.shareable !== true) {
    return genericCard(origin, targetUrl);
  }

  if (path.entryId) {
    const entries = codexShare.entries || {};
    const entry = entryCandidates(path.entryId, path.codexId, codexShare)
      .map(id => entries[id])
      .find(Boolean);
    if (!entry || !entry.id || entry.shareable !== true) return genericCard(origin, targetUrl);
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

function renderMeta(card) {
  const image = card.image;
  const type = card.kind === 'entry' ? 'article' : 'website';
  const tags = [
    ['meta', { charset: 'utf-8' }],
    ['meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    ['meta', { name: 'robots', content: 'noindex' }],
    ['title', {}, card.title],
    ['link', { rel: 'canonical', href: card.canonicalUrl }],
    ['meta', { property: 'og:site_name', content: SITE_NAME }],
    ['meta', { property: 'og:type', content: type }],
    ['meta', { property: 'og:locale', content: 'zh_CN' }],
    ['meta', { property: 'og:url', content: card.canonicalUrl }],
    ['meta', { property: 'og:title', content: card.title }],
    ['meta', { property: 'og:description', content: card.description }],
    ['meta', { name: 'twitter:card', content: image ? 'summary_large_image' : 'summary' }],
    ['meta', { name: 'twitter:title', content: card.title }],
    ['meta', { name: 'twitter:description', content: card.description }],
  ];
  if (image) {
    tags.push(
      ['meta', { property: 'og:image', content: image.url }],
      ['meta', { property: 'og:image:secure_url', content: image.url }],
      ['meta', { property: 'og:image:width', content: image.width }],
      ['meta', { property: 'og:image:height', content: image.height }],
      ['meta', { property: 'og:image:alt', content: image.alt }],
      ['meta', { name: 'twitter:image', content: image.url }],
      ['meta', { name: 'twitter:image:alt', content: image.alt }],
    );
  }
  return tags.map(tag => {
    const [name, attrs, text] = tag;
    const attrText = Object.entries(attrs || {})
      .map(([key, value]) => `${key}="${htmlEscape(value)}"`)
      .join(' ');
    if (name === 'title') return `<title>${htmlEscape(text)}</title>`;
    if (name === 'link') return `<link ${attrText}>`;
    return attrText ? `<${name} ${attrText}>` : `<${name}>`;
  }).join('\n');
}

function renderHtml(card) {
  const targetJson = JSON.stringify(card.targetUrl);
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
<p>正在打开法典图鉴。</p>
<p><a href="${htmlEscape(card.targetUrl)}">如果没有自动跳转，请点击这里继续。</a></p>
</main>
<script>location.replace(${targetJson});</script>
</body>
</html>`;
}

export async function renderShareResponse(context) {
  const card = await resolveShareCard(context);
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': CACHE_CONTROL,
  };
  const body = context.request.method === 'HEAD' ? null : renderHtml(card);
  return new Response(body, { status: 200, headers });
}
