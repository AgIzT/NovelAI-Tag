import { $, esc, safeJsonParse } from './utils.js';
import { openMask, closeMask, trapFocus, bindBackdropDismiss } from './modal.js';
import { animateUi, cancelUiMotion } from './ui-motion.js';
import { formatRecentTime } from './history.js';
import { fetchDataJson } from '../data-source.js';
import {
  loadUpdates, updatesDigest, renderUpdatesList, markUpdatesRead, handleUpdateRowClick,
} from './updates.js';

const READ_STORAGE_KEY = 'fadian-ann-read-ids';
const TABS = ['updates', 'announcements', 'feedback'];

let announcements = [];
let loaded = false;
let loadingPromise = null;
let activeTab = 'announcements';
let finishTabMotion = null;

/* 面板由顶栏气泡的三个入口驱动，气泡自己不渲染内容——它只回答「有没有」，
   点开哪一栏由 openAnnouncementsPanel 的 tab 参数决定。 */
export function setupAnnouncements({ closeMore = () => {}, trigger = null, historyMode = () => 'push' } = {}) {
  if (document.body?.classList.contains('local-edition')) return;
  const mask = $('#announcementsPanel');
  const btn = $('#announcementsBtn');
  if (!mask || !btn) return;
  mask.addEventListener('click', event => {
    const tabBtn = event.target.closest?.('[data-announcements-tab]');
    if (tabBtn && mask.contains(tabBtn)) {
      selectAnnouncementsTab(String(tabBtn.dataset.announcementsTab || ''));
      return;
    }
    /* 不手动 closeMask：那会发一次异步 history.back()，和随后的换书 push 抢历史栈，
       结果是路由到了、面板还开着。交给 openBatch 的 consumeLayer 顶掉这一层。 */
    handleUpdateRowClick(event, { consumeLayer: true });
  });
  $('#announcementsClose')?.addEventListener('click', () => closeMask(mask));
  bindBackdropDismiss(mask, () => closeMask(mask));
  mask.addEventListener('keydown', ev => {
    const tabBtn = ev.target.closest?.('[data-announcements-tab]');
    if (tabBtn && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) {
      ev.preventDefault();
      const index = TABS.indexOf(tabBtn.dataset.announcementsTab);
      const nextIndex = ev.key === 'Home' ? 0 : ev.key === 'End' ? TABS.length - 1
        : (index + (ev.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
      selectAnnouncementsTab(TABS[nextIndex]);
      mask.querySelector('[data-announcements-tab="' + TABS[nextIndex] + '"]')?.focus({ preventScroll: true });
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeMask(mask);
      return;
    }
    trapFocus(ev, mask);
  });
  /* Back 也通过共享 modal 移除 show；关闭时结清页签动效，不留下离流的旧页。 */
  new MutationObserver(() => {
    if (!mask.classList.contains('show') || mask.hidden) finishTabMotion?.();
  }).observe(mask, { attributes: true, attributeFilter: ['class', 'hidden'] });
  /* 两条流各自失败互不牵连：公告挂了不该让更新页签也空着，反之亦然。 */
  Promise.allSettled([loadAnnouncements(), loadUpdates()]).then(updateAnnouncementBadge);
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
    .catch(error => {
      console.warn('[announcements] 公告加载失败，将在下次打开时重试', error);
      announcements = [];
      return announcements;
    })
    .finally(() => { loadingPromise = null; });
  return loadingPromise;
}

export function openAnnouncementsPanel(trigger = document.activeElement, { historyMode = 'push', tab = '' } = {}) {
  const mask = $('#announcementsPanel');
  if (!mask) return;
  finishTabMotion?.();
  renderAnnouncements();
  selectAnnouncementsTab(tab || defaultTab());
  openMask(mask, trigger, { historyMode });
}

/* 未读优先：有更新就先开更新页，其次公告，都读完了回到公告。 */
function defaultTab() {
  if (updatesDigest().entries > 0) return 'updates';
  if (hasUnreadAnnouncements()) return 'announcements';
  return 'announcements';
}

export function selectAnnouncementsTab(value) {
  const tab = TABS.includes(value) ? value : 'announcements';
  const mask = $('#announcementsPanel');
  const shell = mask?.querySelector('.announcements-views');
  const views = {
    updates: $('#announcementsUpdatesView'),
    announcements: $('#announcementsNoticeView'),
    feedback: $('#announcementsFeedbackView'),
  };
  const previous = views[activeTab];
  const next = views[tab];
  const open = Boolean(mask && !mask.hidden && mask.classList.contains('show'));
  if (tab === activeTab && open && next && !next.hidden) return;
  const moving = Boolean(open && shell && previous && next && tab !== activeTab);
  /* 快速切换从此刻的可见高度接续，先结清上一轮再建立新的离流旧页。 */
  const oldHeight = moving ? shell.getBoundingClientRect().height : 0;
  const oldOpacity = moving ? getComputedStyle(previous).opacity : '1';
  const direction = TABS.indexOf(tab) > TABS.indexOf(activeTab) ? 1 : -1;
  finishTabMotion?.();
  activeTab = tab;
  mask?.querySelector('.announcements-tabs')?.style.setProperty('--ann-tab-index', String(TABS.indexOf(tab)));
  document.querySelectorAll('[data-announcements-tab]').forEach(button => {
    const active = button.dataset.announcementsTab === tab;
    button.setAttribute('aria-selected', active ? 'true' : 'false');
    button.tabIndex = active ? 0 : -1;
  });
  for (const [key, view] of Object.entries(views)) {
    if (!view) continue;
    view.hidden = key !== tab;
    view.inert = key !== tab;
    view.setAttribute('aria-hidden', key === tab ? 'false' : 'true');
  }
  /* 只把当前这一栏标记为已读——用户没翻到的那栏不该被顺手清掉红点。 */
  if (tab === 'updates') {
    renderUpdatesList($('#updatesList'));
    markUpdatesRead();
  } else if (tab === 'announcements') {
    markVisibleAnnouncementsRead();
  }
  updateAnnouncementBadge();
  if (moving) animateTabViews(shell, previous, next, { oldHeight, oldOpacity, direction });
}

function animateTabViews(shell, previous, next, { oldHeight, oldOpacity, direction }) {
  const newHeight = shell.getBoundingClientRect().height;
  const shellStyle = shell.style.cssText;
  const previousStyle = previous.style.cssText;
  previous.hidden = false;
  Object.assign(previous.style, { position: 'absolute', inset: '0 0 auto', pointerEvents: 'none' });
  shell.style.overflow = 'hidden';
  const finish = () => {
    if (finishTabMotion !== finish) return;
    finishTabMotion = null;
    cancelUiMotion(previous);
    cancelUiMotion(next);
    cancelUiMotion(shell);
    previous.hidden = true;
    previous.style.cssText = previousStyle;
    shell.style.cssText = shellStyle;
  };
  finishTabMotion = finish;
  const outgoing = animateUi(previous, [
    { opacity: oldOpacity, translate: '0 0' },
    { opacity: 0, translate: String(-direction * 8) + 'px 0' },
  ], { duration: 150, easing: 'ease-out' });
  const incoming = animateUi(next, [
    { opacity: 0, translate: String(direction * 10) + 'px 0' },
    { opacity: 1, translate: '0 0' },
  ]);
  const resizing = animateUi(shell, [
    { height: String(oldHeight) + 'px' },
    { height: String(newHeight) + 'px' },
  ]);
  if (!incoming && !resizing) {
    finish();
    return;
  }
  /* 较短的淡出先收起，避免动画释放 opacity 后旧内容又亮一帧。 */
  outgoing?.finished.then(() => {
    if (finishTabMotion === finish) previous.hidden = true;
  }, () => {});
  Promise.allSettled([incoming?.finished, resizing?.finished]).then(finish);
}

/* 顶栏一枚按钮同时代表两条流：有数字就显示数字（更新条数），
   只有公告未读时退回一个小红点，避免为「1 条公告」打出一个大数字。 */
export function updateAnnouncementBadge() {
  const dot = $('#announcementsDot');
  const count = $('#updatesCount');
  const digest = updatesDigest();
  const annUnread = hasUnreadAnnouncements();
  const unread = annUnread || digest.batches > 0;
  if (count) {
    count.textContent = digest.batches > 0 ? String(digest.batches) : '';
    count.hidden = digest.batches <= 0;
  }
  if (dot) dot.hidden = !annUnread || digest.batches > 0;
  const btn = $('#announcementsBtn');
  if (btn) btn.classList.toggle('has-unread', unread);
  const tabDots = {
    updates: digest.entries > 0,
    announcements: annUnread,
  };
  document.querySelectorAll('[data-tab-dot]').forEach(node => {
    node.hidden = !tabDots[node.dataset.tabDot];
  });
  const popDot = document.querySelector('[data-updates-ann-dot]');
  if (popDot) popDot.hidden = !annUnread;
}

function hasUnreadAnnouncements() {
  const ids = readIds();
  return activeAnnouncements().some(item => !ids.has(item.id));
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
  try {
    localStorage.setItem(READ_STORAGE_KEY, JSON.stringify([...ids].slice(-80)));
  } catch {}
}

function readIds() {
  let raw = null;
  try {
    raw = localStorage.getItem(READ_STORAGE_KEY);
  } catch {}
  const arr = safeJsonParse(raw, []);
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
