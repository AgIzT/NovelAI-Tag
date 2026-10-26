import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../site/assets/app/tag-relay-rail.js', import.meta.url), 'utf8')
  .replace(/^import [^\r\n]* from ['"][^'"]+['"];\r?\n/gm, '').replace(/^export\s+/gm, '');
const motionSource = readFileSync(new URL('../site/assets/app/ui-motion.js', import.meta.url), 'utf8')
  .replace(/^import [^\r\n]* from ['"][^'"]+['"];\r?\n/gm, '').replace(/^export\s+/gm, '');
const animationDuration = Number(readFileSync(new URL('../site/assets/app/state.js', import.meta.url), 'utf8')
  .match(/^export const RELAYOUT_ANIM_MS = (\d+);/m)?.[1]);
assert.ok(Number.isFinite(animationDuration), 'shared layout animation duration must be available');
const cases = [];
async function test(name, action) {
  try { await action(); cases.push({ name, status: 'PASS' }); }
  catch (error) { cases.push({ name, status: 'FAIL', error: error.message }); }
}
const microtasks = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture({ motion = false, openInitially = true, supportsAnimation = true } = {}) {
  const calls = [], stored = new Map(), animations = [], order = [], ownership = [];
  const eventTarget = object => {
    const listeners = new Map();
    return Object.assign(object, {
      addEventListener(type, fn) { const callbacks = listeners.get(type) || new Set(); callbacks.add(fn); listeners.set(type, callbacks); },
      emit(type, event = {}) { for (const fn of listeners.get(type) || []) fn(event); },
    });
  };
  const query = eventTarget({ matches: false });
  const reduced = eventTarget({ matches: !motion });
  const phone = eventTarget({ matches: false });
  let activeAnimation = null;
  const layout = { lockedWidth: null, begins: 0, ends: 0 };
  class Element {
    constructor(id) { this.id = id; this.attrs = new Map(); this.isConnected = true; const values = new Set();
      this.classList = { contains: name => values.has(name), toggle(name, on) { if (on) values.add(name); else values.delete(name); } }; }
    setAttribute(name, value) { this.attrs.set(name, value); } removeAttribute(name) { this.attrs.delete(name); }
    addEventListener() {} dispatchEvent() {} focus() { document.activeElement = this; }
    contains(target) { return target === this || target?.parent === this; }
    querySelector(selector) { return selector === '#tagRelayRailClose' ? close : null; }
    animate(keyframes, options) {
      let resolve, reject, settled = false;
      const finished = new Promise((success, failure) => { resolve = success; reject = failure; });
      const animation = { keyframes, options, finished, playState: 'running', visualWidth: keyframes[0].flexBasis, cancellations: 0,
        finish() { if (settled) return; settled = true; this.playState = 'finished'; resolve(); },
        cancel() {
          this.cancellations += 1; this.playState = 'idle';
          if (!settled) { settled = true; reject(new DOMException('synthetic cancellation', 'AbortError')); }
        },
      };
      activeAnimation = animation;
      animations.push(animation);
      order.push({ action: 'animate', lockedWidth: layout.lockedWidth });
      return animation;
    }
  }
  const rail = new Element('tagRelayRail'), close = new Element('tagRelayRailClose'); close.parent = rail;
  if (!supportsAnimation) rail.animate = undefined;
  const button = new Element('tagRelayBtn'), lightbox = new Element('lightbox'), focus = new Element('foreground'); focus.parent = lightbox;
  const document = eventTarget({ body: new Element('body'), documentElement: new Element('html'), activeElement: button, visibilityState: 'visible',
    querySelector: selector => ({ '#tagRelayRail': rail, '#tagRelayRailClose': close, '#tagRelayBtn': button, '#lightbox': lightbox }[selector] || null) });
  const window = eventTarget({ innerWidth: 1440, innerHeight: 820, matchMedia: value => value.includes('1240') ? query : value.includes('600') ? phone : reduced });
  let top = null;
  const computedWidth = () => activeAnimation?.playState === 'running' ? activeAnimation.visualWidth : rail.classList.contains('closed') ? '0px' : '440px';
  const deps = { document, window, getComputedStyle: () => ({ flexBasis: query.matches ? 'auto' : computedWidth() }),
    HTMLElement: Element, CustomEvent: class {}, localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    registerHistoryLayer() {}, openHistoryLayer: id => { ownership.push({ id, lockedWidth: layout.lockedWidth }); calls.push('open:' + id); }, closeHistoryLayer: id => { calls.push('close:' + id); return false; },
    forgetHistoryLayer: id => calls.push('forget:' + id), trapFocus() {}, topInteractionLayer: () => top,
    retireHistoryLayer: id => calls.push('retire:' + id),
    cancelRelayAction() {}, settleRelayMotion() {}, prefersReducedMotion: () => reduced.matches, RELAYOUT_ANIM_MS: animationDuration, queueMicrotask };
  // Keep the actual animation owner/cancellation behavior; only the browser's
  // Animation object and CSS measurements are synthetic and explicitly driven.
  Object.assign(deps, new Function('deps', `with(deps){${motionSource}\nreturn {animateUi,cancelUiMotion};}`)(deps));
  const api = new Function('deps', `with(deps){${source}\nreturn {setupTagRelayRail,openRelayRail,closeRelayRail,isRelayRailOpen,setRelayRailLayoutActions};}`)(deps);
  api.setRelayRailLayoutActions({
    begin() {
      // beginMasonryResize replaces a single final-width lock on reversal; it
      // is deliberately not a reference count of all animation generations.
      layout.lockedWidth = rail.classList.contains('closed') ? 1119 : 681;
      layout.begins += 1;
      order.push({ action: 'begin', lockedWidth: layout.lockedWidth });
    },
    end() { layout.lockedWidth = null; layout.ends += 1; order.push({ action: 'end' }); },
  });
  api.setupTagRelayRail(); if (openInitially) api.openRelayRail(button);
  return { api, rail, close, button, lightbox, focus, document, calls, stored, animations, layout, order, ownership,
    foreground(value) { top = value; }, resize(narrow) { query.matches = narrow; query.emit('change'); },
    reduce(value) { reduced.matches = value; reduced.emit('change'); },
    hide() { document.visibilityState = 'hidden'; document.emit('visibilitychange'); },
    resizeWindow(width, height = window.innerHeight) { window.innerWidth = width; window.innerHeight = height; window.emit('resize'); },
    visualWidth(value) { assert.equal(activeAnimation?.playState, 'running'); activeAnimation.visualWidth = value; },
  };
}
await test('lower dock closes silently under foreground and preserves desktop preference', () => {
  const f = fixture(); f.foreground(f.lightbox); f.document.activeElement = f.focus; f.resize(true);
  assert.equal(f.document.activeElement, f.focus); assert.equal(f.api.isRelayRailOpen(), false);
  assert.deepEqual(f.calls, []); assert.equal(f.stored.get('fadian-tag-relay-rail'), 'open');
  f.resize(false); assert.deepEqual(f.calls, []); assert.equal(f.document.activeElement, f.focus);
});
await test('foreground-free dock acquires one modal layer and focus, wide returns it', () => {
  const f = fixture(); f.resize(true); assert.deepEqual(f.calls, ['open:tag-relay-rail']); assert.equal(f.document.activeElement, f.close);
  f.resize(false); assert.deepEqual(f.calls, ['open:tag-relay-rail', 'close:tag-relay-rail']); assert.equal(f.api.isRelayRailOpen(), true);
});
await test('modal rail becoming docked under foreground retires without Back', () => {
  const f = fixture(); f.resize(true); f.calls.length = 0;
  f.foreground(f.lightbox); f.document.activeElement = f.focus; f.resize(false);
  assert.deepEqual(f.calls, ['retire:tag-relay-rail']); assert.equal(f.document.activeElement, f.focus);
});
await test('docked open and close lock the final layout before animation and release once', async () => {
  const f = fixture({ motion: true, openInitially: false });
  f.api.openRelayRail(f.button);
  const opening = f.animations[0];
  assert.equal(f.layout.lockedWidth, 681);
  assert.deepEqual(f.order, [{ action: 'begin', lockedWidth: 681 }, { action: 'animate', lockedWidth: 681 }]);
  assert.deepEqual(opening.keyframes, [{ flexBasis: '0px', width: '0px' }, { flexBasis: '440px', width: '440px' }]);
  assert.equal(opening.options.duration, animationDuration);
  assert.equal(opening.options.fill, 'none');
  opening.finish(); await microtasks();
  assert.equal(f.layout.lockedWidth, null);
  assert.equal(f.layout.ends, 1);
  assert.equal(opening.cancellations, 1, 'completed WAAPI effect is removed by the actual motion owner');
  f.api.closeRelayRail();
  const closing = f.animations[1];
  assert.equal(f.api.isRelayRailOpen(), false);
  assert.equal(f.rail.inert, true);
  assert.equal(f.layout.lockedWidth, 1119);
  assert.deepEqual(closing.keyframes, [{ flexBasis: '440px', width: '440px' }, { flexBasis: '0px', width: '0px' }]);
  closing.finish(); await microtasks();
  assert.equal(f.layout.lockedWidth, null);
  assert.equal(f.layout.ends, 2);
  f.hide(); assert.equal(f.layout.ends, 2, 'a completed generation cannot release twice');
});
await test('a rejected animation releases layout without closing the logical dock', async () => {
  const f = fixture({ motion: true });
  f.animations[0].cancel(); await microtasks();
  assert.equal(f.layout.lockedWidth, null);
  assert.equal(f.layout.ends, 1);
  assert.equal(f.api.isRelayRailOpen(), true);
  f.resizeWindow(1300); assert.equal(f.layout.ends, 1);
});
await test('rapid reversals preserve visual width and only the newest generation releases layout', async () => {
  const f = fixture({ motion: true });
  const opening = f.animations[0];
  f.visualWidth('177px'); f.api.closeRelayRail();
  const closing = f.animations[1];
  assert.equal(opening.cancellations, 1);
  assert.equal(closing.keyframes[0].flexBasis, '177px');
  assert.equal(closing.keyframes[1].flexBasis, '0px');
  assert.equal(f.layout.lockedWidth, 1119);
  await microtasks();
  assert.equal(f.layout.ends, 0, 'cancelled opening cannot unlock its replacement');
  f.visualWidth('90px'); f.api.openRelayRail(f.button);
  const reopened = f.animations[2];
  assert.equal(closing.cancellations, 1);
  assert.equal(reopened.keyframes[0].flexBasis, '90px');
  assert.equal(reopened.keyframes[1].flexBasis, '440px');
  await microtasks();
  assert.equal(f.layout.lockedWidth, 681);
  assert.equal(f.layout.begins, 3);
  assert.equal(f.layout.ends, 0, 'both stale promises must leave the newest width lock intact');
  reopened.finish(); await microtasks();
  assert.equal(f.layout.lockedWidth, null);
  assert.equal(f.layout.ends, 1);
});
await test('crossing a breakpoint cancels dock motion and releases its layout lock before modal ownership', async () => {
  const f = fixture({ motion: true });
  f.resize(true);
  assert.equal(f.animations[0].cancellations, 1);
  assert.equal(f.layout.lockedWidth, null);
  assert.equal(f.layout.ends, 1);
  assert.deepEqual(f.calls, ['open:tag-relay-rail']);
  assert.deepEqual(f.ownership, [{ id: 'tag-relay-rail', lockedWidth: null }], 'modal ownership is recorded only after the dock width lock is released');
  assert.equal(f.document.activeElement, f.close);
  await microtasks();
  assert.equal(f.layout.ends, 1);
  f.resize(false);
  assert.equal(f.layout.lockedWidth, null);
  assert.equal(f.layout.begins, 1, 'returning to docked form alone must not start another width animation');
  assert.deepEqual(f.calls, ['open:tag-relay-rail', 'close:tag-relay-rail']);
});
await test('enabling reduced motion releases the active lock and later transitions finish synchronously', async () => {
  const f = fixture({ motion: true });
  f.reduce(true);
  assert.equal(f.layout.lockedWidth, null);
  assert.equal(f.animations[0].cancellations, 1);
  await microtasks(); assert.equal(f.layout.ends, 1);
  f.api.closeRelayRail();
  assert.equal(f.animations.length, 1);
  assert.equal(f.layout.lockedWidth, null);
  assert.equal(f.layout.begins, 2);
  assert.equal(f.layout.ends, 2);
});
await test('hiding the document cancels active dock motion and releases layout once', async () => {
  const f = fixture({ motion: true });
  f.hide();
  assert.equal(f.layout.lockedWidth, null);
  assert.equal(f.animations[0].cancellations, 1);
  await microtasks(); f.hide();
  assert.equal(f.layout.ends, 1);
});
await test('height-only resize keeps the active lock while an actual width resize releases it', async () => {
  const f = fixture({ motion: true });
  f.resizeWindow(1440, 720);
  assert.equal(f.layout.lockedWidth, 681);
  assert.equal(f.layout.ends, 0);
  f.resizeWindow(1320, 720);
  assert.equal(f.layout.lockedWidth, null);
  assert.equal(f.animations[0].cancellations, 1);
  await microtasks(); assert.equal(f.layout.ends, 1);
});
await test('missing WAAPI support releases the final-width lock synchronously', () => {
  const f = fixture({ motion: true, supportsAnimation: false });
  assert.equal(f.animations.length, 0);
  assert.equal(f.layout.begins, 1);
  assert.equal(f.layout.ends, 1);
  assert.equal(f.layout.lockedWidth, null);
});
console.log(JSON.stringify({ cases }, null, 2));
if (cases.some(item => item.status === 'FAIL')) process.exitCode = 1;
else console.log(`tag relay rail: PASS (${cases.length} cases)`);
