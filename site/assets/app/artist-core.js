/* 画师串拆解的纯计算：从提示词里认出 artist:xxx、算出各自的倍率、对到样张索引。零 DOM，node 直测。
   画师名归一建立在 tag-zh-core.js 的 bareTag 上，与 tools/build_artist_index.py 的 artist_key 一致。 */

import { bareTag, splitPromptPieces } from './tag-zh-core.js';

export const ARTIST_INDEX_SCHEMA = 1;
export const ARTIST_VERSIONS = ['n45', 'n5'];
export const ARTIST_VERSION_LABELS = { n45: 'v4.5', n5: 'v5' };

/* NAI 的 {} 每层 ×1.05、[] 每层 ÷1.05。 */
const BRACE_STEP = 1.05;

function countChar(text, ch) {
  let n = 0;
  for (const c of text) if (c === ch) n += 1;
  return n;
}

/* 一段 tag 原文 → 归一后的画师名；不是 artist: 前缀返回空串。
   前缀的冒号先换成占位符，免得 artist:382 这种纯数字名被当成 SD 权重剥掉。 */
const ARTIST_PREFIX = /artist\s*:/i;
const PREFIX_MARK = 'artist\u0003';
export function artistKey(piece) {
  const text = bareTag(String(piece ?? '').replace(ARTIST_PREFIX, PREFIX_MARK));
  return text.startsWith(PREFIX_MARK) ? text.slice(PREFIX_MARK.length).trim() : '';
}

/* 提示词里常把「ie (raarami)」写成「ie(raarami)」，精确对不上时用去掉全部空白的名字兜底。 */
export function compactArtistKey(name) {
  return String(name || '').replace(/\s+/g, '');
}

/* 提示词里的画师，按第一次出现的顺序去重。weight 是作用在它身上的倍率：
   NAI 数字权重（1.5::…:: 组也算）× 1.05^花括号层数 ÷ 1.05^方括号层数；括号跨逗号时按所在层数算。 */
export function promptArtists(text) {
  const found = new Map();
  let curly = 0;
  let square = 0;
  for (const piece of splitPromptPieces(text)) {
    const raw = piece.text;
    const opensCurly = countChar(raw, '{');
    const opensSquare = countChar(raw, '[');
    const level = (curly + opensCurly) - (square + opensSquare);
    curly = Math.max(0, curly + opensCurly - countChar(raw, '}'));
    square = Math.max(0, square + opensSquare - countChar(raw, ']'));
    const name = artistKey(raw);
    if (!name || found.has(name)) continue;
    found.set(name, { name, weight: (piece.weight ?? 1) * BRACE_STEP ** level });
  }
  return [...found.values()];
}

/* 倍率显示：1 倍不标；其余保留两位小数后去掉多余的 0。 */
export function formatArtistWeight(weight) {
  if (!Number.isFinite(weight) || Math.abs(weight - 1) < 0.005) return '';
  return `×${Number(weight.toFixed(2))}`;
}

function normalizeSample(record, version, paths) {
  if (!Array.isArray(record) || typeof record[0] !== 'string' || !record[0]) return null;
  const [entryId, image, assetRev, pathIndex, assetCodexId, count] = record;
  return {
    version,
    entryId,
    image: image || `${entryId}.jpg`,
    assetRev: assetRev || '',
    path: Array.isArray(paths[pathIndex]) ? paths[pathIndex].map(String) : [],
    assetCodexId: assetCodexId || '',
    count: Number.isInteger(count) && count > 1 ? count : 1,
  };
}

/* 索引 JSON → { books: {n45, n5}, samples: {n45: Map, n5: Map}, compact: {…}, codexModel: Map }；
   形态不对返回 null（当作没有索引，整栏不显示）。 */
export function normalizeArtistIndex(value) {
  if (!value || typeof value !== 'object' || value.schema !== ARTIST_INDEX_SCHEMA) return null;
  const books = {};
  const samples = {};
  const compact = {};
  for (const version of ARTIST_VERSIONS) {
    const info = value.versions?.[version];
    const book = String(info?.book || '');
    const paths = Array.isArray(info?.paths) ? info.paths : [];
    const map = new Map();
    const loose = new Map();
    if (book && info?.samples && typeof info.samples === 'object') {
      for (const [name, record] of Object.entries(info.samples)) {
        const sample = normalizeSample(record, version, paths);
        if (!sample) continue;
        map.set(name, sample);
        if (!loose.has(compactArtistKey(name))) loose.set(compactArtistKey(name), sample);
      }
    }
    books[version] = book;
    samples[version] = map;
    compact[version] = loose;
  }
  const codexModel = new Map(Object.entries(value.codexModel || {})
    .filter(([, version]) => ARTIST_VERSIONS.includes(version)));
  return { books, samples, compact, codexModel };
}

export function findArtistSample(index, version, name) {
  if (!index || !ARTIST_VERSIONS.includes(version)) return null;
  return index.samples[version].get(name) || index.compact[version].get(compactArtistKey(name)) || null;
}

export function otherArtistVersion(version) {
  return version === 'n45' ? 'n5' : 'n45';
}

/* 一条提示词在某个版本下的拆解结果：每位画师取该版样张，没有就取另一版（tile.fallback = true），
   两版都没有的进 missing。skipEntry 是当前词条自己（画师词典里的单画师词条不把自己列成样张）。
   bothVersions 表示至少有一位画师两版都有样张，版本切换才有意义。 */
export function resolveArtistTiles(index, artists, version, { skipEntry = null } = {}) {
  const tiles = [];
  const missing = [];
  let bothVersions = false;
  const usable = (sample) => sample
    && !(skipEntry && index.books[sample.version] === skipEntry.codexId && sample.entryId === skipEntry.entryId);
  for (const artist of artists) {
    const own = findArtistSample(index, version, artist.name);
    const other = findArtistSample(index, otherArtistVersion(version), artist.name);
    if (usable(own) && usable(other)) bothVersions = true;
    const sample = usable(own) ? own : (usable(other) ? other : null);
    if (sample) tiles.push({ ...artist, sample, fallback: sample.version !== version });
    else missing.push(artist);
  }
  return { tiles, missing, bothVersions };
}
