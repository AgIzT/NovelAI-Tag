// Real ES module graphs, synthetic fetch and a controlled clock; no network or user storage.
// node --experimental-vm-modules tools/test_frontend_loading_recovery.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve('site/assets');
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const shard = (shards = [], m = {}) => ({ schema: 1, shards, m });
const book = id => ({ id, title: id, entries: [{ id: `${id}-entry`, title: id, tags: 'cat' }] });
const watch = promise => {
  const observed = { settled: false };
  promise.then(value => Object.assign(observed, { settled: true, value }),
    error => Object.assign(observed, { settled: true, error }));
  return observed;
};

async function environment(handler, hostname = 'localhost') {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const calls = [];
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, DOMException, Response, Promise,
    console: { warn() {}, error() {}, log() {} },
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    location: { hostname, protocol: 'https:', href: `https://${hostname}/` },
    fetch(url, options = {}) {
      const call = { url: String(url), options, aborted: false };
      calls.push(call);
      options.signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
      return handler(call, calls);
    },
  });
  const modules = new Map();
  function moduleFor(filename) {
    if (!modules.has(filename)) modules.set(filename, new vm.SourceTextModule(readFileSync(filename, 'utf8'), {
      context, identifier: filename,
    }));
    return modules.get(filename);
  }
  async function load(name) {
    const mod = moduleFor(path.join(root, name));
    if (mod.status === 'unlinked') await mod.link((specifier, parent) => moduleFor(path.resolve(path.dirname(parent.identifier), specifier)));
    if (mod.status === 'linked') await mod.evaluate();
    return mod.namespace;
  }
  async function advance(ms) {
    now += ms;
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    await flush();
  }
  return { load, calls, advance, timers };
}

function hanging(call) {
  return new Promise((resolve, reject) => {
    if (call.options.signal?.aborted) reject(call.options.signal.reason);
    else call.options.signal?.addEventListener('abort', () => reject(call.options.signal.reason), { once: true });
  });
}

const cases = [];
const test = (name, run) => cases.push({ name, run });

async function relayTranslationCaller(env) {
  const tag = await env.load('app/tag-zh.js');
  const source = readFileSync(path.join(root, 'app/tag-relay-compose.js'), 'utf8');
  const start = source.indexOf('function warmTranslations(');
  const end = source.indexOf('\nfunction translate(', start);
  assert.ok(start >= 0 && end > start);
  let renders = 0;
  const context = vm.createContext({
    requestedZh: new Set(), loadTagZh: tag.loadTagZh, isTagZhComplete: tag.isTagZhComplete,
    editor: { render() { renders++; vm.runInContext("warmTranslations('a')", context); } },
  });
  vm.runInContext(source.slice(start, end), context);
  return { tag, warm: () => vm.runInContext("warmTranslations('a')", context), renders: () => renders };
}

for (const failingPath of ['core.json', 'a.json']) {
  test(`AUD-003 relay caller retries ${failingPath} after transient failure`, async () => {
    let fail = true;
    const env = await environment(call => fail && call.url.endsWith('/' + failingPath) ? response({}, 503)
      : response(call.url.endsWith('/core.json') ? shard(['a']) : shard([], { cat: '猫' })));
    const caller = await relayTranslationCaller(env);
    for (let i = 0; i < 25; i++) caller.warm();
    await flush();
    assert.equal(caller.renders(), 1, 'concurrent calls and synchronous render reentry stay single flight');
    assert.equal(caller.tag.isTagZhComplete('a'), false);
    const failedCalls = env.calls.length;
    for (let i = 0; i < 25; i++) caller.warm();
    await flush();
    assert.equal(env.calls.length, failedCalls, 'loader cooldown still bounds failed rerenders');
    fail = false;
    await env.advance(1000);
    for (let i = 0; i < 25; i++) caller.warm();
    await flush();
    assert.equal(caller.tag.lookupLoadedTagZh('cat', ['a'])?.zh, '猫');
    assert.equal(caller.tag.isTagZhComplete('a'), true);
    const completeCalls = env.calls.length, completeRenders = caller.renders();
    for (let i = 0; i < 25; i++) caller.warm();
    await env.advance(60000);
    assert.equal(env.calls.length, completeCalls);
    assert.equal(caller.renders(), completeRenders, 'completed source does not loop through loading or repaint');
  });
}

