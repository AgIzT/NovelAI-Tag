import { json } from '../../_lib.js';
import { decideMessage, listPending, requireModerator } from '../../_birthday_messages.js';

/* 审核 agent 专用（BIRTHDAY_MODERATOR_TOKEN）：只能列出待审留言，并把待审的改成通过 / 拒绝 / 留给维护者。
   碰不到已经处理过的留言、墙的开关和站里其它后台。 */
export async function onRequestGet(context) {
  const denied = await requireModerator(context);
  if (denied) return json({ ok: false, error: denied.error }, denied.status);
  const limit = Number(new URL(context.request.url).searchParams.get('limit')) || 20;
  return json(await listPending(context.env, limit));
}

export async function onRequestPost(context) {
  const denied = await requireModerator(context);
  if (denied) return json({ ok: false, error: denied.error }, denied.status);
  const body = await context.request.json().catch(() => null);
  const result = await decideMessage(context.env, body?.id, body?.decision, 'agent');
  if (result.invalid) return json({ ok: false, error: 'decision must be approve, reject or hold for a pending id' }, 400);
  return json(result);
}
