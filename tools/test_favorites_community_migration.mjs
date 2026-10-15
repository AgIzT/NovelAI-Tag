import assert from 'node:assert/strict';
import { loadFavoritesTestModules } from './favorites-library-test-loader.mjs';

const { core, library, store, backupStore } = await loadFavoritesTestModules();
const KEY = library.FAVORITES_LIBRARY_STORAGE_KEY;
const OLD = core.COMMUNITY_FAVORITES_STORAGE_KEY;
const codexes = [{ id: 'alpha' }, { id: 'community' }];
const now = '2026-10-13T00:00:00.000Z';
const makeLibrary = keys => ({
  ...library.migrateV1Favorites(keys, { codexes, now }), migratedFrom: 'v1', presetsSeeded: 1,
});
class Storage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); this.beforeWrite = null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.beforeWrite?.(key, value); this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
const makeStore = storage => store.createLibraryStore({
  getStorage: () => storage, getLocks: () => null, eventTarget: null,
  getCodexes: () => codexes, notify() {},
});
const keys = instance => library.libraryKeys(instance.librarySnapshot());

// 旧社区和已有 V2 同时存在：重复投稿保留备注、收藏夹关系和原加入时间。
{
  const original = makeLibrary(['alpha:a', 'community:post-a']);
  original.items[1].note = '旧备注\n保留尾部空格  ';
  const folder = library.createFolder(original, '共创收藏', { id: 'mine', now });
  library.setFolderMembership(original, ['community:post-a'], folder.id, true, { now });
  const oldRaw = '[ "post-a", "post-b", "post-a" ]';
  const storage = new Storage({ [KEY]: JSON.stringify(original), [OLD]: oldRaw });
  const first = makeStore(storage);
  assert.equal((await first.ensureLibrary()).ok, true);
  assert.deepEqual(keys(first), ['alpha:a', 'community:post-a', 'community:post-b']);
  assert.equal(first.librarySnapshot().communityMigrated, true);
  assert.deepEqual(first.librarySnapshot().items[1], original.items[1]);
  assert.deepEqual(first.librarySnapshot().memberships, original.memberships);
  assert.equal(storage.getItem(OLD), oldRaw);
  assert.equal(storage.getItem(store.COMMUNITY_MIGRATION_STORAGE_KEY), '1');
  assert.equal((await first.commitLibrary(draft => library.removeLibraryItems(draft, ['community:post-a', 'community:post-b']))).ok, true);
  const next = makeStore(storage);
  assert.equal((await next.ensureLibrary()).ok, true);
  assert.deepEqual(keys(next), ['alpha:a'], '取消后刷新不能从旧键复活');
  // 已打开的旧代码会丢掉它不认识的库字段，但不能丢掉独立迁移记账。
  const legacyPage = JSON.parse(storage.getItem(KEY));
  delete legacyPage.communityMigrated;
  storage.setItem(KEY, JSON.stringify(legacyPage));
  assert.equal((await next.ensureLibrary()).ok, true);
  assert.deepEqual(keys(next), ['alpha:a'], '旧页回写也不能重新迁入已取消项');
  assert.equal((await next.commitLibrary(draft => { draft.items[0].note = '另一项'; })).ok, true);
  assert.equal(next.librarySnapshot().communityMigrated, true, '普通保存保留迁移记账');
  const adapter = backupStore.createFavoritesBackupStore(next);
  const current = await adapter.readCurrent({ storage, codexes });
  assert.deepEqual(current.communityIds, []);
  const backup = library.parseLibraryBackup(backupStore.serializeLibraryFavorites({ ...current, codexes }), codexes);
  assert.deepEqual(library.libraryKeys(backup.library), ['alpha:a'], '备份不能带回旧键已取消项');
}

