// 单画师按画风重排（原型）纯逻辑：node tools/test_artist_style.mjs
// 覆盖：挂数据不改写 codex.tree、展示目录与计数路径、未归类、本地编辑模式下关闭重排、旧来源链接落点、
// 每位画师一张卡、按 post 排、卡片底行、详情落点、拷贝词条按 ID 认画师、接近名单分片。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { todayFeatured, isFeaturedEntry, pinFeatured, featuredArtistName } from '../site/assets/app/featured.js';
import { codexUpdateFilters, entryMatchesUpdateFilter } from '../site/assets/app/data.js';
import { decodeCodexPathCode, normalizeCodexRoutePath } from '../site/assets/app/codex-route-compat.js';
import { encodePathCode } from '../site/assets/app/path-code.js';
import { parseSearchQuery, rankSearchResults } from '../site/assets/app/search.js';
import { state } from '../site/assets/app/state.js';

const data = {
  schema: 3, codexId: 'artist_nai5_personal', idPrefix: 'artist_nai5_personal_', nearShard: 2,
  nearRevision: '0123456789abcdef',
  pathAliases: [
    { from: ['单画师词典', '旧甲类'], to: ['单画师词典', '甲类'] },
    { from: ['单画师词典', '旧甲类', '旧甲一'], to: ['单画师词典', '甲类', '甲一'] },
    { from: ['单画师词典', '旧甲类', '不存在'], to: ['单画师词典', '甲类', '不存在'] },
    { from: ['画风组词典', '旧甲类'], to: ['单画师词典', '甲类'] },
  ],
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
    { e: 'baolong_1', p: 500, r: 1, s: 'baolong_1', g: 0, o: 1, x: ['huazhiyu_9', 'huazhiyu_10'] },
    { e: 'baolong_2', p: 2000, r: 7, t: 'someone', g: 0, o: 0 },
    { e: 'baolong_3', p: null, r: null, g: 1, o: 0 },
    { e: 'baolong_4', p: 90, r: 40, g: 2, o: 0 },
  ],
};
const nearShards = { 0: [[1, 2], [0]], 1: [[0], [2, 1, 0]] };
const requestedUrls = [];
globalThis.fetch = async url => {
  requestedUrls.push(String(url));
  const shard = String(url).match(/artist_styles_near\/0123456789abcdef\/(\d+)\.json$/);
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
  entry('huazhiyu_10', ['单画师词典', '花枝鱼（无原图）', '其它图'], 'artist:baolong 1'),
];
const tree = [
  { name: '单画师词典', count: 6, children: [{ name: '花枝鱼', count: 1, children: [] }, { name: 'MayRain', count: 4, children: [] }, { name: '九七', count: 1, children: [] }] },
  { name: '画风组词典', count: 1, children: [{ name: 'W.O.F', count: 1, children: [] }] },
];
const treeSnapshot = JSON.stringify(tree);
const codex = { id: 'artist_nai5_personal', entries, tree };
data.sourceFingerprint = createHash('sha256').update(JSON.stringify(entries
  .filter(entry => entry.path[0] === '单画师词典')
  .sort((a, b) => a.id < b.id ? -1 : 1)
  .map(entry => [entry.id, entry.path, entry.image || '', entry.rating || 'safe', entry.tags || '']))).digest('hex');

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

