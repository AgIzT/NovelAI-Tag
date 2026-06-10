'use strict';

import { json, requireAdmin, requireStorage, listAll, readJsonBatch, toEntry } from '../../_lib.js';

// GET /api/admin/pending — 待审投稿列表（需 Authorization: Bearer <ADMIN_TOKEN>）
export async function onRequestGet(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const { env } = context;
  const noStorage = requireStorage(env);
  if (noStorage) return noStorage;

  const keys = (await listAll(env.STRINGS_BUCKET, 'community/pending/')).filter(k => k.endsWith('.json'));
  const records = await readJsonBatch(env.STRINGS_BUCKET, keys);
  records.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); // 先来先审
  return json({ ok: true, items: records.map(r => toEntry(env, r)) });
}
