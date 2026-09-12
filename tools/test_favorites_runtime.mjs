import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadFavoritesTestModules } from './favorites-library-test-loader.mjs';

const favoritesUrl = new URL('../site/assets/app/favorites.js', import.meta.url);
const state = {
  codex: { id: 'alpha' },
  codexes: [{ id: 'alpha', aliases: ['old_alpha'] }],
  favs: new Set(['alpha:alpha-1']),
  favoritesView: false,
};
const lookupSources = [];
const lookupArguments = [];
const emittedChanges = [];
const messages = [];
const bytes = new Map([['fadian-favs', JSON.stringify([...state.favs])]]);
let rejectWrite = false;
const storage = {
  getItem: key => bytes.get(key) ?? null,
  setItem(key, value) {
    if (rejectWrite && key === 'fadian-favs-v2') throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    bytes.set(key, String(value));
  },
  removeItem: key => bytes.delete(key),
};
const { library, store: stores } = await loadFavoritesTestModules();
const store = stores.createLibraryStore({ getStorage: () => storage, getCodexes: () => state.codexes,
  getLocks: () => ({ request: async (_name, _options, fn) => fn({}) }), notify: (...args) => messages.push(args) });
await store.ensureLibrary();
globalThis.__favoritesRuntimeTest = { state, lookupSources, lookupArguments, emittedChanges, messages, library, store };

const coreImport = /import \{\s*atlasFavoriteStorageKeys,\s*createCodexLookup,\s*\} from '\.\/favorites-backup-core\.js';/;
const favoritesSource = (await readFile(favoritesUrl, 'utf8'))
  .replace("import { state } from './state.js';", 'const state = globalThis.__favoritesRuntimeTest.state;')
  .replace("import { toast } from './feedback.js';", 'const toast = (...args) => globalThis.__favoritesRuntimeTest.messages.push(args);')
  .replace("import { addLibraryItem, libraryKeys, removeLibraryItems } from './favorites-library-core.js';",
    'const { addLibraryItem, libraryKeys, removeLibraryItems } = globalThis.__favoritesRuntimeTest.library;')
  .replace("import { commitLibrary, librarySnapshot } from './favorites-library-store.js';",
    'const { commitLibrary, librarySnapshot } = globalThis.__favoritesRuntimeTest.store;')
  .replace(
    "import { emitFavoritesChanged } from './favorites-backup.js';",
    'const emitFavoritesChanged = (scopes, reason) => globalThis.__favoritesRuntimeTest.emittedChanges.push({ scopes, reason });',
  )
  .replace(
    "import { findCodexMeta } from './data.js';",
    'const findCodexMeta = id => state.codexes.find(codex => codex.id === id || (codex.aliases || []).includes(id));',
  )
  .replace(coreImport, `
const ATLAS_FAVORITES_STORAGE_KEY = 'fadian-favs';
const createCodexLookup = codexes => {
  const lookup = { source: codexes };
  globalThis.__favoritesRuntimeTest.lookupSources.push(codexes);
  return lookup;
};
const atlasFavoriteStorageKeys = (favorite, lookup) => {
  globalThis.__favoritesRuntimeTest.lookupArguments.push(lookup);
  return [favorite.codexId + ':' + favorite.entryId];
};`);
assert.doesNotMatch(favoritesSource, /^import /m, '测试替身未覆盖 favorites.js 的全部依赖');

const favorites = await import(
  `data:text/javascript;base64,${Buffer.from(favoritesSource).toString('base64')}`
);
const entry = { id: 'alpha-1' };

assert.deepEqual(favorites.favKeys(entry), ['alpha:alpha-1']);
assert.equal(favorites.isFav(entry), true);
assert.deepEqual(favorites.favKeys(entry), ['alpha:alpha-1']);
assert.equal(lookupSources.length, 1, '同一 state.codexes 引用应只建一次索引');
assert.ok(lookupArguments.every(lookup => lookup.source === state.codexes));

const reloadedCodexes = [{ id: 'alpha', aliases: ['old_alpha'] }];
state.codexes = reloadedCodexes;
assert.deepEqual(favorites.favKeys(entry), ['alpha:alpha-1']);
assert.equal(lookupSources.length, 2, '编辑器 reload 换入新数组后应重建索引');
assert.equal(lookupSources[1], reloadedCodexes);
assert.equal(lookupArguments.at(-1).source, reloadedCodexes);

// 收藏墙灯箱延迟刷新：取消后当前词条仍可立即重新收藏；星标同步到底层卡片，
// 真正的合成列表重建只在灯箱关闭时显式 flush。
{
  const makeButton = () => {
    const classes = new Set();
    const attrs = new Map();
    return {
      textContent: '',
      title: '',
      classList: {
        toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); },
      },
      setAttribute(name, value) { attrs.set(name, String(value)); },
      getAttribute(name) { return attrs.get(name); },
    };
  };
  const lightboxButton = makeButton();
  const cardButton = makeButton();
  state.list = [entry];
  state.nodes = new Map([[0, { querySelector: selector => selector === '.fav-btn' ? cardButton : null }]]);
  state.favoritesView = true;
  let refreshes = 0;
  favorites.setFavoritesActions({ refreshFavoritesView: () => { refreshes += 1; } });
  globalThis.localStorage = { setItem() {} };

  await favorites.toggleFav(entry, lightboxButton, { deferViewRefresh: true });
  assert.deepEqual(emittedChanges.pop(), { scopes: ['atlas'], reason: 'toggle' });
  assert.equal(favorites.isFav(entry), false);
  assert.equal(refreshes, 0);
  assert.equal(lightboxButton.getAttribute('aria-pressed'), 'false');
  assert.equal(cardButton.getAttribute('aria-pressed'), 'false');
  assert.equal(cardButton.textContent, '☆');
  assert.equal(favorites.flushDeferredFavoritesViewRefresh(), true);
  assert.equal(refreshes, 1);
  assert.equal(favorites.flushDeferredFavoritesViewRefresh(), false, '重复关闭不应重复刷新');

  await favorites.toggleFav(entry, lightboxButton, { deferViewRefresh: true });
  assert.equal(favorites.isFav(entry), true, '刷新前仍应能把当前词条重新收藏');
  assert.equal(lightboxButton.getAttribute('aria-pressed'), 'true');
  assert.equal(cardButton.textContent, '★');
  favorites.flushDeferredFavoritesViewRefresh();
  assert.equal(refreshes, 2);
}

// 落盘失败时不换内存、不发成功事件、不改星标、不弹成功提示。
rejectWrite = true;
const before = [...state.favs];
const eventCount = emittedChanges.length;
messages.length = 0;
let buttonTouched = false;
const outcome = await favorites.toggleFav({ id: 'alpha-2', title: '第二条' }, {
  set textContent(_) { buttonTouched = true; },
});
assert.equal(outcome.ok, false);
assert.equal(outcome.reason, 'quota');
assert.deepEqual([...state.favs], before);
assert.equal(emittedChanges.length, eventCount);
assert.equal(buttonTouched, false);
assert.equal(messages.some(([message]) => message.startsWith('已收藏')), false);
assert.equal(messages.at(-1)[0], '收藏没能保存：浏览器存储已满');
assert.equal((await favorites.saveFavs()).ok, false);
delete globalThis.__favoritesRuntimeTest;

console.log('favorites runtime: all tests passed');
