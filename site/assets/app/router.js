import { state } from './state.js';
import { $ } from './utils.js';
import { encodePathCode } from './path-code.js';
import { serializeSearchFilters } from './search.js';
import { hasEntryImage } from './media.js';
import { resolveAtlasEntryId } from './favorites-backup-core.js';
import { toast } from './feedback.js';
import { isEntryAccessBlocked, isR18gBlocked, showNsfwLockedHint, showR18gLockedHint } from './access.js';
import {
  beginLayeredSearch,
  commitHistoryRoute,
  configureBrowserHistory,
  getManagedHistoryEntry,
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

const DEFAULT_DOCUMENT_TITLE = '法典图鉴 · NovelAI 提示词';
const SITE_NAME = '法典图鉴';

export function setRouterActions(actions = {}) {
  Object.assign(routerActions, actions);
}

/* 根部署的 /share/<法典>/<词条> 是词条深链的规范地址：这条路由由 Pages Function 渲染 OG 卡，
   再把 App 外壳原样交付（注入 <base href="/">），所以地址栏停在它上面、复制即可分享。
   静态子路径部署没有这条 Function，写 URL 时会退回查询参数；读取端继续只认根级 /share。
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
    // f 允许重复；空值和非法值也必须原样交给搜索解析器，才能显示错误而不是退化成宽泛搜索。
    searchFilters: params.getAll('f'),
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
    searchFilters: captureSearchFilterValues(),
    entry: entryOverride === undefined ? (state.lightbox.entry?.id || '') : String(entryOverride || ''),
    imageIndex: Math.max(0, Number(state.lightbox.index) || 0),
    updateFilter: String(state.updateFilter || ''),
  };
}

function captureSearchFilterValues() {
  if (Array.isArray(state.searchFilterValues)) return state.searchFilterValues.map(value => String(value ?? ''));
  if (Array.isArray(state.searchPlan?.filterValues)) return state.searchPlan.filterValues.map(value => String(value ?? ''));
  return serializeSearchFilters(state.searchPlan?.filters || []);
}

export function hasActiveSearchRoute(route) {
  return Boolean(
    String(route?.q || '').trim()
    || (Array.isArray(route?.searchFilters) && route.searchFilters.length),
  );
}

/* 全站搜索首次构建要异步加载多本法典：首个 push 请求可能被后续输入取消，而后续
   输入按常规只请求 replace。这里根据历史事实补回“第一次进入搜索必须 push”的不变量；
   移动搜索已有自己的 layered 结构，有浮层时绝不能在这里额外加一层。 */
export function resolveAtlasHistoryMode(requestedMode, route, {
  transition,
  sessionId,
  currentEntry = getManagedHistoryEntry(),
} = {}) {
  const mode = requestedMode || 'replace';
  const layers = Array.isArray(currentEntry?.layers) ? currentEntry.layers : [];
  const startsUnrecordedSearch = mode === 'replace'
    && transition === 'search'
    && Boolean(String(sessionId || ''))
    && Boolean(currentEntry?.id)
    && currentEntry.sessionId !== sessionId
    && layers.length === 0
    && !hasActiveSearchRoute(currentEntry.route)
    && hasActiveSearchRoute(route);
  return startsUnrecordedSearch ? 'push' : mode;
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

export function documentTitleForRoute(route, codex = state.codex) {
  const localTitle = typeof document !== 'undefined' && document.body?.classList.contains('local-edition')
    ? String(document.body.dataset?.localTitle || '').trim()
    : '';
  if (localTitle) return localTitle;
  const entryId = String(route?.entry || '');
  if (entryId && codex) {
    const activeEntry = state.lightbox?.entry?.id === entryId ? state.lightbox.entry : null;
    const entry = activeEntry || codex.entries?.find(candidate => candidate.id === entryId);
    const entryTitle = String(entry?.title || '').trim();
    // 收藏/全站搜索使用合成法典；词条上的来源标题才是用户真正打开的那本书。
    // 没有来源标记时再退回当前视图标题，兼容旧数据和普通法典。
    const codexTitle = String(entry?._srcCodexTitle || codex.title || '').trim();
    if (entryTitle && codexTitle) return `${entryTitle} · ${codexTitle} | ${SITE_NAME}`;
  }
  return DEFAULT_DOCUMENT_TITLE;
}

function syncDocumentTitle(route) {
  if (typeof document !== 'undefined') document.title = documentTitleForRoute(route);
}

export function atlasUrlForRoute(route) {
  const base = appBasePath();
  const virtualView = Boolean(route.favorites || route.siteSearch);
  /* 根部署开着灯箱就把地址栏换成 /share/<法典>/<词条>——那条路由带 OG 卡，用户直接复制
     也能出预览图。非根静态部署没有 Function，只能用下方查询串保证刷新可达。收藏 / 全站搜索
     是私人视图，换过去会把上下文丢给收链接的人，所以同样维持查询串形态。 */
  if (route.entry && route.codex && !virtualView && base === '/') {
    return `${base}share/${encodeURIComponent(route.codex)}/${encodeURIComponent(route.entry)}`;
  }

  const params = new URLSearchParams();
  if (route.codex) params.set('c', route.codex);
  if (route.favorites) params.set('fav', '1');
  if (route.updateFilter) params.set('update', route.updateFilter);
  const q = String(route.q || '').trim();
  const searchFilters = Array.isArray(route.searchFilters)
    ? route.searchFilters.map(value => String(value ?? ''))
    : [];
  if (q) params.set('q', q);
  for (const filter of searchFilters) params.append('f', filter);
  if (hasActiveSearchRoute({ q, searchFilters })) {
    params.set('scope', route.siteSearch || route.scope === 'site' ? 'site' : 'codex');
  }
  const path = route.path || [];
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
    isEmptySearchRoute: route => !hasActiveSearchRoute(route),
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
  const requestedHistoryMode = options.historyMode || 'replace';
  if (!state.codex) return;
  const entryId = entry === undefined ? (state.lightbox.entry?.id || '') : entry;
  const route = captureAtlasRoute(entryId);
  const historyMode = resolveAtlasHistoryMode(requestedHistoryMode, route, { transition, sessionId });
  // history restore 会暂时禁止 URL 写入，但灯箱仍在开合；标题不能因此停在上一条词条。
  syncDocumentTitle(route);
  if (state.suppressUrlSync) return;
  commitHistoryRoute({
    mode: historyMode,
    transition,
    sessionId,
    consumeLayer,
    parentScrollY,
    route,
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
  const rawId = String(entryId);
  const aliases = Array.isArray(state.codex.aliases)
    ? state.codex.aliases.map(alias => String(alias || '').trim()).filter(Boolean)
    : [];
  const uniqueMatches = ids => {
    const matches = [];
    for (const id of ids) {
      // 真实 ID 优先；被合并的旧 ID 才按书内精确映射转到现存套图。
      let entry = state.codex.entries.find(candidate => candidate.id === id);
      if (!entry) {
        const targetId = resolveAtlasEntryId(id, state.codex.entryAliases);
        if (targetId !== id) entry = state.codex.entries.find(candidate => candidate.id === targetId);
      }
      if (entry && !matches.some(item => item.id === entry.id)) matches.push(entry);
    }
    return matches;
  };
  let matches = uniqueMatches([rawId]);
  if (!matches.length) {
    const forwardIds = aliases
      .filter(alias => rawId.startsWith(`${alias}-`) && alias !== state.codex.id)
      .map(alias => `${state.codex.id}${rawId.slice(alias.length)}`);
    matches = uniqueMatches(forwardIds);
  }
  if (!matches.length && rawId.startsWith(`${state.codex.id}-`)) {
    // 兼容短链修复前生成的 canonical 前缀 ID；来源信息丢失时多候选必须拒绝。
    const reverseIds = aliases
      .filter(alias => alias !== state.codex.id)
      .map(alias => `${alias}${rawId.slice(state.codex.id.length)}`);
    matches = uniqueMatches(reverseIds);
  }
  if (matches.length !== 1) {
    syncUrlState({ historyMode: 'replace', entry: '' });
    return false;
  }
  const [entry] = matches;
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
  if (!hasActiveSearchRoute({ q: state.query, searchFilters: state.searchFilterValues })
      && !state.activePath.length && entry.path?.length) {
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
    return entry.id;
  } else {
    toast('这个词条还没有例图');
    syncUrlState({ entry: '' });
    return false;
  }
}
