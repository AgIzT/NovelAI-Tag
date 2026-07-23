'use strict';

import { json, err, requireAdmin, validId, listAll, cleanLine, readJson } from '../../_lib.js';
import { updatePublicFeedbackIndex } from '../../_feedback.js';

const STATUSES = new Set(['pending', 'resolved', 'ignored']);

export async function onRequestPost(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const { request, env } = context;
  if (!env.STRINGS_BUCKET) return err('服务端未绑定存储桶 STRINGS_BUCKET', 503);

  let body;
  try { body = await request.json(); } catch { return err('请求格式错误'); }
  const id = String(body?.id || '');
  const status = cleanLine(body?.status, 20);
  if (!validId(id)) return err('无效的反馈 id');
  if (!STATUSES.has(status)) return err('反馈状态无效');

  const keys = (await listAll(env.STRINGS_BUCKET, `feedback/${status}/`))
    .filter(key => key.endsWith(`/${id}.json`) || key.endsWith(`${id}.json`));
  const recordKey = keys[0] || '';
  if (!recordKey) return err('该反馈不存在或已被删除', 404);

  const record = await readJson(env.STRINGS_BUCKET, recordKey);
  if (record?.publicVisible === true) {
    await updatePublicFeedbackIndex(env.STRINGS_BUCKET, { removeIds: [id] });
  }
  await env.STRINGS_BUCKET.delete(recordKey);
  console.log(JSON.stringify({
    event: 'feedback_deleted',
    feedbackId: id,
    status,
  }));
  return json({ ok: true, id, status });
}
