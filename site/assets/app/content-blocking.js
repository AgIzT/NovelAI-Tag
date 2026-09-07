import { state } from './state.js';
import { findCodexMeta } from './data.js';
import { atlasFavoriteStorageKeys, createCodexLookup } from './favorites-backup-core.js';
import {
  BLOCKING_STORAGE_KEY, BLOCKING_WORD_LIMIT, BLOCKING_ENTRY_LIMIT,
  normalizeBlockedWord, normalizeBlockingPreferences, compileBlockedWords, positiveBlockingFields, matchBlockedWord,
} from './content-blocking-core.js';

let preferences = normalizeBlockingPreferences(null);
let compiled = [];
let hiddenKeys = new Set();
let entryMatches = new WeakMap();
let lookupSource = null;
let lookup = null;
const listeners = new Set();

function install(value) {
  preferences = normalizeBlockingPreferences(value);
  compiled = compileBlockedWords(preferences.words);
  hiddenKeys = new Set(preferences.entries.map(item => item.key));
  entryMatches = new WeakMap();
}

export function loadContentBlocking() {
  try { install(JSON.parse(localStorage.getItem(BLOCKING_STORAGE_KEY) || 'null')); }
  catch { install(null); }
}

export function getBlockingPreferences() {
  return { ...preferences, words: [...preferences.words], entries: preferences.entries.map(item => ({ ...item })) };
}

export function subscribeContentBlocking(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function receiveBlockingStorage(event) {
  if (event.storageArea !== localStorage || (event.key !== null && event.key !== BLOCKING_STORAGE_KEY)) return;
  loadContentBlocking();
  listeners.forEach(listener => listener());
}

function save(next) {
  const normalized = normalizeBlockingPreferences(next);
  try { localStorage.setItem(BLOCKING_STORAGE_KEY, JSON.stringify(normalized)); }
  catch { return { error: '无法保存屏蔽清单，清空最近浏览或复制历史后重试' }; }
  install(normalized);
  listeners.forEach(listener => listener());
  return { ok: true };
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

export function hideContentEntry(entry) {
  const keys = contentBlockingKeys(entry);
  if (!keys.length) return { error: '无法识别这张卡片的来源，刷新后重试' };
  if (keys.some(key => hiddenKeys.has(key))) return { error: '这张卡片已在屏蔽清单中' };
  if (preferences.entries.length >= BLOCKING_ENTRY_LIMIT) return { error: '已达到 5000 张卡片上限，在屏蔽管理中恢复部分卡片后重试' };
  const source = findCodexMeta(entry._srcCodexId || state.codex?.id) || state.codex;
  const record = { key: keys[0], codexId: source?.id || '', title: entry.title,
    codexTitle: source?.title || '', rating: entry.rating || entry.level || '', path: entry._srcPath || entry.path || [] };
  return { ...save({ ...preferences, entries: [record, ...preferences.entries.filter(item => !keys.includes(item.key))] }), key: record.key };
}

export function restoreContentEntry(key) {
  return save({ ...preferences, entries: preferences.entries.filter(item => item.key !== key) });
}

export function addBlockedWords(input) {
  const words = String(input || '').split(/[\n,，]+/).map(normalizeBlockedWord).filter(Boolean);
  if (!words.length) return { error: '填写要屏蔽的词或短语' };
  if (words.some(word => word.length > 80)) return { error: '每个词或短语最多 80 个字符' };
  const all = [...new Set([...preferences.words, ...words])];
  if (all.length > BLOCKING_WORD_LIMIT) return { error: '最多添加 100 个屏蔽词，移除部分词后重试' };
  if (all.length === preferences.words.length) return { error: '这些词已在屏蔽清单中' };
  return save({ ...preferences, words: all });
}

export function removeBlockedWord(word) { return save({ ...preferences, words: preferences.words.filter(item => item !== word) }); }
export function setContentBlockingEnabled(enabled) { return save({ ...preferences, enabled: Boolean(enabled) }); }
