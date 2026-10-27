import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/admin/feedback.js';
import { writeCanonical } from '../functions/_record-store.js';
import { MemoryR2 } from './memory-r2-test-harness.mjs';

class Bucket extends MemoryR2 {
  bodyReads = 0;
  async get(key) { if (/^feedback\/(resolved|pending|ignored|records)\//.test(key)) this.bodyReads++; return super.get(key); }
}
const key = (id, month = '01') => `feedback/resolved/2026/${month}/${id}.json`;
const item = (id, time = 1) => ({ id, status: 'resolved', createdAt: time, description: 'synthetic private feedback', contact: 'private@example.test' });
async function fixture(n) {
  const bucket = new Bucket();
  for (let i = 0; i < n; i++) {
    const id = `id${String(i).padStart(5, '0')}`;
    await bucket.put(key(id), JSON.stringify(item(id, i < 230 ? 1 : i)));
  }
  return bucket;
}
async function request(bucket, cursor = '', status = 'resolved') {
  const before = bucket.bodyReads;
  const url = new URL('https://local.test/api/admin/feedback');
  url.searchParams.set('status', status);
  if (cursor) url.searchParams.set('cursor', cursor);
  const response = await onRequestGet({ env: { STRINGS_BUCKET: bucket, ADMIN_TOKEN: 'test' },
    request: new Request(url, { headers: { authorization: 'Bearer test' } }) });
  assert.ok(bucket.bodyReads - before <= 200, 'every HTTP request is bounded to 200 feedback body reads');
  return { code: response.status, data: await response.json() };
}
async function ready(bucket, cursor = '', status = 'resolved') {
  for (let i = 0; i < 30; i++) {
    const result = await request(bucket, cursor, status);
    if (result.code !== 202) return result;
    assert.deepEqual(result.data.items, [], '202 must not return a partial ranking');
  }
  assert.fail('finite stable fixture never finishes indexing');
}
const cases = [];
for (const n of [200, 201, 300, 1000]) cases.push([`all ${n} records are reachable in stable global activity order`, async () => {
  const bucket = await fixture(n);
  const collected = []; let cursor = '', pages = 0;
  do {
    const result = await ready(bucket, cursor); assert.equal(result.code, 200);
    assert.equal(result.data.total, n);
    assert.equal(result.data.offset, pages * 200);
    assert.ok(result.data.items.length <= 200);
    if (result.data.nextCursor) {
      const decoded = JSON.parse(Buffer.from(result.data.nextCursor, 'base64url').toString());
      assert.deepEqual(Object.keys(decoded).sort(), ['o', 'r', 's', 'v']);
      assert.doesNotMatch(JSON.stringify(decoded), /feedback\/|test|private|description|contact/);
    }
    collected.push(...result.data.items.map(value => value.id));
    cursor = result.data.nextCursor; pages++;
    assert.ok(pages <= Math.ceil(n / 200), 'cursor must advance');
  } while (cursor);
  const expected = Array.from({ length: n }, (_, i) => `id${String(i).padStart(5, '0')}`)
    .sort((a, b) => {
      const ai = Number(a.slice(2)), bi = Number(b.slice(2));
      return (bi < 230 ? 1 : bi) - (ai < 230 ? 1 : ai) || a.localeCompare(b);
    });
  assert.deepEqual(collected, expected);
  assert.equal(new Set(collected).size, n);
}]);
cases.push(['changed version and cross-status cursors fail explicitly', async () => {
  const bucket = await fixture(300); const first = await ready(bucket);
  assert.ok(first.data.nextCursor);
  assert.equal((await request(bucket, first.data.nextCursor, 'pending')).code, 409);
  await bucket.put(key('newest'), JSON.stringify(item('newest', 9999)));
  const stale = await ready(bucket, first.data.nextCursor);
  assert.equal(stale.code, 409); assert.equal(stale.data.resetPagination, true);
  const refreshed = await ready(bucket);
  assert.equal(refreshed.data.items[0].id, 'newest'); assert.equal(refreshed.data.offset, 0);
}], ['malformed and excessive cursor input fails before any storage access', async () => {
  const bucket = await fixture(1);
  const shape = { v: 1, s: 'resolved', r: 'a'.repeat(64), o: 200 };
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const cursor of ['!', 'a'.repeat(513), encoded(null), encoded({ ...shape, o: -200 }),
    encoded({ ...shape, o: 50000 }), encoded({ ...shape, o: 1 }), encoded({ ...shape, v: 2 }),
    encoded({ ...shape, r: 'a'.repeat(63) }), encoded({ ...shape, extra: true })]) {
    const before = bucket.listCalls + bucket.bodyReads;
    assert.equal((await request(bucket, cursor)).code, 400);
    assert.equal(bucket.listCalls + bucket.bodyReads, before);
  }
}], ['canonical authority and legacy duplicates never consume multiple page positions', async () => {
  const bucket = await fixture(201);
  await bucket.put(key('id00000', '02'), JSON.stringify(item('id00000', 99999)));
  await bucket.put(key('id00001', '02'), JSON.stringify(item('id00001', 88888)));
  await writeCanonical(bucket, 'feedback', 'id00001', null, { status: 'pending', record: { ...item('id00001'), status: 'pending' } });
  await writeCanonical(bucket, 'feedback', 'id00002', null, { status: 'resolved', deleted: true });
  const result = await ready(bucket);
  assert.equal(result.data.total, 199); assert.equal(result.data.items[0].id, 'id00000');
  assert.equal(result.data.items.filter(value => value.id === 'id00000').length, 1);
  assert.ok(!result.data.items.some(value => ['id00001', 'id00002'].includes(value.id)));
}], ['empty status is a complete empty page', async () => {
  const result = await ready(await fixture(0));
  assert.equal(result.code, 200); assert.equal(result.data.total, 0);
  assert.equal(result.data.offset, 0); assert.equal(result.data.nextCursor, ''); assert.deepEqual(result.data.items, []);
}], ['deletion and migration invalidate an already loaded tail cursor', async () => {
  const bucket = await fixture(201), first = await ready(bucket);
  const tail = await ready(bucket, first.data.nextCursor); assert.equal(tail.data.items.length, 1);
  const deletedId = tail.data.items[0].id;
  await writeCanonical(bucket, 'feedback', deletedId, null, { status: 'resolved', deleted: true });
  assert.equal((await ready(bucket, first.data.nextCursor)).code, 409);
  const refreshed = await ready(bucket); assert.equal(refreshed.data.total, 200); assert.equal(refreshed.data.nextCursor, '');
  const movedId = refreshed.data.items[50].id;
  await writeCanonical(bucket, 'feedback', movedId, null, { status: 'ignored', record: { ...item(movedId), status: 'ignored' } });
  const afterMove = await ready(bucket); assert.equal(afterMove.data.total, 199);
  assert.ok(!afterMove.data.items.some(value => value.id === movedId));
}]);
let failed = 0;
for (const [name, test] of cases) {
  try { await test(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}
console.log(`feedback pagination: ${failed ? 'FAIL' : 'PASS'} (${cases.length - failed}/${cases.length})`);
if (failed) process.exitCode = 1;
