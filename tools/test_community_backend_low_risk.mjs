// 共创与反馈 Functions 低风险回归：node tools/test_community_backend_low_risk.mjs
import assert from 'node:assert/strict';

import { findFeedbackRecord } from '../functions/_feedback.js';
import { moveCommunityRecord } from '../functions/_lib.js';
import { onRequestPost as deleteFeedback } from '../functions/api/admin/feedback-delete.js';

class MemoryR2 {
  constructor() {
    this.objects = new Map();
  }

  async get(key) {
    if (!this.objects.has(key)) return null;
    const raw = this.objects.get(key);
    return { json: async () => JSON.parse(raw) };
  }

  async put(key, value) {
    const raw = typeof value === 'string' ? value : await value.text();
    this.objects.set(key, raw);
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list({ prefix }) {
    return {
      objects: [...this.objects.keys()]
        .filter(key => key.startsWith(prefix))
        .map(key => ({ key })),
      truncated: false,
    };
  }
}

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

// 旧 key 首次删除失败后重试一次；重试成功则完成迁移。
{
  const id = '60000001';
  const fromKey = `community/pending/${id}.json`;
  const toKey = `community/hidden/${id}.json`;
  const bucket = new DeleteFailureR2(1);
  const record = communityRecord(id, 'pending');
  await bucket.put(fromKey, JSON.stringify(record));
  const moved = await moveCommunityRecord(
    { STRINGS_BUCKET: bucket },
    { status: 'pending', key: fromKey, record },
    'hidden',
    { now: 200, rebuild: false },
  );
  assert.equal(moved.status, 'hidden');
  assert.equal(bucket.deleteAttempts, 2);
  assert.equal(bucket.objects.has(fromKey), false);
  assert.equal(bucket.objects.has(toKey), true);
}

// 两次删除都失败时，新副本保留，记结构化错误后继续抛出。
{
  const id = '60000002';
  const fromKey = `community/pending/${id}.json`;
  const toKey = `community/hidden/${id}.json`;
  const bucket = new DeleteFailureR2(2);
  const record = communityRecord(id, 'pending');
  await bucket.put(fromKey, JSON.stringify(record));
  const originalError = console.error;
  const logs = [];
  console.error = value => logs.push(value);
  try {
    await assert.rejects(
      moveCommunityRecord(
        { STRINGS_BUCKET: bucket },
        { status: 'pending', key: fromKey, record },
        'hidden',
        { now: 300, rebuild: false },
      ),
      /delete failed 2/,
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(bucket.deleteAttempts, 2);
  assert.equal(bucket.objects.has(fromKey), true, '删旧副本失败时不得破坏旧数据');
  assert.equal(bucket.objects.has(toKey), true, '先写新副本的保数据语义必须保留');
  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(logs[0]), {
    event: 'community_record_move_delete_failed',
    id,
    fromKey,
    toKey,
    error: 'delete failed 2',
  });
}

console.log('community/backend low-risk regressions: PASS');
