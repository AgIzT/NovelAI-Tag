// Deterministic R2 request interleavings; synthetic memory only, no network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { onRequestPost as communityAdmin } from '../functions/api/admin/community/[[path]].js';
import { onRequestPost as feedbackAdmin } from '../functions/api/admin/feedback-decide.js';
import { onRequestGet as communityPublic } from '../functions/api/community.js';
import { readCanonical, writeCanonical, listRecordMetadata } from '../functions/_record-store.js';
import { findCommunityRecord, rebuildCommunity } from '../functions/_lib.js';
import { readAdminFeedbackList } from '../functions/_feedback-list.js';
import { onRequestPost as feedbackDelete } from '../functions/api/admin/feedback-delete.js';
import { updatePublicFeedbackIndex, rebuildPublicFeedbackIndex } from '../functions/_feedback.js';

const clone = value => JSON.parse(JSON.stringify(value));
class Bucket {
  constructor() { this.items = new Map(); this.hook = null; this.operations = []; }
  seed(key, value, customMetadata) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    this.items.set(key, { text, customMetadata, etag: createHash('sha256').update(text).digest('hex') });
  }
  snapshot(key) {
    const data = this.items.get(key);
    if (!data) return null;
    return { key, etag: data.etag, customMetadata: data.customMetadata, size: Buffer.byteLength(data.text),
      json: async () => JSON.parse(data.text), text: async () => data.text };
  }
  async get(key) { if (this.hook) await this.hook('get', key); return this.snapshot(key); }
  async head(key) { return this.snapshot(key); }
  async list({ prefix = '' } = {}) {
    return { objects: [...this.items.keys()].filter(k => k.startsWith(prefix)).sort().map(key => this.snapshot(key)), truncated: false };
  }
  async put(key, value, options = {}) {
    if (this.hook) await this.hook('put', key, value, options);
    // The conditional check, final bytes and ETag commit are synchronous together.
    const previous = this.items.get(key);
    const condition = options.onlyIf;
    if (condition instanceof Headers && condition.get('if-none-match') === '*' && previous) return null;
    if (condition?.etagMatches && previous?.etag !== condition.etagMatches) return null;
    this.seed(key, value, options.customMetadata);
    this.operations.push({ op: 'put', key, conditional: !!condition });
    return this.snapshot(key);
  }
  async delete(key) {
    for (const item of Array.isArray(key) ? key : [key]) this.items.delete(item);
    this.operations.push({ op: 'delete', key });
  }
  read(key) { return this.items.has(key) ? JSON.parse(this.items.get(key).text) : null; }
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function gate(bucket, predicate) {
  const reached = deferred(), resume = deferred();
  bucket.hook = async (...args) => {
    if (!predicate(...args)) return;
    bucket.hook = null;
    reached.resolve();
    await resume.promise;
  };
  return { reached: reached.promise, resume: resume.resolve };
}
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const envFor = bucket => ({ STRINGS_BUCKET: bucket, STRINGS_PUBLIC_BASE: 'https://synthetic.invalid', ADMIN_TOKEN: 'audit-synthetic-token' });
const context = (env, route, body) => ({ env, params: { path: [route] }, request: new Request('https://synthetic.invalid/api/admin/' + route, {
  method: 'POST', headers: { authorization: 'Bearer audit-synthetic-token', 'content-type': 'application/json' }, body: JSON.stringify(body),
}) });
const results = [];
async function run(name, perform) {
  try {
    const evidence = await perform();
    results.push({ name, status: evidence.invariant ? 'PASS' : 'FAIL', ...evidence });
  } catch (error) { results.push({ name, status: 'FAIL', invariant: false, error: error.stack }); }
}

