import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../site/assets/app/tag-relay-rail.js', import.meta.url), 'utf8')
  .replace(/^import [^\r\n]* from ['"][^'"]+['"];\r?\n/gm, '').replace(/^export\s+/gm, '');
const cases = [];
async function test(name, action) {
  try { await action(); cases.push({ name, status: 'PASS' }); }
  catch (error) { cases.push({ name, status: 'FAIL', error: error.message }); }
}
function fixture() {
  const listeners = new Map(), calls = [], stored = new Map();
  class Element {
    constructor(id) { this.id = id; this.attrs = new Map(); this.isConnected = true; const values = new Set();
      this.classList = { contains: name => values.has(name), toggle(name, on) { if (on) values.add(name); else values.delete(name); } }; }
    setAttribute(name, value) { this.attrs.set(name, value); } removeAttribute(name) { this.attrs.delete(name); }
    addEventListener() {} dispatchEvent() {} focus() { document.activeElement = this; }
    contains(target) { return target === this || target?.parent === this; }
    querySelector(selector) { return selector === '#tagRelayRailClose' ? close : null; }
  }
  const rail = new Element('tagRelayRail'), close = new Element('tagRelayRailClose'); close.parent = rail;
  const button = new Element('tagRelayBtn'), lightbox = new Element('lightbox'), focus = new Element('foreground'); focus.parent = lightbox;
  const document = { body: new Element('body'), activeElement: button, addEventListener() {},
    querySelector: selector => ({ '#tagRelayRail': rail, '#tagRelayRailClose': close, '#tagRelayBtn': button, '#lightbox': lightbox }[selector] || null) };
  let top = null;
  const query = { matches: false, addEventListener(type, fn) { listeners.set(type, fn); } };
  const deps = { document, window: { matchMedia: value => value.includes('1240') ? query : { addEventListener() {} }, addEventListener() {} },
    HTMLElement: Element, CustomEvent: class {}, localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    registerHistoryLayer() {}, openHistoryLayer: id => calls.push('open:' + id), closeHistoryLayer: id => { calls.push('close:' + id); return false; },
    forgetHistoryLayer: id => calls.push('forget:' + id), trapFocus() {}, topInteractionLayer: () => top,
    retireHistoryLayer: id => calls.push('retire:' + id),
    cancelRelayAction() {}, settleRelayMotion() {}, prefersReducedMotion: () => true, queueMicrotask };
  const api = new Function('deps', `with(deps){${source}\nreturn {setupTagRelayRail,openRelayRail,isRelayRailOpen};}`)(deps);
  api.setupTagRelayRail(); api.openRelayRail(button);
  return { api, rail, close, button, lightbox, focus, document, calls, stored,
    foreground(value) { top = value; }, resize(narrow) { query.matches = narrow; listeners.get('change')(); } };
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
console.log(JSON.stringify({ cases }, null, 2));
if (cases.some(item => item.status === 'FAIL')) process.exitCode = 1;
else console.log(`tag relay rail: PASS (${cases.length} cases)`);
