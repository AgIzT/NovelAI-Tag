'use strict';

export const COMMUNITY_LIKE_SCOPE = 'community';
export const COMMUNITY_LIKE_KIND = 'like';
export const COMMUNITY_LIKE_COOKIE = 'nat_like_actor';

const COOKIE_VERSION = 'v1';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_BUCKET_RETENTION_MS = 24 * 60 * 60 * 1000;
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const ACTOR_RATE_LIMIT = 30;
const IP_RATE_LIMIT = 120;
const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLIC_QUERY_ID_BATCH = 80;
const ACTOR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const encoder = new TextEncoder();

export function enabledFlag(value) {
  return value === true || TRUE_VALUES.has(String(value == null ? '' : value).trim().toLowerCase());
}

function secretBytes(value) {
  return encoder.encode(String(value == null ? '' : value)).byteLength;
}

export function communityLikesAvailable(env) {
  return !!(
    env &&
    enabledFlag(env.COMMUNITY_LIKES_ENABLED) &&
    env.COMMUNITY_DB &&
    typeof env.COMMUNITY_DB.prepare === 'function' &&
    typeof env.COMMUNITY_DB.batch === 'function' &&
    secretBytes(env.ENGAGEMENT_COOKIE_SECRET) >= 32 &&
    String(env.RATE_LIMIT_SALT || '').trim()
  );
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return bytesToBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function signText(secret, text) {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
}

async function verifyText(secret, text, encodedSignature) {
  const signature = base64UrlToBytes(encodedSignature);
  if (!signature || signature.byteLength !== 32) return false;
  const key = await hmacKey(secret);
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(text));
}

function cookieValue(request, name) {
  const header = request && request.headers && request.headers.get('cookie');
  if (!header) return '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ''; }
  }
  return '';
}

export async function readLikeActor(request, env) {
  const raw = cookieValue(request, COMMUNITY_LIKE_COOKIE);
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== COOKIE_VERSION || !ACTOR_RE.test(parts[1])) return null;
  const payload = `${parts[0]}.${parts[1].toLowerCase()}`;
  const valid = await verifyText(env.ENGAGEMENT_COOKIE_SECRET, payload, parts[2]);
  return valid ? parts[1].toLowerCase() : null;
}

export async function createLikeActor(env, request) {
  const actorId = crypto.randomUUID().toLowerCase();
  const payload = `${COOKIE_VERSION}.${actorId}`;
  const signature = bytesToBase64Url(await signText(env.ENGAGEMENT_COOKIE_SECRET, payload));
  const value = `${payload}.${signature}`;
  return {
    actorId,
    cookie: `${COMMUNITY_LIKE_COOKIE}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly${isHttps(request) ? '; Secure' : ''}; SameSite=Lax`,
  };
}

function isHttps(request) {
  try { return new URL(request && request.url).protocol === 'https:'; } catch { return false; }
}

export function isSameOriginWrite(request) {
  if (!request) return false;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

export function clientIp(request) {
  return String(
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0] ||
    'unknown',
  ).trim() || 'unknown';
}

export async function rateIdentifier(salt, type, value) {
  const bytes = await signText(salt, `${type}:${value}`);
  return bytesToBase64Url(bytes);
}

function rows(result) {
  return Array.isArray(result && result.results) ? result.results : [];
}

