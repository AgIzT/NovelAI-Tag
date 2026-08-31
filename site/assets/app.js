import { state, ADULT_CONFIRMATION_STORAGE_KEY, RECENT_STORAGE_KEY, LAST_BROWSE_STORAGE_KEY, NSFW_STORAGE_KEY, R18G_STORAGE_KEY, DENSITY_STORAGE_KEY, SEARCH_SCOPE_STORAGE_KEY, normalizeSearchScope } from './app/state.js';
import { $, esc, safeJsonParse, updateSearchClear, prefersReducedMotion } from './app/utils.js';
import { setLoading, showSkeleton, hideSkeleton, replaceSkeleton } from './app/feedback.js';
import { isCodexLocked, firstUnlockedCodex, showNsfwLockedHint, isEntryAccessBlocked, isR18gPath } from './app/access.js';
import { loadBootstrapData, fetchCodex, findCodexMeta, notifyCodexDataStatus, buildTreeFromEntries, codexUpdateFilters, entryMatchesUpdateFilter, resolveUpdateFilter } from './app/data.js';
import { parseSearchQuery, matchSearchPlan } from './app/search.js';
import { hasEntryImage, primeResourceHints, isLocalOrigin } from './app/media.js';
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
import { normalizeRoutePath, normalizeCodexRoutePath } from './app/codex-route-compat.js';
import { setupCodexPicker, setupAbout, setupTreeSpy, updateCodexPickerState, renderTree, renderCodexHeader, renderCategoryRail, updateRailActive, updateResultBar, updateEmptyState, setCodexUiActions } from './app/codex-ui.js';
import { normalizeRecentEntries, normalizeLastBrowse, restoreBrowseScroll, scheduleBrowseStateSave, suppressBrowseStateSave, setHistoryActions } from './app/history.js';
import { bindUI, applyDensity, setUiActions, updateSearchScopeControl } from './app/ui.js';
import { maybeShowOnboarding } from './app/onboarding.js';
import { startIntro, beginIntroReveal, markIntroDataReady, introSettled } from './app/intro.js';
import { setupResumePrompt } from './app/resume-prompt.js';
import { isHistoryRestoreToken } from './app/browser-history.js';
import { setupTagRelay } from './app/tag-relay.js';

let codexLoadSeq = 0;
let favoritesBackupBound = false;
const codexPickerTitle = c => c?.selectorTitle || c?.title || '';
const setOnlyFavControl = checked => {
  state.onlyFav = Boolean(checked);
  const onlyFav = $('#onlyFav');
  if (onlyFav) onlyFav.checked = state.onlyFav;
};
const virtualView = () => state.favoritesView || state.siteSearchView;
const requestedUpdateFilter = route => String(route?.updateFilter || (route?.onlyNew ? 'latest' : ''));
const hasOwnRouteField = (route, key) => Object.prototype.hasOwnProperty.call(route || {}, key);
const canonicalListContext = route => {
  const value = {
    ...(route || {}),
    entry: '',
    imageIndex: 0,
    updateFilter: resolveUpdateFilter(state.codex, requestedUpdateFilter(route)),
  };
  delete value.onlyImaged;
  delete value.onlyNew;
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ));
};
const historyRouteNeedsCanonicalization = (route, normalizedRoute) => Boolean(
  hasOwnRouteField(route, 'onlyImaged')
  || hasOwnRouteField(route, 'onlyNew')
  || requestedUpdateFilter(route) !== String(normalizedRoute?.updateFilter || '')
  // 旧 id 只用于判定并册前的目录来源；一旦迁移完成，历史记录与地址栏都写回正式 id。
  || Boolean(route?.codex && route.codex !== normalizedRoute?.codex)
);
const announceCodexLoaded = codex => {
  document.dispatchEvent(new CustomEvent('codex:loaded', { detail: { codex } }));
};
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
const siteSearchStillWanted = options => Boolean(
  options.urlState?.q?.trim()
  || (state.searchScope === 'site' && state.query.trim()),
);

