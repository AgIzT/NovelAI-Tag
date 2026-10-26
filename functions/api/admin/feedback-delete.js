'use strict';

import { json, err, requireAdmin, validId, cleanLine } from '../../_lib.js';
import { readCanonical, writeCanonical, deleteLegacyRecords } from '../../_record-store.js';
import { cleanRecordMarkers } from '../../_record-index.js';
import { updatePublicFeedbackIndex, findFeedbackRecord, FEEDBACK_STATUSES } from '../../_feedback.js';

const STATUSES = new Set(['pending', 'resolved', 'ignored']);

export async function onRequestPost(context) {
  const denied = await requireAdmin(context);
  if (denied) return denied;
  const { request, env } = context;
  if (!env.STRINGS_BUCKET) return err('服务端未绑定存储桶 STRINGS_BUCKET', 503);

  let body;
  try { body = await request.json(); } catch { return err('请求格式错误'); }
  const id = String(body?.id || '');
  const status = cleanLine(body?.status, 20);
  if (!validId(id)) return err('无效的反馈 id');
  if (!STATUSES.has(status)) return err('反馈状态无效');

  try {
    let found = await readCanonical(env.STRINGS_BUCKET, 'feedback', id);
    if (found?.deleted) await cleanRecordMarkers(env.STRINGS_BUCKET, 'feedback', found);
    if (!found?.deleted) {
      found = await findFeedbackRecord(env.STRINGS_BUCKET, id, status);
      if (!found) return err('这条反馈不存在或状态已变化，点「刷新反馈」重新加载', 404);
      await writeCanonical(env.STRINGS_BUCKET, 'feedback', id, found, { status: found.status, deleted: true });
    }
    await updatePublicFeedbackIndex(env.STRINGS_BUCKET, { removeIds: [id] });
    await deleteLegacyRecords(env.STRINGS_BUCKET, 'feedback', id, FEEDBACK_STATUSES);
  } catch (error) { return err(error.message || '反馈清理失败，请重试删除', error.status || 503); }
  console.log(JSON.stringify({
    event: 'feedback_deleted',
    feedbackId: id,
    status,
  }));
  return json({ ok: true, id, status });
}
