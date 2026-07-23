'use strict';

import { err, json, readJson } from '../_lib.js';
import {
  FEEDBACK_PUBLIC_INDEX_KEY,
  sanitizePublicFeedbackProjection,
} from '../_feedback.js';

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.STRINGS_BUCKET) return err('服务端未绑定存储桶 STRINGS_BUCKET', 503);

  const index = await readJson(env.STRINGS_BUCKET, FEEDBACK_PUBLIC_INDEX_KEY);
  const items = (Array.isArray(index?.items) ? index.items : [])
    .map(sanitizePublicFeedbackProjection)
    .filter(Boolean);
  const closed = items.filter(item => (
    item.progressStatus === 'completed' || item.progressStatus === 'declined'
  )).length;

  return json({
    ok: true,
    updatedAt: Number(index?.updatedAt || 0),
    summary: {
      total: items.length,
      open: items.length - closed,
      closed,
    },
    items,
  });
}
