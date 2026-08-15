import { state } from './state.js';
import { stripTrailingSlash } from './utils.js';
import { hasEntryImage } from './media.js';
import { toast } from './feedback.js';
import { fetchDataJson, fetchDataJsonBatch, fetchDataJsonResult, getDataSource } from '../data-source.js';

const EMPTY_ABOUT = { links: [], tips: [], credits: [] };

export async function loadBootstrapData() {
  const [indexResult, mediaResult, aboutResult] = await fetchDataJsonBatch([
    { path: 'codexes.json', cache: 'no-store' },
    { path: 'media.json', cache: 'no-store', fallbackValue: {} },
    { path: 'about.json', cache: 'no-store', fallbackValue: EMPTY_ABOUT },
  ]);
  return {
    codexes: Array.isArray(indexResult.data) ? indexResult.data : [],
    media: mediaResult.data || {},
    about: aboutResult.data || EMPTY_ABOUT,
  };
}

export async function fetchCodex(meta) {
  const key = meta.id || meta.dataUrl;
  if (state.codexCache.has(key)) return state.codexCache.get(key);
  const load = (async () => {
    let data;
    let sourceMeta = meta;
    let shouldCache = true;
    try {
      if (meta.dataUrl) {
        data = await fetchJson(meta.dataUrl, 'no-store');
      } else {
        const result = await fetchDataJsonResult(`${meta.id}.json`);
        data = result.data;
        if (result.source === 'r2') {
          sourceMeta = { ...meta, dataStatus: 'R2 数据', dataRelease: result.release };
        } else if (result.source === 'proxy' || result.source === 'proxy-fallback') {
          sourceMeta = {
            ...meta,
            dataStatus: result.source === 'proxy-fallback' ? 'R2 代理回退' : 'R2 数据（Pages 代理）',
            dataRelease: result.release,
            dataNotice: result.source === 'proxy-fallback'
              ? 'R2 公网直连失败，已通过 Pages Functions 读取同一发布版本'
              : '',
            dataError: result.error?.message || String(result.error || ''),
          };
        }
      }
    } catch (ex) {
      if (!meta.fallbackDataUrl) throw ex;
      console.warn(ex);
      shouldCache = false;
      const fallbackPath = localDataPath(meta.fallbackDataUrl);
      data = fallbackPath
        ? await fetchDataJson(fallbackPath)
        : await fetchJson(meta.fallbackDataUrl, 'default');
      sourceMeta = {
        ...meta,
        sourceDataUrl: meta.dataUrl,
        dataUrl: '',
        assetBaseUrl: '',
        assetPathMode: 'codex',
        dataStatus: '发布回退数据',
        dataNotice: '外部数据源加载失败，已使用当前 R2 发布中的回退数据',
        dataError: ex.message || String(ex),
        version: meta.fallbackVersion || meta.version || data.version,
      };
    }
    return { codex: normalizeCodex(data, sourceMeta), shouldCache };
  })();
  const cached = load.then(
    ({ codex, shouldCache }) => {
      if (!shouldCache && state.codexCache.get(key) === cached) state.codexCache.delete(key);
      return codex;
    },
    error => {
      if (state.codexCache.get(key) === cached) state.codexCache.delete(key);
      throw error;
    },
  );
  state.codexCache.set(key, cached);
  return cached;
}

export async function fetchJson(url, cache = 'default') {
  return fetch(url, { cache }).then(r => {
    if (!r.ok) throw new Error(`Failed to load codex: ${url}`);
    return r.json();
  });
}

function localDataPath(url) {
  const match = String(url || '').match(/^\/?data\/(.+)$/);
  return match ? match[1] : '';
}

export function codexMatches(codex, id) {
  if (!codex || !id) return false;
  return codex.id === id || (codex.aliases || []).includes(id);
}

export function findCodexMeta(id) {
  return state.codexes.find(c => codexMatches(c, id));
}

const cleanUpdateLabel = value => String(value || '').trim().replace(/^本次/, '');

