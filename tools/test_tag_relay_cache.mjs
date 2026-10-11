/* 两个独立 renderer 缓存 + 真实模块；Web Locks 串行化不等于 localStorage 已传播。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as v4 from '../site/assets/app/tag-relay-v4.js';

const appDir = fileURLToPath(new URL('../site/assets/app/', import.meta.url));
const KEY = v4.TAG_RELAY_STORAGE_KEY;
class TestLockManager {
  queues = new Map(); held = new Map(); starts = [];
  request(name, options, callback) {
    const previous = this.queues.get(name) || Promise.resolve();
    const request = previous.then(async () => {
      assert.ok(![...this.held.values()].some(lock => lock.name === name), '同名锁必须真正互斥');
      const token = Symbol(name); this.held.set(token, { name, mode: options.mode });
      this.starts.push(name);
      try { return await callback(); } finally { this.held.delete(token); }
    });
    this.queues.set(name, request.catch(() => {})); return request;
  }
  async query() { return { held: [...this.held.values()], pending: [] }; }
}
function renderer(browserDisk, peers, delay) {
  const values = new Map(browserDisk), handlers = new Map();
  const target = {
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); },
    removeEventListener(type, fn) { handlers.set(type, (handlers.get(type) || []).filter(item => item !== fn)); },
    fire(type, event) { for (const fn of handlers.get(type) || []) fn(event); },
  };
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      const raw = String(value), previous = values.get(key) ?? null;
      values.set(key, raw); browserDisk.set(key, raw);
      for (const peer of peers) if (peer.storage !== storage) setTimeout(() => {
        peer.values.set(key, raw);
        peer.target.fire('storage', { key, newValue: raw, oldValue: previous, storageArea: peer.storage });
      }, delay);
    },
    removeItem(key) {
      values.delete(key); browserDisk.delete(key);
      for (const peer of peers) if (peer.storage !== storage) setTimeout(() => {
        peer.values.delete(key); peer.target.fire('storage', { key, newValue: null, storageArea: peer.storage });
      }, delay);
    },
  };
  const peer = { storage, values, target }; peers.push(peer); return peer;
}
async function page(peer, locks) {
  const context = vm.createContext({
    localStorage: peer.storage, navigator: { locks }, crypto: webcrypto,
    structuredClone, setTimeout, clearTimeout, console, URL, window: peer.target, document: {},
  });
  const cache = new Map();
  async function moduleAt(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename);
    const source = path.basename(filename) === 'feedback.js' ? 'export function toast() {}' : await fs.readFile(filename, 'utf8');
    const module = new vm.SourceTextModule(source, { context, identifier: filename });
    cache.set(filename, module); return module;
  }
  const store = await moduleAt(path.join(appDir, 'tag-relay-store.js'));
  await store.link((specifier, importing) => moduleAt(path.resolve(path.dirname(importing.identifier), specifier)));
  await store.evaluate();
  await store.namespace.setupRelayStore();
  return { store: store.namespace, core: cache.get(path.join(appDir, 'tag-relay-v4.js')).namespace };
}
async function scenario(kind, delay) {
  const initial = v4.createRelayState({ planName: 'Base' });
  initial.plans[0].positive.text = 'base text';
  const browserDisk = new Map([[KEY, JSON.stringify(initial)]]), peers = [], locks = new TestLockManager();
  const peerA = renderer(browserDisk, peers, delay), peerB = renderer(browserDisk, peers, delay);
  const [a, b] = await Promise.all([page(peerA, locks), page(peerB, locks)]);
  const mutate = (page, label) => kind === 'plans'
    ? page.store.commitRelay(next => page.core.createPlan(next, label), { changed: 'plan' })
    : kind === 'inbox'
      ? page.store.commitRelay(next => page.core.touchInboxEntry(next, {
        codexId: 'test', entryId: label, title: label, prompt: label,
      }), { changed: 'inbox' })
      : page.store.commitRelay(next => page.core.replacePlanText(next, 'plan-default', {
        dedupe: false, positive: { text: label, folds: {} }, negative: { text: '', folds: {} },
      }, { expectedRevision: 0 }), { changed: 'plan', planId: 'plan-default', revision: 0 });
  try {
    const results = await Promise.all([mutate(a, 'saved-by-A'), mutate(b, 'saved-by-B')]);
    const saved = JSON.parse(browserDisk.get(KEY));
    assert.equal(results[0].ok, true);
    if (kind === 'revision') {
      assert.equal(results[1].ok, false, '过期 revision 必须拒写，即使 B 的 renderer 曾读到旧正文');
      assert.equal(results[1].reason, 'conflict');
      assert.equal(saved.plans[0].positive.text, 'saved-by-A');
      assert.equal(saved.plans[0].revision, 1);
    } else {
      assert.equal(results[1].ok, true);
      const labels = kind === 'plans' ? saved.plans.map(plan => plan.name) : saved.inbox.map(entry => entry.entryId);
      assert.ok(labels.includes('saved-by-A'), `${kind}: 已成功保存的 A 不能被缓存未同步的 B 覆盖`);
      assert.ok(labels.includes('saved-by-B'));
    }
    assert.ok(locks.starts.filter(name => name === KEY + ':lock').length >= 4, '初始化与提交必须使用 Web Lock');
    await new Promise(resolve => setTimeout(resolve, delay + 20));
    assert.equal(JSON.stringify(a.store.relayState()), browserDisk.get(KEY));
    assert.equal(JSON.stringify(b.store.relayState()), browserDisk.get(KEY));
  } finally {
    peerA.target.fire('pagehide', {}); peerB.target.fire('pagehide', {});
  }
}
for (const delay of [25, 75]) for (const kind of ['plans', 'inbox', 'revision']) await scenario(kind, delay);
console.log('tag relay cache fence: all tests passed');
