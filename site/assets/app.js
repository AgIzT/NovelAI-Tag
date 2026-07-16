import { state, RECENT_STORAGE_KEY, LAST_BROWSE_STORAGE_KEY, NSFW_STORAGE_KEY, R18G_STORAGE_KEY, DENSITY_STORAGE_KEY, SEARCH_SCOPE_STORAGE_KEY, normalizeSearchScope } from './app/state.js';
import { $, esc, safeJsonParse, updateSearchClear, prefersReducedMotion } from './app/utils.js';
import { setLoading, showSkeleton, hideSkeleton } from './app/feedback.js';
import { isCodexLocked, firstUnlockedCodex, showNsfwLockedHint, isEntryAccessBlocked, isR18gPath } from './app/access.js';
import { loadMedia, loadAbout, fetchCodex, findCodexMeta, notifyCodexDataStatus, buildTreeFromEntries } from './app/data.js';
import { parseSearchQuery, matchSearchPlan } from './app/search.js';
import { hasEntryImage, primeResourceHints } from './app/media.js';
import { isFav, setFavoritesActions, toggleFav } from './app/favorites.js';
import { ATLAS_FAVORITES_STORAGE_KEY, readStoredFavorites } from './app/favorites-backup-core.js';
import { setupFavoritesBackup, subscribeFavoritesChanges } from './app/favorites-backup.js';
import { buildFavoritesCodex, FAVORITES_CODEX_ID } from './app/fav-codex.js';
import { buildSiteSearchCodex, SITE_SEARCH_CODEX_ID } from './app/site-search.js';
import { renderList, clearMasonry, updateVirtualCards, setMasonryActions } from './app/masonry.js';
import { openLightbox, closeLightbox } from './app/lightbox.js';
import { copyEntry } from './app/copy.js';
import { openReportDialog } from './app/report.js';
import { captureAtlasRoute, configureAtlasHistory, initializeAtlasHistory, readUrlState, syncUrlState, openEntryDeepLink, setRouterActions } from './app/router.js';
import { setupCodexPicker, setupAbout, setupTreeSpy, updateCodexPickerState, renderTree, renderCodexHeader, renderCategoryRail, updateRailActive, updateResultBar, updateEmptyState, setCodexUiActions } from './app/codex-ui.js';
import { normalizeRecentEntries, normalizeLastBrowse, restoreBrowseScroll, scheduleBrowseStateSave, suppressBrowseStateSave, setHistoryActions } from './app/history.js';
import { bindUI, applyDensity, setUiActions, updateSearchScopeControl } from './app/ui.js';
import { maybeShowOnboarding } from './app/onboarding.js';
import { isHistoryRestoreToken } from './app/browser-history.js';

let codexLoadSeq = 0;
let favoritesBackupBound = false;
const codexPickerTitle = c => c?.selectorTitle || c?.title || '';
const setOnlyFavControl = checked => {
  state.onlyFav = Boolean(checked);
  const onlyFav = $('#onlyFav');
  if (onlyFav) onlyFav.checked = state.onlyFav;
};
const virtualView = () => state.favoritesView || state.siteSearchView;
const historyModeFor = (options, fallback = 'push') => options.historyMode || fallback;
const urlSearchScope = urlState => {
  if (!urlState) return state.searchScope;
  if (urlState.scope) return normalizeSearchScope(urlState.scope);
  return urlState.q ? 'codex' : state.searchScope;  // 旧 q 链接继续按当前法典搜索解释
};
const applyUrlSearchScope = urlState => {
  if (!urlState) return;
  state.searchScope = urlSearchScope(urlState);
  updateSearchScopeControl();
};

