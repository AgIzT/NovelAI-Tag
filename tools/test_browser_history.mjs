import assert from 'node:assert/strict';
import {
  beginLayeredSearch,
  checkpointHistoryScroll,
  closeHistoryLayer,
  commitHistoryRoute,
  configureBrowserHistory,
  createManagedHistoryEntry,
  getManagedHistoryEntry,
  goBackFrom,
  initializeBrowserHistory,
  isManagedHistoryEntry,
  isRestoringHistory,
  openHistoryLayer,
  registerHistoryLayer,
  replaceManagedHistoryEntry,
} from '../site/assets/app/browser-history.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

class FakeWindow extends EventTarget {
  constructor() {
    super();
    this.scrollY = 0;
    this.setTimeout = setTimeout;
    this.clearTimeout = clearTimeout;
    this.queueMicrotask = queueMicrotask;
    this.history = new FakeHistory(this);
  }
}

class FakeHistory {
  constructor(window) {
    this.window = window;
    this.entries = [{ state: null, url: '/page.html' }];
    this.index = 0;
  }

  get state() { return this.entries[this.index]?.state ?? null; }
  get length() { return this.entries.length; }

  replaceState(state, _title, url) {
    this.entries[this.index] = {
      state: structuredClone(state),
      url: url === undefined ? this.entries[this.index].url : url,
    };
  }

  pushState(state, _title, url) {
    this.entries.splice(this.index + 1);
    this.entries.push({
      state: structuredClone(state),
      url: url === undefined ? this.entries[this.index].url : url,
    });
    this.index += 1;
  }

  back() { this.go(-1); }
  forward() { this.go(1); }

  go(delta) {
    const next = this.index + delta;
    if (next < 0 || next >= this.entries.length) return;
    this.index = next;
    const event = new Event('popstate');
    Object.defineProperty(event, 'state', { value: structuredClone(this.state) });
    this.window.dispatchEvent(event);
  }
}

function configure(page = 'atlas', applyRoute = async () => undefined) {
  const window = new FakeWindow();
  let route = { view: 'all', q: '' };
  configureBrowserHistory({
    window,
    page,
    captureRoute: () => route,
    applyRoute,
    restoreScroll: async top => { window.scrollY = top; },
    isEmptySearchRoute: value => !String(value?.q || '').trim(),
  });
  return {
    window,
    get route() { return route; },
    set route(value) { route = value; },
  };
}

// State construction and validation stay deterministic and clone caller-owned values.
const sourceRoute = { view: 'all', nested: { value: 1 } };
const entry = createManagedHistoryEntry({
  page: 'atlas',
  id: 'entry-1',
  parentId: 'entry-0',
  transition: 'route',
  sessionId: 'search-1',
  route: sourceRoute,
  layers: [{ id: 'menu' }],
  scrollY: 12.6,
});
sourceRoute.nested.value = 9;
assert.equal(entry.route.nested.value, 1);
assert.equal(entry.scrollY, 13);
assert.ok(isManagedHistoryEntry(entry, 'atlas'));
assert.equal(isManagedHistoryEntry(entry, 'community'), false);
const replaced = replaceManagedHistoryEntry(entry, { route: { view: 'favorites' } });
assert.equal(replaced.id, entry.id);
assert.equal(replaced.parentId, entry.parentId);

// Initial entries have no parent; push creates a child and replace keeps its identity.
{
  const env = configure();
  const initial = initializeBrowserHistory();
  assert.equal(initial.parentId, null);
  assert.equal(env.window.history.length, 1);

  env.route = { view: 'category', q: '' };
  commitHistoryRoute({ mode: 'push', transition: 'route', parentScrollY: 77 });
  const child = getManagedHistoryEntry();
  assert.equal(child.parentId, initial.id);
  assert.equal(env.window.history.entries[0].state.scrollY, 77);
  assert.equal(env.window.history.length, 2);

  env.route = { view: 'category', q: 'fox' };
  commitHistoryRoute({ mode: 'replace', transition: 'search', sessionId: 's1' });
  const search = getManagedHistoryEntry();
  assert.equal(search.id, child.id);
  assert.equal(search.parentId, initial.id);
  assert.equal(search.route.q, 'fox');
  assert.equal(env.window.history.length, 2);
}

