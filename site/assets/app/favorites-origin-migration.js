import {
  ATLAS_FAVORITES_STORAGE_KEY,
  COMMUNITY_FAVORITES_STORAGE_KEY,
  FAVORITES_BACKUP_LIMITS,
  FavoritesBackupError,
  createFavoritesBackup,
  readStoredFavorites,
} from './favorites-backup-core.js';
import { restoreLibraryFavorites } from './favorites-backup-store.js';
import {
  FavoritesLibraryError,
  libraryKeys,
  migrateV1Favorites,
  parseStoredLibraryDocument,
} from './favorites-library-core.js';

export const FAVORITES_MIGRATION_VERSION = 1;
export const FAVORITES_MIGRATION_PATH = '/_favorites-migration-202607.html';
export const FAVORITES_MIGRATION_OLD_ORIGIN = 'https://novelai-tag.pages.dev';
export const FAVORITES_MIGRATION_NEW_ORIGIN = 'https://novelai.quicktagcloud.com';
export const FAVORITES_MIGRATION_CACHE_BUSTER_PARAM = 'bridge';
export const FAVORITES_MIGRATION_CACHE_BUSTER_VALUE = '20260721';
export const FAVORITES_MIGRATION_MARKER_KEY = 'novelai-tag-favorites-origin-migration-v1';
/* 首页横幅收档时间。原定 2026-11-01；2026-08-27 维护者判断迁移期已过、不必再在首页常驻，
   提前关掉。⚠ 只关横幅——救援页 `_favorites-migration-202607.html`、备份对话框里的找回入口
   与整条 postMessage 桥都保持可用（见 docs/decisions/旧Pages域收藏迁移桥.md）。 */
export const FAVORITES_MIGRATION_BANNER_END = Date.parse('2026-08-27T00:00:00+08:00');

/* 2026-11 换到 naitag.com。V2 收藏库带收藏夹、归类和备注，旧网址只交出原始字符串，
   解析、校验与合并都在新网址用现成的备份路径完成（见 docs/decisions/新网址收藏找回.md）。 */
export const FAVORITES_LIBRARY_MIGRATION_VERSION = 2;
export const FAVORITES_MOVE_PATH = '/_favorites-migration-202611.html';
export const FAVORITES_MOVE_OLD_ORIGIN = 'https://novelai.quicktagcloud.com';
export const FAVORITES_MOVE_NEW_ORIGIN = 'https://naitag.com';
export const FAVORITES_MOVE_CACHE_BUSTER_VALUE = '20261111';
export const FAVORITES_MOVE_MARKER_KEY = 'novelai-tag-favorites-origin-migration-202611';
// 只在 localhost / 127.0.0.1 读取：写入另一个本机 origin，就能用真实界面把整条桥跑一遍。
export const FAVORITES_DEV_BRIDGE_KEY = 'novelai-tag-dev-favorites-bridge';

export const FAVORITES_MIGRATION_BRIDGES = Object.freeze([
  Object.freeze({
    id: 'pages-dev-202607',
    oldOrigin: FAVORITES_MIGRATION_OLD_ORIGIN,
    newOrigin: FAVORITES_MIGRATION_NEW_ORIGIN,
    path: FAVORITES_MIGRATION_PATH,
    cacheBuster: FAVORITES_MIGRATION_CACHE_BUSTER_VALUE,
    markerKey: FAVORITES_MIGRATION_MARKER_KEY,
    bannerEnd: FAVORITES_MIGRATION_BANNER_END,
    version: FAVORITES_MIGRATION_VERSION,
    offer: false,
  }),
  Object.freeze({
    id: 'naitag-202611',
    oldOrigin: FAVORITES_MOVE_OLD_ORIGIN,
    newOrigin: FAVORITES_MOVE_NEW_ORIGIN,
    path: FAVORITES_MOVE_PATH,
    cacheBuster: FAVORITES_MOVE_CACHE_BUSTER_VALUE,
    markerKey: FAVORITES_MOVE_MARKER_KEY,
    bannerEnd: 0,
    version: FAVORITES_LIBRARY_MIGRATION_VERSION,
    offer: true,
  }),
]);

export const FAVORITES_MIGRATION_MESSAGES = Object.freeze({
  ready: 'ready',
  request: 'request',
  payload: 'payload',
  result: 'result',
});

const MIGRATION_TIMEOUT_MS = 20_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const LOCAL_ORIGIN_RE = /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/;
const LIBRARY_PAYLOAD_FIELDS = ['libraryRaw', 'communityRaw', 'legacyAtlasRaw'];

