import { json, requireAdmin } from '../../_lib.js';
import { adminOverview, decideMessage, setWall } from '../../_birthday_messages.js';

// 维护者（ADMIN_TOKEN）：看全部留言与计数，改任意一条的状态，整面祝福墙开关。页面在 site/birthday-review.html。
export async function onRequestGet(context) {
  const denied = await requireAdmin(context);
  if (denied) return denied;
  return json(await adminOverview(context.env));
}

export async function onRequestPost(context) {
  const denied = await requireAdmin(context);
  if (denied) return denied;
  const body = await context.request.json().catch(() => null);
  if (body?.action === 'wall') return json(await setWall(context.env, body.on === true));
  const result = await decideMessage(context.env, body?.id, body?.action, 'admin');
  if (result.invalid) return json({ ok: false, error: '操作无效' }, 400);
  return json(result);
}
