// Deterministic aggregate interleavings; memory only, no credentials or network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MemoryR2 } from './memory-r2-test-harness.mjs';
import { rebuildCommunity, moveCommunityRecord, emptyCollection, findCommunityRecord } from '../functions/_lib.js';
import { onRequestPost as adminPost } from '../functions/api/admin/community/[[path]].js';
import { onRequestGet as communityGet } from '../functions/api/community.js';

const KEY = 'community/community.json';
const ID = 'a0000001';
const NEW_ID = 'b0000002';
const FIXED_TIME = 1_800_000_000_000;

class AggregateR2 extends MemoryR2 {
  aggregateAttempts = 0;
  beforeAggregatePut = null;
  pageSize = 1000;
  async put(key, value, options = {}) {
    if (key === KEY) {
      this.aggregateAttempts += 1;
      if (this.beforeAggregatePut) await this.beforeAggregatePut();
    }
    return super.put(key, value, options);
  }
  createEtag(raw) {
    // R2 ETags can repeat for identical bytes. Version counters hide this edge.
    return createHash('md5').update(raw).digest('hex');
  }
  async list({ prefix, cursor }) {
    this.listCalls += 1;
    const keys = [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort();
    const start = Number(cursor || 0);
    const next = start + this.pageSize;
    return {
      objects: keys.slice(start, next).map(key => ({ key, etag: this.etags.get(key), customMetadata: this.customMetas.get(key) })),
      truncated: next < keys.length,
      cursor: next < keys.length ? String(next) : undefined,
    };
  }
}

function fixture() {
  const bucket = new AggregateR2();
  return { bucket, env: { STRINGS_BUCKET: bucket, STRINGS_PUBLIC_BASE: 'https://cdn.example.test', ADMIN_TOKEN: 'test-only-token' } };
}

function record(id = ID, status = 'approved') {
  return { id, status, title: `title-${id}`, prompt: 'test', category: ['画风'], images: [], createdAt: 100 };
}

async function seed(bucket, id = ID, status = 'approved') {
  await bucket.put(`community/${status}/${id}.json`, JSON.stringify(record(id, status)));
}

function admin(env, action, body) {
  return adminPost({
    env, params: { path: [action] },
    request: new Request(`https://example.test/api/admin/community/${action}`, {
      method: 'POST', headers: { authorization: 'Bearer test-only-token', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
}

async function publicIds(env) {
  const response = await communityGet({ env, request: new Request('https://example.test/api/community') });
  assert.equal(response.status, 200);
  return (await response.json()).entries.map(entry => entry.id).sort();
}

function pauseOnce(bucket, phase) {
  let entered, release;
  let used = false;
  const arrived = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const pause = async () => {
    if (used) return;
    used = true;
    entered();
    await wait;
  };
  if (phase === 'read') bucket.afterGet = key => key === `community/approved/${ID}.json` ? pause() : undefined;
  else bucket.beforeAggregatePut = pause;
  return { arrived, release };
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('controlled interleaving did not reach barrier')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

async function staleWriter({ initial = 'populated', phase = 'put', approve = false } = {}) {
  const { bucket, env } = fixture();
  if (initial === 'empty') await rebuildCommunity(env);
  await seed(bucket);
  if (initial === 'populated') await rebuildCommunity(env);
  if (approve) await seed(bucket, NEW_ID, 'pending');
  const gate = pauseOnce(bucket, phase);
  const older = (approve ? admin(env, 'approve', { id: NEW_ID }) : rebuildCommunity(env))
    .then(value => ({ value }), error => ({ error }));
  try {
    await bounded(gate.arrived);
    const hidden = await admin(env, 'unpublish', { id: ID });
    assert.equal(hidden.status, 200, JSON.stringify(await hidden.json()));
    assert.deepEqual(await publicIds(env), approve ? [NEW_ID] : [], 'unpublish must have completed first');
  } finally { gate.release(); }
  const completed = await bounded(older);
  if (completed.error) throw completed.error;
  if (approve) assert.equal(completed.value.status, 200);
  assert.deepEqual(await publicIds(env), approve ? [NEW_ID] : [], 'stale aggregate resurrected the hidden entry');
  assert.equal(!!await findCommunityRecord(env, ID, ['approved']), false);
  assert.equal(!!await findCommunityRecord(env, ID, ['hidden']), true);
}

function installConflicts(bucket, count = Infinity) {
  let conflicts = 0;
  bucket.beforeAggregatePut = async () => {
    if (conflicts++ >= count) return;
    // Another writer commits before the attempted conditional write.
    await MemoryR2.prototype.put.call(bucket, KEY, JSON.stringify({ ...emptyCollection(), revision: `rival-${conflicts}` }));
  };
}

const cases = [
  ['one commit never exposes an intermediate ETag', async () => {
    const bucket = new AggregateR2();
    const [written, observed] = await Promise.all([
      bucket.put('etag-atomicity', 'content'),
      bucket.head('etag-atomicity'),
    ]);
    assert.equal(observed.etag, written.etag, 'head saw an intermediate ETag without another write');
    assert.equal((await bucket.head('etag-atomicity')).etag, written.etag);
  }],
  ['older aggregate cannot undo successful unpublish', () => staleWriter()],
  ['concurrent first creation cannot undo unpublish', () => staleWriter({ initial: 'absent' })],
  ['version must be read before record snapshot', () => staleWriter({ phase: 'read' })],
  ['concurrent approval survives while a different entry is hidden', () => staleWriter({ approve: true })],
  ['identical aggregate bytes at the same millisecond cannot bypass the guard', async () => {
    const originalNow = Date.now;
    Date.now = () => FIXED_TIME;
    try { await staleWriter({ initial: 'empty' }); }
    finally { Date.now = originalNow; }
  }],
  ['conflict retry reloads records and includes later changes', async () => {
    const { bucket, env } = fixture();
    await seed(bucket);
    await rebuildCommunity(env);
    let conflicts = 0;
    bucket.beforeAggregatePut = async () => {
      if (conflicts++ >= 2) return;
      await bucket.delete(`community/approved/${ID}.json`);
      await seed(bucket, NEW_ID);
      await MemoryR2.prototype.put.call(bucket, KEY, JSON.stringify({ ...emptyCollection(), revision: `rival-${conflicts}` }));
    };
    bucket.aggregateAttempts = 0;
    const data = await rebuildCommunity(env);
    assert.deepEqual(data.entries.map(entry => entry.id), [NEW_ID]);
    assert.equal(bucket.aggregateAttempts, 3);
    assert.deepEqual(await publicIds(env), [NEW_ID]);
  }],
  ['exhausted conflicts reject and preserve the winning aggregate', async () => {
    const { bucket, env } = fixture();
    await seed(bucket);
    installConflicts(bucket);
    await assert.rejects(rebuildCommunity(env), error => error.status === 503);
    assert.equal(bucket.aggregateAttempts, 3, 'retry work must be bounded');
    assert.deepEqual(await publicIds(env), []);
  }],
  ['single admin operation cannot report success after exhausted conflicts', async () => {
    const { bucket, env } = fixture();
    await seed(bucket);
    installConflicts(bucket);
    const response = await admin(env, 'unpublish', { id: ID });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).ok, false);
    assert.equal(!!await findCommunityRecord(env, ID, ['hidden']), true, 'record move is not rolled back');
  }],
  ['batch final rebuild failure cannot return succeeded as success', async () => {
    const { bucket, env } = fixture();
    await seed(bucket);
    installConflicts(bucket);
    const response = await admin(env, 'batch', { action: 'unpublish', ids: [ID] });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.succeeded, undefined);
    assert.equal(bucket.aggregateAttempts, 3, 'failure must come from exhausted aggregate conflicts');
  }],
  ['default move helper propagates exhausted rebuild conflicts', async () => {
    const { bucket, env } = fixture();
    await seed(bucket);
    installConflicts(bucket);
    await assert.rejects(moveCommunityRecord(env, {
      status: 'approved', key: `community/approved/${ID}.json`, record: record(),
    }, 'hidden'), error => error.status === 503);
  }],
  ['real storage exceptions propagate without an unconditional fallback', async () => {
    const { bucket, env } = fixture();
    await seed(bucket);
    bucket.beforeAggregatePut = () => { throw new Error('injected storage failure'); };
    await assert.rejects(rebuildCommunity(env), /injected storage failure/);
    assert.equal(bucket.aggregateAttempts, 1);
    assert.equal(bucket.objects.has(KEY), false);
  }],
  ['normal paginated rebuild preserves all records and one aggregate write', async () => {
    const { bucket, env } = fixture();
    bucket.pageSize = 2;
    for (let i = 1; i <= 5; i++) await seed(bucket, `c000000${i}`);
    const data = await rebuildCommunity(env);
    assert.equal(data.entries.length, 5);
    assert.equal(bucket.listCalls, 4);
    assert.equal(bucket.aggregateAttempts, 1);
    assert.deepEqual(data.categories, ['画风']);
  }],
];

let failures = 0;
for (const [name, run] of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}\n${error.stack}`); }
}
if (failures) {
  console.error(`community aggregate concurrency: FAIL (${failures}/${cases.length})`);
  process.exitCode = 1;
} else console.log(`community aggregate concurrency: PASS (${cases.length} cases)`);
