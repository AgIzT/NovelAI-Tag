'use strict';

import { json, err, LIMITS, cleanLine, cleanText, readJson } from '../_lib.js';
import { canonicalKey, writeCanonical, countPendingRecords } from '../_record-store.js';
import { findFeedbackRecord } from '../_feedback.js';
import { consumeSubmissionRate, reservePendingSlot, releasePendingSlot } from '../_submission_guards.js';

const TYPES = new Set(['site_bug', 'card_content', 'image_error', 'copy_error', 'suggestion']);
const LIMIT = {
  descriptionMin: 10,
  description: 1000,
  contact: 120,
  contextBytes: 12000,
  bodyBytes: 36000,
  perWindow: 5,
  windowMs: 10 * 60 * 1000,
};

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.STRINGS_BUCKET) return err('服务端未绑定存储桶 STRINGS_BUCKET', 503);
  const len = Number(request.headers.get('content-length') || 0);
  if (len > LIMIT.bodyBytes) return err('反馈内容过大', 413);

  let body;
  try {
    body = await request.json();
  } catch {
    return err('请求格式错误');
  }

  if (cleanLine(body?.honeypot, 200)) {
    return json({ ok: true, id: '' }, 201);
  }

  const type = cleanLine(body?.type, 40);
  if (!TYPES.has(type)) return err('反馈类型无效');

  const descriptionRaw = cleanText(body?.description, LIMIT.description + 1);
  if (descriptionRaw.length < LIMIT.descriptionMin) return err(`反馈内容至少 ${LIMIT.descriptionMin} 个字`);
  if (descriptionRaw.length > LIMIT.description) return err(`反馈内容最多 ${LIMIT.description} 个字`);
  const contactRaw = cleanLine(body?.contact, LIMIT.contact + 1);
  if (contactRaw.length > LIMIT.contact) return err(`联系方式最多 ${LIMIT.contact} 个字`);

  // 目录准备可能需要多次刷新；尚未就绪时不消耗来源频率额度。
  let pendCount;
  try { pendCount = await countPendingRecords(env.STRINGS_BUCKET, 'feedback', LIMITS.pendingMax); }
  catch (error) { return err(error.message || '待审目录暂不可用，请稍后重试', error.status || 503); }
  if (pendCount >= LIMITS.pendingMax) return err('反馈队列已满，过几天再试', 429);

  // 限额走 D1 原子计数；D1 不可用（未绑定 / 0004 迁移未跑）时退回原来的 R2 软限额
  const ipHash = await hashIp(request, env);
  const rate = await consumeSubmissionRate(env, {
    scope: 'feedback', identifierHash: ipHash, limit: LIMIT.perWindow, windowMs: LIMIT.windowMs,
  });
  const limited = rate ? !rate.allowed : await applySoftRateLimit(env.STRINGS_BUCKET, ipHash);
  if (limited) return err('反馈太频繁，10 分钟后再试', 429);

  // 并发保险：上面的计数只负责尽早拒绝，写入前再用 D1 原子占位守住上限
  const slot = await reservePendingSlot(env, { queue: 'feedback', pendingCount: pendCount, max: LIMITS.pendingMax });
  if (slot && !slot.reserved) return err('反馈队列已满，过几天再试', 429);

  const now = new Date();
  const id = crypto.randomUUID();
  const key = canonicalKey('feedback', id);
  const record = {
    id,
    status: 'pending',
    type,
    description: descriptionRaw,
    contact: contactRaw,
    context: normalizeContext(body?.context),
    receivedAt: now.toISOString(),
    createdAt: now.getTime(),
    statusUpdatedAt: now.getTime(),
    statusUpdatedAtIso: now.toISOString(),
    progressStatus: 'unread',
    progressStatusUpdatedAt: now.getTime(),
    progressStatusUpdatedAtIso: now.toISOString(),
    adminReply: '',
    replyUpdatedAt: 0,
    replyUpdatedAtIso: '',
    publicVisible: false,
    publicVisibleUpdatedAt: 0,
    publicVisibleUpdatedAtIso: '',
    commitSha: cleanLine(env.CF_PAGES_COMMIT_SHA, 80) || 'local',
    cfRay: cleanLine(request.headers.get('cf-ray'), 120),
    notification: initialNotificationState(env),
  };

  try {
    if (await findFeedbackRecord(env.STRINGS_BUCKET, id)) throw Object.assign(new Error('反馈 ID 已占用'), { status: 409 });
    await writeCanonical(env.STRINGS_BUCKET, 'feedback', id, null, { status: 'pending', record });
  } catch (error) {
    if (error.status === 409 || error.canonicalNotAttempted) await releasePendingSlot(env, { queue: 'feedback', id: slot?.id });
    return err(error.message || '反馈提交结果未确认，请稍后核对', error.status || 503);
  }

  if (hasNotificationChannel(env)) {
    context.waitUntil(deliverFeedbackNotification(env.STRINGS_BUCKET, key, env, record));
  }

  return json({ ok: true, id }, 201);
}

