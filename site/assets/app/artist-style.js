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
export const SPECIMEN_SOURCE_ORDER = Object.freeze(['花枝鱼', 'AgIzT', '九七', '雨燕', 'nax.moe', 'MayRain', 'wwuumm']);
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
  for (const entry of codex.entries) {
    if (entry.path?.[0] !== SINGLE_ROOT) continue;
    const index = data.byEntry.get(entry.id);
    if (index == null) {
      entry.stylePath = [SINGLE_ROOT, UNSORTED];
      continue;
    }
    const artist = data.artists[index];
    entry.styleArtist = index;
    entry.styleRep = artist.entryId === entry.id;
    entry.styleArtistTitle = byId.get(artist.canonicalEntryId)?.title || entry.title;
  }
  const singleNode = (codex.tree || []).find(node => node.name === SINGLE_ROOT);
  codex.styleEntryById = byId;
  codex.styleSources = (singleNode?.children || []).map(node => node.name);
  applyDivision(codex, 'style');
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
  /* 改名走精确别名；旧来源目录（MayRain 等）仍落到单画师首页。
     路径属于另一种分法（别人分享的档位链接，或本机记着按 post 却打开了画风小组链接）时，本次先切到那种分法。 */
  Object.defineProperty(codex, 'styleRouteFallback', {
    configurable: true,
    value: path => {
      if (!styleActive(codex) || path?.[0] !== SINGLE_ROOT) return null;
      const other = divisionOfPath(codex, path);
      if (other) {
        applyDivision(codex, other);
        return path.slice();
      }
      const alias = pathsByName.get(JSON.stringify(path));
      if (alias && artistDivision(codex) !== 'style') applyDivision(codex, 'style');
      return alias?.slice() || [SINGLE_ROOT];
    },
  });
  Object.defineProperty(codex, 'stylePathFromCode', {
    configurable: true,
    value: code => {
      if (!styleActive(codex)) return null;
      const key = String(code || '').trim();
      return pathsByCode.get(key)?.slice() || divisionPathFromCode(codex, key);
    },
  });
  const remembered = storedDivision();
  if (remembered !== 'style') applyDivision(codex, remembered);
  return true;
}

/* ---------- 挑画师：分法 ----------
   「单画师词典」下面的目录可以换一种分法：画风（大类 › 小组）、post 档位。以后的收藏量、热门也照这个做。
   分法只决定两件事：目录有哪些节点、每位画师算到哪个节点。排序、目录计数、阅读位置和地址栏短码
   都照 entry.stylePath 与 codex.displayTree 走，所以换分法只重写这两样。 */

export const ARTIST_DIVISIONS = Object.freeze(['style', 'post']);
const DIVISION_KEY = 'fadian-artist-division';
/* 低 post 一侧人多，切得细；高的一侧人少，切得粗。 */
const POST_BANDS = Object.freeze([
  [2000, '2000 以上'], [1000, '1000–1999'], [500, '500–999'], [400, '400–499'], [300, '300–399'],
  [250, '250–299'], [200, '200–249'], [150, '150–199'], [100, '100–149'], [50, '50–99'], [0, '50 以下'],
]);
const POST_UNKNOWN = 'post 未知';

function storedDivision() {
  try {
    const value = globalThis.localStorage?.getItem(DIVISION_KEY);
    return ARTIST_DIVISIONS.includes(value) ? value : 'style';
  } catch {
    return 'style';
  }
}

export function artistDivision(codex = styleBook) {
  return ARTIST_DIVISIONS.includes(codex?.styleDivision) ? codex.styleDivision : 'style';
}

function postBand(artist) {
  return artist.post == null ? POST_UNKNOWN : POST_BANDS.find(([min]) => artist.post >= min)?.[1] || POST_UNKNOWN;
}

/* 某种分法下：每位画师的目录路径，以及单画师词典下面的节点（带人数，空节点不建）。不改任何东西。 */
function divisionLayout(codex, mode) {
  const data = styles;
  const paths = data.artists.map(artist => (mode === 'post' ? [SINGLE_ROOT, postBand(artist)] : groupPath(artist.group)));
  const present = new Set();
  let unsorted = 0;
  for (const entry of codex.entries) {
    if (entry.path?.[0] !== SINGLE_ROOT) continue;
    if (Number.isInteger(entry.styleArtist)) present.add(entry.styleArtist);
    else unsorted += 1;
  }
  const tally = new Map();
  for (const index of present) {
    const leaf = paths[index][paths[index].length - 1];
    tally.set(leaf, (tally.get(leaf) || 0) + 1);
  }
  const leafNode = name => ({ name, count: tally.get(name) || 0, children: [] });
  let children;
  if (mode === 'post') {
    children = [...POST_BANDS.map(([, name]) => name), POST_UNKNOWN].map(leafNode);
  } else {
    children = data.parents.map(parent => {
      const groups = parent.groups.map(g => leafNode(data.groups[g].name));
      return { name: parent.name, count: groups.reduce((sum, node) => sum + node.count, 0), children: groups };
    });
  }
  if (mode !== 'style') children = children.filter(node => node.count > 0);
  if (unsorted) children.push({ name: UNSORTED, count: unsorted, children: [] });
  return { paths, children, total: present.size + unsorted };
}

