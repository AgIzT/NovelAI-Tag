/* 画风分类（原型）：v5 画师词典的单画师按画风分成大类 › 小组，每位画师一张卡。
   数据 artist_styles.json 由 output/artist-style-view-20261113/build_style_data.py 从画师表生成；
   原型期放在 site/proto-data/，不在 site/data/，不随数据发布。画风接近的名单按画师下标分片，打开词条详情时才取。

   接线方式：给每位画师的代表词条挂一条虚拟路径 entry.stylePath = [画风分类, 大类, 小组]，
   并在法典树前面插一个同名虚拟目录，于是侧栏目录、分类轨、面包屑、地址栏短码与浏览历史都沿用原有机制；
   同一画师的其它单画师词条只挂 entry.styleArtist，用于词条详情里的「画风」一栏。本模块不碰 DOM。 */

import { state } from './state.js';

export const STYLE_CODEX_ID = 'artist_nai5_personal';
export const STYLE_ROOT = '画风分类';
const DATA_URL = 'proto-data/artist_styles.json';
const NEAR_URL = shard => `proto-data/artist_styles_near/${shard}.json`;

export const STYLE_SORTS = [
  { value: 'post', label: '按 post 数' },
  { value: 'rec', label: '按辨识度' },
  { value: 'near', label: '按接近本组' },
];
export const STYLE_FILTERS = [
  { key: 'heat', label: '热度', options: [['hot', 'post 1000 以上'], ['mid', 'post 200–1000'], ['cold', 'post 200 以下']] },
  { key: 'rec', label: '辨识度', options: [['high', '高'], ['mid', '中'], ['low', '低']] },
  { key: 'light', label: '明暗', options: [['0', '偏暗'], ['1', '适中'], ['2', '偏亮']] },
  { key: 'color', label: '色彩', options: [['0', '素淡'], ['1', '适中'], ['2', '鲜艳']] },
];
const REC_TEXT = { high: '高', mid: '中', low: '低', unknown: '未知' };

let styles;          // undefined = 没加载；null = 不可用；对象 = 已规范化
let loading = null;
const nearShards = new Map();

/* 画风分类视图里的排序与筛选：只存在内存里（原型不进地址栏） */
export const styleView = { sort: 'post', heat: '', rec: '', light: '', color: '' };

export function supportsArtistStyles(codex) {
  return codex?.id === STYLE_CODEX_ID;
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
    light: Number.isInteger(a.l) ? a.l : null,
    color: Number.isInteger(a.v) ? a.v : null,
    weights: Array.isArray(a.w) ? { count: a.w[0], median: a.w[1] } : null,
    group: a.g,
    closeness: Number.isFinite(a.o) ? a.o : 1e9,   // 组内离中心的名次，0 最近
  }));
  const groups = raw.groups.map((g, index) => ({ index, ...g }));
  const parents = raw.parents.map((p, index) => ({ index, ...p }));
  return { root: raw.root || STYLE_ROOT, nearShard: raw.nearShard || 512, artists, groups, parents };
}

