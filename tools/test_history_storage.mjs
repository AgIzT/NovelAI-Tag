import assert from 'node:assert/strict';

const toastElement = {
  textContent: '',
  offsetWidth: 1,
  classList: {
    add: () => {},
    remove: () => {},
  },
};

const windowListeners = new Map();
let storageWritesFail = true;
const storageWrites = [];

globalThis.document = {
  documentElement: { scrollHeight: 0 },
  querySelector: selector => selector === '#toast' ? toastElement : null,
};
globalThis.window = {
  scrollY: 42,
  innerHeight: 800,
  setTimeout,
  addEventListener(type, listener) { windowListeners.set(type, listener); },
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

  // pagehide bypasses the trailing debounce, but must honor restore suppression.
  storageWritesFail = false;
  state.lastBrowse = null;
  window.scrollY = 77;
  windowListeners.get('pagehide')?.(new Event('pagehide'));
  assert.equal(state.lastBrowse.scrollY, 77);
  assert.ok(storageWrites.some(([key]) => key === 'fadian-last-browse'));

  // A real wheel/touch gesture cancels the remaining restore retries.
  const queued = [];
  let scrollCalls = 0;
  window.setTimeout = callback => { queued.push(callback); return queued.length; };
  window.scrollTo = ({ top }) => {
    scrollCalls += 1;
    window.scrollY = Math.min(100, top); // layout clamp forces the retry path
  };
  historyModule.restoreBrowseScroll(500);
  queued.shift()?.();
  assert.equal(scrollCalls, 1);
  assert.ok(windowListeners.has('wheel'));
  windowListeners.get('wheel')?.(new Event('wheel'));
  while (queued.length) queued.shift()();
  assert.equal(scrollCalls, 1, 'user input must cancel all pending restore retries');
  assert.equal(windowListeners.has('touchstart'), false);

  const beforeSuppressedPagehide = state.lastBrowse;
  historyModule.suppressBrowseStateSave(1000);
  window.scrollY = 99;
  windowListeners.get('pagehide')?.(new Event('pagehide'));
  assert.strictEqual(state.lastBrowse, beforeSuppressedPagehide);
} finally {
  console.warn = originalWarn;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

console.log('history storage resilience tests passed');
