import {
  isV2Release, releaseManifestPath, parseReleaseManifest, objectPath,
  readV2Json, validateReleasePointer,
} from '../site/assets/data-release.js';

const V1_RELEASE_RE = /^r-[0-9a-f]{20}$/;
const LOGICAL_PATH_RE = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.json$/;
const OBJECT_PATH_RE = /^objects\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})\.json$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

export function normalizedDataPrefix(env) {
  const prefix = String(env?.ATLAS_DATA_PREFIX || 'data').trim().replace(/^\/+|\/+$/g, '');
  return /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(prefix) && !/[\r\n]/.test(prefix) ? prefix : 'data';
}

function dataError(message, status = 503, transient = true) {
  return Object.assign(new Error(message), { status, transient });
}

function validLogical(path) {
  return path.length <= 240 && LOGICAL_PATH_RE.test(path) && !/[\r\n]/.test(path);
}

function validV1Release(release) {
  return typeof release === 'string' && V1_RELEASE_RE.test(release) && !/[\r\n]/.test(release);
}

async function bytesOf(object, limit) {
  if (Number.isFinite(object.size) && object.size > limit) throw dataError('data object exceeds read budget');
  // R2 bodies are bounded before buffering. Tests may supply text-only bodies.
  let body;
  const stream = object.body;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw dataError('data object exceeds read budget');
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  } else if (stream instanceof Uint8Array) {
    body = stream.slice();
  } else if (typeof stream === 'string') {
    body = new TextEncoder().encode(stream);
  } else if (typeof object.arrayBuffer === 'function') {
    body = new Uint8Array(await object.arrayBuffer());
  } else {
    body = new TextEncoder().encode(await object.text());
  }
  if (body.byteLength > limit) throw dataError('data object exceeds read budget');
  return body;
}

async function hashBytes(body) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)), x => x.toString(16).padStart(2, '0')).join('');
}

/** Request-local only: never share an R2 I/O promise between Workers requests.
 * Immutable manifests and small object bytes have bounded caches; failures are evicted.
 */
export function createAtlasDataReader(bucket, prefix = 'data') {
  prefix = normalizedDataPrefix({ ATLAS_DATA_PREFIX: prefix });
  const pending = new Map();
  const manifests = new Map();
  const objects = new Map();
  let cachedBytes = 0;

  async function merge(key, run) {
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 32) throw dataError('data reader concurrency budget exceeded');
    const work = Promise.resolve().then(run);
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  }

  async function get(path) {
    const object = await bucket.get(`${prefix}/${path}`);
    if (!object) throw dataError('data object not found', 404, false);
    return object;
  }

  async function pointer(path = 'current.json') {
    if (!['current.json', 'v2/current.json'].includes(path)) throw dataError('invalid pointer path', 400, false);
    let object;
    try { object = await get(path); } catch { throw dataError('current release unavailable'); }
    const body = await bytesOf(object, 65536);
    const current = validateReleasePointer(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)), prefix);
    if (path.startsWith('v2/') ? !isV2Release(current.release) : !validV1Release(current.release)) throw dataError('current release schema mismatch');
    return { object, body, current, release: current.release };
  }

  async function loadManifest(release) {
    if (!isV2Release(release)) throw dataError('invalid v2 release', 400, false);
    if (manifests.has(release)) return manifests.get(release);
    return merge(`manifest:${release}`, async () => {
      const object = await get(releaseManifestPath(release));
      const body = await bytesOf(object, MAX_MANIFEST_BYTES);
      const value = await parseReleaseManifest(body, release);
      if (manifests.size >= 8) manifests.delete(manifests.keys().next().value);
      const record = { value, object, body };
      manifests.set(release, record);
      return record;
    });
  }

  async function manifest(release) { return (await loadManifest(release)).value; }

  async function rawObject(path, expected) {
    const match = OBJECT_PATH_RE.exec(path);
    if (!match || match[1] !== match[2].slice(0, 2)) throw dataError('invalid content object path', 400, false);
    const result = objects.has(path) ? objects.get(path) : await merge(`object:${path}`, async () => {
      const object = await get(path);
      const body = await bytesOf(object, Math.min(expected?.size || MAX_OBJECT_BYTES, MAX_OBJECT_BYTES));
      if (expected && body.byteLength !== expected.size) throw dataError('object body size mismatch');
      if (await hashBytes(body) !== match[2]) throw dataError('object body SHA-256 mismatch');
      const value = { object, body };
      if (body.byteLength <= 1024 * 1024) {
        while (objects.size >= 16 || cachedBytes + body.byteLength > 4 * 1024 * 1024) {
          const oldest = objects.keys().next().value;
          cachedBytes -= objects.get(oldest).body.byteLength;
          objects.delete(oldest);
        }
        objects.set(path, value);
        cachedBytes += body.byteLength;
      }
      return value;
    });
    if (expected && result.body.byteLength !== expected.size) throw dataError('object body size mismatch');
    return result;
  }

  async function logical(release, path) {
    if (!validLogical(path)) throw dataError('invalid logical JSON path', 400, false);
    const value = await manifest(release);
    if (!Object.hasOwn(value.files, path)) throw dataError('logical file is absent from this release', 404, false);
    const item = value.files[path];
    return { ...await rawObject(objectPath(item.sha256), item), release };
  }

  async function json(release, path) {
    const value = await manifest(release);
    if (!validLogical(path) || !Object.hasOwn(value.files, path)) throw dataError('logical file is absent from this release', 404, false);
    return readV2Json(value, path, async object => (await rawObject(object, value.files[path])).body);
  }

  async function manifestObject(release) {
    const value = await loadManifest(release);
    return { object: value.object, body: value.body, release };
  }

  return { pointer, manifest, manifestObject, logical, json, rawObject };
}

