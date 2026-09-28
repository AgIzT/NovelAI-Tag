import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadFavoritesTestModules } from './favorites-library-test-loader.mjs';
import { SqliteD1, readMigrations } from './sqlite-d1-test-harness.mjs';
import { onRequestPost as pickupCreatePost } from '../functions/api/favorites-pickup/index.js';
import { onRequestPost as pickupRedeemPost } from '../functions/api/favorites-pickup/redeem.js';
import * as pickupModule from '../site/assets/app/favorites-pickup.js';
import * as transferModule from '../site/assets/app/favorites-transfer.js';
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
    './favorites-transfer.js': transferModule,
    './favorites-pickup.js': pickupModule,
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

// 取件码走真实前端模块与真实 Functions 处理器，D1 用 node:sqlite 模拟。
const PICKUP_ORIGIN = 'https://test.example';
const pickupMigration = await readMigrations('0001_community_likes.sql', '0002_engagement_tombstones.sql', '0003_favorites_pickup.sql');
const pickupEnv = { FAVORITES_PICKUP_ENABLED: 'true', RATE_LIMIT_SALT: 'ui-salt', COMMUNITY_DB: new SqliteD1(pickupMigration) };
const pickupRequests = [];
globalThis.fetch = async (url, init = {}) => {
  pickupRequests.push(url);
  const request = new Request(PICKUP_ORIGIN + url, {
    method: init.method,
    headers: { ...init.headers, origin: PICKUP_ORIGIN, 'cf-connecting-ip': '192.0.2.10' },
    body: init.body,
  });
  const handler = url === '/api/favorites-pickup/redeem' ? pickupRedeemPost : pickupCreatePost;
  return handler({ env: pickupEnv, request });
};
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
// 取件码往返：A 设备生成，B 设备取件后走同一套预览与合并；同码不能再取。
{
  const sender = await setup(make(['alpha:a', 'alpha:b']));
  assert.equal(sender.doc.nodes.get('favoritesPickupCreateBtn').disabled, false);
  assert.equal(sender.doc.nodes.get('favoritesPickupResult').hidden, true);
  await sender.doc.nodes.get('favoritesPickupCreateBtn').fire('click'); await sender.waitIdle();
  const code = sender.doc.nodes.get('favoritesPickupCode').textContent;
  assert.match(code, /^[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/);
  assert.equal(sender.doc.nodes.get('favoritesPickupResult').hidden, false);
  assert.match(sender.doc.nodes.get('favoritesPickupExpiry').textContent, /前有效 · 取用一次即失效/);
  assert.match(sender.doc.nodes.get('favoritesBackupStatus').textContent, /取件码已生成/);
  const stored = pickupEnv.COMMUNITY_DB.rows('SELECT payload FROM favorites_pickups');
  assert.equal(stored.length, 1);
  assert.ok(stored[0].payload.startsWith('NAITAG1.'), '上传的是压缩后的迁移文本');

  const receiver = await setup(make(['alpha:c']));
  receiver.doc.nodes.get('favoritesPickupInput').value = code.toLowerCase().replace('-', ' ');
  await receiver.doc.nodes.get('favoritesPickupRedeemBtn').fire('click'); await receiver.waitIdle();
  assert.equal(receiver.doc.nodes.get('favoritesBackupError').textContent, '');
  assert.equal(receiver.doc.nodes.get('favoritesImportPreview').hidden, false);
  assert.equal(receiver.doc.nodes.get('favoritesPickupInput').value, '');
  assert.equal(receiver.doc.nodes.get('favoritesRestoreBtn').disabled, false);
  await receiver.doc.nodes.get('favoritesRestoreBtn').fire('click'); await receiver.waitIdle();
  assert.deepEqual(library.libraryKeys(receiver.libraryStore.librarySnapshot()).sort(), ['alpha:a', 'alpha:b', 'alpha:c']);
  assert.equal(pickupEnv.COMMUNITY_DB.rows('SELECT id FROM favorites_pickups').length, 0, '取件后服务端即删除');

  const late = await setup(make([]));
  late.doc.nodes.get('favoritesPickupInput').value = code;
  await late.doc.nodes.get('favoritesPickupRedeemBtn').fire('click'); await late.waitIdle();
  assert.match(late.doc.nodes.get('favoritesBackupError').textContent, /已被取用/);
  assert.equal(late.doc.nodes.get('favoritesImportPreview').hidden, true);
}

// 可否生成与「复制迁移文本」同一判定；码格式不对在本地拦下，不发请求；服务不可用给出兜底提示。
{
  const empty = await setup(make([]));
  assert.equal(empty.doc.nodes.get('favoritesPickupCreateBtn').dataset.empty, empty.doc.nodes.get('favoritesExportTextBtn').dataset.empty);
  const before = pickupRequests.length;
  empty.doc.nodes.get('favoritesPickupInput').value = 'abc';
  await empty.doc.nodes.get('favoritesPickupRedeemBtn').fire('click'); await empty.waitIdle();
  assert.match(empty.doc.nodes.get('favoritesBackupError').textContent, /8 位/);
  assert.equal(pickupRequests.length, before);

  pickupEnv.FAVORITES_PICKUP_ENABLED = 'false';
  try {
    const off = await setup(make(['alpha:a']));
    await off.doc.nodes.get('favoritesPickupCreateBtn').fire('click'); await off.waitIdle();
    assert.match(off.doc.nodes.get('favoritesBackupError').textContent, /暂不可用/);
    assert.equal(off.doc.nodes.get('favoritesPickupResult').hidden, true);
  } finally {
    pickupEnv.FAVORITES_PICKUP_ENABLED = 'true';
  }
}

// 本地版没有后端，取件码整块隐藏。
{
  const local = await setup(make(['alpha:a']), true);
  assert.equal(local.doc.nodes.get('favoritesPickupSection').hidden, true);
}

console.warn = originalWarn;
console.log('favorites backup UI: all tests passed');
