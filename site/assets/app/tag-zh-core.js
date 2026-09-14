/* tag 中文对照的纯计算：切段、查表键、分片查找。零 DOM，node 直测。
   查表键必须与 tools/build_tag_zh.py 的 tag_key 逐条一致，否则构建出来的译名前端查不到；
   两边共用 tools/fixtures/tag_zh_keys.json 做防漂移回归，改一侧必须同步另一侧。 */

export const TAG_ZH_SCHEMA = 1;
export const TAG_ZH_SOURCE_LABELS = { m: '人工校对', d: '社区词库', a: 'AI 机翻' };

const SEPARATOR = /(\r\n|\r|\n|,|，)/;
const WEIGHT_PREFIX = /^-?\d+(?:\.\d+)?::/;
const SD_WEIGHT_SUFFIX = /:\s*-?\d+(?:\.\d+)?$/;
const LATIN = /[a-z]/i;
const MAX_KEY_LENGTH = 300;
const LOOKUP_ORDER = ['m', 'd', 'a'];

function trimChars(text, chars) {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start])) start += 1;
  while (end > start && chars.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

function countChar(text, ch) {
  let n = 0;
  for (const c of text) if (c === ch) n += 1;
  return n;
}

/* 一段 tag 原文 → 查表键：剥掉 NAI 的 {} [] 与 1.2:: 权重、SD 的 (tag:1.2)，
   小写、下划线当空格、压空白。空、无英文字母、画师前缀和超长的一律返回空串（不查）。 */
export function tagZhKey(piece) {
  let text = String(piece ?? '').replace(/\\\(/g, '\u0001').replace(/\\\)/g, '\u0002');
  for (let i = 0; i < 12; i += 1) {
    const before = text;
    text = text.trim().replace(WEIGHT_PREFIX, '');
    if (text.endsWith('::')) text = text.slice(0, -2);
    text = trimChars(text, '{}[]"');
    while (text.startsWith('(') && countChar(text, '(') > countChar(text, ')')) text = text.slice(1);
    while (text.endsWith(')') && countChar(text, ')') > countChar(text, '(')) text = text.slice(0, -1);
    if (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1);
    text = text.replace(SD_WEIGHT_SUFFIX, '');
    if (text === before) break;
  }
  text = text.replace(/\u0001/g, '(').replace(/\u0002/g, ')');
  const key = text.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!key || !LATIN.test(key) || key.startsWith('artist:') || [...key].length > MAX_KEY_LENGTH) return '';
  return key;
}

const LEADING_MARKS = /^[\s{}[\]()]*(?:-?\d+(?:\.\d+)?::[\s{}[\]()]*)*/;
const WEIGHT_OPEN = /(-?\d+(?:\.\d+)?)::/g;

/* 按逗号 / 全角逗号 / 换行切成可渲染的段：lead 是段首空白，text 是 tag 原文（可带权重语法），
   sep 是紧跟的分隔符。拼回 lead + text + sep 就是原文，一个字符都不丢。
   weight 是作用在这个 tag 上的 NAI 数字权重（1.5::a, b:: 这种跨逗号的组也算进去），没有为 null；
   只有段首的「数字::」算开组，段内其余的 :: 一律当收组，免得把 year 2025:: 认成 2025 倍。 */
export function splitPromptPieces(value) {
  const parts = String(value ?? '').split(SEPARATOR);
  const pieces = [];
  let openWeight = null;
  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i] || '';
    const sep = parts[i + 1] || '';
    if (!body && !sep) continue;
    const lead = body.match(/^\s*/)[0];
    const text = body.slice(lead.length);
    const marks = text.match(LEADING_MARKS)[0];
    let weight = openWeight;
    for (const match of marks.matchAll(WEIGHT_OPEN)) {
      weight = Number(match[1]);
      openWeight = weight;
    }
    if (text.slice(marks.length).includes('::')) openWeight = null;
    pieces.push({ lead, text, sep, key: tagZhKey(text), weight });
  }
  return pieces;
}

function toMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
  return new Map(Object.entries(value).filter(([, zh]) => typeof zh === 'string' && zh.trim()));
}

/* 分片 JSON → { m, d, a: Map, shards: [书 id], source }；形态不对返回 null（当作没有对照表）。 */
export function normalizeTagZhShard(value) {
  if (!value || typeof value !== 'object' || value.schema !== TAG_ZH_SCHEMA) return null;
  return {
    m: toMap(value.m),
    d: toMap(value.d),
    a: toMap(value.a),
    shards: Array.isArray(value.shards) ? value.shards.map(String) : [],
    source: value.source && typeof value.source === 'object' ? value.source : null,
  };
}

/* 译名优先级：人工 > 词库 > AI；同级先查 core 再查书分片（两者的键本来就不重叠）。 */
export function lookupTagZh(shards, key) {
  if (!key || !Array.isArray(shards)) return null;
  for (const group of LOOKUP_ORDER) {
    for (const shard of shards) {
      const zh = shard?.[group]?.get(key);
      if (zh) return { zh, source: group };
    }
  }
  return null;
}

export function danbooruWikiUrl(key) {
  return `https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(String(key || '').trim().replace(/ /g, '_'))}`;
}
