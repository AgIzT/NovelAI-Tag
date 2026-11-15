// 单画师整书去重后的计数与规范标题：node tools/test_artist_style_counts.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

function classList() {
  const names = new Set();
  return { add: name => names.add(name), remove: name => names.delete(name), contains: name => names.has(name),
    toggle(name, force) { const on = force ?? !names.has(name); if (on) names.add(name); else names.delete(name); return on; } };
}

class Node {
  constructor() {
    this.dataset = {};
    this.classList = classList();
    this.children = new Map();
    const properties = new Map();
    this.style = { setProperty: (key, value) => properties.set(key, value), getPropertyValue: key => properties.get(key) || '' };
  }
  querySelector(selector) { if (!this.children.has(selector)) this.children.set(selector, new Node()); return this.children.get(selector); }
  setAttribute(key, value) { this[key] = value; }
  cloneNode() { return new Node(); }
}

const template = { content: { firstElementChild: new Node() } };
globalThis.HTMLElement = Node;
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: true }), innerWidth: 1200, innerHeight: 800,
  scrollY: 0, performance, setTimeout, clearTimeout };
globalThis.document = { body: { classList: classList() }, documentElement: { classList: classList(), clientHeight: 800, scrollHeight: 2000 },
  addEventListener() {}, querySelector: selector => selector === '#cardTpl' ? template : null, querySelectorAll: () => [] };
globalThis.location = { href: 'http://localhost/', origin: 'http://localhost', hostname: 'localhost', protocol: 'http:', pathname: '/', search: '', hash: '' };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const { state } = await import('../site/assets/app/state.js');
const { attachArtistStyles } = await import('../site/assets/app/artist-style.js');
const { accessHiddenCount, visibleEntryCount, visibleTree, invalidateAccessViewMemo, randomKey, rememberRandomEntry } = await import('../site/assets/app/codex-ui.js');
const { estimateBodyMetrics, makeCard } = await import('../site/assets/app/masonry.js');

const prefix = 'artist_nai5_personal_';
const entry = (id, source, rating = 'safe', title = id) => ({ id: prefix + id, title, rating,
  path: ['单画师词典', source], image: '', tags: 'artist:' + id });
const entries = [
  entry('a_hzy', '花枝鱼', 'safe', '旧写法'.repeat(30)),
  entry('a_mr', 'MayRain', 'safe', 'Canonical'),
  entry('a_rain', '雨燕', 'r18'),
  entry('b_hzy', '花枝鱼', 'r18'),
  entry('b_mr', 'MayRain', 'r18'),
  entry('unknown', 'MayRain'),
  { id: prefix + 'string', title: '多画师串', path: ['画风组词典', 'W.O.F'], tags: 'artist:a, artist:b', rating: 'safe' },
];
const data = { schema: 3, codexId: 'artist_nai5_personal', idPrefix: prefix, nearShard: 2, nearRevision: '0123456789abcdef',
  parents: [{ name: '大类', groups: [0], size: 2 }],
  groups: [{ name: '小组', parent: 0, size: 2, reps: [0, 1] }],
  artists: [{ e: 'a_hzy', c: 'a_mr', x: ['a_mr', 'a_rain'], g: 0, p: 20, r: null },
    { e: 'b_hzy', x: ['b_mr'], g: 0, p: 10, r: null }],
};
data.sourceFingerprint = createHash('sha256').update(JSON.stringify(entries.filter(e => e.path[0] === '单画师词典')
  .sort((a, b) => a.id < b.id ? -1 : 1).map(e => [e.id, e.path, e.image || '', e.rating || 'safe', e.tags || '']))).digest('hex');
globalThis.fetch = async () => ({ ok: true, json: async () => data });
const codex = { id: 'artist_nai5_personal', entryCount: entries.length, entries,
  tree: [{ name: '单画师词典', children: [{ name: '花枝鱼', children: [] }, { name: 'MayRain', children: [] }, { name: '雨燕', children: [] }] },
    { name: '画风组词典', children: [{ name: 'W.O.F', children: [] }] }] };
assert.equal(await attachArtistStyles(codex), true);
state.codex = codex;
state.codexes = [{ id: codex.id, entryCount: entries.length }];
state.allowNsfw = false;
state.allowR18g = false;
state.favoritesView = false;
state.siteSearchView = false;
state.activePath = [];
state.query = '';
state.searchPlan = null;

