import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCommunityFavoritesStore } from '../site/assets/community/favorites.js';
import { loadFavoritesTestModules } from './favorites-library-test-loader.mjs';

const KEY = 'community-favorites-v1';
const LIBRARY = 'fadian-favs-v2';
const SIGNAL = LIBRARY + ':signal';
class MemoryStorage {
  values = new Map(); writes = []; beforeRead; beforeWrite;
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  getItem(key) { this.beforeRead?.(key); return this.values.get(key) ?? null; }
  setItem(key, value) { this.beforeWrite?.(key, value); this.values.set(key, String(value)); this.writes.push(key); }
  removeItem(key) { this.values.delete(key); }
}
const quota = () => Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
const make = storage => createCommunityFavoritesStore({ getStorage: () => storage, getLocks: () => null, eventTarget: null });
const entry = id => ({ id });

// 旧版 loader 把数字 ID 转成字符串；读取仅归一内存，下次锁内提交才写规范数组。
{
  const raw = '[ 123, "123", 0, "0", 456, "legacy", 456 ]';
  const disk = new MemoryStorage({ [KEY]: raw });
  const store = make(disk);
  assert.equal(store.getFavoritesIssue(), null);
  assert.deepEqual([...store.reloadFavorites()], ['123', '0', '456', 'legacy']);
  assert.equal(store.isFavorite(entry(123)), true);
  assert.equal(store.isFavorite(entry('0')), true);
  assert.equal(disk.getItem(KEY), raw, '读取不能提前改写旧收藏原字节');
  assert.deepEqual(disk.writes, []);
  assert.equal((await store.toggleFavorite(entry(123))).active, false);
  assert.deepEqual(JSON.parse(disk.getItem(KEY)), ['0', '456', 'legacy']);
  assert.equal((await store.toggleFavorite(entry('new'))).active, true);
  assert.deepEqual(JSON.parse(disk.getItem(KEY)), ['0', '456', 'legacy', 'new']);
}

// 旧数字的规范化与新星标属于同一事务；任何失败保留旧数组及信号原字节。
for (const failureKey of [KEY, SIGNAL]) {
  for (const silent of [false, true]) {
    const raw = '[ 123, "123", 0, "old" ]';
    const disk = new MemoryStorage({ [KEY]: raw, [SIGNAL]: 'previous-signal' });
    const store = make(disk);
    const actualSet = disk.setItem.bind(disk);
    disk.setItem = (key, value) => {
      if (key === failureKey) {
        if (silent) return;
        throw quota();
      }
      actualSet(key, value);
    };
    assert.equal((await store.toggleFavorite(entry('new'))).ok, false);
    assert.equal(store.isFavorite(entry('new')), false);
    assert.equal(store.isFavorite(entry('123')), true);
    assert.equal(disk.getItem(KEY), raw);
    assert.equal(disk.getItem(SIGNAL), 'previous-signal');
    disk.setItem = actualSet;
    assert.equal((await store.toggleFavorite(entry('new'))).ok, true);
    assert.deepEqual(JSON.parse(disk.getItem(KEY)), ['123', '0', 'old', 'new']);
  }
}
// 最新底本读取、事务原值读取、写后回读的异常均不得留下半规范化的旧数据。
for (const failureKey of [KEY, SIGNAL]) {
  for (const readNumber of [1, 2, 3]) {
    const raw = '[ 123, "123", 0, "old" ]';
    const disk = new MemoryStorage({ [KEY]: raw, [SIGNAL]: 'previous-signal' });
    const store = make(disk);
    let reads = 0;
    disk.beforeRead = key => {
      if (key === failureKey && ++reads === readNumber) throw new DOMException('blocked', 'SecurityError');
    };
    assert.equal((await store.toggleFavorite(entry('new'))).ok, false);
    assert.equal(store.isFavorite(entry('new')), false);
    assert.equal(store.isFavorite(entry('123')), true);
    assert.equal(disk.values.get(KEY), raw);
    assert.equal(disk.values.get(SIGNAL), 'previous-signal');
    disk.beforeRead = null;
    assert.equal((await store.toggleFavorite(entry('new'))).ok, true);
    assert.deepEqual(JSON.parse(disk.getItem(KEY)), ['123', '0', 'old', 'new']);
  }
}

