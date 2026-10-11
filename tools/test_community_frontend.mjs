// 共创广场与管理端前端中危修复回归：node tools/test_community_frontend.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const asDataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const stripImports = source => source.replace(/^import[\s\S]*?;\r?\n/gm, '');

// 加载状态：API 回退到空壳也算失败，不能伪装成正常的 0 条投稿。
{
  const elements = {
    '#communityTitle': { textContent: '' },
    '#communityCount': { textContent: '' },
  };
  const state = { loading: false, loadError: false, features: {}, entries: [] };
  let response;
  let syncCalls = 0;
  globalThis.__communityEntryTest = {
    state,
    loadCommunityData: async () => {
      if (response instanceof Error) throw response;
      return response;
    },
    $: selector => elements[selector] || null,
    applyCommunityFilters: () => {},
    syncAfterLoad: () => { syncCalls += 1; },
  };

  let source = stripImports(await readFile(new URL('../site/assets/community.js', import.meta.url), 'utf8'));
  source = `
const { state, loadCommunityData, $, applyCommunityFilters, syncAfterLoad } = globalThis.__communityEntryTest;
const configureCommunityHistory = () => {};
const initDetailDialog = () => {};
const initSubmitDialog = () => {};
const initCommunityUI = () => {};
const setupFavoritesBackup = () => {};
const setCommunityRouterActions = () => {};
const subscribeFavoritesChanges = () => {};
const reloadFavorites = () => {};
const renderMySubmissions = () => {};
const restoreCommunityHistorySnapshot = async () => {};
const initializeCommunityHistory = () => {};
const closeCommunityDetail = () => {};
const openCommunityDetail = () => {};
const openSubmitDialog = () => {};
const applyCommunityRoute = () => {};
const COMMUNITY_CATEGORIES = [];
const DEFAULT_COMMUNITY_CATEGORY = '';
${source.replace("init().catch(error => console.error('[community] initialization failed', error));", '')}
export { loadAndRender };
`;
  globalThis.window = {};
  const { loadAndRender } = await import(asDataModule(source));

  response = {
    collection: {},
    data: { title: '共创广场', features: { likes: false } },
    entries: [],
    source: 'api',
  };
  await loadAndRender();
  assert.equal(state.loadError, false, 'API 返回真实空集合仍应是正常空态');
  assert.equal(elements['#communityCount'].textContent, '0 条投稿');

  response = { ...response, source: 'fallback' };
  await loadAndRender();
  assert.equal(state.loadError, true, 'API 失败后回退到 0 条空壳必须标成加载失败');
  assert.equal(elements['#communityCount'].textContent, '加载失败');

  response = new Error('index unavailable');
  const previousError = console.error;
  console.error = () => {};
  try {
    await loadAndRender();
  } finally {
    console.error = previousError;
  }
  assert.equal(state.loadError, true, '数据入口抛错必须标成加载失败');
  assert.equal(elements['#communityCount'].textContent, '加载失败');
  assert.equal(syncCalls, 3, '成功、回退和异常三条路径都应完成最终渲染同步');
  delete globalThis.__communityEntryTest;
}

// 错误空态提供刷新；真实空集合仍保留投稿引导。
{
  const buttons = [];
  const actionBox = { appendChild: button => buttons.push(button) };
  const empty = {
    hidden: true,
    html: '',
    set innerHTML(value) { this.html = value; buttons.length = 0; },
    get innerHTML() { return this.html; },
    querySelector: selector => selector === '.empty-actions' ? actionBox : null,
  };
  const result = { textContent: '', innerHTML: '' };
  const state = {
    loading: false,
    loadError: false,
    entries: [],
    filtered: [],
    activeCategory: null,
    query: '',
    onlyFavorites: false,
    showNSFW: true,
  };
  let reloads = 0;
  let submits = 0;
  globalThis.window = { location: { reload: () => { reloads += 1; } } };
  globalThis.document = {
    createDocumentFragment: () => ({ appendChild: () => {} }),
    createElement: () => {
      const listeners = {};
      return {
        textContent: '',
        addEventListener: (type, listener) => { listeners[type] = listener; },
        click: () => listeners.click?.(),
      };
    },
  };
  globalThis.__communityRenderTest = { state, empty, result };
  let source = stripImports(await readFile(new URL('../site/assets/community/render.js', import.meta.url), 'utf8'));
  source = `
const { state, empty, result } = globalThis.__communityRenderTest;
const COMMUNITY_CATEGORIES = [];
const isFavorite = () => false;
const createLikeButton = () => null;
const $ = selector => selector === '#empty' ? empty : (selector === '#resultInfo' ? result : null);
const escHtml = value => String(value == null ? '' : value).replace(/[&<>\"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[character]));
const imageUrl = value => value;
const promptExcerpt = value => value;
${source}
`;
  const render = await import(asDataModule(source));

  render.renderEmptyState({ onSubmit: () => { submits += 1; } });
  assert.match(empty.innerHTML, /暂无投稿/);
  assert.equal(buttons[0]?.textContent, '投稿');
  buttons[0].click();
  assert.equal(submits, 1);

  state.loadError = true;
  render.renderResultBar();
  render.renderEmptyState({ onSubmit: () => { submits += 1; } });
  assert.equal(result.textContent, '共创广场加载失败');
  assert.match(empty.innerHTML, /投稿数据加载失败/);
  assert.equal(buttons[0]?.textContent, '刷新重试');
  assert.doesNotMatch(empty.innerHTML, />投稿</);
  buttons[0].click();
  assert.equal(reloads, 1);
  assert.equal(submits, 1, '错误空态不能继续引导投稿');
  delete globalThis.__communityRenderTest;
}

