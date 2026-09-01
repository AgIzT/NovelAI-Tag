import { state } from './state.js';
import { $ } from './utils.js';
import { encodePathCode } from './path-code.js';
import { hasEntryImage } from './media.js';
import { toast } from './feedback.js';
import { isEntryAccessBlocked, isR18gBlocked, showNsfwLockedHint, showR18gLockedHint } from './access.js';
import {
  beginLayeredSearch,
  commitHistoryRoute,
  configureBrowserHistory,
  initializeBrowserHistory,
  isRestoringHistory,
} from './browser-history.js';

const routerActions = {
  onUrlSync: () => {},
  renderTree: () => {},
  applyFilter: () => {},
  openLightbox: () => {},
  updateVirtualCards: () => {},
  applyHistoryRoute: async () => {},
  restoreHistoryScroll: async () => {},
};

export function setRouterActions(actions = {}) {
  Object.assign(routerActions, actions);
}

/* /share/<法典>/<词条> 是词条深链的规范地址：这条路由由 Pages Function 渲染 OG 卡，
   再把 App 外壳原样交付（注入 <base href="/">），所以地址栏停在它上面、复制即可分享。
   词条 id 里可能带 '/'，与后端 functions/_share.js 的 parseSharePath 保持同一种兜法。 */
export function readSharePathname(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (parts[0] !== 'share' || parts.length < 2) return { codex: '', entry: '' };
  const decode = value => {
    try {
      return decodeURIComponent(value).trim();
    } catch {
      return String(value || '').trim();
    }
  };
  const rest = parts.slice(1).map(decode);
  return { codex: rest[0] || '', entry: rest.slice(1).join('/') };
}

export function readUrlState() {
  const params = new URLSearchParams(location.search);
  const hash = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
  const share = readSharePathname(location.pathname);
  const pathValues = params.getAll('path');
  const path = pathValues.length > 1
    ? pathValues.map(seg => seg.trim()).filter(Boolean)
    : decodeLegacyPathParam(pathValues[0] || '');
  const codex = share.codex || params.get('c') || params.get('codex') || '';
  return {
    codex,
    favorites: params.get('fav') === '1' || params.get('view') === 'favorites' || codex === 'favorites',
    scope: params.get('scope') || '',
    path,
    // 目录短码；旧的 path= 参数仍然照读，读到就优先用它，短码只是没有 path 时的来源。
    pathCode: params.get('p') || '',
    q: params.get('q') || '',
    entry: share.entry || params.get('entry') || hash.get('entry') || '',
    updateFilter: params.get('update') || (params.get('new') === '1' ? 'latest' : ''),
  };
}

export function captureAtlasRoute(entryOverride) {
  const routeCodex = (state.favoritesView || state.siteSearchView) ? (state.browseCodex?.id || state.codex?.id || '') : (state.codex?.id || '');
  return {
    codex: routeCodex,
    favorites: Boolean(state.favoritesView),
    siteSearch: Boolean(state.siteSearchView),
    scope: state.searchScope,
    path: [...(state.activePath || [])],
    searchReturnPath: [...(state.searchReturnPath || [])],
    q: state.query.trim(),
    entry: entryOverride === undefined ? (state.lightbox.entry?.id || '') : String(entryOverride || ''),
    imageIndex: Math.max(0, Number(state.lightbox.index) || 0),
    updateFilter: String(state.updateFilter || ''),
  };
}

/* App 可能被 Function 挂在 /share/... 下交付，那时 location.pathname 不是站点根。
   注入的 <base href="/"> 让 document.baseURI 始终指向根，用它算基准最稳。 */
function appBasePath() {
  try {
    return new URL(document.baseURI).pathname.replace(/[^/]*$/, '') || '/';
  } catch {
    return '/';
  }
}

