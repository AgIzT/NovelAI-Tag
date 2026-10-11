'use strict';

import { err, json, readCommunityRecord, validId } from '../../_lib.js';
import {
  communityLikesAvailable, consumeCommunityLikeRateLimit, createLikeActor,
  errorMessage, isSameOriginWrite, readCommunityLikeCount, readLikeActor,
  setCommunityLike,
} from '../../_engagements.js';

export async function onRequestPut(context) {
  return handleLikeWrite(context, true);
}

export async function onRequestDelete(context) {
  return handleLikeWrite(context, false);
}

async function handleLikeWrite(context, targetLiked) {
  const { env, request } = context;
  if (!communityLikesAvailable(env)) return err('喜欢功能暂不可用', 503);
  if (!isSameOriginWrite(request)) return err('仅接受同源请求', 403);
  if (!env.STRINGS_BUCKET) return err('服务端未绑定存储桶 STRINGS_BUCKET', 503);

  const id = routeId(context);
  if (!validId(id)) return err('投稿 id 无效');

  let actorId;
  let setCookie = '';
  try {
    actorId = await readLikeActor(request, env);
    if (targetLiked && !actorId) {
      const actor = await createLikeActor(env, request);
      actorId = actor.actorId;
      setCookie = actor.cookie;
    }

    const rate = await consumeCommunityLikeRateLimit(env, request, actorId);
    if (!rate.allowed) {
      return json(
        { ok: false, error: '操作太频繁，稍后再试' },
        429,
        { 'retry-after': String(rate.retryAfter) },
      );
    }

    const approved = await readCommunityRecord(env, 'approved', id);
    if (!approved) return err('该投稿不存在或当前不可互动', 404);

    if (!actorId) {
      const likeCount = await readCommunityLikeCount(env, id);
      return json({ ok: true, id, liked: false, likeCount });
    }

    const result = await setCommunityLike(env, id, actorId, targetLiked);
    if (targetLiked && result.tombstoned) return err('该投稿不存在或当前不可互动', 404);
    return json(
      { ok: true, id, liked: result.liked, likeCount: result.likeCount },
      200,
      responseHeaders(setCookie),
    );
  } catch (error) {
    console.error(JSON.stringify({
      message: 'community like write failed',
      id,
      method: request && request.method,
      error: errorMessage(error),
    }));
    return json(
      { ok: false, error: '喜欢功能暂不可用' },
      503,
      {},
    );
  }
}

function responseHeaders(cookie, extra = {}) {
  return cookie ? { ...extra, 'set-cookie': cookie } : extra;
}

function routeId(context) {
  const value = context.params && context.params.id;
  return String(Array.isArray(value) ? value[0] || '' : value || '');
}
