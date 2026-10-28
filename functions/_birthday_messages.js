import { clientIp, rateIdentifier } from './_engagements.js';
import { wishBinding, wishWindow } from './_birthday_wishes.js';

/* 所长生日祝福墙（前端 site/assets/app/birthday-wall.js）：先审后发。
   - 访客留言进 pending；审核 agent（BIRTHDAY_MODERATOR_TOKEN）只能把 pending 改成 approved / rejected / held；
     held 是「拿不准，留给维护者」。维护者（ADMIN_TOKEN）可以改任意一条，也能整面墙开关。
   - 墙上只出现 approved，按通过时间从新到旧。收留言的时段同「送上祝福」（wishWindow）。 */
export const MESSAGE_BODY_MAX = 60;
export const MESSAGE_NAME_MAX = 12;
export const WALL_LIMIT = 30;
export const MESSAGE_IP_LIMIT = 5;          // 每个 IP 每 10 分钟
export const MESSAGE_GLOBAL_LIMIT = 60;     // 全站每分钟
const MESSAGE_BODY_BYTES = 1024;
const MINUTE_MS = 60_000;
const IP_WINDOW_MS = 10 * MINUTE_MS;
const STATUSES = new Set(['pending', 'approved', 'held', 'rejected', 'hidden']);
const AGENT_DECISIONS = { approve: 'approved', reject: 'rejected', hold: 'held' };
const ADMIN_DECISIONS = { approve: 'approved', reject: 'rejected', hold: 'held', hide: 'hidden' };

// 链接、邮箱、五位以上连号（QQ / 手机）和常见引流词：服务器直接拒收，剩下的交给审核
const BLOCKED = [
  /https?:|www\.|:\/\//i,
  /[a-z0-9-]+\.(?:com|cn|net|org|top|xyz|io|me|cc|vip|club|site|link|gg|app|ly|to|tk)\b/i,
  /@/,
  /\d[\d\s-]{3,}\d/,
  /微信|威信|v信|vx|wx号|q群|qq群|加群|群号|扣扣|telegram|t\.me|discord|电报群/i,
];

export function cleanMessage(value, max) {
  const text = String(value ?? '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return [...text].length > max ? null : text;
}

export function messageKey(body) {
  return body.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

export function messageBlocked(text) {
  // 全角半角折叠后再查，ｗｗｗ、ＱＱ群之类绕不过去；存进库的仍是原文
  const folded = text.normalize('NFKC');
  return BLOCKED.some(re => re.test(folded));
}

async function readSetting(db, key) {
  const row = await db.prepare('SELECT value FROM birthday_settings WHERE key = ?').bind(key).first();
  return row?.value ?? null;
}

async function wallOn(db) {
  return (await readSetting(db, 'wall')) !== 'off';
}

const publicRow = row => ({ id: row.id, body: row.body, name: row.name, at: row.decided_at || row.created_at });

export async function readWall(env, now = Date.now()) {
  const db = wishBinding(env);
  if (!db) return { enabled: false };
  const { year, open } = wishWindow(now);
  try {
    if (!await wallOn(db)) return { enabled: true, wall: false, open, messages: [] };
    const result = await db.batch([
      db.prepare(`SELECT id, body, name, created_at, decided_at FROM birthday_messages
        WHERE year = ? AND status = 'approved' ORDER BY decided_at DESC, id DESC LIMIT ?`).bind(year, WALL_LIMIT),
      db.prepare(`SELECT COUNT(*) AS n FROM birthday_messages WHERE year = ? AND status = 'approved'`).bind(year),
    ]);
    return {
      enabled: true, wall: true, open,
      total: Number(result[1].results?.[0]?.n) || 0,
      messages: (result[0].results || []).map(publicRow),
    };
  } catch { return { enabled: false }; }
}

/** 只收 {"body": "...", "name": "..."}；name 可省 */
export async function readMessageBody(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MESSAGE_BODY_BYTES)) return { status: 413 };
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MESSAGE_BODY_BYTES) return { status: 413 };
    // 不是合法 UTF-8 就整条拒收，免得库里存进一串替换字符
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : null;
    if (!keys || !keys.includes('body') || keys.some(key => key !== 'body' && key !== 'name')
      || typeof data.body !== 'string' || (data.name !== undefined && typeof data.name !== 'string')) return { status: 400 };
    return { body: data.body, name: data.name ?? '' };
  } catch { return { status: 400 }; }
}

