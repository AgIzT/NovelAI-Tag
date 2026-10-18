// Public synthetic fixtures only. No private data, network or timing threshold assertions.
import assert from 'node:assert/strict';
let guardFailures = 0;
function test(name, check) {
  try { check(); console.log(`[OK] ${name}`); }
  catch (error) { guardFailures += 1; console.error(`[FAIL] ${name}: ${error.message}`); }
}
import * as benchmark from './benchmark_search_v1.mjs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createDataset, loadAllLocalEntries, verifyPublicFixture,
  verifyLegacyComparable, sampleCurrent, makeReport,
} from './benchmark_search_v1.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/search_benchmark.json', import.meta.url), 'utf8'));
assert.equal(verifyPublicFixture(fixture), 4);
const incorrect = structuredClone(fixture);
incorrect.cases[0].ids.push('excluded');
assert.throws(() => verifyPublicFixture(incorrect), /fixture/);
const loaded = createDataset(fixture.metas, fixture.codexes);
assert.throws(() => verifyLegacyComparable(loaded, ['场']), /semantics differ/);
await assert.rejects(makeReport(loaded, { compare: true }), /semantics differ/);
const empty = createDataset([{ id: 'empty', title: 'Empty' }], [{ id: 'empty', entries: [] }]);
await assert.rejects(makeReport(empty, { rounds: 2, warmup: 1, queries: ['场'] }), /empty dataset/);
assert.throws(() => sampleCurrent(empty, { rounds: 2, warmup: 1, queries: ['场'] }), /empty dataset/);
const comparable = createDataset([{ id: 'demo', title: 'Demo' }], [{ id: 'demo', entries: [{ id: 'one', title: '场', tags: '' }] }]);
assert.doesNotThrow(() => verifyLegacyComparable(comparable, ['场']));
const measured = sampleCurrent(loaded, { queries: ['场', '涩'], rounds: 3, warmup: 1 });
assert.equal(measured[0].count, 1);
for (const row of measured) {
  for (const phase of ['cold', 'warm']) {
    assert.equal(row[phase].samplesMs.length, 3);
    for (const value of Object.values(row[phase]).flat()) assert.ok(Number.isFinite(value) && value >= 0);
    assert.ok(row[phase].minMs <= row[phase].medianMs && row[phase].medianMs <= row[phase].maxMs);
  }
}

// Changing synthetic input changes the exact-byte snapshot and observed counts, not a stale expected count.
let frozenReport, frozenInput;
const directory = await mkdtemp(join(tmpdir(), 'search-benchmark-test-'));
try {
const dataUrl = pathToFileURL(directory + '/');
await writeFile(join(directory, 'codexes.json'), JSON.stringify([{ id: 'demo', title: 'Demo' }]));
const book = { id: 'demo', entries: [{ id: 'one', title: '场', tags: '' }] };
await writeFile(join(directory, 'demo.json'), JSON.stringify(book));
const first = await loadAllLocalEntries(dataUrl);
book.entries.push({ id: 'two', title: '场', tags: '' });
await writeFile(join(directory, 'demo.json'), JSON.stringify(book));
const second = await loadAllLocalEntries(dataUrl);
frozenInput = second;
assert.notEqual(first.snapshot.sha256, second.snapshot.sha256);
assert.equal(sampleCurrent(second, { queries: ['场'], rounds: 2, warmup: 1 })[0].count, 2);
const report = await makeReport(second, { rounds: 2, warmup: 1, queries: ['场'] });
frozenReport = structuredClone(report);
assert.equal(report.status, 'PASS');
assert.equal(report.performanceImprovementClaim, false);
assert.equal(report.snapshot.fileCount, 2);
assert.ok(report.environment.node && report.sourceSha256 && report.comparabilityKey);
assert.equal(report.legacyComparison.requested, false);
assert.doesNotMatch(JSON.stringify(report), /\bSKIP\b/);
await writeFile(join(directory, 'codexes.json'), JSON.stringify([{ id: '../outside' }]));
await assert.rejects(loadAllLocalEntries(dataUrl), /unsafe/);
await writeFile(join(directory, 'codexes.json'), JSON.stringify([{ id: 'missing' }]));
await assert.rejects(loadAllLocalEntries(dataUrl), /Missing local data/);
} finally {
  await rm(directory, { recursive: true, force: true });
}
test('current cold/warm results bind complete ordered semantics and cache comparison', () => {
  for (const row of measured) {
    assert.match(row.resultSha256, /^[a-f0-9]{64}$/);
    assert.equal(row.cacheComparison.status, 'PASS');
    assert.equal(row.cacheComparison.equalResultChecks, 6);
    assert.ok(Number.isFinite(row.cacheComparison.warmToColdMedianRatio));
  }
});

test('changing actual searchable input between cache generations fails the semantic guard', () => {
  const changing = createDataset([{ id: 'demo' }], [{ entries: [{ id: 'one', title: '', tags: '场' }] }]);
  let reads = 0;
  Object.defineProperty(changing.entries[0], 'tags', { get: () => (++reads === 1 ? '场' : 'elsewhere') });
  assert.throws(() => sampleCurrent(changing, { queries: ['场'], rounds: 2, warmup: 1 }), /result changed/);
});