export function loadArtistStyles() {
  if (styles !== undefined) return Promise.resolve(styles);
  loading ??= fetch(DATA_URL, { cache: 'no-cache' })
    .then(response => (response.ok ? response.json() : null))
    .then(normalize)
    .catch(error => {
      console.warn('画风分类数据不可用，目录里不显示「画风分类」。', error);
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
  return [STYLE_ROOT, styles.parents[group.parent].name, group.name];
}

/* 把画风数据挂到法典词条和目录树上；同一本书只挂一次。返回是否挂上。 */
export async function ensureArtistStyles(codex) {
  if (!supportsArtistStyles(codex)) return false;
  if (codex.styleStamp) return true;
  const data = await loadArtistStyles();
  if (!data || codex.styleStamp) return Boolean(data);
  const byId = new Map(codex.entries.map(entry => [entry.id, entry]));
  const counts = data.groups.map(() => 0);
  for (const artist of data.artists) {
    const rep = byId.get(artist.entryId);
    if (!rep) continue;
    rep.stylePath = groupPath(artist.group);
    rep.styleArtist = artist.index;
    counts[artist.group] += 1;
    for (const id of artist.otherIds) {
      const other = byId.get(id);
      if (other) other.styleArtist = artist.index;
    }
  }
  codex.styleEntryById = byId;
  const children = data.parents.map(parent => ({
    name: parent.name,
    count: parent.groups.reduce((sum, g) => sum + counts[g], 0),
    children: parent.groups.map(g => ({ name: data.groups[g].name, count: counts[g], children: [] })),
  }));
  codex.tree = [{ name: STYLE_ROOT, count: counts.reduce((a, b) => a + b, 0), children, virtual: true },
    ...(codex.tree || []).filter(node => node.name !== STYLE_ROOT)];
  codex.styleStamp = Date.now();
  return true;
}

/* 目录计数用的虚拟节点骨架：大类、小组按数据里的顺序先占位，计数由调用方按词条累加 */
export function styleTreeSkeleton(codex) {
  if (!codex?.styleStamp || !styles) return null;
  return {
    name: STYLE_ROOT,
    children: styles.parents.map(parent => ({ name: parent.name, children: parent.groups.map(g => styles.groups[g].name) })),
  };
}

export function isStylePath(path) {
  return Array.isArray(path) && path[0] === STYLE_ROOT;
}

export function inStyleView() {
  return Boolean(isStylePath(state.activePath) && !state.siteSearchView && !state.favoritesView && state.codex?.styleStamp);
}

/* 当前路径落在哪一层：root / parent / group */
export function styleLocation(path = state.activePath) {
  if (!styles || !isStylePath(path)) return null;
  const parent = path[1] ? styles.parents.find(p => p.name === path[1]) : null;
  const group = parent && path[2] ? styles.groups.find(g => g.parent === parent.index && g.name === path[2]) : null;
  if (group) return { level: 'group', parent, group };
  if (parent) return { level: 'parent', parent };
  return { level: 'root' };
}

export function artistOf(entry) {
  if (!styles || !Number.isInteger(entry?.styleArtist)) return null;
  return styles.artists[entry.styleArtist] || null;
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

export const heatOf = post => (post == null ? '' : post >= 1000 ? 'hot' : post >= 200 ? 'mid' : 'cold');
export const recOf = rank => (rank == null ? 'unknown' : rank === 1 ? 'high' : rank <= 10 ? 'mid' : 'low');
export const recText = rank => REC_TEXT[recOf(rank)];

export function formatPost(post) {
  return post == null ? 'post 未知' : `post ${post.toLocaleString('en-US')}`;
}

/* 画风分类视图里的卡片底行：小组页写 post 与辨识度，其它层再带上小组名 */
export function styleCardLine(entry) {
  if (!inStyleView()) return '';
  const artist = artistOf(entry);
  if (!artist) return '';
  const where = styleLocation();
  const parts = where?.level === 'group' ? [] : [groupOf(artist).name];
  parts.push(formatPost(artist.post), `辨识度${recText(artist.rank)}`);
  return parts.join(' · ');
}

export function styleFiltersActive() {
  return STYLE_FILTERS.some(filter => styleView[filter.key] !== '');
}

export function filterStyleEntries(list) {
  if (!styleFiltersActive()) return list;
  return list.filter(entry => {
    const artist = artistOf(entry);
    if (!artist) return false;
    if (styleView.heat && heatOf(artist.post) !== styleView.heat) return false;
    if (styleView.rec && recOf(artist.rank) !== styleView.rec) return false;
    if (styleView.light !== '' && String(artist.light) !== styleView.light) return false;
    if (styleView.color !== '' && String(artist.color) !== styleView.color) return false;
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
