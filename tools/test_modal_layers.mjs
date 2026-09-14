// 共享模态生命周期与顶层按键回归：node tools/test_modal_layers.mjs
import assert from 'node:assert/strict';
import { configureMask, openMask, closeMask, topInteractionLayer, isGlobalShortcutBlocked } from '../site/assets/app/modal.js';
import { configureBrowserHistory, initializeBrowserHistory, registerHistoryLayer, openHistoryLayer } from '../site/assets/app/browser-history.js';

const nodes = [];
let reduced = false;
class Element {
  constructor(id = '', { parent = null, modal = false, z = 'auto', hidden = false } = {}) {
    this.id = id; this.parentElement = parent; this.hidden = hidden; this.inert = false;
    this.isConnected = true; this.offsetParent = parent; this.zIndex = String(z);
    this.attributes = new Map(modal ? [['aria-modal', 'true']] : []);
    const classes = new Set();
    this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
    nodes.push(this);
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if ((selector.includes('[hidden]') && node.hidden) || (selector.includes('[inert]') && node.inert)
        || (selector.includes('[data-modal-root]') && node.attributes.has('data-modal-root'))
        || (selector.includes('[aria-modal="true"]') && node.attributes.get('aria-modal') === 'true')) return node;
    }
    return null;
  }
  getClientRects() { return this.closest('[hidden]') || !this.isConnected ? [] : [{}]; }
  contains(target) {
    for (let node = target; node; node = node.parentElement) if (node === this) return true;
    return false;
  }
  querySelectorAll() { return nodes.filter(node => node !== this && this.contains(node) && node.focusable); }
  focus() { document.activeElement = this; }
}
globalThis.HTMLElement = Element;
globalThis.window = { matchMedia: () => ({ matches: reduced }) };
globalThis.getComputedStyle = element => ({ zIndex: element.zIndex, display: 'block', visibility: 'visible' });
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
const body = new Element('body');
globalThis.document = {
  body, activeElement: body,
  getElementById: id => nodes.find(node => node.id === id) || null,
  querySelectorAll: () => nodes.filter(node => node.attributes.get('aria-modal') === 'true' || node.attributes.has('data-modal-root')),
};
const tick = (delay = 0) => new Promise(resolve => setTimeout(resolve, delay));
const reset = () => { nodes.splice(1); document.activeElement = body; reduced = false; };
const button = (id, parent = body) => { const node = new Element(id, { parent }); node.focusable = true; return node; };
const makeMask = (id, z = 70) => new Element(id, { parent: body, modal: true, z, hidden: true });
let passed = 0;
async function test(name, action) { reset(); await action(); passed++; console.log('PASS ' + name); }

await test('route lightbox blocks page shortcuts, selection and a docked rail do not', () => {
  new Element('selection', { parent: body });
  new Element('rail', { parent: body, z: 68 });
  assert.equal(isGlobalShortcutBlocked({}), false);
  const lightbox = new Element('lightbox', { parent: body, modal: true, z: 80 });
  assert.equal(topInteractionLayer(), lightbox);
  assert.equal(isGlobalShortcutBlocked({}, lightbox), false);
  assert.equal(isGlobalShortcutBlocked({}), true);
});

await test('visual stacking blocks lower owners and one Escape cannot pass through a closing top layer', () => {
  const lightbox = new Element('lightbox', { parent: body, modal: true, z: 80 });
  const organize = makeMask('organize', 95);
  const done = button('done', organize);
  openMask(organize, body, { historyMode: 'none' });
  assert.equal(isGlobalShortcutBlocked({}, lightbox), true);
  assert.equal(isGlobalShortcutBlocked({}, done), false);
  const escape = {};
  assert.equal(topInteractionLayer(escape), organize);
  reduced = true;
  closeMask(organize, { historyMode: 'none' });
  assert.equal(organize.inert, true);
  assert.equal(topInteractionLayer(), lightbox);
  assert.equal(isGlobalShortcutBlocked(escape, lightbox), true);
  assert.equal(isGlobalShortcutBlocked({}, lightbox), false);
});

