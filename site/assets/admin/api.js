import { KEY } from './state.js';

export function token() {
  return sessionStorage.getItem(KEY) || '';
}

export function setToken(value) {
  sessionStorage.setItem(KEY, value || '');
}

export function clearToken() {
  sessionStorage.removeItem(KEY);
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
    clearToken();
    const error = new Error(data.error || '管理口令错误或已失效');
    error.unauthorized = true;
    throw error;
  }
  if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
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
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.blob();
}

export function getFeedback(status, opts = {}) {
  return adminApi('/api/admin/feedback?status=' + encodeURIComponent(status), opts);
}

export function decideFeedback(id, action, sourceStatus = '') {
  return adminApi('/api/admin/feedback-decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, action, sourceStatus }),
  });
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
