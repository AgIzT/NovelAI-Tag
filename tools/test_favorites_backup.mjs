import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const coreUrl = new URL('../site/assets/app/favorites-backup-core.js', import.meta.url);
const coreSource = await readFile(coreUrl, 'utf8');
const core = await import(`data:text/javascript;base64,${Buffer.from(coreSource).toString('base64')}`);

const {
  ATLAS_FAVORITES_STORAGE_KEY,
  COMMUNITY_FAVORITES_STORAGE_KEY,
  FavoritesBackupError,
  atlasFavoriteStorageKeys,
  canonicalizeAtlasFavorite,
  canonicalizeAtlasStorageKey,
  commitFavoritesRestore,
  createCodexLookup,
  createFavoritesBackup,
  createFavoritesRestorePlan,
  parseFavoritesBackup,
  readStoredFavorites,
  serializeFavoritesBackup,
} = core;

const codexes = [
  { id: 'alpha', aliases: ['old_alpha'] },
  { id: 'beta' },
];
const ownerMigrationCodexes = [
  { id: 'artist_nai45_strings' },
  { id: 'mengshen_pack' },
  { id: 'suozhang_r18' },
];
const exportedAt = '2026-07-10T00:00:00.000Z';

function backupText(favorites, extra = {}) {
  return JSON.stringify({
    format: 'novelai-tag-favorites',
    version: 1,
    exportedAt,
    favorites,
    ...extra,
  });
}

function expectCode(code, fn) {
  assert.throws(fn, error => error instanceof FavoritesBackupError && error.code === code);
}

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

// 空集合与紧凑 JSON。
const emptyJson = serializeFavoritesBackup({ exportedAt, codexes });
assert.equal(
  emptyJson,
  '{"format":"novelai-tag-favorites","version":1,"exportedAt":"2026-07-10T00:00:00.000Z","favorites":{"atlas":[],"community":[]}}',
);
assert.deepEqual(parseFavoritesBackup(emptyJson, codexes).favorites, { atlas: [], community: [] });

// 导出会 canonicalize、去重并按稳定的代码点顺序排序。
const created = createFavoritesBackup({
  atlasKeys: [
    'beta:z-entry',
    'old_alpha:old_alpha-entry-2',
    'alpha:alpha-entry-2',
    'alpha:shared-entry',
  ],
  communityIds: ['z-id', 'a-id', 'z-id'],
  codexes,
  exportedAt,
});
assert.deepEqual(created.favorites, {
  atlas: [
    { codexId: 'alpha', entryId: 'alpha-entry-2' },
    { codexId: 'alpha', entryId: 'shared-entry' },
    { codexId: 'beta', entryId: 'z-entry' },
  ],
  community: ['a-id', 'z-id'],
});
assert.deepEqual(
  canonicalizeAtlasFavorite({ codexId: 'old_alpha', entryId: 'old_alpha-42' }, createCodexLookup(codexes)),
  { codexId: 'alpha', entryId: 'alpha-42' },
);
assert.deepEqual(
  canonicalizeAtlasFavorite({ codexId: 'old_alpha', entryId: 'shared' }, codexes),
  { codexId: 'alpha', entryId: 'shared' },
);
assert.deepEqual(
  atlasFavoriteStorageKeys({ codexId: 'alpha', entryId: 'alpha-42' }, codexes),
  ['alpha:alpha-42', 'old_alpha:old_alpha-42'],
);
assert.deepEqual(
  atlasFavoriteStorageKeys({ codexId: 'alpha', entryId: 'shared' }, codexes),
  ['alpha:shared', 'old_alpha:shared'],
);

