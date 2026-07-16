import { state, RECENT_ENTRY_LIMIT, RECENT_STORAGE_KEY, LAST_BROWSE_STORAGE_KEY } from './state.js';
import { $, esc, updateSearchClear, updateScrollProgress } from './utils.js';
import { hasEntryImage, thumbUrl } from './media.js';
import { syncUrlState } from './router.js';
import { firstUnlockedCodex, isCodexLocked, isR18gPath, showNsfwLockedHint, showR18gLockedHint } from './access.js';
import { toast } from './feedback.js';
import { findCodexMeta } from './data.js';
import { FAVORITES_CODEX_ID } from './fav-codex.js';
import { SITE_SEARCH_CODEX_ID } from './site-search.js';
import { isHistoryRestoreToken } from './browser-history.js';

const historyActions = {
  loadCodex: async () => {},
  openFavoritesView: async () => {},
  openSiteSearchView: async () => {},
  openEntryDeepLink: () => {},
  renderTree: () => {},
  applyFilter: () => {},
  updateVirtualCards: () => {},
};

export function setHistoryActions(actions = {}) {
  Object.assign(historyActions, actions);
}

export function normalizeRecentEntries(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => item && item.codexId && item.entryId && item.title)
    .map(item => ({
      codexId: String(item.codexId),
      codexTitle: String(item.codexTitle || item.codexId),
      entryId: String(item.entryId),
      title: String(item.title),
      path: Array.isArray(item.path) ? item.path.map(String) : [],
      thumb: String(item.thumb || ''),
      at: Number(item.at) || Date.now(),
    }))
    .slice(0, RECENT_ENTRY_LIMIT);
}

export function normalizeLastBrowse(value) {
  if (!value || typeof value !== 'object' || !value.codexId) return null;
  return {
    codexId: String(value.codexId),
    codexTitle: String(value.codexTitle || value.codexId),
    path: Array.isArray(value.path) ? value.path.map(String) : [],
    q: String(value.q || ''),
    onlyImaged: Boolean(value.onlyImaged),
    onlyFav: Boolean(value.onlyFav),
    favoritesView: Boolean(value.favoritesView || value.favMode || value.onlyFav || value.codexId === FAVORITES_CODEX_ID),
    siteSearchView: Boolean(value.siteSearchView || value.searchView || value.codexId === SITE_SEARCH_CODEX_ID),
    searchScope: value.searchScope === 'codex' ? 'codex' : 'site',
    entryId: String(value.entryId || ''),
    scrollY: Math.max(0, Number(value.scrollY) || 0),
    at: Number(value.at) || Date.now(),
  };
}

/* ---------------- 浏览记录 ---------------- */
export function saveRecentEntries() {
  localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(state.recentEntries));
}

export function recordRecentEntry(e) {
  if (!state.codex || !e) return;
  /* 全部收藏视图里的词条带 _src* 标记：记录归到真实法典，点开记录才能跳回原书原分类 */
  const codexId = e._srcCodexId || state.codex.id;
  const codexTitle = e._srcCodexTitle || state.codex.title;
  const key = `${codexId}:${e.id}`;
  const item = {
    codexId,
    codexTitle,
    entryId: e.id,
    title: e.title,
    path: e._srcPath || e.path || [],
    thumb: hasEntryImage(e) ? thumbUrl(e) : '',
    at: Date.now(),
  };
  state.recentEntries = [
    item,
    ...state.recentEntries.filter(old => `${old.codexId}:${old.entryId}` !== key),
  ].slice(0, RECENT_ENTRY_LIMIT);
  saveRecentEntries();
}

function isHiddenR18gHistoryItem(item) {
  return !state.allowR18g && isR18gPath(item?.path || []);
}

