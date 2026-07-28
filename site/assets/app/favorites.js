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

export function toggleFav(e, btn) {
  const keys = favKeys(e);
  const k = keys[0];
  if (isFav(e)) keys.forEach(key => state.favs.delete(key));
  else state.favs.add(k);
  saveFavs();
  const on = state.favs.has(k);
  if (btn) {
    btn.textContent = on ? '★' : '☆';
    btn.classList.toggle('on', on);
    btn.title = on ? '取消收藏' : '收藏';
    btn.setAttribute('aria-label', on ? '取消收藏' : '收藏');
  }
  if (state.favoritesView) favoriteActions.refreshFavoritesView({ transition: 'filter' });   // 收藏视图里取消收藏：卡片就地消失 + 目录树/计数同步刷新
  toast(on ? `已收藏：${e.title}` : `已取消收藏：${e.title}`);
}
