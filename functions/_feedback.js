'use strict';

import { cleanLine, cleanText, listAll, readJson, readJsonBatch } from './_lib.js';

export const FEEDBACK_STATUSES = Object.freeze(['pending', 'resolved', 'ignored']);
export const FEEDBACK_REPLY_LIMIT = 2000;
export const FEEDBACK_PUBLIC_INDEX_KEY = 'feedback/public.json';
export const FEEDBACK_PUBLIC_LIMIT = 200;

export const FEEDBACK_PROGRESS = Object.freeze({
  unread: Object.freeze({
    label: '待查看',
    description: '维护者尚未查看这条反馈。',
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
    label: '暂不采纳',
    description: '评估后暂不采纳，具体原因请查看回复。',
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
    publicConsent: source.publicConsent === true,
    publicVisible: source.publicConsent === true && source.publicVisible === true,
    publicVisibleUpdatedAt: Number(source.publicVisibleUpdatedAt || 0),
    publicVisibleUpdatedAtIso: String(source.publicVisibleUpdatedAtIso || ''),
    handledAt: Number(source.handledAt || 0),
    handledAction: String(source.handledAction || ''),
    commitSha: String(source.commitSha || ''),
    cfRay: String(source.cfRay || ''),
    notification: sanitizeNotification(source.notification),
  };
}

export function sanitizePublicFeedbackRecord(record, status) {
  const source = record && typeof record === 'object' ? record : {};
  if (source.publicConsent !== true || source.publicVisible !== true) return null;
  const item = sanitizeAdminFeedbackRecord(source, status);
  if (!item.id) return null;
  const progress = FEEDBACK_PROGRESS[item.progressStatus] || FEEDBACK_PROGRESS.unread;
  return sanitizePublicFeedbackProjection({
    id: item.id,
    type: item.type,
    typeLabel: item.typeLabel,
    description: item.description,
    progressStatus: item.progressStatus,
    progressStatusLabel: progress.label,
    progressDescription: progress.description,
    adminReply: item.adminReply,
    createdAt: item.createdAt,
    progressStatusUpdatedAt: item.progressStatusUpdatedAt,
    replyUpdatedAt: item.replyUpdatedAt,
    updatedAt: Math.max(
      item.progressStatusUpdatedAt,
      item.replyUpdatedAt,
      item.publicVisibleUpdatedAt,
      item.createdAt,
    ),
    context: sanitizePublicContext(item.context),
  });
}

export function sanitizePublicFeedbackProjection(value) {
  const source = value && typeof value === 'object' ? value : {};
  const progressStatus = normalizeFeedbackProgressStatus(source.progressStatus, 'unread');
  const progress = FEEDBACK_PROGRESS[progressStatus];
  const id = cleanLine(source.id, 120);
  const type = cleanLine(source.type, 40) || 'site_bug';
  if (!id) return null;
  return {
    id,
    type,
    typeLabel: cleanLine(source.typeLabel, 80) || FEEDBACK_TYPE_LABELS[type] || type,
    description: cleanText(source.description, 1000),
    progressStatus,
    progressStatusLabel: progress.label,
    progressDescription: progress.description,
    adminReply: cleanText(source.adminReply, FEEDBACK_REPLY_LIMIT),
    createdAt: positiveTime(source.createdAt),
    progressStatusUpdatedAt: positiveTime(source.progressStatusUpdatedAt),
    replyUpdatedAt: positiveTime(source.replyUpdatedAt),
    updatedAt: positiveTime(source.updatedAt),
    context: sanitizePublicContext(source.context),
  };
}

export async function updatePublicFeedbackIndex(
  bucket,
  { upsertRecord = null, upsertStatus = '', removeIds = [] } = {},
) {
  const index = await readJson(bucket, FEEDBACK_PUBLIC_INDEX_KEY);
  const byId = publicFeedbackMap(index?.items);
  const sizeBeforeRemoval = byId.size;
  let removedFromIndex = false;
  for (const id of removeIds || []) {
    removedFromIndex = byId.delete(String(id || '')) || removedFromIndex;
  }
  if (
    removedFromIndex
    && sizeBeforeRemoval >= FEEDBACK_PUBLIC_LIMIT
    && !upsertRecord
  ) {
    return rebuildPublicFeedbackIndex(bucket, { excludeIds: removeIds });
  }
  if (upsertRecord && typeof upsertRecord === 'object') {
    const id = String(upsertRecord.id || '');
    const item = sanitizePublicFeedbackRecord(upsertRecord, upsertStatus);
    if (item) byId.set(item.id, item);
    else if (id) byId.delete(id);
  }
  return writePublicFeedbackIndex(bucket, byId.values());
}

export async function rebuildPublicFeedbackIndex(bucket, { excludeIds = [] } = {}) {
  const excluded = new Set(Array.from(excludeIds || [], value => String(value || '')));
  const groups = await Promise.all(FEEDBACK_STATUSES.map(async status => {
    const keys = (await listAll(bucket, `feedback/${status}/`))
      .filter(key => key.endsWith('.json'));
    const records = await readJsonBatch(bucket, keys);
    return records
      .map(record => sanitizePublicFeedbackRecord(record, status))
      .filter(item => item && !excluded.has(item.id));
  }));
  const byId = new Map();
  for (const item of groups.flat()) {
    const current = byId.get(item.id);
    if (!current || item.updatedAt >= current.updatedAt) byId.set(item.id, item);
  }
  return writePublicFeedbackIndex(bucket, byId.values());
}

function publicFeedbackMap(items) {
  const byId = new Map();
  for (const value of Array.isArray(items) ? items : []) {
    const item = sanitizePublicFeedbackProjection(value);
    if (!item) continue;
    const current = byId.get(item.id);
    if (!current || item.updatedAt >= current.updatedAt) byId.set(item.id, item);
  }
  return byId;
}

async function writePublicFeedbackIndex(bucket, items) {
  const now = new Date();
  const payload = {
    version: 1,
    updatedAt: now.getTime(),
    updatedAtIso: now.toISOString(),
    items: [...items]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, FEEDBACK_PUBLIC_LIMIT),
  };
  await bucket.put(FEEDBACK_PUBLIC_INDEX_KEY, JSON.stringify(payload), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  return payload;
}

function sanitizePublicContext(value) {
  const source = value && typeof value === 'object' ? value : {};
  const codexSource = source.codex && typeof source.codex === 'object' ? source.codex : {};
  const entrySource = source.entry && typeof source.entry === 'object' ? source.entry : {};
  const codex = {
    id: cleanLine(codexSource.id, 120),
    title: cleanLine(codexSource.title, 160),
  };
  const entry = {
    id: cleanLine(entrySource.id, 160),
    title: cleanLine(entrySource.title, 200),
    path: Array.isArray(entrySource.path)
      ? entrySource.path.map(value => cleanLine(value, 120)).filter(Boolean).slice(0, 12)
      : [],
  };
  return {
    codex: codex.id || codex.title ? codex : null,
    entry: entry.id || entry.title || entry.path.length ? entry : null,
  };
}

function positiveTime(value) {
  const time = Number(value || 0);
  return Number.isFinite(time) && time > 0 ? time : 0;
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
