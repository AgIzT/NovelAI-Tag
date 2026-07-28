import { safeStorageGet } from './utils.js';
import { ADULT_CONFIRMATION_STORAGE_KEY, NSFW_STORAGE_KEY } from '../app/state.js';

export const COMMUNITY_NSFW_PREFERENCE_KEY = 'strings-nsfw';

export function hasAdultNsfwConfirmation(read = safeStorageGet) {
  return read(ADULT_CONFIRMATION_STORAGE_KEY) === '1'
    // 旧主站键为 1 证明用户走过主站确认；只允许它单向作为广场凭证。
    || read(NSFW_STORAGE_KEY) === '1';
}

export function shouldRestoreCommunityNsfw(read = safeStorageGet) {
  return read(COMMUNITY_NSFW_PREFERENCE_KEY) === 'true'
    && hasAdultNsfwConfirmation(read);
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