export async function init() {
  const initSkeletonToken = 'init';
  try {
    configureAtlasHistory();
    showSkeleton(initSkeletonToken, { delay: 0 });
    setLoading('');
    const savedFavs = safeJsonParse(localStorage.getItem(ATLAS_FAVORITES_STORAGE_KEY), []);
    state.favs = new Set(Array.isArray(savedFavs) ? savedFavs : []);
    state.recentEntries = normalizeRecentEntries(safeJsonParse(localStorage.getItem(RECENT_STORAGE_KEY), []));
    state.lastBrowse = normalizeLastBrowse(safeJsonParse(localStorage.getItem(LAST_BROWSE_STORAGE_KEY), null));
    state.allowNsfw = localStorage.getItem(NSFW_STORAGE_KEY) === '1';
    document.body.classList.toggle('nsfw-unlocked', state.allowNsfw);
    state.allowR18g = state.allowNsfw && localStorage.getItem(R18G_STORAGE_KEY) === '1';
    document.body.classList.toggle('r18g-unlocked', state.allowR18g);
    applyDensity(localStorage.getItem(DENSITY_STORAGE_KEY), { render: false });
    state.searchScope = normalizeSearchScope(localStorage.getItem(SEARCH_SCOPE_STORAGE_KEY));
    const [codexes, media, about] = await Promise.all([
      fetch('data/codexes.json', { cache: 'no-store' }).then(r => r.json()),
      loadMedia(),
      loadAbout(),
    ]);
    state.codexes = codexes;
    state.media = { ...state.media, ...media };
    state.about = about;
    primeResourceHints({ media: state.media, codexes: state.codexes });
    const sel = $('#codexSelect');
    sel.innerHTML = codexes.map(c => `<option value="${c.id}">${esc(codexPickerTitle(c))}</option>`).join('');
    sel.onchange = () => loadCodex(sel.value);
    setupCodexPicker();
    setupAbout();
    setupTreeSpy();
    bindUI();
    bindFavoritesBackup();
    state.pendingUrlState = readUrlState();
    const wantsFavorites = state.pendingUrlState.favorites || state.pendingUrlState.codex === FAVORITES_CODEX_ID;
    const wantsSiteSearch = !wantsFavorites && state.pendingUrlState.scope === 'site' && state.pendingUrlState.q.trim();
    const initialMeta = findCodexMeta(state.pendingUrlState.codex);
    const initialId = initialMeta && !isCodexLocked(initialMeta)
      ? initialMeta.id
      : firstUnlockedCodex()?.id || codexes[0]?.id;
    if (initialMeta && isCodexLocked(initialMeta)) showNsfwLockedHint();
    if (codexes.length) {
      hideSkeleton(initSkeletonToken);
      const initialUrlState = wantsFavorites
        ? null
        : (wantsSiteSearch ? { ...state.pendingUrlState, q: '' } : state.pendingUrlState);
      await loadCodex(initialId, { urlState: initialUrlState, historyMode: 'none', saveBrowse: false });
      if (wantsFavorites) {
        await openFavoritesView({ urlState: state.pendingUrlState, historyMode: 'none', saveBrowse: false });
      } else if (wantsSiteSearch) {
        await openSiteSearchView({ urlState: state.pendingUrlState, historyMode: 'none', saveBrowse: false });
      }
      initializeAtlasHistory(captureAtlasRoute(state.pendingUrlState.entry || ''));
      maybeShowOnboarding();
    } else {
      hideSkeleton(initSkeletonToken);
      setLoading('还没有可显示的法典数据');
    }
  } catch (ex) {
    console.error(ex);
    hideSkeleton(initSkeletonToken);
    setLoading('加载失败，请刷新页面重试');
  }
}

function bindFavoritesBackup() {
  setupFavoritesBackup({ getCodexes: () => state.codexes });
  if (favoritesBackupBound) return;
  favoritesBackupBound = true;
  subscribeFavoritesChanges('atlas', syncAtlasFavoritesFromStorage);
}

