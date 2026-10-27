'use strict';

import { listRecordMetadata, decodeCanonical, storageError } from './_record-store.js';
import { sanitizeAdminFeedbackRecord } from './_feedback.js';
import { matchesMarker, pendingMarker, abortedMarker } from './_record-index.js';

const BODY_LIMIT = 200;
const MAX_LIST_PAGES = 100;
const MAX_RECORDS = 50000;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

async function cacheSecrets(secret, status) {
  const material = encoder.encode(String(secret || '').trim());
  if (!material.length) throw new Error('Missing feedback cache secret');
  const addressKey = await crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const address = await crypto.subtle.sign('HMAC', addressKey, encoder.encode(`feedback-admin-index-v2/${status}`));
  const suffix = [...new Uint8Array(address)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const keyMaterial = await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
    salt: encoder.encode('feedback-admin-index-v2'), info: encoder.encode('encrypted-record-index') },
  keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { key, indexKey: `feedback/admin-list/${suffix}.json` };
}

function encode64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
const decode64 = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));

function paginationConflict() {
  return Object.assign(storageError('反馈列表已变化，点击「刷新反馈」返回第一页', 409), { resetPagination: true });
}

function readCursor(value, status) {
  if (!value) return null;
  try {
    if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode64(value.replace(/-/g, '+').replace(/_/g, '/'))));
    if (!cursor || Object.keys(cursor).sort().join(',') !== 'o,r,s,v' || cursor.v !== 1
      || !['pending', 'resolved', 'ignored'].includes(cursor.s) || !/^[a-f0-9]{64}$/.test(cursor.r)
      || !Number.isSafeInteger(cursor.o) || cursor.o < BODY_LIMIT || cursor.o >= MAX_RECORDS || cursor.o % BODY_LIMIT) throw new Error();
    if (cursor.s !== status) throw paginationConflict();
    return cursor;
  } catch (error) {
    if (error.resetPagination) throw error;
    throw storageError('反馈分页无效，点击「刷新反馈」返回第一页', 400);
  }
}

