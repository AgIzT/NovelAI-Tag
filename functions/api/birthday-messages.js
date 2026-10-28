import { json } from '../_lib.js';
import { isSameOriginWrite } from '../_engagements.js';
import { readMessageBody, readWall, submitMessage } from '../_birthday_messages.js';

// 所长生日祝福墙：GET 读墙上最新的已通过留言，POST 交一条待审留言。没有绑定或没建表一律 enabled:false。
export async function onRequestGet({ env }) {
  return json(await readWall(env));
}

export async function onRequestPost({ request, env }) {
  if (!isSameOriginWrite(request) || ['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site'))) {
    return json({ enabled: false }, 403);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    return json({ enabled: true, accepted: false }, 415);
  }
  const input = await readMessageBody(request);
  if (input.status) return json({ enabled: true, accepted: false, reason: 'invalid' }, input.status);
  const result = await submitMessage(env, request, input);
  if (!result.enabled) return json({ enabled: false });
  if (result.reason === 'rate') return json(result, 429, { 'retry-after': '600' });
  return json(result, result.accepted ? 200 : 400);
}
