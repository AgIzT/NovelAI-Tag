// Actual admin module graph with synthetic DOM/fetch/editor inputs; no network or user storage.
// node --experimental-vm-modules tools/test_feedback_pagination_ui.mjs [--baseline]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';

const baseline = process.argv.includes('--baseline');
const root = path.resolve('site/assets');
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const response = data => new Response(JSON.stringify({ ok: true, indexing: false, ...data }));
const item = (id, status = 'resolved') => ({ id, status, description: id, createdAt: 1 });
const page = (id, offset = 0, total = 401) => ({ items: id ? [item(id)] : [], offset, total,
  nextCursor: offset < 400 && total > 200 ? 'next-page' : '', previousCursor: offset > 200 ? 'previous-page' : '' });
function node() {
  const listeners = new Map(), classes = new Set();
  return { dataset: {}, hidden: false, innerHTML: '', textContent: '', placeholder: '', style: {},
    classList: { add: key => classes.add(key), remove: key => classes.delete(key),
      contains: key => classes.has(key), toggle(key, on) { if (on) classes.add(key); else classes.delete(key); } },
    addEventListener(name, listener) { listeners.set(name, listener); },
    fire(name, event) { return listeners.get(name)?.(event); },
    querySelector() { return null; }, querySelectorAll() { return []; }, setAttribute() {}, focus() {},
  };
}
async function fixture(handler) {
  const nodes = new Map(), calls = [], timers = new Map(); let nextTimer = 0, allowDiscard = true;
  const get = selector => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); };
  const document = { querySelector: get, querySelectorAll: () => [], addEventListener() {},
    body: node(), documentElement: node() };
  const context = vm.createContext({ console, URL, Response, AbortController, DOMException, document,
    window: { matchMedia: () => ({ matches: false }), addEventListener() {} },
    confirm: () => allowDiscard, localStorage: { removeItem() {}, getItem() { return null; } },
    sessionStorage: { getItem() { return 'synthetic'; }, removeItem() {} },
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch(url, options = {}) { const call = { url: new URL(url, 'https://local.test'), options }; calls.push(call); return handler(call, calls); },
  });
  const modules = new Map();
  function moduleAt(filename) {
    if (modules.has(filename)) return modules.get(filename);
    let source;
    if (filename === path.join(root, 'admin/editor.js')) source = `
      export function collectCommunityEdits() { return {}; }
      export function collectFeedbackUpdate() { return {progressStatus:'completed',adminReply:'synthetic reply',publicVisible:false}; }
      export function resetParamsRecheckMemo() {}
      export function setParamsRecheckErrorHandler() {}
      export function renderCommunityDetail() { return ''; }
      export function renderFeedbackDetail(item) { return item?.id || ''; }
      export function verifyPendingParams() {}`;
    else source = baseline && filename.includes(`${path.sep}admin${path.sep}`)
      ? execFileSync('git', ['show', `HEAD:${path.relative(process.cwd(), filename).split(path.sep).join('/')}`], { encoding: 'utf8' })
      : readFileSync(filename, 'utf8');
    if (filename === path.join(root, 'admin/actions.js')) source += '\nexport { loadCurrent, runFeedbackAction, bindDelegates };';
    const mod = new vm.SourceTextModule(source, { context, identifier: filename }); modules.set(filename, mod); return mod;
  }
  const actions = moduleAt(path.join(root, 'admin/actions.js'));
  await actions.link((specifier, importing) => moduleAt(path.resolve(path.dirname(importing.identifier), specifier)));
  await actions.evaluate();
  const state = modules.get(path.join(root, 'admin/state.js')).namespace.state;
  state.view = 'feedback'; state.feedbackStatus = 'resolved';
  state.feedbackPage = { offset: 0, total: 401, nextCursor: 'next-page', previousCursor: '' };
  actions.namespace.bindDelegates();
  function click(selector, dataset) {
    get('#toolbar').fire('click', { target: { closest: candidate => candidate === selector ? { dataset } : null } });
  }
  return { actions: actions.namespace, state, nodes, get, calls, click, denyDiscard() { allowDiscard = false; } };
}
const cases = [
  ['delegated next page clears old selection and labels the persistent query scope', async () => {
    let release;
    const f = await fixture(() => new Promise(resolve => { release = resolve; }));
    f.state.query = 'old'; f.state.feedbackItems = [item('old')]; f.state.selectedFeedbackId = 'old';
    f.click('[data-feedback-page]', { feedbackPage: 'next' }); await flush();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url.searchParams.get('cursor'), 'next-page');
    assert.equal(f.state.selectedFeedbackId, ''); assert.equal(f.get('#detail').innerHTML, '');
    release(response(page('new', 200))); await flush();
    assert.equal(f.state.feedbackPage.offset, 200); assert.equal(f.state.selectedFeedbackId, 'new');
    assert.equal(f.state.query, 'old'); assert.match(f.get('#globalSearch').placeholder, /仅筛选本页/);
    assert.match(f.get('#toolbar').innerHTML, /201–201 \/ 401 条 · 本页匹配 0 条/);
  }],
  ['status switch aborts an older page and rejects its late completion', async () => {
    let release;
    const f = await fixture((_, calls) => calls.length === 1 ? new Promise(resolve => { release = resolve; })
      : response({ ...page('current', 0, 1), items: [item('current', 'pending')] }));
    const old = f.actions.loadCurrent({ feedbackCursor: 'old-cursor' }); await flush();
    f.click('[data-feedback-status]', { feedbackStatus: 'pending' }); await flush();
    assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.calls[1].url.searchParams.has('cursor'), false);
    release(response(page('late', 200))); await old; await flush();
    assert.equal(f.state.feedbackStatus, 'pending'); assert.equal(f.state.feedbackItems[0].id, 'current');
    assert.equal(f.state.feedbackPage.offset, 0); assert.equal(f.state.selectedFeedbackId, 'current');
  }],
  ['refresh resets the page and prevents stale page contents from reappearing', async () => {
    let release;
    const f = await fixture((_, calls) => calls.length === 1 ? new Promise(resolve => { release = resolve; }) : response(page('fresh')));
    const old = f.actions.loadCurrent({ feedbackCursor: 'old-cursor' }); await flush();
    f.click('[data-reload]', {}); await flush();
    assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.calls[1].url.searchParams.has('cursor'), false);
    release(response(page('late', 200))); await old; await flush();
    assert.equal(f.state.feedbackItems[0].id, 'fresh'); assert.equal(f.state.feedbackPage.offset, 0);
  }],
  ['deleting the last tail item reloads a complete empty first page', async () => {
    const f = await fixture(call => call.url.pathname.endsWith('/feedback-delete') ? response({}) : response(page('', 0, 0)));
    f.state.feedbackPage.offset = 200; f.state.feedbackPage.total = 201;
    f.state.feedbackItems = [item('last')]; f.state.selectedFeedbackId = 'last';
    await f.actions.runFeedbackAction('delete');
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].url.searchParams.has('cursor'), false);
    assert.equal(f.state.feedbackPage.total, 0); assert.equal(f.state.feedbackPage.offset, 0);
    assert.equal(f.state.feedbackItems.length, 0); assert.equal(f.state.selectedFeedbackId, '');
    assert.match(f.get('#toolbar').innerHTML, /第 0 \/ 0 条/);
  }],
  ['status migration reloads the first page and clears the moved item', async () => {
    const f = await fixture(call => call.url.pathname.endsWith('/feedback-decide')
      ? response({ item: item('moved', 'resolved') }) : response({ ...page('remaining', 0, 1), items: [item('remaining', 'pending')] }));
    f.state.feedbackStatus = 'pending'; f.state.feedbackPage.offset = 200;
    f.state.feedbackItems = [item('middle', 'pending'), item('moved', 'pending'), item('tail', 'pending')];
    f.state.selectedFeedbackId = 'moved';
    await f.actions.runFeedbackAction('save');
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].url.searchParams.has('cursor'), false);
    assert.equal(f.state.feedbackPage.offset, 0); assert.equal(f.state.selectedFeedbackId, 'remaining');
    assert.ok(!f.state.feedbackItems.some(value => value.id === 'moved'));
  }],
  ['discard rejection leaves page, query, and selection intact', async () => {
    const f = await fixture(() => { throw new Error('unexpected request'); });
    f.state.feedbackItems = [item('edited')]; f.state.selectedFeedbackId = 'edited'; f.state.dirty = true;
    f.denyDiscard(); f.click('[data-feedback-page]', { feedbackPage: 'next' }); await flush();
    assert.equal(f.calls.length, 0); assert.equal(f.state.selectedFeedbackId, 'edited'); assert.equal(f.state.dirty, true);
  }],
];
let failed = 0;
for (const [name, test] of cases) {
  try { await test(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}
console.log(`feedback pagination UI: ${failed ? 'FAIL' : 'PASS'} (${cases.length - failed}/${cases.length})`);
if (failed) process.exitCode = 1;
