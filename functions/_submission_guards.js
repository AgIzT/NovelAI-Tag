'use strict';

// 投稿 / 反馈的防刷限额与待审容量保险丝。
// 原先两道都是「先在 R2 里数一下、再写进去」：同时到达的请求会数到同一个数、一起放行。
// 这里把「判断 + 计数」放进同一个 D1 batch（D1 的 batch 是一个事务），并发也不会多放。
// D1 没绑定或 0004 迁移还没跑时返回 null，调用方退回原来的 R2 做法：
// 先发程序、后跑迁移也不会让投稿和反馈失效，只是暂时回到旧的软限额。

export const PENDING_RESERVATION_TTL_MS = 5 * 60 * 1000;

function rows(result) {
  return Array.isArray(result && result.results) ? result.results : [];
}

function warnFallback(event, error) {
  console.warn(JSON.stringify({ event, message: String((error && error.message) || error).slice(0, 300) }));
}

// 计数一次并判断是否超限；返回 { allowed, retryAfter }，D1 不可用返回 null。
export async function consumeSubmissionRate(env, { scope, identifierHash, limit, windowMs, now = Date.now() }) {
  const db = env.COMMUNITY_DB;
  if (!db) return null;
  const bucketStart = Math.floor(now / windowMs) * windowMs;
  try {
    const results = await db.batch([
      db.prepare('DELETE FROM submission_rate_buckets WHERE expires_at <= ?').bind(now),
      db.prepare(`
        INSERT INTO submission_rate_buckets (scope, identifier_hash, bucket_start, request_count, expires_at)
        VALUES (?, ?, ?, 1, ?)
        ON CONFLICT (scope, identifier_hash, bucket_start) DO UPDATE SET
          request_count = submission_rate_buckets.request_count + 1
      `).bind(scope, identifierHash, bucketStart, bucketStart + windowMs),
      db.prepare(`
        SELECT request_count FROM submission_rate_buckets
        WHERE scope = ? AND identifier_hash = ? AND bucket_start = ?
      `).bind(scope, identifierHash, bucketStart),
    ]);
    const count = Math.floor(Number(rows(results[2])[0] && rows(results[2])[0].request_count) || 0);
    return {
      allowed: count <= limit,
      retryAfter: Math.max(1, Math.ceil((bucketStart + windowMs - now) / 1000)),
    };
  } catch (error) {
    warnFallback('submission_rate_d1_unavailable', error);
    return null;
  }
}

// 写入 R2 待审区之前占一个名额：R2 里已有的条数 + 未过期名额 < max 才占得到。
// 返回 { reserved, id }；D1 不可用返回 null。
export async function reservePendingSlot(env, { queue, pendingCount, max, now = Date.now() }) {
  const db = env.COMMUNITY_DB;
  if (!db) return null;
  const id = crypto.randomUUID();
  try {
    const results = await db.batch([
      db.prepare('DELETE FROM pending_reservations WHERE expires_at <= ?').bind(now),
      db.prepare(`
        INSERT INTO pending_reservations (queue, reservation_id, expires_at)
        SELECT ?, ?, ?
        WHERE (SELECT COUNT(*) FROM pending_reservations WHERE queue = ?) + ? < ?
        RETURNING reservation_id
      `).bind(queue, id, now + PENDING_RESERVATION_TTL_MS, queue, pendingCount, max),
    ]);
    return { reserved: rows(results[1]).length > 0, id };
  } catch (error) {
    warnFallback('pending_reservation_d1_unavailable', error);
    return null;
  }
}

// 写入失败时把名额还回去；还不掉也只是多占几分钟，不影响上限本身。
export async function releasePendingSlot(env, { queue, id }) {
  if (!env.COMMUNITY_DB || !id) return;
  try {
    await env.COMMUNITY_DB
      .prepare('DELETE FROM pending_reservations WHERE queue = ? AND reservation_id = ?')
      .bind(queue, id)
      .run();
  } catch (error) {
    warnFallback('pending_reservation_release_failed', error);
  }
}
