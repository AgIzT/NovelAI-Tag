import { clientIp, rateIdentifier } from './_engagements.js';

/* 所长生日「送上祝福」（前端 site/assets/app/birthday-wishes.js）。
   生日同 site/assets/app/birthday.js：10 月 27 日起到月底，按访客本地日期。服务端只认 UTC，
   从最早进入 27 日的时区（UTC+14）收到最晚走完 31 日的时区（UTC−12）。 */
const BIRTHDAY = { month: 10, day: 27, days: 5 };
export const WISH_BATCH_LIMIT = 100;           // 一次请求最多带多少份（前端连点攒够就发）
export const WISH_GLOBAL_REQUEST_LIMIT = 600;  // 全站每分钟受理的请求数
export const WISH_IP_LIMIT = 1500;             // 每个 IP 每分钟的祝福数，比手点快得多，只拦脚本
const WISH_BODY_BYTES = 64;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export function wishWindow(now = Date.now()) {
  const year = new Date(now).getUTCFullYear();
  const start = Date.UTC(year, BIRTHDAY.month - 1, BIRTHDAY.day) - 14 * HOUR_MS;
  const end = Date.UTC(year, BIRTHDAY.month - 1, BIRTHDAY.day + BIRTHDAY.days) + 12 * HOUR_MS;
  return { year: String(year), open: now >= start && now < end };
}

export function wishBinding(env) {
  const db = env?.COMMUNITY_DB;
  return db && typeof db.prepare === 'function' && typeof db.batch === 'function' ? db : null;
}

export async function readWishTotal(env, now = Date.now()) {
  const db = wishBinding(env);
  if (!db) return { enabled: false };
  const { year, open } = wishWindow(now);
  try {
    const row = await db.prepare('SELECT COALESCE(SUM(wish_count), 0) AS total FROM birthday_wishes WHERE year = ?')
      .bind(year).first();
    return { enabled: true, open, total: Number(row?.total) || 0 };
  } catch { return { enabled: false }; }
}

/** 请求体只收 {"count": n}，n 为 1–WISH_BATCH_LIMIT 的整数 */
export async function readWishCount(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > WISH_BODY_BYTES)) return { status: 413 };
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > WISH_BODY_BYTES) return { status: 413 };
    const body = JSON.parse(text);
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
    const count = body?.count;
    if (keys.length !== 1 || keys[0] !== 'count' || !Number.isInteger(count)
      || count < 1 || count > WISH_BATCH_LIMIT) return { status: 400 };
    return { count };
  } catch { return { status: 400 }; }
}

export async function addWishes(env, request, count, now = Date.now()) {
  const db = wishBinding(env);
  if (!db) return { enabled: false };
  const { year, open } = wishWindow(now);
  if (!open) return { enabled: true, open: false };
  const day = new Date(now).toISOString().slice(0, 10);
  const windowStart = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const expiresAt = windowStart + 2 * MINUTE_MS;
  // 没配盐（本地或预览）就只有全站限额；IP 只以加盐摘要进限额桶，两分钟后随桶删掉
  const salt = String(env.RATE_LIMIT_SALT || '').trim();
  const ipBucket = salt ? `ip:${await rateIdentifier(salt, 'birthday-wish', clientIp(request))}` : '';
  const bump = (bucket, amount) => db.prepare(`INSERT INTO birthday_wish_rate (bucket, window_start, amount, expires_at)
    VALUES (?, ?, ?, ?) ON CONFLICT (bucket, window_start) DO UPDATE SET amount = birthday_wish_rate.amount + excluded.amount`)
    .bind(bucket, windowStart, amount, expiresAt);
  const within = `(SELECT amount FROM birthday_wish_rate WHERE bucket = 'all' AND window_start = ?1) <= ?2
    AND COALESCE((SELECT amount FROM birthday_wish_rate WHERE bucket = ?3 AND window_start = ?1), 0) <= ?4`;
  // D1 batch 是一个事务：限额与计数一起落定，超额的那批不计入
  const statements = [
    db.prepare('DELETE FROM birthday_wish_rate WHERE expires_at <= ?').bind(now),
    bump('all', 1),
    ...(ipBucket ? [bump(ipBucket, count)] : []),
    db.prepare(`INSERT INTO birthday_wishes (year, day, wish_count) SELECT ?5, ?6, ?7 WHERE ${within}
      ON CONFLICT (year, day) DO UPDATE SET wish_count = birthday_wishes.wish_count + excluded.wish_count`)
      .bind(windowStart, WISH_GLOBAL_REQUEST_LIMIT, ipBucket, WISH_IP_LIMIT, year, day, count),
    db.prepare(`SELECT (${within}) AS allowed, (SELECT COALESCE(SUM(wish_count), 0) FROM birthday_wishes WHERE year = ?5) AS total`)
      .bind(windowStart, WISH_GLOBAL_REQUEST_LIMIT, ipBucket, WISH_IP_LIMIT, year),
  ];
  try {
    const results = await db.batch(statements);
    if (results.some(result => result.success === false)) return { enabled: false };
    const row = results.at(-1).results?.[0] || {};
    return {
      enabled: true, open: true, accepted: Number(row.allowed) === 1, total: Number(row.total) || 0,
      retryAfter: Math.max(1, Math.ceil((windowStart + MINUTE_MS - now) / 1000)),
    };
  } catch { return { enabled: false }; }
}
