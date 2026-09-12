/* 收藏库纯逻辑。身份只委托 V1 core；这里不读取 DOM 或浏览器存储。 */
import {
  FAVORITES_BACKUP_FORMAT,
  FAVORITES_BACKUP_LIMITS,
  FavoritesBackupError,
  canonicalizeAtlasStorageKey,
  createCodexLookup,
  createFavoritesBackup,
  createFavoritesRestorePlan,
  parseFavoritesBackup,
} from './favorites-backup-core.js';

export const FAVORITES_LIBRARY_STORAGE_KEY = 'fadian-favs-v2';
export const LIBRARY_STORAGE_KEY = FAVORITES_LIBRARY_STORAGE_KEY;
export const FAVORITES_LIBRARY_FORMAT = 'novelai-tag-favorites-library';
export const FAVORITES_LIBRARY_VERSION = 2;
export const FAVORITES_LIBRARY_LIMITS = Object.freeze({
  maxFolders: 100,
  maxFolderName: 20,
  maxItems: FAVORITES_BACKUP_LIMITS.maxTotalItems,
  maxSnapshots: 800,
  maxBytes: 2 * 1024 * 1024,
});
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const iso = value => {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const text = (value, max) => typeof value === 'string'
  ? [...value.replace(CONTROL_RE, '')].slice(0, max).join('') : '';
const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;

export class FavoritesLibraryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FavoritesLibraryError';
    this.code = code;
    this.details = details;
  }
}
const fail = (code, message, details) => { throw new FavoritesLibraryError(code, message, details); };

export function newLibraryId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    if (globalThis.crypto?.getRandomValues) {
      return [...globalThis.crypto.getRandomValues(new Uint8Array(16))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* 受限浏览器仍可保留本地身份；库 ID 不是同步凭证。 */ }
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 0x100000000)
    .toString(16).padStart(8, '0')).join('');
}

export function canonicalLibraryKey(key, codexes = []) {
  const item = canonicalizeAtlasStorageKey(key, codexes);
  return item.codexId + ':' + item.entryId;
}

export function validateFolderName(value, folders = [], exceptId = '') {
  if (typeof value !== 'string' || !value.trim()) fail('FOLDER_NAME_EMPTY', '填写收藏夹名称');
  const name = value.trim();
  if (CONTROL_RE.test(name)) {
    CONTROL_RE.lastIndex = 0;
    fail('FOLDER_NAME_CONTROL', '收藏夹名称含有不可用字符，换个名称。');
  }
  CONTROL_RE.lastIndex = 0;
  if ([...name].length > FAVORITES_LIBRARY_LIMITS.maxFolderName) {
    fail('FOLDER_NAME_LONG', '收藏夹名称最多 20 个字');
  }
  if (folders.some(folder => folder.id !== exceptId && folder.name === name)) {
    fail('FOLDER_NAME_DUPLICATE', '已有同名收藏夹');
  }
  return name;
}

function normalizeSnapshot(value) {
  if (!isRecord(value)) return undefined;
  // 第一阶段只采集，禁止用 snap 渲染或鉴权；分级与下架始终回 access.js 当前来源判断。
  const result = {
    title: text(value.title, 512), tags: text(value.tags, 400),
    image: text(value.image, 2048),
    w: Number.isFinite(value.w) && value.w > 0 ? Math.min(value.w, 100000) : 0,
    h: Number.isFinite(value.h) && value.h > 0 ? Math.min(value.h, 100000) : 0,
    rating: text(value.rating, 32), srcTitle: text(value.srcTitle, 256),
    rev: typeof value.rev === 'number' && Number.isFinite(value.rev) ? value.rev : text(value.rev, 128),
  };
  return result;
}

