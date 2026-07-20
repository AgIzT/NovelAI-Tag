import {
  FAVORITES_BACKUP_LIMITS,
  FavoritesBackupError,
  commitFavoritesRestore,
  createFavoritesBackup,
  createFavoritesRestorePlan,
  readStoredFavorites,
} from './favorites-backup-core.js';

export const FAVORITES_MIGRATION_VERSION = 1;
export const FAVORITES_MIGRATION_PATH = '/_favorites-migration-202607.html';
export const FAVORITES_MIGRATION_OLD_ORIGIN = 'https://novelai-tag.pages.dev';
export const FAVORITES_MIGRATION_NEW_ORIGIN = 'https://novelai.quicktagcloud.com';
export const FAVORITES_MIGRATION_MARKER_KEY = 'novelai-tag-favorites-origin-migration-v1';
export const FAVORITES_MIGRATION_BANNER_END = Date.parse('2026-11-01T00:00:00+08:00');

export const FAVORITES_MIGRATION_MESSAGES = Object.freeze({
  ready: 'ready',
  request: 'request',
  payload: 'payload',
  result: 'result',
});

const MIGRATION_TIMEOUT_MS = 20_000;

function fail(code, message, details = {}) {
  throw new FavoritesBackupError(code, message, details);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function encodedSize(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (cause) {
    fail('INVALID_MIGRATION_PAYLOAD', '旧域收藏数据无法序列化', { cause });
  }
  return new TextEncoder().encode(text).byteLength;
}

export function createFavoritesMigrationNonce(cryptoApi = globalThis.crypto) {
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    fail('MIGRATION_CRYPTO_UNAVAILABLE', '当前浏览器无法创建安全的迁移会话');
  }
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function readFavoritesMigrationMarker(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(FAVORITES_MIGRATION_MARKER_KEY) || 'null');
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
} = {}) {
  return origin === newOrigin
    && now < FAVORITES_MIGRATION_BANNER_END
    && !readFavoritesMigrationMarker(storage);
}

export function isTrustedFavoritesMigrationEvent(event, {
  source,
  origin = FAVORITES_MIGRATION_OLD_ORIGIN,
  nonce,
  type,
} = {}) {
  return Boolean(
    event
    && event.origin === origin
    && event.source === source
    && isRecord(event.data)
    && event.data.type === type
    && event.data.version === FAVORITES_MIGRATION_VERSION
    && event.data.nonce === nonce,
  );
}

export function createFavoritesMigrationRestore({
  message,
  nonce,
  storage,
  codexes = [],
} = {}) {
  if (!isRecord(message)
    || message.type !== FAVORITES_MIGRATION_MESSAGES.payload
    || message.version !== FAVORITES_MIGRATION_VERSION
    || message.nonce !== nonce) {
    fail('INVALID_MIGRATION_MESSAGE', '旧域收藏迁移消息无效');
  }

  const payload = {
    atlasKeys: message.atlasKeys,
    communityIds: message.communityIds,
  };
  if (!isRecord(payload)
    || !Array.isArray(payload.atlasKeys)
    || !Array.isArray(payload.communityIds)) {
    fail('INVALID_MIGRATION_PAYLOAD', '旧域收藏数据结构无效');
  }
  if (encodedSize(payload) > FAVORITES_BACKUP_LIMITS.maxFileBytes) {
    fail('MIGRATION_TOO_LARGE', '旧域收藏数据超过 2 MiB，无法自动迁移');
  }

  const backup = createFavoritesBackup({
    atlasKeys: payload.atlasKeys,
    communityIds: payload.communityIds,
    codexes,
    exportedAt: new Date(),
  });
  const current = readStoredFavorites(storage, codexes);
  const plan = createFavoritesRestorePlan({
    backup,
    currentAtlasKeys: current.atlasKeys,
    currentCommunityIds: current.communityIds,
    mode: 'merge',
    codexes,
  });
  const result = commitFavoritesRestore(storage, plan);
  return { backup, current, plan, result };
}