// addFiles 的所有入口共用 Promise 队列：第二批要等第一批完成，并且不能越过 6 张上限。
{
  const nativeURL = globalThis.URL;
  const submitSource = await readFile(new URL('../site/assets/community/submit.js', import.meta.url), 'utf8');
  const started = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const previews = {
    children: [],
    set innerHTML(_value) { this.children = []; },
    appendChild(node) { this.children.push(node); },
  };
  const errorBox = { textContent: '' };
  const promptSource = { className: '', textContent: '' };
  const elements = new Map([
    ['#subPreviews', previews],
    ['#subErr', errorBox],
    ['#subPromptSrc', promptSource],
    ['#subPrompt', { value: '' }],
    ['#subNegative', { value: '' }],
  ]);
  globalThis.__communitySubmitTest = {
    readImageParams: async file => {
      started.push(file.name);
      if (file.name === '1.png') await firstGate;
      return null;
    },
    $: selector => elements.get(selector) || null,
  };
  globalThis.URL = {
    createObjectURL: blob => `blob:${blob.name}`,
    revokeObjectURL: () => {},
  };
  globalThis.createImageBitmap = async file => ({ width: 20, height: 10, name: file.name, close: () => {} });
  globalThis.document = {
    activeElement: null,
    createElement(tag) {
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext() {
            return { fillStyle: '', fillRect: () => {}, drawImage: bitmap => { this.bitmap = bitmap; } };
          },
          toBlob(callback) { callback({ size: 1, name: this.bitmap?.name || '' }); },
        };
      }
      const listeners = {};
      const button = { addEventListener: (type, listener) => { listeners[type] = listener; } };
      return {
        className: '',
        innerHTML: '',
        querySelector: selector => selector === 'button' ? button : null,
      };
    },
  };
  let source = stripImports(submitSource);
  source = `
const closeMask = () => {};
const isMaskOpen = () => false;
const openMask = () => {};
const trapFocus = () => {};
const toast = () => {};
const DEFAULT_COMMUNITY_CATEGORY = '随手分享';
const LIMITS = { imageCount: 6, origBytes: 1e9, totalBytes: 1e9, imageBytes: 1e9, prompt: 1000, negative: 1000 };
const SUBMIT_CATEGORIES = ['随手分享'];
const SUBMIT_DISABLED = false;
const SUBMIT_DISABLED_MESSAGE = '';
const readImageParams = globalThis.__communitySubmitTest.readImageParams;
const $ = globalThis.__communitySubmitTest.$;
const $$ = () => [];
const escHtml = value => String(value == null ? '' : value);
${source}
`;
  const { addFiles } = await import(asDataModule(source));
  const makeFile = index => ({ name: `${index}.png`, type: 'image/png', size: 1 });
  const firstBatch = addFiles([1, 2, 3, 4, 5, 6].map(makeFile));
  const secondBatch = addFiles([makeFile(7)]);
  await Promise.resolve();
  assert.deepEqual(started, ['1.png'], '第二个入口不能在第一批处理中插队');
  releaseFirst();
  await Promise.all([firstBatch, secondBatch]);
  assert.deepEqual(started, ['1.png', '2.png', '3.png', '4.png', '5.png', '6.png']);
  assert.equal(previews.children.length, 6);
  assert.equal(errorBox.textContent, '图片最多 6 张');
  globalThis.URL = nativeURL;
  delete globalThis.__communitySubmitTest;
}