function renderCodexView(codex, seq, {
  options,
  parentScrollY,
  primeCodexes = [codex],
  enterView,
  selectedCodexId,
  buttonCodex,
  buttonFallback,
  metaText,
  resolveUrlState,
  applyViewUrlState,
  resolveQuery,
}) {
  if (seq !== codexLoadSeq) return;
  primeResourceHints({ codexes: primeCodexes });
  enterView(codex);
  state.codex = codex;
  const c = state.codex;
  const selectId = selectedCodexId(c);
  const codexSelect = $('#codexSelect');
  if (codexSelect && selectId) codexSelect.value = selectId;
  $('#codexTitle').textContent = c.title;
  $('#codexMeta').textContent = metaText(c);
  const codexBtnText = $('#codexBtnText');
  if (codexBtnText) codexBtnText.textContent = codexPickerTitle(buttonCodex(c)) || buttonFallback(c);
  updateCodexPickerState();
  const urlState = resolveUrlState(c);
  applyViewUrlState(urlState, c);
  const nextPath = normalizeCodexRoutePath(c, urlState?.path || [], urlState?.codex || c.id);
  state.activePath = !state.allowR18g && isR18gPath(nextPath) ? [] : nextPath;
  state.query = resolveQuery(urlState);
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
  if (urlState?.entry && options.autoOpenEntry !== false) {
    window.setTimeout(() => openEntryDeepLink(urlState.entry), 180);
  }
  setLoading('');
  notifyCodexDataStatus(c);
  announceCodexLoaded(c);
}

async function runCodexViewTransition(seq, render, { wasSwitching, transition }) {
  /* 换法典用同文档 View Transition 做整页交叉淡化（数据已就绪，回调内纯同步渲染，不冻结页面）；
     首次进站没有旧画面、减少动效、老浏览器 → 直接渲染 */
  if (wasSwitching && transition !== 'none' && !prefersReducedMotion() && typeof document.startViewTransition === 'function') {
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
    await render();
  }
}

