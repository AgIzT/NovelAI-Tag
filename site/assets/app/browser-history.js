const HISTORY_APP = 'novelai-tag';
const HISTORY_VERSION = 1;

let config = null;
let initialized = false;
let restoring = false;
let pendingBack = false;
let restoreToken = 0;
let currentEntry = null;
let scrollTimer = 0;
let idCounter = 0;
const layerRegistry = new Map();

const cloneValue = value => {
  if (value == null) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const nextId = () => `${Date.now().toString(36)}-${(++idCounter).toString(36)}`;
const layerIds = entry => Array.isArray(entry?.layers) ? entry.layers.map(layer => layer?.id).filter(Boolean) : [];

export function createManagedHistoryEntry({
  page,
  id = nextId(),
  parentId = null,
  transition = 'initial',
  sessionId = null,
  route = {},
  layers = [],
  scrollY = 0,
} = {}) {
  return {
    app: HISTORY_APP,
    version: HISTORY_VERSION,
    page: String(page || ''),
    id,
    parentId,
    transition,
    sessionId,
    route: cloneValue(route || {}),
    layers: cloneValue(layers || []),
    scrollY: Math.max(0, Math.round(Number(scrollY) || 0)),
  };
}

export function isManagedHistoryEntry(value, page = '') {
  return Boolean(
    value &&
    value.app === HISTORY_APP &&
    value.version === HISTORY_VERSION &&
    value.id &&
    (!page || value.page === page),
  );
}

export function replaceManagedHistoryEntry(entry, changes = {}) {
  return createManagedHistoryEntry({
    ...entry,
    ...changes,
    page: changes.page ?? entry?.page,
    id: changes.id ?? entry?.id,
    parentId: changes.parentId === undefined ? entry?.parentId ?? null : changes.parentId,
    transition: changes.transition ?? entry?.transition ?? 'initial',
    sessionId: changes.sessionId === undefined ? entry?.sessionId ?? null : changes.sessionId,
    route: changes.route ?? entry?.route ?? {},
    layers: changes.layers ?? entry?.layers ?? [],
    scrollY: changes.scrollY ?? entry?.scrollY ?? 0,
  });
}

function browserWindow() {
  return config?.window || (typeof window !== 'undefined' ? window : null);
}

function captureRoute() {
  return cloneValue(config?.captureRoute?.() || {});
}

function currentScrollY() {
  return Math.max(0, Math.round(Number(browserWindow()?.scrollY) || 0));
}

function historyUrl(route) {
  const value = config?.urlForRoute?.(cloneValue(route));
  return typeof value === 'string' && value ? value : undefined;
}

function writeState(mode, entry, { updateUrl = true } = {}) {
  const win = browserWindow();
  if (!win) return;
  const url = updateUrl ? historyUrl(entry.route) : undefined;
  if (mode === 'push') {
    if (url === undefined) win.history.pushState(entry, '');
    else win.history.pushState(entry, '', url);
  } else if (url === undefined) {
    win.history.replaceState(entry, '');
  } else {
    win.history.replaceState(entry, '', url);
  }
  currentEntry = entry;
}

function checkpointCurrent({ updateUrl = false, scrollY } = {}) {
  if (!initialized || !currentEntry) return null;
  const entry = replaceManagedHistoryEntry(currentEntry, {
    scrollY: scrollY === undefined ? currentScrollY() : scrollY,
  });
  writeState('replace', entry, { updateUrl });
  return entry;
}

export function configureBrowserHistory(options = {}) {
  const win = options.window || (typeof window !== 'undefined' ? window : null);
  if (!win) throw new Error('Browser history requires a window');
  if (!options.page) throw new Error('Browser history requires a page id');
  if (config?.window) {
    config.window.removeEventListener('popstate', handlePopState);
    config.window.removeEventListener('pagehide', checkpointHistoryScroll);
  }
  config = { ...options, window: win };
  initialized = false;
  restoring = false;
  pendingBack = false;
  currentEntry = null;
  if ('scrollRestoration' in win.history) win.history.scrollRestoration = 'manual';
  win.addEventListener('popstate', handlePopState);
  win.addEventListener('pagehide', checkpointHistoryScroll);
}

export function persistedHistoryState() {
  if (!config) return null;
  const state = browserWindow()?.history?.state;
  return isManagedHistoryEntry(state, config.page) ? cloneValue(state) : null;
}

export function initializeBrowserHistory({ transition = 'initial', route: routeOverride } = {}) {
  if (!config) throw new Error('Browser history is not configured');
  /* 刷新 / 跨文档返回时 history.state 里仍留着本页的托管记录（pagehide 已存过
     滚动位置）：沿用其身份、transition 与 scrollY，让返回链和滚动恢复跨重载
     存活。浮层在重载后必然全部关闭，故 layers 一律清空。 */
  const previous = persistedHistoryState();
  currentEntry = createManagedHistoryEntry({
    page: config.page,
    id: previous?.id,
    parentId: previous?.parentId ?? null,
    transition: previous?.transition || transition,
    sessionId: previous?.sessionId ?? null,
    route: routeOverride === undefined ? captureRoute() : cloneValue(routeOverride),
    layers: [],
    scrollY: previous ? previous.scrollY : currentScrollY(),
  });
  initialized = true;
  writeState('replace', currentEntry);
  if (previous && previous.scrollY > 0) config.restoreScroll?.(previous.scrollY, {});
  return cloneValue(currentEntry);
}

export function managedHistoryReady() {
  return initialized;
}

export function isRestoringHistory() {
  return restoring;
}

export function isHistoryRestoreToken(token) {
  return Number(token) === restoreToken;
}

export function getManagedHistoryEntry() {
  return cloneValue(currentEntry);
}

export function topHistoryLayerId() {
  const ids = layerIds(currentEntry);
  return ids[ids.length - 1] || '';
}

export function registerHistoryLayer(id, handlers = {}) {
  if (!id) return;
  layerRegistry.set(String(id), handlers);
}

function directCloseLayer(id) {
  const handler = layerRegistry.get(id);
  if (handler?.isOpen?.() !== false) handler?.close?.();
}

function directOpenLayer(id) {
  const handler = layerRegistry.get(id);
  if (handler?.isOpen?.() !== true) handler?.open?.();
}

function reconcileLayers(targetLayers = []) {
  const targetIds = targetLayers.map(layer => layer?.id).filter(Boolean);
  const currentIds = [...layerRegistry.keys()].filter(id => layerRegistry.get(id)?.isOpen?.());
  for (const id of currentIds.reverse()) {
    if (!targetIds.includes(id)) directCloseLayer(id);
  }
  for (const id of targetIds) directOpenLayer(id);
}

export function openHistoryLayer(id, { mode = 'push' } = {}) {
  id = String(id || '');
  if (!id || !initialized || restoring || !currentEntry) return false;
  const ids = layerIds(currentEntry);
  if (ids[ids.length - 1] === id) return true;
  const layers = ids.map(layerId => ({ id: layerId }));
  if (mode === 'replace' && layers.length) {
    const oldId = layers[layers.length - 1].id;
    if (oldId !== id) directCloseLayer(oldId);
    layers[layers.length - 1] = { id };
    const entry = replaceManagedHistoryEntry(currentEntry, {
      transition: 'layer',
      layers,
      route: captureRoute(),
      scrollY: currentScrollY(),
    });
    writeState('replace', entry);
    return true;
  }
  const parent = checkpointCurrent();
  const entry = createManagedHistoryEntry({
    page: config.page,
    parentId: parent?.id || null,
    transition: 'layer',
    route: captureRoute(),
    layers: [...layers, { id }],
    scrollY: currentScrollY(),
  });
  writeState('push', entry);
  return true;
}

export function forgetHistoryLayer(id) {
  id = String(id || '');
  if (!id || !initialized || restoring || !currentEntry) return;
  const ids = layerIds(currentEntry);
  if (!ids.includes(id)) return;
  const entry = replaceManagedHistoryEntry(currentEntry, {
    layers: ids.filter(layerId => layerId !== id).map(layerId => ({ id: layerId })),
    route: captureRoute(),
    scrollY: currentScrollY(),
  });
  writeState('replace', entry);
}

export function closeHistoryLayer(id) {
  id = String(id || '');
  if (!id || !initialized || restoring || !currentEntry) return false;
  const ids = layerIds(currentEntry);
  if (ids[ids.length - 1] !== id) {
    forgetHistoryLayer(id);
    return false;
  }
  if (currentEntry.parentId) {
    if (!pendingBack) requestHistoryBack();
    return true;
  }
  forgetHistoryLayer(id);
  return false;
}

export function commitHistoryRoute({
  mode = 'replace',
  transition,
  sessionId,
  consumeLayer = false,
  route: routeOverride,
  parentScrollY,
} = {}) {
  if (mode === 'none' || !initialized || restoring || !currentEntry) return false;
  const route = routeOverride === undefined ? captureRoute() : cloneValue(routeOverride);
  const ids = layerIds(currentEntry);
  if (consumeLayer && ids.length) {
    const removed = ids[ids.length - 1];
    directCloseLayer(removed);
    const entry = replaceManagedHistoryEntry(currentEntry, {
      transition: transition || 'route',
      sessionId: sessionId === undefined ? null : sessionId,
      route,
      layers: ids.slice(0, -1).map(id => ({ id })),
      scrollY: currentScrollY(),
    });
    writeState('replace', entry);
    return true;
  }
  if (mode === 'push') {
    const parent = checkpointCurrent({ scrollY: parentScrollY });
    const entry = createManagedHistoryEntry({
      page: config.page,
      parentId: parent?.id || null,
      transition: transition || 'route',
      sessionId: sessionId ?? null,
      route,
      layers: ids.map(id => ({ id })),
      scrollY: currentScrollY(),
    });
    writeState('push', entry);
    return true;
  }
  const entry = replaceManagedHistoryEntry(currentEntry, {
    transition: transition || currentEntry.transition,
    sessionId: sessionId === undefined ? currentEntry.sessionId : sessionId,
    route,
    layers: ids.map(id => ({ id })),
    scrollY: currentScrollY(),
  });
  writeState('replace', entry);
  return true;
}

export function beginLayeredSearch(layerId, sessionId, routeOverride) {
  layerId = String(layerId || '');
  if (!initialized || restoring || !currentEntry || !layerId) return false;
  const ids = layerIds(currentEntry);
  if (ids[ids.length - 1] !== layerId) {
    return commitHistoryRoute({ mode: 'push', transition: 'search', sessionId });
  }
  const route = routeOverride === undefined ? captureRoute() : cloneValue(routeOverride);
  const resultEntry = replaceManagedHistoryEntry(currentEntry, {
    transition: 'search',
    sessionId,
    route,
    layers: ids.slice(0, -1).map(id => ({ id })),
    scrollY: currentScrollY(),
  });
  writeState('replace', resultEntry);
  const layerEntry = createManagedHistoryEntry({
    page: config.page,
    parentId: resultEntry.id,
    transition: 'layer',
    sessionId,
    route,
    layers: ids.map(id => ({ id })),
    scrollY: currentScrollY(),
  });
  writeState('push', layerEntry);
  return true;
}

export function canGoBackFrom(transition) {
  return Boolean(
    initialized &&
    currentEntry?.parentId &&
    (!transition || currentEntry.transition === transition),
  );
}

/* history.back() 到 popstate 之间有一段异步窗口，currentEntry 在此期间是旧值。
   pendingBack 挡住这段窗口里的重复回退（快速双击关闭按钮 / 连按 Esc），
   否则会多退一级。popstate 一到即清除。 */
function requestHistoryBack() {
  pendingBack = true;
  browserWindow().history.back();
}

export function goBackFrom(transition) {
  if (!canGoBackFrom(transition)) return false;
  if (!pendingBack) requestHistoryBack();
  return true;
}

export function checkpointHistoryScroll() {
  clearTimeout(scrollTimer);
  scrollTimer = 0;
  if (!initialized || restoring) return;
  checkpointCurrent();
}

export function scheduleHistoryScrollCheckpoint(delay = 150) {
  if (!initialized || restoring) return;
  clearTimeout(scrollTimer);
  scrollTimer = browserWindow().setTimeout(checkpointHistoryScroll, delay);
}

async function handlePopState(event) {
  pendingBack = false;
  if (!config || !isManagedHistoryEntry(event.state, config.page)) return;
  clearTimeout(scrollTimer);
  scrollTimer = 0;
  const departing = currentEntry;
  let target = cloneValue(event.state);
  const departingLayers = layerIds(departing);
  const targetLayers = layerIds(target);
  const closingDirectLayer = Boolean(
    departing?.parentId === target.id &&
    departingLayers.length > targetLayers.length,
  );
  const sameSearchSession = Boolean(
    closingDirectLayer &&
    departing?.sessionId &&
    target.sessionId &&
    departing.sessionId === target.sessionId,
  );
  if (closingDirectLayer) {
    target = replaceManagedHistoryEntry(target, {
      route: departing.route,
      scrollY: currentScrollY(),
    });
    writeState('replace', target);
    if (sameSearchSession && config.isEmptySearchRoute?.(target.route) && target.parentId) {
      reconcileLayers(target.layers);
      browserWindow().queueMicrotask(() => requestHistoryBack());
      return;
    }
  } else {
    currentEntry = target;
  }

  const token = ++restoreToken;
  restoring = true;
  reconcileLayers(target.layers);
  try {
    const normalizedRoute = await config.applyRoute?.(
      cloneValue(target.route),
      { token, departing: cloneValue(departing), target: cloneValue(target) },
    );
    if (token !== restoreToken) return;
    if (normalizedRoute && typeof normalizedRoute === 'object') {
      const changes = { route: normalizedRoute };
      if (target.transition === 'detail' && !normalizedRoute.entry) changes.transition = 'route';
      target = replaceManagedHistoryEntry(target, changes);
      writeState('replace', target);
    }
    reconcileLayers(target.layers);
    await config.restoreScroll?.(target.scrollY, { token });
  } catch (error) {
    console.error('[history] 恢复页面状态失败', error);
  } finally {
    if (token === restoreToken) restoring = false;
  }
}