async function syncAtlasFavoritesFromStorage() {
  state.favs = new Set(readStoredFavorites(localStorage, state.codexes).atlasKeys);
  if (!state.codex) return;
  if (state.favoritesView) {
    await openFavoritesView({
      urlState: {
        codex: state.browseCodex?.id || '',
        favorites: true,
        path: state.activePath.slice(),
        q: state.query,
        scope: state.searchScope,
      },
      historyMode: 'replace',
      saveBrowse: false,
    });
    return;
  }
  applyFilter({ transition: 'none' });
}

export async function loadCodex(id, options = {}) {
  const parentScrollY = options.parentScrollY ?? Math.max(0, window.scrollY || 0);
  if (id === FAVORITES_CODEX_ID) return openFavoritesView(options);
  if (id === SITE_SEARCH_CODEX_ID) return openSiteSearchView(options);
  const meta = findCodexMeta(id) || { id };
  if (isCodexLocked(meta)) {
    showNsfwLockedHint();
    const fallback = firstUnlockedCodex();
    if (fallback && fallback.id !== meta.id) {
      return loadCodex(fallback.id, { ...options, urlState: null, historyMode: 'replace' });
    }
    setLoading('需要在设置中开启 NSFW 法典展示后才能查看');
    return;
  }
  const seq = ++codexLoadSeq;
  showSkeleton(seq);
  setLoading('');
  clearMasonry();
  try {
    const codex = await fetchCodex(meta);
    if (seq !== codexLoadSeq) return;
    const wasSwitching = Boolean(state.codex);
    const render = () => {
      if (seq !== codexLoadSeq) return;
      primeResourceHints({ codexes: [codex] });
      state.favoritesView = false;
      state.siteSearchView = false;
      state.browseCodex = codex;
      state.searchReturnPath = [];
      setOnlyFavControl(false);
      state.codex = codex;
      const c = state.codex;
      const codexSelect = $('#codexSelect');
      if (codexSelect) codexSelect.value = c.id;
      $('#codexTitle').textContent = c.title;
      $('#codexMeta').textContent = `${c.author ? c.author + ' · ' : ''}${c.version} · ${c.entryCount} 条`;
      const codexBtnText = $('#codexBtnText');
      if (codexBtnText) codexBtnText.textContent = codexPickerTitle(findCodexMeta(c.id)) || c.title;
      updateCodexPickerState();
      const urlState = options.urlState && (!options.urlState.codex || options.urlState.codex === c.id || (c.aliases || []).includes(options.urlState.codex))
        ? options.urlState
        : null;
      applyUrlSearchScope(urlState);
      const nextPath = normalizeRoutePath(c.tree, urlState?.path || []);
      state.activePath = !state.allowR18g && isR18gPath(nextPath) ? [] : nextPath;
      state.query = urlState?.q || '';
      state.seenAnimated.clear();
      state.recentRandomIds = [];
      $('#search').value = state.query;
      updateSearchClear();
      renderTree();
      renderCodexHeader();
      if (options.saveBrowse === false) suppressBrowseStateSave(2000);
      applyFilter({ resetScroll: true });
      syncUrlState({
        historyMode: historyModeFor(options),
        transition: options.transition || 'route',
        consumeLayer: Boolean(options.consumeLayer),
        parentScrollY,
        entry: urlState?.entry || '',
        saveBrowse: options.saveBrowse !== false,
      });
      if (urlState?.entry) {
        window.setTimeout(() => openEntryDeepLink(urlState.entry), 180);
      }
      setLoading('');
      notifyCodexDataStatus(c);
    };
    /* 换法典用同文档 View Transition 做整页交叉淡化（数据已就绪，回调内纯同步渲染，不冻结页面）；
       首次进站没有旧画面、减少动效、老浏览器 → 直接渲染 */
    if (wasSwitching && !prefersReducedMotion() && typeof document.startViewTransition === 'function') {
      /* 先等选择菜单/面板退场（~180ms）再开始变形——切换动效别被浮层挡住白播一场 */
      await new Promise(r => setTimeout(r, 170));
      if (seq !== codexLoadSeq) return;
      /* vt-codex 只存活于本次过渡：横幅独立变形等换法典专属动画全挂它名下 */
      const h = document.documentElement;
      h.classList.add('vt-codex');
      const vt = document.startViewTransition(render);
      vt.finished.catch(() => {}).finally(() => h.classList.remove('vt-codex'));
      await vt.updateCallbackDone;
    } else {
      render();
    }
  } catch (ex) {
    if (seq === codexLoadSeq) {
      console.error(ex);
      setLoading('加载失败，请刷新页面重试');
    }
  } finally {
    hideSkeleton(seq);
  }
}

