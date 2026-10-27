import assert from 'node:assert/strict';
import { listRecordMetadata, readListedRecords, countPendingRecords, canonicalKey, writeCanonical, readCanonical } from '../functions/_record-store.js';
import { requireRecordIndex, maintainRecordIndex, prepareRecordMarker } from '../functions/_record-index.js';
import { readAdminFeedbackList } from '../functions/_feedback-list.js';
import { onRequestPost as feedbackSubmit } from '../functions/api/feedback.js';
import { onRequestPost as communitySubmit } from '../functions/api/submit.js';
import { onRequestPost as deleteFeedback } from '../functions/api/admin/feedback-delete.js';
import { rebuildPublicFeedbackIndex } from '../functions/_feedback.js';
import { listCommunityRecords, rebuildCommunity } from '../functions/_lib.js';
import { onRequestPost as moderate } from '../functions/api/admin/community/[[path]].js';
import { onRequestGet as publicCommunity } from '../functions/api/community.js';
import { MemoryR2 } from './memory-r2-test-harness.mjs';

globalThis.fetch = async () => { throw new Error('network forbidden in record edge fixtures'); };
const cases = [];
async function test(name, action) {
  try { await action(); cases.push({ name, status: 'PASS' }); }
  catch (error) { cases.push({ name, status: 'FAIL', error: error.stack }); }
}
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const badId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const env = bucket => ({ STRINGS_BUCKET: bucket, STRINGS_PUBLIC_BASE: 'https://synthetic.invalid', ADMIN_TOKEN: 'test' });
class Bucket extends MemoryR2 {
  async list({ prefix = '', cursor, limit = 1000, startAfter = '' }) {
    const keys = [...this.objects.keys()].filter(key => key.startsWith(prefix) && key > startAfter).sort();
    const offset = Number(cursor || 0), page = keys.slice(offset, offset + limit);
    return { objects: page.map(key => ({ key, etag: this.etags.get(key), customMetadata: this.customMetas.get(key) })),
      truncated: offset + page.length < keys.length,
      ...(offset + page.length < keys.length ? { cursor: String(offset + page.length) } : {}) };
  }
  seed(key, value, customMetadata) { return this.put(key, typeof value === 'string' ? value : JSON.stringify(value), { customMetadata }); }
}
async function ready(action) {
  for (let i = 0; i < 1000; i++) {
    try { return await action(); }
    catch (error) { if (!error.indexing) throw error; }
  }
  throw new Error('index preparation did not progress');
}
const rec = (entryId = id) => ({ id: entryId, status: 'approved', prompt: 'synthetic valid prompt', title: 'synthetic', images: [], createdAt: 1 });
const request = () => new Request('https://synthetic.invalid/api/admin/community/unpublish', {
  method: 'POST', headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, body: JSON.stringify({ id }),
});

await test('one malformed legacy JSON cannot suppress valid records or block unpublish retry', async () => {
  const bucket = new Bucket();
  await bucket.seed(`community/approved/${id}.json`, rec());
  await ready(() => rebuildCommunity(env(bucket)));
  await bucket.seed(`community/approved/${badId}.json`, '{');
  const rows = await ready(() => listCommunityRecords(env(bucket), 'approved'));
  assert.deepEqual(rows.map(x => x.id), [id]);
  for (let i = 0; i < 2; i++) {
    const response = await moderate({ env: env(bucket), params: { path: ['unpublish'] }, request: request() });
    assert.equal(response.status, 200, await response.text());
    assert.equal((await readCanonical(bucket, 'community', id)).status, 'hidden');
    assert.deepEqual((await (await publicCommunity({ env: env(bucket) })).json()).entries, []);
  }
});
await test('canonical parse and storage I/O failures remain strict', async () => {
  const bucket = new Bucket();
  await bucket.seed(canonicalKey('community', id), '{', { schema: 'moderation-v1', status: 'approved', deleted: 'false' });
  await assert.rejects(() => ready(() => listCommunityRecords(env(bucket), 'approved')));
  const io = new Bucket(); await io.seed(`community/approved/${id}.json`, rec());
  io.get = async () => { throw new Error('synthetic I/O unavailable'); };
  await assert.rejects(() => ready(() => listCommunityRecords(env(io), 'approved')), /I\/O/);
});