// 改名之前保存的完整路径（path=、历史与最近浏览）仍在同一画风目录。
const oldParent = ['单画师词典', '旧甲类'];
const newParent = ['单画师词典', '甲类'];
const oldGroup = [...oldParent, '旧甲一'];
const newGroup = [...newParent, '甲一'];
assert.deepEqual(normalizeCodexRoutePath(codex, oldParent), newParent, '旧大类链接进入同一类');
assert.deepEqual(normalizeCodexRoutePath(codex, oldGroup), newGroup, '旧小组链接进入同一组');
assert.deepEqual(normalizeCodexRoutePath(codex, newGroup), newGroup, '当前分类名优先');
assert.deepEqual(normalizeCodexRoutePath(codex, [...oldParent, '不存在']), ['单画师词典'], '不恢复已经不存在的目的地');
assert.deepEqual(normalizeCodexRoutePath(codex, ['画风组词典', '旧甲类']), [], '兼容路径只能在单画师目录内');
const fromCode = path => normalizeCodexRoutePath(codex, decodeCodexPathCode(codex, encodePathCode(path)));
assert.deepEqual(fromCode(oldParent), newParent, '旧大类短码');
assert.deepEqual(fromCode(oldGroup), newGroup, '旧小组短码');
assert.deepEqual(fromCode(newGroup), newGroup, '现有小组短码');
assert.deepEqual(fromCode(['单画师词典', 'MayRain']), ['单画师词典'], '原来源目录短码保持旧行为');
assert.deepEqual(fromCode(['单画师词典', '旧甲类', '未知']), [], '随机短码回到全部');
editMode = true;
assert.deepEqual(normalizeCodexRoutePath(codex, oldGroup), [], '编辑模式不使用画风别名');
assert.deepEqual(fromCode(oldGroup), [], '编辑模式不使用画风短码');
assert.deepEqual(fromCode(['单画师词典', 'MayRain']), ['单画师词典', 'MayRain'], '编辑模式仍还原真实来源目录');
editMode = false;

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
assert.deepEqual(ids(style.selectStyleEntries(entries, ['单画师词典'])), ['huazhiyu_9', 'baolong_2', 'baolong_3', 'baolong_4', 'jiuqi_77'], '首页每位画师一张，并保留尚未归类的原条目');
assert.deepEqual(ids(style.deduplicateStyleEntries(entries)),
  ['huazhiyu_9', 'baolong_2', 'baolong_3', 'baolong_4', 'jiuqi_77', 'wof_1'],
  '整本选卡只合并已知单画师，画风串与未归类原样保留');
assert.deepEqual(ids(style.deduplicateStyleEntries([entries[2], entries[1], entries[5], entries[6]])),
  ['baolong_2', 'baolong_1', 'jiuqi_77', 'wof_1'], '只从本次筛选保留的候选里选择，不能补回未命中的首选图');
assert.deepEqual(ids(style.selectStyleEntries(entries, ['单画师词典', '甲类'])), ['huazhiyu_9', 'baolong_2', 'baolong_3']);
assert.deepEqual(ids(style.selectStyleEntries(entries, ['单画师词典', '甲类', '甲一'])), ['huazhiyu_9', 'baolong_2']);
assert.deepEqual(ids(style.selectStyleEntries(entries, ['单画师词典', '未归类'])), ['jiuqi_77']);
assert.deepEqual(ids(style.selectStyleEntries(entries.filter(item => !item.id.endsWith('baolong_1')), ['单画师词典', '甲类', '甲一'])),
  ['huazhiyu_9', 'baolong_2'], '代表那条被分级挡住时改用这位画师别的例图，画师不消失');
const sourceOrder = JSON.parse(await readFile(new URL('./fixtures/artist_specimen_order.json', import.meta.url), 'utf8'));
assert.deepEqual([...style.SPECIMEN_SOURCE_ORDER], sourceOrder.canonicalOrder, '前端与生成器共用同一来源顺序夹具');
for (const [source, rank] of sourceOrder.sourceCases) {
  assert.equal(style.specimenSourceRank({ path: ['单画师词典', source] }), rank, `来源归一：${source}`);
}
const priorityCandidates = [...sourceOrder.canonicalOrder, '未知来源'].map((source, index) => ({
  ...entries[1], id: `artist_nai5_personal_priority_${index}`, path: ['单画师词典', source], styleRep: source === 'MayRain',
}));
for (let first = 0; first < priorityCandidates.length; first += 1) {
  const eligible = priorityCandidates.slice(first).reverse();
  assert.equal(style.selectStyleEntries(eligible, ['单画师词典'])[0].id, priorityCandidates[first].id,
    '优先来源受限后，只在调用者保留的合格例图中依次回退');
}
assert.deepEqual(ids(style.selectStyleEntries([entries[7], entries[0]], ['单画师词典'])), ['huazhiyu_9'],
  '同来源平局按原 e/x 次序，不跟随候选输入次序');
