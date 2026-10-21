/* Shared browser/Functions CAS v2 wire protocol. Storage and HTTP are supplied by callers. */
const SHA256_RE = /^[0-9a-f]{64}$/;
const V2_RELEASE_RE = /^r2-[0-9a-f]{64}$/;
const V1_RELEASE_RE = /^r-[0-9a-f]{20}$/;
const LOGICAL_PATH_RE = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.json$/;
const validatedManifests = new WeakSet();
function utf8(text) {
  return new TextEncoder().encode(text);
}

function exact(pattern, value) {
  return typeof value === 'string' && pattern.test(value) && !/[\r\n]/.test(value);
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) {
      throw new TypeError(`${label} must not contain accessors`);
    }
  }
}

function requireFields(value, fields, label) {
  requireRecord(value, label);
  if (Reflect.ownKeys(value).length !== fields.length || !fields.every(key => Object.hasOwn(value, key))) {
    throw new TypeError(`${label} has missing or unknown fields`);
  }
}

function requirePath(path) {
  if (!exact(LOGICAL_PATH_RE, path) || path === 'manifest.json' || path.length > 240) throw new TypeError('invalid logical JSON path');
}

function requireHash(hash) {
  if (!exact(SHA256_RE, hash)) throw new TypeError('invalid SHA-256');
}

function requireBytes(body) {
  if (!(body instanceof Uint8Array)) throw new TypeError('storage must return actual Uint8Array bytes');
  return body;
}

async function digest(body) {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', body);
  return Array.from(new Uint8Array(hash), item => item.toString(16).padStart(2, '0')).join('');
}

export function isV2Release(release) {
  return exact(V2_RELEASE_RE, release);
}

export function releaseManifestPath(release) {
  if (!isV2Release(release)) throw new TypeError('invalid v2 release');
  return `v2/releases/${release}/manifest.json`;
}

export function objectPath(sha256) {
  requireHash(sha256);
  return `objects/sha256/${sha256.slice(0, 2)}/${sha256}.json`;
}

async function validateManifest(value) {
  if (validatedManifests.has(value)) return value;
  requireFields(value, ['schemaVersion', 'release', 'contentHash', 'files'], 'manifest');
  if (value.schemaVersion !== 2 || !isV2Release(value.release)) throw new TypeError('invalid v2 manifest schema or release');
  requireHash(value.contentHash);
  requireRecord(value.files, 'manifest.files');
  const paths = Reflect.ownKeys(value.files);
  if (!paths.length || paths.length > 4096 || paths.some(path => typeof path !== 'string')) throw new TypeError('invalid manifest file count or key');
  const files = Object.create(null);
  const digestSizes = new Map();
  const identity = ['r2-cas-v2\n'];
  for (const path of paths.sort()) {
    requirePath(path);
    const item = value.files[path];
    requireFields(item, ['sha256', 'size'], `file ${path}`);
    requireHash(item.sha256);
    if (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > 32 * 1024 * 1024) throw new TypeError(`invalid size for ${path}`);
    if (digestSizes.has(item.sha256) && digestSizes.get(item.sha256) !== item.size) throw new TypeError('one digest has inconsistent sizes');
    digestSizes.set(item.sha256, item.size);
    files[path] = Object.freeze({ sha256: item.sha256, size: item.size });
    identity.push(`${path}\0${item.sha256}\0${item.size}\n`);
  }
  // Detach before awaiting so caller mutations cannot substitute identity fields.
  const release = value.release;
  const expectedHash = value.contentHash;
  const contentHash = await digest(utf8(identity.join('')));
  if (contentHash !== expectedHash || release !== `r2-${contentHash}`) throw new Error('manifest content identity mismatch');
  const manifest = Object.freeze({ schemaVersion: 2, release, contentHash, files: Object.freeze({ ...files }) });
  validatedManifests.add(manifest);
  return manifest;
}

export async function parseReleaseManifest(raw, expectedRelease) {
  releaseManifestPath(expectedRelease);
  // Keep an owned byte snapshot across the asynchronous identity check.
  const body = Uint8Array.from(requireBytes(raw));
  const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  const manifest = await validateManifest(JSON.parse(text));
  if (manifest.release !== expectedRelease) throw new Error('manifest release mismatch');
  const canonical = utf8(JSON.stringify({
    contentHash: manifest.contentHash,
    files: Object.fromEntries(Object.keys(manifest.files).sort().map(path => [path, {
      sha256: manifest.files[path].sha256, size: manifest.files[path].size,
    }])),
    release: manifest.release,
    schemaVersion: 2,
  }) + '\n');
  if (body.length !== canonical.length || body.some((item, index) => item !== canonical[index])) {
    throw new Error('manifest must use canonical JSON bytes');
  }
  return manifest;
}

export async function readV2Json(value, logical, loadBytes) {
  const manifest = await validateManifest(value);
  requirePath(logical);
  if (!Object.hasOwn(manifest.files, logical)) throw new Error('logical file is absent from this release');
  if (typeof loadBytes !== 'function') throw new TypeError('loadBytes callback is required');
  const item = manifest.files[logical];
  const body = Uint8Array.from(requireBytes(await loadBytes(objectPath(item.sha256))));
  if (body.byteLength !== item.size) throw new Error('object body size mismatch');
  if (await digest(body) !== item.sha256) throw new Error('object body SHA-256 mismatch');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
}

export function validateReleasePointer(value, dataPrefix = 'data') {
  requireRecord(value, 'pointer');
  if (exact(V1_RELEASE_RE, value.release)) return Object.freeze({ ...value });
  const fields = ['schemaVersion', 'release', 'contentHash', 'manifest', 'publishedAt', 'operationId'];
  if (Object.hasOwn(value, 'previousRelease')) fields.push('previousRelease');
  requireFields(value, fields, 'pointer');
  if (value.schemaVersion !== 2 || !isV2Release(value.release)) throw new TypeError('invalid v2 pointer schema or release');
  if (!exact(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/, dataPrefix)) throw new TypeError('invalid data prefix');
  if (value.contentHash !== value.release.slice(3) || value.manifest !== `${dataPrefix}/${releaseManifestPath(value.release)}`) throw new Error('pointer identity mismatch');
  if (!exact(/^[0-9a-f]{32}$/, value.operationId) || typeof value.publishedAt !== 'string' || !value.publishedAt) throw new TypeError('invalid publication metadata');
  if (Object.hasOwn(value, 'previousRelease') && (!isV2Release(value.previousRelease) || value.previousRelease === value.release)) throw new TypeError('invalid previous release');
  return Object.freeze({ ...value });
}
