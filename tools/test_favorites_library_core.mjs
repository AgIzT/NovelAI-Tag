import assert from 'node:assert/strict';
import { loadFavoritesTestModules } from './favorites-library-test-loader.mjs';
const { library: core, core: v1 } = await loadFavoritesTestModules();
const {
  normalizeLibrary, migrateV1Favorites, libraryKeys, createFolder, renameFolder, deleteFolder,
  addLibraryItem, removeLibraryItems, setFolderMembership, trimLibraryToBudget,
  createLibraryBackup, parseLibraryBackup, createLibraryRestorePlan,
} = core;
const now = '2026-09-12T12:00:00.000Z';
const codexes = [{ id: 'alpha', aliases: ['old_alpha'], entryAliases: { 'alpha-1': 'alpha-set' } }, { id: 'beta' }];
const fresh = () => normalizeLibrary({ libraryId: 'test-library', updatedAt: now }, { now });
const expectCode = (code, fn) => assert.throws(fn, error => error.code === code);

const dirty = normalizeLibrary({
  libraryId: 'repair', updatedAt: now,
  folders: [
    { id: 'one', name: '  画\u0000风  ', order: -3 },
    { id: 'two', name: '文'.repeat(25), order: Infinity },
    { id: 'same-name', name: '画风', order: '1' },
    { id: '_unsorted', name: '角色', order: null },
    null,
  ],
  items: [
    { key: 'old_alpha:old_alpha-1', note: 1, addedAt: 'bad', snap: { tags: '词'.repeat(401), w: -1, h: '5' } },
    { key: 'alpha:alpha-set', note: '保留备注' },
    { key: 'future:item', addedAt: null },
  ],
  memberships: [
    { itemKey: 'old_alpha:old_alpha-1', folderId: 'same-name', addedAt: now },
    { itemKey: 'alpha:alpha-set', folderId: 'one', addedAt: now },
    { itemKey: 'missing:entry', folderId: 'one' },
  ],
}, { codexes, now });
assert.equal(dirty.folders[0].name, '画风');
assert.equal(dirty.folders[1].name.length, 20);
assert.deepEqual(dirty.folders.map(folder => folder.order), [0, 1, 2]);
assert.notEqual(dirty.folders[2].id, '_unsorted');
assert.deepEqual(libraryKeys(dirty), ['alpha:alpha-set', 'future:item']);
assert.equal(dirty.items[0].note, '保留备注');
assert.equal(dirty.items[0].addedAt, null);
assert.equal(dirty.items[0].snap.tags.length, 400);
assert.equal(dirty.items[0].snap.w, 0);
assert.deepEqual(dirty.memberships, [{ itemKey: 'alpha:alpha-set', folderId: 'one', addedAt: now }]);
assert.deepEqual(normalizeLibrary(dirty, { codexes, now }), dirty, 'schema 规范化幂等');
assert.deepEqual(normalizeLibrary({ folders: 'bad', items: {}, memberships: true }, { now }).items, []);

const doc = fresh();
const folder = createFolder(doc, '  画风 ', { id: 'styles', now });
assert.equal(folder.name, '画风');
expectCode('FOLDER_NAME_EMPTY', () => createFolder(doc, ' '));
expectCode('FOLDER_NAME_DUPLICATE', () => createFolder(doc, '画风'));
expectCode('FOLDER_NAME_LONG', () => createFolder(doc, '字'.repeat(21)));
expectCode('FOLDER_NAME_CONTROL', () => createFolder(doc, '坏\u0000名'));
createFolder(doc, '画風', { id: 'styles2', now });
renameFolder(doc, 'styles2', '角色');
expectCode('FOLDER_NAME_DUPLICATE', () => renameFolder(doc, 'styles2', '画风'));
addLibraryItem(doc, 'alpha:a', { now });
addLibraryItem(doc, 'alpha:a', { now });
addLibraryItem(doc, 'beta:b', { now });
assert.equal(doc.items.length, 2);
assert.equal(setFolderMembership(doc, ['alpha:a', 'alpha:a'], 'styles', true, { now }), 1);
assert.equal(setFolderMembership(doc, ['alpha:a'], 'styles', true, { now }), 0);
setFolderMembership(doc, ['alpha:a'], 'styles2', true, { now });
assert.equal(doc.memberships.length, 2, '一条收藏可以多归属');
expectCode('ITEM_MISSING', () => setFolderMembership(doc, ['missing:x'], 'styles', true));
const deletedFolder = deleteFolder(doc, 'styles');
assert.equal(deletedFolder.memberships.length, 1);
assert.equal(doc.items.length, 2, '删除收藏夹保留全部收藏');
assert.equal(doc.memberships[0].folderId, 'styles2');
const removed = removeLibraryItems(doc, ['alpha:a']);
assert.equal(removed.items.length, 1);
assert.equal(removed.memberships.length, 1);
assert.equal(doc.memberships.length, 0);
const full = fresh();
for (let index = 0; index < 100; index++) createFolder(full, String(index), { id: 'fd_' + index, now });
expectCode('TOO_MANY_FOLDERS', () => createFolder(full, '第101个'));
expectCode('TOO_MANY_ITEMS', () => normalizeLibrary({
  items: Array.from({ length: 30001 }, (_, index) => ({ key: 'alpha:' + index })),
}));