assert.deepEqual(ids(style.selectStyleEntries([{ ...entries[0], path: entries[1].path }, entries[1]], ['单画师词典'])), ['baolong_1'],
  '仅在同来源平局时，原代表图排在其它例图前');
assert.deepEqual(style.selectStyleEntries(priorityCandidates, ['单画师词典'], { deduplicate: false }), priorityCandidates,
  '去重之前不丢例图，访问与屏蔽筛选仍可先执行');
assert.equal(entries[0].styleArtistTitle, entries[1].title, '高优先级来源出卡也沿用规范身份的标题');
state.siteSearchView = true;
assert.equal(style.inSingleSection(), false, '全站搜索不进单画师各层');
state.siteSearchView = false;

// 卡片
state.activePath = ['单画师词典', '甲类'];
assert.equal(style.styleCardLine(entries[2]), '甲一 · post 2,000', '大类页底行带小组名');
state.activePath = ['单画师词典', '甲类', '甲一'];
assert.equal(style.styleCardLine(entries[2]), 'post 2,000', '小组页不重复写组名');
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
assert.deepEqual(ids(style.specimensOf(style.artistByIndex(0))), ['huazhiyu_9', 'huazhiyu_10', 'baolong_1'], '例图列表按来源优先级，同来源保持原 e/x 顺序');

// 浏览列表先跟随展示目录，只有同一个画风小组内部按 post 排。
const reps = entries.slice(1, 5);
assert.deepEqual(ids(style.sortStyleEntries(reps)), ['baolong_2', 'baolong_1', 'baolong_3', 'baolong_4'],
  '跨组不拿 post 比较：甲二的未知 post 仍在乙一前面');
const savedPost = style.artistByIndex(2).post;
style.artistByIndex(2).post = 3000;
assert.deepEqual(ids(style.sortStyleEntries(reps.slice(0, 3))), ['baolong_2', 'baolong_1', 'baolong_3'],
  '大类内也先按小组顺序，不能把后一小组的高 post 插到前面');
style.artistByIndex(2).post = savedPost;
assert.deepEqual(ids(style.sortStyleEntries([entries[1], entries[2]])), ['baolong_2', 'baolong_1'],
  '单小组仍按 post 降序');
const allInput = [...entries].reverse();
assert.deepEqual(ids(style.sortStyleEntries(allInput)),
  ['baolong_2', 'huazhiyu_10', 'baolong_1', 'huazhiyu_9', 'baolong_3', 'baolong_4', 'jiuqi_77', 'wof_1'],
  '整书全部按展示路径连续排列，保留同人多来源卡片及未归类/画风串');
assert.deepEqual(allInput, [...entries].reverse(), '排序不能改输入数组');
const reverseParents = { ...codex, displayTree: [{ ...codex.styleTree[0], children: [
  codex.styleTree[0].children[1], codex.styleTree[0].children[0], codex.styleTree[0].children[2],
] }, codex.styleTree[1]] };
assert.deepEqual(ids(style.sortStyleEntries(reps, reverseParents)), ['baolong_4', 'baolong_2', 'baolong_1', 'baolong_3'],
  '使用实际展示树的目录次序，不写死画师数据的组下标');
editMode = true;
assert.deepEqual(style.sortStyleEntries(allInput), allInput, '编辑模式不套展示目录排序');
editMode = false;

