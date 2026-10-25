'use strict';

import { json, err, requireAdmin, cleanLine } from '../../_lib.js';
import {
  normalizeFeedbackStatus,
} from '../../_feedback.js';
import { readAdminFeedbackList } from '../../_feedback-list.js';

export async function onRequestGet(context) {
  const denied = await requireAdmin(context);
  if (denied) return denied;
  const { request, env } = context;
  if (!env.STRINGS_BUCKET) return err('服务端未绑定存储桶 STRINGS_BUCKET', 503);

  const url = new URL(request.url);
  const status = cleanLine(url.searchParams.get('status'), 20) || 'pending';
  if (!normalizeFeedbackStatus(status)) return err('反馈状态无效');

  try {
    const result = await readAdminFeedbackList(env.STRINGS_BUCKET, status, env.ADMIN_TOKEN, { cursor: url.searchParams.get('cursor') || '' });
    return json({ ok: true, status, ...result }, result.indexing ? 202 : 200);
  } catch (error) {
    if (error?.resetPagination) return json({ ok: false, error: error.message, resetPagination: true }, 409);
    if (error?.status === 400) return err(error.message, 400);
    return err('反馈列表暂时无法完整加载，请稍后刷新重试', 503);
  }
}
