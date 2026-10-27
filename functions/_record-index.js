'use strict';

export const recordStatuses = kind => kind === 'community'
  ? ['pending', 'approved', 'hidden', 'rejected', 'deleted'] : ['pending', 'resolved', 'ignored'];
const failure = message => Object.assign(new Error(message), { status: 503 });
const preparing = () => Object.assign(failure('记录目录正在分批准备，请稍后刷新重试'), { indexing: true });
const root = kind => `${kind}/record-index/v1/`;
export const recordIndexPrefix = (kind, status) => `${root(kind)}${status}/`;
const stateKey = kind => `${kind}/record-index-state/v1.json`;

export function canonicalMetadata(object, kind) {
  const meta = object.customMetadata;
  if (!object.etag || !['moderation-v1', 'moderation-v2'].includes(meta?.schema) || !recordStatuses(kind).includes(meta.status)
    || !['true', 'false'].includes(meta.deleted)) throw failure('权威记录目录版本不可读取');
  if (meta.schema === 'moderation-v2' && (!meta.operationId || !Number.isSafeInteger(Number(meta.revision)) || Number(meta.revision) < 1)) {
    throw failure('权威记录目录版本不可读取');
  }
  return meta;
}
async function oldToken(etag) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(etag));
  return 'etag-' + [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function indexKey(kind, status, id, token) { return `${recordIndexPrefix(kind, status)}${token}/${id}.json`; }
const abortKey = (kind, operationId) => `${kind}/record-index-aborted/v1/${operationId}.json`;
export async function abortedMarker(bucket, kind, meta) {
  return !!meta.operationId && !!await bucket.head(abortKey(kind, meta.operationId));
}
export async function prepareRecordMarker(bucket, kind, id, { status, operationId, revision, etag }) {
  const token = operationId || await oldToken(etag);
  const key = indexKey(kind, status, id, token);
  const metadata = { schema: 'moderation-index-v1', status, id,
    ...(operationId ? { operationId, revision: String(revision) } : { canonicalEtag: etag }) };
  // 唯一操作目录先落地，再提交权威 CAS；读者仍验证权威版本，不能把准备当成功。
  try {
    const saved = await bucket.put(key, '{}', { onlyIf: new Headers({ 'if-none-match': '*' }), customMetadata: metadata,
      httpMetadata: { contentType: 'application/json; charset=utf-8' } });
    if (saved) return key;
  } catch { /* 可能已准备成功；先确认精确操作，不直接提交权威。 */ }
  try {
    const saved = await bucket.head(key);
    if (saved && Object.entries(metadata).every(([name, value]) => saved.customMetadata?.[name] === value)) return key;
  } catch { /* 不确认准备就不能发出 canonical PUT。 */ }
  if (operationId) {
    // 此处从未发出权威写入；永久中止凭据让迟到的准备目录不能占住列表/容量。
    // 已发出 canonical PUT 的未知结果绝不能走这条中止路径。
    try {
      await bucket.put(abortKey(kind, operationId), '{}', { onlyIf: new Headers({ 'if-none-match': '*' }) });
      await bucket.delete(key);
    } catch { /* 存储持续故障时保留证据，需在恢复后核对该操作。 */ }
  }
  throw Object.assign(failure('记录目录准备未确认，未提交记录；请刷新核对后重试'), { canonicalNotAttempted: true });
}

// 旧 canonical 只做一次可继续的索引准备。单次至多50页/200个索引写入，不读正文。
// 准备完成前新写入不启动；上线仍须先停止、排空旧版本写入者。
export async function requireRecordIndex(bucket, kind) {
  const key = stateKey(kind), found = await bucket.get(key);
  let state = { version: 1, ready: false, cursor: '' };
  if (found) {
    try { state = await found.json(); } catch { throw failure('记录目录准备状态不可读取'); }
    if (state?.version !== 1 || typeof state.ready !== 'boolean' || typeof state.cursor !== 'string') {
      throw failure('记录目录准备状态不可读取');
    }
    if (state.ready) return;
  }
  let cursor = state.cursor, writes = 0, ready = false;
  const cursors = new Set(cursor ? [cursor] : []);
  for (let page = 0; page < 50 && writes < 200; page++) {
    const result = await bucket.list({ prefix: `${kind}/records/`, include: ['customMetadata'], limit: 200,
      ...(cursor ? { cursor } : {}) });
    const objects = result.objects.filter(x => x.key.startsWith(`${kind}/records/`) && x.key.endsWith('.json'));
    const active = objects.map(object => ({ object, meta: canonicalMetadata(object, kind) })).filter(x => x.meta.deleted === 'false');
    if (active.length > 200) throw failure('记录目录分页超过准备预算');
    if (writes + active.length > 200) break;
    for (let i = 0; i < active.length; i += 20) await Promise.all(active.slice(i, i + 20).map(({ object, meta }) =>
      prepareRecordMarker(bucket, kind, object.key.split('/').at(-1).slice(0, -5), { status: meta.status, etag: object.etag })));
    writes += active.length;
    if (!result.truncated) { ready = true; cursor = ''; break; }
    if (!result.cursor || cursors.has(result.cursor)) throw failure('记录目录准备游标未前进');
    cursor = result.cursor; cursors.add(cursor);
  }
  const saved = await bucket.put(key, JSON.stringify({ version: 1, ready, cursor }), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    onlyIf: found ? { etagMatches: found.etag } : new Headers({ 'if-none-match': '*' }),
  });
  if (!saved) {
    const current = await bucket.get(key);
    let latest;
    try { latest = await current?.json(); } catch { throw failure('记录目录准备状态不可读取'); }
    if (latest?.version === 1 && latest.ready === true && latest.cursor === '') return;
    throw preparing();
  }
  if (!ready) throw preparing();
}