// Swapping a transient layer consumes the current menu record instead of adding depth.
{
  const env = configure();
  let menuOpen = false;
  let dialogOpen = false;
  registerHistoryLayer('menu', {
    isOpen: () => menuOpen,
    open: () => { menuOpen = true; },
    close: () => { menuOpen = false; },
  });
  registerHistoryLayer('dialog', {
    isOpen: () => dialogOpen,
    open: () => { dialogOpen = true; },
    close: () => { dialogOpen = false; },
  });
  initializeBrowserHistory();
  menuOpen = true;
  openHistoryLayer('menu');
  assert.equal(env.window.history.length, 2);
  dialogOpen = true;
  openHistoryLayer('dialog', { mode: 'replace' });
  assert.equal(env.window.history.length, 2);
  assert.deepEqual(getManagedHistoryEntry().layers, [{ id: 'dialog' }]);
  assert.equal(menuOpen, false);
}

// Closing a direct layer carries route changes made inside that layer back to
// its parent record, so settings toggles are not reverted as the dialog closes.
{
  const env = configure();
  let settingsOpen = false;
  registerHistoryLayer('settings-filter', {
    isOpen: () => settingsOpen,
    open: () => { settingsOpen = true; },
    close: () => { settingsOpen = false; },
  });
  const initial = initializeBrowserHistory();
  settingsOpen = true;
  openHistoryLayer('settings-filter');
  env.route = { view: 'all', q: '', updateFilter: '2026.8.14' };
  env.window.scrollY = 180;
  commitHistoryRoute({ mode: 'replace' });

  env.window.history.back();
  await tick();
  assert.equal(settingsOpen, false);
  assert.equal(getManagedHistoryEntry().id, initial.id);
  assert.equal(getManagedHistoryEntry().route.updateFilter, '2026.8.14');
  assert.equal(getManagedHistoryEntry().scrollY, 180);
}

// A layered search keeps one stable session: back closes the search layer while
// retaining the latest query, then a second back restores the pre-search route.
{
  const env = configure();
  let searchOpen = false;
  registerHistoryLayer('mobile-search', {
    isOpen: () => searchOpen,
    open: () => { searchOpen = true; },
    close: () => { searchOpen = false; },
  });
  const initial = initializeBrowserHistory();
  searchOpen = true;
  openHistoryLayer('mobile-search');
  env.route = { view: 'all', q: 'f' };
  beginLayeredSearch('mobile-search', 'stable-search');
  env.route = { view: 'all', q: 'fox' };
  env.window.scrollY = 240;
  commitHistoryRoute({ mode: 'replace', transition: 'search', sessionId: 'stable-search' });
  assert.equal(env.window.history.length, 3);

  env.window.history.back();
  await tick();
  assert.equal(searchOpen, false);
  assert.equal(getManagedHistoryEntry().route.q, 'fox');
  assert.equal(getManagedHistoryEntry().scrollY, 240);
  assert.deepEqual(getManagedHistoryEntry().layers, []);

  env.window.history.back();
  await tick();
  assert.equal(getManagedHistoryEntry().id, initial.id);
  assert.equal(getManagedHistoryEntry().route.q, '');
}

// Route adapters can downgrade stale records (for example a deleted community post).
{
  const applied = [];
  const env = configure('community', async route => {
    applied.push(route);
    if (route.entry === 'missing') return { ...route, entry: '', imageIndex: 0 };
    return undefined;
  });
  initializeBrowserHistory();
  env.route = { view: 'all', q: '', entry: 'missing', imageIndex: 4 };
  commitHistoryRoute({ mode: 'push', transition: 'detail' });
  env.route = { view: 'other', q: '' };
  commitHistoryRoute({ mode: 'push', transition: 'route' });

  env.window.history.back();
  await tick();
  assert.equal(applied.at(-1).entry, 'missing');
  assert.equal(getManagedHistoryEntry().route.entry, '');
  assert.equal(getManagedHistoryEntry().transition, 'route');
  assert.equal(env.window.history.state.route.imageIndex, 0);
}

// Reload adoption: a visible route record persisted in history.state keeps its
// identity, transition, and scroll across re-init, so back navigation and
// scroll restoration survive a page reload / cross-document return.
{
  const win = new FakeWindow();
  let route = { view: 'all', q: '' };
  let restored = -1;
  const options = {
    window: win,
    page: 'atlas',
    captureRoute: () => route,
    applyRoute: async () => undefined,
    restoreScroll: async top => { restored = top; win.scrollY = top; },
  };
  configureBrowserHistory(options);
  const initial = initializeBrowserHistory();
  route = { view: 'category', q: '' };
  commitHistoryRoute({ mode: 'push', transition: 'route' });
  const before = getManagedHistoryEntry();
  win.scrollY = 320;
  checkpointHistoryScroll();

  configureBrowserHistory(options);   // simulated reload: same window, same history
  const adopted = initializeBrowserHistory();
  assert.equal(adopted.id, before.id);
  assert.equal(adopted.parentId, initial.id);
  assert.equal(adopted.transition, 'route');
  assert.equal(adopted.scrollY, 320);
  assert.equal(restored, 320);
  assert.deepEqual(adopted.layers, []);

  win.history.back();
  await tick();
  assert.equal(getManagedHistoryEntry().id, initial.id);
}

