import assert from 'node:assert/strict';
import { loadFavoritesTestModules } from './favorites-library-test-loader.mjs';

const { core, library, store, backupStore } = await loadFavoritesTestModules();
const originalWarn = console.warn;
console.warn = () => {};
const codexes = [{ id: 'alpha' }];
const timestamp = '2026-10-01T00:00:00.000Z';
const make = keys => ({ ...library.migrateV1Favorites(keys, { codexes, now: timestamp }), migratedFrom: 'v1', presetsSeeded: 1 });
const makeBackup = (value, communityIds = []) => library.parseLibraryBackup(JSON.stringify(
  library.createLibraryBackup({ library: value, communityIds, codexes, exportedAt: timestamp })), codexes);
class Storage {
  constructor(value, communityIds) {
    this.values = new Map([
      [library.FAVORITES_LIBRARY_STORAGE_KEY, typeof value === 'string' ? value : JSON.stringify(value)],
      [core.COMMUNITY_FAVORITES_STORAGE_KEY, JSON.stringify(communityIds)],
    ]);
  }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
async function setup(value, communityIds = [], locks = null) {
  const storage = new Storage(value, communityIds);
  const emitted = [];
  const libraryStore = store.createLibraryStore({ getStorage: () => storage, getLocks: () => locks,
    eventTarget: null, getCodexes: () => codexes, emitFavoritesChanged: (...args) => emitted.push(args) });
  const adapter = backupStore.createFavoritesBackupStore(libraryStore);
  const current = typeof value === 'string'
    ? backupStore.readFavoritesRecovery({ storage, codexes })
    : await adapter.readCurrent({ storage, codexes });
  return { storage, emitted, libraryStore, adapter, current };
}
function confirmation(current, backup, preserveCommunity = false) {
  const plan = library.createLibraryRestorePlan({ backup, currentLibrary: current.library,
    currentCommunityIds: current.communityIds, mode: 'replace', codexes, preserveCommunity });
  return { plan, review: backupStore.createReplaceReview({ plan, currentLibrary: current.library }) };
}
async function rejectStale(ctx, backup, review, extra = {}) {
  const beforeDisk = [...ctx.storage.values];
  const beforeMemory = ctx.libraryStore.librarySnapshot();
  const beforeEvents = ctx.emitted.length;
  let refusal;
  await assert.rejects(() => ctx.adapter.restore({ backup, mode: 'replace', storage: ctx.storage,
    codexes, expectedReplaceReview: review, ...extra }), error => {
    refusal = error;
    return error.code === 'REPLACE_PLAN_CHANGED';
  });
  assert.deepEqual([...ctx.storage.values], beforeDisk, '过期确认不能写盘、镜像或信号');
  assert.deepEqual(ctx.libraryStore.librarySnapshot(), beforeMemory, '拒写不能发布新内存');
  assert.equal(ctx.emitted.length, beforeEvents, '拒写不能广播恢复成功');
  assert.ok(refusal.details.current.library);
  assert.equal(refusal.details.plan.mode, 'replace');
  return refusal.details;
}
async function otherCommit(ctx, mutate) {
  const other = store.createLibraryStore({ getStorage: () => ctx.storage, getLocks: () => null,
    eventTarget: null, getCodexes: () => codexes });
  assert.equal((await other.commitLibrary(mutate, { silent: true })).ok, true);
}

// 一条删除预览后，另一页新增收藏；拒写后新计划必须再经过明确确认。
{
  const ctx = await setup(make(['alpha:keep', 'alpha:old']));
  const backup = makeBackup(make(['alpha:keep']));
  const { plan, review } = confirmation(ctx.current, backup);
  assert.equal(plan.stats.atlas.removed, 1);
  await otherCommit(ctx, draft => library.addLibraryItem(draft, 'alpha:new'));
  const latest = await rejectStale(ctx, backup, review);
  assert.equal(latest.plan.stats.atlas.removed, 2);
  const renewed = confirmation(latest.current, backup);
  const result = await ctx.adapter.restore({ backup, mode: 'replace', storage: ctx.storage, codexes,
    expectedReplaceReview: renewed.review });
  assert.deepEqual(result.result.atlasKeys, ['alpha:keep']);
}

// 计数相同但删除对象换了身份，不能复用旧确认。
{
  const ctx = await setup(make(['alpha:keep', 'alpha:old']));
  const backup = makeBackup(make(['alpha:keep']));
  const { review } = confirmation(ctx.current, backup);
  await otherCommit(ctx, draft => {
    library.removeLibraryItems(draft, ['alpha:old']);
    library.addLibraryItem(draft, 'alpha:replacement');
  });
  const latest = await rejectStale(ctx, backup, review);
  assert.equal(latest.plan.stats.atlas.removed, 1);
}

// 原身份还在，但将被覆盖的备注、夹子或归类改变，也需要重看计划。
for (const change of ['note', 'folder', 'membership']) {
  const value = make(['alpha:keep']);
  value.items[0].note = '确认前原文';
  const folder = library.createFolder(value, '保留夹', { id: 'fd_keep', now: timestamp });
  const incoming = structuredClone(value);
  incoming.items[0].note = '备份原文';
  const backup = makeBackup(incoming);
  const ctx = await setup(value);
  const { review } = confirmation(ctx.current, backup);
  await otherCommit(ctx, draft => {
    if (change === 'note') draft.items[0].note = '确认后新原文';
    if (change === 'folder') draft.folders[0].name = '确认后新夹名';
    if (change === 'membership') library.setFolderMembership(draft, ['alpha:keep'], folder.id, true, { now: timestamp });
  });
  await rejectStale(ctx, backup, review);
}

// 收藏夹与归类的删除数相同，也不能把新的身份算作已经确认过的旧对象。
for (const change of ['folder-identity', 'membership-identity']) {
  const value = make(['alpha:keep', 'alpha:keep2']);
  const folder = library.createFolder(value, '旧夹', { id: 'fd_old', now: timestamp });
  library.setFolderMembership(value, ['alpha:keep'], folder.id, true, { now: timestamp });
  const incoming = structuredClone(value);
  incoming.memberships = [];
  if (change === 'folder-identity') incoming.folders = [];
  const backup = makeBackup(incoming);
  const ctx = await setup(value);
  const { review } = confirmation(ctx.current, backup);
  await otherCommit(ctx, draft => {
    if (change === 'folder-identity') {
      draft.folders[0].id = 'fd_replacement';
      draft.memberships[0].folderId = 'fd_replacement';
    } else draft.memberships[0].itemKey = 'alpha:keep2';
  });
  await rejectStale(ctx, backup, review);
}

// 共创收藏删除集合也要精确比对，含等数换身份。
for (const ids of [['community-old', 'community-new'], ['community-replacement']]) {
  const ctx = await setup(make(['alpha:keep']), ['community-old']);
  const backup = makeBackup(make(['alpha:keep']));
  const { review } = confirmation(ctx.current, backup);
  await otherCommit(ctx, draft => {
    library.removeLibraryItems(draft, draft.items.filter(item => item.key.startsWith('community:')).map(item => item.key));
    ids.forEach(id => library.addLibraryItem(draft, 'community:' + id));
  });
  await rejectStale(ctx, backup, review);
}

// 已点击确认、排队等待锁时发生改动，校验必须留在真正持锁后的重算路径。
{
  let release;
  let entered;
  const queued = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const locks = { held: false, async request(name, options, callback) {
    if (this.held) { entered(); await gate; }
    return callback();
  } };
  const ctx = await setup(make(['alpha:keep', 'alpha:old']), [], locks);
  const backup = makeBackup(make(['alpha:keep']));
  const { review } = confirmation(ctx.current, backup);
  locks.held = true;
  const saving = ctx.adapter.restore({ backup, mode: 'replace', storage: ctx.storage, codexes,
    expectedReplaceReview: review });
  await queued;
  const next = JSON.parse(ctx.storage.getItem(library.FAVORITES_LIBRARY_STORAGE_KEY));
  library.addLibraryItem(next, 'alpha:queued-new');
  ctx.storage.setItem(library.FAVORITES_LIBRARY_STORAGE_KEY, JSON.stringify(next));
  const before = ctx.storage.getItem(library.FAVORITES_LIBRARY_STORAGE_KEY);
  release();
  await assert.rejects(saving, error => error.code === 'REPLACE_PLAN_CHANGED');
  assert.equal(ctx.storage.getItem(library.FAVORITES_LIBRARY_STORAGE_KEY), before);
}

// 不影响损失对象的并发更新仍可用：V1覆盖保留幸存项的新备注及日期。
{
  const ctx = await setup(make(['alpha:keep', 'alpha:old']));
  const backup = library.parseLibraryBackup(core.serializeFavoritesBackup({ atlasKeys: ['alpha:keep'], codexes }), codexes);
  const { review } = confirmation(ctx.current, backup);
  await otherCommit(ctx, draft => { draft.items.find(item => item.key === 'alpha:keep').note = '应保留的新备注'; });
  await ctx.adapter.restore({ backup, mode: 'replace', storage: ctx.storage, codexes, expectedReplaceReview: review });
  assert.equal(ctx.libraryStore.librarySnapshot().items[0].note, '应保留的新备注');
}

// 本地版不覆盖共创，其并发变化既不能使确认失效，也不能被副写覆盖。
{
  const ctx = await setup(make(['alpha:keep', 'alpha:old']), ['community-old']);
  const backup = makeBackup(make(['alpha:keep']));
  const { review } = confirmation(ctx.current, backup, true);
  ctx.storage.setItem(core.COMMUNITY_FAVORITES_STORAGE_KEY, '[ "community-new" ]');
  await ctx.adapter.restore({ backup, mode: 'replace', storage: ctx.storage, codexes,
    expectedReplaceReview: review, preserveCommunity: true });
  assert.equal(ctx.storage.getItem(core.COMMUNITY_FAVORITES_STORAGE_KEY), '[ "community-new" ]');
}

// 损坏库恢复仍按精确原文字节挡住改变；旧共创键保留原文且不参与覆盖。
{
  const ctx = await setup('{original-broken', ['community-old']);
  const backup = makeBackup(make(['alpha:recovered']));
  const { review } = confirmation(ctx.current, backup);
  ctx.storage.setItem(core.COMMUNITY_FAVORITES_STORAGE_KEY, '["community-new"]');
  ctx.storage.setItem(library.FAVORITES_LIBRARY_STORAGE_KEY, '{new-broken');
  const before = [...ctx.storage.values];
  await assert.rejects(() => ctx.adapter.restore({ backup, mode: 'replace', storage: ctx.storage, codexes,
    expectedReplaceReview: review, expectedCorruptRaw: '{original-broken' }), error => error.details?.reason === 'stale');
  assert.deepEqual([...ctx.storage.values], before);
}

console.warn = originalWarn;
console.log('favorites replace confirmation: all tests passed');
