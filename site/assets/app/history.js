import { state, RECENT_ENTRY_LIMIT, RECENT_STORAGE_KEY, LAST_BROWSE_STORAGE_KEY } from './state.js';
import { $, esc, updateSearchClear, updateScrollProgress } from './utils.js';
import { hasEntryImage, thumbUrl } from './media.js';
import { captureAtlasRoute, syncUrlState } from './router.js';
import { normalizeCodexRoutePath } from './codex-route-compat.js';
import { firstUnlockedCodex, isCodexLocked, isEntryNsfw, isNsfwPathSegment, isR18gEntry, showNsfwLockedHint, showR18gLockedHint } from './access.js';
import { toast } from './feedback.js';
import { findCodexMeta, fetchCodex, resolveUpdateFilter, updateFilterDefinitions } from './data.js';
import { canonicalizeAtlasFavorite } from './favorites-backup-core.js';
import { getBlockingPreferences, isContentBlocked } from './content-blocking.js';
import { FAVORITES_CODEX_ID } from './fav-codex.js';
import { SITE_SEARCH_CODEX_ID } from './site-search.js';
import { getHistoryNavigationVersion, isHistoryRestoreToken } from './browser-history.js';

const historyActions = {
  loadCodex: async () => {},
  openFavoritesView: async () => {},
  openSiteSearchView: async () => {},
  openEntryDeepLink: () => {},
  renderTree: () => {},
  applyFilter: () => {},
  updateVirtualCards: () => {},
  updateSearchScopeControl: () => {},
  favoritesFolderCode: () => '',
};

export function setHistoryActions(actions = {}) {
  Object.assign(historyActions, actions);
}

function normalizeHistoryPath(value) {
  const parts = Array.isArray(value) ? value : [value];
  return parts.map(part => String(part || '').trim()).filter(Boolean);
}

function normalizeSearchFilterValues(value) {
  return (Array.isArray(value) ? value : [])
    .map(item => String(item ?? ''));
}

function hasSnapshotSearch(snapshot) {
  return Boolean(String(snapshot?.q || '').trim() || normalizeSearchFilterValues(snapshot?.searchFilters).length);
}

function snapshotSearchDesc(snapshot) {
  const q = String(snapshot?.q || '').trim();
  if (q) return `搜索 “${q}”`;
  const count = normalizeSearchFilterValues(snapshot?.searchFilters).length;
  return count ? `筛选 ${count} 项` : '';
}

function isHistoryNsfw(item) {
  return isEntryNsfw(item) || normalizeHistoryPath(item?.path).some(part => (
    isNsfwPathSegment(part) || part.toLowerCase().includes('nsfw')
  ));
}

function isHistoryR18g(item) {
  return isR18gEntry({ ...item, path: normalizeHistoryPath(item?.path) });
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
      path: normalizeHistoryPath(item.path),
      thumb: String(item.thumb || ''),
      access: {
        nsfw: item.access?.nsfw === true || item.nsfw === true || item.sourceNsfw === true || isHistoryNsfw(item),
        r18g: item.access?.r18g === true || item.r18g === true || item.sourceR18g === true || isHistoryR18g(item),
      },
      at: Number(item.at) || Date.now(),
    }))
    .slice(0, RECENT_ENTRY_LIMIT);
}

export function normalizeLastBrowse(value) {
  if (!value || typeof value !== 'object' || !value.codexId) return null;
  return {
    codexId: String(value.codexId),
    codexTitle: String(value.codexTitle || value.codexId),
    path: normalizeHistoryPath(value.path),
    q: String(value.q || ''),
    searchFilters: normalizeSearchFilterValues(value.searchFilters),
    updateFilter: String(value.updateFilter || (value.onlyNew ? 'latest' : '')),
    onlyFav: Boolean(value.onlyFav),
    favoritesView: Boolean(value.favoritesView || value.favMode || value.onlyFav || value.codexId === FAVORITES_CODEX_ID),
    siteSearchView: Boolean(value.siteSearchView || value.searchView || value.codexId === SITE_SEARCH_CODEX_ID),
    searchScope: value.searchScope === 'site' || value.siteSearchView || value.searchView || value.codexId === SITE_SEARCH_CODEX_ID ? 'site' : 'codex',
    ...(typeof value.favFolder === 'string' ? { favFolder: value.favFolder } : {}),
    folderCode: String(value.folderCode || ''),
    favSource: String(value.favSource || ''),
    favSort: ['recent', 'oldest', 'title'].includes(value.favSort) ? value.favSort : 'recent',
    entryId: String(value.entryId || ''),
    imageIndex: Math.max(0, Math.floor(Number(value.imageIndex) || 0)),
    access: {
      nsfw: value.access?.nsfw === true || value.nsfw === true || value.sourceNsfw === true || isHistoryNsfw(value),
      r18g: value.access?.r18g === true || value.r18g === true || value.sourceR18g === true || isHistoryR18g(value),
    },
    scrollY: Math.max(0, Number(value.scrollY) || 0),
    at: Number(value.at) || Date.now(),
  };
}

