// 公共选择器行为回归：node tools/test_select_menu.mjs
import assert from 'node:assert/strict';
import { createSelectMenu } from '../site/assets/app/select-menu.js';

class FakeEventTarget extends EventTarget {
  listeners = new Map();

  addEventListener(type, listener, options) {
    const normalized = typeof options === 'boolean' ? { capture: options } : options;
    const key = `${type}:${Boolean(normalized?.capture)}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(listener);
    super.addEventListener(type, listener, normalized);
  }

  removeEventListener(type, listener, options) {
    // Node 的布尔 capture 解绑与浏览器不同，和现有 modal 回归保持一致。
    const normalized = typeof options === 'boolean' ? { capture: options } : options;
    this.listeners.get(`${type}:${Boolean(normalized?.capture)}`)?.delete(listener);
    super.removeEventListener(type, listener, normalized);
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }
}

class FakeElement extends FakeEventTarget {
  constructor(ownerDocument, tagName = 'div') {
    super();
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.parentElement = null;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
  }

  get isConnected() { return this.ownerDocument.body.contains(this); }
  get lastElementChild() { return this.children.at(-1) || null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }

  append(...nodes) {
    for (const node of nodes) {
      if (node.parentElement) {
        const siblings = node.parentElement.children;
        siblings.splice(siblings.indexOf(node), 1);
      }
      node.parentElement = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    if (this.children.some(child => child.contains(this.ownerDocument.activeElement))) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }

  contains(target) {
    for (let node = target; node; node = node.parentElement) {
      if (node === this) return true;
    }
    return false;
  }

  closest(selector) {
    assert.equal(selector, '[role="option"]');
    for (let node = this; node; node = node.parentElement) {
      if (node.getAttribute('role') === 'option') return node;
    }
    return null;
  }

  focus() {
    if (this.disabled || !this.isConnected) return;
    for (let node = this; node; node = node.parentElement) if (node.hidden) return;
    this.ownerDocument.activeElement = this;
  }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.body = new FakeElement(this, 'body');
    this.activeElement = this.body;
    this.hidden = false;
    this.hitTarget = null;
  }

  createElement(tagName) { return new FakeElement(this, tagName); }
  createElementNS(_namespace, tagName) { return this.createElement(tagName); }
  elementFromPoint() { return this.hitTarget; }
}

function eventFor(type, target, values = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({
    target, button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse',
    clientX: 30, clientY: 40, detail: type === 'click' ? 1 : 0, ...values,
  })) Object.defineProperty(event, key, { value });
  const stop = event.stopPropagation.bind(event);
  event.propagationStopped = false;
  event.stopPropagation = () => { event.propagationStopped = true; stop(); };
  return event;
}

// Node EventTarget 不会冒泡；只补交互事件的祖先派发，不模拟布局或选择器逻辑。
function bubble(type, target, values) {
  const event = eventFor(type, target, values);
  for (let root = target; root; root = root.parentElement || (root === target.ownerDocument.body ? target.ownerDocument : null)) {
    root.dispatchEvent(event);
    if (event.propagationStopped) break;
  }
  return event;
}

function key(target, value, options = {}) { return bubble('keydown', target, { key: value, ...options }); }

function gesture(doc, downTarget, upTarget, clickTarget = upTarget, hitTarget = upTarget) {
  doc.dispatchEvent(eventFor('pointerdown', downTarget));
  doc.hitTarget = hitTarget;
  doc.dispatchEvent(eventFor('pointerup', upTarget));
  doc.dispatchEvent(eventFor('click', clickTarget));
}

const options = [
  { value: 'recent', label: '最近收藏', description: '最新在前' },
  { value: 'disabled', label: '不可用', disabled: true },
  { value: 'oldest', label: '最早收藏' },
  { value: 'title', label: '名称' },
];

function fixture() {
  const previous = { document: globalThis.document, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const doc = new FakeDocument();
  const timers = new Map();
  let timerId = 0;
  globalThis.document = doc;
  globalThis.setTimeout = callback => { timers.set(++timerId, callback); return timerId; };
  globalThis.clearTimeout = id => timers.delete(id);
  const menus = [];
  const changes = [];
  const create = (config = {}) => {
    const menu = createSelectMenu({ label: '排序', options, value: 'oldest', onChange: value => changes.push(value), ...config });
    menus.push(menu);
    doc.body.append(menu.element);
    return menu;
  };
  const outside = doc.createElement('button');
  doc.body.append(outside);
  return {
    doc, create, outside, changes, timers,
    tick() {
      for (const [id, callback] of [...timers]) {
        if (!timers.delete(id)) continue;
        callback();
      }
    },
    cleanup() {
      for (const menu of menus) menu.destroy();
      Object.assign(globalThis, previous);
    },
  };
}

function option(menu, value) { return menu.list.children.find(child => child.dataset.value === value); }
function selected(menu) { return menu.list.children.filter(child => child.getAttribute('aria-selected') === 'true').map(child => child.dataset.value); }
function assertOpen(menu, open) {
  assert.equal(menu.list.hidden, !open);
  assert.equal(menu.button.getAttribute('aria-expanded'), String(open));
}

let passed = 0;
function test(name, run) {
  const context = fixture();
  try {
    run(context);
    passed += 1;
    console.log(`PASS ${name}`);
  } finally { context.cleanup(); }
}

test('listbox starts closed with a stable accessible selection and linked trigger', ({ create }) => {
  const menu = create();
  assertOpen(menu, false);
  assert.equal(menu.button.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(menu.button.getAttribute('aria-controls'), menu.list.id);
  assert.equal(menu.list.getAttribute('role'), 'listbox');
  assert.equal(menu.list.getAttribute('aria-label'), '排序');
  assert.equal(menu.button.getAttribute('aria-label'), '排序：最早收藏');
  assert.deepEqual(selected(menu), ['oldest']);
  assert.equal(option(menu, 'oldest').lastElementChild.textContent, '✓');
});

test('trigger arrows and Home/End open at the requested available option', ({ create, doc }) => {
  const menu = create();
  for (const [pressed, value] of [['ArrowDown', 'oldest'], ['ArrowUp', 'title'], ['Home', 'recent'], ['End', 'title']]) {
    menu.close();
    menu.button.focus();
    const event = key(menu.button, pressed);
    assertOpen(menu, true);
    assert.equal(doc.activeElement, option(menu, value));
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
  }
});

test('list arrows wrap, skip disabled options, and Home/End retain the business value', ({ create, doc, changes }) => {
  const menu = create();
  menu.open();
  for (const [pressed, value] of [['ArrowUp', 'recent'], ['ArrowUp', 'title'], ['ArrowDown', 'recent'], ['End', 'title'], ['Home', 'recent'], ['ArrowDown', 'oldest']]) {
    const event = key(doc.activeElement, pressed);
    assert.equal(doc.activeElement, option(menu, value));
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
    assert.deepEqual(selected(menu), ['oldest']);
  }
  assert.deepEqual(changes, []);
});

test('unhandled list shortcuts stay local while Tab reaches the outer focus trap', ({ create, doc, changes }) => {
  const menu = create();
  const outerKeys = [];
  doc.addEventListener('keydown', event => outerKeys.push(event.key));
  menu.open();
  const focused = doc.activeElement;
  for (const pressed of ['?', '/', 'g']) {
    const event = key(focused, pressed);
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.propagationStopped, true);
    assert.equal(doc.activeElement, focused);
    assertOpen(menu, true);
  }
  assert.deepEqual(outerKeys, []);
  assert.deepEqual(changes, []);
  const tab = key(focused, 'Tab');
  assert.equal(tab.defaultPrevented, false);
  assert.equal(tab.propagationStopped, false);
  assert.deepEqual(outerKeys, ['Tab']);
  assert.deepEqual(changes, []);
});

test('Escape closes only the menu and restores its trigger before reaching the parent', ({ create, doc }) => {
  const menu = create();
  let parentEscapes = 0;
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') parentEscapes += 1; });
  menu.open();
  const event = key(doc.activeElement, 'Escape');
  assertOpen(menu, false);
  assert.equal(doc.activeElement, menu.button);
  assert.equal(event.defaultPrevented, true);
  assert.equal(parentEscapes, 0);
  key(menu.button, 'Escape');
  assert.equal(parentEscapes, 1, 'a second Escape can reach the parent after the menu closes');
  menu.open();
  menu.button.focus();
  key(menu.button, 'Escape');
  assertOpen(menu, false);
  assert.equal(parentEscapes, 1);
});

test('Enter and Space close and restore focus before onChange without committing the value', ({ create, doc }) => {
  const calls = [];
  const menu = create({ onChange: value => {
    assertOpen(menu, false);
    assert.equal(doc.activeElement, menu.button);
    assert.deepEqual(selected(menu), ['oldest']);
    calls.push(value);
  } });
  for (const pressed of ['Enter', ' ']) {
    menu.open('last');
    const event = key(doc.activeElement, pressed);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
    assert.deepEqual(selected(menu), ['oldest']);
  }
  assert.deepEqual(calls, ['title', 'title']);
  menu.setValue('title');
  assert.deepEqual(selected(menu), ['title']);
  assert.equal(menu.button.getAttribute('aria-label'), '排序：名称');
});

test('clicking option descendants submits once and disabled options cannot submit', ({ create, changes }) => {
  const menu = create();
  menu.open();
  bubble('click', option(menu, 'title').children[0]);
  assert.deepEqual(changes, ['title']);
  assert.deepEqual(selected(menu), ['oldest']);
  menu.open();
  bubble('click', option(menu, 'disabled').children[0]);
  key(option(menu, 'disabled'), 'Enter');
  assert.deepEqual(changes, ['title']);
  assertOpen(menu, true);
});

test('Tab and Shift+Tab preserve native focus until the deferred close', ({ create, doc, outside, timers, tick }) => {
  const menu = create();
  for (const shiftKey of [false, true]) {
    menu.open();
    const focused = doc.activeElement;
    const event = key(focused, 'Tab', { shiftKey });
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.propagationStopped, false);
    assert.equal(doc.activeElement, focused);
    assertOpen(menu, true);
    assert.equal(timers.size, 1);
    outside.focus(); // 浏览器的原生 Tab 默认动作发生在当前事件结束后。
    tick();
    assertOpen(menu, false);
    assert.equal(doc.activeElement, outside);
    assert.equal(timers.size, 0);
  }
});

test('reopening cancels a pending Tab close', ({ create, doc, timers, tick }) => {
  const menu = create();
  menu.open();
  key(doc.activeElement, 'Tab');
  menu.open('first');
  assert.equal(timers.size, 0);
  tick();
  assertOpen(menu, true);
  assert.equal(doc.activeElement, option(menu, 'recent'));
});

test('setOptions preserves focus by value across reordering and label changes', ({ create, doc, changes }) => {
  const menu = create();
  menu.open('last');
  const oldFocused = doc.activeElement;
  menu.setOptions([{ value: 'title', label: '名称新标签' }, ...options.filter(item => item.value !== 'title')]);
  assert.equal(oldFocused.isConnected, false);
  assert.notEqual(doc.activeElement, oldFocused);
  assert.equal(doc.activeElement, option(menu, 'title'));
  assert.deepEqual(selected(menu), ['oldest']);
  assert.deepEqual(changes, []);
  assertOpen(menu, true);
});

test('removed or disabled focus falls back to selected, first available, then trigger', ({ create, doc }) => {
  const menu = create();
  menu.open('last');
  menu.setOptions(options.filter(item => item.value !== 'title'));
  assert.equal(doc.activeElement, option(menu, 'oldest'));
  menu.setOptions(options.map(item => ({ ...item, disabled: item.value === 'oldest' || item.disabled })));
  assert.equal(doc.activeElement, option(menu, 'recent'));
  menu.setOptions([]);
  assert.equal(doc.activeElement, menu.button);
  assertOpen(menu, true);
});

test('closed redraws do not steal focus and selection can be restored when options return', ({ create, doc, outside }) => {
  const menu = create();
  outside.focus();
  menu.setOptions([{ value: 'recent', label: '最近收藏' }]);
  assert.equal(doc.activeElement, outside);
  assert.deepEqual(selected(menu), []);
  menu.setOptions(options);
  assert.deepEqual(selected(menu), ['oldest']);
  assert.equal(doc.activeElement, outside);
  assertOpen(menu, false);
});

test('outside dismiss requires both endpoints outside and protects trigger SVG descendants', ({ create, doc, outside }) => {
  const menu = create();
  menu.open();
  const inside = option(menu, 'oldest').children[0];
  const svg = menu.button.children[1].children[0];
  for (const [down, up] of [[inside, outside], [outside, inside], [svg, outside], [outside, svg], [inside, inside]]) {
    gesture(doc, down, up, outside);
    assertOpen(menu, true);
  }
  // 隐式触摸捕获把 up.target 留在外侧时，以真正命中点为准。
  gesture(doc, outside, outside, outside, inside);
  assertOpen(menu, true);
  outside.focus();
  gesture(doc, outside, outside);
  assertOpen(menu, false);
  assert.equal(doc.activeElement, outside);
});

test('visibility changes close only when the document becomes hidden and cancel Tab timers', ({ create, doc, timers, tick }) => {
  const menu = create();
  menu.open();
  doc.dispatchEvent(new Event('visibilitychange'));
  assertOpen(menu, true);
  key(doc.activeElement, 'Tab');
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  assertOpen(menu, false);
  assert.equal(timers.size, 0);
  tick();
  assertOpen(menu, false);
});

test('destroy is idempotent and clears its listeners and pending Tab timer', ({ create, doc, timers, tick, changes, outside }) => {
  const baseline = doc.listenerCount();
  const menu = create();
  assert.ok(doc.listenerCount() > baseline);
  menu.open();
  key(doc.activeElement, 'Tab');
  assert.equal(timers.size, 1);
  menu.destroy();
  menu.destroy();
  assert.equal(doc.listenerCount(), baseline);
  assert.equal(menu.button.listenerCount(), 0);
  assert.equal(menu.list.listenerCount(), 0);
  assert.equal(timers.size, 0);
  assertOpen(menu, false);
  outside.focus();
  menu.open();
  bubble('click', menu.button);
  key(option(menu, 'title'), 'Enter');
  tick();
  assertOpen(menu, false);
  assert.equal(doc.activeElement, outside);
  assert.deepEqual(changes, []);
});

test('repeated header replacement does not accumulate document listeners or affect another menu', ({ create, doc, outside }) => {
  const retained = create();
  const baseline = doc.listenerCount();
  for (let index = 0; index < 40; index++) {
    const oldHeader = create();
    oldHeader.open();
    oldHeader.destroy();
    assert.equal(doc.listenerCount(), baseline);
  }
  retained.open();
  gesture(doc, outside, outside);
  assertOpen(retained, false);
  retained.destroy();
  assert.equal(doc.listenerCount(), 0);
});

test('empty or disabled choices stay safe and onOpen can destroy a stale instance', ({ create, doc }) => {
  const empty = create({ options: [] });
  empty.button.focus();
  empty.open();
  assert.equal(doc.activeElement, empty.button);
  key(empty.list, 'ArrowDown');
  const disabled = create({ options: options.map(item => ({ ...item, disabled: true })) });
  disabled.button.focus();
  disabled.open();
  assert.equal(doc.activeElement, disabled.button);
  const stale = create({ onOpen: () => stale.destroy() });
  stale.open();
  assertOpen(stale, false);
});

console.log(`select menu regression: ${passed} passed`);
