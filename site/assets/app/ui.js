import { state, ADULT_CONFIRMATION_STORAGE_KEY, DENSITY_PRESETS, DENSITY_STORAGE_KEY, THEME_STORAGE_KEY, THEMES, NSFW_STORAGE_KEY, R18G_STORAGE_KEY, SEARCH_SCOPE_STORAGE_KEY } from './state.js';
import { normalizeDensity, densityConfig, normalizeSearchScope } from './state.js';
import { $, updateSearchClear, updateScrollProgress, prefersReducedMotion } from './utils.js';
import { dismissToast, toast } from './feedback.js';
import { firstUnlockedCodex, isNsfwCodex, isNsfwPathSegment, isR18gName } from './access.js';
import { closeBannerAbout, renderCodexArchive, renderTree, renderCodexHeader, randomExplore, updateCodexPickerState } from './codex-ui.js';
import { beginAtlasLayeredSearch, syncUrlState } from './router.js';
import { parseSearchFilter, parseSearchQuery, serializeSearchFilter } from './search.js';
import { closeSearchFilterPanel, renderSearchStatus, setSearchUiActions, setupSearchUi } from './search-ui.js';
import { renderHistoryPanel, resumeLastBrowse, openRecentEntry, saveRecentEntries, scheduleBrowseStateSave } from './history.js';
import { captureMasonryAnchor, restoreMasonryAnchor, relayoutVisible, updateVirtualCards, scheduleVirtualUpdate, scheduleRelayout } from './masonry.js';
import { bindLightboxControls, refreshLightboxAccess } from './lightbox.js';
import { scrubClipboardFallback } from './clipboard-fallback.js';
import { openMask, closeMask, registerMaskHistory, trapFocus } from './modal.js';
import { setupAnnouncements } from './announcements.js';
import { setupReport, openReportDialog } from './report.js';
import { openOnboarding, setupOnboarding } from './onboarding.js';
import { closeRelayRail, isRelayRailModal } from './tag-relay-rail.js';
import { refreshRelayAccess } from './tag-relay.js';
import { setupHomeShortcutGuide } from './home-shortcut.js';
import { dismissResumePrompt } from './resume-prompt.js';
import {
  closeHistoryLayer,
  forgetHistoryLayer,
  getManagedHistoryEntry,
  goBackFrom,
  openHistoryLayer,
  registerHistoryLayer,
  scheduleHistoryScrollCheckpoint,
  topHistoryLayerId,
} from './browser-history.js';

const THEME_ICONS = {
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8Z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
};

const uiActions = {
  loadCodex: async () => {},
  openFavoritesView: async () => {},
  openSiteSearchView: async () => {},
  exitSiteSearchView: () => {},
  applyFilter: () => {},
  applySearch: async () => {},
  openRelatedDirectory: async () => {},
};

export function setUiActions(actions = {}) {
  Object.assign(uiActions, actions);
}

const DENSITY_ORDER = Object.keys(DENSITY_PRESETS);

export function nextDensity(value) {
  const current = normalizeDensity(value);
  const index = DENSITY_ORDER.indexOf(current);
  return DENSITY_ORDER[(index + 1) % DENSITY_ORDER.length];
}

/* 首次搜索可能要等全站法典异步汇总后才真正写入历史。把“首条记录是否仍待写”
   收在一个小状态机里，确保输入、chip 和范围切换共用同一份 push/replace 语义。 */
export function createSearchHistoryIntentTracker() {
  let pending = false;
  return {
    begin({ previous, next, mobileLayered = false } = {}) {
      if (!next) pending = false;
      if (next && !previous) pending = true;
      const needsInitialHistory = Boolean(next && pending);
      const layered = Boolean(needsInitialHistory && mobileLayered);
      return {
        needsInitialHistory,
        layered,
        historyMode: needsInitialHistory ? (layered ? 'none' : 'push') : 'replace',
      };
    },
    settle({ needsInitialHistory, layered, sessionMatches, siteViewReady = true, beginLayeredSearch } = {}) {
      if (needsInitialHistory && layered && pending && sessionMatches && siteViewReady) {
        if (beginLayeredSearch?.()) pending = false;
      } else if (needsInitialHistory && !layered && sessionMatches) {
        pending = false;
      }
      return !pending;
    },
    get pending() { return pending; },
  };
}

