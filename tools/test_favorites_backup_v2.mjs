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
console.log('favorites backup V2: all tests passed');
