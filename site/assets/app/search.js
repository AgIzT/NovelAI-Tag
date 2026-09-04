import { state } from './state.js';
import { entryImages, hasEntryImage } from './media.js';
import { isFav } from './favorites.js';
import { encodePathCode } from './path-code.js';

export const SEARCH_TEXT_CONDITION_LIMIT = 10;

const searchableTextCache = new WeakMap();
const searchFieldCache = new WeakMap();
const filterNeedleCache = new WeakMap();
const entryDirectoryCodesCache = new WeakMap();
const TEXT_FIELDS = new Set([
  'default',
  'title',
  'prompt',
  'negative',
  'note',
  'raw',
  'author',
  'codex',
  'type',
  'path',
]);
const FIELD_ALIASES = new Map(Object.entries({
  default: 'default',
  title: 'title',
  '标题': 'title',
  prompt: 'prompt',
  prompts: 'prompt',
  tag: 'prompt',
  tags: 'prompt',
  '标签': 'prompt',
  '正向': 'prompt',
  '提示词': 'prompt',
  negative: 'negative',
  neg: 'negative',
  '负面': 'negative',
  '负面词': 'negative',
  note: 'note',
  '备注': 'note',
  raw: 'raw',
  rawtag: 'raw',
  rawtags: 'raw',
  '原始': 'raw',
  '原始词': 'raw',
  author: 'author',
  '作者': 'author',
  codex: 'codex',
  book: 'codex',
  source: 'codex',
  '法典': 'codex',
  '书': 'codex',
  type: 'type',
  '类型': 'type',
  path: 'path',
  '路径': 'path',
  '目录': 'path',
  has: 'has',
  image: 'has',
  '图片': 'has',
  fav: 'fav',
  favorite: 'fav',
  favourite: 'fav',
  '收藏': 'fav',
  dir: 'directory',
  directory: 'directory',
}));
const HAS_VALUES = new Map([
  ['image', true], ['img', true], ['true', true], ['yes', true], ['1', true], ['有图', true], ['有', true], ['是', true],
  ['noimage', false], ['none', false], ['false', false], ['no', false], ['0', false], ['无图', false], ['无', false], ['否', false],
]);
const FAV_VALUES = new Map([
  ['true', true], ['yes', true], ['1', true], ['收藏', true], ['已收藏', true], ['是', true],
  ['false', false], ['no', false], ['0', false], ['未收藏', false], ['否', false],
]);
const TYPE_VALUES = new Map([
  ['codex', 'codex'], ['法典', 'codex'],
  ['string', 'string'], ['画风', 'string'], ['画风串', 'string'],
  ['composition', 'composition'], ['构图', 'composition'], ['服装', 'composition'], ['场景', 'composition'],
  ['pack', 'pack'], ['图包', 'pack'], ['精选图包', 'pack'],
]);