function fail(code, message, details = {}) {
  throw new FavoritesBackupError(code, message, details);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function encodedSize(value) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch (cause) {
    fail('INVALID_MIGRATION_PAYLOAD', '旧网址收藏数据无法序列化', { cause });
  }
  return new TextEncoder().encode(text).byteLength;
}

function devBridge(origin, storage) {
  let hostname;
  try { hostname = new URL(origin).hostname; } catch { return null; }
  if (!LOCAL_HOSTS.has(hostname)) return null;
  let oldOrigin = '';
  try { oldOrigin = storage?.getItem?.(FAVORITES_DEV_BRIDGE_KEY) || ''; } catch { return null; }
  if (!LOCAL_ORIGIN_RE.test(oldOrigin) || oldOrigin === origin) return null;
  const move = FAVORITES_MIGRATION_BRIDGES.find(bridge => bridge.id === 'naitag-202611');
  return { ...move, id: 'dev', oldOrigin, newOrigin: origin, targetOrigin: origin };
}

export function resolveFavoritesMigrationBridge({ origin, storage } = {}) {
  return FAVORITES_MIGRATION_BRIDGES.find(bridge => bridge.newOrigin === origin)
    || devBridge(origin, storage);
}

export function createFavoritesMigrationNonce(cryptoApi = globalThis.crypto) {
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    fail('MIGRATION_CRYPTO_UNAVAILABLE', '当前浏览器无法创建安全的迁移会话');
  }
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function buildFavoritesMigrationUrl({
  origin = FAVORITES_MIGRATION_OLD_ORIGIN,
  path = FAVORITES_MIGRATION_PATH,
  nonce = '',
  cacheBuster = FAVORITES_MIGRATION_CACHE_BUSTER_VALUE,
  targetOrigin = '',
} = {}) {
  const url = new URL(path, origin);
  // 上线切换期间访问过救援路径的浏览器可能永久缓存旧 301。
  // 使用不含用户数据的版本参数创建新的 HTTP 缓存键；安全 nonce 仍只放 fragment。
  url.searchParams.set(FAVORITES_MIGRATION_CACHE_BUSTER_PARAM, cacheBuster);
  if (targetOrigin) url.searchParams.set('targetOrigin', targetOrigin);
  if (nonce) url.hash = new URLSearchParams({ nonce }).toString();
  return url.toString();
}

export function readFavoritesMigrationMarker(storage, key = FAVORITES_MIGRATION_MARKER_KEY) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(key) || 'null');
    return isRecord(parsed) && typeof parsed.status === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function shouldShowFavoritesMigrationBanner({
  origin,
  storage,
  now = Date.now(),
  newOrigin = FAVORITES_MIGRATION_NEW_ORIGIN,
  bannerEnd = FAVORITES_MIGRATION_BANNER_END,
  markerKey = FAVORITES_MIGRATION_MARKER_KEY,
} = {}) {
  return origin === newOrigin
    && now < bannerEnd
    && !readFavoritesMigrationMarker(storage, markerKey);
}

/* 收藏空状态与备份对话框用：当前网址有可找回的旧网址、且这台浏览器还没找回过。 */
export function favoritesMigrationOffer({
  origin = globalThis.location?.origin,
  storage = globalThis.localStorage,
} = {}) {
  let bridge;
  try { bridge = resolveFavoritesMigrationBridge({ origin, storage }); } catch { return null; }
  if (!bridge?.offer || readFavoritesMigrationMarker(storage, bridge.markerKey)) return null;
  return bridge;
}

export function isTrustedFavoritesMigrationEvent(event, {
  source,
  origin = FAVORITES_MIGRATION_OLD_ORIGIN,
  nonce,
  type,
  version = FAVORITES_MIGRATION_VERSION,
} = {}) {
  return Boolean(
    event
    && event.origin === origin
    && event.source === source
    && isRecord(event.data)
    && event.data.type === type
    && event.data.version === version
    && event.data.nonce === nonce,
  );
}

