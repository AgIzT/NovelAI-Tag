import { toast } from '../app/feedback.js';
import { state } from './state.js';

const LIKE_INFO_STORAGE_KEY = 'community-like-info-seen-v1';
const pendingEntries = new Set();
let likeInfoShownThisSession = false;

function entryKey(entry) {
  return String(entry?.id || '');
}

function normalizeLikeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function patchLikeButton(button, entry) {
  const liked = Boolean(entry.liked);
  const count = normalizeLikeCount(entry.likeCount);
  const pending = pendingEntries.has(entryKey(entry));

  button.setAttribute('aria-pressed', String(liked));
  button.setAttribute('aria-label', `${liked ? '取消喜欢' : '喜欢'}，当前 ${count} 个喜欢`);
  button.setAttribute('aria-busy', String(pending));
  button.disabled = pending;
  const countNode = button.querySelector('[data-like-count]');
  if (countNode) countNode.textContent = String(count);
}

export function patchLikeControls(entry) {
  const key = entryKey(entry);
  if (!key) return;
  document.querySelectorAll('[data-like-entry]').forEach(button => {
    if (button.dataset.likeEntry === key) patchLikeButton(button, entry);
  });
}

export function createLikeButton(entry, className = '') {
  const key = entryKey(entry);
  if (!state.features.likes || !key) return null;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = ['community-like-btn', 'ui-press', className].filter(Boolean).join(' ');
  button.dataset.likeEntry = key;
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z"/></svg>
    <span data-like-count></span>
  `;
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    void toggleCommunityLike(entry);
  });
  button.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
  });
  patchLikeButton(button, entry);
  return button;
}

function showFirstLikeInfo() {
  if (likeInfoShownThisSession) return;

  let alreadyShown = false;
  try {
    alreadyShown = localStorage.getItem(LIKE_INFO_STORAGE_KEY) === '1';
  } catch {
    // 无法使用 localStorage 时仍只在本次页面会话提示一次。
  }
  if (alreadyShown) return;

  likeInfoShownThisSession = true;
  try {
    localStorage.setItem(LIKE_INFO_STORAGE_KEY, '1');
  } catch {
    // 提示标记不是点赞状态，存储失败不影响互动。
  }
  toast('喜欢会匿名计入热度；星标收藏仍只保存在本机。', '');
}

export async function toggleCommunityLike(entry) {
  const key = entryKey(entry);
  if (!state.features.likes || !key || pendingEntries.has(key)) return;

  const previous = {
    liked: Boolean(entry.liked),
    likeCount: normalizeLikeCount(entry.likeCount),
  };
  const nextLiked = !previous.liked;

  entry.liked = nextLiked;
  entry.likeCount = Math.max(0, previous.likeCount + (nextLiked ? 1 : -1));
  pendingEntries.add(key);
  patchLikeControls(entry);

  try {
    const response = await fetch(`/api/community-likes/${encodeURIComponent(key)}`, {
      method: nextLiked ? 'PUT' : 'DELETE',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok !== true) throw new Error(`HTTP ${response.status}`);
    if (result.id != null && String(result.id) !== key) throw new Error('点赞响应作品不匹配');

    entry.liked = Boolean(result.liked);
    entry.likeCount = normalizeLikeCount(result.likeCount);
    if (nextLiked && entry.liked) showFirstLikeInfo();
  } catch (error) {
    entry.liked = previous.liked;
    entry.likeCount = previous.likeCount;
    console.warn('共创广场喜欢操作失败', error);
    toast('暂时无法点赞，请稍后再试', '!');
  } finally {
    pendingEntries.delete(key);
    patchLikeControls(entry);
  }
}