// 挑画师（原型）：换分法时，单画师词典下面的目录和每位画师的归属一起换
const singleNodes = () => codex.styleTree.find(node => node.name === '单画师词典').children.map(node => `${node.name}:${node.count}`);
const styleTreeBefore = JSON.stringify(codex.styleTree);
assert.equal(style.artistDivision(codex), 'style');
assert.equal(style.setArtistDivision(codex, 'nope', { persist: false }), false, '不认识的分法不动');
assert.equal(style.setArtistDivision(codex, 'post', { persist: false }), true);
assert.equal(style.artistDivision(codex), 'post');
assert.deepEqual(singleNodes(), ['2000 以上:1', '500–999:1', '100 以下:1', 'post 未知:1', '未归类:1'],
  '按 post：档位从高到低，空档不建，未知和未归类垫底');
assert.deepEqual(entries[0].stylePath, ['单画师词典', '500–999'], '同一位画师的各来源例图一起换到档位下');
assert.deepEqual(entries[5].stylePath, ['单画师词典', '未归类'], '未归类不动');
assert.deepEqual(ids(style.sortStyleEntries(reps)), ['baolong_2', 'baolong_1', 'baolong_4', 'baolong_3'],
  '按 post 分时，原有的目录排序自然成了从多到少');
state.activePath = ['单画师词典', '500–999'];
assert.equal(style.styleLocation().level, 'band');
assert.deepEqual(ids(style.selectStyleEntries(entries)), ['huazhiyu_9'], '点档位只看这一档，仍是一人一卡');
assert.equal(style.styleCardLine(entries[1]), '甲一 · post 500', '档位页底行带上画风小组名');
state.activePath = [];
assert.equal(style.stylePathText(entries[0]), '甲一 · post 500', '按 post 分时「全部」里不把画风小组写成路径');
codex.updateFilters = [{ id: '2026.9.5', label: '9.5更新' }, { id: '2026.11.15', label: '11.15更新', latest: true }];
entries[4].updateBatches = ['2026.9.5'];
entries[7].updateBatches = ['2026.9.5', '2026.11.15'];
assert.equal(style.setArtistDivision(codex, 'new', { persist: false }), true);
assert.deepEqual(singleNodes(), ['11.15更新:1', '9.5更新:1', '未标批次:2', '未归类:1'],
  '按上新：批次新的在前，看这位画师全部例图里最新的一期');
assert.equal(style.setArtistDivision(codex, 'style', { persist: false }), true);
assert.equal(JSON.stringify(codex.styleTree), styleTreeBefore, '换回按画风后目录与初始一致');
assert.deepEqual(entries[0].stylePath, ['单画师词典', '甲类', '甲一']);
assert.equal(style.stylePathText(entries[0]), '单画师词典 › 甲一 · 花枝鱼');
delete codex.updateFilters;
delete entries[4].updateBatches;
delete entries[7].updateBatches;

// 只看所选
state.artistPicked = new Map([[3, 'artist_nai5_personal_baolong_4'], [0, 'artist_nai5_personal_baolong_1']]);
assert.deepEqual(ids(style.pickedArtistEntries(reps)), ['baolong_4', 'baolong_1'], '只看所选按勾选顺序，没勾的不出现');
assert.equal(style.artistPickedView(), false);
state.artistPickOnly = true;
assert.equal(style.artistPickedView(), true);
state.activePath = ['单画师词典', '甲类', '甲一'];
assert.equal(style.styleCardLine(entries[1]), '甲一 · post 500', '只看所选跨目录，底行带上小组名');
state.activePath = [];
state.artistPickOnly = false;
state.artistPicked = new Map();

// 今日画师抽到的原来源可能不是本次一人一卡选中的来源，仍只置顶这个人已选的卡。
const featuredBook = { ...codex, entries: entries.map((entry, index) => index === 1
  ? { ...entry, rating: 'safe', image: 'featured.jpg', imageWidth: 100, imageHeight: 200 }
  : { ...entry }) };
