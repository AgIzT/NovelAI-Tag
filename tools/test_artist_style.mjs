// 单画师按画风重排（原型）纯逻辑：node tools/test_artist_style.mjs
// 覆盖：挂数据不改写 codex.tree、展示目录与计数路径、未归类、本地编辑模式下关闭重排、旧来源链接落点、
// 每位画师一张卡、按 post 排、卡片底行、详情落点、拷贝词条按 ID 认画师、接近名单分片。
import assert from 'node:assert/strict';
import { state } from '../site/assets/app/state.js';

const data = {
  schema: 1, codexId: 'artist_nai5_personal', idPrefix: 'artist_nai5_personal_', nearShard: 2,
  parents: [
    { name: '甲类', desc: '甲', groups: [0, 1], size: 3, showcase: [1, 0] },
    { name: '乙类', desc: '乙', groups: [2], size: 1, showcase: [3] },
  ],
  groups: [
    { name: '甲一', desc: '', tags: ['偏暗'], parent: 0, size: 2, reps: [0, 1], famous: [0] },
    { name: '甲二', desc: '', tags: [], parent: 0, size: 1, reps: [2], famous: [] },
    { name: '乙一', desc: '', tags: [], parent: 1, size: 1, reps: [3], famous: [] },
  ],
  artists: [
    { e: 'baolong_1', p: 500, r: 1, g: 0, o: 1, x: ['huazhiyu_9'] },
    { e: 'baolong_2', p: 2000, r: 7, t: 'someone', g: 0, o: 0 },
    { e: 'baolong_3', p: null, r: null, g: 1, o: 0 },
    { e: 'baolong_4', p: 90, r: 40, g: 2, o: 0 },
  ],
};
const nearShards = { 0: [[1, 2], [0]], 1: [[0], [2, 1, 0]] };
globalThis.fetch = async url => {
  const shard = String(url).match(/artist_styles_near\/(\d+)\.json$/);
  const body = shard ? nearShards[shard[1]] : data;
  return { ok: Boolean(body), json: async () => body };
};
let editMode = false;
globalThis.document = { body: { classList: { contains: name => name === 'edit-mode' && editMode } } };

const style = await import('../site/assets/app/artist-style.js');
const entry = (id, path, tags = `artist:${id}`) => ({ id: `artist_nai5_personal_${id}`, path, title: id, tags });
const entries = [
  entry('huazhiyu_9', ['单画师词典', '花枝鱼', '测试图'], 'artist:baolong 1, year 2025'),
  entry('baolong_1', ['单画师词典', 'MayRain', '例图']),
  entry('baolong_2', ['单画师词典', 'MayRain', '例图']),
  entry('baolong_3', ['单画师词典', 'MayRain', '例图']),
  entry('baolong_4', ['单画师词典', 'MayRain', '例图']),
  entry('jiuqi_77', ['单画师词典', '九七', '参考'], 'artist:a, artist:b'),
  entry('wof_1', ['画风组词典', 'W.O.F'], '0.6::artist:baolong_1::, artist:baolong_2'),
];
const tree = [
  { name: '单画师词典', count: 6, children: [{ name: '花枝鱼', count: 1, children: [] }, { name: 'MayRain', count: 4, children: [] }, { name: '九七', count: 1, children: [] }] },
  { name: '画风组词典', count: 1, children: [{ name: 'W.O.F', count: 1, children: [] }] },
];
const treeSnapshot = JSON.stringify(tree);
const codex = { id: 'artist_nai5_personal', entries, tree };

// 挂数据
assert.equal(await style.attachArtistStyles({ id: 'suozhang', entries: [] }), false, '别的书不挂');
assert.equal(await style.attachArtistStyles(codex), true);
assert.equal(codex.tree, tree, '原目录对象不换');
assert.equal(JSON.stringify(codex.tree), treeSnapshot, '原目录内容不改：本地编辑器、全站搜索、收藏仍用它');
assert.deepEqual(codex.styleTree[0].children.map(node => [node.name, node.count]), [['甲类', 3], ['乙类', 1], ['未归类', 1]],
  '单画师词典下是画风大类，计数按画师；未归类垫底');
assert.deepEqual(codex.styleTree[1], tree[1], '画风组词典照旧');
assert.equal(codex.displayTree, codex.styleTree);
assert.deepEqual(codex.styleSources, ['花枝鱼', 'MayRain', '九七'], '例图来源取自原来源目录');
assert.equal(await style.attachArtistStyles(codex), true, '同一本书只挂一次');

// 目录计数路径
assert.deepEqual(style.treePathOf(entries[1], codex), ['单画师词典', '甲类', '甲一'], '代表词条按画风小组计');
assert.equal(style.treePathOf(entries[0], codex), null, '同一画师的其它来源例图不另计');
assert.deepEqual(style.treePathOf(entries[5], codex), ['单画师词典', '未归类'], '多画师词条进未归类');
assert.deepEqual(style.treePathOf(entries[6], codex), ['画风组词典', 'W.O.F'], '画风串照原路径');
const copy = { ...entries[1], path: ['NovelAI v5画师词典', ...entries[1].path] };
assert.deepEqual(style.treePathOf(copy, { id: 'favorites', entries: [] }), copy.path, '收藏、全站搜索的拷贝不按画风算');
assert.deepEqual(style.styleTreeSkeleton(codex).children.map(node => [node.name, node.children]),
  [['甲类', ['甲一', '甲二']], ['乙类', ['乙一']], ['未归类', []]]);
