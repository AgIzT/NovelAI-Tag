// Fault injection against the real handler; synthetic memory R2 + SQLite only.
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/submit.js';
import { MemoryR2 } from './memory-r2-test-harness.mjs';
import { requireRecordIndex } from '../functions/_record-index.js';
import { SqliteD1, readMigrations } from './sqlite-d1-test-harness.mjs';

const migration = await readMigrations('0004_submission_guards.sql');
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECOVERY = 'community/submission-recovery/';
const MEDIA = 'community/img/';
const PENDING = 'community/records/';
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);
const opened = [];
let logs = [];

class FaultR2 extends MemoryR2 {
  puts = [];
  deletes = [];
  beforePut = null;
  afterPut = null;
  beforeDelete = null;
  async put(key, value, options = {}) {
    this.puts.push(key);
    if (this.beforePut) await this.beforePut(key, value, options);
    const result = await super.put(key, value, options);
    if (this.afterPut) await this.afterPut(key, value, options, result);
    return result;
  }
  async delete(keys) {
    this.deletes.push(Array.isArray(keys) ? [...keys] : [keys]);
    if (this.beforeDelete) await this.beforeDelete(keys);
    return super.delete(keys);
  }
}

function fixture({ d1 = true } = {}) {
  const bucket = new FaultR2();
  const db = d1 ? new SqliteD1(migration) : null;
  if (db) opened.push(db);
  const env = { STRINGS_BUCKET: bucket, STRINGS_PUBLIC_BASE: 'https://cdn.example.test' };
  if (db) env.COMMUNITY_DB = db;
  return { bucket, db, env };
}

function request({ count = 2, originals = false } = {}) {
  const form = new FormData();
  form.append('prompt', 'PRIVATE-PROMPT-MUST-NOT-BE-LOGGED');
  form.append('submitter', 'PRIVATE-SUBMITTER');
  for (let i = 1; i <= count; i++) {
    form.append('images', new File([jpg], `${i}.jpg`, { type: 'image/jpeg' }));
    if (originals) form.append('originals', new File([jpg], `${i}.jpg`, { type: 'image/jpeg' }));
  }
  return new Request('https://example.test/api/submit', { method: 'POST', body: form });
}

const keys = (bucket, prefix) => [...bucket.objects.keys()].filter(key => key.startsWith(prefix));
const reservations = db => db.rows('SELECT COUNT(*) AS n FROM pending_reservations')[0].n;
const post = (env, options) => onRequestPost({ env, request: request(options) });
const rawPut = (bucket, ...args) => MemoryR2.prototype.put.call(bucket, ...args);

function recovery(bucket) {
  const found = keys(bucket, RECOVERY);
  assert.equal(found.length, 1, 'uncertain/failed compensation must remain durably traceable');
  const raw = bucket.objects.get(found[0]);
  assert.doesNotMatch(raw, /PRIVATE-PROMPT|PRIVATE-SUBMITTER|injected secret/);
  return JSON.parse(raw);
}

async function fixedId(fn) {
  const original = crypto.randomUUID;
  crypto.randomUUID = () => ID;
  try { return await fn(); } finally { crypto.randomUUID = original; }
}

function failMedia(bucket, index, { after = false } = {}) {
  const error = new Error('injected secret: media write failure');
  let seen = 0;
  bucket[after ? 'afterPut' : 'beforePut'] = key => {
    if (key.startsWith(MEDIA) && ++seen === index) throw error;
  };
  return error;
}

const cases = [];
// Cover every thumb/original write slot at the current six-image limit.
for (let index = 1; index <= 12; index++) {
  cases.push([`media write ${index}/12 fails before commit`, async () => {
    const { bucket, env, db } = fixture();
    await rawPut(bucket, 'community/img/historical/keep.jpg', 'history');
    const error = failMedia(bucket, index);
    await assert.rejects(post(env, { count: 6, originals: true }), caught => caught === error);
    assert.deepEqual(keys(bucket, MEDIA), ['community/img/historical/keep.jpg'], 'acknowledged earlier writes must be compensated');
    assert.equal(keys(bucket, PENDING).length, 0);
    assert.equal(reservations(db), 0);
    assert.ok(recovery(bucket).mediaKeys.includes(bucket.puts.filter(key => key.startsWith(MEDIA)).at(-1)));
    assert.ok(bucket.deletes.every(batch => !batch.includes('community/img/historical/keep.jpg')));
  }]);
}

