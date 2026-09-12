import { state } from './state.js';
import { toast } from './feedback.js';
import { findCodexMeta } from './data.js';
import {
  atlasFavoriteStorageKeys,
  createCodexLookup,
} from './favorites-backup-core.js';
import { emitFavoritesChanged } from './favorites-backup.js';
import { addLibraryItem, libraryKeys, removeLibraryItems } from './favorites-library-core.js';
import { commitLibrary, librarySnapshot } from './favorites-library-store.js';

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

export async function saveFavs() {
  const keys = new Set(state.favs);
  const outcome = await commitLibrary(draft => {
    removeLibraryItems(draft, draft.items.filter(item => !keys.has(item.key)).map(item => item.key));
    for (const key of keys) addLibraryItem(draft, key, { codexes: state.codexes });
  });
  state.favs = new Set(libraryKeys(librarySnapshot()));
  return outcome;
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

export async function toggleFav(e, btn, options = {}) {
  const keys = favKeys(e);
  const k = keys[0];
  const outcome = await commitLibrary(draft => {
    const on = !draft.items.some(item => keys.includes(item.key));
    if (on) {
      // 快照仅为后续阶段采集；rating 不能作为访问依据，渲染仍须回源经过 access.js。
      const image = e.images?.[0];
      addLibraryItem(draft, k, {
        codexes: state.codexes,
        snap: {
          title: e.title, tags: String(e.tags || '').slice(0, 400),
          image: typeof image === 'string' ? image : (image?.file || e.image || ''),
          w: image?.w || e.w, h: image?.h || e.h, rating: e.rating,
          srcTitle: e._srcCodexTitle || ownerCodex(e)?.title || '', rev: e.assetRev,
        },
      });
    } else removeLibraryItems(draft, keys);
    return on;
  });
  if (!outcome.ok) return outcome;
  state.favs = new Set(libraryKeys(librarySnapshot()));
  emitFavoritesChanged(['atlas'], 'toggle');
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
  return outcome;
}
