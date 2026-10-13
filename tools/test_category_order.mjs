// 目录调序与访问树：node tools/test_category_order.mjs（只使用内存夹具）
import assert from 'node:assert/strict';
import { normalizeCategoryOrder, sortCategoryTree } from '../site/assets/app/category-order.js';
import { normalizeCodex } from '../site/assets/app/data.js';
import { state } from '../site/assets/app/state.js';

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

console.log('category order: PASS');
