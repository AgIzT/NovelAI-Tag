// 目录调序与访问树：node tools/test_category_order.mjs（只使用内存夹具）
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeCategoryOrder, sortCategoryTree, sortCategoryEntries } from '../site/assets/app/category-order.js';
import { normalizeCodex } from '../site/assets/app/data.js';
import { state } from '../site/assets/app/state.js';
import { parseSearchQuery, rankSearchResults } from '../site/assets/app/search.js';

globalThis.window = { addEventListener() {} };
const { accessHiddenCount, invalidateAccessViewMemo, visibleTree } = await import('../site/assets/app/codex-ui.js');

const leaf = (name, count = 1, extra = {}) => ({ name, count, children: [], ...extra });
const names = nodes => nodes.map(node => node.name);
const raw = [['B'], ['A', 'Y'], ['B'], [], [''], ['A', null], 'A'];
const normalized = normalizeCategoryOrder(raw);
assert.deepEqual(normalized, [['B'], ['A', 'Y']]);
assert.notEqual(normalized[0], raw[0], '读取顺序不能把输入路径的可变引用带入法典');

const tree = [
  { name: 'A', count: 2, children: [leaf('X'), leaf('Y')] },
  { name: 'B', count: 2, children: [leaf('X', 1, { locked: true }), leaf('Y')] },
  leaf('C'), leaf('Empty', 0),
];
const before = structuredClone(tree);
const order = [['Missing'], ['B'], ['B', 'Y'], ['B', 'X'], ['A'], ['A', 'Y'], ['A', 'X'], ['Empty']];
const sorted = sortCategoryTree(tree, order);
assert.deepEqual(names(sorted), ['B', 'A', 'Empty', 'C']);
assert.deepEqual(names(sorted[0].children), ['Y', 'X']);
assert.deepEqual(names(sorted[1].children), ['Y', 'X']);
assert.equal(sorted[0].children[1].locked, true, '排序保留原节点分级标记');
assert.equal(sorted[2].count, 0, '空目录保留原计数');
assert.deepEqual(tree, before, '排序不改变输入树');
assert.equal(sortCategoryTree(tree), tree, '旧书未登记顺序时保持原树身份与顺序');
assert.equal(sortCategoryTree(tree, [null, []]), tree);
assert.deepEqual(names(sortCategoryTree(tree, [['B']])), ['B', 'A', 'C', 'Empty'], '未登记节点保持原相对次序');
assert.deepEqual(sortCategoryTree([], [['Ghost'], ['Ghost', 'Child']]), [], '顺序记录不能制造目录');

// 同一目录的词条可在源数组中交错出现；浏览列表必须连续分组，并保留组内原序。
{
  const items = [
    { id: 'a-x-2', seq: 20, path: ['A', 'X'], image: 'x2.jpg' },
    { id: 'b-x', path: ['B', 'X'] },
    { id: 'a-y', path: ['A', 'Y'] },
    { id: 'b-y-2', path: ['B', 'Y'], image: 'y2.jpg' },
    { id: 'a-x-1', seq: 10, path: ['A', 'X'], image: 'x1.jpg' },
    { id: 'b-direct', path: ['B'] },
    { id: 'b-y-1', path: ['B', 'Y'], image: 'y1.jpg' },
    { id: 'unknown', path: ['NotInTree'] },
  ];
  const original = structuredClone(items);
  const list = sortCategoryEntries(items, sorted, order);
  assert.deepEqual(list.map(item => item.id), ['b-direct', 'b-y-2', 'b-y-1', 'b-x', 'a-y', 'a-x-2', 'a-x-1', 'unknown']);
  assert.deepEqual(items, original, '显示排序不反写源数组、词条身份或媒体');
  assert.equal(list[1], items[3], '复用同一词条对象，不能破坏灯箱和收藏引用');
  assert.equal(sortCategoryEntries(items, sorted), items, '未登记顺序的旧书不改变列表');
  assert.equal(sortCategoryEntries(items, sorted, [null, []]), items, '无效顺序不改变列表');
  const subtree = list.filter(item => item.path[0] === 'B');
  assert.deepEqual(subtree.map(item => item.id), ['b-direct', 'b-y-2', 'b-y-1', 'b-x']);
  const partial = [['A', 'Y'], ['A', 'X']];
  const partialTree = sortCategoryTree(tree, partial);
  assert.deepEqual(sortCategoryEntries(items, partialTree, partial).map(item => item.id),
    ['a-y', 'a-x-2', 'a-x-1', 'b-direct', 'b-x', 'b-y-2', 'b-y-1', 'unknown'],
    '局部子目录排序仍须遵守父目录树顺序，不能把其它父级带到前面');
}

const legacy = normalizeCodex({ id: 'legacy', entries: [], tree });
assert.equal(legacy.tree, tree);
assert.equal(Object.hasOwn(legacy, 'categoryOrder'), false);
const normalizedBook = normalizeCodex({ id: 'ordered', entries: [], tree, categoryOrder: order });
assert.deepEqual(names(normalizedBook.tree), ['B', 'A', 'Empty', 'C'], '存储树和展示树服从同一份顺序');
assert.deepEqual(normalizedBook.categoryOrder, order);
assert.notEqual(normalizedBook.categoryOrder, order);
assert.equal(Object.hasOwn(normalizeCodex({ categoryOrder: 'invalid' }), 'categoryOrder'), false);