export function updateFilterDefinitions(meta = {}, codex = null) {
  const definitions = [];
  const seen = new Set();
  for (const raw of Array.isArray(meta?.updateFilters) ? meta.updateFilters : []) {
    const id = String(raw?.id || '').trim();
    const label = cleanUpdateLabel(raw?.label);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    definitions.push({ id, label, latest: raw?.latest === true });
  }
  if (!definitions.some(item => item.latest) && cleanUpdateLabel(meta?.newFilterLabel)) {
    const id = String(meta?.version || codex?.version || 'latest').trim() || 'latest';
    if (!seen.has(id)) {
      definitions.push({ id, label: cleanUpdateLabel(meta.newFilterLabel), latest: true });
    }
  }
  return definitions;
}

export function entryMatchesUpdateFilter(entry, filter) {
  if (!entry || !filter) return false;
  const batches = Array.isArray(entry.updateBatches) ? entry.updateBatches : [];
  return batches.some(value => String(value) === filter.id) || (filter.latest && entry.isNew === true);
}

export function codexUpdateFilters(codex) {
  if (!codex) return [];
  const meta = findCodexMeta(codex.id) || codex;
  return updateFilterDefinitions(meta, codex)
    .map(filter => ({
      ...filter,
      count: (codex.entries || []).filter(entry => entryMatchesUpdateFilter(entry, filter)).length,
    }))
    .filter(filter => filter.count > 0);
}

export function resolveUpdateFilter(codex, requested) {
  const value = String(requested || '').trim();
  if (!value || !codex) return '';
  const filters = codexUpdateFilters(codex);
  if (value === 'latest') return filters.find(filter => filter.latest)?.id || '';
  return filters.some(filter => filter.id === value) ? value : '';
}

export function normalizeCodex(data, meta = {}) {
  const codex = {
    ...data,
    id: meta.id || data.id,
    type: meta.type || data.type || 'codex',
    title: meta.title || data.title || data.id || meta.id,
    version: meta.version || data.version || '',
    author: meta.author || data.author || '',
    nsfw: Boolean(meta.nsfw || data.nsfw),
    assetBaseUrl: stripTrailingSlash(meta.assetBaseUrl || meta.baseUrl || data.assetBaseUrl || ''),
    assetPathMode: meta.assetPathMode || data.assetPathMode || (meta.dataUrl ? 'relative' : 'codex'),
    dataUrl: meta.dataUrl || data.dataUrl || '',
    sourceDataUrl: meta.sourceDataUrl || data.sourceDataUrl || meta.dataUrl || data.dataUrl || '',
    fallbackDataUrl: meta.fallbackDataUrl || data.fallbackDataUrl || '',
    dataStatus: meta.dataStatus || data.dataStatus || (meta.dataUrl ? '外部源' : '本地数据'),
    dataNotice: meta.dataNotice || data.dataNotice || '',
    dataError: meta.dataError || data.dataError || '',
    dataRelease: meta.dataRelease || data.dataRelease || '',
    source: meta.source || data.source || '',
    contributors: meta.contributors || data.contributors || [],
    links: meta.links || data.links || [],
    aliases: meta.aliases || data.aliases || [],
    hasOriginal: meta.hasOriginal ?? data.hasOriginal ?? false,
  };
  codex.entries = (data.entries || []).map((entry, i) => normalizeEntry(entry, codex, i));
  codex.entryCount = Number(codex.entryCount || codex.entries.length);
  codex.imagedCount = Number(codex.imagedCount || codex.entries.filter(hasEntryImage).length);
  codex.tree = data.tree || buildTreeFromEntries(codex.entries);
  return codex;
}

export function normalizeEntry(entry, codex, index) {
  const images = normalizeImageList(entry);
  const primary = images[0];
  return {
    ...entry,
    id: String(entry.id || `${codex.id}-${index + 1}`),
    title: String(entry.title || ''),
    path: Array.isArray(entry.path) ? entry.path : [],
    tags: String(entry.tags || entry.rawTags || ''),
    negative: String(entry.negative || ''),
    updateBatches: Array.isArray(entry.updateBatches)
      ? [...new Set(entry.updateBatches.map(String).filter(Boolean))]
      : [],
    characterPrompts: normalizeCharacterPrompts(entry.characterPrompts),
    note: String(entry.note || ''),
    image: entry.image || primary?.path || '',
    original: entry.original || primary?.original || primary?.path || '',
    images,
  };
}

