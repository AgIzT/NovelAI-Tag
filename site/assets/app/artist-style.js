/* 单画师按画风重排：v5 画师词典的「单画师词典」改成 画风大类 › 小组，一位画师一张卡。
   tools/build_artist_styles.py 生成 artist_styles.json，根与接近名单随同一数据 release 读取。
   接近名单按画师下标和 nearRevision 分片，打开词条详情时才取。

   不改写 codex.tree：展示用目录另存 codex.styleTree，经 codex.displayTree 取用（目录、地址栏短码、路径兼容）；
   codex.tree 原样留给本地编辑器、全站搜索和收藏。本地编辑模式（body.edit-mode）时整套重排关闭，编辑器看到真实来源目录。
   本模块不碰 DOM。 */

import { state } from './state.js';
import { normalizeRoutePath } from './codex-route-compat.js';
import { encodePathCode } from './path-code.js';
import { fetchDataJson } from '../data-source.js';

export const STYLE_CODEX_ID = 'artist_nai5_personal';
export const SINGLE_ROOT = '单画师词典';
export const UNSORTED = '未归类';
export const SPECIMEN_SOURCE_ORDER = Object.freeze(['花枝鱼', 'AgIzT', '九七', '雨燕', 'MayRain', 'wwuumm']);
const DATA_PATH = 'artist_styles.json';
const NEAR_BASE = 'artist_styles_near';
const REQUEST_TIMEOUT_MS = 6000;

let styles;          // undefined = 没加载；null = 不可用；对象 = 已规范化
let loading = null;
let styleBook = null;  // 挂上画风数据的那本法典（v5 画师词典的真实对象，不是收藏 / 全站搜索的拷贝）
const nearShards = new Map();

export function supportsArtistStyles(codex) {
  return codex?.id === STYLE_CODEX_ID;
}

function editing() {
  return typeof document !== 'undefined' && Boolean(document.body?.classList?.contains('edit-mode'));
}

/* 这本书当前是否按画风展示：数据挂上了、且不在本地编辑模式 */
export function styleActive(codex = state.codex) {
  return Boolean(codex?.styleTree && styles && !editing());
}

function normalize(raw) {
  if (!raw || raw.schema !== 3 || !Array.isArray(raw.artists) || !Array.isArray(raw.groups) || !Array.isArray(raw.parents)) return null;
  const revision = /^[0-9a-f]{16}$/.test(raw.nearRevision) ? raw.nearRevision : '';
  if (!revision || raw.codexId !== STYLE_CODEX_ID || raw.idPrefix !== STYLE_CODEX_ID + '_'
    || !/^[0-9a-f]{64}$/.test(raw.sourceFingerprint) || !Number.isInteger(raw.nearShard) || raw.nearShard < 1 || raw.nearShard > 4096) return null;
  const within = (i, list) => Number.isInteger(i) && i >= 0 && i < list.length;
  const label = value => typeof value === 'string' && value.trim() === value && value.length > 0;
  const refs = (value, list) => value === undefined || (Array.isArray(value) && value.every(i => within(i, list)));
  const description = value => value === undefined || typeof value === 'string';
  if (!raw.parents.length || !raw.groups.length
    || !raw.groups.every(g => g && label(g.name) && within(g.parent, raw.parents)
      && description(g.desc) && (g.tags === undefined || (Array.isArray(g.tags) && g.tags.every(tag => typeof tag === 'string')))
      && refs(g.reps, raw.artists) && refs(g.famous, raw.artists))
    || !raw.parents.every(p => p && label(p.name) && Array.isArray(p.groups) && p.groups.length
      && description(p.desc)
      && p.groups.every(g => within(g, raw.groups)) && refs(p.showcase, raw.artists))) return null;
  const grouped = raw.parents.flatMap((p, parent) => p.groups.map(group => [group, parent]));
  if (grouped.length !== raw.groups.length || new Set(grouped.map(([g]) => g)).size !== raw.groups.length
    || grouped.some(([g, p]) => raw.groups[g].parent !== p)
    || new Set(raw.parents.map(p => p.name)).size !== raw.parents.length
    || new Set(raw.groups.map(g => g.name)).size !== raw.groups.length) return null;
  const ids = new Set();
  for (const a of raw.artists) {
    if (!a || !within(a.g, raw.groups) || !label(a.e) || (a.x !== undefined && !Array.isArray(a.x))) return null;
    if (a.c !== undefined && ![a.e, ...(a.x || [])].includes(a.c)) return null;
    for (const id of [a.e, ...(a.x || [])]) {
      if (!label(id) || ids.has(id)) return null;
      ids.add(id);
    }
  }
  const prefix = String(raw.idPrefix || '');
  const artists = raw.artists.map((a, index) => {
    const otherIds = a.x || [];
    const hasRank = Number.isInteger(a.r) && a.r > 0 && (a.s === a.e || otherIds.includes(a.s));
    return {
      index,
      entryId: prefix + a.e,
      canonicalEntryId: prefix + (a.c || a.e),
      otherIds: otherIds.map(id => prefix + id),
      post: Number.isFinite(a.p) ? a.p : null,
      rank: hasRank ? a.r : null,
      rankSampleId: hasRank ? prefix + a.s : '',
      seenAs: hasRank ? a.t || '' : '',
      group: a.g,
    };
  });
  const groups = raw.groups.map((g, index) => ({
    index, name: g.name, desc: g.desc || '', tags: g.tags || [], parent: g.parent, size: g.size || 0,
    reps: g.reps || [], famous: g.famous || [],
  }));
  const parents = raw.parents.map((p, index) => ({
    index, name: p.name, desc: p.desc || '', groups: p.groups || [], size: p.size || 0, showcase: p.showcase || [],
  }));
  // 词条 ID → 画师：收藏、全站搜索里的词条是拷贝，可能早于挂数据，不一定带 styleArtist
  const byEntry = new Map();
  for (const artist of artists) {
    byEntry.set(artist.entryId, artist.index);
    for (const id of artist.otherIds) byEntry.set(id, artist.index);
  }
  const pathAliases = Array.isArray(raw.pathAliases) ? raw.pathAliases : [];
  return { nearShard: raw.nearShard, revision, sourceFingerprint: raw.sourceFingerprint, artists, groups, parents, byEntry, pathAliases };
}

