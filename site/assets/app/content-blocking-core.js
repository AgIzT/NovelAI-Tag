export const BLOCKING_STORAGE_KEY = 'fadian-content-blocking-v1';
export const BLOCKING_WORD_LIMIT = 100;
export const BLOCKING_ENTRY_LIMIT = 5000;

export function normalizeBlockedWord(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeBlockingPreferences(value) {
  const source = value && typeof value === 'object' && value.version === 1 ? value : {};
  const words = Array.isArray(source.words) ? source.words : [];
  const entries = Array.isArray(source.entries) ? source.entries : [];
  const seen = new Set();
  return {
    version: 1,
    enabled: source.enabled !== false,
    words: [...new Set(words.filter(word => typeof word === 'string').map(normalizeBlockedWord)
      .filter(word => word && word.length <= 80))].slice(0, BLOCKING_WORD_LIMIT),
    entries: entries.filter(item => {
      if (!item || typeof item.key !== 'string' || !item.key || item.key.length > 500 || seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    }).slice(0, BLOCKING_ENTRY_LIMIT).map(item => ({
      key: item.key,
      codexId: String(item.codexId || '').slice(0, 200),
      title: String(item.title || '未命名卡片').slice(0, 200),
      codexTitle: String(item.codexTitle || '').slice(0, 200),
      rating: String(item.rating || ''),
      path: Array.isArray(item.path) ? item.path.map(String) : [],
    })),
  };
}

export function compileBlockedWords(words) {
  return words.map(word => {
    const normalized = normalizeBlockedWord(word);
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 英文整词匹配；中文按短语匹配。下划线与空格等价，权重符号保持为边界。
    const start = /^[\p{Script=Latin}\p{N}]/u.test(normalized) ? '(^|[^\\p{Script=Latin}\\p{N}])' : '';
    const end = /[\p{Script=Latin}\p{N}]$/u.test(normalized) ? '(?=$|[^\\p{Script=Latin}\\p{N}])' : '';
    return { word: normalized, pattern: new RegExp(start + escaped + end, 'u') };
  });
}

export function positiveBlockingFields(entry) {
  const characters = items => (Array.isArray(items) ? items : []).map(item => item?.prompt || item?.positive || '');
  const images = Array.isArray(entry?.images) ? entry.images : [];
  // images[].rawTag 的数据契约是逐图正向 prompt；负面、备注和目录均不参与。
  return [entry?.title, entry?.tags, ...characters(entry?.characterPrompts),
    ...images.flatMap(item => typeof item === 'object'
      ? [item.prompt, item.positive, item.tags, item.rawTag || item.rawTags, ...characters(item.characterPrompts)] : [])]
    .filter(value => typeof value === 'string' && value.trim()).map(normalizeBlockedWord);
}

export function matchBlockedWord(fields, compiled) {
  return compiled.find(({ pattern }) => fields.some(text => pattern.test(text)))?.word || '';
}
