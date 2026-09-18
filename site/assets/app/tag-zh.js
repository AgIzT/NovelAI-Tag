import { fetchDataJson } from '../data-source.js';
import { renderHighlightedText } from './search.js';
import {
  TAG_ZH_SOURCE_LABELS,
  danbooruWikiUrl,
  lookupTagZh,
  normalizeTagZhShard,
  splitPromptPieces,
} from './tag-zh-core.js';

/* ---------------- tag 中文对照（灯箱提示词下方的中文小字） ----------------
   偏好默认开，存 localStorage；对照表按需加载：core 全站高频 + 当前词条所属书的分片。
   译名只画在展示层，复制走的仍是词条原文，中文小字也选不中，拖选复制带不出来。 */

export const TAG_ZH_STORAGE_KEY = 'fadian-tag-zh';
const CORE_PATH = 'tag_zh/core.json';

const listeners = new Set();
const shardCache = new Map();   // 书 id → 已归一的分片；null = 该书没有分片
const shardLoads = new Map();   // 书 id → 在途 Promise
let coreShard;                  // undefined = 还没加载完；null = 当前数据版本没有对照表
let coreLoad = null;
let enabled = readTagZhEnabled();

export function readTagZhEnabled(storage) {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    return target?.getItem(TAG_ZH_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function isTagZhEnabled() {
  return enabled;
}

export function setTagZhEnabled(on) {
  const next = Boolean(on);
  try { globalThis.localStorage?.setItem(TAG_ZH_STORAGE_KEY, next ? '1' : '0'); } catch { /* 无痕模式等写不进也照常切换 */ }
  if (next === enabled) return;
  enabled = next;
  for (const listener of listeners) listener(enabled);
}

export function onTagZhChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* 对照表是否确定不可用（旧数据版本没有 tag_zh/，或文件损坏）。还没加载完时返回 false。 */
export function isTagZhUnavailable() {
  return coreShard === null;
}

function loadCore() {
  if (coreShard !== undefined) return Promise.resolve(coreShard);
  coreLoad ??= fetchDataJson(CORE_PATH)
    .then(normalizeTagZhShard)
    .catch(error => {
      console.warn('tag 中文对照表不可用，灯箱按原文显示。', error);
      return null;
    })
    .then(shard => {
      coreShard = shard;
      return shard;
    });
  return coreLoad;
}

function loadShard(codexId) {
  if (shardCache.has(codexId)) return Promise.resolve(shardCache.get(codexId));
  if (!shardLoads.has(codexId)) {
    shardLoads.set(codexId, fetchDataJson(`tag_zh/${codexId}.json`)
      .then(normalizeTagZhShard)
      .catch(() => null)
      .then(shard => {
        shardCache.set(codexId, shard);
        shardLoads.delete(codexId);
        return shard;
      }));
  }
  return shardLoads.get(codexId);
}

/* 同步取已就绪的分片组：undefined = 还在路上，null = 不可用，数组 = 可以直接渲染。 */
export function peekTagZh(codexId) {
  if (coreShard === undefined) return undefined;
  if (coreShard === null) return null;
  const id = String(codexId || '');
  const shard = shardCache.get(id);
  return shard ? [coreShard, shard] : [coreShard];
}

/* 这本书的对照表是不是已经全到齐了。core 有全站高频词，先用它出译名不用等分书表；
   分书表（长尾、整句）到货后调用方再重画一次补齐。 */
export function isTagZhComplete(codexId) {
  if (coreShard === undefined) return false;
  if (coreShard === null) return true;
  const id = String(codexId || '');
  return !id || !coreShard.shards.includes(id) || shardCache.has(id);
}

export async function loadTagZh(codexId) {
  const core = await loadCore();
  if (!core) return null;
  const id = String(codexId || '');
  if (id && core.shards.includes(id)) await loadShard(id);
  return peekTagZh(id);
}

function formatWeight(weight) {
  return String(weight).replace('-', '−');
}

/* 把一段提示词渲染成「英文 + 下方中文」的对照排版。整段一个译名都没有（比如纯画师串）
   时返回 false、不动元素，调用方照原文显示。
   - 有译名的 tag 装进盒子，逗号跟着进同一个盒子，免得折行时逗号落到下一行行首；
   - 没译名的（画师名、长尾）是普通行内片段，和原文一样能在词中间折行，不留空行；
   - 原文逗号后没空格时补一点视觉间距（不插字符，拖选复制仍是原文），有空格就不再叠加；
   - 换行符留在盒子外面，保住原文分行；负权重的 tag 译名前加「−」，免得把 −3::chibi 读成要 Q 版。 */
export function renderTagZhPrompt(element, text, { shards, terms = [] } = {}) {
  if (!element || !Array.isArray(shards)) return false;
  const pieces = splitPromptPieces(text);
  const hits = pieces.map(piece => lookupTagZh(shards, piece.key));
  if (!hits.some(Boolean)) return false;
  const fragment = document.createDocumentFragment();
  pieces.forEach((piece, index) => {
    if (piece.lead) fragment.append(piece.lead);
    const comma = piece.sep === ',' || piece.sep === '，';
    if (!piece.text.trim()) {
      fragment.append(piece.text + piece.sep);
      return;
    }
    const label = comma ? piece.text + piece.sep : piece.text;
    const hit = hits[index];
    let node;
    if (hit) {
      node = document.createElement('span');
      node.className = 'tag-zh-tok';
      node.dataset.tagZhKey = piece.key;
      node.dataset.tagZhSource = hit.source;
      const en = document.createElement('span');
      en.className = 'tag-zh-en';
      renderHighlightedText(en, label, terms);
      const zh = document.createElement('span');
      zh.className = 'tag-zh-zh';
      if (hit.source === 'a') zh.classList.add('is-ai');
      if (piece.weight !== null && piece.weight < 0) {
        node.dataset.tagZhWeight = String(piece.weight);
        zh.textContent = `−${hit.zh}`;
      } else {
        zh.textContent = hit.zh;
      }
      node.append(en, zh);
    } else {
      node = document.createElement('span');
      node.className = 'tag-zh-plain';
      renderHighlightedText(node, label, terms);
    }
    if (comma && !pieces[index + 1]?.lead) node.classList.add('tag-zh-gap');
    fragment.append(node);
    if (!comma && piece.sep) fragment.append(piece.sep);
  });
  element.replaceChildren(fragment);
  return true;
}

/* 点某个 tag：在所在提示词框下方给一行说明（译名、来源、Danbooru 维基）；再点同一个收起。 */
export function toggleTagZhDetail(box) {
  const pre = box?.closest('pre');
  if (!pre) return;
  let detail = pre.nextElementSibling?.classList.contains('tag-zh-detail') ? pre.nextElementSibling : null;
  const alreadyPicked = box.classList.contains('is-picked');
  pre.querySelectorAll('.tag-zh-tok.is-picked').forEach(node => node.classList.remove('is-picked'));
  if (alreadyPicked) {
    detail?.remove();
    return;
  }
  box.classList.add('is-picked');
  if (!detail) {
    detail = document.createElement('div');
    detail.className = 'tag-zh-detail';
    detail.setAttribute('role', 'status');
    pre.after(detail);
  }
  const key = box.dataset.tagZhKey || '';
  const source = box.dataset.tagZhSource || '';
  const weight = box.dataset.tagZhWeight || '';
  const zh = (box.querySelector('.tag-zh-zh')?.textContent || '').replace(/^−/, '');
  const name = document.createElement('span');
  name.className = 'tag-zh-detail-tag';
  name.textContent = key || box.querySelector('.tag-zh-en')?.textContent || '';
  const meaning = document.createElement('span');
  meaning.className = 'tag-zh-detail-zh';
  meaning.textContent = zh || '暂无译名';
  const parts = [name, meaning];
  if (weight) {
    const note = document.createElement('span');
    note.className = 'tag-zh-detail-weight';
    note.textContent = `负权重 ${formatWeight(weight)}：让画面远离这个特征`;
    parts.push(note);
  }
  if (source) {
    const label = document.createElement('span');
    label.className = `tag-zh-detail-src is-${source}`;
    label.textContent = source === 'a' ? `${TAG_ZH_SOURCE_LABELS.a} · 仅供参考` : TAG_ZH_SOURCE_LABELS[source];
    parts.push(label);
  }
  if (key && source !== 'a') {
    const link = document.createElement('a');
    link.href = danbooruWikiUrl(key);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Danbooru 维基';
    parts.push(link);
  }
  detail.replaceChildren(...parts);
}

export function clearTagZhDetails(root) {
  root?.querySelectorAll('.tag-zh-detail').forEach(node => node.remove());
}
