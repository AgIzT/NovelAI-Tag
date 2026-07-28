import { safeStorageGet } from './utils.js';

export const COMMUNITY_NSFW_PREFERENCE_KEY = 'strings-nsfw';
export const SHARED_NSFW_CONFIRMATION_KEY = 'fadian-nsfw-ok';

export function hasSharedNsfwConfirmation(read = safeStorageGet) {
  return read(SHARED_NSFW_CONFIRMATION_KEY) === '1';
}

export function shouldRestoreCommunityNsfw(read = safeStorageGet) {
  return read(COMMUNITY_NSFW_PREFERENCE_KEY) === 'true'
    && hasSharedNsfwConfirmation(read);
}

export const state = {
  collection: null,
  features: { likes: false },
  entries: [],
  filtered: [],
  activeCategory: null,
  query: '',
  // 旧版 strings-nsfw 只需单击即可写入，不能把它单独当成年确认凭证。
  showNSFW: shouldRestoreCommunityNsfw(),
  onlyFavorites: safeStorageGet('community-only-favorites') === 'true',
  activeEntryId: '',
  activeImageIndex: 0,
  searchHistorySessionId: '',
  loading: true,
  loadError: false,
};

export function canShowCommunityEntry(entry, showNsfw = state.showNSFW) {
  return Boolean(entry && (!entry.nsfw || showNsfw));
}