// 闭包过时也只能修改当前盘中一个星标；社区操作不改主图鉴库。
const shared = new MemoryStorage({ [KEY]: '["original"]' });
const a = make(shared), b = make(shared);
assert.equal((await a.toggleFavorite(entry('A'))).ok, true);
assert.equal((await b.toggleFavorite(entry('B'))).ok, true);
assert.deepEqual(JSON.parse(shared.getItem(KEY)), ['original', 'A', 'B']);
assert.ok(!shared.writes.includes(LIBRARY));
const legacyLatest = new MemoryStorage({ [KEY]: '[123,"old"]' });
const staleLegacy = make(legacyLatest);
legacyLatest.setItem(KEY, '[ 123, "123", 456, "later" ]');
assert.equal((await staleLegacy.toggleFavorite(entry('new'))).ok, true);
assert.deepEqual(JSON.parse(legacyLatest.getItem(KEY)), ['123', '456', 'later', 'new'], '规范化必须基于锁内最新底本');

// 配额、静默丢写和信号失败均不能发布假成功，且原数据按字节保留。
for (const failureKey of [KEY, SIGNAL]) {
  const disk = new MemoryStorage({ [KEY]: '[ "original" ]', [SIGNAL]: 'previous-signal' });
  const store = make(disk);
  disk.beforeWrite = key => { if (key === failureKey) throw quota(); };
  assert.equal((await store.toggleFavorite(entry('lost'))).ok, false);
  assert.equal(store.isFavorite(entry('lost')), false);
  assert.equal(disk.getItem(KEY), '[ "original" ]');
  assert.equal(disk.getItem(SIGNAL), 'previous-signal');
  disk.beforeWrite = null;
  assert.equal((await store.toggleFavorite(entry('saved'))).ok, true);
  assert.deepEqual(JSON.parse(disk.getItem(KEY)), ['original', 'saved']);
}
const dropped = new MemoryStorage({ [KEY]: '["original"]' });
const droppedStore = make(dropped);
const actualSet = dropped.setItem.bind(dropped);
dropped.setItem = (key, value) => { if (key !== KEY) actualSet(key, value); };
assert.equal((await droppedStore.toggleFavorite(entry('lost'))).ok, false);
assert.equal(droppedStore.isFavorite(entry('lost')), false);

// 首读/重新读取失败均保留原数据；恢复权限后的下一笔先重读，不以空集覆盖。
for (const initiallyBlocked of [false, true]) {
  const disk = new MemoryStorage({ [KEY]: '["original"]' });
  let denied = initiallyBlocked;
  disk.beforeRead = key => { if (denied && key === KEY) throw new DOMException('blocked', 'SecurityError'); };
  const store = make(disk);
  denied = true;
  store.reloadFavorites();
  assert.equal(store.isFavorite(entry('original')), !initiallyBlocked);
  assert.equal((await store.toggleFavorite(entry('new'))).ok, false);
  assert.equal(disk.values.get(KEY), '["original"]');
  denied = false;
  assert.equal((await store.toggleFavorite(entry('new'))).ok, true);
  assert.deepEqual(JSON.parse(disk.getItem(KEY)), ['original', 'new']);
}
for (const raw of ['{broken', '{"version":2,"favorites":["old"]}', '["old",null]', '[123,{}]', '[123,[]]', '[123,true]', '[1e400]']) {
  const disk = new MemoryStorage({ [KEY]: raw });
  assert.equal((await make(disk).toggleFavorite(entry('new'))).reason, 'corrupt');
  assert.equal(disk.getItem(KEY), raw);
}