await run('community edit arriving after successful unpublish must not republish', async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  bucket.seed(`community/approved/${id}.json`, { id, status: 'approved', prompt: 'synthetic original', title: 'synthetic', images: [], createdAt: 1 });
  const hold = gate(bucket, (op, key, value) => op === 'put' && [ `community/approved/${id}.json`, `community/records/${id}.json` ].includes(key) && (JSON.parse(value).record || JSON.parse(value)).prompt === 'synthetic stale edit');
  const editing = communityAdmin(context(env, 'update', { id, status: 'approved', edits: { prompt: 'synthetic stale edit' } }));
  await hold.reached;
  const hidden = await communityAdmin(context(env, 'unpublish', { id }));
  assert.equal(hidden.status, 200);
  const afterUnpublish = await (await communityPublic({ env })).json();
  assert.equal(afterUnpublish.entries.length, 0);
  hold.resume();
  const edited = await editing;
  const final = await (await communityPublic({ env })).json();
  return { invariant: final.entries.length === 0 && edited.status === 409,
    responses: { unpublish: hidden.status, staleEdit: edited.status },
    afterUnpublishIds: afterUnpublish.entries.map(x => x.id), finalPublicIds: final.entries.map(x => x.id),
    storedStates: ['approved', 'hidden'].filter(status => bucket.read(`community/${status}/${id}.json`)),
    operations: bucket.operations };
});

await run('feedback stale public projection must not undo a completed withdrawal', async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  const key = `feedback/pending/2026/10/${id}.json`;
  const record = { id, status: 'pending', progressStatus: 'unread', publicVisible: true, description: 'synthetic public feedback', createdAt: 1 };
  bucket.seed(key, record);
  await updatePublicFeedbackIndex(bucket, { upsertRecord: record, upsertStatus: 'pending' });
  const hold = gate(bucket, (op, objectKey) => op === 'get' && objectKey === 'feedback/public.json');
  const editing = feedbackAdmin(context(env, 'feedback-decide', { id, sourceStatus: 'pending', adminReply: 'synthetic stale reply' }));
  await hold.reached;
  const withdrawal = await feedbackAdmin(context(env, 'feedback-decide', { id, sourceStatus: 'pending', publicVisible: false }));
  assert.equal(withdrawal.status, 200);
  assert.equal(bucket.read('feedback/public.json').items.length, 0);
  hold.resume();
  const edited = await editing;
  assert.equal(edited.status, 200);
  const final = bucket.read('feedback/public.json');
  return { invariant: final.items.length === 0,
    responses: { withdrawal: withdrawal.status, staleEdit: edited.status },
    sourcePublicVisible: (bucket.read(`feedback/records/${id}.json`)?.record || bucket.read(key))?.publicVisible,
    finalPublicIds: final.items.map(x => x.id), operations: bucket.operations };
});

await run('first feedback index creation must preserve concurrent distinct upserts', async () => {
  const bucket = new Bucket();
  const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const rec = value => ({ id: value, status: 'pending', progressStatus: 'unread', publicVisible: true, description: 'synthetic', createdAt: 1 });
  bucket.seed(`feedback/pending/2026/10/${id}.json`, rec(id));
  bucket.seed(`feedback/pending/2026/10/${other}.json`, rec(other));
  const hold = gate(bucket, (op, key) => op === 'put' && key === 'feedback/public.json');
  const first = updatePublicFeedbackIndex(bucket, { upsertRecord: rec(id), upsertStatus: 'pending' });
  await hold.reached;
  await updatePublicFeedbackIndex(bucket, { upsertRecord: rec(other), upsertStatus: 'pending' });
  hold.resume();
  await first;
  const final = bucket.read('feedback/public.json');
  return { invariant: final.items.length === 2, expectedIds: [id, other],
    finalPublicIds: final.items.map(x => x.id), operations: bucket.operations };
});

const feedbackRecord = (extra = {}) => ({ id, status: 'pending', progressStatus: 'unread', publicVisible: true, description: 'synthetic', contact: 'private-contact', createdAt: 1, ...extra });
const communityRecord = (extra = {}) => ({ id, status: 'approved', prompt: 'synthetic', images: [], createdAt: 1, ...extra });
const publicIds = bucket => bucket.read('feedback/public.json').items.map(item => item.id).sort();
async function checked(name, perform) { await run(name, async () => { await perform(); return { invariant: true }; }); }

await checked('canonical community stale edit conflicts after unpublish', async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  await writeCanonical(bucket, 'community', id, null, { status: 'approved', record: communityRecord() });
  const hold = gate(bucket, (op, key, value) => op === 'put' && key === `community/records/${id}.json` && JSON.parse(value).record?.prompt === 'old-edit');
  const editing = communityAdmin(context(env, 'update', { id, edits: { prompt: 'old-edit' } }));
  await hold.reached;
  assert.equal((await communityAdmin(context(env, 'unpublish', { id }))).status, 200);
  hold.resume();
  assert.equal((await editing).status, 409);
  assert.equal((await readCanonical(bucket, 'community', id)).status, 'hidden');
  assert.equal(bucket.read('community/community.json').entries.length, 0);
});