// Reload discards transient layer UI. Initialization therefore walks back to
// the nearest visible parent before the user can press Back, carrying route
// changes and scroll through nested layers without replaying the route.
{
  const win = new FakeWindow();
  win.history.entries = [
    { state: null, url: '/before.html' },
    { state: null, url: '/page.html' },
  ];
  win.history.index = 1;
  let route = { view: 'all', q: '', updateFilter: '' };
  const calls = { applyRoute: 0, restoreScroll: 0 };
  const options = {
    window: win,
    page: 'atlas',
    captureRoute: () => route,
    applyRoute: async () => { calls.applyRoute += 1; },
    restoreScroll: async top => { calls.restoreScroll += 1; win.scrollY = top; },
  };
  let settingsOpen = false;
  let confirmOpen = false;
  configureBrowserHistory(options);
  registerHistoryLayer('reload-settings', {
    isOpen: () => settingsOpen,
    open: () => { settingsOpen = true; },
    close: () => { settingsOpen = false; },
  });
  registerHistoryLayer('reload-confirm', {
    isOpen: () => confirmOpen,
    open: () => { confirmOpen = true; },
    close: () => { confirmOpen = false; },
  });
  const initial = initializeBrowserHistory();
  settingsOpen = true;
  openHistoryLayer('reload-settings');
  confirmOpen = true;
  openHistoryLayer('reload-confirm');
  route = { view: 'all', q: '', updateFilter: '2026.8.14' };
  win.scrollY = 320;
  commitHistoryRoute({ mode: 'replace' });
  checkpointHistoryScroll();

  // Simulated DOM reload: both overlays are gone, while session history stays.
  settingsOpen = false;
  confirmOpen = false;
  configureBrowserHistory(options);
  const adopted = initializeBrowserHistory();
  assert.equal(adopted.parentId != null, true);
  await tick();
  assert.equal(win.history.index, 1);
  assert.equal(getManagedHistoryEntry().id, initial.id);
  assert.deepEqual(getManagedHistoryEntry().layers, []);
  assert.equal(getManagedHistoryEntry().route.updateFilter, '2026.8.14');
  assert.equal(getManagedHistoryEntry().scrollY, 320);
  assert.equal(calls.applyRoute, 0);
  assert.equal(calls.restoreScroll, 1);

  // The first user Back now reaches the previous document, not a ghost layer.
  win.history.back();
  assert.equal(win.history.index, 0);
}

// A detail intentionally not restored after reload (community list policy) is
// collapsed, while a detail that remains visible (atlas deep link) is retained.
{
  const win = new FakeWindow();
  win.history.entries = [
    { state: null, url: '/before.html' },
    { state: null, url: '/page.html' },
  ];
  win.history.index = 1;
  let route = { view: 'all', q: '', entry: '', imageIndex: 0 };
  const applied = [];
  const options = {
    window: win,
    page: 'community',
    captureRoute: () => route,
    applyRoute: async value => { applied.push(value); },
  };
  configureBrowserHistory(options);
  const list = initializeBrowserHistory();
  route = { view: 'all', q: '', entry: 'post-1', imageIndex: 2 };
  commitHistoryRoute({ mode: 'push', transition: 'detail' });

  route = { view: 'all', q: '', entry: '', imageIndex: 0 };
  configureBrowserHistory(options);
  initializeBrowserHistory();
  await tick();
  assert.equal(win.history.index, 1);
  assert.equal(getManagedHistoryEntry().id, list.id);
  assert.equal(applied.length, 0);

  const atlasWin = new FakeWindow();
  let atlasRoute = { view: 'all', q: '', entry: '', imageIndex: 0 };
  const atlasOptions = {
    window: atlasWin,
    page: 'atlas',
    captureRoute: () => atlasRoute,
    applyRoute: async () => undefined,
  };
  configureBrowserHistory(atlasOptions);
  initializeBrowserHistory();
  atlasRoute = { view: 'all', q: '', entry: 'entry-1', imageIndex: 2 };
  commitHistoryRoute({ mode: 'push', transition: 'detail' });
  configureBrowserHistory(atlasOptions);
  atlasRoute = { view: 'all', q: '', entry: 'entry-1', imageIndex: 0 };
  const visibleDetail = initializeBrowserHistory();
  await tick();
  assert.equal(atlasWin.history.index, 1);
  assert.equal(getManagedHistoryEntry().id, visibleDetail.id);
  assert.equal(getManagedHistoryEntry().transition, 'detail');
}

