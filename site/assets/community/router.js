import {
  commitHistoryRoute,
  configureBrowserHistory,
  getManagedHistoryEntry,
  initializeBrowserHistory,
  isHistoryRestoreToken,
  persistedHistoryState,
} from '../app/browser-history.js';
import { COMMUNITY_CATEGORIES } from './constants.js';
import { canShowCommunityEntry, state } from './state.js';

const routerActions = {
  applyListRoute: async () => {},
  findEntry: () => null,
  openDetail: () => {},
  closeDetail: () => {},
};

let scrollRestoreToken = 0;

function normalizedImageIndex(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

export function setCommunityRouterActions(actions = {}) {
  Object.assign(routerActions, actions);
}

function normalizeRoute(route = {}) {
  const category = COMMUNITY_CATEGORIES.includes(route.category) ? route.category : '';
  return {
    category,
    q: String(route.q || ''),
    onlyFavorites: Boolean(route.onlyFavorites),
    entry: String(route.entry || ''),
    imageIndex: normalizedImageIndex(route.imageIndex),
  };
}

export function readCommunityUrlState(search = globalThis.location?.search || '') {
  const params = new URLSearchParams(String(search || ''));
  const entry = String(params.get('entry') || '').trim();
  const image = Math.max(1, Math.trunc(Number(params.get('image')) || 1));
  return {
    entry,
    imageIndex: entry ? image - 1 : 0,
  };
}

export function communityUrlForRoute(route = {}, href = globalThis.location?.href || 'https://example.invalid/strings.html') {
  const url = new URL(href, 'https://example.invalid/');
  const entry = String(route.entry || '').trim();
  if (entry) {
    url.searchParams.set('entry', entry);
    const imageIndex = normalizedImageIndex(route.imageIndex);
    if (imageIndex) url.searchParams.set('image', String(imageIndex + 1));
    else url.searchParams.delete('image');
  } else {
    url.searchParams.delete('entry');
    url.searchParams.delete('image');
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function captureCommunityRoute(entryOverride, imageIndexOverride) {
  return normalizeRoute({
    category: state.activeCategory || '',
    q: state.query,
    onlyFavorites: state.onlyFavorites,
    entry: entryOverride === undefined ? state.activeEntryId : entryOverride,
    imageIndex: imageIndexOverride === undefined ? state.activeImageIndex : imageIndexOverride,
  });
}

async function applyCommunityHistoryRoute(route, context = {}) {
  let normalized = normalizeRoute(route);
  await routerActions.applyListRoute(normalized, context);
  if (context.token == null) return;

  if (normalized.entry) {
    const entry = routerActions.findEntry(normalized.entry);
    if (canShowCommunityEntry(entry)) {
      const lastIndex = Math.max(0, (entry.images || []).length - 1);
      normalized.imageIndex = Math.min(normalized.imageIndex, lastIndex);
      const opened = routerActions.openDetail(entry, normalized.imageIndex, { historyMode: 'none' });
      if (opened === false) {
        normalized = { ...normalized, entry: '', imageIndex: 0 };
        routerActions.closeDetail({ historyMode: 'none' });
        return normalized;
      }
    } else {
      normalized = { ...normalized, entry: '', imageIndex: 0 };
      routerActions.closeDetail({ historyMode: 'none' });
      return normalized;
    }
  } else {
    routerActions.closeDetail({ historyMode: 'none' });
  }
  return undefined;
}

function restoreCommunityScroll(scrollY, { token } = {}) {
  const ownToken = ++scrollRestoreToken;
  const target = Math.max(0, Number(scrollY) || 0);
  let attempts = 0;
  const run = () => {
    if (ownToken !== scrollRestoreToken) return;
    if (token !== undefined && !isHistoryRestoreToken(token)) return;
    window.scrollTo({ top: target, left: 0, behavior: 'auto' });
    attempts += 1;
    const reached = Math.abs(Math.max(0, window.scrollY) - target) <= 3;
    if (!reached && attempts < 4) window.setTimeout(run, attempts === 1 ? 80 : 160);
  };
  window.requestAnimationFrame(run);
}

export function configureCommunityHistory() {
  configureBrowserHistory({
    page: 'community',
    captureRoute: captureCommunityRoute,
    urlForRoute: communityUrlForRoute,
    applyRoute: applyCommunityHistoryRoute,
    restoreScroll: restoreCommunityScroll,
  });
}

/* 分类、搜索、收藏筛选仍只存在 history.state；可分享详情额外写入 entry/image
   查询参数。刷新或跨文档返回时先恢复列表态，再由初始化流程按门控打开详情。 */
export async function restoreCommunityHistorySnapshot() {
  const previous = persistedHistoryState();
  if (!previous) return;
  await routerActions.applyListRoute(normalizeRoute(previous.route), { target: previous });
}

export function initializeCommunityHistory(route) {
  return initializeBrowserHistory({ route: route || captureCommunityRoute('', 0) });
}

export function syncCommunityHistory({
  historyMode = 'replace',
  transition,
  sessionId,
  consumeLayer = false,
  entry,
  imageIndex,
  route,
  parentScrollY,
} = {}) {
  return commitHistoryRoute({
    mode: historyMode,
    transition,
    sessionId,
    consumeLayer,
    parentScrollY,
    route: route || captureCommunityRoute(entry, imageIndex),
  });
}

export function currentCommunityHistorySession() {
  return getManagedHistoryEntry()?.sessionId || '';
}