function firstNumber(result, name) {
  const value = Number(rows(result)[0] && rows(result)[0][name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export async function consumeCommunityLikeRateLimit(env, request, actorId, now = Date.now()) {
  const db = env.COMMUNITY_DB;
  const bucketStart = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  const expiresAt = bucketStart + RATE_BUCKET_RETENTION_MS;
  const ip = clientIp(request);
  const identifiers = [];
  if (actorId) identifiers.push({ type: 'actor', value: actorId, limit: ACTOR_RATE_LIMIT });
  identifiers.push({ type: 'ip', value: ip, limit: IP_RATE_LIMIT });

  const hashed = await Promise.all(identifiers.map(async item => ({
    ...item,
    hash: await rateIdentifier(env.RATE_LIMIT_SALT, item.type, item.value),
  })));
  const statements = [
    db.prepare('DELETE FROM engagement_rate_buckets WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM engagement_events WHERE created_at < ?').bind(now - EVENT_RETENTION_MS),
  ];
  const countIndexes = [];
  for (const item of hashed) {
    statements.push(db.prepare(`
      INSERT INTO engagement_rate_buckets
        (identifier_type, identifier_hash, bucket_start, request_count, expires_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT (identifier_type, identifier_hash, bucket_start) DO UPDATE SET
        request_count = engagement_rate_buckets.request_count + 1,
        expires_at = excluded.expires_at
    `).bind(item.type, item.hash, bucketStart, expiresAt));
    countIndexes.push(statements.length);
    statements.push(db.prepare(`
      SELECT request_count FROM engagement_rate_buckets
      WHERE identifier_type = ? AND identifier_hash = ? AND bucket_start = ?
    `).bind(item.type, item.hash, bucketStart));
  }
  const results = await db.batch(statements);
  const exceeded = hashed.some((item, index) => firstNumber(results[countIndexes[index]], 'request_count') > item.limit);
  return {
    allowed: !exceeded,
    retryAfter: Math.max(1, Math.ceil((bucketStart + RATE_WINDOW_MS - now) / 1000)),
  };
}

export async function readCommunityLikeCount(env, itemId) {
  const result = await env.COMMUNITY_DB.prepare(`
    SELECT like_count FROM engagement_stats
    WHERE scope = ? AND item_id = ? AND kind = ?
  `).bind(COMMUNITY_LIKE_SCOPE, itemId, COMMUNITY_LIKE_KIND).all();
  return firstNumber(result, 'like_count');
}

export async function setCommunityLike(env, itemId, actorId, liked, now = Date.now()) {
  const db = env.COMMUNITY_DB;
  const mutation = liked
    ? db.prepare(`
        INSERT OR IGNORE INTO engagements (scope, item_id, kind, actor_id, created_at)
        SELECT ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM engagement_tombstones
          WHERE scope = ? AND item_id = ? AND kind = ?
        )
      `).bind(
        COMMUNITY_LIKE_SCOPE, itemId, COMMUNITY_LIKE_KIND, actorId, now,
        COMMUNITY_LIKE_SCOPE, itemId, COMMUNITY_LIKE_KIND,
      )
    : db.prepare(`
        DELETE FROM engagements
        WHERE scope = ? AND item_id = ? AND kind = ? AND actor_id = ?
      `).bind(COMMUNITY_LIKE_SCOPE, itemId, COMMUNITY_LIKE_KIND, actorId);
  const state = db.prepare(`
    SELECT
      EXISTS(
        SELECT 1 FROM engagement_tombstones
        WHERE scope = ? AND item_id = ? AND kind = ?
      ) AS tombstoned,
      EXISTS(
        SELECT 1 FROM engagements
        WHERE scope = ? AND item_id = ? AND kind = ? AND actor_id = ?
      ) AS liked,
      COALESCE((
        SELECT like_count FROM engagement_stats
        WHERE scope = ? AND item_id = ? AND kind = ?
      ), 0) AS like_count
  `).bind(
    COMMUNITY_LIKE_SCOPE, itemId, COMMUNITY_LIKE_KIND,
    COMMUNITY_LIKE_SCOPE, itemId, COMMUNITY_LIKE_KIND, actorId,
    COMMUNITY_LIKE_SCOPE, itemId, COMMUNITY_LIKE_KIND,
  );
  const results = await db.batch([mutation, state]);
  return {
    tombstoned: firstNumber(results[1], 'tombstoned') === 1,
    liked: firstNumber(results[1], 'liked') === 1,
    likeCount: firstNumber(results[1], 'like_count'),
  };
}

export async function readCommunityLikeSnapshot(env, entries, request) {
  const counts = new Map();
  const liked = new Set();
  if (!communityLikesAvailable(env)) return { available: false, counts, liked };
  const ids = new Set((entries || []).map(entry => String(entry && entry.id || '')).filter(Boolean));
  if (!ids.size) return { available: true, counts, liked };

  try {
    const actorId = request ? await readLikeActor(request, env) : null;
    const statements = [];
    const statementTypes = [];
    const idList = [...ids];
    for (let offset = 0; offset < idList.length; offset += PUBLIC_QUERY_ID_BATCH) {
      const part = idList.slice(offset, offset + PUBLIC_QUERY_ID_BATCH);
      const placeholders = part.map(() => '?').join(', ');
      statements.push(env.COMMUNITY_DB.prepare(`
        SELECT item_id, like_count FROM engagement_stats
        WHERE scope = ? AND kind = ? AND item_id IN (${placeholders})
      `).bind(COMMUNITY_LIKE_SCOPE, COMMUNITY_LIKE_KIND, ...part));
      statementTypes.push('stats');
      if (actorId) {
        statements.push(env.COMMUNITY_DB.prepare(`
          SELECT item_id FROM engagements
          WHERE scope = ? AND kind = ? AND actor_id = ? AND item_id IN (${placeholders})
        `).bind(COMMUNITY_LIKE_SCOPE, COMMUNITY_LIKE_KIND, actorId, ...part));
        statementTypes.push('actor');
      }
    }
    const results = await env.COMMUNITY_DB.batch(statements);
    for (let index = 0; index < results.length; index += 1) {
      for (const row of rows(results[index])) {
        const id = String(row.item_id || '');
        if (!ids.has(id)) continue;
        if (statementTypes[index] === 'actor') liked.add(id);
        else counts.set(id, Math.max(0, Math.floor(Number(row.like_count) || 0)));
      }
    }
    return { available: true, counts, liked };
  } catch (error) {
    console.error(JSON.stringify({ message: 'community likes snapshot failed', error: errorMessage(error) }));
    return { available: false, counts, liked };
  }
}

function unavailableLikes() {
  return { available: false, total: 0, uniqueDevices: 0, likedEntries: 0, trend14d: [], top: [] };
}

export async function getCommunityLikesStats(env, items, now = Date.now()) {
  if (!communityLikesAvailable(env)) return unavailableLikes();
  const start = Math.floor(now / DAY_MS) * DAY_MS - 13 * DAY_MS;
  try {
    const db = env.COMMUNITY_DB;
    const results = await db.batch([
      db.prepare(`
        SELECT COALESCE(SUM(like_count), 0) AS total,
               COUNT(*) AS liked_entries
        FROM engagement_stats WHERE scope = ? AND kind = ? AND like_count > 0
      `).bind(COMMUNITY_LIKE_SCOPE, COMMUNITY_LIKE_KIND),
      db.prepare(`
        SELECT COUNT(DISTINCT actor_id) AS unique_devices
        FROM engagements WHERE scope = ? AND kind = ?
      `).bind(COMMUNITY_LIKE_SCOPE, COMMUNITY_LIKE_KIND),
      db.prepare(`
        SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS date,
               SUM(CASE WHEN action = 'add' THEN 1 ELSE 0 END) AS adds,
               SUM(CASE WHEN action = 'remove' THEN 1 ELSE 0 END) AS removes
        FROM engagement_events
        WHERE scope = ? AND kind = ? AND created_at >= ?
        GROUP BY date ORDER BY date
      `).bind(COMMUNITY_LIKE_SCOPE, COMMUNITY_LIKE_KIND, start),
      db.prepare(`
        SELECT item_id, like_count FROM engagement_stats
        WHERE scope = ? AND kind = ? AND like_count > 0
        ORDER BY like_count DESC, item_id ASC LIMIT 10
      `).bind(COMMUNITY_LIKE_SCOPE, COMMUNITY_LIKE_KIND),
    ]);
    const totals = rows(results[0])[0] || {};
    const devices = rows(results[1])[0] || {};
    const trendRows = new Map(rows(results[2]).map(row => [String(row.date || ''), row]));
    const trend14d = Array.from({ length: 14 }, (_, index) => {
      const date = new Date(start + index * DAY_MS).toISOString().slice(0, 10);
      const row = trendRows.get(date) || {};
      const adds = Math.max(0, Math.floor(Number(row.adds) || 0));
      const removes = Math.max(0, Math.floor(Number(row.removes) || 0));
      return { date, adds, removes, net: adds - removes };
    });
    const itemMap = new Map((items || []).map(item => [String(item && item.id || ''), item]));
    const top = rows(results[3]).map(row => {
      const id = String(row.item_id || '');
      const item = itemMap.get(id);
      if (!item) return null;
      return {
        id,
        title: String(item.title || ''),
        status: String(item.status || ''),
        category: Array.isArray(item.category) ? item.category : [],
        likeCount: Math.max(0, Math.floor(Number(row.like_count) || 0)),
      };
    }).filter(Boolean);
    return {
      available: true,
      total: Math.max(0, Math.floor(Number(totals.total) || 0)),
      uniqueDevices: Math.max(0, Math.floor(Number(devices.unique_devices) || 0)),
      likedEntries: Math.max(0, Math.floor(Number(totals.liked_entries) || 0)),
      trend14d,
      top,
    };
  } catch (error) {
    console.error(JSON.stringify({ message: 'community likes stats failed', error: errorMessage(error) }));
    return unavailableLikes();
  }
}

export async function purgeCommunityLikes(env, itemId) {
  const db = env && env.COMMUNITY_DB;
  if (!db) return;
  if (typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new Error('COMMUNITY_DB binding is invalid');
  }
  const now = Date.now();
  await db.batch([
    db.prepare(`
      INSERT INTO engagement_tombstones (scope, item_id, kind, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (scope, item_id, kind) DO UPDATE SET created_at = excluded.created_at
    `).bind(COMMUNITY_LIKE_SCOPE, itemId, COMMUNITY_LIKE_KIND, now),
    db.prepare('DELETE FROM engagements WHERE scope = ? AND item_id = ? AND kind = ?')
      .bind(COMMUNITY_LIKE_SCOPE, itemId, COMMUNITY_LIKE_KIND),
    db.prepare('DELETE FROM engagement_stats WHERE scope = ? AND item_id = ? AND kind = ?')
      .bind(COMMUNITY_LIKE_SCOPE, itemId, COMMUNITY_LIKE_KIND),
    db.prepare('DELETE FROM engagement_events WHERE scope = ? AND item_id = ? AND kind = ?')
      .bind(COMMUNITY_LIKE_SCOPE, itemId, COMMUNITY_LIKE_KIND),
  ]);
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'unknown error');
}