// 章节/法典合并后的旧归属键会改挂到当前法典，但词条 id 原样保留。
for (const entryId of ['mengshen_pack-0001', 'mengshen_pack-0258']) {
  assert.deepEqual(
    canonicalizeAtlasFavorite({ codexId: 'mengshen_pack', entryId }, ownerMigrationCodexes),
    { codexId: 'artist_nai45_strings', entryId },
  );
}
assert.deepEqual(
  canonicalizeAtlasFavorite(
    { codexId: 'mengshen_pack', entryId: 'mengshen_pack-0259' },
    ownerMigrationCodexes,
  ),
  { codexId: 'mengshen_pack', entryId: 'mengshen_pack-0259' },
);
for (const sourceCodexId of ['codex_6e699406', 'codex_8489ac52']) {
  const entryId = `${sourceCodexId}-0042`;
  assert.deepEqual(
    canonicalizeAtlasFavorite({ codexId: sourceCodexId, entryId }, ownerMigrationCodexes),
    { codexId: 'suozhang_r18', entryId },
  );
}
assert.deepEqual(
  canonicalizeAtlasStorageKey(
    'mengshen_pack:mengshen_pack-0001',
    ownerMigrationCodexes,
  ),
  { codexId: 'artist_nai45_strings', entryId: 'mengshen_pack-0001' },
);
assert.deepEqual(
  atlasFavoriteStorageKeys(
    { codexId: 'artist_nai45_strings', entryId: 'mengshen_pack-0001' },
    ownerMigrationCodexes,
  ),
  [
    'artist_nai45_strings:mengshen_pack-0001',
    'mengshen_pack:mengshen_pack-0001',
  ],
);
assert.deepEqual(
  atlasFavoriteStorageKeys(
    { codexId: 'suozhang_r18', entryId: 'codex_6e699406-0042' },
    ownerMigrationCodexes,
  ),
  [
    'suozhang_r18:codex_6e699406-0042',
    'codex_6e699406:codex_6e699406-0042',
  ],
);

// UTF-8 BOM、额外字段、文件内重复项，以及未知法典保留与计数。
const parsed = parseFavoritesBackup(`\ufeff${backupText({
  atlas: [
    { codexId: 'old_alpha', entryId: 'old_alpha-1', ignored: true },
    { codexId: 'alpha', entryId: 'alpha-1' },
    { codexId: 'future_codex', entryId: 'future-1' },
  ],
  community: ['community-1', 'community-1'],
}, { ignoredRoot: true })}`, codexes);
assert.deepEqual(parsed.favorites, {
  atlas: [
    { codexId: 'alpha', entryId: 'alpha-1' },
    { codexId: 'future_codex', entryId: 'future-1' },
  ],
  community: ['community-1'],
});
assert.equal(parsed.unknownCodexCount, 1);
assert.deepEqual(parsed.unknownCodexIds, ['future_codex']);

// 合并与覆盖预案：duplicate 是与当前集合的交集，removed 是覆盖后会删除的当前项。
const incoming = parseFavoritesBackup(backupText({
  atlas: [
    { codexId: 'alpha', entryId: 'alpha-1' },
    { codexId: 'beta', entryId: 'beta-2' },
    { codexId: 'future_codex', entryId: 'future-3' },
  ],
  community: ['community-1', 'community-2'],
}), codexes);
const planInput = {
  backup: incoming,
  currentAtlasKeys: ['old_alpha:old_alpha-1', 'alpha:alpha-3'],
  currentCommunityIds: ['community-1', 'community-3'],
  codexes,
};
const mergePlan = createFavoritesRestorePlan({ ...planInput, mode: 'merge' });
assert.deepEqual(mergePlan.stats.atlas, {
  current: 2, incoming: 3, added: 2, duplicate: 1, removed: 0, total: 4,
});
assert.deepEqual(mergePlan.stats.community, {
  current: 2, incoming: 2, added: 1, duplicate: 1, removed: 0, total: 3,
});
assert.deepEqual(mergePlan.stats.all, {
  current: 4, incoming: 5, added: 3, duplicate: 2, removed: 0, total: 7,
});
assert.equal(mergePlan.stats.unknownCodexCount, 1);
assert.deepEqual(mergePlan.stats.unknownCodexIds, ['future_codex']);

const replacePlan = createFavoritesRestorePlan({ ...planInput, mode: 'replace' });
assert.deepEqual(replacePlan.stats.atlas, {
  current: 2, incoming: 3, added: 2, duplicate: 1, removed: 1, total: 3,
});
assert.deepEqual(replacePlan.stats.community, {
  current: 2, incoming: 2, added: 1, duplicate: 1, removed: 1, total: 2,
});
assert.deepEqual(replacePlan.next, incoming.favorites);