test('a frozen same-input report allows source differences and checks timing regressions', () => {
  assert.equal(typeof benchmark.compareBaselineReports, 'function');
  const current = structuredClone(frozenReport);
  const unchanged = benchmark.compareBaselineReports(frozenReport, current);
  assert.equal(unchanged.status, 'PASS');
  assert.equal(unchanged.sameSource, true);
  current.sourceFiles = [{ name: 'frozen-source.js', sha256: '2'.repeat(64) }];
  current.sourceSha256 = createHash('sha256').update(JSON.stringify(current.sourceFiles)).digest('hex');
  const changed = benchmark.compareBaselineReports(frozenReport, current);
  assert.equal(changed.sameSource, false);
  assert.equal(changed.status, 'PASS');
  for (const row of current.samples) {
    for (const phase of ['cold', 'warm']) {
      for (const field of ['minMs', 'maxMs', 'medianMs', 'p95Ms']) row[phase][field] *= 2;
      row[phase].samplesMs = row[phase].samplesMs.map(value => value * 2);
    }
  }
  assert.equal(benchmark.compareBaselineReports(frozenReport, current).status, 'FAIL');
});

for (const [baselineMs, below, atLimit, above] of [
  [10, 10.999, 11, 11.001],
  [0.1, 0.10999, 0.11, 0.11001],
  [0.3, 0.32997, 0.33, 0.33003],
  [6.7284, 7.40056716, 7.40124, 7.40191284],
  [1e-8, 1.0999e-8, 1.1e-8, 1.1001e-8],
  [1e8, 109990000, 110000000, 110010000],
]) {
  test(`regression threshold is strict at 9.99%, 10%, 10.01% for ${baselineMs} ms`, () => {
    const baseline = structuredClone(frozenReport);
    const current = structuredClone(frozenReport);
    const setTimings = (report, value) => {
      for (const row of report.samples) for (const phase of ['cold', 'warm']) {
        row[phase] = { samplesMs: [value, value], minMs: value, maxMs: value, medianMs: value, p95Ms: value };
      }
    };
    setTimings(baseline, baselineMs);
    const cases = [[below, 'PASS'], [atLimit, 'PASS'], [above, 'FAIL']];
    if (baselineMs === 0.1) cases.push([0.11000000000000001, 'FAIL']);
    if (baselineMs === 0.3) cases.push([0.32999999999999996, 'PASS'], [0.33000000000000007, 'FAIL']);
    for (const [currentMs, expected] of cases) {
      setTimings(current, currentMs);
      assert.equal(benchmark.compareBaselineReports(baseline, current).status, expected,
        `only strict >10% fails: ${baselineMs} -> ${currentMs} ms`);
    }
  });
}

test('baseline protocol, data, environment and full result changes remain incomparable', () => {
  assert.equal(typeof benchmark.compareBaselineReports, 'function');
  for (const alter of [
    report => { report.snapshot.sha256 = 'f'.repeat(64); },
    report => { report.environment.node = 'different'; },
    report => { report.protocol.warmup += 1; },
    report => { report.samples[0].resultSha256 = 'f'.repeat(64); },
    report => { report.samples = []; },
    report => { report.samples[0].cold.samplesMs[0] = -1; },
    report => { report.samples[0].warm.medianMs += 1; },
    report => { report.sourceSha256 = 'f'.repeat(64); },
    report => { report.status = 'FAIL'; },
  ]) {
    const changed = structuredClone(frozenReport);
    alter(changed);
    assert.throws(() => benchmark.compareBaselineReports(changed, frozenReport), /baseline|incomparable/);
  }
});

const mismatchedBaseline = structuredClone(frozenReport);
mismatchedBaseline.samples[0].resultSha256 = 'f'.repeat(64);
const originalNow = performance.now;
try {
  performance.now = () => { throw new Error('timing must not start for incompatible semantics'); };
  await assert.rejects(makeReport(frozenInput, { queries: ['场'], rounds: 2, warmup: 1,
    baseline: mismatchedBaseline }), /ordered results differ/);
} finally { performance.now = originalNow; }

test('default report output can be frozen without accepting a failed or conflicting marker', () => {
  assert.equal(typeof benchmark.parseBaselineReport, 'function');
  const json = JSON.stringify(frozenReport, null, 2);
  assert.deepEqual(benchmark.parseBaselineReport(json + '\nsearch V1 benchmark: PASS\n'), frozenReport);
  assert.deepEqual(benchmark.parseBaselineReport('\ufeff' + json), frozenReport);
  assert.throws(() => benchmark.parseBaselineReport(json + '\nsearch V1 benchmark: FAIL\n'), /baseline/);
  assert.throws(() => benchmark.parseBaselineReport(json + '\nsearch V1 benchmark: PASS\nextra'), /baseline/);
});

if (guardFailures) throw new Error(`${guardFailures} benchmark guard failures`);
console.log('search benchmark harness: PASS (public semantics, changed input, distributions, snapshots and comparison guard)');