let browseSaveTimer = 0;
let browseSaveSuppressedUntil = 0;
export function currentBrowseSnapshot(entryId = state.lightbox.entry?.id || '') {
  if (!state.codex) return null;
  const favoritesView = Boolean(state.favoritesView);
  const siteSearchView = Boolean(state.siteSearchView);
  const routeCodex = (favoritesView || siteSearchView) ? (state.browseCodex || firstUnlockedCodex() || state.codex) : state.codex;
  return {
    codexId: routeCodex.id,
    codexTitle: favoritesView ? '全部收藏' : (siteSearchView ? '全站搜索' : routeCodex.title),
    favoritesView,
    siteSearchView,
    searchScope: state.searchScope,
    path: state.activePath || [],
    q: state.query.trim(),
    onlyImaged: Boolean(state.onlyImaged),
    onlyFav: favoritesView,
    entryId,
    scrollY: Math.max(0, Math.round(window.scrollY || 0)),
    at: Date.now(),
  };
}

export function suppressBrowseStateSave(ms = 450) {
  browseSaveSuppressedUntil = Math.max(browseSaveSuppressedUntil, Date.now() + ms);
  clearTimeout(browseSaveTimer);
}

export function saveBrowseStateNow(entryId) {
  const snapshot = currentBrowseSnapshot(entryId);
  if (!snapshot) return;
  state.lastBrowse = snapshot;
  localStorage.setItem(LAST_BROWSE_STORAGE_KEY, JSON.stringify(snapshot));
}

export function scheduleBrowseStateSave(entryId) {
  if (Date.now() < browseSaveSuppressedUntil) return;
  clearTimeout(browseSaveTimer);
  browseSaveTimer = window.setTimeout(() => saveBrowseStateNow(entryId), 180);
}

export function browseDesc(snapshot) {
  if (!snapshot) return '暂无可恢复的位置';
  if (isHiddenR18gHistoryItem(snapshot)) return '上次位置包含 R18G / 重口内容，已隐藏';
  if (snapshot.favoritesView) {
    if (snapshot.q) return `全部收藏 · 搜索 “${snapshot.q}”`;
    if (snapshot.path?.length) return `全部收藏 · ${snapshot.path.join(' › ')}`;
    return `全部收藏 · ${formatRecentTime(snapshot.at)}`;
  }
  if (snapshot.siteSearchView || snapshot.searchScope === 'site') {
    if (snapshot.q) return `全站搜索 · “${snapshot.q}”`;
    if (snapshot.path?.length) return `全站搜索 · ${snapshot.path.join(' › ')}`;
    return `全站搜索 · ${formatRecentTime(snapshot.at)}`;
  }
  if (snapshot.q) return `${snapshot.codexTitle} · 搜索 “${snapshot.q}”`;
  if (snapshot.path?.length) return `${snapshot.codexTitle} · ${snapshot.path.join(' › ')}`;
  return `${snapshot.codexTitle} · ${formatRecentTime(snapshot.at)}`;
}

export function formatRecentTime(ts) {
  const diff = Math.max(0, Date.now() - Number(ts || 0));
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(Number(ts)).toLocaleDateString('zh-CN');
}

