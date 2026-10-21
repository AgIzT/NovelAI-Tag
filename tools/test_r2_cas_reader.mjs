// Offline protocol and old-URL compatibility tests. Only synthetic bytes are read.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  validateManifest, parseManifestBytes, objectKey, manifestKey, readLogicalFile,
  resolveLegacyV2Url, readLegacyV1Url,
} from './r2_cas_experiment/reader.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/r2_cas_v2.json', import.meta.url), 'utf8'));
const manifest = fixture.manifest;
const clone = value => JSON.parse(JSON.stringify(value));
const sha256 = body => createHash('sha256').update(body).digest('hex');
// Re-sign adversarial identities so rejection proves the field boundary, not a stale digest.
const signFiles = files => {
  const identity = 'r2-cas-v2\n' + Object.keys(files).sort().map(path => `${path}\0${files[path].sha256}\0${files[path].size}\n`).join('');
  const contentHash = sha256(Buffer.from(identity, 'utf8'));
  return { schemaVersion: 2, release: `r2-${contentHash}`, contentHash, files };
};
const canonicalBytes = value => Buffer.from(JSON.stringify({
  contentHash: value.contentHash,
  files: Object.fromEntries(Object.keys(value.files).sort().map(path => [path, {
    sha256: value.files[path].sha256, size: value.files[path].size,
  }])),
  release: value.release,
  schemaVersion: value.schemaVersion,
}) + '\n', 'utf8');
const objects = new Map(fixture.objects.map(item => [item.key, Buffer.from(item.bodyBase64, 'base64')]));
const legacyUrl = path => `/data/releases/${manifest.release}/${path}`;
const exactRelease = 'r-0123456789abcdef0123';

test('fixture identity, object keys and UTF-8 bytes are deterministic', () => {
  assert.deepEqual(validateManifest(manifest), manifest);
  const reversed = { ...manifest, files: Object.fromEntries(Object.entries(manifest.files).reverse()) };
  assert.deepEqual(validateManifest(reversed), manifest);
  for (const object of fixture.objects) {
    const body = Buffer.from(object.bodyBase64, 'base64');
    assert.equal(sha256(body), object.sha256);
    assert.equal(body.length, object.size);
    assert.equal(objectKey(object.sha256), object.key);
  }
  assert.equal(manifestKey(manifest.release), `data/v2/releases/${manifest.release}/manifest.json`);
});

test('manifest rejects missing and unknown fields at every layer', () => {
  for (const key of ['schemaVersion', 'release', 'contentHash', 'files']) {
    const value = clone(manifest);
    delete value[key];
    assert.throws(() => validateManifest(value), undefined, key);
  }
  for (const extra of ['previousRelease', 'url', 'objectKey', '__proto__']) {
    const value = clone(manifest);
    Object.defineProperty(value, extra, { value: 'untrusted', enumerable: true });
    assert.throws(() => validateManifest(value), undefined, extra);
    const nested = clone(manifest);
    Object.defineProperty(nested.files['codexes.json'], extra, { value: 'untrusted', enumerable: true });
    assert.throws(() => validateManifest(nested), undefined, `file.${extra}`);
  }
  for (const invalid of [null, [], 'text', 2, Object.create({ inherited: true })]) {
    assert.throws(() => validateManifest(invalid));
  }
});

test('raw manifest accepts canonical bytes and rejects duplicates and ambiguous number lexemes', () => {
  const canonical = canonicalBytes(manifest);
  assert.deepEqual(parseManifestBytes(canonical), manifest);
  const text = canonical.toString('utf8');
  const duplicateTop = text.replace('{"contentHash":', '{"schemaVersion":2,"contentHash":');
  const duplicatePath = text.replace('"files":{', `"files":{"codexes.json":${JSON.stringify(manifest.files['codexes.json'])},`);
  const duplicateMetadata = text.replace('"sha256":', '"size":70,"sha256":');
  for (const raw of [
    duplicateTop, duplicatePath, duplicateMetadata,
    text.replace('"schemaVersion":2', '"schemaVersion":2.0'),
    text.replace('"size":70', '"size":7e1'),
    text.replace('"size":70', '"size":70.0'),
    JSON.stringify(manifest) + '\n', text.trimEnd(), ` ${text}`, `\ufeff${text}`,
  ]) {
    assert.throws(() => parseManifestBytes(Buffer.from(raw, 'utf8')), undefined, raw.slice(0, 80));
  }
  assert.throws(() => parseManifestBytes(Buffer.from([0xff])));
  assert.throws(() => parseManifestBytes(text));
});

