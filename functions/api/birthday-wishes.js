import { json } from '../_lib.js';
import { isSameOriginWrite } from '../_engagements.js';
import { addWishes, readWishCount, readWishTotal } from '../_birthday_wishes.js';

// 所长生日「送上祝福」：GET 读今年总数，POST 加一批。没有绑定或没建表一律 enabled:false。
export async function onRequestGet({ env }) {
  return json(await readWishTotal(env));
}

export async function onRequestPost({ request, env }) {
  if (!isSameOriginWrite(request) || ['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site'))) {
    return json({ enabled: false }, 403);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    return json({ enabled: true, accepted: false }, 415);
  }
  const body = await readWishCount(request);
  if (!body.count) return json({ enabled: true, accepted: false }, body.status);
  const result = await addWishes(env, request, body.count);
  if (!result.enabled) return json({ enabled: false });
  if (!result.open) return json({ enabled: true, open: false, accepted: false });
  const payload = { enabled: true, open: true, accepted: result.accepted, total: result.total };
  if (!result.accepted) return json(payload, 429, { 'retry-after': String(result.retryAfter) });
  return json(payload);
}
