import { STRINGS_R2_BASE } from './constants.js';
import { showClipboardFallback } from '../app/clipboard-fallback.js';
import { writeClipboardText } from '../app/clipboard.js';
import { formatCopyText } from '../app/nai-sd.js';
import { isCommunitySdModeEnabled } from './sd-mode.js';

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

export async function copyText(text, options = {}) {
  const formatted = formatCopyText(text, {
    sdMode: isCommunitySdModeEnabled(),
    convert: options.convert !== false,
  });
  const result = await writeClipboardText(formatted.text, options.clipboardOptions);
  if (result.ok) return { ...result, converted: formatted.converted };

  let manualFallbackShown = false;
  if (options.manualFallback !== false) {
    try {
      manualFallbackShown = showClipboardFallback(formatted.text, { trigger: options.trigger });
    } catch {
      // Keep failure reporting truthful even if the fallback UI cannot mount.
    }
  }
  const error = new Error(
    manualFallbackShown ? '复制失败：已打开手动复制面板' : '复制失败',
  );
  error.copyResult = { ...result, converted: formatted.converted, manualFallbackShown };
  throw error;
}

export function promptExcerpt(text, max = 120) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  return raw.length > max ? raw.slice(0, max - 1) + '…' : raw;
}
