/* 数据源解析：正式域读 R2 不可变 release，其余一律读随站点部署的 data/ 快照。
   路径全部相对于文档基址，子路径部署（GitHub Pages 项目站）同样可用。 */
const LOCAL_DATA_BASE = 'data';
const CONFIG_URL = 'data-source.json';
const RELEASE_RE = /^r-[0-9a-f]{20}$/;
/* 索引类文件决定分级门控与图片来源，一旦回退就把整个会话降级，
   避免"新 release 的分书 + 旧快照的索引"混读造成门控错配。 */
const DEMOTING_PATHS = new Set(['codexes.json', 'media.json']);

let sourcePromise = null;
let activeSource = {
  mode: 'static',
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

function demoteToStatic(error) {
  activeSource = {
    mode: 'static',
    baseUrl: LOCAL_DATA_BASE,
    release: '',
    publishedAt: '',
    degraded: true,
    error,
  };
}

export async function initializeDataSource() {
  if (!sourcePromise) {
    sourcePromise = (async () => {
      if (isLocalRuntime()) return;
      try {
        const config = await fetchJsonUrl(absoluteSiteUrl(CONFIG_URL), 'no-store');
        if (!remoteHostAllowed(config)) return;
        const { baseUrl, pointer } = validateConfig(config);
        const current = await fetchJsonUrl(joinBase(baseUrl, pointer), 'no-store');
        const release = String(current?.release || '');
        if (!RELEASE_RE.test(release)) throw new Error('Invalid R2 data release pointer');
        activeSource = {
          mode: 'r2',
          baseUrl: `${baseUrl}/releases/${release}`,
          release,
          publishedAt: String(current.publishedAt || ''),
          degraded: false,
        };
      } catch (error) {
        console.warn('R2 data source unavailable; using the deployed snapshot.', error);
        activeSource = { ...activeSource, error };
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
  return source.degraded ? 'static-fallback' : 'static';
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
    const fallbackUrl = joinBase(LOCAL_DATA_BASE, path);
    console.warn(`R2 data file unavailable; using the deployed snapshot: ${path}`, error);
    const data = await fetchJsonUrl(fallbackUrl, 'no-store');
    if (DEMOTING_PATHS.has(normalizeKey(path))) demoteToStatic(error);
    return {
      data,
      source: 'static-fallback',
      url: fallbackUrl,
      release: source.release,
      error,
    };
  }
}

export async function fetchDataJson(path, options) {
  return (await fetchDataJsonResult(path, options)).data;
}