// While a back() is still in flight, further close requests are treated as
// handled instead of popping extra records (rapid double-tap / double Escape).
{
  const env = configure();
  let layerOpen = false;
  registerHistoryLayer('guard-layer', {
    isOpen: () => layerOpen,
    open: () => { layerOpen = true; },
    close: () => { layerOpen = false; },
  });
  initializeBrowserHistory();
  env.route = { view: 'detail', q: '' };
  commitHistoryRoute({ mode: 'push', transition: 'detail' });

  const history = env.window.history;
  const realBack = history.back.bind(history);
  let backs = 0;
  history.back = () => { backs += 1; };   // swallow traversal: popstate stays pending
  assert.equal(goBackFrom('detail'), true);
  assert.equal(goBackFrom('detail'), true);
  assert.equal(backs, 1);
  history.back = realBack;
  history.back();                          // deliver the pending traversal
  await tick();
  assert.equal(getManagedHistoryEntry().transition, 'initial');
  assert.equal(goBackFrom('detail'), false);   // pendingBack cleared by popstate

  layerOpen = true;
  openHistoryLayer('guard-layer');
  backs = 0;
  history.back = () => { backs += 1; };
  assert.equal(closeHistoryLayer('guard-layer'), true);
  assert.equal(closeHistoryLayer('guard-layer'), true);
  assert.equal(backs, 1);
  history.back = realBack;
  history.back();
  await tick();
  assert.equal(layerOpen, false);
}

// A pure layer close only reconciles overlays: no route replay, no scroll
// restore — the page must not flash to the top when a dialog closes.
{
  const win = new FakeWindow();
  let route = { view: 'all', q: '' };
  const calls = { applyRoute: 0, restoreScroll: 0 };
  configureBrowserHistory({
    window: win,
    page: 'atlas',
    captureRoute: () => route,
    applyRoute: async () => { calls.applyRoute += 1; },
    restoreScroll: async () => { calls.restoreScroll += 1; },
  });
  let dialogOpen = false;
  registerHistoryLayer('flash-dialog', {
    isOpen: () => dialogOpen,
    open: () => { dialogOpen = true; },
    close: () => { dialogOpen = false; },
  });
  const initial = initializeBrowserHistory();
  win.scrollY = 260;
  dialogOpen = true;
  openHistoryLayer('flash-dialog');

  win.history.back();
  await tick();
  assert.equal(dialogOpen, false);
  assert.equal(calls.applyRoute, 0);
  assert.equal(calls.restoreScroll, 0);
  assert.equal(win.scrollY, 260);
  assert.equal(getManagedHistoryEntry().id, initial.id);

  // A real route pop still replays the route and restores scroll.
  route = { view: 'category', q: '' };
  commitHistoryRoute({ mode: 'push', transition: 'route' });
  win.history.back();
  await tick();
  assert.equal(calls.applyRoute, 1);
  assert.equal(calls.restoreScroll, 1);
}

// A route-backed detail dialog shares the modal registry but is not a transient
// history layer. Closing a clipboard/settings layer above it must preserve the
// detail UI and its route while still skipping route replay.
{
  const calls = { applyRoute: 0, restoreScroll: 0 };
  const env = configure('community', async () => { calls.applyRoute += 1; });
  let detailOpen = true;
  let clipboardFallbackOpen = false;
  registerHistoryLayer('route-backed-detail', {
    isOpen: () => detailOpen,
    open: () => { detailOpen = true; },
    close: () => { detailOpen = false; },
  });
  registerHistoryLayer('clipboard-fallback-test', {
    isOpen: () => clipboardFallbackOpen,
    open: () => { clipboardFallbackOpen = true; },
    close: () => { clipboardFallbackOpen = false; },
  });
  env.route = { view: 'all', q: '', entry: 'post-1', imageIndex: 0 };
  const detail = initializeBrowserHistory({ transition: 'detail' });
  clipboardFallbackOpen = true;
  openHistoryLayer('clipboard-fallback-test');

  env.window.history.back();
  await tick();
  assert.equal(clipboardFallbackOpen, false);
  assert.equal(detailOpen, true);
  assert.equal(getManagedHistoryEntry().id, detail.id);
  assert.equal(getManagedHistoryEntry().route.entry, 'post-1');
  assert.equal(calls.applyRoute, 0);
  assert.equal(calls.restoreScroll, 0);
  detailOpen = false; // avoid leaking a deliberately visible registered modal into later cases
}