function applyDivision(codex, mode) {
  const layout = divisionLayout(codex, mode);
  for (const entry of codex.entries) {
    if (entry.path?.[0] === SINGLE_ROOT && Number.isInteger(entry.styleArtist)) entry.stylePath = layout.paths[entry.styleArtist];
  }
  codex.styleTree = (codex.tree || []).map(node => (node.name === SINGLE_ROOT
    ? { ...node, count: layout.total, children: layout.children }
    : node));
  codex.styleDivision = mode;
}

/* 换分法：目录和每位画师的归属一起换。persist 为假时只在本次打开有效（比如跟着分享链接切过去）。 */
export function setArtistDivision(codex, mode, { persist = true } = {}) {
  if (!codex?.styleTree || !styles || !ARTIST_DIVISIONS.includes(mode)) return false;
  if (artistDivision(codex) !== mode) applyDivision(codex, mode);
  if (persist) {
    try { globalThis.localStorage?.setItem(DIVISION_KEY, mode); } catch { /* 记不住就只管本次 */ }
  }
  return true;
}

function nodePaths(children) {
  const list = [];
  const walk = (nodes, prefix) => {
    for (const node of nodes) {
      const path = [...prefix, node.name];
      list.push(path);
      walk(node.children || [], path);
    }
  };
  walk(children, [SINGLE_ROOT]);
  return list;
}

/* 这条单画师路径属于哪一种「别的分法」；当前分法里就有、或哪种都没有时返回空。 */
function divisionOfPath(codex, path) {
  if (!Array.isArray(path) || path.length < 2 || path[1] === UNSORTED) return '';
  const key = JSON.stringify(path);
  const has = mode => nodePaths(divisionLayout(codex, mode).children).some(item => JSON.stringify(item) === key);
  const current = artistDivision(codex);
  if (has(current)) return '';
  return ARTIST_DIVISIONS.find(mode => mode !== current && has(mode)) || '';
}

function divisionPathFromCode(codex, code) {
  if (!code) return null;
  const current = artistDivision(codex);
  for (const mode of ARTIST_DIVISIONS) {
    if (mode === current) continue;
    const found = nodePaths(divisionLayout(codex, mode).children).find(path => encodePathCode(path) === code);
    if (found) return found;
  }
  return null;
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

/* 当前路径落在哪一层：root / parent / group / unsorted，非画风分法下第二段是 band；不在单画师各层时为 null */
export function styleLocation(path = state.activePath) {
  if (!styles || !isSinglePath(path)) return null;
  if (path[1] === UNSORTED) return { level: 'unsorted' };
  if (path[1] && artistDivision() !== 'style') return { level: 'band', name: path[1] };
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
  if (where.level === 'band') {
    const inBand = entries.filter(entry => entry.path?.[0] === SINGLE_ROOT && Number.isInteger(entry.styleArtist) && entry.stylePath?.[1] === where.name);
    return deduplicate ? deduplicateStyleEntries(inBand) : inBand;
  }
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

/* 只看所选：这本书的普通浏览里把勾中的画师单独摆出来；这时卡片顺序和目录无关。 */
export function artistPickedView() {
  return Boolean(state.artistPickOnly && state.artistPicked?.size && styleActive()
    && !state.favoritesView && !state.siteSearchView
    && !(state.searchPlan?.hasActiveSearch || String(state.query || '').trim() || state.searchFilterValues?.length));
}

/* 只看所选：按勾选顺序排，没被勾选的不出现。 */
export function pickedArtistEntries(list, picked = state.artistPicked) {
  const order = new Map([...picked.keys()].map((index, position) => [index, position]));
  return list.filter(entry => order.has(artistOf(entry)?.index))
    .sort((a, b) => order.get(artistOf(a).index) - order.get(artistOf(b).index));
}

/* 画风小组页底行只写 post；其余各层（大类、单画师首页、post 档位、只看所选）再带上画风小组名。 */
export function styleCardLine(entry) {
  if (!artistListActive()) return '';
  const artist = artistOf(entry);
  if (!artist) return '';
  const parts = styleLocation()?.level === 'group' && !artistPickedView() ? [] : [groupOf(artist).name];
  parts.push(formatPost(artist.post));
  return parts.join(' · ');
}

/* 其它视图（全部、搜索、收藏）里单画师卡片的路径行：和侧栏目录一致，后面带上例图来源 */
export function stylePathText(entry) {
  const book = styleBookCodex();
  if (!book || !styleActive(book) || !mayHaveStyle(entry) || entry?.path?.[0] !== SINGLE_ROOT) return '';
  const artist = artistOf(entry);
  const source = sourceOf(entry);
  if (!artist) return [SINGLE_ROOT, UNSORTED].join(' › ') + (source ? ` · ${source}` : '');
  // 目录按 post 分时，侧栏里没有画风小组这一行，不写成路径，只写小组名和 post
  if (!state.favoritesView && !state.siteSearchView && artistDivision(book) !== 'style') {
    return `${groupOf(artist).name} · ${formatPost(artist.post)}`;
  }
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
