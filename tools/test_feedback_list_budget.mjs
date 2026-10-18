import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/admin/feedback.js';
import { MemoryR2 } from './memory-r2-test-harness.mjs';

const PREFIX = 'feedback/resolved/';
const addressKey = await crypto.subtle.importKey('raw', new TextEncoder().encode('test'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const address = await crypto.subtle.sign('HMAC', addressKey, new TextEncoder().encode('feedback-admin-index-v2/resolved'));
const INDEX = 'feedback/admin-list/' + [...new Uint8Array(address)].map(b => b.toString(16).padStart(2, '0')).join('') + '.json';
class Bucket extends MemoryR2 {
  reads = []; writes = []; deletes = []; pages = 73;
  async get(key) { this.reads.push(key); return super.get(key); }
  async put(key, value, options) { this.writes.push(key); return super.put(key, value, options); }
  async delete(key) { this.deletes.push(key); return super.delete(key); }
  async list({ prefix, cursor, limit = 1000 }) {
    this.listCalls++;
    const keys = [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort();
    const offset = Number(cursor || 0), page = keys.slice(offset, offset + Math.min(limit, this.pages));
    const truncated = offset + page.length < keys.length;
    return { objects: page.map(key => ({ key, etag: this.etags.get(key) })), truncated,
      ...(truncated ? { cursor: String(offset + page.length) } : {}) };
  }
}
const key = i => `${PREFIX}2026/01/${String(i).padStart(6, '0')}.json`;
const record = (i, changed = 0) => ({ id: `item${i}`, createdAt: i, progressStatusUpdatedAt: changed,
  description: 'PRIVATE BODY', contact: 'PRIVATE CONTACT', status: 'resolved' });
async function fixture(n) {
  const bucket = new Bucket();
  for (let i = 1; i <= n; i++) await bucket.put(key(i), JSON.stringify(record(i)));
  bucket.reads = []; bucket.writes = [];
  return bucket;
}
async function page(bucket, authorized = true, secret = "test") {
  const start = bucket.reads.length;
  const response = await onRequestGet({ env: { STRINGS_BUCKET: bucket, ADMIN_TOKEN: secret },
    request: new Request('https://local.test/api/admin/feedback?status=resolved', { headers: { authorization: authorized ? `Bearer ${secret.trim()}` : '' } }) });
  assert.ok(bucket.reads.slice(start).filter(key => key.startsWith(PREFIX)).length <= 200, 'one HTTP request must read at most 200 record bodies');
  return { response, data: await response.json() };
}
async function complete(bucket) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await page(bucket);
    if (result.response.status === 200) return result.data;
    assert.equal(result.response.status, 202);
    assert.equal(result.data.indexing, true);
    assert.deepEqual(result.data.items, [], 'incomplete ranking must not masquerade as latest feedback');
  }
  assert.fail('stable finite fixture must finish indexing');
}
const cases = [];
const measurements = [];
cases.push(['cache does not expose private record keys or ETags', async () => {
  const bucket = await fixture(2);
  // This synthetic IV reproduces a valid Base64 ciphertext containing "v1".
  // A short substring in ciphertext is not evidence that an ETag leaked.
  const getRandomValues = crypto.getRandomValues;
  try {
    crypto.getRandomValues = bytes => { bytes.fill(0); bytes[bytes.length - 1] = 45; return bytes; };
    await complete(bucket);
  } finally { crypto.getRandomValues = getRandomValues; }
  const stored = [...bucket.objects].filter(([k]) => k.startsWith('feedback/admin-list/'));
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0][0], 'feedback/admin-list/resolved.json', 'cache address must not be guessable from status');
  const payload = stored[0][1];
  assert.doesNotMatch(payload, /feedback\/resolved\/|PRIVATE BODY|PRIVATE CONTACT/);
  const envelope = JSON.parse(payload);
  assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'iv', 'version'], 'no plaintext index metadata may be stored beside ciphertext');
  assert.equal(envelope.version, 2);
  assert.equal(Buffer.from(envelope.iv, 'base64').length, 12);
  assert.ok(envelope.ciphertext.includes('v1'), 'fixed synthetic IV must exercise the short-token counterexample');
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', encoder.encode('test'), 'HKDF', false, ['deriveKey']);
  const encryptionKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
    salt: encoder.encode('feedback-admin-index-v2'), info: encoder.encode('encrypted-record-index') },
  material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const algorithm = { name: 'AES-GCM', iv: Buffer.from(envelope.iv, 'base64'), additionalData: encoder.encode(INDEX) };
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const decoded = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt(algorithm, encryptionKey, ciphertext)));
  assert.deepEqual(decoded.entries.map(entry => [entry.key, entry.etag]), [1, 2].map(i => [key(i), bucket.etags.get(key(i))]));
  await assert.rejects(crypto.subtle.decrypt({ ...algorithm, additionalData: encoder.encode(INDEX + '/wrong') }, encryptionKey, ciphertext),
    'index metadata must be authenticated to its cache address');
}], ['tampered encrypted cache is rebuilt', async () => {
  const bucket = await fixture(2); await complete(bucket);
  const envelope = JSON.parse(bucket.objects.get(INDEX));
  envelope.ciphertext = (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1);
  await bucket.put(INDEX, JSON.stringify(envelope));
  assert.deepEqual((await complete(bucket)).items.map(x => x.id), ['item2', 'item1']);
  assert.notEqual(JSON.parse(bucket.objects.get(INDEX)).ciphertext, envelope.ciphertext);
}], ['token rotation rebuilds without trusting old cached entries', async () => {
  const bucket = await fixture(2); await complete(bucket); bucket.reads = [];
  const result = await page(bucket, true, '  rotated-test  ');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data.items.map(x => x.id), ['item2', 'item1']);
  assert.equal(bucket.writes.filter(k => k.startsWith('feedback/admin-list/')).length, 2);
}]);
for (const warm of [false, true]) cases.push([`transient body stream failure is not cached as malformed JSON (warm=${warm})`, async () => {
  const bucket = await fixture(2);
  if (warm) await complete(bucket);
  const get = bucket.get.bind(bucket); let fail = true;
  bucket.get = async k => {
    const object = await get(k);
    if (k === key(1) && fail) {
      const broken = async () => { fail = false; throw new TypeError('transient body stream failure'); };
      return { ...object, json: broken, text: broken };
    }
    return object;
  };
  assert.equal((await page(bucket)).response.status, 503, 'stream failure must not claim a complete list or poison its ETag');
  assert.deepEqual((await complete(bucket)).items.map(x => x.id), ['item2', 'item1']);
}]);
for (const n of [500, 1000, 2000]) cases.push([`bounded bodies and complete latest ordering N=${n}`, async () => {
  const bucket = await fixture(n);
  await bucket.put(key(1), JSON.stringify(record(1, n + 100)));
  const data = await complete(bucket);
  assert.deepEqual(data.items.map(x => x.id), ['item1', ...Array.from({ length: 199 }, (_, i) => `item${n - i}`)]);
  bucket.reads = []; bucket.listCalls = 0; bucket.writes = [];
  const warm = await page(bucket);
  assert.equal(warm.response.status, 200);
  assert.deepEqual(warm.data.items, data.items);
  assert.equal(bucket.reads.filter(k => k.startsWith(PREFIX)).length, 200);
  assert.equal(bucket.writes.length, 0, 'unchanged warm reads do not write the cache');
  assert.equal(bucket.deletes.length, 0);
  assert.doesNotMatch(bucket.objects.get(INDEX), /PRIVATE BODY|PRIVATE CONTACT/);
  measurements.push({ n, warmRecordReads: 200, warmTotalGets: bucket.reads.length, warmListCalls: bucket.listCalls });
}]);
cases.push(['changed old record becomes newest and removed records are not returned', async () => {
  const bucket = await fixture(500); await complete(bucket);
  await bucket.put(key(2), JSON.stringify(record(2, 9000)));
  await bucket.delete(key(500));
  const data = await complete(bucket);
  assert.equal(data.items[0].id, 'item2'); assert.ok(!data.items.some(x => x.id === 'item500'));
}], ['corrupt cache rebuilds without partial success', async () => {
  const bucket = await fixture(500); await bucket.put(INDEX, '{');
  assert.equal((await page(bucket)).response.status, 202);
  assert.equal((await complete(bucket)).items.length, 200);
}], ['malformed record is ignored until its etag changes', async () => {
  const bucket = await fixture(2); await bucket.put(key(1), '{');
  assert.deepEqual((await complete(bucket)).items.map(x => x.id), ['item2']);
  await bucket.put(key(1), JSON.stringify(record(1, 100)));
  assert.equal((await complete(bucket)).items[0].id, 'item1');
}], ['cache CAS conflict never overwrites the other builder', async () => {
  const bucket = await fixture(500); const put = bucket.put.bind(bucket); let conflict = true;
  bucket.put = async (k, value, options) => {
    if (k === INDEX && conflict) { conflict = false; await put(k, JSON.stringify({ marker: 'other-builder' })); }
    return put(k, value, options);
  };
  assert.equal((await page(bucket)).response.status, 202);
  assert.equal(JSON.parse(bucket.objects.get(INDEX)).marker, 'other-builder');
  assert.equal((await complete(bucket)).items.length, 200);
}], ['unauthorized request does not read or build the index', async () => {
  const bucket = await fixture(500); assert.equal((await page(bucket, false)).response.status, 401);
  assert.equal(bucket.reads.length, 0); assert.equal(bucket.listCalls, 0); assert.equal(bucket.writes.length, 0);
}], ['object changes between list and body read must be retried', async () => {
  const bucket = await fixture(2); await complete(bucket); let changed = false;
  const get = bucket.get.bind(bucket);
  bucket.get = async k => { if (k === key(2) && !changed) { changed = true; await bucket.put(k, JSON.stringify(record(2, 9000))); } return get(k); };
  assert.equal((await page(bucket)).response.status, 202);
  assert.equal((await complete(bucket)).items[0].progressStatusUpdatedAt, 9000);
}], ['record read failure returns an error, never an incomplete latest list', async () => {
  const bucket = await fixture(2); const get = bucket.get.bind(bucket);
  bucket.get = async k => { if (k === key(2)) throw new Error('synthetic read error'); return get(k); };
  assert.equal((await page(bucket)).response.status, 503);
}], ['truncated page without a new cursor fails closed', async () => {
  const bucket = await fixture(2); let calls = 0;
  bucket.list = async () => { if (++calls > 2) throw new Error('fixture stopped an unbounded list loop'); return { objects: [], truncated: true }; };
  assert.equal((await page(bucket)).response.status, 503);
}]);
let failed = 0;
for (const [name, test] of cases) {
  try { await test(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}
console.log(JSON.stringify({ measurements }));
if (failed) { console.error(`feedback list budget: FAIL (${failed}/${cases.length})`); process.exitCode = 1; }
else console.log(`feedback list budget: PASS (${cases.length} cases)`);
