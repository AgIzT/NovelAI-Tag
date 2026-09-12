import assert from 'node:assert/strict';
import { loadFavoritesTestModules } from './favorites-library-test-loader.mjs';
const { library, store: module } = await loadFavoritesTestModules();
const { FAVORITES_LIBRARY_STORAGE_KEY: KEY, normalizeLibrary, addLibraryItem, createFolder, libraryKeys } = library;
const { createLibraryStore, LIBRARY_LOCK_KEY, LIBRARY_SIGNAL_KEY } = module;
const V1 = 'fadian-favs';
const COMMUNITY = 'community-favorites-v1';
class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); this.writes = []; this.beforeWrite = null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.beforeWrite?.(key, value); this.writes.push([key, value]); this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
class EventTarget {
  handlers = new Map();
  addEventListener(name, handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name).push(handler);
  }
  fire(name, event) { for (const handler of this.handlers.get(name) || []) handler(event); }
}
const quota = () => Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
const codexes = [{ id: 'alpha', aliases: ['old_alpha'] }];
const make = (storage = new MemoryStorage(), extra = {}) => {
  const events = new EventTarget(), notices = [], broadcasts = [];
  const instance = createLibraryStore({
    getStorage: () => storage, getLocks: () => null, getCodexes: () => codexes,
    eventTarget: events, notify: (...args) => notices.push(args),
    emitFavoritesChanged: (...args) => broadcasts.push(args), ...extra,
  });
  return { ...instance, storage, events, notices, broadcasts };
};
const raw = (keys = ['alpha:original']) => JSON.stringify(normalizeLibrary({
  libraryId: 'test-library', updatedAt: '2026-09-12T12:00:00.000Z', migratedFrom: 'v1',
  items: keys.map(key => ({ key, addedAt: null })),
}, { codexes }));
const initial = new MemoryStorage({ [V1]: '["old_alpha:old_alpha-1","alpha:alpha-2"]' });
const migrated = make(initial);
assert.equal((await migrated.ensureLibrary()).ok, true);
assert.deepEqual(libraryKeys(migrated.librarySnapshot()), ['alpha:alpha-1', 'alpha:alpha-2']);
assert.ok(migrated.librarySnapshot().items.every(item => item.addedAt === null && item.importedAt));
const migrationWrites = initial.writes.filter(([key]) => key === KEY);
assert.equal(migrationWrites.length, 1);
assert.equal(JSON.parse(migrationWrites[0][1]).migratedFrom, 'v1');
assert.equal(initial.getItem(V1), JSON.stringify(libraryKeys(migrated.librarySnapshot())));
initial.values.set(V1, '["alpha:stale"]');
await migrated.ensureLibrary();
assert.ok(!libraryKeys(migrated.librarySnapshot()).includes('alpha:stale'), '完成迁移后忽略旧镜像');
const snapshots = [];
migrated.subscribeLibrary((value, meta) => snapshots.push([value, meta]));
const committed = await migrated.commitLibrary(next => {
  createFolder(next, '画风', { id: 'styles' });
  return addLibraryItem(next, 'alpha:new');
});
assert.equal(committed.ok, true);
assert.equal(committed.result.key, 'alpha:new');
assert.deepEqual(migrated.librarySnapshot(), JSON.parse(initial.getItem(KEY)));
assert.equal(snapshots.length, 1);
assert.ok(Object.isFrozen(migrated.librarySnapshot().items));
assert.deepEqual(migrated.broadcasts.at(-1), [['atlas'], 'library']);

const quotaStore = make(new MemoryStorage({ [KEY]: raw() }));
await quotaStore.ensureLibrary();
const before = quotaStore.librarySnapshot();
const beforeRaw = quotaStore.storage.getItem(KEY);
quotaStore.storage.writes.length = 0;
quotaStore.storage.beforeWrite = key => { if (key === KEY) throw quota(); };
const failed = await quotaStore.commitLibrary(next => addLibraryItem(next, 'alpha:no'));
assert.equal(failed.ok, false);
assert.equal(failed.reason, 'quota');
assert.equal(quotaStore.librarySnapshot(), before);
assert.equal(quotaStore.storage.getItem(KEY), beforeRaw);
assert.equal(quotaStore.broadcasts.length, 0);
assert.ok(!quotaStore.storage.writes.some(([key]) => key === LIBRARY_SIGNAL_KEY));
assert.equal(quotaStore.notices.at(-1)[2].label, '备份并清理');
const overBudget = make(new MemoryStorage({ [KEY]: raw() }));
await overBudget.ensureLibrary();
assert.equal((await overBudget.commitLibrary(next => { next.items[0].note = '中'.repeat(800000); })).reason, 'quota');
assert.equal(overBudget.librarySnapshot().items[0].note, '');

