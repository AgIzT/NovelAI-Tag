import assert from 'node:assert/strict';

import { onRequestGet as getFeedback } from '../functions/api/admin/feedback.js';
import { onRequestPost as updateFeedback } from '../functions/api/admin/feedback-decide.js';
import { onRequestPost as submitFeedback } from '../functions/api/feedback.js';
import {
  FEEDBACK_PROGRESS as BACKEND_FEEDBACK_PROGRESS,
  feedbackStatusForProgress,
} from '../functions/_feedback.js';
import {
  FEEDBACK_PROGRESS as FRONTEND_FEEDBACK_PROGRESS,
} from '../site/assets/admin/state.js';

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

const bucket = new MemoryR2();
const env = {
  STRINGS_BUCKET: bucket,
  ADMIN_TOKEN: 'test-token',
};

const EXPECTED_PROGRESS_BUCKETS = {
  unread: 'pending',
  accepted: 'pending',
  investigating: 'pending',
  in_progress: 'pending',
  verifying: 'pending',
  deferred: 'pending',
  completed: 'resolved',
  declined: 'ignored',
};
assert.deepEqual(
  Object.keys(FRONTEND_FEEDBACK_PROGRESS),
  Object.keys(BACKEND_FEEDBACK_PROGRESS),
  '前后端展示进度枚举必须一致',
);
for (const [progressStatus, bucketStatus] of Object.entries(EXPECTED_PROGRESS_BUCKETS)) {
  assert.equal(feedbackStatusForProgress(progressStatus), bucketStatus);
  assert.equal(FRONTEND_FEEDBACK_PROGRESS[progressStatus].status, bucketStatus);
  assert.equal(
    FRONTEND_FEEDBACK_PROGRESS[progressStatus].label,
    BACKEND_FEEDBACK_PROGRESS[progressStatus].label,
  );
  assert.equal(
    FRONTEND_FEEDBACK_PROGRESS[progressStatus].description,
    BACKEND_FEEDBACK_PROGRESS[progressStatus].description,
  );
}

function request(method, path, body) {
  const options = {
    method,
    headers: { authorization: 'Bearer test-token' },
  };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  return new Request(`https://admin.example.test${path}`, options);
}

async function readOk(response) {
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.ok, true, JSON.stringify(data));
  return data;
}

async function readError(response, expectedStatus) {
  const data = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(data));
  assert.equal(data.ok, false, JSON.stringify(data));
  return data;
}

function getContext(status) {
  return {
    env,
    request: request('GET', `/api/admin/feedback?status=${status}`),
  };
}

function updateContext(body) {
  return {
    env,
    request: request('POST', '/api/admin/feedback-decide', body),
  };
}

function keysFor(status, id) {
  return [...bucket.objects.keys()]
    .filter(key => key.startsWith(`feedback/${status}/`) && key.endsWith(`/${id}.json`));
}

const id = 'feed0001';
await bucket.put(`feedback/pending/2026/07/${id}.json`, JSON.stringify({
  id,
  status: 'ignored',
  type: 'card_content',
  description: '这个词条的目录位置需要修正',
  contact: 'tester@example.test',
  context: {
    codex: { id: 'suozhang', title: '所长常规' },
    entry: { id: 'entry-1', title: '测试词条', path: ['人物', '发型'] },
  },
  createdAt: 1000,
}));

const initial = await readOk(await getFeedback(getContext('pending')));
assert.equal(initial.items.length, 1);
assert.equal(initial.items[0].status, 'pending', 'R2 目录状态应覆盖历史对象中的过期状态字段');
assert.equal(initial.items[0].progressStatus, 'unread');
assert.equal(initial.items[0].progressStatusLabel, '待查看');
assert.equal(initial.items[0].adminReply, '');
assert.deepEqual(initial.items[0].context.entry.path, ['人物', '发型']);