export async function createFavoritesMigrationRestore({
  message,
  nonce,
  storage,
  codexes = [],
  restoreFavorites = restoreLibraryFavorites,
} = {}) {
  if (!isRecord(message)
    || message.type !== FAVORITES_MIGRATION_MESSAGES.payload
    || message.version !== FAVORITES_MIGRATION_VERSION
    || message.nonce !== nonce) {
    fail('INVALID_MIGRATION_MESSAGE', '旧网址收藏迁移消息无效');
  }

  const payload = {
    atlasKeys: message.atlasKeys,
    communityIds: message.communityIds,
  };
  if (!isRecord(payload)
    || !Array.isArray(payload.atlasKeys)
    || !Array.isArray(payload.communityIds)) {
    fail('INVALID_MIGRATION_PAYLOAD', '旧网址收藏数据结构无效');
  }
  if (encodedSize(payload) > FAVORITES_BACKUP_LIMITS.maxFileBytes) {
    fail('MIGRATION_TOO_LARGE', '旧网址收藏数据超过 2 MB，无法自动迁移');
  }

  const backup = createFavoritesBackup({
    atlasKeys: payload.atlasKeys,
    communityIds: payload.communityIds,
    codexes,
    exportedAt: new Date(),
  });
  const restored = await restoreFavorites({ backup, mode: 'merge', storage, codexes });
  return { backup, warnings: [], ...restored };
}

/* V2 载荷：旧网址 localStorage 的三份原始字符串。新网址按「从 JSON 恢复」同一条恢复预案与事务合并，
   收藏夹、归类和备注随收藏一起过来；V2 文档损坏时退回每次写入都会同步的 V1 镜像。 */
export async function createLibraryMigrationRestore({
  message,
  nonce,
  storage,
  codexes = [],
  restoreFavorites = restoreLibraryFavorites,
} = {}) {
  if (!isRecord(message)
    || message.type !== FAVORITES_MIGRATION_MESSAGES.payload
    || message.version !== FAVORITES_LIBRARY_MIGRATION_VERSION
    || message.nonce !== nonce) {
    fail('INVALID_MIGRATION_MESSAGE', '旧网址收藏迁移消息无效');
  }
  const raws = {};
  for (const field of LIBRARY_PAYLOAD_FIELDS) {
    const value = message[field];
    if (value !== null && value !== undefined && typeof value !== 'string') {
      fail('INVALID_MIGRATION_PAYLOAD', '旧网址收藏数据结构无效');
    }
    if (typeof value === 'string' && encodedSize(value) > FAVORITES_BACKUP_LIMITS.maxFileBytes) {
      fail('MIGRATION_TOO_LARGE', '旧网址收藏数据超过 2 MB，无法自动迁移');
    }
    raws[field] = typeof value === 'string' && value !== '' ? value : null;
  }

  const readRaw = (atlasRaw, communityRaw) => readStoredFavorites({
    getItem: key => key === ATLAS_FAVORITES_STORAGE_KEY ? atlasRaw
      : key === COMMUNITY_FAVORITES_STORAGE_KEY ? communityRaw : null,
    setItem: () => {},
  }, codexes);
  const community = readRaw(null, raws.communityRaw);
  const warnings = [];
  let skipped = community.skippedCount;
  let library = null;
  let libraryBroken = false;
  if (raws.libraryRaw) {
    try {
      library = parseStoredLibraryDocument(raws.libraryRaw, codexes);
    } catch (error) {
      if (!(error instanceof FavoritesLibraryError)) throw error;
      libraryBroken = true;
    }
  }
  if (!library) {
    const legacy = readRaw(raws.legacyAtlasRaw, null);
    skipped += legacy.skippedCount;
    if (libraryBroken) {
      if (!legacy.atlasKeys.length && !community.communityIds.length) {
        fail('MIGRATION_SOURCE_CORRUPT', '旧网址的收藏数据无法读取，没有找回任何内容');
      }
      warnings.push(legacy.atlasKeys.length
        ? '旧网址的收藏夹和备注无法读取，只找回了收藏'
        : '旧网址的法典收藏无法读取');
    }
    library = migrateV1Favorites(legacy.atlasKeys, { codexes });
  }
  if (skipped) warnings.push(`${skipped} 条格式异常的收藏已跳过`);

  // 直接组成已解析的备份，不经 2 MB 的备份文本：旧网址收藏库本身最多约 2 MB，换成备份格式会更大，
  // 最重的用户会被备份文件上限挡住。恢复预案仍会逐项重新校验收藏标识和收藏库（真实数据审计覆盖上限样本）。
  const backup = {
    ...createFavoritesBackup({ atlasKeys: libraryKeys(library), communityIds: community.communityIds, codexes }),
    version: 2,
    folders: library.folders,
    memberships: library.memberships,
    library,
  };
  const restored = await restoreFavorites({ backup, mode: 'merge', storage, codexes });
  return { backup, warnings, ...restored };
}