export async function openFavoritesView(options = {}) {
  const parentScrollY = options.parentScrollY ?? Math.max(0, window.scrollY || 0);
  const baseCodex = state.codex && !virtualView()
    ? state.codex
    : state.browseCodex;
  if (baseCodex) state.browseCodex = baseCodex;
  else {
    const fallback = firstUnlockedCodex();
    if (fallback) {
      await loadCodex(fallback.id, { historyMode: 'replace', saveBrowse: false });
    }
  }

  const seq = ++codexLoadSeq;
  showSkeleton(seq);
  setLoading('');
  clearMasonry();
  try {
    const codex = await buildFavoritesCodex();
    if (seq !== codexLoadSeq) return;
    const wasSwitching = Boolean(state.codex);
    const render = () => {
      if (seq !== codexLoadSeq) return;
      primeResourceHints({ codexes: [codex] });
      state.favoritesView = true;
      state.siteSearchView = false;
      state.searchReturnPath = [];
      setOnlyFavControl(true);
      state.codex = codex;
      const c = state.codex;
      const baseMeta = findCodexMeta(state.browseCodex?.id);
      const codexSelect = $('#codexSelect');
      if (codexSelect && state.browseCodex) codexSelect.value = state.browseCodex.id;
      $('#codexTitle').textContent = c.title;
      $('#codexMeta').textContent = `${c.version} · ${c.entryCount} 条`;
      const codexBtnText = $('#codexBtnText');
      if (codexBtnText) codexBtnText.textContent = codexPickerTitle(baseMeta || state.browseCodex) || '选择法典';
      updateCodexPickerState();
      const urlState = options.urlState && (options.urlState.favorites || options.urlState.codex === FAVORITES_CODEX_ID)
        ? options.urlState
        : null;
      applyUrlSearchScope(urlState);
      const nextPath = normalizeRoutePath(c.tree, urlState?.path || []);
      state.activePath = !state.allowR18g && isR18gPath(nextPath) ? [] : nextPath;
      state.query = urlState?.q || '';
      state.seenAnimated.clear();
      state.recentRandomIds = [];
      $('#search').value = state.query;
      updateSearchClear();
      renderTree();
      renderCodexHeader();
      if (options.saveBrowse === false) suppressBrowseStateSave(2000);
      applyFilter({ resetScroll: true });
      syncUrlState({
        historyMode: historyModeFor(options),
        transition: options.transition || 'route',
        consumeLayer: Boolean(options.consumeLayer),
        parentScrollY,
        entry: urlState?.entry || '',
        saveBrowse: options.saveBrowse !== false,
      });
      if (urlState?.entry) {
        window.setTimeout(() => openEntryDeepLink(urlState.entry), 180);
      }
      setLoading('');
      notifyCodexDataStatus(c);
    };
    if (wasSwitching && !prefersReducedMotion() && typeof document.startViewTransition === 'function') {
      await new Promise(r => setTimeout(r, 170));
      if (seq !== codexLoadSeq) return;
      const h = document.documentElement;
      h.classList.add('vt-codex');
      const vt = document.startViewTransition(render);
      vt.finished.catch(() => {}).finally(() => h.classList.remove('vt-codex'));
      await vt.updateCallbackDone;
    } else {
      render();
    }
  } catch (ex) {
    if (seq === codexLoadSeq) {
      console.error(ex);
      setLoading('加载失败，请刷新页面重试');
    }
  } finally {
    hideSkeleton(seq);
  }
}

