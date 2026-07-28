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
  assert.match(empty.innerHTML, /还没有人投稿/);
  assert.equal(buttons[0]?.textContent, '分享你的作品');
  buttons[0].click();
  assert.equal(submits, 1);

  state.loadError = true;
  render.renderResultBar();
  render.renderEmptyState({ onSubmit: () => { submits += 1; } });
  assert.equal(result.textContent, '共创广场加载失败');
  assert.match(empty.innerHTML, /暂时无法取得投稿数据/);
  assert.equal(buttons[0]?.textContent, '刷新重试');
  assert.doesNotMatch(empty.innerHTML, /分享你的作品/);
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

console.log('community/admin frontend regressions: PASS');
