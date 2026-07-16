import { $, esc, safeJsonParse } from './utils.js';
import { openMask, closeMask, trapFocus } from './modal.js';
import { formatRecentTime } from './history.js';

const ANNOUNCEMENT_URL = 'data/announcements.json';
const READ_STORAGE_KEY = 'fadian-ann-read-ids';

let announcements = [];
let loaded = false;
let loadingPromise = null;

export function setupAnnouncements({ closeMore = () => {}, trigger = null, historyMode = () => 'push' } = {}) {
  const mask = $('#announcementsPanel');
  const btn = $('#announcementsBtn');
  if (!mask || !btn) return;
  btn.addEventListener('click', async () => {
    closeMore();
    await loadAnnouncements();
    openAnnouncementsPanel(trigger || btn, { historyMode: historyMode() });
  });
  $('#announcementsClose')?.addEventListener('click', () => closeMask(mask));
  mask.addEventListener('click', ev => { if (ev.target === mask) closeMask(mask); });
  mask.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeMask(mask);
      return;
    }
    trapFocus(ev, mask);
  });
  loadAnnouncements().then(updateAnnouncementBadge).catch(() => updateAnnouncementBadge());
}

export async function loadAnnouncements() {
  if (loaded) return announcements;
  if (loadingPromise) return loadingPromise;
  loadingPromise = fetch(ANNOUNCEMENT_URL, { cache: 'no-store' })
    .then(res => res.ok ? res.json() : [])
    .then(data => {
      announcements = normalizeAnnouncements(data);
      loaded = true;
      return announcements;
    })
    .catch(() => {
      announcements = [];
      loaded = true;
      return announcements;
    })
    .finally(() => { loadingPromise = null; });
  return loadingPromise;
}

export function openAnnouncementsPanel(trigger = document.activeElement, { historyMode = 'push' } = {}) {
  const mask = $('#announcementsPanel');
  if (!mask) return;
  renderAnnouncements();
  markVisibleAnnouncementsRead();
  updateAnnouncementBadge();
  openMask(mask, trigger, { historyMode });
}

export function updateAnnouncementBadge() {
  const dot = $('#announcementsDot');
  if (!dot) return;
  const unread = activeAnnouncements().some(item => !readIds().has(item.id));
  dot.hidden = !unread;
  const btn = $('#announcementsBtn');
  if (btn) btn.classList.toggle('has-unread', unread);
}

function renderAnnouncements() {
  const list = $('#announcementsList');
  if (!list) return;
  const items = activeAnnouncements();
  if (!items.length) {
    list.innerHTML = '<div class="announcement-empty">暂无公告。</div>';
    return;
  }
  list.innerHTML = items.map(item => `
    <article class="announcement-item level-${esc(item.level)}">
      <div class="announcement-icon" aria-hidden="true">${levelIcon(item.level)}</div>
      <div class="announcement-main">
        <div class="announcement-title-row">
          <h3>${esc(item.title)}</h3>
          <time datetime="${esc(item.date)}">${esc(formatAnnouncementTime(item.date))}</time>
        </div>
        <p>${esc(item.body)}</p>
        ${item.link ? `<a class="announcement-link" href="${esc(item.link)}" target="_blank" rel="noopener">查看详情</a>` : ''}
      </div>
    </article>
  `).join('');
}

function markVisibleAnnouncementsRead() {
  const ids = readIds();
  for (const item of activeAnnouncements()) ids.add(item.id);
  localStorage.setItem(READ_STORAGE_KEY, JSON.stringify([...ids].slice(-80)));
}

function readIds() {
  const arr = safeJsonParse(localStorage.getItem(READ_STORAGE_KEY), []);
  return new Set(Array.isArray(arr) ? arr.map(String) : []);
}

function activeAnnouncements() {
  return announcements.filter(item => item.active !== false);
}

function normalizeAnnouncements(data) {
  if (!Array.isArray(data)) return [];
  return data
    .map(item => ({
      id: String(item?.id || '').trim(),
      title: String(item?.title || '').trim(),
      body: String(item?.body || '').trim(),
      date: String(item?.date || '').trim(),
      level: ['info', 'warning', 'success'].includes(String(item?.level || '')) ? String(item.level) : 'info',
      active: item?.active !== false,
      link: normalizeLink(item?.link),
    }))
    .filter(item => item.id && item.title && item.body)
    .sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0));
}

function normalizeLink(value) {
  const link = String(value || '').trim();
  if (!link) return '';
  try {
    const url = new URL(link, location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function formatAnnouncementTime(dateText) {
  const ts = Date.parse(dateText);
  if (!Number.isFinite(ts)) return dateText || '';
  const now = new Date();
  const date = new Date(ts);
  if (now.toDateString() === date.toDateString()) return '今天';
  return formatRecentTime(ts);
}

function levelIcon(level) {
  if (level === 'warning') return '!';
  if (level === 'success') return 'ok';
  return 'i';
}