export async function openSiteSearchView(options = {}) {
  const parentScrollY = options.parentScrollY ?? Math.max(0, window.scrollY || 0);
  const baseCodex = state.codex && !virtualView()
    ? state.codex
    : state.browseCodex;
  if (baseCodex) state.browseCodex = baseCodex;
  else {
    const fallback = firstUnlockedCodex();
    if (fallback) {
      await loadCodex(fallback.id, { historyMode: 'replace', saveBrowse: false });
    }
  }
  if (!state.browseCodex) return;
  if (!state.siteSearchView) state.searchReturnPath = state.activePath.slice();

  const seq = ++codexLoadSeq;
  showSkeleton(seq);
  setLoading('');
  clearMasonry();
  try {
    const codex = await buildSiteSearchCodex();
    if (seq !== codexLoadSeq) return;
    const wasSwitching = Boolean(state.codex);
    const render = () => {
      if (seq !== codexLoadSeq) return;
      primeResourceHints({ codexes: state.codexes });
      state.favoritesView = false;
      state.siteSearchView = true;
      setOnlyFavControl(false);
      state.codex = codex;
      const c = state.codex;
      const baseMeta = findCodexMeta(state.browseCodex?.id);
      const codexSelect = $('#codexSelect');
      if (codexSelect && state.browseCodex) codexSelect.value = state.browseCodex.id;
      $('#codexTitle').textContent = c.title;
      $('#codexMeta').textContent = `${c.version} · ${c.entryCount} 条`;
      const codexBtnText = $('#codexBtnText');
      if (codexBtnText) codexBtnText.textContent = codexPickerTitle(baseMeta || state.browseCodex) || '选择法典';
      updateCodexPickerState();
      const urlState = options.urlState && options.urlState.scope === 'site'
        ? options.urlState
        : null;
      state.searchScope = 'site';
      updateSearchScopeControl();
      const nextPath = normalizeRoutePath(c.tree, urlState?.path || []);
      state.activePath = !state.allowR18g && isR18gPath(nextPath) ? [] : nextPath;
      state.query = urlState?.q ?? state.query;
      state.seenAnimated.clear();
      state.recentRandomIds = [];
      $('#search').value = state.query;
      updateSearchClear();
      renderTree();
      renderCodexHeader();
      if (options.saveBrowse === false) suppressBrowseStateSave(2000);
      applyFilter({ resetScroll: true });
      syncUrlState({
        historyMode: historyModeFor(options),
        transition: options.transition || 'route',
        consumeLayer: Boolean(options.consumeLayer),
        parentScrollY,
        entry: urlState?.entry || '',
        saveBrowse: options.saveBrowse !== false,
      });
      if (urlState?.entry) {
        window.setTimeout(() => openEntryDeepLink(urlState.entry), 180);
      }
      setLoading('');
      notifyCodexDataStatus(c);
    };
    if (wasSwitching && !prefersReducedMotion() && typeof document.startViewTransition === 'function') {
      await new Promise(r => setTimeout(r, 170));
      if (seq !== codexLoadSeq) return;
      const h = document.documentElement;
      h.classList.add('vt-codex');
      const vt = document.startViewTransition(render);
      vt.finished.catch(() => {}).finally(() => h.classList.remove('vt-codex'));
      await vt.updateCallbackDone;
    } else {
      render();
    }
  } catch (ex) {
    if (seq === codexLoadSeq) {
      console.error(ex);
      setLoading('全站搜索加载失败，请稍后重试');
    }
  } finally {
    hideSkeleton(seq);
  }
}

