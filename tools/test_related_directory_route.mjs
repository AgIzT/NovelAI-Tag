import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { encodePathCode } from '../site/assets/app/path-code.js';
import { normalizeCodexRoutePath } from '../site/assets/app/codex-route-compat.js';
import { matchSearchPlan, parseSearchQuery } from '../site/assets/app/search.js';
import { SINGLE_ROOT, STYLE_CODEX_ID } from '../site/assets/app/artist-style.js';

// 可传修复前的 app.js，验证同组真实导航与搜索断言会失败。
const source = await readFile(process.argv[2] || new URL('../site/assets/app.js', import.meta.url), 'utf8');
const actionStart = source.indexOf('export async function openRelatedDirectory(');
const actionEnd = source.indexOf('\nasync function applyObservedSearch(', actionStart);
const compileStart = source.indexOf('const compileSearchState = ');
const compileEnd = source.indexOf('\nconst requestedUpdateFilter', compileStart);
assert.ok(actionStart >= 0 && actionEnd > actionStart && compileStart >= 0 && compileEnd > compileStart);

function harness({ canSave = true } = {}) {
  const calls = [];
  const state = { query: 'old query', searchDraft: 'old query', searchFilterValues: ['title:old'], onlyFav: true };
  const deps = {
    state, parseSearchQuery, encodePathCode, SINGLE_ROOT, STYLE_CODEX_ID,
    writePreference: () => canSave,
    SEARCH_SCOPE_STORAGE_KEY: 'test-scope',
    setOnlyFavControl: value => { state.onlyFav = value; },
    updateSearchScopeControl: () => {},
    loadCodex: async (id, options) => { calls.push({ id, ...options }); },
    window: { scrollY: 120 },
    requestAnimationFrame: callback => callback(),
    $: () => ({ focus() {} }),
  };
  const open = new Function(...Object.keys(deps), `
    ${source.slice(compileStart, compileEnd)}
    return (${source.slice(actionStart, actionEnd).replace(/^export /, '')});
  `)(...Object.values(deps));
  return { state, calls, open };
}

const artistBook = {
  id: STYLE_CODEX_ID,
  tree: [{ name: SINGLE_ROOT, children: [{ name: 'MayRain', children: [] }, { name: '花枝鱼', children: [] }] }],
  displayTree: [{ name: SINGLE_ROOT, children: [{ name: '高光二次元', children: [] }] }],
  styleRouteFallback: path => path[0] === SINGLE_ROOT ? [SINGLE_ROOT] : null,
};

{
  const test = harness();
  const path = [SINGLE_ROOT, 'MayRain'];
  await test.open({ codexId: STYLE_CODEX_ID, path, pathCode: 'stale-code' });
  assert.equal(test.calls.length, 1);
  const route = test.calls[0].urlState;
  const activePath = normalizeCodexRoutePath(artistBook, route.path);
  const plan = parseSearchQuery(route.q, route.searchFilters);
  const entries = [
    { id: 'mayrain', path, _srcCodexId: STYLE_CODEX_ID },
    { id: 'mayrain-child', path: [...path, '子目录'], _srcCodexId: STYLE_CODEX_ID },
    { id: 'other-source', path: [SINGLE_ROOT, '花枝鱼'], _srcCodexId: STYLE_CODEX_ID },
    { id: 'similar-name', path: [SINGLE_ROOT, 'MayRain旧'], _srcCodexId: STYLE_CODEX_ID },
    { id: 'other-book', path, _srcCodexId: 'another-book' },
  ];
  const visible = entries.filter(entry => activePath.every((part, index) => entry.path[index] === part)
    && matchSearchPlan(entry, plan));
  assert.deepEqual(visible.map(entry => entry.id), ['mayrain', 'mayrain-child'], '点击来源建议不能把范围放宽为所有画师');
  assert.deepEqual(activePath, [SINGLE_ROOT]);
  assert.deepEqual(route.searchFilters, [`dir:${STYLE_CODEX_ID}:${encodePathCode(path)}`], '精确来源可随 URL/历史恢复，短码由路径重算');
  assert.deepEqual(test.state.searchFilterValues, route.searchFilters);
  assert.equal(test.state.searchPlan.hasErrors, false);
  assert.equal(test.state.searchScope, 'codex');
  assert.equal(test.state.onlyFav, false);
  assert.equal(test.calls[0].parentScrollY, 120);
  // 旧来源书签仍沿用已定的单画师根回退，只有当前主动点选建议携带筛选。
  assert.deepEqual(normalizeCodexRoutePath(artistBook, path), [SINGLE_ROOT]);
}

for (const [codexId, path] of [
  ['ordinary-book', ['服装', '礼服']],
  [STYLE_CODEX_ID, ['画风组词典', 'MayRain']],
  [STYLE_CODEX_ID, [SINGLE_ROOT]],
]) {
  const test = harness();
  await test.open({ codexId, path });
  assert.deepEqual(test.calls[0].urlState, { codex: codexId, path, q: '', searchFilters: [], scope: 'codex' }, '普通目录及单画师根继续原导航');
}

{
  const test = harness({ canSave: false });
  const before = structuredClone(test.state);
  await test.open({ codexId: STYLE_CODEX_ID, path: [SINGLE_ROOT, 'MayRain'] });
  assert.deepEqual(test.state, before, '偏好存储失败不能先改搜索状态');
  assert.deepEqual(test.calls, []);
}

for (const item of [null, { codexId: STYLE_CODEX_ID, path: [] }]) {
  const test = harness();
  await test.open(item);
  assert.deepEqual(test.calls, []);
}

console.log('related directory route: PASS (7 cases)');
