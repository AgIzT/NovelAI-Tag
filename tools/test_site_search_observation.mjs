import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSiteAnalytics } from '../site/assets/app/site-analytics.js';

function fixture() {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const calls = [];
  const host = {
    navigator: {}, location: { protocol: 'https:', origin: 'https://metrics.example.test' },
    Date: { now: () => now }, AbortController,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) { calls.push(options); return Response.json({ enabled: true }); },
  };
  for (const key of ['localStorage', 'sessionStorage', 'crypto']) {
    Object.defineProperty(host, key, { get() { throw new Error(`Forbidden analytics access: ${key}`); } });
  }
  const analytics = createSiteAnalytics({ enabled: true, host });
  return {
    analytics,
    async tick(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
      }
      await Promise.resolve();
    },
    events: () => calls.filter(call => call.method === 'POST').flatMap(call => JSON.parse(call.body).events),
  };
}

const result = (scope = 'codex', hasResults = true) => ({ active: true, valid: true, hasResults, scope });
for (const scope of ['codex', 'site', 'favorites']) {
  for (const hasResults of [false, true]) {
    const f = fixture();
    await f.analytics.start();
    const settle = f.analytics.beginSearch();
    settle(result(scope, hasResults));
    await f.tick(799); await f.analytics.flush();
    assert.deepEqual(f.events(), []);
    await f.tick(1); await f.analytics.flush();
    assert.deepEqual(f.events(), [{ name: hasResults ? 'search_success' : 'search_empty', detail: scope }]);
    settle(result(scope, hasResults));
    await f.tick(800); await f.analytics.flush();
    assert.equal(f.events().length, 1, 'a completed observation cannot count twice');
    f.analytics.stop();
  }
}

for (const invalid of [{ active: false }, { valid: false }, { scope: 'unknown' }]) {
  const f = fixture();
  await f.analytics.start();
  const settle = f.analytics.beginSearch();
  settle(result());
  await f.tick(799);
  settle({ ...result(), ...invalid });
  await f.tick(1); await f.analytics.flush();
  assert.deepEqual(f.events(), [], 'an invalid/inactive callback cancels its already scheduled result');
  settle(result());
  await f.tick(800); await f.analytics.flush();
  assert.deepEqual(f.events(), [], 'a canceled callback cannot resurrect its observation');
  f.analytics.stop();
}

{
  const f = fixture();
  await f.analytics.start();
  const old = f.analytics.beginSearch();
  old(result('codex', false));
  await f.tick(799);
  const latest = f.analytics.beginSearch();
  latest(result('site'));
  old({ ...result(), valid: false });
  await f.tick(800); await f.analytics.flush();
  assert.deepEqual(f.events(), [{ name: 'search_success', detail: 'site' }], 'an obsolete callback cannot cancel a newer search');
  f.analytics.stop();
}

{
  const f = fixture();
  await f.analytics.start();
  const settle = f.analytics.beginSearch();
  settle(result('favorites', false));
  await f.tick(400);
  settle(result('favorites', true));
  await f.tick(400); await f.analytics.flush();
  assert.deepEqual(f.events(), [], 'updated results restart only the metrics settling timer');
  await f.tick(400); await f.analytics.flush();
  assert.deepEqual(f.events(), [{ name: 'search_success', detail: 'favorites' }]);
  f.analytics.cancelSearch(); await f.analytics.flush();
  assert.equal(f.events().length, 1, 'canceling does not erase already completed events');
  f.analytics.stop();
}

async function source(path) { return readFile(new URL(`../site/assets/${path}`, import.meta.url), 'utf8'); }
function between(text, start, end) {
  const left = text.indexOf(start);
  const right = text.indexOf(end, left + start.length);
  assert.ok(left >= 0 && right > left, `Missing action boundary: ${start}`);
  return text.slice(left, right);
}
function bindFunction(text, deps) {
  return new Function(...Object.keys(deps), `return (${text.replace(/^export /, '')});`)(...Object.values(deps));
}

const app = await source('app.js');
const ui = await source('app/ui.js');
const applyBody = between(app, 'export async function applySearch(', '\nfunction searchDirectoryOptions(');
const filterBody = between(app, 'export function applyFilter(', '\n/* 取消、撤销');
const observedBody = between(app, 'async function applyObservedSearch(', '\nexport async function applySearch(');
function filterDependencies(state, plan, analytics) {
  return {
    state, cancelSiteSearchObservation: () => analytics.cancelSearch(), compileSearchState: () => plan,
    isCodexLocked: () => false, isEntryAccessBlocked: () => false,
    listSearchDirectories: () => [], searchDirectoryOptions: () => [], virtualView: () => state.siteSearchView || state.favoritesView,
    matchSearchPlan: () => true, codexUpdateFilters: () => [], entryMatchesUpdateFilter: () => true,
    filterFavoritesScope: value => value, isContentBlocked: () => false, filterFavoritesEntries: value => value,
    rankSearchResults: value => value, pinFeatured: value => value, findRelatedDirectories: () => [],
    renderSearchExperience() {}, updateResultBar() {}, syncFavoritesView() {}, renderFavoritesRail() {},
    renderFavoritesHeader() {}, refreshFavoriteBadges() {}, renderList() {}, updateBlockingSummary() {},
  };
}