await checked('competing first migration approve versus reject has one winner', async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  bucket.seed(`community/pending/${id}.json`, communityRecord({ status: 'pending' }));
  const hold = gate(bucket, (op, key, value) => op === 'put' && key.includes('/records/') && JSON.parse(value).status === 'approved');
  const approval = communityAdmin(context(env, 'approve', { id }));
  await hold.reached;
  assert.equal((await communityAdmin(context(env, 'reject', { id }))).status, 200);
  hold.resume();
  assert.equal((await approval).status, 409);
  assert.equal(await findCommunityRecord(env, id, ['pending', 'approved']), null);
  assert.equal((await findCommunityRecord(env, id, ['rejected'])).status, 'rejected');
});

await checked('feedback stale source edit cannot undo withdrawal', async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  await writeCanonical(bucket, 'feedback', id, null, { status: 'pending', record: feedbackRecord() });
  await updatePublicFeedbackIndex(bucket, { upsertRecord: { id } });
  const hold = gate(bucket, (op, key, value) => op === 'put' && key.includes('/records/') && JSON.parse(value).record?.adminReply === 'old-reply');
  const editing = feedbackAdmin(context(env, '', { id, adminReply: 'old-reply' }));
  await hold.reached;
  assert.equal((await feedbackAdmin(context(env, '', { id, publicVisible: false }))).status, 200);
  hold.resume();
  assert.equal((await editing).status, 409);
  assert.deepEqual(publicIds(bucket), []);
});

await checked('feedback delete fences a paused source writer and removes private legacy copies', async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  bucket.seed(`feedback/pending/2026/10/${id}.json`, feedbackRecord());
  const hold = gate(bucket, (op, key, value) => op === 'put' && key.includes('/records/') && JSON.parse(value).record?.adminReply === 'old-reply');
  const editing = feedbackAdmin(context(env, '', { id, adminReply: 'old-reply' }));
  await hold.reached;
  assert.equal((await feedbackDelete(context(env, '', { id, status: 'pending' }))).status, 200);
  hold.resume();
  assert.equal((await editing).status, 409);
  const tombstone = bucket.read(`feedback/records/${id}.json`);
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.record, undefined);
  assert.doesNotMatch(JSON.stringify([...bucket.items]), /private-contact/);
  assert.deepEqual(publicIds(bucket), []);
});

await checked('failed feedback legacy cleanup retries without restoring deleted content', async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  bucket.seed(`feedback/pending/2026/10/${id}.json`, feedbackRecord());
  const originalDelete = bucket.delete.bind(bucket);
  let failed = false;
  bucket.delete = async keys => { if (!failed) { failed = true; throw new Error('injected cleanup'); } return originalDelete(keys); };
  assert.equal((await feedbackDelete(context(env, '', { id, status: 'pending' }))).status, 503);
  assert.equal((await readCanonical(bucket, 'feedback', id)).deleted, true);
  assert.deepEqual((await readAdminFeedbackList(bucket, 'pending', 'test')).items, []);
  assert.equal((await feedbackDelete(context(env, '', { id, status: 'pending' }))).status, 200);
  assert.doesNotMatch(JSON.stringify([...bucket.items]), /private-contact/);
});

await checked('community purge fences old edit and permits failed media cleanup retry', async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  bucket.seed(`community/approved/${id}.json`, communityRecord());
  bucket.seed(`community/img/${id}/1.jpg`, 'synthetic-media');
  const hold = gate(bucket, (op, key, value) => op === 'put' && key.includes('/records/') && JSON.parse(value).record?.prompt === 'old-edit');
  const editing = communityAdmin(context(env, 'update', { id, edits: { prompt: 'old-edit' } }));
  await hold.reached;
  const originalDelete = bucket.delete.bind(bucket);
  let failed = false;
  bucket.delete = async keys => { if (!failed) { failed = true; throw new Error('injected cleanup'); } return originalDelete(keys); };
  assert.equal((await communityAdmin(context(env, 'purge', { id }))).status, 503);
  hold.resume();
  assert.equal((await editing).status, 409);
  assert.equal((await readCanonical(bucket, 'community', id)).deleted, true);
  assert.equal(bucket.read('community/community.json').entries.length, 0);
  assert.equal((await communityAdmin(context(env, 'purge', { id }))).status, 200);
  assert.equal(bucket.items.has(`community/approved/${id}.json`), false);
  assert.equal(bucket.items.has(`community/img/${id}/1.jpg`), false);
  assert.equal(bucket.read(`community/records/${id}.json`).record, undefined);
});

