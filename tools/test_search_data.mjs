// 搜索热路径、法典单飞缓存与全站搜索 memo 回归：node tools/test_search_data.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const moduleUrl = name => pathToFileURL(path.resolve(`site/assets/app/${name}`)).href;
const {
  invalidateSearchableText,
  matchSearchPlan,
  parseSearchQuery,
  searchableText,
  splitQueryTokens,
} = await import(moduleUrl('search.js'));
const { fetchCodex, normalizeCodex } = await import(moduleUrl('data.js'));
const {
  buildSiteSearchCodex,
  invalidateSiteSearchCodex,
} = await import(moduleUrl('site-search.js'));
const { state } = await import(moduleUrl('state.js'));

// 引号短语保持整体匹配，高亮词与匹配词必须来自同一份 terms。
{
  const plan = parseSearchQuery('path:服装 "red dress" blue，lace');
  assert.equal(plan.isSyntax, true);
  assert.deepEqual(plan.path, ['服装']);
  assert.deepEqual(plan.terms, ['red dress', 'blue', 'lace']);
  assert.deepEqual(plan.highlightTerms, plan.terms);
  assert.equal(matchSearchPlan({ title: 'red dress with blue lace', path: ['服装'] }, plan), true);
  assert.equal(matchSearchPlan({ title: 'red silk dress with blue lace', path: ['服装'] }, plan), false);

  const plain = parseSearchQuery('"red dress"');
  assert.deepEqual(plain.terms, ['red dress']);
  assert.equal(matchSearchPlan({ title: 'red dress', path: [] }, plain), true);
  assert.equal(matchSearchPlan({ title: 'red summer dress', path: [] }, plain), false);
  assert.deepEqual(splitQueryTokens('path:"a b" "red dress"'), ['path:a b', 'red dress']);
}

// searchableText 按对象缓存，编辑态就地修改后可显式失效。
{
  const entry = { title: '旧标题', tags: '', path: [] };
  assert.match(searchableText(entry), /旧标题/);
  entry.title = '新标题';
  assert.match(searchableText(entry), /旧标题/, '失效前应命中同一对象的缓存');
  assert.equal(invalidateSearchableText(entry), true);
  assert.match(searchableText(entry), /新标题/);
}

