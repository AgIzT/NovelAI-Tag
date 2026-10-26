'use strict';

import { requireRecordIndex, prepareRecordMarker, recordIndexPrefix, listedMarker, canonicalMetadata,
  matchesMarker, pendingMarker, abortedMarker, maintainRecordIndex, previousMarkerKeys, cleanRecordMarkers } from './_record-index.js';

// 固定 key 是唯一写入权威。旧目录只读兼容；墓碑永不删除，避免迟到请求复活记录。
export const canonicalKey = (kind, id) => `${kind}/records/${id}.json`;

export function storageError(message, status = 503) {
  return Object.assign(new Error(message), { status });
}

export function decodeCanonical(value, id, kind) {
  const statuses = kind === 'community' ? ['pending', 'approved', 'hidden', 'rejected', 'deleted'] : ['pending', 'resolved', 'ignored'];
  if (!value || ![1, 2].includes(value.version) || value.id !== id
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.operationId !== 'string' || !value.operationId
    || !statuses.includes(value.status) || typeof value.deleted !== 'boolean'
    || (!value.deleted && (!value.record || typeof value.record !== 'object' || Array.isArray(value.record) || value.record.id !== id))) {
    throw storageError('记录版本不可读取，请核对存储后重试');
  }
  return value;
}

export async function readCanonical(bucket, kind, id) {
  const key = canonicalKey(kind, id);
  const object = await bucket.get(key);
  if (!object) return null;
  if (!object.etag) throw storageError('记录缺少存储版本');
  let value;
  try { value = decodeCanonical(await object.json(), id, kind); }
  catch { throw storageError('记录版本不可读取，请核对存储后重试'); }
  return { ...value, key, etag: object.etag, canonical: true };
}

// found 是本次编辑实际读取的版本，不能在这里刷新后重放旧编辑。
export async function writeCanonical(bucket, kind, id, found, { status, record = null, deleted = false }) {
  if (found?.deleted) throw storageError('记录已永久删除', 409);
  let previous;
  try {
    await requireRecordIndex(bucket, kind);
    await cleanRecordMarkers(bucket, kind, found);
    previous = await previousMarkerKeys(kind, id, found);
  } catch (error) {
    throw Object.assign(error.status ? error : storageError('记录目录暂不可读取'), { canonicalNotAttempted: true });
  }
  const payload = {
    version: 2, id, revision: (found?.canonical ? found.revision : 0) + 1,
    operationId: crypto.randomUUID(), status, deleted,
    ...(deleted ? {} : { record }),
    ...(previous.length ? { indexCleanupKeys: previous } : {}),
  };
  decodeCanonical(payload, id, kind);
  const marker = deleted ? '' : await prepareRecordMarker(bucket, kind, id, payload);
  const key = canonicalKey(kind, id);
  const options = {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { schema: 'moderation-v2', status, deleted: String(deleted),
      revision: String(payload.revision), operationId: payload.operationId },
    onlyIf: found?.canonical ? { etagMatches: found.etag } : new Headers({ 'if-none-match': '*' }),
  };
  let written;
  try { written = await bucket.put(key, JSON.stringify(payload), options); }
  catch {
    // 超时可能已提交，也可能稍后提交。只确认本次 operationId；不补写、不删除。
    try {
      const current = await readCanonical(bucket, kind, id);
      if (current?.operationId === payload.operationId) {
        await cleanRecordMarkers(bucket, kind, current);
        return current;
      }
    } catch { /* 不可读也不能推断提交失败 */ }
    throw storageError('记录提交结果未确认，请刷新核对后重试');
  }
  if (!written) {
    // CAS 已明确失败，该唯一操作目录不会再成为权威；清理不影响其它写入者。
    if (marker) try { await bucket.delete(marker); } catch { /* 派生垃圾可随后核对 */ }
    throw storageError('记录已被其它操作更新，请刷新后重试', 409);
  }
  try { await cleanRecordMarkers(bucket, kind, payload); }
  catch { throw storageError('记录状态已提交，旧目录清理未完成；请刷新核对后重试'); }
  return { ...payload, key, etag: written.etag, canonical: true };
}

