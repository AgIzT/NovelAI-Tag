import assert from 'node:assert/strict';

// 使用真实收藏墙、星标、路由及分享响应；浏览器替身只提供这些入口需要的 DOM/存储。
const values = new Map();
globalThis.localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
};
globalThis.window = { addEventListener() {}, dispatchEvent() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = {
  baseURI: 'http://localhost/', querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, documentElement: { classList: { contains: () => false } },
};
globalThis.location = new URL('http://localhost/');
const core = await import('../site/assets/app/favorites-backup-core.js');
const { state } = await import('../site/assets/app/state.js');
const { openEntryDeepLink, setRouterActions } = await import('../site/assets/app/router.js');
const { isFav, toggleFav } = await import('../site/assets/app/favorites.js');
const { buildFavoritesCodex } = await import('../site/assets/app/fav-codex.js');
const { renderShareResponse } = await import('../functions/_share.js');

const codexId = 'nai5_community_pack';
const prefix = 'nai5_community_pack_mengshen_korean_';
const ids = Array.from({ length: 6 }, (_, i) => prefix + String(888 + i).padStart(4, '0'));
const entryAliases = Object.fromEntries(ids.slice(1).map(id => [id, ids[0]]));
const meta = { id: codexId, title: 'N5', type: 'pack', entryAliases };
const codexes = [meta, { id: 'other' }];
const favorite = { codexId, entryId: ids[0] };
const keys = ids.map(id => `${codexId}:${id}`);
for (const id of ids) {
  assert.deepEqual(core.canonicalizeAtlasFavorite({ codexId, entryId: id }, codexes), favorite);
}
assert.deepEqual(core.atlasFavoriteStorageKeys(favorite, codexes), keys);
for (const key of core.atlasFavoriteStorageKeys(favorite, codexes)) {
  assert.deepEqual(core.canonicalizeAtlasStorageKey(key, codexes), favorite, key);
}
for (const id of [prefix + '0887', prefix + '0894']) {
  assert.deepEqual(core.canonicalizeAtlasFavorite({ codexId, entryId: id }, codexes), { codexId, entryId: id });
}
assert.deepEqual(core.canonicalizeAtlasFavorite({ codexId: 'other', entryId: ids[1] }, codexes), {
  codexId: 'other', entryId: ids[1],
});
for (const aliases of [null, [], { old: '' }, { old: 7 }, { old: ' target' }, { old: 'old' },
  { old: 'next', next: 'final' }, { old: 'next', next: 'old' }]) {
  assert.equal(core.resolveAtlasEntryId('old', aliases), 'old');
}
assert.equal(core.resolveAtlasEntryId('toString', {}), 'toString');
const backup = core.createFavoritesBackup({ atlasKeys: keys, communityIds: [], codexes });
assert.deepEqual(backup.favorites.atlas, [favorite]);
const legacyBackup = { ...backup, favorites: { atlas: ids.map(entryId => ({ codexId, entryId })), community: [] } };
assert.deepEqual(core.parseFavoritesBackup(JSON.stringify(legacyBackup), codexes).favorites.atlas, [favorite]);

const entry = {
  id: ids[0], title: 'DC 001', rating: 'r18', path: ['author', 'NSFW'],
  image: 'cover.webp', images: ids.map((id, i) => ({ path: `image-${i}.webp`, original: `${id}.png` })),
};
state.codex = { ...meta, entries: [entry] };
state.codexes = codexes;
state.codexCache = new Map([[codexId, Promise.resolve(state.codex)]]);
state.favs = new Set(keys);
state.list = [];
state.placements = [];
state.nodes = new Map();
state.lightbox = { entry: null, images: [], index: 0 };
state.activePath = [];
state.query = '';
state.suppressUrlSync = true;
state.favoritesView = false;
state.siteSearchView = false;
state.allowNsfw = true;
state.allowR18g = false;
let wall = await buildFavoritesCodex();
assert.equal(wall.entries.length, 1, '六个历史收藏只呈现一张套图卡');
assert.equal(wall.entries[0].images.length, 6);
assert.equal(wall.dataNotice, '');
assert.equal(isFav(entry), true);
toggleFav(entry);
assert.deepEqual([...state.favs], [], '取消收藏清除规范键与全部历史键');
for (const key of keys.slice(1)) {
  state.favs = new Set([key]);
  assert.equal(isFav(entry), true, key);
  wall = await buildFavoritesCodex();
  assert.equal(wall.entries.length, 1, key);
}

const opened = [];
setRouterActions({
  openLightbox: (target, imageIndex) => opened.push({ target, imageIndex }),
  renderTree() {}, applyFilter() {}, updateVirtualCards() {},
});
for (const id of ids) {
  assert.equal(openEntryDeepLink(id), ids[0], id);
  assert.equal(opened.at(-1).target, entry);
}
const previouslyOpened = opened.length;
state.allowNsfw = false;
for (const id of ids.slice(1)) assert.equal(openEntryDeepLink(id), false, '旧深链仍遵守 NSFW 门控');
assert.equal(opened.length, previouslyOpened);
state.allowNsfw = true;
assert.equal(openEntryDeepLink(prefix + '0894'), false, '不猜不存在的邻接 ID');
const realEntry = { ...entry, id: ids[1] };
state.codex.entries.push(realEntry);
assert.equal(openEntryDeepLink(ids[1]), ids[1], '存在真实 ID 时不让 alias 覆盖');
state.codex.entries.pop();
state.codex.entryAliases = { [ids[1]]: 'missing' };
assert.equal(openEntryDeepLink(ids[1]), false, '目标必须现存');
state.codex.entryAliases = entryAliases;

const release = 'r-0123456789abcdefabcd';
const canonicalCard = { id: ids[0], title: 'DC 001', shareable: false };
const shard = {
  id: codexId, title: 'private book', shareable: true,
  entries: Object.fromEntries(ids.map(id => [id, canonicalCard])),
};
const dataset = {
  'data/current.json': { release },
  [`data/releases/${release}/share-index.json`]: { codexes: { [codexId]: { id: codexId, shareable: true } }, aliases: {} },
  [`data/releases/${release}/share/${codexId}.json`]: shard,
};
for (const id of ids.slice(1)) {
  const response = await renderShareResponse({
    request: new Request(`https://novelai.quicktagcloud.com/share/${codexId}/${id}`),
    env: {
      ATLAS_DATA_HOSTS: 'novelai.quicktagcloud.com', ATLAS_DATA_PREFIX: 'data',
      ATLAS_DATA_BUCKET: { get: async key => Object.hasOwn(dataset, key) ? { json: async () => dataset[key] } : null },
      ASSETS: { fetch: async () => new Response('<html><head><title>App</title></head><body></body></html>') },
    },
  });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.includes(`<link rel="canonical" href="https://novelai.quicktagcloud.com/share/${codexId}/${ids[0]}">`));
  assert.ok(html.includes('<title>DC 001 | 法典图鉴</title>'));
  assert.doesNotMatch(html, /private book|cover\.webp|image-\d|author|property="og:image"/);
}
console.log('entry aliases: six legacy favorites merge, wall/unfavorite, five deep links and gated share canonicals passed');