function writeMigrationMarker(storage, value) {
  try {
    storage.setItem(FAVORITES_MIGRATION_MARKER_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function migrationResultMessage(nonce, status, details = {}) {
  return {
    type: FAVORITES_MIGRATION_MESSAGES.result,
    version: FAVORITES_MIGRATION_VERSION,
    nonce,
    status,
    ...details,
  };
}

export function setupFavoritesOriginMigration(options = {}) {
  const windowApi = options.window || globalThis.window;
  const documentApi = options.document || globalThis.document;
  const storage = options.storage || windowApi?.localStorage;
  if (!windowApi || !documentApi || !storage) return;

  const oldOrigin = options.oldOrigin || FAVORITES_MIGRATION_OLD_ORIGIN;
  const newOrigin = options.newOrigin || FAVORITES_MIGRATION_NEW_ORIGIN;
  const currentOrigin = options.currentOrigin || windowApi.location?.origin;
  const migrationPath = options.migrationPath || FAVORITES_MIGRATION_PATH;
  const root = options.root || documentApi;
  const startButtons = [...root.querySelectorAll('[data-favorites-migration-start]')];
  const dismissButtons = [...root.querySelectorAll('[data-favorites-migration-dismiss]')];
  const banners = [...root.querySelectorAll('[data-favorites-migration-banner]')];
  const feedback = [...root.querySelectorAll('[data-favorites-migration-feedback]')];
  const fallbackLinks = [...root.querySelectorAll('[data-favorites-migration-fallback]')];
  if (!startButtons.length || currentOrigin !== newOrigin) {
    banners.forEach(element => { element.hidden = true; });
    return;
  }
  if (root.documentElement?.dataset.favoritesMigrationBound === '1') return;
  if (root.documentElement) root.documentElement.dataset.favoritesMigrationBound = '1';

  const showBanner = shouldShowFavoritesMigrationBanner({
    origin: currentOrigin,
    storage,
    now: options.now ?? Date.now(),
    newOrigin,
  });
  banners.forEach(element => { element.hidden = !showBanner; });
  fallbackLinks.forEach(link => {
    link.href = `${oldOrigin}${migrationPath}`;
  });

  const setFeedback = message => {
    feedback.forEach(element => {
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
    startButtons.forEach(button => { button.disabled = Boolean(value); });
    options.onBusy?.(Boolean(value));
  };
  const hideBanners = () => banners.forEach(element => { element.hidden = true; });

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
    setFeedback('正在连接旧域收藏…');
    setBusy(true);

    let nonce;
    try {
      nonce = createFavoritesMigrationNonce(options.crypto || windowApi.crypto);
    } catch (error) {
      setError(error.message || '无法创建收藏迁移会话。');
      setBusy(false);
      return;
    }

    const onMessage = async event => {
      const popup = session?.popup;
      if (!popup) return;

      if (isTrustedFavoritesMigrationEvent(event, {
        source: popup,
        origin: oldOrigin,
        nonce,
        type: FAVORITES_MIGRATION_MESSAGES.ready,
      })) {
        try {
          popup.postMessage({
            type: FAVORITES_MIGRATION_MESSAGES.request,
            version: FAVORITES_MIGRATION_VERSION,
            nonce,
          }, oldOrigin);
        } catch {
          setError('旧域迁移窗口已关闭。请重新尝试，或改用 JSON 备份恢复。');
          cleanup();
          return;
        }
        setFeedback('已找到旧域页面，正在合并收藏…');
        return;
      }

      if (!isTrustedFavoritesMigrationEvent(event, {
        source: popup,
        origin: oldOrigin,
        nonce,
        type: FAVORITES_MIGRATION_MESSAGES.payload,
      })) return;
      if (session.processingPayload) return;
      session.processingPayload = true;
      windowApi.clearTimeout(session.timeoutId);
      session.timeoutId = null;

      const postResult = message => {
        try {
          popup.postMessage(message, oldOrigin);
        } catch {
          // 收藏已在新域事务式写入时，旧窗口提前关闭不应把成功误报为失败。
        }
      };

      try {
        const codexes = await options.getCodexes?.() || [];
        const migrated = createFavoritesMigrationRestore({
          message: event.data,
          nonce,
          storage,
          codexes,
        });
        const incoming = migrated.plan.stats.all.incoming;
        const marker = {
          status: incoming ? 'migrated' : 'empty',
          completedAt: new Date().toISOString(),
          incoming,
          added: migrated.plan.stats.all.added,
          duplicate: migrated.plan.stats.all.duplicate,
          atlasTotal: migrated.result.atlasKeys.length,
          communityTotal: migrated.result.communityIds.length,
        };
        writeMigrationMarker(storage, marker);
        options.onChanged?.(['atlas', 'community'], { reason: 'origin-migration', marker });
        await options.refreshCounts?.();
        postResult(migrationResultMessage(nonce, marker.status, marker));
        hideBanners();
        setFeedback(incoming
          ? `找回完成：新增 ${marker.added} 条，${marker.duplicate} 条已存在。`
          : '旧域没有发现可迁移的收藏。');
        cleanup();
      } catch (error) {
        postResult(migrationResultMessage(nonce, 'error', {
          message: error?.message || '旧域收藏迁移失败',
        }));
        setError(error?.message || '旧域收藏迁移失败，请改用 JSON 备份恢复。');
        cleanup();
      }
    };

    const timeoutId = windowApi.setTimeout(() => {
      setError('连接旧域超时。请确认迁移窗口未被拦截，或改用 JSON 备份恢复。');
      cleanup();
    }, options.timeoutMs || MIGRATION_TIMEOUT_MS);

    // 监听必须先于 window.open 注册：旧域页可能从浏览器缓存中瞬间完成加载并发出 ready。
    session = {
      nonce,
      popup: null,
      onMessage,
      timeoutId,
      processingPayload: false,
    };
    windowApi.addEventListener('message', onMessage);

    const hash = new URLSearchParams({ nonce }).toString();
    const target = `${oldOrigin}${migrationPath}#${hash}`;
    let popup;
    try {
      popup = (options.openWindow || windowApi.open.bind(windowApi))(
        target,
        '_blank',
        'popup,width=540,height=720',
      );
    } catch {
      cleanup();
      setError('无法打开迁移窗口。请允许弹窗后重试，或手动打开救援页下载备份。');
      return;
    }
    if (!popup) {
      cleanup();
      setError('浏览器阻止了迁移窗口。请允许弹窗后重试，或手动打开救援页下载备份。');
      return;
    }
    session.popup = popup;
  };

  startButtons.forEach(button => button.addEventListener('click', start));
  dismissButtons.forEach(button => button.addEventListener('click', () => {
    writeMigrationMarker(storage, {
      status: 'dismissed',
      completedAt: new Date().toISOString(),
    });
    hideBanners();
  }));

  return { start, cleanup };
}
