'use strict';

import { json, err, LIMITS, cleanLine, cleanText, readJson, listAll } from '../_lib.js';

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

  const ipHash = await hashIp(request, env);
  const limited = await applySoftRateLimit(env.STRINGS_BUCKET, ipHash);
  if (limited) return err('反馈太频繁，请稍后再试', 429);

  const pend = await env.STRINGS_BUCKET.list({ prefix: 'feedback/pending/', limit: 1000 });
  const pendCount = pend.objects.filter(o => o.key.endsWith('.json')).length;
  if (pendCount >= LIMITS.pendingMax) return err('反馈队列已满，请过几天再试', 429);

  const now = new Date();
  const id = crypto.randomUUID();
  const key = `feedback/pending/${now.getUTCFullYear()}/${pad(now.getUTCMonth() + 1)}/${id}.json`;
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
    publicConsent: body?.publicConsent !== false,
    publicVisible: false,
    publicVisibleUpdatedAt: 0,
    publicVisibleUpdatedAtIso: '',
    commitSha: cleanLine(env.CF_PAGES_COMMIT_SHA, 80) || 'local',
    ipHash,
    cfRay: cleanLine(request.headers.get('cf-ray'), 120),
    notification: initialNotificationState(env),
  };

  await env.STRINGS_BUCKET.put(key, JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });

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
  const salt = String(env.RATE_LIMIT_SALT || env.ADMIN_TOKEN || 'novelai-tag-feedback').slice(0, 128);
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
    const currentKey = await findFeedbackRecordKey(bucket, record.id, recordKey);
    if (!currentKey) {
      console.log(JSON.stringify({
        event: 'feedback_notification_status_skipped',
        feedbackId: record.id,
        reason: 'record_no_longer_exists',
      }));
      return;
    }
    const currentRecord = await readJson(bucket, currentKey);
    if (!currentRecord) return;
    await bucket.put(currentKey, JSON.stringify({
      ...currentRecord,
      notification: record.notification,
    }), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
  } catch (ex) {
    console.error(JSON.stringify({
      event: 'feedback_notification_status_write_failed',
      feedbackId: record.id,
      message: cleanLine(ex?.message || ex, 300),
    }));
  }
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

async function findFeedbackRecordKey(bucket, id, preferredKey) {
  if (preferredKey && await bucket.head(preferredKey)) return preferredKey;
  for (const status of ['pending', 'resolved', 'ignored']) {
    const keys = await listAll(bucket, `feedback/${status}/`);
    const found = keys.find(key => key.endsWith(`/${id}.json`) || key.endsWith(`${id}.json`));
    if (found) return found;
  }
  return '';
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}
