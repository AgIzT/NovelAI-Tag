// Browser/Functions protocol regression: synthetic bytes only; no external fetch.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isV2Release, releaseManifestPath, parseReleaseManifest, objectPath, readV2Json, validateReleasePointer } from '../site/assets/data-release.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/r2_cas_v2.json', import.meta.url), 'utf8'));
const value = fixture.manifest;
const clone = input => JSON.parse(JSON.stringify(input));
const canonical = input => new TextEncoder().encode(JSON.stringify({
  contentHash: input.contentHash,
  files: Object.fromEntries(Object.keys(input.files).sort().map(path => [path, { sha256: input.files[path].sha256, size: input.files[path].size }])),
  release: input.release, schemaVersion: input.schemaVersion,
}) + '\n');
const sign = files => {
  const contentHash = createHash('sha256').update('r2-cas-v2\n' + Object.keys(files).sort().map(path => `${path}\0${files[path].sha256}\0${files[path].size}\n`).join('')).digest('hex');
  return { schemaVersion: 2, release: `r2-${contentHash}`, contentHash, files };
};
const pointer = () => ({ schemaVersion: 2, release: value.release, contentHash: value.contentHash, manifest: `data/${releaseManifestPath(value.release)}`, publishedAt: '2026-10-20T00:00:00Z', operationId: 'a'.repeat(32) });

test('promoted protocol matches frozen Python/JS fixture, without Node dependencies', async () => {
  const source = await readFile(new URL('../site/assets/data-release.js', import.meta.url), 'utf8');
  assert.equal(/node:|\bBuffer\b/.test(source), false);
  assert.equal(isV2Release(value.release), true);
  assert.equal(isV2Release(`${value.release}\n`), false);
  assert.equal(releaseManifestPath(value.release), `v2/releases/${value.release}/manifest.json`);
  const manifest = await parseReleaseManifest(canonical(value), value.release);
  assert.deepEqual(manifest, value);
  assert.equal(Object.isFrozen(manifest.files['codexes.json']), true);
  const objects = new Map(fixture.objects.map(item => [item.key.slice(5), new Uint8Array(Buffer.from(item.bodyBase64, 'base64'))]));
  const data = await readV2Json(manifest, 'codexes.json', key => objects.get(key));
  assert.equal(data.name, '本地隔离试验');
  assert.equal(objectPath(fixture.objects[0].sha256), fixture.objects[0].key.slice(5));
});

test('strict canonical bytes and expected release bind all manifest fields', async () => {
  const raw = new TextDecoder().decode(canonical(value));
  for (const bad of [raw.trimEnd(), ' ' + raw, '\ufeff' + raw, JSON.stringify(value) + '\n', raw.replace('"schemaVersion":2', '"schemaVersion":2.0'), raw.replace('{"contentHash":', '{"schemaVersion":2,"contentHash":')]) {
    await assert.rejects(parseReleaseManifest(new TextEncoder().encode(bad), value.release));
  }
  await assert.rejects(parseReleaseManifest(new Uint8Array([255]), value.release));
  await assert.rejects(parseReleaseManifest(canonical(value), 'r2-' + 'a'.repeat(64)));
  await assert.rejects(parseReleaseManifest(raw, value.release));
  for (const path of ['manifest.json', '../x.json', '/x.json', 'x%2fy.json', 'a//x.json', 'a.json/x.json', '中文.json', 'x.json\n', 'x.json\u2028']) {
    await assert.rejects(parseReleaseManifest(canonical(sign({ [path]: value.files['codexes.json'] })), value.release));
  }
  const conflicted = sign({ 'a.json': { sha256: 'a'.repeat(64), size: 1 }, 'b.json': { sha256: 'a'.repeat(64), size: 2 } });
  await assert.rejects(parseReleaseManifest(canonical(conflicted), conflicted.release), /size/i);
});

test('object reads reject accessors, false metadata, wrong size/hash and absent logical path', async () => {
  const body = new Uint8Array(Buffer.from(fixture.objects[0].bodyBase64, 'base64'));
  for (const invalid of [undefined, 'body', { body }, body.subarray(1), new Uint8Array(body.length)]) {
    await assert.rejects(readV2Json(value, 'codexes.json', () => invalid));
  }
  let calls = 0;
  const mutated = clone(value);
  Object.defineProperty(mutated.files['codexes.json'], 'sha256', { get() { calls += 1; return 'a'.repeat(64); }, enumerable: true });
  await assert.rejects(readV2Json(mutated, 'codexes.json', () => { calls += 1; return body; }), /accessor/i);
  assert.equal(calls, 0);
  await assert.rejects(readV2Json(value, 'missing.json', () => { calls += 1; return body; }));
  assert.equal(calls, 0);
});

