import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadFavoritesTestModules } from './favorites-library-test-loader.mjs';
const modules = await loadFavoritesTestModules();
const { core, library, store, backupStore } = modules;
const codexes = [{ id: 'alpha' }];
const source = await readFile(new URL('../site/assets/app/favorites-backup.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const documents = [];
const originalWarn = console.warn;
const warnings = [];
console.warn = (...args) => warnings.push(args);
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.dataset = {}; this.children = []; this.handlers = new Map(); this.attrs = new Map();
    this.textContent = ''; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; this.files = [];
    this.classList = { contains: () => false };
  }
  addEventListener(type, fn) { const list = this.handlers.get(type) || []; list.push(fn); this.handlers.set(type, list); }
  removeEventListener(type, fn) { this.handlers.set(type, (this.handlers.get(type) || []).filter(item => item !== fn)); }
  async fire(type) { for (const fn of this.handlers.get(type) || []) await fn({ currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  getAttribute(key) { return this.attrs.get(key); }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); }
  replaceChildren(...nodes) { this.children = nodes; }
  focus() { document.activeElement = this; }
  remove() {}
  click() { if (this.tagName === 'a') document.downloads.push({ href: this.href, name: this.download }); }
}
function dom() {
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const trigger = new Element('button');
  const modes = [Object.assign(new Element('input'), { value: 'merge', checked: true }), Object.assign(new Element('input'), { value: 'replace' })];
  const panel = nodes.get('favoritesBackupPanel');
  const dialog = new Element(); dialog.children = [new Element(), nodes.get('favoritesReplaceConfirm')];
  panel.querySelectorAll = () => modes;
  panel.querySelector = () => dialog;
  for (const id of ['favoritesBackupPanel', 'favoritesImportPreview', 'favoritesReplaceConfirm']) nodes.get(id).hidden = true;
  const documentApi = {
    nodes, trigger, modes, downloads: [], body: new Element('body'), activeElement: trigger,
    getElementById: id => nodes.get(id), querySelectorAll: () => [trigger], createElement: tag => new Element(tag),
  };
  documents.push(documentApi);
  return documentApi;
}
let sequence = 0;
async function setup(initialLibrary, localEdition = false) {
  const values = new Map([['community-favorites-v1', '["community-before"]']]);
  if (initialLibrary !== undefined) values.set(library.FAVORITES_LIBRARY_STORAGE_KEY, typeof initialLibrary === 'string' ? initialLibrary : JSON.stringify(initialLibrary));
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  globalThis.localStorage = storage;
  globalThis.document = dom();
  globalThis.window = Object.assign(new Element(), { setTimeout, location: { origin: 'https://test.example' }, dispatchEvent() {} });
  const currentDoc = document;
  const blobs = new Map();
  URL.createObjectURL = blob => { const id = 'blob:' + blobs.size; blobs.set(id, blob); return id; };
  URL.revokeObjectURL = () => {};
  globalThis.CustomEvent = class { constructor(type, { detail }) { this.type = type; this.detail = detail; } };
  const libraryStore = store.createLibraryStore({ getStorage: () => storage, getLocks: () => null, eventTarget: null, getCodexes: () => codexes });
  const adapter = backupStore.createFavoritesBackupStore(libraryStore);
  globalThis.__backupUiModules = {
    './favorites-backup-core.js': core,
    './favorites-library-core.js': library,
    './favorites-backup-store.js': { ...backupStore, readLibraryFavorites: options => adapter.readCurrent({ ...options, storage }), restoreLibraryFavorites: options => adapter.restore({ ...options, storage }) },
    './modal.js': { openMask: panel => { panel.hidden = false; }, closeMask: panel => { panel.hidden = true; }, trapFocus() {}, bindBackdropDismiss() {} },
    './browser-history.js': { closeHistoryLayer: () => false, forgetHistoryLayer() {}, openHistoryLayer() {}, registerHistoryLayer() {} },
    './favorites-origin-migration.js': { setupFavoritesOriginMigration() {} },
    '../data-source.js': { fetchDataJson: async () => codexes },
    './favorites-transfer.js': { decodeFavoritesTransfer: async text => text, encodeFavoritesTransfer: async text => text },
    './clipboard.js': { writeClipboardText: async () => ({ ok: true }) },
    './clipboard-fallback.js': { showClipboardFallback: () => false },
  };
  const rewritten = source.replace(/import\s*\{([\s\S]*?)\}\s*from\s*'([^']+)';/g, (_, imports, path) => 'const {' + imports + '} = globalThis.__backupUiModules[' + JSON.stringify(path) + '];');
  assert.doesNotMatch(rewritten, /^import /m);
  const ui = await import('data:text/javascript;base64,' + Buffer.from(rewritten + '\n//' + sequence++).toString('base64'));
  ui.setupFavoritesBackup({ getCodexes: async () => codexes, localEdition });
  await tick();
  await currentDoc.trigger.fire('click');
  const waitIdle = async () => { for (let n = 0; n < 100 && currentDoc.nodes.get('favoritesBackupPanel').getAttribute('aria-busy') === 'true'; n++) await tick(); };
  return { storage, doc: currentDoc, libraryStore, blobs, waitIdle, async importText(text) { currentDoc.nodes.get('favoritesImportText').value = text; await currentDoc.nodes.get('favoritesImportTextBtn').fire('click'); } };
}
const make = keys => library.migrateV1Favorites(keys, { codexes });
const serialize = value => backupStore.serializeLibraryFavorites({ library: value, codexes, communityIds: ['community-before'] });