export function renderHistoryPanel() {
  const resume = $('#resumeBrowse');
  const resumeDesc = $('#resumeDesc');
  const resumeHidden = isHiddenR18gHistoryItem(state.lastBrowse);
  if (resumeDesc) resumeDesc.textContent = browseDesc(state.lastBrowse);
  if (resume) resume.disabled = !state.lastBrowse || resumeHidden;
  const clearBtn = $('#clearRecent');
  const recentEntries = state.recentEntries.filter(item => !isHiddenR18gHistoryItem(item));
  if (clearBtn) clearBtn.disabled = recentEntries.length === 0;

  const list = $('#recentList');
  if (!list) return;
  list.innerHTML = '';
  if (!recentEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'recent-empty';
    empty.textContent = state.recentEntries.length
      ? '最近记录中只有已隐藏的 R18G / 重口内容。开启 R18G 后可查看。'
      : '最近还没有打开过词条。点卡片放大图或复制词条后，这里会自动记录。';
    list.appendChild(empty);
    return;
  }
  for (const item of recentEntries) {
    const btn = document.createElement('button');
    btn.className = 'recent-item';
    btn.type = 'button';
    btn.dataset.codex = item.codexId;
    btn.dataset.entry = item.entryId;

    if (item.thumb) {
      const img = document.createElement('img');
      img.className = 'recent-thumb';
      img.src = item.thumb;
      img.alt = '';
      btn.appendChild(img);
    } else {
      const mark = document.createElement('span');
      mark.className = 'recent-thumb no-img';
      mark.textContent = '☆';
      btn.appendChild(mark);
    }

    const main = document.createElement('span');
    main.className = 'recent-main';
    const title = document.createElement('span');
    title.className = 'recent-title';
    title.textContent = item.title;
    const meta = document.createElement('span');
    meta.className = 'recent-meta';
    meta.textContent = `${item.codexTitle}${item.path?.length ? ' · ' + item.path.join(' › ') : ''}`;
    main.append(title, meta);
    btn.appendChild(main);

    const time = document.createElement('span');
    time.className = 'recent-time';
    time.textContent = formatRecentTime(item.at);
    btn.appendChild(time);
    btn.onclick = () => document.dispatchEvent(new CustomEvent('openRecentEntry', { detail: item }));
    list.appendChild(btn);
  }
}

export function applyBrowseControls(snapshot) {
  state.onlyImaged = Boolean(snapshot.onlyImaged);
  state.onlyFav = Boolean(snapshot.favoritesView || snapshot.onlyFav);
  const onlyImaged = $('#onlyImaged');
  const onlyFav = $('#onlyFav');
  if (onlyImaged) onlyImaged.checked = state.onlyImaged;
  if (onlyFav) onlyFav.checked = state.onlyFav;
}

export function applyBrowseState(snapshot, options = {}) {
  state.activePath = snapshot.path || [];
  state.query = snapshot.q || '';
  const search = $('#search');
  if (search) search.value = state.query;
  updateSearchClear();
  historyActions.renderTree();
  suppressBrowseStateSave();
  historyActions.applyFilter({ resetScroll: true });
  syncUrlState({
    historyMode: options.historyMode || 'replace',
    transition: options.transition || (snapshot.entryId ? 'detail' : 'route'),
    consumeLayer: Boolean(options.consumeLayer),
    entry: snapshot.entryId || '',
    saveBrowse: false,
  });
}

let browseScrollRestoreSeq = 0;
export function restoreBrowseScroll(top, { token } = {}) {
  const seq = ++browseScrollRestoreSeq;
  const target = Math.max(0, Number(top) || 0);
  let attempts = 0;
  const run = () => {
    if (seq !== browseScrollRestoreSeq) return;
    if (token !== undefined && !isHistoryRestoreToken(token)) return;
    window.scrollTo({ top: target, left: 0, behavior: 'auto' });
    historyActions.updateVirtualCards(true);
    updateScrollProgress();
    attempts += 1;
    const reached = Math.abs(Math.max(0, window.scrollY) - target) <= 3;
    if (!reached && attempts < 6) window.setTimeout(run, attempts < 2 ? 140 : 220);
  };
  window.setTimeout(run, 160);
}