assert.equal(accessHiddenCount(), 1, '同人受限备用图不算隐藏整人；仅整位无可访问例图的画师算隐藏');
assert.equal(visibleEntryCount(), 3, '全部口径为可访问画师 + 未归类条目 + 非单画师串');
assert.equal(codex.entryCount, 7, '不改原 JSON 条目数');
assert.equal(state.codexes[0].entryCount, 7, '不改书目元数据');
const memo = visibleTree();
assert.equal(visibleTree(), memo, '同一访问状态复用快照');
entries[0].rating = 'r18';
invalidateAccessViewMemo();
assert.equal(visibleEntryCount(), 3, '首选来源受限但同人还有安全来源时仍有一张卡');
assert.equal(accessHiddenCount(), 1, '不能因首选来源受限而把整位画师算作隐藏');
assert.equal(visibleTree()[0].children[0].children[0].locked, false, '仍有安全备用图的画风组不能被代表图误锁');
assert.equal(visibleTree()[0].children[0].children[0].count, 2, '目录仍按人计数，不重复计算备用来源');
entries[0].rating = 'r18g';
invalidateAccessViewMemo();
assert.equal(visibleTree()[0].children[0].children[0].count, 2, '首选重口图隐藏后仍由安全备用图为同人计数');
assert.equal(visibleTree()[0].children[0].children[0].locked, false);
entries[0].rating = 'safe';
invalidateAccessViewMemo();
codex.nsfw = true;
assert.equal(visibleEntryCount(), 0, '整本锁定时无可见卡片');
assert.equal(accessHiddenCount(), 4, '整本隐藏也按去重展示卡数计算');
delete codex.nsfw;
state.allowNsfw = true;
assert.equal(visibleEntryCount(), 4);
assert.equal(accessHiddenCount(), 0);
state.allowNsfw = false;
assert.equal(visibleEntryCount(), 3, '权限变化会失效展示计数快照');
document.body.classList.add('edit-mode');
assert.equal(visibleEntryCount(), 4, '编辑模式按原始可访问词条计数');
assert.equal(accessHiddenCount(), 3);
document.body.classList.remove('edit-mode');
assert.equal(visibleEntryCount(), 3);
for (const view of ['favoritesView', 'siteSearchView']) {
  state[view] = true;
  assert.equal(visibleEntryCount(), 4, '虚拟视图保留原条目口径');
  assert.equal(accessHiddenCount(), 3);
  state[view] = false;
}
invalidateAccessViewMemo();

const example = entries[0];
assert.equal(example.styleArtistTitle, 'Canonical');
const placement = { entry: example, index: 0, width: 160, height: 180, left: 0, top: 0, tagsHeight: 36, imageHeight: 0 };
const title = () => makeCard(placement).querySelector('.card-title').textContent;
document.body.classList.add('edit-mode');
const rawMetrics = estimateBodyMetrics(example, 160);
assert.equal(title(), example.title);
document.body.classList.remove('edit-mode');
const allMetrics = estimateBodyMetrics(example, 160);
assert.equal(title(), 'Canonical', '整书全部页沿用规范画师名，不随高优先级例图变成旧写法');
assert.ok(allMetrics.height < rawMetrics.height, '估高与实际渲染使用同一规范标题');
assert.equal(estimateBodyMetrics(example, 160), allMetrics, '标题不变时复用测高缓存');
state.query = 'artist';
state.searchPlan = { hasActiveSearch: true, highlightTerms: [], promptHighlightTerms: [] };
assert.equal(title(), 'Canonical', '本书搜索也沿用规范标题');
assert.equal(estimateBodyMetrics(example, 160), allMetrics);
for (const view of ['favoritesView', 'siteSearchView']) {
  state[view] = true;
  assert.equal(title(), example.title, '虚拟视图保留所点原词条标题');
  assert.equal(estimateBodyMetrics(example, 160).height, rawMetrics.height, '视图变化后测高缓存按实际标题失效');
  state[view] = false;
}
document.body.classList.add('edit-mode');
assert.equal(title(), example.title);
assert.equal(estimateBodyMetrics(example, 160).height, rawMetrics.height);
document.body.classList.remove('edit-mode');
assert.equal(randomKey(entries[0]), randomKey(entries[1]), '普通浏览跨来源切换后，随机探索仍记得已经看过同一人');
assert.notEqual(randomKey(entries[0]), randomKey(entries[3]), '不同画师分别记录');
assert.equal(randomKey(entries[5]), `${codex.id}:${entries[5].id}`, '未知条目沿用来源键');
assert.equal(randomKey(entries[6]), `${codex.id}:${entries[6].id}`, '画风串沿用来源键');
state.recentRandomIds = [];
rememberRandomEntry(entries[0]);
rememberRandomEntry(entries[1]);
assert.deepEqual(state.recentRandomIds, [`${codex.id}:${entries[1].id}`], '同一画师只占一个最近记录');
for (const view of ['favoritesView', 'siteSearchView']) {
  state[view] = true;
  assert.notEqual(randomKey(entries[0]), randomKey(entries[1]), '虚拟视图的具体来源可分别随机探索');
  state[view] = false;
}
document.body.classList.add('edit-mode');
assert.notEqual(randomKey(entries[0]), randomKey(entries[1]), '编辑模式保留具体词条随机键');
console.log('artist style counts and canonical titles: PASS');