const blocked = make(undefined, { getStorage: () => { throw new DOMException('denied', 'SecurityError'); } });
assert.deepEqual(libraryKeys(blocked.librarySnapshot()), []);
assert.equal((await blocked.ensureLibrary()).reason, 'storage');
assert.equal((await blocked.commitLibrary(() => {})).reason, 'storage');
const locked = make(new MemoryStorage({ [KEY]: raw(), [LIBRARY_LOCK_KEY]: JSON.stringify({ token: 'other', expiresAt: Date.now() + 1900 }) }));
assert.equal((await locked.commitLibrary(() => assert.fail('mutator must not run'))).reason, 'lock');
const mutation = make(new MemoryStorage({ [KEY]: raw() }));
const error = new Error('implementation bug');
assert.equal((await mutation.commitLibrary(() => { throw error; })).reason, 'mutator');
assert.notEqual(mutation.notices.at(-1)[0], locked.notices.at(-1)[0]);
assert.notEqual(blocked.notices.at(-1)[0], locked.notices.at(-1)[0]);
assert.equal(mutation.storage.getItem(KEY), raw());

const mirrorFailure = make(new MemoryStorage({ [KEY]: raw() }));
mirrorFailure.storage.beforeWrite = key => { if (key === V1) throw quota(); };
assert.equal((await mirrorFailure.commitLibrary(next => addLibraryItem(next, 'alpha:saved'))).ok, true);
assert.ok(libraryKeys(mirrorFailure.librarySnapshot()).includes('alpha:saved'));
const staleClock = make(new MemoryStorage({ [KEY]: raw(), [LIBRARY_LOCK_KEY]: JSON.stringify({ token: 'old-clock', expiresAt: Date.now() + 3600000 }) }));
assert.equal((await staleClock.commitLibrary(next => addLibraryItem(next, 'alpha:clock'))).ok, true);

const migrationFailure = make(new MemoryStorage({ [V1]: '["alpha:old"]' }));
let mainWrites = 0;
migrationFailure.storage.beforeWrite = key => { if (key === KEY && ++mainWrites === 1) throw quota(); };
const oldSnapshot = migrationFailure.librarySnapshot();
assert.equal((await migrationFailure.ensureLibrary()).reason, 'quota');
assert.equal(migrationFailure.librarySnapshot(), oldSnapshot);
assert.equal(migrationFailure.storage.getItem(KEY), null, '迁移原子写失败不留下半成品');
assert.equal(migrationFailure.storage.getItem(V1), '["alpha:old"]');
assert.equal(migrationFailure.broadcasts.length, 0);
migrationFailure.storage.beforeWrite = null;
const restarted = make(migrationFailure.storage);
assert.equal((await restarted.ensureLibrary()).ok, true);
assert.equal(restarted.librarySnapshot().items.length, 1, '重启后迁移不丢收藏');
const crashedDoc = JSON.parse(raw(['alpha:complete-v2']));
delete crashedDoc.migratedFrom;
const crashRestart = make(new MemoryStorage({ [KEY]: JSON.stringify(crashedDoc), [V1]: '["alpha:stale"]' }));
assert.equal((await crashRestart.ensureLibrary()).ok, true);
assert.deepEqual(libraryKeys(crashRestart.librarySnapshot()), ['alpha:complete-v2'], '崩溃留下完整 V2 只补标记');

const corrupt = make(new MemoryStorage({ [KEY]: '{"broken":', [V1]: '["alpha:stale"]' }));
assert.equal((await corrupt.ensureLibrary()).reason, 'corrupt');
assert.equal((await corrupt.commitLibrary(next => addLibraryItem(next, 'alpha:new'))).reason, 'corrupt');
assert.equal(corrupt.storage.getItem(KEY), '{"broken":');
assert.equal(corrupt.storage.getItem(V1), '["alpha:stale"]');
const corruptItem = make(new MemoryStorage({ [KEY]: raw().replace('alpha:original', 'badkey') }));
assert.equal((await corruptItem.commitLibrary(() => {})).reason, 'corrupt');

