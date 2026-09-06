export const FAVORITES_BACKUP_FORMAT = 'novelai-tag-favorites';
export const FAVORITES_BACKUP_VERSION = 1;
export const ATLAS_FAVORITES_STORAGE_KEY = 'fadian-favs';
export const COMMUNITY_FAVORITES_STORAGE_KEY = 'community-favorites-v1';

export const FAVORITES_BACKUP_LIMITS = Object.freeze({
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalItems: 30000,
  maxAtlasFieldLength: 128,
  maxCommunityIdLength: 256,
});

// 永久兼容表：词条保留原 id、但归属法典发生变化时，旧 localStorage 键仍须指向新正主。
// 这与整本法典 aliases 不同：归属迁移不改词条前缀，且可以只迁走一个编号范围。
export const ATLAS_FAVORITE_OWNER_MIGRATIONS = Object.freeze([
  Object.freeze({
    sourceCodexId: 'mengshen_pack',
    // 2026-08-31 画师串词典并入 artist_nai45_personal 后，这个 target 只是别名——
    // findFavoriteOwnerMigration 用 byAnyId（含 aliases）查 target，会自己落到合并册，故不改。
    targetCodexId: 'artist_nai45_strings',
    entryIdPrefix: 'mengshen_pack-',
    entryNumberMin: 1,
    entryNumberMax: 258,
    entryNumberWidth: 4,
  }),
  // 2026-08-31 两本社区图包并成 nai45_community_pack。
  // ⚠ 这里必须走迁移表、不能只靠 aliases：这两本的词条 id 带旧书 id 前缀
  // （`mengshen_pack-NNNN` / `community_ai_misc-NNNN`），别名那条路径会把 id 前缀一起换掉
  // （见下面 canonicalizeAtlasFavorite 的注释），换完就找不到词条；迁移表原样保留 entryId。
  // 梦神那本的 0001–0258 早在 2026-07 就迁进画师串词典，所以这条从 0259 起算，
  // 上面那条老规则继续管 0001–0258，两段不重叠。
  Object.freeze({
    sourceCodexId: 'mengshen_pack',
    targetCodexId: 'nai45_community_pack',
    entryIdPrefix: 'mengshen_pack-',
    entryNumberMin: 259,
    entryNumberMax: 1944,
    entryNumberWidth: 4,
  }),
  Object.freeze({
    sourceCodexId: 'community_ai_misc',
    targetCodexId: 'nai45_community_pack',
    entryIdPrefix: 'community_ai_misc-',
  }),
  Object.freeze({
    sourceCodexId: 'codex_6e699406',
    targetCodexId: 'suozhang_r18',
    entryIdPrefix: 'codex_6e699406-',
  }),
  Object.freeze({
    sourceCodexId: 'codex_8489ac52',
    targetCodexId: 'suozhang_r18',
    entryIdPrefix: 'codex_8489ac52-',
  }),
]);

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;

export class FavoritesBackupError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FavoritesBackupError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new FavoritesBackupError(code, message, details);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareAtlas(a, b) {
  return compareText(a.codexId, b.codexId) || compareText(a.entryId, b.entryId);
}

function atlasSignature(item) {
  return JSON.stringify([item.codexId, item.entryId]);
}

function atlasStorageKey(item) {
  return `${item.codexId}:${item.entryId}`;
}

function asArray(value, label) {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value[Symbol.iterator] === 'function') return [...value];
  fail('INVALID_INPUT', `${label} 必须是数组或可迭代集合`);
}

function assertTotalItemLimit(atlas, community) {
  const total = atlas.length + community.length;
  if (total > FAVORITES_BACKUP_LIMITS.maxTotalItems) {
    fail(
      'TOO_MANY_ITEMS',
      `收藏总数不能超过 ${FAVORITES_BACKUP_LIMITS.maxTotalItems} 条`,
      { total, max: FAVORITES_BACKUP_LIMITS.maxTotalItems },
    );
  }
}

