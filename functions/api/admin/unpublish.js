'use strict';

import { json, err, requireAdmin, requireStorage, validId, readJson, deleteImages, rebuildCommunity } from '../../_lib.js';

// POST /api/admin/unpublish — 下架已发布的投稿：{id}
// 删除记录与图片后重新生成发布文件
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

  const key = `community/approved/${id}.json`;
  const rec = await readJson(env.STRINGS_BUCKET, key);
  if (!rec) return err('该投稿不在已发布列表', 404);

  await deleteImages(env, id);
  await env.STRINGS_BUCKET.delete(key);
  const data = await rebuildCommunity(env);
  return json({ ok: true, published: data.entries.length });
}
