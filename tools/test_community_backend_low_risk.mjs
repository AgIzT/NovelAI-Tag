// 共创与反馈 Functions 低风险回归：node tools/test_community_backend_low_risk.mjs
import assert from 'node:assert/strict';

import { findFeedbackRecord } from '../functions/_feedback.js';
import { moveCommunityRecord, findCommunityRecord } from '../functions/_lib.js';
import { onRequestPost as deleteFeedback } from '../functions/api/admin/feedback-delete.js';
import { MemoryR2 } from './memory-r2-test-harness.mjs';

function adminRequest(path, body) {
  return new Request(`https://admin.example.test${path}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

// 合法的 8 位截短 id 不得命中另一条以它结尾的完整 id。
{
  const bucket = new MemoryR2();
  const fullId = 'abcdef12cafebabe';
  const shortId = 'cafebabe';
  const key = `feedback/pending/2026/07/${fullId}.json`;
  await bucket.put(key, JSON.stringify({ id: fullId, status: 'pending', publicVisible: false }));

  assert.equal(await findFeedbackRecord(bucket, shortId, 'pending'), null);
  const response = await deleteFeedback({
    env: { STRINGS_BUCKET: bucket, ADMIN_TOKEN: 'test-token' },
    request: adminRequest('/api/admin/feedback-delete', { id: shortId, status: 'pending' }),
  });
  const data = await response.json();
  assert.equal(response.status, 404, JSON.stringify(data));
  assert.equal(bucket.objects.has(key), true, '截短 id 不得误删完整 id 记录');
}

class DeleteFailureR2 extends MemoryR2 {
  constructor(failures) {
    super();
    this.failures = failures;
    this.deleteAttempts = 0;
  }

  async delete(keys) {
    this.deleteAttempts += 1;
    if (this.deleteAttempts <= this.failures) {
      throw new Error(`delete failed ${this.deleteAttempts}`);
    }
    return super.delete(keys);
  }
}

function communityRecord(id, status) {
  return {
    id,
    status,
    title: `title-${id}`,
    prompt: `prompt-${id}`,
    category: ['随手分享'],
    images: [],
    createdAt: 100,
  };
}

// 迁移只写 canonical；旧副本不再参与状态，删除故障不能产生双权威。
for (const failures of [1, 2]) {
  const id = `6000000${failures}`;
  const fromKey = `community/pending/${id}.json`;
  const bucket = new DeleteFailureR2(failures);
  const record = communityRecord(id, 'pending');
  await bucket.put(fromKey, JSON.stringify(record));
  const env = { STRINGS_BUCKET: bucket };
  const moved = await moveCommunityRecord(env, { status: 'pending', key: fromKey, record }, 'hidden', { now: 200, rebuild: false });
  assert.equal(moved.status, 'hidden');
  assert.equal(bucket.deleteAttempts, 0);
  assert.equal(bucket.objects.has(fromKey), true, '只读旧副本保留到永久删除');
  assert.equal(await findCommunityRecord(env, id, ['pending']), null);
  assert.equal((await findCommunityRecord(env, id, ['hidden'])).record.status, 'hidden');
}
console.log('community/backend low-risk regressions: PASS');