function validateIdentifier(value, maxLength, label, code) {
  if (typeof value !== 'string') fail(code, `${label} 必须是字符串`);
  if (!value.length || !value.trim().length) fail(code, `${label} 不能为空`);
  if (value.length > maxLength) {
    fail(code, `${label} 不能超过 ${maxLength} 个字符`, { length: value.length, max: maxLength });
  }
  if (CONTROL_CHAR_RE.test(value)) fail(code, `${label} 不能包含控制字符`);
  return value;
}

function validateAtlasItem(value, index = -1) {
  const label = index >= 0 ? `法典收藏第 ${index + 1} 项` : '法典收藏';
  if (!isRecord(value)) fail('INVALID_ATLAS_ITEM', `${label} 必须是对象`);
  return {
    codexId: validateIdentifier(
      value.codexId,
      FAVORITES_BACKUP_LIMITS.maxAtlasFieldLength,
      `${label}的 codexId`,
      'INVALID_ATLAS_ITEM',
    ),
    entryId: validateIdentifier(
      value.entryId,
      FAVORITES_BACKUP_LIMITS.maxAtlasFieldLength,
      `${label}的 entryId`,
      'INVALID_ATLAS_ITEM',
    ),
  };
}

function validateCommunityId(value, index = -1) {
  const label = index >= 0 ? `共创广场收藏第 ${index + 1} 项` : '共创广场收藏';
  return validateIdentifier(
    value,
    FAVORITES_BACKUP_LIMITS.maxCommunityIdLength,
    label,
    'INVALID_COMMUNITY_ITEM',
  );
}

export function createCodexLookup(codexes = []) {
  if (!Array.isArray(codexes)) fail('INVALID_CODEX_INDEX', '法典索引必须是数组');
  const byAnyId = new Map();
  const canonicalIds = new Set();

  // 与 findCodexMeta(Array.find) 一致：索引中先出现的法典优先认领冲突 id/alias。
  for (const codex of codexes) {
    if (!isRecord(codex) || typeof codex.id !== 'string' || !codex.id) continue;
    canonicalIds.add(codex.id);
    const ids = [codex.id, ...(Array.isArray(codex.aliases) ? codex.aliases : [])];
    for (const id of ids) {
      if (typeof id === 'string' && id && !byAnyId.has(id)) byAnyId.set(id, codex);
    }
  }

  return { byAnyId, canonicalIds };
}

function toCodexLookup(codexesOrLookup) {
  if (
    codexesOrLookup
    && codexesOrLookup.byAnyId instanceof Map
    && codexesOrLookup.canonicalIds instanceof Set
  ) return codexesOrLookup;
  return createCodexLookup(codexesOrLookup || []);
}

function migrationMatchesEntryId(migration, entryId) {
  if (!entryId.startsWith(migration.entryIdPrefix)) return false;
  if (!Number.isInteger(migration.entryNumberMin)) return true;
  const suffix = entryId.slice(migration.entryIdPrefix.length);
  return suffix.length === migration.entryNumberWidth
    && /^\d+$/.test(suffix)
    && Number(suffix) >= migration.entryNumberMin
    && Number(suffix) <= migration.entryNumberMax;
}

function findFavoriteOwnerMigration(item, lookup) {
  const migration = ATLAS_FAVORITE_OWNER_MIGRATIONS.find(candidate => (
    candidate.sourceCodexId === item.codexId
    && migrationMatchesEntryId(candidate, item.entryId)
  ));
  if (!migration) return null;
  return lookup.byAnyId.get(migration.targetCodexId) || null;
}

// 同书散条合为套图后的精确身份映射；只允许单跳，不猜编号，也不沿链递归。
export function resolveAtlasEntryId(entryId, entryAliases) {
  if (!isRecord(entryAliases) || !Object.hasOwn(entryAliases, entryId)) return entryId;
  const target = entryAliases[entryId];
  if (typeof target !== 'string' || !target || target.trim() !== target
      || target.length > FAVORITES_BACKUP_LIMITS.maxAtlasFieldLength
      || CONTROL_CHAR_RE.test(target) || target === entryId
      || Object.hasOwn(entryAliases, target)) return entryId;
  return target;
}

