/* 原生产 store 的补偿失败边界：结果不确定时本页拒绝重复提交，真实重载再读盘。 */
import assert from 'node:assert/strict';
import * as core from '../site/assets/app/tag-relay-v4.js';
import * as legacy from '../site/assets/app/tag-relay-core.js';
import { writeStorageTransaction } from '../site/assets/app/storage-coordinator.js';

const KEY = core.TAG_RELAY_STORAGE_KEY, SIGNAL = `${KEY}:signal`;
const originalTimer = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => {
  const timer = originalTimer(callback, delay, ...args); timer.unref(); return timer;
};
const previousWarn = console.warn;
console.warn = () => {};
let serial = 0;
const failures = [];
function element() {
  return { children: [], textContent: '', classList: { add() {}, remove() {}, toggle() {} },
    contains: () => false, setAttribute() {}, removeAttribute() {}, addEventListener() {}, focus() {},
    replaceChildren(...children) { this.children = children; }, appendChild(child) { this.children.push(child); } };
}
async function fixture({ seed = new Map([[KEY, core.serializeRelayState(core.createRelayState())]]),
  quotaFirst = false, failRollback = true, initialize = true } = {}) {
  const values = new Map(seed), oldMain = values.get(KEY) ?? null, writes = [], handlers = new Map(), toast = element();
  const signalError = Object.assign(new Error('signal rejected'), { name: 'SecurityError' });
  const rollbackError = Object.assign(new Error('rollback rejected'), { name: 'SecurityError' });
  let fault = true, failed = false, quota = quotaFirst, tail = Promise.resolve();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      const text = String(value); writes.push({ method: 'setItem', key, value: text });
      if (fault && key === KEY && quota) {
        quota = false; throw Object.assign(new Error('quota first attempt'), { name: 'QuotaExceededError' });
      }
      if (fault && key === SIGNAL) { failed = true; throw signalError; }
      if (fault && failed && failRollback && key === KEY && text === oldMain) throw rollbackError;
      values.set(key, text);
    },
    removeItem(key) {
      writes.push({ method: 'removeItem', key });
      if (fault && failed && failRollback && key === KEY && oldMain === null) throw rollbackError;
      values.delete(key);
    },
  };
  globalThis.localStorage = storage;
  globalThis.document = { activeElement: null, querySelector: selector => selector === '#toast' ? toast : null, createElement: element };
  globalThis.window = { addEventListener(type, callback) { const list = handlers.get(type) || []; list.push(callback); handlers.set(type, list); }, removeEventListener() {} };
  // A serialized async lock queue exercises calls already waiting when rollback becomes uncertain.
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
    request(name, options, callback) { const operation = tail.then(callback); tail = operation.catch(() => {}); return operation; },
  } } });
  const store = await import(`../site/assets/app/tag-relay-store.js?rollback=${++serial}`), events = [];
  store.subscribeRelay((state, meta) => events.push(meta));
  if (initialize) assert.equal((await store.setupRelayStore()).ok, true);
  events.length = 0;
  return { storage, values, writes, store, events, signalError, rollbackError, oldMain,
    clearFault() { fault = false; },
    fire(type, event) { for (const callback of handlers.get(type) || []) callback(event); },
    lastToast: () => toast.children[0]?.textContent,
  };
}
function assertRollback(f, result) {
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rollback');
  assert.equal(result.error, f.signalError, 'original error must survive the public API');
  assert.equal(result.rollbackErrors.length, 1);
  assert.equal(result.rollbackErrors[0].key, KEY);
  assert.equal(result.rollbackErrors[0].error, f.rollbackError);
  assert.equal(f.store.getRelayStorageIssue(), 'rollback');
}
async function assertLocked(f, result, mutate) {
  const memory = JSON.stringify(f.store.relayState()), disk = f.values.get(KEY), count = f.writes.length;
  f.clearFault();
  let called = false;
  const retry = await f.store.commitRelay(next => { called = true; return mutate(next); });
  assertRollback(f, retry);
  assert.equal(retry.error, result.error); assert.equal(retry.rollbackErrors, result.rollbackErrors);
  assertRollback(f, await f.store.initializeRelay());
  assertRollback(f, await f.store.setupRelayStore());
  f.fire('pageshow', { persisted: true });
  for (const key of [KEY, SIGNAL, null, ...core.TAG_RELAY_LEGACY_STORAGE_KEYS]) {
    f.fire('storage', { key, storageArea: f.storage, newValue: JSON.stringify({ committed: true, changed: 'all' }) });
  }
  await new Promise(resolve => originalTimer(resolve, 5));
  assert.equal(called, false, 'locked pages must not rerun non-idempotent mutations');
  assert.equal(f.writes.length, count, 'locked pages must not even write lock or signal keys');
  assert.equal(f.values.get(KEY), disk);
  assert.equal(JSON.stringify(f.store.relayState()), memory);
  assert.equal(f.store.getRelayStorageIssue(), 'rollback');
  assert.match(f.lastToast(), /保存结果.*重新加载/);
}
async function test(label, run) {
  try { await run(); console.log(`PASS ${label}`); }
  catch (error) { failures.push({ label, error }); console.error(`FAIL ${label}: ${error.stack}`); }
}

await test('helper reports uncertain rollback metadata', async () => {
  const f = await fixture();
  const result = writeStorageTransaction(f.storage, [{ key: KEY, value: 'new bytes' }, { key: SIGNAL, value: 'signal' }]);
  assert.equal(result.reason, 'rollback'); assert.equal(result.error, f.signalError);
  assert.equal(result.rollbackErrors[0].key, KEY); assert.equal(result.rollbackErrors[0].error, f.rollbackError);
  assert.equal(f.values.get(KEY), 'new bytes');
});
// The helper alone does not set the store issue; check its own metadata separately.
// Store cases below prove the latching/public API contract.