const clearPlan = createFavoritesRestorePlan({
  backup: parseFavoritesBackup(emptyJson, codexes),
  currentAtlasKeys: ['alpha:alpha-1'],
  currentCommunityIds: ['community-1'],
  mode: 'replace',
  codexes,
});
assert.equal(clearPlan.stats.willClearAll, true);
assert.deepEqual(clearPlan.stats.all, {
  current: 2, incoming: 0, added: 0, duplicate: 0, removed: 2, total: 0,
});

// 错误结构、版本、长度、控制字符与条数上限均拒绝整包。
expectCode('INVALID_JSON', () => parseFavoritesBackup('{', codexes));
expectCode('INVALID_ROOT', () => parseFavoritesBackup('[]', codexes));
expectCode('INVALID_FORMAT', () => parseFavoritesBackup(backupText({ atlas: [], community: [] }).replace('novelai-tag-favorites', 'other'), codexes));
expectCode('UNSUPPORTED_VERSION', () => parseFavoritesBackup(backupText({ atlas: [], community: [] }).replace('"version":1', '"version":2'), codexes));
expectCode('INVALID_ATLAS', () => parseFavoritesBackup(backupText({ community: [] }), codexes));
expectCode('INVALID_COMMUNITY', () => parseFavoritesBackup(backupText({ atlas: [] }), codexes));
expectCode('INVALID_ATLAS_ITEM', () => parseFavoritesBackup(backupText({ atlas: ['alpha:1'], community: [] }), codexes));
expectCode('INVALID_ATLAS_ITEM', () => parseFavoritesBackup(backupText({ atlas: [{ codexId: '', entryId: '1' }], community: [] }), codexes));
expectCode('INVALID_ATLAS_ITEM', () => parseFavoritesBackup(backupText({ atlas: [{ codexId: 'a'.repeat(129), entryId: '1' }], community: [] }), codexes));
expectCode('INVALID_ATLAS_ITEM', () => parseFavoritesBackup(backupText({ atlas: [{ codexId: 'alpha', entryId: 'bad\u0000id' }], community: [] }), codexes));
expectCode('INVALID_COMMUNITY_ITEM', () => parseFavoritesBackup(backupText({ atlas: [], community: ['x'.repeat(257)] }), codexes));
expectCode('INVALID_COMMUNITY_ITEM', () => parseFavoritesBackup(backupText({ atlas: [], community: ['bad\u007fid'] }), codexes));
expectCode('TOO_MANY_ITEMS', () => parseFavoritesBackup(backupText({ atlas: [], community: Array(30001).fill('same') }), codexes));
expectCode('INVALID_MODE', () => createFavoritesRestorePlan({ ...planInput, mode: 'append' }));

// 读取现有键沿用各页面的损坏 JSON => 空集合行为，并归一 alias。
const readStorage = new MemoryStorage({
  [ATLAS_FAVORITES_STORAGE_KEY]: JSON.stringify(['old_alpha:old_alpha-2']),
  [COMMUNITY_FAVORITES_STORAGE_KEY]: JSON.stringify(['b', 'a', 'a']),
});
assert.deepEqual(readStoredFavorites(readStorage, codexes), {
  atlasKeys: ['alpha:alpha-2'],
  communityIds: ['a', 'b'],
});
readStorage.values.set(ATLAS_FAVORITES_STORAGE_KEY, '{broken');
assert.deepEqual(readStoredFavorites(readStorage, codexes).atlasKeys, []);

// 现存旧键读取时归一并与新键去重，未迁出的 mengshen_pack-0259 保持原归属。
const ownerMigrationStorage = new MemoryStorage({
  [ATLAS_FAVORITES_STORAGE_KEY]: JSON.stringify([
    'mengshen_pack:mengshen_pack-0001',
    'artist_nai45_strings:mengshen_pack-0001',
    'mengshen_pack:mengshen_pack-0259',
    'codex_6e699406:codex_6e699406-0042',
    'codex_8489ac52:codex_8489ac52-0042',
  ]),
  [COMMUNITY_FAVORITES_STORAGE_KEY]: '[]',
});
assert.deepEqual(readStoredFavorites(ownerMigrationStorage, ownerMigrationCodexes).atlasKeys, [
  'artist_nai45_strings:mengshen_pack-0001',
  'mengshen_pack:mengshen_pack-0259',
  'suozhang_r18:codex_6e699406-0042',
  'suozhang_r18:codex_8489ac52-0042',
]);

