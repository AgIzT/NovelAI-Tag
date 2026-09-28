'use strict';

import { err, json } from '../../_lib.js';
import { errorMessage, isSameOriginWrite } from '../../_engagements.js';
import {
  consumePickupRateLimit, createPickup, formatPickupCode, pickupAvailable,
  readPickupBody, validPickupPayload, PICKUP_MAX_PAYLOAD_CHARS,
} from '../../_pickup.js';

// 生成取件码：暂存一份 NAITAG1. 迁移文本，10 分钟内取用一次。
export async function onRequestPost(context) {
  const { env, request } = context;
  if (!pickupAvailable(env)) return err('取件码暂不可用', 503);
  if (!isSameOriginWrite(request)) return err('仅接受同源请求', 403);

  const body = await readPickupBody(request);
  if (body.error) return err(body.error, body.status);
  const payload = body.data.payload;
  if (typeof payload === 'string' && payload.length > PICKUP_MAX_PAYLOAD_CHARS) {
    return err('收藏数据太大，请改用 JSON 文件', 413);
  }
  if (!validPickupPayload(payload)) return err('迁移文本格式无效');

  try {
    const rate = await consumePickupRateLimit(env, request, 'create');
    if (!rate.allowed) {
      return json(
        { ok: false, error: '生成太频繁，请稍后再试' },
        429,
        { 'retry-after': String(rate.retryAfter) },
      );
    }
    const created = await createPickup(env, payload);
    if (!created) return err('取件服务繁忙，请稍后再试', 503);
    return json({ ok: true, code: formatPickupCode(created.code), expiresAt: created.expiresAt });
  } catch (error) {
    console.error(JSON.stringify({ message: 'favorites pickup create failed', error: errorMessage(error) }));
    return err('取件码暂不可用', 503);
  }
}
