import { COMMUNITY_CATEGORIES, DEFAULT_COMMUNITY_CATEGORY } from './community/constants.js';
import { loadCommunityData } from './community/api.js';
import { closeCommunityDetail, openCommunityDetail, initDetailDialog } from './community/detail.js';
import { initSubmitDialog, openSubmitDialog } from './community/submit.js';
import { state } from './community/state.js';
import { applyCommunityFilters, applyCommunityRoute, initCommunityUI, syncAfterLoad } from './community/ui.js';
import { reloadFavorites } from './community/favorites.js';
import { $ } from './community/utils.js';
import { setupFavoritesBackup, subscribeFavoritesChanges } from './app/favorites-backup.js';
import {
  configureCommunityHistory,
  initializeCommunityHistory,
  restoreCommunityHistorySnapshot,
  setCommunityRouterActions,
} from './community/router.js';

window.COMMUNITY_CATEGORIES = COMMUNITY_CATEGORIES;
window.DEFAULT_COMMUNITY_CATEGORY = DEFAULT_COMMUNITY_CATEGORY;
window.openSubmitDialog = openSubmitDialog;
window.openCommunityDetail = openCommunityDetail;
window.applyCommunityFilters = applyCommunityFilters;

let favoritesBackupBound = false;

async function loadAndRender() {
  state.loading = true;
  state.loadError = false;
  applyCommunityFilters();

  try {
    const { collection, data, entries, source } = await loadCommunityData();
    state.collection = collection;
    state.features = data.features;
    state.entries = entries;
    state.loadError = source === 'fallback' && entries.length === 0;
    $('#communityTitle').textContent = data.title || '共创广场';
    $('#communityCount').textContent = state.loadError ? '加载失败' : `${entries.length} 条投稿`;
  } catch (error) {
    console.error('共创广场加载失败', error);
    state.features = { likes: false };
    state.entries = [];
    state.loadError = true;
    $('#communityCount').textContent = '加载失败';
  } finally {
    state.loading = false;
    syncAfterLoad();
  }
}

async function init() {
  configureCommunityHistory();
  initDetailDialog();
  initSubmitDialog({ onSubmitted: () => {} });
  initCommunityUI({
    openDetail: openCommunityDetail,
    openSubmit: openSubmitDialog,
  });
  setupFavoritesBackup();
  setCommunityRouterActions({
    applyListRoute: applyCommunityRoute,
    findEntry: id => state.entries.find(entry => String(entry.id) === String(id)) || null,
    openDetail: openCommunityDetail,
    closeDetail: closeCommunityDetail,
  });
  if (!favoritesBackupBound) {
    favoritesBackupBound = true;
    subscribeFavoritesChanges('community', () => {
      reloadFavorites();
      syncAfterLoad();
    });
  }
  await loadAndRender();
  await restoreCommunityHistorySnapshot();
  initializeCommunityHistory();
}

init().catch(error => console.error('[community] initialization failed', error));