// 纯语法查询不应触碰 searchableText 的字段 getter。
{
  const entry = {
    get title() { throw new Error('纯语法查询不应构建文本'); },
    path: [],
    images: [],
  };
  assert.equal(matchSearchPlan(entry, parseSearchQuery('has:noimage')), true);
}

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
try {
  // 首次并发请求共享一个在途 Promise，完成后继续复用同一个归一化对象。
  {
    state.codexCache.clear();
    let releaseFetch;
    const gate = new Promise(resolve => { releaseFetch = resolve; });
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      await gate;
      return {
        ok: true,
        json: async () => ({ id: 'remote', title: 'Remote', entries: [{ id: 'e1', title: 'A' }] }),
      };
    };
    const meta = { id: 'remote', dataUrl: 'https://example.test/remote.json' };
    const first = fetchCodex(meta);
    const second = fetchCodex(meta);
    assert.equal(calls, 1);
    assert.ok(state.codexCache.get('remote') instanceof Promise);
    releaseFetch();
    const [a, b] = await Promise.all([first, second]);
    assert.strictEqual(a, b);
    assert.strictEqual(await fetchCodex(meta), a);
    assert.equal(calls, 1);
  }

  // reject 后删除在途项，让下一次调用能够重试。
  {
    state.codexCache.clear();
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error('offline');
    };
    const meta = { id: 'retry', dataUrl: 'https://example.test/retry.json' };
    await assert.rejects(fetchCodex(meta), /offline/);
    assert.equal(state.codexCache.has('retry'), false);
    await assert.rejects(fetchCodex(meta), /offline/);
    assert.equal(calls, 2);
  }

  // 外部源降级成功也不留缓存，下一次仍会优先重试外部源。
  {
    state.codexCache.clear();
    let primaryCalls = 0;
    let fallbackCalls = 0;
    console.warn = () => {};
    globalThis.fetch = async url => {
      if (String(url).includes('primary.test')) {
        primaryCalls += 1;
        throw new Error('primary down');
      }
      fallbackCalls += 1;
      return {
        ok: true,
        json: async () => ({ id: 'fallback', title: 'Fallback', entries: [] }),
      };
    };
    const meta = {
      id: 'fallback',
      dataUrl: 'https://primary.test/fallback.json',
      fallbackDataUrl: 'https://fallback.test/fallback.json',
    };
    assert.equal((await fetchCodex(meta)).dataStatus, '发布回退数据');
    assert.equal(state.codexCache.has('fallback'), false);
    await fetchCodex(meta);
    assert.equal(primaryCalls, 2);
    assert.equal(fallbackCalls, 2);
  }

  // 全站搜索只 memo 全成功结果；显式失效后重建，失败的半成品不会冻结。
  {
    const metaA = { id: 'a', title: 'A', entryCount: 1 };
    const codexA = normalizeCodex({ id: 'a', title: 'A', entries: [{ id: 'a1', title: 'one' }] }, metaA);
    state.allowNsfw = false;
    state.allowR18g = false;
    state.codexes = [metaA];
    state.codexCache.clear();
    state.codexCache.set('a', Promise.resolve(codexA));
    invalidateSiteSearchCodex();
    const built = await buildSiteSearchCodex();
    assert.strictEqual(await buildSiteSearchCodex(), built);
    codexA.entries.push({ id: 'a2', title: 'two', path: [], images: [] });
    assert.equal((await buildSiteSearchCodex()).entryCount, 1, '命中时应复用完整构建结果');
    invalidateSiteSearchCodex();
    const rebuilt = await buildSiteSearchCodex();
    assert.notStrictEqual(rebuilt, built);
    assert.equal(rebuilt.entryCount, 2);

    const metaB = { id: 'b', title: 'B', entryCount: 1 };
    const codexB = normalizeCodex({ id: 'b', title: 'B', entries: [{ id: 'b1', title: 'three' }] }, metaB);
    state.codexes = [metaA, metaB];
    state.codexCache.set('b', Promise.reject(new Error('temporary')));
    console.warn = () => {};
    const partial = await buildSiteSearchCodex();
    assert.match(partial.dataNotice, /加载失败/);
    state.codexCache.set('b', Promise.resolve(codexB));
    const retried = await buildSiteSearchCodex();
    assert.notStrictEqual(retried, partial);
    assert.equal(retried.entryCount, 3);
    assert.equal(retried.dataNotice, '');

    state.codexes = [metaA];
    state.codexCache.set('a', Promise.resolve({ ...codexA, dataStatus: '发布回退数据' }));
    invalidateSiteSearchCodex();
    const degraded = await buildSiteSearchCodex();
    state.codexCache.set('a', Promise.resolve(codexA));
    const recovered = await buildSiteSearchCodex();
    assert.notStrictEqual(recovered, degraded, '外部源降级结果不能进入全站搜索 memo');

    let releaseOldBuild;
    const oldBuild = new Promise(resolve => { releaseOldBuild = resolve; });
    const latestCodex = normalizeCodex(
      { id: 'a', title: 'A', entries: [{ id: 'latest', title: 'latest' }] },
      metaA,
    );
    state.codexCache.set('a', oldBuild);
    invalidateSiteSearchCodex();
    const pendingBuild = buildSiteSearchCodex();
    state.codexCache.set('a', Promise.resolve(latestCodex));
    invalidateSiteSearchCodex();
    releaseOldBuild(codexA);
    const refreshedDuringBuild = await pendingBuild;
    assert.equal(refreshedDuringBuild.entries[0].id, 'latest', '失效中的旧构建不能迟到覆盖新结果');
  }
} finally {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  state.codexCache.clear();
}

console.log('search/data/site-search: PASS');
