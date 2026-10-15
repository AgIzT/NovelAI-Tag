import {
  COMMUNITY_FAVORITES_STORAGE_KEY,
  ATLAS_FAVORITES_STORAGE_KEY,
  FAVORITES_BACKUP_LIMITS,
  FavoritesBackupError,
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
    lock: '收藏未保存：另一个标签页正在修改，重试一次',
    quota: '收藏未保存：浏览器存储已满。在「浏览记录」里清空最近浏览，或在中转站清空「成品记录」后重试',
    storage: '收藏未保存：浏览器不允许本站保存数据，在浏览器设置里允许后重试',
    stale: '当前收藏数据已改变，重新检查备份后再恢复。',
    corrupt: '当前收藏数据无法读取，先导出原始数据再恢复。',
    rollback: '收藏写入失败，且无法完整恢复原数据；重新导出当前收藏进行核对。',
  };
  return new FavoritesBackupError(code, messages[result.reason] || '收藏未保存，重新打开「收藏备份与恢复」后重试。', { cause: result.error, reason: result.reason });
}

function stableJson(value) {
  return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

// 只比较覆盖会删除或替换的旧对象；同数量换身份、改备注和改归类都需要重新确认。
// 顶层更新时间不属于损失对象，保留下来的相同对象也不使确认过期。
export function createReplaceReview({ plan, currentLibrary } = {}) {
  const replaced = (current, next, identity) => {
    const retained = new Map(next.map(item => [identity(item), stableJson(item)]));
    return current.filter(item => retained.get(identity(item)) !== stableJson(item))
      .sort((a, b) => identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0);
  };
  const nextCommunity = new Set(plan.next.community);
  return stableJson({
    items: replaced(currentLibrary.items, plan.nextLibrary.items, item => item.key),
    folders: replaced(currentLibrary.folders, plan.nextLibrary.folders, folder => folder.id),
    memberships: replaced(currentLibrary.memberships, plan.nextLibrary.memberships,
      member => JSON.stringify([member.itemKey, member.folderId])),
    community: plan.current.community.filter(id => !nextCommunity.has(id)).sort(),
  });
}

export function createFavoritesBackupStore(store = defaultStore) {
  const readCurrent = async ({ storage, codexes = [] } = {}) => {
    const ready = await store.ensureLibrary({ silent: true, codexes });
    if (!ready.ok) throw restoreError(ready);
    const library = store.librarySnapshot();
    return { communityIds: [], skippedCount: 0, atlasKeys: libraryKeys(library), library };
  };

  const restore = async ({ backup, mode = 'merge', storage, codexes = [], preserveCommunity = false,
    expectedCorruptRaw, expectedReplaceReview } = {}) => {
    if (expectedCorruptRaw !== undefined && mode !== 'replace') {
      throw new FavoritesBackupError('INVALID_MODE', '当前收藏数据无法读取，只能选择覆盖恢复。');
    }
    let plan;
    let current;
    const committed = await store.commitLibrary(draft => {
      current = { communityIds: [], skippedCount: 0, atlasKeys: libraryKeys(draft), library: JSON.parse(JSON.stringify(draft)) };
      // 预览后可能已有另一标签页写入；拿锁后的 draft 才是恢复计划的当前值。
      plan = createLibraryRestorePlan({ backup, currentLibrary: draft, mode, codexes, preserveCommunity });
      if (mode === 'replace' && expectedReplaceReview !== undefined
          && expectedReplaceReview !== createReplaceReview({ plan, currentLibrary: draft })) {
        throw new FavoritesBackupError('REPLACE_PLAN_CHANGED',
          '当前收藏有变化，覆盖范围已更新，检查后再确认一次。', { current, plan });
      }
      for (const key of Object.keys(draft)) delete draft[key];
      Object.assign(draft, plan.nextLibrary);
    }, {
      changed: 'all', silent: true, codexes,
      ...(expectedCorruptRaw === undefined ? {} : { replaceCorrupt: true, expectedCorruptRaw }),
      // 旧键保留原字节供故障恢复；新库的迁移标记保证它不会复活已取消的收藏。
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
    return {
      recovery: {
        format: 'novelai-tag-favorites-recovery', version: 1,
        exportedAt: new Date().toISOString(), libraryRaw,
        atlasRaw: storage.getItem(ATLAS_FAVORITES_STORAGE_KEY),
        communityRaw: storage.getItem(COMMUNITY_FAVORITES_STORAGE_KEY),
      },
      communityIds: [], skippedCount: 0,
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
    if (!budget.trimmed) throw new FavoritesBackupError('FILE_TOO_LARGE', '收藏备份超过 2 MB，无法导出。取消一部分收藏后重试。');
  }
}