test('manifest digest binds every logical path, size and hash', () => {
  for (const mutate of [
    value => { value.files['codexes.json'].size += 1; },
    value => { value.files['codexes.json'].sha256 = 'a'.repeat(64); },
    value => { value.files['renamed.json'] = value.files['codexes.json']; delete value.files['codexes.json']; },
    value => { value.release = `r2-${'a'.repeat(64)}`; },
    value => { value.contentHash = 'a'.repeat(64); },
  ]) {
    const value = clone(manifest);
    mutate(value);
    assert.throws(() => validateManifest(value));
  }
});

test('manifest rejects inconsistent sizes for one content digest', () => {
  const hash = fixture.objects[0].sha256;
  const conflicting = signFiles({ 'a.json': { sha256: hash, size: 3 }, 'b.json': { sha256: hash, size: 4 } });
  assert.throws(() => validateManifest(conflicting), /size/i);
  assert.throws(() => parseManifestBytes(canonicalBytes(conflicting)), /size/i);
  const shared = signFiles({ 'a.json': { sha256: hash, size: 3 }, 'b.json': { sha256: hash, size: 3 } });
  assert.deepEqual(validateManifest(shared), shared);
});

test('path grammar rejects traversal, encoded separators and non-ASCII identities', () => {
  for (const path of [
    '../codexes.json', './codexes.json', '/codexes.json', 'a/../codexes.json',
    'a//b.json', 'a\\b.json', 'a%2fb.json', 'a.json?x=1', 'a.json#x', 'a..b.json', '.hidden.json', 'a/.hidden.json',
    'a/b.json/c.json', 'a.json/child.json', '中文.json', 'x.JSON', 'x.json\n', 'x.json\u2028', 'x.json\u2029',
    'x.json\0', 'a'.repeat(236) + '.json', '__proto__',
  ]) {
    const value = signFiles({ [path]: clone(manifest.files['codexes.json']) });
    assert.throws(() => validateManifest(value), undefined, path);
  }
});

test('manifest enforces schema, file count and numeric boundaries', () => {
  for (const schemaVersion of [1, '2', true, 2.1]) {
    assert.throws(() => validateManifest({ ...manifest, schemaVersion }));
  }
  for (const size of [true, false, 0, -1, 1.5, 268435457, Number.MAX_SAFE_INTEGER + 1, '70', null, NaN, Infinity]) {
    const value = clone(manifest);
    value.files['codexes.json'].size = size;
    assert.throws(() => validateManifest(signFiles(value.files)), undefined, String(size));
  }
  for (const files of [{}, Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`file_${i}.json`, manifest.files['codexes.json']]))]) {
    assert.throws(() => validateManifest(signFiles(files)));
  }
  assert.throws(() => validateManifest({ ...manifest, files: [] }));
  assert.throws(() => validateManifest({ ...manifest, files: null }));
  for (const hash of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), `${'a'.repeat(64)}\n`, `${'a'.repeat(64)}\u2028`, 'https://example.invalid/x']) {
    assert.throws(() => objectKey(hash));
    const value = clone(manifest);
    value.files['codexes.json'].sha256 = hash;
    assert.throws(() => validateManifest(signFiles(value.files)));
  }
  for (const release of [exactRelease, `r2-${'A'.repeat(64)}`, `${manifest.release}/../current`, `${manifest.release}\n`, `${manifest.release}\u2029`]) {
    assert.throws(() => manifestKey(release));
  }
});