const entries = [
  { id: 'a-y', path: ['A', 'Y'] },
  { id: 'b-x', path: ['B', 'X'], rating: 'r18' },
  { id: 'a-x', path: ['A', 'X'] },
  { id: 'b-y', path: ['B', 'Y'] },
  { id: 'gore', path: ['R18G'], rating: 'r18g' },
];
state.codexes = [];
state.allowNsfw = false;
state.allowR18g = false;
state.codex = { id: 'access-order', entries, emptyCategories: [['Empty']], categoryOrder: [
  ['Empty'], ['Missing'], ['R18G'], ['B'], ['B', 'Y'], ['B', 'X'], ['A'], ['A', 'X'], ['A', 'Y'],
] };
invalidateAccessViewMemo();
const accessTree = visibleTree();
assert.deepEqual(names(accessTree), ['Empty', 'B', 'A']);
assert.deepEqual(names(accessTree[1].children), ['Y', 'X']);
assert.equal(accessTree[1].locked, false, '混合目录保持可进入');
assert.equal(accessTree[1].children[1].locked, true, '纯受限目录仍锁定');
assert.equal(accessTree[1].count, 2);
assert.equal(accessHiddenCount(), 2, '调序不能改变隐藏词条数');
assert.equal(visibleTree(), accessTree, '相同顺序引用复用访问树');

state.codex.categoryOrder = [['A'], ['A', 'Y'], ['A', 'X'], ['B'], ['Empty']];
const reordered = visibleTree();
assert.notEqual(reordered, accessTree, '只替换顺序引用也必须让 memo 失效');
assert.deepEqual(names(reordered), ['A', 'B', 'Empty']);
assert.deepEqual(names(reordered[0].children), ['Y', 'X']);
assert.equal(accessHiddenCount(), 2);
state.allowR18g = true;
assert.deepEqual(names(visibleTree()), ['A', 'B', 'Empty', 'R18G']);
state.allowNsfw = true;
assert.equal(accessHiddenCount(), 0);

delete state.codex.categoryOrder;
assert.deepEqual(names(visibleTree()), ['A', 'B', 'R18G', 'Empty'], '去掉顺序恢复派生树原序');
state.codex = { id: 'no-ghosts', entries: [], categoryOrder: [['Ghost'], ['Ghost', 'Child']] };
assert.deepEqual(visibleTree(), []);
state.codex = { id: 'locked', nsfw: true, entries, categoryOrder: [['B'], ['A']] };
state.allowNsfw = false;
assert.deepEqual(visibleTree(), [], '整本锁定时调序记录也不能暴露目录');
assert.equal(accessHiddenCount(), entries.length);

// 回放真实 applyFilter，防止只验排序 helper、却漏掉主站图片列表接线。
{
  const source = await readFile(new URL('../site/assets/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function applyFilter(');
  const end = source.indexOf('\n/* 取消、撤销', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end).replace('export function', 'function');
  const items = [
    { id: 'a-1', path: ['A'], title: 'first', tags: '' },
    { id: 'b-1', path: ['B'], title: 'second', tags: '' },
    { id: 'a-2', path: ['A'], title: 'third', tags: '' },
    { id: 'b-2', path: ['B'], title: 'fourth', tags: '' },
  ];
  const tree = [leaf('B'), leaf('A')];
  const run = ({ favorites = false, site = false, activePath = [], query = '', input = items } = {}) => {
    const model = { codex: { entries: input, tree, categoryOrder: [['B'], ['A']] },
      favoritesView: favorites, siteSearchView: site, activePath, updateFilter: '' };
    let rendered;
    const deps = {
      state: model, compileSearchState: () => parseSearchQuery(query),
      cancelSiteSearchObservation() {}, isCodexLocked: () => false, isEntryAccessBlocked: () => false,
      listSearchDirectories: () => [], searchDirectoryOptions: () => [], virtualView: () => favorites || site,
      matchSearchPlan: () => true, codexUpdateFilters: () => [], entryMatchesUpdateFilter: () => true,
      filterFavoritesScope: list => list, isContentBlocked: () => false, filterFavoritesEntries: list => list,
      sortCategoryEntries, rankSearchResults, pinFeatured: list => list, findRelatedDirectories: () => [],
      renderSearchExperience() {}, updateResultBar() {}, syncFavoritesView() {}, renderFavoritesRail() {},
      renderFavoritesHeader() {}, refreshFavoriteBadges() {}, updateBlockingSummary() {},
      renderList() { rendered = model.list.map(entry => entry.id); },
    };
    new Function(...Object.keys(deps), body + '\nreturn applyFilter;')(...Object.values(deps))();
    assert.equal(model.codex.entries, input, '过滤链不能重排源数组');
    return rendered;
  };
  assert.deepEqual(run(), ['b-1', 'b-2', 'a-1', 'a-2'], '全部图片确实跟随目录顺序');
  assert.deepEqual(run({ activePath: ['A'] }), ['a-1', 'a-2']);
  assert.deepEqual(run({ favorites: true }), items.map(entry => entry.id), '收藏页继续沿用收藏排序');
  assert.deepEqual(run({ site: true }), items.map(entry => entry.id), '全站搜索继续沿用跨书结果排序');
  assert.deepEqual(run({ query: 'needle', input: [
    { id: 'a-exact', path: ['A'], title: 'needle', tags: '' },
    { id: 'b-prefix', path: ['B'], title: 'needle extra', tags: '' },
  ] }), ['a-exact', 'b-prefix'], '搜索相关性仍高于目录次序');
}

console.log('category order: PASS');
