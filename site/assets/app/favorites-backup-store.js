import {
  COMMUNITY_FAVORITES_STORAGE_KEY,
  FavoritesBackupError,
  readStoredFavorites,
} from './favorites-backup-core.js';
import {
  createLibraryRestorePlan,
  libraryKeys,
} from './favorites-library-core.js';
import * as defaultStore from './favorites-library-store.js';

function restoreError(result) {
  if (result.error instanceof FavoritesBackupError) return result.error;
  const code = result.reason === 'rollback' ? 'STORAGE_ROLLBACK_FAILED' : 'STORAGE_WRITE_FAILED';
  const messages = {
    lock: '收藏没能保存，另一个标签页正在修改。重试一次。',
    quota: '收藏没能保存：浏览器存储已满',
    storage: '收藏没能保存：浏览器禁止了本站的本地存储',
    rollback: '收藏写入失败，且无法完整恢复原数据；重新导出当前收藏进行核对。',
  };
  return new FavoritesBackupError(code, messages[result.reason] || '收藏没能保存，重新打开备份面板后重试。', { cause: result.error, reason: result.reason });
}

// 已迁移后只从 V2 读取图鉴收藏；旧 core 仅负责共创收藏的既有容错与校验。
function readCommunity(storage, codexes) {
  return readStoredFavorites({
    getItem: key => key === COMMUNITY_FAVORITES_STORAGE_KEY ? storage.getItem(key) : null,
    setItem: (key, value) => storage.setItem(key, value),
  }, codexes);
}

export function createFavoritesBackupStore(store = defaultStore) {
  const readCurrent = async ({ storage = globalThis.localStorage, codexes = [] } = {}) => {
    const ready = await store.ensureLibrary({ silent: true, codexes });
    if (!ready.ok) throw restoreError(ready);
    const current = readCommunity(storage, codexes);
    const library = store.librarySnapshot();
    return { ...current, atlasKeys: libraryKeys(library), library };
  };

  const restore = async ({ backup, mode = 'merge', storage = globalThis.localStorage, codexes = [], preserveCommunity = false } = {}) => {
    let plan;
    let current;
    const committed = await store.commitLibrary(draft => {
      current = { ...readCommunity(storage, codexes), atlasKeys: libraryKeys(draft), library: JSON.parse(JSON.stringify(draft)) };
      const incoming = preserveCommunity
        ? { ...backup, favorites: { ...backup.favorites, community: current.communityIds } }
        : backup;
      // 预览后可能已有另一标签页写入；拿锁后的 draft 才是恢复计划的当前值。
      plan = createLibraryRestorePlan({ backup: incoming, currentLibrary: draft, currentCommunityIds: current.communityIds, mode, codexes });
      for (const key of Object.keys(draft)) delete draft[key];
      Object.assign(draft, plan.nextLibrary);
    }, {
      changed: 'all', silent: true, codexes,
      companionWrites: () => preserveCommunity ? [] : [{
        key: COMMUNITY_FAVORITES_STORAGE_KEY,
        value: JSON.stringify(plan.next.community),
      }],
    });
    if (!committed.ok) throw restoreError(committed);
    return { current, plan, result: { atlasKeys: plan.next.atlas.map(item => item.codexId + ':' + item.entryId), communityIds: plan.next.community } };
  };
  return { readCurrent, restore };
}

const backupStore = createFavoritesBackupStore();
export const readLibraryFavorites = backupStore.readCurrent;
export const restoreLibraryFavorites = backupStore.restore;
