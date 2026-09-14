import assert from 'node:assert/strict';
import { loadFavoritesTestModules } from './favorites-library-test-loader.mjs';

const { core, library, store, backupStore } = await loadFavoritesTestModules();
const { ATLAS_FAVORITES_STORAGE_KEY, COMMUNITY_FAVORITES_STORAGE_KEY, createFavoritesBackup, serializeFavoritesBackup, parseFavoritesBackup } = core;
const { FAVORITES_LIBRARY_STORAGE_KEY, libraryKeys, addLibraryItem, createFolder, setFolderMembership } = library;
const codexes = [{ id: 'alpha', aliases: ['old_alpha'] }, { id: 'beta' }];
class MemoryStorage {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); this.failKey = ''; this.failReads = false; }
  getItem(key) { if (this.failReads) throw new Error('disabled'); return this.values.get(key) ?? null; }
  setItem(key, value) {
    if (key === this.failKey) { this.failKey = ''; throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); }
    this.values.set(key, String(value));
  }
  removeItem(key) { this.values.delete(key); }
}
function setup(entries) {
  const storage = new MemoryStorage(entries);
  const emitted = [];
  const libraryStore = store.createLibraryStore({ getStorage: () => storage, getLocks: () => null, eventTarget: null, getCodexes: () => codexes, emitFavoritesChanged: (...args) => emitted.push(args) });
  return { storage, emitted, libraryStore, adapter: backupStore.createFavoritesBackupStore(libraryStore) };
}
function backup(atlasKeys, communityIds = []) { return createFavoritesBackup({ atlasKeys, communityIds, codexes }); }

// V2 是唯一读取来源：旧版标签页改镜像不能被导出或救援合并重新带回来。
{
  const { storage, adapter } = setup({ [ATLAS_FAVORITES_STORAGE_KEY]: '["alpha:alpha-first"]', [COMMUNITY_FAVORITES_STORAGE_KEY]: '["community-current"]' });
  await adapter.readCurrent({ storage, codexes });
  storage.setItem(ATLAS_FAVORITES_STORAGE_KEY, '["alpha:stale-v1"]');
  const current = await adapter.readCurrent({ storage, codexes });
  assert.deepEqual(current.atlasKeys, ['alpha:alpha-first']);
  const exported = parseFavoritesBackup(serializeFavoritesBackup({ ...current, codexes }), codexes);
  assert.deepEqual(exported.favorites.atlas, [{ codexId: 'alpha', entryId: 'alpha-first' }]);
  const restored = await adapter.restore({ backup: backup(['old_alpha:old_alpha-new'], ['community-new']), storage, codexes });
  assert.deepEqual(new Set(restored.result.atlasKeys), new Set(['alpha:alpha-first', 'alpha:alpha-new']));
  assert.deepEqual(restored.result.communityIds, ['community-current', 'community-new']);
  assert.deepEqual(new Set(JSON.parse(storage.getItem(ATLAS_FAVORITES_STORAGE_KEY))), new Set(restored.result.atlasKeys));
}

// 恢复必须在锁内重读重算；预览之后另一页增加的条目、归属与共创收藏仍参与合并。
{
  const { storage, adapter, libraryStore } = setup({ [ATLAS_FAVORITES_STORAGE_KEY]: '["alpha:a"]' });
  await adapter.readCurrent({ storage, codexes });
  const other = store.createLibraryStore({ getStorage: () => storage, getLocks: () => null, eventTarget: null, getCodexes: () => codexes });
  assert.equal((await other.commitLibrary(draft => {
    addLibraryItem(draft, 'beta:b');
    const folder = createFolder(draft, '收藏测试夹', { id: 'fd_other' });
    setFolderMembership(draft, ['beta:b'], folder.id, true);
  }, { silent: true })).ok, true);
  storage.setItem(COMMUNITY_FAVORITES_STORAGE_KEY, '["community-later"]');
  const restored = await adapter.restore({ backup: backup(['alpha:c']), storage, codexes });
  assert.deepEqual(new Set(restored.result.atlasKeys), new Set(['alpha:a', 'beta:b', 'alpha:c']));
  assert.deepEqual(restored.result.communityIds, ['community-later']);
  assert.equal(libraryStore.librarySnapshot().memberships[0].folderId, 'fd_other');
  assert.equal(restored.plan.stats.atlas.current, 2);
}

// 两处持久化协调失败都必须不发布成功；社区已写、V2失败时补偿恢复社区原字节。
for (const failedKey of [COMMUNITY_FAVORITES_STORAGE_KEY, FAVORITES_LIBRARY_STORAGE_KEY]) {
  const { storage, adapter, libraryStore, emitted } = setup({ [ATLAS_FAVORITES_STORAGE_KEY]: '["alpha:before"]', [COMMUNITY_FAVORITES_STORAGE_KEY]: '[ "community-before" ]' });
  await adapter.readCurrent({ storage, codexes });
  const before = libraryStore.librarySnapshot();
  const rawLibrary = storage.getItem(FAVORITES_LIBRARY_STORAGE_KEY);
  const rawCommunity = storage.getItem(COMMUNITY_FAVORITES_STORAGE_KEY);
  const emittedBefore = emitted.length;
  storage.failKey = failedKey;
  await assert.rejects(() => adapter.restore({ backup: backup(['beta:after'], ['community-after']), storage, codexes }), error => error.code === 'STORAGE_WRITE_FAILED');
  assert.deepEqual(libraryStore.librarySnapshot(), before);
  assert.equal(storage.getItem(FAVORITES_LIBRARY_STORAGE_KEY), rawLibrary);
  assert.equal(storage.getItem(COMMUNITY_FAVORITES_STORAGE_KEY), rawCommunity);
  assert.equal(emitted.length, emittedBefore);
}

// 本地版覆盖只更新图鉴；即使社区键无法写入，也不触碰原始共创值。
{
  const { storage, adapter } = setup({ [ATLAS_FAVORITES_STORAGE_KEY]: '["alpha:before"]', [COMMUNITY_FAVORITES_STORAGE_KEY]: '[ "community-current" ]' });
  await adapter.readCurrent({ storage, codexes });
  storage.failKey = COMMUNITY_FAVORITES_STORAGE_KEY;
  const restored = await adapter.restore({ backup: backup(['beta:after'], ['unwanted']), mode: 'replace', preserveCommunity: true, storage, codexes });
  assert.deepEqual(restored.result.atlasKeys, ['beta:after']);
  assert.equal(storage.getItem(COMMUNITY_FAVORITES_STORAGE_KEY), '[ "community-current" ]');
}

console.log('favorites backup store: all tests passed');
