// Synthetic in-memory checks only; never contacts Cloudflare or reads configuration.
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import worker, { buildFixture } from '../workers/r2-platform-test/worker.js';
import compatWorker from '../workers/r2-data-compat/worker.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const runId = '1'.repeat(32);
const token = 'a'.repeat(64);
const hash = body => createHash('md5').update(body).digest('hex');
class SyntheticBucket {
  constructor() { this.objects = new Map(); this.calls = []; }
  metadata(key, item) {
    return { key, etag: item.etag, httpEtag: '"' + item.etag + '"', size: item.body.length,
      writeHttpMetadata(headers) {
        headers.set('content-type', item.metadata?.contentType || 'application/json; charset=utf-8');
      } };
  }
  async head(key) {
    this.calls.push({ method: 'head', key });
    const item = this.objects.get(key);
    return item ? this.metadata(key, item) : null;
  }
  async get(key, options = {}) {
    this.calls.push({ method: 'get', key });
    const item = this.objects.get(key);
    if (!item) return null;
    const whole = item.body.slice();
    const body = options.range ? whole.slice(options.range.offset, options.range.offset + options.range.length) : whole;
    return { ...this.metadata(key, item), body: new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }),
      arrayBuffer: async () => body.slice().buffer, text: async () => new TextDecoder().decode(body) };
  }
  async put(key, value, options = {}) {
    this.calls.push({ method: 'put', key });
    const current = this.objects.get(key);
    const condition = options.onlyIf;
    if (condition?.etagDoesNotMatch === '*' && current) return null;
    if (condition?.etagMatches !== undefined && current?.etag !== condition.etagMatches) return null;
    const body = Uint8Array.from(value);
    const item = { body, etag: hash(body), metadata: options.httpMetadata };
    this.objects.set(key, item);
    return this.metadata(key, item);
  }
  async delete() { throw new Error('deletion forbidden'); }
  async list() { throw new Error('listing forbidden'); }
}
const bucket = new SyntheticBucket();
const env = { ATLAS_DATA_BUCKET: bucket, ATLAS_DATA_PREFIX: 'data', ATLAS_TEST_ONLY: '1',
  ATLAS_TEST_BUCKET_NAME: 'novelai-tag-r2-acceptance-20261021-0123abcd',
  ATLAS_TEST_WORKER_NAME: 'atlas-r2-acceptance-20261021-0123abcd',
  ATLAS_DATA_CORS_ORIGINS: 'https://allowed.invalid', ATLAS_R2_TEST_TOKEN: token };