export function exitSiteSearchView(options = {}) {
  const parentScrollY = options.parentScrollY ?? Math.max(0, window.scrollY || 0);
  if (!state.siteSearchView) {
    applyFilter(options);
    return;
  }
  const codex = state.browseCodex || firstUnlockedCodex();
  if (!codex) return;
  state.siteSearchView = false;
  state.favoritesView = false;
  state.codex = codex;
  const c = state.codex;
  const codexSelect = $('#codexSelect');
  if (codexSelect) codexSelect.value = c.id;
  $('#codexTitle').textContent = c.title;
  $('#codexMeta').textContent = `${c.author ? c.author + ' · ' : ''}${c.version} · ${c.entryCount} 条`;
  const codexBtnText = $('#codexBtnText');
  if (codexBtnText) codexBtnText.textContent = codexPickerTitle(findCodexMeta(c.id)) || c.title;
  updateCodexPickerState();
  state.activePath = normalizeRoutePath(c.tree, state.searchReturnPath);
  state.searchReturnPath = [];
  state.seenAnimated.clear();
  state.recentRandomIds = [];
  renderTree();
  renderCodexHeader();
  applyFilter(options);
  syncUrlState({
    historyMode: historyModeFor(options),
    transition: options.transition || 'route',
    consumeLayer: Boolean(options.consumeLayer),
    parentScrollY,
    saveBrowse: options.saveBrowse !== false,
  });
}

export async function applySearch(options = {}) {
  const parentScrollY = options.parentScrollY ?? Math.max(0, window.scrollY || 0);
  if (state.favoritesView) {
    applyFilter(options);
    syncUrlState({ historyMode: historyModeFor(options, 'replace'), transition: options.transition, sessionId: options.sessionId, parentScrollY, saveBrowse: options.saveBrowse !== false });
    return;
  }
  if (state.searchScope === 'site' && state.query.trim()) {
    if (!state.siteSearchView) await openSiteSearchView(options);
    else {
      applyFilter(options);
      syncUrlState({ historyMode: historyModeFor(options, 'replace'), transition: options.transition, sessionId: options.sessionId, parentScrollY, saveBrowse: options.saveBrowse !== false });
    }
    return;
  }
  if (state.siteSearchView) {
    exitSiteSearchView(options);
    return;
  }
  applyFilter(options);
  syncUrlState({ historyMode: historyModeFor(options, 'replace'), transition: options.transition, sessionId: options.sessionId, parentScrollY, saveBrowse: options.saveBrowse !== false });
}

export function applyFilter(options = {}) {
  const plan = parseSearchQuery(state.query);
  state.searchPlan = plan;
  let list = state.codex.entries;
  const byActivePath = l => {
    const p = state.activePath;
    return p.length ? l.filter(e => p.every((seg, i) => e.path[i] === seg)) : l;
  };
  if (plan.raw) {
    list = list.filter(e => matchSearchPlan(e, plan));
    if (state.siteSearchView) list = byActivePath(list);   // 全站搜索：搜索词 + 目录收窄并存
  } else if (state.activePath.length) {
    list = byActivePath(list);
  }
  if (state.onlyImaged) list = list.filter(hasEntryImage);
  if (state.favoritesView) list = list.filter(isFav);   // 收藏视图里取消收藏即时消卡
  list = list.filter(e => !isEntryAccessBlocked(e));  // NSFW/R18G 条目级访问控制
  state.list = list;
  updateResultBar();
  renderList(options);
}

/* 收藏视图内取消收藏后：从仍被收藏的词条重算合成法典的条目/计数/目录树，刷新顶栏、横幅进度、
   分类轨道与目录树。applyFilter 只重过滤 state.list，不动这些在 buildFavoritesCodex 时烤进合成
   法典的字段，故单独在此就地更新（不重放 chipIn 入场、不重绘横幅封面，保持“取消即消卡”的顺滑）。 */
