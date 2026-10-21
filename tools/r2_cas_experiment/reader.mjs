// Offline CAS v2 protocol prototype. No production reader imports this module.
// Storage is supplied by the caller; there is no fetch, configuration or network client.
import { createHash } from 'node:crypto';

const SHA256_RE = /^[0-9a-f]{64}$/;
const RELEASE_RE = /^r2-[0-9a-f]{64}$/;
const V1_RELEASE_RE = /^r-[0-9a-f]{20}$/;
const LOGICAL_PATH_RE = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.json$/;
const MAX_FILES = 4096;
const MAX_PATH_LENGTH = 240;
const MAX_OBJECT_SIZE = 268435456;

function matchesExactly(pattern, value) {
  return typeof value === 'string' && pattern.test(value) && !value.includes('\n') && !value.includes('\r');
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} must not contain accessors`);
    }
  }
}

function requireFields(value, expected, label) {
  requireRecord(value, label);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || !expected.every(key => Object.hasOwn(value, key))) {
    throw new TypeError(`${label} has missing or unknown fields`);
  }
}

function requirePath(path) {
  if (!matchesExactly(LOGICAL_PATH_RE, path) || path.length > MAX_PATH_LENGTH) {
    throw new TypeError('invalid logical JSON path');
  }
}

function requireHash(sha256) {
  if (!matchesExactly(SHA256_RE, sha256)) throw new TypeError('invalid SHA-256');
}

function requireRelease(release) {
  if (!matchesExactly(RELEASE_RE, release)) throw new TypeError('invalid v2 release');
}

function digest(body) {
  return createHash('sha256').update(body).digest('hex');
}

/** Validate the complete manifest and return an immutable, detached snapshot. */
export function validateManifest(value) {
  requireFields(value, ['schemaVersion', 'release', 'contentHash', 'files'], 'manifest');
  if (value.schemaVersion !== 2) throw new TypeError('unsupported manifest schemaVersion');
  requireRelease(value.release);
  requireHash(value.contentHash);
  requireRecord(value.files, 'manifest.files');
  const paths = Reflect.ownKeys(value.files);
  if (paths.length < 1 || paths.length > MAX_FILES || paths.some(path => typeof path !== 'string')) {
    throw new TypeError('invalid manifest file count or key');
  }
  const files = Object.create(null);
  const digestSizes = new Map();
  const identity = ['r2-cas-v2\n'];
  for (const path of paths.sort()) {
    requirePath(path);
    const item = value.files[path];
    requireFields(item, ['sha256', 'size'], `file ${path}`);
    requireHash(item.sha256);
    if (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_OBJECT_SIZE) {
      throw new TypeError(`invalid size for ${path}`);
    }
    if (digestSizes.has(item.sha256) && digestSizes.get(item.sha256) !== item.size) {
      throw new Error('one content digest has inconsistent sizes');
    }
    digestSizes.set(item.sha256, item.size);
    files[path] = Object.freeze({ sha256: item.sha256, size: item.size });
    identity.push(`${path}\0${item.sha256}\0${item.size}\n`);
  }
  const contentHash = digest(Buffer.from(identity.join(''), 'utf8'));
  if (contentHash !== value.contentHash || value.release !== `r2-${contentHash}`) {
    throw new Error('manifest content identity mismatch');
  }
  // Normal object output keeps cross-language JSON equality straightforward.
  return Object.freeze({ schemaVersion: 2, release: value.release, contentHash, files: Object.freeze({ ...files }) });
}

/** Strict wire boundary: only the canonical UTF-8 serialization is accepted.
 * Duplicate JSON keys and alternate numeric spellings cannot equal these bytes.
 * Object callers use validateManifest; stored manifests use this byte parser.
 */
export function parseManifestBytes(raw) {
  const body = requireBytes(raw);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  const manifest = validateManifest(JSON.parse(text));
  const canonical = Buffer.from(JSON.stringify({
    contentHash: manifest.contentHash,
    files: Object.fromEntries(Object.keys(manifest.files).sort().map(path => [path, {
      sha256: manifest.files[path].sha256, size: manifest.files[path].size,
    }])),
    release: manifest.release,
    schemaVersion: manifest.schemaVersion,
  }) + '\n', 'utf8');
  if (!body.equals(canonical)) throw new Error('manifest must use canonical JSON bytes');
  return manifest;
}

export function objectKey(sha256) {
  requireHash(sha256);
  return `data/objects/sha256/${sha256.slice(0, 2)}/${sha256}.json`;
}

export function manifestKey(release) {
  requireRelease(release);
  return `data/v2/releases/${release}/manifest.json`;
}

function requireBytes(value) {
  if (!(value instanceof Uint8Array)) throw new TypeError('storage callback must return actual Uint8Array bytes');
  return Buffer.from(value);
}

/** Read actual bytes and verify length/hash; metadata never substitutes for a body. */
export async function readLogicalFile(manifestValue, path, readObject) {
  const manifest = validateManifest(manifestValue);
  requirePath(path);
  if (!Object.hasOwn(manifest.files, path)) throw new Error('logical file is absent from this release');
  if (typeof readObject !== 'function') throw new TypeError('readObject callback is required');
  const item = manifest.files[path];
  const body = requireBytes(await readObject(objectKey(item.sha256)));
  if (body.byteLength !== item.size) throw new Error('object body size mismatch');
  if (digest(body) !== item.sha256) throw new Error('object body SHA-256 mismatch');
  return body;
}

function parseLegacyUrl(url, releasePattern) {
  if (typeof url !== 'string') throw new TypeError('legacy URL must be an exact pathname');
  // Deliberately do not normalize/decode via URL: traversal and encoded input fail closed.
  const match = /^\/data\/releases\/([^/]+)\/(.+)$/.exec(url);
  if (!match || !matchesExactly(releasePattern, match[1])) throw new TypeError('invalid legacy release URL');
  requirePath(match[2]);
  return { release: match[1], path: match[2] };
}

/** Local compatibility prototype: explicitly supplied release map, never current/previous. */
export async function resolveLegacyV2Url(url, manifests, readObject) {
  const { release, path } = parseLegacyUrl(url, RELEASE_RE);
  let value;
  if (manifests instanceof Map) {
    value = manifests.get(release);
  } else {
    requireRecord(manifests, 'release map');
    if (Object.hasOwn(manifests, release)) value = manifests[release];
  }
  if (!value) throw new Error('v2 release was not explicitly supplied');
  const manifest = validateManifest(value);
  if (manifest.release !== release) throw new Error('URL and supplied manifest release differ');
  return readLogicalFile(manifest, path, readObject);
}

/** Separate v1 path reader; v2 failures cannot enter this function as a fallback. */
export async function readLegacyV1Url(url, expectedRelease, readExactPath) {
  if (!matchesExactly(V1_RELEASE_RE, expectedRelease)) throw new TypeError('invalid exact v1 release');
  const { release, path } = parseLegacyUrl(url, V1_RELEASE_RE);
  if (release !== expectedRelease) throw new Error('v1 reader release mismatch');
  if (typeof readExactPath !== 'function') throw new TypeError('readExactPath callback is required');
  return requireBytes(await readExactPath(`data/releases/${release}/${path}`));
}
