import { state } from './state.js';

export function hasEntryImage(e) {
  return Boolean((e.images && e.images.length) || e.image);
}

export function cacheBustUrl(url) {
  if (!url) return url;
  return `${url}${url.includes('?') ? '&' : '?'}retry=${Date.now()}`;
}

export function isLocalOrigin() {
  return ['localhost', '127.0.0.1', '::1'].includes(location.hostname) || location.protocol === 'file:';
}

export function originFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  } catch {}
  return '';
}

function isLoopbackHost(hostname) {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname);
}

function shouldSkipHintOrigin(origin) {
  if (!origin || origin === location.origin) return true;
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return true;
  }
}

function scanResourceHints() {
  const preconnect = new Set();
  const dns = new Set();
  document.querySelectorAll('link[rel="preconnect"]').forEach(link => {
    const origin = originFromUrl(link.href);
    if (!origin) return;
    const mode = link.hasAttribute('crossorigin') ? 'cors' : 'plain';
    preconnect.add(`${origin}|${mode}`);
  });
  document.querySelectorAll('link[rel="dns-prefetch"]').forEach(link => {
    const origin = originFromUrl(link.href);
    if (origin) dns.add(origin);
  });
  return { preconnect, dns };
}

function appendHint(rel, origin, { cors = false } = {}) {
  const link = document.createElement('link');
  link.rel = rel;
  link.href = origin;
  if (cors) link.setAttribute('crossorigin', '');
  document.head.appendChild(link);
}

function ensureDnsPrefetch(origin, hints) {
  if (hints.dns.has(origin)) return;
  appendHint('dns-prefetch', origin);
  hints.dns.add(origin);
}

function ensurePreconnect(origin, mode, hints) {
  const key = `${origin}|${mode}`;
  if (hints.preconnect.has(key)) return;
  appendHint('preconnect', origin, { cors: mode === 'cors' });
  hints.preconnect.add(key);
}

export function primeResourceHints({ media = state.media, codexes = state.codexes } = {}) {
  const hints = scanResourceHints();
  const addImageOrigin = url => {
    const origin = originFromUrl(url);
    if (shouldSkipHintOrigin(origin)) return;
    ensureDnsPrefetch(origin, hints);
    ensurePreconnect(origin, 'plain', hints);
  };
  const addDataOrigin = url => {
    const origin = originFromUrl(url);
    if (shouldSkipHintOrigin(origin)) return;
    ensureDnsPrefetch(origin, hints);
    ensurePreconnect(origin, 'cors', hints);
  };

  addImageOrigin(media?.baseUrl);
  for (const codex of codexes || []) {
    addImageOrigin(codex?.assetBaseUrl);
    addDataOrigin(codex?.dataUrl);
  }
}

/* codex 参数：词条默认属于当前法典；收藏总览等跨法典场景传入词条自己的法典 */
export function mediaPath(kind, e, codex = state.codex) {
  const file = kind === 'original' ? e.original : e.image;
  if (!file) return '';
  if (isAbsoluteUrl(file)) return file;
  if (codex.assetPathMode === 'relative') {
    return encodeAssetPath(file);
  }
  const prefix = kind === 'original' ? state.media.originalPrefix : state.media.imagePrefix;
  const assetCodexId = e.assetCodexId || codex.id;
  return [prefix || (kind === 'original' ? 'originals' : 'images'), assetCodexId, file]
    .map(part => encodeURIComponent(part).replace(/%2F/g, '/'))
    .join('/');
}

export function imageItemPath(kind, e, item) {
  const file = kind === 'original' ? (item.original || item.path) : item.path;
  if (!file) return '';
  if (isAbsoluteUrl(file)) return file;
  if (state.codex.assetPathMode === 'relative') return encodeAssetPath(file);
  return mediaPath(kind, { ...e, image: item.path, original: item.original || item.path });
}

export function entryImages(e) {
  const images = (e.images && e.images.length)
    ? e.images
    : (e.image ? [{ path: e.image, original: e.original || '', _hasOriginal: Boolean(e.original) }] : []);
  return images.map(item => {
    const hasOriginal = item?._hasOriginal === undefined
      ? Boolean(item?.original)
      : Boolean(item._hasOriginal);
    return item?._hasOriginal === hasOriginal ? item : { ...item, _hasOriginal: hasOriginal };
  });
}

/* imageItemUrl('original') 为兼容旧调用会回退到缩略图路径；需要向用户声明
   “真实原图”时必须看这个显式标记，不能把 fallback 误报成 original。 */
export function imageItemHasOriginal(item, entry = null) {
  if (item?._hasOriginal !== undefined) return Boolean(item._hasOriginal);
  return Boolean(item?.original || (entry?.original && !item));
}

export function isAbsoluteUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) || String(url || '').startsWith('data:');
}

export function encodeAssetPath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

export function withRev(url, e) {
  if (!url || !e.assetRev) return url;
  return url + (url.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(e.assetRev);
}

export function localAssetUrl(kind, e) {
  if (state.codex.assetPathMode === 'relative') return '';
  return withRev(mediaPath(kind, e), e);
}

export function assetUrl(kind, e, codex = state.codex) {
  const path = mediaPath(kind, e, codex);
  if (!path) return '';
  if (isAbsoluteUrl(path)) return withRev(path, e);
  if (codex.assetPathMode === 'relative') {
    const base = codex.assetBaseUrl;
    return withRev(base ? `${base}/${path}` : path, e);
  }
  if (isLocalOrigin() && state.media.localFallback !== false) return withRev(path, e);
  const base = String(state.media.baseUrl || '').replace(/\/+$/, '');
  return withRev(base ? `${base}/${path}` : path, e);
}

export function imageItemUrl(kind, e, item) {
  const path = imageItemPath(kind, e, item);
  if (!path) return '';
  if (isAbsoluteUrl(path)) return withRev(path, e);
  if (state.codex.assetPathMode === 'relative') {
    const base = state.codex.assetBaseUrl;
    return withRev(base ? `${base}/${path}` : path, e);
  }
  return assetUrl(kind, { ...e, image: item.path, original: item.original || item.path });
}

export function thumbUrl(e, codex = state.codex) {
  return assetUrl('image', e, codex);
}

export function originalUrl(e) {
  return assetUrl('original', e);
}