const rawFeatured = todayFeatured(featuredBook);
assert.equal(rawFeatured.id, entries[1].id, '夹具只给原 MayRain 来源一个合格候选');
const chosenFeatured = featuredBook.entries[0];
const otherArtist = featuredBook.entries[2];
const featureInput = [otherArtist, chosenFeatured, featuredBook.entries[6]];
assert.equal(isFeaturedEntry(chosenFeatured, featuredBook), true, '今日标记跟同一画师，而非只认原图 ID');
assert.equal(isFeaturedEntry(otherArtist, featuredBook), false);
assert.deepEqual(pinFeatured(featureInput, featuredBook), [chosenFeatured, otherArtist, featuredBook.entries[6]],
  '只移动已存在已选的卡，不把原来源补成第二张卡');
assert.equal(featuredArtistName(chosenFeatured), 'baolong_1', '开场使用 c 对应的规范画师名');
assert.deepEqual(featureInput, [otherArtist, chosenFeatured, featuredBook.entries[6]], '置顶不改原列表');
assert.deepEqual(pinFeatured([otherArtist], featuredBook), [otherArtist], '该人没有可见卡时不换人、不补卡');
editMode = true;
assert.equal(isFeaturedEntry(chosenFeatured, featuredBook), false, '编辑模式仍按真实来源词条识别今日卡');
editMode = false;

assert.equal(style.artistOf(entries[0]), style.artistOf(entries[1]), '旧名例图和代表图属于同一位画师');
assert.deepEqual([style.artistOf(entries[0]).rank, style.artistOf(entries[0]).rankSampleId], [1, entries[1].id], '标明用于评估的 v5 封面');
assert.equal(style.artistOf(entries[2]).rank, null, '旧原型数据缺少样图来源，不能当作 v5 结果');
assert.equal(style.formatPost(null), 'post 未知');
assert.deepEqual(await style.loadNearArtists(1), [0], '第 0 片第 2 行');
assert.deepEqual(await style.loadNearArtists(3), [2, 1, 0], '第 1 片第 2 行');
assert.ok(requestedUrls.some(url => url.endsWith('/data/artist_styles_near/0123456789abcdef/0.json')), '邻居下标绑定同一数据发布版本');

// 回放主站筛选入口：往期链接进单画师各层会清掉，NEW 与其它目录的往期链接仍能筛选。
codex.updateFilters = [
  { id: '2026.10.7', label: '10.7更新' },
  { id: '2026.10.24', label: '10.24更新', latest: true },
];
entries[2].isNew = true;
entries[3].updateBatches = ['2026.10.7'];
entries[6].updateBatches = ['2026.10.7'];
const source = await readFile(new URL('../site/assets/app.js', import.meta.url), 'utf8');
const start = source.indexOf('export function applyFilter(');
const end = source.indexOf('\n/* 取消、撤销', start);
assert.ok(start >= 0 && end > start);
const body = source.slice(start, end).replace('export function', 'function');
const blockedIds = new Set();
let featuredPinCalls = 0;
const deps = {
  state, compileSearchState: () => parseSearchQuery(state.query),
  cancelSiteSearchObservation() {}, isCodexLocked: () => false, isEntryAccessBlocked: () => false,
  listSearchDirectories: () => [], searchDirectoryOptions: () => [], prepareSearchZh: () => null,
  virtualView: () => false,
  matchSearchPlan: () => true, codexUpdateFilters, entryMatchesUpdateFilter,
  ...style, isContentBlocked: entry => blockedIds.has(entry.id), sortCategoryEntries: list => list,
  rankSearchResults, pinFeatured: list => {
    featuredPinCalls += 1;
    return [entries[4], ...list.filter(entry => entry !== entries[4])];
  }, findRelatedDirectories: () => [],
  renderSearchExperience() {}, updateResultBar() {}, renderList() {}, updateBlockingSummary() {},
};
const applyFilter = new Function(...Object.keys(deps), body + '\nreturn applyFilter;')(...Object.values(deps));
function runUpdateFilter(path, updateFilter, query = '') {
  state.activePath = path;
  state.updateFilter = updateFilter;
  state.query = query;
  applyFilter();
  return [state.updateFilter, ids(state.list)];
}