const cross = make(new MemoryStorage({ [KEY]: raw() }));
await cross.ensureLibrary();
cross.setupLibraryStore();
cross.setupLibraryStore();
const reads = [];
cross.subscribeLibrary((snapshot, meta) => reads.push(meta.source));
cross.storage.values.set(KEY, raw(['alpha:other-tab']));
cross.events.fire('storage', { key: KEY, storageArea: {} });
assert.deepEqual(libraryKeys(cross.librarySnapshot()), ['alpha:original']);
cross.events.fire('storage', { key: LIBRARY_SIGNAL_KEY, storageArea: cross.storage });
cross.events.fire('storage', { key: LIBRARY_LOCK_KEY, storageArea: cross.storage });
cross.events.fire('storage', { key: V1, storageArea: cross.storage });
assert.equal(reads.length, 0);
cross.events.fire('storage', { key: KEY, storageArea: cross.storage });
assert.deepEqual(libraryKeys(cross.librarySnapshot()), ['alpha:other-tab']);
assert.deepEqual(reads, ['storage']);
cross.storage.values.set(KEY, raw(['alpha:back']));
cross.events.fire('pageshow', { persisted: false });
assert.equal(reads.length, 1);
cross.events.fire('pageshow', { persisted: true });
assert.deepEqual(libraryKeys(cross.librarySnapshot()), ['alpha:back']);
cross.storage.values.delete(KEY);
cross.events.fire('storage', { key: null, storageArea: cross.storage });
assert.deepEqual(libraryKeys(cross.librarySnapshot()), [], 'clear 后旧镜像不能复活');

// 任何已采用的 V2 快照都会封死旧镜像读入口，即使未经过 ensure。
const observed = make(new MemoryStorage({ [KEY]: raw(['alpha:current']), [V1]: '["alpha:stale"]' }));
assert.deepEqual(libraryKeys(observed.librarySnapshot()), ['alpha:current']);
observed.storage.values.delete(KEY);
assert.equal((await observed.commitLibrary(next => addLibraryItem(next, 'alpha:new'))).ok, true);
assert.deepEqual(libraryKeys(observed.librarySnapshot()), ['alpha:new']);
const observedEvent = make(new MemoryStorage({ [V1]: '["alpha:stale"]' }));
observedEvent.setupLibraryStore();
observedEvent.storage.values.set(KEY, raw(['alpha:current']));
observedEvent.events.fire('storage', { key: KEY, storageArea: observedEvent.storage });
observedEvent.storage.values.delete(KEY);
observedEvent.events.fire('storage', { key: KEY, storageArea: observedEvent.storage });
assert.deepEqual(libraryKeys(observedEvent.librarySnapshot()), []);
const oversizedRaw = JSON.parse(raw());
oversizedRaw.items = Array.from({ length: 30001 }, (_, index) => ({ key: 'alpha:' + index }));
const oversized = make(new MemoryStorage({ [KEY]: JSON.stringify(oversizedRaw) }));
assert.equal((await oversized.ensureLibrary({ silent: true })).reason, 'corrupt');
assert.equal(JSON.parse(oversized.storage.getItem(KEY)).items.length, 30001);

// 两个独立页面实例同时进入：真正的 Web Locks 保证锁内重读，不受旧快照影响。
let queue = Promise.resolve();
const locks = { request(name, options, callback) {
  const next = queue.then(() => callback());
  queue = next.catch(() => {});
  return next;
} };
const shared = new MemoryStorage({ [KEY]: raw() });
const pageA = make(shared, { getLocks: () => locks });
const pageB = make(shared, { getLocks: () => locks });
pageA.librarySnapshot(); pageB.librarySnapshot();
const concurrent = await Promise.all([
  pageA.commitLibrary(next => addLibraryItem(next, 'alpha:A')),
  pageB.commitLibrary(next => addLibraryItem(next, 'alpha:B')),
]);
assert.ok(concurrent.every(result => result.ok));
assert.deepEqual(libraryKeys(JSON.parse(shared.getItem(KEY))), ['alpha:original', 'alpha:A', 'alpha:B']);
const lockFallback = make(new MemoryStorage({ [KEY]: raw() }), {
  getLocks: () => ({ request: () => Promise.reject(new Error('locks denied')) }),
});
assert.equal((await lockFallback.commitLibrary(next => addLibraryItem(next, 'alpha:fallback'))).ok, true);