const migrated = migrateV1Favorites(['old_alpha:old_alpha-1', 'alpha:alpha-set', 'future:item'], { codexes, now, libraryId: 'migrated' });
assert.equal(migrated.items.length, 2);
assert.ok(migrated.items.every(item => item.addedAt === null && item.importedAt === now));
assert.deepEqual(migrated.folders, []);
assert.deepEqual(migrated.memberships, []);
assert.deepEqual(migrateV1Favorites(migrated, { codexes, now }), migrated);

const many = fresh();
for (let index = 0; index < 805; index++) addLibraryItem(many, 'alpha:' + String(index).padStart(4, '0'), {
  now: new Date(Date.parse(now) + index), snap: { title: '例图', tags: '词'.repeat(400) },
});
assert.equal(trimLibraryToBudget(many).trimmed, 5);
assert.equal(many.items.length, 805);
assert.ok(!many.items[0].snap && many.items[5].snap);
assert.equal(many.items.filter(item => item.snap).length, 800);
const reduced = trimLibraryToBudget(many, 120000);
assert.ok(reduced.trimmed > 0);
assert.ok(reduced.bytes <= 120000);
assert.equal(many.items.length, 805);
many.items[0].note = '中'.repeat(800000);
assert.equal(trimLibraryToBudget(many).overBudget, true, '超预算时只删 snap，不能删 note/items');
assert.equal(many.items.length, 805);
assert.equal(many.items[0].note.length, 800000);

const original = fresh();
const one = createFolder(original, '画风', { id: 'original_style', now });
addLibraryItem(original, 'alpha:alpha-set', { now, note: '我的备注', snap: { title: '例图', tags: '词' } });
addLibraryItem(original, 'future:entry', { now });
setFolderMembership(original, ['alpha:alpha-set'], one.id, true, { now });
const backup = createLibraryBackup({ library: original, communityIds: ['community'], codexes, exportedAt: now });
const parsed = parseLibraryBackup(JSON.stringify(backup), codexes);
assert.equal(parsed.version, 2);
assert.equal(parsed.unknownCodexCount, 1);
assert.deepEqual(parsed.favorites.community, ['community']);
assert.deepEqual(parsed.library, original, 'V2 元数据与归属 round-trip');
const oldBackup = parseLibraryBackup(v1.serializeFavoritesBackup({
  atlasKeys: ['old_alpha:old_alpha-1'], codexes, exportedAt: now,
}), codexes);
assert.equal(oldBackup.version, 1);
assert.equal(oldBackup.library.items[0].addedAt, null);
assert.deepEqual(oldBackup.library.memberships, []);

const local = fresh();
createFolder(local, '画风', { id: 'local_style', now });
addLibraryItem(local, 'alpha:alpha-set', { now });
const merge = createLibraryRestorePlan({ backup: parsed, currentLibrary: local, codexes });
assert.equal(merge.nextLibrary.folders.length, 1);
assert.equal(merge.nextLibrary.folders[0].id, 'local_style');
assert.equal(merge.nextLibrary.memberships[0].folderId, 'local_style');
assert.equal(merge.nextLibrary.items[0].note, '我的备注');
assert.equal(merge.stats.folders.duplicate, 1);
const repeat = createLibraryRestorePlan({
  backup: parsed, currentLibrary: merge.nextLibrary, currentCommunityIds: ['community'], codexes,
});
assert.equal(repeat.hasChanges, false, '重复合并不新增收藏、夹子或关系');
const replaced = createLibraryRestorePlan({ backup: parsed, currentLibrary: local, mode: 'replace', codexes });
assert.equal(replaced.nextLibrary.libraryId, local.libraryId, '导入不改变本机库身份');
const legacyReplace = createLibraryRestorePlan({ backup: oldBackup, currentLibrary: merge.nextLibrary, mode: 'replace', codexes });
const legacyRepeat = createLibraryRestorePlan({ backup: oldBackup, currentLibrary: legacyReplace.nextLibrary, mode: 'replace', codexes });
assert.equal(legacyRepeat.hasChanges, false, '重复 V1 覆盖不改导入时间');
const invalid = structuredClone(backup);
invalid.memberships[0].folderId = 'missing';
expectCode('INVALID_MEMBERSHIP', () => parseLibraryBackup(JSON.stringify(invalid), codexes));
expectCode('UNSUPPORTED_VERSION', () => parseLibraryBackup(JSON.stringify({ ...backup, version: 3 }), codexes));
expectCode('FILE_TOO_LARGE', () => parseLibraryBackup(' '.repeat(2 * 1024 * 1024 + 1)));
console.log('favorites library core: schema, CRUD, migration, budgets, V1/V2 round-trip and merge passed');