await checked('unpublish retry repairs a previously failed public projection', async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  bucket.seed(`community/approved/${id}.json`, communityRecord());
  await rebuildCommunity(env);
  bucket.hook = async (op, key) => { if (op === 'put' && key === 'community/community.json') throw Object.assign(new Error('index unavailable'), { status: 503 }); };
  assert.equal((await communityAdmin(context(env, 'unpublish', { id }))).status, 503);
  bucket.hook = null;
  assert.equal((await communityAdmin(context(env, 'unpublish', { id }))).status, 200);
  assert.equal(bucket.read('community/community.json').entries.length, 0);
});

await checked('unknown put confirmed by operationId does not submit twice', async () => {
  const bucket = new Bucket();
  const originalPut = bucket.put.bind(bucket);
  let puts = 0;
  bucket.put = async (...args) => { puts++; await originalPut(...args); throw new Error('response lost'); };
  const saved = await writeCanonical(bucket, 'feedback', id, null, { status: 'pending', record: feedbackRecord() });
  assert.equal(saved.revision, 1);
  assert.equal(puts, 1);
  assert.equal(saved.operationId, bucket.read(`feedback/records/${id}.json`).operationId);
});

await checked('unknown late first create cannot overwrite a competing committed canonical', async () => {
  const bucket = new Bucket();
  let late;
  bucket.hook = async (op, key, value, options) => {
    if (op === 'put') { bucket.hook = null; late = () => bucket.put(key, value, options); throw new Error('unknown pending write'); }
  };
  await assert.rejects(writeCanonical(bucket, 'feedback', id, null, { status: 'pending', record: feedbackRecord({ description: 'old' }) }), error => error.status === 503);
  const winner = await writeCanonical(bucket, 'feedback', id, null, { status: 'pending', record: feedbackRecord({ description: 'winner' }) });
  assert.equal(await late(), null);
  assert.equal((await readCanonical(bucket, 'feedback', id)).operationId, winner.operationId);
});

await checked('unknown stale update cannot overwrite a newer tombstone even if it commits later', async () => {
  const bucket = new Bucket();
  const current = await writeCanonical(bucket, 'feedback', id, null, { status: 'pending', record: feedbackRecord() });
  let late;
  bucket.hook = async (op, key, value, options) => { if (op === 'put') { bucket.hook = null; late = () => bucket.put(key, value, options); throw new Error('lost'); } };
  await assert.rejects(writeCanonical(bucket, 'feedback', id, current, { status: 'pending', record: feedbackRecord({ description: 'old' }) }), error => error.status === 503);
  await writeCanonical(bucket, 'feedback', id, current, { status: 'pending', deleted: true });
  assert.equal(await late(), null);
  assert.equal((await readCanonical(bucket, 'feedback', id)).deleted, true);
});

await checked('unreadable canonical fails closed instead of falling back to public legacy', async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  bucket.seed(`community/approved/${id}.json`, communityRecord());
  bucket.seed(`community/records/${id}.json`, { version: 999, id });
  await assert.rejects(findCommunityRecord(env, id, ['approved']), error => error.status === 503);
  for (const fields of [{ status: 'invalid' }, { record: [] }]) {
    bucket.seed(`feedback/records/${id}.json`, { version: 1, id, revision: 1, operationId: 'test', status: 'pending', deleted: false, record: feedbackRecord(), ...fields });
    await assert.rejects(readCanonical(bucket, 'feedback', id), error => error.status === 503);
  }
});

