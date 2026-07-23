'use strict';

import { json, err, requireAdmin, validId, cleanLine, cleanText } from '../../_lib.js';
import {
  FEEDBACK_REPLY_LIMIT,
  defaultFeedbackProgressStatus,
  feedbackRecordKey,
  feedbackStatusForProgress,
  findFeedbackRecord,
  normalizeFeedbackProgressStatus,
  normalizeFeedbackStatus,
  sanitizeAdminFeedbackRecord,
  updatePublicFeedbackIndex,
} from '../../_feedback.js';

const LEGACY_ACTION_STATUS = Object.freeze({
  resolve: 'resolved',
  ignore: 'ignored',
});

export async function onRequestPost(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const { request, env } = context;
  if (!env.STRINGS_BUCKET) return err('服务端未绑定存储桶 STRINGS_BUCKET', 503);

  let body;
  try { body = await request.json(); } catch { return err('请求格式错误'); }
  const id = String(body?.id || '');
  const action = cleanLine(body?.action, 20);
  if (!validId(id)) return err('无效的反馈 id');
  if (action && action !== 'update' && !LEGACY_ACTION_STATUS[action]) return err('未知反馈操作');

  const sourceStatusRaw = cleanLine(body?.sourceStatus, 20);
  const sourceStatus = sourceStatusRaw ? normalizeFeedbackStatus(sourceStatusRaw) : '';
  if (sourceStatusRaw && !sourceStatus) return err('反馈来源状态无效');

  const targetStatusRaw = cleanLine(body?.targetStatus, 20);
  const requestedTargetStatus = targetStatusRaw ? normalizeFeedbackStatus(targetStatusRaw) : '';
  if (targetStatusRaw && !requestedTargetStatus) return err('反馈目标状态无效');
  const legacyTargetStatus = LEGACY_ACTION_STATUS[action] || '';
  if (requestedTargetStatus && legacyTargetStatus && requestedTargetStatus !== legacyTargetStatus) {
    return err('旧操作与目标状态冲突');
  }
  const requestedBucketStatus = requestedTargetStatus || legacyTargetStatus;

  const progressStatusRaw = cleanLine(body?.progressStatus, 30);
  const requestedProgressStatus = progressStatusRaw
    ? normalizeFeedbackProgressStatus(progressStatusRaw)
    : '';
  if (progressStatusRaw && !requestedProgressStatus) return err('反馈展示进度无效');

  const found = await findFeedbackRecord(env.STRINGS_BUCKET, id, sourceStatus);
  if (!found) return err('该反馈不存在或状态不匹配', 404);

  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const record = found.record;
  const currentItem = sanitizeAdminFeedbackRecord(record, found.status);
  const currentProgressStatus = currentItem.progressStatus;
  let progressStatus = requestedProgressStatus;
  if (!progressStatus) {
    if (!requestedBucketStatus || requestedBucketStatus === found.status) {
      progressStatus = currentProgressStatus;
    } else if (requestedBucketStatus === 'resolved') {
      progressStatus = 'completed';
    } else if (requestedBucketStatus === 'ignored') {
      progressStatus = 'declined';
    } else {
      progressStatus = 'accepted';
    }
  }
  progressStatus = normalizeFeedbackProgressStatus(
    progressStatus,
    defaultFeedbackProgressStatus(found.status),
  );
  const targetStatus = feedbackStatusForProgress(progressStatus);
  if (!targetStatus) return err('反馈展示进度无效');
  if (requestedProgressStatus && requestedBucketStatus && requestedBucketStatus !== targetStatus) {
    return err('展示进度与后台归档状态冲突');
  }

  const hasReply = Object.prototype.hasOwnProperty.call(body || {}, 'adminReply')
    || Object.prototype.hasOwnProperty.call(body || {}, 'reply');
  const currentReply = cleanText(record.adminReply, FEEDBACK_REPLY_LIMIT);
  let adminReply = currentReply;
  if (hasReply) {
    const rawReply = cleanText(body.adminReply ?? body.reply, FEEDBACK_REPLY_LIMIT + 1);
    if (rawReply.length > FEEDBACK_REPLY_LIMIT) {
      return err(`回复最多 ${FEEDBACK_REPLY_LIMIT} 个字`);
    }
    adminReply = rawReply;
  }

  const hasPublicVisible = Object.prototype.hasOwnProperty.call(body || {}, 'publicVisible');
  if (hasPublicVisible && typeof body.publicVisible !== 'boolean') {
    return err('公开展示设置无效');
  }
  const publicConsent = record.publicConsent === true;
  const currentPublicVisible = publicConsent && record.publicVisible === true;
  const publicVisible = hasPublicVisible ? body.publicVisible === true : currentPublicVisible;
  if (publicVisible && !publicConsent) {
    return err('反馈者已选择不公开，不能开启公开展示');
  }

  const statusChanged = found.status !== targetStatus;
  const progressChanged = currentProgressStatus !== progressStatus;
  const replyChanged = currentReply !== adminReply;
  const publicVisibleChanged = currentPublicVisible !== publicVisible;
  const nextRecord = {
    ...record,
    status: targetStatus,
    statusUpdatedAt: statusChanged
      ? nowMs
      : Number(record.statusUpdatedAt || record.handledAt || record.createdAt || nowMs),
    statusUpdatedAtIso: statusChanged
      ? nowIso
      : String(record.statusUpdatedAtIso || record.handledAtIso || ''),
    progressStatus,
    progressStatusUpdatedAt: progressChanged
      ? nowMs
      : Number(currentItem.progressStatusUpdatedAt || record.createdAt || nowMs),
    progressStatusUpdatedAtIso: progressChanged
      ? nowIso
      : String(currentItem.progressStatusUpdatedAtIso || record.receivedAt || ''),
    adminReply,
    replyUpdatedAt: replyChanged ? nowMs : Number(record.replyUpdatedAt || 0),
    replyUpdatedAtIso: replyChanged ? nowIso : String(record.replyUpdatedAtIso || ''),
    publicConsent,
    publicVisible,
    publicVisibleUpdatedAt: publicVisibleChanged
      ? nowMs
      : Number(record.publicVisibleUpdatedAt || 0),
    publicVisibleUpdatedAtIso: publicVisibleChanged
      ? nowIso
      : String(record.publicVisibleUpdatedAtIso || ''),
  };
  if (progressChanged) nextRecord.previousProgressStatus = currentProgressStatus;
  if (statusChanged) {
    nextRecord.previousStatus = found.status;
    nextRecord.handledAction = targetStatus === 'resolved'
      ? 'resolve'
      : targetStatus === 'ignored'
        ? 'ignore'
        : 'reopen';
    if (targetStatus === 'pending') {
      nextRecord.handledAt = 0;
      nextRecord.handledAtIso = '';
    } else {
      nextRecord.handledAt = nowMs;
      nextRecord.handledAtIso = nowIso;
    }
  }

  const nextKey = statusChanged ? feedbackRecordKey(targetStatus, id, now) : found.key;
  if (currentPublicVisible && !publicVisible) {
    await updatePublicFeedbackIndex(env.STRINGS_BUCKET, { removeIds: [id] });
  }
  await env.STRINGS_BUCKET.put(nextKey, JSON.stringify(nextRecord), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  if (nextKey !== found.key) await env.STRINGS_BUCKET.delete(found.key);
  if (publicVisible) {
    await updatePublicFeedbackIndex(env.STRINGS_BUCKET, {
      upsertRecord: nextRecord,
      upsertStatus: targetStatus,
    });
  }
  return json({
    ok: true,
    id,
    action: action || 'update',
    status: targetStatus,
    previousStatus: found.status,
    progressStatus,
    previousProgressStatus: currentProgressStatus,
    item: sanitizeAdminFeedbackRecord(nextRecord, targetStatus),
  });
}
