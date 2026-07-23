'use strict';

import {
  json, err, requireAdmin, requireStorage, validId, readJson,
  applyCommunityEdits, moveCommunityRecord,
} from '../../_lib.js';

// POST /api/admin/decide — 审核：{id, action:"approve"|"reject", edits?}
// approve 可附带 edits（维护者在管理页修正过的字段），通过后重新生成发布文件
export async function onRequestPost(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const { env } = context;
  const noStorage = requireStorage(env);
  if (noStorage) return noStorage;

  let body;
  try { body = await context.request.json(); } catch { return err('请求格式错误'); }
  const id = String(body.id || '');
  if (!validId(id)) return err('无效的投稿 id');

  const pendKey = `community/pending/${id}.json`;
  const rec = await readJson(env.STRINGS_BUCKET, pendKey);
  if (!rec) return err('该投稿不存在或已被处理', 404);
  const found = { status: 'pending', key: pendKey, record: rec };

  if (body.action === 'reject') {
    await moveCommunityRecord(env, found, 'rejected', { now: Date.now() });
    return json({ ok: true, action: 'reject' });
  }

  if (body.action === 'approve') {
    const result = applyCommunityEdits(rec, body.edits || {});
    if (result.error) return err(result.error);
    const now = Date.now();
    await moveCommunityRecord(env, { ...found, record: result.record }, 'approved', {
      now,
      fields: { reviewedAt: now, publishedAt: now, hiddenAt: 0, deletedAt: 0 },
    });
    return json({ ok: true, action: 'approve' });
  }

  return err('未知操作');
}
