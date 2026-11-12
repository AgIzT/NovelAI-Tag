// 画风分类（原型）纯逻辑：node tools/test_artist_style.mjs
// 覆盖：挂数据到法典（代表词条虚拟路径、同画师其它词条、树前插虚拟目录、只挂一次）、层级解析、筛选与排序、卡片底行、接近名单分片。
import assert from 'node:assert/strict';
import { state } from '../site/assets/app/state.js';

const data = {
  schema: 1, codexId: 'artist_nai5_personal', idPrefix: 'artist_nai5_personal_', root: '画风分类', nearShard: 2,
  parents: [{ name: '甲类', desc: '甲', groups: [0, 1], size: 3 }, { name: '乙类', desc: '乙', groups: [2], size: 1 }],
  groups: [
    { name: '甲一', desc: '', tags: [], parent: 0, size: 2, reps: [0, 1], famous: [0] },
    { name: '甲二', desc: '', tags: [], parent: 0, size: 1, reps: [2], famous: [] },
    { name: '乙一', desc: '', tags: [], parent: 1, size: 1, reps: [3], famous: [] },
  ],
  artists: [
    { e: 'baolong_1', p: 500, r: 1, g: 0, o: 1, l: 0, v: 2, x: ['huazhiyu_9'] },
    { e: 'baolong_2', p: 2000, r: 7, t: 'someone', g: 0, o: 0, l: 1, v: 1 },
    { e: 'baolong_3', p: null, r: null, g: 1, o: 0, l: 2, v: 0, w: [5, 0.6] },
    { e: 'baolong_4', p: 90, r: 40, g: 2, o: 0, l: 0, v: 0 },
  ],
};
const nearShards = { 0: [[1, 2], [0]], 1: [[0], [2, 1, 0]] };
globalThis.fetch = async url => {
  const shard = String(url).match(/artist_styles_near\/(\d+)\.json$/);
  const body = shard ? nearShards[shard[1]] : data;
  return { ok: Boolean(body), json: async () => body };
};

const style = await import('../site/assets/app/artist-style.js');
const entry = (id, path) => ({ id: `artist_nai5_personal_${id}`, path, title: id, tags: `artist:${id}` });
const entries = [
  entry('huazhiyu_9', ['单画师词典', '花枝鱼']),
  entry('baolong_1', ['单画师词典', 'MayRain']),
  entry('baolong_2', ['单画师词典', 'MayRain']),
  entry('baolong_3', ['单画师词典', 'MayRain']),
  entry('baolong_4', ['单画师词典', 'MayRain']),
];
const codex = { id: 'artist_nai5_personal', entries, tree: [{ name: '单画师词典', count: 5, children: [] }] };

assert.equal(style.supportsArtistStyles({ id: 'suozhang' }), false);
assert.equal(await style.ensureArtistStyles({ id: 'suozhang', entries: [] }), false, '别的书不挂');
assert.equal(await style.ensureArtistStyles(codex), true);
assert.deepEqual(entries[1].stylePath, ['画风分类', '甲类', '甲一'], '代表词条挂虚拟路径');
assert.equal(entries[0].stylePath, undefined, '同画师其它词条不进画风目录');
assert.equal(entries[0].styleArtist, 0, '同画师其它词条也能查到画风');
assert.deepEqual(codex.tree.map(node => node.name), ['画风分类', '单画师词典'], '虚拟目录排最前，原目录保留');
assert.deepEqual(codex.tree[0].children.map(node => [node.name, node.count]), [['甲类', 3], ['乙类', 1]]);
const stamp = codex.styleStamp;
assert.equal(await style.ensureArtistStyles(codex), true);
assert.equal(codex.styleStamp, stamp, '同一本书只挂一次');
assert.equal(codex.tree.filter(node => node.name === '画风分类').length, 1);
assert.deepEqual(style.styleTreeSkeleton(codex).children.map(p => [p.name, p.children]), [['甲类', ['甲一', '甲二']], ['乙类', ['乙一']]]);

state.codex = codex;
state.favoritesView = false;
state.siteSearchView = false;
state.activePath = ['单画师词典'];
assert.equal(style.inStyleView(), false);
assert.equal(style.styleCardLine(entries[1]), '', '来源目录里卡片底行照旧');
state.activePath = ['画风分类'];
assert.equal(style.inStyleView(), true);
assert.equal(style.styleLocation().level, 'root');
assert.equal(style.styleCardLine(entries[2]), '甲一 · post 2,000 · 辨识度中');
state.activePath = ['画风分类', '甲类', '甲一'];
assert.equal(style.styleLocation().group.name, '甲一');
assert.equal(style.styleCardLine(entries[2]), 'post 2,000 · 辨识度中', '小组页不重复写组名');
assert.equal(style.styleLocation(['画风分类', '甲类']).level, 'parent');
assert.equal(style.styleLocation(['画风分类', '不存在']).level, 'root');
state.siteSearchView = true;
assert.equal(style.inStyleView(), false, '全站搜索不进画风视图');
state.siteSearchView = false;

const reps = [entries[1], entries[2], entries[3], entries[4]];
const ids = list => list.map(item => item.id.replace('artist_nai5_personal_', ''));
assert.deepEqual(ids(style.sortStyleEntries(reps)), ['baolong_2', 'baolong_1', 'baolong_4', 'baolong_3'], '默认按 post 多到少，未知垫底');
style.styleView.sort = 'rec';
assert.deepEqual(ids(style.sortStyleEntries(reps)), ['baolong_1', 'baolong_2', 'baolong_4', 'baolong_3'], '按辨识度，未知垫底');
style.styleView.sort = 'near';
assert.deepEqual(ids(style.sortStyleEntries(reps)), ['baolong_2', 'baolong_1', 'baolong_3', 'baolong_4'], '按小组再按离中心名次');
style.styleView.sort = 'post';
style.styleView.heat = 'hot';
assert.deepEqual(ids(style.filterStyleEntries(reps)), ['baolong_2']);
style.styleView.heat = '';
style.styleView.rec = 'low';
assert.deepEqual(ids(style.filterStyleEntries(reps)), ['baolong_4']);
style.styleView.rec = '';
style.styleView.light = '2';
assert.deepEqual(ids(style.filterStyleEntries(reps)), ['baolong_3']);
style.styleView.light = '';
assert.equal(style.filterStyleEntries(reps), reps, '没有筛选时原样返回');

assert.equal(style.recText(null), '未知');
assert.equal(style.formatPost(null), 'post 未知');
assert.deepEqual(await style.loadNearArtists(1), [0], '第 0 片第 2 行');
assert.deepEqual(await style.loadNearArtists(3), [2, 1, 0], '第 1 片第 2 行');

console.log('artist style: PASS');
