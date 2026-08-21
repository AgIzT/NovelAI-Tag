import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../site/assets/beta-banner.js', import.meta.url), 'utf8');

function createPreviewEnvironment(initialTime) {
  let clock = initialTime;
  const nodes = new Map();
  const listeners = new Map();
  const timers = [];

  function createNode(tagName) {
    let id = '';
    const node = {
      tagName: tagName.toUpperCase(),
      children: [],
      parentNode: null,
      style: {},
      textContent: '',
      appendChild(child) {
        child.parentNode = node;
        node.children.push(child);
        if (child.id) nodes.set(child.id, child);
        return child;
      },
      remove() {
        if (node.parentNode) {
          node.parentNode.children = node.parentNode.children.filter(child => child !== node);
        }
        if (id) nodes.delete(id);
        node.parentNode = null;
      },
    };
    Object.defineProperty(node, 'id', {
      get: () => id,
      set: value => {
        if (id) nodes.delete(id);
        id = String(value || '');
        if (id && node.parentNode) nodes.set(id, node);
      },
    });
    Object.defineProperty(node, 'innerHTML', {
      set: () => {
        node.firstChild = { textContent: '' };
        node.lastChild = { textContent: '' };
      },
    });
    return node;
  }

  class FakeDate extends Date {
    constructor(...args) { super(args.length ? args[0] : clock); }
    static now() { return clock; }
  }
  FakeDate.UTC = Date.UTC;
  FakeDate.parse = Date.parse;

  const document = {
    body: createNode('body'),
    head: createNode('head'),
    documentElement: { style: {} },
    hidden: false,
    createElement: createNode,
    getElementById: id => nodes.get(id) || null,
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const context = {
    Date: FakeDate,
    document,
    location: { hostname: 'preview.example.pages.dev' },
    window: {
      setTimeout(callback, delay) {
        timers.push({ callback, delay });
        return timers.length;
      },
    },
  };
  return {
    document,
    timers,
    run: () => vm.runInNewContext(source, context),
    setTime: value => { clock = value; },
  };
}

/* 截止日是 beta-banner.js 里的一行常量，会被反复改（延期）。测试从源码里读它、再按它
   推算前后一天，这样以后改日期不必连带改测试；读不出来就直接失败，免得推算悄悄落到
   一个恒不过期的日子上，把两条断言变成永远为真。 */
const EXPIRES = source.match(/var EXPIRES = '([0-9]{4}-[0-9]{2}-[0-9]{2})'/)?.[1];
assert.ok(EXPIRES, '必须能从 beta-banner.js 读出 EXPIRES 常量');
const cutoff = Date.parse(EXPIRES + 'T00:00:00Z');
const DAY = 86_400_000;

// A page opened before the cutoff must upgrade itself after the next UTC day
// boundary, rather than relying on a manual refresh to install the gate.
{
  const env = createPreviewEnvironment(cutoff - DAY + (23 * 60 + 59) * 60_000);
  env.run();
  assert.ok(env.document.getElementById('betaBar'));
  assert.equal(env.timers.length, 1);

  env.setTime(cutoff + DAY + 1_000);
  env.timers.shift().callback();
  assert.equal(env.document.getElementById('betaBar'), null);
  assert.ok(env.document.getElementById('betaGate'));
  assert.equal(env.document.documentElement.style.overflow, 'hidden');
}

// A fresh request after expiry is gated immediately as before.
{
  const env = createPreviewEnvironment(cutoff + DAY + 12 * 3_600_000);
  env.run();
  assert.equal(env.document.getElementById('betaBar'), null);
  assert.ok(env.document.getElementById('betaGate'));
}

console.log('beta banner expiry tests passed');
