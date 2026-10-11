import assert from 'node:assert/strict';
import { loadFavoritesTestModules } from './favorites-library-test-loader.mjs';

const { core, library, store, backupStore } = await loadFavoritesTestModules();
const { FAVORITES_LIBRARY_STORAGE_KEY, migrateV1Favorites, createFolder, setFolderMembership, createLibraryBackup, parseLibraryBackup, createLibraryRestorePlan } = library;
const codexes = [{ id: 'alpha', aliases: ['old_alpha'] }];
const source = migrateV1Favorites(['alpha:a', 'alpha:b'], { codexes, now: '2026-09-01T00:00:00Z' });
source.items[0].note = '人物配色';
const style = createFolder(source, '画风', { id: 'fd_source_style' });
const role = createFolder(source, '角色', { id: 'fd_source_role' });
setFolderMembership(source, ['alpha:a', 'alpha:b'], style.id, true);
setFolderMembership(source, ['alpha:a'], role.id, true);
const text = JSON.stringify(createLibraryBackup({ library: source, communityIds: ['community-source'], codexes }));
const parsed = parseLibraryBackup(text, codexes);
assert.equal(parsed.version, 2);
assert.deepEqual(parsed.library.folders, source.folders);
assert.deepEqual(parsed.library.memberships, source.memberships);
assert.equal(parsed.library.items[0].note, '人物配色');

const target = migrateV1Favorites(['alpha:a'], { codexes, now: '2026-08-01T00:00:00Z' });
const existingStyle = createFolder(target, '画风', { id: 'fd_target_style' });
const values = new Map([[FAVORITES_LIBRARY_STORAGE_KEY, JSON.stringify(target)]]);
const storage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key),
};
const libraryStore = store.createLibraryStore({ getStorage: () => storage, getLocks: () => null, eventTarget: null, getCodexes: () => codexes });
const adapter = backupStore.createFavoritesBackupStore(libraryStore);
const restored = await adapter.restore({ backup: parsed, storage, codexes });
let result = libraryStore.librarySnapshot();
assert.equal(result.libraryId, target.libraryId, '导入另一设备备份保留当前设备库身份');
assert.equal(result.folders.length, 2);
assert.equal(result.folders.find(folder => folder.name === '画风').id, existingStyle.id);
assert.equal(result.memberships.filter(member => member.folderId === existingStyle.id).length, 2, '同名夹归属映射到当前夹');
assert.equal(result.items.find(item => item.key === 'alpha:a').note, '人物配色', '重复项补回备份备注');
assert.equal(restored.plan.hasChanges, true);
const repeated = await adapter.restore({ backup: parsed, storage, codexes });
assert.equal(repeated.plan.hasChanges, false, '重复导入不产生重复或伪变化');
assert.deepEqual(libraryStore.librarySnapshot().memberships, result.memberships);

// 词条集合相同、只有分类或备注变化，仍是可恢复的备份。
const metadataOnly = parseLibraryBackup(text, codexes);
metadataOnly.library.items[0].note = '另一套配色';
metadataOnly.library.memberships = [];
const replace = createLibraryRestorePlan({ backup: metadataOnly, currentLibrary: result, currentCommunityIds: ['community-source'], mode: 'replace', codexes });
assert.equal(replace.stats.atlas.added, 0);
assert.equal(replace.stats.atlas.removed, 0);
assert.equal(replace.hasChanges, true);
await adapter.restore({ backup: metadataOnly, mode: 'replace', storage, codexes });
assert.equal(libraryStore.librarySnapshot().memberships.length, 0);
assert.equal(libraryStore.librarySnapshot().items[0].note, '另一套配色');

