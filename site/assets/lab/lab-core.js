/* 画风实验台的纯计算：画风串表归一、热度与搭档统计、抽卡、找「一起出现过」的串、网址编码与输出串。
   零 DOM，node 直测。画风串表由 tools/build_artist_index.py 生成（artist_strings.json）。 */

import { ARTIST_VERSIONS, findArtistSample } from '../app/artist-core.js';

export const LAB_DEFAULT_SIZE = 6;
export const LAB_MAX_SIZE = 40;
export const LAB_WEIGHT_MIN = 0.1;
export const LAB_WEIGHT_MAX = 2.5;
export const LAB_WEIGHT_STEP = 0.1;
/* 抽卡权重 = 出现在几条画风串里 + 这个底数：没进过画风串的冷门画师也有机会抽到，但不压过常用的。 */
const COLD_BASE = 0.5;
/* 有锁住的牌时，空位按这个比例从锁住画师的常见搭档里抽，其余照常按热度抽，免得越抽越窄。 */
const PARTNER_SHARE = 0.65;

export function roundWeight(weight) {
  const value = Number(weight);
  if (!Number.isFinite(value) || Math.abs(value - 1) < 0.005) return 1;
  return Math.round(value * 100) / 100;
}

export function clampWeight(weight) {
  return roundWeight(Math.min(LAB_WEIGHT_MAX, Math.max(LAB_WEIGHT_MIN, Number(weight) || 1)));
}

function member(raw, artists) {
  const [index, weight] = Array.isArray(raw) ? raw : [raw, 1];
  const name = artists[index];
  return typeof name === 'string' && name ? { name, weight: roundWeight(weight) } : null;
}

/* 画风串表 JSON → { n45: [...], n5: [...] }，每条 { members: [{name, weight}], rep }；
   rep 是代表作 { codexId, entryId, image, assetRev, assetCodexId, images }，没有常规级配图时为 null。
   形态不对返回 null。 */
export function normalizeArtistStrings(value) {
  if (!value || typeof value !== 'object' || value.schema !== 1) return null;
  const out = {};
  for (const version of ARTIST_VERSIONS) {
    const info = value.versions?.[version] || {};
    const artists = Array.isArray(info.artists) ? info.artists : [];
    const books = Array.isArray(info.books) ? info.books : [];
    out[version] = (Array.isArray(info.strings) ? info.strings : []).map(record => {
      if (!Array.isArray(record) || !Array.isArray(record[0])) return null;
      const members = record[0].map(raw => member(raw, artists)).filter(Boolean);
      if (members.length < 2) return null;
      const [, bookIndex, entryId, image, assetRev, assetCodexId, images] = record;
      const codexId = typeof books[bookIndex] === 'string' ? books[bookIndex] : '';
      const rep = codexId && typeof entryId === 'string' && entryId
        ? {
          codexId,
          entryId,
          image: image || `${entryId}.jpg`,
          assetRev: assetRev || '',
          assetCodexId: assetCodexId || '',
          images: Number.isInteger(images) && images > 0 ? images : 1,
        }
        : null;
      return { members, rep };
    }).filter(Boolean);
  }
  return out;
}

/* 同一位画师在不同地方写法可能略有出入（ie(raarami) / ie (raarami)）。比对、统计时统一换成样张索引里的名字；
   牌组和输出里保留原写法。 */
export function canonicalArtist(index, version, name) {
  return findArtistSample(index, version, name)?.name || name;
}

/* 热度（出现在几条画风串里）与搭档（两人同串的条数），名字都换成样张索引里的写法。 */
export function buildArtistStats(index, version, strings) {
  const popularity = new Map();
  const partners = new Map();
  const canonical = new Map();
  const nameOf = name => {
    if (!canonical.has(name)) canonical.set(name, canonicalArtist(index, version, name));
    return canonical.get(name);
  };
  for (const string of strings || []) {
    const names = [...new Set(string.members.map(item => nameOf(item.name)))];
    for (const name of names) popularity.set(name, (popularity.get(name) || 0) + 1);
    for (const a of names) {
      let row = partners.get(a);
      if (!row) partners.set(a, row = new Map());
      for (const b of names) if (a !== b) row.set(b, (row.get(b) || 0) + 1);
    }
  }
  return { popularity, partners, nameOf };
}

function pickWeighted(entries, random) {
  let total = 0;
  for (const [, weight] of entries) total += weight;
  if (!(total > 0)) return null;
  let roll = random() * total;
  for (const [name, weight] of entries) {
    roll -= weight;
    if (roll < 0) return name;
  }
  return entries.at(-1)?.[0] ?? null;
}