// 管理口令仅保留在当前浏览器会话；加载和退出都清掉旧版 localStorage 残留。
{
  const sessionDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const localDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const session = new Map();
  const local = new Map([['strings-admin-token', 'legacy-secret']]);
  const localMethods = [];
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: key => session.get(key) ?? null,
      setItem: (key, value) => session.set(key, String(value)),
      removeItem: key => session.delete(key),
    },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: key => { localMethods.push('getItem'); return local.get(key) ?? null; },
      setItem: (key, value) => { localMethods.push('setItem'); local.set(key, String(value)); },
      removeItem: key => { localMethods.push('removeItem'); local.delete(key); },
    },
  });
  try {
    const adminApi = await import(new URL('../site/assets/admin/api.js?legacy-token-cleanup', import.meta.url));
    assert.equal(local.has('strings-admin-token'), false, '模块初始化必须删除旧版永久口令');
    adminApi.setToken('session-secret');
    assert.equal(adminApi.token(), 'session-secret', '同一会话刷新后应能继续读取口令');

    local.set('strings-admin-token', 'legacy-secret-again');
    adminApi.clearToken();
    assert.equal(adminApi.token(), '');
    assert.equal(local.has('strings-admin-token'), false, '退出必须兜底删除再次出现的旧版永久口令');
    assert.deepEqual([...new Set(localMethods)], ['removeItem'], '管理口令流程只能删除、不得读写 localStorage');

    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: () => { throw new Error('session storage denied'); },
        setItem: () => { throw new Error('session storage denied'); },
        removeItem: () => { throw new Error('session storage denied'); },
      },
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => { throw new Error('local storage denied'); },
    });
    const deniedApi = await import(new URL('../site/assets/admin/api.js?storage-denied', import.meta.url));
    assert.equal(deniedApi.token(), '', '存储受限时应按未登录处理');
    assert.doesNotThrow(() => deniedApi.setToken('ignored'));
    assert.doesNotThrow(() => deniedApi.clearToken());
  } finally {
    if (sessionDescriptor) Object.defineProperty(globalThis, 'sessionStorage', sessionDescriptor);
    else delete globalThis.sessionStorage;
    if (localDescriptor) Object.defineProperty(globalThis, 'localStorage', localDescriptor);
    else delete globalThis.localStorage;
  }
}

