import assert from 'node:assert/strict';
import { loadFavoritesTestModules } from './favorites-library-test-loader.mjs';

const { library, store } = await loadFavoritesTestModules();
const { FAVORITES_LIBRARY_STORAGE_KEY: KEY, createFolder, createLibraryBackup, parseLibraryBackup } = library;
const codexes = [{ id: 'alpha', entryAliases: { oldA: 'merged', oldB: 'merged' } }];
const originals = ['first distinct note\n原文保留  ', 'second distinct note\n\n---\n\n原文自带分隔符'];
const rawLibrary = notes => JSON.stringify({
  format: library.FAVORITES_LIBRARY_FORMAT, version: 2, libraryId: 'note-conflict-store',
  updatedAt: '2026-10-11T00:00:00.000Z', migratedFrom: 'v1', presetsSeeded: 1,
  folders: [], memberships: [],
  items: notes.map((note, index) => ({ key: index ? 'alpha:oldB' : 'alpha:oldA', note, addedAt: null })),
});
function make(raw) {
  const values = new Map([[KEY, raw]]);
  const writes = [];
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { writes.push(key); values.set(key, String(value)); },
    removeItem: key => values.delete(key),
  };
  const instance = store.createLibraryStore({
    getStorage: () => storage, getLocks: () => null, getCodexes: () => codexes,
    eventTarget: null, notify() {},
  });
  return { ...instance, storage, writes };
}

const initialRaw = rawLibrary(originals);
const normal = make(initialRaw);
assert.equal((await normal.ensureLibrary()).ok, true);
assert.equal(normal.storage.getItem(KEY), initialRaw, '纯读取仍不重写旧数据');
assert.deepEqual(normal.librarySnapshot().items[0].noteParts, originals);
assert.equal((await normal.commitLibrary(next => createFolder(next, '普通提交', { id: 'notes-folder' }))).ok, true);
const persisted = JSON.parse(normal.storage.getItem(KEY));
assert.equal(persisted.items.length, 1);
assert.deepEqual(persisted.items[0].noteParts, originals, '新建收藏夹的普通提交同时保存冲突原文');
for (const note of originals) assert.ok(persisted.items[0].note.includes(note));
for (let round = 0; round < 6; round++) {
  assert.equal((await normal.commitLibrary(() => {})).ok, true);
  assert.deepEqual(JSON.parse(normal.storage.getItem(KEY)).items[0], persisted.items[0], '重复普通提交不重复拼接');
}
const restarted = make(normal.storage.getItem(KEY));
assert.equal((await restarted.ensureLibrary()).ok, true);
assert.deepEqual(restarted.librarySnapshot().items[0], persisted.items[0], '重启归一保留双方原文');
const parsed = parseLibraryBackup(JSON.stringify(createLibraryBackup({ library: restarted.librarySnapshot(), codexes })), codexes);
assert.deepEqual(parsed.library.items[0], persisted.items[0]);

// 原文仍在旧文档预算内，冲突记录导致新文档超限：拒写，不能靠截 note 让普通动作假成功。
const largeNotes = ['A'.repeat(600000), 'B'.repeat(600000)];
const largeRaw = rawLibrary(largeNotes);
assert.ok(new TextEncoder().encode(largeRaw).length < library.FAVORITES_LIBRARY_LIMITS.maxBytes);
const oversized = make(largeRaw);
assert.equal((await oversized.ensureLibrary()).ok, true);
const before = oversized.librarySnapshot();
oversized.writes.length = 0;
const rejected = await oversized.commitLibrary(next => createFolder(next, '不能截备注', { id: 'over-budget' }));
assert.equal(rejected.ok, false);
assert.equal(rejected.reason, 'quota');
assert.equal(oversized.storage.getItem(KEY), largeRaw, '预算不足保留完整旧字节');
assert.equal(oversized.librarySnapshot(), before, '失败保持原内存快照');
assert.deepEqual(oversized.librarySnapshot().items[0].noteParts, largeNotes);
assert.ok(!oversized.writes.includes(KEY), '超预算在主写前失败');
console.log('favorites note conflicts: ordinary commit, reload, backup round-trip, repeat stability and over-budget refusal passed');