test('valid exact path, size and file-count limits are accepted', () => {
  const metadata = { sha256: fixture.objects[0].sha256, size: 1 };
  const paths = ['a.json', 'A-Z_0/a_b-9.json', 'tutorials/composition.draft.json', 'tutorials/style.draft.json', `${'x'.repeat(235)}.json`];
  for (const path of paths) {
    assert.equal(Object.keys(validateManifest(signFiles({ [path]: metadata })).files)[0], path);
  }
  assert.equal(validateManifest(signFiles({ 'max.json': { ...metadata, size: 268435456 } })).files['max.json'].size, 268435456);
  const files = Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [`file_${i}.json`, metadata]));
  assert.equal(Object.keys(validateManifest(signFiles(files)).files).length, 4096);
  const integerValue = signFiles({ 'integer.json': { ...metadata, size: 2.0 } });
  integerValue.schemaVersion = 2.0;
  assert.equal(validateManifest(integerValue).files['integer.json'].size, 2);
  assert.equal(parseManifestBytes(canonicalBytes(integerValue)).files['integer.json'].size, 2);
});

test('validated manifests are detached from caller mutations', () => {
  const source = clone(manifest);
  const validated = validateManifest(source);
  source.files['codexes.json'].sha256 = 'a'.repeat(64);
  source.release = 'changed';
  assert.equal(validated.release, manifest.release);
  assert.equal(validated.files['codexes.json'].sha256, manifest.files['codexes.json'].sha256);
});

test('object API rejects getters and setters at manifest, files and metadata layers without invoking them', () => {
  for (const layer of ['manifest', 'files', 'metadata']) {
    for (const kind of ['getter', 'setter']) {
      const value = clone(manifest);
      const target = layer === 'manifest' ? value : layer === 'files' ? value.files : value.files['codexes.json'];
      const key = layer === 'manifest' ? 'release' : layer === 'files' ? 'codexes.json' : 'sha256';
      const original = target[key];
      let accesses = 0;
      const descriptor = kind === 'getter' ? { get() { accesses += 1; return original; } } : { set() { accesses += 1; } };
      Object.defineProperty(target, key, { ...descriptor, enumerable: true, configurable: true });
      assert.throws(() => validateManifest(value), /accessor/i, `${layer} ${kind}`);
      assert.equal(accesses, 0);
    }
  }
  const nullValue = Object.assign(Object.create(null), clone(manifest));
  nullValue.files = Object.assign(Object.create(null), nullValue.files);
  for (const key of Object.keys(nullValue.files)) nullValue.files[key] = Object.assign(Object.create(null), nullValue.files[key]);
  assert.deepEqual(validateManifest(nullValue), manifest);
});

test('read API rejects digest getter substitution before any body read', async () => {
  const value = clone(manifest);
  const original = value.files['codexes.json'].sha256;
  const forgedBody = Buffer.alloc(value.files['codexes.json'].size, 32);
  const forged = sha256(forgedBody);
  let accesses = 0;
  Object.defineProperty(value.files['codexes.json'], 'sha256', {
    enumerable: true, get() { accesses += 1; return accesses % 5 === 4 ? forged : original; },
  });
  const calls = [];
  await assert.rejects(readLogicalFile(value, 'codexes.json', key => { calls.push(key); return forgedBody; }), /accessor/i);
  assert.deepEqual(calls, []);
  assert.equal(accesses, 0);
});

test('reads deduplicated content by derived object key and preserves Chinese JSON bytes', async () => {
  const calls = [];
  const read = async key => { calls.push(key); return objects.get(key); };
  const original = await readLogicalFile(manifest, 'codexes.json', read);
  const alias = await readLogicalFile(manifest, 'shared/alias.json', read);
  assert.deepEqual(original, alias);
  assert.equal(JSON.parse(original.toString('utf8')).name, '本地隔离试验');
  assert.deepEqual(calls, [calls[0], calls[0]]);
});