cases.push(
  ['success preserves every referenced thumb/original and removes recovery intent', async () => {
    const { bucket, env, db } = fixture();
    const response = await post(env, { count: 6, originals: true });
    assert.equal(response.status, 201);
    const result = await response.json();
    const record = (await (await bucket.get(`${PENDING}${result.id}.json`)).json()).record;
    assert.equal(record.images.length, 6);
    for (const image of record.images) {
      assert.ok(bucket.objects.has(image.key));
      assert.ok(bucket.objects.has(image.origKey));
    }
    assert.equal(keys(bucket, RECOVERY).length, 0);
    assert.equal(reservations(db), 1, 'success keeps the existing reservation TTL policy');
  }],
  ['media commits then throws: unknown key retained with durable intent', async () => {
    const { bucket, env, db } = fixture();
    const error = failMedia(bucket, 2, { after: true });
    await assert.rejects(post(env), caught => caught === error);
    const remaining = keys(bucket, MEDIA);
    assert.equal(remaining.length, 1, 'clean confirmed first image, retain uncertain second image');
    assert.ok(remaining[0].endsWith('/2.jpg'));
    assert.ok(recovery(bucket).mediaKeys.includes(remaining[0]));
    assert.equal(reservations(db), 0);
  }],
  ['media may commit after the failed request returns', async () => {
    const { bucket, env } = fixture();
    const error = new Error('late media');
    let late;
    bucket.beforePut = (key, value, options) => {
      if (key.startsWith(MEDIA) && key.endsWith('/2.jpg')) {
        late = () => rawPut(bucket, key, value, options);
        throw error;
      }
    };
    await assert.rejects(post(env), caught => caught === error);
    assert.equal(keys(bucket, MEDIA).length, 0);
    const intent = recovery(bucket);
    await late();
    assert.ok(intent.mediaKeys.includes(keys(bucket, MEDIA)[0]), 'late commit is not an untracked orphan');
  }],
  ...[false, true].map(after => [`pending ${after ? 'commits then' : 'fails before commit and'} throws: media and reservation retained`, async () => {
    const { bucket, env, db } = fixture();
    const error = new Error('pending outcome unknown');
    bucket[after ? 'afterPut' : 'beforePut'] = key => { if (key.startsWith(PENDING)) throw error; };
    if (after) assert.equal((await post(env)).status, 201, 'operationId 复读确认已提交');
    else await assert.rejects(post(env), caught => caught.status === 503);
    assert.equal(keys(bucket, MEDIA).length, 2);
    assert.equal(keys(bucket, PENDING).length, Number(after));
    assert.equal(reservations(db), 1, 'ambiguous commit must not release a possibly accepted reservation');
    if (after) assert.equal(keys(bucket, RECOVERY).length, 0);
    else assert.equal(recovery(bucket).mediaKeys.length, 2);
    assert.equal(bucket.deletes.flat().filter(key => key.startsWith(MEDIA)).length, 0);
  }]),
  ['pending may commit after failure and still references intact images', async () => {
    const { bucket, env, db } = fixture();
    const error = new Error('late pending');
    let late;
    bucket.beforePut = (key, value, options) => {
      if (key.startsWith(PENDING)) { late = () => rawPut(bucket, key, value, options); throw error; }
    };
    await assert.rejects(post(env), caught => caught.status === 503);
    assert.equal(keys(bucket, PENDING).length, 0);
    recovery(bucket);
    await late();
    const record = JSON.parse(bucket.objects.get(keys(bucket, PENDING)[0])).record;
    for (const image of record.images) assert.ok(bucket.objects.has(image.key));
    assert.equal(reservations(db), 1);
  }],
  ['failed compensation does not stop cleanup of other owned images', async () => {
    const { bucket, env, db } = fixture();
    const error = failMedia(bucket, 4);
    let stubborn;
    bucket.beforeDelete = async value => {
      const batch = Array.isArray(value) ? value : [value];
      stubborn ||= bucket.puts.find(key => key.startsWith(MEDIA));
      if (batch.includes(stubborn)) throw new Error('injected delete failure');
    };
    await assert.rejects(post(env, { count: 4 }), caught => caught === error);
    assert.deepEqual(keys(bucket, MEDIA), [stubborn], 'other owned objects should still be cleaned');
    assert.ok(recovery(bucket).mediaKeys.includes(stubborn));
    assert.ok(logs.some(line => line.includes('community_submission_recovery_needed')));
    assert.equal(reservations(db), 0);
    assert.ok(bucket.deletes.length <= 5, 'compensation work must be bounded');
  }],
  ['partial batch delete with lost response can be safely retried per key', async () => {
    const { bucket, env } = fixture();
    const error = failMedia(bucket, 4);
    let injected = false;
    bucket.beforeDelete = async value => {
      if (!injected) {
        injected = true;
        await MemoryR2.prototype.delete.call(bucket, Array.isArray(value) ? value[0] : value);
        throw new Error('delete response lost');
      }
    };
    await assert.rejects(post(env, { count: 4 }), caught => caught === error);
    assert.equal(keys(bucket, MEDIA).length, 0);
    recovery(bucket);
  }],
  ['recovery intent failure stops before all media writes', async () => {
    const { bucket, env, db } = fixture();
    const error = new Error('intent unavailable');
    bucket.beforePut = key => { if (key.startsWith(RECOVERY)) throw error; };
    await assert.rejects(post(env), caught => caught === error);
    assert.equal(keys(bucket, MEDIA).length, 0);
    assert.equal(keys(bucket, PENDING).length, 0);
    assert.equal(reservations(db), 0);
  }],
  ['recovery snapshot update failure preserves initial durable intent and original error', async () => {
    const { bucket, env } = fixture();
    const error = new Error('original media failure');
    let intents = 0;
    bucket.beforePut = key => {
      if (key.startsWith(RECOVERY) && ++intents > 1) throw new Error('journal update unavailable');
      if (key.startsWith(MEDIA) && key.endsWith('/2.jpg')) throw error;
    };
    await assert.rejects(post(env), caught => caught === error);
    assert.equal(keys(bucket, MEDIA).length, 0);
    recovery(bucket);
  }],
  ['intent cleanup failure after commit cannot turn success into rollback', async () => {
    const { bucket, env, db } = fixture();
    bucket.beforeDelete = value => {
      if ([value].flat().some(key => key.startsWith(RECOVERY))) throw new Error('journal delete unavailable');
    };
    const response = await post(env);
    assert.equal(response.status, 201);
    assert.equal(keys(bucket, MEDIA).length, 2);
    assert.equal(keys(bucket, PENDING).length, 1);
    assert.equal(reservations(db), 1);
    recovery(bucket);
    assert.ok(logs.some(line => line.includes('community_submission_recovery_cleanup_failed')));
  }],
  ['media creation conflict preserves the existing object and cleans only owned keys', async () => {
    const { bucket, env, db } = fixture();
    let foreign;
    bucket.beforePut = async key => {
      if (key.startsWith(MEDIA) && key.endsWith('/2.jpg')) {
        foreign = key;
        await rawPut(bucket, key, 'foreign bytes');
      }
    };
    await assert.rejects(post(env));
    assert.deepEqual(keys(bucket, MEDIA), [foreign]);
    assert.equal(bucket.objects.get(foreign), 'foreign bytes');
    assert.ok(!bucket.deletes.flat().includes(foreign));
    assert.equal(reservations(db), 0);
  }],
  ['pending creation conflict never overwrites the other record', async () => {
    const { bucket, env, db } = fixture();
    bucket.beforePut = async key => { if (key.startsWith(PENDING)) await rawPut(bucket, key, 'foreign pending'); };
    await assert.rejects(post(env));
    assert.equal(bucket.objects.get(keys(bucket, PENDING)[0]), 'foreign pending');
    assert.equal(keys(bucket, MEDIA).length, 0);
    assert.equal(reservations(db), 0);
  }],
  ['recovery intent collision never replaces another request intent', async () => fixedId(async () => {
    const { bucket, env } = fixture();
    await rawPut(bucket, `${RECOVERY}${ID}.json`, 'foreign intent');
    await assert.rejects(post(env));
    assert.equal(bucket.objects.get(`${RECOVERY}${ID}.json`), 'foreign intent');
    assert.equal(keys(bucket, MEDIA).length, 0);
    assert.equal(bucket.deletes.length, 0);
  })],
  ...['pending', 'approved', 'hidden', 'rejected', 'deleted', 'records'].map(status => [`existing ${status} ID (even invalid JSON) is not reused`, async () => fixedId(async () => {
    const { bucket, env, db } = fixture();
    // 此组隔离检查 ID 冲突；首次目录升级和坏 canonical 由 record_store_edges 单独验证。
    await requireRecordIndex(bucket, 'community');
    const key = `community/${status}/${ID}.json`;
    await rawPut(bucket, key, 'historical invalid JSON');
    await rawPut(bucket, `${MEDIA}${ID}/1.jpg`, 'historical image');
    const before = [...bucket.objects];
    await assert.rejects(post(env));
    assert.deepEqual([...bucket.objects], before);
    assert.equal(bucket.deletes.length, 0);
    assert.equal(reservations(db), 0);
  })]),
  ['D1 release failure preserves the original storage error and cleanup result', async () => {
    const { bucket, env, db } = fixture();
    const prepare = db.prepare.bind(db);
    db.prepare = sql => sql.includes('DELETE FROM pending_reservations WHERE queue')
      ? { bind: () => ({ run: async () => { throw new Error('release unavailable'); } }) }
      : prepare(sql);
    const error = failMedia(bucket, 2);
    await assert.rejects(post(env), caught => caught === error);
    assert.equal(keys(bucket, MEDIA).length, 0);
    assert.equal(reservations(db), 1);
    assert.ok(logs.some(line => line.includes('pending_reservation_release_failed')));
  }],
  ['D1-unbound fallback still compensates partial media writes', async () => {
    const { bucket, env } = fixture({ d1: false });
    const error = failMedia(bucket, 2);
    await assert.rejects(post(env), caught => caught === error);
    assert.equal(keys(bucket, MEDIA).length, 0);
    recovery(bucket);
  }],
  ['unconfirmed index preparation never issued canonical PUT and compensates confirmed media', async () => {
    const { bucket, env, db } = fixture();
    let canonicalPuts = 0;
    bucket.beforePut = key => {
      if (key.startsWith(PENDING)) canonicalPuts++;
      if (key.startsWith('community/record-index/v1/')) throw new Error('prepare unavailable');
    };
    await assert.rejects(post(env), error => error.status === 503);
    assert.equal(canonicalPuts, 0);
    assert.equal(keys(bucket, MEDIA).length, 0);
    assert.equal(keys(bucket, RECOVERY).length, 0);
    assert.equal(reservations(db), 0);
    assert.equal(keys(bucket, 'community/record-index-aborted/').length, 1);
  }],
  ['a new submission after failure does not reuse or delete the earlier attempt', async () => {
    const { bucket, env } = fixture();
    const error = failMedia(bucket, 2);
    await assert.rejects(post(env), caught => caught === error);
    const old = recovery(bucket);
    bucket.beforePut = null;
    const response = await post(env);
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.notEqual(result.id, old.id);
    assert.equal(keys(bucket, MEDIA).length, 2);
    assert.equal(keys(bucket, PENDING).length, 1);
    assert.ok(bucket.objects.has(`${RECOVERY}${old.id}.json`));
  }],
);

let failures = 0;
for (const [name, run] of cases) {
  const warn = console.warn, error = console.error;
  logs = [];
  console.warn = console.error = (...args) => logs.push(args.join(' '));
  try {
    await run();
    assert.ok(logs.every(line => !/PRIVATE-PROMPT|PRIVATE-SUBMITTER|injected secret/.test(line)), 'diagnostics must not leak content or raw storage errors');
    console.log(`PASS ${name}`);
  } catch (caught) {
    failures += 1;
    error(`FAIL ${name}\n${caught.stack}`);
  } finally {
    console.warn = warn; console.error = error;
    for (const db of opened.splice(0)) db.sqlite.close();
  }
}
if (failures) {
  console.error(`community submission recovery: FAIL (${failures}/${cases.length})`);
  process.exitCode = 1;
} else console.log(`community submission recovery: PASS (${cases.length} cases)`);