const origin = 'https://atlas-r2-acceptance-20261021-0123abcd.synthetic.workers.dev';
const request = (path, options = {}, environment = env) => worker.fetch(new Request(origin + path, options), environment);
const post = (value, authorization = 'Bearer ' + token, environment = env) => request('/__test', {
  method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(value),
}, environment);
const savedFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('network forbidden'); };
try {
  const probe = await request('/__test');
  assert.equal(probe.status, 200);
  assert.deepEqual(await probe.json(), { bucket: env.ATLAS_TEST_BUCKET_NAME, worker: env.ATLAS_TEST_WORKER_NAME, testOnly: true });
  assert.equal(bucket.calls.length, 0);
  for (const [authorization, environment] of [
    ['', env], ['Bearer ' + 'b'.repeat(64), env], ['Bearer ' + 'a'.repeat(63), env],
    ['Bearer ' + token, { ...env, ATLAS_R2_TEST_TOKEN: undefined }],
    ['Bearer ' + token, { ...env, ATLAS_R2_TEST_TOKEN: token + '\n' }],
  ]) assert.equal((await post({ case: 'seed', runId }, authorization, environment)).status, 401);
  for (const changed of [
    { ATLAS_TEST_ONLY: '0' }, { ATLAS_TEST_BUCKET_NAME: 'novelai-tag-assets' },
    { ATLAS_TEST_WORKER_NAME: 'other' }, { ATLAS_DATA_PREFIX: 'production' }, { ATLAS_DATA_BUCKET: null },
  ]) assert.equal((await post({ case: 'seed', runId }, 'Bearer ' + token, { ...env, ...changed })).status, 503);
  for (const value of [
    { case: 'delete', runId }, { case: 'seed', runId: '../escape' }, { case: 'seed', runId: runId + '\n' },
    { case: 'seed', runId, key: 'unapproved' }, { case: 'seed', runId, bucket: 'novelai-tag-assets' },
    { case: 'seed', runId, body: 'unapproved' }, [], null,
  ]) assert.equal((await post(value)).status, 400);
  assert.equal((await request('/__test', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: 'x'.repeat(257) })).status, 400);
  assert.equal((await request('/__test?case=seed')).status, 404);
  assert.equal((await request('/__test', { method: 'DELETE' })).status, 405);
  assert.equal(bucket.calls.length, 0, 'guards must reject before any bucket operation');

  const binding = await post({ case: 'binding', runId });
  assert.equal(binding.status, 200);
  const bindingResult = (await binding.json()).result;
  assert.ok(Object.values(bindingResult.checks).every(value => value === true));
  assert.deepEqual(bindingResult.keys, ['platform/' + runId + '/binding/conditional.json', 'platform/' + runId + '/binding/race.json']);
  assert.equal((await post({ case: 'binding', runId })).status, 409);

  const fixture = await buildFixture(runId);
  const seed = await post({ case: 'seed', runId });
  assert.equal(seed.status, 200);
  const seedResult = (await seed.json()).result;
  assert.deepEqual(seedResult.keys, fixture.keys);
  assert.deepEqual([...bucket.objects.keys()].sort(), [...bindingResult.keys, ...fixture.keys].sort());
  const size = bucket.objects.size;
  assert.equal((await post({ case: 'seed', runId: '2'.repeat(32) })).status, 409);
  assert.equal(bucket.objects.size, size, 'second seed must stop before creating objects');
  const old = fixture.versions.old;
  const paths = ['/data/releases/' + old.v1Release + '/demo.json',
    '/data/releases/' + old.release + '/demo.json', '/data/v2/releases/' + old.release + '/demo.json'];
  for (const path of paths) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), old.body);
    const direct = await compatWorker.fetch(new Request(origin + path), env);
    assert.equal(direct.status, response.status, 'test wrapper must preserve active response');
    assert.deepEqual([...direct.headers], [...response.headers]);
    assert.equal((await request(path, { method: 'HEAD' })).body, null);
    assert.equal((await request(path, { headers: { 'if-none-match': response.headers.get('etag') } })).status, 304);
    const range = await request(path, { headers: { range: 'bytes=0-7' } });
    assert.equal(range.status, 206);
    assert.deepEqual(new Uint8Array(await range.arrayBuffer()), old.body.slice(0, 8));
    const suffix = await request(path, { headers: { range: 'bytes=-8' } });
    assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), old.body.slice(-8));
  }
  const bad = fixture.versions.bad;
  assert.equal((await request('/data/releases/' + bad.release + '/demo.json')).status, 503);
  assert.equal((await request('/data/' + bad.blobKey.slice(5))).status, 503);
  const switched = await post({ case: 'switch', runId });
  assert.equal(switched.status, 200);
  assert.equal((await (await request('/data/current.json')).json()).release, fixture.versions.new.v1Release);
  assert.equal((await (await request('/data/v2/current.json')).json()).release, fixture.versions.new.release);
  assert.deepEqual(new Uint8Array(await (await request('/data/v2/demo.json')).arrayBuffer()), fixture.versions.new.body);
  for (const path of paths) assert.deepEqual(new Uint8Array(await (await request(path)).arrayBuffer()), old.body);
  assert.equal((await post({ case: 'switch', runId })).status, 409);
  assert.equal(bucket.calls.some(call => !call.key.startsWith('data/') && !call.key.startsWith('platform/' + runId + '/binding/')), false);
  console.log('R2 platform test Worker guards and synthetic cases passed');
} finally {
  globalThis.fetch = savedFetch;
}