await checked('canonical metadata suppresses all legacy statuses and tombstones in counts', async () => {
  const bucket = new Bucket();
  bucket.seed(`feedback/pending/2026/10/${id}.json`, feedbackRecord());
  await writeCanonical(bucket, 'feedback', id, null, { status: 'resolved', record: feedbackRecord({ status: 'resolved' }) });
  assert.equal((await listRecordMetadata(bucket, 'feedback', ['pending'])).length, 0);
  assert.equal((await listRecordMetadata(bucket, 'feedback', ['resolved'])).length, 1);
  const current = await readCanonical(bucket, 'feedback', id);
  await writeCanonical(bucket, 'feedback', id, current, { status: 'resolved', deleted: true });
  assert.equal((await listRecordMetadata(bucket, 'feedback', ['pending', 'resolved', 'ignored'])).length, 0);
});

for (const operation of ['upsert', 'rebuild']) await checked(`feedback ${operation} snapshot cannot defeat a completed withdrawal at index CAS`, async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  await writeCanonical(bucket, 'feedback', id, null, { status: 'pending', record: feedbackRecord() });
  await updatePublicFeedbackIndex(bucket, { upsertRecord: { id } });
  const hold = gate(bucket, (op, key) => op === 'put' && key === 'feedback/public.json');
  const projection = operation === 'upsert' ? updatePublicFeedbackIndex(bucket, { upsertRecord: { id } }) : rebuildPublicFeedbackIndex(bucket);
  await hold.reached;
  assert.equal((await feedbackAdmin(context(env, '', { id, publicVisible: false }))).status, 200);
  hold.resume();
  await projection;
  assert.deepEqual(publicIds(bucket), []);
});

await checked('feedback UUID revisions prevent identical-byte ABA with a frozen clock', async () => {
  const bucket = new Bucket();
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [1_800_000_000_000])); }
    static now() { return 1_800_000_000_000; }
  };
  try {
    const first = await updatePublicFeedbackIndex(bucket);
    const firstEtag = (await bucket.head('feedback/public.json')).etag;
    const second = await updatePublicFeedbackIndex(bucket);
    assert.equal(first.updatedAt, second.updatedAt);
    assert.notEqual(first.revision, second.revision);
    assert.notEqual((await bucket.head('feedback/public.json')).etag, firstEtag);
    assert.equal(await bucket.put('feedback/public.json', JSON.stringify(first), { onlyIf: { etagMatches: firstEtag } }), null);
  } finally { globalThis.Date = RealDate; }
});

await checked('unknown put with unavailable confirmation remains 503 and is never replayed', async () => {
  const bucket = new Bucket();
  let puts = 0;
  bucket.put = async () => { puts++; throw new Error('put unavailable'); };
  bucket.get = async () => { throw new Error('get unavailable'); };
  await assert.rejects(writeCanonical(bucket, 'feedback', id, null, { status: 'pending', record: feedbackRecord() }), error => error.status === 503);
  assert.equal(puts, 1);
});

// Review regressions: old move leftovers and projection-only recovery.
await checked('legacy duplicate rebuild keeps the newest public reply before applying the 200 limit', async () => {
  const bucket = new Bucket();
  bucket.seed(`feedback/pending/2026/10/${id}.json`, feedbackRecord({ adminReply: 'old reply', replyUpdatedAt: 1 }));
  bucket.seed(`feedback/resolved/2026/10/${id}.json`, feedbackRecord({ status: 'resolved', progressStatus: 'completed', adminReply: 'new reply', replyUpdatedAt: 10 }));
  // 199 个其它 ID 加上这一重复 ID：必须先去重，否则两个副本挤掉第 200 个唯一项。
  for (let i = 0; i < 199; i++) {
    const other = (0x10000000 + i).toString(16);
    bucket.seed(`feedback/pending/2026/10/${other}.json`, feedbackRecord({ id: other }));
  }
  const index = await rebuildPublicFeedbackIndex(bucket);
  assert.equal(index.items.length, 200);
  assert.equal(new Set(index.items.map(item => item.id)).size, 200);
  assert.equal(index.items[0].adminReply, 'new reply');
  assert.equal(index.items[0].progressStatus, 'completed');
  // Canonical wins regardless of a legacy copy's timestamp, including private/tombstone.
  await writeCanonical(bucket, 'feedback', id, null, { status: 'pending', record: feedbackRecord({ adminReply: 'canonical reply', replyUpdatedAt: 2 }) });
  assert.equal((await rebuildPublicFeedbackIndex(bucket)).items[0].adminReply, 'canonical reply');
  const current = await readCanonical(bucket, 'feedback', id);
  await writeCanonical(bucket, 'feedback', id, current, { status: 'pending', deleted: true });
  const afterDelete = await rebuildPublicFeedbackIndex(bucket);
  assert.equal(afterDelete.items.length, 199);
  assert.equal(afterDelete.items.some(item => item.id === id), false);
});

