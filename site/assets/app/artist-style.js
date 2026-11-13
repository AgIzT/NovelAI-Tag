/* 单画师按画风重排（原型）：v5 画师词典的「单画师词典」不再按来源分目录，改成 画风大类 › 小组，一位画师一张卡。
   数据 artist_styles.json 由 output/artist-style-view-20261113/build_style_data.py 从画师表生成；
   原型期放在 site/proto-data/，不在 site/data/，不随数据发布。画风接近名单按画师下标分片，打开词条详情时才取。

   不改写 codex.tree：展示用目录另存 codex.styleTree，经 codex.displayTree 取用（目录、地址栏短码、路径兼容）；
   codex.tree 原样留给本地编辑器、全站搜索和收藏。本地编辑模式（body.edit-mode）时整套重排关闭，编辑器看到真实来源目录。
   本模块不碰 DOM。 */

import { state } from './state.js';

export const STYLE_CODEX_ID = 'artist_nai5_personal';
export const SINGLE_ROOT = '单画师词典';
export const UNSORTED = '未归类';
const DATA_URL = 'proto-data/artist_styles.json';
const NEAR_URL = shard => `proto-data/artist_styles_near/${shard}.json`;

export const STYLE_SORTS = [
  { value: 'post', label: '按 post 数' },
  { value: 'rec', label: '按辨识度' },
  { value: 'near', label: '按接近本组' },
];
/* 明暗、色彩已经体现在小组的实测标签里，不单独做筛选 */
export const STYLE_FILTERS = [
  { key: 'heat', label: '热度', options: [['hot', 'post 1000 以上'], ['mid', 'post 200–1000'], ['cold', 'post 200 以下']] },
  { key: 'rec', label: '辨识度', options: [['high', '辨识度高'], ['mid', '辨识度中'], ['low', '辨识度低']] },
];
const REC_TEXT = { high: '高', mid: '中', low: '低', unknown: '未知' };

let styles;          // undefined = 没加载；null = 不可用；对象 = 已规范化
let loading = null;
let styleBook = null;  // 挂上画风数据的那本法典（v5 画师词典的真实对象，不是收藏 / 全站搜索的拷贝）
const nearShards = new Map();

/* 单画师各层的排序、筛选与例图来源：只存在内存里（原型不进地址栏）。source 为空 = 自动（有 MayRain 用 MayRain） */
export const styleView = { sort: 'post', heat: '', rec: '', source: '' };

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

export function artistStyles() {
  return styles || null;
}

function normalize(raw) {
  if (!raw || raw.schema !== 1 || !Array.isArray(raw.artists) || !Array.isArray(raw.groups) || !Array.isArray(raw.parents)) return null;
  const prefix = String(raw.idPrefix || '');
  const artists = raw.artists.map((a, index) => ({
    index,
    entryId: prefix + a.e,
    otherIds: (a.x || []).map(id => prefix + id),
    post: Number.isFinite(a.p) ? a.p : null,
    rank: Number.isFinite(a.r) ? a.r : null,
    seenAs: a.t || '',
    group: a.g,
    closeness: Number.isFinite(a.o) ? a.o : 1e9,   // 组内离中心的名次，0 最近
  }));
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
  return { nearShard: raw.nearShard || 512, artists, groups, parents, byEntry };
}

export function loadArtistStyles() {
  if (styles !== undefined) return Promise.resolve(styles);
  loading ??= fetch(DATA_URL, { cache: 'no-cache' })
    .then(response => (response.ok ? response.json() : null))
    .then(normalize)
    .catch(error => {
      console.warn('画风数据不可用，单画师词典按来源显示。', error);
      return null;
    })
    .then(result => {
      styles = result;
      return result;
    });
  return loading;
}

export function groupPath(groupIndex) {
  const group = styles.groups[groupIndex];
  return [SINGLE_ROOT, styles.parents[group.parent].name, group.name];
}

function sourceOf(entry) {
  return entry?.path?.[0] === SINGLE_ROOT ? String(entry.path[1] || '') : '';
}

