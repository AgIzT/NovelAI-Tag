import assert from 'node:assert/strict';

const toastElement = {
  textContent: '',
  children: [],
  offsetWidth: 1,
  classList: {
    add: () => {},
    remove: () => {},
    toggle: () => {},
  },
  replaceChildren() { this.children = []; },
  appendChild(child) { this.children.push(child); },
  querySelector: () => null,
  setAttribute: () => {},
  removeAttribute: () => {},
};

const windowListeners = new Map();
let storageWritesFail = true;
const storageWrites = [];

globalThis.document = {
  documentElement: { scrollHeight: 0 },
  querySelector: selector => selector === '#toast' ? toastElement : null,
  createElement: tag => ({ tagName: tag.toUpperCase(), className: '', textContent: '' }),
};
globalThis.window = {
  scrollY: 42,
  innerHeight: 800,
  setTimeout,
  addEventListener(type, listener) { windowListeners.set(type, listener); },
  dispatchEvent() { return true; },
  removeEventListener(type, listener) {
    if (windowListeners.get(type) === listener) windowListeners.delete(type);
  },
  scrollTo({ top }) { this.scrollY = top; },
};
globalThis.location = {
  hostname: 'localhost',
  origin: 'http://localhost',
  protocol: 'http:',
};
globalThis.localStorage = {
  getItem() { return null; },
  setItem(key, value) {
    if (storageWritesFail) throw new DOMException('storage unavailable', 'QuotaExceededError');
    storageWrites.push([key, value]);
  },
};

const [{ state }, historyModule, favoritesModule] = await Promise.all([
  import('../site/assets/app/state.js'),
  import('../site/assets/app/history.js'),
  import('../site/assets/app/favorites.js'),
]);

state.codex = { id: 'test-codex', title: 'Test Codex' };
state.codexes = [
  { id: 'test-codex', title: 'Test Codex' },
  { id: 'adult-codex', title: 'Adult Codex', nsfw: true },
];
state.recentEntries = [];
state.favs = new Set();

const warnings = [];
const originalWarn = console.warn;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
console.warn = (...args) => { warnings.push(args); };
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};

