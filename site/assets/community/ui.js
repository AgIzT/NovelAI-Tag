import { updateScrollProgress } from '../app/utils.js';
import { dismissToast, toast } from '../app/feedback.js';
import { scrubClipboardFallback } from '../app/clipboard-fallback.js';
import { closeMask } from '../app/modal.js';
import { forgetHistoryLayer, goBackFrom, scheduleHistoryScrollCheckpoint } from '../app/browser-history.js';
import { COMMUNITY_CATEGORIES } from './constants.js';
import { favoriteCountForEntries, favoriteKey, isFavorite, toggleFavorite } from './favorites.js';
import { currentCommunityHistorySession, syncCommunityHistory } from './router.js';
import { requestCommunityNsfwAccess } from './nsfw-confirm.js';
import { revokeCommunityDetailAccess } from './detail.js';
import { ADULT_CONFIRMATION_STORAGE_KEY } from '../app/state.js';
import {
  COMMUNITY_NSFW_PREFERENCE_KEY,
  hasAdultNsfwConfirmation,
  shouldRestoreCommunityNsfw,
  state,
} from './state.js';
import { $, $$, safeStorageSet } from './utils.js';
import { renderCategoryRail, renderEmptyState, renderGrid, renderResultBar } from './render.js';

let openDetail = null;
let openSubmit = null;
let nsfwRequestSeq = 0;
let deferredNsfwDetail = null;
const pendingFavorites = new Set();
const nextSearchSessionId = () => `community-search-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export function initCommunityUI(handlers = {}) {
  openDetail = handlers.openDetail || null;
  openSubmit = handlers.openSubmit || null;

  bindSearch();
  bindNsfw();
  bindFavorites();
  bindTheme();
  bindFocusSearch();
  bindScrollProgress();
  renderCategoryRail(selectCategory);
  updateNSFWButton();
}

export function applyCommunityFilters({ scrollTop = false } = {}) {
  let list = [...state.entries];
  const query = state.query.trim().toLowerCase();

  if (query) {
    const terms = query.split(/\s+/).filter(Boolean);
    list = list.filter(entry => {
      const haystack = [
        entry.title,
        entry.prompt,
        entry.negative,
        entry.comment,
        entry.submitter,
        ...(entry.tags || []),
        ...(entry.category || []),
      ].join('\n').toLowerCase();
      return terms.every(term => haystack.includes(term));
    });
  }

  if (state.activeCategory) {
    list = list.filter(entry => entry.category?.[0] === state.activeCategory);
  }

  if (state.onlyFavorites) list = list.filter(isFavorite);

  state.hiddenNsfwMatches = state.showNSFW ? 0 : list.filter(entry => entry.nsfw).length;
  if (!state.showNSFW) list = list.filter(entry => !entry.nsfw);

  state.filtered = list;
  renderCategoryRail(selectCategory);
  renderResultBar();
  renderGrid(state.filtered, { onOpenDetail: openDetail && openDetailFromGrid, onToggleFavorite: handleToggleFavorite });
  renderEmptyState({
    onSubmit: () => openSubmit?.(),
    onClearSearch: clearSearch,
    onShowAll: showAll,
    onShowFavoritesAll: showFavoritesAll,
    onShowNSFW: () => requestShowCommunityNsfw(),
  });

  if (scrollTop) {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
}

async function handleToggleFavorite(entry) {
  const key = favoriteKey(entry);
  if (pendingFavorites.has(key)) return;
  pendingFavorites.add(key);
  try {
    const result = await toggleFavorite(entry);
    if (!result.ok) {
      const message = result.reason === 'quota' ? '收藏没能保存：浏览器存储已满，打开「收藏备份」备份并清理后重试'
        : result.reason === 'corrupt' ? '收藏数据无法读取，打开「收藏备份」导出原数据后再恢复'
        : result.reason === 'lock' ? '收藏没能保存，另一个标签页正在修改。重试一次。'
        : result.reason === 'rollback' ? '收藏保存未完成，打开「收藏备份」检查当前内容'
        : '收藏没能保存：浏览器禁止了本站的本地存储，恢复存储权限后重试';
      toast(message, '!');
      return;
    }
    toast(result.active ? '已收藏' : '已取消收藏');
    updateFavoriteButton();
    applyCommunityFilters();
    syncCommunityHistory({ historyMode: 'replace' });
  } finally { pendingFavorites.delete(key); }
}

function selectCategory(category) {
  const parentScrollY = Math.max(0, window.scrollY || 0);
  const next = COMMUNITY_CATEGORIES.includes(category) ? category : null;
  const changed = state.activeCategory !== next;
  state.activeCategory = next;
  applyCommunityFilters({ scrollTop: true });
  syncCommunityHistory({ historyMode: changed ? 'push' : 'replace', transition: 'route', parentScrollY });
}

function clearSearch() {
  const parentScrollY = Math.max(0, window.scrollY || 0);
  const hadQuery = Boolean(state.query.trim());
  state.query = '';
  state.searchHistorySessionId = '';
  const input = $('#search');
  if (input) input.value = '';
  const clear = $('#searchClear');
  if (clear) clear.hidden = true;
  if (hadQuery && goBackFrom('search')) return;
  applyCommunityFilters({ scrollTop: true });
  syncCommunityHistory({ historyMode: 'replace', transition: 'route', sessionId: null, parentScrollY });
}

function showAll() {
  const parentScrollY = Math.max(0, window.scrollY || 0);
  state.activeCategory = null;
  state.query = '';
  state.searchHistorySessionId = '';
  const input = $('#search');
  if (input) input.value = '';
  const clear = $('#searchClear');
  if (clear) clear.hidden = true;
  applyCommunityFilters({ scrollTop: true });
  syncCommunityHistory({ historyMode: 'push', transition: 'route', sessionId: null, parentScrollY });
}

function showFavoritesAll() {
  state.onlyFavorites = false;
  safeStorageSet('community-only-favorites', 'false');
  updateFavoriteButton();
  applyCommunityFilters({ scrollTop: true });
  syncCommunityHistory({ historyMode: 'replace' });
}

function bindFocusSearch() {
  $$('[data-focus-search]').forEach(button => {
    button.addEventListener('click', () => $('#search')?.focus());
  });
}

function bindSearch() {
  const input = $('#search');
  const clear = $('#searchClear');
  if (!input) return;

  let timer = 0;
  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const parentScrollY = Math.max(0, window.scrollY || 0);
      const previous = state.query.trim();
      state.query = input.value;
      const next = state.query.trim();
      if (clear) clear.hidden = !input.value;
      if (!next && previous && goBackFrom('search')) {
        state.searchHistorySessionId = '';
        return;
      }
      const firstQuery = Boolean(next && !previous);
      if (firstQuery) state.searchHistorySessionId = nextSearchSessionId();
      applyCommunityFilters({ scrollTop: true });
      syncCommunityHistory({
        historyMode: firstQuery ? 'push' : 'replace',
        transition: next ? 'search' : 'route',
        sessionId: next
          ? (state.searchHistorySessionId || currentCommunityHistorySession() || undefined)
          : null,
        parentScrollY,
      });
    }, 140);
  });
  clear?.addEventListener('click', clearSearch);
}

function bindNsfw() {
  $('#nsfwBtn')?.addEventListener('click', event => {
    if (!state.showNSFW) {
      requestShowCommunityNsfw({ trigger: event.currentTarget });
      return;
    }
    hideCommunityNsfw({ scrollTop: true });
  });
  window.addEventListener('storage', event => {
    if (event.key !== COMMUNITY_NSFW_PREFERENCE_KEY && event.key !== null) return;
    if (event.newValue !== 'true' || !shouldRestoreCommunityNsfw()) {
      hideCommunityNsfw({ persist: false });
      return;
    }
    // 别的标签页开启不算本页的明确动作：不替用户打开分享链接那条，卡片已经回到列表里。
    deferredNsfwDetail = null;
    state.showNSFW = true;
    updateNSFWButton();
    applyCommunityFilters();
    syncCommunityHistory({ historyMode: 'replace' });
  });
}

function hideCommunityNsfw({ persist = true, scrollTop = false } = {}) {
  state.showNSFW = false;
  nsfwRequestSeq += 1;
  if (persist) safeStorageSet(COMMUNITY_NSFW_PREFERENCE_KEY, false);
  const confirmation = $('#communityNsfwConfirm');
  if (confirmation) closeMask(confirmation, { historyMode: 'none' });
  forgetHistoryLayer('communityNsfwConfirm');
  revokeCommunityDetailAccess();
  scrubClipboardFallback({ historyMode: 'none' });
  // 直接收起还要移除托管浮层，否则 Forward 会恢复失效确认框或空复制框。
  forgetHistoryLayer('clipboardFallback');
  dismissToast({ clear: true });
  updateNSFWButton();
  applyCommunityFilters({ scrollTop });
  syncCommunityHistory({ historyMode: 'replace' });
}

/* 分享链接指向 NSFW 投稿但混显关着：先记下这条，用户在本页明确开启混显（提示、顶栏开关、
   空状态按钮）时再打开；提示消失后仍能回到它。 */
export function deferCommunityNsfwDetail(open) {
  deferredNsfwDetail = typeof open === 'function' ? open : null;
}

// 用户已经点开别的投稿，就不再在开启混显时跳回分享链接那条。
function openDetailFromGrid(...args) {
  deferredNsfwDetail = null;
  return openDetail?.(...args);
}

export function requestShowCommunityNsfw({ trigger = document.activeElement, onEnabled } = {}) {
  if (state.showNSFW) {
    onEnabled?.({ consumeLayer: false });
    return;
  }
  const seq = ++nsfwRequestSeq;
  const enable = ({ consumeLayer = false } = {}) => {
    if (seq !== nsfwRequestSeq) return;
    const next = onEnabled || deferredNsfwDetail;
    deferredNsfwDetail = null;
    state.showNSFW = true;
    safeStorageSet(COMMUNITY_NSFW_PREFERENCE_KEY, true);
    safeStorageSet(ADULT_CONFIRMATION_STORAGE_KEY, '1');
    updateNSFWButton();
    applyCommunityFilters({ scrollTop: true });
    if (next) next({ consumeLayer });
    else syncCommunityHistory({ historyMode: 'replace', consumeLayer });
  };
  // 主站已经完成过同一份成人确认时，不重复打扰；只恢复广场偏好。
  if (hasAdultNsfwConfirmation()) {
    enable();
    return;
  }
  requestCommunityNsfwAccess({
    trigger,
    onAccept: enable,
  });
}

function bindFavorites() {
  $('#favFilterBtn')?.addEventListener('click', () => {
    state.onlyFavorites = !state.onlyFavorites;
    safeStorageSet('community-only-favorites', state.onlyFavorites);
    updateFavoriteButton();
    applyCommunityFilters({ scrollTop: true });
    syncCommunityHistory({ historyMode: 'replace' });
  });
  updateFavoriteButton();
}

function updateFavoriteButton() {
  const btn = $('#favFilterBtn');
  if (!btn) return;
  const count = favoriteCountForEntries(state.entries);
  btn.classList.toggle('active', state.onlyFavorites);
  btn.setAttribute('aria-pressed', String(state.onlyFavorites));
  btn.title = state.onlyFavorites ? `只看收藏 · ${count} 条` : `收藏 · ${count} 条`;
}

function updateNSFWButton() {
  const btn = $('#nsfwBtn');
  if (!btn) return;
  btn.classList.toggle('active', state.showNSFW);
  btn.setAttribute('aria-pressed', String(state.showNSFW));
  const total = state.entries.filter(entry => entry.nsfw).length;
  btn.title = state.showNSFW ? `NSFW 混显中 · ${total} 条` : `NSFW 已隐藏 · ${total} 条`;
}

function bindTheme() {
  $('#themeBtn')?.addEventListener('click', () => {
    const dark = !document.body.classList.contains('dark');
    document.body.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    safeStorageSet('fadian-dark', dark ? '1' : '0');
  });
}

function bindScrollProgress() {
  updateScrollProgress();
  window.addEventListener('scroll', () => {
    updateScrollProgress();
    scheduleHistoryScrollCheckpoint();
  }, { passive: true });
  window.addEventListener('resize', updateScrollProgress, { passive: true });
}

export function syncAfterLoad() {
  updateNSFWButton();
  updateFavoriteButton();
  applyCommunityFilters();
}

export function applyCommunityRoute(route, context = {}) {
  state.activeCategory = COMMUNITY_CATEGORIES.includes(route?.category) ? route.category : null;
  state.query = String(route?.q || '');
  state.onlyFavorites = Boolean(route?.onlyFavorites);
  state.searchHistorySessionId = context.target?.sessionId || '';
  const input = $('#search');
  if (input) input.value = state.query;
  const clear = $('#searchClear');
  if (clear) clear.hidden = !state.query;
  updateFavoriteButton();
  applyCommunityFilters();
}