// 社区备份与 V2 组成一次提交；主写失败时按原字节恢复社区。
const companion = make(new MemoryStorage({ [KEY]: raw(), [COMMUNITY]: '["before"]' }));
await companion.ensureLibrary();
companion.storage.beforeWrite = key => { if (key === KEY) throw quota(); };
const companionFailed = await companion.commitLibrary(next => addLibraryItem(next, 'alpha:import'), {
  companionWrites: () => [{ key: COMMUNITY, value: '["after"]' }],
});
assert.equal(companionFailed.reason, 'quota');
assert.equal(companion.storage.getItem(COMMUNITY), '["before"]');
assert.equal(companion.storage.getItem(KEY), raw());
companion.storage.beforeWrite = null;
assert.equal((await companion.commitLibrary(next => addLibraryItem(next, 'alpha:import'), {
  companionWrites: [{ key: COMMUNITY, value: '["after"]' }],
})).ok, true);
assert.equal(companion.storage.getItem(COMMUNITY), '["after"]');
const rollbackFail = make(new MemoryStorage({ [KEY]: raw(), [COMMUNITY]: '["before"]' }));
rollbackFail.storage.beforeWrite = (key, value) => {
  if (key === KEY || (key === COMMUNITY && value === '["before"]')) throw quota();
};
assert.equal((await rollbackFail.commitLibrary(() => {}, {
  companionWrites: [{ key: COMMUNITY, value: '["after"]' }],
})).reason, 'rollback');

// 静默丢弃写入也不报成功。
const dropped = make(new MemoryStorage({ [KEY]: raw() }));
const realSet = dropped.storage.setItem.bind(dropped.storage);
dropped.storage.setItem = (key, value) => { if (key !== KEY) realSet(key, value); };
assert.equal((await dropped.commitLibrary(next => addLibraryItem(next, 'alpha:lost'))).reason, 'storage');
assert.deepEqual(libraryKeys(dropped.librarySnapshot()), ['alpha:original']);

// 损坏恢复只允许用户确认过的精确原文，普通提交仍保护原文。
const rescue = make(new MemoryStorage({ [KEY]: '{broken', [V1]: '["alpha:stale"]' }));
assert.equal((await rescue.commitLibrary(next => addLibraryItem(next, 'alpha:no'))).reason, 'corrupt');
assert.equal((await rescue.commitLibrary(next => addLibraryItem(next, 'alpha:restored'), {
  replaceCorrupt: true, expectedCorruptRaw: '{broken',
})).ok, true);
assert.deepEqual(libraryKeys(rescue.librarySnapshot()), ['alpha:restored']);
assert.deepEqual(rescue.librarySnapshot(), JSON.parse(rescue.storage.getItem(KEY)));
const rescueChanged = make(new MemoryStorage({ [KEY]: '{new-corruption' }));
assert.equal((await rescueChanged.commitLibrary(() => assert.fail('不能运行过期恢复'), {
  replaceCorrupt: true, expectedCorruptRaw: '{old-corruption',
})).reason, 'stale');
assert.equal(rescueChanged.storage.getItem(KEY), '{new-corruption');
const alreadyRepaired = make(new MemoryStorage({ [KEY]: raw() }));
assert.equal((await alreadyRepaired.commitLibrary(() => assert.fail('有效库不走损坏替换'), {
  replaceCorrupt: true, expectedCorruptRaw: raw(),
})).reason, 'stale');
assert.equal(alreadyRepaired.storage.getItem(KEY), raw());
const rescueFailure = make(new MemoryStorage({ [KEY]: '{broken', [COMMUNITY]: '["before"]' }));
rescueFailure.storage.beforeWrite = key => { if (key === KEY) throw quota(); };
assert.equal((await rescueFailure.commitLibrary(next => addLibraryItem(next, 'alpha:restored'), {
  replaceCorrupt: true, expectedCorruptRaw: '{broken',
  companionWrites: [{ key: COMMUNITY, value: '["after"]' }],
})).reason, 'quota');
assert.equal(rescueFailure.storage.getItem(KEY), '{broken');
assert.equal(rescueFailure.storage.getItem(COMMUNITY), '["before"]');
assert.equal(rescueFailure.broadcasts.length, 0);
const recoverId = JSON.stringify({ libraryId: 'existing-library', version: 2, broken: true });
const identityRescue = make(new MemoryStorage({ [KEY]: recoverId }));
assert.equal((await identityRescue.commitLibrary(next => addLibraryItem(next, 'alpha:restored'), {
  replaceCorrupt: true, expectedCorruptRaw: recoverId,
})).ok, true);
assert.equal(identityRescue.librarySnapshot().libraryId, 'existing-library');