export async function resumeLastBrowse(options = {}) {
  const snapshot = state.lastBrowse;
  if (!snapshot) return;
  if (isHiddenR18gHistoryItem(snapshot)) {
    showR18gLockedHint();
    return;
  }
  const wantsFavorites = Boolean(snapshot.favoritesView || snapshot.onlyFav || snapshot.codexId === FAVORITES_CODEX_ID);
  const wantsSiteSearch = Boolean(snapshot.siteSearchView || (!wantsFavorites && snapshot.searchScope === 'site' && snapshot.q));
  const requestedCodexId = snapshot.codexId === FAVORITES_CODEX_ID
    ? (state.browseCodex?.id || firstUnlockedCodex()?.id || '')
    : (snapshot.codexId === SITE_SEARCH_CODEX_ID ? (state.browseCodex?.id || firstUnlockedCodex()?.id || '') : snapshot.codexId);
  const meta = findCodexMeta(requestedCodexId);
  const targetId = meta?.id || requestedCodexId || firstUnlockedCodex()?.id || snapshot.codexId;
  const finalHistory = {
    historyMode: options.historyMode || 'push',
    transition: snapshot.entryId ? 'detail' : 'route',
    consumeLayer: Boolean(options.consumeLayer),
    saveBrowse: false,
  };
  if (meta && isCodexLocked(meta)) {
    showNsfwLockedHint();
    return;
  }
  if (wantsFavorites) {
    if (!state.codex || state.codex.id !== targetId || state.favoritesView) {
      await historyActions.loadCodex(targetId, { historyMode: 'none', saveBrowse: false });
    }
    applyBrowseControls({ ...snapshot, favoritesView: true });
    await historyActions.openFavoritesView({
      urlState: { codex: targetId, path: snapshot.path || [], q: snapshot.q || '', entry: snapshot.entryId || '', favorites: true },
      ...finalHistory,
    });
  } else if (wantsSiteSearch) {
    if (!state.codex || state.codex.id !== targetId || state.favoritesView || state.siteSearchView) {
      await historyActions.loadCodex(targetId, { historyMode: 'none', saveBrowse: false });
    }
    applyBrowseControls({ ...snapshot, favoritesView: false, onlyFav: false });
    await historyActions.openSiteSearchView({
      urlState: { codex: targetId, path: snapshot.path || [], q: snapshot.q || '', entry: snapshot.entryId || '', scope: 'site' },
      ...finalHistory,
    });
  } else if (!state.codex || state.codex.id !== targetId || state.favoritesView || state.siteSearchView) {
    applyBrowseControls(snapshot);
    await historyActions.loadCodex(targetId, {
      urlState: { codex: targetId, path: snapshot.path || [], q: snapshot.q || '', entry: snapshot.entryId || '' },
      ...finalHistory,
    });
  } else {
    applyBrowseControls(snapshot);
    applyBrowseState(snapshot, finalHistory);
    if (snapshot.entryId) window.setTimeout(() => historyActions.openEntryDeepLink(snapshot.entryId), 120);
  }
  if (!snapshot.entryId) {
    restoreBrowseScroll(snapshot.scrollY);
  }
  toast('已恢复上次浏览位置');
}

export async function openRecentEntry(item, options = {}) {
  if (!item?.codexId || !item.entryId) return;
  if (isHiddenR18gHistoryItem(item)) {
    showR18gLockedHint();
    return;
  }
  const meta = findCodexMeta(item.codexId);
  const targetId = meta?.id || item.codexId;
  if (meta && isCodexLocked(meta)) {
    showNsfwLockedHint();
    return;
  }
  const urlState = { codex: targetId, path: item.path || [], q: '', entry: item.entryId };
  const finalHistory = {
    historyMode: options.historyMode || 'push',
    transition: 'detail',
    consumeLayer: Boolean(options.consumeLayer),
  };
  if (!state.codex || state.codex.id !== targetId || state.siteSearchView) {
    state.onlyFav = false;
    state.onlyImaged = false;
    applyBrowseControls({ onlyFav: false, onlyImaged: false });
    await historyActions.loadCodex(targetId, { urlState, ...finalHistory });
  } else {
    state.query = '';
    state.activePath = item.path || [];
    state.onlyFav = false;
    state.onlyImaged = false;
    applyBrowseControls({ onlyFav: false, onlyImaged: false });
    const search = $('#search');
    if (search) search.value = '';
    updateSearchClear();
    historyActions.renderTree();
    historyActions.applyFilter({ resetScroll: true });
    syncUrlState({ ...finalHistory, entry: item.entryId });
    window.setTimeout(() => historyActions.openEntryDeepLink(item.entryId), 120);
  }
}