// Every managed popstate invalidates an older async restore, including the
// pure-layer-close fast path. The stale restore must neither overwrite the
// parent slot nor leave history writes permanently locked.
{
  const applyStarted = deferred();
  const finishApply = deferred();
  const env = configure('atlas', async route => {
    applyStarted.resolve();
    await finishApply.promise;
    return { ...route, staleRestore: true };
  });
  let dialogOpen = false;
  registerHistoryLayer('restore-race-dialog', {
    isOpen: () => dialogOpen,
    open: () => { dialogOpen = true; },
    close: () => { dialogOpen = false; },
  });
  const parent = initializeBrowserHistory();
  dialogOpen = true;
  openHistoryLayer('restore-race-dialog');
  env.route = { view: 'category', q: '' };
  commitHistoryRoute({ mode: 'push', transition: 'route' });

  env.window.history.back();
  await applyStarted.promise;
  assert.equal(isRestoringHistory(), true);
  env.window.history.back();
  await tick();
  assert.equal(isRestoringHistory(), false);
  assert.equal(dialogOpen, false);
  assert.equal(getManagedHistoryEntry().id, parent.id);

  env.route = { view: 'fresh', q: '' };
  assert.equal(commitHistoryRoute({ mode: 'replace' }), true);
  finishApply.resolve();
  await tick();
  assert.equal(getManagedHistoryEntry().id, parent.id);
  assert.deepEqual(getManagedHistoryEntry().route, { view: 'fresh', q: '' });
  assert.equal(env.window.history.state.route.staleRestore, undefined);
}

// A layer opened by the user during a slow route restore remains visible and
// is adopted into managed history once restoration finishes.
{
  const applyStarted = deferred();
  const finishApply = deferred();
  const env = configure('atlas', async () => {
    applyStarted.resolve();
    await finishApply.promise;
  });
  let userLayerOpen = false;
  registerHistoryLayer('opened-during-restore', {
    isOpen: () => userLayerOpen,
    open: () => { userLayerOpen = true; },
    close: () => { userLayerOpen = false; },
  });
  const parent = initializeBrowserHistory();
  env.route = { view: 'category', q: '' };
  commitHistoryRoute({ mode: 'push', transition: 'route' });

  env.window.history.back();
  await applyStarted.promise;
  userLayerOpen = true;
  assert.equal(openHistoryLayer('opened-during-restore'), false);
  finishApply.resolve();
  await tick();

  assert.equal(userLayerOpen, true);
  assert.equal(isRestoringHistory(), false);
  assert.equal(getManagedHistoryEntry().parentId, parent.id);
  assert.deepEqual(getManagedHistoryEntry().layers, [{ id: 'opened-during-restore' }]);
  env.window.history.back();
  await tick();
  assert.equal(userLayerOpen, false);
  assert.equal(getManagedHistoryEntry().id, parent.id);
}

// If that provisional layer is no longer open by the time restoration ends,
// do not create a history record and therefore keep the existing Forward slot.
{
  const applyStarted = deferred();
  const finishApply = deferred();
  const env = configure('atlas', async () => {
    applyStarted.resolve();
    await finishApply.promise;
  });
  let provisionalOpen = false;
  registerHistoryLayer('closed-during-restore', {
    isOpen: () => provisionalOpen,
    open: () => { provisionalOpen = true; },
    close: () => { provisionalOpen = false; },
  });
  const parent = initializeBrowserHistory();
  env.route = { view: 'category', q: '' };
  commitHistoryRoute({ mode: 'push', transition: 'route' });
  const forward = getManagedHistoryEntry();

  env.window.history.back();
  await applyStarted.promise;
  provisionalOpen = true;
  openHistoryLayer('closed-during-restore');
  provisionalOpen = false;
  finishApply.resolve();
  await tick();

  assert.equal(env.window.history.index, 0);
  assert.equal(env.window.history.length, 2);
  assert.equal(env.window.history.entries[1].state.id, forward.id);
  assert.equal(getManagedHistoryEntry().id, parent.id);
  assert.deepEqual(getManagedHistoryEntry().layers, []);
}

console.log('browser history tests passed');
