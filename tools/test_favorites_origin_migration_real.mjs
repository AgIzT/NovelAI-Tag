import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

import { loadFavoritesTestModules } from './favorites-library-test-loader.mjs';

/* 新网址找回的真实数据全量审计（只在本机有 site/data 时运行）。
   2026-07 的 pages.dev 救援页曾因并册 / 跨册迁移的特殊归属，只有一部分目录的收藏没过来，
   而且很久没被发现。这里拿全部法典的每一条词条、站点认得的每一种历史键写法，
   按旧网址上可能存着的几种形态喂给真实的找回流程，再逐条比：
   旧网址收藏墙显示什么，新网址找回后就必须显示什么——同一批词条、同样的「源词条已不存在」、
   同样的备注和收藏夹归属。 */

const dataDir = new URL('../site/data/', import.meta.url);
const hasData = await stat(dataDir).then(value => value.isDirectory()).catch(() => false);
if (!hasData) {
  console.log('favorites origin migration (real data): skipped, no local site/data');
  process.exit(0);
}

const { core, library, store, backupStore, migration } = await loadFavoritesTestModules();
const codexes = JSON.parse(await readFile(new URL('codexes.json', dataDir), 'utf8'));
const lookup = core.createCodexLookup(codexes);
const books = [];
for (const meta of codexes) {
  const book = JSON.parse(await readFile(new URL(`${meta.id}.json`, dataDir), 'utf8'));
  books.push({ id: meta.id, ids: book.entries.map(entry => entry.id) });
}
const existing = new Map(books.map(book => [book.id, new Set(book.ids)]));
const existsKey = key => {
  const separator = key.indexOf(':');
  return Boolean(existing.get(key.slice(0, separator))?.has(key.slice(separator + 1)));
};