function normalizeInput(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

function normalizeSearchText(value) {
  return normalizeInput(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function canonicalField(value) {
  return FIELD_ALIASES.get(normalizeSearchText(value)) || '';
}

function searchIssue(code, message, value = '') {
  return { code, message, value: String(value ?? '') };
}

function characterPromptText(entry) {
  return (entry?.characterPrompts || [])
    .map(item => item?.prompt)
    .filter(Boolean)
    .join('\n');
}

function characterNegativeText(entry) {
  return (entry?.characterPrompts || [])
    .map(item => item?.negative)
    .filter(Boolean)
    .join('\n');
}

function rawTagText(entry) {
  const imageRawTags = entryImages(entry || {}).flatMap(image => [image?.rawTag, image?.rawTags]);
  return [entry?.rawTags, entry?.rawTag, ...imageRawTags].filter(Boolean).join('\n');
}

function entryActualPath(entry) {
  return Array.isArray(entry?._srcPath) ? entry._srcPath : (entry?.path || []);
}

function cachedSearchField(entry, field) {
  if (field === 'default') return searchableText(entry);
  let cached = searchFieldCache.get(entry);
  if (!cached) {
    cached = Object.create(null);
    searchFieldCache.set(entry, cached);
  }
  if (Object.prototype.hasOwnProperty.call(cached, field)) return cached[field];
  let value = '';
  if (field === 'title') value = normalizeSearchText(entry?.title);
  else if (field === 'prompt') value = normalizeSearchText([entry?.tags, characterPromptText(entry)].filter(Boolean).join('\n'));
  else if (field === 'negative') {
    value = normalizeSearchText([entry?.negative, characterNegativeText(entry)].filter(Boolean).join('\n'));
  } else if (field === 'note') value = normalizeSearchText(entry?.note);
  else if (field === 'raw') value = normalizeSearchText(rawTagText(entry));
  else if (field === 'path') value = normalizeSearchText(entryActualPath(entry).join('/'));
  cached[field] = value;
  return value;
}

/** 默认召回文本：只含标题、tags 与角色正向 prompt。 */
export function searchableText(entry) {
  const cached = searchableTextCache.get(entry);
  if (cached !== undefined) return cached;
  const title = normalizeSearchText(entry?.title);
  const prompt = normalizeSearchText([entry?.tags, characterPromptText(entry)].filter(Boolean).join('\n'));
  const text = [title, prompt].filter(Boolean).join('\n');
  searchableTextCache.set(entry, text);
  let fields = searchFieldCache.get(entry);
  if (!fields) {
    fields = Object.create(null);
    searchFieldCache.set(entry, fields);
  }
  fields.title = title;
  fields.prompt = prompt;
  return text;
}

export function invalidateSearchableText(entry) {
  if (!entry || (typeof entry !== 'object' && typeof entry !== 'function')) return false;
  const deletedDefault = searchableTextCache.delete(entry);
  const deletedFields = searchFieldCache.delete(entry);
  const deletedDirectories = entryDirectoryCodesCache.delete(entry);
  return deletedDefault || deletedFields || deletedDirectories;
}

function scanQuery(input) {
  const source = normalizeInput(input);
  const tokens = [];
  let buf = '';
  let quote = '';
  let quoted = false;
  let quotedAtStart = false;
  let quotePrefix = '';
  for (const ch of source) {
    if (quote) {
      if (ch === quote) quote = '';
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (!quoted) {
        quotedAtStart = buf.length === 0;
        quotePrefix = buf;
      }
      quote = ch;
      quoted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf || quoted) {
        tokens.push({ value: buf, quoted, quotedAtStart, quotePrefix });
        buf = '';
        quoted = false;
        quotedAtStart = false;
        quotePrefix = '';
      }
      continue;
    }
    buf += ch;
  }
  if (buf || quoted) tokens.push({ value: buf, quoted, quotedAtStart, quotePrefix });
  return {
    tokens,
    issue: quote
      ? searchIssue('unclosed_quote', '引号没有闭合，请补全后再搜索', source)
      : null,
  };
}

export function splitQueryTokens(input) {
  return scanQuery(input).tokens.map(token => token.value);
}

function cleanFilterValue(value) {
  const raw = normalizeInput(value).trim();
  if (!raw) return { value: '', issue: null };
  const first = raw[0];
  if (first !== '"' && first !== "'") return { value: raw, issue: null };
  if (raw.length < 2 || raw.at(-1) !== first) {
    return { value: '', issue: searchIssue('unclosed_quote', '筛选值的引号没有闭合', raw) };
  }
  return { value: raw.slice(1, -1).trim(), issue: null };
}

function normalizeFilterObject(filter) {
  if (!filter || typeof filter !== 'object') {
    return { filter: null, issue: searchIssue('invalid_filter', '筛选条件格式无效') };
  }
  const field = filter.field === 'directory' ? 'directory' : canonicalField(filter.field);
  if (!field) {
    return { filter: null, issue: searchIssue('unknown_filter', `未知筛选字段：${filter.field || ''}`, filter.field) };
  }
  if (field === 'directory') {
    if (filter.op && filter.op !== 'include') {
      return { filter: null, issue: searchIssue('invalid_operator', '精确目录筛选只能使用包含操作') };
    }
    const codexId = String(filter.codexId || '').trim();
    const pathCode = normalizeSearchText(filter.pathCode);
    if (!codexId || !pathCode) {
      return { filter: null, issue: searchIssue('empty_filter', '精确目录筛选缺少法典或目录短码') };
    }
    return {
      filter: { field: 'directory', op: 'include', value: '', codexId, pathCode },
      issue: null,
    };
  }
  const op = TEXT_FIELDS.has(field)
    ? (filter.op === 'exclude' ? 'exclude' : 'include')
    : 'is';
  if (field === 'has') {
    const key = typeof filter.value === 'boolean' ? filter.value : HAS_VALUES.get(normalizeSearchText(filter.value));
    if (typeof key !== 'boolean') {
      return { filter: null, issue: searchIssue('invalid_enum', '图片筛选只能是“有图”或“无图”', filter.value) };
    }
    return { filter: { field, op, value: key }, issue: null };
  }
  if (field === 'fav') {
    const key = typeof filter.value === 'boolean' ? filter.value : FAV_VALUES.get(normalizeSearchText(filter.value));
    if (typeof key !== 'boolean') {
      return { filter: null, issue: searchIssue('invalid_enum', '收藏筛选只能是“已收藏”或“未收藏”', filter.value) };
    }
    return { filter: { field, op, value: key }, issue: null };
  }
  const value = String(filter.value ?? '').trim();
  if (!value) {
    return { filter: null, issue: searchIssue('empty_filter', '筛选条件缺少值', filter.field) };
  }
  if (field === 'type') {
    const type = TYPE_VALUES.get(normalizeSearchText(value));
    if (!type) {
      return { filter: null, issue: searchIssue('invalid_enum', '类型只能是法典、画风、构图或图包', value) };
    }
    return { filter: { field, op, value: type }, issue: null };
  }
  return { filter: { field, op, value }, issue: null };
}

function parseFilterToken(rawValue, { unknownAsText = false, quoted = false } = {}) {
  const raw = normalizeInput(rawValue).trim();
  if (!raw) {
    return { filter: null, issue: searchIssue('empty_filter', '筛选条件不能为空', rawValue), unknown: false };
  }
  const excluded = raw.startsWith('-');
  const body = excluded ? raw.slice(1) : raw;
  const colon = body.indexOf(':');
  if (colon === -1) {
    if (unknownAsText && excluded) {
      const value = body.trim();
      return value
        ? { filter: { field: 'default', op: 'exclude', value }, issue: null, unknown: false }
        : { filter: null, issue: searchIssue('empty_filter', '排除条件缺少值', raw), unknown: false };
    }
    return unknownAsText
      ? { filter: null, issue: null, unknown: true }
      : { filter: null, issue: searchIssue('invalid_filter', '筛选条件应为“字段:值”', raw), unknown: false };
  }
  const rawField = body.slice(0, colon).trim();
  const field = canonicalField(rawField);
  if (!field) {
    return unknownAsText
      ? { filter: null, issue: null, unknown: true }
      : { filter: null, issue: searchIssue('unknown_filter', `未知筛选字段：${rawField}`, raw), unknown: false };
  }
  const remainder = body.slice(colon + 1);
  if (field === 'directory') {
    if (excluded) {
      return { filter: null, issue: searchIssue('invalid_operator', '精确目录筛选不能使用排除操作', raw), unknown: false };
    }
    const splitAt = remainder.indexOf(':');
    const codexId = splitAt === -1 ? '' : remainder.slice(0, splitAt).trim();
    const pathCode = splitAt === -1 ? '' : remainder.slice(splitAt + 1).trim();
    const result = normalizeFilterObject({ field, codexId, pathCode });
    return { ...result, unknown: false };
  }
  const cleaned = quoted ? { value: remainder.trim(), issue: null } : cleanFilterValue(remainder);
  if (cleaned.issue) return { filter: null, issue: cleaned.issue, unknown: false };
  if (!cleaned.value) {
    return { filter: null, issue: searchIssue('empty_filter', `${rawField} 筛选缺少值`, raw), unknown: false };
  }
  if ((field === 'has' || field === 'fav') && excluded) {
    return { filter: null, issue: searchIssue('invalid_operator', `${rawField} 筛选不能使用排除操作`, raw), unknown: false };
  }
  const result = normalizeFilterObject({
    field,
    op: excluded ? 'exclude' : 'include',
    value: cleaned.value,
  });
  return { ...result, unknown: false };
}

/** 解析单个 repeated `f` 值，并同时返回可展示的错误。 */
export function parseSearchFilter(value) {
  const parsed = typeof value === 'object' && value !== null
    ? normalizeFilterObject(value)
    : parseFilterToken(value);
  const issues = parsed.issue ? [parsed.issue] : [];
  return {
    filter: parsed.filter || null,
    issues,
    serialized: parsed.filter ? serializeSearchFilter(parsed.filter) : String(value ?? ''),
  };
}

export function serializeSearchFilter(filter) {
  const parsed = normalizeFilterObject(filter);
  if (!parsed.filter) return '';
  const normalized = parsed.filter;
  if (normalized.field === 'directory') {
    return `dir:${normalized.codexId}:${normalized.pathCode}`;
  }
  if (normalized.field === 'has') return `has:${normalized.value ? 'image' : 'noimage'}`;
  if (normalized.field === 'fav') return `fav:${normalized.value ? 'true' : 'false'}`;
  return `${normalized.op === 'exclude' ? '-' : ''}${normalized.field}:${normalized.value}`;
}

function filterIdentity(filter) {
  if (filter.field === 'directory') {
    return `directory\u0000${normalizeSearchText(filter.codexId)}\u0000${normalizeSearchText(filter.pathCode)}`;
  }
  return `${filter.field}\u0000${filter.op}\u0000${normalizeSearchText(filter.value)}`;
}

function filterConflictIdentity(filter) {
  if (!TEXT_FIELDS.has(filter.field)) return '';
  return `${filter.field}\u0000${normalizeSearchText(filter.value)}`;
}

function appendFilter(filter, filters, seen, conflicts, issues) {
  const identity = filterIdentity(filter);
  if (seen.has(identity)) return false;
  const conflictIdentity = filterConflictIdentity(filter);
  if (conflictIdentity) {
    const previous = conflicts.get(conflictIdentity);
    if (previous && previous !== filter.op) {
      issues.push(searchIssue('conflicting_filter', '同一个条件不能同时包含和排除', filter.value));
    } else {
      conflicts.set(conflictIdentity, filter.op);
    }
  }
  if (filter.field === 'has' || filter.field === 'fav' || filter.field === 'directory') {
    const previous = filters.find(candidate => candidate.field === filter.field);
    if (previous && filterIdentity(previous) !== identity) {
      issues.push(searchIssue('conflicting_filter', `${filter.field === 'has' ? '图片' : filter.field === 'fav' ? '收藏' : '目录'}筛选存在冲突`, serializeSearchFilter(filter)));
    }
  }
  seen.add(identity);
  filters.push(filter);
  return true;
}

export function parseSearchFilters(values = []) {
  const inputs = values === null || values === undefined
    ? []
    : (Array.isArray(values) ? values : [values]);
  const filters = [];
  const issues = [];
  const filterValues = [];
  const seen = new Set();
  const conflicts = new Map();
  for (const input of inputs) {
    const parsed = parseSearchFilter(input);
    issues.push(...parsed.issues);
    if (!parsed.filter) {
      // 非法值必须留在地址栏/状态里，避免下一次同步悄悄变成宽泛搜索。
      filterValues.push(String(input ?? ''));
      continue;
    }
    if (appendFilter(parsed.filter, filters, seen, conflicts, issues)) {
      filterValues.push(serializeSearchFilter(parsed.filter));
    }
  }
  return { filters, issues, filterValues };
}

export function serializeSearchFilters(filters = []) {
  const out = [];
  const seen = new Set();
  for (const input of Array.isArray(filters) ? filters : [filters]) {
    const parsed = parseSearchFilter(input);
    if (!parsed.filter) continue;
    const serialized = serializeSearchFilter(parsed.filter);
    const identity = filterIdentity(parsed.filter);
    if (!serialized || seen.has(identity)) continue;
    seen.add(identity);
    out.push(serialized);
  }
  return out;
}

function queryTermsFromToken(token) {
  if (token.quoted) {
    const value = normalizeSearchText(token.value);
    return value ? [value] : [];
  }
  return String(token.value || '')
    .split(/[\s,，、;；]+/)
    .map(normalizeSearchText)
    .filter(Boolean);
}

function uniqueTerms(terms) {
  const seen = new Set();
  return terms.filter(term => {
    if (!term || seen.has(term)) return false;
    seen.add(term);
    return true;
  });
}

function highlightOrder(terms) {
  return [...new Set(terms)].sort((left, right) => right.length - left.length);
}

function formatQueryToken(token) {
  const value = String(token.value || '');
  return token.quoted || /\s/.test(value)
    ? `"${value.replace(/"/g, '\\"')}"`
    : value;
}

function applyLegacyPlanFields(plan) {
  const last = field => [...plan.filters].reverse().find(filter => filter.field === field);
  const pathFilter = last('path');
  plan.path = pathFilter
    ? String(pathFilter.value).split('/').map(segment => segment.trim()).filter(Boolean)
    : null;
  plan.hasImage = last('has')?.value ?? null;
  plan.fav = last('fav')?.value ?? null;
  plan.author = normalizeSearchText(last('author')?.value);
  plan.codex = normalizeSearchText(last('codex')?.value);
  plan.type = normalizeSearchText(last('type')?.value);
  return plan;
}

/**
 * 把输入框 `q` 与 repeated `f` 编译成统一 SearchPlan。
 * SearchFilter: { field, op, value, codexId?, pathCode? }
 */
export function parseSearchQuery(raw, filterValues = []) {
  const rawInput = String(raw ?? '').trim();
  const input = normalizeInput(rawInput).trim();
  const filterInputs = filterValues === null || filterValues === undefined
    ? []
    : (Array.isArray(filterValues) ? filterValues : [filterValues]);
  const parsedFilters = parseSearchFilters(filterInputs);
  const filters = [...parsedFilters.filters];
  const issues = [...parsedFilters.issues];
  const normalizedFilterValues = [...parsedFilters.filterValues];
  const seen = new Set(filters.map(filterIdentity));
  const conflicts = new Map();
  filters.forEach(filter => {
    const identity = filterConflictIdentity(filter);
    if (identity) conflicts.set(identity, filter.op);
  });
  const { tokens, issue: quoteIssue } = scanQuery(input);
  if (quoteIssue) issues.push(quoteIssue);
  const positiveTerms = [];
  const plainTokens = [];
  let extractedFilterCount = 0;
  let recognizedQuerySyntax = false;

  for (const token of tokens) {
    // 完整引用的 `"path:foo"` 是普通精确短语；`-"path:foo"` 是普通排除短语；
    // 只有 `path:"foo bar"` 才是字段语法。
    let parsed;
    if (token.quotedAtStart) {
      parsed = token.value
        ? { filter: null, issue: null, unknown: true }
        : { filter: null, issue: searchIssue('empty_text_condition', '搜索短语不能为空'), unknown: false };
    } else if (token.quoted && token.quotePrefix === '-') {
      const value = token.value.slice(1).trim();
      parsed = value
        ? { filter: { field: 'default', op: 'exclude', value }, issue: null, unknown: false }
        : { filter: null, issue: searchIssue('empty_filter', '排除条件缺少值'), unknown: false };
    } else {
      parsed = parseFilterToken(token.value, { unknownAsText: true, quoted: token.quoted });
    }
    if (parsed.issue) {
      if (!parsed.unknown) recognizedQuerySyntax = true;
      issues.push(parsed.issue);
      plainTokens.push(token);
      continue;
    }
    if (parsed.filter) {
      recognizedQuerySyntax = true;
      extractedFilterCount += 1;
      if (appendFilter(parsed.filter, filters, seen, conflicts, issues)) {
        normalizedFilterValues.push(serializeSearchFilter(parsed.filter));
      }
      continue;
    }
    plainTokens.push(token);
    positiveTerms.push(...queryTermsFromToken(token));
  }

  const uniquePositiveTerms = uniqueTerms(positiveTerms);
  if (input && !uniquePositiveTerms.length && extractedFilterCount === 0 && !issues.length) {
    issues.push(searchIssue('empty_search', '请输入至少一个有效关键词或筛选条件', rawInput));
  }
  const textConditionKeys = new Set(uniquePositiveTerms.map(term => `default\u0000include\u0000${term}`));
  for (const filter of filters) {
    if (!TEXT_FIELDS.has(filter.field)) continue;
    textConditionKeys.add(`${filter.field}\u0000${filter.op}\u0000${normalizeSearchText(filter.value)}`);
  }
  if (textConditionKeys.size > SEARCH_TEXT_CONDITION_LIMIT) {
    issues.push(searchIssue(
      'too_many_text_conditions',
      `最多添加 ${SEARCH_TEXT_CONDITION_LIMIT} 个文本条件，当前有 ${textConditionKeys.size} 个`,
      textConditionKeys.size,
    ));
  }

  const includeFilterTerms = filters
    .filter(filter => TEXT_FIELDS.has(filter.field) && filter.op === 'include')
    .map(filter => normalizeSearchText(filter.value))
    .filter(Boolean);
  const terms = highlightOrder(uniquePositiveTerms);
  const plan = {
    raw: rawInput,
    isSyntax: filters.length > 0 || recognizedQuerySyntax || parsedFilters.issues.length > 0,
    text: uniquePositiveTerms.join(' '),
    terms,
    positiveTerms: uniquePositiveTerms,
    filters,
    filterValues: normalizedFilterValues,
    issues,
    hasErrors: issues.length > 0,
    hasActiveSearch: Boolean(input || filterInputs.length),
    highlightTerms: highlightOrder([...uniquePositiveTerms, ...includeFilterTerms]).slice(0, SEARCH_TEXT_CONDITION_LIMIT),
    canonicalQuery: plainTokens.map(formatQueryToken).join(' ').trim(),
    hasLegacyFilters: extractedFilterCount > 0,
    canCanonicalize: extractedFilterCount > 0 && issues.length === 0,
  };
  return applyLegacyPlanFields(plan);
}

function fieldText(entry, field) {
  if (field === 'author') return normalizeSearchText(entryAuthorText(entry));
  if (field === 'codex') return normalizeSearchText(entryCodexText(entry));
  if (field === 'type') return normalizeSearchText(entryTypeText(entry));
  return cachedSearchField(entry, field);
}

function filterNeedle(filter) {
  const cached = filterNeedleCache.get(filter);
  if (cached !== undefined) return cached;
  const value = normalizeSearchText(filter.value);
  filterNeedleCache.set(filter, value);
  return value;
}

function matchesDirectoryFilter(entry, filter) {
  const codexId = String(entry?._srcCodexId || state.codex?.id || '').trim().toLowerCase();
  if (codexId !== String(filter.codexId || '').trim().toLowerCase()) return false;
  let codes = entryDirectoryCodesCache.get(entry);
  if (!codes) {
    const path = entryActualPath(entry);
    codes = new Set(path.map((_segment, index) => encodePathCode(path.slice(0, index + 1))).filter(Boolean));
    entryDirectoryCodesCache.set(entry, codes);
  }
  return codes.has(normalizeSearchText(filter.pathCode));
}

function matchesFilter(entry, filter) {
  if (filter.field === 'has') return hasEntryImage(entry) === filter.value;
  if (filter.field === 'fav') return isFav(entry) === filter.value;
  if (filter.field === 'directory') return matchesDirectoryFilter(entry, filter);
  const includes = fieldText(entry, filter.field).includes(filterNeedle(filter));
  return filter.op === 'exclude' ? !includes : includes;
}

export function matchSearchPlan(entry, plan) {
  if (!plan) return true;
  if (plan.hasErrors || plan.issues?.length) return false;
  const positiveTerms = plan.positiveTerms?.length
    ? plan.positiveTerms
    : (plan.terms?.length ? plan.terms : (plan.text ? [normalizeSearchText(plan.text)] : []));
  if (positiveTerms.length) {
    const text = searchableText(entry);
    if (!positiveTerms.every(term => text.includes(term))) return false;
  }
  if (Array.isArray(plan.filters)) return !plan.filters.length || plan.filters.every(filter => matchesFilter(entry, filter));
  // 兼容尚未接入 filters 的旧调用者手工构造的 plan。
  if (!plan.isSyntax) return true;
  if (plan.path && !pathMatchesQuery(entryActualPath(entry), plan.path)) return false;
  if (plan.hasImage !== null && plan.hasImage !== undefined && hasEntryImage(entry) !== plan.hasImage) return false;
  if (plan.fav !== null && plan.fav !== undefined && isFav(entry) !== plan.fav) return false;
  if (plan.author && !entryAuthorText(entry).includes(plan.author)) return false;
  if (plan.codex && !entryCodexText(entry).includes(plan.codex)) return false;
  if (plan.type && !entryTypeText(entry).includes(plan.type)) return false;
  return true;
}

export function searchRelevanceTier(entry, plan) {
  const terms = plan?.positiveTerms || [];
  if (!terms.length) return null;
  const title = fieldText(entry, 'title');
  const prompt = fieldText(entry, 'prompt');
  const wholeQuery = plan.text || '';
  if (wholeQuery && title === wholeQuery) return 0;
  if (wholeQuery && title.startsWith(wholeQuery)) return 1;
  if (terms.every(term => title.includes(term))) return 2;
  const titleHits = terms.some(term => title.includes(term));
  const promptHits = terms.some(term => prompt.includes(term));
  if (titleHits && promptHits && terms.every(term => title.includes(term) || prompt.includes(term))) return 3;
  if (terms.every(term => prompt.includes(term))) return 4;
  return 5;
}

/** 返回新数组；同一相关性层级严格保持输入顺序。 */
export function rankSearchResults(entries, plan) {
  if (!plan?.positiveTerms?.length) return [...entries];
  return entries
    .map((entry, index) => ({ entry, index, tier: searchRelevanceTier(entry, plan) }))
    .sort((left, right) => left.tier - right.tier || left.index - right.index)
    .map(item => item.entry);
}

export function pathMatchesQuery(path, queryPath) {
  if (!queryPath.length) return true;
  const joined = path.join('/').toLowerCase();
  const qJoined = queryPath.join('/').toLowerCase();
  if (joined.includes(qJoined)) return true;
  return queryPath.every(seg => path.some(part => String(part).toLowerCase().includes(seg.toLowerCase())));
}

export function entryAuthorText(entry) {
  const imageAuthors = entryImages(entry).flatMap(image => [image.author, image.credit]);
  const contributors = Array.isArray(entry._srcContributors)
    ? entry._srcContributors.map(person => typeof person === 'string' ? person : `${person.name || ''} ${person.role || ''}`)
    : (Array.isArray(state.codex?.contributors)
      ? state.codex.contributors.map(person => typeof person === 'string' ? person : `${person.name || ''} ${person.role || ''}`)
      : []);
  return [entry._srcAuthor, entry._srcSource, state.codex?.author, state.codex?.source, entry.author, entry.credit, ...imageAuthors, ...contributors]
    .join('\n')
    .toLowerCase();
}

export function entryCodexText(entry) {
  const source = [entry._srcCodexId, entry._srcCodexTitle].filter(Boolean);
  return (source.length ? source : [state.codex?.id, state.codex?.title])
    .join('\n')
    .toLowerCase();
}

export function entryTypeText(entry) {
  const type = entry._srcType || state.codex?.type || '';
  const labels = {
    codex: 'codex 法典',
    // 旧类型名保留为搜索别名，兼容用户已有习惯。
    string: 'string 画风 画风串',
    composition: 'composition 构图 服装 场景',
    pack: 'pack 图包 精选图包',
  };
  return [type, labels[type] || ''].join('\n').toLowerCase();
}

export function highlightTermsFromText(text) {
  const terms = normalizeInput(text)
    .split(/[\s,，、;；]+/)
    .map(normalizeSearchText)
    .filter(Boolean);
  return highlightOrder(terms).slice(0, SEARCH_TEXT_CONDITION_LIMIT);
}

export function currentHighlightTerms() {
  return state.searchPlan?.highlightTerms || [];
}

export function hiddenSearchMatch(entry, terms = currentHighlightTerms()) {
  const needles = uniqueTerms((terms || []).map(normalizeSearchText).filter(Boolean));
  if (!needles.length) return null;
  // 角色正向 prompt 会直接展示在卡片提示词区域，因此属于可见字段。
  const visible = searchableText(entry);
  const unresolved = needles.filter(term => !visible.includes(term));
  if (!unresolved.length) return null;
  const fields = [
    ['负面词', [entry?.negative, characterNegativeText(entry)].filter(Boolean).join('\n')],
    ['备注', entry?.note],
    ['Raw', rawTagText(entry)],
    ['路径', entryActualPath(entry).join(' › ')],
  ];
  for (const [label, value] of fields) {
    const raw = String(value || '').replace(/\s+/g, ' ').trim();
    const lower = normalizeSearchText(raw);
    const term = unresolved.find(candidate => lower.includes(candidate));
    if (!term) continue;
    const index = lower.indexOf(term);
    const start = Math.max(0, index - 22);
    const end = Math.min(raw.length, index + term.length + 32);
    return {
      label,
      excerpt: `${start ? '…' : ''}${raw.slice(start, end)}${end < raw.length ? '…' : ''}`,
    };
  }
  return null;
}

export function renderHighlightedText(element, text, terms = []) {
  if (!element) return;
  const raw = String(text || '');
  const needles = highlightOrder((terms || []).map(normalizeSearchText).filter(Boolean));
  if (!needles.length) {
    element.textContent = raw;
    return;
  }
  const normalized = normalizedTextWithOffsets(raw);
  const fragment = document.createDocumentFragment();
  let normalizedPosition = 0;
  let rawPosition = 0;
  while (normalizedPosition < normalized.text.length) {
    let bestIndex = -1;
    let bestTerm = '';
    for (const term of needles) {
      const index = normalized.text.indexOf(term, normalizedPosition);
      if (index === -1) continue;
      if (bestIndex === -1 || index < bestIndex || (index === bestIndex && term.length > bestTerm.length)) {
        bestIndex = index;
        bestTerm = term;
      }
    }
    if (bestIndex === -1) {
      fragment.appendChild(document.createTextNode(raw.slice(rawPosition)));
      break;
    }
    const rawStart = normalized.starts[bestIndex];
    const rawEnd = normalized.ends[bestIndex + bestTerm.length - 1];
    if (rawStart > rawPosition) fragment.appendChild(document.createTextNode(raw.slice(rawPosition, rawStart)));
    const mark = document.createElement('mark');
    mark.textContent = raw.slice(rawStart, rawEnd);
    fragment.appendChild(mark);
    normalizedPosition = bestIndex + bestTerm.length;
    rawPosition = rawEnd;
  }
  if (normalizedPosition >= normalized.text.length && rawPosition < raw.length) {
    fragment.appendChild(document.createTextNode(raw.slice(rawPosition)));
  }
  if (!normalized.text.length) fragment.appendChild(document.createTextNode(raw));
  element.replaceChildren(fragment);
}

function normalizedTextWithOffsets(raw) {
  let text = '';
  const starts = [];
  const ends = [];
  let pendingSpaceStart = -1;
  let pendingSpaceEnd = -1;
  for (let rawIndex = 0; rawIndex < raw.length;) {
    const codePoint = raw.codePointAt(rawIndex);
    const character = String.fromCodePoint(codePoint);
    const rawEnd = rawIndex + character.length;
    const normalized = normalizeInput(character).toLowerCase();
    for (let index = 0; index < normalized.length; index += 1) {
      const normalizedCharacter = normalized[index];
      if (/\s/.test(normalizedCharacter)) {
        if (text) {
          if (pendingSpaceStart === -1) pendingSpaceStart = rawIndex;
          pendingSpaceEnd = rawEnd;
        }
        continue;
      }
      if (pendingSpaceStart !== -1) {
        text += ' ';
        starts.push(pendingSpaceStart);
        ends.push(pendingSpaceEnd);
        pendingSpaceStart = -1;
        pendingSpaceEnd = -1;
      }
      text += normalizedCharacter;
      starts.push(rawIndex);
      ends.push(rawEnd);
    }
    rawIndex = rawEnd;
  }
  return { text, starts, ends };
}
