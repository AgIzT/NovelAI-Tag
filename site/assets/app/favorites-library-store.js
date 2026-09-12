/* 收藏库唯一写入口。视图能力与法典索引由组合根注入，禁止反向 import 视图。 */
import { toast } from './feedback.js';
import { ATLAS_FAVORITES_STORAGE_KEY, COMMUNITY_FAVORITES_STORAGE_KEY, readStoredFavorites } from './favorites-backup-core.js';
import {
  FAVORITES_LIBRARY_STORAGE_KEY, FAVORITES_LIBRARY_FORMAT, FAVORITES_LIBRARY_LIMITS,
  FavoritesLibraryError, canonicalLibraryKey, libraryKeys,
  migrateV1Favorites, newLibraryId, normalizeLibrary, trimLibraryToBudget,
} from './favorites-library-core.js';

export const LIBRARY_STORAGE_KEY = FAVORITES_LIBRARY_STORAGE_KEY;
export const LIBRARY_LOCK_KEY = FAVORITES_LIBRARY_STORAGE_KEY + ':lock';
export const LIBRARY_SIGNAL_KEY = FAVORITES_LIBRARY_STORAGE_KEY + ':signal';
const LOCK_TTL = 2000;
const LOCK_WAIT = 48;

function isQuotaError(error) {
  return error?.name === 'QuotaExceededError' || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error?.code === 22 || error?.code === 1014;
}
function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}
function validDocument(raw, codexes) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new FavoritesLibraryError('CORRUPT', '收藏数据无法读取，先导出备份再恢复。'); }
  if (!value || value.format !== FAVORITES_LIBRARY_FORMAT || value.version !== 2
      || typeof value.libraryId !== 'string' || !value.libraryId
      || !Array.isArray(value.items) || !Array.isArray(value.folders) || !Array.isArray(value.memberships)) {
    throw new FavoritesLibraryError('CORRUPT', '收藏数据无法读取，先导出备份再恢复。');
  }
  // 身份错误不能由 normalize 的容错悄悄删掉后写回。脏字段可修复，收藏本身必须保留。
  for (const item of value.items) {
    if (!item || typeof item !== 'object') throw new FavoritesLibraryError('CORRUPT', '收藏数据无法读取，先导出备份再恢复。');
    try { canonicalLibraryKey(item.key, codexes); } catch {
      throw new FavoritesLibraryError('CORRUPT', '收藏数据无法读取，先导出备份再恢复。');
    }
  }
  return normalizeLibrary(value, { codexes });
}