export function canonicalizeAtlasFavorite(favorite, codexesOrLookup = []) {
  const item = validateAtlasItem(favorite);
  const lookup = toCodexLookup(codexesOrLookup);
  const migratedOwner = findFavoriteOwnerMigration(item, lookup);
  if (migratedOwner) {
    return { codexId: migratedOwner.id, entryId: resolveAtlasEntryId(item.entryId, migratedOwner.entryAliases) };
  }

  const meta = lookup.byAnyId.get(item.codexId);
  if (!meta) return item;

  let entryId = item.entryId;
  // 复刻 fav-codex.js：只有收藏挂在 alias 下且词条 id 也带同一 alias 前缀时才换前缀。
  if (meta.id !== item.codexId && entryId.startsWith(`${item.codexId}-`)) {
    entryId = meta.id + entryId.slice(item.codexId.length);
  }
  return { codexId: meta.id, entryId: resolveAtlasEntryId(entryId, meta.entryAliases) };
}

export function atlasFavoriteStorageKeys(favorite, codexesOrLookup = []) {
  const lookup = toCodexLookup(codexesOrLookup);
  const canonical = canonicalizeAtlasFavorite(favorite, lookup);
  const keys = new Set([atlasStorageKey(canonical)]);
  const meta = lookup.byAnyId.get(canonical.codexId);
  const addCompatibleKey = candidate => {
    // aliases 也供路由使用，不一定是这条词条的历史归属；迁移规则还可能把候选导向另一册。
    // 只认正向归一后仍回到同一词条的键，避免星标命中与收藏墙/备份恢复指向不同身份。
    const normalized = canonicalizeAtlasFavorite(candidate, lookup);
    if (normalized.codexId === canonical.codexId && normalized.entryId === canonical.entryId) {
      keys.add(atlasStorageKey(candidate));
    }
  };

  for (const entryId of Object.keys(isRecord(meta?.entryAliases) ? meta.entryAliases : {})) {
    if (resolveAtlasEntryId(entryId, meta.entryAliases) === canonical.entryId) {
      addCompatibleKey({ codexId: canonical.codexId, entryId });
    }
  }

  for (const alias of meta?.aliases || []) {
    const aliasEntryId = canonical.entryId.startsWith(`${meta.id}-`)
      ? alias + canonical.entryId.slice(meta.id.length)
      : canonical.entryId;
    addCompatibleKey({ codexId: alias, entryId: aliasEntryId });
  }

  for (const migration of ATLAS_FAVORITE_OWNER_MIGRATIONS) {
    // ⚠ target 要先按 aliases 归一再比：迁移目标那本自己也可能后来被并册
    // （2026-08-31 artist_nai45_strings 并进 artist_nai45_personal 就是），
    // 裸比 id 会生成不出旧键，收藏在「全部收藏」里直接消失——isFav 靠这些键认卡。
    const migrationTargetId = lookup.byAnyId.get(migration.targetCodexId)?.id || migration.targetCodexId;
    if (
      migrationTargetId === canonical.codexId
      && migrationMatchesEntryId(migration, canonical.entryId)
    ) {
      addCompatibleKey({ codexId: migration.sourceCodexId, entryId: canonical.entryId });
    }
  }
  return [...keys];
}

function normalizeAtlasItems(values, lookup) {
  const unique = new Map();
  values.forEach((value, index) => {
    const normalized = canonicalizeAtlasFavorite(validateAtlasItem(value, index), lookup);
    unique.set(atlasSignature(normalized), normalized);
  });
  return [...unique.values()].sort(compareAtlas);
}

