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

// A page opened before the cutoff must upgrade itself after the next UTC day
// boundary, rather than relying on a manual refresh to install the gate.
{
  const env = createPreviewEnvironment(Date.UTC(2026, 8, 7, 23, 59, 0));
  env.run();
  assert.ok(env.document.getElementById('betaBar'));
  assert.equal(env.timers.length, 1);

  env.setTime(Date.UTC(2026, 8, 9, 0, 0, 1));
  env.timers.shift().callback();
  assert.equal(env.document.getElementById('betaBar'), null);
  assert.ok(env.document.getElementById('betaGate'));
  assert.equal(env.document.documentElement.style.overflow, 'hidden');
}

// A fresh request after expiry is gated immediately as before.
{
  const env = createPreviewEnvironment(Date.UTC(2026, 8, 9, 12, 0, 0));
  env.run();
  assert.equal(env.document.getElementById('betaBar'), null);
  assert.ok(env.document.getElementById('betaGate'));
}

console.log('beta banner expiry tests passed');