/* ---------------- 浏览记录 ---------------- */
export function saveRecentEntries() {
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(state.recentEntries));
  } catch (error) {
    console.warn('[history] 无法保存最近浏览记录', error);
  }
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
    path: normalizeHistoryPath(e._srcPath || e.path),
    thumb: hasEntryImage(e) ? thumbUrl(e) : '',
    access: {
      nsfw: findCodexMeta(codexId)?.nsfw === true || isHistoryNsfw({ ...e, path: e._srcPath || e.path }),
      r18g: isHistoryR18g({ ...e, path: e._srcPath || e.path }),
    },
    at: Date.now(),
  };
  state.recentEntries = [
    item,
    ...state.recentEntries.filter(old => `${old.codexId}:${old.entryId}` !== key),
  ].slice(0, RECENT_ENTRY_LIMIT);
  saveRecentEntries();
}

export function isHistoryItemLocked(item) {
  const meta = findCodexMeta(item?.codexId);
  const codexId = String(item?.codexId || '').trim();
  const virtual = codexId === FAVORITES_CODEX_ID || codexId === SITE_SEARCH_CODEX_ID;
  /* 法典索引加载完成后仍找不到来源的旧记录，无法证明它是安全内容。 */
  if (state.codexes?.length && codexId && !virtual && !meta) return 'nsfw';
  const access = item?.access || {};
  const nsfw = access.nsfw === true || meta?.nsfw === true || isHistoryNsfw(item);
  const r18g = access.r18g === true || isHistoryR18g(item);
  if (r18g && !state.allowR18g) return 'r18g';
  if (nsfw && !state.allowNsfw) return 'nsfw';
  return '';
}

/* 兼容旧调用。新代码统一用 isHistoryItemLocked，避免仅看 path 而漏掉 NSFW。 */
export function isHiddenR18gHistoryItem(item) {
  return isHistoryItemLocked(item) === 'r18g';
}

let browseSaveTimer = 0;
let browseSaveSuppressedUntil = 0;
export function currentBrowseSnapshot(entryId = state.lightbox.entry?.id || '', entry = state.lightbox.entry) {
  if (!state.codex) return null;
  const favoritesView = Boolean(state.favoritesView);
  const siteSearchView = Boolean(state.siteSearchView);
  const routeCodex = (favoritesView || siteSearchView) ? (state.browseCodex || firstUnlockedCodex() || state.codex) : state.codex;
  const entryPath = normalizeHistoryPath(entry?._srcPath || entry?.path);
  const entryCodexId = entry?._srcCodexId || routeCodex.id;
  const entryMeta = findCodexMeta(entryCodexId);
  return {
    codexId: routeCodex.id,
    codexTitle: favoritesView ? '全部收藏' : (siteSearchView ? '全站搜索' : routeCodex.title),
    favoritesView,
    siteSearchView,
    searchScope: state.searchScope,
    ...(favoritesView ? {
      favFolder: String(state.favFolder || ''),
      folderCode: historyActions.favoritesFolderCode(state.favFolder),
      favSource: String(state.favSource || ''),
      favSort: state.favSort || 'recent',
    } : {}),
    path: state.activePath || [],
    q: state.query.trim(),
    searchFilters: normalizeSearchFilterValues(state.searchFilterValues),
    updateFilter: String(state.updateFilter || ''),
    onlyFav: favoritesView,
    entryId,
    imageIndex: entryId ? Math.max(0, Math.floor(Number(state.lightbox.index) || 0)) : 0,
    access: {
      nsfw: entryMeta?.nsfw === true || isHistoryNsfw({ ...entry, path: entryPath }) || routeCodex?.nsfw === true,
      r18g: isHistoryR18g({ ...entry, path: entryPath }),
    },
    scrollY: Math.max(0, Math.round(window.scrollY || 0)),
    at: Date.now(),
  };
}