assert.equal(style.styleTreeSkeleton({ id: 'favorites', entries: [] }), null);

// 本地编辑模式：整套重排关闭
editMode = true;
assert.equal(style.styleActive(codex), false);
assert.equal(codex.displayTree, tree, '编辑器看到真实来源目录');
assert.deepEqual(style.treePathOf(entries[1], codex), entries[1].path);
assert.equal(style.styleTreeSkeleton(codex), null);
assert.equal(codex.styleRouteFallback(['单画师词典', 'MayRain']), null);
editMode = false;

// 旧链接里的来源目录落到单画师首页
assert.deepEqual(codex.styleRouteFallback(['单画师词典', 'MayRain', '例图']), ['单画师词典']);
assert.equal(codex.styleRouteFallback(['画风组词典', '不存在']), null);

// 层级与列表
state.codex = codex;
state.favoritesView = false;
state.siteSearchView = false;
state.activePath = ['画风组词典'];
assert.equal(style.inSingleSection(), false);
state.activePath = ['单画师词典'];
assert.equal(style.inSingleSection(), true);
assert.equal(style.styleLocation().level, 'root');
assert.equal(style.styleLocation(['单画师词典', '未归类']).level, 'unsorted');
assert.equal(style.styleLocation(['单画师词典', '甲类', '甲一']).group.name, '甲一');
assert.equal(style.styleLocation(['单画师词典', '甲类']).level, 'parent');
const ids = list => list.map(item => item.id.replace('artist_nai5_personal_', ''));
assert.deepEqual(ids(style.selectStyleEntries(entries, ['单画师词典'])), ['baolong_1', 'baolong_2', 'baolong_3', 'baolong_4'], '首页范围：每位画师一张代表卡');
assert.deepEqual(ids(style.selectStyleEntries(entries, ['单画师词典', '甲类'])), ['baolong_1', 'baolong_2', 'baolong_3']);
assert.deepEqual(ids(style.selectStyleEntries(entries, ['单画师词典', '甲类', '甲一'])), ['baolong_1', 'baolong_2']);
assert.deepEqual(ids(style.selectStyleEntries(entries, ['单画师词典', '未归类'])), ['jiuqi_77']);
assert.deepEqual(ids(style.selectStyleEntries(entries.filter(item => !item.id.endsWith('baolong_1')), ['单画师词典', '甲类', '甲一'])),
  ['huazhiyu_9', 'baolong_2'], '代表那条被分级挡住时改用这位画师别的例图，画师不消失');
state.siteSearchView = true;
assert.equal(style.inSingleSection(), false, '全站搜索不进单画师各层');
state.siteSearchView = false;

// 卡片
state.activePath = ['单画师词典', '甲类'];
assert.equal(style.styleCardLine(entries[2]), '甲一 · post 2,000 · 辨识度中', '大类页底行带小组名');
state.activePath = ['单画师词典', '甲类', '甲一'];
assert.equal(style.styleCardLine(entries[2]), 'post 2,000 · 辨识度中', '小组页不重复写组名');
state.activePath = ['单画师词典', '未归类'];
assert.equal(style.styleCardLine(entries[5]), '', '未归类照旧写路径');
state.activePath = [];
assert.equal(style.styleCardLine(entries[1]), '', '「全部」里照旧写路径');
assert.equal(style.stylePathText(entries[0]), '单画师词典 › 甲一 · 花枝鱼', '其它视图的路径行和侧栏一致，带上例图来源');
assert.equal(style.stylePathText(entries[6]), '', '画风串照原路径');

// 详情落点与拷贝
assert.deepEqual(style.landingPathOf(entries[0], codex), ['单画师词典', '甲类', '甲一'], '打开词条落到画风小组，不落到来源目录');
assert.deepEqual(style.landingPathOf(entries[6], codex), entries[6].path);
assert.equal(style.artistOf({ id: 'artist_nai5_personal_baolong_2', path: ['收藏'] })?.index, 1, '拷贝按 ID 认画师');
assert.equal(style.artistOf({ id: 'suozhang_001', path: [] }), null);
assert.deepEqual(ids(style.specimensOf(style.artistByIndex(0))), ['baolong_1', 'huazhiyu_9'], '代表那条在前');

// 排序
const reps = entries.slice(1, 5);
assert.deepEqual(ids(style.sortStyleEntries(reps)), ['baolong_2', 'baolong_1', 'baolong_4', 'baolong_3'], '按 post 多到少，未知垫底');

assert.equal(style.recText(null), '未知');
assert.equal(style.formatPost(null), 'post 未知');
assert.deepEqual(await style.loadNearArtists(1), [0], '第 0 片第 2 行');
assert.deepEqual(await style.loadNearArtists(3), [2, 1, 0], '第 1 片第 2 行');

console.log('artist style: PASS');