export function listedMarker(object, kind, status) {
  const meta = object.customMetadata;
  const parts = object.key.slice(recordIndexPrefix(kind, status).length).split('/');
  if (!object.etag || parts.length !== 2 || meta?.schema !== 'moderation-index-v1' || meta.status !== status
    || !meta.id || parts[1] !== `${meta.id}.json`
    || !(meta.operationId && parts[0] === meta.operationId && Number.isSafeInteger(Number(meta.revision)) && Number(meta.revision) > 0
      || meta.canonicalEtag && parts[0].startsWith('etag-'))) throw failure('记录状态索引不可读取');
  return { ...object, id: meta.id, status, canonical: true, recordKey: `${kind}/records/${meta.id}.json`,
    operationId: meta.operationId || '', revision: Number(meta.revision || 0), canonicalEtag: meta.canonicalEtag || '' };
}
export function matchesMarker(meta, current, etag) {
  return meta.operationId ? current.operationId === meta.operationId : etag === meta.canonicalEtag;
}
export function pendingMarker(meta, current) {
  return !!meta.operationId && (!current || meta.revision > current.revision);
}

// 超预算时分批回收已证明无效的派生目录。每次至多200个HEAD，不读正文；
// startAfter使用最后一个完整key，删除前页不能改变下一页位置。
export async function maintainRecordIndex(bucket, kind, status, start = false, budget = 200) {
  const key = `${kind}/record-index-gc/v1/${status}.json`;
  const found = await bucket.get(key);
  let state = { version: 1, active: false, after: '' };
  if (found) {
    try { state = await found.json(); } catch { throw failure('记录目录回收状态不可读取'); }
    if (state?.version !== 1 || typeof state.active !== 'boolean' || typeof state.after !== 'string') {
      throw failure('记录目录回收状态不可读取');
    }
  }
  if (!state.active && !start) return;
  const after = state.active ? state.after : '';
  const prefix = recordIndexPrefix(kind, status);
  const page = await bucket.list({ prefix, limit: budget, include: ['customMetadata'], ...(after ? { startAfter: after } : {}) });
  const objects = page.objects;
  if (objects.length > budget) throw failure('记录目录回收分页超过预算');
  const garbage = [];
  for (let i = 0; i < objects.length; i += 20) await Promise.all(objects.slice(i, i + 20).map(async object => {
    const marker = listedMarker(object, kind, status);
    const current = await bucket.head(marker.recordKey);
    let stale;
    if (!current) stale = await abortedMarker(bucket, kind, marker);
    else {
      const meta = canonicalMetadata(current, kind);
      stale = meta.deleted === 'true' || (marker.operationId
        ? meta.operationId !== marker.operationId && marker.revision <= Number(meta.revision || 0)
        : current.etag !== marker.canonicalEtag);
      if (!stale && marker.operationId && meta.operationId !== marker.operationId) stale = await abortedMarker(bucket, kind, marker);
    }
    if (stale) garbage.push(object.key);
  }));
  // 删的是唯一不可复用的操作key；权威墓碑、中止凭据和未知canonical意图不动。
  if (garbage.length) await bucket.delete(garbage);
  const next = page.truncated ? objects.at(-1)?.key : '';
  if (page.truncated && (!next || next <= after)) throw failure('记录目录回收游标未前进');
  const saved = await bucket.put(key, JSON.stringify({ version: 1, active: !!page.truncated, after: next }), {
    onlyIf: found ? { etagMatches: found.etag } : new Headers({ 'if-none-match': '*' }),
  });
  // 一个请求只执行一批后续回收，最后一批也让下次请求再读取完整视图。
  throw preparing();
}
export async function previousMarkerKeys(kind, id, found) {
  if (!found?.canonical || found.deleted) return [];
  return [indexKey(kind, found.status, id, found.operationId), indexKey(kind, found.status, id, await oldToken(found.etag))];
}
export function validCleanupKey(key, kind, id) {
  if (typeof key !== 'string' || !key.startsWith(root(kind)) || !key.endsWith(`/${id}.json`)) return false;
  const parts = key.slice(root(kind).length).split('/');
  return parts.length === 3 && recordStatuses(kind).includes(parts[0]) && /^[a-zA-Z0-9_-]+$/.test(parts[1]) && parts[2] === `${id}.json`;
}
export async function cleanRecordMarkers(bucket, kind, value) {
  const keys = value?.indexCleanupKeys || [];
  if (!Array.isArray(keys) || keys.length > 2 || keys.some(key => !validCleanupKey(key, kind, value.id))) {
    throw failure('记录目录清理状态不可读取');
  }
  if (keys.length) await bucket.delete(keys);
}