function refreshFavoritesView(options = {}) {
  if (!state.favoritesView || !state.codex) { applyFilter(options); return; }
  const c = state.codex;
  c.entries = c.entries.filter(isFav);
  c.entryCount = c.entries.length;
  c.imagedCount = c.entries.filter(hasEntryImage).length;
  c.tree = buildTreeFromEntries(c.entries);
  state.activePath = normalizeRoutePath(c.tree, state.activePath);   // 清空的来源分组从路径里剔除
  const meta = $('#codexMeta');
  if (meta) meta.textContent = `${c.version} · ${c.entryCount} 条`;
  const pct = c.entryCount ? Math.round((c.imagedCount / c.entryCount) * 100) : 0;
  const bpFill = document.querySelector('#codexBanner .bp-fill');
  const bpText = document.querySelector('#codexBanner .bp-text');
  if (bpFill) bpFill.style.width = `${pct}%`;
  if (bpText) bpText.textContent = `${c.imagedCount} / ${c.entryCount} 已配图`;
  renderTree();
  renderCategoryRail({ animate: false });
  applyFilter(options);
}

function normalizeRoutePath(tree, path) {
  if (!Array.isArray(path) || !path.length) return [];
  let nodes = Array.isArray(tree) ? tree : [];
  const normalized = [];
  for (const seg of path) {
    const node = nodes.find(nd => nd?.name === seg);
    if (!node) return [];
    normalized.push(node.name);
    nodes = Array.isArray(node.children) ? node.children : [];
  }
  return normalized;
}

