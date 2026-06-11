'use strict';

import {
  json, err, requireAdmin, requireStorage, validId, readJson, deleteImages, rebuildCommunity,
  cleanLine, cleanText, normTags, normCategory, LIMITS,
} from '../../_lib.js';

// POST /api/admin/decide — 审核：{id, action:"approve"|"reject", edits?}
// approve 可附带 edits（站长在管理页修正过的字段），通过后重新生成发布文件
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

  if (body.action === 'reject') {
    await deleteImages(env, id);
    await env.STRINGS_BUCKET.delete(pendKey);
    return json({ ok: true, action: 'reject' });
  }

  if (body.action === 'approve') {
    const e = body.edits || {};
    if (e.title != null) rec.title = cleanLine(e.title, LIMITS.title);
    if (e.prompt != null) rec.prompt = cleanText(e.prompt, LIMITS.prompt);
    if (e.negative != null) rec.negative = cleanText(e.negative, LIMITS.negative);
    if (e.comment != null) rec.comment = cleanText(e.comment, LIMITS.comment);
    if (e.submitter != null) rec.submitter = cleanLine(e.submitter, LIMITS.submitter);
    if (e.tags != null) rec.tags = normTags(e.tags);
    if (e.category != null) rec.category = normCategory(e.category);
    if (e.nsfw != null) rec.nsfw = !!e.nsfw;
    if (!rec.title) return err('标题不能为空');
    if (!rec.prompt) return err('画风串内容不能为空');

    rec.reviewedAt = Date.now();
    await env.STRINGS_BUCKET.put(`community/approved/${id}.json`, JSON.stringify(rec), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
    await env.STRINGS_BUCKET.delete(pendKey);
    const data = await rebuildCommunity(env);
    return json({ ok: true, action: 'approve', published: data.entries.length });
  }

  return err('未知操作');
}
