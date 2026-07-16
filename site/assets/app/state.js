export const VIRTUAL_BUFFER_UP = 0.8;
export const VIRTUAL_BUFFER_DOWN = 1.4;
export const IMAGE_LOAD_DELAY = 90;
export const RELAYOUT_INTERVAL = 150;
export const RELAYOUT_ANIM_MS = 320;
export const DEFAULT_IMAGE_RATIO = 1.18;
export const RANDOM_RECENT_LIMIT = 20;
export const DENSITY_STORAGE_KEY = 'fadian-density';
export const DEFAULT_DENSITY = 'standard';
export const THEME_STORAGE_KEY = 'fadian-theme';
export const THEMES = [
  { id: '', name: '紫调' },
  { id: 'teal', name: '青翠' },
  { id: 'sakura', name: '樱粉' },
  { id: 'amber', name: '暖金' },
];
export const RECENT_STORAGE_KEY = 'fadian-recent';
export const LAST_BROWSE_STORAGE_KEY = 'fadian-last-browse';
export const RECENT_ENTRY_LIMIT = 18;
export const SEARCH_SCOPE_STORAGE_KEY = 'fadian-search-scope';
export const DEFAULT_SEARCH_SCOPE = 'site';
export const DENSITY_PRESETS = {
  comfort: {
    label: '舒适',
    minWidth: 290,
    gap: 16,
    bodyPadX: 13,
    bodyPadTop: 12,
    bodyPadBottom: 11,
    titleCharWidth: 14,
    titleLineHeight: 20,
    titleGap: 8,
    tagCharWidth: 7,
    tagLineHeight: 19,
    tagPaddingY: 18,
    minTagHeight: 34,
    maxTagHeight: 114,
    maxTagLines: 6,
    footGap: 9,
    footHeight: 18,
    footHeightNegative: 21,
  },
  standard: {
    label: '标准',
    minWidth: 236,
    gap: 12,
    bodyPadX: 11,
    bodyPadTop: 10,
    bodyPadBottom: 10,
    titleCharWidth: 13.5,
    titleLineHeight: 19,
    titleGap: 7,
    tagCharWidth: 6.8,
    tagLineHeight: 17.5,
    tagPaddingY: 16,
    minTagHeight: 30,
    maxTagHeight: 86,
    maxTagLines: 4,
    footGap: 7,
    footHeight: 17,
    footHeightNegative: 20,
  },
  compact: {
    label: '紧凑',
    minWidth: 176,
    gap: 8,
    bodyPadX: 7,
    bodyPadTop: 7,
    bodyPadBottom: 7,
    titleCharWidth: 12.2,
    titleLineHeight: 16,
    titleGap: 5,
    tagCharWidth: 6.2,
    tagLineHeight: 14.4,
    tagPaddingY: 10,
    minTagHeight: 22,
    maxTagHeight: 42,
    maxTagLines: 2,
    footGap: 5,
    footHeight: 15,
    footHeightNegative: 18,
  },
};
export const NSFW_STORAGE_KEY = 'fadian-nsfw-ok';
export const NSFW_LOCKED_MESSAGE = '请先在设置里开启「允许 NSFW 法典展示」，并确认成人内容提示。';
export const R18G_STORAGE_KEY = 'fadian-r18g-ok';
export const R18G_LOCKED_MESSAGE = 'R18G / 重口内容默认完全隐藏，需在设置中完成多重确认后才会显示。';

export const state = {
  codex: null,        // 当前法典数据
  browseCodex: null,  // 临时视图背后的真实当前法典
  favoritesView: false,
  siteSearchView: false,
  codexes: [],
  codexCache: new Map(),
  list: [],           // 当前过滤后的词条
  rendered: 0,        // 当前虚拟渲染数量
  placements: [],     // 虚拟瀑布流布局
  nodes: new Map(),   // index -> DOM node
  colN: 0,
  itemWidth: 0,
  activePath: [],     // 选中的目录路径
  searchReturnPath: [],
  searchHistorySessionId: '',
  query: '',
  searchPlan: null,
  searchScope: DEFAULT_SEARCH_SCOPE,
  onlyImaged: false,
  onlyFav: false,
  allowNsfw: false,
  allowR18g: false,  // R18G/重口内容默认完全隐藏，需多重确认开启
  sdMode: false,      // 复制时把 NAI 权重转成 Stable Diffusion 格式
  density: DEFAULT_DENSITY,
  favs: new Set(),    // 收藏集合，键为 codexId:entryId
  loadedImages: new Set(),
  seenAnimated: new Set(),
  recentRandomIds: [],
  recentEntries: [],
  lastBrowse: null,
  sourceNoticesShown: new Set(),
  pendingUrlState: null,
  suppressUrlSync: false,
  lightbox: {
    entry: null,
    images: [],
    index: 0,
  },
  media: {
    baseUrl: '',
    imagePrefix: 'images',
    originalPrefix: 'originals',
    localFallback: true,
  },
};

export function normalizeDensity(value) {
  return DENSITY_PRESETS[value] ? value : DEFAULT_DENSITY;
}

export function densityConfig() {
  return DENSITY_PRESETS[state.density] || DENSITY_PRESETS[DEFAULT_DENSITY];
}

export function normalizeSearchScope(value) {
  return value === 'codex' ? 'codex' : DEFAULT_SEARCH_SCOPE;
}
