import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { onRequest } from '../functions/data/[[path]].js';

const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));
function fixture(values) {
  const files = Object.fromEntries(Object.entries(values).sort().map(([name, value]) => {
    const body = encode(value);
    return [name, { sha256: hash(body), size: body.length }];
  }));
  const contentHash = hash('r2-cas-v2\n' + Object.entries(files).map(([name, m]) => name + '\0' + m.sha256 + '\0' + m.size + '\n').join(''));
  const release = 'r2-' + contentHash;
  const manifest = { contentHash, files, release, schemaVersion: 2 };
  const raw = Buffer.from(JSON.stringify(manifest) + '\n');
  const objects = { ['data/v2/releases/' + release + '/manifest.json']: raw };
  for (const [name, value] of Object.entries(values)) {
    const digest = files[name].sha256;
    objects['data/objects/sha256/' + digest.slice(0, 2) + '/' + digest + '.json'] = encode(value);
  }
  objects['data/v2/current.json'] = encode({ schemaVersion: 2, release, contentHash, manifest: 'data/v2/releases/' + release + '/manifest.json', publishedAt: '2026-10-20T00:00:00Z', operationId: '0'.repeat(32) });
  return { release, manifest, objects };
}
function bucketFor(objects) {
  const calls = [];
  return { calls, async get(key) {
    calls.push(key);
    const raw = objects[key];
    if (raw instanceof Error) throw raw;
    if (!raw) return null;
    return { size: raw.length, httpEtag: '"' + hash(raw) + '"', arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), text: async () => raw.toString('utf8'), body: raw, writeHttpMetadata(headers) { headers.set('content-type', 'application/json; charset=utf-8'); } };
  } };
}
const frozen = fixture({ 'codexes.json': [{ id: 'old' }], 'tag_zh/demo.v2.json': { version: 'old' } });
const newer = fixture({ 'codexes.json': [{ id: 'new' }] });
const objects = { ...frozen.objects, ...newer.objects };
const bucket = bucketFor(objects);
const call = (route, options = {}) => onRequest({ request: new Request('https://preview.example/data/' + route, options), params: { path: route.split('/') }, env: { ATLAS_DATA_BUCKET: bucket, ATLAS_DATA_PREFIX: 'data' } });

