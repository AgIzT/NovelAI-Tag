/* 数据源解析：正式域优先直连 R2；Pages Preview 与公网直连故障时，
   通过同源 /data Pages Function 读取同一个不可变 R2 release。
   localhost、file: 与独立本地版继续读取本机 site/data。 */
const LOCAL_DATA_BASE = 'data';
const CONFIG_URL = 'data-source.json';
const RELEASE_RE = /^r-[0-9a-f]{20}$/;
/* 索引类文件决定分级门控与图片来源，一旦公网直连失败就把整个会话
   切到同一 release 的 Pages 代理，避免不同 release 混读造成门控错配。 */
const DEMOTING_PATHS = new Set(['codexes.json', 'media.json']);

let sourcePromise = null;
let activeSource = {
  mode: 'local',
  baseUrl: LOCAL_DATA_BASE,
  release: '',
  publishedAt: '',
  degraded: false,
};

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
  if (baseUrl.startsWith('http://') || baseUrl.startsWith('https://')) {
    return `${stripTrailingSlash(baseUrl)}/${encoded}`;
  }
  return absoluteSiteUrl(`${stripTrailingSlash(baseUrl)}/${encoded}`);
}

async function fetchJsonUrl(url, cache) {
  const response = await fetch(url, { cache });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

function remoteHostAllowed(config) {
  const hosts = Array.isArray(config?.remoteHosts) ? config.remoteHosts.map(String) : [];
  const hostname = runtimeLocation().hostname;
  return hosts.includes('*') || hosts.includes(hostname);
}

function validateConfig(config) {
  if (!config || Number(config.schemaVersion) !== 1) throw new Error('Unsupported data source config');
  const baseUrl = stripTrailingSlash(config.baseUrl);
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:') throw new Error('R2 data baseUrl must use HTTPS');
  const pointer = cleanRelativePath(config.pointer || 'current.json');
  return { baseUrl, pointer };
}

async function selectReleaseSource(mode, baseUrl, pointer, { degraded = false, error = null } = {}) {
  const current = await fetchJsonUrl(joinBase(baseUrl, pointer), 'no-store');
  const release = String(current?.release || '');
  if (!RELEASE_RE.test(release)) throw new Error('Invalid R2 data release pointer');
  activeSource = {
    mode,
    baseUrl: `${stripTrailingSlash(baseUrl)}/releases/${release}`,
    release,
    publishedAt: String(current.publishedAt || ''),
    degraded,
    ...(error ? { error } : {}),
  };
  return activeSource;
}

function localSource(error = null) {
  activeSource = {
    mode: 'local',
    baseUrl: LOCAL_DATA_BASE,
    release: '',
    publishedAt: '',
    degraded: false,
    ...(error ? { error } : {}),
  };
  return activeSource;
}

function proxySourceForRelease(source, error) {
  activeSource = {
    mode: 'proxy',
    baseUrl: `${LOCAL_DATA_BASE}/releases/${source.release}`,
    release: source.release,
    publishedAt: source.publishedAt,
    degraded: true,
    error,
  };
  return activeSource;
}

export async function initializeDataSource() {
  if (!sourcePromise) {
    sourcePromise = (async () => {
      if (isLocalRuntime()) return localSource();

      let config;
      try {
        config = await fetchJsonUrl(absoluteSiteUrl(CONFIG_URL), 'no-store');
        if (remoteHostAllowed(config)) {
          const { baseUrl, pointer } = validateConfig(config);
          try {
            return await selectReleaseSource('r2', baseUrl, pointer);
          } catch (error) {
            console.warn('Public R2 data source unavailable; using the Pages data proxy.', error);
            try {
              return await selectReleaseSource('proxy', LOCAL_DATA_BASE, 'current.json', {
                degraded: true,
                error,
              });
            } catch (proxyError) {
              console.warn('Pages data proxy unavailable; trying local site data.', proxyError);
              return localSource(proxyError);
            }
          }
        }
      } catch (error) {
        console.warn('Data source config unavailable; trying the Pages data proxy.', error);
      }

      try {
        return await selectReleaseSource('proxy', LOCAL_DATA_BASE, 'current.json');
      } catch (error) {
        console.warn('Pages data proxy unavailable; trying local site data.', error);
        return localSource(error);
      }
    })();
  }
  await sourcePromise;
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

function normalizeBatchRequest(request) {
  const spec = typeof request === 'string' ? { path: request } : { ...(request || {}) };
  return {
    path: normalizeKey(spec.path),
    cache: spec.cache || 'default',
    hasFallbackValue: Object.prototype.hasOwnProperty.call(spec, 'fallbackValue'),
    fallbackValue: spec.fallbackValue,
  };
}

async function fetchSourceResult(spec, source, primaryError = null) {
  const url = joinBase(source.baseUrl, spec.path);
  try {
    return {
      data: await fetchJsonUrl(url, primaryError || source.degraded ? 'no-store' : spec.cache),
      source: primaryError ? 'proxy-fallback' : sourceLabel(source),
      url,
      release: source.release,
      ...(primaryError ? { error: primaryError } : {}),
    };
  } catch (error) {
    if (!spec.hasFallbackValue) throw error;
    return {
      data: spec.fallbackValue,
      source: sourceLabel(source),
      url,
      release: source.release,
      error,
    };
  }
}

/* 启动数据必须按批次决定数据通道：公网 R2 的 demoting path 失败时，
   丢弃本批全部结果并从 Pages 代理重读同一个不可变 release。 */
export async function fetchDataJsonBatch(requests) {
  const specs = Array.from(requests || [], normalizeBatchRequest);
  const source = await initializeDataSource();
  if (source.mode !== 'r2') {
    return Promise.all(specs.map(spec => fetchSourceResult(spec, source)));
  }

  const primary = await Promise.allSettled(specs.map(spec => (
    fetchJsonUrl(joinBase(source.baseUrl, spec.path), spec.cache)
  )));
  const demotingFailure = primary.findIndex((result, index) => (
    result.status === 'rejected' && DEMOTING_PATHS.has(specs[index].path)
  ));
  if (demotingFailure >= 0 || activeSource !== source) {
    const error = demotingFailure >= 0
      ? primary[demotingFailure].reason
      : activeSource.error || new Error('R2 data source changed during batch loading');
    console.warn('R2 bootstrap data unavailable; reloading the same release through Pages.', error);
    const proxy = activeSource === source ? proxySourceForRelease(source, error) : activeSource;
    return Promise.all(specs.map(spec => fetchSourceResult(spec, proxy, error)));
  }

  const proxy = {
    mode: 'proxy',
    baseUrl: `${LOCAL_DATA_BASE}/releases/${source.release}`,
    release: source.release,
    publishedAt: source.publishedAt,
    degraded: true,
  };
  return Promise.all(primary.map((result, index) => {
    const spec = specs[index];
    if (result.status === 'fulfilled') {
      return {
        data: result.value,
        source: 'r2',
        url: joinBase(source.baseUrl, spec.path),
        release: source.release,
      };
    }
    console.warn(`R2 data file unavailable; using the Pages proxy: ${spec.path}`, result.reason);
    return fetchSourceResult(spec, proxy, result.reason);
  }));
}

export async function fetchDataJsonResult(path, { cache = 'default', allowFallback = true } = {}) {
  const source = await initializeDataSource();
  const primaryUrl = joinBase(source.baseUrl, path);
  try {
    return {
      data: await fetchJsonUrl(primaryUrl, cache),
      source: sourceLabel(source),
      url: primaryUrl,
      release: source.release,
    };
  } catch (error) {
    if (source.mode !== 'r2' || !allowFallback) throw error;
    const demoting = DEMOTING_PATHS.has(normalizeKey(path));
    const proxy = demoting
      ? proxySourceForRelease(source, error)
      : {
          mode: 'proxy',
          baseUrl: `${LOCAL_DATA_BASE}/releases/${source.release}`,
          release: source.release,
          publishedAt: source.publishedAt,
          degraded: true,
          error,
        };
    const fallbackUrl = joinBase(proxy.baseUrl, path);
    console.warn(`R2 data file unavailable; using the Pages proxy: ${path}`, error);
    return {
      data: await fetchJsonUrl(fallbackUrl, 'no-store'),
      source: 'proxy-fallback',
      url: fallbackUrl,
      release: source.release,
      error,
    };
  }
}

export async function fetchDataJson(path, options) {
  return (await fetchDataJsonResult(path, options)).data;
}