async function fetchStyleData(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchDataJson(path, { cache: 'no-cache', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function loadArtistStyles() {
  if (styles) return Promise.resolve(styles);
  loading ??= fetchStyleData(DATA_PATH)
    .then(normalize)
    .catch(error => {
      console.warn('画风数据不可用，单画师词典按来源显示。', error);
      return null;
    })
    .then(result => {
      if (result) styles = result;
      return result;
    }).finally(() => { loading = null; });
  return loading;
}

async function sourceFingerprint(codex) {
  const rows = codex.entries.filter(entry => entry.path?.[0] === SINGLE_ROOT)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(entry => [entry.id, entry.path, entry.image || '', entry.rating || 'safe', entry.tags || '']);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function groupPath(groupIndex) {
  const group = styles.groups[groupIndex];
  return [SINGLE_ROOT, styles.parents[group.parent].name, group.name];
}

function sourceOf(entry) {
  return entry?.path?.[0] === SINGLE_ROOT ? String(entry.path[1] || '') : '';
}

function validStyleAliasPath(path) {
  return Array.isArray(path) && (path.length === 2 || path.length === 3)
    && path[0] === SINGLE_ROOT && path.every(seg => typeof seg === 'string' && seg.trim() === seg && seg);
}

/* 把画风数据挂到法典上；同一本书只挂一次。返回是否挂上。 */
export async function attachArtistStyles(codex) {
  if (!supportsArtistStyles(codex)) return false;
  const data = await loadArtistStyles();
  if (!data) return false;
  try {
    const sourceIds = new Set(codex.entries.filter(entry => entry.path?.[0] === SINGLE_ROOT).map(entry => entry.id));
    if (await sourceFingerprint(codex) !== data.sourceFingerprint
      || [...data.byEntry.keys()].some(id => !sourceIds.has(id))) return false;
  } catch (error) {
    console.warn('画风数据与当前词典无法核对，按来源显示。', error);
    return false;
  }
  styleBook = codex;
  if (codex.styleTree) return true;
  const byId = new Map(codex.entries.map(entry => [entry.id, entry]));
  const counts = data.groups.map(() => 0);
  let unsorted = 0;
  for (const entry of codex.entries) {
    if (entry.path?.[0] !== SINGLE_ROOT) continue;
    const index = data.byEntry.get(entry.id);
    if (index == null) {
      entry.stylePath = [SINGLE_ROOT, UNSORTED];
      unsorted += 1;
      continue;
    }
    const artist = data.artists[index];
    entry.styleArtist = index;
    entry.styleRep = artist.entryId === entry.id;
    entry.styleArtistTitle = byId.get(artist.canonicalEntryId)?.title || entry.title;
    entry.stylePath = groupPath(artist.group);
    if (entry.styleRep) counts[artist.group] += 1;
  }
  const singleNode = (codex.tree || []).find(node => node.name === SINGLE_ROOT);
  const sources = (singleNode?.children || []).map(node => node.name);
  const styleChildren = data.parents.map(parent => ({
    name: parent.name,
    count: parent.groups.reduce((sum, g) => sum + counts[g], 0),
    children: parent.groups.map(g => ({ name: data.groups[g].name, count: counts[g], children: [] })),
  }));
  if (unsorted) styleChildren.push({ name: UNSORTED, count: unsorted, children: [] });
  codex.styleEntryById = byId;
  codex.styleSources = sources;
  codex.styleTree = (codex.tree || []).map(node => (node.name === SINGLE_ROOT
    ? { ...node, count: counts.reduce((a, b) => a + b, 0) + unsorted, children: styleChildren }
    : node));
  Object.defineProperty(codex, 'displayTree', {
    configurable: true,
    get() { return styleActive(this) ? this.styleTree : this.tree; },
  });
  const pathsByName = new Map();
  const pathsByCode = new Map();
  for (const alias of data.pathAliases) {
    const { from, to } = alias || {};
    if (!validStyleAliasPath(from) || !validStyleAliasPath(to) || from.length !== to.length) continue;
    const target = normalizeRoutePath(codex.styleTree, to);
    if (!target.length) continue;
    pathsByName.set(JSON.stringify(from), target);
    pathsByCode.set(encodePathCode(from), from);
  }
  /* 改名走精确别名；旧来源目录（MayRain 等）仍落到单画师首页。 */
  Object.defineProperty(codex, 'styleRouteFallback', {
    configurable: true,
    value: path => {
      if (!styleActive(codex) || path?.[0] !== SINGLE_ROOT) return null;
      return pathsByName.get(JSON.stringify(path))?.slice() || [SINGLE_ROOT];
    },
  });
  Object.defineProperty(codex, 'stylePathFromCode', {
    configurable: true,
    value: code => styleActive(codex) ? pathsByCode.get(String(code || '').trim())?.slice() : null,
  });
  return true;
}

/* 目录计数用：这条词条在侧栏里算到哪条路径下；null = 不计（同一画师的其它来源例图，由代表那条算）。
   收藏、全站搜索里的拷贝也带着 stylePath，只有挂了数据的那本书本身才按画风算。 */
export function treePathOf(entry, codex = state.codex) {
  if (!styleActive(codex) || entry?.path?.[0] !== SINGLE_ROOT || !entry.stylePath) return entry?.path;
  if (entry.styleRep || entry.stylePath[1] === UNSORTED) return entry.stylePath;
  return null;
}

/* 打开一条词条时该落到哪个目录：按画风展示的那本书里，单画师词条落到它的画风小组（来源目录已不在侧栏里） */
export function landingPathOf(entry, codex = styleBook) {
  return styleActive(codex) && mayHaveStyle(entry) && Array.isArray(entry?.stylePath) ? entry.stylePath : entry?.path;
}

/* 目录骨架：单画师词典下的大类、小组按数据顺序先占位，「未归类」垫底 */
export function styleTreeSkeleton(codex = state.codex) {
  if (!styleActive(codex)) return null;
  const single = codex.styleTree.find(node => node.name === SINGLE_ROOT);
  return single ? { name: SINGLE_ROOT, children: single.children.map(node => ({ name: node.name, children: node.children.map(child => child.name) })) } : null;
}

export function isSinglePath(path) {
  return Array.isArray(path) && path[0] === SINGLE_ROOT;
}

/* 当前是否在单画师各层（按画风展示的那本书里） */
export function inSingleSection(path = state.activePath) {
  return Boolean(isSinglePath(path) && !state.siteSearchView && !state.favoritesView && styleActive());
}

/* 当前路径落在哪一层：root / parent / group / unsorted；不在单画师各层时为 null */
export function styleLocation(path = state.activePath) {
  if (!styles || !isSinglePath(path)) return null;
  if (path[1] === UNSORTED) return { level: 'unsorted' };
  const parent = path[1] ? styles.parents.find(p => p.name === path[1]) : null;
  const group = parent && path[2] ? styles.groups.find(g => g.parent === parent.index && g.name === path[2]) : null;
  if (group) return { level: 'group', parent, group };
  if (parent) return { level: 'parent', parent };
  return { level: 'root' };
}

export function artistOf(entry) {
  if (!styles || !entry) return null;
  const index = Number.isInteger(entry.styleArtist) ? entry.styleArtist : styles.byEntry.get(entry.id);
  return index == null ? null : styles.artists[index] || null;
}

/* 可能带画风的词条：按 ID 前缀认 v5 画师词典，数据还没加载时用来决定要不要去加载 */
export function mayHaveStyle(entry) {
  return String(entry?.id || '').startsWith(STYLE_CODEX_ID + '_');
}

export function styleBookCodex() {
  return styleBook?.styleTree ? styleBook : null;
}

export function styleBookEntry(id) {
  return styleBookCodex()?.styleEntryById?.get(id) || null;
}

export function artistByIndex(index) {
  return styles?.artists[index] || null;
}

export function groupOf(artist) {
  return artist ? styles.groups[artist.group] : null;
}

export function parentOf(group) {
  return group ? styles.parents[group.parent] : null;
}

/* 比较时忽略来源名末尾的无原图标记，展示仍保留原来源文字。 */
export function specimenSourceRank(entry) {
  const source = sourceOf(entry).trim().replace(/\s*[（(]无原图[)）]\s*$/, '').trim();
  const index = SPECIMEN_SOURCE_ORDER.indexOf(source);
  return index < 0 ? SPECIMEN_SOURCE_ORDER.length : index;
}

function specimenPosition(entry, artist) {
  if (entry.id === artist.entryId) return 0;
  const index = artist.otherIds.indexOf(entry.id);
  return index < 0 ? artist.otherIds.length + 1 : index + 1;
}

function compareSpecimens(left, right, artist) {
  return specimenSourceRank(left) - specimenSourceRank(right)
    || specimenPosition(left, artist) - specimenPosition(right, artist);
}

/* 各来源例图按维护者指定顺序排列，同来源保持原 e/x 次序。 */
export function specimensOf(artist) {
  if (!artist) return [];
  return [artist.entryId, ...artist.otherIds].map(styleBookEntry).filter(Boolean)
    .sort((left, right) => compareSpecimens(left, right, artist));
}

export function formatCount(value) {
  return Number(value || 0).toLocaleString('en-US');
}

export function formatPost(post) {
  return post == null ? 'post 未知' : `post ${formatCount(post)}`;
}

export function specimenSource(entry) {
  return sourceOf(entry);
}

/* 在过滤后的真实词典结果中每位画师选一张；其它内容和未知身份保留原位置。
   不删原词条，详情、收藏与具体图深链仍使用各自的原 ID。 */
export function deduplicateStyleEntries(entries, codex = state.codex) {
  if (!supportsArtistStyles(codex) || !styleActive(codex)) return entries;
  const identity = entry => entry.path?.[0] === SINGLE_ROOT ? artistOf(entry) : null;
  const picked = new Map();
  for (const entry of entries) {
    const artist = identity(entry);
    if (!artist) continue;
    const current = picked.get(artist.index);
    if (!current || compareSpecimens(entry, current, artist) < 0) picked.set(artist.index, entry);
  }
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const artist = identity(entry);
    if (!artist) result.push(entry);
    else if (!seen.has(artist.index)) {
      seen.add(artist.index);
      result.push(picked.get(artist.index));
    }
  }
  return result;
}

/* 单画师各层先筛分级、批次和屏蔽，再按来源优先级每人选一张；同来源按 e/x 稳定取图。 */
export function selectStyleEntries(entries, path = state.activePath, { deduplicate = true } = {}) {
  const where = styleLocation(path);
  if (!where) return entries;
  if (where.level === 'unsorted') return entries.filter(entry => entry.stylePath?.[1] === UNSORTED && entry.path?.[0] === SINGLE_ROOT);
  const inScope = artist => (where.level === 'root'
    || (where.level === 'parent' ? styles.groups[artist.group].parent === where.parent.index : artist.group === where.group.index));
  const candidates = entries.filter(entry => {
    if (entry.path?.[0] !== SINGLE_ROOT) return false;
    const artist = Number.isInteger(entry.styleArtist) ? styles.artists[entry.styleArtist] : null;
    return artist ? inScope(artist) : where.level === 'root' && entry.stylePath?.[1] === UNSORTED;
  });
  if (!deduplicate) return candidates;
  return deduplicateStyleEntries(candidates);
}

/* 卡片底行写 post 的场合：单画师各层（未归类除外），且不在搜索——本书搜索照旧搜整本、底行照旧写路径 */
function artistListActive() {
  if (!inSingleSection()) return false;
  if (state.searchPlan?.hasActiveSearch || String(state.query || '').trim() || state.searchFilterValues?.length) return false;
  const where = styleLocation();
  return Boolean(where && where.level !== 'unsorted');
}

/* 画师名：取正向里的 artist: 写法；花枝鱼等来源的标题带年份，不能直接用标题 */
export function artistNameOf(entry) {
  const match = String(entry?.tags || '').match(/artist:\s*([^,\n]+)/);
  return (match ? match[1] : entry?.title || '').trim();
}

/* ---------- 挑画师（原型）：打平排序 ---------- */

export const ARTIST_SORTS = Object.freeze(['style', 'post', 'usage', 'new']);
const USAGE_PATH = 'proto-data/artist_usage.json';
let usage;            // undefined = 没取过；null = 没有这份数据；Map = 归一画师名 → 例图张数
let usageLoading = null;
const batchInfo = new WeakMap();   // 画师对象 → { rank, id, label }；画风数据重载后画师对象是新的

const usageKey = name => String(name || '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').replace(/\s*\(/g, ' (').trim();

/* 站内例图的画师使用量（原型数据，离线统计的快照）。没有这份文件时排序选项不出现。 */
export function loadArtistUsage() {
  if (usage !== undefined) return Promise.resolve(usage);
  if (!usageLoading) {
    usageLoading = fetch(USAGE_PATH, { cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        const counts = data && typeof data.counts === 'object' ? Object.entries(data.counts) : [];
        usage = counts.length ? new Map(counts.map(([name, count]) => [usageKey(name), Number(count) || 0])) : null;
        return usage;
      })
      .catch(() => { usage = null; return null; });
  }
  return usageLoading;
}

export function artistUsageReady() {
  return usage instanceof Map;
}

export function usageOf(artist) {
  if (!artist || !(usage instanceof Map)) return null;
  const entry = styleBookEntry(artist.canonicalEntryId) || styleBookEntry(artist.entryId);
  return usage.get(usageKey(artistNameOf(entry))) ?? 0;
}

/* 批次编号形如 2026.11.15，按日期比较；认不出的批次不参与。 */
function batchRank(id) {
  const parts = String(id || '').split('.').map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? parts[0] * 10000 + parts[1] * 100 + parts[2] : null;
}

/* 这位画师所有例图里最新的一期更新。 */
export function latestBatchOf(artist) {
  if (!artist) return null;
  if (batchInfo.has(artist)) return batchInfo.get(artist);
  let best = null;
  for (const entry of specimensOf(artist)) {
    for (const id of entry.updateBatches || []) {
      const rank = batchRank(id);
      if (rank != null && (!best || rank > best.rank)) best = { rank, id: String(id) };
    }
  }
  if (best) {
    const filter = (styleBookCodex()?.updateFilters || []).find(item => String(item.id) === best.id);
    best.label = filter?.label || best.id;
  }
  batchInfo.set(artist, best);
  return best;
}

/* 当前是否把单画师打平成一条榜（或只看所选）；侧栏阅读位置在这两种情况下不跟随。 */
export function artistFlatMode() {
  if (!artistListActive()) return '';
  if (state.artistPickOnly && state.artistPicked?.size) return 'picked';
  return ARTIST_SORTS.includes(state.artistSort) && state.artistSort !== 'style' ? state.artistSort : '';
}

function sortKey(artist, mode) {
  if (!artist) return null;
  if (mode === 'post') return artist.post ?? null;
  if (mode === 'usage') return usageOf(artist);
  if (mode === 'new') return latestBatchOf(artist)?.rank ?? null;
  return null;
}

/* 打平排序：按所选的数从多到少，缺值垫底；同值先比 post，再保持原相对顺序。 */
export function sortArtistEntries(list, mode) {
  return list.map((entry, index) => {
    const artist = artistOf(entry);
    return { entry, index, key: sortKey(artist, mode), post: artist?.post ?? -1 };
  }).sort((a, b) => ((b.key ?? -Infinity) - (a.key ?? -Infinity)) || (b.post - a.post) || (a.index - b.index))
    .map(item => item.entry);
}

/* 只看所选：按勾选顺序排，没被勾选的不出现。 */
export function pickedArtistEntries(list, picked = state.artistPicked) {
  const order = new Map([...picked.keys()].map((index, position) => [index, position]));
  return list.filter(entry => order.has(artistOf(entry)?.index))
    .sort((a, b) => order.get(artistOf(a).index) - order.get(artistOf(b).index));
}

/* 小组页底行只写 post，大类页和单画师首页再带上小组名；打平排序时写当前排序用的那个数。 */
export function styleCardLine(entry) {
  if (!artistListActive()) return '';
  const artist = artistOf(entry);
  if (!artist) return '';
  const mode = artistFlatMode();
  const parts = styleLocation()?.level === 'group' && mode !== 'picked' ? [] : [groupOf(artist).name];
  const count = mode === 'usage' ? usageOf(artist) : null;
  const batch = mode === 'new' ? latestBatchOf(artist) : null;
  if (count != null) parts.push(`${formatCount(count)} 张例图用到`);
  else if (batch) parts.push(batch.label);
  else parts.push(formatPost(artist.post));
  return parts.join(' · ');
}

/* 其它视图（全部、搜索、收藏）里单画师卡片的路径行：和侧栏目录一致，后面带上例图来源 */
export function stylePathText(entry) {
  const book = styleBookCodex();
  if (!book || !styleActive(book) || !mayHaveStyle(entry) || entry?.path?.[0] !== SINGLE_ROOT) return '';
  const artist = artistOf(entry);
  const source = sourceOf(entry);
  if (!artist) return [SINGLE_ROOT, UNSORTED].join(' › ') + (source ? ` · ${source}` : '');
  return `${SINGLE_ROOT} › ${groupOf(artist).name}${source ? ` · ${source}` : ''}`;
}

/* 跟随展示目录连续排列；只有同一画风小组内按 post 排，未知 post 垫底。
   排序使用所有例图的展示路径，不能用只给代表图计数的 treePathOf。 */
export function sortStyleEntries(list, codex = state.codex) {
  if (!styleActive(codex)) return list;
  const ranks = new Map();
  const walk = (nodes, prefix = []) => {
    for (const node of nodes || []) {
      const path = [...prefix, node.name];
      ranks.set(JSON.stringify(path), ranks.size);
      walk(node.children, path);
    }
  };
  walk(codex.displayTree || codex.styleTree);
  return list.map((entry, index) => {
    const path = entry.path?.[0] === SINGLE_ROOT && entry.stylePath ? entry.stylePath : entry.path || [];
    return { entry, index, rank: ranks.get(JSON.stringify(path)) ?? Infinity, artist: artistOf(entry) };
  }).sort((a, b) => (a.rank - b.rank)
    || (a.artist && b.artist ? (b.artist.post ?? -1) - (a.artist.post ?? -1) : 0)
    || a.index - b.index).map(item => item.entry);
}

/* 画风接近的画师（下标），按需取所在分片 */
export function loadNearArtists(index) {
  if (!styles || !Number.isInteger(index) || index < 0 || index >= styles.artists.length) return Promise.resolve([]);
  const shard = Math.floor(index / styles.nearShard);
  if (!nearShards.has(shard)) {
    const dir = styles.revision ? `${NEAR_BASE}/${styles.revision}` : NEAR_BASE;
    nearShards.set(shard, fetchStyleData(`${dir}/${shard}.json`)
      .then(rows => {
        const start = shard * styles.nearShard;
        if (!Array.isArray(rows) || rows.length !== Math.min(styles.nearShard, styles.artists.length - start)
          || rows.some((row, offset) => !Array.isArray(row) || new Set(row).size !== row.length
            || row.some(i => !Number.isInteger(i) || i < 0 || i >= styles.artists.length || i === start + offset))) {
          throw new Error('Invalid artist neighbor shard');
        }
        return rows;
      }).catch(() => { nearShards.delete(shard); return []; }));
  }
  return nearShards.get(shard).then(rows => rows[index - shard * styles.nearShard] || []);
}
