import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cancelSiteSearchObservation } from '../site/assets/app/site-analytics.js';

// 加载实际模块，以轻量 DOM/网络替身控制「已发起、尚未完成」的异步边界。
const read = path => readFile(new URL(`../site/assets/${path}`, import.meta.url), 'utf8');
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function loadModule(path, dependencies, extra = '') {
  const names = new Set();
  const source = (await read(path)).replace(/^import\s*\{([\s\S]*?)\}\s*from\s*'[^']+';/gm, (_match, list) => {
    list.split(',').map(name => name.trim()).filter(Boolean).forEach(name => names.add(name));
    return '';
  });
  assert.doesNotMatch(source, /^import /m, `未覆盖 ${path} 的依赖形式`);
  globalThis.__atlasAccessRuntime = dependencies;
  return import(moduleUrl(`const {${[...names].join(',')}} = globalThis.__atlasAccessRuntime;\n${source}\n${extra}`));
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
class ElementStub {
  constructor() {
    this.hidden = false;
    this.disabled = false;
    this.textContent = '旧内容';
    this.value = '';
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.handlers = new Map();
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name),
      toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
    };
    this.style = { setProperty() {} };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  set title(value) { this.setAttribute('title', value); }
  get title() { return this.attributes.get('title') || ''; }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'src') this.src = '';
    if (name.startsWith('data-')) delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())];
  }
  replaceChildren(...children) { this.children = children; this.textContent = ''; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener(name, fn) { this.handlers.set(name, fn); }
  reset() { this.value = ''; }
  focus() {}
}
const elements = new Map();
const $ = selector => {
  if (!elements.has(selector)) elements.set(selector, new ElementStub());
  return elements.get(selector);
};
const pres = [new ElementStub(), new ElementStub()];
const imageRequests = [];
class ImageStub extends ElementStub {
  set src(url) { this.url = url; if (url) imageRequests.push(url); }
  get src() { return this.url; }
}
globalThis.HTMLElement = ElementStub;
globalThis.Image = ImageStub;
globalThis.document = {
  activeElement: null,
  documentElement: new ElementStub(),
  body: new ElementStub(),
  querySelectorAll: selector => selector === '#lightboxInfo pre' ? pres : [],
};
globalThis.window = { scrollY: 0, innerWidth: 1280, innerHeight: 800, setTimeout, clearTimeout, scrollTo() {} };
globalThis.location = { href: 'http://localhost/', pathname: '/', search: '', hash: '' };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test', language: 'zh' }, configurable: true });
const safeBook = { id: 'safe', nsfw: false, entries: [] };
const adultBook = { id: 'adult', nsfw: true, entries: [] };
const state = { codex: safeBook, codexes: [safeBook, adultBook], allowNsfw: true, allowR18g: true,
  activePath: [], query: '', searchFilterValues: [], lightbox: { entry: null, images: [], index: 0 } };
const isCodexLocked = codex => Boolean(codex?.nsfw && !state.allowNsfw);
const isEntryAccessBlocked = entry => Boolean(
  (entry?.rating === 'r18' && !state.allowNsfw)
  || (entry?.rating === 'r18g' && (!state.allowNsfw || !state.allowR18g))
  || (entry?._srcCodexId === 'adult' && !state.allowNsfw));
const findCodexMeta = id => state.codexes.find(book => book.id === id);

