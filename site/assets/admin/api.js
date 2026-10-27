import { KEY } from './state.js';

function callStorage(storageName, method, ...args) {
  try {
    return globalThis[storageName]?.[method](...args);
  } catch {
    return null;
  }
}

// 旧版本曾把管理口令写入永久存储；加载新版审核页时立即清掉残留。
callStorage('localStorage', 'removeItem', KEY);

export function token() {
  return callStorage('sessionStorage', 'getItem', KEY) || '';
}

export function setToken(value) {
  callStorage('sessionStorage', 'setItem', KEY, value || '');
}

export function clearToken() {
  callStorage('sessionStorage', 'removeItem', KEY);
  callStorage('localStorage', 'removeItem', KEY);
}

function unauthorizedError(message) {
  clearToken();
  const error = new Error(message || '管理口令无效，重新填写后点「进入后台」');
  error.unauthorized = true;
  return error;
}

export async function adminApi(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      authorization: 'Bearer ' + token(),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw unauthorizedError(data.error);
  }
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || ('HTTP ' + res.status)), {
    status: res.status, resetPagination: data.resetPagination === true,
  });
  return data;
}

export function getCommunity(status, opts = {}) {
  return adminApi('/api/admin/community?status=' + encodeURIComponent(status), opts);
}

export function getStats(opts = {}) {
  return adminApi('/api/admin/community/stats', opts);
}

export function mutateCommunity(action, body = {}) {
  return adminApi('/api/admin/community/' + encodeURIComponent(action), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// 取社区图片原始字节（隐写复检用；r2.dev 公开域拿不到 CORS 干净的字节流）
export async function fetchCommunityAsset(key) {
  const res = await fetch('/api/admin/community/asset?key=' + encodeURIComponent(key), {
    headers: { authorization: 'Bearer ' + token() },
  });
  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    throw unauthorizedError(data.error);
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.blob();
}

export async function getFeedback(status, opts = {}) {
  // 首次/大量变更分批准备完整排序；202 不是空列表，离页后停止后续批次。
  const { cursor: initialCursor = '', ...requestOpts } = opts;
  let cursor = initialCursor, paginationReset = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    requestOpts.signal?.throwIfAborted();
    let data;
    try {
      data = await adminApi('/api/admin/feedback?status=' + encodeURIComponent(status)
        + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), requestOpts);
    } catch (error) {
      requestOpts.signal?.throwIfAborted();
      if (error.status !== 409 || !error.resetPagination || !cursor) throw error;
      cursor = ''; paginationReset = true;
      continue;
    }
    requestOpts.signal?.throwIfAborted();
    if (!data.indexing) return paginationReset ? { ...data, paginationReset } : data;
  }
  throw new Error('反馈列表仍在准备中，请点击「刷新反馈」继续加载');
}

export function updateFeedback(id, sourceStatus, progressStatus, adminReply, publicVisible) {
  return adminApi('/api/admin/feedback-decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id,
      action: 'update',
      sourceStatus,
      progressStatus,
      adminReply,
      publicVisible,
    }),
  });
}

export function deleteFeedback(id, status) {
  return adminApi('/api/admin/feedback-delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, status }),
  });
}
