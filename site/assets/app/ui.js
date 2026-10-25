import { state, ADULT_CONFIRMATION_STORAGE_KEY, DENSITY_PRESETS, DENSITY_STORAGE_KEY, THEME_STORAGE_KEY, THEMES, FONT_STORAGE_KEY, FONTS, DARK_MODE_STORAGE_KEY, LEGACY_DARK_STORAGE_KEY, DARK_MODES, NSFW_STORAGE_KEY, R18G_STORAGE_KEY, SEARCH_SCOPE_STORAGE_KEY, CARD_ZOOM_STORAGE_KEY } from './state.js';
import { normalizeDensity, densityConfig, normalizeSearchScope } from './state.js';
import { $, updateSearchClear, updateScrollProgress, prefersReducedMotion } from './utils.js';
import { dismissToast, toast } from './feedback.js';
import { readPreference, writePreference, writePreferences } from './preferences-storage.js';
import { animateUi } from './ui-motion.js';
import { firstUnlockedCodex, isNsfwPathSegment, isR18gName } from './access.js';
import { closeBannerAbout, renderCodexArchive, renderTree, randomExplore, setUpdateFilter, updateCodexPickerState } from './codex-ui.js';
import { beginAtlasLayeredSearch, syncUrlState } from './router.js';
import { parseSearchFilter, parseSearchQuery, removeSearchQueryTerm, serializeSearchFilter, splitSearchPhrases } from './search.js';
import { closeSearchFilterPanel, renderSearchStatus, setSearchUiActions, setupSearchUi } from './search-ui.js';
import { renderHistoryPanel, resumeLastBrowse, openRecentEntry, saveRecentEntries, scheduleBrowseStateSave } from './history.js';
import { captureMasonryAnchor, restoreMasonryAnchor, relayoutVisible, refreshCardPrompts, refreshCopyHints, updateVirtualCards, scheduleVirtualUpdate, scheduleRelayout, beginMasonryResize, endMasonryResize } from './masonry.js';
import { bindLightboxControls, refreshLightboxAccess, refreshLightboxNavigation } from './lightbox.js';
import { isTagZhEnabled, onTagZhChange, setTagZhEnabled } from './tag-zh.js';
import { scrubClipboardFallback } from './clipboard-fallback.js';
import { bindBackdropDismiss, bindOutsideDismiss, openMask, closeMask, registerMaskHistory, trapFocus, topInteractionLayer, isGlobalShortcutBlocked } from './modal.js';
import { setupAnnouncements, openAnnouncementsPanel, updateAnnouncementBadge } from './announcements.js';
import { loadUpdates, renderUpdatesDigest, handleUpdateRowClick } from './updates.js';
import { setupReport, openReportDialog, refreshReportAccess } from './report.js';
import { openOnboarding, setupOnboarding } from './onboarding.js';
import { closeRelayRail, isRelayRailModal, setRelayRailLayoutActions } from './tag-relay-rail.js';
import { refreshRelayAccess } from './tag-relay.js';
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
  toggleFavoritesFolders: () => false,
  openFavoritesView: async () => {},
  openSiteSearchView: async () => {},
  exitSiteSearchView: () => {},
  applyFilter: () => {},
  applySearch: async () => {},
  cancelSearchObservation: () => {},
  openRelatedDirectory: async () => {},
  refreshAccessView: () => {},
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
  const text = site ? '全站' : '本书';
  let label = btn.querySelector('.search-scope-label');
  const changed = Boolean(label && label.textContent !== text);
  if (!label) {
    label = document.createElement('span');
    label.className = 'search-scope-label';
    btn.replaceChildren(label);
  }
  label.textContent = text;
  if (changed) animateUi(label, [
    { opacity: 0, translate: '0 4px' },
    { opacity: 1, translate: '0 0' },
  ], { duration: 180 });
  btn.dataset.scope = state.searchScope;
  btn.title = site ? '当前搜索范围：全站。点击切到当前法典' : '当前搜索范围：当前法典。点击切到全站';
  btn.setAttribute('aria-label', site ? '搜索范围：全站' : '搜索范围：当前法典');
}

