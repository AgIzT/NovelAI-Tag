import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

import { loadFavoritesTestModules } from './favorites-library-test-loader.mjs';

const { core, library, store, backupStore, migration } = await loadFavoritesTestModules();
const rescueFile = new URL('../site/_favorites-migration-202607.html', import.meta.url);
const { ATLAS_FAVORITES_STORAGE_KEY, COMMUNITY_FAVORITES_STORAGE_KEY, FavoritesBackupError } = core;
const { FAVORITES_LIBRARY_STORAGE_KEY } = library;
const {
  FAVORITES_MIGRATION_CACHE_BUSTER_PARAM,
  FAVORITES_MIGRATION_CACHE_BUSTER_VALUE,
  FAVORITES_MIGRATION_MARKER_KEY,
  FAVORITES_MIGRATION_MESSAGES,
  FAVORITES_MIGRATION_VERSION,
  buildFavoritesMigrationUrl,
  createFavoritesMigrationNonce,
  createFavoritesMigrationRestore: migrate,
  isTrustedFavoritesMigrationEvent,
  readFavoritesMigrationMarker,
  setupFavoritesOriginMigration,
  shouldShowFavoritesMigrationBanner,
} = migration;

const builtMigrationUrl = buildFavoritesMigrationUrl({
  origin: 'https://old.example',
  path: '/_favorites-migration-202607.html?targetOrigin=https%3A%2F%2Fnew.example',
  nonce: 'nonce-only-in-fragment',
});
const parsedMigrationUrl = new URL(builtMigrationUrl);
assert.equal(
  parsedMigrationUrl.searchParams.get(FAVORITES_MIGRATION_CACHE_BUSTER_PARAM),
  FAVORITES_MIGRATION_CACHE_BUSTER_VALUE,
);
assert.equal(parsedMigrationUrl.searchParams.get('targetOrigin'), 'https://new.example');
assert.equal(parsedMigrationUrl.searchParams.has('nonce'), false);
assert.equal(parsedMigrationUrl.hash, '#nonce=nonce-only-in-fragment');

// 已被旧 301 送到 .com 的同名救援页会自动换缓存键重试旧 origin，且保留 nonce。
const rescueSource = await readFile(rescueFile, 'utf8');
const rescueScript = rescueSource.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
assert.ok(rescueScript, 'missing rescue inline script');
let retriedRescueUrl = '';
const wrongOriginHref = 'https://novelai.quicktagcloud.com/_favorites-migration-202607.html#nonce=retry-nonce';
const wrongOriginUrl = new URL(wrongOriginHref);
runInNewContext(rescueScript, {
  URL,
  URLSearchParams,
  location: {
    href: wrongOriginHref,
    origin: wrongOriginUrl.origin,
    hostname: wrongOriginUrl.hostname,
    pathname: wrongOriginUrl.pathname,
    search: wrongOriginUrl.search,
    hash: wrongOriginUrl.hash,
    replace(value) {
      retriedRescueUrl = String(value);
    },
  },
  document: {
    getElementById() {
      return {
        hidden: false,
        textContent: '',
        classList: { toggle() {} },
      };
    },
  },
});
assert.equal(
  retriedRescueUrl,
  'https://novelai-tag.pages.dev/_favorites-migration-202607.html?bridge=20260721#nonce=retry-nonce',
);

const codexes = [
  { id: 'alpha', aliases: ['old_alpha'] },
  { id: 'beta' },
  { id: 'artist_nai45_strings' },
  { id: 'mengshen_pack' },
  { id: 'suozhang_r18' },
];

class MemoryStorage {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
    this.failOnceFor = null;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    if (this.failOnceFor === key) {
      this.failOnceFor = null;
      throw new Error(`simulated failure: ${key}`);
    }
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

class FakeElement extends EventTarget {
  constructor() {
    super();
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.href = '';
  }
}

class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.documentElement = new FakeElement();
    this.start = new FakeElement();
    this.dismiss = new FakeElement();
    this.banner = new FakeElement();
    this.feedback = new FakeElement();
    this.fallback = new FakeElement();
    this.offer = new FakeElement();
    this.offer.hidden = true;
  }

  querySelectorAll(selector) {
    return {
      '[data-favorites-migration-start]': [this.start],
      '[data-favorites-migration-dismiss]': [this.dismiss],
      '[data-favorites-migration-banner]': [this.banner],
      '[data-favorites-migration-feedback]': [this.feedback],
      '[data-favorites-migration-fallback]': [this.fallback],
      '[data-favorites-migration-offer]': [this.offer],
    }[selector] || [];
  }
}

class FakeWindow extends EventTarget {
  constructor(storage, origin = 'https://new.example') {
    super();
    this.localStorage = storage;
    this.location = { origin };
    this.crypto = {
      getRandomValues(bytes) {
        bytes.forEach((_, index) => { bytes[index] = index; });
        return bytes;
      },
    };
    this.setTimeout = setTimeout;
    this.clearTimeout = clearTimeout;
    this.messageListenerCount = 0;
  }

  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    if (type === 'message') this.messageListenerCount += 1;
  }

  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
    if (type === 'message') this.messageListenerCount -= 1;
  }
}