// 没有 V2 时，同一次原子迁移收下 V1 图鉴和旧社区。旧 ID 上限和含冒号的身份原样保留。
{
  const long = 'x'.repeat(256);
  const storage = new Storage({ 'fadian-favs': '["alpha:first"]', [OLD]: JSON.stringify(['post:part', long]) });
  const instance = makeStore(storage);
  assert.equal((await instance.ensureLibrary()).ok, true);
  assert.deepEqual(new Set(keys(instance)), new Set(['alpha:first', 'community:post:part', 'community:' + long]));
  const roundTrip = library.parseLibraryBackup(backupStore.serializeLibraryFavorites({ library: instance.librarySnapshot(), codexes }), codexes);
  assert.deepEqual(new Set(library.libraryKeys(roundTrip.library)), new Set(keys(instance)));
}

// 配额、静默丢写和信号失败都不能落下迁移完成标记，旧字节与既有库不变，重启可重试。
for (const failure of ['quota', 'readback', 'marker', 'signal']) {
  const raw = JSON.stringify(makeLibrary(['alpha:a']));
  const oldRaw = '[ "post" ]';
  const storage = new Storage({ [KEY]: raw, [OLD]: oldRaw });
  let failed = false;
  const set = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    const matches = failure === 'signal' ? key === store.LIBRARY_SIGNAL_KEY
      : failure === 'marker' ? key === store.COMMUNITY_MIGRATION_STORAGE_KEY : key === KEY;
    if (matches && !failed) {
      failed = true;
      if (failure === 'readback') return;
      throw Object.assign(new Error('storage full'), { name: 'QuotaExceededError' });
    }
    set(key, value);
  };
  const instance = makeStore(storage);
  assert.equal((await instance.ensureLibrary({ silent: true })).ok, false);
  assert.equal(storage.getItem(KEY), raw);
  assert.equal(storage.getItem(OLD), oldRaw);
  assert.equal(storage.getItem(store.COMMUNITY_MIGRATION_STORAGE_KEY), null, '失败不能提前记成已迁移');
  assert.deepEqual(keys(instance), ['alpha:a']);
  assert.equal((await makeStore(storage).ensureLibrary()).ok, true);
  assert.equal(JSON.parse(storage.getItem(KEY)).communityMigrated, true);
}

// 跨版本记账本身无法回退时，保留已迁入的完整库，避免假完成标记使收藏丢失。
{
  const original = JSON.stringify(makeLibrary(['alpha:a']));
  const storage = new Storage({ [KEY]: original, [OLD]: '["post"]' });
  let failed = false;
  storage.beforeWrite = key => {
    if (key === store.LIBRARY_SIGNAL_KEY && !failed) { failed = true; throw new Error('signal failed'); }
  };
  const remove = storage.removeItem.bind(storage);
  storage.removeItem = key => {
    if (key === store.COMMUNITY_MIGRATION_STORAGE_KEY) throw new Error('marker rollback denied');
    remove(key);
  };
  const instance = makeStore(storage);
  assert.equal((await instance.ensureLibrary({ silent: true })).reason, 'rollback');
  assert.equal(storage.getItem(OLD), '["post"]');
  assert.ok(JSON.parse(storage.getItem(KEY)).items.some(item => item.key === 'community:post'), '标记回退失败必须保留完整迁移收藏');
  assert.deepEqual(keys(instance), ['alpha:a'], '部分失败不发布成功内存');
  const restarted = makeStore(storage);
  assert.equal((await restarted.ensureLibrary()).ok, true);
  assert.deepEqual(keys(restarted), ['alpha:a', 'community:post']);
}

// 坏旧键不被当作空收藏迁移，原始恢复包包含所有旧字节。
for (const raw of ['{broken', '{}', '[null]', '["ok",""]']) {
  const storage = new Storage({ [OLD]: raw, 'fadian-favs': '["alpha:a"]' });
  const instance = makeStore(storage);
  assert.equal((await instance.ensureLibrary({ silent: true })).reason, 'corrupt');
  assert.equal(storage.getItem(KEY), null);
  assert.equal(storage.getItem(OLD), raw);
  const recovered = backupStore.readFavoritesRecovery({ storage, codexes });
  assert.equal(recovered.recovery.communityRaw, raw);
  assert.equal(recovered.recovery.atlasRaw, '["alpha:a"]');
  assert.equal(recovered.recovery.libraryRaw, null);
}

