// 搜索 V1 的本地、只读性能验收：node tools/benchmark_search_v1.mjs
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import {
  matchSearchPlan,
  parseSearchQuery,
  rankSearchResults,
} from '../site/assets/app/search.js';
import {
  findRelatedDirectories,
  invalidateSearchDirectories,
  listSearchDirectories,
} from '../site/assets/app/search-directories.js';
import { state } from '../site/assets/app/state.js';

const ITERATIONS = 20;
const WARMUP_ROUNDS = 5;
const MAX_DEGRADATION = 0.10;
const EXPECTED_COUNTS = new Map([
  ['场', 111],
  ['画', 609],
  ['涩', 46],
]);
const DATA_DIR = new URL('../site/data/', import.meta.url);
const INDEX_URL = new URL('codexes.json', DATA_DIR);

class MissingLocalDataError extends Error {}

async function readLocalJson(url) {
  try {
    return JSON.parse(await readFile(url, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new MissingLocalDataError(`缺少 ${decodeURIComponent(url.pathname.split('/').at(-1) || url.pathname)}`);
    }
    throw error;
  }
}

function sourceLabel(meta, codex) {
  return meta.selectorTitle || codex.selectorTitle || codex.title || meta.title || meta.id;
}

function siteSearchEntry(entry, meta, codex) {
  const sourcePath = Array.isArray(entry.path) ? entry.path : [];
  return {
    ...entry,
    path: [sourceLabel(meta, codex), ...sourcePath],
    _srcCodexId: meta.id || codex.id,
    _srcCodexTitle: meta.title || codex.title || meta.id,
    _srcType: meta.type || codex.type || 'codex',
    _srcPath: sourcePath,
    _srcAuthor: meta.author || codex.author || '',
    _srcSource: meta.source || codex.source || '',
    _srcContributors: Array.isArray(meta.contributors)
      ? meta.contributors
      : (Array.isArray(codex.contributors) ? codex.contributors : []),
  };
}

async function loadAllLocalEntries() {
  const metas = await readLocalJson(INDEX_URL);
  if (!Array.isArray(metas) || !metas.length) {
    throw new Error('site/data/codexes.json 不是非空法典数组');
  }
  const sources = await Promise.all(metas.map(async meta => {
    const id = String(meta?.id || '').trim();
    if (!id) throw new Error('codexes.json 中存在缺少 id 的法典');
    const codex = await readLocalJson(new URL(`${id}.json`, DATA_DIR));
    if (!Array.isArray(codex?.entries)) throw new Error(`${id}.json 缺少 entries 数组`);
    return { meta, codex };
  }));
  const entries = sources.flatMap(({ meta, codex }) => (
    codex.entries.map(entry => siteSearchEntry(entry, meta, codex))
  ));
  const sourceDirectoryTrees = sources.map(({ meta, codex }) => ({
    codexId: meta.id || codex.id,
    tree: codex.tree,
  }));
  return { entries, metas, sourceDirectoryTrees };
}

// 以下三段保持 cc84cb4 默认文本查询的热路径，用来提供同进程旧实现基线。
const legacyTextCache = new WeakMap();

function legacySearchableText(entry) {
  const cached = legacyTextCache.get(entry);
  if (cached !== undefined) return cached;
  const characterText = (entry.characterPrompts || [])
    .flatMap(item => [item.label, item.prompt, item.negative]);
  const text = [
    entry.title,
    entry.tags,
    entry.negative,
    ...characterText,
    entry.note,
    entry.rawTags,
    ...(entry.path || []),
  ].join('\n').toLowerCase();
  legacyTextCache.set(entry, text);
  return text;
}

function legacyTokenizeQuery(input) {
  const tokens = [];
  let buffer = '';
  let quote = '';
  let quoted = false;
  for (const character of input) {
    if (quote) {
      if (character === quote) quote = '';
      else buffer += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      quoted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (buffer) {
        tokens.push({ value: buffer, quoted });
        buffer = '';
        quoted = false;
      }
      continue;
    }
    buffer += character;
  }
  if (buffer) tokens.push({ value: buffer, quoted });
  return tokens;
}

function legacyHighlightTerms(text) {
  const terms = String(text || '')
    .split(/[\s,，、]+/)
    .map(value => value.trim())
    .filter(Boolean);
  return [...new Set(terms.map(value => value.toLowerCase()))]
    .sort((left, right) => right.length - left.length)
    .slice(0, 10);
}

function legacyParseSearchQuery(raw) {
  const input = String(raw || '').trim();
  if (!input) return { text: '', terms: [] };
  const tokens = legacyTokenizeQuery(input);
  const terms = tokens.flatMap(token => (
    token.quoted
      ? [String(token.value || '').trim().toLowerCase()]
      : legacyHighlightTerms(token.value)
  )).filter(Boolean);
  return {
    text: tokens.map(token => token.value).join(' ').trim().toLowerCase(),
    terms: [...new Set(terms)].sort((left, right) => right.length - left.length).slice(0, 10),
  };
}

function runLegacySearch(entries, query) {
  const plan = legacyParseSearchQuery(query);
  const terms = plan.terms.length ? plan.terms : (plan.text ? [plan.text] : []);
  return entries.filter(entry => {
    const text = legacySearchableText(entry);
    return terms.every(term => text.includes(term));
  });
}

function runV1Search(entries, siteCodex, query) {
  const plan = parseSearchQuery(query);
  const filtered = entries.filter(entry => matchSearchPlan(entry, plan));
  const ranked = rankSearchResults(filtered, plan);
  const directories = listSearchDirectories({ entries, codex: siteCodex, sourceView: true });
  const related = findRelatedDirectories({
    entries,
    directories,
    codex: siteCodex,
    siteSearchView: true,
    positiveTerms: plan.positiveTerms,
    queryText: plan.text,
  });
  return { ranked, related };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

let checksum = 0;

function measure(operation) {
  const startedAt = performance.now();
  const result = operation();
  const elapsed = performance.now() - startedAt;
  if (Array.isArray(result)) checksum += result.length;
  else checksum += result.ranked.length + result.related.length + result.related.totalCount;
  return elapsed;
}

function percent(value) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(2)}%`;
}

async function main() {
  let loaded;
  try {
    loaded = await loadAllLocalEntries();
  } catch (error) {
    if (error instanceof MissingLocalDataError) {
      console.log(`search V1 benchmark: SKIP (${error.message})`);
      return;
    }
    throw error;
  }

  const { entries, metas, sourceDirectoryTrees } = loaded;
  const siteCodex = {
    id: 'site-search',
    title: '全站搜索',
    type: 'site-search-view',
    _sourceDirectoryTrees: sourceDirectoryTrees,
  };
  state.allowNsfw = true;
  state.allowR18g = true;
  state.codex = siteCodex;
  state.codexes = metas;

  invalidateSearchDirectories(entries);
  listSearchDirectories({ entries, codex: siteCodex, sourceView: true });

  for (let round = 0; round < WARMUP_ROUNDS; round += 1) {
    for (const query of EXPECTED_COUNTS.keys()) {
      runLegacySearch(entries, query);
      runV1Search(entries, siteCodex, query);
    }
  }

  for (const [query, expected] of EXPECTED_COUNTS) {
    const actual = runV1Search(entries, siteCodex, query).ranked.length;
    if (actual !== expected) {
      throw new Error(`默认搜索 ${JSON.stringify(query)} 应为 ${expected} 条，实际为 ${actual} 条`);
    }
  }

  const samples = new Map([...EXPECTED_COUNTS.keys()].map(query => [query, { legacy: [], v1: [] }]));
  const legacyTotals = [];
  const v1Totals = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    let legacyTotal = 0;
    let v1Total = 0;
    let queryIndex = 0;
    for (const query of EXPECTED_COUNTS.keys()) {
      const sample = samples.get(query);
      const legacyOperation = () => runLegacySearch(entries, query);
      const v1Operation = () => runV1Search(entries, siteCodex, query);
      let legacyElapsed;
      let v1Elapsed;
      if ((iteration + queryIndex) % 2 === 0) {
        legacyElapsed = measure(legacyOperation);
        v1Elapsed = measure(v1Operation);
      } else {
        v1Elapsed = measure(v1Operation);
        legacyElapsed = measure(legacyOperation);
      }
      sample.legacy.push(legacyElapsed);
      sample.v1.push(v1Elapsed);
      legacyTotal += legacyElapsed;
      v1Total += v1Elapsed;
      queryIndex += 1;
    }
    legacyTotals.push(legacyTotal);
    v1Totals.push(v1Total);
  }

  console.log(`search V1 benchmark: ${entries.length} entries / ${metas.length} codexes / ${ITERATIONS} runs each`);
  console.log('query\tcount\tlegacy median\tV1 median\tdegradation');
  const ratioFailures = [];
  for (const [query, expected] of EXPECTED_COUNTS) {
    const sample = samples.get(query);
    const legacyMedian = median(sample.legacy);
    const v1Median = median(sample.v1);
    const degradation = (v1Median / legacyMedian) - 1;
    console.log(`${query}\t${expected}\t${legacyMedian.toFixed(3)} ms\t${v1Median.toFixed(3)} ms\t${percent(degradation)}`);
    if (degradation > MAX_DEGRADATION) ratioFailures.push(`${query} ${percent(degradation)}`);
  }
  const legacyMedian = median(legacyTotals);
  const v1Median = median(v1Totals);
  const degradation = (v1Median / legacyMedian) - 1;
  console.log(`overall\t${[...EXPECTED_COUNTS.values()].reduce((sum, count) => sum + count, 0)}\t${legacyMedian.toFixed(3)} ms\t${v1Median.toFixed(3)} ms\t${percent(degradation)}`);
  if (degradation > MAX_DEGRADATION) ratioFailures.push(`overall ${percent(degradation)}`);

  // 防止未来把结果消费删掉后，基准被引擎当作无用工作；该值本身不参与验收。
  if (!Number.isFinite(checksum) || checksum <= 0) throw new Error('benchmark checksum 无效');
  if (ratioFailures.length) {
    throw new Error(`V1 同进程中位耗时超过 10% 门槛：${ratioFailures.join('，')}`);
  }
  console.log('search V1 benchmark: PASS');
}

main().catch(error => {
  console.error(`search V1 benchmark: FAIL (${error?.message || error})`);
  process.exitCode = 1;
});
