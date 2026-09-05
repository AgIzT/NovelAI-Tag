// 弹层关闭手势回归：node tools/test_modal_dismiss.mjs
import assert from 'node:assert/strict';
import { bindBackdropDismiss, bindOutsideDismiss } from '../site/assets/app/modal.js';

class FakeEventTarget extends EventTarget {
  // Node 的布尔 capture 解绑与浏览器不同，统一成等价的选项对象。
  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, typeof options === 'boolean' ? { capture: options } : options);
  }

  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, typeof options === 'boolean' ? { capture: options } : options);
  }
}

class FakeElement extends FakeEventTarget {
  constructor(ownerDocument, parent = null) {
    super();
    this.ownerDocument = ownerDocument;
    this.parentElement = parent;
  }

  contains(target) {
    for (let node = target; node; node = node.parentElement) {
      if (node === this) return true;
    }
    return false;
  }
}

class FakeDocument extends FakeEventTarget {
  hitTarget = null;
  hitTests = 0;

  elementFromPoint(x, y) {
    this.hitTests += 1;
    assert.equal(x, 30);
    assert.equal(y, 40);
    return this.hitTarget;
  }
}

// 只提供浏览器已派发的事件目标与释放处命中结果，不模拟布局或重写关闭判断。
// Node EventTarget 不会冒泡，因此直接在实际监听根上派发这段已知事件序列。
function dispatch(root, type, target, values = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const properties = {
    target,
    button: 0,
    isPrimary: true,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 30,
    clientY: 40,
    detail: type === 'click' ? 1 : 0,
    ...values,
  };
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(event, key, { value });
  }
  root.dispatchEvent(event);
}

function gesture(root, downTarget, upTarget, clickTarget, { hitTarget = upTarget, ...values } = {}) {
  const doc = root.ownerDocument || root;
  dispatch(root, 'pointerdown', downTarget, values);
  doc.hitTarget = hitTarget;
  dispatch(root, 'pointerup', upTarget, values);
  dispatch(root, 'click', clickTarget, values);
}

function backdropFixture(options) {
  const doc = new FakeDocument();
  const mask = new FakeElement(doc);
  const content = new FakeElement(doc, mask);
  const text = new FakeElement(doc, content);
  let dismissals = 0;
  const unbind = bindBackdropDismiss(mask, () => { dismissals += 1; }, options);
  return { doc, mask, content, text, unbind, count: () => dismissals };
}

let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log(`PASS ${name}`);
}

test('selection starts inside and ends on backdrop without dismissing', () => {
  const { mask, text, count } = backdropFixture();
  gesture(mask, text, mask, mask);
  assert.equal(count(), 0);
  // 下一次真正的背景点击仍然有效，不依赖之前的选区是否还存在。
  gesture(mask, mask, mask, mask);
  assert.equal(count(), 1);
});

test('reverse drag and an entirely internal click stay open', () => {
  const { mask, text, count } = backdropFixture();
  gesture(mask, mask, text, mask);
  gesture(mask, text, text, text);
  assert.equal(count(), 0);
});

test('a completed backdrop click dismisses only once', () => {
  const { mask, count } = backdropFixture();
  gesture(mask, mask, mask, mask);
  assert.equal(count(), 1);
  dispatch(mask, 'click', mask);
  assert.equal(count(), 1);
});

test('pointer clicks need both a press and a matching release', () => {
  const { mask, count } = backdropFixture();
  dispatch(mask, 'click', mask);
  dispatch(mask, 'pointerdown', mask);
  dispatch(mask, 'click', mask);
  assert.equal(count(), 0);
});

test('pointercancel discards the gesture and the next click still works', () => {
  const { doc, mask, count } = backdropFixture();
  dispatch(mask, 'pointerdown', mask);
  dispatch(mask, 'pointercancel', mask);
  doc.hitTarget = mask;
  dispatch(mask, 'pointerup', mask);
  dispatch(mask, 'click', mask);
  assert.equal(count(), 0);
  gesture(mask, mask, mask, mask);
  assert.equal(count(), 1);
});

test('touch capture does not turn a release over content into a backdrop tap', () => {
  const { mask, text, count } = backdropFixture();
  gesture(mask, mask, mask, mask, { pointerType: 'touch', hitTarget: text });
  assert.equal(count(), 0);
  gesture(mask, mask, mask, mask, { pointerType: 'touch' });
  assert.equal(count(), 1);
});