test('reads reject missing bytes, forged metadata, wrong length and wrong same-length bytes', async () => {
  const expected = objects.get(fixture.objects[0].key);
  for (const supplied of [undefined, null, 'text', { body: expected, sha256: fixture.objects[0].sha256 }, expected.subarray(1), Buffer.alloc(expected.length, 32)]) {
    await assert.rejects(readLogicalFile(manifest, 'codexes.json', () => supplied));
  }
  await assert.rejects(readLogicalFile(manifest, 'codexes.json', () => { throw new Error('read failed'); }), /read failed/);
});

test('invalid manifests and missing logical paths never call storage', async () => {
  let calls = 0;
  const read = () => { calls += 1; return fixture.objects[0].bodyBase64; };
  await assert.rejects(readLogicalFile({ ...manifest, contentHash: 'a'.repeat(64) }, 'codexes.json', read));
  await assert.rejects(readLogicalFile(manifest, 'missing.json', read));
  await assert.rejects(readLogicalFile(manifest, '../codexes.json', read));
  assert.equal(calls, 0);
});

test('old URL compatibility reads only the explicitly mapped exact v2 release', async () => {
  const calls = [];
  const read = key => { calls.push(key); return objects.get(key); };
  const body = await resolveLegacyV2Url(legacyUrl('share/demo.json'), new Map([[manifest.release, manifest]]), read);
  assert.equal(JSON.parse(body.toString('utf8')).title, '分享样机');
  assert.deepEqual(calls, [fixture.objects[1].key]);
  await assert.rejects(resolveLegacyV2Url(`/data/releases/r2-${'a'.repeat(64)}/share/demo.json`, new Map([[manifest.release, manifest]]), read));
  await assert.rejects(resolveLegacyV2Url(legacyUrl('missing.json'), new Map([[manifest.release, manifest]]), read));
  assert.equal(calls.length, 1);
});

test('compatibility rejects normalization, current/previous and URL fallback routes', async () => {
  let calls = 0;
  const read = () => { calls += 1; throw new Error('must not read'); };
  for (const url of [
    '/data/current.json', '/data/v2/current.json', '/data/previous.json',
    `https://example.invalid${legacyUrl('codexes.json')}`, `${legacyUrl('codexes.json')}?x=1`,
    `${legacyUrl('codexes.json')}#x`, legacyUrl('../codexes.json'), legacyUrl('%2e%2e/codexes.json'),
    `/data/releases/${exactRelease}/codexes.json`,
  ]) {
    await assert.rejects(resolveLegacyV2Url(url, new Map([[manifest.release, manifest]]), read), undefined, url);
  }
  const invalid = { ...manifest, contentHash: 'a'.repeat(64) };
  await assert.rejects(resolveLegacyV2Url(legacyUrl('codexes.json'), new Map([[manifest.release, invalid]]), read));
  assert.equal(calls, 0);
});

test('v2 storage failure propagates without trying v1 or another release', async () => {
  const calls = [];
  await assert.rejects(resolveLegacyV2Url(legacyUrl('codexes.json'), new Map([[manifest.release, manifest]]), key => {
    calls.push(key);
    throw new Error('v2 object absent');
  }), /v2 object absent/);
  assert.deepEqual(calls, [fixture.objects[0].key]);
});

test('v1 local reader stays pinned to given exact release and rejects v2', async () => {
  const url = `/data/releases/${exactRelease}/share/demo.json`;
  const calls = [];
  const body = await readLegacyV1Url(url, exactRelease, key => { calls.push(key); return Buffer.from('{"v":1}'); });
  assert.equal(JSON.parse(body.toString('utf8')).v, 1);
  assert.deepEqual(calls, [`data/releases/${exactRelease}/share/demo.json`]);
  await assert.rejects(readLegacyV1Url(url, 'r-aaaaaaaaaaaaaaaaaaaa', () => { throw new Error('must not read'); }));
  await assert.rejects(readLegacyV1Url(legacyUrl('codexes.json'), exactRelease, () => { throw new Error('must not read'); }));
});