export function updateDensityControls() {
  for (const btn of document.querySelectorAll('[data-density]')) {
    const active = btn.dataset.density === state.density;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  const quick = $('#densityQuickBtn');
  if (quick) {
    const currentLabel = DENSITY_PRESETS[state.density]?.label || densityConfig().label;
    const nextLabel = DENSITY_PRESETS[nextDensity(state.density)].label;
    const label = `卡片密度：${currentLabel}；点击切换到${nextLabel}`;
    quick.title = label;
    quick.setAttribute('aria-label', label);
  }
}

export function updateSearchScopeControl() {
  const btn = $('#searchScopeBtn');
  if (!btn) return;
  const site = state.searchScope === 'site';
  btn.textContent = site ? '全站' : '本书';
  btn.dataset.scope = state.searchScope;
  btn.title = site ? '当前搜索范围：全站。点击切到当前法典' : '当前搜索范围：当前法典。点击切到全站';
  btn.setAttribute('aria-label', site ? '搜索范围：全站' : '搜索范围：当前法典');
}

export function applyDensity(value, { render = true, announce = false } = {}) {
  const next = normalizeDensity(value);
  const changed = state.density !== next;
  const anchor = changed && render ? captureMasonryAnchor() : null;
  state.density = next;
  document.body.classList.remove(...Object.keys(DENSITY_PRESETS).map(k => `density-${k}`));
  document.body.classList.add(`density-${next}`);
  localStorage.setItem(DENSITY_STORAGE_KEY, next);
  updateDensityControls();
  if (!changed || !render || !state.codex) return;
  relayoutVisible({ animate: true });
  restoreMasonryAnchor(anchor);
  updateVirtualCards(true);
  updateScrollProgress();
  if (announce) toast(`卡片密度：${densityConfig().label}`);
}

export function bindUI() {
  document.querySelectorAll('.settings-mask[id], .favorites-backup-mask[id]')
    .forEach(registerMaskHistory);
  let st;
  const searchInput = $('#search');
  const searchClear = $('#searchClear');
  const searchExit = $('#searchExit');
  const searchScopeBtn = $('#searchScopeBtn');
  const mobileSearchBtn = $('#mobileSearchBtn');
  const mobileQuery = window.matchMedia('(max-width:600px)');
  const mobileSearchInertState = new Map();
  const setMobileSearchSiblingsInert = inert => {
    if (inert) {
      document.querySelectorAll('.topbar > :not(.search-wrap)').forEach(node => {
        if (mobileSearchInertState.has(node)) return;
        mobileSearchInertState.set(node, Boolean(node.inert));
        node.inert = true;
      });
      return;
    }
    mobileSearchInertState.forEach((wasInert, node) => { node.inert = wasInert; });
    mobileSearchInertState.clear();
  };
  const applySearchMode = (on, { focus = false, restoreButton = false } = {}) => {
    const shouldOpen = on && mobileQuery.matches;
    document.body.classList.toggle('search-mode', shouldOpen);
    setMobileSearchSiblingsInert(shouldOpen);
    if (shouldOpen) {
      setTopbarHidden(false);
      if (focus) requestAnimationFrame(() => searchInput.focus());
    } else {
      searchInput.blur();
      if (restoreButton) mobileSearchBtn?.focus({ preventScroll: true });
    }
  };
  registerHistoryLayer('mobile-search', {
    isOpen: () => document.body.classList.contains('search-mode'),
    open: () => applySearchMode(true),
    close: () => {
      closeSearchFilterPanel();
      applySearchMode(false, { restoreButton: mobileQuery.matches });
    },
  });
  const setSearchMode = (on, { focus = false, restoreButton = false, historyMode = on ? 'push' : 'back' } = {}) => {
    if (!mobileQuery.matches) {
      applySearchMode(false, { restoreButton });
      return;
    }
    const replaceLayer = on && topHistoryLayerId() === 'banner-about';
    if (replaceLayer) closeBannerAbout();
    if (!on && historyMode !== 'none' && closeHistoryLayer('mobile-search')) return;
    applySearchMode(on, { focus, restoreButton });
    if (historyMode === 'none') return;
    if (on) openHistoryLayer('mobile-search', { mode: replaceLayer || historyMode === 'replace' ? 'replace' : 'push' });
    else forgetHistoryLayer('mobile-search');
  };
  const nextSearchSessionId = () => `search-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const searchHistoryIntent = createSearchHistoryIntentTracker();
  const searchIsActive = () => Boolean(state.query.trim() || state.searchFilterValues.length);
  const compileSearchState = (query, filterValues, { canonicalize = true } = {}) => {
    const plan = parseSearchQuery(query, filterValues);
    state.query = canonicalize && plan.canCanonicalize ? plan.canonicalQuery : String(query || '');
    state.searchDraft = state.query;
    state.searchFilters = [...plan.filters];
    state.searchFilterValues = [...plan.filterValues];
    state.searchIssues = [...plan.issues];
    state.searchPlan = plan;
    return plan;
  };
  const applySearchConditions = async ({ query = state.query, filterValues = state.searchFilterValues } = {}, { canonicalize = true } = {}) => {
    const parentScrollY = Math.max(0, window.scrollY || 0);
    const previous = searchIsActive();
    const plan = compileSearchState(query, filterValues, { canonicalize });
    const next = plan.hasActiveSearch;
    searchInput.value = state.query;
    updateSearchClear();
    const firstQuery = Boolean(next && !previous);
    if (firstQuery) {
      state.searchHistorySessionId = nextSearchSessionId();
    }
    // 全站法典异步汇总期间，较早查询可能被更新查询取消。直到某一轮真正写入首条
    // search 记录前，后续查询也必须保留 push 意图，不能提前退化成 replace。
    const historyIntent = searchHistoryIntent.begin({
      previous,
      next,
      mobileLayered: mobileQuery.matches && topHistoryLayerId() === 'mobile-search',
    });
    const { needsInitialHistory, layered, historyMode } = historyIntent;
    if (!next && previous && !mobileQuery.matches && goBackFrom('search')) return plan;
    const sessionId = state.searchHistorySessionId || getManagedHistoryEntry()?.sessionId || undefined;
    await uiActions.applySearch({
      resetScroll: true,
      transition: next ? 'search' : 'route',
      historyMode,
      sessionId,
      parentScrollY,
    });
    searchHistoryIntent.settle({
      ...historyIntent,
      sessionMatches: layered
        ? sessionId === state.searchHistorySessionId
        : getManagedHistoryEntry()?.sessionId === sessionId,
      siteViewReady: state.searchScope !== 'site' || state.siteSearchView || state.favoritesView,
      beginLayeredSearch: () => beginAtlasLayeredSearch(sessionId),
    });
    if (!next && !getManagedHistoryEntry()?.sessionId) state.searchHistorySessionId = '';
    return plan;
  };
  const pendingSyntax = value => {
    const raw = String(value || '').replace(/[：]/g, ':').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    if (!raw || /\s$/.test(raw)) return false;
    const plan = parseSearchQuery(raw, state.searchFilterValues);
    if (plan.issues.some(issue => issue.code === 'unclosed_quote')) return true;
    const field = '(?:title|标题|prompt|prompts|tag|tags|标签|正向|提示词|negative|neg|负面|负面词|note|备注|raw|rawtag|rawtags|原始|原始词|author|作者|codex|book|source|法典|书|type|类型|path|路径|目录|has|image|图片|fav|favorite|favourite|收藏|dir|directory)';
    const valuePattern = '(?:"[^"]*"|\'[^\']*\'|[^\\s]*)';
    return new RegExp(`(?:^|\\s)-?${field}:${valuePattern}$`, 'i').test(raw)
      || /(?:^|\s)-(?:"[^"]*"|'[^']*'|[^\s]+)$/.test(raw);
  };
  updateSearchScopeControl();
  if (searchScopeBtn) {
    searchScopeBtn.onclick = () => {
      state.searchScope = normalizeSearchScope(state.searchScope === 'site' ? 'codex' : 'site');
      localStorage.setItem(SEARCH_SCOPE_STORAGE_KEY, state.searchScope);
      updateSearchScopeControl();
      if (searchIsActive()) {
        void applySearchConditions();
      } else {
        syncUrlState({ historyMode: 'replace' });
      }
      searchInput.focus();
    };
  }
  mobileSearchBtn?.addEventListener('click', () => setSearchMode(true, { focus: true }));
  searchExit?.addEventListener('click', () => setSearchMode(false, { restoreButton: true }));
  if (mobileQuery.addEventListener) {
    mobileQuery.addEventListener('change', ev => {
      if (ev.matches) {
        if (document.body.classList.contains('search-filters-open')) {
          setSearchMode(true, { historyMode: 'push' });
        }
      } else {
        const searchWasOpen = document.body.classList.contains('search-mode');
        closeSearchFilterPanel();
        applySearchMode(false);
        if (searchWasOpen) closeHistoryLayer('mobile-search');
        else forgetHistoryLayer('mobile-search');
        forgetHistoryLayer('mobile-sidebar');
      }
    });
  }
  let searchComposing = false;
  const scheduleSearchInput = (value, { commitSyntax = /\s$/.test(String(value || '')) } = {}) => {
    clearTimeout(st);
    st = setTimeout(() => {
      if (!commitSyntax && pendingSyntax(value)) {
        state.searchDraft = String(value || '');
        renderSearchStatus({ kind: 'info', message: '继续输入，或按 Enter 添加筛选条件' });
        return;
      }
      if (value.trim()) {
        if (!state.siteSearchView) document.querySelectorAll('.tree-row.active').forEach(r => r.classList.remove('active'));   // 全站搜索保留目录收窄的高亮
      } else if (!state.siteSearchView) {
        renderTree();
      }
      void applySearchConditions({ query: value }, { canonicalize: commitSyntax || !pendingSyntax(value) });
    }, 180);
  };
  searchInput.addEventListener('compositionstart', () => {
    searchComposing = true;
    clearTimeout(st);
  });
  searchInput.addEventListener('compositionend', e => {
    searchComposing = false;
    updateSearchClear();
    scheduleSearchInput(e.currentTarget.value);
  });
  searchInput.oninput = e => {
    updateSearchClear();
    if (searchComposing || e.isComposing) {
      clearTimeout(st);
      return;
    }
    scheduleSearchInput(e.target.value);
  };
  searchInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || searchComposing || event.isComposing) return;
    event.preventDefault();
    clearTimeout(st);
    void applySearchConditions({ query: searchInput.value }, { canonicalize: true });
  });
  searchInput.addEventListener('blur', () => {
    if (searchComposing || searchInput.value === state.query) return;
    clearTimeout(st);
    void applySearchConditions({ query: searchInput.value }, { canonicalize: true });
  });
  searchInput.addEventListener('paste', () => {
    clearTimeout(st);
    setTimeout(() => {
      clearTimeout(st); // input 事件会安排一次防抖；粘贴完成后只提交这一轮，避免重复 replace/render
      if (!searchComposing) void applySearchConditions({ query: searchInput.value }, { canonicalize: true });
    }, 0);
  });
  if (searchClear) {
    searchClear.onclick = () => {
      if (!searchInput.value) return;
      clearTimeout(st);
      searchInput.value = '';
      updateSearchClear();
      void applySearchConditions({ query: '' });
      searchInput.focus();
    };
  }

  const normalizedFilterValue = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();
  const addSearchFilter = async candidate => {
    const parsed = parseSearchFilter(candidate);
    if (!parsed.filter) throw new Error(parsed.issues[0]?.message || '筛选条件无效');
    const nextFilter = parsed.filter;
    const serialized = serializeSearchFilter(nextFilter);
    let values = [...state.searchFilterValues];
    const parsedValues = values.map(value => parseSearchFilter(value));
    if (parsedValues.some(item => item.filter && serializeSearchFilter(item.filter) === serialized)) return true;
    const singleValueFields = new Set(['directory', 'has', 'fav', 'codex', 'type']);
    if (singleValueFields.has(nextFilter.field)) {
      values = values.filter((value, index) => parsedValues[index].filter?.field !== nextFilter.field);
    } else {
      const conflict = parsedValues.some(item => item.filter
        && item.filter.field === nextFilter.field
        && item.filter.op !== nextFilter.op
        && normalizedFilterValue(item.filter.value) === normalizedFilterValue(nextFilter.value));
      if (conflict) throw new Error('同一个条件不能同时包含和排除');
    }
    values.push(serialized);
    await applySearchConditions({ filterValues: values });
    return true;
  };
  const removeSearchFilter = async (_filter, index) => {
    const values = [...state.searchFilterValues];
    if (!Number.isInteger(index) || index < 0 || index >= values.length) return;
    values.splice(index, 1);
    await applySearchConditions({ filterValues: values });
  };
  const clearAllSearch = async () => {
    clearTimeout(st);
    searchInput.value = '';
    await applySearchConditions({ query: '', filterValues: [] });
    closeSearchFilterPanel();
  };
  setSearchUiActions({
    addFilter: addSearchFilter,
    removeFilter: removeSearchFilter,
    clearAll: clearAllSearch,
    useExample: async query => {
      const combined = [searchInput.value.trim(), String(query || '').trim()].filter(Boolean).join(' ');
      searchInput.value = combined;
      await applySearchConditions({ query: combined }, { canonicalize: true });
    },
    openRelatedDirectory: async item => {
      closeSearchFilterPanel();
      await uiActions.openRelatedDirectory(item);
    },
    runStatusAction: async action => {
      if (action?.id === 'clear-filters') {
        await applySearchConditions({ filterValues: [] });
      } else if (action?.id === 'clear-all') {
        await clearAllSearch();
      } else if (action?.id === 'scope-site') {
        state.searchScope = 'site';
        localStorage.setItem(SEARCH_SCOPE_STORAGE_KEY, state.searchScope);
        updateSearchScopeControl();
        await applySearchConditions();
      }
    },
  });
  setupSearchUi();

  const updateFilterControls = $('#updateFilterControls');
  if (updateFilterControls) {
    updateFilterControls.onclick = event => {
      const btn = event.target.closest?.('[data-update-filter]');
      if (!btn || !updateFilterControls.contains(btn)) return;
      const id = String(btn.dataset.updateFilter || '');
      state.updateFilter = state.updateFilter === id ? '' : id;
      uiActions.applyFilter({ resetScroll: true, transition: 'filter' });
      syncUrlState({ historyMode: 'replace' });
    };
  }
  $('#onlyFav').onchange = e => {
    if (e.target.checked) {
      uiActions.openFavoritesView();
    } else {
      const target = state.browseCodex?.id || firstUnlockedCodex()?.id || state.codex?.id;
      if (target) uiActions.loadCodex(target, { historyMode: 'push', transition: 'route' });
    }
  };

  const applyTheme = d => {
    document.body.classList.toggle('dark', d);
    document.documentElement.style.colorScheme = d ? 'dark' : 'light';   // 滚动条等原生控件跟随深浅色
    $('#themeBtn').innerHTML = d ? THEME_ICONS.sun : THEME_ICONS.moon;
    $('#themeBtn').setAttribute('aria-label', d ? '切换浅色模式' : '切换深色模式');
    localStorage.setItem('fadian-dark', d ? '1' : '0');
  };
  $('#themeBtn').onclick = () => applyTheme(!document.body.classList.contains('dark'));
  applyTheme(localStorage.getItem('fadian-dark') === '1');

  /* 界面风格（换肤）：与深浅色正交，每套 light+dark 都在 CSS 里；默认紫=不加类 */
  const applySkin = id => {
    const t = THEMES.find(x => x.id === id) || THEMES[0];
    for (const x of THEMES) if (x.id) document.body.classList.remove('theme-' + x.id);
    if (t.id) document.body.classList.add('theme-' + t.id);
    localStorage.setItem(THEME_STORAGE_KEY, t.id);
    for (const b of document.querySelectorAll('#themeControl [data-theme]'))
      b.setAttribute('aria-pressed', b.dataset.theme === t.id ? 'true' : 'false');
    return t;
  };
  for (const b of document.querySelectorAll('#themeControl [data-theme]'))
    b.onclick = () => toast(`已切换主题：${applySkin(b.dataset.theme).name}`);
  applySkin(localStorage.getItem(THEME_STORAGE_KEY) || '');

  /* SD 复制模式：设置里的开关 + 顶栏常驻角标（开着才显示，点角标可关），状态存 localStorage */
  const sdToggle = $('#sdModeToggle');
  const sdBadge = $('#sdBadge');
  let sdBadgeTimer;
  const showSdBadge = (on, animate) => {
    if (!sdBadge) return;
    clearTimeout(sdBadgeTimer);
    if (on) {
      sdBadge.hidden = false;
      if (animate) void sdBadge.offsetWidth;   // 强制回流，让淡入过渡生效
      sdBadge.classList.add('show');
    } else {
      sdBadge.classList.remove('show');
      if (animate && !prefersReducedMotion()) {
        sdBadgeTimer = setTimeout(() => { sdBadge.hidden = true; }, 240);  // 等淡出动画结束再收起占位
      } else {
        sdBadge.hidden = true;
      }
    }
  };
  const applySdMode = (on, animate = true) => {
    state.sdMode = on;
    if (sdToggle) sdToggle.checked = on;
    document.body.classList.toggle('sd-mode', on);
    localStorage.setItem('fadian-sdmode', on ? '1' : '0');
    showSdBadge(on, animate);
  };
  if (sdToggle) sdToggle.onchange = e => applySdMode(e.target.checked);
  if (sdBadge) sdBadge.onclick = () => applySdMode(false);
  applySdMode(localStorage.getItem('fadian-sdmode') === '1', false);  // 初始化不做动画

  for (const btn of document.querySelectorAll('[data-density]')) {
    btn.onclick = () => applyDensity(btn.dataset.density, { render: true, announce: true });
  }
  const densityQuickBtn = $('#densityQuickBtn');
  if (densityQuickBtn) {
    densityQuickBtn.onclick = () => applyDensity(nextDensity(state.density), { render: true, announce: true });
  }
  updateDensityControls();

  const sidebar = $('#sidebar');
  const sidebarBackdrop = $('#sidebarBackdrop');
  const savedSidebar = localStorage.getItem('fadian-sidebar');
  if (savedSidebar === 'closed' || (savedSidebar === null && window.innerWidth <= 600)) {
    sidebar.classList.add('closed');
  }
  const setSidebarOpenDirect = open => {
    sidebar.classList.toggle('closed', !open);
    localStorage.setItem('fadian-sidebar', open ? 'open' : 'closed');
  };
  registerHistoryLayer('mobile-sidebar', {
    isOpen: () => mobileQuery.matches && !sidebar.classList.contains('closed'),
    open: () => setSidebarOpenDirect(true),
    close: () => setSidebarOpenDirect(false),
  });
  sidebarBackdrop?.addEventListener('click', () => {
    if (closeHistoryLayer('mobile-sidebar')) return;
    setSidebarOpenDirect(false);
    forgetHistoryLayer('mobile-sidebar');
  });
  $('#menuBtn').onclick = () => {
    const opening = sidebar.classList.contains('closed');
    if (mobileQuery.matches && !opening && closeHistoryLayer('mobile-sidebar')) return;
    const replaceLayer = mobileQuery.matches && opening && topHistoryLayerId() === 'banner-about';
    if (replaceLayer) closeBannerAbout();
    setSidebarOpenDirect(opening);
    if (!mobileQuery.matches) return;
    if (opening) openHistoryLayer('mobile-sidebar', { mode: replaceLayer ? 'replace' : 'push' });
    else forgetHistoryLayer('mobile-sidebar');
  };

  const moreBtn = $('#moreBtn');
  const moreMenu = $('#moreMenu');
  const moreItems = () => [...moreMenu.querySelectorAll('.more-item')]
    .filter(item => item.offsetParent !== null);
  const closeMoreDirect = ({ focusButton = false } = {}) => {
    if (!moreMenu || moreMenu.hidden) return;
    moreMenu.hidden = true;
    moreBtn.classList.remove('open');
    moreBtn.setAttribute('aria-expanded', 'false');
    if (focusButton) moreBtn.focus({ preventScroll: true });
  };
  const openMoreDirect = ({ focus = false } = {}) => {
    closeBannerAbout();
    moreMenu.hidden = false;
    moreBtn.classList.add('open');
    moreBtn.setAttribute('aria-expanded', 'true');
    if (focus) requestAnimationFrame(() => moreItems()[0]?.focus());
  };
  registerHistoryLayer('more-menu', {
    isOpen: () => mobileQuery.matches && !moreMenu.hidden,
    open: () => openMoreDirect(),
    close: () => closeMoreDirect(),
  });
  const closeMore = ({ focusButton = false, historyMode = 'back' } = {}) => {
    if (mobileQuery.matches && historyMode !== 'none' && closeHistoryLayer('more-menu')) return;
    closeMoreDirect({ focusButton });
    if (mobileQuery.matches && historyMode !== 'none') forgetHistoryLayer('more-menu');
  };
  const openMore = ({ focus = false, historyMode = 'push' } = {}) => {
    const replaceLayer = mobileQuery.matches && topHistoryLayerId() === 'banner-about';
    openMoreDirect({ focus });
    if (mobileQuery.matches && historyMode !== 'none') {
      openHistoryLayer('more-menu', { mode: replaceLayer ? 'replace' : historyMode });
    }
  };
  if (moreBtn && moreMenu) {
    moreBtn.onclick = ev => {
      ev.stopPropagation();
      if (moreMenu.hidden) openMore({ focus: true });
      else closeMore({ focusButton: true });
    };
    moreBtn.onkeydown = ev => {
      if (ev.key !== 'ArrowDown' && ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      openMore({ focus: true });
    };
    moreMenu.onkeydown = ev => {
      const list = moreItems();
      const i = list.indexOf(document.activeElement);
      if (ev.key === 'Escape') { ev.preventDefault(); closeMore({ focusButton: true }); }
      else if (ev.key === 'Tab') closeMore();
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); list[(i + 1 + list.length) % list.length]?.focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
      else if (ev.key === 'Home') { ev.preventDefault(); list[0]?.focus(); }
      else if (ev.key === 'End') { ev.preventDefault(); list[list.length - 1]?.focus(); }
    };
    document.addEventListener('click', ev => {
      if (!moreMenu.hidden && !moreMenu.contains(ev.target) && !moreBtn.contains(ev.target)) closeMore();
    });
  }
  setupReport();
  setupAnnouncements({
    closeMore: () => closeMore({ historyMode: 'none' }),
    historyMode: () => mobileQuery.matches ? 'replace' : 'push',
  });
  setupOnboarding();
  setupHomeShortcutGuide();
  const globalReportBtn = $('#globalReportBtn');
  if (globalReportBtn) {
    globalReportBtn.onclick = () => {
      closeMore({ historyMode: 'none' });
      openReportDialog({
        source: 'global',
        trigger: moreBtn || globalReportBtn,
        historyMode: mobileQuery.matches ? 'replace' : 'push',
      });
    };
  }

  /* 公告面板底部的常驻入口：从「站方在干什么」的语境顺势跳到反馈处理进度。
     沿用灯箱→反馈的既有做法（叠层打开、不手动关公告），保持历史栈一致。 */
  const announcementsFeedbackLink = $('#announcementsFeedbackLink');
  if (announcementsFeedbackLink) {
    announcementsFeedbackLink.onclick = () => {
      openReportDialog({
        source: 'announcement',
        tab: 'progress',
        trigger: announcementsFeedbackLink,
        historyMode: mobileQuery.matches ? 'replace' : 'push',
      });
    };
  }

  /* 设置 / 关于 悬浮框：开关三件套（按钮/遮罩/Esc），带淡入淡出 */
  const settingsMask = $('#settings');
  const nsfwMask = $('#nsfwConfirm');
  const shortcutMask = $('#shortcutHelp');
  const historyMask = $('#historyPanel');
  const favoritesBackupMask = $('#favoritesBackupPanel');
  const aboutMask = $('#about');
  const archiveMask = $('#codexArchive');
  const announcementsMask = $('#announcementsPanel');
  const feedbackMask = $('#feedbackPanel');
  const onboardingMask = $('#onboarding');
  const nsfwToggle = $('#nsfwToggle');
  const scrubRestrictedSurfaces = () => {
    /* 不能只让之后的点击被 guard 拦住：已经写进 DOM 的标题、缩略图和 prompt
       也属于撤权范围，跨标签页关闭权限时尤其容易残留。 */
    renderHistoryPanel();
    dismissResumePrompt();
    scrubClipboardFallback();
    dismissToast({ clear: true });
  };
  const setNsfwAccess = (on, { announce = false, persist = true } = {}) => {
    state.allowNsfw = Boolean(on);
    document.body.classList.toggle('nsfw-unlocked', state.allowNsfw);
    if (persist) localStorage.setItem(NSFW_STORAGE_KEY, state.allowNsfw ? '1' : '0');
    if (persist && state.allowNsfw) localStorage.setItem(ADULT_CONFIRMATION_STORAGE_KEY, '1');
    if (nsfwToggle) nsfwToggle.checked = state.allowNsfw;
    if (!state.allowNsfw) setR18gAccess(false, { persist, scrub: false });  // R18G 依赖 NSFW，关掉 NSFW 一并强制关闭 R18G
    if (!state.allowNsfw && (state.activePath || []).some(isNsfwPathSegment)) state.activePath = [];
    updateR18gToggleState();
    updateCodexPickerState();
    if (!state.allowNsfw && isNsfwCodex(state.codex)) {
      const fallback = firstUnlockedCodex();
      if (fallback) uiActions.loadCodex(fallback.id, { historyMode: 'replace' });
    } else if (state.siteSearchView) {
      uiActions.openSiteSearchView({ historyMode: 'replace' });   // 全站搜索按整本锁态构建：NSFW 开关后重建索引
    } else if (state.favoritesView) {
      uiActions.openFavoritesView({ historyMode: 'replace' });   // 收藏视图按锁态构建：开关 NSFW 后重建，让 NSFW 法典的收藏浮现/隐藏
    } else if (state.codex) {
      renderTree();
      renderCodexHeader();
      uiActions.applyFilter({ resetScroll: true });
    }
    refreshRelayAccess();   // 侧栏只订阅自己的 store，分级是内存 state，必须显式通知，否则锁后仍有可选中的残留文本
    refreshLightboxAccess();
    if (!state.allowNsfw) scrubRestrictedSurfaces();
    if (announce) toast(state.allowNsfw ? 'NSFW 法典已解锁' : 'NSFW 法典已锁定');
  };
  const cancelNsfwConfirm = () => {
    if (nsfwToggle) nsfwToggle.checked = false;
    closeMask(nsfwMask);
  };
  if (nsfwToggle) {
    nsfwToggle.checked = state.allowNsfw;
    nsfwToggle.onchange = e => {
      if (e.target.checked) {
        e.target.checked = false;
        openMask(nsfwMask, nsfwToggle);
      } else {
        setNsfwAccess(false, { announce: true });
      }
    };
  }
  $('#nsfwAccept').onclick = () => {
    setNsfwAccess(true, { announce: true });
    closeMask(nsfwMask);
  };
  $('#nsfwCancel').onclick = cancelNsfwConfirm;
  $('#nsfwCancelX').onclick = cancelNsfwConfirm;
  nsfwMask.onclick = ev => { if (ev.target === nsfwMask) cancelNsfwConfirm(); };
  nsfwMask.onkeydown = ev => trapFocus(ev, nsfwMask);

  /* R18G / 重口：默认完全隐藏；需先开 NSFW，再走多重恐吓式确认才能开启 */
  const r18gToggle = $('#r18gToggle');
  const r18gMask = $('#r18gConfirm');
  const R18G_STEPS = [
    {
      title: '⚠ 重口 / R18G 内容警告',
      text: '你正要解锁「R18G / 重口」内容。这类内容与普通 R18 完全不是一个级别——它包含血腥、暴力、猎奇等极端画面，绝大多数人看了会强烈不适。确定要继续吗？',
      next: '我已年满 18 岁，继续',
    },
    {
      title: '⚠⚠ 最后机会：强烈生理与心理不适',
      text: '再次严重警告：内含杀害、肢解、人棍、刑罚、内脏、排泄物等极端猎奇画面，可能引起恶心、呕吐、心理阴影，且一旦看到便无法消除。能接受 R18 不代表能接受这些。你真的要看？',
      next: '我自愿承担后果，继续',
    },
    {
      title: '⚠⚠⚠ 终极确认',
      text: '这些内容非娱乐向。点击开启即代表你完全自愿、并自行承担观看后果，与本站及法典作者无关。确认开启？',
      next: '我清楚后果，确认开启',
    },
  ];
  let r18gStep = 0;
  const renderR18gStep = () => {
    const s = R18G_STEPS[r18gStep];
    const titleEl = $('#r18gConfirmTitle');
    const textEl = $('#r18gWarnText');
    const nextBtn = $('#r18gNext');
    const backBtn = $('#r18gBack');
    if (titleEl) titleEl.textContent = s.title;
    if (textEl) textEl.textContent = s.text;
    if (nextBtn) nextBtn.textContent = s.next;
    if (backBtn) backBtn.textContent = r18gStep === 0 ? '我点错了，退出' : '上一步';
  };
  const openR18gConfirm = () => { r18gStep = 0; renderR18gStep(); openMask(r18gMask, r18gToggle); };
  const cancelR18gConfirm = () => { if (r18gToggle) r18gToggle.checked = false; closeMask(r18gMask); };
  const setR18gAccess = (on, { announce = false, persist = true, scrub = true } = {}) => {
    state.allowR18g = Boolean(on) && state.allowNsfw;
    refreshRelayAccess();
    refreshLightboxAccess();
    document.body.classList.toggle('r18g-unlocked', state.allowR18g);
    if (persist) localStorage.setItem(R18G_STORAGE_KEY, state.allowR18g ? '1' : '0');
    if (r18gToggle) r18gToggle.checked = state.allowR18g;
    if (!state.allowR18g && (state.activePath || []).some(isR18gName)) state.activePath = [];  // 关闭时若停在 r18g 分类则退回全部
    if (state.codex) {
      renderTree();
      renderCodexHeader();
      uiActions.applyFilter({ resetScroll: true });
    }
    if (!state.allowR18g && scrub) scrubRestrictedSurfaces();
    if (announce) toast(state.allowR18g ? '已开启 R18G / 重口' : 'R18G / 重口内容已隐藏');
  };
  const updateR18gToggleState = () => {
    if (!r18gToggle) return;
    const row = r18gToggle.closest('.set-row');
    r18gToggle.disabled = !state.allowNsfw;
    if (row) row.classList.toggle('disabled', !state.allowNsfw);
    r18gToggle.checked = state.allowR18g;
  };
  if (r18gToggle) {
    r18gToggle.checked = state.allowR18g;
    r18gToggle.onchange = e => {
      if (!state.allowNsfw) { e.target.checked = false; toast('请先开启「允许 NSFW 法典展示」', '!'); return; }
      if (e.target.checked) {
        e.target.checked = false;
        openR18gConfirm();
      } else {
        setR18gAccess(false, { announce: true });
      }
    };
  }
  if (r18gMask) {
    $('#r18gNext').onclick = () => {
      if (r18gStep < R18G_STEPS.length - 1) { r18gStep++; renderR18gStep(); }
      else { setR18gAccess(true, { announce: true }); closeMask(r18gMask); }
    };
    $('#r18gBack').onclick = () => {
      if (r18gStep > 0) { r18gStep--; renderR18gStep(); }
      else cancelR18gConfirm();
    };
    $('#r18gCancelX').onclick = cancelR18gConfirm;
    r18gMask.onclick = ev => { if (ev.target === r18gMask) cancelR18gConfirm(); };
    r18gMask.onkeydown = ev => trapFocus(ev, r18gMask);
  }
  updateR18gToggleState();
  /* 两个开关是同源持久化偏好，不应在多标签页里各自保留一套权限状态。
     storage 事件不回发当前页，所以本地确认流程仍只走上面的 setter。 */
  window.addEventListener('storage', event => {
    if (event.storageArea && event.storageArea !== localStorage) return;
    if (event.key === null) {
      setNsfwAccess(false, { persist: false });
      return;
    }
    if (event.key === NSFW_STORAGE_KEY) {
      const on = event.newValue === '1';
      setNsfwAccess(on, { persist: false });
      /* setNsfwAccess 只认 NSFW 这一个键：开启时它不会去补读 R18G，于是对端只写了
         NSFW 键（「先开 R18G → 关 NSFW → 再开 NSFW」就走这条）时，本页 R18G 会停在
         false 而对端是 true。方向是 fail-closed 不算漏，但两页状态不一致，这里补一次
         读盘对齐。关闭方向不用补：setNsfwAccess(false) 内部已强制关掉 R18G。 */
      if (on) setR18gAccess(localStorage.getItem(R18G_STORAGE_KEY) === '1', { persist: false });
      return;
    }
    if (event.key === R18G_STORAGE_KEY) {
      if (event.newValue === '1' && !state.allowNsfw && localStorage.getItem(NSFW_STORAGE_KEY) === '1') {
        setNsfwAccess(true, { persist: false });
      }
      setR18gAccess(event.newValue === '1', { persist: false });
    }
  });
  const openFromMore = (mask, trigger = moreBtn) => {
    const topLayer = topHistoryLayerId();
    const replaceLayer = topLayer === 'more-menu' || topLayer === 'banner-about';
    closeMore({ historyMode: 'none' });
    if (topLayer === 'banner-about') closeBannerAbout();
    openMask(mask, trigger, { historyMode: replaceLayer ? 'replace' : 'push' });
  };
  const onboardingBtn = $('#onboardingBtn');
  if (onboardingBtn) {
    onboardingBtn.onclick = () => {
      const topLayer = topHistoryLayerId();
      const replaceLayer = topLayer === 'more-menu' || topLayer === 'banner-about';
      closeMore({ historyMode: 'none' });
      if (topLayer === 'banner-about') closeBannerAbout();
      openOnboarding({
        trigger: moreBtn || onboardingBtn,
        historyMode: replaceLayer ? 'replace' : 'push',
      });
    };
  }
  $('#shortcutBtn').onclick = () => openFromMore(shortcutMask);
  $('#shortcutClose').onclick = () => closeMask(shortcutMask);
  shortcutMask.onclick = ev => { if (ev.target === shortcutMask) closeMask(shortcutMask); };
  shortcutMask.onkeydown = ev => trapFocus(ev, shortcutMask);
  $('#historyBtn').onclick = () => { renderHistoryPanel(); openFromMore(historyMask); };
  $('#historyClose').onclick = () => closeMask(historyMask);
  historyMask.onclick = ev => { if (ev.target === historyMask) closeMask(historyMask); };
  historyMask.onkeydown = ev => trapFocus(ev, historyMask);
  $('#resumeBrowse').onclick = async () => {
    await resumeLastBrowse({ historyMode: 'push', consumeLayer: true });
  };
  $('#clearRecent').onclick = () => {
    state.recentEntries = [];
    saveRecentEntries();
    renderHistoryPanel();
  };
  document.addEventListener('openRecentEntry', async ev => {
    await openRecentEntry(ev.detail, { historyMode: 'push', consumeLayer: true });
  });
  const settingsBtn = $('#settingsBtn');
  if (settingsBtn) settingsBtn.onclick = () => openFromMore(settingsMask, settingsBtn);
  $('#settingsClose').onclick = () => closeMask(settingsMask);
  settingsMask.onclick = ev => { if (ev.target === settingsMask) closeMask(settingsMask); };
  settingsMask.onkeydown = ev => trapFocus(ev, settingsMask);
  $('#aboutBtn').onclick = () => openFromMore(aboutMask);
  $('#aboutClose').onclick = () => closeMask(aboutMask);
  aboutMask.onclick = ev => { if (ev.target === aboutMask) closeMask(aboutMask); };
  aboutMask.onkeydown = ev => trapFocus(ev, aboutMask);
  $('#archiveClose').onclick = () => closeMask(archiveMask);
  archiveMask.onclick = ev => { if (ev.target === archiveMask) closeMask(archiveMask); };
  archiveMask.onkeydown = ev => trapFocus(ev, archiveMask);
  document.addEventListener('openCodexArchive', ev => {
    renderCodexArchive();
    const opener = document.querySelector('.banner-about-btn') || ev.detail?.trigger || document.activeElement;
    const replaceLayer = topHistoryLayerId() === 'banner-about';
    closeBannerAbout();
    openMask(archiveMask, opener, { historyMode: replaceLayer ? 'replace' : 'push' });
  });
  document.addEventListener('click', ev => {
    const openBtn = document.querySelector('.banner-about-btn.open');
    const openPop = document.querySelector('.banner-pop:not([hidden])');
    if (!openBtn || !openPop) return;
    if (openBtn.contains(ev.target) || openPop.contains(ev.target)) return;
    closeBannerAbout({ historyMode: 'back' });
  });
  window.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    if (document.body.classList.contains('search-mode')) {
      ev.preventDefault();
      setSearchMode(false, { restoreButton: true });
      return;
    }
    if (!nsfwMask.hidden) {
      ev.preventDefault();
      cancelNsfwConfirm();
      return;
    }
    if (r18gMask && !r18gMask.hidden) {
      ev.preventDefault();
      cancelR18gConfirm();
      return;
    }
    if (!moreMenu.hidden) { closeMore({ focusButton: true }); return; }
    if (!settingsMask.hidden) { closeMask(settingsMask); return; }
    if (!shortcutMask.hidden) { closeMask(shortcutMask); return; }
    if (!historyMask.hidden) { closeMask(historyMask); return; }
    if (!aboutMask.hidden) { closeMask(aboutMask); return; }
    if (!archiveMask.hidden) { closeMask(archiveMask); return; }
    if (announcementsMask && !announcementsMask.hidden) { closeMask(announcementsMask); return; }
    if (feedbackMask && !feedbackMask.hidden) { closeMask(feedbackMask); return; }
    if (onboardingMask && !onboardingMask.hidden) { closeMask(onboardingMask); return; }
    /* 只有浮层形态的中转站栏才吃 Esc；停靠态是页面家具（同左侧目录栏），不该抢 */
    if (isRelayRailModal()) { closeRelayRail(); return; }
    closeBannerAbout({ historyMode: 'back' });
  });
  bindLightboxControls({ mobileQuery });

  window.addEventListener('scroll', scheduleVirtualUpdate, { passive: true });

  /* 智能顶栏：下滑隐藏、上滑立现；搜索聚焦/移动端目录打开时锁定不收 */
  const randomBtn = $('#randomBtn');
  const backTopBtn = $('#backTop');
  const floatActions = $('.float-actions');
  const setTopbarHidden = hide => document.body.classList.toggle('tb-hidden', hide);
  const scrollToTop = () => {
    setTopbarHidden(false);
    backTopBtn.classList.remove('show');
    floatActions?.classList.remove('has-backtop');
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    updateScrollProgress();
  };
  let lastScrollY = Math.max(0, window.scrollY);
  window.addEventListener('scroll', () => {
    const y = Math.max(0, window.scrollY);
    const dy = y - lastScrollY;
    lastScrollY = y;
    const showBackTop = y > 800;
    backTopBtn.classList.toggle('show', showBackTop);
    floatActions?.classList.toggle('has-backtop', showBackTop);
    updateScrollProgress();
    scheduleBrowseStateSave();
    scheduleHistoryScrollCheckpoint();
    if (Math.abs(dy) < 4) return;
    if (document.body.classList.contains('search-filters-open')) { setTopbarHidden(false); return; }
    if (document.activeElement === searchInput) { setTopbarHidden(false); return; }
    if (mobileQuery.matches && !sidebar.classList.contains('closed')) { setTopbarHidden(false); return; }
    setTopbarHidden(dy > 0 && y > 120);
  }, { passive: true });
  searchInput.addEventListener('focus', () => {
    setTopbarHidden(false);
    if (mobileQuery.matches && !document.body.classList.contains('search-mode')) {
      setSearchMode(true);
    }
  });
  const typingTarget = () => {
    const el = document.activeElement;
    const tag = el && el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable;
  };
  const overlayOpen = () =>
    !$('#lightbox').hidden ||
    !settingsMask.hidden ||
    !nsfwMask.hidden ||
    (r18gMask && !r18gMask.hidden) ||
    !shortcutMask.hidden ||
    !historyMask.hidden ||
    (favoritesBackupMask && !favoritesBackupMask.hidden) ||
    !aboutMask.hidden ||
    !archiveMask.hidden ||
    (announcementsMask && !announcementsMask.hidden) ||
    (feedbackMask && !feedbackMask.hidden) ||
    (onboardingMask && !onboardingMask.hidden) ||
    isRelayRailModal();
  window.addEventListener('keydown', ev => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || typingTarget()) return;
    if (ev.key === '?' && !overlayOpen()) {
      ev.preventDefault();
      openMask(shortcutMask);
      return;
    }
    if (ev.key.toLowerCase() === 'g' && !overlayOpen()) {
      ev.preventDefault();
      scrollToTop();
      return;
    }
    if (ev.key === '/' && !overlayOpen()) {
      ev.preventDefault();
      if (mobileQuery.matches) setSearchMode(true);
      searchInput.focus();
    }
  });

  /* 分类轨道：纵向滚轮转横向滚动 */
  const rail = $('#chipRail');
  if (rail) rail.addEventListener('wheel', ev => {
    if (!ev.deltaY) return;
    ev.preventDefault();
    rail.scrollLeft += ev.deltaY;
  }, { passive: false });

  backTopBtn.onclick = () => {
    scrollToTop();
  };
  if (randomBtn) {
    randomBtn.onclick = () => {
      setTopbarHidden(false);
      randomExplore();
    };
  }

  /* 手机滑动松手时地址栏伸缩会触发纯高度 resize：列数与卡宽都没变，全量重排只会让卡片
     被打回估算高度再弹回实测高度（一缩一伸的乱晃感）。只有宽度变了才值得重排；
     纯高度变化只需刷新虚拟渲染范围（与下方 ResizeObserver 的 2px 宽度守卫同一思路）。 */
  let lastWindowWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    const width = window.innerWidth;
    if (Math.abs(width - lastWindowWidth) >= 2) {
      lastWindowWidth = width;
      scheduleRelayout(true);
    } else {
      scheduleVirtualUpdate();
    }
    updateScrollProgress();
  }, { passive: true });

  if ('ResizeObserver' in window) {
    let lastMainWidth = 0;
    const ro = new ResizeObserver(entries => {
      const width = Math.round(entries[0]?.contentRect?.width || 0);
      if (!width || Math.abs(width - lastMainWidth) < 2) return;
      lastMainWidth = width;
      scheduleRelayout(true);
    });
    ro.observe($('#main'));
  }
}
