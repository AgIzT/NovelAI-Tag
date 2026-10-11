/* UUID 不可用时验证原生产协调器与四种真实 store，所有写入只进内存夹具。 */
import assert from 'node:assert/strict';
import { createStorageCoordinator, writeStorageTransaction } from '../site/assets/app/storage-coordinator.js';
import * as relayCore from '../site/assets/app/tag-relay-v4.js';

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalWindow = globalThis.window, originalDocument = globalThis.document, originalStorage = globalThis.localStorage;
const originalTimer = globalThis.setTimeout, originalWarn = console.warn;
let serial = 0, passed = 0;
const failures = [];
const modes = ['normal', 'missing-method', 'missing-crypto', 'call-denied', 'crypto-getter-denied', 'uuid-getter-denied'];
const paths = ['short', 'web-query', 'web-no-query'];
function setCrypto(mode) {
  const denied = () => { throw new DOMException('UUID access denied', 'SecurityError'); };
  let value = mode === 'missing-crypto' ? undefined : mode === 'normal' ? { randomUUID() { return 'uuid-normal'; } } : {};
  if (mode === 'call-denied') value.randomUUID = denied;
  if (mode === 'uuid-getter-denied') Object.defineProperty(value, 'randomUUID', { get: denied });
  Object.defineProperty(globalThis, 'crypto', mode === 'crypto-getter-denied'
    ? { configurable: true, get: denied } : { configurable: true, value });
}
function storage() {
  const values = new Map(), writes = [];
  return { values, writes, getItem: key => values.get(key) ?? null,
    setItem(key, value) { writes.push({ key, value: String(value) }); values.set(key, String(value)); },
    removeItem: key => values.delete(key) };
}
function locks(path) {
  if (path === 'short') return null;
  const held = new Map(), queues = new Map();
  const manager = { request(name, options, callback) {
    const operation = (queues.get(name) || Promise.resolve()).then(async () => {
      const id = Symbol(name); held.set(id, { name, mode: options.mode });
      try { return await callback(); } finally { held.delete(id); }
    });
    queues.set(name, operation.catch(() => {})); return operation;
  } };
  if (path === 'web-query') manager.query = async () => ({ held: [...held.values()], pending: [] });
  return manager;
}
function events() {
  const handlers = new Map();
  return { addEventListener(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
    removeEventListener() {}, fire(name, event = {}) { for (const handler of handlers.get(name) || []) handler(event); } };
}
function element() {
  return { children: [], textContent: '', classList: { add() {}, remove() {}, toggle() {} }, contains: () => false,
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, focus() {},
    replaceChildren(...items) { this.children = items; }, appendChild(item) { this.children.push(item); } };
}
function globals(disk, manager, target) {
  globalThis.localStorage = disk; globalThis.window = target;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: manager } });
  const toast = element();
  globalThis.document = { activeElement: null, querySelector: key => key === '#toast' ? toast : null, createElement: element };
}
async function test(name, operation) {
  try { await operation(); passed += 1; }
  catch (error) { failures.push({ name, error }); console.error(`FAIL ${name}: ${error.stack}`); }
}
globalThis.setTimeout = (callback, ms, ...args) => { const timer = originalTimer(callback, ms, ...args); timer.unref(); return timer; };
console.warn = () => {};
try {
  for (const mode of modes) for (const path of paths) {
    await test(`coordinator ${mode} ${path}`, async () => {
      setCrypto(mode);
      const disk = storage(), manager = locks(path), target = events();
      const coordinator = createStorageCoordinator({ lockKey: 'uuid-test:lock', signalKey: 'uuid-test:signal',
        getStorage: () => disk, getLocks: () => manager, eventTarget: target });
      let calls = 0, observedFence;
      try {
        const result = await coordinator.run((current, fence) => {
          calls += 1; observedFence = fence;
          const saved = writeStorageTransaction(current, [{ key: 'document', value: 'saved' },
            { key: 'uuid-test:signal', value: JSON.stringify({ ...(fence || {}) }) }]);
          return { ...saved, written: saved.ok };
        });
        assert.equal(result.ok, true); assert.equal(calls, 1); assert.equal(disk.getItem('document'), 'saved');
        if (path === 'short') {
          const owner = JSON.parse(disk.writes.find(write => write.key === 'uuid-test:lock').value).token;
          assert.ok(owner); if (mode === 'normal') assert.equal(owner, 'uuid-normal');
          else assert.match(owner, /^local-/);
        } else if (path === 'web-query') {
          assert.ok(observedFence.nonce); if (mode === 'normal') assert.equal(observedFence.nonce, 'uuid-normal');
          else assert.match(observedFence.nonce, /^local-/);
        }
      } finally { coordinator.release(); }
    });
    for (const consumer of ['relay', 'favorites-library', 'community', 'content-blocking']) {
      await test(`${consumer} ${mode} ${path}`, async () => {
        setCrypto(mode);
        const disk = storage(), manager = locks(path), target = events(); globals(disk, manager, target);
        try {
          if (consumer === 'relay') {
            const store = await import(`../site/assets/app/tag-relay-store.js?uuid-fallback=${++serial}`);
            assert.equal((await store.initializeRelay()).ok, true);
            for (let index = 0; index < 2; index += 1) {
              const result = await store.commitRelay(next => relayCore.createPlan(next, `saved plan ${index}`), { changed: 'plan' });
              assert.equal(result.ok, true); assert.ok(result.result.id);
              if (mode === 'normal') assert.equal(result.result.id, `plan-uuid-normal${index ? '-2' : ''}`);
            }
            for (let index = 0; index < 2; index += 1) assert.equal((await store.commitRelay(next => relayCore.recordCopyHistory(next, {
              label: `saved output ${index}`, output: { positive: 'prompt', negative: '' },
            }), { changed: 'history' })).ok, true);
            const saved = JSON.parse(disk.getItem(relayCore.TAG_RELAY_STORAGE_KEY));
            assert.equal(saved.plans.length, 3); assert.equal(saved.history.length, 2);
            assert.equal(new Set(saved.plans.map(plan => plan.id)).size, 3);
            assert.equal(new Set(saved.history.map(record => record.id)).size, 2);
            assert.equal(JSON.stringify(store.relayState()), disk.getItem(relayCore.TAG_RELAY_STORAGE_KEY));
          } else if (consumer === 'favorites-library') {
            const core = await import('../site/assets/app/favorites-library-core.js');
            const { createLibraryStore } = await import('../site/assets/app/favorites-library-store.js');
            const store = createLibraryStore({ getStorage: () => disk, getLocks: () => manager, eventTarget: target, notify() {} });
            assert.equal((await store.commitLibrary(next => core.addLibraryItem(next, 'alpha:uuid-saved'))).ok, true);
            assert.ok(store.librarySnapshot().items.some(item => item.key === 'alpha:uuid-saved'));
            assert.ok(JSON.parse(disk.getItem(core.FAVORITES_LIBRARY_STORAGE_KEY)).items.some(item => item.key === 'alpha:uuid-saved'));
          } else if (consumer === 'community') {
            const { createCommunityFavoritesStore } = await import('../site/assets/community/favorites.js');
            const store = createCommunityFavoritesStore({ getStorage: () => disk, getLocks: () => manager, eventTarget: target });
            assert.equal((await store.toggleFavorite({ id: 'uuid-saved' })).ok, true);
            assert.equal(store.isFavorite({ id: 'uuid-saved' }), true);
            assert.ok(JSON.parse(disk.getItem('community-favorites-v1')).includes('uuid-saved'));
          } else {
            const store = await import(`../site/assets/app/content-blocking.js?uuid-fallback=${++serial}`);
            store.loadContentBlocking();
            assert.equal((await store.addBlockedWords('uuid-saved-word')).ok, true);
            assert.ok(store.getBlockingPreferences().words.includes('uuid-saved-word'));
            assert.ok([...disk.values].some(([key, value]) => !key.endsWith(':signal') && !key.endsWith(':lock')
              && JSON.parse(value).words?.includes('uuid-saved-word')));
          }
        } finally { target.fire('pagehide'); }
      });
    }
  }
  await test('requested relay IDs retain collision suffixes without crypto access', async () => {
    setCrypto('crypto-getter-denied');
    const next = relayCore.createRelayState();
    assert.equal(relayCore.createPlan(next, 'first', { id: 'explicit' }).id, 'explicit');
    assert.equal(relayCore.createPlan(next, 'second', { id: 'explicit' }).id, 'explicit-2');
  });
} finally {
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto); else delete globalThis.crypto;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
  if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
  if (originalStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = originalStorage;
  globalThis.setTimeout = originalTimer; console.warn = originalWarn;
}
if (failures.length) { console.error(`storage UUID fallback: ${passed} passed, ${failures.length} failed`); process.exitCode = 1; }
else console.log(`storage UUID fallback: ${passed} cases passed`);