try {
  // 历史记录即使是旧 shape，也必须从法典元数据、rating / level 与 string path
  // 推导访问权限；关闭开关后不能把标题或缩略图重新渲染出来。
  state.allowNsfw = false;
  state.allowR18g = false;
  const [codexAdult, ratingAdult, r18gPath] = historyModule.normalizeRecentEntries([
    { codexId: 'adult-codex', entryId: 'meta', title: 'Meta adult', path: [] },
    { codexId: 'test-codex', entryId: 'rating', title: 'Rating adult', rating: 'restricted', path: [] },
    { codexId: 'test-codex', entryId: 'path', title: 'Path adult', path: 'R18G' },
  ]);
  assert.equal(historyModule.isHistoryItemLocked(codexAdult), 'nsfw');
  assert.equal(historyModule.isHistoryItemLocked(ratingAdult), 'nsfw');
  assert.deepEqual(r18gPath.path, ['R18G']);
  assert.equal(historyModule.isHistoryItemLocked(r18gPath), 'r18g');

  const legacyBrowse = historyModule.normalizeLastBrowse({
    codexId: 'test-codex',
    codexTitle: 'Secret route',
    path: 'NSFW-限制级别',
    at: Date.now(),
  });
  assert.equal(historyModule.isHistoryItemLocked(legacyBrowse), 'nsfw');
  assert.match(historyModule.browseDesc(legacyBrowse), /限制级内容/);

  const entrySnapshot = historyModule.currentBrowseSnapshot('entry-adult', {
    id: 'entry-adult',
    title: 'Rating adult',
    rating: 'restricted',
    path: ['NSFW'],
  });
  assert.equal(entrySnapshot.access.nsfw, true);
  assert.equal(historyModule.isHistoryItemLocked(entrySnapshot), 'nsfw');

  assert.doesNotThrow(() => historyModule.recordRecentEntry({
    id: 'entry-1',
    title: 'Entry One',
    path: ['Category'],
  }));
  assert.equal(state.recentEntries[0].entryId, 'entry-1');

  assert.doesNotThrow(() => historyModule.saveBrowseStateNow());
  assert.equal(state.lastBrowse.codexId, 'test-codex');
  assert.equal(state.lastBrowse.scrollY, 42);

  const button = {
    textContent: '',
    title: '',
    classList: { toggle: () => {} },
    setAttribute: () => {},
  };
  assert.doesNotThrow(() => favoritesModule.toggleFav({ id: 'entry-1', title: 'Entry One' }, button));
  assert.equal(state.favs.has('test-codex:entry-1'), true);

  assert.deepEqual(
    warnings.map(args => args[0]),
    [
      '[history] 无法保存最近浏览记录',
      '[history] 无法保存浏览位置',
      '[favorites] 无法保存收藏',
    ],
  );

  // pagehide bypasses the trailing debounce, but must honor restore suppression.
  storageWritesFail = false;
  state.lastBrowse = null;
  window.scrollY = 77;
  windowListeners.get('pagehide')?.(new Event('pagehide'));
  assert.equal(state.lastBrowse.scrollY, 77);
  assert.ok(storageWrites.some(([key]) => key === 'fadian-last-browse'));

  // A real wheel/touch scroll cancels restoration both before its delayed first
  // scroll and between retries. A plain touchstart is not a scroll intent.
  const queued = [];
  let scrollCalls = 0;
  window.setTimeout = callback => { queued.push(callback); return queued.length; };
  window.scrollTo = ({ top }) => {
    scrollCalls += 1;
    window.scrollY = Math.min(100, top); // layout clamp forces the retry path
  };
  historyModule.restoreBrowseScroll(500);
  assert.ok(windowListeners.has('wheel'));
  assert.ok(windowListeners.has('touchmove'));
  assert.equal(windowListeners.has('touchstart'), false);
  windowListeners.get('touchstart')?.(new Event('touchstart'));
  queued.shift()?.();
  assert.equal(scrollCalls, 1);
  assert.ok(windowListeners.has('wheel'));
  assert.ok(windowListeners.has('touchmove'));
  windowListeners.get('touchmove')?.(new Event('touchmove'));
  while (queued.length) queued.shift()();
  assert.equal(scrollCalls, 1, 'user input must cancel all pending restore retries');
  assert.equal(windowListeners.has('wheel'), false);
  assert.equal(windowListeners.has('touchmove'), false);

  historyModule.restoreBrowseScroll(500);
  windowListeners.get('wheel')?.(new Event('wheel'));
  while (queued.length) queued.shift()();
  assert.equal(scrollCalls, 1, 'wheel before the first scroll must cancel restoration');

  historyModule.restoreBrowseScroll(500);
  windowListeners.get('touchmove')?.(new Event('touchmove'));
  while (queued.length) queued.shift()();
  assert.equal(scrollCalls, 1, 'touchmove before the first scroll must cancel restoration');

  // A second restore supersedes the first without creating an unguarded input
  // window before either delayed callback runs.
  historyModule.restoreBrowseScroll(500);
  historyModule.restoreBrowseScroll(600);
  windowListeners.get('wheel')?.(new Event('wheel'));
  while (queued.length) queued.shift()();
  assert.equal(scrollCalls, 1, 'input must cancel the newest overlapping restore');

  const beforeSuppressedPagehide = state.lastBrowse;
  historyModule.suppressBrowseStateSave(1000);
  window.scrollY = 99;
  windowListeners.get('pagehide')?.(new Event('pagehide'));
  assert.strictEqual(state.lastBrowse, beforeSuppressedPagehide);

  // 并册后：继续浏览与最近浏览的同书快速路径、跨书加载路径都保留原来源。
  state.suppressUrlSync = true;
  const merged = {
    id: 'artist_nai45_personal', aliases: ['artist_nai45_strings'], title: '合并画师词典',
    tree: [{ name: '画师串词典', children: [{ name: 'W.O.F_画风', children: [] }] }],
  };
  state.codexes = [merged];
  state.codex = merged;
  state.browseCodex = merged;
  state.favoritesView = false;
  state.siteSearchView = false;
  state.lastBrowse = { codexId: 'artist_nai45_strings', path: ['W.O.F_画风'], q: '', entryId: 'wof-1' };
  await historyModule.resumeLastBrowse();
  assert.deepEqual(state.activePath, ['画师串词典', 'W.O.F_画风']);
  const recent = { codexId: 'artist_nai45_strings', path: ['W.O.F_画风'], entryId: 'wof-1' };
  state.activePath = [];
  await historyModule.openRecentEntry(recent);
  assert.deepEqual(state.activePath, ['画师串词典', 'W.O.F_画风']);
  const loads = [];
  historyModule.setHistoryActions({ loadCodex: async (id, options) => loads.push({ id, options }) });
  state.codex = { id: 'another' };
  await historyModule.resumeLastBrowse();
  await historyModule.openRecentEntry(recent);
  assert.equal(loads.length, 2);
  for (const { id, options } of loads) {
    assert.equal(id, merged.id);
    assert.equal(options.urlState.codex, 'artist_nai45_strings');
    assert.deepEqual(options.urlState.path, ['W.O.F_画风']);
  }
} finally {
  console.warn = originalWarn;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

console.log('history storage resilience tests passed');