for (const scope of ['codex', 'site', 'favorites']) {
  const f = fixture(); await f.analytics.start();
  const plan = { hasActiveSearch: true, hasErrors: false, filters: [], positiveTerms: [] };
  const state = { codex: { entries: [{}] }, favoritesView: scope === 'favorites', siteSearchView: scope === 'site', activePath: [], updateFilter: '', searchScope: scope };
  const filter = bindFunction(filterBody, filterDependencies(state, plan, f.analytics));
  const apply = bindFunction(applyBody, {
    state, window: { scrollY: 0 }, cancelSiteSearchObservation: () => f.analytics.cancelSearch(),
    hasActiveSearchState: () => true, applyFilter: filter, syncUrlState() {}, historyModeFor: () => 'replace',
  });
  const observed = bindFunction(observedBody, { beginSiteSearchObservation: () => f.analytics.beginSearch(), applySearch: apply });
  await observed(); await f.tick(800); await f.analytics.flush();
  assert.deepEqual(f.events(), [{ name: 'search_success', detail: scope }], 'real search/filter bodies preserve scope and valid completion');
  f.analytics.stop();
}

{
  const f = fixture(); await f.analytics.start();
  const plan = { hasActiveSearch: true, hasErrors: false, filters: [], positiveTerms: [] };
  const state = { codex: { entries: [] }, favoritesView: false, siteSearchView: false, searchScope: 'site', active: true, activePath: [], updateFilter: '' };
  const filter = bindFunction(filterBody, filterDependencies(state, plan, f.analytics));
  const pending = [];
  let renders = 0;
  const deps = {
    state, window: { scrollY: 0 }, cancelSiteSearchObservation: () => f.analytics.cancelSearch(),
    cancelCodexSwitch() {}, virtualView: () => state.siteSearchView, invalidateOrganizeRequest() {},
    showSkeleton() {}, hideSkeleton() {}, setLoading() {}, clearMasonry() {}, setOnlyFavControl() {},
    buildSiteSearchCodex: () => new Promise(resolve => pending.push(resolve)),
    siteSearchStillWanted: () => state.searchScope === 'site' && state.active,
    runCodexViewTransition: async (seq, render) => render(), replaceSkeleton: (seq, render) => render(),
    renderCodexView(codex, seq, args) {
      renders++;
      state.codex = codex;
      args.enterView();
      filter({ onSearchSettled: args.options.onSearchSettled });
    },
    recordSiteEvent() { assert.fail('no data error expected'); },
  };
  const openBody = between(app, 'export async function openSiteSearchView(', '\nexport function exitSiteSearchView(');
  const open = new Function(...Object.keys(deps), `let codexLoadSeq = 0; return (${openBody.replace(/^export /, '')});`)(...Object.values(deps));
  const apply = bindFunction(applyBody, {
    state, window: { scrollY: 0 }, cancelSiteSearchObservation: () => f.analytics.cancelSearch(),
    hasActiveSearchState: () => state.active, openSiteSearchView: open, applyFilter: filter,
    syncUrlState() {}, historyModeFor: () => 'replace',
  });
  const observed = bindFunction(observedBody, { beginSiteSearchObservation: () => f.analytics.beginSearch(), applySearch: apply });
  const old = observed();
  const latest = observed();
  pending[0]({ entries: [] }); await old;
  assert.equal(renders, 0, 'real async site search rejects the obsolete load generation');
  await f.tick(800); await f.analytics.flush();
  assert.deepEqual(f.events(), []);
  pending[1]({ entries: [{}] }); await latest;
  await f.tick(800); await f.analytics.flush();
  assert.deepEqual(f.events(), [{ name: 'search_success', detail: 'site' }]);
  state.siteSearchView = false;
  const departed = observed();
  state.searchScope = 'codex';
  await apply();
  pending[2]({ entries: [] }); await departed;
  await f.tick(800); await f.analytics.flush();
  assert.equal(renders, 1, 'departing rejects the late site-search render');
  assert.equal(f.events().length, 1, 'departing never counts the late async callback');
  f.analytics.stop();
}

