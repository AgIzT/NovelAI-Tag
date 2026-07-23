'use strict';

import { cleanLine, cleanText, listAll, readJson } from './_lib.js';

export const FEEDBACK_STATUSES = Object.freeze(['pending', 'resolved', 'ignored']);
export const FEEDBACK_REPLY_LIMIT = 2000;

export const FEEDBACK_PROGRESS = Object.freeze({
  unread: Object.freeze({
    label: '待查看',
    description: '尚未人工查看这条反馈。',
    status: 'pending',
  }),
  accepted: Object.freeze({
    label: '已受理',
    description: '已经查看并纳入处理队列。',
    status: 'pending',
  }),
  investigating: Object.freeze({
    label: '调查中',
    description: '正在复现问题、确认原因和影响范围。',
    status: 'pending',
  }),
  in_progress: Object.freeze({
    label: '处理中',
    description: '已经开始修复、调整或实施。',
    status: 'pending',
  }),
  verifying: Object.freeze({
    label: '待验证',
    description: '处理方案已经完成，正在验证结果。',
    status: 'pending',
  }),
  deferred: Object.freeze({
    label: '暂缓处理',
    description: '反馈有效，但当前暂不排期处理。',
    status: 'pending',
  }),
  completed: Object.freeze({
    label: '已完成',
    description: '处理结果已经完成并确认。',
    status: 'resolved',
  }),
  declined: Object.freeze({
    label: '不予处理',
    description: '评估后决定不处理，具体原因应写在回复中。',
    status: 'ignored',
  }),
});
export const FEEDBACK_PROGRESS_STATUSES = Object.freeze(Object.keys(FEEDBACK_PROGRESS));

export const FEEDBACK_TYPE_LABELS = Object.freeze({
  site_bug: '站点 Bug / 使用问题',
  card_content: '卡片内容错误',
  image_error: '图片加载 / 配图问题',
  copy_error: '复制结果问题',
  suggestion: '建议 / 想法',
});

export function normalizeFeedbackStatus(value, fallback = '') {
  const status = cleanLine(value, 20);
  return FEEDBACK_STATUSES.includes(status) ? status : fallback;
}

export function normalizeFeedbackProgressStatus(value, fallback = '') {
  const status = cleanLine(value, 30);
  return FEEDBACK_PROGRESS_STATUSES.includes(status) ? status : fallback;
}

export function feedbackStatusForProgress(progressStatus) {
  const progress = FEEDBACK_PROGRESS[normalizeFeedbackProgressStatus(progressStatus)];
  return progress?.status || '';
}

export function defaultFeedbackProgressStatus(status) {
  const normalized = normalizeFeedbackStatus(status, 'pending');
  if (normalized === 'resolved') return 'completed';
  if (normalized === 'ignored') return 'declined';
  return 'unread';
}

export function feedbackRecordKey(status, id, date = new Date()) {
  const normalized = normalizeFeedbackStatus(status, 'pending');
  return `feedback/${normalized}/${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${id}.json`;
}

export async function findFeedbackRecord(bucket, id, preferredStatus = '') {
  const preferred = normalizeFeedbackStatus(preferredStatus);
  const statuses = preferred ? [preferred] : FEEDBACK_STATUSES;
  for (const status of statuses) {
    const keys = await listAll(bucket, `feedback/${status}/`);
    const key = keys.find(item => item.endsWith(`/${id}.json`) || item.endsWith(`${id}.json`));
    if (!key) continue;
    const record = await readJson(bucket, key);
    if (record) return { status, key, record };
  }
  return null;
}

export function sanitizeAdminFeedbackRecord(record, status) {
  const source = record && typeof record === 'object' ? record : {};
  const type = String(source.type || 'site_bug');
  const currentStatus = normalizeFeedbackStatus(status)
    || normalizeFeedbackStatus(source.status, 'pending');
  const storedProgressStatus = normalizeFeedbackProgressStatus(
    source.progressStatus,
    defaultFeedbackProgressStatus(currentStatus),
  );
  const progressStatus = feedbackStatusForProgress(storedProgressStatus) === currentStatus
    ? storedProgressStatus
    : defaultFeedbackProgressStatus(currentStatus);
  return {
    id: String(source.id || ''),
    status: currentStatus,
    previousStatus: normalizeFeedbackStatus(source.previousStatus),
    progressStatus,
    progressStatusLabel: FEEDBACK_PROGRESS[progressStatus].label,
    previousProgressStatus: normalizeFeedbackProgressStatus(source.previousProgressStatus),
    type,
    typeLabel: FEEDBACK_TYPE_LABELS[type] || type,
    description: String(source.description || ''),
    contact: String(source.contact || ''),
    context: source.context && typeof source.context === 'object' ? source.context : {},
    createdAt: Number(source.createdAt || Date.parse(source.receivedAt) || 0),
    receivedAt: String(source.receivedAt || ''),
    statusUpdatedAt: Number(source.statusUpdatedAt || source.handledAt || source.createdAt || 0),
    statusUpdatedAtIso: String(source.statusUpdatedAtIso || source.handledAtIso || ''),
    progressStatusUpdatedAt: Number(
      source.progressStatusUpdatedAt
      || source.statusUpdatedAt
      || source.handledAt
      || source.createdAt
      || 0
    ),
    progressStatusUpdatedAtIso: String(
      source.progressStatusUpdatedAtIso
      || source.statusUpdatedAtIso
      || source.handledAtIso
      || ''
    ),
    adminReply: cleanText(source.adminReply, FEEDBACK_REPLY_LIMIT),
    replyUpdatedAt: Number(source.replyUpdatedAt || 0),
    replyUpdatedAtIso: String(source.replyUpdatedAtIso || ''),
    handledAt: Number(source.handledAt || 0),
    handledAction: String(source.handledAction || ''),
    commitSha: String(source.commitSha || ''),
    cfRay: String(source.cfRay || ''),
    notification: sanitizeNotification(source.notification),
  };
}

function sanitizeNotification(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    provider: String(value.provider || ''),
    status: String(value.status || ''),
    attemptedAt: String(value.attemptedAt || ''),
    completedAt: String(value.completedAt || ''),
    httpStatus: Number(value.httpStatus || 0),
    code: value.code == null ? null : Number(value.code),
    message: String(value.message || ''),
  };
}

function pad(value) {
  return String(value).padStart(2, '0');
}