export async function init() {
  const initSkeletonToken = 'init';
  try {
    /* 开场脚本先起跑，不等任何网络请求：打字机与 step 计数就是数据加载期的等待画面 */
    startIntro();
    configureAtlasHistory();
    showSkeleton(initSkeletonToken, { delay: 0 });
    setLoading('');
    const savedFavs = safeJsonParse(localStorage.getItem(ATLAS_FAVORITES_STORAGE_KEY), []);
    state.favs = new Set(Array.isArray(savedFavs) ? savedFavs : []);
    state.recentEntries = normalizeRecentEntries(safeJsonParse(localStorage.getItem(RECENT_STORAGE_KEY), []));
    state.lastBrowse = normalizeLastBrowse(safeJsonParse(localStorage.getItem(LAST_BROWSE_STORAGE_KEY), null));
    state.allowNsfw = localStorage.getItem(NSFW_STORAGE_KEY) === '1';
    // 旧主站 key=1 已代表用户完成过成人确认；单向迁移确认事实，
    // 使其不再依附于之后可随时关闭的主站展示偏好。
    if (state.allowNsfw) localStorage.setItem(ADULT_CONFIRMATION_STORAGE_KEY, '1');
    document.body.classList.toggle('nsfw-unlocked', state.allowNsfw);
    state.allowR18g = state.allowNsfw && localStorage.getItem(R18G_STORAGE_KEY) === '1';
    document.body.classList.toggle('r18g-unlocked', state.allowR18g);
    /* ⚠ 必须排在分级开关恢复之后：建栏时会立刻渲染一次「最近复制」，而 snapshotLocked 读的是
       内存里的 state.allowNsfw / allowR18g。它原先在模块体里跑，早于这里，首屏那一版整列都会
       被误判成锁定——之前只是被 store 里那次无条件的 pageshow 重载恰好盖住了。 */
    setupTagRelay();
    applyDensity(localStorage.getItem(DENSITY_STORAGE_KEY), { render: false });
    state.searchScope = normalizeSearchScope(localStorage.getItem(SEARCH_SCOPE_STORAGE_KEY));
    const { codexes, media, about } = await loadBootstrapData();
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
      /* ⚠ 必须在首次渲染之前：开场靠 html.intro-run 给**新插入**的横幅/胶囊/卡片换一套入场动画，
         节点建好之后再打标就赶不上了 */
      beginIntroReveal();
      const initialUrlState = wantsFavorites
        ? null
        : (wantsSiteSearch ? { ...state.pendingUrlState, q: '' } : state.pendingUrlState);
      await loadCodex(initialId, { urlState: initialUrlState, historyMode: 'none', saveBrowse: false });
      if (wantsFavorites) {
        await openFavoritesView({ urlState: state.pendingUrlState, historyMode: 'none', saveBrowse: false });
      } else if (wantsSiteSearch) {
        await openSiteSearchView({ urlState: state.pendingUrlState, historyMode: 'none', saveBrowse: false });
      }
      markIntroDataReady();
      initializeAtlasHistory(captureAtlasRoute(state.pendingUrlState.entry || ''));
      await introSettled();   // 开场落幕再弹引导；没播开场时立即 resolve
      const onboardingShown = maybeShowOnboarding();
      setupResumePrompt({ route: state.pendingUrlState, onboardingShown });
    } else {
      markIntroDataReady();
      hideSkeleton(initSkeletonToken);
      setLoading('还没有可显示的法典数据');
      const codexBtnText = $('#codexBtnText');
      if (codexBtnText) codexBtnText.textContent = '暂无法典';
      initializeAtlasHistory(captureAtlasRoute(''));
    }
    // 本地编辑器的能力探测与是否已有法典无关：空仓库也必须能创建第一本。
    maybeLoadEditMode();
  } catch (ex) {
    console.error(ex);
    markIntroDataReady();
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

/* 本地编辑模式探测：只在本机 origin 下、且 /__edit__/ping 有响应（= edit_server 在服务本页）
   才动态加载编辑模块；线上与普通预览该路径 404，编辑代码零加载。失败一律静默。 */
function maybeLoadEditMode() {
  if (!isLocalOrigin()) return;
  // ⚠ 瀑布流有持续微动效，页面几乎不会真正 idle，requestIdleCallback 必须带 timeout 兜底才会触发
  // 独立本地版则不应先短暂露出共创入口/空状态，启动后立即接管为编辑器。
  const schedule = document.body.classList.contains('local-edition')
    ? cb => cb()
    : window.requestIdleCallback
      ? cb => window.requestIdleCallback(cb, { timeout: 2000 })
      : cb => setTimeout(cb, 1500);
  schedule(async () => {
    try {
      const res = await fetch('/__edit__/ping', { cache: 'no-store' });
      if (!res.ok) return;
      const info = await res.json();
      if (!info?.ok) return;
      const mod = await import('./app/edit.js');
      mod.initEditMode(info, { loadCodex, applyFilter, captureRoute: captureAtlasRoute });
    } catch { /* 无编辑服务 = 能力不存在 */ }
  });
}

async function syncAtlasFavoritesFromStorage(detail = {}) {
  /* ⚠ 点星标（reason:'toggle'）不能走下面的整份重建：toggleFav 自己已经改好 state.favs、
     用 setFavoriteButtonState / syncRenderedFavoriteButtons 做了外科式更新，收藏视图也由它
     经 refreshFavoritesView 处理（还带 deferViewRefresh 供灯箱延后）。这里再 applyFilter /
     openFavoritesView 一次，等于每点一颗星就把整条虚拟瀑布流销毁重建，顺带把 deferViewRefresh
     整个架空。中转站侧栏收藏列另有自己的订阅（只置脏、切页签才重建），不依赖这条路径。 */
  if (detail?.reason === 'toggle') return;
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
    const render = () => renderCodexView(codex, seq, {
      options,
      parentScrollY,
      enterView: c => {
        state.favoritesView = false;
        state.siteSearchView = false;
        state.browseCodex = c;
        state.searchReturnPath = [];
        setOnlyFavControl(false);
      },
      selectedCodexId: c => c.id,
      buttonCodex: c => findCodexMeta(c.id),
      buttonFallback: c => c.title,
      metaText: c => `${c.author ? c.author + ' · ' : ''}${c.version} · ${c.entryCount} 条`,
      resolveUrlState: c => options.urlState
        && (!options.urlState.codex || options.urlState.codex === c.id || (c.aliases || []).includes(options.urlState.codex))
        ? options.urlState
        : null,
      applyViewUrlState: (urlState, c) => {
        state.updateFilter = resolveUpdateFilter(c, requestedUpdateFilter(urlState));
        applyUrlSearchScope(urlState);
      },
      resolveQuery: urlState => urlState?.q || '',
    });
    await runCodexViewTransition(seq, () => replaceSkeleton(seq, render), { wasSwitching, transition: options.transition });
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
    const render = () => renderCodexView(codex, seq, {
      options,
      parentScrollY,
      enterView: () => {
        state.favoritesView = true;
        state.siteSearchView = false;
        state.updateFilter = '';
        state.searchReturnPath = [];
        setOnlyFavControl(true);
      },
      selectedCodexId: () => state.browseCodex?.id || '',
      buttonCodex: () => findCodexMeta(state.browseCodex?.id) || state.browseCodex,
      buttonFallback: () => '选择法典',
      metaText: c => `${c.version} · ${c.entryCount} 条`,
      resolveUrlState: () => options.urlState
        && (options.urlState.favorites || options.urlState.codex === FAVORITES_CODEX_ID)
        ? options.urlState
        : null,
      applyViewUrlState: urlState => applyUrlSearchScope(urlState),
      resolveQuery: urlState => urlState?.q || '',
    });
    await runCodexViewTransition(seq, () => replaceSkeleton(seq, render), { wasSwitching, transition: options.transition });
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
    if (!siteSearchStillWanted(options)) return;
    const wasSwitching = Boolean(state.codex);
    const render = () => siteSearchStillWanted(options) && renderCodexView(codex, seq, {
      options,
      parentScrollY,
      primeCodexes: state.codexes,
      enterView: () => {
        state.favoritesView = false;
        state.siteSearchView = true;
        state.updateFilter = '';
        setOnlyFavControl(false);
      },
      selectedCodexId: () => state.browseCodex?.id || '',
      buttonCodex: () => findCodexMeta(state.browseCodex?.id) || state.browseCodex,
      buttonFallback: () => '选择法典',
      metaText: c => `${c.version} · ${c.entryCount} 条`,
      resolveUrlState: () => options.urlState && options.urlState.scope === 'site'
        ? options.urlState
        : null,
      applyViewUrlState: () => {
        state.searchScope = 'site';
        updateSearchScopeControl();
      },
      resolveQuery: urlState => urlState?.q ?? state.query,
    });
    await runCodexViewTransition(seq, () => replaceSkeleton(seq, render), { wasSwitching, transition: options.transition });
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
  state.updateFilter = '';
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
  const updateFilter = codexUpdateFilters(state.codex).find(filter => filter.id === state.updateFilter);
  if (updateFilter) list = list.filter(entry => entryMatchesUpdateFilter(entry, updateFilter));
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
  const closingOwnDetail = Boolean(
    !targetEntry &&
    state.lightbox.entry &&
    context.departing?.transition === 'detail' &&
    context.departing?.parentId === context.target?.id &&
    canonicalListContext(context.departing?.route) === canonicalListContext(route),
  );
  if (closingOwnDetail) {
    state.searchHistorySessionId = String(context.target?.sessionId || '');
    closeLightbox({ historyMode: 'none' });
    const normalizedRoute = captureAtlasRoute('');
    return historyRouteNeedsCanonicalization(route, normalizedRoute)
      ? normalizedRoute
      : undefined;
  }
  const urlState = {
    codex: targetLocked || targetUnknown ? targetId : (route.codex || targetId),
    favorites: Boolean(route.favorites),
    scope: route.siteSearch ? 'site' : (route.scope || 'codex'),
    path: Array.isArray(route.path) ? route.path : [],
    q: String(route.q || ''),
    entry: '',
    updateFilter: requestedUpdateFilter(route),
  };
  state.suppressUrlSync = true;
  state.searchHistorySessionId = String(context.target?.sessionId || '');
  suppressBrowseStateSave(2000);
  try {
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
      state.updateFilter = resolveUpdateFilter(state.codex, requestedUpdateFilter(route));
      state.searchScope = route.scope === 'site' ? 'site' : 'codex';
      updateSearchScopeControl();
      const nextPath = normalizeCodexRoutePath(state.codex, urlState.path, urlState.codex);
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
    state.searchReturnPath = route.searchReturnPath?.length
      ? normalizeCodexRoutePath(state.browseCodex || state.codex, route.searchReturnPath, urlState.codex)
      : [];
    const normalizedRoute = captureAtlasRoute(targetEntry);
    const pathChanged = !targetEntry && JSON.stringify(normalizedRoute.path) !== JSON.stringify(urlState.path);
    if (
      targetLocked
      || targetUnknown
      || pathChanged
      || historyRouteNeedsCanonicalization(route, normalizedRoute)
    ) {
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