await checked('legacy same-status copies retain prior count semantics without exceeding the admin body budget', async () => {
  const bucket = new Bucket();
  for (let i = 1; i <= 201; i++) bucket.seed(`feedback/pending/2026/${String(i).padStart(3, '0')}/${id}.json`, feedbackRecord({ createdAt: i }));
  let bodyReads = 0;
  const get = bucket.get.bind(bucket);
  bucket.get = async key => { if (key.startsWith('feedback/pending/')) bodyReads++; return get(key); };
  assert.equal((await listRecordMetadata(bucket, 'feedback', ['pending'])).length, 201);
  let result;
  for (let attempt = 0; attempt < 4; attempt++) {
    bodyReads = 0;
    result = await readAdminFeedbackList(bucket, 'pending', 'synthetic-secret');
    assert.ok(bodyReads <= 200, `read ${bodyReads} record bodies`);
    if (!result.indexing) break;
  }
  assert.equal(result.indexing, false);
  assert.equal(result.items.length, 200);
  assert.equal(result.items[0].createdAt, 201);
  assert.equal(result.items.at(-1).createdAt, 2);
  await writeCanonical(bucket, 'feedback', id, null, { status: 'resolved', record: feedbackRecord({ status: 'resolved' }) });
  assert.equal((await listRecordMetadata(bucket, 'feedback', ['pending'])).length, 0);
  assert.equal((await listRecordMetadata(bucket, 'feedback', ['resolved'])).length, 1);
});

await checked('soft-delete retry repairs the projection without replaying the old request', async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  bucket.seed(`community/approved/${id}.json`, communityRecord());
  await rebuildCommunity(env);
  const body = { id, status: 'approved' };
  bucket.hook = async (op, key) => { if (op === 'put' && key === 'community/community.json') throw new Error('index unavailable'); };
  assert.equal((await communityAdmin(context(env, 'delete', body))).status, 503);
  const saved = clone(bucket.read(`community/records/${id}.json`));
  assert.equal(saved.status, 'deleted');
  assert.equal(bucket.read('community/community.json').entries.length, 1);
  bucket.hook = null;
  assert.equal((await communityAdmin(context(env, 'delete', body))).status, 409);
  assert.deepEqual(bucket.read(`community/records/${id}.json`), saved);
  assert.equal(bucket.read('community/community.json').entries.length, 0);
});

await checked('feedback withdrawal and status-move retry repairs only the public projection', async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  bucket.seed(`feedback/pending/2026/10/${id}.json`, feedbackRecord());
  await rebuildPublicFeedbackIndex(bucket);
  const body = { id, sourceStatus: 'pending', progressStatus: 'completed', publicVisible: false, adminReply: 'original reply' };
  bucket.hook = async (op, key) => { if (op === 'put' && key === 'feedback/public.json') throw new Error('index unavailable'); };
  assert.equal((await feedbackAdmin(context(env, '', body))).status, 503);
  const saved = clone(bucket.read(`feedback/records/${id}.json`));
  assert.equal(saved.status, 'resolved');
  assert.equal(saved.record.publicVisible, false);
  assert.equal(publicIds(bucket).length, 1);
  bucket.hook = null;
  assert.equal((await feedbackAdmin(context(env, '', body))).status, 409);
  assert.deepEqual(bucket.read(`feedback/records/${id}.json`), saved);
  assert.deepEqual(publicIds(bucket), []);
});