// 灯箱撤权须清掉所有内容和入口；仅关闭 R18G 时仍可查看 R18。
const lightbox = await loadModule('app/lightbox.js', {
  state, $, findCodexMeta, isEntryAccessBlocked,
  entrySourceCodexId: entry => entry?._srcCodexId || state.codex?.id,
  isContentBlocked: () => false, isTouchPrimaryInput: () => true,
  entryImages: entry => entry.images || [], hasEntryImage: entry => Boolean(entry.images?.length),
  imageItemUrl: (_kind, _entry, item) => item.path,
  resetArtistStrip: () => $('#artistPeekImg').removeAttribute('src'),
  clearTagZhDetails() {}, syncUrlState() {}, flushDeferredFavoritesViewRefresh() {},
}, 'export const lightboxTest = { setOriginalPreload: image => { lbOriginalPreload = image; } };');
const restricted = { id: 'restricted', title: 'R18 词条', path: [], rating: 'r18', images: [{ path: '/restricted.jpg' }] };
const safe = { id: 'safe-entry', title: '安全词条', path: [], images: [{ path: '/safe.jpg' }] };
state.list = [safe, restricted];
state.lightbox = { entry: safe, images: safe.images, index: 0 };
state.allowNsfw = false;
lightbox.preloadLightboxNeighbors({ entries: [safe, restricted], index: 0 });
assert.deepEqual(imageRequests, [], '撤权后不得预取相邻受限词条');
state.allowNsfw = true;
lightbox.preloadImage('/pending-original.jpg');
const mainImage = $('#lightboxImg');
mainImage.src = '/restricted.jpg';
$('#lightboxThumbs').children = [new ImageStub(), new ImageStub()];
$('#artistStrip').children = [new ImageStub()];
$('#artistPeekImg').src = '/restricted-artist.jpg';
$('#copyPositive').onclick = () => '旧提示词';
$('#lightboxCredit').setAttribute('href', 'https://example.test/private');
state.lightbox = { entry: restricted, images: restricted.images, index: 0 };
state.allowNsfw = false;
assert.equal(lightbox.refreshLightboxAccess(undefined, { scrub: true }), false);
assert.equal($('#lightbox').hidden, true);
assert.equal(state.lightbox.entry, null);
assert.equal(mainImage.src, '');
assert.equal($('#lightboxTitle').textContent, '');
assert.ok(pres.every(pre => pre.textContent === ''), '隐藏 DOM 不留提示词');
assert.equal($('#lightboxThumbs').children.length, 0);
assert.equal($('#artistStrip').children.length, 0);
assert.equal($('#artistPeekImg').src, '');
assert.equal($('#copyPositive').onclick, null);
assert.equal($('#lightboxCredit').attributes.has('href'), false);
const count = imageRequests.length;
lightbox.preloadImage('/pending-original.jpg');
assert.equal(imageRequests.length, count + 1, '撤权清空缓存，后续合法重试仍能预取');
state.allowNsfw = true;
state.allowR18g = false;
state.lightbox = { entry: restricted, images: restricted.images, index: 0 };
assert.equal(lightbox.refreshLightboxAccess(undefined, { scrub: true }), true);
assert.equal(state.lightbox.entry, restricted, '仅收回重口权限不能清掉仍获准的 R18 灯箱');
// 仍获准的灯箱：清场不能掐断它正在下载的原图，否则状态停在「加载中」。
const keptOriginal = new ImageStub();
keptOriginal.src = '/restricted-original.jpg';
keptOriginal.onload = () => {};
lightbox.lightboxTest.setOriginalPreload(keptOriginal);
assert.equal(lightbox.refreshLightboxAccess(undefined, { scrub: true }), true);
assert.equal(keptOriginal.src, '/restricted-original.jpg');
assert.equal(typeof keptOriginal.onload, 'function');
state.allowNsfw = false;
assert.equal(lightbox.refreshLightboxAccess(undefined, { scrub: true }), false);
assert.equal(keptOriginal.src, '', '失权词条的原图下载要撤');
assert.equal(keptOriginal.onload, null);
state.allowNsfw = true;

// 保留的安全/R18 灯箱也要更新邻条名称和计数，不能残留已失权词条的 title/aria 标签。
const heavy = { id: 'heavy', title: 'R18G 邻条', path: [], rating: 'r18g', images: [{ path: '/heavy.jpg' }] };
for (const [entry, neighbor, revoke] of [
  [safe, restricted, () => { state.allowNsfw = false; }],
  [restricted, heavy, () => { state.allowR18g = false; }],
]) {
  state.allowNsfw = true;
  state.allowR18g = true;
  state.list = [entry, neighbor];
  state.lightbox = { entry, images: entry.images, index: 0 };
  $('#lightbox').hidden = false;
  lightbox.refreshLightboxNavigation();
  assert.equal($('#lightboxNext').title, `下一条：${neighbor.title}`);
  assert.match($('#lightboxMeta').textContent, /第 1 \/ 2 条/);
  const original = new ImageStub();
  original.src = '/kept-safe-original.jpg';
  original.onload = () => {};
  lightbox.lightboxTest.setOriginalPreload(original);
  const beforeRequests = imageRequests.length;
  revoke();
  assert.equal(lightbox.refreshLightboxAccess(undefined, { scrub: true }), true);
  state.list = [entry];  // refreshAccessView 同步过滤后的列表。
  lightbox.refreshLightboxNavigation();
  for (const id of ['lightboxPrev', 'lightboxNext']) {
    const button = $(`#${id}`);
    assert.equal(button.hidden, true);
    assert.equal(button.title, '');
    assert.equal(button.attributes.has('aria-label'), false);
    assert.equal(button.dataset.navLabel, undefined);
  }
  assert.match($('#lightboxMeta').textContent, /第 1 \/ 1 条/);
  assert.equal(state.lightbox.entry, entry);
  assert.equal(original.src, '/kept-safe-original.jpg');
  assert.equal(typeof original.onload, 'function');
  assert.equal(imageRequests.length, beforeRequests, '刷新导航不得重新请求当前图片或原图');
  state.allowNsfw = true;
  state.allowR18g = true;
  state.list = [entry, neighbor];
  lightbox.refreshLightboxNavigation();
  assert.equal($('#lightboxNext').hidden, false);
  assert.equal($('#lightboxNext').title, `下一条：${neighbor.title}`);
  lightbox.closeLightbox({ historyMode: 'none', immediate: true });
}

