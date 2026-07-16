import { state, DENSITY_PRESETS, DENSITY_STORAGE_KEY, THEME_STORAGE_KEY, THEMES, NSFW_STORAGE_KEY, R18G_STORAGE_KEY, SEARCH_SCOPE_STORAGE_KEY } from './state.js';
import { normalizeDensity, densityConfig, normalizeSearchScope } from './state.js';
import { $, updateSearchClear, updateScrollProgress, prefersReducedMotion } from './utils.js';
import { toast } from './feedback.js';
import { firstUnlockedCodex, isNsfwCodex, isNsfwPathSegment, isR18gName } from './access.js';
import { closeBannerAbout, renderCodexArchive, renderTree, renderCodexHeader, randomExplore, updateCodexPickerState } from './codex-ui.js';
import { beginAtlasLayeredSearch, syncUrlState } from './router.js';
import { renderHistoryPanel, resumeLastBrowse, openRecentEntry, saveRecentEntries, scheduleBrowseStateSave } from './history.js';
import { captureMasonryAnchor, restoreMasonryAnchor, relayoutVisible, updateVirtualCards, scheduleVirtualUpdate, scheduleRelayout } from './masonry.js';
import { bindLightboxControls } from './lightbox.js';
import { openMask, closeMask, trapFocus } from './modal.js';
import { setupAnnouncements } from './announcements.js';
import { setupReport, openReportDialog } from './report.js';
import { setupOnboarding } from './onboarding.js';
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
};

export function setUiActions(actions = {}) {
  Object.assign(uiActions, actions);
}

export function updateDensityControls() {
  for (const btn of document.querySelectorAll('[data-density]')) {
    const active = btn.dataset.density === state.density;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
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
  let st;
  const searchInput = $('#search');
  const searchClear = $('#searchClear');
  const searchExit = $('#searchExit');
  const searchScopeBtn = $('#searchScopeBtn');
  const mobileSearchBtn = $('#mobileSearchBtn');
  const mobileQuery = window.matchMedia('(max-width:600px)');
  const applySearchMode = (on, { focus = false, restoreButton = false } = {}) => {
    const shouldOpen = on && mobileQuery.matches;
    document.body.classList.toggle('search-mode', shouldOpen);
    if (shouldOpen) {
      setTopbarHidden(false);
      if (focus) requestAnimationFrame(() => searchInput.focus());
    } else {
      searchInput.blur();
      if (restoreButton) mobileSearchBtn?.focus();
    }
  };
  registerHistoryLayer('mobile-search', {
    isOpen: () => document.body.classList.contains('search-mode'),
    open: () => applySearchMode(true),
    close: () => applySearchMode(false),
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
  const applySearchInput = async value => {
    const parentScrollY = Math.max(0, window.scrollY || 0);
    const previous = state.query.trim();
    state.query = String(value || '');
    const next = state.query.trim();
    if (!next && previous && !mobileQuery.matches && goBackFrom('search')) return;
    const firstQuery = Boolean(next && !previous);
    if (firstQuery) state.searchHistorySessionId = nextSearchSessionId();
    const layered = firstQuery && mobileQuery.matches && topHistoryLayerId() === 'mobile-search';
    const historyMode = firstQuery ? (layered ? 'none' : 'push') : 'replace';
    await uiActions.applySearch({
      resetScroll: true,
      transition: next ? 'search' : 'route',
      historyMode,
      sessionId: state.searchHistorySessionId || getManagedHistoryEntry()?.sessionId || undefined,
      parentScrollY,
    });
    if (layered) beginAtlasLayeredSearch(state.searchHistorySessionId);
    if (!next && !getManagedHistoryEntry()?.sessionId) state.searchHistorySessionId = '';
  };
  updateSearchScopeControl();
  if (searchScopeBtn) {
    searchScopeBtn.onclick = () => {
      state.searchScope = normalizeSearchScope(state.searchScope === 'site' ? 'codex' : 'site');
      localStorage.setItem(SEARCH_SCOPE_STORAGE_KEY, state.searchScope);
      updateSearchScopeControl();
      if (state.query.trim()) {
        void uiActions.applySearch({
          resetScroll: true,
          transition: 'search',
          historyMode: 'replace',
          sessionId: state.searchHistorySessionId || getManagedHistoryEntry()?.sessionId || undefined,
        });
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
      if (!ev.matches) {
        applySearchMode(false);
        forgetHistoryLayer('mobile-search');
        forgetHistoryLayer('mobile-sidebar');
      }
    });
  }
  searchInput.oninput = e => {
    updateSearchClear();
    clearTimeout(st);
    st = setTimeout(() => {
      const value = e.target.value;
      if (value.trim()) {
        if (!state.siteSearchView) document.querySelectorAll('.tree-row.active').forEach(r => r.classList.remove('active'));   // 全站搜索保留目录收窄的高亮
      } else if (!state.siteSearchView) {
        renderTree();
      }
      void applySearchInput(value);
    }, 180);
  };
  if (searchClear) {
    searchClear.onclick = () => {
      if (!searchInput.value) return;
      clearTimeout(st);
      searchInput.value = '';
      updateSearchClear();
      void applySearchInput('');
      searchInput.focus();
    };
  }

  $('#onlyImaged').onchange = e => {
    state.onlyImaged = e.target.checked;
    uiActions.applyFilter({ resetScroll: true, transition: 'filter' });
    syncUrlState({ historyMode: 'replace' });
  };
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
  updateDensityControls();

  const sidebar = $('#sidebar');
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
  const moreItems = () => [...moreMenu.querySelectorAll('.more-item')];
  const closeMoreDirect = ({ focusButton = false } = {}) => {
    if (!moreMenu || moreMenu.hidden) return;
    moreMenu.hidden = true;
    moreBtn.classList.remove('open');
    moreBtn.setAttribute('aria-expanded', 'false');
    if (focusButton) moreBtn.focus();
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
  const setNsfwAccess = (on, { announce = false } = {}) => {
    state.allowNsfw = Boolean(on);
    document.body.classList.toggle('nsfw-unlocked', state.allowNsfw);
    localStorage.setItem(NSFW_STORAGE_KEY, state.allowNsfw ? '1' : '0');
    if (nsfwToggle) nsfwToggle.checked = state.allowNsfw;
    if (!state.allowNsfw) setR18gAccess(false);  // R18G 依赖 NSFW，关掉 NSFW 一并强制关闭 R18G
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
  const setR18gAccess = (on, { announce = false } = {}) => {
    state.allowR18g = Boolean(on) && state.allowNsfw;
    document.body.classList.toggle('r18g-unlocked', state.allowR18g);
    localStorage.setItem(R18G_STORAGE_KEY, state.allowR18g ? '1' : '0');
    if (r18gToggle) r18gToggle.checked = state.allowR18g;
    if (!state.allowR18g && (state.activePath || []).some(isR18gName)) state.activePath = [];  // 关闭时若停在 r18g 分类则退回全部
    if (state.codex) {
      renderTree();
      renderCodexHeader();
      uiActions.applyFilter({ resetScroll: true });
    }
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
  const openFromMore = (mask, trigger = moreBtn) => {
    const topLayer = topHistoryLayerId();
    const replaceLayer = topLayer === 'more-menu' || topLayer === 'banner-about';
    closeMore({ historyMode: 'none' });
    if (topLayer === 'banner-about') closeBannerAbout();
    openMask(mask, trigger, { historyMode: replaceLayer ? 'replace' : 'push' });
  };
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
    (onboardingMask && !onboardingMask.hidden);
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

  window.addEventListener('resize', () => {
    scheduleRelayout(true);
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
