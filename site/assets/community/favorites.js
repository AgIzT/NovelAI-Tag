import { COMMUNITY_FAVORITES_STORAGE_KEY } from '../app/favorites-backup-core.js';
import { FAVORITES_LIBRARY_STORAGE_KEY } from '../app/favorites-library-core.js';
import { createStorageCoordinator, writeStorageTransaction } from '../app/storage-coordinator.js';

const LOCK_KEY = FAVORITES_LIBRARY_STORAGE_KEY + ':lock';
const SIGNAL_KEY = FAVORITES_LIBRARY_STORAGE_KEY + ':signal';

export function favoriteKey(entry) {
  if (entry?.id) return String(entry.id);
  const category = entry?.category?.[0] || '';
  const title = entry?.title || '';
  const prompt = String(entry?.prompt || '').slice(0, 80);
  return `${category}:${title}:${prompt}`;
}

export function createCommunityFavoritesStore({
  getStorage = () => globalThis.localStorage,
  getLocks = () => globalThis.navigator?.locks,
  eventTarget = globalThis.window,
} = {}) {
  let favorites = new Set();
  let issue = null;
  let sequence = 0;
  const pending = new Map();
  // 社区星标与收藏备份的社区副写共用锁和传播屏障，星标操作不写主图鉴收藏库。
  const coordinator = createStorageCoordinator({ lockKey: LOCK_KEY, signalKey: SIGNAL_KEY, getStorage, getLocks, eventTarget });
  function read(storage) {
    try {
      const raw = storage.getItem(COMMUNITY_FAVORITES_STORAGE_KEY);
      let values;
      try { values = raw === null ? [] : JSON.parse(raw); }
      catch (error) { return { ok: false, reason: 'corrupt', error }; }
      if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) return { ok: false, reason: 'corrupt' };
      return { ok: true, next: new Set(values) };
    } catch (error) { return { ok: false, reason: 'storage', error }; }
  }
  function reloadFavorites() {
    let result;
    try { result = read(getStorage()); } catch (error) { result = { ok: false, reason: 'storage', error }; }
    issue = result.ok ? null : result;
    if (result.ok) favorites = result.next;
    return new Set(favorites);
  }
  function isFavorite(entry) { return favorites.has(favoriteKey(entry)); }
  function toggleFavorite(entry) {
    const key = favoriteKey(entry);
    if (pending.has(key)) return pending.get(key);
    const active = !favorites.has(key);
    const operation = coordinator.run((storage, fence) => {
      const latest = read(storage);
      if (!latest.ok) return latest;
      if (active) latest.next.add(key);
      else latest.next.delete(key);
      const saved = writeStorageTransaction(storage, [
        { key: COMMUNITY_FAVORITES_STORAGE_KEY, value: JSON.stringify([...latest.next]) },
        { key: SIGNAL_KEY, value: JSON.stringify({
          changed: 'community', rev: 'community-' + Date.now() + '-' + ++sequence,
          ...(fence ? { epoch: fence.epoch, nonce: fence.nonce } : {}),
        }) },
      ]);
      return saved.ok ? { ok: true, written: true, next: latest.next, active } : saved;
    }).then(result => {
      issue = result.ok ? null : result;
      if (result.ok) favorites = result.next;
      return result.ok ? { ok: true, active: result.active } : result;
    }).finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  }
  function favoriteCountForEntries(entries) { return (entries || []).filter(isFavorite).length; }
  eventTarget?.addEventListener?.('storage', event => {
    let storage;
    try { storage = getStorage(); } catch { return; }
    if (event.storageArea !== storage || (event.key !== null && event.key !== COMMUNITY_FAVORITES_STORAGE_KEY)) return;
    if (event.key === null || event.newValue === null) coordinator.release();
    reloadFavorites();
  });
  reloadFavorites();
  return { reloadFavorites, isFavorite, toggleFavorite, favoriteCountForEntries, getFavoritesIssue: () => issue };
}

const store = createCommunityFavoritesStore();
export const reloadFavorites = store.reloadFavorites;
export const isFavorite = store.isFavorite;
export const toggleFavorite = store.toggleFavorite;
export const favoriteCountForEntries = store.favoriteCountForEntries;
export const getFavoritesIssue = store.getFavoritesIssue;
