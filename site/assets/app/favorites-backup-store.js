import {
  COMMUNITY_FAVORITES_STORAGE_KEY,
  FAVORITES_BACKUP_LIMITS,
  FavoritesBackupError,
  readStoredFavorites,
} from './favorites-backup-core.js';
import {
  FAVORITES_LIBRARY_STORAGE_KEY,
  FavoritesLibraryError,
  createLibraryBackup,
  createLibraryRestorePlan,
  normalizeLibrary,
  trimLibraryToBudget,
  libraryKeys,
} from './favorites-library-core.js';
import * as defaultStore from './favorites-library-store.js';

function restoreError(result) {
  if (result.error instanceof FavoritesBackupError || result.error instanceof FavoritesLibraryError) return result.error;
  const code = result.reason === 'rollback' ? 'STORAGE_ROLLBACK_FAILED' : 'STORAGE_WRITE_FAILED';
  const messages = {
    lock: '收藏没能保存，另一个标签页正在修改。重试一次。',
    quota: '收藏没能保存：浏览器存储已满',
    storage: '收藏没能保存：浏览器禁止了本站的本地存储',
    stale: '当前收藏数据已改变，重新检查备份后再恢复。',
    corrupt: '当前收藏数据无法读取，先导出原始数据再恢复。',
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
  const readCurrent = async ({ storage, codexes = [] } = {}) => {
    const ready = await store.ensureLibrary({ silent: true, codexes });
    if (!ready.ok) throw restoreError(ready);
    const current = readCommunity(storage || browserStorage(), codexes);
    const library = store.librarySnapshot();
    return { ...current, atlasKeys: libraryKeys(library), library };
  };

  const restore = async ({ backup, mode = 'merge', storage, codexes = [], preserveCommunity = false, expectedCorruptRaw } = {}) => {
    if (expectedCorruptRaw !== undefined && mode !== 'replace') {
      throw new FavoritesBackupError('INVALID_MODE', '当前收藏数据无法读取，只能选择覆盖恢复。');
    }
    let plan;
    let current;
    const committed = await store.commitLibrary(draft => {
      current = { ...readCommunity(storage || browserStorage(), codexes), atlasKeys: libraryKeys(draft), library: JSON.parse(JSON.stringify(draft)) };
      const incoming = preserveCommunity
        ? { ...backup, favorites: { ...backup.favorites, community: current.communityIds } }
        : backup;
      // 预览后可能已有另一标签页写入；拿锁后的 draft 才是恢复计划的当前值。
      plan = createLibraryRestorePlan({ backup: incoming, currentLibrary: draft, currentCommunityIds: current.communityIds, mode, codexes });
      for (const key of Object.keys(draft)) delete draft[key];
      Object.assign(draft, plan.nextLibrary);
    }, {
      changed: 'all', silent: true, codexes,
      ...(expectedCorruptRaw === undefined ? {} : { replaceCorrupt: true, expectedCorruptRaw }),
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

function browserStorage() {
  try { return globalThis.localStorage; } catch (error) {
    throw restoreError({ reason: 'storage', error });
  }
}

// 恢复包保留不可解析的原字符串；它不是普通收藏备份，导入时不得当成空库。
export function readFavoritesRecovery({ storage = browserStorage(), codexes = [] } = {}) {
  try {
    const libraryRaw = storage.getItem(FAVORITES_LIBRARY_STORAGE_KEY);
    if (typeof libraryRaw !== 'string') throw new Error('missing library');
    return {
      recovery: {
        format: 'novelai-tag-favorites-recovery', version: 1,
        exportedAt: new Date().toISOString(), libraryRaw,
        communityRaw: storage.getItem(COMMUNITY_FAVORITES_STORAGE_KEY),
      },
      ...readCommunity(storage, codexes),
      atlasKeys: [], library: normalizeLibrary(null, { codexes }),
    };
  } catch (error) { throw restoreError({ reason: 'storage', error }); }
}

export function serializeLibraryFavorites({ library, communityIds = [], codexes = [], exportedAt = new Date(), maxBytes = FAVORITES_BACKUP_LIMITS.maxFileBytes } = {}) {
  const copy = normalizeLibrary(library, { codexes });
  const encode = value => new TextEncoder().encode(value).byteLength;
  for (;;) {
    const json = JSON.stringify(createLibraryBackup({ library: copy, communityIds, codexes, exportedAt }));
    const size = encode(json);
    if (size <= maxBytes) return json;
    // 库正文达预算后，备份封装与共创标识仍会占空间；只裁剪导出副本的展示快照。
    const budget = trimLibraryToBudget(copy, Math.max(0, encode(JSON.stringify(copy)) - (size - maxBytes) - 64));
    if (!budget.trimmed) throw new FavoritesBackupError('FILE_TOO_LARGE', '收藏备份超过 2 MiB，无法导出。');
  }
}