async function applyAtlasHistoryRoute(route = {}, context = {}) {
  const currentRestore = () => context.token === undefined || isHistoryRestoreToken(context.token);
  const requestedMeta = findCodexMeta(route.codex);
  const requestedId = requestedMeta?.id || route.codex;
  const targetLocked = Boolean(requestedMeta && isCodexLocked(requestedMeta));
  const targetUnknown = Boolean(route.codex && !requestedMeta);
  const browseMeta = findCodexMeta(state.browseCodex?.id);
  const fallbackId = (browseMeta && !isCodexLocked(browseMeta) ? browseMeta.id : '') || firstUnlockedCodex()?.id || state.codex?.id;
  const targetId = targetLocked || targetUnknown ? fallbackId : (requestedId || fallbackId);
  if (!targetId) return;
  const targetEntry = String(route.entry || '');
  /* 快速路径仅限“详情覆盖在同一列表之上”的返回：最近浏览/恢复上次浏览推的
     detail 记录可能同时切换法典、目录或清空搜索，列表上下文不一致时必须走
     下面的完整恢复，否则底层列表会停留在错误状态。 */
  const listContextOf = value => JSON.stringify({ ...(value || {}), entry: '', imageIndex: 0 });
  const closingOwnDetail = Boolean(
    !targetEntry &&
    state.lightbox.entry &&
    context.departing?.transition === 'detail' &&
    context.departing?.parentId === context.target?.id &&
    listContextOf(context.departing?.route) === listContextOf(route),
  );
  if (closingOwnDetail) {
    state.searchHistorySessionId = String(context.target?.sessionId || '');
    closeLightbox({ historyMode: 'none' });
    return;
  }
  const urlState = {
    codex: targetId,
    favorites: Boolean(route.favorites),
    scope: route.siteSearch ? 'site' : (route.scope || 'codex'),
    path: Array.isArray(route.path) ? route.path : [],
    q: String(route.q || ''),
    entry: '',
  };
  state.suppressUrlSync = true;
  state.searchHistorySessionId = String(context.target?.sessionId || '');
  suppressBrowseStateSave(2000);
  try {
    state.onlyImaged = Boolean(route.onlyImaged);
    const onlyImaged = $('#onlyImaged');
    if (onlyImaged) onlyImaged.checked = state.onlyImaged;
    state.searchReturnPath = Array.isArray(route.searchReturnPath) ? [...route.searchReturnPath] : [];

    if (route.favorites) {
      if (!state.browseCodex || state.browseCodex.id !== targetId || (!state.favoritesView && state.codex?.id !== targetId)) {
        await loadCodex(targetId, { historyMode: 'none', saveBrowse: false });
        if (!currentRestore()) return;
      }
      await openFavoritesView({ urlState, historyMode: 'none', saveBrowse: false });
      if (!currentRestore()) return;
    } else if (route.siteSearch) {
      if (!state.browseCodex || state.browseCodex.id !== targetId || (!state.siteSearchView && state.codex?.id !== targetId)) {
        await loadCodex(targetId, { historyMode: 'none', saveBrowse: false });
        if (!currentRestore()) return;
      }
      await openSiteSearchView({ urlState, historyMode: 'none', saveBrowse: false });
      if (!currentRestore()) return;
    } else if (!state.codex || state.codex.id !== targetId || state.favoritesView || state.siteSearchView) {
      await loadCodex(targetId, { urlState, historyMode: 'none', saveBrowse: false });
      if (!currentRestore()) return;
    } else {
      state.searchScope = route.scope === 'site' ? 'site' : 'codex';
      updateSearchScopeControl();
      const nextPath = normalizeRoutePath(state.codex.tree, urlState.path);
      state.activePath = !state.allowR18g && isR18gPath(nextPath) ? [] : nextPath;
      state.query = urlState.q;
      const search = $('#search');
      if (search) search.value = state.query;
      updateSearchClear();
      renderTree();
      applyFilter({ resetScroll: true, transition: 'none' });
    }

    if (!currentRestore()) return;
    if (state.lightbox.entry && state.lightbox.entry.id !== targetEntry) {
      closeLightbox({ historyMode: 'none', immediate: true });
    }
    const lightboxOpen = $('#lightbox')?.classList.contains('is-open');
    if (targetEntry && (state.lightbox.entry?.id !== targetEntry || !lightboxOpen)) {
      const opened = openEntryDeepLink(targetEntry, { imageIndex: Math.max(0, Number(route.imageIndex) || 0) });
      if (!opened) {
        return targetLocked
          ? captureAtlasRoute('')
          : { ...route, entry: '', imageIndex: 0 };
      }
    }
    state.searchReturnPath = Array.isArray(route.searchReturnPath) ? [...route.searchReturnPath] : [];
    const normalizedRoute = captureAtlasRoute(targetEntry);
    const canonicalRequested = requestedMeta?.id || requestedId;
    const pathChanged = !targetEntry && JSON.stringify(normalizedRoute.path) !== JSON.stringify(urlState.path);
    if (targetLocked || targetUnknown || pathChanged || (canonicalRequested && normalizedRoute.codex !== canonicalRequested)) {
      return normalizedRoute;
    }
  } finally {
    if (currentRestore()) state.suppressUrlSync = false;
  }
}

setRouterActions({
  onUrlSync: scheduleBrowseStateSave,
  renderTree,
  applyFilter,
  openLightbox,
  updateVirtualCards,
  applyHistoryRoute: applyAtlasHistoryRoute,
  restoreHistoryScroll: restoreBrowseScroll,
});

setCodexUiActions({
  loadCodex,
  applyFilter,
  applySearch,
  syncUrlState,
  openLightbox,
  updateVirtualCards,
});

setHistoryActions({
  loadCodex,
  openFavoritesView,
  openSiteSearchView,
  openEntryDeepLink,
  renderTree,
  applyFilter,
  updateVirtualCards,
});

setFavoritesActions({ applyFilter, refreshFavoritesView });

setMasonryActions({
  openLightbox,
  copyEntry,
  toggleFav,
  reportEntry: (entry, opts = {}) => openReportDialog({ entry, ...opts }),
});

setUiActions({ loadCodex, openFavoritesView, openSiteSearchView, exitSiteSearchView, applyFilter, applySearch });

init();
