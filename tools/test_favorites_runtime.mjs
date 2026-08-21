import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
globalThis.__favoritesRuntimeTest = { state, lookupSources, lookupArguments, emittedChanges };

const coreImport = /import \{\s*ATLAS_FAVORITES_STORAGE_KEY,\s*atlasFavoriteStorageKeys,\s*createCodexLookup,\s*\} from '\.\/favorites-backup-core\.js';/;
const favoritesSource = (await readFile(favoritesUrl, 'utf8'))
  .replace("import { state } from './state.js';", 'const state = globalThis.__favoritesRuntimeTest.state;')
  .replace("import { toast } from './feedback.js';", 'const toast = () => {};')
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

  favorites.toggleFav(entry, lightboxButton, { deferViewRefresh: true });
  assert.deepEqual(emittedChanges.pop(), { scopes: ['atlas'], reason: 'toggle' });
  assert.equal(favorites.isFav(entry), false);
  assert.equal(refreshes, 0);
  assert.equal(lightboxButton.getAttribute('aria-pressed'), 'false');
  assert.equal(cardButton.getAttribute('aria-pressed'), 'false');
  assert.equal(cardButton.textContent, '☆');
  assert.equal(favorites.flushDeferredFavoritesViewRefresh(), true);
  assert.equal(refreshes, 1);
  assert.equal(favorites.flushDeferredFavoritesViewRefresh(), false, '重复关闭不应重复刷新');

  favorites.toggleFav(entry, lightboxButton, { deferViewRefresh: true });
  assert.equal(favorites.isFav(entry), true, '刷新前仍应能把当前词条重新收藏');
  assert.equal(lightboxButton.getAttribute('aria-pressed'), 'true');
  assert.equal(cardButton.textContent, '★');
  favorites.flushDeferredFavoritesViewRefresh();
  assert.equal(refreshes, 2);
}

// 保留对 localStorage 受限/写入失败的既有容错。
const previousStorage = globalThis.localStorage;
const previousWarn = console.warn;
let warned = false;
globalThis.localStorage = { setItem() { throw new Error('storage denied'); } };
console.warn = () => { warned = true; };
try {
  assert.doesNotThrow(() => favorites.saveFavs());
  assert.equal(warned, true);
} finally {
  console.warn = previousWarn;
  if (previousStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previousStorage;
  delete globalThis.__favoritesRuntimeTest;
}

console.log('favorites runtime: all tests passed');
