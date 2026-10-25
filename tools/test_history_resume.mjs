// Actual history control flow with synthetic routes and controlled async views.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../site/assets/app/history.js', import.meta.url), 'utf8')
  .replace(/^import\s[\s\S]*?;\r?\n/gm, '').replace(/^export\s+/gm, '');
const cases = [];
async function test(name, action) {
  try { await action(); cases.push({ name, status: 'PASS' }); }
  catch (error) { cases.push({ name, status: 'FAIL', error: error.message }); }
}
function fixture() {
  const books = ['a', 'b'].map(id => ({ id, title: id, tree: [] }));
  const state = { codex: books[0], browseCodex: books[0], codexes: books, favoritesView: false,
    siteSearchView: false, onlyFav: false, favFolder: '', favSource: '', favSort: 'recent',
    activePath: [], query: '', searchScope: 'codex', searchFilterValues: [], updateFilter: '',
    lightbox: { entry: null, index: 0 }, allowNsfw: false, allowR18g: false };
  let version = 0;
  const timers = [], listeners = new Map(), calls = [];
  const controls = { '#search': { value: '' }, '#onlyFav': { checked: false } };
  const route = () => ({ codex: state.codex.id, path: state.activePath, q: state.query,
    scope: state.searchScope, favorites: state.favoritesView, siteSearch: state.siteSearchView });
  const window = { scrollY: 320, innerWidth: 1000, setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    addEventListener(type, fn) { const set = listeners.get(type) || new Set(); set.add(fn); listeners.set(type, set); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    scrollTo({ top }) { this.scrollY = top; } };
  const deps = { state, window, document: {}, localStorage: { setItem() {} },
    RECENT_ENTRY_LIMIT: 18, RECENT_STORAGE_KEY: 'recent', LAST_BROWSE_STORAGE_KEY: 'last',
    $: selector => controls[selector] || null, esc: text => text, updateSearchClear() {}, updateScrollProgress() {},
    hasEntryImage: () => false, thumbUrl: () => '', captureAtlasRoute: route,
    getHistoryNavigationVersion: () => version,
    syncUrlState(options) { version++; calls.push({ action: 'route', options }); },
    normalizeCodexRoutePath: (_, path) => path, firstUnlockedCodex: () => books[0],
    isCodexLocked: () => false, isEntryNsfw: () => false, isNsfwPathSegment: () => false, isR18gEntry: () => false,
    showNsfwLockedHint() {}, showR18gLockedHint() {}, toast() {},
    findCodexMeta: id => books.find(book => book.id === id), fetchCodex: async () => books[0],
    resolveUpdateFilter: (_, value) => value, updateFilterDefinitions: () => [], canonicalizeAtlasFavorite: item => item,
    getBlockingPreferences: () => ({ words: [] }), isContentBlocked: () => false,
    FAVORITES_CODEX_ID: 'favorites', SITE_SEARCH_CODEX_ID: 'site-search', isHistoryRestoreToken: () => true,
    clearTimeout() {} };
  const api = new Function('deps', `with (deps) { ${source}\nreturn {currentBrowseSnapshot,normalizeLastBrowse,resumeLastBrowse,openRecentEntry,restoreBrowseScroll,setHistoryActions};}`)(deps);
  const view = kind => async options => {
    if (options.isCurrent?.() === false) return;
    state.favoritesView = kind === 'favorites'; state.siteSearchView = kind === 'site';
    state.codex = state.favoritesView || state.siteSearchView ? { id: kind } : books.find(book => book.id === options.urlState?.codex) || state.codex;
    const url = options.urlState || {};
    state.query = url.q || ''; state.activePath = url.path || []; state.searchScope = url.scope || 'codex';
    version++; calls.push({ action: kind, options }); options.onViewRendered?.();
  };
  api.setHistoryActions({ loadCodex: async (id, options) => view('load')({ ...options, urlState: { codex: id, ...options.urlState } }),
    openFavoritesView: view('favorites'), openSiteSearchView: view('site'),
    favoritesFolderCode: folder => folder === '_unsorted' ? folder : folder === 'folder-42' ? 'renamed-code' : '',
    updateSearchScopeControl: () => calls.push({ action: 'scope-control', scope: state.searchScope }),
    openEntryDeepLink: (entry, options) => calls.push({ action: 'detail', entry, options }) });
  return { state, books, api, timers, listeners, calls, window, controls,
    navigate() { version++; for (const fn of listeners.get('popstate') || []) fn({}); },
    drain() { while (timers.length) timers.shift().fn(); } };
}
await test('same-book resume restores scope, controls and route together', async () => {
  const f = fixture(); f.state.searchScope = 'site';
  f.state.lastBrowse = f.api.normalizeLastBrowse({ codexId: 'a', q: 'cat', searchScope: 'codex' });
  await f.api.resumeLastBrowse();
  assert.equal(f.state.searchScope, 'codex');
  assert.ok(f.calls.some(call => call.action === 'scope-control' && call.scope === 'codex'));
});
await test('cross-book resume sends the saved scope', async () => {
  const f = fixture(); f.state.lastBrowse = f.api.normalizeLastBrowse({ codexId: 'b', q: 'cat', searchScope: 'codex' });
  await f.api.resumeLastBrowse();
  assert.equal(f.calls.find(call => call.action === 'load').options.urlState.scope, 'codex');
});
await test('favorites resume keeps stable folder, source and sort', async () => {
  const f = fixture(); Object.assign(f.state, { favoritesView: true, favFolder: 'folder-42', favSource: 'b', favSort: 'title' });
  const snapshot = f.api.normalizeLastBrowse(f.api.currentBrowseSnapshot());
  assert.equal(snapshot.favFolder, 'folder-42');
  f.state.lastBrowse = snapshot; f.state.favoritesView = false;
  await f.api.resumeLastBrowse();
  const restored = f.calls.find(call => call.action === 'favorites').options.urlState;
  assert.equal(restored.folderCode, 'renamed-code'); assert.equal(restored.favSource, 'b'); assert.equal(restored.favSort, 'title');
});
for (const [folder, expected] of [['_unsorted', '_unsorted'], ['deleted-folder', '']]) {
  await test('favorites folder fallback: ' + folder, async () => {
    const f = fixture(); f.state.lastBrowse = f.api.normalizeLastBrowse({ codexId: 'a', favoritesView: true, favFolder: folder, folderCode: 'stale-code' });
    await f.api.resumeLastBrowse(); assert.equal(f.calls.find(call => call.action === 'favorites').options.urlState.folderCode, expected);
  });
}
await test('legacy snapshots keep defaults and an older folder code', async () => {
  const f = fixture(); const snapshot = f.api.normalizeLastBrowse({ codexId: 'a', favoritesView: true, folderCode: 'old-code' });
  assert.equal(snapshot.imageIndex, 0); assert.equal(snapshot.favSort, 'recent');
  f.state.lastBrowse = snapshot; await f.api.resumeLastBrowse();
  assert.equal(f.calls.find(call => call.action === 'favorites').options.urlState.folderCode, 'old-code');
});
await test('legacy search without a scope remains a local-book search', async () => {
  const f = fixture(); f.state.lastBrowse = f.api.normalizeLastBrowse({ codexId: 'a', q: 'cat' });
  await f.api.resumeLastBrowse(); assert.equal(f.state.searchScope, 'codex'); assert.equal(f.state.siteSearchView, false);
});
for (const mode of ['failed resume', 'cancelled resume', 'failed recent']) {
  await test(mode + ' preserves the existing favorites controls', async () => {
    const f = fixture(); Object.assign(f.state, { codex: { id: 'favorites' }, favoritesView: true, onlyFav: true });
    f.controls['#onlyFav'].checked = true;
    f.state.lastBrowse = f.api.normalizeLastBrowse({ codexId: 'b', searchScope: 'codex' });
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    f.api.setHistoryActions({ loadCodex: async () => { if (mode === 'cancelled resume') await pending; } });
    const before = { onlyFav: f.state.onlyFav, checked: f.controls['#onlyFav'].checked, filter: f.state.updateFilter };
    const work = mode === 'failed recent' ? f.api.openRecentEntry({ codexId: 'b', entryId: 'b-1' }) : f.api.resumeLastBrowse();
    if (mode === 'cancelled resume') { f.navigate(); release(); }
    await work;
    assert.deepEqual({ onlyFav: f.state.onlyFav, checked: f.controls['#onlyFav'].checked, filter: f.state.updateFilter }, before);
  });
}
for (const mode of ['favorites', 'site']) {
  await test(mode + ' prepares a different base without committing an intermediate view', async () => {
    const f = fixture(); Object.assign(f.state, { codex: { id: 'favorites' }, favoritesView: true, onlyFav: true });
    f.controls['#onlyFav'].checked = true;
    f.state.lastBrowse = f.api.normalizeLastBrowse({ codexId: 'b', favoritesView: mode === 'favorites',
      siteSearchView: mode === 'site', searchScope: mode === 'site' ? 'site' : 'codex', q: mode === 'site' ? 'cat' : '' });
    const before = { codex: f.state.codex.id, onlyFav: f.state.onlyFav, favorites: f.state.favoritesView, checked: f.controls['#onlyFav'].checked };
    let enter, release, preparedOptions;
    const entered = new Promise(resolve => { enter = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const virtual = async options => { preparedOptions = options; enter(); await pending; };
    f.api.setHistoryActions({ openFavoritesView: virtual, openSiteSearchView: virtual });
    const work = f.api.resumeLastBrowse();
    await entered;
    const observed = { codex: f.state.codex.id, onlyFav: f.state.onlyFav, favorites: f.state.favoritesView, checked: f.controls['#onlyFav'].checked };
    f.navigate(); release(); await work;
    assert.deepEqual(observed, before, 'preparing the base must not expose an ordinary book under the old virtual URL');
    assert.equal(f.calls.some(call => call.action === 'load'), false);
    assert.equal(preparedOptions.browseCodexId, 'b');
  });
}
for (const mode of ['favorites', 'site']) {
  await test('browser replay ' + mode + ' keeps base and return context private until the final view', async () => {
    const text = readFileSync(new URL('../site/assets/app.js', import.meta.url), 'utf8');
    const start = text.indexOf('async function applyAtlasHistoryRoute(');
    const body = text.slice(start, text.indexOf('\nsetRouterActions(', start));
    const a = { id: 'a' }, b = { id: 'b' };
    const state = { codex: { id: 'favorites' }, browseCodex: a, favoritesView: true, siteSearchView: false,
      lightbox: { entry: null }, searchReturnPath: ['old-return'] };
    let entered, release, options;
    const entering = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const virtual = async value => { options = value; entered(); await pending; };
    const deps = { state, isHistoryRestoreToken: () => true, findCodexMeta: id => [a, b].find(book => book.id === id),
      codexLoadSeq: 1, pendingCodexLoad: null, cancelCodexSwitch() {}, replaceSkeleton() {},
      isCodexLocked: () => false, firstUnlockedCodex: () => a, searchFilterValues: () => [], requestedUpdateFilter: () => '',
      suppressBrowseStateSave() {}, loadCodex: async () => { state.codex = b; state.browseCodex = b; state.favoritesView = false; },
      openFavoritesView: virtual, openSiteSearchView: virtual, $: () => null, captureAtlasRoute: () => ({ path: [], entry: '' }),
      normalizeCodexRoutePath: (_, path) => path, historyRouteNeedsCanonicalization: () => false };
    const replay = new Function('deps', `with(deps){${body};return applyAtlasHistoryRoute;}`)(deps);
    const work = replay({ codex: 'b', favorites: mode === 'favorites', siteSearch: mode === 'site', searchReturnPath: ['target-return'] });
    await entering;
    const observed = { codex: state.codex.id, browse: state.browseCodex.id, favorites: state.favoritesView, returnPath: state.searchReturnPath };
    release(); await work;
    assert.deepEqual(observed, { codex: 'favorites', browse: 'a', favorites: true, returnPath: ['old-return'] });
    assert.deepEqual({ codex: state.codex.id, browse: state.browseCodex.id, favorites: state.favoritesView, returnPath: state.searchReturnPath },
      observed, 'a virtual action without a rendered-view receipt cannot publish target return state');
    assert.equal(options.browseCodexId, 'b');
  });
}
await test('browser replay invalidates the existing ordinary UI load generation', async () => {
  const text = readFileSync(new URL('../site/assets/app.js', import.meta.url), 'utf8');
  const start = text.indexOf('async function applyAtlasHistoryRoute(');
  const body = text.slice(start, text.indexOf('\nsetRouterActions(', start));
  const a = { id: 'a' }, b = { id: 'b' };
  const state = { codex: a, browseCodex: a, favoritesView: false, siteSearchView: false, activePath: [],
    lightbox: { entry: null }, searchReturnPath: [], allowR18g: false, query: 'dog' };
  const deps = { state, codexLoadSeq: 7, pendingCodexLoad: { seq: 7, meta: b },
    isHistoryRestoreToken: () => true, findCodexMeta: id => [a, b].find(book => book.id === id), isCodexLocked: () => false,
    firstUnlockedCodex: () => a, searchFilterValues: () => [], requestedUpdateFilter: () => '', suppressBrowseStateSave() {},
    cancelCodexSwitch() {}, replaceSkeleton() {}, resolveUpdateFilter: (_, value) => value, updateSearchScopeControl() {},
    normalizeCodexRoutePath: (_, path) => path, isR18gPath: () => false, compileSearchState() {}, $: () => null,
    updateSearchClear() {}, renderTree() {}, applyFilter() {}, captureAtlasRoute: () => ({ path: [], entry: '', q: state.query }),
    historyRouteNeedsCanonicalization: () => false };
  const replay = new Function('deps', `with(deps){${body};return applyAtlasHistoryRoute;}`)(deps);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const priorLoad = pending.then(() => { if (deps.codexLoadSeq === 7) state.codex = b; });
  await replay({ codex: 'a', q: 'cat', path: [] });
  release(); await priorLoad;
  assert.equal(state.codex.id, 'a');
  assert.equal(state.query, 'cat');
  assert.notEqual(deps.codexLoadSeq, 7);
  assert.equal(deps.pendingCodexLoad, null);
});
await test('pack image index survives normalization and restore', async () => {
  const f = fixture(); f.state.lightbox = { entry: { id: 'pack', path: [] }, index: 3 };
  f.state.lastBrowse = f.api.normalizeLastBrowse(f.api.currentBrowseSnapshot()); await f.api.resumeLastBrowse(); f.drain();
  assert.equal(f.calls.find(call => call.action === 'detail').options?.imageIndex, 3);
});
await test('Back and same-route Forward cannot revive a recent detail callback', async () => {
  const f = fixture(); await f.api.openRecentEntry({ codexId: 'a', entryId: 'old', path: [] }, { landOnCard: true });
  const before = f.calls.filter(call => call.action === 'detail').length;
  f.navigate(); f.navigate(); f.drain();
  assert.equal(f.calls.filter(call => call.action === 'detail').length, before);
});
for (const mode of ['recent', 'resume', 'favorites', 'site']) {
  await test('pending ' + mode + ' view cannot commit after Back/Forward ABA', async () => {
    const f = fixture(); let release; const pending = new Promise(resolve => { release = resolve; }); let committed = false;
    const action = async (...args) => { const options = args.at(-1); await pending;
      if (options.isCurrent?.() === false) return; committed = true;
      f.state.codex = f.books[1]; options.onViewRendered?.(); };
    f.api.setHistoryActions({ loadCodex: action, openFavoritesView: action, openSiteSearchView: action });
    f.state.lastBrowse = f.api.normalizeLastBrowse({ codexId: mode === 'recent' || mode === 'resume' ? 'b' : 'a',
      favoritesView: mode === 'favorites', siteSearchView: mode === 'site', searchScope: mode === 'site' ? 'site' : 'codex', q: 'cat', entryId: 'old' });
    const work = mode === 'recent' ? f.api.openRecentEntry({ codexId: 'b', entryId: 'old' }, { landOnCard: true }) : f.api.resumeLastBrowse();
    f.navigate(); f.navigate(); release(); await work; f.drain();
    assert.equal(committed, false); assert.equal(f.calls.some(call => call.action === 'detail'), false);
  });
}
await test('keyboard scroll cancels restore but editable/default-prevented keys do not', () => {
  const f = fixture(); const key = event => { for (const fn of f.listeners.get('keydown') || []) fn(event); };
  f.api.restoreBrowseScroll(500); key({ key: 'Home', target: { closest: () => null } }); f.drain(); assert.equal(f.window.scrollY, 320);
  f.api.restoreBrowseScroll(500); key({ key: 'Home', target: { closest: () => ({}) } }); f.drain(); assert.equal(f.window.scrollY, 500);
  f.window.scrollY = 320; f.api.restoreBrowseScroll(500); key({ key: 'End', defaultPrevented: true }); f.drain(); assert.equal(f.window.scrollY, 500);
});
console.log(JSON.stringify({ cases }, null, 2));
if (cases.some(item => item.status === 'FAIL')) process.exitCode = 1;
else console.log(`history resume: PASS (${cases.length} cases)`);
