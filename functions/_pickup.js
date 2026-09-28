'use strict';

import { clientIp, enabledFlag, rateIdentifier } from './_engagements.js';

export const PICKUP_PAYLOAD_PREFIX = 'NAITAG1.';
export const PICKUP_MAX_PAYLOAD_CHARS = 1_000_000;
export const PICKUP_MAX_BODY_BYTES = PICKUP_MAX_PAYLOAD_CHARS + 1024;
export const PICKUP_TTL_MS = 10 * 60 * 1000;
export const PICKUP_MAX_ACTIVE = 200;
export const PICKUP_RATE_LIMITS = { create: 10, redeem: 30 };
export const PICKUP_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

const PICKUP_CODE_LENGTH = 8;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const CODE_ATTEMPTS = 3;
const PAYLOAD_RE = /^NAITAG1\.[A-Za-z0-9_-]+$/;
const CODE_RE = new RegExp(`^[${PICKUP_CODE_ALPHABET}]{${PICKUP_CODE_LENGTH}}$`);

export function pickupAvailable(env) {
  return !!(
    env &&
    enabledFlag(env.FAVORITES_PICKUP_ENABLED) &&
    env.COMMUNITY_DB &&
    typeof env.COMMUNITY_DB.prepare === 'function' &&
    typeof env.COMMUNITY_DB.batch === 'function' &&
    String(env.RATE_LIMIT_SALT || '').trim()
  );
}

export function validPickupPayload(value) {
  return typeof value === 'string' && value.length <= PICKUP_MAX_PAYLOAD_CHARS && PAYLOAD_RE.test(value);
}

// 不区分大小写，空格与横线可有可无；不合法返回空串。
export function normalizePickupCode(value) {
  const code = String(value == null ? '' : value).toUpperCase().replace(/[\s-]+/g, '');
  return CODE_RE.test(code) ? code : '';
}

export function formatPickupCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function generatePickupCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(PICKUP_CODE_LENGTH));
  let code = '';
  for (const byte of bytes) code += PICKUP_CODE_ALPHABET[byte & 31];
  return code;
}

// 库里只存带密钥的摘要，拿到数据库副本也换不回取件码。
function pickupCodeHash(env, code) {
  return rateIdentifier(env.RATE_LIMIT_SALT, 'pickup-code', code);
}

function rows(result) {
  return Array.isArray(result && result.results) ? result.results : [];
}

// 读取请求体并限制字节数；失败返回 { status, error }。
export async function readPickupBody(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > PICKUP_MAX_BODY_BYTES) {
    return { status: 413, error: '收藏数据太大，请改用 JSON 文件' };
  }
  let text;
  try { text = await request.text(); } catch { return { status: 400, error: '请求内容无法读取' }; }
  if (new TextEncoder().encode(text).byteLength > PICKUP_MAX_BODY_BYTES) {
    return { status: 413, error: '收藏数据太大，请改用 JSON 文件' };
  }
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && !Array.isArray(data)) return { data };
  } catch {}
  return { status: 400, error: '请求内容格式无效' };
}

// 同一批里顺带清掉过期取件与限流桶。
export async function consumePickupRateLimit(env, request, action, now = Date.now()) {
  const db = env.COMMUNITY_DB;
  const bucketStart = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  const hash = await rateIdentifier(env.RATE_LIMIT_SALT, `pickup-${action}`, clientIp(request));
  const results = await db.batch([
    db.prepare('DELETE FROM pickup_rate_buckets WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM favorites_pickups WHERE expires_at <= ?').bind(now),
    db.prepare(`
      INSERT INTO pickup_rate_buckets (action, identifier_hash, bucket_start, request_count, expires_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT (action, identifier_hash, bucket_start) DO UPDATE SET
        request_count = pickup_rate_buckets.request_count + 1
    `).bind(action, hash, bucketStart, bucketStart + RATE_WINDOW_MS),
    db.prepare(`
      SELECT request_count FROM pickup_rate_buckets
      WHERE action = ? AND identifier_hash = ? AND bucket_start = ?
    `).bind(action, hash, bucketStart),
  ]);
  const count = Math.floor(Number(rows(results[3])[0] && rows(results[3])[0].request_count) || 0);
  return {
    allowed: count <= PICKUP_RATE_LIMITS[action],
    retryAfter: Math.max(1, Math.ceil((bucketStart + RATE_WINDOW_MS - now) / 1000)),
  };
}

// 成功返回 { code, expiresAt }；全站同时存放已满返回 null。
export async function createPickup(env, payload, now = Date.now()) {
  const db = env.COMMUNITY_DB;
  const expiresAt = now + PICKUP_TTL_MS;
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const code = generatePickupCode();
    const codeHash = await pickupCodeHash(env, code);
    const results = await db.batch([
      db.prepare(`
        INSERT OR IGNORE INTO favorites_pickups (code_hash, payload, bytes, created_at, expires_at)
        SELECT ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM favorites_pickups WHERE expires_at > ?) < ?
        RETURNING id
      `).bind(codeHash, payload, payload.length, now, expiresAt, now, PICKUP_MAX_ACTIVE),
      db.prepare('SELECT COUNT(*) AS active FROM favorites_pickups WHERE expires_at > ?').bind(now),
    ]);
    if (rows(results[0]).length) return { code, expiresAt };
    const active = Number(rows(results[1])[0] && rows(results[1])[0].active) || 0;
    if (active >= PICKUP_MAX_ACTIVE) return null;
    // 没插入且未满，说明撞上了仍有效的码，换一个重试。
  }
  throw new Error('pickup code collision retries exhausted');
}

// 一条 DELETE … RETURNING 完成一次性取件；无效或过期返回 null。
export async function redeemPickup(env, code, now = Date.now()) {
  const codeHash = await pickupCodeHash(env, code);
  const result = await env.COMMUNITY_DB.prepare(`
    DELETE FROM favorites_pickups
    WHERE code_hash = ? AND expires_at > ?
    RETURNING payload
  `).bind(codeHash, now).all();
  const row = rows(result)[0];
  return row ? String(row.payload || '') : null;
}
