import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const coreUrl = new URL('../site/assets/app/favorites-backup-core.js', import.meta.url);
const coreSource = await readFile(coreUrl, 'utf8');
const core = await import(`data:text/javascript;base64,${Buffer.from(coreSource).toString('base64')}`);
const backupUiUrl = new URL('../site/assets/app/favorites-backup.js', import.meta.url);
const backupUiSource = await readFile(backupUiUrl, 'utf8');

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
/* 2026-08-31 之后的现状：迁移目标 artist_nai45_strings 自己被并进了合并册，只剩别名身份。 */
const mergedOwnerMigrationCodexes = [
  { id: 'artist_nai45_personal', aliases: ['artist_300', 'artist_nai45_strings'] },
  { id: 'mengshen_pack' },
  { id: 'suozhang_r18' },
];
/* 两本社区图包并成一册后的现状：旧书 id 只作为别名与迁移来源存在。 */
const mergedPackCodexes = [
  { id: 'nai45_community_pack', aliases: ['mengshen_pack', 'community_ai_misc'] },
  { id: 'artist_nai45_personal', aliases: ['artist_nai45_strings'] },
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

// 迁移目标那本后来被并册（只剩别名）时，正反两个方向都必须照旧成立：
// 反向少生成一个旧键，收藏就会在「全部收藏」里静默消失——isFav 正是靠这些键认卡的。
assert.deepEqual(
  canonicalizeAtlasStorageKey('mengshen_pack:mengshen_pack-0001', mergedOwnerMigrationCodexes),
  { codexId: 'artist_nai45_personal', entryId: 'mengshen_pack-0001' },
);
assert.ok(
  atlasFavoriteStorageKeys(
    { codexId: 'artist_nai45_personal', entryId: 'mengshen_pack-0001' },
    mergedOwnerMigrationCodexes,
  ).includes('mengshen_pack:mengshen_pack-0001'),
  '并册后仍须生成旧归属键 mengshen_pack:mengshen_pack-0001',
);

// 图包合并：两本旧图包的收藏都要落到 nai45_community_pack，且 **词条 id 一个字符都不能改**
// （别名路径会把 id 前缀换掉，所以这两本必须走迁移表；这几条断言就是钉住这一点）。
for (const [codexId, entryId] of [
  ['mengshen_pack', 'mengshen_pack-0259'],
  ['mengshen_pack', 'mengshen_pack-1944'],
  ['community_ai_misc', 'community_ai_misc-0001'],
  ['community_ai_misc', 'community_ai_misc-5330'],
]) {
  assert.deepEqual(
    canonicalizeAtlasFavorite({ codexId, entryId }, mergedPackCodexes),
    { codexId: 'nai45_community_pack', entryId },
  );
}
// 梦神 0001–0258 归画师词典那本，别被图包这条新规则抢走。
assert.deepEqual(
  canonicalizeAtlasFavorite({ codexId: 'mengshen_pack', entryId: 'mengshen_pack-0001' }, mergedPackCodexes),
  { codexId: 'artist_nai45_personal', entryId: 'mengshen_pack-0001' },
);
assert.ok(
  atlasFavoriteStorageKeys(
    { codexId: 'nai45_community_pack', entryId: 'community_ai_misc-0042' },
    mergedPackCodexes,
  ).includes('community_ai_misc:community_ai_misc-0042'),
  '并册后仍须生成旧归属键 community_ai_misc:community_ai_misc-0042',
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
  skippedCount: 0,
});
readStorage.values.set(ATLAS_FAVORITES_STORAGE_KEY, '{broken');
assert.deepEqual(readStoredFavorites(readStorage, codexes).atlasKeys, []);

// 本地现存脏键逐条跳过并计数；外部备份仍由上方 INVALID_* 断言保持整包严格拒绝。
readStorage.values.set(ATLAS_FAVORITES_STORAGE_KEY, JSON.stringify([
  'alpha:alpha-2',
  'missing-separator',
  `alpha:bad\u0000id`,
]));
readStorage.values.set(COMMUNITY_FAVORITES_STORAGE_KEY, JSON.stringify([
  'community-ok',
  'bad\u007fid',
]));
assert.deepEqual(readStoredFavorites(readStorage, codexes), {
  atlasKeys: ['alpha:alpha-2'],
  communityIds: ['community-ok'],
  skippedCount: 3,
});

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

