import {
  CATEGORY_ALIASES,
  COMMUNITY_CATEGORIES,
  DEFAULT_COMMUNITY_CATEGORY,
} from './constants.js';
import { demoEntries } from './demo.js';
import { isLocal, normalizeImage } from './utils.js';
import { fetchDataJson } from '../data-source.js';

export function normalizeCategoryName(value) {
  const text = String(value == null ? '' : value).split('/')[0].replace(/\s+/g, ' ').trim();
  if (!text) return DEFAULT_COMMUNITY_CATEGORY;
  if (COMMUNITY_CATEGORIES.includes(text)) return text;
  const key = text.toLowerCase().replace(/\s+/g, '');
  return CATEGORY_ALIASES.get(key) || DEFAULT_COMMUNITY_CATEGORY;
}

export function normalizeCategory(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return [normalizeCategoryName(raw)];
}

export function categoriesFromEntries(entries) {
  const used = new Set((entries || []).map(entry => normalizeCategory(entry?.category)[0]));
  return COMMUNITY_CATEGORIES.filter(category => used.has(category));
}

function normalizeEntry(entry) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const rawLikeCount = Number(source.likeCount);
  return {
    ...source,
    id: source.id || '',
    title: source.title || '随手分享',
    prompt: source.prompt || '',
    negative: source.negative || '',
    comment: source.comment || '',
    submitter: source.submitter || '',
    tags: Array.isArray(source.tags) ? source.tags : [],
    category: normalizeCategory(source.category),
    nsfw: Boolean(source.nsfw),
    images: Array.isArray(source.images) ? source.images.map(normalizeImage).filter(image => image.file) : [],
    createdAt: source.createdAt || 0,
    likeCount: Number.isFinite(rawLikeCount) && rawLikeCount > 0 ? Math.floor(rawLikeCount) : 0,
    liked: Boolean(source.liked),
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function loadCommunityData() {
  const index = await fetchDataJson('strings_index.json', { cache: 'no-store' });
  const collection = (index.collections || [])[0] || { name: '共创广场', dataUrl: '/api/community', file: 'strings.json' };
  let raw = null;
  let source = 'api';

  if (collection.dataUrl) {
    try {
      raw = await fetchJson(collection.dataUrl);
    } catch (error) {
      console.warn('共创广场在线数据加载失败，回退本地空壳', error);
      source = 'fallback';
    }
  }

  if (!raw) raw = await fetchDataJson(collection.file || 'strings.json', { cache: 'no-store' });

  let entries = (raw.entries || []).map(normalizeEntry);
  if (!entries.length && isLocal()) entries = demoEntries().map(normalizeEntry);
  const data = {
    title: '共创广场',
    author: raw.author || '',
    features: { likes: Boolean(raw.features?.likes) },
    categories: categoriesFromEntries(entries),
    entries,
    imagedCount: entries.filter(entry => entry.images.length).length,
    generatedAt: raw.generatedAt || 0,
  };

  return { collection, data, entries, source };
}
