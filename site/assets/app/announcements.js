import { $, esc, safeJsonParse } from './utils.js';
import { openMask, closeMask, trapFocus } from './modal.js';
import { formatRecentTime } from './history.js';
import { fetchDataJson } from '../data-source.js';

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
  loadingPromise = fetchDataJson('announcements.json', { cache: 'no-store' })
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
      <div class="announcement-icon" data-icon="${esc(item.icon || item.level)}" aria-hidden="true">${announcementIcon(item.icon, item.level)}</div>
      <div class="announcement-main">
        <div class="announcement-title-row">
          <h3>${esc(item.title)}</h3>
          <time datetime="${esc(item.date)}">${esc(formatAnnouncementTime(item.date))}</time>
        </div>
        ${item.lead ? `<p class="announcement-lead"><strong>${esc(item.lead)}</strong></p>` : ''}
        <p class="announcement-body">${esc(item.body)}</p>
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
      lead: String(item?.lead || '').trim(),
      body: String(item?.body || '').trim(),
      date: String(item?.date || '').trim(),
      level: ['info', 'warning', 'success'].includes(String(item?.level || '')) ? String(item.level) : 'info',
      icon: ['feedback', 'collaboration'].includes(String(item?.icon || '')) ? String(item.icon) : '',
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

function announcementIcon(icon, level) {
  if (icon === 'feedback') return `
    <svg viewBox="0 0 24 24" focusable="false">
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path>
      <path d="m9 11 2 2 4-4"></path>
    </svg>`;
  if (icon === 'collaboration') return `
    <svg viewBox="0 0 24 24" focusable="false">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
      <circle cx="9" cy="7" r="4"></circle>
      <path d="M22 21v-2a4 4 0 0 0-3-3.87"></path>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
    </svg>`;
  if (level === 'warning') return `
    <svg viewBox="0 0 24 24" focusable="false">
      <path d="M10.3 3.7 2.4 17.5A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.5L13.7 3.7a2 2 0 0 0-3.4 0z"></path>
      <path d="M12 9v4"></path><path d="M12 17h.01"></path>
    </svg>`;
  if (level === 'success') return `
    <svg viewBox="0 0 24 24" focusable="false">
      <circle cx="12" cy="12" r="9"></circle><path d="m8 12 2.5 2.5L16 9"></path>
    </svg>`;
  return `
    <svg viewBox="0 0 24 24" focusable="false">
      <circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path>
    </svg>`;
}
