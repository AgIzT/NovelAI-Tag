// 投稿 / 反馈防护回归：node tools/test_submission_guards.mjs
// 覆盖 D1 原子限额与待审占位、D1 不可用时退回 R2、公开反馈快照的条件写、推送结果回写不复活已删记录。
import assert from 'node:assert/strict';

import { SqliteD1, readMigrations } from './sqlite-d1-test-harness.mjs';
import { MemoryR2 } from './memory-r2-test-harness.mjs';
import {
  consumeSubmissionRate, reservePendingSlot, releasePendingSlot, PENDING_RESERVATION_TTL_MS,
} from '../functions/_submission_guards.js';
import { readCanonical, writeCanonical, listRecordMetadata } from '../functions/_record-store.js';
import { LIMITS } from '../functions/_lib.js';
import { FEEDBACK_PUBLIC_INDEX_KEY, updatePublicFeedbackIndex } from '../functions/_feedback.js';
import { onRequestPost as feedbackPost } from '../functions/api/feedback.js';
import { onRequestPost as submitPost } from '../functions/api/submit.js';

const migration = await readMigrations('0004_submission_guards.sql');
const silentWarn = async fn => {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try { return { result: await fn(), warnings }; } finally { console.warn = original; }
};

// ---- 1. 限额：窗口内第 6 次被拒；换窗口后重新计数并清掉过期行 ----
{
  const db = new SqliteD1(migration);
  const env = { COMMUNITY_DB: db };
  const base = { scope: 'feedback', identifierHash: 'ip-a', limit: 5, windowMs: 600_000 };
  const now = 1_800_000_000_000;
  const results = await Promise.all(Array.from({ length: 7 }, () => consumeSubmissionRate(env, { ...base, now })));
  assert.equal(results.filter(r => r.allowed).length, 5, '同时到达的 7 次只放行 5 次');
  assert.equal((await consumeSubmissionRate(env, { ...base, identifierHash: 'ip-b', now })).allowed, true, '不同来源互不影响');
  const later = await consumeSubmissionRate(env, { ...base, now: now + 600_000 });
  assert.equal(later.allowed, true, '下一个窗口重新计数');
  const leftover = db.rows('SELECT COUNT(*) AS n FROM submission_rate_buckets WHERE bucket_start < ?', Math.floor((now + 600_000) / 600_000) * 600_000);
  assert.equal(leftover[0].n, 0, '过期窗口的计数行随调用清掉，不会一直累积');
  console.log('  ok  guards: 限额原子计数与过期清理');
}

// ---- 2. 待审占位：R2 已有 298 条时同时来 5 个，只有 2 个占到；名额过期后释放 ----
{
  const db = new SqliteD1(migration);
  const env = { COMMUNITY_DB: db };
  const now = 1_800_000_000_000;
  const slots = await Promise.all(Array.from({ length: 5 }, () => reservePendingSlot(env, { queue: 'community', pendingCount: 298, max: 300, now })));
  assert.equal(slots.filter(s => s.reserved).length, 2, '同时到达也不超过上限');
  assert.equal((await reservePendingSlot(env, { queue: 'feedback', pendingCount: 298, max: 300, now })).reserved, true, '两个队列分开计数');
  const kept = slots.find(s => s.reserved);
  await releasePendingSlot(env, { queue: 'community', id: kept.id });
  assert.equal((await reservePendingSlot(env, { queue: 'community', pendingCount: 298, max: 300, now })).reserved, true, '释放后名额可再用');
  const expired = await reservePendingSlot(env, { queue: 'community', pendingCount: 299, max: 300, now: now + PENDING_RESERVATION_TTL_MS + 1 });
  assert.equal(expired.reserved, true, '名额过期后不再占位');
  console.log('  ok  guards: 待审名额原子占位');
}

// ---- 3. D1 未绑定或迁移未跑：返回 null 交给调用方退回 R2 做法 ----
{
  assert.equal(await consumeSubmissionRate({}, { scope: 'feedback', identifierHash: 'x', limit: 5, windowMs: 1000 }), null);
  assert.equal(await reservePendingSlot({}, { queue: 'feedback', pendingCount: 0, max: 300 }), null);
  const { result, warnings } = await silentWarn(() => reservePendingSlot({ COMMUNITY_DB: new SqliteD1('') }, { queue: 'feedback', pendingCount: 0, max: 300 }));
  assert.equal(result, null, '表不存在时不抛错');
  assert.match(warnings.join('\n'), /pending_reservation_d1_unavailable/);
  console.log('  ok  guards: D1 不可用时退回');
}