// R18G 本来就关着时再写一次关（别的标签页开 NSFW 后补读）不算撤权，不清场。
const uiSource = await read('app/ui.js');
assert.match(uiSource, /const wasAllowed = state\.allowR18g;/);
assert.match(uiSource, /refreshContentAccess\(\{ revoked: wasAllowed && !state\.allowR18g \}\)/);

// 换书请求在撤权前启动、之后返回，无论减少动效或接力过渡都不能落地。
const appSource = await read('app.js');
const loadStart = appSource.indexOf('export async function loadCodex(');
const loadEnd = appSource.indexOf('function snapshotCodexIdentity(', loadStart);
assert.ok(loadStart >= 0 && loadEnd > loadStart);
const loadSource = appSource.slice(loadStart, loadEnd).replace(/^export /gm, '');
for (const animated of [false, true]) {
  const response = deferred();
  const events = [];
  state.codex = safeBook;
  state.allowNsfw = true;
  state.favoritesView = false;
  state.siteSearchView = false;
  const dependencies = {
    state, window, isCodexLocked, findCodexMeta,
    cancelSiteSearchObservation,
    FAVORITES_CODEX_ID: 'favorites', SITE_SEARCH_CODEX_ID: 'search',
    firstUnlockedCodex: () => safeBook, showNsfwLockedHint() {},
    invalidateOrganizeRequest() {}, canAnimateSwitch: () => animated,
    fetchCodex: () => response.promise, showSkeleton: seq => events.push(['skeleton', seq]),
    hideSkeleton() {}, replaceSkeleton: (_seq, render) => { events.push(['replace-skeleton']); render(); },
    cancelCodexSwitch: () => events.push(['cancel-switch']), setLoading() {}, clearMasonry() {},
    renderCodexView: codex => { state.codex = codex; events.push(['render', codex.id]); },
    codexViewArgs: () => ({}), runCodexViewTransition: (_seq, render) => render(),
    beginCodexSwitch: () => ({ land: render => render(), abort: () => events.push(['abort']) }),
    snapshotCodexIdentity() {}, closeLightbox() {},
    renderTree: () => events.push(['tree']), renderCodexHeader: () => events.push(['header']),
    applyFilter: () => events.push(['filter']),
    openFavoritesView: () => { events.push(['favorites']); return new Promise(() => {}); },
    openSiteSearchView: () => { events.push(['search']); return new Promise(() => {}); },
  };
  const runtime = new Function(...Object.keys(dependencies),
    `let codexLoadSeq=0,pendingCodexLoad=null;\n${loadSource}\nreturn {loadCodex,refreshAccessView};`)(...Object.values(dependencies));
  const loading = runtime.loadCodex('adult');
  state.allowNsfw = false;
  runtime.refreshAccessView({ revoked: true });
  assert.ok(events.some(([name]) => name === 'replace-skeleton'));
  assert.ok(events.some(([name]) => name === 'filter'), '撤权当帧恢复安全列表');
  response.resolve(adultBook);
  await loading;
  assert.equal(state.codex, safeBook);
  assert.equal(events.some(([name]) => name === 'render'), false, `animated=${animated} 不得落地过期成人书`);
  state.siteSearchView = true;
  events.length = 0;
  runtime.refreshAccessView({ revoked: true });
  assert.ok(events.findIndex(([name]) => name === 'filter') < events.findIndex(([name]) => name === 'search'));
  state.siteSearchView = false;
  state.favoritesView = true;
  events.length = 0;
  runtime.refreshAccessView({ revoked: true });
  assert.ok(events.findIndex(([name]) => name === 'filter') < events.findIndex(([name]) => name === 'favorites'));
  assert.equal(events.some(([name]) => name === 'header'), false, '保留收藏专用头');
}