class MemoryStorage {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const LIBRARY_KEY = library.FAVORITES_LIBRARY_STORAGE_KEY;
const ATLAS_KEY = core.ATLAS_FAVORITES_STORAGE_KEY;
const COMMUNITY_KEY = core.COMMUNITY_FAVORITES_STORAGE_KEY;
const NOW = '2026-10-01T00:00:00.000Z';

// 收藏墙（fav-codex.js）的判定：键按当前书目归一，归一后的书里真有这条才显示，其余记作源词条已不存在。
const canonical = key => {
  const item = core.canonicalizeAtlasStorageKey(key, lookup);
  return `${item.codexId}:${item.entryId}`;
};
const wall = keys => {
  const shown = new Set();
  const missing = new Set();
  for (const key of keys) {
    const target = canonical(key);
    (existsKey(target) ? shown : missing).add(target);
  }
  return { shown, missing };
};

// 每条真实词条：站点认得的全部写法（当前键、别名、跨册迁移旧归属、套图 entryAliases、并册前的旧前缀）。
const universe = [];
let formCount = 0;
for (const book of books) {
  for (const entryId of book.ids) {
    const expected = { codexId: book.id, entryId };
    const forms = new Set(core.atlasFavoriteStorageKeys(expected, lookup));
    // 2026-08-31 画师串词典并入个人词典前，这两类词条挂在 artist_nai45_strings 下（与 test_favorites_backup.mjs 同一口径）。
    if (book.id === 'artist_nai45_personal' && /^(artist_nai45_strings_\d+|mengshen_pack-\d{4})$/.test(entryId)) {
      forms.add(`artist_nai45_strings:${entryId}`);
    }
    const key = `${book.id}:${entryId}`;
    for (const form of forms) assert.equal(canonical(form), key, `兼容写法不闭合：${form}`);
    formCount += forms.size;
    universe.push({ key, forms: [...forms] });
  }
}
const historicalForms = universe.reduce((sum, item) => sum + item.forms.length - 1, 0);
// 并册、跨册迁移和套图合并都必须真的出现在审计里，否则下面的比较等于没测。
for (const prefix of ['artist_300:', 'artist_45_collection:', 'artist_nai45_strings:', 'mengshen_pack:', 'community_ai_misc:',
  'codex_6e699406:', 'codex_8489ac52:', 'codex_70c0e66f:', 'codex_3f60585d:', 'nai5_community_pack:nai5_community_pack_mengshen_korean_0889']) {
  assert.ok(universe.some(item => item.forms.some(form => form.startsWith(prefix) && form !== item.key)), `历史写法缺失：${prefix}`);
}
// 旧网址上也可能留着已经下架或从未存在的键；找回后必须原样留着，不能悄悄变多或变少。
const orphanForms = [
  'suozhang:suozhang-99999999',
  'removed_codex:removed_codex-0001',
  'mengshen_pack:mengshen_pack-1945',
  'nai5_community_pack:nai5_community_pack_gone_0001',
];

function chunk(list, size) {
  const result = [];
  for (let index = 0; index < list.length; index += size) result.push(list.slice(index, index + size));
  return result;
}

function newSide(entries = {}) {
  const storage = new MemoryStorage(entries);
  const libraryStore = store.createLibraryStore({ getStorage: () => storage, getLocks: () => null, getCodexes: () => codexes, eventTarget: null });
  return { storage, libraryStore, adapter: backupStore.createFavoritesBackupStore(libraryStore) };
}

// 旧网址那一侧：在原始字节的副本上跑真实收藏库，得到旧站此刻显示的收藏（state.favs 的来源）。
// 救援页本身不跑收藏库，只读原始字节，所以交给找回流程的是没被动过的原件。
async function oldSnapshotOf(entries) {
  const side = newSide(entries);
  await side.libraryStore.ensureLibrary({ silent: true, codexes });
  return side.libraryStore.librarySnapshot();
}

function describeLibrary(doc) {
  const folderNames = new Map(doc.folders.map(folder => [folder.id, folder.name]));
  const items = new Map();
  for (const item of doc.items) {
    items.set(item.key, { note: item.note, folders: new Set() });
  }
  for (const member of doc.memberships) items.get(member.itemKey)?.folders.add(folderNames.get(member.folderId));
  return items;
}

let migratedRuns = 0;
let migratedItems = 0;
async function migrate(oldEntries, { newEntries = {}, label }) {
  const oldSnapshot = await oldSnapshotOf(oldEntries);
  const raws = {
    libraryRaw: oldEntries[LIBRARY_KEY] ?? null,
    communityRaw: oldEntries[COMMUNITY_KEY] ?? null,
    legacyAtlasRaw: oldEntries[ATLAS_KEY] ?? null,
  };

  const target = newSide(newEntries);
  const before = target.libraryStore.librarySnapshot();
  const beforeItems = describeLibrary(before);
  const result = await migration.createLibraryMigrationRestore({
    message: { type: 'payload', version: 2, nonce: 'audit', ...raws },
    nonce: 'audit',
    storage: target.storage,
    codexes,
    restoreFavorites: target.adapter.restore,
  });
  assert.deepEqual(result.warnings, [], `${label}: 不应有警告`);

  const stored = JSON.parse(target.storage.getItem(LIBRARY_KEY));
  const storedKeys = stored.items.map(item => item.key);
  assert.equal(new Set(storedKeys).size, storedKeys.length, `${label}: 新网址出现重复收藏`);
  for (const key of storedKeys) assert.equal(canonical(key), key, `${label}: 新网址存了非规范键 ${key}`);

  // 收藏墙逐条一致：旧网址显示的 ∪ 新网址原有的 = 新网址找回后显示的；不存在的词条同样保留。
  const oldWall = wall(oldSnapshot.items.map(item => item.key));
  const beforeWall = wall(before.items.map(item => item.key));
  const afterWall = wall(storedKeys);
  const expectShown = new Set([...oldWall.shown, ...beforeWall.shown]);
  const expectMissing = new Set([...oldWall.missing, ...beforeWall.missing]);
  assert.deepEqual([...afterWall.shown].sort(), [...expectShown].sort(), `${label}: 收藏墙显示的词条不一致`);
  assert.deepEqual([...afterWall.missing].sort(), [...expectMissing].sort(), `${label}: 「源词条已不存在」不一致`);

  // 备注和收藏夹归属逐条带过来；新网址原有的备注与归属不丢。
  const oldItems = describeLibrary(oldSnapshot);
  const afterItems = describeLibrary(stored);
  for (const [key, item] of [...oldItems, ...beforeItems]) {
    const after = afterItems.get(canonical(key));
    assert.ok(after, `${label}: 收藏丢失 ${key}`);
    // 同一词条的几条备注在收藏库里以分隔线拼成一条；逐段比，每一段都得在。
    const afterParts = after.note.split('\n\n---\n\n');
    for (const part of item.note ? item.note.split('\n\n---\n\n') : []) {
      assert.ok(afterParts.includes(part), `${label}: 备注丢失 ${key}：${part}`);
    }
    for (const folder of item.folders) assert.ok(after.folders.has(folder), `${label}: 收藏夹归属丢失 ${key} → ${folder}`);
  }

  // 共创收藏取并集。
  const community = new Set(JSON.parse(target.storage.getItem(COMMUNITY_KEY) || '[]'));
  for (const id of JSON.parse(raws.communityRaw || '[]')) assert.ok(community.has(id), `${label}: 共创收藏丢失 ${id}`);

  // 再找回一次不新增任何东西。
  const again = await migration.createLibraryMigrationRestore({
    message: { type: 'payload', version: 2, nonce: 'again', ...raws },
    nonce: 'again',
    storage: target.storage,
    codexes,
    restoreFavorites: target.adapter.restore,
  });
  assert.equal(again.plan.stats.all.added, 0, `${label}: 重复找回新增了收藏`);
  assert.equal(JSON.parse(target.storage.getItem(LIBRARY_KEY)).items.length, stored.items.length, `${label}: 重复找回改变了条数`);
  migratedRuns += 1;
  migratedItems += oldSnapshot.items.length;
  return { stored, oldSnapshot };
}

function v2Document(items, folders = []) {
  return JSON.stringify({
    format: 'novelai-tag-favorites-library', version: 2, libraryId: 'old-audit', updatedAt: NOW,
    presetsSeeded: 1,
    folders: folders.map((name, index) => ({ id: `fd_audit_${index}`, name, coverItemId: '', order: index, createdAt: NOW })),
    items: items.map(item => ({ key: item.key, addedAt: NOW, note: item.note || '' })),
    memberships: items.filter(item => item.folder !== undefined)
      .map(item => ({ itemKey: item.key, folderId: `fd_audit_${item.folder}`, addedAt: NOW })),
  });
}

const CHUNK = 3000;
const maxForms = Math.max(...universe.map(item => item.forms.length));

// 1. 旧网址存着未归一的历史键（并册前写入、之后没再写过的 V2 文档）：每条词条轮流用每一种写法，带备注和收藏夹。
for (let round = 0; round < maxForms; round++) {
  const picked = universe.filter(item => round === 0 || item.forms.length > round);
  for (const [index, part] of chunk(picked, CHUNK).entries()) {
    const items = part.map((item, position) => ({
      key: item.forms[round % item.forms.length],
      note: position % 3 === 0 ? `备注 ${item.key}` : '',
      folder: position % 4,
    }));
    if (round === 0 && index === 0) items.push(...orphanForms.map(key => ({ key, note: '已下架的收藏' })));
    await migrate({
      [LIBRARY_KEY]: v2Document(items, ['角色', '画风', '旧网址自建', '素材参考']),
      [COMMUNITY_KEY]: JSON.stringify([`community-${round}-${index}`]),
    }, { label: `V2 历史写法 第 ${round + 1} 轮 第 ${index + 1} 组` });
  }
}

// 2. 同一词条的多种写法同时出现在旧文档里：找回后只剩一条，备注各自保留。
for (const [index, part] of chunk(universe.filter(item => item.forms.length > 1), 1500).entries()) {
  const items = part.flatMap(item => item.forms.map(key => ({ key, note: `写法 ${key}`, folder: 0 })));
  await migrate({ [LIBRARY_KEY]: v2Document(items, ['同一词条多写法']) }, { label: `多写法同时存在 第 ${index + 1} 组` });
}

// 3. 只在旧网址用过 V1（从没打开过 V2 收藏库）：只有 fadian-favs 原始键。
for (const round of [0, maxForms - 1]) {
  for (const [index, part] of chunk(universe, CHUNK).entries()) {
    const keys = part.map(item => item.forms[round % item.forms.length]);
    if (index === 0) keys.push(...orphanForms);
    await migrate({ [ATLAS_KEY]: JSON.stringify(keys) }, { label: `只有 V1 第 ${round + 1} 种写法 第 ${index + 1} 组` });
  }
}

// 4. 新网址已经有一部分（换了写法、带自己的备注和同名收藏夹）：取并集，不重复、不覆盖。
{
  const part = universe.filter((item, index) => index % 17 === 0 && item.forms.length > 1).slice(0, CHUNK);
  const already = part.filter((item, index) => index % 2 === 0);
  const newDoc = v2Document(already.map(item => ({ key: item.forms[item.forms.length - 1], note: `新网址备注 ${item.key}`, folder: 0 })), ['角色']);
  await migrate({
    [LIBRARY_KEY]: v2Document(part.map(item => ({ key: item.forms[1], note: `旧网址备注 ${item.key}`, folder: 0 })), ['角色']),
  }, { newEntries: { [LIBRARY_KEY]: newDoc }, label: '新网址已有部分收藏' });
}

// 5. V2 文档损坏：退回 V1 镜像，收藏墙仍与旧网址镜像一致（收藏夹和备注无法带过来，会有提示）。
{
  const part = universe.slice(0, CHUNK);
  const keys = part.map(item => item.forms[item.forms.length - 1]);
  const target = newSide();
  const result = await migration.createLibraryMigrationRestore({
    message: { type: 'payload', version: 2, nonce: 'broken', libraryRaw: '{broken', communityRaw: null, legacyAtlasRaw: JSON.stringify(keys) },
    nonce: 'broken', storage: target.storage, codexes, restoreFavorites: target.adapter.restore,
  });
  assert.match(result.warnings.join(), /收藏夹和备注无法读取/);
  const storedKeys = JSON.parse(target.storage.getItem(LIBRARY_KEY)).items.map(item => item.key);
  assert.deepEqual([...wall(storedKeys).shown].sort(), [...wall(keys).shown].sort(), 'V2 损坏退回镜像：收藏墙不一致');
}

// 6. 最重的用户：旧网址收藏库能写下的上限（约 2 MB）。找回不能因为换成备份格式变大而失败或丢条目。
{
  const all = universe.map(item => item.key);
  let count = 29000;
  let heavy;
  for (;;) {
    const keys = all.slice(0, count);
    const old = newSide({ [ATLAS_KEY]: JSON.stringify(keys) });
    const ready = await old.libraryStore.ensureLibrary({ silent: true, codexes });
    if (ready.ok) { heavy = old; break; }
    count -= 1000;
    assert.ok(count > 0, '旧网址连一条收藏都存不下');
  }
  // 再往同一个库里加备注，直到旧网址自己的写入预算用满。
  let notes = 0;
  for (const step of [400, 100, 25]) {
    for (;;) {
      const snapshot = heavy.libraryStore.librarySnapshot();
      const slice = snapshot.items.slice(notes, notes + step).map(item => item.key);
      if (slice.length < step) break;
      const committed = await heavy.libraryStore.commitLibrary(draft => {
        for (const item of draft.items) if (slice.includes(item.key)) item.note = '这是一条比较长的备注，用来把收藏库撑到旧网址允许的上限。'.repeat(2);
      }, { silent: true, codexes });
      if (!committed.ok) break;
      notes += step;
    }
  }
  const raw = heavy.storage.getItem(LIBRARY_KEY);
  const bytes = new TextEncoder().encode(raw).byteLength;
  assert.ok(bytes > 1.9 * 1024 * 1024, `上限样本不够重：${bytes} 字节`);
  const result = await migrate(Object.fromEntries(heavy.storage.values), { label: `上限 ${count} 条、${(bytes / 1024 / 1024).toFixed(2)} MB` });
  assert.equal(result.stored.items.length, result.oldSnapshot.items.length);
  console.log(`  heaviest old library: ${count} items, ${notes} notes, ${(bytes / 1024 / 1024).toFixed(2)} MB → migrated intact`);
}

console.log(`favorites origin migration (real data): ${universe.length} entries, ${formCount} key forms (${historicalForms} historical), ${migratedRuns} migrations, ${migratedItems} old items compared; all passed`);