export function normalizeCharacterPrompts(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  value.forEach((raw, index) => {
    const item = typeof raw === 'string' ? { prompt: raw } : raw;
    if (!item || typeof item !== 'object') return;
    const prompt = String(item.prompt || item.positive || item.char_caption || '').trim();
    const negative = String(item.negative || item.uc || '').trim();
    if (!prompt && !negative) return;
    out.push({
      label: String(item.label || `char${index + 1}`).trim() || `char${index + 1}`,
      prompt,
      negative,
    });
  });
  return out;
}

export function normalizeImageList(entry) {
  const out = [];
  const seen = new Set();
  const add = (image, toFront = false) => {
    if (!image) return;
    const item = typeof image === 'string' ? { path: image } : { ...image };
    const path = item.path || item.image || item.url || item.src;
    if (!path || seen.has(path)) return;
    seen.add(path);
    const hasOriginal = item._hasOriginal === undefined
      ? Boolean(item.original)
      : Boolean(item._hasOriginal);
    const normalized = {
      ...item,
      path,
      original: item.original || path,
      _hasOriginal: hasOriginal,
      rawTag: item.rawTag || item.rawTags || '',
    };
    if (toFront) out.unshift(normalized);
    else out.push(normalized);
  };
  for (const image of entry.images || []) add(image);
  if (entry.image && !seen.has(entry.image)) {
    add({
      path: entry.image,
      original: entry.original || entry.image,
      _hasOriginal: Boolean(entry.original),
    }, true);
  }
  if (entry.image && out.length) {
    const primaryIndex = out.findIndex(image => image.path === entry.image);
    if (primaryIndex > 0) out.unshift(out.splice(primaryIndex, 1)[0]);
    if (entry.original && out[0]?.path === entry.image) {
      out[0].original = entry.original;
      out[0]._hasOriginal = true;
    }
  }
  if (!out.length && entry.original) {
    add({ path: entry.original, original: entry.original, _hasOriginal: true });
  }
  return out;
}

export function buildTreeFromEntries(entries) {
  const root = new Map();
  for (const entry of entries) {
    let node = root;
    for (const name of entry.path || []) {
      if (!node.has(name)) node.set(name, { name, count: 0, children: new Map() });
      const cur = node.get(name);
      cur.count++;
      node = cur.children;
    }
  }
  const toList = map => [...map.values()].map(n => ({
    name: n.name,
    count: n.count,
    children: toList(n.children),
  }));
  return toList(root);
}

export function codexStatusLabel(c) {
  if (c?.dataStatus) return c.dataStatus;
  if (c?.dataUrl) return '外部源';
  if (c?.fallbackDataUrl) return '发布回退数据';
  return '本地数据';
}

export function codexStatusClass(c) {
  const label = codexStatusLabel(c);
  if (label.includes('快照') || label.includes('失败')) return 'warn';
  if (label.includes('外部') || label.includes('R2')) return 'remote';
  return 'local';
}

export function codexStatusTitle(c) {
  if (c?.dataNotice) return c.dataNotice;
  if (c?.dataRelease) return `当前读取 R2 发布：${c.dataRelease}`;
  if (c?.dataUrl) return `当前读取外部源：${c.dataUrl}`;
  if (c?.sourceDataUrl && c?.fallbackDataUrl) return `外部源：${c.sourceDataUrl}\n发布回退数据：${c.fallbackDataUrl}`;
  if (c?.fallbackDataUrl) return `发布回退数据：${c.fallbackDataUrl}`;
  if (getDataSource().mode === 'r2') return '当前读取 R2 数据发布层';
  if (getDataSource().mode === 'proxy') return '当前通过 Pages Functions 读取 R2 数据发布层';
  return '当前读取本地数据';
}

export function notifyCodexDataStatus(c) {
  if (!c?.dataNotice) return;
  const key = `data:${c.id}:${c.dataStatus}:${c.dataError || c.dataNotice}`;
  if (state.sourceNoticesShown.has(key)) return;
  state.sourceNoticesShown.add(key);
  toast(c.dataNotice);
}
