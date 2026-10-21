/* 数据源解析：正式域优先直连 R2；Pages Preview 与公网直连故障时，
   通过同源 /data Pages Function 读取同一个不可变 R2 release。
   localhost、file: 与独立本地版继续读取本机 site/data。 */
import {
  isV2Release, releaseManifestPath, parseReleaseManifest, objectPath, readV2Json, validateReleasePointer,
} from './data-release.js';

const LOCAL_DATA_BASE = 'data';
const CONFIG_URL = 'data-source.json';
const DEMOTING_PATHS = new Set(['codexes.json', 'media.json']);
const manifestPromises = new WeakMap();
let sourcePromise = null;
let activeSource = { mode: 'local', baseUrl: LOCAL_DATA_BASE, release: '', publishedAt: '', degraded: false };

function normalizeKey(value) {
  return String(value || '').replace(/^\/+/, '');
}

function cleanRelativePath(value) {
  const path = normalizeKey(value);
  if (!path || path.split('/').includes('..')) throw new Error(`Invalid data path: ${value}`);
  return path.split('/').map(encodeURIComponent).join('/');
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function runtimeLocation() {
  return globalThis.location || { href: 'http://localhost/', hostname: 'localhost', protocol: 'http:' };
}

function isLocalRuntime() {
  const loc = runtimeLocation();
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(loc.hostname);
  const localEdition = globalThis.document?.body?.classList?.contains('local-edition') === true;
  return localHost || loc.protocol === 'file:' || localEdition;
}

function documentBase() {
  return globalThis.document?.baseURI || runtimeLocation().href;
}

function absoluteSiteUrl(path) {
  const relative = normalizeKey(path);
  if (runtimeLocation().protocol === 'file:') return relative;
  return new URL(relative, documentBase()).href;
}

function joinBase(baseUrl, path) {
  const encoded = cleanRelativePath(path);
  if (baseUrl.startsWith('http://') || baseUrl.startsWith('https://')) return `${stripTrailingSlash(baseUrl)}/${encoded}`;
  return absoluteSiteUrl(`${stripTrailingSlash(baseUrl)}/${encoded}`);
}

async function fetchResponse(url, cache, signal) {
  const response = await fetch(url, { cache, ...(signal ? { signal } : {}) });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${url}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

async function fetchJsonUrl(url, cache, signal) {
  return (await fetchResponse(url, cache, signal)).json();
}

async function fetchBytesUrl(url, cache, signal) {
  return new Uint8Array(await (await fetchResponse(url, cache, signal)).arrayBuffer());
}

function remoteHostAllowed(config) {
  const hosts = Array.isArray(config?.remoteHosts) ? config.remoteHosts.map(String) : [];
  return hosts.includes('*') || hosts.includes(runtimeLocation().hostname);
}

function validateConfig(config) {
  if (!config || Number(config.schemaVersion) !== 1) throw new Error('Unsupported data source config');
  const baseUrl = stripTrailingSlash(config.baseUrl);
  if (new URL(baseUrl).protocol !== 'https:') throw new Error('R2 data baseUrl must use HTTPS');
  // v2 is an explicit program rollout switch. The legacy pointer remains independent.
  const v2 = Object.hasOwn(config, 'v2Pointer');
  const rawPointer = v2 ? config.v2Pointer : config.pointer || 'current.json';
  if (typeof rawPointer !== 'string' || (v2 && rawPointer !== 'v2/current.json')) throw new Error('Invalid data pointer path');
  const dataPrefix = config.dataPrefix ?? new URL(baseUrl).pathname.replace(/^\/+|\/+$/g, '');
  if (v2 && (typeof dataPrefix !== 'string' || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(dataPrefix)
      || /[\r\n]/.test(dataPrefix))) throw new Error('Invalid data storage prefix');
  return { baseUrl, pointer: cleanRelativePath(rawPointer), v2, dataPrefix };
}

/* 启动预取只认领一次；新模块不能把旧 HTML 提前发出的 v1 指针误当 v2。 */
function claimBoot(key) {
  const boot = globalThis.__atlasBoot;
  const promise = boot?.[key];
  if (!promise) return null;
  boot[key] = null;
  return promise;
}

function claimBootPointer(pointer, baseUrl) {
  const boot = globalThis.__atlasBoot;
  if (!boot || (boot.pointerPath || 'current.json') !== pointer
      || (boot.baseUrl && stripTrailingSlash(boot.baseUrl) !== baseUrl)) return null;
  return claimBoot('pointer');
}

function releaseSource(mode, root, current, { degraded = false, error = null } = {}) {
  const v2 = isV2Release(current.release);
  return {
    mode,
    dataBaseUrl: stripTrailingSlash(root),
    baseUrl: `${stripTrailingSlash(root)}/${v2 ? 'v2/' : ''}releases/${current.release}`,
    release: current.release,
    publishedAt: String(current.publishedAt || ''),
    v2,
    degraded,
    ...(error ? { error } : {}),
  };
}

async function selectReleaseSource(mode, root, pointer, { v2 = false, dataPrefix = 'data', degraded = false, error = null, prefetched = null } = {}) {
  const fetchPointer = () => fetchJsonUrl(joinBase(root, pointer), 'no-store');
  const raw = await (prefetched ? prefetched.catch(fetchPointer) : fetchPointer());
  // Legacy pointers historically require only a release field; keep that boundary unchanged.
  const current = v2 ? validateReleasePointer(raw, dataPrefix) : { release: String(raw?.release || ''), publishedAt: raw?.publishedAt };
  if (v2 ? !isV2Release(current.release) : !/^r-[0-9a-f]{20}$/.test(current.release) || /[\r\n]/.test(current.release)) throw new Error('Data pointer protocol mismatch');
  activeSource = releaseSource(mode, root, current, { degraded, error });
  return activeSource;
}

function localSource(error = null) {
  activeSource = { mode: 'local', baseUrl: LOCAL_DATA_BASE, release: '', publishedAt: '', degraded: false, ...(error ? { error } : {}) };
  return activeSource;
}

function sameReleaseProxy(source, error) {
  return releaseSource('proxy', LOCAL_DATA_BASE, source, { degraded: true, error });
}

function proxySourceForRelease(source, error) {
  activeSource = sameReleaseProxy(source, error);
  return activeSource;
}

export async function initializeDataSource() {
  if (!sourcePromise) {
    sourcePromise = (async () => {
      if (isLocalRuntime()) return localSource();
      let selection = { pointer: 'current.json', v2: false };
      try {
        const fetchConfig = () => fetchJsonUrl(absoluteSiteUrl(CONFIG_URL), 'no-store');
        const bootConfig = claimBoot('config');
        const config = await (bootConfig ? bootConfig.catch(fetchConfig) : fetchConfig());
        // A declared rollout must not silently switch protocol on invalid configuration.
        if (config && Object.hasOwn(config, 'v2Pointer')) selection = { pointer: 'v2/current.json', v2: true };
        selection = validateConfig(config);
        if (remoteHostAllowed(config)) {
          try {
            return await selectReleaseSource('r2', selection.baseUrl, selection.pointer, {
              v2: selection.v2, dataPrefix: selection.dataPrefix, prefetched: claimBootPointer(selection.pointer, selection.baseUrl),
            });
          } catch (error) {
            console.warn('Public R2 pointer unavailable; using the Pages data proxy.', error);
            try {
              return await selectReleaseSource('proxy', LOCAL_DATA_BASE, selection.pointer, { v2: selection.v2, dataPrefix: selection.dataPrefix, degraded: true, error });
            } catch (proxyError) {
              if (selection.v2) throw proxyError;
              console.warn('Pages data proxy unavailable; trying local site data.', proxyError);
              return localSource(proxyError);
            }
          }
        }
      } catch (error) {
        console.warn('Data source config unavailable; trying the Pages data proxy.', error);
      }
      try {
        return await selectReleaseSource('proxy', LOCAL_DATA_BASE, selection.pointer, { v2: selection.v2, dataPrefix: selection.dataPrefix });
      } catch (error) {
        if (selection.v2) throw error;
        console.warn('Pages data proxy unavailable; trying local site data.', error);
        return localSource(error);
      }
    })();
  }
  const pending = sourcePromise;
  try {
    await pending;
  } catch (error) {
    if (sourcePromise === pending) sourcePromise = null;
    throw error;
  }
  return activeSource;
}

export function getDataSource() {
  return activeSource;
}

function sourceLabel(source) {
  if (source.mode === 'r2') return 'r2';
  if (source.mode === 'proxy') return source.degraded ? 'proxy-fallback' : 'proxy';
  return 'local';
}

function loadManifest(source, signal) {
  let shared = manifestPromises.get(source);
  if (!shared) {
    const controller = new AbortController();
    shared = { controller, consumers: 0, settled: false, promise: null };
    const current = shared;
    current.promise = (async () => parseReleaseManifest(await fetchBytesUrl(
      joinBase(source.dataBaseUrl, releaseManifestPath(source.release)),
      source.degraded ? 'no-store' : 'default', controller.signal,
    ), source.release))();
    manifestPromises.set(source, current);
    current.promise.then(() => { current.settled = true; }, () => {
      current.settled = true;
      if (manifestPromises.get(source) === current) manifestPromises.delete(source);
    });
  }
  shared.consumers++;
  const current = shared;
  return awaitShared(current.promise, signal).finally(() => {
    current.consumers--;
    // Retain a successful immutable manifest. No consumer should inherit abandoned work.
    if (!current.settled && current.consumers === 0) {
      if (manifestPromises.get(source) === current) manifestPromises.delete(source);
      current.controller.abort();
    }
  });
}
/* 单个调用取消只结束自己的等待，不取消同页其它调用共享的指针或清单。 */
function awaitShared(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
async function readSource(path, source, cache, signal) {
  signal?.throwIfAborted();
  if (!source.v2) {
    const url = joinBase(source.baseUrl, path);
    return { data: await fetchJsonUrl(url, cache, signal), url };
  }
  const manifest = await loadManifest(source, signal);
  signal?.throwIfAborted();
  const logical = normalizeKey(path);
  const meta = manifest.files[logical];
  // readV2Json checks path grammar, membership and actual bytes before returning data.
  const url = source.mode === 'r2' && meta
    ? joinBase(source.dataBaseUrl, objectPath(meta.sha256))
    : joinBase(source.baseUrl, logical);
  const data = await readV2Json(manifest, logical, () => fetchBytesUrl(url, cache, signal));
  signal?.throwIfAborted();
  return { data, url };
}

function normalizeBatchRequest(request) {
  const spec = typeof request === 'string' ? { path: request } : { ...(request || {}) };
  return {
    path: normalizeKey(spec.path), cache: spec.cache || 'default',
    hasFallbackValue: Object.prototype.hasOwnProperty.call(spec, 'fallbackValue'), fallbackValue: spec.fallbackValue,
  };
}

async function fetchSourceResult(spec, source, primaryError = null) {
  try {
    return {
      ...await readSource(spec.path, source, primaryError || source.degraded ? 'no-store' : spec.cache),
      source: primaryError ? 'proxy-fallback' : sourceLabel(source), release: source.release,
      ...(primaryError ? { error: primaryError } : {}),
    };
  } catch (error) {
    if (!spec.hasFallbackValue) throw error;
    return { data: spec.fallbackValue, source: sourceLabel(source), url: joinBase(source.baseUrl, spec.path), release: source.release, error };
  }
}

/* 启动数据按批次决定通道：公网 codexes/media 失败时丢弃本批结果，
   再从同 release 的 Pages 代理完整重读，不能切回其它 current。 */
export async function fetchDataJsonBatch(requests) {
  const specs = Array.from(requests || [], normalizeBatchRequest);
  const source = await initializeDataSource();
  if (source.mode !== 'r2') return Promise.all(specs.map(spec => fetchSourceResult(spec, source)));
  const primary = await Promise.allSettled(specs.map(spec => readSource(spec.path, source, spec.cache)));
  const demotingFailure = primary.findIndex((result, index) => result.status === 'rejected' && DEMOTING_PATHS.has(specs[index].path));
  if (demotingFailure >= 0 || activeSource !== source) {
    const error = demotingFailure >= 0 ? primary[demotingFailure].reason : activeSource.error || new Error('R2 data source changed during batch loading');
    console.warn('R2 bootstrap data unavailable; reloading the same release through Pages.', error);
    const proxy = activeSource === source ? proxySourceForRelease(source, error) : activeSource;
    return Promise.all(specs.map(spec => fetchSourceResult(spec, proxy, error)));
  }
  const proxy = sameReleaseProxy(source);
  return Promise.all(primary.map((result, index) => {
    if (result.status === 'fulfilled') return { ...result.value, source: 'r2', release: source.release };
    console.warn(`R2 data file unavailable; using the Pages proxy: ${specs[index].path}`, result.reason);
    return fetchSourceResult(specs[index], proxy, result.reason);
  }));
}

export async function fetchDataJsonResult(path, { cache = 'default', allowFallback = true, signal } = {}) {
  signal?.throwIfAborted();
  const source = await awaitShared(initializeDataSource(), signal);
  signal?.throwIfAborted();
  try {
    return { ...await readSource(path, source, cache, signal), source: sourceLabel(source), release: source.release };
  } catch (error) {
    signal?.throwIfAborted();
    if (source.mode !== 'r2' || !allowFallback) throw error;
    const proxy = DEMOTING_PATHS.has(normalizeKey(path)) ? proxySourceForRelease(source, error) : sameReleaseProxy(source, error);
    console.warn(`R2 data file unavailable; using the Pages proxy: ${path}`, error);
    return { ...await readSource(path, proxy, 'no-store', signal), source: 'proxy-fallback', release: source.release, error };
  }
}

export async function fetchDataJson(path, options) {
  return (await fetchDataJsonResult(path, options)).data;
}
