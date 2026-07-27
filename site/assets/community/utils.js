import { STRINGS_R2_BASE } from './constants.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function safeStorageGet(key) {
  try {
    const storage = globalThis.localStorage;
    return storage ? storage.getItem(String(key)) : null;
  } catch {
    return null;
  }
}

export function safeStorageSet(key, value) {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.setItem(String(key), String(value));
    return true;
  } catch {
    return false;
  }
}

export function escHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[char]));
}

export function escAttr(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

export function isLocal() {
  return ['localhost', '127.0.0.1', '::1'].includes(location.hostname) || location.protocol === 'file:';
}

export function normalizeImage(image) {
  if (typeof image === 'string') return { file: image, label: 'gallery' };
  if (!image || typeof image !== 'object') return { file: '', label: 'gallery' };
  return { ...image, file: image.file || '', label: image.label || 'gallery' };
}

export function imageUrl(file) {
  const raw = String(file || '');
  if (!raw) return '';
  if (/^(https?:)?\/\//i.test(raw) || raw.startsWith('data:') || raw.startsWith('/')) return raw;
  const path = ['images', 'strings', raw]
    .map(part => encodeURIComponent(part).replace(/%2F/g, '/'))
    .join('/');
  return isLocal() ? path : `${STRINGS_R2_BASE}/${path}`;
}

export async function copyText(text) {
  const raw = String(text || '');
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(raw);
    return;
  }
  const area = document.createElement('textarea');
  area.value = raw;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    area.remove();
  }
  if (!copied) throw new Error('复制失败');
}

export function promptExcerpt(text, max = 120) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  return raw.length > max ? raw.slice(0, max - 1) + '…' : raw;
}