for (const [name, source] of [['missing', () => response({}, 404)], ['empty', () => response(shard())]]) {
  test(`AUD-003 relay caller retains terminal ${name} result`, async () => {
    const env = await environment(source);
    const caller = await relayTranslationCaller(env);
    caller.warm(); await flush();
    assert.equal(caller.tag.isTagZhComplete('a'), true);
    for (let i = 0; i < 25; i++) caller.warm();
    await env.advance(60000);
    assert.equal(env.calls.length, 1);
    assert.equal(caller.renders(), 1);
  });
}

test('AUD-003 core transient failure recovers without page reload', async () => {
  const env = await environment((_, calls) => calls.length === 1 ? Promise.reject(new TypeError('offline')) : response(shard([], { cat: '猫' })));
  const tag = await env.load('app/tag-zh.js');
  assert.equal(await tag.loadTagZh(''), null);
  assert.equal(tag.isTagZhUnavailable(), false, 'temporary failure is not a permanently unavailable table');
  assert.equal(tag.isTagZhComplete(''), false);
  await env.advance(1000);
  assert.equal((await tag.loadTagZh(''))[0].m.get('cat'), '猫');
  assert.equal(env.calls.length, 2);
});

test('AUD-003 shard retry preserves core and isolates another shard', async () => {
  let broken = true;
  const env = await environment(call => {
    if (call.url.endsWith('/core.json')) return response(shard(['a', 'b'], { dog: '狗' }));
    if (call.url.endsWith('/a.json') && broken) return response({}, 503);
    return response(shard([], { cat: '猫' }));
  });
  const tag = await env.load('app/tag-zh.js');
  assert.equal((await tag.loadTagZh('a')).length, 1);
  assert.equal(tag.isTagZhComplete('a'), false);
  assert.equal((await tag.loadTagZh('b')).length, 2);
  broken = false;
  await env.advance(1000);
  assert.equal((await tag.loadTagZh('a')).length, 2);
  assert.equal(env.calls.length, 4);
});

test('AUD-003 retries have cooldown, single flight and bounded demand', async () => {
  const env = await environment(() => Promise.reject(new TypeError('offline')));
  const tag = await env.load('app/tag-zh.js');
  await Promise.all(Array.from({ length: 25 }, () => tag.loadTagZh('a')));
  assert.equal(env.calls.length, 1);
  await Promise.all(Array.from({ length: 25 }, () => tag.loadTagZh('a')));
  assert.equal(env.calls.length, 1, 'immediate rerenders must not hammer a broken endpoint');
  await env.advance(1000);
  await Promise.all(Array.from({ length: 25 }, () => tag.loadTagZh('a')));
  assert.equal(env.calls.length, 2, 'one retry per cooldown and no hidden automatic loop');
});

for (const [name, makeResponse] of [
  ['404', () => response({}, 404)],
  ['invalid schema', () => response({ schema: 999 })],
  ['broken JSON', () => new Response('{')],
]) test(`AUD-003 ${name} is terminal in this immutable release`, async () => {
  const env = await environment(makeResponse);
  const tag = await env.load('app/tag-zh.js');
  await tag.loadTagZh('a');
  await env.advance(60000);
  await tag.loadTagZh('a');
  assert.equal(tag.isTagZhUnavailable(), true);
  assert.equal(env.calls.length, 1);
});

test('AUD-003 valid empty shards remain successful cached results', async () => {
  const env = await environment(call => response(shard(call.url.endsWith('/core.json') ? ['a'] : [])));
  const tag = await env.load('app/tag-zh.js');
  assert.equal((await tag.loadTagZh('a')).length, 2);
  assert.equal(tag.isTagZhComplete('a'), true);
  assert.equal(tag.isTagZhUnavailable(), false);
  await tag.loadTagZh('a');
  assert.equal(env.calls.length, 2);
});