function parseAtlasStorageKey(value, index) {
  const label = index >= 0 ? `本地法典收藏第 ${index + 1} 项` : '本地法典收藏';
  if (typeof value !== 'string') {
    fail('INVALID_ATLAS_ITEM', `${label}必须是字符串`);
  }
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    fail('INVALID_ATLAS_ITEM', `${label}格式无效`);
  }
  return validateAtlasItem({ codexId: value.slice(0, separator), entryId: value.slice(separator + 1) }, index);
}

export function canonicalizeAtlasStorageKey(value, codexesOrLookup = []) {
  return canonicalizeAtlasFavorite(parseAtlasStorageKey(value, -1), codexesOrLookup);
}

function normalizeAtlasStorageKeys(values, lookup) {
  return normalizeAtlasItems(values.map(parseAtlasStorageKey), lookup);
}

function normalizeCommunityItems(values) {
  return [...new Set(values.map(validateCommunityId))].sort(compareText);
}

function normalizeStoredItems(values, normalize, errorCode) {
  const items = [];
  let skippedCount = 0;
  values.forEach((value, index) => {
    try {
      items.push(normalize(value, index));
    } catch (error) {
      if (!(error instanceof FavoritesBackupError) || error.code !== errorCode) throw error;
      skippedCount += 1;
    }
  });
  return { items, skippedCount };
}

function unknownCodexInfo(atlas, lookup) {
  const unknownItems = atlas.filter(item => !lookup.canonicalIds.has(item.codexId));
  return {
    unknownCodexCount: unknownItems.length,
    unknownCodexIds: [...new Set(unknownItems.map(item => item.codexId))].sort(compareText),
  };
}

function normalizeExportedAt(value, { optional = false, canonical = false } = {}) {
  if ((value === undefined || value === null) && optional) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    fail('INVALID_EXPORTED_AT', 'exportedAt 必须是有效日期');
  }
  return canonical || value instanceof Date ? date.toISOString() : String(value);
}

function normalizeBackupFavorites(favorites, lookup) {
  if (!isRecord(favorites)) fail('INVALID_FAVORITES', 'favorites 必须是对象');
  if (!Object.hasOwn(favorites, 'atlas') || !Array.isArray(favorites.atlas)) {
    fail('INVALID_ATLAS', 'favorites.atlas 必须存在且为数组');
  }
  if (!Object.hasOwn(favorites, 'community') || !Array.isArray(favorites.community)) {
    fail('INVALID_COMMUNITY', 'favorites.community 必须存在且为数组');
  }
  assertTotalItemLimit(favorites.atlas, favorites.community);
  return {
    atlas: normalizeAtlasItems(favorites.atlas, lookup),
    community: normalizeCommunityItems(favorites.community),
  };
}

function safeStoredArray(raw) {
  if (raw === null || raw === undefined || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function assertStorage(storage) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    fail('STORAGE_UNAVAILABLE', '收藏存储不可用');
  }
}

export function readStoredFavorites(storage, codexes = []) {
  assertStorage(storage);
  let atlasRaw;
  let communityRaw;
  try {
    atlasRaw = storage.getItem(ATLAS_FAVORITES_STORAGE_KEY);
    communityRaw = storage.getItem(COMMUNITY_FAVORITES_STORAGE_KEY);
  } catch (cause) {
    throw new FavoritesBackupError('STORAGE_READ_FAILED', '读取本地收藏失败', { cause });
  }

  const lookup = createCodexLookup(codexes);
  const storedAtlas = normalizeStoredItems(
    safeStoredArray(atlasRaw),
    parseAtlasStorageKey,
    'INVALID_ATLAS_ITEM',
  );
  const storedCommunity = normalizeStoredItems(
    safeStoredArray(communityRaw),
    validateCommunityId,
    'INVALID_COMMUNITY_ITEM',
  );
  const atlas = normalizeAtlasItems(storedAtlas.items, lookup);
  const community = normalizeCommunityItems(storedCommunity.items);
  assertTotalItemLimit(atlas, community);
  return {
    atlasKeys: atlas.map(atlasStorageKey),
    communityIds: community,
    skippedCount: storedAtlas.skippedCount + storedCommunity.skippedCount,
  };
}

