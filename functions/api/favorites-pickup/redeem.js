'use strict';

import { err, json } from '../../_lib.js';
import { errorMessage, isSameOriginWrite } from '../../_engagements.js';
import {
  consumePickupRateLimit, normalizePickupCode, pickupAvailable, readPickupBody, redeemPickup,
} from '../../_pickup.js';

// 取件：码放在请求体里，不进 URL；取到即删除。
export async function onRequestPost(context) {
  const { env, request } = context;
  if (!pickupAvailable(env)) return err('取件码暂不可用', 503);
  if (!isSameOriginWrite(request)) return err('仅接受同源请求', 403);

  const body = await readPickupBody(request);
  if (body.error) return err(body.error, body.status);

  try {
    // 先计数再校验格式，乱填也算尝试次数。
    const rate = await consumePickupRateLimit(env, request, 'redeem');
    if (!rate.allowed) {
      return json(
        { ok: false, error: '尝试太频繁，请稍后再试' },
        429,
        { 'retry-after': String(rate.retryAfter) },
      );
    }
    const code = normalizePickupCode(body.data.code);
    if (!code) return err('取件码应为 8 位字母或数字');
    const payload = await redeemPickup(env, code);
    if (!payload) return err('取件码无效、已过期或已被取用', 404);
    return json({ ok: true, payload });
  } catch (error) {
    console.error(JSON.stringify({ message: 'favorites pickup redeem failed', error: errorMessage(error) }));
    return err('取件码暂不可用', 503);
  }
}