await checked('mismatched community request cannot overwrite a newer hidden record while repairing projection', async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  bucket.seed(`community/approved/${id}.json`, communityRecord());
  await rebuildCommunity(env);
  await writeCanonical(bucket, 'community', id, null, { status: 'hidden', record: communityRecord({ status: 'hidden', prompt: 'new prompt' }) });
  const saved = clone(bucket.read(`community/records/${id}.json`));
  assert.equal((await communityAdmin(context(env, 'update', { id, status: 'approved', edits: { prompt: 'old prompt' } }))).status, 409);
  assert.deepEqual(bucket.read(`community/records/${id}.json`), saved);
  assert.equal(bucket.read('community/community.json').entries.length, 0);
});

await checked('mismatched feedback request cannot publish or overwrite newer reply while repairing projection', async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  bucket.seed(`feedback/pending/2026/10/${id}.json`, feedbackRecord());
  await rebuildPublicFeedbackIndex(bucket);
  await writeCanonical(bucket, 'feedback', id, null, { status: 'resolved', record: feedbackRecord({ status: 'resolved', progressStatus: 'completed', publicVisible: false, adminReply: 'new reply' }) });
  const saved = clone(bucket.read(`feedback/records/${id}.json`));
  const body = { id, sourceStatus: 'pending', progressStatus: 'unread', publicVisible: true, adminReply: 'old reply' };
  bucket.hook = async (op, key) => { if (op === 'put' && key === 'feedback/public.json') throw new Error('index still unavailable'); };
  assert.equal((await feedbackAdmin(context(env, '', body))).status, 503);
  assert.deepEqual(bucket.read(`feedback/records/${id}.json`), saved);
  bucket.hook = null;
  assert.equal((await feedbackAdmin(context(env, '', body))).status, 409);
  assert.deepEqual(bucket.read(`feedback/records/${id}.json`), saved);
  assert.deepEqual(publicIds(bucket), []);
});

await checked('batch soft-delete retry reports conflicts while repairing all committed projections', async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  const ids = [id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
  for (const entryId of ids) bucket.seed(`community/approved/${entryId}.json`, communityRecord({ id: entryId }));
  await rebuildCommunity(env);
  const body = { action: 'delete', ids, status: 'approved' };
  bucket.hook = async (op, key) => { if (op === 'put' && key === 'community/community.json') throw new Error('index unavailable'); };
  assert.equal((await communityAdmin(context(env, 'batch', body))).status, 503);
  const saved = ids.map(entryId => clone(bucket.read(`community/records/${entryId}.json`)));
  assert.ok(saved.every(item => item.status === 'deleted'));
  // 整批最终投影失败必须整体503；不能先返回“已同步”的逐项结果。
  const failedRepair = await communityAdmin(context(env, 'batch', body));
  const failure = await failedRepair.json();
  assert.equal(failedRepair.status, 503);
  assert.equal(failure.ok, false);
  assert.equal(failure.changed, undefined);
  assert.equal(failure.failed, undefined);
  bucket.hook = null;
  const response = await communityAdmin(context(env, 'batch', body));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.changed, 0);
  assert.equal(result.failed.length, ids.length);
  assert.ok(result.failed.every(item => item.status === 409));
  assert.deepEqual(ids.map(entryId => bucket.read(`community/records/${entryId}.json`)), saved);
  assert.equal(bucket.read('community/community.json').entries.length, 0);
});

await checked('legacy duplicate rebuild CAS retry observes a new private canonical', async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  bucket.seed(`feedback/pending/2026/10/${id}.json`, feedbackRecord({ replyUpdatedAt: 1 }));
  bucket.seed(`feedback/resolved/2026/10/${id}.json`, feedbackRecord({ status: 'resolved', progressStatus: 'completed', adminReply: 'new reply', replyUpdatedAt: 10 }));
  const hold = gate(bucket, (op, key) => op === 'put' && key === 'feedback/public.json');
  const rebuilding = rebuildPublicFeedbackIndex(bucket);
  await hold.reached;
  assert.equal((await feedbackAdmin(context(env, '', { id, sourceStatus: 'pending', publicVisible: false }))).status, 200);
  hold.resume();
  await rebuilding;
  assert.deepEqual(publicIds(bucket), []);
});