// 浏览器有独立 renderer 缓存：即使主锁串行，下一页也可能尚未收到上次写入。
class TestLockManager {
  queues = new Map();
  held = new Map();
  rejectFence = false;
  request(name, options, callback) {
    if (this.rejectFence && name.includes(':fence:')) return Promise.reject(new Error('fence denied'));
    const previous = this.queues.get(name) || Promise.resolve();
    const request = previous.then(async () => {
      const token = Symbol(name);
      this.held.set(token, { name, mode: options.mode });
      try { return await callback(); } finally { this.held.delete(token); }
    });
    this.queues.set(name, request.catch(() => {}));
    return request;
  }
  async query() { return { held: [...this.held.values()], pending: [] }; }
}
const browserLocks = new TestLockManager();
const browserDisk = new Map([[KEY, raw()]]);
const rendererCaches = [];
function rendererStorage() {
  const storage = new MemoryStorage(Object.fromEntries(browserDisk));
  rendererCaches.push(storage);
  storage.setItem = (key, value) => {
    storage.beforeWrite?.(key, value);
    storage.values.set(key, String(value));
    browserDisk.set(key, String(value));
    for (const peer of rendererCaches) {
      if (peer === storage) continue;
      setTimeout(() => peer.values.set(key, String(value)), 25);
    }
  };
  return storage;
}
const rendererA = make(rendererStorage(), { getLocks: () => browserLocks });
const rendererB = make(rendererStorage(), { getLocks: () => browserLocks });
const rendererResults = await Promise.all([
  rendererA.commitLibrary(next => createFolder(next, '并发甲')),
  rendererB.commitLibrary(next => createFolder(next, '并发乙')),
]);
assert.ok(rendererResults.every(result => result.ok));
assert.deepEqual(JSON.parse(browserDisk.get(KEY)).folders.map(folder => folder.name), ['并发甲', '并发乙'],
  'Web Lock 内必须等待上一提交信号可见，不能覆盖尚未传播到本页的已成功数据');
assert.equal(browserLocks.held.size, 2, '每个写入页最多保留一个瞬时新鲜度标记');
rendererA.setupLibraryStore(); rendererB.setupLibraryStore();
rendererA.events.fire('pagehide', {}); rendererB.events.fire('pagehide', {});
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(browserLocks.held.size, 0, '离页释放标记');
const fenceUnavailable = new TestLockManager();
fenceUnavailable.rejectFence = true;
const deniedFence = make(new MemoryStorage({ [KEY]: raw() }), { getLocks: () => fenceUnavailable });
assert.equal((await deniedFence.commitLibrary(() => assert.fail('没有屏障不能改写'))).reason, 'lock');
assert.equal(deniedFence.storage.getItem(KEY), raw());
assert.equal(deniedFence.broadcasts.length, 0);

// 信号写入也是事务的一部分；信号失败不可留下“成功主键 + 无可验证屏障”。
const signalFailure = make(new MemoryStorage({ [KEY]: raw(), [COMMUNITY]: '["before"]', [LIBRARY_SIGNAL_KEY]: 'old-signal' }));
await signalFailure.ensureLibrary();
const signalBefore = signalFailure.librarySnapshot();
signalFailure.storage.beforeWrite = (key, value) => { if (key === LIBRARY_SIGNAL_KEY && value !== 'old-signal') throw quota(); };
assert.equal((await signalFailure.commitLibrary(next => addLibraryItem(next, 'alpha:signal-failed'), {
  companionWrites: [{ key: COMMUNITY, value: '["after"]' }],
})).reason, 'quota');
assert.equal(signalFailure.storage.getItem(KEY), raw());
assert.equal(signalFailure.storage.getItem(COMMUNITY), '["before"]');
assert.equal(signalFailure.storage.getItem(LIBRARY_SIGNAL_KEY), 'old-signal');
assert.equal(signalFailure.librarySnapshot(), signalBefore);
assert.equal(signalFailure.broadcasts.length, 0);

console.log('favorites library store: migration, persistence, failures, locks, cross-tab, companion rollback passed');