await test('createPlan cannot duplicate after uncertain save', async () => {
  const f = await fixture();
  const mutate = next => core.createPlan(next, 'One intended plan');
  const first = await f.store.commitRelay(mutate, { changed: 'plan' });
  assertRollback(f, first);
  assert.equal(f.store.relayState().plans.length, 1); assert.equal(JSON.parse(f.values.get(KEY)).plans.length, 2);
  assert.equal(f.events.at(-1).issue, 'rollback');
  await assertLocked(f, first, mutate);
});
await test('recordCopyHistory cannot duplicate after uncertain save', async () => {
  const f = await fixture();
  const mutate = next => core.recordCopyHistory(next, { label: 'One intended copy', output: { positive: 'one prompt', negative: '' } });
  const first = await f.store.commitRelay(mutate, { changed: 'history' });
  assertRollback(f, first);
  assert.equal(f.store.relayState().history.length, 0); assert.equal(JSON.parse(f.values.get(KEY)).history.length, 1);
  await assertLocked(f, first, mutate);
});
await test('initialize plus draft retry cannot turn own save into conflict', async () => {
  const f = await fixture(), plan = structuredClone(core.getActivePlan(f.store.relayState()));
  plan.positive.text = 'edited prompt';
  const mutate = next => core.replacePlanText(next, plan.id, plan, { expectedRevision: plan.revision });
  const first = await f.store.commitRelay(mutate, { changed: 'plan', planId: plan.id, revision: plan.revision });
  assertRollback(f, first);
  assert.equal(f.store.relayState().plans[0].revision, 0); assert.equal(JSON.parse(f.values.get(KEY)).plans[0].revision, 1);
  await assertLocked(f, first, mutate);
});
await test('queued mutation sees rollback gate inside acquired lock', async () => {
  const f = await fixture();
  let firstCalls = 0, secondCalls = 0;
  const first = f.store.commitRelay(next => { firstCalls += 1; return core.createPlan(next, 'first'); });
  const second = f.store.commitRelay(next => { secondCalls += 1; return core.createPlan(next, 'queued'); });
  assertRollback(f, await first); assertRollback(f, await second);
  assert.equal(firstCalls, 1); assert.equal(secondCalls, 0);
  assert.equal(JSON.parse(f.values.get(KEY)).plans.length, 2);
});
await test('quota trim retry retains rollback cause instead of quota', async () => {
  const initial = core.createRelayState(); initial.plans[0].positive.text = 'saved prompt';
  for (let index = 0; index < 4; index += 1) core.recordCopyHistory(initial, {
    label: `old history ${index}`, output: { positive: 'large output '.repeat(250), negative: '' },
  });
  const f = await fixture({ seed: new Map([[KEY, core.serializeRelayState(initial)]]), quotaFirst: true });
  const first = await f.store.commitRelay(next => core.createPlan(next, 'trim retry'), { changed: 'plan' });
  assertRollback(f, first); assert.ok(first.trimmed > 0);
  await assertLocked(f, first, next => core.createPlan(next, 'trim retry'));
});
for (const trigger of ['initialize', 'commit']) await test(`legacy ${trigger} preserves rollback instead of migration-save`, async () => {
  const old = legacy.createRelayState(), oldKey = core.TAG_RELAY_LEGACY_STORAGE_KEYS[0], oldBytes = legacy.serializeRelayState(old);
  const f = await fixture({ seed: new Map([[oldKey, oldBytes]]), initialize: false });
  const candidate = JSON.stringify(f.store.relayState());
  const first = trigger === 'initialize' ? await f.store.setupRelayStore()
    : await f.store.commitRelay(next => core.createPlan(next, 'migration mutation'));
  assertRollback(f, first);
  assert.equal(f.values.get(oldKey), oldBytes); assert.equal(JSON.parse(f.values.get(KEY)).version, 4);
  assert.equal(JSON.stringify(f.store.relayState()), candidate);
  await assertLocked(f, first, next => core.createPlan(next, 'migration retry'));
});
await test('successful signal compensation retains ordinary retry behavior', async () => {
  const f = await fixture({ failRollback: false });
  const first = await f.store.commitRelay(next => core.createPlan(next, 'safe retry'));
  assert.equal(first.ok, false); assert.equal(first.reason, 'save');
  assert.equal(f.values.get(KEY), f.oldMain); assert.equal(f.store.getRelayStorageIssue(), null);
  f.clearFault();
  assert.equal((await f.store.commitRelay(next => core.createPlan(next, 'safe retry'))).ok, true);
  assert.equal(JSON.parse(f.values.get(KEY)).plans.filter(plan => plan.name === 'safe retry').length, 1);
});
await test('fresh module after page reload reads persisted result and accepts new work', async () => {
  const f = await fixture();
  assertRollback(f, await f.store.commitRelay(next => core.createPlan(next, 'uncertain first')));
  f.clearFault();
  const fresh = await import(`../site/assets/app/tag-relay-store.js?reload=${++serial}`);
  assert.equal((await fresh.initializeRelay()).ok, true); assert.equal(fresh.getRelayStorageIssue(), null);
  assert.equal(fresh.relayState().plans.filter(plan => plan.name === 'uncertain first').length, 1);
  assert.equal((await fresh.commitRelay(next => core.createPlan(next, 'new work after reload'))).ok, true);
});

console.warn = previousWarn;
globalThis.setTimeout = originalTimer;
if (failures.length) { console.error(`${failures.length} rollback cases failed`); process.exitCode = 1; }
else console.log('tag relay rollback: all tests passed');