test('pointer validates v2 identity/path and keeps historical v1 minimum fields', () => {
  assert.equal(validateReleasePointer(pointer()).release, value.release);
  assert.equal(validateReleasePointer({ ...pointer(), manifest: `archive/data/${releaseManifestPath(value.release)}` }, 'archive/data').release, value.release);
  assert.equal(validateReleasePointer({ release: 'r-0123456789abcdefabcd' }).release, 'r-0123456789abcdefabcd');
  for (const bad of [
    { ...pointer(), contentHash: 'a'.repeat(64) }, { ...pointer(), manifest: 'data/current.json' },
    { ...pointer(), schemaVersion: 1 }, { ...pointer(), operationId: 'x' }, { ...pointer(), extra: true },
    { ...pointer(), previousRelease: value.release }, { ...pointer(), release: value.release + '\n' },
  ]) assert.throws(() => validateReleasePointer(bad));
  const accessor = pointer();
  Object.defineProperty(accessor, 'release', { get() { throw new Error('must not invoke'); } });
  assert.throws(() => validateReleasePointer(accessor), /accessor/i);
});

test('manifest field, path, numeric and identity boundaries remain strict after promotion', async () => {
  const readNothing = () => { throw new Error('must reject before storage'); };
  for (const layer of ['manifest', 'files', 'metadata']) {
    const bad = clone(value);
    const target = layer === 'manifest' ? bad : layer === 'files' ? bad.files : bad.files['codexes.json'];
    let accesses = 0;
    Object.defineProperty(target, layer === 'manifest' ? 'release' : layer === 'files' ? 'codexes.json' : 'size', {
      enumerable: true, get() { accesses++; return null; },
    });
    await assert.rejects(readV2Json(bad, 'codexes.json', readNothing), /accessor/i);
    assert.equal(accesses, 0);
  }
  for (const key of ['schemaVersion', 'release', 'contentHash', 'files']) {
    const bad = clone(value); delete bad[key];
    await assert.rejects(readV2Json(bad, 'codexes.json', readNothing), /fields/i);
  }
  for (const path of ['manifest.json', '../x.json', '/x.json', 'x%2fy.json', 'a//x.json', 'a.json/x.json', '中文.json', 'x.json\n', 'x.json\u2028']) {
    const bad = sign({ [path]: value.files['codexes.json'] });
    await assert.rejects(parseReleaseManifest(canonical(bad), bad.release), /path/i);
  }
  for (const size of [0, -1, 1.5, 33554433, 268435457, true, '70', null, NaN, Infinity]) {
    const bad = sign({ 'a.json': { sha256: 'a'.repeat(64), size } });
    await assert.rejects(readV2Json(bad, 'a.json', readNothing), /size/i);
  }
  for (const schemaVersion of [1, '2', true, 2.1]) {
    await assert.rejects(readV2Json({ ...value, schemaVersion }, 'codexes.json', readNothing), /schema/i);
  }
  for (const change of [
    bad => { bad.files['codexes.json'].size++; },
    bad => { bad.files['renamed.json'] = bad.files['codexes.json']; delete bad.files['codexes.json']; },
    bad => { bad.files['codexes.json'].sha256 = 'a'.repeat(64); },
    bad => { bad.contentHash = 'a'.repeat(64); },
  ]) {
    const bad = clone(value); change(bad);
    await assert.rejects(readV2Json(bad, 'codexes.json', readNothing));
  }
  const extra = { ...value, extra: true };
  await assert.rejects(readV2Json(extra, 'codexes.json', readNothing), /fields/i);
  const nestedExtra = clone(value); nestedExtra.files['codexes.json'].url = 'https://invalid.example';
  await assert.rejects(readV2Json(nestedExtra, 'codexes.json', readNothing), /fields/i);
  const maxFiles = Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [`file_${i}.json`, { sha256: 'a'.repeat(64), size: 33554432 }]));
  const boundary = sign(maxFiles);
  assert.equal(Object.keys((await parseReleaseManifest(canonical(boundary), boundary.release)).files).length, 4096);
  const excessive = sign({ ...maxFiles, 'extra.json': { sha256: 'a'.repeat(64), size: 33554432 } });
  await assert.rejects(parseReleaseManifest(canonical(excessive), excessive.release), /count/i);
});
