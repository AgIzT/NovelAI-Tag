import { safeStorageGet } from './utils.js';

export const state = {
  collection: null,
  features: { likes: false },
  entries: [],
  filtered: [],
  activeCategory: null,
  query: '',
  showNSFW: safeStorageGet('strings-nsfw') === 'true',
  onlyFavorites: safeStorageGet('community-only-favorites') === 'true',
  activeEntryId: '',
  activeImageIndex: 0,
  searchHistorySessionId: '',
  loading: true,
  loadError: false,
};