for (const count of [1, 10, 50]) await checked(`batch projection repair K=${count} performs one rebuild with bounded record reads`, async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  const ids = Array.from({ length: count }, (_, i) => (0x10000000 + i).toString(16));
  for (let i = 0; i < 20; i++) {
    const entryId = (0x20000000 + i).toString(16);
    await writeCanonical(bucket, 'community', entryId, null, { status: 'approved', record: communityRecord({ id: entryId }) });
  }
  for (const entryId of ids) await writeCanonical(bucket, 'community', entryId, null, { status: 'approved', record: communityRecord({ id: entryId }) });
  await rebuildCommunity(env);
  for (const entryId of ids) {
    const current = await readCanonical(bucket, 'community', entryId);
    await writeCanonical(bucket, 'community', entryId, current, { status: 'deleted', record: { ...current.record, status: 'deleted' } });
  }
  const saved = ids.map(entryId => clone(bucket.read(`community/records/${entryId}.json`)));
  const get = bucket.get.bind(bucket), put = bucket.put.bind(bucket);
  let recordReads = 0, indexWrites = 0;
  bucket.get = async key => { if (key.startsWith('community/records/')) recordReads++; return get(key); };
  bucket.put = async (key, ...args) => { if (key === 'community/community.json') indexWrites++; return put(key, ...args); };
  const response = await communityAdmin(context(env, 'batch', { action: 'delete', ids, status: 'approved' }));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.changed, 0);
  assert.equal(result.failed.length, count);
  assert.ok(result.failed.every(item => item.status === 409));
  assert.deepEqual(ids.map(entryId => bucket.read(`community/records/${entryId}.json`)), saved);
  assert.equal(bucket.read('community/community.json').entries.length, 20);
  assert.equal(indexWrites, 1, `K=${count} wrote the aggregate ${indexWrites} times`);
  assert.ok(recordReads <= 20 + 2 * count, `K=${count} read ${recordReads} canonical bodies`);
});

await checked('mixed batch shares one final rebuild between successful mutations and stale-source repairs', async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  const active = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  for (const entryId of [id, active]) bucket.seed(`community/approved/${entryId}.json`, communityRecord({ id: entryId }));
  await rebuildCommunity(env);
  await writeCanonical(bucket, 'community', id, null, { status: 'deleted', record: communityRecord({ status: 'deleted' }) });
  const saved = clone(bucket.read(`community/records/${id}.json`));
  let indexWrites = 0;
  const put = bucket.put.bind(bucket);
  bucket.put = async (key, ...args) => { if (key === 'community/community.json') indexWrites++; return put(key, ...args); };
  const response = await communityAdmin(context(env, 'batch', { action: 'delete', ids: [id, active, 'cccccccc'], status: 'approved' }));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.changed, 1);
  assert.deepEqual(result.failed.map(item => item.status), [409, 404]);
  assert.deepEqual(bucket.read(`community/records/${id}.json`), saved);
  assert.equal(bucket.read('community/community.json').entries.length, 0);
  assert.equal(indexWrites, 1);
});

await checked('batch stale-source repair exhausting index CAS fails the whole response after one bounded rebuild', async () => {
  const bucket = new Bucket(), env = envFor(bucket);
  const ids = Array.from({ length: 10 }, (_, i) => (0x30000000 + i).toString(16));
  for (const entryId of ids) await writeCanonical(bucket, 'community', entryId, null, { status: 'deleted', record: communityRecord({ id: entryId, status: 'deleted' }) });
  const saved = ids.map(entryId => clone(bucket.read(`community/records/${entryId}.json`)));
  const put = bucket.put.bind(bucket);
  let attempts = 0;
  bucket.put = async (key, ...args) => { if (key === 'community/community.json') { attempts++; return null; } return put(key, ...args); };
  const response = await communityAdmin(context(env, 'batch', { action: 'delete', ids, status: 'approved' }));
  const result = await response.json();
  assert.equal(response.status, 503);
  assert.equal(result.ok, false);
  assert.equal(result.failed, undefined);
  assert.equal(result.changed, undefined);
  assert.equal(attempts, 3, 'the batch shares one rebuild with its existing three CAS attempts');
  assert.deepEqual(ids.map(entryId => bucket.read(`community/records/${entryId}.json`)), saved);
});

for (const result of results) console.log(`${result.status}: ${result.name}`);
if (results.some(result => !result.invariant)) { console.log(JSON.stringify(results, null, 2)); process.exitCode = 1; }
else console.log('moderation concurrency tests: PASS');