class HistoryBucket extends Bucket {
  constructor(kind, count, status, deleted) {
    super(); this.kind = kind; this.historyReads = 0; this.historyLists = 0;
    this.directory = Array.from({ length: count }, (_, i) => ({
      key: `${kind}/records/00000000-0000-4000-8000-${String(i).padStart(12, '0')}.json`, etag: `h${i}`,
      customMetadata: { schema: 'moderation-v1', status, deleted: String(deleted) },
    }));
  }
  async get(key) { if (key.startsWith(`${this.kind}/records/`)) this.historyReads++; return super.get(key); }
  async list(options) {
    if (options.prefix !== `${this.kind}/records/`) return super.list(options);
    this.historyLists++;
    const start = Number(options.cursor || 0), page = this.directory.slice(start, start + (options.limit || 1000));
    return { objects: page, truncated: start + page.length < this.directory.length,
      ...(start + page.length < this.directory.length ? { cursor: String(start + page.length) } : {}) };
  }
}
for (const [kind, status, deleted] of [['feedback', 'ignored', true], ['community', 'deleted', true], ['feedback', 'resolved', false]]) {
  await test(`50001 retained ${kind}/${status} records do not cap an empty pending view`, async () => {
    const bucket = new HistoryBucket(kind, 50001, status, deleted);
    assert.equal((await ready(() => listRecordMetadata(bucket, kind, ['pending']))).length, 0);
    const initialScans = bucket.historyLists;
    for (let i = 0; i < 3; i++) assert.equal((await listRecordMetadata(bucket, kind, ['pending'])).length, 0);
    assert.equal(bucket.historyLists, initialScans, 'ready pending queries must not rescan lifetime canonical history');
    assert.equal(bucket.historyReads, 0, 'metadata preparation must not read historical bodies');
    assert.equal(bucket.directory.length, 50001, 'permanent history and tombstones are retained');
  });
}
await test('submission handlers and empty feedback admin recover after 50001 tombstones', async () => {
  const feedback = new HistoryBucket('feedback', 50001, 'ignored', true);
  const submitFeedback = () => feedbackSubmit({ env: { ...env(feedback), RATE_LIMIT_SALT: 'synthetic' }, waitUntil() {},
    request: new Request('https://synthetic.invalid/api/feedback', { method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' },
      body: JSON.stringify({ type: 'suggestion', description: 'synthetic sufficiently long description' }) }) });
  // 初始化可分批继续，503 期间不产生投稿正文或消耗来源限额。
  let response;
  for (let i = 0; i < 10; i++) { response = await submitFeedback(); if (response.status !== 503) break; }
  assert.equal(response.status, 201, await response.text());
  const empty = new HistoryBucket('feedback', 50001, 'ignored', true);
  const page = await ready(() => readAdminFeedbackList(empty, 'pending', 'synthetic-secret'));
  assert.equal(page.indexing, false); assert.equal(page.total, 0);
  const community = new HistoryBucket('community', 50001, 'deleted', true);
  for (let i = 0; i < 10; i++) {
    response = await communitySubmit({ env: env(community), request: new Request('https://synthetic.invalid/api/submit', { method: 'POST' }) });
    if (response.status !== 503) break;
  }
  // 无效表单应到达既有解析校验；不能再卡在历史容量预检。
  assert.equal(response.status, 400, await response.text());
});
await test('new canonical active views keep only current operation after transitions and tombstone', async () => {
  const bucket = new Bucket();
  let value = await ready(() => writeCanonical(bucket, 'feedback', id, null, { status: 'pending', record: { id, description: 'synthetic' } }));
  assert.equal((await listRecordMetadata(bucket, 'feedback', ['pending'])).length, 1);
  value = await writeCanonical(bucket, 'feedback', id, value, { status: 'resolved', record: { ...value.record, status: 'resolved' } });
  assert.equal((await listRecordMetadata(bucket, 'feedback', ['pending'])).length, 0);
  assert.equal((await listRecordMetadata(bucket, 'feedback', ['resolved'])).length, 1);
  await writeCanonical(bucket, 'feedback', id, value, { status: 'resolved', deleted: true });
  assert.equal((await listRecordMetadata(bucket, 'feedback', ['pending', 'resolved', 'ignored'])).length, 0);
  assert.equal((await readCanonical(bucket, 'feedback', id)).deleted, true);
});