function feedbackRequest(ip, n) {
  return new Request('https://example.test/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ type: 'suggestion', description: `并发反馈测试第 ${n} 条，内容足够长。` }),
  });
}

// ---- 4. 反馈接口：同一来源同时 7 条只收 5 条；D1 不可用时仍按 R2 软限额工作 ----
{
  const bucket = new MemoryR2({ latencyMs: 5 });  // 模拟网络往返，让并发请求真的交错
  const env = { STRINGS_BUCKET: bucket, COMMUNITY_DB: new SqliteD1(migration), RATE_LIMIT_SALT: 'test' };
  const responses = await Promise.all(Array.from({ length: 7 }, (_, i) => feedbackPost({ env, request: feedbackRequest('203.0.113.7', i), waitUntil() {} })));
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 201, 201, 201, 201, 429, 429]);
  const pending = await listRecordMetadata(bucket, 'feedback', ['pending']);
  assert.equal(pending.length, 5, '只写入放行的 5 条');
  assert.equal([...bucket.objects.keys()].some(key => key.startsWith('feedback/ratelimit/')), false, '走 D1 时不再往 R2 写限流记录');

  const fallbackBucket = new MemoryR2();
  const { result } = await silentWarn(async () => {
    const out = [];
    for (let i = 0; i < 6; i += 1) {
      out.push((await feedbackPost({ env: { STRINGS_BUCKET: fallbackBucket, COMMUNITY_DB: new SqliteD1('') }, request: feedbackRequest('203.0.113.8', i), waitUntil() {} })).status);
    }
    return out;
  });
  assert.deepEqual(result, [201, 201, 201, 201, 201, 429], 'D1 不可用时退回 R2 软限额，反馈照常可用');
  console.log('  ok  feedback: D1 原子限额与退回');
}

// ---- 5. 反馈队列：R2 已有 299 条时同时来 3 条（不同来源），只收 1 条 ----
{
  const bucket = new MemoryR2({ latencyMs: 5 });  // 模拟网络往返，让并发请求真的交错
  for (let i = 0; i < LIMITS.pendingMax - 1; i += 1) await bucket.put(`feedback/pending/2026/10/full-${i}.json`, '{}');
  const env = { STRINGS_BUCKET: bucket, COMMUNITY_DB: new SqliteD1(migration), RATE_LIMIT_SALT: 'test' };
  const responses = await Promise.all(['198.51.100.1', '198.51.100.2', '198.51.100.3'].map((ip, i) => feedbackPost({ env, request: feedbackRequest(ip, i), waitUntil() {} })));
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 429, 429]);
  const pending = await listRecordMetadata(bucket, 'feedback', ['pending']);
  assert.equal(pending.length, LIMITS.pendingMax, '并发下也不超过上限');
  console.log('  ok  feedback: 待审上限在并发下成立');
}

// ---- 6. 投稿接口：待审 299 条时同时来 2 个合法投稿，只收 1 个 ----
{
  const bucket = new MemoryR2({ latencyMs: 5 });  // 模拟网络往返，让并发请求真的交错
  for (let i = 0; i < LIMITS.pendingMax - 1; i += 1) await bucket.put(`community/pending/full-${i}.json`, '{}');
  const env = { STRINGS_BUCKET: bucket, STRINGS_PUBLIC_BASE: 'https://cdn.example.test', COMMUNITY_DB: new SqliteD1(migration) };
  const jpg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);
  const submitRequest = n => {
    const fd = new FormData();
    fd.append('prompt', `concurrent ${n}`);
    fd.append('images', new File([jpg()], '1.jpg', { type: 'image/jpeg' }));
    return new Request('https://example.test/api/submit', { method: 'POST', body: fd });
  };
  const responses = await Promise.all([submitPost({ env, request: submitRequest(1) }), submitPost({ env, request: submitRequest(2) })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 429]);
  const pending = await listRecordMetadata(bucket, 'community', ['pending']);
  assert.equal(pending.length, LIMITS.pendingMax, '并发下也不超过上限');
  assert.equal([...bucket.objects.keys()].filter(key => key.startsWith('community/img/')).length, 1, '被拒的投稿不写图片');
  console.log('  ok  submit: 待审上限在并发下成立');
}

