import {
  commitHistoryRoute,
  configureBrowserHistory,
  getManagedHistoryEntry,
  initializeBrowserHistory,
  isHistoryRestoreToken,
  persistedHistoryState,
} from '../app/browser-history.js';
import { COMMUNITY_CATEGORIES } from './constants.js';
import { state } from './state.js';

const routerActions = {
  applyListRoute: async () => {},
  findEntry: () => null,
  openDetail: () => {},
  closeDetail: () => {},
};

let scrollRestoreToken = 0;

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
    imageIndex: Math.max(0, Number(route.imageIndex) || 0),
  };
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
    if (entry) {
      const lastIndex = Math.max(0, (entry.images || []).length - 1);
      normalized.imageIndex = Math.min(normalized.imageIndex, lastIndex);
      routerActions.openDetail(entry, normalized.imageIndex, { historyMode: 'none' });
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
    applyRoute: applyCommunityHistoryRoute,
    restoreScroll: restoreCommunityScroll,
  });
}

/* strings.html 的路由只存在 history.state 里（地址栏不带参数）：刷新或跨文档
   返回时，把上次记录的分类/搜索/收藏筛选先应用回列表，再初始化托管历史。
   详情弹窗不自动复原，只回列表态。 */
export async function restoreCommunityHistorySnapshot() {
  const previous = persistedHistoryState();
  if (!previous) return;
  await routerActions.applyListRoute(normalizeRoute(previous.route), { target: previous });
}

export function initializeCommunityHistory() {
  return initializeBrowserHistory({ route: captureCommunityRoute('', 0) });
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
