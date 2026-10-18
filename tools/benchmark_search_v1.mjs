// 当前搜索的本地只读采样；历史比较必须显式 --compare-legacy 且先证明命中集合相同。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  matchSearchPlan,
  parseSearchQuery,
  rankSearchResults,
  invalidateSearchableText,
} from '../site/assets/app/search.js';
import {
  findRelatedDirectories,
  invalidateSearchDirectories,
  listSearchDirectories,
} from '../site/assets/app/search-directories.js';
import { state } from '../site/assets/app/state.js';

const ITERATIONS = 20;
const WARMUP_ROUNDS = 5;
const MAX_DEGRADATION_PERCENT = 10;
const MAX_DEGRADATION = MAX_DEGRADATION_PERCENT / 100;
const QUERIES = ['场', '画', '涩'];
const DATA_DIR = new URL('../site/data/', import.meta.url);
const REPORT_SCHEMA = 'search-v1-cache-pairs/2';

class MissingLocalDataError extends Error {}
class IncomparableError extends Error {}
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function readLocalJson(url, root, files) {
  try {
    const filename = fileURLToPath(url);
    if ((await lstat(filename)).isSymbolicLink() || path.dirname(await realpath(filename)) !== root) {
      throw new Error('unsafe data file link');
    }
    const bytes = await readFile(url);
    files.push({ name: path.basename(filename), bytes: bytes.length, sha256: sha256(bytes) });
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new MissingLocalDataError(`Missing local data: ${path.basename(fileURLToPath(url))}`);
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

export async function loadAllLocalEntries(dataDir = DATA_DIR) {
  const files = [];
  const rootPath = path.resolve(fileURLToPath(dataDir));
  let root;
  try {
    root = await realpath(rootPath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new MissingLocalDataError('Missing local data directory');
    throw error;
  }
  if (root !== rootPath || (await lstat(root)).isSymbolicLink()) throw new Error('unsafe data directory link');
  const metas = await readLocalJson(new URL('codexes.json', dataDir), root, files);
  if (!Array.isArray(metas) || !metas.length) {
    throw new Error('site/data/codexes.json 不是非空法典数组');
  }
  const ids = new Set();
  const codexes = await Promise.all(metas.map(async meta => {
    const id = String(meta?.id || '').trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) throw new Error('unsafe or duplicate codex id');
    ids.add(id);
    const codex = await readLocalJson(new URL(`${id}.json`, dataDir), root, files);
    if (!Array.isArray(codex?.entries)) throw new Error(`${id}.json 缺少 entries 数组`);
    return codex;
  }));
  files.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  // Detect mutation while collecting the input; timings below use only these in-memory bytes.
  for (const file of files) {
    if (sha256(await readFile(new URL(file.name, dataDir))) !== file.sha256) {
      throw new Error('local data changed during snapshot collection');
    }
  }
  return { ...createDataset(metas, codexes), snapshot: {
    sha256: sha256(JSON.stringify(files)), fileCount: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  } };
}

export function createDataset(metas, codexes) {
  const sources = metas.map((meta, index) => ({ meta, codex: codexes[index] }));
  const entries = sources.flatMap(({ meta, codex }) => (
    codex.entries.map(entry => siteSearchEntry(entry, meta, codex))
  ));
  const sourceDirectoryTrees = sources.map(({ meta, codex }) => ({
    codexId: meta.id || codex.id,
    tree: codex.tree,
  }));
  const siteCodex = { id: 'site-search', title: '全站搜索', type: 'site-search-view', _sourceDirectoryTrees: sourceDirectoryTrees };
  return { entries, metas, siteCodex };
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

function distribution(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    samplesMs,
    minMs: sorted[0], maxMs: sorted.at(-1),
    medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function resultFingerprint(result, positions) {
  const ranked = result.ranked.map(entry => {
    assert.ok(positions.has(entry), 'search returned an entry outside the frozen input');
    return positions.get(entry);
  });
  return sha256(stableJson({ ranked, related: result.related, relatedCount: result.related.totalCount }));
}

function semanticSnapshot(loaded, queries) {
  if (!loaded.entries.length) throw new IncomparableError('empty dataset; no timing sample performed');
  configure(loaded);
  const positions = new Map(loaded.entries.map((entry, index) => [entry, index]));
  return queries.map(query => {
    clearCurrentCaches(loaded.entries);
    const result = runV1Search(loaded.entries, loaded.siteCodex, query);
    return { query, count: result.ranked.length, relatedCount: result.related.totalCount,
      resultSha256: resultFingerprint(result, positions) };
  });
}

function configure(loaded) {
  state.allowNsfw = true;
  state.allowR18g = true;
  state.codex = loaded.siteCodex;
  state.codexes = loaded.metas;
}

function clearCurrentCaches(entries) {
  for (const entry of entries) invalidateSearchableText(entry);
  invalidateSearchDirectories(entries);
}

export function verifyPublicFixture(fixture) {
  const loaded = createDataset(fixture.metas, fixture.codexes);
  configure(loaded);
  assert.ok(fixture.cases.length > 0, 'fixture must have cases');
  for (const item of fixture.cases) {
    const result = runV1Search(loaded.entries, loaded.siteCodex, item.query);
    assert.deepEqual(result.ranked.map(entry => entry.id).sort(), [...item.ids].sort(), `fixture recall: ${item.query}`);
    assert.deepEqual(result.related.map(node => node.name), item.relatedNames, `fixture directories: ${item.query}`);
  }
  return fixture.cases.length;
}

export function verifyLegacyComparable(loaded, queries = QUERIES) {
  configure(loaded);
  for (const query of queries) {
    const old = new Set(runLegacySearch(loaded.entries, query));
    const current = runV1Search(loaded.entries, loaded.siteCodex, query).ranked;
    if (old.size !== current.length || current.some(entry => !old.has(entry))) {
      throw new IncomparableError(`legacy/current semantics differ for ${JSON.stringify(query)} (legacy ${old.size}, current ${current.length}); no timing comparison performed`);
    }
  }
}

let checksum = 0;
function measure(operation, validate) {
  const start = performance.now();
  const result = operation();
  const elapsed = performance.now() - start;
  if (validate) validate(result); // Result hashing and assertions are outside the measured operation.
  checksum += Array.isArray(result) ? result.length : result.ranked.length + result.related.length + result.related.totalCount;
  return elapsed;
}

export function sampleCurrent(loaded, options = {}) {
  return sampleCurrentAgainst(loaded, options);
}

function sampleCurrentAgainst(loaded, { queries = QUERIES, rounds = ITERATIONS, warmup = WARMUP_ROUNDS } = {}, expected) {
  if (!loaded.entries.length) throw new IncomparableError('empty dataset; no timing sample performed');
  if (!Number.isInteger(rounds) || rounds < 2 || !Number.isInteger(warmup) || warmup < 1 || !queries.length) {
    throw new Error('benchmark needs at least two rounds, one warmup and one query');
  }
  configure(loaded);
  const { entries, siteCodex } = loaded;
  const rows = (expected || semanticSnapshot(loaded, queries)).map(row => ({ ...row, cold: [], warm: [] }));
  const positions = new Map(entries.map((entry, index) => [entry, index]));
  const verify = (row, result) => assert.equal(resultFingerprint(result, positions), row.resultSha256,
    `search result changed between cache generations: ${JSON.stringify(row.query)}`);
  for (let round = 0; round < warmup; round += 1) {
    for (const row of rows) verify(row, runV1Search(entries, siteCodex, row.query));
  }
  for (let round = 0; round < rounds; round += 1) {
    for (const [index, row] of rows.entries()) {
      const operation = () => runV1Search(entries, siteCodex, row.query);
      const cold = () => {
        clearCurrentCaches(entries);
        row.cold.push(measure(operation, result => verify(row, result)));
      };
      const warm = () => {
        verify(row, operation()); // Prime the identical query, including fields used only by ranking.
        row.warm.push(measure(operation, result => verify(row, result)));
      };
      if ((round + index) % 2) { warm(); cold(); }
      else { cold(); warm(); }
    }
  }
  return rows.map(row => {
    const cold = distribution(row.cold), warm = distribution(row.warm);
    return { query: row.query, count: row.count, relatedCount: row.relatedCount, resultSha256: row.resultSha256,
      cold, warm, cacheComparison: { status: 'PASS', equalResultChecks: rounds * 2,
        warmToColdMedianRatio: cold.medianMs > 0 ? warm.medianMs / cold.medianMs : null,
        scope: 'Same source and ordered results; observed cache effect, not a code improvement claim.' } };
  });
}

function requireBaseline(condition, reason) {
  if (!condition) throw new IncomparableError(`baseline incomparable: ${reason}; no valid timing comparison`);
}

function validateReport(report, measured = true) {
  requireBaseline(report?.schema === REPORT_SCHEMA && report.status === 'PASS', 'missing schema or non-PASS report');
  requireBaseline(/^[a-f0-9]{64}$/.test(report.sourceSha256 || ''), 'missing source fingerprint');
  requireBaseline(Array.isArray(report.sourceFiles) && report.sourceFiles.length > 0
    && report.sourceFiles.every(file => typeof file.name === 'string' && /^[a-f0-9]{64}$/.test(file.sha256 || ''))
    && sha256(JSON.stringify(report.sourceFiles)) === report.sourceSha256, 'source manifest fingerprint differs');
  requireBaseline(report.snapshot && /^[a-f0-9]{64}$/.test(report.snapshot.sha256 || ''), 'missing input fingerprint');
  requireBaseline(report.protocol && Number.isInteger(report.protocol.rounds) && report.protocol.rounds >= 2
    && Number.isInteger(report.protocol.warmup) && report.protocol.warmup >= 1, 'invalid sampling protocol');
  requireBaseline(Array.isArray(report.protocol.queries) && report.protocol.queries.length > 0
    && report.protocol.queries.every(query => typeof query === 'string' && query.trim())
    && Array.isArray(report.samples) && report.samples.length === report.protocol.queries.length, 'missing query samples');
  for (const [index, row] of report.samples.entries()) {
    requireBaseline(row.query === report.protocol.queries[index] && /^[a-f0-9]{64}$/.test(row.resultSha256 || '')
      && Number.isInteger(row.count) && row.count >= 0 && Number.isInteger(row.relatedCount) && row.relatedCount >= 0,
    'missing ordered result fingerprint');
    if (!measured) continue;
    for (const phase of ['cold', 'warm']) {
      const samples = row[phase]?.samplesMs;
      requireBaseline(Array.isArray(samples) && samples.length === report.protocol.rounds
        && samples.every(value => Number.isFinite(value) && value >= 0), 'invalid timing samples');
      const recomputed = distribution(samples);
      requireBaseline(recomputed.medianMs > 0 && ['minMs', 'maxMs', 'medianMs', 'p95Ms']
        .every(key => row[phase][key] === recomputed[key]), 'invalid timing distribution');
    }
  }
}

function verifyBaselineComparable(baseline, current, measured = true) {
  validateReport(baseline);
  validateReport(current, measured);
  for (const key of ['schema', 'snapshot', 'environment', 'protocol', 'scope']) {
    requireBaseline(stableJson(baseline[key]) === stableJson(current[key]), `${key} differs`);
  }
  for (const [index, row] of current.samples.entries()) {
    const previous = baseline.samples[index];
    requireBaseline(row.resultSha256 === previous.resultSha256 && row.count === previous.count
      && row.relatedCount === previous.relatedCount, `ordered results differ for ${JSON.stringify(row.query)}`);
  }
}

function exceedsRegressionThreshold(baselineMs, currentMs) {
  // Compare the decimal milliseconds recorded in JSON exactly. Division/subtraction or
  // multiplying by binary 1.1 can move a boundary by one ULP; an epsilon hides real excesses.
  const decimal = value => {
    const [digits, exponent = '0'] = String(value).split('e');
    return { units: BigInt(digits.replace('.', '')), exponent: Number(exponent) - (digits.split('.')[1]?.length || 0) };
  };
  const baseline = decimal(baselineMs), current = decimal(currentMs);
  const exponent = Math.min(baseline.exponent, current.exponent);
  return current.units * 10n ** BigInt(current.exponent - exponent) * 100n
    > baseline.units * 10n ** BigInt(baseline.exponent - exponent) * BigInt(100 + MAX_DEGRADATION_PERCENT);
}

export function compareBaselineReports(baseline, current) {
  verifyBaselineComparable(baseline, current);
  const rows = current.samples.flatMap((row, index) => ['cold', 'warm'].map(phase => ({
    query: row.query, phase, baselineMedianMs: baseline.samples[index][phase].medianMs,
    currentMedianMs: row[phase].medianMs,
    degradation: row[phase].medianMs / baseline.samples[index][phase].medianMs - 1,
    exceedsThreshold: exceedsRegressionThreshold(baseline.samples[index][phase].medianMs, row[phase].medianMs),
  })));
  return { requested: true, status: rows.some(row => row.exceedsThreshold) ? 'FAIL' : 'PASS',
    maxDegradation: MAX_DEGRADATION, baselineSourceSha256: baseline.sourceSha256,
    currentSourceSha256: current.sourceSha256, sameSource: baseline.sourceSha256 === current.sourceSha256, rows,
    scope: 'Same exact input, environment, protocol and ordered results. Threshold uses exact decimal milliseconds; displayed ratios are approximate. Timing regression observation; CPU load and process scheduling are not controlled.' };
}

export function parseBaselineReport(text) {
  const json = String(text).replace(/^\uFEFF/, '').trim().replace(/\r?\nsearch V1 benchmark: PASS$/, '');
  let report;
  try { report = JSON.parse(json); } catch { throw new IncomparableError('baseline is not a complete JSON report with an optional PASS marker'); }
  validateReport(report);
  return report;
}

// Retain the historical 10% gate, but only for explicitly requested comparable inputs.
function compareLegacy(loaded, { queries, rounds, warmup }) {
  verifyLegacyComparable(loaded, queries);
  const { entries, siteCodex } = loaded;
  for (let round = 0; round < warmup; round += 1) {
    for (const query of queries) {
      runLegacySearch(entries, query);
      runV1Search(entries, siteCodex, query);
    }
  }
  const rows = queries.map(query => ({ query, legacy: [], current: [] }));
  const totals = { legacy: [], current: [] };
  for (let round = 0; round < rounds; round += 1) {
    let legacyTotal = 0;
    let currentTotal = 0;
    for (const [index, row] of rows.entries()) {
      const operations = [() => runLegacySearch(entries, row.query), () => runV1Search(entries, siteCodex, row.query)];
      let legacy, current;
      if ((round + index) % 2) { current = measure(operations[1]); legacy = measure(operations[0]); }
      else { legacy = measure(operations[0]); current = measure(operations[1]); }
      row.legacy.push(legacy); row.current.push(current);
      legacyTotal += legacy; currentTotal += current;
    }
    totals.legacy.push(legacyTotal); totals.current.push(currentTotal);
  }
  const compared = [...rows, { query: 'overall', ...totals }].map(row => {
    const legacy = distribution(row.legacy), current = distribution(row.current);
    return { query: row.query, legacy, current, degradation: current.medianMs / legacy.medianMs - 1,
      exceedsThreshold: exceedsRegressionThreshold(legacy.medianMs, current.medianMs) };
  });
  return { requested: true, status: compared.some(row => row.exceedsThreshold) ? 'FAIL' : 'PASS',
    maxDegradation: MAX_DEGRADATION, rows: compared,
    scope: 'Same in-memory entries and recall sets; legacy returns matches, current also ranks and finds directories.' };
}

export async function makeReport(loaded, { queries = QUERIES, rounds = ITERATIONS, warmup = WARMUP_ROUNDS,
  compare = false, baseline = null, baselineFileSha256 = null } = {}) {
  if (compare && baseline) throw new Error('choose legacy comparison or a frozen baseline report');
  // This guard precedes every timing operation in comparison mode.
  if (compare) verifyLegacyComparable(loaded, queries);
  const moduleNames = ['benchmark_search_v1.mjs', '../site/assets/app/search.js',
    '../site/assets/app/search-directories.js', '../site/assets/app/access.js',
    '../site/assets/app/state.js', '../site/assets/app/path-code.js'];
  const sourceFiles = await Promise.all(moduleNames.map(async name => ({
    name, sha256: sha256(await readFile(new URL(name, import.meta.url))),
  })));
  const sourceSha256 = sha256(JSON.stringify(sourceFiles));
  const environment = { node: process.version, v8: process.versions.v8, platform: process.platform,
    arch: process.arch, osRelease: os.release(), cpu: os.cpus()[0]?.model || 'unknown', cpuCount: os.cpus().length,
    icu: process.versions.icu, locale: Intl.DateTimeFormat().resolvedOptions().locale };
  const protocol = { version: REPORT_SCHEMA, queries, rounds, warmup, allowNsfw: true, allowR18g: true,
    input: 'Source metadata projection of raw local JSON entries; app loading/normalization is outside this microbenchmark.',
    cold: 'Fresh application text/field/directory caches before every query; cache invalidation excluded from timing.',
    warm: 'Same in-memory entries, primed by the identical query; alternating cold/warm pairs after JIT warmup.',
    semantics: 'Ordered input positions plus all returned related-directory fields and total count; checked outside timing.',
    excluded: 'Disk read/JSON parse, network, browser, render and OS cache effects are not measured.' };
  const report = { schema: REPORT_SCHEMA, status: 'PASS', performanceImprovementClaim: false,
    snapshot: loaded.snapshot || { sha256: sha256(stableJson({ entries: loaded.entries, metas: loaded.metas, siteCodex: loaded.siteCodex })), kind: 'in-memory projection' },
    sourceSha256, sourceFiles, environment, protocol,
    scope: { entries: loaded.entries.length, codexes: loaded.metas.length },
    samples: semanticSnapshot(loaded, queries) };
  // Reject a changed environment/input/ordered result before taking any timed sample.
  if (baseline) verifyBaselineComparable(baseline, report, false);
  report.samples = sampleCurrentAgainst(loaded, { queries, rounds, warmup }, report.samples);
  const legacyComparison = compare ? compareLegacy(loaded, { queries, rounds, warmup })
    : { requested: false, reason: 'Not requested. Use --compare-legacy; different recall sets block before timing.' };
  if (!Number.isFinite(checksum)) throw new Error('invalid benchmark checksum');
  const baselineComparison = baseline ? { ...compareBaselineReports(baseline, report), baselineFileSha256 }
    : { requested: false, reason: 'Use --baseline-report <frozen output> for an identical-input regression check.' };
  return { ...report, status: legacyComparison.status === 'FAIL' || baselineComparison.status === 'FAIL' ? 'FAIL' : 'PASS',
    comparabilityKey: sha256(stableJson({ snapshot: report.snapshot, environment, protocol })),
    legacyComparison, baselineComparison };
}

async function main() {
  const args = process.argv.slice(2);
  const baselineIndex = args.indexOf('--baseline-report');
  let baseline = null, baselineFileSha256 = null;
  if (baselineIndex !== -1) {
    const filename = args[baselineIndex + 1];
    if (!filename || filename.startsWith('--')) throw new Error('--baseline-report needs a frozen report path');
    const resolved = path.resolve(filename);
    const stat = await lstat(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(resolved) !== resolved || stat.size > 8 * 1024 * 1024) {
      throw new IncomparableError('baseline file must be a regular local file of at most 8 MiB without links');
    }
    const bytes = await readFile(resolved);
    baseline = parseBaselineReport(bytes.toString('utf8'));
    baselineFileSha256 = sha256(bytes);
    args.splice(baselineIndex, 2);
  }
  if (args.some(arg => !['--check-fixture', '--compare-legacy'].includes(arg))) throw new Error('unknown benchmark argument');
  const fixture = JSON.parse(await readFile(new URL('./fixtures/search_benchmark.json', import.meta.url), 'utf8'));
  const fixtureCases = verifyPublicFixture(fixture);
  if (args.includes('--check-fixture')) {
    if (args.includes('--compare-legacy') || baseline) throw new Error('choose fixture-only or a comparison');
    console.log(`search benchmark fixture: PASS (${fixtureCases} cases)`);
    return;
  }
  const loaded = await loadAllLocalEntries();
  const report = await makeReport(loaded, { compare: args.includes('--compare-legacy'), baseline, baselineFileSha256 });
  report.fixture = { cases: fixtureCases, sha256: sha256(await readFile(new URL('./fixtures/search_benchmark.json', import.meta.url))) };
  console.log(JSON.stringify(report, null, 2));
  console.log(`search V1 benchmark: ${report.status}`);
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    const blocked = error instanceof MissingLocalDataError || error instanceof IncomparableError;
    console.error(`search V1 benchmark: ${blocked ? 'BLOCKED' : 'FAIL'} (${error?.message || error})`);
    process.exitCode = blocked ? 2 : 1;
  });
}