// V1 / 旧 V2 的 community 数组都进入同一个书目；混合格式重复身份不损失 V2 元数据。
for (const version of [1, 2]) {
  const raw = core.createFavoritesBackup({ atlasKeys: ['alpha:a', 'community:post'], communityIds: ['post', 'second'], codexes, exportedAt: now });
  raw.version = version;
  if (version === 2) {
    Object.assign(raw, { libraryId: 'old-backup', updatedAt: now,
      folders: [{ id: 'saved', name: '我的夹', order: 0, createdAt: now }],
      memberships: [{ itemKey: 'community:post', folderId: 'saved', addedAt: now }],
    });
    raw.favorites.atlas.find(item => item.codexId === 'community').note = '投稿备注';
  }
  const parsed = library.parseLibraryBackup(JSON.stringify(raw), codexes);
  assert.deepEqual(new Set(library.libraryKeys(parsed.library)), new Set(['alpha:a', 'community:post', 'community:second']));
  const storage = new Storage({ [OLD]: '["current"]' });
  const instance = makeStore(storage);
  const adapter = backupStore.createFavoritesBackupStore(instance);
  await adapter.readCurrent({ storage, codexes });
  await adapter.restore({ backup: parsed, storage, codexes });
  assert.deepEqual(new Set(keys(instance)), new Set(['community:current', 'alpha:a', 'community:post', 'community:second']));
  if (version === 2) {
    assert.equal(instance.librarySnapshot().items.find(item => item.key === 'community:post').note, '投稿备注');
    assert.ok(instance.librarySnapshot().memberships.some(item => item.itemKey === 'community:post' && item.folderId === 'saved'));
  }
  assert.equal((await adapter.restore({ backup: parsed, storage, codexes })).plan.hasChanges, false);
  await adapter.restore({ backup: parsed, mode: 'replace', storage, codexes });
  assert.ok(!keys(instance).includes('community:current'));
  assert.equal(instance.librarySnapshot().communityMigrated, true);
  assert.equal(storage.getItem(OLD), '["current"]');
  const fresh = makeStore(storage);
  await fresh.ensureLibrary();
  assert.ok(!keys(fresh).includes('community:current'), '覆盖恢复也不能复活旧收藏');
  const cleared = library.parseLibraryBackup(core.serializeFavoritesBackup({ codexes }), codexes);
  await adapter.restore({ backup: cleared, mode: 'replace', storage, codexes });
  const oldPageAfterClear = JSON.parse(storage.getItem(KEY));
  delete oldPageAfterClear.communityMigrated;
  storage.setItem(KEY, JSON.stringify(oldPageAfterClear));
  const afterClear = makeStore(storage);
  await afterClear.ensureLibrary();
  assert.deepEqual(keys(afterClear), [], '覆盖清空后的旧页回写不能绕过迁移隔离');
}

// 主键和标记之间中断：内嵌标记仍封死旧键，下一次初始化补齐独立记账。
{
  const current = { ...makeLibrary([]), communityMigrated: true };
  const storage = new Storage({ [KEY]: JSON.stringify(current), [OLD]: '["removed"]' });
  const instance = makeStore(storage);
  await instance.ensureLibrary();
  assert.deepEqual(keys(instance), []);
  assert.equal(storage.getItem(store.COMMUNITY_MIGRATION_STORAGE_KEY), '1');
  await instance.commitLibrary(draft => library.addLibraryItem(draft, 'alpha:later'));
  assert.equal(storage.getItem(store.COMMUNITY_MIGRATION_STORAGE_KEY), '1');
  assert.deepEqual(keys(instance), ['alpha:later']);
}

console.log('favorites community migration: all tests passed');
