// Disposable test-bucket wrapper. /data/* is the unmodified active reader.
import compatWorker from '../r2-data-compat/worker.js';
import { objectPath, parseReleaseManifest, releaseManifestPath } from '../../site/assets/data-release.js';

const encoder = new TextEncoder();
const TEST_BUCKET = /^novelai-tag-r2-acceptance-[0-9]{8}-[0-9a-f]{8}$/;
const RUN_ID = /^[0-9a-f]{32}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const CASES = new Set(['probe', 'seed', 'switch', 'binding']);
const JSON_METADATA = { contentType: 'application/json; charset=utf-8' };

function exact(pattern, value) {
  return typeof value === 'string' && pattern.test(value) && !/[\r\n]/.test(value);
}
function fail(message, status = 409) {
  throw Object.assign(new Error(message), { status });
}
function requireTestEnvironment(env) {
  if (env.ATLAS_TEST_ONLY !== '1' || !exact(TEST_BUCKET, env.ATLAS_TEST_BUCKET_NAME)
      || env.ATLAS_TEST_WORKER_NAME !== env.ATLAS_TEST_BUCKET_NAME.replace('novelai-tag-r2-', 'atlas-r2-')
      || env.ATLAS_DATA_PREFIX !== 'data' || !env.ATLAS_DATA_BUCKET) fail('test environment unavailable', 503);
}
function probe(env) {
  return { bucket: env.ATLAS_TEST_BUCKET_NAME, worker: env.ATLAS_TEST_WORKER_NAME, testOnly: true };
}
function authenticated(request, env) {
  const expected = env.ATLAS_R2_TEST_TOKEN;
  const header = request.headers.get('authorization') || '';
  if (!exact(TOKEN, expected) || !/^Bearer [0-9a-f]{64}$/.test(header) || /[\r\n]/.test(header)) return false;
  const left = encoder.encode(header.slice(7));
  const right = encoder.encode(expected);
  // The format check fixes both operands at 64 bytes; never short circuit by byte.
  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(left, right);
  let difference = 0;
  for (let index = 0; index < 64; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}
async function hash(body) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)), value => value.toString(16).padStart(2, '0')).join('');
}
function jsonBody(value) { return encoder.encode(JSON.stringify(value) + '\n'); }
async function requestCase(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '')) fail('invalid test request', 400);
  const reader = request.body?.getReader();
  if (!reader) fail('invalid test request', 400);
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > 256) { await reader.cancel(); fail('invalid test request', 400); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { fail('invalid test request', 400); }
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'case') || !Object.hasOwn(value, 'runId')
      || !CASES.has(value.case) || !exact(RUN_ID, value.runId)) fail('invalid test request', 400);
  return value;
}
export async function buildFixture(runId) {
  if (!exact(RUN_ID, runId)) fail('invalid run id', 400);
  const versions = {};
  for (const version of ['old', 'new', 'bad']) {
    const body = jsonBody({ kind: 'r2-platform-fixture', runId, version });
    const digest = await hash(body);
    const files = { 'demo.json': { sha256: digest, size: body.byteLength } };
    const contentHash = await hash(encoder.encode('r2-cas-v2\ndemo.json\0' + digest + '\0' + body.byteLength + '\n'));
    const release = 'r2-' + contentHash;
    const manifestBody = jsonBody({ contentHash, files, release, schemaVersion: 2 });
    await parseReleaseManifest(manifestBody, release);
    versions[version] = { body, digest, release, manifestBody, v1Release: 'r-' + digest.slice(0, 20),
      blobKey: 'data/' + objectPath(digest), manifestKey: 'data/' + releaseManifestPath(release) };
  }
  const keys = [];
  for (const [version, value] of Object.entries(versions)) {
    if (version !== 'bad') keys.push('data/releases/' + value.v1Release + '/demo.json');
    keys.push(value.blobKey, value.manifestKey);
  }
  keys.push('data/current.json', 'data/v2/current.json');
  return { versions, keys };
}
function fixtureSummary(fixture) {
  return { keys: fixture.keys,
    versions: Object.fromEntries(Object.entries(fixture.versions).map(([name, value]) => [name, {
      release: value.release, v1Release: value.v1Release, sha256: value.digest,
      size: value.body.byteLength, blobKey: value.blobKey, manifestKey: value.manifestKey,
    }])) };
}
function pointerBody(value, runId, v2) {
  return v2 ? jsonBody({ schemaVersion: 2, release: value.release, contentHash: value.release.slice(3),
    manifest: value.manifestKey, publishedAt: '2026-10-21T00:00:00Z', operationId: runId })
    : jsonBody({ release: value.v1Release });
}
async function readBytes(bucket, key) {
  const object = await bucket.get(key);
  if (!object || object.size > 8192) fail('test object unavailable');
  const body = new Uint8Array(await object.arrayBuffer());
  if (body.byteLength > 8192) fail('test object unavailable');
  return { object, body };
}
function sameBytes(left, right) {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
async function createFixtureObject(bucket, key, body) {
  const result = await bucket.put(key, body, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: JSON_METADATA });
  if (!result && !sameBytes((await readBytes(bucket, key)).body, body)) fail('test fixture key already differs');
}
async function seed(bucket, runId) {
  const fixture = await buildFixture(runId);
  if (await bucket.head('data/current.json') || await bucket.head('data/v2/current.json')) fail('test pointers already exist');
  for (const [version, value] of Object.entries(fixture.versions)) {
    if (version !== 'bad') await createFixtureObject(bucket, 'data/releases/' + value.v1Release + '/demo.json', value.body);
    const storedBody = version === 'bad'
      ? jsonBody({ kind: 'r2-platform-fixture', runId, version: 'BAD' }) : value.body;
    await createFixtureObject(bucket, value.blobKey, storedBody);
    await createFixtureObject(bucket, value.manifestKey, value.manifestBody);
  }
  for (const v2 of [false, true]) {
    const key = v2 ? 'data/v2/current.json' : 'data/current.json';
    if (!await bucket.put(key, pointerBody(fixture.versions.old, runId, v2), {
      onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: JSON_METADATA,
    })) fail('test pointer create conflict');
  }
  return fixtureSummary(fixture);
}
async function switchCurrent(bucket, runId) {
  const fixture = await buildFixture(runId);
  const pointers = [];
  for (const v2 of [false, true]) {
    const key = v2 ? 'data/v2/current.json' : 'data/current.json';
    const previous = await readBytes(bucket, key);
    if (!sameBytes(previous.body, pointerBody(fixture.versions.old, runId, v2))) fail('test pointer is not expected old fixture');
    pointers.push({ key, v2, previous });
  }
  const changed = [];
  for (const { key, v2, previous } of pointers) {
    const result = await bucket.put(key, pointerBody(fixture.versions.new, runId, v2), {
      onlyIf: { etagMatches: previous.object.etag }, httpMetadata: JSON_METADATA,
    });
    if (!result) fail('test pointer CAS conflict');
    changed.push({ key, etag: result.etag, size: result.size });
  }
  return { ...fixtureSummary(fixture), changed };
}
async function bindingCases(bucket, runId) {
  const key = 'platform/' + runId + '/binding/conditional.json';
  const raceKey = 'platform/' + runId + '/binding/race.json';
  if (await bucket.head(key) || await bucket.head(raceKey)) fail('test binding keys already exist');
  const original = jsonBody({ runId, value: 'original' });
  const updated = jsonBody({ runId, value: 'updated' });
  const first = await bucket.put(key, original, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: JSON_METADATA });
  if (!first) fail('binding create-only failed');
  const duplicate = await bucket.put(key, updated, { onlyIf: { etagDoesNotMatch: '*' } });
  const wrong = await bucket.put(key, updated, { onlyIf: { etagMatches: 'wrong-test-etag' } });
  if (duplicate !== null || wrong !== null || !sameBytes((await readBytes(bucket, key)).body, original)) fail('binding rejected condition changed bytes');
  const correct = await bucket.put(key, updated, { onlyIf: { etagMatches: first.etag }, httpMetadata: JSON_METADATA });
  if (!correct) fail('binding correct ETag failed');
  const stale = await bucket.put(key, original, { onlyIf: { etagMatches: first.etag } });
  if (stale !== null || !sameBytes((await readBytes(bucket, key)).body, updated)) fail('binding stale condition changed bytes');
  const base = await bucket.put(raceKey, original, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: JSON_METADATA });
  if (!base) fail('binding race create failed');
  const candidates = ['one', 'two'].map(value => jsonBody({ runId, value }));
  const results = await Promise.all(candidates.map(body => bucket.put(raceKey, body, {
    onlyIf: { etagMatches: base.etag }, httpMetadata: JSON_METADATA,
  })));
  const winners = results.map((result, index) => result ? index : -1).filter(index => index >= 0);
  if (winners.length !== 1 || results.filter(result => result === null).length !== 1) fail('binding race did not have exactly one winner');
  const final = await readBytes(bucket, raceKey);
  if (!sameBytes(final.body, candidates[winners[0]]) || final.object.etag !== results[winners[0]].etag) fail('binding race final bytes mismatch');
  return { keys: [key, raceKey], checks: {
    createOnly: true, duplicateNull: duplicate === null, wrongEtagNull: wrong === null,
    correctEtag: true, staleNull: stale === null, raceOneWinner: true, raceFinalBytes: true,
  }, final: { key: raceKey, etag: final.object.etag, size: final.body.byteLength, sha256: await hash(final.body) } };
}
function jsonResponse(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/data/')) return compatWorker.fetch(request, env);
    if (url.pathname !== '/__test' || url.search) return new Response('not found', { status: 404 });
    if (!['GET', 'POST'].includes(request.method)) return new Response('method not allowed', { status: 405, headers: { allow: 'GET, POST' } });
    try {
      requireTestEnvironment(env);
      if (request.method === 'GET') return jsonResponse(probe(env));
      if (!authenticated(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);
      const value = await requestCase(request);
      const result = value.case === 'probe' ? probe(env)
        : value.case === 'seed' ? await seed(env.ATLAS_DATA_BUCKET, value.runId)
          : value.case === 'switch' ? await switchCurrent(env.ATLAS_DATA_BUCKET, value.runId)
            : await bindingCases(env.ATLAS_DATA_BUCKET, value.runId);
      return jsonResponse({ case: value.case, runId: value.runId, result });
    } catch (error) {
      // Never echo a platform exception, request, headers, body, or secret.
      const status = [400, 409, 503].includes(error.status) ? error.status : 503;
      return jsonResponse({ error: status === 400 ? 'invalid test request' : status === 409 ? 'test assertion or key conflict' : 'test unavailable' }, status);
    }
  },
};
