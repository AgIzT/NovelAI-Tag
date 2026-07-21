import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const coreFile = new URL('../site/assets/app/favorites-backup-core.js', import.meta.url);
const migrationFile = new URL('../site/assets/app/favorites-origin-migration.js', import.meta.url);
const rescueFile = new URL('../site/_favorites-migration-202607.html', import.meta.url);
const coreSource = await readFile(coreFile, 'utf8');
const coreDataUrl = `data:text/javascript;base64,${Buffer.from(coreSource).toString('base64')}`;
const migrationSource = (await readFile(migrationFile, 'utf8')).replace(
  "from './favorites-backup-core.js'",
  `from '${coreDataUrl}'`,
);
const migration = await import(
  `data:text/javascript;base64,${Buffer.from(migrationSource).toString('base64')}`
);

const {
  ATLAS_FAVORITES_STORAGE_KEY,
  COMMUNITY_FAVORITES_STORAGE_KEY,
  FavoritesBackupError,
} = await import(coreDataUrl);

const {
  FAVORITES_MIGRATION_CACHE_BUSTER_PARAM,
  FAVORITES_MIGRATION_CACHE_BUSTER_VALUE,
  FAVORITES_MIGRATION_MARKER_KEY,
  FAVORITES_MIGRATION_MESSAGES,
  FAVORITES_MIGRATION_VERSION,
  buildFavoritesMigrationUrl,
  createFavoritesMigrationNonce,
  createFavoritesMigrationRestore,
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

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement();
    this.start = new FakeElement();
    this.dismiss = new FakeElement();
    this.banner = new FakeElement();
    this.feedback = new FakeElement();
    this.fallback = new FakeElement();
  }

  querySelectorAll(selector) {
    return {
      '[data-favorites-migration-start]': [this.start],
      '[data-favorites-migration-dismiss]': [this.dismiss],
      '[data-favorites-migration-banner]': [this.banner],
      '[data-favorites-migration-feedback]': [this.feedback],
      '[data-favorites-migration-fallback]': [this.fallback],
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

function expectCode(code, fn) {
  assert.throws(fn, error => error instanceof FavoritesBackupError && error.code === code);
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
  now: Date.parse('2026-10-31T23:59:59+08:00'),
}), true);
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
const merged = createFavoritesMigrationRestore({
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
const repeated = createFavoritesMigrationRestore({
  message: mergeMessage,
  nonce: 'merge-nonce',
  storage: mergeStorage,
  codexes,
});
assert.equal(repeated.plan.stats.all.added, 0);
assert.equal(repeated.plan.stats.all.duplicate, 4);
assert.deepEqual(repeated.result, merged.result);
const empty = createFavoritesMigrationRestore({
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
const ownerMigrated = createFavoritesMigrationRestore({
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
const ownerRepeated = createFavoritesMigrationRestore({
  message: ownerMigrationMessage,
  nonce: 'owner-migration',
  storage: ownerMigrationStorage,
  codexes,
});
assert.equal(ownerRepeated.plan.stats.atlas.added, 0);
assert.equal(ownerRepeated.plan.stats.atlas.duplicate, 4);
assert.deepEqual(ownerRepeated.result, ownerMigrated.result);

// 畸形消息、字段限制、数量上限和 2 MiB 上限全部在写入前拒绝。
expectCode('INVALID_MIGRATION_MESSAGE', () => createFavoritesMigrationRestore({
  message: { ...mergeMessage, version: 2 },
  nonce: 'merge-nonce',
  storage: mergeStorage,
  codexes,
}));
expectCode('INVALID_MIGRATION_MESSAGE', () => createFavoritesMigrationRestore({
  message: mergeMessage,
  nonce: 'wrong',
  storage: mergeStorage,
  codexes,
}));
expectCode('INVALID_MIGRATION_PAYLOAD', () => createFavoritesMigrationRestore({
  message: { ...mergeMessage, communityIds: undefined },
  nonce: 'merge-nonce',
  storage: mergeStorage,
  codexes,
}));
expectCode('INVALID_ATLAS_ITEM', () => createFavoritesMigrationRestore({
  message: payload('bad-atlas', { atlasKeys: ['missing-separator'], communityIds: [] }),
  nonce: 'bad-atlas',
  storage: mergeStorage,
  codexes,
}));
expectCode('INVALID_COMMUNITY_ITEM', () => createFavoritesMigrationRestore({
  message: payload('bad-community', {
    atlasKeys: [],
    communityIds: ['x'.repeat(257)],
  }),
  nonce: 'bad-community',
  storage: mergeStorage,
  codexes,
}));
expectCode('TOO_MANY_ITEMS', () => createFavoritesMigrationRestore({
  message: payload('too-many', {
    atlasKeys: [],
    communityIds: Array(30001).fill('same'),
  }),
  nonce: 'too-many',
  storage: mergeStorage,
  codexes,
}));
expectCode('MIGRATION_TOO_LARGE', () => createFavoritesMigrationRestore({
  message: payload('too-large', {
    atlasKeys: [],
    communityIds: ['x'.repeat(2 * 1024 * 1024)],
  }),
  nonce: 'too-large',
  storage: mergeStorage,
  codexes,
}));

// 第二键写入失败时，事务核心恢复两个原始值。
const originalAtlas = '["alpha:alpha-before"]';
const originalCommunity = '["community-before"]';
const rollbackStorage = new MemoryStorage({
  [ATLAS_FAVORITES_STORAGE_KEY]: originalAtlas,
  [COMMUNITY_FAVORITES_STORAGE_KEY]: originalCommunity,
});
rollbackStorage.failOnceFor = COMMUNITY_FAVORITES_STORAGE_KEY;
expectCode('STORAGE_WRITE_FAILED', () => createFavoritesMigrationRestore({
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
  const controller = setupFavoritesOriginMigration({
    window: windowApi,
    document: documentApi,
    root: documentApi,
    storage,
    oldOrigin: 'https://old.example',
    newOrigin: 'https://new.example',
    currentOrigin: 'https://new.example',
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
  if (scenario === 'blocked') assert.match(documentApi.feedback.textContent, /阻止/);
  if (scenario === 'closed') assert.match(documentApi.feedback.textContent, /关闭/);
  if (scenario === 'timeout') assert.match(documentApi.feedback.textContent, /超时/);
}

console.log('favorites origin migration: all tests passed');