// 先枚举旧目录，再读新目录，避免迁移期间将旧副本重新选为权威。
// include customMetadata 不读取正文，保留反馈列表每次 200 正文的预算。
export async function listRecordMetadata(bucket, kind, statuses, { maxPages = 100, maxRecords = 50000, canonicalHeads = new Map() } = {}) {
  await requireRecordIndex(bucket, kind);
  for (const status of statuses) await maintainRecordIndex(bucket, kind, status);
  async function list(prefix, canonical = false) {
    const items = [], cursors = new Set();
    let cursor;
    for (let page = 0; page < maxPages; page++) {
      const result = await bucket.list({ prefix, limit: 1000, ...(canonical ? { include: ['customMetadata'] } : {}), ...(cursor ? { cursor } : {}) });
      for (const object of result.objects) {
        if (!object.key.startsWith(prefix) || !object.key.endsWith('.json')) continue;
        if (!object.etag) throw storageError('记录目录缺少版本');
        items.push(object);
        if (items.length > maxRecords) {
          if (canonical) await maintainRecordIndex(bucket, kind, prefix.split('/').at(-2), true);
          throw storageError('记录目录超过读取预算');
        }
      }
      if (!result.truncated) return items;
      if (!result.cursor || cursors.has(result.cursor)) throw storageError('记录目录游标未前进');
      cursor = result.cursor; cursors.add(cursor);
    }
    throw storageError('记录目录超过分页预算');
  }
  const byId = new Map();
  for (const status of statuses) {
    for (const object of await list(`${kind}/${status}/`)) {
      const id = object.key.split('/').at(-1).slice(0, -5);
      // 旧迁移可能留下多个状态/年月副本。保留全部候选，由投影按原时间规则选择；
      // 这里不能仅凭目录顺序丢掉较新的正文，也不能额外读取正文突破列表预算。
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push({ ...object, id, status, canonical: false });
    }
  }
  const indexed = [];
  for (const status of statuses) for (const object of await list(recordIndexPrefix(kind, status), true)) {
    indexed.push(listedMarker(object, kind, status));
  }
  // 旧副本只有有限的遗留集合；逐ID的HEAD只用于抑制这些旧副本，不扫描终身权威目录。
  const indexedIds = new Set(indexed.map(item => item.id));
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += 20) await Promise.all(ids.slice(i, i + 20).map(async id => {
    if (!canonicalHeads.has(id)) canonicalHeads.set(id, await bucket.head(canonicalKey(kind, id)));
    const object = canonicalHeads.get(id);
    if (!object) return;
    const meta = canonicalMetadata(object, kind);
    byId.delete(id);
    if (meta.deleted === 'false' && statuses.includes(meta.status) && !indexedIds.has(id)) {
      indexed.push({ ...object, key: canonicalKey(kind, id), id, status: meta.status, canonical: true });
    }
  }));
  for (const item of indexed) {
    if (!byId.has(item.id)) byId.set(item.id, []);
    byId.get(item.id).push(item);
  }
  const result = [...byId.values()].flat();
  if (result.length > maxRecords) {
    // 各状态分别未超限，总和仍可能由过期目录撑满；同时启动分批回收，
    // 首轮共享200候选预算，后续由各状态持久游标继续，不能总卡在首个状态。
    if (indexed.length) {
      for (const status of statuses) {
        try { await maintainRecordIndex(bucket, kind, status, true, Math.max(1, Math.floor(200 / statuses.length))); }
        catch (error) { if (!error.indexing) throw error; }
      }
      throw Object.assign(storageError('记录目录正在分批核对，请稍后刷新重试'), { indexing: true });
    }
    throw storageError('当前状态记录超过读取预算');
  }
  return result;
}