test('Python and JavaScript agree on exact fixture and invalid boundaries', () => {
  const python = process.env.R2_CAS_PYTHON || 'python';
  const program = `
import base64, json, socket, sys
def no_network(*args, **kwargs):
    raise RuntimeError('offline test forbids networking')
socket.socket = no_network
socket.create_connection = no_network
from tools.r2_cas_experiment.protocol import make_manifest, validate_manifest, parse_manifest_bytes, object_key
fixture = json.load(sys.stdin)
manifest = fixture['manifest']
assert validate_manifest(manifest) == manifest
assert make_manifest(manifest['files']) == manifest
assert make_manifest(fixture['dottedManifest']['files']) == fixture['dottedManifest']
assert validate_manifest(fixture['dottedManifest']) == fixture['dottedManifest']
try:
    validate_manifest(fixture['conflictingSizeManifest'])
except (ValueError, TypeError):
    pass
else:
    raise AssertionError('accepted one digest with inconsistent sizes')
canonical = (json.dumps(manifest, ensure_ascii=True, sort_keys=True, separators=(',', ':')) + '\\n').encode('utf-8')
assert canonical == base64.b64decode(fixture['canonicalManifestBase64'])
assert parse_manifest_bytes(canonical) == manifest
for original in fixture['invalidManifestBytesBase64']:
    try:
        parse_manifest_bytes(base64.b64decode(original))
    except (ValueError, TypeError, UnicodeError):
        pass
    else:
        raise AssertionError('accepted ambiguous raw JSON')
integer_manifest = make_manifest({'integer.json': {'sha256': fixture['objects'][0]['sha256'], 'size': 2.0}})
assert integer_manifest == fixture['integerManifest']
assert integer_manifest['files']['integer.json']['size'] == 2
assert type(integer_manifest['files']['integer.json']['size']) is int
integer_manifest['schemaVersion'] = 2.0
assert validate_manifest(integer_manifest)['schemaVersion'] == 2
for item in fixture['objects']:
    assert object_key(item['sha256']) == item['key']
for size in (True, False, 0, -1, 1.5, 268435457, '70', None):
    value = json.loads(json.dumps(manifest))
    value['files']['codexes.json']['size'] = size
    try:
        make_manifest(value['files'])
    except (ValueError, TypeError):
        pass
    else:
        raise AssertionError('accepted invalid size: ' + repr(size))
print(json.dumps({'status': 'PASS', 'release': manifest['release']}, sort_keys=True))
`;
  const env = Object.fromEntries(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  env.PYTHONUTF8 = '1';
  env.PYTHONDONTWRITEBYTECODE = '1';
  const raw = canonicalBytes(manifest).toString('utf8');
  const invalidManifestBytesBase64 = [
    raw.replace('{"contentHash":', '{"schemaVersion":2,"contentHash":'),
    raw.replace('"size":70', '"size":70.0'),
    raw.replace('"schemaVersion":2', '"schemaVersion":2e0'),
    ` ${raw}`, raw.trimEnd(),
  ].map(value => Buffer.from(value, 'utf8').toString('base64'));
  const result = spawnSync(python, ['-B', '-c', program], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    input: JSON.stringify({ ...fixture, invalidManifestBytesBase64, canonicalManifestBase64: canonicalBytes(manifest).toString('base64'), integerManifest: signFiles({ 'integer.json': { sha256: fixture.objects[0].sha256, size: 2 } }), dottedManifest: signFiles({ 'tutorials/composition.draft.json': manifest.files['codexes.json'], 'tutorials/style.draft.json': manifest.files['share/demo.json'] }), conflictingSizeManifest: signFiles({ 'a.json': { sha256: fixture.objects[0].sha256, size: 3 }, 'b.json': { sha256: fixture.objects[0].sha256, size: 4 } }) }),
    encoding: 'utf8', env, timeout: 30000,
  });
  assert.ifError(result.error && new Error(`BLOCKED: Python cross-language runner: ${result.error.message}`));
  assert.equal(result.status, 0, `Python protocol failed:\n${result.stdout || ''}\n${result.stderr || ''}`);
  assert.equal(JSON.parse(result.stdout).release, manifest.release);
});