// 共创撤权清场：实际详情/开关/storage handlers 共用状态，不能只藏列表。
{
  const preference = 'strings-nsfw';
  const adultKey = 'fadian-adult-confirmed-v1';
  const storage = new Map([[preference, 'true'], [adultKey, '1']]);
  const writes = [];
  const listeners = new Map();
  const preloads = [];
  const messages = [];
  const copies = [];
  const state = {
    showNSFW: true, entries: [], filtered: [], query: '', activeCategory: null,
    onlyFavorites: false, activeEntryId: '', activeImageIndex: 0,
  };
  const button = () => ({
    listeners: {}, dataset: {}, classList: { toggle() {} },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    setAttribute() {},
  });
  const nsfwButton = button();
  const mask = { open: false, addEventListener() {} };
  const body = {
    html: '', image: null, copyButton: null,
    set innerHTML(value) {
      if (this.image) this.image.isConnected = false;
      this.html = value;
      this.image = value ? {
        src: 'thumb.png', isConnected: true,
        removeAttribute(name) { if (name === 'src') this.src = ''; },
      } : null;
      this.copyButton = value ? Object.assign(button(), { dataset: { copy: 'prompt' } }) : null;
    },
    get innerHTML() { return this.html; },
    querySelector(selector) { return selector === '#detailImage' ? this.image : null; },
    querySelectorAll(selector) {
      if (selector === 'img') return this.image ? [this.image] : [];
      return selector === '[data-copy]' && this.copyButton ? [this.copyButton] : [];
    },
  };
  const elements = { '#detailMask': mask, '#detailBody': body, '#nsfwBtn': nsfwButton };
  let fallbackScrubs = 0;
  let toastDismissals = 0;
  let confirmation;
  const timers = new Map();
  let timerId = 0;
  const flushTimers = () => {
    const due = [...timers.values()];
    timers.clear();
    due.forEach(callback => callback());
  };
  globalThis.window = {
    scrollY: 0, scrollTo() {},
    addEventListener: (type, listener) => listeners.set(type, listener),
    setTimeout: callback => { timerId += 1; timers.set(timerId, callback); return timerId; },
    clearTimeout: id => { timers.delete(id); },
  };
  globalThis.document = { activeElement: null, querySelectorAll: () => [] };
  globalThis.Image = class {
    constructor() { this.src = ''; preloads.push(this); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
  };
  globalThis.__communityAccessTest = {
    state, elements, storage, writes,
    toast: (message, icon, action) => messages.push({ message, icon, action }),
    copyText: async (text, options) => {
      if (!options.canCopy()) return { ok: false, blocked: true };
      copies.push(text); return { ok: true };
    },
    revokeDetail: () => {},
    scrubFallback: () => { fallbackScrubs += 1; },
    dismissToast: () => { toastDismissals += 1; },
    requestAccess: options => { confirmation = options; },
  };
  const detailSource = stripImports(await readFile(new URL('../site/assets/community/detail.js', import.meta.url), 'utf8'));
  const detail = await import(asDataModule(`
const test = globalThis.__communityAccessTest;
const { state, toast, copyText } = test;
const $ = selector => test.elements[selector] || null;
const canShowCommunityEntry = entry => Boolean(entry && (!entry.nsfw || state.showNSFW));
const closeMask = mask => { mask.open = false; };
const openMask = mask => { mask.open = true; };
const isMaskOpen = mask => mask.open;
const configureMask = () => {};
const bindBackdropDismiss = () => {};
const focusFirstIn = () => {};
const topInteractionLayer = () => null;
const trapFocus = () => {};
const goBackFrom = () => false;
const createLikeButton = () => null;
const syncCommunityHistory = () => {};
const communityUrlForRoute = route => '/strings.html?entry=' + route.entry;
const escAttr = value => String(value ?? '');
const escHtml = value => String(value ?? '');
const imageUrl = value => value;
${detailSource}`));
  globalThis.__communityAccessTest.revokeDetail = detail.revokeCommunityDetailAccess;
  detail.initDetailDialog();

  const uiSource = stripImports(await readFile(new URL('../site/assets/community/ui.js', import.meta.url), 'utf8'));
  const ui = await import(asDataModule(`
const test = globalThis.__communityAccessTest;
const { state, toast } = test;
const COMMUNITY_NSFW_PREFERENCE_KEY = '${preference}';
const ADULT_CONFIRMATION_STORAGE_KEY = '${adultKey}';
const COMMUNITY_CATEGORIES = [];
const hasAdultNsfwConfirmation = () => test.storage.get(ADULT_CONFIRMATION_STORAGE_KEY) === '1';
const shouldRestoreCommunityNsfw = () => test.storage.get(COMMUNITY_NSFW_PREFERENCE_KEY) === 'true' && hasAdultNsfwConfirmation();
const safeStorageSet = (key, value) => { test.writes.push([key, String(value)]); test.storage.set(key, String(value)); };
const $ = selector => test.elements[selector] || null;
const $$ = () => [];
const updateScrollProgress = () => {};
const goBackFrom = () => false;
const scheduleHistoryScrollCheckpoint = () => {};
const forgetHistoryLayer = () => {};
const favoriteCountForEntries = () => 0;
const isFavorite = () => false;
const toggleFavorite = () => false;
const currentCommunityHistorySession = () => '';
const syncCommunityHistory = () => {};
const requestCommunityNsfwAccess = (...args) => test.requestAccess(...args);
const revokeCommunityDetailAccess = () => test.revokeDetail();
const scrubClipboardFallback = () => test.scrubFallback();
const dismissToast = () => test.dismissToast();
const closeMask = mask => { mask.open = false; };
const renderCategoryRail = () => {};
const renderEmptyState = () => {};
const renderGrid = (_list, options) => { test.gridOpen = options.onOpenDetail; };
const renderResultBar = () => {};
${uiSource}`));
  const restricted = {
    id: 'restricted-fixture', nsfw: true, title: 'restricted marker',
    prompt: 'synthetic positive', negative: 'synthetic negative', category: [], tags: [],
    images: [{ file: 'thumb.png', original: 'original.png' }],
  };
  const safe = { ...restricted, id: 'safe-fixture', nsfw: false };
  state.entries = [restricted, safe];
  ui.initCommunityUI({ openDetail: detail.openCommunityDetail });
  assert.equal(detail.openCommunityDetail(restricted), true);
  assert.match(body.innerHTML, /restricted marker/);
  const staleButton = body.copyButton;
  const staleImage = body.image;
  const stalePreload = preloads.at(-1);
  const staleOnload = stalePreload.onload;
  await staleButton.listeners.click();
  const negativeAction = messages.at(-1).action;
  assert.equal(copies.length, 1);

  nsfwButton.listeners.click({ currentTarget: nsfwButton });
  assert.equal(state.showNSFW, false);
  assert.equal(storage.get(preference), 'false');
  assert.equal(storage.get(adultKey), '1', '关闭混显保留共享成人确认凭据');
  assert.equal(mask.open, false);
  assert.equal(state.activeEntryId, '');
  assert.equal(body.innerHTML, '', '撤权后不能留下隐藏详情原文');
  assert.equal(staleImage.src, '', '撤权清除已挂载图片 src');
  assert.equal(stalePreload.src, '', '撤权取消原图预载');
  assert.equal(stalePreload.onload, null);
  staleOnload();
  assert.equal(staleImage.src, '', '已排队的原图回调不能在撤权后写回');
  await staleButton.listeners.click();
  await negativeAction.onClick();
  assert.equal(copies.length, 1, '旧详情按钮和旧负面复制动作不能越过撤权');
  assert.deepEqual(state.filtered.map(entry => entry.id), ['safe-fixture']);
  assert.equal(fallbackScrubs, 1);
  assert.equal(toastDismissals, 1);
  assert.equal(writes.some(([key]) => key === 'fadian-nsfw-ok'), false, '广场开关不能写主站偏好');

  nsfwButton.listeners.click({ currentTarget: nsfwButton });
  assert.equal(state.showNSFW, true, '明确再次开启可复用成年凭据');
  assert.equal(confirmation, undefined, '有凭据时不重复成人确认');
  detail.openCommunityDetail(restricted);
  const beforeStorageWrites = writes.length;
  storage.set(preference, 'false');
  listeners.get('storage')({ key: preference, newValue: 'false' });
  assert.equal(state.showNSFW, false);
  assert.equal(body.innerHTML, '');
  assert.equal(mask.open, false);
  assert.equal(writes.length, beforeStorageWrites, 'storage 撤权不回写，避免标签页循环');

  // 普通关闭：淡出期间保留内容、收起后清空；淡出途中撤权立刻清空；淡出途中重开不被旧计时清掉。
  state.showNSFW = true;
  detail.openCommunityDetail(restricted);
  detail.closeCommunityDetail({ historyMode: 'none' });
  assert.match(body.innerHTML, /restricted marker/, '淡出期间不能先变成空面板');
  flushTimers();
  assert.equal(body.innerHTML, '');
  detail.openCommunityDetail(restricted);
  detail.closeCommunityDetail({ historyMode: 'none' });
  listeners.get('storage')({ key: preference, newValue: 'false' });
  assert.equal(body.innerHTML, '', '淡出途中撤权要立刻清空');
  state.showNSFW = true;
  detail.openCommunityDetail(restricted);
  detail.closeCommunityDetail({ historyMode: 'none' });
  detail.openCommunityDetail(safe);
  flushTimers();
  assert.notEqual(body.innerHTML, '', '重开的详情不能被上一次关闭的计时清掉');
  // 安全详情不因 NSFW 撤权被关闭。
  detail.openCommunityDetail(safe);
  listeners.get('storage')({ key: preference, newValue: 'false' });
  assert.equal(mask.open, true);
  assert.equal(state.activeEntryId, safe.id);
  assert.notEqual(body.innerHTML, '');
  state.showNSFW = true;
  listeners.get('storage')({ key: 'fadian-nsfw-ok', newValue: '0' });
  assert.equal(state.showNSFW, true, '主站开关事件不改广场独立偏好');

  // 分享链接那条：本页明确开启时打开一次；别的标签页开启、或用户点开了别的投稿，就不再跳回。
  const toggle = () => nsfwButton.listeners.click({ currentTarget: nsfwButton });
  const deferredOpens = [];
  const deferLinked = () => ui.deferCommunityNsfwDetail(({ consumeLayer }) => deferredOpens.push(consumeLayer));
  toggle();
  assert.equal(state.showNSFW, false);
  deferLinked();
  toggle();
  assert.equal(state.showNSFW, true);
  assert.deepEqual(deferredOpens, [false], '顶栏开启也打开分享链接那条');
  toggle();
  toggle();
  assert.deepEqual(deferredOpens, [false], '只打开一次');
  toggle();
  deferLinked();
  storage.set(preference, 'true');
  listeners.get('storage')({ key: preference, newValue: 'true' });
  assert.equal(state.showNSFW, true);
  toggle();
  toggle();
  assert.deepEqual(deferredOpens, [false], '别的标签页开启不替本页打开');
  toggle();
  deferLinked();
  globalThis.__communityAccessTest.gridOpen(safe);
  assert.equal(state.activeEntryId, safe.id);
  detail.closeCommunityDetail({ historyMode: 'none' });
  toggle();
  assert.deepEqual(deferredOpens, [false], '点开别的投稿后不再跳回');
  assert.equal(state.showNSFW, true);

  // 确认在途时另一个标签页关闭，旧 Accept 不能重新开启。
  state.showNSFW = false;
  storage.delete(adultKey);
  ui.requestShowCommunityNsfw();
  assert.equal(typeof confirmation.onAccept, 'function');
  listeners.get('storage')({ key: preference, newValue: 'false' });
  confirmation.onAccept({ consumeLayer: true });
  assert.equal(state.showNSFW, false);
  delete globalThis.__communityAccessTest;
  delete globalThis.Image;
}

// Clipboard await 后权限失效：成功/失败都不能追加 toast 或手动复制原文。
{
  let allowed = true;
  let complete;
  let writes = 0;
  let fallbacks = 0;
  globalThis.__communityCopyGuardTest = {
    write: () => { writes += 1; return new Promise(resolve => { complete = resolve; }); },
    fallback: () => { fallbacks += 1; return true; },
  };
  const source = stripImports(await readFile(new URL('../site/assets/community/utils.js', import.meta.url), 'utf8'));
  const utils = await import(asDataModule(`
const STRINGS_R2_BASE = '';
const formatCopyText = text => ({ text, converted: false });
const isCommunitySdModeEnabled = () => false;
const writeClipboardText = (...args) => globalThis.__communityCopyGuardTest.write(...args);
const showClipboardFallback = () => globalThis.__communityCopyGuardTest.fallback();
${source}`));
  const options = { canCopy: () => allowed };
  for (const ok of [false, true]) {
    allowed = true;
    const pending = utils.copyText('synthetic private marker', options);
    allowed = false;
    complete({ ok });
    assert.deepEqual(await pending, { ok: false, blocked: true });
  }
  assert.equal(fallbacks, 0, '迟到失败不能重新显示手动复制面板');
  await utils.copyText('synthetic private marker', options);
  assert.equal(writes, 2, '已关闭权限时不能开始新复制');
  allowed = true;
  const failed = utils.copyText('normal copy without revoked access', options);
  complete({ ok: false });
  await assert.rejects(failed, error => error.copyResult.manualFallbackShown === true);
  assert.equal(fallbacks, 1, '允许态保留原有手动复制回退');

  // 使用真实 capability 层：Clipboard API 晚拒绝不能降级 execCommand。
  const clipboard = await import(new URL('../site/assets/app/clipboard.js', import.meta.url));
  globalThis.__communityCopyGuardTest.write = clipboard.writeClipboardText;
  let rejectClipboard;
  let execCalls = 0;
  const guardedOptions = {
    canCopy: () => allowed,
    clipboardOptions: {
      navigatorApi: { clipboard: { writeText: () => new Promise((_resolve, reject) => { rejectClipboard = reject; }) } },
      documentApi: {
        activeElement: null,
        body: { appendChild() {} },
        createElement: () => ({ style: {}, setAttribute() {}, focus() {}, select() {}, setSelectionRange() {}, remove() {} }),
        execCommand: () => { execCalls += 1; return true; },
      },
    },
  };
  allowed = true;
  const lateReject = utils.copyText('synthetic revoked marker', guardedOptions);
  allowed = false;
  rejectClipboard(new Error('Clipboard API rejected after access was revoked'));
  assert.deepEqual(await lateReject, { ok: false, blocked: true });
  assert.equal(execCalls, 0, '撤权后的 late rejection 不能进入 execCommand');
  assert.equal(fallbacks, 1, '撤权后的 late rejection 不能进入手动原文回退');
  allowed = true;
  guardedOptions.clipboardOptions.canWrite = () => false;
  assert.deepEqual(await utils.copyText('caller-specific guard', guardedOptions), { ok: false, blocked: true });
  assert.equal(execCalls, 0, '合并 canCopy 时也要保留调用方 clipboardOptions.canWrite');
  delete globalThis.__communityCopyGuardTest;
}

// 实际页面初始化：混显关闭时 NSFW 深链不自动打开。已确认过成年只给开启入口；
// 从没确认过直接弹成年确认。两种情况都记下这条，明确开启后再打开。
{
  const linked = { id: 'deep-restricted', nsfw: true, images: [{}, {}] };
  const state = { showNSFW: false, entries: [], loading: false, loadError: false };
  const elements = { '#communityTitle': { textContent: '' }, '#communityCount': { textContent: '' } };
  const opened = [];
  const messages = [];
  let enableRequests = 0;
  let deferredOpen = null;
  globalThis.window = {};
  const deepTest = globalThis.__communityDeepPreferenceTest = {
    state, elements, linked, opened, messages, adult: true,
    defer: open => { deferredOpen = open; },
    requestShow: () => { enableRequests += 1; },
  };
  const raw = stripImports(await readFile(new URL('../site/assets/community.js', import.meta.url), 'utf8'));
  const source = raw.replace("init().catch(error => console.error('[community] initialization failed', error));", '');
  const page = await import(asDataModule(`
const test = globalThis.__communityDeepPreferenceTest;
const { state } = test;
const COMMUNITY_CATEGORIES = [];
const DEFAULT_COMMUNITY_CATEGORY = '';
const $ = selector => test.elements[selector] || null;
const loadCommunityData = async () => ({ collection: {}, data: { features: {} }, entries: [test.linked], source: 'api' });
const configureCommunityHistory = () => {};
const initCommunitySdMode = () => {};
const initDetailDialog = () => {};
const initMySubmissions = () => {};
const initSubmitDialog = () => {};
const initCommunityUI = () => {};
const setupFavoritesBackup = () => {};
const setCommunityRouterActions = () => {};
const subscribeFavoritesChanges = () => {};
const reloadFavorites = () => {};
const renderMySubmissions = () => {};
const applyCommunityFilters = () => {};
const syncAfterLoad = () => {};
const restoreCommunityHistorySnapshot = async () => {};
const initializeCommunityHistory = () => {};
const captureCommunityRoute = () => ({});
const readCommunityUrlState = () => ({ entry: test.linked.id, imageIndex: 1 });
const closeCommunityDetail = () => {};
const openCommunityDetail = (...args) => test.opened.push(args);
const openSubmitDialog = () => {};
const applyCommunityRoute = () => {};
const requestShowCommunityNsfw = (...args) => test.requestShow(...args);
const deferCommunityNsfwDetail = open => test.defer(open);
const hasAdultNsfwConfirmation = () => test.adult;
const toast = (message, icon, action) => test.messages.push({ message, icon, action });
${source}
export { init };`));
  await page.init();
  assert.equal(state.showNSFW, false);
  assert.equal(enableRequests, 0, '初始化不能自动调用已有成年凭据开启混显');
  assert.deepEqual(opened, []);
  const notice = messages.at(-1);
  assert.equal(notice.message, '这条投稿含 NSFW 内容');
  assert.equal(notice.action.label, '开启 NSFW 混显');
  notice.action.onClick();
  assert.equal(enableRequests, 1);
  deferredOpen({ consumeLayer: false });
  assert.equal(opened[0][0], linked);
  assert.equal(opened[0][1], 1, '明确开启继续原深链所选图片');

  deepTest.adult = false;
  messages.length = 0;
  opened.length = 0;
  enableRequests = 0;
  deferredOpen = null;
  await page.init();
  assert.equal(enableRequests, 1, '从没确认过成年：直接弹确认框');
  assert.equal(messages.length, 0, '首次访客不出提示条');
  assert.deepEqual(opened, [], '确认前不打开');
  deferredOpen({ consumeLayer: true });
  assert.equal(opened[0][0], linked, '确认开启后打开分享链接那条');
  assert.equal(opened[0][2].consumeLayer, true);
  delete globalThis.__communityDeepPreferenceTest;
}

// 撤权直接收起浮层时，也要从真实托管历史移除它；否则 Back/Forward 会再次打开旧框。
{
  const history = await import(new URL('../site/assets/app/browser-history.js', import.meta.url));
  class HistoryWindow extends EventTarget {
    constructor() {
      super();
      this.scrollY = 0;
      this.setTimeout = setTimeout;
      this.clearTimeout = clearTimeout;
      this.queueMicrotask = queueMicrotask;
      this.history = new HistoryStack(this);
    }
  }
  class HistoryStack {
    constructor(window) {
      this.window = window;
      this.entries = [{ state: null }];
      this.index = 0;
    }
    get state() { return this.entries[this.index].state; }
    replaceState(state) { this.entries[this.index] = { state: structuredClone(state) }; }
    pushState(state) {
      this.entries.splice(this.index + 1);
      this.entries.push({ state: structuredClone(state) });
      this.index += 1;
    }
    go(delta) {
      const index = this.index + delta;
      if (index < 0 || index >= this.entries.length) return;
      this.index = index;
      const event = new Event('popstate');
      Object.defineProperty(event, 'state', { value: structuredClone(this.state) });
      this.window.dispatchEvent(event);
    }
    back() { this.go(-1); }
    forward() { this.go(1); }
  }
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const source = stripImports(await readFile(new URL('../site/assets/community/ui.js', import.meta.url), 'utf8'));
  for (const layerId of ['communityNsfwConfirm', 'clipboardFallback']) {
    const window = globalThis.window = new HistoryWindow();
    globalThis.document = { activeElement: null };
    const state = {
      showNSFW: true, entries: [], query: '', activeCategory: null, onlyFavorites: false,
      activeEntryId: 'safe-detail', activeImageIndex: 0,
    };
    const confirmation = { open: false };
    const fallback = { open: false, value: 'synthetic copy marker' };
    const unrelated = { open: true };
    const nsfwButton = { addEventListener() {}, classList: { toggle() {} }, setAttribute() {} };
    const captureRoute = () => ({ entry: state.activeEntryId, imageIndex: state.activeImageIndex });
    history.configureBrowserHistory({
      window, page: 'community', captureRoute,
      applyRoute: async () => {}, restoreScroll: async () => {},
    });
    history.initializeBrowserHistory();
    history.registerHistoryLayer('mySubmissionsPanel', {
      isOpen: () => unrelated.open,
      open: () => { unrelated.open = true; },
      close: () => { unrelated.open = false; },
    });
    history.openHistoryLayer('mySubmissionsPanel');
    for (const [id, mask] of [['communityNsfwConfirm', confirmation], ['clipboardFallback', fallback]]) {
      history.registerHistoryLayer(id, {
        isOpen: () => mask.open,
        open: () => { mask.open = true; },
        close: () => { mask.open = false; },
      });
    }
    const revokedMask = layerId === 'communityNsfwConfirm' ? confirmation : fallback;
    revokedMask.open = true;
    history.openHistoryLayer(layerId);
    globalThis.__communityHistoryRevokeTest = { state, confirmation, fallback, nsfwButton, history };
    const ui = await import(asDataModule(`
const test = globalThis.__communityHistoryRevokeTest;
const { state, history } = test;
const COMMUNITY_NSFW_PREFERENCE_KEY = 'strings-nsfw';
const ADULT_CONFIRMATION_STORAGE_KEY = 'fadian-adult-confirmed-v1';
const COMMUNITY_CATEGORIES = [];
const $ = selector => selector === '#communityNsfwConfirm' ? test.confirmation : selector === '#nsfwBtn' ? test.nsfwButton : null;
const $$ = () => [];
const safeStorageSet = () => {};
const shouldRestoreCommunityNsfw = () => false;
const hasAdultNsfwConfirmation = () => false;
const updateScrollProgress = () => {};
const goBackFrom = () => false;
const scheduleHistoryScrollCheckpoint = () => {};
const forgetHistoryLayer = history.forgetHistoryLayer;
const favoriteCountForEntries = () => 0;
const isFavorite = () => false;
const toggleFavorite = () => false;
const currentCommunityHistorySession = () => '';
const syncCommunityHistory = () => history.commitHistoryRoute({ mode: 'replace' });
const requestCommunityNsfwAccess = () => {};
const revokeCommunityDetailAccess = () => false;
const scrubClipboardFallback = () => { test.fallback.open = false; test.fallback.value = ''; };
const dismissToast = () => {};
const toast = () => {};
const closeMask = mask => { mask.open = false; };
const renderCategoryRail = () => {};
const renderEmptyState = () => {};
const renderGrid = () => {};
const renderResultBar = () => {};
// ${layerId}：保证两种浮层分别运行实际 UI 初始化与 storage listener。
${source}`));
    ui.initCommunityUI();
    const event = new Event('storage');
    Object.defineProperty(event, 'key', { value: 'strings-nsfw' });
    Object.defineProperty(event, 'newValue', { value: 'false' });
    window.dispatchEvent(event);
    assert.equal(revokedMask.open, false);
    assert.equal(state.showNSFW, false);
    assert.deepEqual(history.getManagedHistoryEntry().layers, [{ id: 'mySubmissionsPanel' }]);
    assert.equal(state.activeEntryId, 'safe-detail', '撤权保留安全详情路由');
    assert.equal(fallback.value, '', '手动复制原文已清空');
    window.history.back();
    await tick();
    window.history.forward();
    await tick();
    assert.equal(revokedMask.open, false, `${layerId} 不能被 Forward 恢复`);
    assert.equal(unrelated.open, true, '只移除失效浮层，不关闭其他安全面板');
    assert.equal(state.activeEntryId, 'safe-detail');
  }
  delete globalThis.__communityHistoryRevokeTest;
}

console.log('community/admin frontend regressions: PASS');