export function suppressBrowseStateSave(ms = 450) {
  browseSaveSuppressedUntil = Math.max(browseSaveSuppressedUntil, Date.now() + ms);
  clearTimeout(browseSaveTimer);
}

/* 本次打开后有没有真的浏览过（滚动、换位置、复制）。没动过就关页，pagehide 不能拿
   首屏默认那本书盖掉上一次的位置，否则下次「继续上次」只会指回打开时的原地。 */
let browseTouched = false;

export function saveBrowseStateNow(entryId, entry) {
  const snapshot = currentBrowseSnapshot(entryId, entry);
  if (!snapshot) return;
  browseTouched = true;
  state.lastBrowse = snapshot;
  try {
    localStorage.setItem(LAST_BROWSE_STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.warn('[history] 无法保存浏览位置', error);
  }
}

export function scheduleBrowseStateSave(entryId) {
  if (Date.now() < browseSaveSuppressedUntil) return;
  browseTouched = true;
  clearTimeout(browseSaveTimer);
  browseSaveTimer = window.setTimeout(() => saveBrowseStateNow(entryId), 180);
}

export function checkpointBrowseState() {
  if (!browseTouched || Date.now() < browseSaveSuppressedUntil) return false;
  clearTimeout(browseSaveTimer);
  saveBrowseStateNow();
  return true;
}

window.addEventListener?.('pagehide', checkpointBrowseState);

/* 上次位置拆成「在哪本书 / 哪个视图」和「里面的哪儿」两段；面板一行字与首页卡片共用。
   shortContext 用选择器短标题，给卡片里要和路径挤一行的场合。 */
export function browsePlace(snapshot) {
  const detailOf = () => (hasSnapshotSearch(snapshot) ? snapshotSearchDesc(snapshot) : (snapshot.path?.length ? snapshot.path.join(' › ') : ''));
  if (snapshot.favoritesView) return { context: '全部收藏', shortContext: '全部收藏', detail: detailOf() };
  if (snapshot.siteSearchView || (snapshot.searchScope === 'site' && hasSnapshotSearch(snapshot))) {
    return { context: '全站搜索', shortContext: '全站搜索', detail: detailOf() };
  }
  const meta = findCodexMeta(snapshot.codexId) || {};
  const requested = String(snapshot.updateFilter || (snapshot.onlyNew ? 'latest' : ''));
  const updateFilter = updateFilterDefinitions(meta).find(filter => requested === 'latest' ? filter.latest : filter.id === requested);
  const filterLabel = updateFilter ? ` · ${updateFilter.label}` : '';
  return {
    context: `${snapshot.codexTitle}${filterLabel}`,
    shortContext: `${meta.selectorTitle || snapshot.codexTitle}${filterLabel}`,
    detail: detailOf(),
  };
}

export function browseDesc(snapshot) {
  if (!snapshot) return '暂无可恢复的位置';
  const locked = isHistoryItemLocked(snapshot);
  if (locked === 'r18g') return '上次位置包含 R18G / 重口内容，已隐藏';
  if (locked === 'nsfw') return '上次位置包含限制级内容，已隐藏';
  const { context, detail } = browsePlace(snapshot);
  return `${context} · ${detail || formatRecentTime(snapshot.at)}`;
}

/* 上次停在某个词条上时，从最近浏览里取它的标题和缩略图；命中屏蔽或还在核对就当没有。 */
export function recentEntryForBrowse(snapshot) {
  if (!snapshot?.entryId) return null;
  /* 最近浏览按「法典 + 词条」区分；收藏与全站搜索的快照只记了入口法典，词条来自哪本书不知道，只能按词条找 */
  const anyCodex = snapshot.favoritesView || snapshot.siteSearchView;
  const codexKey = id => findCodexMeta(id)?.id || id;
  const codexId = codexKey(snapshot.codexId);
  const item = state.recentEntries.find(recent => recent.entryId === snapshot.entryId
    && (anyCodex || codexKey(recent.codexId) === codexId));
  if (!item || isHistoryItemLocked(item)) return null;
  return historyContentVisibility(item, getBlockingPreferences()) === 'visible' ? item : null;
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

const historyBlockingCodexes = new Map();

function historyContentVisibility(item, preferences) {
  if (!preferences.enabled || (!preferences.words.length && !preferences.entries.length)) return 'visible';
  let identity;
  try { identity = canonicalizeAtlasFavorite({ codexId: item.codexId, entryId: item.entryId }, state.codexes); }
  catch { return 'hidden'; }
  const snapshot = { id: identity.entryId, _srcCodexId: identity.codexId, title: item.title };
  if (isContentBlocked(snapshot)) return 'hidden';
  if (!preferences.words.length) return 'visible';
  const meta = findCodexMeta(identity.codexId);
  if (!meta) return 'hidden';
  const cached = historyBlockingCodexes.get(meta.id);
  const codex = state.codex?.id === meta.id ? state.codex : cached?.codex;
  if (codex) {
    const entry = codex.entries.find(entry => entry.id === identity.entryId);
    return !entry || isContentBlocked({ ...entry, _srcCodexId: meta.id }) ? 'hidden' : 'visible';
  }
  if (cached) return cached.failed ? 'failed' : 'pending';
  const record = {};
  historyBlockingCodexes.set(meta.id, record);
  fetchCodex(meta).then(codex => { record.codex = codex; }, () => { record.failed = true; }).finally(() => {
    if ($('#historyPanel') && !$('#historyPanel').hidden) renderHistoryPanel();
  });
  return 'pending';
}

export function renderHistoryPanel() {
  if ($('#historyPanel')?.hidden) {
    for (const [key, value] of historyBlockingCodexes) if (value.failed) historyBlockingCodexes.delete(key);
  }
  const resume = $('#resumeBrowse');
  const resumeDesc = $('#resumeDesc');
  const resumeLocked = isHistoryItemLocked(state.lastBrowse);
  if (resumeDesc) resumeDesc.textContent = browseDesc(state.lastBrowse);
  if (resume) resume.disabled = !state.lastBrowse || Boolean(resumeLocked);
  const clearBtn = $('#clearRecent');
  const preferences = getBlockingPreferences();
  const accessibleEntries = state.recentEntries.filter(item => !isHistoryItemLocked(item));
  const checked = accessibleEntries.map(item => ({ item, visibility: historyContentVisibility(item, preferences) }));
  const recentEntries = checked.filter(item => item.visibility === 'visible').map(item => item.item);
  const pending = checked.some(item => item.visibility === 'pending');
  const failed = checked.some(item => item.visibility === 'failed');
  if (clearBtn) clearBtn.disabled = recentEntries.length === 0;

  const list = $('#recentList');
  if (!list) return;
  list.innerHTML = '';
  if (!recentEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'recent-empty';
    empty.textContent = state.recentEntries.length
      ? (pending ? '正在检查最近记录…' : failed ? '部分记录加载失败，重新打开此面板可重试。'
        : accessibleEntries.length ? '最近记录已被屏蔽，可在设置中管理屏蔽清单。'
          : '最近记录中只有当前已隐藏的限制级内容。开启对应内容权限后可查看。')
      : '最近还没有打开过词条。点卡片放大图或复制词条后，这里会自动记录。';
    list.appendChild(empty);
    return;
  }
  for (const item of recentEntries) {
    const btn = document.createElement('button');
    btn.className = 'recent-item ui-press';
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
  if (pending || failed) {
    const notice = document.createElement('p');
    notice.className = 'recent-empty';
    notice.textContent = pending ? '正在检查其余记录…' : '部分记录加载失败，重新打开此面板可重试。';
    list.appendChild(notice);
  }
}

export function applyBrowseControls(snapshot) {
  const requested = String(snapshot.updateFilter || (snapshot.onlyNew ? 'latest' : ''));
  const sameCodex = state.codex && (state.codex.id === snapshot.codexId || (state.codex.aliases || []).includes(snapshot.codexId));
  state.updateFilter = (!snapshot.favoritesView && !snapshot.siteSearchView)
    ? (sameCodex ? resolveUpdateFilter(state.codex, requested) : requested)
    : '';
  state.onlyFav = Boolean(snapshot.favoritesView || snapshot.onlyFav);
  const onlyFav = $('#onlyFav');
  if (onlyFav) onlyFav.checked = state.onlyFav;
}

export function applyBrowseState(snapshot, options = {}) {
  state.searchScope = snapshot.searchScope === 'site' ? 'site' : 'codex';
  historyActions.updateSearchScopeControl();
  state.activePath = normalizeCodexRoutePath(state.codex, snapshot.path || [], snapshot.codexId);
  state.query = snapshot.q || '';
  state.searchFilterValues = normalizeSearchFilterValues(snapshot.searchFilters);
  const search = $('#search');
  if (search) search.value = state.query;
  updateSearchClear();
  historyActions.renderTree();
  suppressBrowseStateSave();
  historyActions.applyFilter({ resetScroll: true });
  if (search) search.value = state.query;
  updateSearchClear();
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
  const navigationVersion = getHistoryNavigationVersion();
  const target = Math.max(0, Number(top) || 0);
  let attempts = 0;
  const stopListening = () => {
    window.removeEventListener?.('wheel', cancelForUserInput);
    window.removeEventListener?.('touchmove', cancelForUserInput);
    window.removeEventListener?.('keydown', cancelForKey);
    window.removeEventListener?.('pointerdown', cancelForScrollbar);
  };
  const cancelForUserInput = () => {
    if (seq === browseScrollRestoreSeq) browseScrollRestoreSeq += 1;
    stopListening();
  };
  const cancelForKey = event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey
        || event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
    if (['Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) cancelForUserInput();
  };
  const cancelForScrollbar = event => {
    if (event.button === 0 && event.clientX >= document.documentElement?.clientWidth) cancelForUserInput();
  };
  window.addEventListener?.('wheel', cancelForUserInput, { once: true, passive: true });
  window.addEventListener?.('touchmove', cancelForUserInput, { once: true, passive: true });
  window.addEventListener?.('keydown', cancelForKey);
  window.addEventListener?.('pointerdown', cancelForScrollbar, { passive: true });
  const run = () => {
    if (seq !== browseScrollRestoreSeq || navigationVersion !== getHistoryNavigationVersion()) { stopListening(); return; }
    if (token !== undefined && !isHistoryRestoreToken(token)) { stopListening(); return; }
    window.scrollTo({ top: target, left: 0, behavior: 'auto' });
    historyActions.updateVirtualCards(true);
    updateScrollProgress();
    attempts += 1;
    const reached = Math.abs(Math.max(0, window.scrollY) - target) <= 3;
    if (!reached && attempts < 6) window.setTimeout(run, attempts < 2 ? 140 : 220);
    else stopListening();
  };
  window.setTimeout(run, 160);
}

let browseIntentSeq = 0;
function beginBrowseIntent() {
  const seq = ++browseIntentSeq;
  return () => seq === browseIntentSeq;
}

/* The view renderer checks before touching state/DOM/history. Its completion
   signal distinguishes a rendered view from an aborted or failed load. */
async function renderBrowseIntent(current, action, options = {}) {
  const version = getHistoryNavigationVersion();
  const route = JSON.stringify(captureAtlasRoute());
  let rendered = null;
  const isCurrent = () => current() && version === getHistoryNavigationVersion()
    && route === JSON.stringify(captureAtlasRoute());
  await action({ ...options, autoOpenEntry: false, isCurrent, onViewRendered: () => {
    rendered = { version: getHistoryNavigationVersion(), route: JSON.stringify(captureAtlasRoute()) };
  } });
  return Boolean(current() && rendered && rendered.version === getHistoryNavigationVersion()
    && rendered.route === JSON.stringify(captureAtlasRoute()));
}

export async function resumeLastBrowse(options = {}) {
  /* 首页卡片传入弹出时记下的那份：之后一滚动 state.lastBrowse 就换成了当前位置 */
  const snapshot = normalizeLastBrowse(options.snapshot || state.lastBrowse);
  if (!snapshot) return;
  const current = beginBrowseIntent();
  const locked = isHistoryItemLocked(snapshot);
  if (locked === 'r18g') {
    showR18gLockedHint();
    return;
  }
  if (locked === 'nsfw') {
    showNsfwLockedHint();
    return;
  }
  const wantsFavorites = Boolean(snapshot.favoritesView || snapshot.onlyFav || snapshot.codexId === FAVORITES_CODEX_ID);
  const wantsSiteSearch = Boolean(snapshot.siteSearchView || (!wantsFavorites && snapshot.searchScope === 'site' && hasSnapshotSearch(snapshot)));
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
  const urlState = {
    codex: requestedCodexId, path: snapshot.path, q: snapshot.q,
    searchFilters: snapshot.searchFilters, entry: snapshot.entryId,
    scope: snapshot.searchScope, imageIndex: snapshot.imageIndex,
    updateFilter: snapshot.updateFilter,
  };
  if (meta && isCodexLocked(meta)) {
    showNsfwLockedHint();
    return;
  }
  if (wantsFavorites) {
    if (!await renderBrowseIntent(current, historyActions.openFavoritesView, {
      browseCodexId: targetId,
      urlState: { ...urlState, codex: targetId, favorites: true,
        folderCode: typeof snapshot.favFolder === 'string' ? historyActions.favoritesFolderCode(snapshot.favFolder) : snapshot.folderCode,
        favSource: snapshot.favSource, favSort: snapshot.favSort },
      ...finalHistory,
    })) return;
  } else if (wantsSiteSearch) {
    if (!await renderBrowseIntent(current, historyActions.openSiteSearchView, {
      browseCodexId: targetId,
      urlState: { ...urlState, codex: targetId, scope: 'site' },
      ...finalHistory,
    })) return;
  } else if (!state.codex || state.codex.id !== targetId || state.favoritesView || state.siteSearchView) {
    if (!await renderBrowseIntent(current, options => historyActions.loadCodex(targetId, options), {
      urlState,
      ...finalHistory,
    })) return;
  } else {
    applyBrowseControls(snapshot);
    applyBrowseState(snapshot, finalHistory);
  }
  if (snapshot.entryId && historyActions.openEntryDeepLink(snapshot.entryId, { imageIndex: snapshot.imageIndex })) {
    syncUrlState({ historyMode: 'replace', saveBrowse: false });
  }
  if (!snapshot.entryId) {
    restoreBrowseScroll(snapshot.scrollY);
  }
  toast('已恢复上次浏览位置');
}

export async function openRecentEntry(item, options = {}) {
  if (!item?.codexId || !item.entryId) return;
  const current = beginBrowseIntent();
  const locked = isHistoryItemLocked(item);
  if (locked === 'r18g') {
    showR18gLockedHint();
    return;
  }
  if (locked === 'nsfw') {
    showNsfwLockedHint();
    return;
  }
  const meta = findCodexMeta(item.codexId);
  const targetId = meta?.id || item.codexId;
  if (meta && isCodexLocked(meta)) {
    showNsfwLockedHint();
    return;
  }
  /* landOnCard：先记一条「目标目录、定位到卡片」，再在其上记详情。关灯箱停在这张卡片，
     再退一步才回原处。不传时目录切换与详情合成一条（画师栏跳词条：关掉回到来时的灯箱）。 */
  const landOnCard = Boolean(options.landOnCard);
  const urlState = { codex: item.codexId, path: item.path || [], q: '', entry: landOnCard ? '' : item.entryId };
  const finalHistory = {
    historyMode: options.historyMode || 'push',
    transition: landOnCard ? 'route' : 'detail',
    consumeLayer: Boolean(options.consumeLayer),
  };
  const openDetail = () => {
    const opened = historyActions.openEntryDeepLink(item.entryId, landOnCard ? { historyMode: 'push' } : undefined);
    if (opened && !landOnCard) syncUrlState({ historyMode: 'replace', saveBrowse: false });
  };
  if (!state.codex || state.codex.id !== targetId || state.siteSearchView) {
    if (!await renderBrowseIntent(current, options => historyActions.loadCodex(targetId, options), { urlState, ...finalHistory })) return;
    if (state.codex?.id === targetId && !state.favoritesView && !state.siteSearchView) openDetail();
  } else {
    state.query = '';
    state.searchFilters = [];
    state.searchFilterValues = [];
    state.searchIssues = [];
    state.activePath = normalizeCodexRoutePath(state.codex, item.path || [], item.codexId);
    state.onlyFav = false;
    applyBrowseControls({ onlyFav: false });
    const search = $('#search');
    if (search) search.value = '';
    updateSearchClear();
    historyActions.renderTree();
    historyActions.applyFilter({ resetScroll: true });
    syncUrlState({ ...finalHistory, entry: urlState.entry });
    openDetail();
  }
}