// 空夹也可导出；真正的点击处理器生成 V2 文件。
{
  const empty = make([]); library.createFolder(empty, '空夹');
  const ctx = await setup(empty);
  assert.equal(ctx.doc.nodes.get('favoritesExportBtn').disabled, false);
  await ctx.doc.nodes.get('favoritesExportBtn').fire('click');
  const exported = JSON.parse(await ctx.blobs.get(ctx.doc.downloads[0].href).text());
  assert.equal(exported.version, 2);
  assert.equal(exported.folders[0].name, '空夹');
}

// 条目没新增，单纯归类变化也能从真实面板确认恢复。
{
  const current = make(['alpha:a']);
  const incoming = structuredClone(current); const folder = library.createFolder(incoming, '画风');
  library.setFolderMembership(incoming, ['alpha:a'], folder.id, true);
  const ctx = await setup(current);
  await ctx.importText(serialize(incoming));
  assert.equal(ctx.doc.nodes.get('favoritesRestoreBtn').disabled, false);
  await ctx.doc.nodes.get('favoritesRestoreBtn').fire('click'); await ctx.waitIdle();
  assert.equal(ctx.libraryStore.librarySnapshot().memberships.length, 1);
  await ctx.importText(serialize(incoming));
  assert.equal(ctx.doc.nodes.get('favoritesRestoreBtn').disabled, true, '重复恢复应显示一致');
}

// 损坏库可下载原字节，原始数据未导出前不能覆盖；正常确认后恢复 V2。
{
  const broken = '{not-json';
  const ctx = await setup(broken);
  assert.equal(ctx.doc.nodes.get('favoritesCurrentAtlas').textContent, '无法读取');
  assert.equal(ctx.doc.nodes.get('favoritesExportBtn').textContent, '导出当前原始数据');
  await ctx.importText(serialize(make(['alpha:recovered'])));
  assert.equal(ctx.doc.modes[0].disabled, true);
  assert.equal(ctx.doc.nodes.get('favoritesRestoreBtn').disabled, true);
  await ctx.doc.nodes.get('favoritesExportBtn').fire('click');
  const exported = JSON.parse(await ctx.blobs.get(ctx.doc.downloads[0].href).text());
  assert.equal(exported.libraryRaw, broken);
  assert.equal(exported.communityRaw, '["community-before"]');
  assert.throws(() => library.parseLibraryBackup(JSON.stringify(exported)), error => error.code === 'INVALID_FORMAT');
  assert.equal(ctx.doc.nodes.get('favoritesRestoreBtn').disabled, false);
  await ctx.doc.nodes.get('favoritesRestoreBtn').fire('click');
  assert.equal(ctx.doc.nodes.get('favoritesReplaceConfirm').hidden, false);
  assert.equal(ctx.storage.getItem(library.FAVORITES_LIBRARY_STORAGE_KEY), broken);
  await ctx.doc.nodes.get('favoritesReplaceConfirmBtn').fire('click'); await ctx.waitIdle();
  assert.deepEqual(library.libraryKeys(ctx.libraryStore.librarySnapshot()), ['alpha:recovered']);
}
// 合并超收藏夹上限时，覆盖计划仍能独立检查和使用。
{
  const current = make(['alpha:a']);
  for (let n = 0; n < 100; n++) library.createFolder(current, '夹' + n);
  const incoming = make(['alpha:a']); library.createFolder(incoming, '另一个夹');
  const ctx = await setup(current);
  await ctx.importText(serialize(incoming));
  assert.equal(ctx.doc.nodes.get('favoritesRestoreBtn').disabled, true);
  assert.match(ctx.doc.nodes.get('favoritesBackupError').textContent, /100/);
  ctx.doc.modes[0].checked = false; ctx.doc.modes[1].checked = true;
  await ctx.doc.modes[1].fire('change');
  assert.equal(ctx.doc.nodes.get('favoritesRestoreBtn').disabled, false);
}

// 确认窗口打开后另一页修复数据，旧救援确认不得覆盖这份新数据。
{
  const ctx = await setup('{broken');
  await ctx.importText(serialize(make(['alpha:backup'])));
  await ctx.doc.nodes.get('favoritesExportBtn').fire('click');
  await ctx.doc.nodes.get('favoritesRestoreBtn').fire('click');
  const repaired = JSON.stringify({ ...make(['alpha:newer']), migratedFrom: 'v1', presetsSeeded: 1 });
  ctx.storage.setItem(library.FAVORITES_LIBRARY_STORAGE_KEY, repaired);
  // 真正的 storage 事件会触发重新读取，并把页面从损坏态改为正常态。
  for (const handler of window.handlers.get('storage') || []) handler({ storageArea: ctx.storage, key: library.FAVORITES_LIBRARY_STORAGE_KEY });
  await tick();
  await ctx.doc.nodes.get('favoritesReplaceConfirmBtn').fire('click'); await ctx.waitIdle();
  assert.equal(ctx.storage.getItem(library.FAVORITES_LIBRARY_STORAGE_KEY), repaired);
  assert.match(ctx.doc.nodes.get('favoritesBackupError').textContent, /已改变/);
}
// 本地版的普通备份与原始数据导出都不带共创收藏，恢复也保留同源共创原值。
{
  const ctx = await setup(make(['alpha:a']), true);
  await ctx.doc.nodes.get('favoritesExportBtn').fire('click');
  const exported = JSON.parse(await ctx.blobs.get(ctx.doc.downloads[0].href).text());
  assert.deepEqual(exported.favorites.community, []);
  const broken = await setup('{local-broken', true);
  await broken.doc.nodes.get('favoritesExportBtn').fire('click');
  const recovery = JSON.parse(await broken.blobs.get(broken.doc.downloads[0].href).text());
  assert.equal(recovery.communityRaw, null);
}
console.warn = originalWarn;
console.log('favorites backup UI: all tests passed');
