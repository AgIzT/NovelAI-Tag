import { state } from './state.js';
import { fetchCodex, findCodexMeta, buildTreeFromEntries } from './data.js';
import { isCodexLocked } from './access.js';
import { hasEntryImage, entryImages, assetUrl } from './media.js';
import {
  FavoritesBackupError,
  canonicalizeAtlasStorageKey,
} from './favorites-backup-core.js';

/* 全部收藏视图：把全部法典的收藏合并成一份临时数据，复用瀑布流/灯箱/搜索/目录树。
   词条克隆时：图片地址预解析成绝对 URL（含外部源法典也能跨书显示）、path 前面插入来源法典名
   （目录树/胶囊自动按来源分组）、带上 _src* 标记（收藏键、最近浏览、pack 行为回溯真实法典）。
   数据不缓存：收藏随时会变，每次进入现建；底层 fetchCodex 有内存缓存，重建代价低。 */

export const FAVORITES_CODEX_ID = 'favorites';

function favoritesViewMeta() {
  return {
    id: FAVORITES_CODEX_ID,
    view: 'favorites',
    type: 'favorites-view',
    title: '全部收藏',
    author: '',
    version: '跨法典收藏',
    nsfw: false,
    aliases: [],
  };
}

/* 旧收藏可能挂在别名法典或已迁移章节下，统一归一到当前正主后再分组。 */
function canonicalizeFavKey(key) {
  try {
    const normalized = canonicalizeAtlasStorageKey(key, state.codexes);
    return {
      ...normalized,
      meta: findCodexMeta(normalized.codexId) || null,
      key,
    };
  } catch (error) {
    if (error instanceof FavoritesBackupError) return null;
    throw error;
  }
}

function collectFavGroups() {
  const byCodex = new Map();
  const orphanKeys = [];
  for (const key of state.favs) {
    const c = canonicalizeFavKey(key);
    if (!c || !c.meta) { orphanKeys.push(key); continue; }
    let group = byCodex.get(c.codexId);
    if (!group) { group = { meta: c.meta, items: new Map() }; byCodex.set(c.codexId, group); }
    const rawKeys = group.items.get(c.entryId) || [];
    rawKeys.push(key);
    group.items.set(c.entryId, rawKeys);
  }
  const groups = state.codexes.filter(c => byCodex.has(c.id)).map(c => byCodex.get(c.id));
  return { groups, orphanKeys };
}

function cloneFavEntry(e, codex, groupName) {
  const clone = {
    ...e,
    path: [groupName, ...(e.path || [])],
    _srcCodexId: codex.id,
    _srcCodexTitle: codex.title,
    _srcType: codex.type,
    _srcPath: e.path || [],
  };
  if (codex.assetPathMode === 'relative') {
    /* 外部源法典：文件路径相对其 assetBaseUrl，跨书展示时预解析成绝对 URL */
    const images = entryImages(e).map(item => {
      const src = { ...e, image: item.path, original: item.original || item.path };
      return { ...item, path: assetUrl('image', src, codex), original: assetUrl('original', src, codex) };
    });
    clone.assetRev = '';   // 预解析的 URL 已带版本参数，置空避免二次追加
    clone.images = images;
    clone.image = images[0]?.path || '';
    clone.original = images[0]?.original || '';
  } else {
    /* 常规法典：走 media.js 现成的 assetCodexId 机制按来源法典拼图片路径（本地回退/线上 R2 都对） */
    clone.assetCodexId = e.assetCodexId || codex.id;
  }
  return clone;
}

export async function buildFavoritesCodex() {
  const { groups, orphanKeys } = collectFavGroups();
  const openGroups = groups.filter(g => !isCodexLocked(g.meta));
  const lockedCount = groups.filter(g => isCodexLocked(g.meta)).reduce((n, g) => n + g.items.size, 0);
  const sources = await Promise.all(openGroups.map(async group => {
    try {
      return { group, codex: await fetchCodex(group.meta) };
    } catch (ex) {
      console.warn(ex);
      return { group, codex: null };
    }
  }));

  const entries = [];
  let missingCount = orphanKeys.length;
  let failedCount = 0;
  for (const { group, codex } of sources) {
    if (!codex) { failedCount += group.items.size; continue; }
    const groupName = group.meta.selectorTitle || codex.title;
    const found = new Set();
    for (const e of codex.entries) {
      if (!group.items.has(e.id)) continue;
      found.add(e.id);
      entries.push(cloneFavEntry(e, codex, groupName));
    }
    missingCount += group.items.size - found.size;
  }

  const notices = [];
  if (lockedCount) notices.push(`另有 ${lockedCount} 条收藏在 NSFW 法典中，开启 NSFW 后可见`);
  if (failedCount) notices.push(`${failedCount} 条收藏所在的法典加载失败，稍后再试`);
  if (missingCount) notices.push(`${missingCount} 条收藏的源词条已不存在`);

  return {
    ...favoritesViewMeta(),
    assetPathMode: 'codex',
    assetBaseUrl: '',
    dataUrl: '',
    sourceDataUrl: '',
    fallbackDataUrl: '',
    dataStatus: '本地收藏',
    dataNotice: notices.join('；'),
    dataError: '',
    source: '',
    contributors: [],
    links: [],
    hasOriginal: sources.some(s => s.codex?.hasOriginal),
    entries,
    entryCount: entries.length,
    imagedCount: entries.filter(hasEntryImage).length,
    tree: buildTreeFromEntries(entries),
  };
}
