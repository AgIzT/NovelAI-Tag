import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const state = {
  favoritesView: true, allowNsfw: false, allowR18g: false, favFolder: '', favSource: '', favSort: 'recent',
  codex: { entries: [] },
};
const entries = [
  { id: 'safe', _srcCodexId: 'a', title: '画风', rating: 'safe' },
  { id: 'adult', _srcCodexId: 'a', title: '限制', rating: 'r18' },
  { id: 'blocked', _srcCodexId: 'a', title: '屏蔽', rating: 'safe' },
  { id: 'legacy-b', _srcCodexId: 'b', title: '乙', rating: 'safe' },
  { id: 'legacy-a', _srcCodexId: 'b', title: '甲', rating: 'safe' },
  { id: 'newest', _srcCodexId: 'b', title: '最新', rating: 'safe' },
];
state.codex.entries = entries;
let doc = {
  folders: [{ id: 'f1', name: '画风', order: 0 }, { id: 'f2', name: '角色', order: 1 }],
  items: entries.map(entry => ({
    key: entry._srcCodexId + ':' + entry.id,
    addedAt: entry.id.startsWith('legacy') ? null : entry.id === 'newest' ? '2026-09-13T00:00:00.000Z' : '2026-09-12T00:00:00.000Z',
  })),
  memberships: [
    { itemKey: 'a:safe', folderId: 'f1' }, { itemKey: 'a:safe', folderId: 'f2' },
    { itemKey: 'a:adult', folderId: 'f1' }, { itemKey: 'a:blocked', folderId: 'f1' },
  ],
};
let blockingListener = () => {};
let blocking = { blocked: new Set(['a:blocked']) };
globalThis.__favoritesViewTest = {
  state,
  librarySnapshot: () => doc,
  subscribeContentBlocking: callback => { blockingListener = callback; },
  isContentBlocked: entry => blocking.blocked.has(entry._srcCodexId + ':' + entry.id),
  isEntryAccessBlocked: entry => entry.rating === 'r18' && !state.allowNsfw,
};
const source = (await readFile(new URL('../site/assets/app/favorites-view.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const shim = 'class FavoritesLibraryError extends Error { constructor(code, message) { super(message); this.code = code; } }\nconst createFolder = (doc, name, options) => doc.folders.push({ id: options.id, name });\nconst { state, librarySnapshot, subscribeContentBlocking, isContentBlocked, isEntryAccessBlocked } = globalThis.__favoritesViewTest;\n';
const view = await import('data:text/javascript;base64,' + Buffer.from(shim + source).toString('base64'));
const keys = doc.items.map(item => item.key);
assert.equal(view.countVisible(keys), 4, '全部计数同时经过分级和个人屏蔽');
assert.equal(view.countVisible(['a:safe', 'a:safe', 'a:adult', 'a:blocked', 'missing:key']), 1, '重复和缺失身份不计入');
assert.deepEqual(view.folderBadges(entries[0]), [{ id: 'f1', name: '画风' }, { id: 'f2', name: '角色' }]);
assert.deepEqual(view.filterFavoritesEntries(entries).map(entry => entry.id), ['newest', 'safe', 'legacy-a', 'legacy-b']);
state.favSort = 'oldest';
assert.deepEqual(view.filterFavoritesEntries(entries).map(entry => entry.id), ['safe', 'newest', 'legacy-a', 'legacy-b'], '旧收藏在两种时间排序都成块位于末尾');
state.favFolder = 'f1';
assert.deepEqual(view.filterFavoritesEntries(entries).map(entry => entry.id), ['safe']);
state.favFolder = 'f2';
assert.deepEqual(view.filterFavoritesEntries(entries).map(entry => entry.id), ['safe'], '多归属均能进入列表');
state.favFolder = '_unsorted';
assert.deepEqual(view.filterFavoritesEntries(entries).map(entry => entry.id), ['newest', 'legacy-a', 'legacy-b']);
state.favSource = 'a';
assert.deepEqual(view.filterFavoritesEntries(entries), [], '来源筛选叠加收藏夹筛选');
state.favFolder = '';
state.favSource = '';
state.allowNsfw = true;
assert.equal(view.countVisible(keys), 5, '分级开关变化使可见索引失效');
blocking = { blocked: new Set() };
blockingListener();
assert.equal(view.countVisible(keys), 6, '个人屏蔽变更使可见索引失效');
doc = { ...doc, memberships: [...doc.memberships, { itemKey: 'b:newest', folderId: 'f2' }] };
assert.deepEqual(view.folderBadges(entries[5]), [{ id: 'f2', name: '角色' }], '远端库引用变化刷新关系索引');
state.favoritesView = false;
const original = entries.slice();
assert.equal(view.filterFavoritesEntries(original), original, '非收藏视图不改变主图鉴列表');
const otherEntries = [{ id: 'safe', _srcCodexId: 'a', title: '来自缓存的收藏' }];
view.setFavoritesViewActions({ getEntries: () => otherEntries });
assert.equal(view.countVisible(keys), 1, '主图鉴整理可以读取独立回源缓存');
const afterDelete = {
  folders: [{ id: 'f1', name: '画风' }, { id: 'f2', name: '角色' }],
  items: [{ key: 'a:safe', note: '另一页重新收藏后的新备注' }, { key: 'new:item' }],
  memberships: [{ itemKey: 'a:safe', folderId: 'f2' }],
};
view.restoreFavoriteObjects(afterDelete, {
  items: [{ key: 'a:safe', note: '旧备注' }, { key: 'old:item', note: '恢复项' }],
  memberships: [{ itemKey: 'a:safe', folderId: 'f1' }, { itemKey: 'old:item', folderId: 'f1' }],
}, 'items');
assert.equal(afterDelete.items.find(item => item.key === 'a:safe').note, '另一页重新收藏后的新备注');
assert.deepEqual(afterDelete.memberships.filter(item => item.itemKey === 'a:safe'), [{ itemKey: 'a:safe', folderId: 'f2' }], '撤销不重放重新收藏后的旧归属');
assert.ok(afterDelete.items.some(item => item.key === 'new:item'), '保留同时加入的无关收藏');
assert.ok(afterDelete.items.some(item => item.key === 'old:item'), '恢复本次删除且未被重新收藏的项');
assert.throws(() => view.restoreFavoriteObjects(afterDelete, { folder: { id: 'other', name: '画风' } }, 'folder'), /撤销没能完成/, '撤销删夹不得覆盖后来创建的同名夹');
console.log('favorites view filters/counts/undo: all tests passed');
delete globalThis.__favoritesViewTest;