export async function submitMessage(env, request, input, now = Date.now()) {
  const db = wishBinding(env);
  if (!db) return { enabled: false };
  const { year, open } = wishWindow(now);
  const body = cleanMessage(input.body, MESSAGE_BODY_MAX);
  const name = cleanMessage(input.name, MESSAGE_NAME_MAX);
  if (body === null || name === null) return { enabled: true, accepted: false, reason: 'too_long' };
  const key = messageKey(body);
  if (!key) return { enabled: true, accepted: false, reason: 'empty' };
  if (messageBlocked(body) || messageBlocked(name)) return { enabled: true, accepted: false, reason: 'blocked' };
  try {
    if (!await wallOn(db)) return { enabled: true, accepted: false, reason: 'off' };
    if (!open) return { enabled: true, accepted: false, reason: 'closed' };
    const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    const slot = Math.floor(now / IP_WINDOW_MS) * IP_WINDOW_MS;
    const salt = String(env.RATE_LIMIT_SALT || '').trim();
    const ipBucket = salt ? `msg:ip:${await rateIdentifier(salt, 'birthday-message', clientIp(request))}` : '';
    const bump = (bucket, start, expires) => db.prepare(`INSERT INTO birthday_wish_rate (bucket, window_start, amount, expires_at)
      VALUES (?, ?, 1, ?) ON CONFLICT (bucket, window_start) DO UPDATE SET amount = birthday_wish_rate.amount + 1`)
      .bind(bucket, start, expires);
    const within = `(SELECT amount FROM birthday_wish_rate WHERE bucket = 'msg:all' AND window_start = ?1) <= ?2
      AND COALESCE((SELECT amount FROM birthday_wish_rate WHERE bucket = ?3 AND window_start = ?4), 0) <= ?5`;
    const id = crypto.randomUUID();
    // 同年同样的话撞唯一索引就不再插入，但照样回「已收到」，刷屏的人看不出被合并了
    const results = await db.batch([
      db.prepare('DELETE FROM birthday_wish_rate WHERE expires_at <= ?').bind(now),
      bump('msg:all', minute, minute + 2 * MINUTE_MS),
      ...(ipBucket ? [bump(ipBucket, slot, slot + 2 * IP_WINDOW_MS)] : []),
      db.prepare(`INSERT OR IGNORE INTO birthday_messages (id, year, body, name, body_key, status, created_at)
        SELECT ?6, ?7, ?8, ?9, ?10, 'pending', ?11 WHERE ${within}`)
        .bind(minute, MESSAGE_GLOBAL_LIMIT, ipBucket, slot, MESSAGE_IP_LIMIT, id, year, body, name, key, now),
      db.prepare(`SELECT (${within}) AS allowed`).bind(minute, MESSAGE_GLOBAL_LIMIT, ipBucket, slot, MESSAGE_IP_LIMIT),
    ]);
    if (results.some(result => result.success === false)) return { enabled: false };
    if (Number(results.at(-1).results?.[0]?.allowed) !== 1) return { enabled: true, accepted: false, reason: 'rate' };
    return { enabled: true, accepted: true };
  } catch { return { enabled: false }; }
}

/* ---------- 审核 agent ---------- */

export async function requireModerator({ request, env }) {
  const expected = String(env?.BIRTHDAY_MODERATOR_TOKEN || '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(expected)) return { status: 503, error: 'Moderation is not configured' };
  const match = (request.headers.get('authorization') || '').match(/^Bearer ([A-Za-z0-9_-]{43})$/i);
  if (!match) return { status: 401, error: 'Unauthorized' };
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([match[1], expected].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0 ? null : { status: 401, error: 'Unauthorized' };
}

export async function listPending(env, limit = 20) {
  const db = wishBinding(env);
  if (!db) return { enabled: false };
  try {
    const rows = await db.prepare(`SELECT id, body, name, created_at FROM birthday_messages
      WHERE status = 'pending' ORDER BY created_at, id LIMIT ?`).bind(Math.max(1, Math.min(50, limit))).all();
    return { enabled: true, messages: (rows.results || []).map(row => ({ id: row.id, body: row.body, name: row.name, at: row.created_at })) };
  } catch { return { enabled: false }; }
}

/** by='agent' 只能改 pending；by='admin' 可以改任意一条（含隐藏已上墙的） */
export async function decideMessage(env, id, decision, by, now = Date.now()) {
  const db = wishBinding(env);
  if (!db) return { enabled: false };
  const status = (by === 'admin' ? ADMIN_DECISIONS : AGENT_DECISIONS)[decision];
  if (!status || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return { enabled: true, changed: false, invalid: true };
  try {
    const results = await db.batch([
      db.prepare(`UPDATE birthday_messages SET status = ?, decided_at = ?, decided_by = ?
        WHERE id = ?${by === 'admin' ? '' : " AND status = 'pending'"}`).bind(status, now, by, id),
      db.prepare('SELECT changes() AS n'),
    ]);
    return { enabled: true, changed: Number(results[1].results?.[0]?.n) > 0 };
  } catch { return { enabled: false }; }
}

/* ---------- 维护者 ---------- */

export async function adminOverview(env, now = Date.now()) {
  const db = wishBinding(env);
  if (!db) return { enabled: false };
  const { year } = wishWindow(now);
  try {
    const result = await db.batch([
      db.prepare(`SELECT id, body, name, status, created_at, decided_at, decided_by FROM birthday_messages
        WHERE year = ? ORDER BY CASE status WHEN 'held' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, created_at DESC LIMIT 500`).bind(year),
      db.prepare('SELECT status, COUNT(*) AS n FROM birthday_messages WHERE year = ? GROUP BY status').bind(year),
    ]);
    const counts = Object.fromEntries([...STATUSES].map(status => [status, 0]));
    for (const row of result[1].results || []) counts[row.status] = Number(row.n) || 0;
    return { enabled: true, wall: await wallOn(db), counts, messages: result[0].results || [] };
  } catch { return { enabled: false }; }
}

export async function setWall(env, on) {
  const db = wishBinding(env);
  if (!db) return { enabled: false };
  try {
    await db.prepare(`INSERT INTO birthday_settings (key, value) VALUES ('wall', ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(on ? 'on' : 'off').run();
    return { enabled: true, wall: Boolean(on) };
  } catch { return { enabled: false }; }
}