// ---- 7. 公开快照：两个后台操作交错时，后写的一方不得把刚撤回的反馈盖回去 ----
{
  const bucket = new MemoryR2();
  const record = (id, updatedAt) => ({
    id, type: 'suggestion', description: `公开反馈 ${id} 的内容`, publicVisible: true, publicConsent: true,
    progressStatus: 'accepted', adminReply: '', createdAt: 1, updatedAt, progressStatusUpdatedAt: updatedAt, context: {},
  });
  await writeCanonical(bucket, 'feedback', 'aaaa1111', null, { status: 'pending', record: record('aaaa1111', 10) });
  await writeCanonical(bucket, 'feedback', 'bbbb2222', null, { status: 'pending', record: record('bbbb2222', 20) });
  await updatePublicFeedbackIndex(bucket, { upsertRecord: record('aaaa1111', 10), upsertStatus: 'pending' });
  const publicIds = async () => JSON.parse(bucket.objects.get(FEEDBACK_PUBLIC_INDEX_KEY)).items.map(item => item.id).sort();
  assert.deepEqual(await publicIds(), ['aaaa1111']);

  // B（更新另一条）读到含 A 的旧快照之后、写回之前，A 被撤回。
  let interleaved = false;
  bucket.afterGet = async key => {
    if (interleaved || key !== FEEDBACK_PUBLIC_INDEX_KEY) return;
    interleaved = true;
    bucket.afterGet = null;
    const current = await readCanonical(bucket, 'feedback', 'aaaa1111');
    await writeCanonical(bucket, 'feedback', 'aaaa1111', current, { status: 'pending', record: { ...current.record, publicVisible: false } });
    await updatePublicFeedbackIndex(bucket, { removeIds: ['aaaa1111'] });
  };
  await updatePublicFeedbackIndex(bucket, { upsertRecord: record('bbbb2222', 20), upsertStatus: 'pending' });
  assert.equal(interleaved, true, '夹具确实制造了交错');
  assert.deepEqual(await publicIds(), ['bbbb2222'], '撤回的反馈不得被旧快照盖回公开列表');
  console.log('  ok  feedback: 公开快照条件写');
}

// ---- 8. 推送回写：推送途中反馈被删除不复活；推送途中被修改则合并而不是覆盖 ----
{
  const originalFetch = globalThis.fetch;
  let releasePush;
  globalThis.fetch = () => new Promise(resolve => {
    releasePush = () => resolve(new Response(JSON.stringify({ code: 0, message: 'ok' }), { status: 200 }));
  });
  const logs = console.log;
  console.log = () => {};
  try {
    // 8a. 回写读到记录之后、写回之前，维护者永久删除了它
    {
      const bucket = new MemoryR2();
      const waits = [];
      const env = { STRINGS_BUCKET: bucket, SERVERCHAN_KEY: 'test-key', RATE_LIMIT_SALT: 'test' };
      const res = await feedbackPost({ env, request: feedbackRequest('192.0.2.1', 1), waitUntil: p => waits.push(p) });
      const { id } = await res.json();
      const key = [...bucket.objects.keys()].find(k => k.endsWith(`${id}.json`));
      bucket.afterGet = async readKey => {
        if (readKey !== key) return;
        bucket.afterGet = null;
        const current = await readCanonical(bucket, 'feedback', id);
        await writeCanonical(bucket, 'feedback', id, current, { status: 'pending', deleted: true });
      };
      releasePush();
      await Promise.all(waits);
      assert.equal((await readCanonical(bucket, 'feedback', id)).deleted, true, '已删除的反馈不得被推送回写重新写出来');
    }
    // 8b. 回写读到记录之后、写回之前，维护者保存了回复
    {
      const bucket = new MemoryR2();
      const waits = [];
      const env = { STRINGS_BUCKET: bucket, SERVERCHAN_KEY: 'test-key', RATE_LIMIT_SALT: 'test' };
      const res = await feedbackPost({ env, request: feedbackRequest('192.0.2.2', 2), waitUntil: p => waits.push(p) });
      const { id } = await res.json();
      const key = [...bucket.objects.keys()].find(k => k.endsWith(`${id}.json`));
      bucket.afterGet = async readKey => {
        if (readKey !== key) return;
        bucket.afterGet = null;
        const current = await readCanonical(bucket, 'feedback', id);
        await writeCanonical(bucket, 'feedback', id, current, { status: 'pending', record: { ...current.record, adminReply: '维护者的回复' } });
      };
      releasePush();
      await Promise.all(waits);
      const final = JSON.parse(bucket.objects.get(key)).record;
      assert.equal(final.adminReply, '维护者的回复', '推送回写不得覆盖维护者刚保存的内容');
      assert.equal(final.notification.status, 'sent', '推送结果仍然写上');
    }
  } finally {
    globalThis.fetch = originalFetch;
    console.log = logs;
  }
  console.log('  ok  feedback: 推送回写条件写');
}

console.log('submission guards: PASS');
