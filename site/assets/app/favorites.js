import { state } from './state.js';
import { toast } from './feedback.js';
import { findCodexMeta } from './data.js';
import {
  ATLAS_FAVORITES_STORAGE_KEY,
  atlasFavoriteStorageKeys,
  createCodexLookup,
} from './favorites-backup-core.js';

const favoriteActions = { applyFilter: () => {}, refreshFavoritesView: () => {} };
let codexLookupSource = null;
let codexLookup = null;
let deferredFavoritesViewRefresh = false;

export function setFavoritesActions(actions = {}) {
  Object.assign(favoriteActions, actions);
}

/* 收藏键始终挂在词条的真实法典下；全部收藏视图里的词条带 _srcCodexId 标记，
   照它回溯正主；普通浏览时词条就属于当前法典。 */
function ownerCodex(e) {
  return (e?._srcCodexId && findCodexMeta(e._srcCodexId)) || state.codex;
}

function favoriteCodexLookup() {
  if (codexLookupSource !== state.codexes) {
    codexLookupSource = state.codexes;
    codexLookup = createCodexLookup(state.codexes);
  }
  return codexLookup;
}

export function favKeys(e, codex = ownerCodex(e)) {
  return atlasFavoriteStorageKeys(
    { codexId: codex.id, entryId: e.id },
    favoriteCodexLookup(),
  );
}

export function favKey(e) { return favKeys(e)[0]; }
export function isFav(e) { return favKeys(e).some(key => state.favs.has(key)); }

export function saveFavs() {
  try {
    localStorage.setItem(ATLAS_FAVORITES_STORAGE_KEY, JSON.stringify([...state.favs]));
  } catch (error) {
    console.warn('[favorites] 无法保存收藏', error);
  }
}

export function setFavoriteButtonState(btn, on) {
  if (!btn) return;
  btn.textContent = on ? '★' : '☆';
  btn.classList.toggle('on', on);
  btn.title = on ? '取消收藏' : '收藏';
  btn.setAttribute('aria-label', on ? '取消收藏' : '收藏');
  btn.setAttribute('aria-pressed', String(on));
}

function sameFavoriteEntry(a, b) {
  if (!a || !b) return false;
  try {
    return favKey(a) === favKey(b);
  } catch {
    return false;
  }
}

function syncRenderedFavoriteButtons(e, on) {
  if (!(state.nodes instanceof Map) || !Array.isArray(state.list)) return;
  for (const [index, node] of state.nodes) {
    if (!sameFavoriteEntry(state.list[index], e)) continue;
    setFavoriteButtonState(node?.querySelector?.('.fav-btn'), on);
  }
}

/* 收藏墙灯箱中先只更新星标，保留当前合成词条以支持立即反悔；灯箱关闭时
   再统一重建背景列表，避免“取消后词条永久从合成 codex 消失”而无法重新收藏。 */
export function flushDeferredFavoritesViewRefresh(options = { transition: 'filter' }) {
  if (!deferredFavoritesViewRefresh) return false;
  deferredFavoritesViewRefresh = false;
  if (state.favoritesView) favoriteActions.refreshFavoritesView(options);
  return true;
}

export function toggleFav(e, btn, options = {}) {
  const keys = favKeys(e);
  const k = keys[0];
  if (isFav(e)) keys.forEach(key => state.favs.delete(key));
  else state.favs.add(k);
  saveFavs();
  const on = isFav(e);
  setFavoriteButtonState(btn, on);
  syncRenderedFavoriteButtons(e, on);
  if (state.favoritesView) {
    if (options.deferViewRefresh) deferredFavoritesViewRefresh = true;
    else {
      deferredFavoritesViewRefresh = false;
      favoriteActions.refreshFavoritesView({ transition: 'filter' });
    }
  }
  toast(on ? `已收藏：${e.title}` : `已取消收藏：${e.title}`);
}