await test('lost marker response confirms preparation and commits authority once', async () => {
  const bucket = new Bucket(); await requireRecordIndex(bucket, 'feedback');
  const put = bucket.put.bind(bucket); let commits = 0;
  bucket.put = async (key, ...args) => {
    if (key === canonicalKey('feedback', id)) commits++;
    const result = await put(key, ...args);
    if (key.startsWith('feedback/record-index/v1/')) throw new Error('marker response lost');
    return result;
  };
  const saved = await writeCanonical(bucket, 'feedback', id, null, { status: 'pending', record: { id } });
  assert.equal(saved.revision, 1); assert.equal(commits, 1);
});

await test('late preparation after an aborted request cannot hold pending capacity or admin list', async () => {
  const bucket = new Bucket(); await requireRecordIndex(bucket, 'feedback');
  const put = bucket.put.bind(bucket); let late, commits = 0;
  bucket.put = async (key, ...args) => {
    if (key === canonicalKey('feedback', id)) commits++;
    if (!late && key.startsWith('feedback/record-index/v1/')) {
      late = () => put(key, ...args); throw new Error('late preparation');
    }
    return put(key, ...args);
  };
  await assert.rejects(writeCanonical(bucket, 'feedback', id, null, { status: 'pending', record: { id } }), error => error.status === 503);
  assert.equal(commits, 0); await late();
  assert.equal(await countPendingRecords(bucket, 'feedback', 300), 0);
  const result = await readAdminFeedbackList(bucket, 'pending', 'synthetic-secret');
  assert.equal(result.indexing, false); assert.equal(result.total, 0); assert.deepEqual(result.items, []);
});

await test('50001 aborted late markers are reclaimed in bounded batches without deleting history', async () => {
  const bucket = new Bucket(); await requireRecordIndex(bucket, 'feedback');
  for (let i = 0; i < 50001; i++) {
    const operationId = `aborted-${String(i).padStart(6, '0')}`;
    await bucket.seed(`feedback/record-index/v1/pending/${operationId}/${id}.json`, '{}', {
      schema: 'moderation-index-v1', id, status: 'pending', operationId, revision: '1',
    });
    await bucket.seed(`feedback/record-index-aborted/v1/${operationId}.json`, '{}');
  }
  let heads = 0, maxHeads = 0;
  const head = bucket.head.bind(bucket);
  bucket.head = async key => { heads++; return head(key); };
  const rows = await ready(async () => {
    heads = 0;
    try { return await listRecordMetadata(bucket, 'feedback', ['pending']); }
    finally { maxHeads = Math.max(maxHeads, heads); }
  });
  assert.deepEqual(rows, []); assert.ok(maxHeads <= 400, `one recovery step used ${maxHeads} HEADs`);
  assert.equal(await countPendingRecords(bucket, 'feedback', 300), 0);
  assert.equal((await readAdminFeedbackList(bucket, 'pending', 'synthetic-secret')).total, 0);
  assert.equal([...bucket.objects.keys()].filter(key => key.startsWith('feedback/record-index-aborted/')).length, 50001);
});