await test('nested modal follows its ancestor stack rather than its small local z-index', () => {
  const lightbox = new Element('lightbox', { parent: body, modal: true, z: 80 });
  const backup = new Element('backup', { parent: body, modal: true, z: 140 });
  const confirm = new Element('confirm', { parent: backup, modal: true, z: 3 });
  assert.equal(topInteractionLayer(), confirm);
  assert.equal(isGlobalShortcutBlocked({}, backup), true);
  backup.inert = true;
  assert.equal(topInteractionLayer(), lightbox);
});

await test('same-z masks use open order and an identified dialog resolves to its configured mask', () => {
  const first = makeMask('first');
  const second = makeMask('second');
  const panel = new Element('panel', { parent: first, modal: true });
  openMask(second, body, { historyMode: 'none' });
  openMask(first, body, { historyMode: 'none' });
  assert.equal(topInteractionLayer(), panel);
  first.attributes.delete('aria-modal');
  assert.equal(topInteractionLayer(), first);
  reduced = true;
  closeMask(first, { historyMode: 'none' });
  closeMask(second, { historyMode: 'none' });
});

await test('close notifies immediately, restores after exit, and rapid reopen cancels the old return', async () => {
  const mask = makeMask('editor');
  const first = button('first');
  const second = button('second');
  const input = button('input', mask);
  const calls = [];
  configureMask(mask, {
    onOpen: () => calls.push('open'),
    onClose: () => calls.push('close'),
    restoreFocus: (_mask, opener) => { calls.push('restore:' + opener.id); opener.focus(); },
  });
  openMask(mask, first, { historyMode: 'none' });
  await tick(10);
  assert.equal(document.activeElement, input);
  closeMask(mask, { historyMode: 'none' });
  closeMask(mask, { historyMode: 'none' });
  assert.deepEqual(calls, ['open', 'close']);
  assert.equal(mask.hidden, false);
  assert.equal(mask.inert, true);
  await tick(40);
  openMask(mask, second, { historyMode: 'none' });
  await tick(260);
  assert.equal(mask.hidden, false);
  assert.equal(mask.inert, false);
  assert.deepEqual(calls, ['open', 'close', 'open']);
  closeMask(mask, { historyMode: 'none' });
  await tick(260);
  assert.equal(mask.hidden, true);
  assert.equal(document.activeElement, second);
  assert.deepEqual(calls, ['open', 'close', 'open', 'close', 'restore:second']);
});

await test('reduced motion closes immediately and pending open focus never re-enters the closed mask', async () => {
  reduced = true;
  const mask = makeMask('fast');
  const opener = button('opener');
  button('input', mask);
  openMask(mask, opener, { historyMode: 'none' });
  closeMask(mask, { historyMode: 'none' });
  assert.equal(mask.hidden, true);
  assert.equal(document.activeElement, opener);
  await tick(10);
  assert.equal(document.activeElement, opener);
});

await test('historyMode none preserves an existing custom layer adapter', () => {
  reduced = true;
  const win = new EventTarget();
  win.scrollY = 0;
  win.history = { state: null, replaceState(state) { this.state = state; }, pushState(state) { this.state = state; } };
  configureBrowserHistory({ window: win, page: 'modal-test', captureRoute: () => ({}) });
  initializeBrowserHistory();
  const mask = makeMask('custom');
  let customClosed = 0;
  registerHistoryLayer(mask.id, {
    isOpen: () => mask.classList.contains('show'),
    close: () => { customClosed++; closeMask(mask, { historyMode: 'none' }); },
  });
  openMask(mask, body, { historyMode: 'none' });
  openHistoryLayer(mask.id);
  openHistoryLayer('replacement', { mode: 'replace' });
  assert.equal(customClosed, 1);
  assert.equal(mask.hidden, true);
});

console.log('modal layers regression: ' + passed + ' passed');
