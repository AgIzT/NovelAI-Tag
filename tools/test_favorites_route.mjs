import assert from 'node:assert/strict';

// DOM 只提供路由所需环境；router / state / path-code / browser-history 都使用真实模块。
const nullElement = { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.location = new URL('http://localhost/');
globalThis.document = {
  baseURI: 'http://localhost/', title: '',
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
  documentElement: nullElement,
  addEventListener() {},
};
class TestHistory {
  constructor(win) { this.win = win; this.entries = [{ state: null, url: '/' }]; this.index = 0; }
  get state() { return this.entries[this.index].state; }
  get length() { return this.entries.length; }
  setLocation(url) { if (url !== undefined) globalThis.location = new URL(url, 'http://localhost'); }
  replaceState(state, _, url) {
    this.entries[this.index] = { state: structuredClone(state), url: url ?? this.entries[this.index].url };
    this.setLocation(url);
  }
  pushState(state, _, url) {
    this.entries.splice(this.index + 1);
    this.entries.push({ state: structuredClone(state), url: url ?? this.entries[this.index].url });
    this.index++;
    this.setLocation(url);
  }
  back() { this.go(-1); }
  forward() { this.go(1); }
  go(step) {
    const index = this.index + step;
    if (index < 0 || index >= this.entries.length) return;
    this.index = index;
    this.setLocation(this.entries[this.index].url);
    const event = new Event('popstate');
    Object.defineProperty(event, 'state', { value: structuredClone(this.state) });
    this.win.dispatchEvent(event);
  }
}
class TestWindow extends EventTarget {
  constructor() {
    super();
    this.scrollY = 240;
    this.setTimeout = setTimeout;
    this.clearTimeout = clearTimeout;
    this.queueMicrotask = queueMicrotask;
    this.history = new TestHistory(this);
  }
}
globalThis.window = new TestWindow();
const [{ state }, router, paths, history] = await Promise.all([
  import('../site/assets/app/state.js'),
  import('../site/assets/app/router.js'),
  import('../site/assets/app/path-code.js'),
  import('../site/assets/app/browser-history.js'),
]);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const routeUrl = route => new URL(router.atlasUrlForRoute(route), 'http://localhost');
const baseRoute = { codex: 'book', favorites: false, siteSearch: false, scope: 'codex', path: [], q: '', searchFilters: [], entry: '' };
const folderNames = ['画风参考', '角色 / 服装', '参考 & 图片', '雨天🎨', 'CaseSensitive'];
for (const name of folderNames) {
  const code = paths.encodePathCode([name]);
  const url = routeUrl({ ...baseRoute, favorites: true, folderCode: code, path: ['旧来源', '旧分类'] });
  assert.equal(url.searchParams.get('fav'), '1');
  assert.equal(url.searchParams.get('fd'), code);
  assert.equal(url.searchParams.has('p'), false);
  assert.equal(url.searchParams.has('path'), false);
  globalThis.location = url;
  const parsed = router.readUrlState();
  assert.equal(parsed.favorites, true);
  assert.equal(parsed.folderCode, code);
  assert.equal(parsed.pathCode, '');
  assert.deepEqual(paths.pathFromCode([{ name, children: [] }], parsed.folderCode), [name],
    '文件夹名作为单段编码，名称中的 / 不能变成嵌套目录');
}
assert.notEqual(paths.encodePathCode(['画风', '参考']), paths.encodePathCode(['画风/参考']));
assert.notEqual(paths.encodePathCode(['name']), paths.encodePathCode(['Name']));
const unsorted = routeUrl({ ...baseRoute, favorites: true, folderCode: '_unsorted' });
assert.equal(unsorted.searchParams.get('fd'), '_unsorted');
globalThis.location = unsorted;
assert.equal(router.readUrlState().folderCode, '_unsorted');
assert.equal(routeUrl({ ...baseRoute, favorites: true, folderCode: '' }).searchParams.has('fd'), false);

// 旧收藏链接仍可读，但下一次 URL 写回移除目录参数；目录不得限制收藏夹视图。
for (const prefix of ['fav=1&c=book', 'view=favorites&codex=book', 'codex=favorites']) {
  globalThis.location = new URL('http://localhost/?' + prefix + '&p=legacy-code&path=old&path=child');
  const parsed = router.readUrlState();
  assert.equal(parsed.favorites, true);
  const canonical = routeUrl(parsed);
  assert.equal(canonical.searchParams.get('fav'), '1');
  assert.equal(canonical.searchParams.has('p'), false);
  assert.equal(canonical.searchParams.has('path'), false);
  assert.equal(canonical.searchParams.has('fd'), false);
}
const directory = ['原目录', '子目录/字面斜线'];
const normal = routeUrl({ ...baseRoute, path: directory, folderCode: 'private-folder' });
assert.equal(normal.searchParams.get('p'), paths.encodePathCode(directory));
assert.equal(normal.searchParams.has('fd'), false, '非收藏视图不能泄露残留夹子参数');
globalThis.location = normal;
assert.equal(router.readUrlState().pathCode, paths.encodePathCode(directory));
const favoriteDetail = routeUrl({
  ...baseRoute, favorites: true, folderCode: '_unsorted', entry: 'entry-a',
  favSource: 'source-book', favSort: 'title',
});
assert.equal(favoriteDetail.pathname, '/', '私人收藏详情保留查询串路由');
assert.equal(favoriteDetail.searchParams.get('entry'), 'entry-a');
assert.equal(favoriteDetail.searchParams.has('favSource'), false);
assert.equal(favoriteDetail.searchParams.has('favSort'), false);

// 路由 capture 通过注入取编码，来源与排序留在 history.state；主图鉴沿用旧字段形状。
Object.assign(state, {
  codex: { id: 'favorites', entries: [] }, browseCodex: { id: 'book' },
  favoritesView: true, siteSearchView: false, searchScope: 'codex',
  query: '  artist  ', activePath: [], searchReturnPath: ['原目录'],
  searchFilterValues: ['has:image'], updateFilter: '', favSource: 'source-book', favSort: 'oldest',
});
state.lightbox.entry = null;
state.lightbox.index = 2;
let activeFolderCode = paths.encodePathCode(['画风参考']);
let applyCalls = 0;
router.setRouterActions({
  favoritesFolderCode: () => activeFolderCode,
  applyHistoryRoute: async route => {
    applyCalls++;
    state.favoritesView = Boolean(route.favorites);
    state.siteSearchView = Boolean(route.siteSearch);
    state.codex = { id: route.favorites ? 'favorites' : route.codex, entries: [] };
    state.browseCodex = { id: route.codex };
    state.activePath = [...(route.path || [])];
    state.searchReturnPath = [...(route.searchReturnPath || [])];
    state.query = route.q;
    state.searchFilterValues = [...(route.searchFilters || [])];
    state.favSource = route.favSource || '';
    state.favSort = route.favSort || 'recent';
    activeFolderCode = route.folderCode || '';
  },
  restoreHistoryScroll: async top => { window.scrollY = top; },
});
const captured = router.captureAtlasRoute();
assert.equal(captured.codex, 'book');
assert.equal(captured.folderCode, activeFolderCode);
assert.equal(captured.favSource, 'source-book');
assert.equal(captured.favSort, 'oldest');
assert.equal(captured.q, 'artist');
state.searchReturnPath.push('随后修改');
assert.deepEqual(captured.searchReturnPath, ['原目录']);
state.searchReturnPath = ['原目录'];
state.favoritesView = false;
state.codex = { id: 'book', entries: [] };
for (const siteSearch of [false, true]) {
  state.siteSearchView = siteSearch;
  const ordinary = router.captureAtlasRoute();
  for (const key of ['folderCode', 'favFolder', 'favSource', 'favSort']) {
    assert.equal(Object.hasOwn(ordinary, key), false, '旧路由不附带收藏私有字段：' + key);
  }
}
state.siteSearchView = false;
state.query = '';
state.searchFilterValues = [];
state.searchReturnPath = [];

// 首次进入收藏 push；同一收藏会话换夹 replace，并保留来源与排序到真实托管栈。
router.configureAtlasHistory();
const initial = router.initializeAtlasHistory(router.captureAtlasRoute());
const initialRoute = structuredClone(initial.route);
state.favoritesView = true;
state.codex = { id: 'favorites', entries: [] };
state.favSource = 'source-book';
state.favSort = 'title';
router.syncUrlState({ historyMode: 'push', saveBrowse: false });
const favoriteEntry = history.getManagedHistoryEntry();
assert.equal(window.history.length, 2);
assert.equal(favoriteEntry.parentId, initial.id);
assert.equal(favoriteEntry.route.folderCode, activeFolderCode);
activeFolderCode = '_unsorted';
router.syncUrlState({ historyMode: 'replace', saveBrowse: false });
assert.equal(window.history.length, 2);
assert.equal(history.getManagedHistoryEntry().id, favoriteEntry.id);
assert.equal(history.getManagedHistoryEntry().route.folderCode, '_unsorted');
assert.equal(location.search.includes('fd=_unsorted'), true);
assert.equal(history.getManagedHistoryEntry().route.favSource, 'source-book');
assert.equal(history.getManagedHistoryEntry().route.favSort, 'title');

// 抽屉、选择模式、整理面板逐层 Back 只关浮层，不重放列表或丢失收藏上下文。
const layers = ['favoritesDrawer', 'favoritesSelection', 'favoritesOrganize'];
const open = new Set();
for (const id of layers) {
  history.registerHistoryLayer(id, {
    isOpen: () => open.has(id),
    open: () => open.add(id),
    close: () => open.delete(id),
  });
  open.add(id);
  history.openHistoryLayer(id);
}
assert.deepEqual(history.getManagedHistoryEntry().layers.map(layer => layer.id), layers);
const callsBefore = applyCalls;
for (let index = layers.length - 1; index >= 0; index--) {
  window.history.back();
  await tick();
  assert.equal(open.has(layers[index]), false);
  assert.equal(applyCalls, callsBefore, '只关闭收藏浮层不能重新应用 route');
  assert.equal(history.getManagedHistoryEntry().route.folderCode, '_unsorted');
  assert.equal(history.getManagedHistoryEntry().route.favSource, 'source-book');
  assert.equal(history.getManagedHistoryEntry().route.favSort, 'title');
}
assert.equal(history.getManagedHistoryEntry().id, favoriteEntry.id);
window.history.back();
await tick();
assert.equal(history.getManagedHistoryEntry().id, initial.id);
assert.deepEqual(history.getManagedHistoryEntry().route, initialRoute);
assert.equal(state.favoritesView, false);
window.history.forward();
await tick();
assert.equal(state.favoritesView, true);
assert.equal(history.getManagedHistoryEntry().route.folderCode, '_unsorted');
assert.equal(history.getManagedHistoryEntry().route.favSource, 'source-book');
assert.equal(history.getManagedHistoryEntry().route.favSort, 'title');
console.log('favorites route: folder codes, legacy paths, private capture and layered history passed');