export function normalizeLibrary(value, { codexes = [], now = new Date() } = {}) {
  const source = isRecord(value) ? value : {};
  const lookup = createCodexLookup(codexes);
  const result = {
    format: FAVORITES_LIBRARY_FORMAT, version: FAVORITES_LIBRARY_VERSION,
    libraryId: text(source.libraryId, 128) || newLibraryId(),
    updatedAt: iso(source.updatedAt) || iso(now),
    folders: [], items: [], memberships: [],
  };
  if (source.migratedFrom === 'v1') result.migratedFrom = 'v1';
  const itemMap = new Map();
  for (const raw of Array.isArray(source.items) ? source.items : []) {
    if (!isRecord(raw)) continue;
    let key;
    try { key = canonicalLibraryKey(raw.key, lookup); } catch (error) {
      if (error instanceof FavoritesBackupError) continue;
      throw error;
    }
    const item = { key, addedAt: iso(raw.addedAt), note: typeof raw.note === 'string' ? raw.note : '' };
    if (iso(raw.importedAt)) item.importedAt = iso(raw.importedAt);
    const snap = normalizeSnapshot(raw.snap);
    if (snap) item.snap = snap;
    if (!itemMap.has(key)) itemMap.set(key, item);
    else {
      const old = itemMap.get(key);
      if (!old.note && item.note) old.note = item.note;
      if (!old.snap && item.snap) old.snap = item.snap;
      if (!old.addedAt && item.addedAt) old.addedAt = item.addedAt;
      if (!old.importedAt && item.importedAt) old.importedAt = item.importedAt;
    }
  }
  result.items = [...itemMap.values()];
  if (result.items.length > FAVORITES_LIBRARY_LIMITS.maxItems) {
    fail('TOO_MANY_ITEMS', '收藏总数不能超过 30000 条');
  }
  const folderIdMap = new Map();
  const names = new Map();
  const usedIds = new Set();
  const sourceFolders = Array.isArray(source.folders) ? source.folders : [];
  const sortedFolders = sourceFolders.map((folder, index) => ({ folder, index }))
    .sort((a, b) => {
      const order = item => Number.isInteger(item.folder?.order) && item.folder.order >= 0
        ? item.folder.order : item.index;
      return order(a) - order(b) || a.index - b.index;
    });
  for (const { folder: raw, index } of sortedFolders) {
    if (!isRecord(raw)) continue;
    const name = text(raw.name, FAVORITES_LIBRARY_LIMITS.maxFolderName).trim();
    if (!name) continue;
    if (names.has(name)) {
      if (typeof raw.id === 'string' && !folderIdMap.has(raw.id)) folderIdMap.set(raw.id, names.get(name));
      continue;
    }
    let id = typeof raw.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(raw.id)
      && raw.id !== '_unsorted' ? raw.id : 'fd_restored_' + index;
    if (usedIds.has(id)) {
      let suffix = index;
      while (usedIds.has('fd_restored_' + suffix)) suffix++;
      id = 'fd_restored_' + suffix;
    }
    usedIds.add(id);
    if (typeof raw.id === 'string' && !folderIdMap.has(raw.id)) folderIdMap.set(raw.id, id);
    names.set(name, id);
    result.folders.push({
      id, name, coverItemId: '', order: result.folders.length,
      createdAt: iso(raw.createdAt) || result.updatedAt,
    });
  }
  if (result.folders.length > FAVORITES_LIBRARY_LIMITS.maxFolders) fail('TOO_MANY_FOLDERS', '收藏夹最多 100 个');
  const relations = new Set();
  for (const raw of Array.isArray(source.memberships) ? source.memberships : []) {
    if (!isRecord(raw)) continue;
    let itemKey;
    try { itemKey = canonicalLibraryKey(raw.itemKey, lookup); } catch { continue; }
    const folderId = folderIdMap.get(raw.folderId);
    const pair = JSON.stringify([itemKey, folderId]);
    if (!itemMap.has(itemKey) || !folderId || relations.has(pair)) continue;
    relations.add(pair);
    result.memberships.push({ itemKey, folderId, addedAt: iso(raw.addedAt) || result.updatedAt });
  }
  return result;
}

