const LOCAL_DATA_BASE = '/data';
const CONFIG_URL = '/data-source.json';
const RELEASE_RE = /^r-[0-9a-f]{20}$/;

let sourcePromise = null;
let activeSource = {
  mode: 'static',
  baseUrl: LOCAL_DATA_BASE,
  release: '',
  publishedAt: '',
};

function cleanRelativePath(value) {
  const path = String(value || '').replace(/^\/+/, '');
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

function absoluteSiteUrl(path) {
  const loc = runtimeLocation();
  if (loc.protocol === 'file:') return String(path).replace(/^\//, '');
  return new URL(path, loc.href).href;
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

export async function initializeDataSource() {
  if (sourcePromise) return sourcePromise;
  sourcePromise = (async () => {
    if (isLocalRuntime()) return activeSource;
    try {
      const config = await fetchJsonUrl(absoluteSiteUrl(CONFIG_URL), 'no-store');
      if (!remoteHostAllowed(config)) return activeSource;
      const { baseUrl, pointer } = validateConfig(config);
      const current = await fetchJsonUrl(joinBase(baseUrl, pointer), 'no-store');
      const release = String(current?.release || '');
      if (!RELEASE_RE.test(release)) throw new Error('Invalid R2 data release pointer');
      activeSource = {
        mode: 'r2',
        baseUrl: `${baseUrl}/releases/${release}`,
        release,
        publishedAt: String(current.publishedAt || ''),
      };
    } catch (error) {
      console.warn('R2 data source unavailable; using the Pages snapshot.', error);
      activeSource = { ...activeSource, error };
    }
    return activeSource;
  })();
  return sourcePromise;
}

export function getDataSource() {
  return activeSource;
}

export async function fetchDataJsonResult(path, { cache = 'default', allowFallback = true } = {}) {
  const source = await initializeDataSource();
  const primaryUrl = joinBase(source.baseUrl, path);
  try {
    return {
      data: await fetchJsonUrl(primaryUrl, cache),
      source: source.mode,
      url: primaryUrl,
      release: source.release,
    };
  } catch (error) {
    if (source.mode !== 'r2' || !allowFallback) throw error;
    const fallbackUrl = joinBase(LOCAL_DATA_BASE, path);
    console.warn(`R2 data file unavailable; using Pages snapshot: ${path}`, error);
    return {
      data: await fetchJsonUrl(fallbackUrl, 'no-store'),
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
