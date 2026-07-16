import { state } from './state.js';
import { $ } from './utils.js';
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

export function readUrlState() {
  const params = new URLSearchParams(location.search);
  const hash = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
  const pathValues = params.getAll('path');
  const path = pathValues.length > 1
    ? pathValues.map(seg => seg.trim()).filter(Boolean)
    : decodeLegacyPathParam(pathValues[0] || '');
  return {
    codex: params.get('codex') || '',
    favorites: params.get('fav') === '1' || params.get('view') === 'favorites' || params.get('codex') === 'favorites',
    scope: params.get('scope') || '',
    path,
    q: params.get('q') || '',
    entry: params.get('entry') || hash.get('entry') || '',
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
    onlyImaged: Boolean(state.onlyImaged),
  };
}

export function atlasUrlForRoute(route) {
  const params = new URLSearchParams();
  if (route.codex) params.set('codex', route.codex);
  if (route.favorites) params.set('fav', '1');
  const q = String(route.q || '').trim();
  if (q) {
    params.set('q', q);
    params.set('scope', route.siteSearch || route.scope === 'site' ? 'site' : 'codex');
    if (route.siteSearch) {
      for (const seg of route.path || []) params.append('path', seg);
    }
  } else {
    for (const seg of route.path || []) params.append('path', seg);
  }
  if (route.entry) params.set('entry', route.entry);
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ''}`;
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