// V1 文件继续可恢复，新增项落未分类，保留原身份兼容规则。
const v1 = parseLibraryBackup(core.serializeFavoritesBackup({ atlasKeys: ['old_alpha:old_alpha-new'], communityIds: [], codexes }), codexes);
await adapter.restore({ backup: v1, storage, codexes });
result = libraryStore.librarySnapshot();
assert.ok(result.items.some(item => item.key === 'alpha:alpha-new' && item.addedAt === null));
assert.ok(result.memberships.every(member => member.itemKey !== 'alpha:alpha-new'));
// 备份封装超过预算时仅裁剪导出副本的快照，收藏、备注与归类原样保留。
{
  const withSnapshot = structuredClone(source);
  withSnapshot.items[0].snap = { title: '预览', tags: 'tag, '.repeat(80), image: 'x'.repeat(1200), w: 100, h: 100 };
  const withoutSnapshot = structuredClone(withSnapshot);
  delete withoutSnapshot.items[0].snap;
  const baseline = backupStore.serializeLibraryFavorites({ library: withoutSnapshot, codexes, exportedAt: '2026-09-01T00:00:00Z' });
  const budget = new TextEncoder().encode(baseline).byteLength + 20;
  const trimmed = backupStore.serializeLibraryFavorites({ library: withSnapshot, codexes, exportedAt: '2026-09-01T00:00:00Z', maxBytes: budget });
  assert.ok(new TextEncoder().encode(trimmed).byteLength <= budget);
  const restored = parseLibraryBackup(trimmed, codexes).library;
  assert.equal(restored.items.length, source.items.length);
  assert.equal(restored.items[0].note, source.items[0].note);
  assert.deepEqual(restored.memberships, source.memberships);
  assert.ok(withSnapshot.items[0].snap, '导出预算不改本地库');
  assert.throws(() => backupStore.serializeLibraryFavorites({ library: withoutSnapshot, codexes, maxBytes: 50 }), error => error.code === 'FILE_TOO_LARGE');
}
// 同一规范身份的两份非空备注在备份往返、合并及重复导入中保留；变化的日期/快照不产生新备注。
{
  const aliases = [{ id: 'alpha', entryAliases: { oldA: 'merged', oldB: 'merged' } }];
  const originals = ['第一份备注\n保留尾部空白  ', '第二份备注\n\n---\n\n正文自带分隔符'];
  const localNotes = library.normalizeLibrary({
    libraryId: 'notes-local', updatedAt: '2026-09-01T00:00:00Z', migratedFrom: 'v1', presetsSeeded: 1,
    items: [{ key: 'alpha:oldA', addedAt: '2026-08-01T00:00:00Z', note: originals[0] }],
  }, { codexes: aliases });
  const incomingNotes = library.normalizeLibrary({
    libraryId: 'notes-import', updatedAt: '2026-09-01T00:00:00Z',
    items: [{ key: 'alpha:oldB', addedAt: '2026-09-01T00:00:00Z', note: originals[1], snap: { title: '异机快照' } }],
  }, { codexes: aliases });
  const incomingBackup = parseLibraryBackup(JSON.stringify(createLibraryBackup({ library: incomingNotes, codexes: aliases })), aliases);
  const noteValues = new Map([[FAVORITES_LIBRARY_STORAGE_KEY, JSON.stringify(localNotes)]]);
  const noteStorage = {
    getItem: key => noteValues.get(key) ?? null,
    setItem: (key, value) => noteValues.set(key, String(value)),
    removeItem: key => noteValues.delete(key),
  };
  const noteStore = store.createLibraryStore({ getStorage: () => noteStorage, getLocks: () => null, eventTarget: null, getCodexes: () => aliases });
  const noteAdapter = backupStore.createFavoritesBackupStore(noteStore);
  await noteAdapter.restore({ backup: incomingBackup, storage: noteStorage, codexes: aliases });
  const merged = noteStore.librarySnapshot();
  assert.equal(merged.items.length, 1);
  assert.deepEqual(merged.items[0].noteParts, originals);
  assert.deepEqual(JSON.parse(noteStorage.getItem(FAVORITES_LIBRARY_STORAGE_KEY)).items[0].noteParts, originals);
  const roundTrip = parseLibraryBackup(backupStore.serializeLibraryFavorites({ library: merged, codexes: aliases }), aliases);
  assert.deepEqual(roundTrip.library.items[0], merged.items[0], '备份恢复包含冲突原文及其去重记录');
  incomingBackup.library.items[0].addedAt = '2026-10-01T00:00:00.000Z';
  incomingBackup.library.items[0].snap = { title: '变化的快照' };
  for (let round = 0; round < 5; round++) {
    const repeated = await noteAdapter.restore({ backup: incomingBackup, storage: noteStorage, codexes: aliases });
    assert.equal(repeated.plan.hasChanges, false, '重复导入相同原文不受备份元数据变化影响');
    assert.deepEqual(noteStore.librarySnapshot().items[0], merged.items[0]);
    const mergedAgain = createLibraryRestorePlan({ backup: roundTrip, currentLibrary: noteStore.librarySnapshot(), codexes: aliases });
    assert.equal(mergedAgain.hasChanges, false, '已合并备份不会被当作第三份原文');
  }
  assert.throws(() => backupStore.serializeLibraryFavorites({ library: merged, codexes: aliases, maxBytes: 50 }), error => error.code === 'FILE_TOO_LARGE');
  assert.deepEqual(noteStore.librarySnapshot().items[0].noteParts, originals, '备份超预算不能截掉原文');
}
console.log('favorites backup V2: all tests passed');