export function libraryKeys(library) {
  return (library?.items || []).map(item => item.key);
}

export function migrateV1Favorites(atlasKeys = [], { codexes = [], now = new Date(), libraryId } = {}) {
  if (isRecord(atlasKeys) && atlasKeys.version === 2) return normalizeLibrary(atlasKeys, { codexes, now });
  return normalizeLibrary({
    libraryId, updatedAt: iso(now),
    items: [...atlasKeys].map(key => ({ key, addedAt: null, importedAt: iso(now), note: '' })),
  }, { codexes, now });
}

export function createFolder(library, name, { id = 'fd_' + newLibraryId(), now = new Date() } = {}) {
  const validated = validateFolderName(name, library.folders);
  if (library.folders.length >= FAVORITES_LIBRARY_LIMITS.maxFolders) fail('TOO_MANY_FOLDERS', '收藏夹最多 100 个');
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || id === '_unsorted'
      || library.folders.some(folder => folder.id === id)) fail('FOLDER_ID', '收藏夹没能创建，重试一次。');
  const folder = { id, name: validated, coverItemId: '', order: library.folders.length, createdAt: iso(now) };
  library.folders.push(folder);
  return folder;
}

export function renameFolder(library, id, name) {
  const folder = library.folders.find(item => item.id === id);
  if (!folder) fail('FOLDER_MISSING', '这个收藏夹已删除，选择另一个收藏夹。');
  folder.name = validateFolderName(name, library.folders, id);
  return folder;
}

export function deleteFolder(library, id) {
  const folder = library.folders.find(item => item.id === id);
  if (!folder) fail('FOLDER_MISSING', '这个收藏夹已删除，选择另一个收藏夹。');
  const memberships = library.memberships.filter(item => item.folderId === id);
  library.folders = library.folders.filter(item => item.id !== id);
  library.folders.forEach((item, index) => { item.order = index; });
  library.memberships = library.memberships.filter(item => item.folderId !== id);
  return { folder, memberships };
}

export function addLibraryItem(library, key, { now = new Date(), snap, note = '', codexes = [] } = {}) {
  key = canonicalLibraryKey(key, codexes);
  const existing = library.items.find(item => item.key === key);
  if (existing) return existing;
  if (library.items.length >= FAVORITES_LIBRARY_LIMITS.maxItems) fail('TOO_MANY_ITEMS', '收藏总数不能超过 30000 条');
  const item = { key, addedAt: iso(now), note: typeof note === 'string' ? note : '' };
  const snapshot = normalizeSnapshot(snap);
  if (snapshot) item.snap = snapshot;
  library.items.push(item);
  return item;
}

export function removeLibraryItems(library, keys) {
  const selected = new Set(keys);
  const items = library.items.filter(item => selected.has(item.key));
  const memberships = library.memberships.filter(item => selected.has(item.itemKey));
  library.items = library.items.filter(item => !selected.has(item.key));
  library.memberships = library.memberships.filter(item => !selected.has(item.itemKey));
  return { items, memberships };
}

export function setFolderMembership(library, keys, folderId, on, { now = new Date() } = {}) {
  if (!library.folders.some(folder => folder.id === folderId)) fail('FOLDER_MISSING', '这个收藏夹已删除，选择另一个收藏夹。');
  const selected = new Set(keys);
  const available = new Set(libraryKeys(library));
  // 目标项在另一页被取消收藏时拒绝，避免勾选成功却实际未归类。
  if ([...selected].some(key => !available.has(key))) fail('ITEM_MISSING', '部分收藏已移除，重新选择后再整理。');
  let changed = 0;
  if (on) {
    const members = new Set(library.memberships.filter(item => item.folderId === folderId).map(item => item.itemKey));
    for (const itemKey of selected) {
      if (members.has(itemKey)) continue;
      library.memberships.push({ itemKey, folderId, addedAt: iso(now) });
      changed++;
    }
  } else {
    library.memberships = library.memberships.filter(item => {
      if (item.folderId !== folderId || !selected.has(item.itemKey)) return true;
      changed++;
      return false;
    });
  }
  return changed;
}