export function atlasUrlForRoute(route) {
  const base = appBasePath();
  const virtualView = Boolean(route.favorites || route.siteSearch);
  /* 开着灯箱就把地址栏换成 /share/<法典>/<词条>——那条路由带 OG 卡，用户直接复制地址栏
     也能在群里出预览图。收藏 / 全站搜索是私人视图，换过去会把上下文丢给收链接的人，
     所以维持查询串形态（本来就是短 ASCII）。 */
  if (route.entry && route.codex && !virtualView) {
    return `${base}share/${encodeURIComponent(route.codex)}/${encodeURIComponent(route.entry)}`;
  }

  const params = new URLSearchParams();
  if (route.codex) params.set('c', route.codex);
  if (route.favorites) params.set('fav', '1');
  if (route.updateFilter) params.set('update', route.updateFilter);
  const q = String(route.q || '').trim();
  if (q) {
    params.set('q', q);
    params.set('scope', route.siteSearch || route.scope === 'site' ? 'site' : 'codex');
  }
  const path = q && !route.siteSearch ? [] : (route.path || []);
  // 中文目录名逐字 percent-encode 是 9 个字符一个汉字，改发短码，反解在 path-code.js。
  const code = encodePathCode(path);
  if (code) params.set('p', code);
  if (route.entry) params.set('entry', route.entry);
  const query = params.toString();
  return `${base}${query ? `?${query}` : ''}`;
}

export function configureAtlasHistory() {
  configureBrowserHistory({
    page: 'atlas',
    captureRoute: captureAtlasRoute,
    urlForRoute: atlasUrlForRoute,
    applyRoute: (route, context) => routerActions.applyHistoryRoute(route, context),
    restoreScroll: (top, context) => routerActions.restoreHistoryScroll(top, context),
    isEmptySearchRoute: route => !String(route?.q || '').trim(),
  });
}

export function initializeAtlasHistory(route) {
  return initializeBrowserHistory({ route });
}

export function syncUrlState(options = {}) {
  const {
    entry,
    saveBrowse = true,
    transition,
    sessionId,
    consumeLayer = false,
    parentScrollY,
  } = options;
  const historyMode = options.historyMode || 'replace';
  if (state.suppressUrlSync || !state.codex) return;
  const entryId = entry === undefined ? (state.lightbox.entry?.id || '') : entry;
  commitHistoryRoute({
    mode: historyMode,
    transition,
    sessionId,
    consumeLayer,
    parentScrollY,
    route: captureAtlasRoute(entryId),
  });
  if (saveBrowse) routerActions.onUrlSync(entryId);
}

export function beginAtlasLayeredSearch(sessionId) {
  return beginLayeredSearch('mobile-search', sessionId, captureAtlasRoute());
}

function decodeLegacyPathParam(value) {
  return String(value || '')
    .split('/')
    .map(seg => {
      try {
        return decodeURIComponent(seg).trim();
      } catch {
        return String(seg || '').trim();
      }
    })
    .filter(Boolean);
}

export function openEntryDeepLink(entryId, { imageIndex = 0 } = {}) {
  if (!state.codex || !entryId) return false;
  const candidates = [entryId];
  for (const alias of state.codex.aliases || []) {
    if (entryId.startsWith(`${alias}-`)) {
      candidates.push(`${state.codex.id}${entryId.slice(alias.length)}`);
    }
  }
  const entry = state.codex.entries.find(e => candidates.includes(e.id));
  if (!entry) {
    syncUrlState({ historyMode: 'replace', entry: '' });
    return false;
  }
  if (isR18gBlocked(entry)) {
    showR18gLockedHint();
    syncUrlState({ entry: '' });
    return false;
  }
  if (isEntryAccessBlocked(entry)) {
    showNsfwLockedHint();
    syncUrlState({ entry: '' });
    return false;
  }
  if (!state.query && !state.activePath.length && entry.path?.length) {
    state.activePath = entry.path;
    routerActions.renderTree();
    routerActions.applyFilter({ resetScroll: true });
  }
  const index = state.list.findIndex(e => e.id === entry.id);
  const placement = index >= 0 ? state.placements[index] : null;
  if (placement) {
    const top = Math.max(0, placement.top + $('#masonry').getBoundingClientRect().top + window.scrollY - 120);
    window.scrollTo({ top, left: 0, behavior: 'auto' });
    routerActions.updateVirtualCards(true);
  }
  if (hasEntryImage(entry)) {
    const node = index >= 0 ? state.nodes.get(index) : null;
    const img = node?.querySelector('.card-img');
    routerActions.openLightbox(entry, imageIndex, img || null, {
      historyMode: 'none',
      recordRecent: !isRestoringHistory(),
    });
    return true;
  } else {
    toast('这个词条还没有例图');
    syncUrlState({ entry: '' });
    return false;
  }
}