for (const operation of ['raw-search', 'raw-results', 'invalid-results']) {
  const f = fixture(); await f.analytics.start();
  const plan = { hasActiveSearch: true, hasErrors: false, filters: [], positiveTerms: [] };
  const state = { codex: { entries: [{}] }, favoritesView: false, siteSearchView: false, activePath: [], updateFilter: '' };
  const filter = bindFunction(filterBody, filterDependencies(state, plan, f.analytics));
  const settle = f.analytics.beginSearch();
  filter({ onSearchSettled: settle });
  await f.tick(799);
  if (operation === 'raw-search') {
    const apply = bindFunction(applyBody, {
      state, window: { scrollY: 0 }, cancelSiteSearchObservation: () => f.analytics.cancelSearch(),
      applyFilter: filter, syncUrlState() {}, historyModeFor: () => 'replace',
    });
    await apply();
  } else if (operation === 'raw-results') {
    state.codex.entries = [];
    filter();
  } else {
    plan.hasErrors = true;
    filter({ onSearchSettled: settle });
  }
  await f.tick(1); await f.analytics.flush();
  assert.deepEqual(f.events(), [], `${operation} cancels the previous pending result`);
  f.analytics.stop();
}

{
  const f = fixture(); await f.analytics.start();
  const settle = f.analytics.beginSearch(); settle(result('codex', false));
  await f.tick(799);
  let returnedByHistory = false;
  const state = { query: 'example', searchFilterValues: [] };
  const text = between(ui, '  const applySearchConditions = async ', '\n  const pendingSyntax');
  const body = text.trim().replace(/^const applySearchConditions = /, '').replace(/;$/, '');
  const clear = bindFunction(body, {
    state, window: { scrollY: 0 }, searchIsActive: () => Boolean(state.query),
    compileSearchState(query) { state.query = query; return { hasActiveSearch: Boolean(query) }; },
    searchInput: { value: state.query }, updateSearchClear() {},
    searchHistoryIntent: { begin: () => ({ needsInitialHistory: false, layered: false, historyMode: 'replace' }) },
    mobileQuery: { matches: false }, topHistoryLayerId: () => '',
    goBackFrom() { returnedByHistory = true; return true; },
    uiActions: { cancelSearchObservation: () => f.analytics.cancelSearch(), applySearch() { assert.fail('history early return must remain unchanged'); } },
  });
  await clear({ query: '' });
  assert.equal(returnedByHistory, true);
  await f.tick(1); await f.analytics.flush();
  assert.deepEqual(f.events(), [], 'real clear/history early return cancels before the old 800 ms deadline');
  settle(result()); await f.tick(800); await f.analytics.flush();
  assert.deepEqual(f.events(), [], 'a late async callback after clear is also obsolete');
  f.analytics.stop();
}

// Execute navigation entry bodies until their first existing business operation.
// A sentinel avoids loading content or changing routes while proving early cancellation.
for (const [start, end] of [
  ['export async function loadCodex(', '\n/* 换书接力'],
  ['export async function openFavoritesView(', '\nexport async function openSiteSearchView('],
  ['export async function openSiteSearchView(', '\nexport function exitSiteSearchView('],
  ['export function exitSiteSearchView(', '\nexport async function openRelatedDirectory('],
  ['async function refreshFavoritesView(', '\nasync function applyAtlasHistoryRoute('],
]) {
  for (const observed of [false, true]) {
    const f = fixture(); await f.analytics.start();
    const settle = f.analytics.beginSearch(); settle(result()); await f.tick(799);
    const sentinel = new Error('stop before business action');
    const action = bindFunction(between(app, start, end), {
      cancelSiteSearchObservation: () => f.analytics.cancelSearch(),
      window: { get scrollY() { throw sentinel; } }, state: new Proxy({}, { get() { throw sentinel; } }),
    });
    const options = observed ? { onSearchSettled: settle } : {};
    try {
      if (start.includes('loadCodex(')) await action('next-book', options);
      else await action(options);
      assert.fail('expected business sentinel');
    } catch (error) { assert.equal(error, sentinel); }
    await f.tick(1); await f.analytics.flush();
    assert.equal(f.events().length, observed ? 1 : 0, `${start}: raw navigation cancels, observed forwarding preserves the callback`);
    f.analytics.stop();
  }
}

assert.ok(app.includes('cancelSearchObservation: cancelSiteSearchObservation'));
assert.ok(app.includes('applyFilter({ resetScroll: true, onSearchSettled: options.onSearchSettled })'));
console.log('PASS search observation cancellation: 800 ms clear/history, raw search/results, invalid callbacks, navigation, scopes, latest-only completion');
