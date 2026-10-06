import assert from 'node:assert/strict';
import { BANNER_INSERT_STORAGE_KEY, createBannerInsertChooser, findCoverCaption, matchingCoverPalette, eligibleBannerInserts } from '../site/assets/app/banner-insert-core.js';

const memory = new Map();
const storage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) };
let draws = 0;
const choose = createBannerInsertChooser({ storage, random: () => { draws++; return .7; } });
assert.equal(choose('a', ['caption', 'history', 'palette', 'index']), 'palette');
assert.equal(choose('a', ['caption', 'history', 'palette', 'index']), 'palette');
assert.equal(draws, 1, '同书筛选 / 返回不重新抽选');
const reload = createBannerInsertChooser({ storage, random: () => { throw Error('reload must not draw'); } });
assert.equal(reload('a', ['caption', 'history', 'palette', 'index']), 'palette', '刷新沿用会话选择');
assert.equal(choose('a', ['history', 'index']), 'index', '失去配色资格后退到可用候选');
assert.equal(choose('a', ['caption', 'history', 'palette', 'index']), 'index', '资格恢复不来回跳样式');
assert.equal(choose('empty', []), '');
const broken = { getItem() { throw Error('denied'); }, setItem() { throw Error('quota'); } };
assert.equal(createBannerInsertChooser({ storage: broken, random: () => 0 })('a', ['index']), 'index');
memory.set(BANNER_INSERT_STORAGE_KEY, '{bad json');
assert.equal(createBannerInsertChooser({ storage, random: () => 0 })('a', ['index']), 'index');

const codex = { id: 'merged', coverCodexId: 'legacy', cover: 'one.jpg', coverRev: 'r2', entries: [
  { id: 'wrong', title: '同名文件', image: 'one.jpg' },
  { id: 'right', title: '正确来源', assetCodexId: 'legacy', images: [{ path: 'zero.jpg' }, { path: 'one.jpg' }] },
] };
assert.equal(findCoverCaption(codex).entry.id, 'right');
assert.equal(findCoverCaption(codex).imageIndex, 1, '借用资源与多图封面打开对应图片');
assert.equal(findCoverCaption({ ...codex, cover: 'standalone.jpg' }), null);
const palette = { image: 'one.jpg', assetCodexId: 'legacy', assetRev: 'r2', colors: ['#103060', '#7a9bc1', '#f6ede7', '#F6EDE7'] };
assert.deepEqual(matchingCoverPalette(codex, palette), ['#103060', '#7a9bc1', '#f6ede7']);
assert.deepEqual(matchingCoverPalette({ ...codex, coverRev: 'r3' }, palette), [], '新封面不沿用旧配色');
assert.deepEqual(matchingCoverPalette(codex, { ...palette, assetCodexId: 'merged' }), []);
assert.deepEqual(matchingCoverPalette(codex, { ...palette, colors: ['#fff', 'red', 'url(bad)', null] }), []);
assert.deepEqual(eligibleBannerInserts({ caption: null, history: [{}, {}], colors: [], groups: [{}] }), []);
assert.deepEqual(eligibleBannerInserts({ caption: {}, history: [{}, {}, {}], colors: ['a', 'b', 'c'], groups: [{}, {}] }), ['caption', 'history', 'palette', 'index']);
console.log('PASS banner insert: conditional pool, session stability, storage fallback, cover provenance and revision');