const pendingKey = keysFor('pending', id)[0];
const investigating = await readOk(await updateFeedback(updateContext({
  id,
  action: 'update',
  sourceStatus: 'pending',
  progressStatus: 'investigating',
  adminReply: '正在复现目录异常并核对影响范围。',
})));
assert.equal(investigating.status, 'pending');
assert.equal(investigating.progressStatus, 'investigating');
assert.equal(investigating.previousProgressStatus, 'unread');
assert.equal(investigating.item.progressStatusLabel, '调查中');
assert.equal(investigating.item.adminReply, '正在复现目录异常并核对影响范围。');
assert.ok(investigating.item.progressStatusUpdatedAt > 0);
assert.ok(investigating.item.replyUpdatedAt > 0);
assert.deepEqual(keysFor('pending', id), [pendingKey], '进行中阶段切换应原位更新');

const replyEdited = await readOk(await updateFeedback(updateContext({
  id,
  action: 'update',
  sourceStatus: 'pending',
  progressStatus: 'investigating',
  adminReply: '目录与词条内容均已完成排查。',
})));
assert.equal(replyEdited.item.status, 'pending');
assert.equal(replyEdited.item.progressStatus, 'investigating');
assert.equal(replyEdited.item.adminReply, '目录与词条内容均已完成排查。');
assert.equal(
  replyEdited.item.progressStatusUpdatedAt,
  investigating.item.progressStatusUpdatedAt,
  '只改回复不应重写进度更新时间',
);
assert.deepEqual(keysFor('pending', id), [pendingKey], '同阶段回复编辑应原位更新');

const completed = await readOk(await updateFeedback(updateContext({
  id,
  action: 'update',
  sourceStatus: 'pending',
  progressStatus: 'completed',
  adminReply: '目录与词条内容均已修正并验证。',
})));
assert.equal(completed.item.status, 'resolved');
assert.equal(completed.item.progressStatus, 'completed');
assert.equal(completed.item.previousProgressStatus, 'investigating');
assert.equal(completed.item.previousStatus, 'pending');
assert.equal(completed.item.handledAction, 'resolve');
assert.equal(keysFor('pending', id).length, 0);
assert.equal(keysFor('resolved', id).length, 1);

const reopenedByOldClient = await readOk(await updateFeedback(updateContext({
  id,
  action: 'update',
  sourceStatus: 'resolved',
  targetStatus: 'pending',
  adminReply: '重新打开，等待下一轮处理。',
})));
assert.equal(reopenedByOldClient.item.status, 'pending');
assert.equal(reopenedByOldClient.item.progressStatus, 'accepted');
assert.equal(reopenedByOldClient.item.previousStatus, 'resolved');
assert.equal(reopenedByOldClient.item.handledAction, 'reopen');
assert.equal(reopenedByOldClient.item.handledAt, 0);
assert.equal(keysFor('resolved', id).length, 0);
assert.equal(keysFor('pending', id).length, 1);

const deferred = await readOk(await updateFeedback(updateContext({
  id,
  action: 'update',
  sourceStatus: 'pending',
  progressStatus: 'deferred',
})));
assert.equal(deferred.item.status, 'pending');
assert.equal(deferred.item.progressStatus, 'deferred');
assert.equal(deferred.item.adminReply, '重新打开，等待下一轮处理。');
assert.equal(keysFor('pending', id).length, 1);

const declined = await readOk(await updateFeedback(updateContext({
  id,
  action: 'update',
  sourceStatus: 'pending',
  progressStatus: 'declined',
  adminReply: '评估后决定不处理，原因已记录。',
})));
assert.equal(declined.item.status, 'ignored');
assert.equal(declined.item.progressStatus, 'declined');
assert.equal(declined.item.adminReply, '评估后决定不处理，原因已记录。');
assert.equal(declined.item.handledAction, 'ignore');
assert.equal(keysFor('pending', id).length, 0);
assert.equal(keysFor('ignored', id).length, 1);

