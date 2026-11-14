import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 可传冻结的 app.js 文件，复现同一组断言在修复前的结果。
const source = await readFile(process.argv[2] || new URL('../site/assets/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function renderCodexView(');
const end = source.indexOf('\nfunction commitCodexView(', start);
assert.ok(start >= 0 && end > start);
const renderSource = source.slice(start, end);

function harness() {
  const state = { favoritesView: false, allowR18g: false, lightbox: { entry: null }, seenAnimated: new Set() };
  const timers = [];
  const opened = [];
  let urlEntry = '';
  const nodes = new Map();
  const noop = () => {};
  const deps = {
    state,
    window: { setTimeout: callback => timers.push(callback) },
    $: key => {
      if (!nodes.has(key)) nodes.set(key, {});
      return nodes.get(key);
    },
    isCodexLocked: () => false,
    closeLightbox: noop,
    primeResourceHints: noop,
    codexPickerTitle: () => '',
    updateCodexPickerState: noop,
    decodeCodexPathCode: () => [],
    normalizeCodexRoutePath: (_, path) => path,
    isR18gPath: () => false,
    compileSearchState: noop,
    updateSearchClear: noop,
    syncFavoritesView: noop,
    renderTree: noop,
    renderCodexHeader: noop,
    suppressBrowseStateSave: noop,
    applyFilter: noop,
    historyModeFor: () => 'replace',
    syncUrlState: ({ entry }) => { urlEntry = entry; },
    readUrlState: () => ({ entry: urlEntry }),
    openEntryDeepLink: entry => opened.push(entry),
    setLoading: noop,
    notifyCodexDataStatus: noop,
    announceCodexLoaded: noop,
  };
  const api = new Function(...Object.keys(deps), `
    let codexLoadSeq = 1;
    let favoritesFolderHistoryActive = false;
    ${renderSource}
    return { renderCodexView, nextLoad: () => ++codexLoadSeq };
  `)(...Object.values(deps));
  const codex = { id: 'site-search', title: 'search', tree: [] };
  const render = (autoOpenEntry = true) => api.renderCodexView(codex, 1, {
    options: { autoOpenEntry },
    parentScrollY: 0,
    enterView: noop,
    selectedCodexId: book => book.id,
    buttonCodex: () => null,
    buttonFallback: () => '',
    resolveUrlState: () => ({ entry: 'old-example' }),
    applyViewUrlState: noop,
    resolveQuery: () => '',
    resolveFilters: () => [],
  });
  return { state, opened, timers, render, nextLoad: api.nextLoad, setEntry: entry => { urlEntry = entry; } };
}

{
  const test = harness();
  test.render();
  test.timers[0]();
  assert.deepEqual(test.opened, ['old-example'], '当前深链正常打开');
}
{
  const test = harness();
  test.render();
  test.nextLoad();
  test.timers[0]();
  assert.deepEqual(test.opened, [], '新视图尚未到齐时，旧视图也不能继续开详情');
}
{
  const test = harness();
  test.render();
  test.nextLoad();
  test.state.codex = { id: 'artist_nai5_personal' };
  test.timers[0]();
  assert.deepEqual(test.opened, [], '从搜索跳到真实词典后，旧延迟动作不能盖回旧图');
}
{
  const test = harness();
  test.render();
  test.setEntry('rank-example');
  test.timers[0]();
  assert.deepEqual(test.opened, [], '同一视图改开另一详情后，旧延迟动作失效');
}
{
  const test = harness();
  test.render();
  test.setEntry('');
  test.timers[0]();
  assert.deepEqual(test.opened, [], '关闭详情后，旧延迟动作不能重开');
}
{
  const test = harness();
  test.render(false);
  assert.equal(test.timers.length, 0, '历史恢复调用者可自行打开详情');
}

console.log('codex view delayed detail: PASS (6 cases)');