function decodeParts(raw) {
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map(value => decodeURIComponent(String(value || ''))).filter(Boolean);
}

function validJsonParts(parts) {
  return parts.length > 0 && parts.every(part => part !== '.' && part !== '..' && !/[\/\\\0\r\n]/.test(part)) && parts.at(-1).endsWith('.json');
}

function rangeBounds(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  let start = Number(match[1] || 0);
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) { start = Math.max(0, size - Number(match[2])); end = size - 1; }
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size
    ? { offset: start, length: Math.min(end, size - 1) - start + 1 }
    : null;
}

function responseFor({ object, body = object.body, release = '', partial }, request, cacheControl) {
  const headers = new Headers();
  if (typeof object.writeHttpMetadata === 'function') object.writeHttpMetadata(headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', cacheControl);
  headers.set('x-content-type-options', 'nosniff');
  if (release) headers.set('x-atlas-data-release', release);
  if (object.httpEtag) headers.set('etag', object.httpEtag);
  const matches = request.headers.get('if-none-match')?.split(',').map(value => value.trim().replace(/^W\//, ''));
  if (matches && (matches.includes('*') || (object.httpEtag && matches.includes(object.httpEtag.replace(/^W\//, ''))))) return new Response(null, { status: 304, headers });
  let status = partial ? 206 : 200;
  if (partial) {
    headers.set('accept-ranges', 'bytes');
    headers.set('content-range', `bytes ${partial.offset}-${partial.offset + partial.length - 1}/${object.size}`);
    headers.set('content-length', String(partial.length));
  }
  if (body instanceof Uint8Array) {
    headers.set('content-length', String(body.byteLength));
    headers.set('accept-ranges', 'bytes');
    const range = request.headers.get('range');
    const ifRange = request.headers.get('if-range');
    if (request.method === 'GET' && range && (!ifRange || ifRange === object.httpEtag)) {
      const bounds = rangeBounds(range, body.byteLength);
      if (!bounds) {
        headers.set('content-range', `bytes */${body.byteLength}`);
        headers.delete('content-length');
        return new Response(null, { status: 416, headers });
      }
      const start = bounds.offset;
      const end = start + bounds.length - 1;
      headers.set('content-range', `bytes ${start}-${end}/${body.byteLength}`);
      body = body.subarray(start, end + 1);
      headers.set('content-length', String(body.byteLength));
      status = 206;
    }
  }
  return new Response(request.method === 'HEAD' ? null : body, { status, headers });
}

export async function handleAtlasDataRequest(request, env, rawParts) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  const bucket = env?.ATLAS_DATA_BUCKET;
  if (!bucket) return new Response('data binding unavailable', { status: 503 });
  let parts;
  try { parts = decodeParts(rawParts); } catch { return new Response('invalid data path', { status: 400 }); }
  if (!validJsonParts(parts)) return new Response('invalid data path', { status: 400 });
  const prefix = normalizedDataPrefix(env);
  const reader = createAtlasDataReader(bucket, prefix);
  try {
    const path = parts.join('/');
    if (path === 'current.json' || path === 'v2/current.json') return responseFor(await reader.pointer(path), request, 'no-store');
    if (parts[0] === 'objects') return responseFor(await reader.rawObject(path), request, IMMUTABLE);
    let release;
    let logical;
    let cacheControl = 'no-store';
    const v2 = parts[0] === 'v2';
    const offset = v2 ? 1 : 0;
    if (parts[offset] === 'releases') {
      release = parts[offset + 1] || '';
      logical = parts.slice(offset + 2).join('/');
      if ((!isV2Release(release) && (!validV1Release(release) || v2)) || !logical) throw dataError('invalid release path', 400, false);
      cacheControl = IMMUTABLE;
    } else {
      const pointer = await reader.pointer(v2 ? 'v2/current.json' : 'current.json');
      release = pointer.release;
      logical = parts.slice(offset).join('/');
    }
    if (isV2Release(release)) {
      const value = logical === 'manifest.json' ? await reader.manifestObject(release) : await reader.logical(release, logical);
      return responseFor(value, request, cacheControl);
    }
    if (!validJsonParts(logical.split('/'))) throw dataError('invalid release path', 400, false);
    const key = `${prefix}/releases/${release}/${logical}`;
    const range = request.method === 'GET' && request.headers.get('range');
    let partial;
    if (range) {
      const metadata = await bucket.head(key);
      if (!metadata) throw dataError('data object not found', 404, false);
      const ifRange = request.headers.get('if-range');
      if (!ifRange || ifRange === metadata.httpEtag) {
        partial = rangeBounds(range, metadata.size);
        if (!partial) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${metadata.size}`, 'cache-control': cacheControl, 'x-atlas-data-release': release, ...(metadata.httpEtag ? { etag: metadata.httpEtag } : {}) } });
      }
    }
    const object = partial ? await bucket.get(key, { range: partial }) : await bucket.get(key);
    if (!object) throw dataError('data object not found', 404, false);
    return responseFor({ object, release, partial }, request, cacheControl);
  } catch (error) {
    const status = Number(error.status) || 503;
    return new Response(status === 404 ? 'data object not found' : status === 400 ? 'invalid data path' : 'data proxy unavailable', { status, headers: { 'cache-control': 'no-store' } });
  }
}
