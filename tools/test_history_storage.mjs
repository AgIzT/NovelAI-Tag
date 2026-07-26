import assert from 'node:assert/strict';

const toastElement = {
  textContent: '',
  offsetWidth: 1,
  classList: {
    add: () => {},
    remove: () => {},
  },
};

globalThis.document = {
  documentElement: { scrollHeight: 0 },
  querySelector: selector => selector === '#toast' ? toastElement : null,
};
globalThis.window = {
  scrollY: 42,
  innerHeight: 800,
  setTimeout,
};
globalThis.location = {
  hostname: 'localhost',
  origin: 'http://localhost',
  protocol: 'http:',
};
globalThis.localStorage = {
  setItem() {
    throw new DOMException('storage unavailable', 'QuotaExceededError');
  },
};

const [{ state }, historyModule, favoritesModule] = await Promise.all([
  import('../site/assets/app/state.js'),
  import('../site/assets/app/history.js'),
  import('../site/assets/app/favorites.js'),
]);

state.codex = { id: 'test-codex', title: 'Test Codex' };
state.codexes = [{ id: 'test-codex', title: 'Test Codex' }];
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
} finally {
  console.warn = originalWarn;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

console.log('history storage resilience tests passed');