test('keyboard clicks remain supported while pointer detail zero cannot bypass the guard', () => {
  const { mask, text, count } = backdropFixture();
  dispatch(mask, 'click', mask, { detail: 0, pointerType: undefined, pointerId: -1 });
  assert.equal(count(), 1);
  dispatch(mask, 'click', text, { detail: 0, pointerType: '', pointerId: -1 });
  dispatch(mask, 'click', mask, { detail: 0, pointerType: 'mouse' });
  assert.equal(count(), 1);
});

test('release and click pointer ids must match the press', () => {
  const { doc, mask, count } = backdropFixture();
  doc.hitTarget = mask;
  dispatch(mask, 'pointerdown', mask);
  dispatch(mask, 'pointerup', mask, { pointerId: 2 });
  dispatch(mask, 'click', mask);
  assert.equal(count(), 0);
  dispatch(mask, 'pointerdown', mask);
  dispatch(mask, 'pointerup', mask);
  dispatch(mask, 'click', mask, { pointerId: 2 });
  assert.equal(count(), 0);
});

test('secondary buttons, nonprimary pointers and viewport misses stay open', () => {
  const { mask, count } = backdropFixture();
  gesture(mask, mask, mask, mask, { button: 2 });
  gesture(mask, mask, mask, mask, { isPrimary: false });
  gesture(mask, mask, mask, mask, { hitTarget: null });
  assert.equal(count(), 0);
});

test('custom backdrops can include both the lightbox and its stage', () => {
  const doc = new FakeDocument();
  const mask = new FakeElement(doc);
  const stage = new FakeElement(doc, mask);
  const image = new FakeElement(doc, stage);
  let dismissals = 0;
  bindBackdropDismiss(mask, () => { dismissals += 1; }, {
    isBackdrop: target => target === mask || target === stage,
  });
  gesture(mask, image, stage, stage);
  assert.equal(dismissals, 0);
  gesture(mask, stage, mask, mask);
  assert.equal(dismissals, 1);
});

test('outside bindings coexist and protect button descendants such as SVG icons', () => {
  const doc = new FakeDocument();
  globalThis.document = doc;
  const page = new FakeElement(doc);
  const menu = new FakeElement(doc, page);
  const button = new FakeElement(doc, page);
  const svg = new FakeElement(doc, button);
  const secondMenu = new FakeElement(doc, page);
  let first = 0;
  let second = 0;
  bindOutsideDismiss([menu, button], () => { first += 1; });
  bindOutsideDismiss([secondMenu], () => { second += 1; });
  gesture(doc, menu, page, page);
  assert.equal(first, 0);
  assert.equal(second, 1);
  gesture(doc, svg, page, page);
  assert.equal(first, 0);
  assert.equal(second, 2);
  gesture(doc, page, svg, page);
  assert.equal(first, 0);
  assert.equal(second, 3);
  gesture(doc, page, page, page);
  assert.equal(first, 1);
  assert.equal(second, 4);
});

test('outside container callbacks follow the current popover and ignore missing containers', () => {
  const doc = new FakeDocument();
  globalThis.document = doc;
  const page = new FakeElement(doc);
  const menu = new FakeElement(doc, page);
  let elements = [];
  let dismissals = 0;
  bindOutsideDismiss(() => elements, () => { dismissals += 1; });
  gesture(doc, page, page, page);
  assert.equal(dismissals, 0);
  elements = [menu, null];
  gesture(doc, menu, page, page);
  assert.equal(dismissals, 0);
  gesture(doc, page, page, page);
  assert.equal(dismissals, 1);
});

test('unbind removes each binding without affecting another document binding', () => {
  const { doc: backdropDoc, mask, unbind, count } = backdropFixture();
  unbind();
  gesture(mask, mask, mask, mask);
  dispatch(mask, 'click', mask, { detail: 0, pointerType: '' });
  assert.equal(count(), 0);
  assert.equal(backdropDoc.hitTests, 0);

  const doc = new FakeDocument();
  globalThis.document = doc;
  const page = new FakeElement(doc);
  const menu = new FakeElement(doc, page);
  let first = 0;
  let second = 0;
  const removeFirst = bindOutsideDismiss([menu], () => { first += 1; });
  bindOutsideDismiss([menu], () => { second += 1; });
  removeFirst();
  gesture(doc, page, page, page);
  assert.equal(first, 0);
  assert.equal(second, 1);
  assert.equal(doc.hitTests, 1);
});

console.log(`modal dismiss regression: ${passed} passed`);