function normalizeContext(value) {
  const text = safeStringify(value || {});
  if (text.length <= LIMIT.contextBytes) {
    try { return JSON.parse(text); } catch { return {}; }
  }
  return {
    truncated: true,
    raw: text.slice(0, LIMIT.contextBytes),
  };
}

async function applySoftRateLimit(bucket, ipHash) {
  const windowId = Math.floor(Date.now() / LIMIT.windowMs);
  const key = `feedback/ratelimit/${ipHash}/${windowId}.json`;
  const current = await readJson(bucket, key);
  const count = Number(current?.count || 0);
  if (count >= LIMIT.perWindow) return true;
  await bucket.put(key, JSON.stringify({
    count: count + 1,
    firstAt: current?.firstAt || Date.now(),
    updatedAt: Date.now(),
  }), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  return false;
}

async function hashIp(request, env) {
  const raw = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]
    || 'unknown';
  const salt = String(env.RATE_LIMIT_SALT || 'novelai-tag-feedback').slice(0, 128);
  const bytes = new TextEncoder().encode(`${salt}:${raw}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function hasNotificationChannel(env) {
  return Boolean((cleanEnv(env.FEEDBACK_RELAY_URL) && cleanEnv(env.FEEDBACK_RELAY_SECRET)) || env.SERVERCHAN_KEY);
}

function notificationProvider(env) {
  if (cleanEnv(env.FEEDBACK_RELAY_URL) && cleanEnv(env.FEEDBACK_RELAY_SECRET)) return 'relay';
  return 'serverchan';
}

function initialNotificationState(env) {
  if (hasNotificationChannel(env)) {
    return { provider: notificationProvider(env), status: 'pending' };
  }
  return { provider: 'none', status: 'skipped', message: '未配置通知通道' };
}

async function deliverFeedbackNotification(bucket, recordKey, env, record) {
  const attemptedAt = new Date().toISOString();
  try {
    const provider = notificationProvider(env);
    const result = provider === 'relay'
      ? await pushNotificationRelay(env.FEEDBACK_RELAY_URL, env.FEEDBACK_RELAY_SECRET, record)
      : await pushServerChan(env.SERVERCHAN_KEY, record);
    record.notification = {
      provider,
      status: 'sent',
      attemptedAt,
      completedAt: new Date().toISOString(),
      httpStatus: result.httpStatus,
      code: result.code,
      message: result.message,
    };
    console.log(JSON.stringify({
      event: 'feedback_notification_sent',
      feedbackId: record.id,
      provider,
      httpStatus: result.httpStatus,
      code: result.code,
    }));
  } catch (ex) {
    const failure = normalizeNotificationFailure(ex);
    record.notification = {
      provider: failure.provider || notificationProvider(env),
      status: 'failed',
      attemptedAt,
      completedAt: new Date().toISOString(),
      httpStatus: failure.httpStatus,
      code: failure.code,
      message: failure.message,
    };
    console.warn(JSON.stringify({
      event: 'feedback_notification_failed',
      feedbackId: record.id,
      provider: record.notification.provider,
      httpStatus: failure.httpStatus,
      code: failure.code,
      message: failure.message,
    }));
  }

  try {
    await writeNotificationStatus(bucket, record, recordKey);
  } catch (ex) {
    console.error(JSON.stringify({
      event: 'feedback_notification_status_write_failed',
      feedbackId: record.id,
      message: cleanLine(ex?.message || ex, 300),
    }));
  }
}

/* 推送结果回写到当前记录。推送要等几秒，这期间维护者可能已经改过、移动或删除了这条反馈：
   回写只在记录仍是刚读到的那个版本时才写（etag 条件写），版本变了就重新定位、重读再合并；
   记录已不存在就放弃，绝不把删掉的反馈（含联系方式）重新写回来。 */
const NOTIFICATION_WRITE_ATTEMPTS = 3;

async function writeNotificationStatus(bucket, record, recordKey) {
  for (let attempt = 0; attempt < NOTIFICATION_WRITE_ATTEMPTS; attempt += 1) {
    const current = await findFeedbackRecord(bucket, record.id);
    if (!current) return;
    try {
      await writeCanonical(bucket, 'feedback', record.id, current, {
        status: current.status, record: { ...current.record, notification: record.notification },
      });
      return;
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }
  console.warn(JSON.stringify({
    event: 'feedback_notification_status_conflict',
    feedbackId: record.id,
    attempts: NOTIFICATION_WRITE_ATTEMPTS,
  }));
}

async function pushServerChan(key, record) {
  const notifyPayload = buildNotificationPayload(record);
  const form = new URLSearchParams();
  form.set('text', notifyPayload.title);
  form.set('desp', notifyPayload.desp);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(String(key).trim())}.send`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: form.toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const raw = await readLimitedText(response, 4000);
  let responsePayload = {};
  try { responsePayload = JSON.parse(raw); } catch {}
  const code = Number.isFinite(Number(responsePayload?.code)) ? Number(responsePayload.code) : null;
  const message = cleanLine(responsePayload?.message || responsePayload?.msg || raw || response.statusText, 300);
  if (!response.ok || (code !== null && code !== 0)) {
    const error = new Error(message || `ServerChan HTTP ${response.status}`);
    error.httpStatus = response.status;
    error.serverChanCode = code;
    throw error;
  }
  return {
    httpStatus: response.status,
    code,
    message: message || 'sent',
  };
}

async function pushNotificationRelay(url, secret, record) {
  const body = JSON.stringify(buildNotificationPayload(record));
  const timestamp = String(Date.now());
  const signature = await hmacHex(secret, `${timestamp}.${body}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(cleanEnv(url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-relay-timestamp': timestamp,
        'x-relay-signature': signature,
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const raw = await readLimitedText(response, 4000);
  let responsePayload = {};
  try { responsePayload = JSON.parse(raw); } catch {}
  const code = responsePayload?.code == null ? null : Number(responsePayload.code);
  const message = cleanLine(responsePayload?.message || responsePayload?.error || raw || response.statusText, 300);
  if (!response.ok || responsePayload?.ok === false) {
    const error = new Error(message || `Relay HTTP ${response.status}`);
    error.provider = 'relay';
    error.httpStatus = Number(responsePayload?.httpStatus || response.status || 0);
    error.notificationCode = Number.isFinite(code) ? code : null;
    throw error;
  }
  return {
    httpStatus: Number(responsePayload?.httpStatus || response.status || 0),
    code: Number.isFinite(code) ? code : null,
    message: message || 'sent',
  };
}

function buildNotificationPayload(record) {
  const title = `法典图鉴反馈：${record.type}`;
  const lines = [
    `类型：${record.type}`,
    `时间：${record.receivedAt}`,
    `描述：${record.description}`,
    record.contact ? `联系方式：${record.contact}` : '',
    record.context?.page?.url ? `页面：${record.context.page.url}` : '',
    record.context?.entry?.title ? `词条：${record.context.entry.title}` : '',
  ].filter(Boolean);
  return {
    id: record.id,
    type: record.type,
    title,
    desp: lines.join('\n\n'),
    receivedAt: record.receivedAt,
  };
}

async function hmacHex(secret, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(cleanEnv(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text));
  return [...new Uint8Array(sig)].map(v => v.toString(16).padStart(2, '0')).join('');
}

function cleanEnv(value) {
  return String(value || '').trim();
}

async function readLimitedText(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const take = Math.min(value.byteLength, maxBytes - total);
      chunks.push(value.slice(0, take));
      total += take;
      if (total >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function normalizeNotificationFailure(ex) {
  return {
    provider: cleanLine(ex?.provider, 40),
    httpStatus: Number(ex?.httpStatus || 0),
    code: ex?.notificationCode != null && Number.isFinite(Number(ex.notificationCode))
      ? Number(ex.notificationCode)
      : ex?.serverChanCode != null && Number.isFinite(Number(ex.serverChanCode))
        ? Number(ex.serverChanCode)
        : null,
    message: cleanLine(ex?.message || ex || '通知推送失败', 300),
  };
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}