export function createLibraryStore({
  getStorage = () => globalThis.localStorage,
  getLocks = () => globalThis.navigator?.locks,
  eventTarget = globalThis.window,
  getCodexes = () => [],
  emitFavoritesChanged = () => {},
  openBackup = () => {},
  notify = toast,
} = {}) {
  let current = null;
  let initialized = false;
  let bound = false;
  let sequence = 0;
  const origin = newLibraryId();
  const listeners = new Set();
  const actions = { getCodexes, emitFavoritesChanged, openBackup };

  function setLibraryStoreActions(next = {}) { Object.assign(actions, next); }
  function codexIndex(options = {}) {
    return options.codexes || actions.getCodexes() || [];
  }
  function storageAccess() {
    try {
      const storage = getStorage();
      return storage?.getItem && storage?.setItem && storage?.removeItem
        ? { ok: true, storage } : { ok: false, reason: 'storage' };
    } catch (error) { return { ok: false, reason: 'storage', error }; }
  }
  function notifySafely(...args) {
    try { notify(...args); } catch (error) { console.warn('[favorites-library] 提示未显示', error); }
  }
  function reportFailure(transaction) {
    const { reason, error } = transaction;
    if (reason === 'quota') {
      notifySafely('收藏没能保存：浏览器存储已满', '!', {
        label: '备份并清理', onClick: () => actions.openBackup(),
      });
    } else if (reason === 'lock') {
      notifySafely('收藏没能保存，另一个标签页正在修改。重试一次。', '!');
    } else if (reason === 'mutator') {
      notifySafely('收藏这次操作没能完成，重试一次。', '!');
    } else if (reason === 'corrupt') {
      notifySafely('收藏数据无法读取，先导出备份再恢复。', '!', {
        label: '备份与恢复', onClick: () => actions.openBackup(),
      });
    } else if (reason === 'rollback') {
      notifySafely('收藏恢复未完成，打开备份与恢复检查当前内容。', '!', {
        label: '备份与恢复', onClick: () => actions.openBackup(),
      });
    } else if (reason === 'validation' && error?.message) {
      notifySafely(error.message, '!');
    } else {
      notifySafely('收藏没能保存：浏览器禁止了本站的本地存储', '!');
    }
  }
  function publish(meta) {
    for (const listener of listeners) {
      try { listener(current, meta); } catch (error) { console.warn('[favorites-library] 订阅者出错', error); }
    }
  }
  function adopt(next, meta) {
    current = freeze(next);
    publish(meta);
  }
  function readV1(storage, codexes) {
    // 收藏库只迁移 atlas。社区条目仍由原有模块拥有，社区坏数据不应阻断 atlas。
    const atlasOnly = {
      getItem: key => key === ATLAS_FAVORITES_STORAGE_KEY ? storage.getItem(key) : null,
      setItem: () => {},
    };
    return migrateV1Favorites(readStoredFavorites(atlasOnly, codexes).atlasKeys, { codexes });
  }
  function librarySnapshot() {
    if (current) return current;
    const access = storageAccess();
    const codexes = codexIndex();
    try {
      if (access.ok) {
        const raw = access.storage.getItem(FAVORITES_LIBRARY_STORAGE_KEY);
        if (raw !== null) {
          current = validDocument(raw, codexes);
          initialized = true;
        }
        else if (!initialized) current = readV1(access.storage, codexes);
      }
    } catch (error) { console.warn('[favorites-library] 收藏读取失败', error); }
    current = freeze(current || normalizeLibrary(null, { codexes }));
    return current;
  }
  // 与 relay 相同的旧浏览器兜底：localStorage 的读写不是原子互斥；
  // 真正的跨页并发保证来自下方 Web Locks，这把短锁只降低碰撞概率。
  function withStorageLock(storage, callback) {
    const token = newLibraryId();
    const deadline = Date.now() + LOCK_WAIT;
    let acquired = false;
    try {
      do {
        const now = Date.now();
        let holder;
        try { holder = JSON.parse(storage.getItem(LIBRARY_LOCK_KEY) || 'null'); } catch { holder = null; }
        const expiresAt = Number(holder?.expiresAt);
        const stale = !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + LOCK_TTL * 2;
        if (!holder?.token || stale) {
          storage.setItem(LIBRARY_LOCK_KEY, JSON.stringify({ token, expiresAt: now + LOCK_TTL }));
          acquired = JSON.parse(storage.getItem(LIBRARY_LOCK_KEY) || 'null')?.token === token;
        }
      } while (!acquired && Date.now() < deadline);
      return acquired ? callback(storage) : { ok: false, reason: 'lock' };
    } catch (error) {
      return { ok: false, reason: isQuotaError(error) ? 'quota' : 'storage', error };
    } finally {
      if (acquired) {
        try {
          if (JSON.parse(storage.getItem(LIBRARY_LOCK_KEY) || 'null')?.token === token) storage.removeItem(LIBRARY_LOCK_KEY);
        } catch { /* 释放失败交给 TTL，不能把已成功提交改判失败。 */ }
      }
    }
  }
  async function withLock(callback) {
    const access = storageAccess();
    if (!access.ok) return access;
    let locks;
    try { locks = getLocks(); } catch { locks = null; }
    if (typeof locks?.request !== 'function') return withStorageLock(access.storage, callback);
    let started = false;
    try {
      return await locks.request(LIBRARY_LOCK_KEY, { mode: 'exclusive' }, () => {
        started = true;
        return callback(access.storage);
      });
    } catch (error) {
      // 锁服务拒绝可降级；callback 已运行的异常不可重放，否则一个动作可能执行两遍。
      if (started) return { ok: false, reason: 'mutator', error };
      console.warn('[favorites-library] Web Locks 不可用，退回同步短锁', error);
      return withStorageLock(access.storage, callback);
    }
  }
  function restoreWrites(storage, previous) {
    const rollbackErrors = [];
    for (const [key, raw] of [...previous].reverse()) {
      try {
        if (storage.getItem(key) === raw) continue;
        if (raw === null) storage.removeItem(key);
        else storage.setItem(key, raw);
        if (storage.getItem(key) !== raw) throw new Error('rollback readback mismatch');
      } catch (error) { rollbackErrors.push({ key, error }); }
    }
    return rollbackErrors;
  }
  function writeVerified(storage, key, value) {
    storage.setItem(key, value);
    if (storage.getItem(key) !== value) throw new Error('storage readback mismatch');
  }
  function writeTransaction(storage, normalized, { companionWrites, migration = false } = {}) {
    // 完成标记与完整文档属于同一份原子 setItem 字节，回读成功后才发布内存。
    if (migration) normalized.migratedFrom = 'v1';
    const budget = trimLibraryToBudget(normalized);
    if (budget.overBudget) return { ok: false, reason: 'quota' };
    const previous = [];
    try {
      const writes = typeof companionWrites === 'function' ? companionWrites(normalized) : companionWrites || [];
      if (!Array.isArray(writes)) throw new FavoritesLibraryError('COMPANION_WRITES', '收藏恢复没能完成，重试一次。');
      for (const write of writes) {
        if (write?.key !== COMMUNITY_FAVORITES_STORAGE_KEY || typeof write.value !== 'string') {
          throw new FavoritesLibraryError('COMPANION_WRITES', '收藏恢复没能完成，重试一次。');
        }
        previous.push([write.key, storage.getItem(write.key)]);
        writeVerified(storage, write.key, write.value);
      }
      previous.push([FAVORITES_LIBRARY_STORAGE_KEY, storage.getItem(FAVORITES_LIBRARY_STORAGE_KEY)]);
      writeVerified(storage, FAVORITES_LIBRARY_STORAGE_KEY, JSON.stringify(normalized));
      return { ok: true, next: normalized, trimmed: budget.trimmed };
    } catch (error) {
      const rollbackErrors = restoreWrites(storage, previous);
      return {
        ok: false,
        reason: rollbackErrors.length ? 'rollback' : isQuotaError(error) ? 'quota'
          : error instanceof FavoritesLibraryError ? 'validation' : 'storage',
        error, rollbackErrors,
      };
    }
  }
  function mirrorAndAnnounce(storage, next, changed) {
    try { storage.setItem(ATLAS_FAVORITES_STORAGE_KEY, JSON.stringify(libraryKeys(next))); } catch (error) {
      console.warn('[favorites-library] 旧版镜像写入失败', error);
    }
    // 成功后才发信号。数据 storage 事件自己触发重读，信号只是提示，不是另一份真相。
    try { storage.setItem(LIBRARY_SIGNAL_KEY, JSON.stringify({ changed, rev: origin + '-' + ++sequence })); } catch {}
    try { actions.emitFavoritesChanged(['atlas'], 'library'); } catch (error) {
      console.warn('[favorites-library] 变更事件未发出', error);
    }
  }
  function transactionRead(storage, codexes) {
    try {
      const raw = storage.getItem(FAVORITES_LIBRARY_STORAGE_KEY);
      if (raw !== null) {
        const next = validDocument(raw, codexes);
        // 兼容早期未标记 V2，只补标记，绝不重读旧镜像。
        return { ok: true, next, migration: next.migratedFrom !== 'v1' };
      }
      // 此页面已经采用过 V2 后，删除主键不能使旧镜像复活。
      return { ok: true, next: initialized ? normalizeLibrary({
        libraryId: current?.libraryId, items: [], folders: [], memberships: [],
      }, { codexes }) : readV1(storage, codexes), migration: !initialized };
    } catch (error) {
      return { ok: false, reason: error instanceof FavoritesLibraryError ? 'corrupt' : 'storage', error };
    }
  }
  async function ensureLibrary(options = {}) {
    const codexes = codexIndex(options);
    // 快照先建立，只用于迁移失败时继续显示 V1；绝不将这个旧快照作为写入依据。
    librarySnapshot();
    const transaction = await withLock(storage => {
      const read = transactionRead(storage, codexes);
      if (!read.ok) return read;
      if (!read.migration) return { ok: true, next: read.next, storage, migrated: false };
      const saved = writeTransaction(storage, read.next, { migration: true });
      return { ...saved, storage, migrated: saved.ok };
    });
    if (!transaction.ok) {
      if (!options.silent) reportFailure(transaction);
      return { ...transaction, snapshot: current };
    }
    initialized = true;
    adopt(transaction.next, { changed: 'all', source: transaction.migrated ? 'migration' : 'load' });
    if (transaction.migrated) mirrorAndAnnounce(transaction.storage, transaction.next, 'all');
    return { ok: true, snapshot: current, migrated: transaction.migrated };
  }
  async function commitLibrary(mutator, options = {}) {
    const { changed = 'all', silent = false, companionWrites } = options;
    const codexes = codexIndex(options);
    librarySnapshot();
    const transaction = await withLock(storage => {
      const read = transactionRead(storage, codexes);
      if (!read.ok) return read;
      let result;
      try {
        result = mutator(read.next);
        if (result && typeof result.then === 'function') {
          // 同步事务不能容纳 await；否则短锁会在 mutator 完成前释放。
          Promise.resolve(result).catch(() => {});
          throw new TypeError('commitLibrary mutator must be synchronous');
        }
      } catch (error) {
        return { ok: false, reason: error instanceof FavoritesLibraryError ? 'validation' : 'mutator', error };
      }
      let normalized;
      try {
        read.next.updatedAt = new Date().toISOString();
        normalized = normalizeLibrary(read.next, { codexes });
      } catch (error) { return { ok: false, reason: 'validation', error, result }; }
      return {
        ...writeTransaction(storage, normalized, { companionWrites, migration: read.migration }),
        result, storage,
      };
    });
    if (!transaction.ok) {
      if (!silent) reportFailure(transaction);
      return { ok: false, reason: transaction.reason, result: transaction.result,
        error: transaction.error, rollbackErrors: transaction.rollbackErrors };
    }
    initialized = true;
    adopt(transaction.next, { changed, source: 'local' });
    mirrorAndAnnounce(transaction.storage, transaction.next, changed);
    return { ok: true, result: transaction.result };
  }
  function subscribeLibrary(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function reloadFromStorage(source) {
    const access = storageAccess();
    if (!access.ok) return;
    const read = transactionRead(access.storage, codexIndex());
    if (!read.ok) { reportFailure(read); return; }
    if (read.migration) return;
    initialized = true;
    adopt(read.next, { changed: 'all', source });
  }
  function setupLibraryStore() {
    if (bound || !eventTarget?.addEventListener) return;
    bound = true;
    eventTarget.addEventListener('storage', event => {
      const access = storageAccess();
      if (!access.ok || event.storageArea !== access.storage) return;
      if (event.key === ATLAS_FAVORITES_STORAGE_KEY) {
        if (initialized) console.info('[favorites-library] 忽略旧版标签页收藏镜像变更');
        return;
      }
      if (event.key !== null && event.key !== FAVORITES_LIBRARY_STORAGE_KEY) return;
      reloadFromStorage('storage');
    });
    eventTarget.addEventListener('pageshow', event => {
      if (event?.persisted) reloadFromStorage('pageshow');
    });
  }
  return { setLibraryStoreActions, ensureLibrary, librarySnapshot, commitLibrary, subscribeLibrary, setupLibraryStore };
}

const store = createLibraryStore();
export const setLibraryStoreActions = store.setLibraryStoreActions;
export const ensureLibrary = store.ensureLibrary;
export const librarySnapshot = store.librarySnapshot;
export const commitLibrary = store.commitLibrary;
export const subscribeLibrary = store.subscribeLibrary;
export const setupLibraryStore = store.setupLibraryStore;