assert.deepEqual(runUpdateFilter([], ''), ['',
  ['baolong_4', 'baolong_2', 'huazhiyu_9', 'baolong_3', 'jiuqi_77', 'wof_1']],
  '全部页每位画师一张，独立今日首卡不重复，画风串和未知条目保留');
assert.equal(featuredPinCalls, 1, '保留原今日画师置顶入口，不将它作为普通目录分组的一部分');
assert.deepEqual(runUpdateFilter(['单画师词典'], '', 'needle'), ['',
  ['huazhiyu_9', 'baolong_2', 'baolong_3', 'baolong_4', 'jiuqi_77', 'wof_1']],
  '本书搜索也一人一卡，但保留搜索排序和匹配到的非单画师内容');
assert.deepEqual(runUpdateFilter(['单画师词典'], '2026.10.7'), ['', ['baolong_2', 'huazhiyu_9', 'baolong_3', 'baolong_4', 'jiuqi_77']]);
assert.deepEqual(runUpdateFilter(['单画师词典', '甲类'], '2026.10.7'), ['', ['baolong_2', 'huazhiyu_9', 'baolong_3']]);
assert.deepEqual(runUpdateFilter(['单画师词典', '甲类', '甲一'], '2026.10.7'), ['', ['baolong_2', 'huazhiyu_9']]);
assert.deepEqual(runUpdateFilter(['单画师词典', '未归类'], '2026.10.7'), ['', ['jiuqi_77']]);
assert.deepEqual(runUpdateFilter(['单画师词典', '甲类'], '2026.10.24'), ['2026.10.24', ['baolong_2']]);
assert.deepEqual(runUpdateFilter([], '2026.10.7'), ['2026.10.7', ['baolong_3', 'wof_1']]);
assert.deepEqual(runUpdateFilter(['画风组词典'], '2026.10.7'), ['2026.10.7', ['wof_1']]);
assert.deepEqual(runUpdateFilter(['单画师词典'], '2026.10.7', 'baolong_3'), ['2026.10.7', ['baolong_3', 'wof_1']]);
editMode = true;
assert.deepEqual(runUpdateFilter(['单画师词典', 'MayRain'], '2026.10.7'), ['2026.10.7', ['baolong_3']]);
editMode = false;

// 隐藏其中一张来源图后，同一画师仍用合格的其它来源出卡。
blockedIds.add(entries[1].id);
assert.deepEqual(runUpdateFilter(['单画师词典', '甲类', '甲一'], ''), ['', ['baolong_2', 'huazhiyu_9']]);
blockedIds.clear();
entries[0].isNew = true;
assert.deepEqual(runUpdateFilter(['单画师词典', '甲类', '甲一'], '2026.10.24'), ['2026.10.24', ['baolong_2', 'huazhiyu_9']]);
blockedIds.add(entries[0].id);
assert.deepEqual(runUpdateFilter(['单画师词典', '甲类', '甲一'], ''), ['', ['baolong_2', 'huazhiyu_10']], '首选来源被屏蔽时，同来源下一条可用图优先');
blockedIds.add(entries[7].id);
assert.deepEqual(runUpdateFilter(['单画师词典', '甲类', '甲一'], ''), ['', ['baolong_2', 'baolong_1']], '同来源全部屏蔽后再用后续来源');
blockedIds.add(entries[1].id);
assert.deepEqual(runUpdateFilter(['单画师词典', '甲类', '甲一'], ''), ['', ['baolong_2']], '全部来源屏蔽后才移除画师');
blockedIds.clear();