/* 把画风数据挂到法典上；同一本书只挂一次。返回是否挂上。 */
export async function attachArtistStyles(codex) {
  if (!supportsArtistStyles(codex)) return false;
  const data = await loadArtistStyles();
  if (!data) return false;
  styleBook = codex;
  if (codex.styleTree) return true;
  const byId = new Map();
  const counts = data.groups.map(() => 0);
  let unsorted = 0;
  for (const entry of codex.entries) {
    byId.set(entry.id, entry);
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
  /* 旧链接里的来源目录（单画师词典 › MayRain …）在画风目录里不存在：落到单画师首页，不退回「全部」 */
  Object.defineProperty(codex, 'styleRouteFallback', {
    configurable: true,
    value: path => (styleActive(codex) && Array.isArray(path) && path[0] === SINGLE_ROOT ? [SINGLE_ROOT] : null),
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

/* 这位画师在各来源的例图词条（代表那条在前） */
export function specimensOf(artist) {
  if (!artist) return [];
  return [artist.entryId, ...artist.otherIds].map(styleBookEntry).filter(Boolean);
}

export const heatOf = post => (post == null ? '' : post >= 1000 ? 'hot' : post >= 200 ? 'mid' : 'cold');
export const recOf = rank => (rank == null ? 'unknown' : rank === 1 ? 'high' : rank <= 10 ? 'mid' : 'low');
export const recText = rank => REC_TEXT[recOf(rank)];

export function formatCount(value) {
  return Number(value || 0).toLocaleString('en-US');
}

export function formatPost(post) {
  return post == null ? 'post 未知' : `post ${formatCount(post)}`;
}

export function specimenSource(entry) {
  return sourceOf(entry);
}

/* 单画师各层出哪些卡：每位画师一张；选了来源就只列有该来源例图的画师。
   例图来源为「自动」时用代表那条；代表那条被分级挡住（不在传入的列表里）时改用这位画师别的例图，免得整位画师消失。 */
export function selectStyleEntries(entries, path = state.activePath) {
  const where = styleLocation(path);
  if (!where) return entries;
  if (where.level === 'unsorted') return entries.filter(entry => entry.stylePath?.[1] === UNSORTED && entry.path?.[0] === SINGLE_ROOT);
  const inScope = artist => (where.level === 'root'
    || (where.level === 'parent' ? styles.groups[artist.group].parent === where.parent.index : artist.group === where.group.index));
  const source = styleView.source;
  const picked = new Map();
  for (const entry of entries) {
    if (entry.path?.[0] !== SINGLE_ROOT) continue;
    const artist = Number.isInteger(entry.styleArtist) ? styles.artists[entry.styleArtist] : null;
    if (!artist || !inScope(artist)) continue;
    if (source && sourceOf(entry) !== source) continue;
    const current = picked.get(artist.index);
    if (!current || (!source && entry.styleRep && !current.styleRep)) picked.set(artist.index, entry);
  }
  return [...picked.values()];
}

/* 卡片用画师样式的场合：单画师各层（未归类除外），且不在搜索——本书搜索照旧搜整本、出普通卡 */
export function artistCardsActive() {
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

/* 画师卡用画师名当标题，不用画师卡时返回空串（调用方用原标题） */
export function styleCardTitle(entry) {
  return artistCardsActive() && Number.isInteger(entry?.styleArtist) ? artistNameOf(entry) : '';
}

/* 画师卡底行：小组页写 post 与辨识度，大类页和首页再带上小组名 */
export function styleCardLine(entry) {
  if (!artistCardsActive()) return '';
  const artist = artistOf(entry);
  if (!artist) return '';
  const parts = styleLocation()?.level === 'group' ? [] : [groupOf(artist).name];
  parts.push(formatPost(artist.post), `辨识度${recText(artist.rank)}`);
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

export function styleFiltersActive() {
  return Boolean(styleView.source) || STYLE_FILTERS.some(filter => styleView[filter.key] !== '');
}

export function filterStyleEntries(list) {
  if (!styleView.heat && !styleView.rec) return list;
  return list.filter(entry => {
    const artist = artistOf(entry);
    if (!artist) return false;
    if (styleView.heat && heatOf(artist.post) !== styleView.heat) return false;
    if (styleView.rec && recOf(artist.rank) !== styleView.rec) return false;
    return true;
  });
}

export function sortStyleEntries(list) {
  const post = entry => artistOf(entry)?.post ?? -1;
  const rank = entry => artistOf(entry)?.rank ?? 1e9;
  const sorted = [...list];
  if (styleView.sort === 'rec') {
    sorted.sort((a, b) => rank(a) - rank(b) || post(b) - post(a));
  } else if (styleView.sort === 'near' && styleLocation()?.level !== 'root') {
    const order = entry => artistOf(entry)?.closeness ?? 1e9;
    sorted.sort((a, b) => (artistOf(a)?.group ?? 99) - (artistOf(b)?.group ?? 99) || order(a) - order(b));
  } else {
    sorted.sort((a, b) => post(b) - post(a));
  }
  return sorted;
}

/* 画风接近的画师（下标），按需取所在分片 */
export function loadNearArtists(index) {
  if (!styles) return Promise.resolve([]);
  const shard = Math.floor(index / styles.nearShard);
  if (!nearShards.has(shard)) {
    nearShards.set(shard, fetch(NEAR_URL(shard), { cache: 'no-cache' })
      .then(response => (response.ok ? response.json() : []))
      .catch(() => []));
  }
  return nearShards.get(shard).then(rows => rows[index - shard * styles.nearShard] || []);
}