// 公开仓库没有整个 data 目录时才跳过；索引或任何一本应存在的书缺失必须失败。
const localDataDir = new URL('../site/data/', import.meta.url);
const hasLocalData = await stat(localDataDir).then(value => value.isDirectory()).catch(error => {
  if (error?.code !== 'ENOENT') throw error;
  return false;
});
if (hasLocalData) {
  const realCodexes = JSON.parse(await readFile(new URL('../site/data/codexes.json', import.meta.url), 'utf8'));
  const lookup = createCodexLookup(realCodexes);
  const readBook = async id => {
    const meta = lookup.byAnyId.get(id);
    assert.ok(meta, `真实书目缺失：${id}`);
    const book = JSON.parse(await readFile(new URL(`${meta.id}.json`, localDataDir), 'utf8'));
    assert.equal(book.entries.length, meta.entryCount, `${id} 索引计数`);
    assert.equal(new Set(book.entries.map(entry => entry.id)).size, book.entries.length, `${id} ID 唯一`);
    return book;
  };
  const [artists, packs, suozhangR18] = await Promise.all([
    readBook('artist_nai45_personal'), readBook('nai45_community_pack'), readBook('suozhang_r18'),
  ]);
  const legacyKeys = [];
  const assertLegacyFavorite = (sourceCodexId, entry, targetCodexId) => {
    const expected = { codexId: targetCodexId, entryId: entry.id };
    const oldKey = `${sourceCodexId}:${entry.id}`;
    assert.deepEqual(canonicalizeAtlasStorageKey(oldKey, lookup), expected, oldKey);
    assert.ok(atlasFavoriteStorageKeys(expected, lookup).includes(oldKey), `反向兼容键缺失：${oldKey}`);
    legacyKeys.push(oldKey);
  };
  // 旧个人词典、旧画师串、两个旧图包全量覆盖，不能只验证迁移表里的几条样例。
  for (const entry of artists.entries) {
    const sourceCodexId = {
      '单画师词典': 'artist_nai45_personal',
      '画师串词典': 'artist_nai45_strings',
    }[entry.path[0]];
    assert.ok(sourceCodexId, `画师词典存在未审计分区：${entry.path[0]}`);
    assertLegacyFavorite(sourceCodexId, entry, artists.id);
  }
  for (const entry of packs.entries) {
    const sourceCodexId = {
      '梦神 · 社区图包': 'mengshen_pack',
      '社区 · AI杂图': 'community_ai_misc',
    }[entry.path[0]];
    assert.ok(sourceCodexId, `社区图包存在未审计分区：${entry.path[0]}`);
    assertLegacyFavorite(sourceCodexId, entry, packs.id);
  }
  const movedMengshenEntries = artists.entries.filter(entry => entry.id.startsWith('mengshen_pack-'));
  assert.equal(movedMengshenEntries.length, 258);
  for (const entry of movedMengshenEntries) {
    assertLegacyFavorite('mengshen_pack', entry, artists.id);
  }
  for (const entry of suozhangR18.entries) {
    const sourceCodexId = entry.id.startsWith('codex_6e699406-')
      ? 'codex_6e699406'
      : 'codex_8489ac52';
    assertLegacyFavorite(sourceCodexId, entry, suozhangR18.id);
  }
  const restored = parseFavoritesBackup(serializeFavoritesBackup({
    atlasKeys: legacyKeys, codexes: realCodexes, exportedAt,
  }), realCodexes);
  assert.equal(restored.unknownCodexCount, 0);
  assert.equal(restored.favorites.atlas.length, artists.entries.length + packs.entries.length + suozhangR18.entries.length);
  const actualIds = new Map([artists, packs, suozhangR18].map(book => [book.id, new Set(book.entries.map(entry => entry.id))]));
  for (const item of restored.favorites.atlas) {
    assert.ok(actualIds.get(item.codexId)?.has(item.entryId), `备份恢复后目标不存在：${item.codexId}:${item.entryId}`);
  }
  console.log(`favorites backup core: audited ${legacyKeys.length} real legacy keys, export/restore OK`);
} else {
  console.log('favorites backup core: skipped local-only site/data compatibility audit');
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

// 法典索引网络请求瞬时失败只影响本次操作，下次操作会重试；成功结果仍复用。
const resolverSource = backupUiSource.match(
  /  const resolveCodexes = async \(\) => \{[\s\S]*?\n  \};/,
)?.[0];
assert.ok(resolverSource, 'missing resolveCodexes implementation');
const makeResolver = new Function('options', 'fetchDataJson', 'console', `
  let codexesPromise = null;
${resolverSource}
  return resolveCodexes;
`);
let fetchAttempts = 0;
const resolverWarnings = [];
const resolveCodexes = makeResolver(
  {},
  async () => {
    fetchAttempts += 1;
    if (fetchAttempts === 1) throw new Error('temporary network failure');
    return codexes;
  },
  { warn: (...args) => resolverWarnings.push(args) },
);
assert.deepEqual(await resolveCodexes(), []);
assert.equal(fetchAttempts, 1);
assert.equal(resolverWarnings.length, 1);
assert.equal((await resolveCodexes()), codexes);
assert.equal(fetchAttempts, 2);
assert.equal((await resolveCodexes()), codexes);
assert.equal(fetchAttempts, 2, '成功读取后应继续复用缓存');

console.log('favorites backup core: all tests passed');