function writeMigrationMarker(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function migrationResultMessage(bridge, nonce, status, details = {}) {
  return {
    type: FAVORITES_MIGRATION_MESSAGES.result,
    version: bridge.version,
    nonce,
    status,
    ...details,
  };
}

function legacyOverrideBridge(options) {
  const [legacy] = FAVORITES_MIGRATION_BRIDGES;
  return {
    ...legacy,
    oldOrigin: options.oldOrigin || legacy.oldOrigin,
    newOrigin: options.newOrigin || legacy.newOrigin,
    path: options.migrationPath || legacy.path,
  };
}

export function setupFavoritesOriginMigration(options = {}) {
  const windowApi = options.window || globalThis.window;
  const documentApi = options.document || globalThis.document;
  const storage = options.storage || windowApi?.localStorage;
  if (!windowApi || !documentApi || !storage) return;

  const currentOrigin = options.currentOrigin || windowApi.location?.origin;
  const bridge = options.bridge
    || (options.oldOrigin || options.newOrigin || options.migrationPath
      ? legacyOverrideBridge(options)
      : resolveFavoritesMigrationBridge({ origin: currentOrigin, storage }));
  const root = options.root || documentApi;
  const all = selector => [...root.querySelectorAll(selector)];
  if (!bridge || currentOrigin !== bridge.newOrigin) {
    all('[data-favorites-migration-banner]').forEach(element => { element.hidden = true; });
    return;
  }
  if (root.documentElement?.dataset.favoritesMigrationBound === '1') return;
  if (root.documentElement) root.documentElement.dataset.favoritesMigrationBound = '1';

  const { oldOrigin, newOrigin, markerKey } = bridge;
  const library = bridge.version === FAVORITES_LIBRARY_MIGRATION_VERSION;
  const urlOptions = {
    origin: oldOrigin,
    path: bridge.path,
    cacheBuster: bridge.cacheBuster,
    targetOrigin: bridge.targetOrigin || '',
  };
  // 失败时给出这条桥能走通的下一步：旧 pages.dev 有 JSON 救援页，旧网址本身有取件码。
  const fallbackHint = library
    ? '或在旧网址的「收藏备份与恢复」生成取件码，到这里取件。'
    : '或手动打开救援页下载 JSON。';

  const showBanner = shouldShowFavoritesMigrationBanner({
    origin: currentOrigin,
    storage,
    now: options.now ?? Date.now(),
    newOrigin,
    bannerEnd: bridge.bannerEnd,
    markerKey,
  });
  all('[data-favorites-migration-banner]').forEach(element => { element.hidden = !showBanner; });
  if (bridge.offer) all('[data-favorites-migration-offer]').forEach(element => { element.hidden = false; });
  all('[data-favorites-migration-fallback]').forEach(link => {
    link.href = buildFavoritesMigrationUrl(urlOptions);
  });

  // 收藏空状态里的按钮和反馈行是重绘时生成的，每次都现查。
  const setFeedback = message => {
    all('[data-favorites-migration-feedback]').forEach(element => {
      element.textContent = message || '';
      element.hidden = !message;
    });
    options.onStatus?.(message || '');
  };
  const setError = message => {
    options.onError?.(message || '');
    if (message) setFeedback(message);
  };
  const setBusy = value => {
    all('[data-favorites-migration-start]').forEach(button => { button.disabled = Boolean(value); });
    options.onBusy?.(Boolean(value));
  };
  const hideBanners = () => all('[data-favorites-migration-banner]').forEach(element => { element.hidden = true; });

  let session = null;
  const cleanup = () => {
    if (!session) return;
    windowApi.clearTimeout(session.timeoutId);
    windowApi.removeEventListener('message', session.onMessage);
    session = null;
    setBusy(false);
  };

  const start = async () => {
    if (session) return;
    options.onError?.('');
    setFeedback('正在连接旧网址…');
    setBusy(true);

    let nonce;
    try {
      nonce = createFavoritesMigrationNonce(options.crypto || windowApi.crypto);
    } catch (error) {
      setError(error.message || '无法创建收藏迁移会话。');
      setBusy(false);
      return;
    }
    const trusted = (event, type) => isTrustedFavoritesMigrationEvent(event, {
      source: session?.popup,
      origin: oldOrigin,
      nonce,
      type,
      version: bridge.version,
    });

    const onMessage = async event => {
      const popup = session?.popup;
      if (!popup) return;

      if (trusted(event, FAVORITES_MIGRATION_MESSAGES.ready)) {
        try {
          popup.postMessage({
            type: FAVORITES_MIGRATION_MESSAGES.request,
            version: bridge.version,
            nonce,
          }, oldOrigin);
        } catch {
          setError('找回窗口已关闭，再点一次「找回旧收藏」。');
          cleanup();
          return;
        }
        setFeedback('已连上旧网址，正在合并收藏…');
        return;
      }

      if (!trusted(event, FAVORITES_MIGRATION_MESSAGES.payload)) return;
      if (session.processingPayload) return;
      session.processingPayload = true;
      windowApi.clearTimeout(session.timeoutId);
      session.timeoutId = null;

      const postResult = message => {
        try {
          popup.postMessage(message, oldOrigin);
        } catch {
          // 收藏已在新网址事务式写入时，旧窗口提前关闭不应把成功误报为失败。
        }
      };

      try {
        const codexes = await options.getCodexes?.() || [];
        const migrated = await (library ? createLibraryMigrationRestore : createFavoritesMigrationRestore)({
          message: event.data,
          nonce,
          storage,
          codexes,
          restoreFavorites: options.restoreFavorites,
        });
        const { all: itemStats, folders } = migrated.plan.stats;
        const foldersAdded = folders?.added || 0;
        const incoming = itemStats.incoming;
        const marker = {
          status: incoming || foldersAdded ? 'migrated' : 'empty',
          completedAt: new Date().toISOString(),
          incoming,
          added: itemStats.added,
          duplicate: itemStats.duplicate,
          foldersAdded,
          atlasTotal: migrated.result.atlasKeys.length,
          communityTotal: migrated.result.communityIds.length,
        };
        writeMigrationMarker(storage, markerKey, marker);
        options.onChanged?.(['atlas', 'community'], { reason: 'origin-migration', marker });
        await options.refreshCounts?.();
        postResult(migrationResultMessage(bridge, nonce, marker.status, {
          ...marker,
          warnings: migrated.warnings,
        }));
        hideBanners();
        const notes = migrated.warnings.length ? ` ${migrated.warnings.join('；')}。` : '';
        const summary = marker.status === 'empty'
          ? '这个浏览器的旧网址里没有收藏。'
          : `已找回旧收藏：新增 ${marker.added} 条${foldersAdded ? `、收藏夹 ${foldersAdded} 个` : ''}`
            + `${marker.duplicate ? `，${marker.duplicate} 条已存在` : ''}。`;
        setFeedback(summary + notes);
        options.onDone?.(summary + notes, marker);
        cleanup();
      } catch (error) {
        postResult(migrationResultMessage(bridge, nonce, 'error', {
          message: error?.message || '找回旧收藏失败',
        }));
        setError(error?.message || `找回旧收藏失败，${fallbackHint}`);
        cleanup();
      }
    };

    const timeoutId = windowApi.setTimeout(() => {
      setError(`连接旧网址超时。允许本站弹出窗口后再点一次，${fallbackHint}`);
      cleanup();
    }, options.timeoutMs || MIGRATION_TIMEOUT_MS);

    // 监听必须先于 window.open 注册：旧网址页面可能从浏览器缓存中瞬间完成加载并发出 ready。
    session = {
      nonce,
      popup: null,
      onMessage,
      timeoutId,
      processingPayload: false,
    };
    windowApi.addEventListener('message', onMessage);

    const target = buildFavoritesMigrationUrl({ ...urlOptions, nonce });
    let popup;
    try {
      popup = (options.openWindow || windowApi.open.bind(windowApi))(
        target,
        '_blank',
        'popup,width=540,height=720',
      );
    } catch {
      cleanup();
      setError(`无法打开找回窗口。允许本站弹出窗口后再点一次，${fallbackHint}`);
      return;
    }
    if (!popup) {
      cleanup();
      setError(`浏览器拦截了找回窗口。允许本站弹出窗口后再点一次，${fallbackHint}`);
      return;
    }
    session.popup = popup;
  };

  const dismiss = () => {
    writeMigrationMarker(storage, markerKey, {
      status: 'dismissed',
      completedAt: new Date().toISOString(),
    });
    hideBanners();
  };

  // 委托到根节点：同步调用 start，window.open 仍在这次点击的用户手势里。
  root.addEventListener?.('click', event => {
    const target = event.target?.closest?.('[data-favorites-migration-start], [data-favorites-migration-dismiss]');
    if (!target || target.disabled) return;
    if (target.matches('[data-favorites-migration-start]')) start();
    else dismiss();
  });

  return { start, cleanup, dismiss, bridge };
}
