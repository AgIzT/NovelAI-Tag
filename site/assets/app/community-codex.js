import { COMMUNITY_CATEGORIES, DEFAULT_COMMUNITY_CATEGORY, CATEGORY_ALIASES, STRINGS_R2_BASE } from '../community/constants.js';

export const COMMUNITY_CODEX_ID = 'community';
export const COMMUNITY_REFRESH_MS = 30_000;
export const COMMUNITY_META = Object.freeze({
  id: COMMUNITY_CODEX_ID, type: 'pack', title: '共创法典', selectorTitle: '共创法典',
  author: '社区共创', version: '', hasOriginal: true, nsfw: false,
  entryCount: 0, imagedCount: 0, dataSource: 'community',
});

// 这是在线书，不生成 community.json，也不把审核状态冻结进 R2 data release。
export function withCommunityCodex(codexes, { localEdition = false } = {}) {
  const books = Array.isArray(codexes) ? codexes : [];
  if (localEdition) return books.filter(book => book.id !== COMMUNITY_CODEX_ID);
  const existing = books.find(book => book.id === COMMUNITY_CODEX_ID);
  const meta = { ...existing, ...COMMUNITY_META };
  return existing ? books.map(book => book === existing ? meta : book) : [...books, meta];
}

function categoryFor(value) {
  const raw = String((Array.isArray(value) ? value[0] : value) || '').split('/')[0].trim();
  return COMMUNITY_CATEGORIES.includes(raw) ? raw
    : CATEGORY_ALIASES.get(raw.toLowerCase().replace(/\s+/g, '')) || DEFAULT_COMMUNITY_CATEGORY;
}

export function communityMediaUrl(file, baseURI = globalThis.document?.baseURI || 'http://localhost/') {
  const raw = String(file || '').trim();
  if (!raw) return '';
  // API 的新投稿提供完整 URL，早期人工条目仍是 images/strings 下的文件名。
  if (/^(https?:)?\/\//i.test(raw) || raw.startsWith('/')) {
    const url = new URL(raw, baseURI);
    return /^https?:$/.test(url.protocol) ? url.href : '';
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.split('/').includes('..')) return '';
  const base = new URL(baseURI);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.protocol === 'file:';
  const path = `images/strings/${raw.split('/').map(encodeURIComponent).join('/')}`;
  return new URL(path, local ? base : `${STRINGS_R2_BASE}/`).href;
}

export function adaptCommunityCodex(raw, { baseURI } = {}) {
  const features = { likes: raw?.features?.likes === true };
  const ids = new Set();
  const entries = (Array.isArray(raw?.entries) ? raw.entries : []).flatMap(source => {
    const id = String(source?.id || '').trim();
    if (!id || ids.has(id) || (source.status && source.status !== 'approved')) return [];
    ids.add(id);
    const images = (Array.isArray(source.images) ? source.images : []).flatMap(value => {
      const item = typeof value === 'string' ? { file: value } : value;
      const path = communityMediaUrl(item?.file, baseURI);
      if (!path) return [];
      const original = communityMediaUrl(item?.original, baseURI);
      // 不解析或采集逐图提示词；整条投稿的 prompt/negative 是唯一提示词来源。
      return [{ path, original: original || path, _hasOriginal: Boolean(original),
        width: item.width, height: item.height }];
    });
    const rating = String(source.rating || source.level || '').toLowerCase();
    const nsfw = Boolean(source.nsfw) || source.images?.some(item => item?.label === 'nsfw');
    return [{
      id, communityId: id, title: String(source.title || '随手分享'),
      path: [categoryFor(source.category)], tags: String(source.prompt || ''),
      negative: String(source.negative || ''), note: String(source.comment || ''),
      author: String(source.submitter || ''),
      rating: rating === 'r18g' ? 'r18g' : (nsfw || ['r18', 'nsfw', 'restricted'].includes(rating) ? 'nsfw' : 'safe'),
      nsfw: Boolean(nsfw), communityTags: Array.isArray(source.tags) ? source.tags.map(String) : [],
      createdAt: source.createdAt || 0, images,
      image: images[0]?.path || '', original: images[0]?._hasOriginal ? images[0].original : '',
      communityFeatures: features, likeCount: Math.max(0, Math.floor(Number(source.likeCount) || 0)), liked: Boolean(source.liked),
    }];
  });
  return {
    ...COMMUNITY_META, entries, entryCount: entries.length,
    imagedCount: entries.filter(entry => entry.images.length).length,
    dataStatus: '实时投稿', communityRevision: String(raw?.revision || ''),
    communityStamp: JSON.stringify(entries),
    communityFeatures: features,
  };
}

export function createCommunitySource({ fetcher = (...args) => fetch(...args), now = Date.now } = {}) {
  let cached = null;
  let loadedAt = 0;
  let pending = null;
  return {
    peek: () => cached,
    async load({ force = false } = {}) {
      if (pending) return pending;
      if (!force && cached && now() - loadedAt < COMMUNITY_REFRESH_MS) return cached;
      pending = (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12_000);
        try {
          const response = await fetcher(new URL('api/community', globalThis.document?.baseURI || 'http://localhost/').href,
            { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
          if (!response.ok) throw new Error(`共创法典加载失败 (${response.status})`);
          const raw = await response.json();
          if (!Array.isArray(raw?.entries)) throw new Error('共创法典数据格式无效');
          cached = adaptCommunityCodex(raw);
          loadedAt = now();
          return cached;
        } catch (error) {
          cached = null;
          throw error; // 下架后不能由 strings.json、旧 release 或示例数据补回。
        } finally {
          clearTimeout(timeout);
          pending = null;
        }
      })();
      return pending;
    },
  };
}

export const communitySource = createCommunitySource();
