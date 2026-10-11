import { state } from './state.js';
import { findCodexMeta } from './data.js';
import { atlasFavoriteStorageKeys, createCodexLookup } from './favorites-backup-core.js';
import { createStorageCoordinator, writeStorageTransaction } from './storage-coordinator.js';
import {
  BLOCKING_STORAGE_KEY, BLOCKING_WORD_LIMIT, BLOCKING_ENTRY_LIMIT,
  normalizeBlockedWord, normalizeBlockingPreferences, compileBlockedWords, positiveBlockingFields, matchBlockedWord,
} from './content-blocking-core.js';

export const BLOCKING_LOCK_KEY = BLOCKING_STORAGE_KEY + ':lock';
export const BLOCKING_SIGNAL_KEY = BLOCKING_STORAGE_KEY + ':signal';
const coordinator = createStorageCoordinator({ lockKey: BLOCKING_LOCK_KEY, signalKey: BLOCKING_SIGNAL_KEY });
let preferences = normalizeBlockingPreferences(null);
let compiled = [];
let hiddenKeys = new Set();
let entryMatches = new WeakMap();
let lookupSource = null;
let lookup = null;
const listeners = new Set();
let sequence = 0;

function install(value) {
  preferences = normalizeBlockingPreferences(value);
  compiled = compileBlockedWords(preferences.words);
  hiddenKeys = new Set(preferences.entries.map(item => item.key));
  entryMatches = new WeakMap();
}

function readPreferences(storage) {
  let raw;
  try { raw = storage.getItem(BLOCKING_STORAGE_KEY); }
  catch { return { error: '无法读取屏蔽清单，恢复本站的本地存储权限后重试' }; }
  if (raw === null) return { ok: true, raw, next: normalizeBlockingPreferences(null) };
  let value;
  try { value = JSON.parse(raw); }
  catch { return { error: '屏蔽清单无法读取，保留原数据并重新加载页面后重试' }; }
  if (value?.version !== 1) return { error: '屏蔽清单版本不受支持，更新页面后重试' };
  // 归一化只用于合法清单；不能把损坏字段裁掉后当成空底本保存。
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || (value.enabled !== undefined && typeof value.enabled !== 'boolean')
      || !Array.isArray(value.words) || value.words.length > BLOCKING_WORD_LIMIT
      || value.words.some(word => typeof word !== 'string' || !normalizeBlockedWord(word) || normalizeBlockedWord(word).length > 80)
      || !Array.isArray(value.entries) || value.entries.length > BLOCKING_ENTRY_LIMIT
      || value.entries.some(item => !item || typeof item !== 'object'
        || typeof item.key !== 'string' || !item.key || item.key.length > 500
        || ['codexId', 'title', 'codexTitle', 'rating'].some(key => item[key] !== undefined && typeof item[key] !== 'string')
        || (item.path !== undefined && (!Array.isArray(item.path) || item.path.some(part => typeof part !== 'string'))))) {
    return { error: '屏蔽清单无法读取，保留原数据并重新加载页面后重试' };
  }
  return { ok: true, raw, next: normalizeBlockingPreferences(value) };
}

export function loadContentBlocking() {
  let result;
  try { result = readPreferences(localStorage); }
  catch { result = { error: '无法读取屏蔽清单，恢复本站的本地存储权限后重试' }; }
  if (result.ok) install(result.next);
  return result;
}

export function getBlockingPreferences() {
  return { ...preferences, words: [...preferences.words], entries: preferences.entries.map(item => ({ ...item })) };
}

