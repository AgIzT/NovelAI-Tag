'use strict';

// 固定 key 是唯一写入权威。旧目录只读兼容；墓碑永不删除，避免迟到请求复活记录。
export const canonicalKey = (kind, id) => `${kind}/records/${id}.json`;

export function storageError(message, status = 503) {
  return Object.assign(new Error(message), { status });
}

export function decodeCanonical(value, id, kind) {
  const statuses = kind === 'community' ? ['pending', 'approved', 'hidden', 'rejected', 'deleted'] : ['pending', 'resolved', 'ignored'];
  if (!value || value.version !== 1 || value.id !== id
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
  const payload = {
    version: 1, id, revision: (found?.canonical ? found.revision : 0) + 1,
    operationId: crypto.randomUUID(), status, deleted,
    ...(deleted ? {} : { record }),
  };
  decodeCanonical(payload, id, kind);
  const key = canonicalKey(kind, id);
  const options = {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { schema: 'moderation-v1', status, deleted: String(deleted) },
    onlyIf: found?.canonical ? { etagMatches: found.etag } : new Headers({ 'if-none-match': '*' }),
  };
  let written;
  try { written = await bucket.put(key, JSON.stringify(payload), options); }
  catch {
    // 超时可能已提交，也可能稍后提交。只确认本次 operationId；不补写、不删除。
    try {
      const current = await readCanonical(bucket, kind, id);
      if (current?.operationId === payload.operationId) return current;
    } catch { /* 不可读也不能推断提交失败 */ }
    throw storageError('记录提交结果未确认，请刷新核对后重试');
  }
  if (!written) throw storageError('记录已被其它操作更新，请刷新后重试', 409);
  return { ...payload, key, etag: written.etag, canonical: true };
}

// 先枚举旧目录，再读新目录，避免迁移期间将旧副本重新选为权威。
// include customMetadata 不读取正文，保留反馈列表每次 200 正文的预算。
export async function listRecordMetadata(bucket, kind, statuses, { maxPages = 100, maxRecords = 50000 } = {}) {
  async function list(prefix, canonical = false) {
    const items = [], cursors = new Set();
    let cursor;
    for (let page = 0; page < maxPages; page++) {
      const result = await bucket.list({ prefix, limit: 1000, ...(canonical ? { include: ['customMetadata'] } : {}), ...(cursor ? { cursor } : {}) });
      for (const object of result.objects) {
        if (!object.key.startsWith(prefix) || !object.key.endsWith('.json')) continue;
        if (!object.etag) throw storageError('记录目录缺少版本');
        items.push(object);
        if (items.length > maxRecords) throw storageError('记录目录超过读取预算');
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
  for (const object of await list(`${kind}/records/`, true)) {
    const id = object.key.split('/').at(-1).slice(0, -5);
    const meta = object.customMetadata;
    if (meta?.schema !== 'moderation-v1' || !meta.status || !['true', 'false'].includes(meta.deleted)) {
      throw storageError('权威记录目录版本不可读取');
    }
    byId.delete(id);
    if (meta.deleted === 'false' && statuses.includes(meta.status)) {
      byId.set(id, [{ ...object, id, status: meta.status, canonical: true }]);
    }
  }
  return [...byId.values()].flat();
}

export async function readListedRecords(bucket, metadata) {
  const records = [];
  for (let i = 0; i < metadata.length; i += 20) {
    const group = await Promise.all(metadata.slice(i, i + 20).map(async meta => {
      const object = await bucket.get(meta.key);
      if (!object) return null;
      const value = await object.json();
      if (!meta.canonical) return { status: meta.status, record: value };
      const current = decodeCanonical(value, meta.id, meta.key.split('/')[0]);
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
