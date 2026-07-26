'use strict';

const RELEASE_RE = /^r-[0-9a-f]{20}$/;
const DEFAULT_PREFIX = 'data';
const POINTER_CACHE_CONTROL = 'no-store';
const RELEASE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

function normalizePrefix(value) {
  const prefix = String(value || DEFAULT_PREFIX).trim().replace(/^\/+|\/+$/g, '');
  return prefix && !prefix.split('/').includes('..') ? prefix : DEFAULT_PREFIX;
}

function decodeParts(raw) {
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map(value => decodeURIComponent(String(value || ''))).filter(Boolean);
}

function validJsonPath(parts) {
  return parts.length > 0
    && parts.every(part => part !== '.' && part !== '..' && !part.includes('/') && !part.includes('\\'))
    && parts.at(-1).endsWith('.json');
}

async function readCurrent(bucket, prefix) {
  const object = await bucket.get(`${prefix}/current.json`);
  if (!object) return null;
  const body = await object.text();
  const current = JSON.parse(body);
  const release = String(current?.release || '');
  return RELEASE_RE.test(release) ? { current, object, release, body } : null;
}

function objectResponse(object, { method, cacheControl, release = '', body = object.body }) {
  const headers = new Headers();
  if (typeof object.writeHttpMetadata === 'function') object.writeHttpMetadata(headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', cacheControl);
  headers.set('x-content-type-options', 'nosniff');
  if (release) headers.set('x-atlas-data-release', release);
  if (object.httpEtag) headers.set('etag', object.httpEtag);
  return new Response(method === 'HEAD' ? null : body, { status: 200, headers });
}

export async function onRequest(context) {
  const method = context.request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const bucket = context.env?.ATLAS_DATA_BUCKET;
  if (!bucket) return new Response('data binding unavailable', { status: 503 });

  let parts;
  try {
    parts = decodeParts(context.params?.path);
  } catch {
    return new Response('invalid data path', { status: 400 });
  }
  if (!validJsonPath(parts)) return new Response('invalid data path', { status: 400 });

  const prefix = normalizePrefix(context.env?.ATLAS_DATA_PREFIX);
  try {
    if (parts.length === 1 && parts[0] === 'current.json') {
      const resolved = await readCurrent(bucket, prefix);
      if (!resolved) return new Response('current release unavailable', { status: 503 });
      return objectResponse(resolved.object, {
        method,
        cacheControl: POINTER_CACHE_CONTROL,
        release: resolved.release,
        body: resolved.body,
      });
    }

    let release;
    let objectPath;
    let cacheControl;
    if (parts[0] === 'releases') {
      release = String(parts[1] || '');
      objectPath = parts.slice(2);
      if (!RELEASE_RE.test(release) || !validJsonPath(objectPath)) {
        return new Response('invalid release path', { status: 400 });
      }
      cacheControl = RELEASE_CACHE_CONTROL;
    } else {
      const resolved = await readCurrent(bucket, prefix);
      if (!resolved) return new Response('current release unavailable', { status: 503 });
      release = resolved.release;
      objectPath = parts;
      cacheControl = POINTER_CACHE_CONTROL;
    }

    const key = `${prefix}/releases/${release}/${objectPath.join('/')}`;
    const object = await bucket.get(key);
    if (!object) return new Response('data object not found', { status: 404 });
    return objectResponse(object, { method, cacheControl, release });
  } catch (error) {
    console.warn('R2 data proxy failed', error);
    return new Response('data proxy unavailable', { status: 503 });
  }
}