function writeCursor(status, revision, offset) {
  if (!offset) return '';
  return encode64(encoder.encode(JSON.stringify({ v: 1, s: status, r: revision, o: offset })))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function recordsRevision(records, status) {
  const identities = records.map(meta => [meta.key, meta.etag]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([status, identities])));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function sortTime(item) {
  return [item.progressStatusUpdatedAt, item.replyUpdatedAt, item.statusUpdatedAt,
    item.handledAt, item.createdAt].reduce((latest, value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(latest, n) : latest;
  }, 0);
}

// 桶可能公开：索引地址用管理口令 HMAC，内容用域分离密钥 AES-GCM 加密，禁止落明文目录。
// 口令轮换或密文损坏后重建；不删除历史对象。记录内容与 ETag 是真相。
// 冷启动分多次请求建立，任何一次最多读取 BODY_LIMIT 个正文；不返回半份「最新」列表。
export async function readAdminFeedbackList(bucket, status, secret, { cursor = '' } = {}) {
  const position = readCursor(cursor, status);
  const { key: encryptionKey, indexKey } = await cacheSecrets(secret, status);
  const additionalData = encoder.encode(indexKey);
  const object = await bucket.get(indexKey);
  let saved;
  if (object && (!object.size || object.size <= MAX_INDEX_BYTES)) {
    try {
      const envelope = await object.json();
      if (envelope.version === 2) {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode64(envelope.iv), additionalData },
          encryptionKey, decode64(envelope.ciphertext));
        saved = JSON.parse(new TextDecoder().decode(plain));
      }
    } catch { /* 损坏或旧密钥的派生索引可从记录重建 */ }
  }
  const validIndex = saved?.version === 1 && saved.status === status && Array.isArray(saved.entries);
  const cached = new Map();
  if (validIndex) for (const entry of saved.entries) {
    if (entry && typeof entry.key === 'string' && typeof entry.etag === 'string'
      && (entry.time === null || Number.isFinite(entry.time) && entry.time >= 0)) cached.set(entry.key, entry);
  }
  const records = await listRecordMetadata(bucket, 'feedback', [status], { maxPages: MAX_LIST_PAGES, maxRecords: MAX_RECORDS });
  if (records.length > MAX_RECORDS) throw new Error('Feedback index record budget exceeded');
  const revision = await recordsRevision(records, status);
  if (position && position.r !== revision) throw paginationConflict();
  const entries = new Map();
  for (const meta of records) {
    const entry = cached.get(meta.key);
    if (entry?.etag === meta.etag) entries.set(meta.key, entry);
  }
  let dirty = !validIndex || entries.size !== cached.size;
  let reads = 0, changed = false;
  const loaded = new Map();

  async function read(recordsToRead) {
    for (let i = 0; i < recordsToRead.length; i += 20) {
      await Promise.all(recordsToRead.slice(i, i + 20).map(async meta => {
        reads++;
        const body = await bucket.get(meta.recordKey || meta.key);
        if (!body && meta.recordKey && await abortedMarker(bucket, 'feedback', meta)) {
          entries.set(meta.key, { key: meta.key, etag: meta.etag, time: null }); dirty = true; return;
        }
        if (!body || !meta.recordKey && body.etag !== meta.etag) {
          entries.delete(meta.key); dirty = true; changed = true;
          return;
        }
        // 先完整读取流；传输失败不能被当作坏 JSON 按 ETag 永久记为不可展示。
        const text = await body.text();
        let item = null;
        let parsed;
        try { parsed = JSON.parse(text); }
        catch (error) { if (meta.canonical || !(error instanceof SyntaxError)) throw storageError('权威记录正文不可读取'); }
        {
          let record = parsed;
          if (meta.canonical) {
            const envelope = decodeCanonical(record, meta.id, 'feedback');
            if (meta.recordKey && !matchesMarker(meta, envelope, body.etag)) {
              if (pendingMarker(meta, envelope) && !await abortedMarker(bucket, 'feedback', meta)) {
                entries.delete(meta.key); dirty = true; changed = true; return;
              }
              record = null;
            } else record = !envelope.deleted && envelope.status === status ? envelope.record : null;
          }
          if (record && typeof record === 'object' && !Array.isArray(record)) item = sanitizeAdminFeedbackRecord(record, status);
        }
        if (entries.get(meta.key)?.time !== null && entries.has(meta.key) && item === null) changed = true;
        const entry = { key: meta.key, etag: meta.etag, time: item ? sortTime(item) : null };
        if (entries.get(meta.key)?.time !== entry.time || entries.get(meta.key)?.etag !== entry.etag) dirty = true;
        entries.set(meta.key, entry);
        loaded.set(meta.key, item);
      }));
    }
  }

  await read(records.filter(meta => !entries.has(meta.key)).slice(0, BODY_LIMIT));
  const remaining = records.length - entries.size;
  let selected = [], total = 0;
  const offset = position?.o || 0;
  if (!remaining && !changed) {
    const seen = new Set();
    const ranked = records.filter(meta => entries.get(meta.key).time !== null)
      .sort((a, b) => entries.get(b.key).time - entries.get(a.key).time || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .filter(meta => { if (seen.has(meta.id)) return false; seen.add(meta.id); return true; });
    total = ranked.length;
    if (position && offset >= total) throw paginationConflict();
    selected = ranked.slice(offset, offset + BODY_LIMIT);
    const needed = selected.filter(meta => !loaded.has(meta.key));
    if (needed.length <= BODY_LIMIT - reads) await read(needed);
  }

  if (dirty && records.length) {
    const plain = encoder.encode(JSON.stringify({ version: 1, status, entries: [...entries.values()] }));
    if (plain.byteLength > MAX_INDEX_BYTES) throw new Error('Feedback index budget exceeded');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, encryptionKey, plain);
    const payload = JSON.stringify({ version: 2, iv: encode64(iv), ciphertext: encode64(new Uint8Array(ciphertext)) });
    if (encoder.encode(payload).byteLength > MAX_INDEX_BYTES) throw new Error('Feedback index budget exceeded');
    const written = await bucket.put(indexKey, payload, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      onlyIf: object ? { etagMatches: object.etag } : new Headers({ 'if-none-match': '*' }),
    });
    if (!written) return { items: [], indexing: true, remaining: records.length - entries.size };
  }
  if (remaining || changed || selected.some(meta => !loaded.has(meta.key))) {
    return { items: [], indexing: true, remaining: records.length - entries.size };
  }
  return { items: selected.map(meta => loaded.get(meta.key)).filter(Boolean), indexing: false,
    total, offset, pageSize: BODY_LIMIT,
    nextCursor: offset + BODY_LIMIT < total ? writeCursor(status, revision, offset + BODY_LIMIT) : '',
    previousCursor: writeCursor(status, revision, Math.max(0, offset - BODY_LIMIT)),
  };
}