export function createFavoritesBackup({
  atlasKeys = [],
  communityIds = [],
  codexes = [],
  exportedAt = new Date(),
} = {}) {
  const atlasValues = asArray(atlasKeys, 'atlasKeys');
  const communityValues = asArray(communityIds, 'communityIds');
  assertTotalItemLimit(atlasValues, communityValues);
  const lookup = createCodexLookup(codexes);

  return {
    format: FAVORITES_BACKUP_FORMAT,
    version: FAVORITES_BACKUP_VERSION,
    exportedAt: normalizeExportedAt(exportedAt, { canonical: true }),
    favorites: {
      atlas: normalizeAtlasStorageKeys(atlasValues, lookup),
      community: normalizeCommunityItems(communityValues),
    },
  };
}

export function serializeFavoritesBackup(options) {
  return JSON.stringify(createFavoritesBackup(options));
}

export function parseFavoritesBackup(text, codexes = []) {
  if (typeof text !== 'string') fail('INVALID_JSON', '备份内容必须是 JSON 文本');
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new FavoritesBackupError('INVALID_JSON', '无法解析收藏备份 JSON', { cause });
  }

  if (!isRecord(parsed)) fail('INVALID_ROOT', '收藏备份根节点必须是对象');
  if (parsed.format !== FAVORITES_BACKUP_FORMAT) {
    fail('INVALID_FORMAT', '这不是法典图鉴收藏备份');
  }
  if (parsed.version !== FAVORITES_BACKUP_VERSION) {
    const message = typeof parsed.version === 'number' && parsed.version > FAVORITES_BACKUP_VERSION
      ? '备份版本较新，请先更新站点后再导入'
      : '不支持这个收藏备份版本';
    fail('UNSUPPORTED_VERSION', message, { version: parsed.version });
  }

  const lookup = createCodexLookup(codexes);
  const favorites = normalizeBackupFavorites(parsed.favorites, lookup);
  const unknown = unknownCodexInfo(favorites.atlas, lookup);
  return {
    format: FAVORITES_BACKUP_FORMAT,
    version: FAVORITES_BACKUP_VERSION,
    exportedAt: normalizeExportedAt(parsed.exportedAt, { optional: true }),
    favorites,
    ...unknown,
  };
}

function unionAtlas(a, b) {
  const unique = new Map(a.map(item => [atlasSignature(item), item]));
  b.forEach(item => unique.set(atlasSignature(item), item));
  return [...unique.values()].sort(compareAtlas);
}

function unionCommunity(a, b) {
  return [...new Set([...a, ...b])].sort(compareText);
}

function collectionStats(current, incoming, next, signature = value => value) {
  const currentKeys = new Set(current.map(signature));
  const incomingKeys = new Set(incoming.map(signature));
  const nextKeys = new Set(next.map(signature));
  let added = 0;
  let duplicate = 0;
  let removed = 0;
  incomingKeys.forEach(key => (currentKeys.has(key) ? duplicate++ : added++));
  currentKeys.forEach(key => { if (!nextKeys.has(key)) removed++; });
  return {
    current: currentKeys.size,
    incoming: incomingKeys.size,
    added,
    duplicate,
    removed,
    total: nextKeys.size,
  };
}

function sumStats(atlas, community) {
  return Object.fromEntries(
    ['current', 'incoming', 'added', 'duplicate', 'removed', 'total']
      .map(key => [key, atlas[key] + community[key]]),
  );
}