/* 抽一位：exclude 里的不抽。有 locked 时按 PARTNER_SHARE 的概率从它们的搭档里抽（按同串条数加权），
   否则按热度加权；recent 里的先避开，整池都抽过了才放开。 */
export function drawArtist({ pool, stats, locked = [], exclude = new Set(), recent = new Set(), random = Math.random }) {
  const nameOf = stats.nameOf || (name => name);
  const excluded = new Set([...exclude].map(nameOf));
  const allowed = name => !excluded.has(name);
  if (locked.length && random() < PARTNER_SHARE) {
    const scores = new Map();
    for (const name of locked) {
      for (const [partner, count] of stats.partners.get(nameOf(name)) || []) {
        if (pool.has(partner) && allowed(partner) && !recent.has(partner)) {
          scores.set(partner, (scores.get(partner) || 0) + count);
        }
      }
    }
    const picked = pickWeighted([...scores], random);
    if (picked) return picked;
  }
  const weighted = fresh => [...pool].filter(name => allowed(name) && (!fresh || !recent.has(name)))
    .map(name => [name, (stats.popularity.get(name) || 0) + COLD_BASE]);
  return pickWeighted(weighted(true), random) || pickWeighted(weighted(false), random);
}

/* 换掉没锁的牌（only 给定时只换那几格），返回新牌组；新抽的牌倍率回到 1。 */
export function rerollSlots(slots, { pool, stats, recent = new Set(), only = null, random = Math.random }) {
  const next = slots.map(slot => ({ ...slot }));
  const replace = new Set(next.map((slot, i) => i).filter(i => (only ? only.includes(i) : !next[i].locked)));
  const locked = next.filter((slot, i) => !replace.has(i)).map(slot => slot.name);
  const exclude = new Set(locked);
  for (const i of replace) exclude.add(next[i].name);
  for (const i of replace) {
    const name = drawArtist({ pool, stats, locked, exclude, recent, random });
    if (!name) continue;
    next[i] = { name, weight: 1, locked: false };
    exclude.add(name);
  }
  return next;
}

/* 至少含其中两位的画风串：含得多的在前；同样多时整串位数少的在前（更接近这一组），再按配图数。只要有代表作的。 */
export function matchStrings(strings, names, nameOf = name => name) {
  const wanted = new Set(names.map(nameOf));
  if (wanted.size < 2) return [];
  const matches = [];
  for (const string of strings || []) {
    if (!string.rep) continue;
    const overlap = [...new Set(string.members.map(item => nameOf(item.name)))].filter(name => wanted.has(name));
    if (overlap.length >= 2) matches.push({ string, overlap });
  }
  return matches.sort((a, b) => b.overlap.length - a.overlap.length
    || a.string.members.length - b.string.members.length
    || b.string.rep.images - a.string.rep.images);
}

/* NAI 写法的画风串：倍率 1 写 artist:x，其余写 w::artist:x:: */
export function composeArtistString(slots) {
  return slots.filter(slot => slot.name).map(slot => {
    const weight = roundWeight(slot.weight);
    return weight === 1 ? `artist:${slot.name}` : `${weight}::artist:${slot.name}::`;
  }).join(', ');
}

/* 网址里的牌组：a=名字*倍率|…，锁住的在名字前加 !；倍率 1 省略。 */
export function encodeBoard(slots) {
  return slots.filter(slot => slot.name).map(slot => {
    const weight = roundWeight(slot.weight);
    return `${slot.locked ? '!' : ''}${slot.name}${weight === 1 ? '' : `*${weight}`}`;
  }).join('|');
}

export function decodeBoard(value) {
  const seen = new Set();
  const slots = [];
  for (const raw of String(value || '').split('|')) {
    let text = raw.trim();
    if (!text) continue;
    const locked = text.startsWith('!');
    if (locked) text = text.slice(1);
    const star = text.lastIndexOf('*');
    let weight = 1;
    if (star > 0 && /^-?\d+(?:\.\d+)?$/.test(text.slice(star + 1))) {
      weight = clampWeight(text.slice(star + 1));
      text = text.slice(0, star);
    }
    const name = text.trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    slots.push({ name, weight, locked });
    if (slots.length >= LAB_MAX_SIZE) break;
  }
  return slots;
}

export function normalizeLabVersion(value, fallback = 'n5') {
  return ARTIST_VERSIONS.includes(value) ? value : fallback;
}