// 正式根更换代表图后，可选 c 仍指向原规范身份；评分样图不随首图改变。
const reordered = structuredClone(data);
Object.assign(reordered.artists[0], { e: 'huazhiyu_9', c: 'baolong_1', x: ['huazhiyu_10', 'baolong_1'] });
globalThis.fetch = async () => ({ ok: true, json: async () => reordered });
const reorderedStyle = await import('../site/assets/app/artist-style.js?reordered-canonical');
const reorderedBook = { id: codex.id, tree, entries: entries.map(item => ({ ...item })) };
assert.equal(await reorderedStyle.attachArtistStyles(reorderedBook), true);
const reorderedArtist = reorderedStyle.artistByIndex(0);
assert.equal(reorderedArtist.entryId, entries[0].id);
assert.equal(reorderedArtist.canonicalEntryId, entries[1].id, '规范标题来源独立于首选例图');
assert.deepEqual([reorderedArtist.rank, reorderedArtist.rankSampleId], [1, entries[1].id], '评估图和名次保持原 MayRain 口径');
assert.equal(reorderedBook.entries[0].styleArtistTitle, entries[1].title);
assert.equal(reorderedBook.entries[0].title, entries[0].title, '不修改原来源词条的标题');

// 无词典绑定的旧原型不能作为正式数据；缺少分片版本也拒绝使用。
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ...data, schema: 1 }) });
const legacyStyle = await import('../site/assets/app/artist-style.js?legacy-rank');
assert.equal(await legacyStyle.loadArtistStyles(), null);
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ...data, nearRevision: '' }) });
const invalidStyle = await import('../site/assets/app/artist-style.js?invalid-revision');
assert.equal(await invalidStyle.loadArtistStyles(), null);

// 独立置顶的今日画师不应把目录提前滚到它原来的画风组。
const codexUiSource = await readFile(new URL('../site/assets/app/codex-ui.js', import.meta.url), 'utf8');
const spyStart = codexUiSource.indexOf('export function updateReadingSpy()');
const spyEnd = codexUiSource.indexOf('\n/* 法典选择器的收起入口', spyStart);
assert.ok(spyStart >= 0 && spyEnd > spyStart);
const readingSpyBody = codexUiSource.slice(spyStart, spyEnd).replace('export function', 'function');
const spy = { hidden: false };
let spyResets = 0;
const spyDeps = {
  state: { codex, placements: [{ entry: entries[4], top: 0, height: 500 }], activePath: [],
    updateFilter: '', favoritesView: false, siteSearchView: false, searchPlan: { hasActiveSearch: false } },
  $: selector => selector === '#tree' ? {
    querySelector(selector) {
      assert.equal(selector, '.tree-spy', '独立今日卡不能先定位到它原来所属的目录行');
      return spy;
    },
  } : { getBoundingClientRect: () => ({ top: 0 }) },
  window: { scrollY: 0, innerHeight: 900 }, treeBranchAnimations: { size: 0 },
  spyLastIndex: 0, spyLastPathKey: '', spyLastRowKey: '', spyPointerIn: false,
  styleActive: () => true, isFeaturedEntry: entry => entry === entries[4], hasActiveSearch: () => false,
  artistPickedView: () => false,
  resetTreeSpy: () => { spyResets += 1; }, CSS: { escape: text => text },
};
new Function(...Object.keys(spyDeps), readingSpyBody + '\nupdateReadingSpy();')(...Object.values(spyDeps));
assert.equal(spy.hidden, true);
assert.equal(spyResets, 1, '离开独立今日卡后，从普通目录重新定位');
let searchRowQueries = 0;
spyDeps.hasActiveSearch = () => true;
spyDeps.$ = selector => selector === '#tree' ? {
  querySelector(selector) {
    if (selector === '.tree-spy') return spy;
    searchRowQueries += 1;
    return null;
  },
} : { getBoundingClientRect: () => ({ top: 0 }) };
new Function(...Object.keys(spyDeps), readingSpyBody + '\nupdateReadingSpy();')(...Object.values(spyDeps));
assert.equal(spyResets, 1, '有搜索词或筛选时不套独立今日卡的阅读例外');
assert.ok(searchRowQueries > 0, '搜索仍按结果的实际目录定位');

console.log('artist style: PASS');