async function expectCode(code, fn) {
  await assert.rejects(fn, error => error instanceof FavoritesBackupError && error.code === code);
}

const storageAdapters = new WeakMap();
function adapterFor(storage, codexes = []) {
  if (!storageAdapters.has(storage)) {
    const libraryStore = store.createLibraryStore({ getStorage: () => storage, getLocks: () => null, getCodexes: () => codexes, eventTarget: null });
    storageAdapters.set(storage, backupStore.createFavoritesBackupStore(libraryStore));
  }
  return storageAdapters.get(storage);
}
function createFavoritesMigrationRestore(options) {
  return migrate({ ...options, restoreFavorites: adapterFor(options.storage, options.codexes).restore });
}

function payload(nonce, favorites = { atlasKeys: [], communityIds: [] }) {
  return {
    type: FAVORITES_MIGRATION_MESSAGES.payload,
    version: FAVORITES_MIGRATION_VERSION,
    nonce,
    atlasKeys: favorites.atlasKeys,
    communityIds: favorites.communityIds,
  };
}

function dispatchMessage(windowApi, { origin, source, data }) {
  const event = new Event('message');
  Object.defineProperties(event, {
    origin: { value: origin },
    source: { value: source },
    data: { value: data },
  });
  windowApi.dispatchEvent(event);
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

// Nonce 使用 128 bit 随机数，编码结果稳定且不暴露到 query。
assert.equal(
  createFavoritesMigrationNonce({
    getRandomValues(bytes) {
      bytes.forEach((_, index) => { bytes[index] = index; });
      return bytes;
    },
  }),
  '000102030405060708090a0b0c0d0e0f',
);

// 临时横幅只在新域、截止日前且没有完成/关闭标记时出现。
const markerStorage = new MemoryStorage();
assert.equal(shouldShowFavoritesMigrationBanner({
  origin: 'https://new.example',
  newOrigin: 'https://new.example',
  storage: markerStorage,
  now: Date.parse('2026-08-26T23:59:59+08:00'),
}), true);
// 2026-08-27 起横幅已收档：截止日之后任何人都不该再看到它。
assert.equal(shouldShowFavoritesMigrationBanner({
  origin: 'https://new.example',
  newOrigin: 'https://new.example',
  storage: markerStorage,
  now: Date.parse('2026-08-27T00:00:01+08:00'),
}), false);
assert.equal(shouldShowFavoritesMigrationBanner({
  origin: 'https://old.example',
  newOrigin: 'https://new.example',
  storage: markerStorage,
}), false);
markerStorage.setItem(FAVORITES_MIGRATION_MARKER_KEY, JSON.stringify({
  status: 'dismissed',
  completedAt: '2026-07-20T00:00:00.000Z',
}));
assert.equal(readFavoritesMigrationMarker(markerStorage).status, 'dismissed');
assert.equal(shouldShowFavoritesMigrationBanner({
  origin: 'https://new.example',
  newOrigin: 'https://new.example',
  storage: markerStorage,
}), false);
markerStorage.setItem(FAVORITES_MIGRATION_MARKER_KEY, '{broken');
assert.equal(readFavoritesMigrationMarker(markerStorage), null);

// postMessage 必须同时匹配 origin、窗口引用、协议版本、nonce 和类型。
const trustedSource = {};
const trustedData = payload('nonce-1');
const trustedEvent = {
  origin: 'https://old.example',
  source: trustedSource,
  data: trustedData,
};
const trustOptions = {
  source: trustedSource,
  origin: 'https://old.example',
  nonce: 'nonce-1',
  type: FAVORITES_MIGRATION_MESSAGES.payload,
};
assert.equal(isTrustedFavoritesMigrationEvent(trustedEvent, trustOptions), true);
for (const badEvent of [
  { ...trustedEvent, origin: 'https://evil.example' },
  { ...trustedEvent, source: {} },
  { ...trustedEvent, data: { ...trustedData, nonce: 'wrong' } },
  { ...trustedEvent, data: { ...trustedData, version: 2 } },
  { ...trustedEvent, data: { ...trustedData, type: FAVORITES_MIGRATION_MESSAGES.ready } },
  { ...trustedEvent, data: null },
]) {
  assert.equal(isTrustedFavoritesMigrationEvent(badEvent, trustOptions), false);
}

// 合并恢复会做别名归一、去重，且永不覆盖新域已有收藏。
const mergeStorage = new MemoryStorage({
  [ATLAS_FAVORITES_STORAGE_KEY]: JSON.stringify([
    'alpha:alpha-existing',
    'beta:beta-new-domain',
  ]),
  [COMMUNITY_FAVORITES_STORAGE_KEY]: JSON.stringify(['community-existing']),
});
const mergeMessage = payload('merge-nonce', {
  atlasKeys: [
    'old_alpha:old_alpha-1',
    'alpha:alpha-existing',
    'old_alpha:old_alpha-1',
  ],
  communityIds: ['community-old', 'community-existing', 'community-old'],
});
const merged = await createFavoritesMigrationRestore({
  message: mergeMessage,
  nonce: 'merge-nonce',
  storage: mergeStorage,
  codexes,
});
assert.deepEqual(merged.result, {
  atlasKeys: [
    'alpha:alpha-1',
    'alpha:alpha-existing',
    'beta:beta-new-domain',
  ],
  communityIds: ['community-existing', 'community-old'],
});
assert.deepEqual(merged.plan.stats.all, {
  current: 3,
  incoming: 4,
  added: 2,
  duplicate: 2,
  removed: 0,
  total: 5,
});

// 重复迁移幂等；旧域为空时也只规范化并保留当前集合。
const repeated = await createFavoritesMigrationRestore({
  message: mergeMessage,
  nonce: 'merge-nonce',
  storage: mergeStorage,
  codexes,
});
assert.equal(repeated.plan.stats.all.added, 0);
assert.equal(repeated.plan.stats.all.duplicate, 4);
assert.deepEqual(repeated.result, merged.result);
const empty = await createFavoritesMigrationRestore({
  message: payload('empty-nonce'),
  nonce: 'empty-nonce',
  storage: mergeStorage,
  codexes,
});
assert.equal(empty.plan.stats.all.incoming, 0);
assert.deepEqual(empty.result, merged.result);

// 旧域 payload 中的历史归属键会在合并时改挂当前法典；再次迁移不会重复新增。
const ownerMigrationStorage = new MemoryStorage({
  [ATLAS_FAVORITES_STORAGE_KEY]: JSON.stringify([
    'artist_nai45_strings:mengshen_pack-0001',
  ]),
  [COMMUNITY_FAVORITES_STORAGE_KEY]: '[]',
});
const ownerMigrationMessage = payload('owner-migration', {
  atlasKeys: [
    'mengshen_pack:mengshen_pack-0001',
    'mengshen_pack:mengshen_pack-0259',
    'codex_6e699406:codex_6e699406-0042',
    'codex_8489ac52:codex_8489ac52-0042',
  ],
  communityIds: [],
});
const ownerMigrated = await createFavoritesMigrationRestore({
  message: ownerMigrationMessage,
  nonce: 'owner-migration',
  storage: ownerMigrationStorage,
  codexes,
});
assert.deepEqual(ownerMigrated.result.atlasKeys, [
  'artist_nai45_strings:mengshen_pack-0001',
  'mengshen_pack:mengshen_pack-0259',
  'suozhang_r18:codex_6e699406-0042',
  'suozhang_r18:codex_8489ac52-0042',
]);
assert.equal(ownerMigrated.plan.stats.atlas.added, 3);
assert.equal(ownerMigrated.plan.stats.atlas.duplicate, 1);
const ownerRepeated = await createFavoritesMigrationRestore({
  message: ownerMigrationMessage,
  nonce: 'owner-migration',
  storage: ownerMigrationStorage,
  codexes,
});
assert.equal(ownerRepeated.plan.stats.atlas.added, 0);
assert.equal(ownerRepeated.plan.stats.atlas.duplicate, 4);
assert.deepEqual(ownerRepeated.result, ownerMigrated.result);

// 畸形消息、字段限制、数量上限和 2 MiB 上限全部在写入前拒绝。
await expectCode('INVALID_MIGRATION_MESSAGE', () => createFavoritesMigrationRestore({
  message: { ...mergeMessage, version: 2 },
  nonce: 'merge-nonce',
  storage: mergeStorage,
  codexes,
}));
await expectCode('INVALID_MIGRATION_MESSAGE', () => createFavoritesMigrationRestore({
  message: mergeMessage,
  nonce: 'wrong',
  storage: mergeStorage,
  codexes,
}));
await expectCode('INVALID_MIGRATION_PAYLOAD', () => createFavoritesMigrationRestore({
  message: { ...mergeMessage, communityIds: undefined },
  nonce: 'merge-nonce',
  storage: mergeStorage,
  codexes,
}));
await expectCode('INVALID_ATLAS_ITEM', () => createFavoritesMigrationRestore({
  message: payload('bad-atlas', { atlasKeys: ['missing-separator'], communityIds: [] }),
  nonce: 'bad-atlas',
  storage: mergeStorage,
  codexes,
}));
await expectCode('INVALID_COMMUNITY_ITEM', () => createFavoritesMigrationRestore({
  message: payload('bad-community', {
    atlasKeys: [],
    communityIds: ['x'.repeat(257)],
  }),
  nonce: 'bad-community',
  storage: mergeStorage,
  codexes,
}));
await expectCode('TOO_MANY_ITEMS', () => createFavoritesMigrationRestore({
  message: payload('too-many', {
    atlasKeys: [],
    communityIds: Array(30001).fill('same'),
  }),
  nonce: 'too-many',
  storage: mergeStorage,
  codexes,
}));
await expectCode('MIGRATION_TOO_LARGE', () => createFavoritesMigrationRestore({
  message: payload('too-large', {
    atlasKeys: [],
    communityIds: ['x'.repeat(2 * 1024 * 1024)],
  }),
  nonce: 'too-large',
  storage: mergeStorage,
  codexes,
}));

// 社区协调写入失败时，两类收藏保留恢复前状态。
const originalAtlas = '["alpha:alpha-before"]';
const originalCommunity = '["community-before"]';
const rollbackStorage = new MemoryStorage({
  [ATLAS_FAVORITES_STORAGE_KEY]: originalAtlas,
  [COMMUNITY_FAVORITES_STORAGE_KEY]: originalCommunity,
});
rollbackStorage.failOnceFor = COMMUNITY_FAVORITES_STORAGE_KEY;
await expectCode('STORAGE_WRITE_FAILED', () => createFavoritesMigrationRestore({
  message: payload('rollback', {
    atlasKeys: ['beta:beta-old'],
    communityIds: ['community-old'],
  }),
  nonce: 'rollback',
  storage: rollbackStorage,
  codexes,
}));
assert.equal(rollbackStorage.getItem(ATLAS_FAVORITES_STORAGE_KEY), originalAtlas);
assert.equal(rollbackStorage.getItem(COMMUNITY_FAVORITES_STORAGE_KEY), originalCommunity);

// 接收端先注册监听再打开窗口；错误安全属性不写入，合法 payload 才合并并刷新两类 UI。
{
  const storage = new MemoryStorage({
    [ATLAS_FAVORITES_STORAGE_KEY]: JSON.stringify(['alpha:alpha-current']),
    [COMMUNITY_FAVORITES_STORAGE_KEY]: JSON.stringify([]),
  });
  const documentApi = new FakeDocument();
  const windowApi = new FakeWindow(storage);
  const posted = [];
  const popup = {
    postMessage(message, origin) {
      posted.push({ message, origin });
    },
  };
  let changed = 0;
  let refreshed = 0;
  let openedTarget = '';
  let releaseRestore;
  const restoreGate = new Promise(resolve => { releaseRestore = resolve; });
  const controller = setupFavoritesOriginMigration({
    window: windowApi,
    document: documentApi,
    root: documentApi,
    storage,
    restoreFavorites: async options => { await restoreGate; return adapterFor(storage, codexes).restore(options); },
    oldOrigin: 'https://old.example',
    newOrigin: 'https://new.example',
    currentOrigin: 'https://new.example',
    // 横幅 2026-08-27 起已收档；这里固定到收档前，好让这段继续覆盖「横幅可见 → 走完整条桥」。
    now: Date.parse('2026-08-26T12:00:00+08:00'),
    getCodexes: async () => codexes,
    onChanged: scopes => {
      assert.deepEqual(scopes, ['atlas', 'community']);
      changed += 1;
    },
    refreshCounts: async () => { refreshed += 1; },
    openWindow: target => {
      assert.equal(windowApi.messageListenerCount, 1);
      openedTarget = target;
      return popup;
    },
    timeoutMs: 1000,
  });
  assert.equal(documentApi.banner.hidden, false);
  assert.equal(
    documentApi.fallback.href,
    'https://old.example/_favorites-migration-202607.html?bridge=20260721',
  );
  await controller.start();
  const nonce = '000102030405060708090a0b0c0d0e0f';
  assert.equal(
    openedTarget,
    `https://old.example/_favorites-migration-202607.html?bridge=20260721#nonce=${nonce}`,
  );

  dispatchMessage(windowApi, {
    origin: 'https://evil.example',
    source: popup,
    data: payload(nonce, {
      atlasKeys: ['beta:evil'],
      communityIds: [],
    }),
  });
  assert.equal(storage.getItem(ATLAS_FAVORITES_STORAGE_KEY), '["alpha:alpha-current"]');

  dispatchMessage(windowApi, {
    origin: 'https://old.example',
    source: popup,
    data: {
      type: FAVORITES_MIGRATION_MESSAGES.ready,
      version: FAVORITES_MIGRATION_VERSION,
      nonce,
    },
  });
  assert.equal(posted[0].message.type, FAVORITES_MIGRATION_MESSAGES.request);

  dispatchMessage(windowApi, {
    origin: 'https://old.example',
    source: popup,
    data: payload(nonce, {
      atlasKeys: ['old_alpha:old_alpha-old'],
      communityIds: ['community-old'],
    }),
  });
  await tick();
  assert.equal(readFavoritesMigrationMarker(storage), null, '恢复尚未落盘时不写成功标记');
  assert.equal(changed, 0, '恢复尚未完成时不广播');
  assert.equal(posted.length, 1, '恢复尚未完成时不通知旧域成功');
  releaseRestore();
  for (let attempts = 0; attempts < 100 && changed === 0; attempts++) await tick(10);
  assert.deepEqual(JSON.parse(storage.getItem(ATLAS_FAVORITES_STORAGE_KEY)), [
    'alpha:alpha-current',
    'alpha:alpha-old',
  ]);
  assert.deepEqual(JSON.parse(storage.getItem(COMMUNITY_FAVORITES_STORAGE_KEY)), ['community-old']);
  assert.equal(changed, 1);
  assert.equal(refreshed, 1);
  assert.equal(readFavoritesMigrationMarker(storage).status, 'migrated');
  assert.equal(documentApi.banner.hidden, true);
  assert.match(documentApi.feedback.textContent, /新增 2 条/);
  assert.equal(windowApi.messageListenerCount, 0);
  assert.equal(posted.at(-1).message.type, FAVORITES_MIGRATION_MESSAGES.result);
}

// 弹窗阻止、旧窗口提前关闭和超时都会清理监听并给出 JSON 兜底提示。
for (const scenario of ['blocked', 'closed', 'timeout']) {
  const storage = new MemoryStorage();
  const documentApi = new FakeDocument();
  const windowApi = new FakeWindow(storage);
  const popup = {
    postMessage() {
      if (scenario === 'closed') throw new Error('closed');
    },
  };
  const controller = setupFavoritesOriginMigration({
    window: windowApi,
    document: documentApi,
    root: documentApi,
    storage,
    oldOrigin: 'https://old.example',
    newOrigin: 'https://new.example',
    currentOrigin: 'https://new.example',
    openWindow: () => scenario === 'blocked' ? null : popup,
    timeoutMs: 5,
  });
  await controller.start();
  if (scenario === 'closed') {
    dispatchMessage(windowApi, {
      origin: 'https://old.example',
      source: popup,
      data: {
        type: FAVORITES_MIGRATION_MESSAGES.ready,
        version: FAVORITES_MIGRATION_VERSION,
        nonce: '000102030405060708090a0b0c0d0e0f',
      },
    });
  }
  await tick(15);
  assert.equal(windowApi.messageListenerCount, 0);
  assert.equal(documentApi.start.disabled, false);
  if (scenario === 'blocked') assert.match(documentApi.feedback.textContent, /拦截/);
  if (scenario === 'closed') assert.match(documentApi.feedback.textContent, /关闭/);
  if (scenario === 'timeout') assert.match(documentApi.feedback.textContent, /超时/);
}

// ---------- 2026-11 新网址找回（V2 收藏库，协议版本 2） ----------
const {
  FAVORITES_DEV_BRIDGE_KEY,
  FAVORITES_LIBRARY_MIGRATION_VERSION,
  FAVORITES_MOVE_MARKER_KEY,
  createLibraryMigrationRestore: migrateLibrary,
  favoritesMigrationOffer,
  resolveFavoritesMigrationBridge,
} = migration;
const libraryMigrate = options => migrateLibrary({ ...options, restoreFavorites: adapterFor(options.storage, options.codexes).restore });

// 按当前 origin 选桥；本机开发开关只在 localhost / 127.0.0.1 生效。
assert.equal(resolveFavoritesMigrationBridge({ origin: 'https://naitag.com' }).id, 'naitag-202611');
assert.equal(resolveFavoritesMigrationBridge({ origin: 'https://novelai.quicktagcloud.com' }).id, 'pages-dev-202607');
assert.equal(resolveFavoritesMigrationBridge({ origin: 'https://evil.example' }), null);
{
  const devStorage = new MemoryStorage({ [FAVORITES_DEV_BRIDGE_KEY]: 'http://127.0.0.1:8821' });
  const dev = resolveFavoritesMigrationBridge({ origin: 'http://localhost:8821', storage: devStorage });
  assert.equal(dev.id, 'dev');
  assert.equal(dev.oldOrigin, 'http://127.0.0.1:8821');
  assert.equal(dev.newOrigin, 'http://localhost:8821');
  assert.equal(dev.version, FAVORITES_LIBRARY_MIGRATION_VERSION);
  assert.equal(resolveFavoritesMigrationBridge({ origin: 'https://preview.example', storage: devStorage }), null);
  assert.equal(resolveFavoritesMigrationBridge({ origin: 'http://127.0.0.1:8821', storage: devStorage }), null, '旧新同源不成桥');
  devStorage.setItem(FAVORITES_DEV_BRIDGE_KEY, 'https://evil.example');
  assert.equal(resolveFavoritesMigrationBridge({ origin: 'http://localhost:8821', storage: devStorage }), null);
}

// 入口只在新网址、且这台浏览器还没有找回结果时给出；pages.dev 那条桥不进空状态。
{
  const offerStorage = new MemoryStorage();
  assert.equal(favoritesMigrationOffer({ origin: 'https://naitag.com', storage: offerStorage }).id, 'naitag-202611');
  assert.equal(favoritesMigrationOffer({ origin: 'https://novelai.quicktagcloud.com', storage: offerStorage }), null);
  assert.equal(favoritesMigrationOffer({ origin: 'http://localhost:8821', storage: offerStorage }), null);
  offerStorage.setItem(FAVORITES_MOVE_MARKER_KEY, JSON.stringify({ status: 'empty' }));
  assert.equal(favoritesMigrationOffer({ origin: 'https://naitag.com', storage: offerStorage }), null);
}

assert.equal(
  buildFavoritesMigrationUrl({
    origin: 'https://novelai.quicktagcloud.com',
    path: '/_favorites-migration-202611.html',
    cacheBuster: '20261111',
    nonce: 'n',
  }),
  'https://novelai.quicktagcloud.com/_favorites-migration-202611.html?bridge=20261111#nonce=n',
);

// 版本号区分两代页面：V1 消息不能冒充 V2，反之亦然。
assert.equal(isTrustedFavoritesMigrationEvent(trustedEvent, { ...trustOptions, version: 2 }), false);
assert.equal(isTrustedFavoritesMigrationEvent(
  { ...trustedEvent, data: { ...trustedData, version: 2 } },
  { ...trustOptions, version: 2 },
), true);

function oldLibraryRaw() {
  return JSON.stringify(library.normalizeLibrary({
    libraryId: 'old-library',
    items: [
      { key: 'old_alpha:old_alpha-1', note: '旧网址备注', addedAt: '2026-10-01T00:00:00.000Z' },
      { key: 'beta:beta-old', addedAt: '2026-10-02T00:00:00.000Z' },
    ],
    folders: [
      { id: 'fd_preset_character', name: '角色' },
      { id: 'fd_old_mine', name: '我的画风' },
    ],
    memberships: [
      { itemKey: 'old_alpha:old_alpha-1', folderId: 'fd_old_mine' },
      { itemKey: 'beta:beta-old', folderId: 'fd_preset_character' },
    ],
  }, { codexes }));
}
function libraryPayload(nonce, raws = {}) {
  return {
    type: FAVORITES_MIGRATION_MESSAGES.payload,
    version: FAVORITES_LIBRARY_MIGRATION_VERSION,
    nonce,
    libraryRaw: null,
    communityRaw: null,
    legacyAtlasRaw: null,
    ...raws,
  };
}
const readLibrary = storage => JSON.parse(storage.getItem(FAVORITES_LIBRARY_STORAGE_KEY));

// V2 合并：收藏夹、归类、备注一起过来，别名归一，新网址已有的收藏与同名收藏夹保留。
{
  const storage = new MemoryStorage({
    [ATLAS_FAVORITES_STORAGE_KEY]: JSON.stringify(['alpha:alpha-current']),
    [COMMUNITY_FAVORITES_STORAGE_KEY]: JSON.stringify(['community-current']),
  });
  const message = libraryPayload('v2-merge', {
    libraryRaw: oldLibraryRaw(),
    communityRaw: JSON.stringify(['community-old', 'community-current']),
    legacyAtlasRaw: JSON.stringify(['beta:only-in-stale-mirror']),
  });
  const moved = await libraryMigrate({ message, nonce: 'v2-merge', storage, codexes });
  assert.deepEqual(moved.warnings, []);
  assert.deepEqual(moved.result.atlasKeys.slice().sort(), ['alpha:alpha-1', 'alpha:alpha-current', 'beta:beta-old']);
  assert.deepEqual(moved.result.communityIds.slice().sort(), ['community-current', 'community-old']);
  assert.equal(moved.plan.stats.all.added, 3);
  const stored = readLibrary(storage);
  const mine = stored.folders.find(folder => folder.name === '我的画风');
  assert.ok(mine, '自建收藏夹随收藏过来');
  assert.equal(stored.folders.filter(folder => folder.name === '角色').length, 1, '同名收藏夹按名字合并');
  assert.ok(stored.memberships.some(m => m.itemKey === 'alpha:alpha-1' && m.folderId === mine.id));
  assert.equal(stored.items.find(item => item.key === 'alpha:alpha-1').note, '旧网址备注');
  assert.equal(stored.items.find(item => item.key === 'beta:beta-old').addedAt, '2026-10-02T00:00:00.000Z');

  const repeated = await libraryMigrate({ message, nonce: 'v2-merge', storage, codexes });
  assert.equal(repeated.plan.stats.all.added, 0, '重复找回幂等');
  assert.equal(repeated.plan.stats.folders.added, 0);
  assert.equal(readLibrary(storage).items.find(item => item.key === 'alpha:alpha-1').note, '旧网址备注', '备注不重复叠加');
}

// V2 损坏：退回 V1 镜像只带回收藏条目并说明；全都读不了则不写入。
{
  const storage = new MemoryStorage();
  const fallback = await libraryMigrate({
    message: libraryPayload('v2-broken', {
      libraryRaw: '{broken',
      legacyAtlasRaw: JSON.stringify(['beta:from-mirror']),
    }),
    nonce: 'v2-broken',
    storage,
    codexes,
  });
  assert.deepEqual(fallback.result.atlasKeys, ['beta:from-mirror']);
  assert.match(fallback.warnings.join(), /收藏夹和备注无法读取/);

  const before = storage.getItem(FAVORITES_LIBRARY_STORAGE_KEY);
  await expectCode('MIGRATION_SOURCE_CORRUPT', () => libraryMigrate({
    message: libraryPayload('all-broken', { libraryRaw: JSON.stringify({ format: 'other' }) }),
    nonce: 'all-broken',
    storage,
    codexes,
  }));
  assert.equal(storage.getItem(FAVORITES_LIBRARY_STORAGE_KEY), before);

  const nothing = await libraryMigrate({ message: libraryPayload('nothing'), nonce: 'nothing', storage, codexes });
  assert.equal(nothing.plan.stats.all.incoming, 0);
  assert.equal(nothing.plan.stats.folders.added, 0);
}

// 只有旧版 V1（从没在旧网址打开过 V2 收藏库）也能找回；坏条目跳过并计数。
{
  const storage = new MemoryStorage();
  const v1Only = await libraryMigrate({
    message: libraryPayload('v1-only', {
      legacyAtlasRaw: JSON.stringify(['alpha:v1-a', 'missing-separator']),
      communityRaw: JSON.stringify(['community-v1']),
    }),
    nonce: 'v1-only',
    storage,
    codexes,
  });
  assert.deepEqual(v1Only.result.atlasKeys, ['alpha:v1-a']);
  assert.deepEqual(v1Only.result.communityIds, ['community-v1']);
  assert.match(v1Only.warnings.join(), /1 条格式异常/);
}

// 畸形消息与超大载荷在写入前拒绝。
for (const [code, message, nonce] of [
  ['INVALID_MIGRATION_MESSAGE', { ...libraryPayload('x'), version: 1 }, 'x'],
  ['INVALID_MIGRATION_MESSAGE', libraryPayload('x'), 'y'],
  ['INVALID_MIGRATION_PAYLOAD', libraryPayload('x', { libraryRaw: { items: [] } }), 'x'],
  ['MIGRATION_TOO_LARGE', libraryPayload('x', { communityRaw: 'x'.repeat(2 * 1024 * 1024 + 1) }), 'x'],
]) {
  await expectCode(code, () => libraryMigrate({ message, nonce, storage: new MemoryStorage(), codexes }));
}

// 共创收藏写入失败时，两类收藏都回到找回前。
{
  const storage = new MemoryStorage({
    [ATLAS_FAVORITES_STORAGE_KEY]: '["alpha:alpha-before"]',
    [COMMUNITY_FAVORITES_STORAGE_KEY]: '["community-before"]',
  });
  await adapterFor(storage, codexes).readCurrent({ storage, codexes });
  const libraryBefore = storage.getItem(FAVORITES_LIBRARY_STORAGE_KEY);
  storage.failOnceFor = COMMUNITY_FAVORITES_STORAGE_KEY;
  await expectCode('STORAGE_WRITE_FAILED', () => libraryMigrate({
    message: libraryPayload('v2-rollback', { libraryRaw: oldLibraryRaw(), communityRaw: '["community-old"]' }),
    nonce: 'v2-rollback',
    storage,
    codexes,
  }));
  assert.equal(storage.getItem(FAVORITES_LIBRARY_STORAGE_KEY), libraryBefore);
  assert.equal(storage.getItem(COMMUNITY_FAVORITES_STORAGE_KEY), '["community-before"]');
}

// 整条 V2 桥：委托点击打开旧网址页面，V1 消息被忽略，合并后写本桥自己的标记并回报结果。
{
  const storage = new MemoryStorage({ [ATLAS_FAVORITES_STORAGE_KEY]: '[]' });
  const documentApi = new FakeDocument();
  const windowApi = new FakeWindow(storage, 'https://naitag.com');
  const posted = [];
  const popup = { postMessage(message, origin) { posted.push({ message, origin }); } };
  let openedTarget = '';
  let done = null;
  const controller = setupFavoritesOriginMigration({
    window: windowApi,
    document: documentApi,
    storage,
    restoreFavorites: adapterFor(storage, codexes).restore,
    getCodexes: async () => codexes,
    onDone: (message, marker) => { done = { message, marker }; },
    openWindow: target => { openedTarget = target; return popup; },
    timeoutMs: 1000,
  });
  assert.equal(controller.bridge.id, 'naitag-202611');
  assert.equal(documentApi.offer.hidden, false, '新网址显示对话框里的找回入口');
  assert.equal(documentApi.banner.hidden, true, '新网址不用首页横幅');

  const click = new Event('click');
  const clickTarget = {
    closest: () => clickTarget,
    matches: selector => selector === '[data-favorites-migration-start]',
    disabled: false,
  };
  Object.defineProperty(click, 'target', { value: clickTarget });
  documentApi.dispatchEvent(click);
  const nonce = '000102030405060708090a0b0c0d0e0f';
  assert.equal(openedTarget, `https://novelai.quicktagcloud.com/_favorites-migration-202611.html?bridge=20261111#nonce=${nonce}`);

  const from = data => dispatchMessage(windowApi, { origin: 'https://novelai.quicktagcloud.com', source: popup, data });
  from({ type: FAVORITES_MIGRATION_MESSAGES.ready, version: 1, nonce });
  assert.equal(posted.length, 0, 'V1 的 ready 不回应');
  from({ type: FAVORITES_MIGRATION_MESSAGES.ready, version: 2, nonce });
  assert.deepEqual(posted[0], {
    message: { type: FAVORITES_MIGRATION_MESSAGES.request, version: 2, nonce },
    origin: 'https://novelai.quicktagcloud.com',
  });
  from(payload(nonce, { atlasKeys: ['beta:v1-shaped'], communityIds: [] }));
  from(libraryPayload(nonce, { libraryRaw: oldLibraryRaw() }));
  for (let attempts = 0; attempts < 100 && !done; attempts++) await tick(10);
  assert.ok(done, '找回完成');
  assert.equal(done.marker.status, 'migrated');
  assert.match(done.message, /^已找回旧收藏：新增 2 条、收藏夹 \d+ 个/);
  assert.equal(readFavoritesMigrationMarker(storage, FAVORITES_MOVE_MARKER_KEY).status, 'migrated');
  assert.equal(readFavoritesMigrationMarker(storage), null, '不动 pages.dev 那条桥的标记');
  assert.equal(readLibrary(storage).items.some(item => item.key === 'beta:v1-shaped'), false);
  assert.equal(posted.at(-1).message.type, FAVORITES_MIGRATION_MESSAGES.result);
  assert.equal(posted.at(-1).message.version, 2);
  assert.equal(windowApi.messageListenerCount, 0);
}

// 旧网址救援页（202611）：新网址上不读也不跳；无 opener 时给取件码；有 opener 时交出三份原始字符串。
{
  const pageSource = await readFile(new URL('../site/_favorites-migration-202611.html', import.meta.url), 'utf8');
  const pageScript = pageSource.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(pageScript, 'missing 202611 inline script');
  const runPage = ({ href, entries = {}, opener = null }) => {
    const url = new URL(href);
    const elements = new Map();
    const node = id => {
      if (!elements.has(id)) elements.set(id, { id, hidden: false, textContent: '', href: '', classList: { toggle() {} } });
      return elements.get(id);
    };
    const listeners = [];
    const pageStorage = new MemoryStorage(entries);
    runInNewContext(pageScript, {
      URL, URLSearchParams, TextEncoder,
      setTimeout: () => 0, clearTimeout: () => {},
      location: { href, origin: url.origin, hostname: url.hostname, pathname: url.pathname, search: url.search, hash: url.hash },
      localStorage: pageStorage,
      document: { getElementById: node },
      window: { opener, addEventListener: (type, listener) => listeners.push(listener), close() {} },
    });
    return { status: node('status').textContent, node, listeners };
  };

  const onNew = runPage({ href: 'https://naitag.com/_favorites-migration-202611.html?bridge=20261111#nonce=a' });
  assert.match(onNew.status, /已跳转/);

  const noOpener = runPage({
    href: 'https://novelai.quicktagcloud.com/_favorites-migration-202611.html',
    entries: { [FAVORITES_LIBRARY_STORAGE_KEY]: oldLibraryRaw(), [COMMUNITY_FAVORITES_STORAGE_KEY]: '["c1"]' },
  });
  assert.equal(noOpener.node('atlasCount').textContent, '2');
  assert.equal(noOpener.node('communityCount').textContent, '1');
  assert.match(noOpener.status, /取件码/);

  const sent = [];
  const opener = { postMessage: (message, origin) => sent.push({ message, origin }) };
  const libraryRaw = oldLibraryRaw();
  const withOpener = runPage({
    href: 'https://novelai.quicktagcloud.com/_favorites-migration-202611.html?bridge=20261111#nonce=page-nonce',
    entries: { [FAVORITES_LIBRARY_STORAGE_KEY]: libraryRaw, [ATLAS_FAVORITES_STORAGE_KEY]: '["alpha:mirror"]' },
    opener,
  });
  assert.equal(sent[0].message.type, 'ready');
  assert.equal(sent[0].origin, 'https://naitag.com');
  const deliver = (data, origin = 'https://naitag.com') => withOpener.listeners.forEach(listener => listener({ origin, source: opener, data }));
  deliver({ type: 'request', version: 1, nonce: 'page-nonce' });
  assert.equal(sent.length, 1, 'V1 请求不交数据');
  deliver({ type: 'request', version: 2, nonce: 'page-nonce' }, 'https://evil.example');
  assert.equal(sent.length, 1, '其它 origin 拿不到数据');
  deliver({ type: 'request', version: 2, nonce: 'page-nonce' });
  // 页面脚本在另一个 realm 里建对象，先过一遍 JSON 再比内容。
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1].message)), {
    type: 'payload', version: 2, nonce: 'page-nonce',
    libraryRaw, communityRaw: null, legacyAtlasRaw: '["alpha:mirror"]',
  });
}

console.log('favorites origin migration: all tests passed');
