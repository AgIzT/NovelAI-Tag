import { COMMUNITY_FAVORITES_STORAGE_KEY } from '../app/favorites-backup-core.js';
import { safeStorageGet, safeStorageSet } from './utils.js';

let favorites = loadFavorites();

function loadFavorites() {
  try {
    const raw = JSON.parse(safeStorageGet(COMMUNITY_FAVORITES_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveFavorites() {
  safeStorageSet(COMMUNITY_FAVORITES_STORAGE_KEY, JSON.stringify([...favorites]));
}

export function reloadFavorites() {
  favorites = loadFavorites();
  return new Set(favorites);
}

export function favoriteKey(entry) {
  if (entry?.id) return String(entry.id);
  const category = entry?.category?.[0] || '';
  const title = entry?.title || '';
  const prompt = String(entry?.prompt || '').slice(0, 80);
  return `${category}:${title}:${prompt}`;
}

export function isFavorite(entry) {
  return favorites.has(favoriteKey(entry));
}

export function toggleFavorite(entry) {
  const key = favoriteKey(entry);
  if (favorites.has(key)) {
    favorites.delete(key);
    saveFavorites();
    return false;
  }
  favorites.add(key);
  saveFavorites();
  return true;
}

export function favoriteCountForEntries(entries) {
  return (entries || []).filter(isFavorite).length;
}
