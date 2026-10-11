/* 原样 store/coordinator，多 renderer + held/query，真实 3 秒 fence 时限。
 * 默认只读生产程序、使用内存存储；可用 --baseline <Git ref> --out output/<file.json> 跑红绿对照。
 * node --experimental-vm-modules tools/test_storage_fence.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { webcrypto, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as v4 from '../site/assets/app/tag-relay-v4.js';

const root = fileURLToPath(new URL('../', import.meta.url)), appDir = path.join(root, 'site/assets/app');
let baseline = '', output = '', only = '';
for (let index = 2; index < process.argv.length; index += 2) {
  if (process.argv[index] === '--baseline') baseline = process.argv[index + 1];
  else if (process.argv[index] === '--out') output = process.argv[index + 1];
  else if (process.argv[index] === '--only') only = process.argv[index + 1];
  else throw new Error('unknown test argument');
}
assert.ok(!baseline || /^[a-zA-Z0-9_./-]+$/.test(baseline));
const sourceCache = new Map();
async function sourceAt(filename) {
  filename = path.resolve(filename);
  if (!sourceCache.has(filename)) {
    const relative = path.relative(root, filename).replaceAll('\\', '/');
    sourceCache.set(filename, baseline ? execFileSync('git', ['show', `${baseline}:${relative}`], { cwd: root, encoding: 'utf8' }) : await fs.readFile(filename, 'utf8'));
  }
  return sourceCache.get(filename);
}
const KEY = v4.TAG_RELAY_STORAGE_KEY, SIGNAL = KEY + ':signal', LOCK = KEY + ':lock', PREFIX = KEY + ':fence:';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Callback 未完成时 query 始终保留 held；同名 exclusive 互斥，shared 兼容，FIFO 排队。
class LockManager {
  held = new Map(); queues = new Map(); queryCount = 0;
  request(clientId, name, options, callback) {
    return new Promise((resolve, reject) => {
      const entry = { clientId, name, mode: options?.mode || 'exclusive', callback, resolve, reject };
      const queue = this.queues.get(name) || []; queue.push(entry); this.queues.set(name, queue); this.pump(name);
    });
  }
  pump(name) {
    const queue = this.queues.get(name) || [];
    while (queue.length) {
      const entry = queue[0], existing = [...this.held.values()].filter(lock => lock.name === name);
      if (existing.length && (entry.mode === 'exclusive' || existing.some(lock => lock.mode === 'exclusive'))) return;
      queue.shift(); const id = Symbol(name); this.held.set(id, { name, mode: entry.mode, clientId: entry.clientId });
      Promise.resolve().then(() => entry.callback()).then(entry.resolve, entry.reject).finally(() => {
        this.held.delete(id); this.pump(name);
      });
      if (entry.mode === 'exclusive') return;
    }
  }
  async query() {
    this.queryCount += 1;
    return { held: [...this.held.values()], pending: [...this.queues.values()].flat().map(({ name, mode, clientId }) => ({ name, mode, clientId })) };
  }
  view(clientId, mode) {
    if (mode === 'none') return undefined;
    return { request: (name, options, callback) => this.request(clientId, name, options, callback),
      ...(mode === 'query' ? { query: () => this.query() } : {}) };
  }
  fences(clientId) { return [...this.held.values()].filter(lock => lock.name.startsWith(PREFIX) && (!clientId || lock.clientId === clientId)); }
}
function target() {
  const handlers = new Map();
  return {
    hidden: false, storageEvents: [],
    addEventListener(type, handler) { handlers.set(type, [...handlers.get(type) || [], handler]); },
    removeEventListener(type, handler) { handlers.set(type, (handlers.get(type) || []).filter(item => item !== handler)); },
    async fire(type, event = {}) {
      if (type === 'storage') this.storageEvents.push(event);
      await Promise.all((handlers.get(type) || []).map(handler => handler(event)));
    },
  };
}
function renderer(id, fixture) {
  const values = new Map(fixture.disk), window = target(), document = target(), deniedReads = new Set();
  const activeTimers = new Map(); let storageDenied = false, reads = 0;
  function propagate(key, oldValue, newValue, clear = false) {
    for (const peer of fixture.peers) if (peer.id !== id) {
      const deliver = async () => {
        if (clear) peer.values.clear();
        else if (newValue === null) peer.values.delete(key);
        else peer.values.set(key, newValue);
        await peer.window.fire('storage', { key, oldValue, newValue, storageArea: peer.storage });
      };
      if (fixture.propagate) setTimeout(() => { void deliver().catch(error => fixture.eventErrors.push(error)); }, fixture.delay);
      else fixture.pendingEvents.push(deliver);
    }
  }
  const storage = {
    getItem(key) {
      reads += 1;
      if (deniedReads.has(key)) { const error = new Error('test storage read denied'); error.name = 'SecurityError'; throw error; }
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      const raw = String(value), oldValue = values.get(key) ?? null;
      values.set(key, raw); fixture.disk.set(key, raw); fixture.writes.push({ page: id, key });
      if (oldValue !== raw) propagate(key, oldValue, raw);
    },
    removeItem(key) {
      const oldValue = values.get(key) ?? null;
      values.delete(key); fixture.disk.delete(key); fixture.writes.push({ page: id, key });
      if (oldValue !== null) propagate(key, oldValue, null);
    },
    clear() {
      const existed = values.size > 0;
      values.clear(); fixture.disk.clear(); fixture.writes.push({ page: id, key: null });
      if (existed) propagate(null, null, null, true);
    },
  };
  const peer = { id, values, window, document, storage, deniedReads, activeTimers,
    denyStorage(value) { storageDenied = value; }, reads: () => reads,
    getStorage() {
      if (storageDenied) { const error = new Error('test storage access denied'); error.name = 'SecurityError'; throw error; }
      return storage;
    },
    setTimeout(callback, delay, ...args) {
      const handle = setTimeout(() => { activeTimers.delete(handle); callback(...args); }, delay);
      activeTimers.set(handle, delay); return handle;
    },
    clearTimeout(handle) { activeTimers.delete(handle); clearTimeout(handle); },
  };
  fixture.peers.push(peer); return peer;
}
async function page(peer, locks, mode) {
  const context = vm.createContext({ navigator: { locks: locks.view(peer.id, mode) }, crypto: webcrypto,
    structuredClone, setTimeout: peer.setTimeout, clearTimeout: peer.clearTimeout,
    console, URL, window: peer.window, document: peer.document });
  Object.defineProperty(context, 'localStorage', { get: peer.getStorage });
  const cache = new Map();
  async function moduleAt(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename);
    const body = path.basename(filename) === 'feedback.js' ? 'export function toast() {}' : await sourceAt(filename);
    const module = new vm.SourceTextModule(body, { context, identifier: filename }); cache.set(filename, module); return module;
  }
  const module = await moduleAt(path.join(appDir, 'tag-relay-store.js'));
  await module.link((specifier, importing) => moduleAt(path.resolve(path.dirname(importing.identifier), specifier)));
  await module.evaluate(); await module.namespace.setupRelayStore();
  return { ...peer, store: module.namespace };
}
async function fixture(options = {}) {
  const f = { disk: new Map([[KEY, JSON.stringify(v4.createRelayState({ planName: 'Base' }))]]),
    peers: [], writes: [], pendingEvents: [], eventErrors: [], locks: new LockManager(),
    delay: options.delay ?? 10, propagate: options.propagate ?? true };
  const [peerA, peerB] = [renderer('A', f), renderer('B', f)];
  [f.a, f.b] = await Promise.all([page(peerA, f.locks, options.mode || 'query'), page(peerB, f.locks, options.mode || 'query')]);
  f.settle = () => pause(f.delay + 20);
  f.deliver = async () => { for (const deliver of f.pendingEvents.splice(0)) await deliver(); };
  f.close = async () => {
    await f.a.window.fire('pagehide'); await f.b.window.fire('pagehide'); await f.settle();
    assert.equal(f.locks.fences().length, 0, '测试结束必须释放所有隔离页面 fence');
    assert.equal(f.a.activeTimers.size + f.b.activeTimers.size, 0, 'pagehide 必须取消 observer，不能留测试计时器');
    assert.equal(f.eventErrors.length, 0, 'storage 监听不得向全局抛错');
  };
  return f;
}
async function useFixture(options, run) {
  const f = await fixture(options);
  try { return await run(f); } finally { await f.close(); }
}
async function save(f, page, label) {
  const started = Date.now(), before = f.writes.length; let invoked = 0;
  const result = await page.store.commitRelay(next => { invoked += 1; return v4.createPlan(next, label); }, { changed: 'plan' });
  return { ok: result.ok, reason: result.reason || null, elapsedMs: Date.now() - started,
    invoked, writes: f.writes.length - before, error: result.error?.message || null };
}
function savedNames(f) { return JSON.parse(f.disk.get(KEY)).plans.map(plan => plan.name); }
function assertTimeout(result) {
  assert.equal(result.ok, false); assert.equal(result.reason, 'lock');
  assert.equal(result.invoked, 0); assert.equal(result.writes, 0);
  assert.ok(result.elapsedMs >= 2900, '保留生产 3 秒 fence 等待，不能通过缩短时限掩盖屏障失效');
}

const cases = [
  ['other page clear restores both writers', () => useFixture({}, async f => {
    assert.equal((await save(f, f.a, 'first')).ok, true); await f.settle();
    f.b.storage.clear(); await f.settle();
    const owner = await save(f, f.a, 'owner-after-clear'); assert.equal(owner.ok, true);
    await f.settle(); const other = await save(f, f.b, 'other-after-clear'); assert.equal(other.ok, true);
    assert.ok(savedNames(f).includes('owner-after-clear')); assert.ok(savedNames(f).includes('other-after-clear'));
    return { owner, other };
  })],
  ['other page signal removal restores both writers', () => useFixture({}, async f => {
    assert.equal((await save(f, f.a, 'first')).ok, true); await f.settle();
    f.b.storage.removeItem(SIGNAL); await f.settle();
    const owner = await save(f, f.a, 'owner-after-signal-removal'); assert.equal(owner.ok, true);
    await f.settle(); const other = await save(f, f.b, 'other-after-signal-removal'); assert.equal(other.ok, true);
    assert.ok(savedNames(f).includes('first')); assert.ok(savedNames(f).includes('owner-after-signal-removal'));
    return { owner, other };
  })],
  ['same page clear, idle owner, peer commits first', () => useFixture({}, async f => {
    assert.equal((await save(f, f.a, 'first')).ok, true); await f.settle();
    const ownEvents = f.a.window.storageEvents.length;
    f.a.storage.clear();
    assert.equal(f.a.window.storageEvents.length, ownEvents, '同页 clear 不能伪造本页 storage 事件');
    await f.settle(); // 先让 peer 看见 reset；不能拿尚未传播的旧主键/旧 signal 当本场景。
    const other = await save(f, f.b, 'peer-after-owner-local-clear'); assert.equal(other.ok, true);
    await f.settle(); const owner = await save(f, f.a, 'owner-after-peer'); assert.equal(owner.ok, true);
    assert.ok(savedNames(f).includes('peer-after-owner-local-clear')); assert.ok(savedNames(f).includes('owner-after-peer'));
    assert.ok(!savedNames(f).includes('first'), '已传播的 clear 不能复活清空前的旧方案');
    return { ownStorageEventOnClear: false, other, owner };
  })],
  ['main key only removal keeps usable signal', () => useFixture({}, async f => {
    assert.equal((await save(f, f.a, 'first')).ok, true); await f.settle();
    f.b.storage.removeItem(KEY); await f.settle();
    assert.equal(f.locks.fences('A').length, 1);
    assert.ok(f.a.storage.getItem(SIGNAL));
    const owner = await save(f, f.a, 'fresh-after-main-removal'); assert.equal(owner.ok, true);
    return { owner };
  })],
  ['queued writers after local clear preserve both commits', () => useFixture({ delay: 75 }, async f => {
    assert.equal((await save(f, f.a, 'first')).ok, true); await f.settle();
    let release, entered;
    const entry = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
    const occupying = f.locks.request('test', LOCK, { mode: 'exclusive' }, async () => { entered(); await held; });
    await entry;
    const ownerPromise = save(f, f.a, 'queued-owner'), otherPromise = save(f, f.b, 'queued-peer');
    f.a.storage.clear(); await f.settle(); release(); await occupying;
    const [owner, other] = await Promise.all([ownerPromise, otherPromise]);
    assert.equal(owner.ok, true); assert.equal(other.ok, true);
    assert.ok(savedNames(f).includes('queued-owner')); assert.ok(savedNames(f).includes('queued-peer'));
    return { owner, other };
  })],
  ['foreign fence blocks a stale renderer for production deadline', () => useFixture({ propagate: false }, async f => {
    assert.equal((await save(f, f.a, 'foreign-success')).ok, true);
    assert.equal(f.b.storage.getItem(SIGNAL), null);
    const blocked = await save(f, f.b, 'must-not-write-stale'); assertTimeout(blocked);
    assert.equal(f.locks.fences('A').length, 1, '不能释放/忽略 foreign writer 的提交标记');
    await f.deliver();
    const recovered = await save(f, f.b, 'fresh-after-propagation'); assert.equal(recovered.ok, true);
    assert.ok(savedNames(f).includes('foreign-success')); assert.ok(savedNames(f).includes('fresh-after-propagation'));
    assert.ok(!savedNames(f).includes('must-not-write-stale'));
    return { blocked, recovered };
  })],
  ['observer read failure retains own fence until readable absence', () => useFixture({}, async f => {
    assert.equal((await save(f, f.a, 'first')).ok, true); await f.settle();
    f.a.deniedReads.add(SIGNAL); f.a.storage.removeItem(SIGNAL); await f.settle(); await pause(300);
    assert.equal(f.locks.fences('A').length, 1, '读失败不能被 observer 当成缺键释放');
    const owner = await save(f, f.a, 'read-denied'); assert.equal(owner.ok, false); assert.equal(owner.invoked, 0); assert.equal(owner.writes, 0);
    const peer = await save(f, f.b, 'must-wait-for-denied-owner'); assertTimeout(peer);
    assert.equal(f.locks.fences('A').length, 1);
    f.a.deniedReads.clear(); await pause(300);
    const recovered = await save(f, f.b, 'recovered-readable-reset'); assert.equal(recovered.ok, true);
    return { owner, peer, recovered };
  })],
  ['storage getter throws safely without mutating', () => useFixture({}, async f => {
    assert.equal((await save(f, f.a, 'first')).ok, true); await f.settle();
    f.a.denyStorage(true);
    const rejected = await save(f, f.a, 'must-not-write');
    assert.equal(rejected.ok, false); assert.equal(rejected.invoked, 0); assert.equal(rejected.writes, 0);
    await pause(300); assert.equal(f.locks.fences('A').length, 1, '既有 handle 能读到正常 signal 时仍保留有效标记');
    f.a.denyStorage(false); const recovered = await save(f, f.a, 'access-recovered'); assert.equal(recovered.ok, true);
    return { rejected, recovered };
  })],
  ['hidden keeps a valid fence, pagehide cancels its observer', () => useFixture({}, async f => {
    assert.equal((await save(f, f.a, 'first')).ok, true); await f.settle();
    f.a.document.hidden = true; await f.a.document.fire('visibilitychange'); await pause(300);
    assert.equal(f.locks.fences('A').length, 1, 'hidden 不能丢掉仍有效的提交传播屏障');
    await f.a.window.fire('pagehide'); await f.settle();
    assert.equal(f.locks.fences('A').length, 0); assert.equal(f.a.activeTimers.size, 0);
    const reads = f.a.reads(); await pause(300); assert.equal(f.a.reads(), reads, 'pagehide 后 observer 必须停止读取');
    const other = await save(f, f.b, 'after-owner-pagehide'); assert.equal(other.ok, true);
    return { other };
  })],
  ['old deletion and unrelated storage events cannot drop current fence', () => useFixture({}, async f => {
    assert.equal((await save(f, f.a, 'first')).ok, true); await f.settle();
    await f.a.window.fire('storage', { key: SIGNAL, newValue: null, storageArea: f.a.storage });
    await f.a.window.fire('storage', { key: null, newValue: null, storageArea: {} });
    await pause(300);
    assert.equal(f.locks.fences('A').length, 1, '实际 signal 非缺失，旧删除事件与 sessionStorage 事件均不能释放');
    return { retainedFence: true };
  })],
  ...['not-json', JSON.stringify({ epoch: 1, nonce: 'different-nonce', committed: true })].map(raw =>
    ['non-null invalid/replaced signal must not release fence: ' + raw, () => useFixture({}, async f => {
      assert.equal((await save(f, f.a, 'first')).ok, true); await f.settle();
      const original = f.a.storage.getItem(SIGNAL); f.b.storage.setItem(SIGNAL, raw); await f.settle(); await pause(300);
      assert.equal(f.locks.fences('A').length, 1);
      const blocked = await save(f, f.a, 'must-not-write-unconfirmed-marker'); assertTimeout(blocked);
      assert.equal(f.locks.fences('A').length, 1);
      f.b.storage.setItem(SIGNAL, original); await f.settle();
      const recovered = await save(f, f.a, 'marker-restored'); assert.equal(recovered.ok, true);
      return { blocked, recovered };
    })]),
  ...['no-query', 'none'].map(mode => ['fallback clear without fencing: ' + mode, () => useFixture({ mode }, async f => {
    assert.equal((await save(f, f.a, 'first')).ok, true); await f.settle(); assert.equal(f.locks.fences().length, 0);
    f.b.storage.clear(); await f.settle(); const owner = await save(f, f.a, 'owner'); assert.equal(owner.ok, true);
    await f.settle(); const other = await save(f, f.b, 'peer'); assert.equal(other.ok, true); assert.equal(f.locks.fences().length, 0);
    return { owner, other };
  })]),
];
const results = [];
for (const [name, run] of cases.filter(([name]) => !only || name.includes(only))) {
  const started = Date.now();
  try { const evidence = await run(); results.push({ name, ok: true, elapsedMs: Date.now() - started, evidence }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, ok: false, elapsedMs: Date.now() - started, error: error.stack }); console.error('FAIL ' + name + ': ' + error.message); }
}
assert.ok(results.length, '没有命中的 fence 回归');
const hashes = {};
for (const name of ['tag-relay-store.js', 'storage-coordinator.js']) hashes[name] = createHash('sha256').update(await sourceAt(path.join(appDir, name))).digest('hex');
if (output) {
  const destination = path.resolve(root, output);
  assert.ok(destination.startsWith(path.join(root, 'output') + path.sep), '输出仅限工作树 output/');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, JSON.stringify({ source: baseline || 'working tree', hashes, results }, null, 2) + '\n');
}
assert.ok(results.every(result => result.ok), `storage fence regressions: ${results.filter(result => !result.ok).length} failed`);
console.log('storage fence regressions: all passed');