// 重复恢复同一条旧归属收藏是幂等的。
const ownerMigrationBackup = createFavoritesBackup({
  atlasKeys: ['mengshen_pack:mengshen_pack-0001'],
  codexes: ownerMigrationCodexes,
  exportedAt,
});
const ownerMigrationPlan = createFavoritesRestorePlan({
  backup: ownerMigrationBackup,
  currentAtlasKeys: ['artist_nai45_strings:mengshen_pack-0001'],
  mode: 'merge',
  codexes: ownerMigrationCodexes,
});
assert.equal(ownerMigrationPlan.stats.atlas.added, 0);
assert.equal(ownerMigrationPlan.stats.atlas.duplicate, 1);
assert.deepEqual(ownerMigrationPlan.next.atlas, [
  { codexId: 'artist_nai45_strings', entryId: 'mengshen_pack-0001' },
]);

// 永久兼容表必须和当前真实数据对齐：258 条全命中，旧图包剩余项全不误迁。
const realCodexes = JSON.parse(await readFile(new URL('../site/data/codexes.json', import.meta.url), 'utf8'));
const artistStrings = JSON.parse(await readFile(new URL('../site/data/artist_nai45_strings.json', import.meta.url), 'utf8'));
const mengshenPack = JSON.parse(await readFile(new URL('../site/data/mengshen_pack.json', import.meta.url), 'utf8'));
const suozhangR18 = JSON.parse(await readFile(new URL('../site/data/suozhang_r18.json', import.meta.url), 'utf8'));
const movedMengshenEntries = artistStrings.entries.filter(entry => entry.id.startsWith('mengshen_pack-'));
assert.equal(movedMengshenEntries.length, 258);
for (const entry of movedMengshenEntries) {
  assert.deepEqual(
    canonicalizeAtlasFavorite(
      { codexId: 'mengshen_pack', entryId: entry.id },
      realCodexes,
    ),
    { codexId: 'artist_nai45_strings', entryId: entry.id },
  );
}
for (const entry of mengshenPack.entries) {
  assert.deepEqual(
    canonicalizeAtlasFavorite(
      { codexId: 'mengshen_pack', entryId: entry.id },
      realCodexes,
    ),
    { codexId: 'mengshen_pack', entryId: entry.id },
  );
}
for (const entry of suozhangR18.entries) {
  const sourceCodexId = entry.id.startsWith('codex_6e699406-')
    ? 'codex_6e699406'
    : 'codex_8489ac52';
  assert.deepEqual(
    canonicalizeAtlasFavorite({ codexId: sourceCodexId, entryId: entry.id }, realCodexes),
    { codexId: 'suozhang_r18', entryId: entry.id },
  );
}

// 双键提交成功后才返回最终运行态快照。
const successStorage = new MemoryStorage();
const committed = commitFavoritesRestore(successStorage, replacePlan);
assert.deepEqual(committed, {
  atlasKeys: ['alpha:alpha-1', 'beta:beta-2', 'future_codex:future-3'],
  communityIds: ['community-1', 'community-2'],
});
assert.equal(successStorage.getItem(ATLAS_FAVORITES_STORAGE_KEY), JSON.stringify(committed.atlasKeys));
assert.equal(successStorage.getItem(COMMUNITY_FAVORITES_STORAGE_KEY), JSON.stringify(committed.communityIds));

// 第二键写入失败时，两个键都恢复为保存前的原始字符串。
const oldAtlasRaw = '["old_alpha:old_alpha-9"]';
const oldCommunityRaw = '["old-community"]';
const rollbackStorage = new MemoryStorage({
  [ATLAS_FAVORITES_STORAGE_KEY]: oldAtlasRaw,
  [COMMUNITY_FAVORITES_STORAGE_KEY]: oldCommunityRaw,
});
rollbackStorage.failOnceFor = COMMUNITY_FAVORITES_STORAGE_KEY;
expectCode('STORAGE_WRITE_FAILED', () => commitFavoritesRestore(rollbackStorage, replacePlan));
assert.equal(rollbackStorage.getItem(ATLAS_FAVORITES_STORAGE_KEY), oldAtlasRaw);
assert.equal(rollbackStorage.getItem(COMMUNITY_FAVORITES_STORAGE_KEY), oldCommunityRaw);

console.log('favorites backup core: all tests passed');