export function createFavoritesRestorePlan({
  backup,
  currentAtlasKeys = [],
  currentCommunityIds = [],
  mode = 'merge',
  codexes = [],
} = {}) {
  if (mode !== 'merge' && mode !== 'replace') {
    fail('INVALID_MODE', '恢复模式必须是 merge 或 replace');
  }
  if (!isRecord(backup)) fail('INVALID_INPUT', 'backup 必须是已解析的收藏备份');

  const lookup = createCodexLookup(codexes);
  const currentAtlasValues = asArray(currentAtlasKeys, 'currentAtlasKeys');
  const currentCommunityValues = asArray(currentCommunityIds, 'currentCommunityIds');
  assertTotalItemLimit(currentAtlasValues, currentCommunityValues);
  const current = {
    atlas: normalizeAtlasStorageKeys(currentAtlasValues, lookup),
    community: normalizeCommunityItems(currentCommunityValues),
  };
  const incoming = normalizeBackupFavorites(backup.favorites, lookup);
  const next = mode === 'merge'
    ? {
      atlas: unionAtlas(current.atlas, incoming.atlas),
      community: unionCommunity(current.community, incoming.community),
    }
    : { atlas: [...incoming.atlas], community: [...incoming.community] };
  assertTotalItemLimit(next.atlas, next.community);

  const atlasStats = collectionStats(current.atlas, incoming.atlas, next.atlas, atlasSignature);
  const communityStats = collectionStats(current.community, incoming.community, next.community);
  const unknown = unknownCodexInfo(incoming.atlas, lookup);
  return {
    mode,
    current,
    incoming,
    next,
    stats: {
      atlas: atlasStats,
      community: communityStats,
      all: sumStats(atlasStats, communityStats),
      ...unknown,
      willClearAll: mode === 'replace'
        && atlasStats.current + communityStats.current > 0
        && atlasStats.total + communityStats.total === 0,
    },
  };
}

function restoreRawValue(storage, key, raw) {
  if (raw === null) {
    if (typeof storage.removeItem !== 'function') fail('STORAGE_UNAVAILABLE', '收藏存储不支持删除');
    storage.removeItem(key);
  } else {
    storage.setItem(key, raw);
  }
}

export function commitFavoritesRestore(storage, plan) {
  assertStorage(storage);
  if (!isRecord(plan) || !isRecord(plan.next)) fail('INVALID_INPUT', '恢复预案无效');
  if (!Array.isArray(plan.next.atlas) || !Array.isArray(plan.next.community)) {
    fail('INVALID_INPUT', '恢复预案缺少 next.atlas 或 next.community');
  }

  const atlasKeys = plan.next.atlas.map((item, index) => atlasStorageKey(validateAtlasItem(item, index)));
  const communityIds = plan.next.community.map(validateCommunityId);
  assertTotalItemLimit(atlasKeys, communityIds);
  const atlasJson = JSON.stringify(atlasKeys);
  const communityJson = JSON.stringify(communityIds);

  let previousAtlas;
  let previousCommunity;
  try {
    previousAtlas = storage.getItem(ATLAS_FAVORITES_STORAGE_KEY);
    previousCommunity = storage.getItem(COMMUNITY_FAVORITES_STORAGE_KEY);
  } catch (cause) {
    throw new FavoritesBackupError('STORAGE_READ_FAILED', '保存前读取本地收藏失败', { cause });
  }

  try {
    storage.setItem(ATLAS_FAVORITES_STORAGE_KEY, atlasJson);
    storage.setItem(COMMUNITY_FAVORITES_STORAGE_KEY, communityJson);
  } catch (cause) {
    const rollbackErrors = [];
    for (const [key, raw] of [
      [ATLAS_FAVORITES_STORAGE_KEY, previousAtlas],
      [COMMUNITY_FAVORITES_STORAGE_KEY, previousCommunity],
    ]) {
      try {
        restoreRawValue(storage, key, raw);
      } catch (rollbackCause) {
        rollbackErrors.push({ key, cause: rollbackCause });
      }
    }
    const code = rollbackErrors.length ? 'STORAGE_ROLLBACK_FAILED' : 'STORAGE_WRITE_FAILED';
    const message = rollbackErrors.length
      ? '写入收藏失败，且无法完整恢复原数据'
      : '写入收藏失败，已恢复原数据';
    throw new FavoritesBackupError(code, message, { cause, rollbackErrors });
  }

  return { atlasKeys, communityIds };
}