test('AUD-003 a missing book shard is cached without disabling core or another book', async () => {
  const env = await environment(call => call.url.endsWith('/core.json') ? response(shard(['a', 'b'], { dog: '狗' }))
    : call.url.endsWith('/a.json') ? response({}, 404) : response(shard([], { cat: '猫' })));
  const tag = await env.load('app/tag-zh.js');
  assert.equal((await tag.loadTagZh('a')).length, 1);
  assert.equal(tag.isTagZhComplete('a'), true);
  assert.equal(tag.isTagZhUnavailable(), false);
  await tag.loadTagZh('a');
  assert.equal((await tag.loadTagZh('b')).length, 2);
  assert.equal(env.calls.length, 3);
});

test('AUD-011 permanent source hang ends at 10 seconds and retry recovers', async () => {
  let broken = true;
  const env = await environment(call => call.url.endsWith('/slow.json') && broken ? hanging(call) : response(book(call.url.endsWith('/slow.json') ? 'slow' : 'ok')));
  const { state } = await env.load('app/state.js');
  const search = await env.load('app/site-search.js');
  state.codexes = [{ id: 'ok', entryCount: 1 }, { id: 'slow', entryCount: 1 }];
  const result = watch(search.buildSiteSearchCodex());
  await flush();
  await env.advance(9999);
  assert.equal(result.settled, false);
  await env.advance(1);
  assert.equal(result.settled, true, 'search must finish despite an unresolved open source');
  assert.deepEqual(Array.from(result.value.entries, entry => entry.id), ['ok-entry']);
  assert.match(result.value.dataNotice, /加载失败/);
  assert.equal(state.codexCache.has('slow'), false);
  assert.equal(env.calls.find(call => call.url.endsWith('/slow.json')).aborted, true);
  broken = false;
  const recovered = await search.buildSiteSearchCodex();
  assert.equal(recovered.entryCount, 2);
  assert.equal(recovered.dataNotice, '');
  assert.equal(env.calls.length, 3, 'completed source is reused; only failed source is retried');
  assert.strictEqual(await search.buildSiteSearchCodex(), recovered);
});

test('AUD-011 response body hang is canceled and never fills cache late', async () => {
  let releaseBody;
  const env = await environment(() => ({ ok: true, json: () => new Promise(resolve => { releaseBody = resolve; }) }));
  const { state } = await env.load('app/state.js');
  const search = await env.load('app/site-search.js');
  state.codexes = [{ id: 'slow' }];
  const result = watch(search.buildSiteSearchCodex());
  await flush();
  await env.advance(10000);
  assert.equal(result.settled, true);
  assert.equal(result.value.entryCount, 0);
  assert.match(result.value.dataNotice, /加载失败/, 'unknown entry count must still report source failure');
  releaseBody(book('late'));
  await flush();
  assert.equal(state.codexCache.has('slow'), false);
});

test('AUD-011 concurrent search builds share requests and clear their deadline', async () => {
  let release;
  const env = await environment(() => new Promise(resolve => { release = resolve; }));
  const { state } = await env.load('app/state.js');
  const search = await env.load('app/site-search.js');
  state.codexes = [{ id: 'slow' }];
  const first = search.buildSiteSearchCodex();
  const second = search.buildSiteSearchCodex();
  await flush();
  await env.advance(9000);
  release(response(book('slow')));
  const [a, b] = await Promise.all([first, second]);
  assert.strictEqual(a, b);
  assert.equal(env.calls.length, 1);
  assert.equal(env.timers.size, 0);
});

test('AUD-011 pre-aborted consumer creates no request or cache entry', async () => {
  const env = await environment(() => { throw new Error('must not fetch'); });
  const { state } = await env.load('app/state.js');
  const { fetchCodex } = await env.load('app/data.js');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchCodex({ id: 'a' }, { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(state.codexCache.size, 0);
  assert.equal(env.calls.length, 0);
});

test('AUD-011 canceling search does not abort another view sharing the source', async () => {
  let resolveFetch;
  const env = await environment(() => new Promise(resolve => { resolveFetch = resolve; }));
  const { state } = await env.load('app/state.js');
  const data = await env.load('app/data.js');
  const search = await env.load('app/site-search.js');
  const meta = { id: 'slow' };
  state.codexes = [meta];
  const view = data.fetchCodex(meta);
  const result = watch(search.buildSiteSearchCodex());
  await flush();
  await env.advance(10000);
  assert.equal(result.settled, true);
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].aborted, false, 'another live consumer owns the shared request');
  resolveFetch(response(book('slow')));
  assert.equal((await view).id, 'slow');
  assert.equal((await search.buildSiteSearchCodex()).entryCount, 1);
});