const ignoredList = await readOk(await getFeedback(getContext('ignored')));
assert.equal(ignoredList.items[0].status, 'ignored');
assert.equal(ignoredList.items[0].progressStatus, 'declined');
assert.equal(ignoredList.items[0].previousStatus, 'pending');

const wrongSource = await readError(await updateFeedback(updateContext({
  id,
  action: 'update',
  sourceStatus: 'resolved',
  progressStatus: 'accepted',
  adminReply: '不会写入',
})), 404);
assert.match(wrongSource.error, /不存在|状态不匹配/);
assert.equal(keysFor('ignored', id).length, 1);

const tooLong = await readError(await updateFeedback(updateContext({
  id,
  action: 'update',
  sourceStatus: 'ignored',
  progressStatus: 'declined',
  adminReply: 'x'.repeat(2001),
})), 400);
assert.match(tooLong.error, /最多 2000 个字/);

const conflictingStatus = await readError(await updateFeedback(updateContext({
  id,
  action: 'update',
  sourceStatus: 'ignored',
  targetStatus: 'ignored',
  progressStatus: 'completed',
})), 400);
assert.match(conflictingStatus.error, /冲突/);

const reopenedIgnored = await readOk(await updateFeedback(updateContext({
  id,
  action: 'update',
  sourceStatus: 'ignored',
  progressStatus: 'accepted',
  adminReply: '重新打开，等待下一轮处理。',
})));
assert.equal(reopenedIgnored.item.status, 'pending');
assert.equal(reopenedIgnored.item.progressStatus, 'accepted');
assert.equal(reopenedIgnored.item.previousStatus, 'ignored');
assert.equal(reopenedIgnored.item.handledAction, 'reopen');
assert.equal(reopenedIgnored.item.adminReply, '重新打开，等待下一轮处理。');
assert.equal(keysFor('ignored', id).length, 0);
assert.equal(keysFor('pending', id).length, 1);

const legacyId = 'feed0002';
await bucket.put(`feedback/pending/2026/07/${legacyId}.json`, JSON.stringify({
  id: legacyId,
  type: 'suggestion',
  description: '希望增加一个新的筛选功能',
  createdAt: 2000,
}));
const legacy = await readOk(await updateFeedback(updateContext({
  id: legacyId,
  action: 'resolve',
})));
assert.equal(legacy.item.status, 'resolved');
assert.equal(legacy.item.progressStatus, 'completed');
assert.equal(legacy.item.adminReply, '');
assert.equal(keysFor('pending', legacyId).length, 0);
assert.equal(keysFor('resolved', legacyId).length, 1);

const submissionBucket = new MemoryR2();
const submissionResponse = await submitFeedback({
  env: {
    STRINGS_BUCKET: submissionBucket,
    ADMIN_TOKEN: 'test-token',
  },
  request: new Request('https://www.example.test/api/feedback', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '127.0.0.1',
    },
    body: JSON.stringify({
      type: 'site_bug',
      description: '测试反馈内容已经超过十个字。',
      contact: '',
      context: { entry: { path: ['测试目录'] } },
    }),
  }),
  waitUntil() {},
});
const submissionData = await submissionResponse.json();
assert.equal(submissionResponse.status, 201, JSON.stringify(submissionData));
const submittedKey = [...submissionBucket.objects.keys()]
  .find(key => key.startsWith('feedback/pending/') && key.endsWith('.json'));
assert.ok(submittedKey, '新反馈应写入 pending 目录');
const submittedRecord = JSON.parse(submissionBucket.objects.get(submittedKey));
assert.equal(submittedRecord.status, 'pending');
assert.equal(submittedRecord.progressStatus, 'unread');
assert.equal(submittedRecord.adminReply, '');
assert.ok(submittedRecord.progressStatusUpdatedAt > 0);

console.log('admin feedback memory flow: PASS');