export function applyDensity(value, { render = true, announce = false, persist = true } = {}) {
  const next = normalizeDensity(value);
  if (persist && !writePreference(DENSITY_STORAGE_KEY, next)) return false;
  const changed = state.density !== next;
  const anchor = changed && render ? captureMasonryAnchor() : null;
  state.density = next;
  document.body.classList.remove(...Object.keys(DENSITY_PRESETS).map(k => `density-${k}`));
  document.body.classList.add(`density-${next}`);
  updateDensityControls();
  if (!changed || !render || !state.codex) return true;
  relayoutVisible({ animate: true });
  restoreMasonryAnchor(anchor);
  updateVirtualCards(true);
  updateScrollProgress();
  if (announce) toast(`卡片密度：${densityConfig().label}`);
  return true;
}

export function bindUI() {
  setRelayRailLayoutActions({ begin: beginMasonryResize, end: endMasonryResize });
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
    uiActions.cancelSearchObservation();
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
      const next = normalizeSearchScope(state.searchScope === 'site' ? 'codex' : 'site');
      if (!writePreference(SEARCH_SCOPE_STORAGE_KEY, next)) return;
      state.searchScope = next;
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
  const removeSearchFilter = async (filter, index) => {
    const values = [...state.searchFilterValues];
    const value = filter?.invalid ? String(filter.value ?? '') : serializeSearchFilter(filter);
    // 全站索引尚在加载时，前一次删除已改状态而 chips 可能还未重绘；按身份复核旧索引。
    const currentIndex = values[index] === value ? index : values.indexOf(value);
    if (currentIndex < 0) return;
    values.splice(currentIndex, 1);
    await applySearchConditions({ filterValues: values });
  };
  const removeQueryTerm = async value => {
    if (searchComposing) return;
    clearTimeout(st);
    const query = removeSearchQueryTerm(searchInput.value, value);
    await applySearchConditions({ query });
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
    removeQueryTerm,
    clearAll: clearAllSearch,
    useExample: async query => {
      if (searchComposing) return;
      clearTimeout(st);
      const combined = [searchInput.value.trim(), String(query || '').trim()].filter(Boolean).join(', ');
      searchInput.value = combined;
      await applySearchConditions({ query: combined }, { canonicalize: true });
    },
    openRelatedDirectory: async item => {
      closeSearchFilterPanel();
      await uiActions.openRelatedDirectory(item);
    },
    runStatusAction: async action => {
      if (action?.id === 'split-phrases') {
        if (searchComposing) return;
        clearTimeout(st);
        const plan = parseSearchQuery(searchInput.value, state.searchFilterValues);
        const query = splitSearchPhrases(plan);
        if (query) await applySearchConditions({ query, filterValues: plan.filterValues }, { canonicalize: true });
      } else if (action?.id === 'clear-filters') {
        await applySearchConditions({ filterValues: [] });
      } else if (action?.id === 'clear-all') {
        await clearAllSearch();
      } else if (action?.id === 'scope-site') {
        if (!writePreference(SEARCH_SCOPE_STORAGE_KEY, 'site')) return;
        state.searchScope = 'site';
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
      setUpdateFilter(btn.dataset.updateFilter, { toggle: true });
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

  const themeBtn = $('#themeBtn');
  const themeMenuBtn = $('#themeMenuBtn');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  /* 深浅色三档：auto 跟随系统，light / dark 是用户拍板。
     旧版只有 fadian-dark 布尔值——读到它就迁成对应的显式档，老用户手感一点不变；
     只有从没设置过的新访客才落到 auto。 */
  const readDarkMode = () => {
    const saved = readPreference(DARK_MODE_STORAGE_KEY);
    if (DARK_MODES.some(m => m.id === saved)) return saved;
    const legacy = readPreference(LEGACY_DARK_STORAGE_KEY);
    return legacy === '1' ? 'dark' : legacy === '0' ? 'light' : 'auto';
  };
  let darkMode = readDarkMode();
  const applyTheme = (mode, { persist = true } = {}) => {
    const next = DARK_MODES.some(m => m.id === mode) ? mode : 'auto';
    const d = next === 'auto' ? systemDark.matches : next === 'dark';
    if (persist && !writePreferences([
      { key: DARK_MODE_STORAGE_KEY, value: next },
      { key: LEGACY_DARK_STORAGE_KEY, value: d ? '1' : '0' },
    ])) return false;
    darkMode = next;
    document.body.classList.toggle('dark', d);
    document.documentElement.style.colorScheme = d ? 'dark' : 'light';   // 滚动条等原生控件跟随深浅色
    const icon = d ? THEME_ICONS.sun : THEME_ICONS.moon;
    const label = d ? '切换浅色模式' : '切换深色模式';
    themeBtn.innerHTML = icon;
    themeBtn.setAttribute('aria-label', label);
    if (themeMenuBtn) themeMenuBtn.innerHTML = `${icon}<span><b>${label}</b></span>`;
    for (const b of document.querySelectorAll('#darkModeControl [data-dark-mode]'))
      b.setAttribute('aria-pressed', b.dataset.darkMode === darkMode ? 'true' : 'false');
    return true;
  };
  /* 顶栏按钮只管「现在翻到反面」，按下就脱离 auto——用户点它要的是确定结果，不是继续跟系统走 */
  const toggleTheme = () => applyTheme(document.body.classList.contains('dark') ? 'light' : 'dark');
  themeBtn.onclick = toggleTheme;
  applyTheme(darkMode, { persist: false });
  // 其它页面只读旧布尔键；首次 auto 也同步派生结果，不改三档偏好。
  writePreference(LEGACY_DARK_STORAGE_KEY, document.body.classList.contains('dark') ? '1' : '0', { announce: false });
  systemDark.addEventListener('change', () => {
    if (darkMode === 'auto') {
      applyTheme('auto', { persist: false });
      // 系统变化不改 auto 偏好；404 / strings / review 的旧镜像尽力跟随。
      writePreference(LEGACY_DARK_STORAGE_KEY, systemDark.matches ? '1' : '0', { announce: false });
    }
  });
  for (const b of document.querySelectorAll('#darkModeControl [data-dark-mode]')) {
    b.onclick = () => {
      if (applyTheme(b.dataset.darkMode)) toast(`深浅色：${DARK_MODES.find(m => m.id === darkMode).name}`);
    };
  }

  /* 界面风格（换肤）：与深浅色正交，每套 light+dark 都在 CSS 里；默认紫=不加类 */
  const applySkin = (id, { persist = true } = {}) => {
    const t = THEMES.find(x => x.id === id) || THEMES[0];
    if (persist && !writePreference(THEME_STORAGE_KEY, t.id)) return null;
    for (const x of THEMES) if (x.id) document.body.classList.remove('theme-' + x.id);
    if (t.id) document.body.classList.add('theme-' + t.id);
    for (const b of document.querySelectorAll('#themeControl [data-theme]'))
      b.setAttribute('aria-pressed', b.dataset.theme === t.id ? 'true' : 'false');
    return t;
  };
  for (const b of document.querySelectorAll('#themeControl [data-theme]'))
    b.onclick = () => { const selected = applySkin(b.dataset.theme); if (selected) toast(`界面风格：${selected.name}`); };
  applySkin(readPreference(THEME_STORAGE_KEY, ''), { persist: false });

  /* 界面字体（换嗓子）：与配色、深浅色同样正交；默认=不加类。
     只换 UI / 展示 / 目录三支，prompt 框永远留着等宽体。 */
  const applyFont = (id, { persist = true } = {}) => {
    const f = FONTS.find(x => x.id === id) || FONTS[0];
    if (persist && !writePreference(FONT_STORAGE_KEY, f.id)) return null;
    for (const x of FONTS) if (x.id) document.body.classList.remove('font-' + x.id);
    if (f.id) document.body.classList.add('font-' + f.id);
    for (const b of document.querySelectorAll('#fontControl [data-font]'))
      b.setAttribute('aria-pressed', b.dataset.font === f.id ? 'true' : 'false');
    return f;
  };
  for (const b of document.querySelectorAll('#fontControl [data-font]'))
    b.onclick = () => { const selected = applyFont(b.dataset.font); if (selected) toast(`站内字体：${selected.name}`); };
  applyFont(readPreference(FONT_STORAGE_KEY, ''), { persist: false });

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
  const applySdMode = (on, animate = true, { persist = true } = {}) => {
    if (persist && !writePreference('fadian-sdmode', on ? '1' : '0')) {
      if (sdToggle) sdToggle.checked = state.sdMode;
      return false;
    }
    const changed = state.sdMode !== on;
    state.sdMode = on;
    if (sdToggle) sdToggle.checked = on;
    document.body.classList.toggle('sd-mode', on);
    showSdBadge(on, animate);
    if (changed) refreshCardPrompts();
    return true;
  };
  if (sdToggle) sdToggle.onchange = e => applySdMode(e.target.checked);
  if (sdBadge) sdBadge.onclick = () => applySdMode(false);
  applySdMode(readPreference('fadian-sdmode') === '1', false, { persist: false });  // 初始化不做动画

  /* 点击卡片放大：电脑端点卡片改开大图；手机本来就开大图，设置行在窄屏隐藏 */
  const cardZoomToggle = $('#cardZoomToggle');
  const applyCardZoom = (on, { persist = true } = {}) => {
    if (persist && !writePreference(CARD_ZOOM_STORAGE_KEY, on ? '1' : '0')) {
      if (cardZoomToggle) cardZoomToggle.checked = state.cardZoom;
      return false;
    }
    state.cardZoom = on;
    if (cardZoomToggle) cardZoomToggle.checked = on;
    refreshCopyHints();
    return true;
  };
  if (cardZoomToggle) cardZoomToggle.onchange = e => applyCardZoom(e.target.checked);
  applyCardZoom(readPreference(CARD_ZOOM_STORAGE_KEY) === '1', { persist: false });

  /* tag 中文对照：设置开关与灯箱「中文对照」按钮是同一个偏好，任一处改另一处跟着变 */
  const tagZhSetting = $('#tagZhSettingToggle');
  if (tagZhSetting) {
    tagZhSetting.checked = isTagZhEnabled();
    tagZhSetting.onchange = e => {
      if (!setTagZhEnabled(e.target.checked)) e.target.checked = isTagZhEnabled();
    };
    onTagZhChange(on => { tagZhSetting.checked = on; });
  }

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
  const savedSidebar = readPreference('fadian-sidebar');
  if (savedSidebar === 'closed' || (savedSidebar === null && window.innerWidth <= 600)) {
    sidebar.classList.add('closed');
  }
  const setSidebarOpenDirect = (open, { persist = true } = {}) => {
    if (persist && !writePreference('fadian-sidebar', open ? 'open' : 'closed')) return false;
    sidebar.classList.toggle('closed', !open);
    return true;
  };
  registerHistoryLayer('mobile-sidebar', {
    isOpen: () => mobileQuery.matches && !sidebar.classList.contains('closed'),
    open: () => setSidebarOpenDirect(true, { persist: false }),
    close: () => setSidebarOpenDirect(false, { persist: false }),
  });
  sidebarBackdrop?.addEventListener('click', () => {
    if (!writePreference('fadian-sidebar', 'closed')) return;
    if (closeHistoryLayer('mobile-sidebar')) return;
    setSidebarOpenDirect(false, { persist: false });
    forgetHistoryLayer('mobile-sidebar');
  });
  $('#menuBtn').onclick = () => {
    // 收藏视图窄屏时这颗按钮唤起收藏夹抽屉；宽屏仍是折叠/展开左栏。
    if (uiActions.toggleFavoritesFolders($('#menuBtn'))) return;
    const opening = sidebar.classList.contains('closed');
    if (!writePreference('fadian-sidebar', opening ? 'open' : 'closed')) return;
    if (mobileQuery.matches && !opening && closeHistoryLayer('mobile-sidebar')) return;
    const replaceLayer = mobileQuery.matches && opening && topHistoryLayerId() === 'banner-about';
    if (replaceLayer) closeBannerAbout();
    setSidebarOpenDirect(opening, { persist: false });
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
  if (themeMenuBtn) {
    themeMenuBtn.onclick = () => {
      toggleTheme();
      closeMore({ focusButton: true });
      moreBtn.focus({ preventScroll: true });
    };
  }
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
    bindOutsideDismiss([moreMenu, moreBtn], () => {
      if (!moreMenu.hidden) closeMore();
    });
  }
  setupReport();
  setupAnnouncements({
    closeMore: () => closeMore({ historyMode: 'none' }),
    historyMode: () => mobileQuery.matches ? 'replace' : 'push',
  });

  /* 顶栏动态气泡：只回答「有没有更新、多少条」，重内容一律交给下面的三页签面板。
     故意不进 openMask/history 层——它是轻量 popover，移动端点一下就该直接进面板。 */
  const announceBtn = $('#announcementsBtn');
  const updatesPopover = $('#updatesPopover');
  if (announceBtn && updatesPopover) {
    let popoverRequest = 0;
    let popoverPending = false;
    updatesPopover.inert = updatesPopover.hidden;
    const closePopover = ({ focusButton = false } = {}) => {
      popoverRequest += 1;
      popoverPending = false;
      announceBtn.removeAttribute('aria-busy');
      updatesPopover.inert = true;
      updatesPopover.hidden = true;
      announceBtn.classList.remove('open');
      announceBtn.setAttribute('aria-expanded', 'false');
      if (focusButton) announceBtn.focus({ preventScroll: true });
    };
    const openPanelAt = tab => {
      closePopover();
      openAnnouncementsPanel(announceBtn, {
        historyMode: mobileQuery.matches ? 'replace' : 'push',
        tab,
      });
    };
    announceBtn.onclick = async ev => {
      ev.stopPropagation();
      closeMore({ historyMode: 'none' });
      if (!updatesPopover.hidden || popoverPending) {
        closePopover({ focusButton: true });
        return;
      }
      const request = ++popoverRequest;
      popoverPending = true;
      announceBtn.setAttribute('aria-busy', 'true');
      await loadUpdates();
      if (request !== popoverRequest) return;
      popoverPending = false;
      announceBtn.removeAttribute('aria-busy');
      /* 加载期间的取消/再次点击优先；按此时的断点决定入口。 */
      if (mobileQuery.matches) {
        openPanelAt('');
        return;
      }
      renderUpdatesDigest(updatesPopover);
      updateAnnouncementBadge();
      updatesPopover.inert = false;
      updatesPopover.hidden = false;
      announceBtn.classList.add('open');
      announceBtn.setAttribute('aria-expanded', 'true');
    };
    updatesPopover.onclick = ev => {
      const open = ev.target.closest?.('[data-updates-open]');
      if (open && updatesPopover.contains(open)) {
        openPanelAt(String(open.dataset.updatesOpen || ''));
        return;
      }
      if (handleUpdateRowClick(ev, { consumeLayer: false })) closePopover();
    };
    document.addEventListener('keydown', ev => {
      if (ev.key !== 'Escape' || (updatesPopover.hidden && !popoverPending)) return;
      ev.preventDefault();
      closePopover({ focusButton: true });
    });
    mobileQuery.addEventListener('change', () => closePopover());
    bindOutsideDismiss([updatesPopover, announceBtn], () => {
      if (!updatesPopover.hidden || popoverPending) {
        closePopover();
      }
    });
  }
  setupOnboarding();
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

  /* 动态面板「反馈」页签里的两个入口：原先是公告列表上方的一条横幅，
     2026-09 提成独立页签。沿用灯箱→反馈的既有做法（叠层打开、不手动关动态面板），
     保持历史栈一致。 */
  const feedbackEntries = [
    ['#announcementsFeedbackLink', 'progress'],
    ['#announcementsFeedbackSubmit', 'submit'],
  ];
  for (const [selector, tab] of feedbackEntries) {
    const node = $(selector);
    if (!node) continue;
    node.onclick = () => {
      openReportDialog({
        source: 'announcement',
        tab,
        trigger: node,
        historyMode: mobileQuery.matches ? 'replace' : 'push',
      });
    };
  }

  /* 设置 / 关于 悬浮框：开关三件套（按钮/遮罩/Esc），带淡入淡出 */
  const settingsMask = $('#settings');
  const nsfwMask = $('#nsfwConfirm');
  const shortcutMask = $('#shortcutHelp');
  const historyMask = $('#historyPanel');
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
  // 本页设置和跨标签页 storage 都走同一轮撤权，先清已打开的内容，再刷新列表和选择器。
  const refreshContentAccess = ({ revoked = false } = {}) => {
    refreshLightboxAccess(undefined, { scrub: revoked });
    refreshReportAccess();
    refreshRelayAccess();
    uiActions.refreshAccessView({ revoked });
    refreshLightboxNavigation();
    updateCodexPickerState({ refreshContent: true });
    if (revoked) scrubRestrictedSurfaces();
  };
  const setNsfwAccess = (on, { announce = false, persist = true } = {}) => {
    const next = Boolean(on);
    const writes = next ? [
      { key: ADULT_CONFIRMATION_STORAGE_KEY, value: '1' },
      { key: NSFW_STORAGE_KEY, value: '1' },
    ] : [
      { key: NSFW_STORAGE_KEY, value: '0' },
      { key: R18G_STORAGE_KEY, value: '0' },
    ];
    if (persist && !writePreferences(writes)) {
      if (nsfwToggle) nsfwToggle.checked = state.allowNsfw;
      return false;
    }
    state.allowNsfw = next;
    document.body.classList.toggle('nsfw-unlocked', state.allowNsfw);
    if (nsfwToggle) nsfwToggle.checked = state.allowNsfw;
    if (!state.allowNsfw) setR18gAccess(false, { persist: false, refresh: false });  // 两档同次保存，关闭后只清场一次
    if (!state.allowNsfw && (state.activePath || []).some(isNsfwPathSegment)) state.activePath = [];
    updateR18gToggleState();
    refreshContentAccess({ revoked: !state.allowNsfw });
    if (announce) toast(state.allowNsfw ? 'NSFW 法典已解锁' : 'NSFW 法典已锁定');
    return true;
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
    if (setNsfwAccess(true, { announce: true })) closeMask(nsfwMask);
  };
  $('#nsfwCancel').onclick = cancelNsfwConfirm;
  $('#nsfwCancelX').onclick = cancelNsfwConfirm;
  bindBackdropDismiss(nsfwMask, cancelNsfwConfirm);
  nsfwMask.onkeydown = ev => trapFocus(ev, nsfwMask);

  /* R18G / 重口：默认完全隐藏；需先开 NSFW，再走多重恐吓式确认才能开启 */
  const r18gToggle = $('#r18gToggle');
  const r18gMask = $('#r18gConfirm');
  const R18G_STEPS = [
    {
      title: '⚠ 重口 / R18G 内容警告',
      text: '即将开启「R18G / 重口」内容。它与普通 R18 不同，包含血腥、暴力、猎奇等极端画面，多数人会感到强烈不适。',
      next: '我已年满 18 岁，继续',
    },
    {
      title: '⚠⚠ 第二次确认：可能引起强烈不适',
      text: '内容包括杀害、肢解、人棍、刑罚、内脏、排泄物等极端猎奇画面，可能引起恶心或长期的心理不适。能接受 R18 不代表能接受这些。',
      next: '我已了解，继续',
    },
    {
      title: '⚠⚠⚠ 最后确认',
      text: '这类内容不以娱乐为目的。开启即表示你自愿观看并自行承担后果，与本站及法典作者无关。',
      next: '确认开启',
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
    if (backBtn) backBtn.textContent = r18gStep === 0 ? '退出' : '上一步';
  };
  const openR18gConfirm = () => { r18gStep = 0; renderR18gStep(); openMask(r18gMask, r18gToggle); };
  const cancelR18gConfirm = () => { if (r18gToggle) r18gToggle.checked = false; closeMask(r18gMask); };
  const setR18gAccess = (on, { announce = false, persist = true, refresh = true } = {}) => {
    const wasAllowed = state.allowR18g;
    const next = Boolean(on) && state.allowNsfw;
    if (persist && !writePreference(R18G_STORAGE_KEY, next ? '1' : '0')) {
      if (r18gToggle) r18gToggle.checked = state.allowR18g;
      return false;
    }
    state.allowR18g = next;
    document.body.classList.toggle('r18g-unlocked', state.allowR18g);
    if (r18gToggle) r18gToggle.checked = state.allowR18g;
    if (!state.allowR18g && (state.activePath || []).some(isR18gName)) state.activePath = [];  // 关闭时若停在 r18g 分类则退回全部
    // 本来就关着（如别的标签页开 NSFW 时补读 R18G）不算撤权，不清场。
    if (refresh) refreshContentAccess({ revoked: wasAllowed && !state.allowR18g });
    if (announce) toast(state.allowR18g ? '已开启 R18G / 重口' : 'R18G / 重口内容已隐藏');
    return true;
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
      if (!state.allowNsfw) { e.target.checked = false; toast('先开启「显示 NSFW 内容」', '!'); return; }
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
      else if (setR18gAccess(true, { announce: true })) closeMask(r18gMask);
    };
    $('#r18gBack').onclick = () => {
      if (r18gStep > 0) { r18gStep--; renderR18gStep(); }
      else cancelR18gConfirm();
    };
    $('#r18gCancelX').onclick = cancelR18gConfirm;
    bindBackdropDismiss(r18gMask, cancelR18gConfirm);
    r18gMask.onkeydown = ev => trapFocus(ev, r18gMask);
  }
  updateR18gToggleState();
  /* 两个开关是同源持久化偏好，不应在多标签页里各自保留一套权限状态。
     storage 事件不回发当前页，所以本地确认流程仍只走上面的 setter。 */
  window.addEventListener('storage', event => {
    let storage;
    try { storage = globalThis.localStorage; } catch { /* 撤权仍按事件执行。 */ }
    if (event.storageArea && storage && event.storageArea !== storage) return;
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
      if (on) setR18gAccess(readPreference(R18G_STORAGE_KEY) === '1', { persist: false });
      return;
    }
    if (event.key === R18G_STORAGE_KEY) {
      if (event.newValue === '1' && !state.allowNsfw && readPreference(NSFW_STORAGE_KEY) === '1') {
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
  bindBackdropDismiss(shortcutMask, () => closeMask(shortcutMask));
  shortcutMask.onkeydown = ev => trapFocus(ev, shortcutMask);
  $('#historyBtn').onclick = () => { renderHistoryPanel(); openFromMore(historyMask); };
  $('#historyClose').onclick = () => closeMask(historyMask);
  bindBackdropDismiss(historyMask, () => closeMask(historyMask));
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
    await openRecentEntry(ev.detail, { historyMode: 'push', consumeLayer: true, landOnCard: true });
  });
  const settingsBtn = $('#settingsBtn');
  if (settingsBtn) settingsBtn.onclick = () => openFromMore(settingsMask, settingsBtn);
  const settingsMenuBtn = $('#settingsMenuBtn');
  if (settingsMenuBtn) settingsMenuBtn.onclick = () => openFromMore(settingsMask);
  $('#settingsClose').onclick = () => closeMask(settingsMask);
  bindBackdropDismiss(settingsMask, () => closeMask(settingsMask));
  settingsMask.onkeydown = ev => trapFocus(ev, settingsMask);
  $('#aboutBtn').onclick = () => openFromMore(aboutMask);
  $('#aboutClose').onclick = () => closeMask(aboutMask);
  bindBackdropDismiss(aboutMask, () => closeMask(aboutMask));
  aboutMask.onkeydown = ev => trapFocus(ev, aboutMask);
  $('#archiveClose').onclick = () => closeMask(archiveMask);
  bindBackdropDismiss(archiveMask, () => closeMask(archiveMask));
  archiveMask.onkeydown = ev => trapFocus(ev, archiveMask);
  document.addEventListener('openCodexArchive', ev => {
    renderCodexArchive();
    const opener = document.querySelector('.banner-about-btn') || ev.detail?.trigger || document.activeElement;
    const replaceLayer = topHistoryLayerId() === 'banner-about';
    closeBannerAbout();
    openMask(archiveMask, opener, { historyMode: replaceLayer ? 'replace' : 'push' });
  });
  bindOutsideDismiss(() => [
    document.querySelector('.banner-about-btn.open'),
    document.querySelector('.banner-pop:not([hidden])'),
  ], () => {
    closeBannerAbout({ historyMode: 'back' });
  });
  // 这里只登记本模块拥有的关闭动作；模态识别与顶层顺序统一由 modal 管理。
  const dismissMasks = new Map([
    [nsfwMask, cancelNsfwConfirm], [r18gMask, cancelR18gConfirm],
    ...[settingsMask, shortcutMask, historyMask, aboutMask, archiveMask, announcementsMask, feedbackMask, onboardingMask]
      .filter(Boolean).map(mask => [mask, () => closeMask(mask)]),
  ]);
  window.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape' || ev.defaultPrevented) return;
    const top = topInteractionLayer(ev);
    if (top) {
      const dismiss = dismissMasks.get(top);
      if (dismiss) { ev.preventDefault(); dismiss(); }
      else if (top === $('#tagRelayRail') && isRelayRailModal()) { ev.preventDefault(); closeRelayRail(); }
      return;
    }
    if (document.body.classList.contains('search-mode')) {
      ev.preventDefault();
      setSearchMode(false, { restoreButton: true });
      return;
    }
    if (!moreMenu.hidden) { closeMore({ focusButton: true }); return; }
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
  window.addEventListener('keydown', ev => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || typingTarget() || isGlobalShortcutBlocked(ev)) return;
    if (ev.key === '?') {
      ev.preventDefault();
      openMask(shortcutMask);
      return;
    }
    if (ev.key.toLowerCase() === 'g') {
      ev.preventDefault();
      scrollToTop();
      return;
    }
    if (ev.key === '/') {
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