test('AUD-011 permission change cancels old generation without exposing locked source', async () => {
  const env = await environment(call => call.url.endsWith('/locked.json') ? hanging(call) : response(book('ok')));
  const { state } = await env.load('app/state.js');
  const search = await env.load('app/site-search.js');
  state.allowNsfw = true;
  state.codexes = [{ id: 'ok' }, { id: 'locked', nsfw: true, entryCount: 1 }];
  const old = watch(search.buildSiteSearchCodex());
  await flush();
  state.allowNsfw = false;
  const current = await search.buildSiteSearchCodex();
  await flush();
  assert.equal(old.settled, true, 'superseded build must stop waiting');
  assert.equal(env.calls.find(call => call.url.endsWith('/locked.json')).aborted, true);
  for (const result of [old.value, current]) assert.deepEqual(Array.from(result.entries, entry => entry.id), ['ok-entry']);
});

test('AUD-011 invalidation cancels ignored fetches and old completions cannot replace new data', async () => {
  let releaseOld;
  const env = await environment((_, calls) => calls.length === 1
    ? new Promise(resolve => { releaseOld = resolve; }) : response(book('new')));
  const { state } = await env.load('app/state.js');
  const search = await env.load('app/site-search.js');
  state.codexes = [{ id: 'a' }];
  const old = watch(search.buildSiteSearchCodex());
  await flush();
  search.invalidateSiteSearchCodex();
  const current = await search.buildSiteSearchCodex();
  await flush();
  assert.equal(old.settled, true);
  assert.equal(current.entries[0].id, 'new-entry');
  releaseOld(response(book('old')));
  await flush();
  assert.strictEqual(await search.buildSiteSearchCodex(), current);
  assert.equal((await state.codexCache.get('a')).entries[0].id, 'new-entry');
});

test('AUD-011 cancellation does not start an external snapshot fallback', async () => {
  const env = await environment(hanging);
  const { state } = await env.load('app/state.js');
  const search = await env.load('app/site-search.js');
  state.codexes = [{ id: 'a', dataUrl: 'https://external.test/a.json', fallbackDataUrl: 'data/a.json' }];
  const result = watch(search.buildSiteSearchCodex());
  await flush();
  await env.advance(10000);
  assert.equal(result.settled, true);
  assert.equal(env.calls.length, 1);
  assert.equal(result.value.entryCount, 0);
});