export function subscribeContentBlocking(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function receiveBlockingStorage(event) {
  try {
    if (event.storageArea !== localStorage || (event.key !== null && event.key !== BLOCKING_STORAGE_KEY)) return;
  } catch { return; }
  if (event.key === null || event.newValue === null) coordinator.release();
  if (loadContentBlocking().ok) listeners.forEach(listener => listener());
}

async function save(apply) {
  const result = await coordinator.run((storage, fence) => {
    const read = readPreferences(storage);
    if (!read.ok) return { ok: false, ...read };
    const changed = apply(read.next);
    if (changed.error) return { ok: false, ...changed };
    const next = normalizeBlockingPreferences(changed.next);
    const saved = writeStorageTransaction(storage, [
      { key: BLOCKING_STORAGE_KEY, value: JSON.stringify(next) },
      { key: BLOCKING_SIGNAL_KEY, value: JSON.stringify({
        rev: ++sequence, ...(fence ? { epoch: fence.epoch, nonce: fence.nonce } : {}),
      }) },
    ]);
    if (!saved.ok) return saved;
    install(next);
    for (const listener of listeners) {
      try { listener(); } catch (error) { console.warn('[content-blocking] 订阅者出错', error); }
    }
    return { ok: true, written: true, key: changed.key };
  });
  if (!result.ok) {
    const error = typeof result.error === 'string' ? result.error
      : result.reason === 'lock' ? '另一标签页正在修改屏蔽清单，重试一次'
        : result.reason === 'rollback' ? '屏蔽清单未能保存，重新加载页面检查清单后重试'
          : result.reason === 'quota' ? '屏蔽清单未保存：浏览器存储已满。在「浏览记录」里清空最近浏览，或在中转站清空「成品记录」后重试'
            : '屏蔽清单未保存：浏览器不允许本站保存数据';
    return { ...result, error };
  }
  return { ok: true, ...(result.key ? { key: result.key } : {}) };
}

export function contentBlockingKeys(entry) {
  const sourceId = entry?._srcCodexId || state.codex?.id;
  if (!sourceId || !entry?.id) return [];
  if (lookupSource !== state.codexes) {
    lookupSource = state.codexes;
    lookup = createCodexLookup(state.codexes || []);
  }
  return atlasFavoriteStorageKeys({ codexId: sourceId, entryId: entry.id }, lookup);
}

export function invalidateBlockingEntry(entry) {
  if (entry) entryMatches.delete(entry);
}

export function contentBlockReason(entry) {
  if (!entry || !preferences.enabled) return null;
  if (hiddenKeys.size && contentBlockingKeys(entry).some(key => hiddenKeys.has(key))) return { type: 'entry' };
  if (!compiled.length) return null;
  if (!entryMatches.has(entry)) entryMatches.set(entry, matchBlockedWord(positiveBlockingFields(entry), compiled));
  const word = entryMatches.get(entry);
  return word ? { type: 'word', word } : null;
}

export function isContentBlocked(entry) { return Boolean(contentBlockReason(entry)); }

export async function hideContentEntry(entry) {
  const keys = contentBlockingKeys(entry);
  if (!keys.length) return { error: '无法识别这张卡片的来源，刷新后重试' };
  const source = findCodexMeta(entry._srcCodexId || state.codex?.id) || state.codex;
  const record = { key: keys[0], codexId: source?.id || '', title: entry.title,
    codexTitle: source?.title || '', rating: entry.rating || entry.level || '', path: entry._srcPath || entry.path || [] };
  return save(current => {
    if (current.entries.some(item => keys.includes(item.key))) return { error: '这张卡片已在屏蔽清单中' };
    if (current.entries.length >= BLOCKING_ENTRY_LIMIT) return { error: '已达到 5000 张卡片上限，在屏蔽管理中恢复部分卡片后重试' };
    return { next: { ...current, entries: [record, ...current.entries] }, key: record.key };
  });
}

export function restoreContentEntry(key) {
  return save(current => ({ next: { ...current, entries: current.entries.filter(item => item.key !== key) } }));
}

export async function addBlockedWords(input) {
  const words = String(input || '').split(/[\n,，]+/).map(normalizeBlockedWord).filter(Boolean);
  if (!words.length) return { error: '填写要屏蔽的词或短语' };
  if (words.some(word => word.length > 80)) return { error: '每个词或短语最多 80 个字符' };
  return save(current => {
    const all = [...new Set([...current.words, ...words])];
    if (all.length > BLOCKING_WORD_LIMIT) return { error: '最多添加 100 个屏蔽词，移除部分词后重试' };
    if (all.length === current.words.length) return { error: '这些词已在屏蔽清单中' };
    return { next: { ...current, words: all } };
  });
}

export function removeBlockedWord(word) {
  return save(current => ({ next: { ...current, words: current.words.filter(item => item !== word) } }));
}
export function setContentBlockingEnabled(enabled) {
  return save(current => ({ next: { ...current, enabled: Boolean(enabled) } }));
}