// 反馈撤权要清上下文；在途失败不能复活回退文本或继续降级复制。
const clipboard = await import(moduleUrl(await read('app/clipboard.js')));
const messages = [];
const ownedFeedback = [];
let feedbackResponse = null;
globalThis.fetch = url => url === '/api/feedback' ? feedbackResponse.promise
  : Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
const report = await loadModule('app/report.js', {
  state, $, isCodexLocked, isEntryAccessBlocked, findCodexMeta,
  clamp: (n, min, max) => Math.min(max, Math.max(min, n)), esc: String,
  toast: text => messages.push(text), cancelUiMotion() {},
  openMask: mask => { mask.hidden = false; mask.classList.add('show'); }, closeMask() {},
  entryImages: entry => entry.images || [], imageItemUrl: (_kind, _entry, item) => item.path,
  hasEntryImage: entry => Boolean(entry.images?.length), entryImageCanUseOriginal: () => false,
  readOwnedRecords: () => [], ownedRecordIds: () => new Set(),
  rememberOwnedRecord: (_key, record) => ownedFeedback.push(record),
  writeClipboardText: clipboard.writeClipboardText,
  showClipboardFallback: () => { throw new Error('失权后不得打开复制回退'); }, forgetHistoryLayer() {},
}, 'export const accessTest = { submitFeedback, copyFallbackText };');
state.favoritesView = false;
state.codex = safeBook;
state.allowNsfw = true;
report.openReportDialog({ source: 'lightbox', entry: restricted });
$('#feedbackDesc').value = '这是一条足够长度的测试反馈';
feedbackResponse = deferred();
const submission = report.accessTest.submitFeedback({ preventDefault() {} });
assert.equal($('#feedbackSubmit').disabled, true);
state.allowNsfw = false;
assert.equal(report.refreshReportAccess(), false);
assert.equal($('#feedbackPanel').hidden, true);
assert.equal($('#feedbackPanel').inert, true);
assert.equal($('#feedbackContextPreview').textContent, '');
assert.equal($('#feedbackFallbackText').value, '');
assert.equal($('#feedbackSubmit').disabled, false, '旧提交失效后按钮不能永久禁用');
feedbackResponse.resolve({ ok: false, status: 503, json: async () => ({ error: 'late failure' }) });
await submission;
assert.equal($('#feedbackFallbackText').value, '');
assert.equal($('#feedbackStatus').textContent, '');
report.openReportDialog({ source: 'global' });
assert.equal($('#feedbackPanel').hidden, false);
assert.equal($('#feedbackSubmit').disabled, false);
state.allowNsfw = true;
report.openReportDialog({ source: 'lightbox', entry: restricted });
$('#feedbackFallbackText').value = '仅获准时才能复制的上下文';
const clipboardResponse = deferred();
navigator.clipboard = { writeText: () => clipboardResponse.promise };
let execCopies = 0;
document.execCommand = () => { execCopies += 1; return true; };
document.createElement = () => new ElementStub();
const copying = report.accessTest.copyFallbackText();
state.allowNsfw = false;
report.refreshReportAccess();
clipboardResponse.reject(new Error('late clipboard failure'));
await copying;
assert.equal(execCopies, 0, 'Clipboard API 等待期间撤权，不得执行 execCommand 降级');
// 服务端已收下的反馈：提交途中关掉重开面板，仍要记到本设备，但旧结果不回写新面板。
state.allowNsfw = true;
report.openReportDialog({ source: 'global' });
$('#feedbackDesc').value = '这是一条足够长度的测试反馈';
feedbackResponse = deferred();
const accepted = report.accessTest.submitFeedback({ preventDefault() {} });
report.openReportDialog({ source: 'global' });
feedbackResponse.resolve({ ok: true, status: 200, json: async () => ({ ok: true, id: 'fb-late' }) });
await accepted;
assert.deepEqual(ownedFeedback.map(record => record.id), ['fb-late']);
assert.equal(messages.length, 0, '失效的提交和复制不得显示成功');

delete globalThis.__atlasAccessRuntime;
console.log('atlas access runtime: all tests passed');