class Locks {
  queues = new Map(); held = new Map();
  request(name, options, callback) {
    const operation = (this.queues.get(name) || Promise.resolve()).then(async () => {
      const id = Symbol(name); this.held.set(id, { name, mode: options.mode });
      try { return await callback(); } finally { this.held.delete(id); }
    });
    this.queues.set(name, operation.catch(() => {}));
    return operation;
  }
  async query() { return { held: [...this.held.values()] }; }
}
class Events {
  handlers = new Map();
  addEventListener(name, handler) { this.handlers.set(name, [...(this.handlers.get(name) || []), handler]); }
  fire(name, event) { for (const handler of this.handlers.get(name) || []) handler(event); }
}
const locks = new Locks(), disk = new Map([[KEY, '[123,"123","original"]']]), caches = [], events = [];
function renderer() {
  const storage = new MemoryStorage(Object.fromEntries(disk));
  caches.push(storage);
  storage.setItem = (key, value) => {
    storage.values.set(key, String(value)); disk.set(key, String(value));
    for (const peer of caches) if (peer !== storage) setTimeout(() => peer.values.set(key, String(value)), 35);
  };
  const eventTarget = new Events(); events.push(eventTarget);
  return { storage, eventTarget, getStorage: () => storage, getLocks: () => locks };
}
// Web Locks 串行但缓存尚未传播：两次成功必须都存住。
const rendererA = renderer(), rendererB = renderer();
const pageA = createCommunityFavoritesStore(rendererA), pageB = createCommunityFavoritesStore(rendererB);
assert.ok((await Promise.all([pageA.toggleFavorite(entry('A')), pageB.toggleFavorite(entry('B'))])).every(result => result.ok));
assert.deepEqual(JSON.parse(disk.get(KEY)), ['123', 'original', 'A', 'B']);
await new Promise(resolve => setTimeout(resolve, 45));
// 备份恢复的社区副写与社区按钮同锁：并发合并不丢任一来源，单星标仍不写atlas。
const { store: libraryStore, library } = await loadFavoritesTestModules();
const backupPage = renderer();
const atlas = libraryStore.createLibraryStore({ ...backupPage, notify() {}, getCodexes: () => [] });
assert.ok((await Promise.all([
  atlas.commitLibrary(next => library.addLibraryItem(next, 'alpha:kept'), { companionWrites: () => [{
    key: KEY, value: JSON.stringify([...new Set([...JSON.parse(backupPage.storage.getItem(KEY)), 'backup'])]),
  }] }),
  pageA.toggleFavorite(entry('during-backup')),
])).every(result => result.ok));
assert.deepEqual(JSON.parse(disk.get(KEY)), ['123', 'original', 'A', 'B', 'backup', 'during-backup']);
for (const target of events) target.fire('pagehide', {});
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(locks.held.size, 0);

// UI 等待确认：重复点击仅一笔，失败无成功提示或重绘，下一次可正常重试。
const uiRaw = await readFile(new URL('../site/assets/community/ui.js', import.meta.url), 'utf8');
let release, calls = 0, redraws = 0, histories = 0;
const messages = [];
globalThis.__communityFavoriteUI = {
  favoriteKey: entry => entry.id,
  toggleFavorite: () => { calls++; return new Promise(resolve => { release = resolve; }); },
  toast: (...args) => messages.push(args),
  redraw: () => { redraws++; }, history: () => { histories++; },
};
let source = uiRaw.replace(/^import[\s\S]*?;\r?\n/gm, '');
source = source.replace('    updateFavoriteButton();', '    globalThis.__communityFavoriteUI.redraw();')
  .replace('    applyCommunityFilters();', '    globalThis.__communityFavoriteUI.redraw();');
source = `const { favoriteKey, toggleFavorite, toast } = globalThis.__communityFavoriteUI;
const syncCommunityHistory = globalThis.__communityFavoriteUI.history;
${source}\nexport { handleToggleFavorite };`;
const ui = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const click = ui.handleToggleFavorite(entry('x'));
await ui.handleToggleFavorite(entry('x'));
assert.equal(calls, 1);
assert.equal(messages.length, 0);
release({ ok: false, reason: 'quota' }); await click;
assert.equal(messages.length, 1); assert.match(messages[0][0], /收藏未保存/);
assert.equal(redraws, 0); assert.equal(histories, 0);
const retry = ui.handleToggleFavorite(entry('x'));
release({ ok: true, active: true }); await retry;
assert.equal(messages.at(-1)[0], '已收藏'); assert.equal(redraws, 2); assert.equal(histories, 1);
delete globalThis.__communityFavoriteUI;
console.log('community favorites: legacy scalar IDs, atomic normalization, latest-base, renderer fence, backup coordination, failures, read protection and UI passed');