test('AUD-011 actual applySearch retries an incomplete active site view', async () => {
  // app.js initializes the entire page at import. Execute its unchanged function
  // body with the same injected boundary style as test_site_search_observation.
  const source = readFileSync(path.join(root, 'app.js'), 'utf8');
  const start = source.indexOf('export async function applySearch(');
  const end = source.indexOf('\nfunction searchDirectoryOptions(', start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const context = vm.createContext({
    state: { siteSearchView: true, searchScope: 'site', codex: { _siteSearchComplete: false } },
    window: { scrollY: 0 }, cancelSiteSearchObservation() {}, hasActiveSearchState: () => true,
    openSiteSearchView: async options => calls.push(['rebuild', options]),
    applyFilter: () => calls.push(['filter']), syncUrlState() {}, historyModeFor: () => 'replace',
  });
  vm.runInContext(source.slice(start, end).replace('export ', ''), context);
  await vm.runInContext('applySearch({onSearchSettled:()=>{}})', context);
  assert.equal(calls[0]?.[0], 'rebuild', 'a new search must retry the missing source, not filter the partial index forever');
  calls.length = 0;
  vm.runInContext('state.codex._siteSearchComplete=true', context);
  await vm.runInContext('applySearch({})', context);
  assert.equal(calls[0]?.[0], 'filter', 'a complete site view keeps the existing cheap filtering path');
});

test('AUD-011 R2 failure retries only the same immutable release through proxy', async () => {
  const release = 'r-0123456789abcdefabcd';
  const env = await environment(call => {
    if (call.url.endsWith('/data-source.json')) return response({ schemaVersion: 1, baseUrl: 'https://r2.test/data', remoteHosts: ['app.test'] });
    if (call.url.endsWith('/current.json')) return response({ release });
    if (call.url.startsWith('https://r2.test/')) return response({}, 503);
    assert.equal(call.url, `https://app.test/data/releases/${release}/a.json`);
    return response(book('a'));
  }, 'app.test');
  const { state } = await env.load('app/state.js');
  const search = await env.load('app/site-search.js');
  state.codexes = [{ id: 'a' }];
  const result = await search.buildSiteSearchCodex();
  assert.equal(result.entries[0].id, 'a-entry');
  assert.equal(env.calls.filter(call => call.url.endsWith('/current.json')).length, 1);
  assert.ok(env.calls.filter(call => call.url.endsWith('/a.json')).every(call => call.url.includes(`/releases/${release}/`)));
});

test('AUD-011 R2 primary timeout neither demotes source nor requests another release', async () => {
  const release = 'r-0123456789abcdefabcd';
  const env = await environment(call => {
    if (call.url.endsWith('/data-source.json')) return response({ schemaVersion: 1, baseUrl: 'https://r2.test/data', remoteHosts: ['app.test'] });
    if (call.url.endsWith('/current.json')) return response({ release });
    return hanging(call);
  }, 'app.test');
  const source = await env.load('data-source.js');
  await source.initializeDataSource();
  const { state } = await env.load('app/state.js');
  const search = await env.load('app/site-search.js');
  state.codexes = [{ id: 'a' }];
  const result = watch(search.buildSiteSearchCodex());
  await flush();
  await env.advance(10000);
  assert.equal(result.settled, true);
  assert.equal(result.value.entryCount, 0);
  assert.equal(state.codexCache.size, 0);
  assert.equal(source.getDataSource().release, release);
  assert.equal(source.getDataSource().mode, 'r2');
  assert.equal(env.calls.length, 3, 'timeout does not start a snapshot/proxy retry outside its budget');
});

test('AUD-011 pointer change stays pinned within page; fresh page uses the new release', async () => {
  const oldRelease = 'r-0123456789abcdefabcd';
  const newRelease = 'r-aaaaaaaaaaaaaaaaaaaa';
  let pointer = oldRelease;
  const handler = call => {
    if (call.url.endsWith('/data-source.json')) return response({ schemaVersion: 1, baseUrl: 'https://r2.test/data', remoteHosts: ['app.test'] });
    if (call.url.endsWith('/current.json')) return response({ release: pointer });
    return response(book(call.url.includes(oldRelease) ? 'old-release' : 'new-release'));
  };
  const firstPage = await environment(handler, 'app.test');
  const { state } = await firstPage.load('app/state.js');
  const search = await firstPage.load('app/site-search.js');
  state.codexes = [{ id: 'a' }];
  assert.equal((await search.buildSiteSearchCodex()).entries[0].id, 'old-release-entry');
  pointer = newRelease;
  search.invalidateSiteSearchCodex();
  state.codexCache.clear();
  assert.equal((await search.buildSiteSearchCodex()).entries[0].id, 'old-release-entry');
  assert.equal(firstPage.calls.filter(call => call.url.endsWith('/current.json')).length, 1);
  const nextPage = await environment(handler, 'app.test');
  const nextState = (await nextPage.load('app/state.js')).state;
  nextState.codexes = [{ id: 'a' }];
  const nextSearch = await nextPage.load('app/site-search.js');
  assert.equal((await nextSearch.buildSiteSearchCodex()).entries[0].id, 'new-release-entry');
});

let failed = 0;
for (const { name, run } of cases) {
  let watchdog;
  try {
    await Promise.race([run(), new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('test still unresolved after controlled clock/cancel')), 1500);
    })]);
    console.log(`PASS ${name}`);
  }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
  finally { clearTimeout(watchdog); }
}
console.log(`frontend loading recovery: ${cases.length - failed}/${cases.length} PASS; ${failed} FAIL`);
if (failed) process.exitCode = 1;