// Fails on the old proxy: v2 requests must resolve the selected immutable snapshot.
{
  const response = await call('v2/current.json');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).release, newer.release);
  assert.equal(response.headers.get('cache-control'), 'no-store');
}
for (const route of ['releases/' + frozen.release + '/codexes.json', 'v2/releases/' + frozen.release + '/codexes.json']) {
  const response = await call(route);
  assert.equal(response.status, 200);
  assert.equal((await response.json())[0].id, 'old');
  assert.equal(response.headers.get('x-atlas-data-release'), frozen.release);
  assert.match(response.headers.get('cache-control'), /immutable/);
}
assert.equal((await call('v2/codexes.json')).status, 200);
assert.equal((await (await call('releases/' + frozen.release + '/tag_zh/demo.v2.json')).json()).version, 'old');
assert.equal((await call('releases/' + frozen.release + '/missing.json')).status, 404);
assert.equal((await call('v2/releases/' + frozen.release + '/manifest.json')).status, 200);
assert.equal((await call('releases/' + frozen.release + '/codexes.json', { method: 'HEAD' })).body, null);
for (const route of ['v2/releases/' + frozen.release + '/%2e%2e/x.json', 'v2/releases/' + frozen.release + '/%252e%252e.json', 'objects/sha256/00/' + 'f'.repeat(64) + '.json', 'objects/private.json', 'feedback/private.json']) {
  assert.ok([400, 404, 503].includes((await call(route)).status));
}
assert.equal(bucket.calls.some(key => key.includes('feedback/')), false);
{
  const response = await call('releases/' + frozen.release + '/codexes.json');
  const etag = response.headers.get('etag');
  assert.equal((await call('releases/' + frozen.release + '/codexes.json', { headers: { 'if-none-match': etag } })).status, 304);
  assert.equal((await call('releases/' + frozen.release + '/codexes.json', { headers: { 'if-none-match': 'W/' + etag } })).status, 304);
  for (const range of ['bytes=999999-', 'bytes=-0', 'bytes=3-1']) {
    const invalid = await call('releases/' + frozen.release + '/codexes.json', { headers: { range } });
    assert.equal(invalid.status, 416);
    assert.match(invalid.headers.get('content-range'), /^bytes \*\//);
  }
  assert.equal((await call('releases/' + frozen.release + '/codexes.json', { headers: { range: 'bytes=0-1', 'if-range': '"different"' } })).status, 200);
}

const { createAtlasDataReader } = await import('../functions/_atlas_data.js');
const reader = createAtlasDataReader(bucket);
const before = bucket.calls.length;
const manifests = await Promise.all([reader.manifest(frozen.release), reader.manifest(frozen.release)]);
assert.equal(bucket.calls.length - before, 1, 'same-request manifest reads should merge inflight');
assert.equal(manifests[0].release, frozen.release);
{
  const variants = Array.from({ length: 10 }, (_, index) => fixture({ 'codexes.json': [{ id: index }] }));
  const manifestObjects = Object.assign({}, ...variants.map(item => item.objects));
  const bounded = bucketFor(manifestObjects);
  const boundedReader = createAtlasDataReader(bounded);
  for (const item of variants) await boundedReader.manifest(item.release);
  const count = bounded.calls.length;
  await boundedReader.manifest(variants[0].release);
  assert.equal(bounded.calls.length, count + 1, 'manifest cache must evict beyond eight releases');
  const parallel = createAtlasDataReader(bucketFor(manifestObjects));
  assert.equal((await Promise.all(variants.map(item => parallel.manifestObject(item.release)))).length, 10);
  const oversize = createAtlasDataReader({ get: async () => ({ size: 32 * 1024 * 1024 + 1, get body() { throw new Error('must not read oversized body'); } }) });
  await assert.rejects(oversize.rawObject('objects/sha256/aa/' + 'a'.repeat(64) + '.json'), /read budget/);
}
const failing = bucketFor({ ...frozen.objects });
const retryReader = createAtlasDataReader(failing);
failing.get = async () => { throw new Error('temporary'); };
await assert.rejects(retryReader.manifest(frozen.release));
failing.get = bucketFor(frozen.objects).get;
assert.equal((await retryReader.manifest(frozen.release)).release, frozen.release, 'failed cache entry must be retryable');
const corruptObjects = { ...frozen.objects };
const digest = frozen.manifest.files['codexes.json'].sha256;
corruptObjects['data/objects/sha256/' + digest.slice(0, 2) + '/' + digest + '.json'] = encode([{ id: 'bad' }]);
const corrupt = bucketFor(corruptObjects);
const response = await onRequest({ request: new Request('https://preview.example/data/releases/' + frozen.release + '/codexes.json'), params: { path: ['releases', frozen.release, 'codexes.json'] }, env: { ATLAS_DATA_BUCKET: corrupt } });
assert.equal(response.status, 503);
assert.equal(corrupt.calls.includes('data/current.json'), false, 'corrupt v2 content cannot fall back to current');

const { default: worker } = await import('../workers/r2-data-compat/worker.js');
const env = { ATLAS_DATA_BUCKET: bucket, ATLAS_DATA_CORS_ORIGINS: 'https://allowed.invalid' };
const compatUrl = 'https://assets.invalid/data/releases/' + frozen.release + '/codexes.json';
const compat = await worker.fetch(new Request(compatUrl, { headers: { origin: 'https://allowed.invalid' } }), env);
assert.equal(compat.status, 200);
assert.deepEqual(await compat.json(), [{ id: 'old' }]);
assert.equal(compat.headers.get('access-control-allow-origin'), 'https://allowed.invalid');
assert.equal((await worker.fetch(new Request(compatUrl, { headers: { origin: 'https://denied.invalid' } }), env)).headers.get('access-control-allow-origin'), null);
assert.equal((await worker.fetch(new Request('https://assets.invalid/images/demo.jpg'), env)).status, 404);
assert.equal((await worker.fetch(new Request(compatUrl, { method: 'POST' }), env)).status, 405);
const preflight = await worker.fetch(new Request(compatUrl, { method: 'OPTIONS', headers: { origin: 'https://allowed.invalid', 'access-control-request-method': 'GET', 'access-control-request-headers': 'Range' } }), env);
assert.equal(preflight.status, 204);
const range = await worker.fetch(new Request(compatUrl, { headers: { Range: 'bytes=0-3' } }), env);
assert.equal(range.status, 206);
assert.equal((await range.arrayBuffer()).byteLength, 4);
assert.equal((await worker.fetch(new Request(compatUrl, { headers: { origin: 'https://allowed.invalid' } }), { ATLAS_DATA_BUCKET: bucket })).headers.get('access-control-allow-origin'), null, 'default CORS cannot widen the public bucket allowlist');
assert.equal((await worker.fetch(new Request(compatUrl, { method: 'OPTIONS', headers: { origin: 'https://allowed.invalid', 'access-control-request-method': 'POST' } }), env)).status, 403);
assert.equal((await worker.fetch(new Request(compatUrl, { method: 'OPTIONS', headers: { origin: 'https://allowed.invalid', 'access-control-request-method': 'GET', 'access-control-request-headers': 'Authorization' } }), env)).status, 403);
console.log('R2 data compatibility tests passed');