export async function countPendingRecords(bucket, kind, limit) {
  // 满旧队列在任何索引写入/表单解析前拒绝；先核对权威状态，不能把旧副本算满。
  const heads = new Map();
  let cursor, legacyCount = 0;
  const seenCursors = new Set(), canonicalIds = new Set();
  for (let page = 0; ; page++) {
    if (page >= 100) throw storageError('旧待审目录超过分页预算');
    const result = await bucket.list({ prefix: `${kind}/pending/`, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const object of result.objects) {
      if (!object.key.startsWith(`${kind}/pending/`) || !object.key.endsWith('.json')) continue;
      const id = object.key.split('/').at(-1).slice(0, -5);
      if (!heads.has(id)) heads.set(id, await bucket.head(canonicalKey(kind, id)));
      const current = heads.get(id);
      if (!current) legacyCount++;
      else {
        const meta = canonicalMetadata(current, kind);
        if (meta.deleted === 'false' && meta.status === 'pending' && !canonicalIds.has(id)) {
          legacyCount++; canonicalIds.add(id);
        }
      }
      if (legacyCount >= limit) return limit;
    }
    if (!result.truncated) break;
    if (!result.cursor || seenCursors.has(result.cursor)) throw storageError('旧待审目录游标未前进');
    cursor = result.cursor; seenCursors.add(cursor);
  }
  const records = await listRecordMetadata(bucket, kind, ['pending'], { canonicalHeads: heads });
  const groups = new Map();
  for (const meta of records) {
    if (!groups.has(meta.id)) groups.set(meta.id, []);
    groups.get(meta.id).push(meta);
  }
  let count = 0;
  for (const [id, candidates] of groups) {
    if (!heads.has(id)) heads.set(id, await bucket.head(canonicalKey(kind, id)));
    const object = heads.get(id);
    if (!object) {
      const markers = candidates.filter(x => x.canonical);
      if (!markers.length) count += candidates.length;
      else for (const marker of markers) if (!await abortedMarker(bucket, kind, marker)) { count++; break; }
    }
    else {
      const meta = canonicalMetadata(object, kind);
      if (meta.deleted === 'false' && meta.status === 'pending') count++;
      else if (meta.deleted === 'false') for (const marker of candidates) {
        if (marker.revision > Number(meta.revision || 0) && !await abortedMarker(bucket, kind, marker)) { count++; break; }
      }
    }
    if (count >= limit) return limit;
  }
  return count;
}

export async function readListedRecords(bucket, metadata) {
  const records = [];
  for (let i = 0; i < metadata.length; i += 20) {
    const group = await Promise.all(metadata.slice(i, i + 20).map(async meta => {
      const object = await bucket.get(meta.recordKey || meta.key);
      if (!object) return null;
      // 先完成读取；仅旧记录的JSON语法损坏可隔离，传输/I/O错误仍传播。
      const text = await object.text();
      let value;
      try { value = JSON.parse(text); }
      catch (error) {
        if (meta.canonical || !(error instanceof SyntaxError)) throw storageError('权威记录正文不可读取');
        console.warn(JSON.stringify({ event: 'malformed_legacy_record', key: meta.key }));
        return null;
      }
      if (!meta.canonical) return { status: meta.status, record: value };
      const current = decodeCanonical(value, meta.id, (meta.recordKey || meta.key).split('/')[0]);
      if (meta.recordKey && !matchesMarker(meta, current, object.etag)) {
        if (pendingMarker(meta, current) && !await abortedMarker(bucket, (meta.recordKey || meta.key).split('/')[0], meta)) {
          throw Object.assign(storageError('记录写入正在确认，请刷新重试'), { indexing: true });
        }
        return null;
      }
      return current.deleted ? null : { status: current.status, record: current.record };
    }));
    records.push(...group.filter(Boolean));
  }
  return records;
}

export async function deleteLegacyRecords(bucket, kind, id, statuses) {
  // 失败不撤销墓碑；同 ID 再次永久删除会重复执行幂等清理。
  for (const status of statuses) {
    let cursor;
    const keys = [], cursors = new Set();
    for (let pageNumber = 0; ; pageNumber++) {
      if (pageNumber >= 100) throw storageError('清理目录超过分页预算，请核对后重试');
      const page = await bucket.list({ prefix: `${kind}/${status}/`, limit: 1000, ...(cursor ? { cursor } : {}) });
      keys.push(...page.objects.map(item => item.key).filter(key => key.endsWith(`/${id}.json`)));
      if (!page.truncated) break;
      if (!page.cursor || cursors.has(page.cursor)) throw storageError('清理目录游标未前进');
      cursor = page.cursor; cursors.add(cursor);
    }
    // 枚举完成后才删，不能让删除改变后续分页位置。
    for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
  }
}
