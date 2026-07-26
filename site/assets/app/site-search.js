import { state } from './state.js';
import { fetchCodex, buildTreeFromEntries } from './data.js';
import { isCodexLocked } from './access.js';
import { hasEntryImage, entryImages, assetUrl } from './media.js';

export const SITE_SEARCH_CODEX_ID = 'site-search';

let siteSearchMemo = null;
let siteSearchInFlight = null;
let siteSearchGeneration = 0;

function currentBuildKey() {
  return {
    codexes: state.codexes,
    allowNsfw: state.allowNsfw,
    allowR18g: state.allowR18g,
  };
}

function sameBuildKey(a, b) {
  return Boolean(a && b
    && a.codexes === b.codexes
    && a.allowNsfw === b.allowNsfw
    && a.allowR18g === b.allowR18g);
}

export function invalidateSiteSearchCodex() {
  siteSearchGeneration += 1;
  siteSearchMemo = null;
  siteSearchInFlight = null;
}

function siteSearchMeta() {
  return {
    id: SITE_SEARCH_CODEX_ID,
    view: 'site-search',
    type: 'site-search-view',
    title: '全站搜索',
    author: '',
    version: '跨法典搜索',
    nsfw: false,
    aliases: [],
  };
}

function sourceLabel(meta, codex) {
  return meta.selectorTitle || codex.selectorTitle || codex.title || meta.title || meta.id;
}

function cloneSearchEntry(e, codex, groupName) {
  const clone = {
    ...e,
    path: [groupName, ...(e.path || [])],
    _srcCodexId: codex.id,
    _srcCodexTitle: codex.title,
    _srcType: codex.type,
    _srcPath: e.path || [],
    _srcAuthor: codex.author || '',
    _srcSource: codex.source || '',
    _srcContributors: Array.isArray(codex.contributors) ? codex.contributors : [],
  };
  if (codex.assetPathMode === 'relative') {
    const images = entryImages(e).map(item => {
      const src = { ...e, image: item.path, original: item.original || item.path };
      return { ...item, path: assetUrl('image', src, codex), original: assetUrl('original', src, codex) };
    });
    clone.assetRev = '';
    clone.images = images;
    clone.image = images[0]?.path || '';
    clone.original = images[0]?.original || '';
  } else {
    clone.assetCodexId = e.assetCodexId || codex.id;
  }
  return clone;
}

export async function buildSiteSearchCodex() {
  const key = currentBuildKey();
  if (sameBuildKey(siteSearchMemo?.key, key)) return siteSearchMemo.codex;
  if (sameBuildKey(siteSearchInFlight?.key, key)) return siteSearchInFlight.promise;

  const generation = siteSearchGeneration;
  const promise = buildSiteSearchCodexFresh().then(({ codex, complete }) => {
    if (generation !== siteSearchGeneration || !sameBuildKey(key, currentBuildKey())) {
      return buildSiteSearchCodex();
    }
    if (complete) {
      siteSearchMemo = { key, codex };
    }
    return codex;
  }).finally(() => {
    if (siteSearchInFlight?.promise === promise) siteSearchInFlight = null;
  });
  siteSearchInFlight = { key, promise };
  return promise;
}

async function buildSiteSearchCodexFresh() {
  const lockedMetas = state.codexes.filter(isCodexLocked);
  const openMetas = state.codexes.filter(meta => !isCodexLocked(meta));
  const sources = await Promise.all(openMetas.map(async meta => {
    try {
      return { meta, codex: await fetchCodex(meta) };
    } catch (ex) {
      console.warn(ex);
      return { meta, codex: null };
    }
  }));

  const entries = [];
  let failedCount = 0;
  let failedSources = 0;
  for (const { meta, codex } of sources) {
    if (!codex) {
      failedSources += 1;
      failedCount += Number(meta.entryCount || 0);
      continue;
    }
    const groupName = sourceLabel(meta, codex);
    for (const e of codex.entries || []) {
      entries.push(cloneSearchEntry(e, codex, groupName));
    }
  }

  const lockedCount = lockedMetas.reduce((n, meta) => n + Number(meta.entryCount || 0), 0);
  const notices = [];
  if (lockedCount) notices.push(`另有 ${lockedCount} 条在 NSFW 法典中，开启 NSFW 后可搜索`);
  if (failedCount) notices.push(`${failedCount} 条所在的法典加载失败，稍后再试`);

  return {
    // fetchCodex 的“发布回退数据”刻意不进 codexCache，以便下次重试外部源；
    // 全站 memo 也必须尊重这层语义，不能把一次降级冻结成整会话结果。
    complete: failedSources === 0
      && sources.every(({ codex }) => codex?.dataStatus !== '发布回退数据'),
    codex: {
      ...siteSearchMeta(),
      assetPathMode: 'codex',
      assetBaseUrl: '',
      dataUrl: '',
      sourceDataUrl: '',
      fallbackDataUrl: '',
      dataStatus: '本地索引',
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
    },
  };
}