export function trimLibraryToBudget(library, maxBytes = FAVORITES_LIBRARY_LIMITS.maxBytes) {
  const candidates = library.items.filter(item => item.snap).sort((a, b) =>
    (Date.parse(a.addedAt) || 0) - (Date.parse(b.addedAt) || 0) || compareText(a.key, b.key));
  let trimmed = 0;
  while (candidates.length - trimmed > FAVORITES_LIBRARY_LIMITS.maxSnapshots) {
    delete candidates[trimmed++].snap;
  }
  let size = bytes(library);
  // 逐项字节差不受其它字段影响，避免 800 次整库 stringify。
  while (size > maxBytes && trimmed < candidates.length) {
    const item = candidates[trimmed++];
    const removedBytes = bytes(JSON.stringify(item.snap)) + bytes(',"snap":');
    delete item.snap;
    size -= removedBytes;
  }
  size = bytes(library);
  return { trimmed, bytes: size, overBudget: size > maxBytes };
}

export function createLibraryBackup({ library, communityIds = [], codexes = [], exportedAt = new Date() } = {}) {
  const normalized = normalizeLibrary(library, { codexes });
  const backup = createFavoritesBackup({ atlasKeys: libraryKeys(normalized), communityIds, codexes, exportedAt });
  const byKey = new Map(normalized.items.map(item => [item.key, item]));
  return {
    ...backup, version: 2, libraryId: normalized.libraryId, updatedAt: normalized.updatedAt,
    ...(normalized.migratedFrom ? { migratedFrom: normalized.migratedFrom } : {}),
    favorites: {
      atlas: backup.favorites.atlas.map(ref => {
        const { key, ...metadata } = byKey.get(ref.codexId + ':' + ref.entryId);
        return { ...ref, ...metadata };
      }),
      community: backup.favorites.community,
    },
    folders: normalized.folders,
    memberships: normalized.memberships,
  };
}

export function parseLibraryBackup(value, codexes = []) {
  if (typeof value !== 'string') throw new FavoritesBackupError('INVALID_JSON', '备份内容必须是 JSON 文本');
  if (bytes(value) > FAVORITES_BACKUP_LIMITS.maxFileBytes) throw new FavoritesBackupError('FILE_TOO_LARGE', '备份文件不能超过 2 MB');
  let raw;
  try { raw = JSON.parse(value.charCodeAt(0) === 0xfeff ? value.slice(1) : value); } catch {
    throw new FavoritesBackupError('INVALID_JSON', '无法解析收藏备份 JSON');
  }
  const isV2 = raw?.version === 2 && raw?.format === FAVORITES_BACKUP_FORMAT;
  const base = parseFavoritesBackup(isV2 ? JSON.stringify({ ...raw, version: 1 }) : value, codexes);
  if (!isV2) return {
    ...base, library: migrateV1Favorites(base.favorites.atlas.map(item => item.codexId + ':' + item.entryId), { codexes }),
  };
  if (!Array.isArray(raw.folders) || !Array.isArray(raw.memberships)) {
    throw new FavoritesBackupError('INVALID_LIBRARY', '备份缺少收藏夹或归属列表');
  }
  for (const folder of raw.folders) {
    if (!isRecord(folder) || typeof folder.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(folder.id)
        || folder.id === '_unsorted') throw new FavoritesBackupError('INVALID_FOLDER', '备份中的收藏夹标识无效');
    validateFolderName(folder.name);
  }
  const sourceItems = raw.favorites.atlas.map(item => ({
    ...item, key: item.codexId + ':' + item.entryId,
  }));
  const rawKeys = new Set(sourceItems.map(item => canonicalLibraryKey(item.key, codexes)));
  const rawFolderIds = new Set(raw.folders.map(folder => folder.id));
  if (rawFolderIds.size !== raw.folders.length) throw new FavoritesBackupError('INVALID_FOLDER', '备份中的收藏夹标识重复');
  for (const relation of raw.memberships) {
    if (!isRecord(relation) || !rawFolderIds.has(relation.folderId)
        || !rawKeys.has(canonicalLibraryKey(relation.itemKey, codexes))) {
      throw new FavoritesBackupError('INVALID_MEMBERSHIP', '备份中的收藏夹归属无效');
    }
  }
  const library = normalizeLibrary({
    ...raw, items: sourceItems,
  }, { codexes });
  return { ...base, version: 2, folders: library.folders, memberships: library.memberships, library };
}

