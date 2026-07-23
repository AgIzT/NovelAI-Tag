'use strict';

import { json, err, requireAdmin, listAll, readJsonBatch, cleanLine } from '../../_lib.js';
import {
  normalizeFeedbackStatus, sanitizeAdminFeedbackRecord,
} from '../../_feedback.js';

export async function onRequestGet(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const { request, env } = context;
  if (!env.STRINGS_BUCKET) return err('服务端未绑定存储桶 STRINGS_BUCKET', 503);

  const url = new URL(request.url);
  const status = cleanLine(url.searchParams.get('status'), 20) || 'pending';
  if (!normalizeFeedbackStatus(status)) return err('反馈状态无效');

  const keys = (await listAll(env.STRINGS_BUCKET, `feedback/${status}/`))
    .filter(k => k.endsWith('.json'));
  const records = await readJsonBatch(env.STRINGS_BUCKET, keys);
  const items = records
    .filter(Boolean)
    .map(record => sanitizeAdminFeedbackRecord(record, status))
    .sort((a, b) => sortTime(b) - sortTime(a))
    .slice(0, 200);

  return json({ ok: true, status, items });
}

function sortTime(item) {
  return [
    item.progressStatusUpdatedAt,
    item.replyUpdatedAt,
    item.statusUpdatedAt,
    item.handledAt,
    item.createdAt,
  ].reduce((latest, value) => Math.max(latest, Number(value) || 0), 0);
}