for (const kind of ['feedback', 'community']) await test(`${kind} permanent delete retry finishes a failed marker cleanup`, async () => {
  const bucket = new Bucket();
  await writeCanonical(bucket, kind, id, null, { status: 'pending', record: { ...rec(), status: 'pending' } });
  const remove = bucket.delete.bind(bucket); let failed = false;
  bucket.delete = async keys => {
    if (!failed && (Array.isArray(keys) ? keys : [keys]).some(key => key.startsWith(`${kind}/record-index/v1/`))) {
      failed = true; throw new Error('one cleanup failure');
    }
    return remove(keys);
  };
  const action = () => {
    const context = { env: env(bucket), params: { path: ['purge'] }, request: new Request('https://synthetic.invalid/api/admin/test', {
      method: 'POST', headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, body: JSON.stringify({ id, status: 'pending' }),
    }) };
    return kind === 'feedback' ? deleteFeedback(context) : moderate(context);
  };
  assert.equal((await action()).status, 503);
  assert.equal((await readCanonical(bucket, kind, id)).deleted, true);
  assert.equal((await action()).status, 200);
  assert.equal([...bucket.objects.keys()].filter(key => key.startsWith(`${kind}/record-index/v1/`)).length, 0);
  assert.equal((await readCanonical(bucket, kind, id)).deleted, true);
});

await test('directory collection preserves current and unknown future operations without reading bodies', async () => {
  const bucket = new Bucket();
  const current = await writeCanonical(bucket, 'feedback', id, null, { status: 'pending', record: { id } });
  const future = await prepareRecordMarker(bucket, 'feedback', id, { status: 'pending', revision: 2, operationId: 'future-operation' });
  const stale = await prepareRecordMarker(bucket, 'feedback', id, { status: 'pending', revision: 1, operationId: 'lost-cas-operation' });
  let bodyReads = 0; const get = bucket.get.bind(bucket);
  bucket.get = async key => { if (key.startsWith('feedback/records/')) bodyReads++; return get(key); };
  await assert.rejects(maintainRecordIndex(bucket, 'feedback', 'pending', true), error => error.indexing);
  assert.equal(bucket.objects.has(stale), false);
  assert.equal(bucket.objects.has(future), true);
  assert.equal(bodyReads, 0);
  assert.equal((await readCanonical(bucket, 'feedback', id)).operationId, current.operationId);
  assert.equal([...bucket.objects.keys()].filter(key => key.startsWith('feedback/record-index/v1/')).length, 2);
});

await test('combined status budget resumes collection across all statuses before public rebuild', async () => {
  const bucket = new Bucket(); await requireRecordIndex(bucket, 'feedback');
  for (const status of ['pending', 'resolved', 'ignored']) for (let i = 0; i < 16667; i++) {
    const operationId = `aborted-${status}-${String(i).padStart(6, '0')}`;
    await bucket.seed(`feedback/record-index/v1/${status}/${operationId}/${id}.json`, '{}', {
      schema: 'moderation-index-v1', id, status, operationId, revision: '1',
    });
    await bucket.seed(`feedback/record-index-aborted/v1/${operationId}.json`, '{}');
  }
  let heads = 0, maxHeads = 0; const head = bucket.head.bind(bucket);
  bucket.head = async key => { heads++; return head(key); };
  const index = await ready(async () => {
    heads = 0;
    try { return await rebuildPublicFeedbackIndex(bucket); }
    finally { maxHeads = Math.max(maxHeads, heads); }
  });
  assert.deepEqual(index.items, []);
  assert.ok(maxHeads <= 400, `combined recovery used ${maxHeads} HEADs`);
  assert.equal([...bucket.objects.keys()].filter(key => key.startsWith('feedback/record-index/v1/')).length, 0);
});

console.log(JSON.stringify({ cases }, null, 2));
if (cases.some(x => x.status === 'FAIL')) process.exitCode = 1;
else console.log(`record store edges: PASS (${cases.length} cases)`);