export function createLibraryRestorePlan({
  backup, currentLibrary, currentCommunityIds = [], mode = 'merge', codexes = [],
} = {}) {
  const current = normalizeLibrary(currentLibrary, { codexes });
  const base = createFavoritesRestorePlan({
    backup, currentAtlasKeys: libraryKeys(current), currentCommunityIds, mode, codexes,
  });
  const incoming = backup.library
    ? normalizeLibrary(backup.library, { codexes })
    : migrateV1Favorites(base.incoming.atlas.map(item => item.codexId + ':' + item.entryId), { codexes });
  let nextLibrary;
  if (mode === 'replace') {
    nextLibrary = { ...incoming, libraryId: current.libraryId, updatedAt: current.updatedAt };
    // V1 没有时间与备注；重复恢复同一旧备份保留已导入条目的元数据。
    if (backup.version === 1) nextLibrary.items = incoming.items.map(item => {
      const existing = current.items.find(candidate => candidate.key === item.key);
      return existing ? { ...existing } : item;
    });
    if (current.migratedFrom) nextLibrary.migratedFrom = current.migratedFrom;
  } else {
    nextLibrary = normalizeLibrary(current, { codexes });
    const items = new Set(libraryKeys(nextLibrary));
    for (const item of incoming.items) {
      if (items.has(item.key)) {
        const existing = nextLibrary.items.find(candidate => candidate.key === item.key);
        if (!existing.note && item.note) existing.note = item.note;
        if (!existing.snap && item.snap) existing.snap = item.snap;
        continue;
      }
      nextLibrary.items.push(item);
      items.add(item.key);
    }
    const folderIds = new Map();
    for (const folder of incoming.folders) {
      const sameName = nextLibrary.folders.find(item => item.name === folder.name);
      if (sameName) { folderIds.set(folder.id, sameName.id); continue; }
      let id = folder.id;
      if (nextLibrary.folders.some(item => item.id === id)) id = 'fd_' + newLibraryId();
      const created = createFolder(nextLibrary, folder.name, { id, now: folder.createdAt });
      folderIds.set(folder.id, created.id);
    }
    for (const membership of incoming.memberships) {
      setFolderMembership(nextLibrary, [membership.itemKey], folderIds.get(membership.folderId), true,
        { now: membership.addedAt });
    }
    nextLibrary = normalizeLibrary(nextLibrary, { codexes });
  }
  const folderNames = new Set(current.folders.map(folder => folder.name));
  const nextNames = new Set(nextLibrary.folders.map(folder => folder.name));
  const incomingNames = new Set(incoming.folders.map(folder => folder.name));
  const folderStats = {
    current: current.folders.length, incoming: incoming.folders.length,
    added: [...incomingNames].filter(name => !folderNames.has(name)).length,
    duplicate: [...incomingNames].filter(name => folderNames.has(name)).length,
    removed: [...folderNames].filter(name => !nextNames.has(name)).length,
    total: nextLibrary.folders.length,
  };
  return {
    ...base, nextLibrary, stats: { ...base.stats, folders: folderStats },
    hasChanges: JSON.stringify(current) !== JSON.stringify(nextLibrary)
      || JSON.stringify(base.current.community) !== JSON.stringify(base.next.community),
  };
}
