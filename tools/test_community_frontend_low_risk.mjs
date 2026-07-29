// 共创广场与管理端低风险回归：node tools/test_community_frontend_low_risk.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const asDataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const stripImports = source => source.replace(/^import[\s\S]*?;\r?\n/gm, '');
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

// localStorage 属性本身抛 SecurityError 时，状态模块、收藏读写和交互仍可用。
{
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('blocked', 'SecurityError'); },
  });
  try {
    const utils = await import(new URL('../site/assets/community/utils.js?blocked-storage', import.meta.url));
    assert.equal(utils.safeStorageGet('missing'), null);
    assert.equal(utils.safeStorageSet('key', 'value'), false);

    const { state } = await import(new URL('../site/assets/community/state.js?blocked-storage', import.meta.url));
    assert.equal(state.showNSFW, false);
    assert.equal(state.onlyFavorites, false);

    const favorites = await import(new URL('../site/assets/community/favorites.js?blocked-storage', import.meta.url));
    const entry = { id: 'blocked-storage-entry' };
    assert.equal(favorites.toggleFavorite(entry), true);
    assert.equal(favorites.isFavorite(entry), true, '写入失败不应中断当前会话的收藏交互');
    assert.equal(favorites.toggleFavorite(entry), false);

    const uiSource = await readFile(new URL('../site/assets/community/ui.js', import.meta.url), 'utf8');
    const favoritesSource = await readFile(new URL('../site/assets/community/favorites.js', import.meta.url), 'utf8');
    assert.doesNotMatch(uiSource, /localStorage\s*\./, 'community UI 不得绕过安全存储包装');
    assert.doesNotMatch(favoritesSource, /localStorage\s*\./, '收藏写入不得绕过安全存储包装');
  } finally {
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else delete globalThis.localStorage;
  }
}

// execCommand 回退明确报告 false，且无论成败都清理临时 textarea。
{
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const area = {
    value: '',
    style: {},
    setAttribute() {},
    select() {},
    removeCalls: 0,
    remove() { this.removeCalls += 1; },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: null },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => area,
      body: { appendChild() {} },
      execCommand: () => false,
    },
  });
  try {
    const { copyText } = await import(new URL('../site/assets/community/utils.js?copy-fallback', import.meta.url));
    await assert.rejects(copyText('prompt'), /复制失败/);
    assert.equal(area.removeCalls, 1);
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
    else delete globalThis.document;
  }
}

// 详情复制失败必须 toast，成功文案保持原语义。
{
  const button = {
    dataset: { copy: 'prompt' },
    addEventListener(_type, listener) { this.listener = listener; },
  };
  const body = {
    innerHTML: '',
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === '[data-copy]' ? [button] : []; },
  };
  const messages = [];
  let copyFails = true;
  globalThis.__communityDetailLowRiskTest = {
    body,
    entry: {
      id: 'detail-entry',
      title: '测试投稿',
      prompt: '1girl',
      negative: '',
      category: ['人物'],
      images: [],
      tags: [],
    },
    copyText: async () => {
      if (copyFails) throw new Error('denied');
    },
    toast: (message, icon) => messages.push({ message, icon }),
  };
  let source = stripImports(await readFile(new URL('../site/assets/community/detail.js', import.meta.url), 'utf8'));
  source = source
    .replace(/let detailMask;\r?\nlet detailBody;\r?\nlet activeEntry = null;/, `
let detailMask = {};
let detailBody = globalThis.__communityDetailLowRiskTest.body;
let activeEntry = globalThis.__communityDetailLowRiskTest.entry;`)
    .concat('\nexport { renderDetail };\n');
  source = `
const closeMask = () => {};
const isMaskOpen = () => false;
const openMask = () => {};
const trapFocus = () => {};
const toast = globalThis.__communityDetailLowRiskTest.toast;
const goBackFrom = () => false;
const createLikeButton = () => null;
const syncCommunityHistory = () => {};
const communityUrlForRoute = route => '/strings.html?entry=' + encodeURIComponent(route.entry || '');
const state = { activeEntryId: '', activeImageIndex: 0 };
const $ = () => null;
const copyText = (...args) => globalThis.__communityDetailLowRiskTest.copyText(...args);
const escAttr = value => String(value ?? '');
const escHtml = value => String(value ?? '');
const imageUrl = value => value;
${source}`;
  const detail = await import(asDataModule(source));
  detail.renderDetail();
  await button.listener();
  assert.deepEqual(messages.at(-1), {
    message: '复制失败，请长按/手动选择文本',
    icon: '!',
  });
  copyFails = false;
  detail.renderDetail();
  await button.listener();
  assert.equal(messages.at(-1).message, '已复制 Prompt');
  delete globalThis.__communityDetailLowRiskTest;
}

function submitModuleSource(testKey, { withFiles = false } = {}) {
  return readFile(new URL('../site/assets/community/submit.js', import.meta.url), 'utf8').then(raw => {
    let source = stripImports(raw)
      .replace(/let submitMask;\r?\nlet submitForm;/, `
let submitMask = globalThis.${testKey}.mask;
let submitForm = globalThis.${testKey}.form;`);
    if (withFiles) {
      source = source.replace('let files = [];', `let files = [globalThis.${testKey}.fileItem];`);
    }
    source += '\nexport { submitCommunity };\n';
    return `
const closeMask = mask => { mask.open = false; };
const isMaskOpen = mask => Boolean(mask?.open);
const openMask = mask => { mask.open = true; };
const trapFocus = () => {};
const toast = (...args) => globalThis.${testKey}.toasts.push(args);
const DEFAULT_COMMUNITY_CATEGORY = '随手分享';
const LIMITS = { imageCount: 6, origBytes: 1e9, totalBytes: 1e9, imageBytes: 1e9, prompt: 2000, negative: 2000 };
const SUBMIT_CATEGORIES = ['随手分享'];
const SUBMIT_DISABLED = false;
const SUBMIT_DISABLED_MESSAGE = '';
const readImageParams = (...args) => globalThis.${testKey}.readImageParams(...args);
const $ = selector => globalThis.${testKey}.elements.get(selector) || null;
const $$ = () => [];
const escHtml = value => String(value ?? '');
const rememberOwnedRecord = () => {};
const COMMUNITY_SUBMISSIONS_KEY = 'test-community-submissions';
${source}`;
  });
}

// 旧上传完成时，不得清空或关闭已重新打开的新会话。
{
  let resolveFetch;
  let resets = 0;
  const mask = { open: false };
  const form = { reset: () => { resets += 1; } };
  const prompt = { value: 'old prompt' };
  const title = { value: 'old title' };
  const submit = { disabled: false, textContent: '' };
  const elements = new Map([
    ['#subPrompt', prompt], ['#subTitle', title], ['#subNegative', { value: '' }],
    ['#subComment', { value: '' }], ['#subCategory', { value: '随手分享' }],
    ['#subTags', { value: '' }], ['#subName', { value: '' }], ['#subNsfw', { checked: false }],
    ['#subGo', submit], ['#subErr', { textContent: '' }], ['#subPromptSrc', { className: '', textContent: '' }],
    ['#subMore', { open: false }], ['#subPreviews', { set innerHTML(_value) {}, appendChild() {} }],
  ]);
  const fileItem = {
    blob: new Blob(['compressed'], { type: 'image/jpeg' }),
    noOriginal: true,
    width: 10,
    height: 10,
    params: null,
  };
  globalThis.__communitySubmitUploadRace = {
    mask, form, elements, fileItem, toasts: [], readImageParams: async () => null,
  };
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: () => new Promise(resolve => { resolveFetch = resolve; }),
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { activeElement: null },
  });
  try {
    const submitModule = await import(asDataModule(await submitModuleSource('__communitySubmitUploadRace', { withFiles: true })));
    submitModule.openSubmitDialog();
    const pending = submitModule.submitCommunity({ preventDefault() {} });
    submitModule.closeSubmitDialog();
    prompt.value = 'new prompt';
    title.value = 'new title';
    submitModule.openSubmitDialog();
    resolveFetch({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await pending;
    assert.equal(resets, 0, '旧请求成功回调不得 reset 新会话');
    assert.equal(mask.open, true, '旧请求成功回调不得关闭新会话');
    assert.equal(prompt.value, 'new prompt');
    assert.equal(title.value, 'new title');
    assert.equal(globalThis.__communitySubmitUploadRace.toasts.at(-1)?.[0], '投稿已提交，审核通过后会公开');
  } finally {
    if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor);
    else delete globalThis.fetch;
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
    else delete globalThis.document;
    delete globalThis.__communitySubmitUploadRace;
  }
}

// 重新打开后，旧会话尚在解析的图片不得追加到新表单。
{
  let releaseMetadata;
  let metadataStarted = false;
  let objectUrls = 0;
  const mask = { open: false };
  const previews = { children: [], set innerHTML(_value) { this.children = []; }, appendChild(node) { this.children.push(node); } };
  const elements = new Map([
    ['#subPreviews', previews], ['#subErr', { textContent: '' }],
    ['#subPromptSrc', { className: '', textContent: '' }], ['#subPrompt', { value: '' }],
    ['#subNegative', { value: '' }],
  ]);
  globalThis.__communitySubmitCompressionRace = {
    mask,
    form: { reset() {} },
    elements,
    toasts: [],
    readImageParams: async () => {
      metadataStarted = true;
      await new Promise(resolve => { releaseMetadata = resolve; });
      return null;
    },
  };
  const moduleSource = await submitModuleSource('__communitySubmitCompressionRace');
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const urlDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'URL');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null } });
  Object.defineProperty(globalThis, 'URL', {
    configurable: true,
    value: {
      createObjectURL: () => { objectUrls += 1; return 'blob:stale'; },
      revokeObjectURL() {},
    },
  });
  try {
    const submitModule = await import(asDataModule(moduleSource));
    submitModule.openSubmitDialog();
    const pending = submitModule.addFiles([{ name: 'stale.png', type: 'image/png', size: 1 }]);
    await Promise.resolve();
    assert.equal(metadataStarted, true);
    submitModule.closeSubmitDialog();
    submitModule.openSubmitDialog();
    releaseMetadata();
    await pending;
    assert.equal(objectUrls, 0, '旧压缩会话不得生成预览 URL');
    assert.equal(previews.children.length, 0, '旧压缩会话不得污染新表单');
  } finally {
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
    else delete globalThis.document;
    if (urlDescriptor) Object.defineProperty(globalThis, 'URL', urlDescriptor);
    else delete globalThis.URL;
    delete globalThis.__communitySubmitCompressionRace;
  }
}

// asset 401 与后续 mutate 401 都传到登录路径，且未重新登录前不空转。
{
  const sessionDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const session = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: key => session.get(key) ?? null,
      setItem: (key, value) => session.set(key, String(value)),
      removeItem: key => session.delete(key),
    },
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => ({ status: 401, ok: false, json: async () => ({ error: '口令已失效' }) }),
  });
  try {
    const api = await import(new URL('../site/assets/admin/api.js?asset-401', import.meta.url));
    api.setToken('expired');
    const error = await api.fetchCommunityAsset('community/img/a/original.png').then(
      () => null,
      value => value,
    );
    assert.equal(error?.unauthorized, true);
    assert.equal(error?.message, '口令已失效');
    assert.equal(api.token(), '', 'asset 401 必须立即清理失效 token');
  } finally {
    if (sessionDescriptor) Object.defineProperty(globalThis, 'sessionStorage', sessionDescriptor);
    else delete globalThis.sessionStorage;
    if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor);
    else delete globalThis.fetch;
  }

  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  delete globalThis.document;
  let failureStage = 'asset';
  let assetCalls = 0;
  let mutateCalls = 0;
  const unauthorized = () => Object.assign(new Error('口令已失效'), { unauthorized: true });
  globalThis.__adminEditor401Test = {
    fetchCommunityAsset: async () => {
      assetCalls += 1;
      if (failureStage === 'asset') throw unauthorized();
      return new Blob(['image']);
    },
    mutateCommunity: async () => {
      mutateCalls += 1;
      throw unauthorized();
    },
    readImageParams: async () => ({ source: 'NovelAI', via: 'text' }),
  };
  let editorSource = stripImports(await readFile(new URL('../site/assets/admin/editor.js', import.meta.url), 'utf8'));
  editorSource = `
const fetchCommunityAsset = (...args) => globalThis.__adminEditor401Test.fetchCommunityAsset(...args);
const mutateCommunity = (...args) => globalThis.__adminEditor401Test.mutateCommunity(...args);
const readImageParams = (...args) => globalThis.__adminEditor401Test.readImageParams(...args);
${editorSource}`;
  try {
    const editor = await import(asDataModule(editorSource));
    const handled = [];
    editor.setParamsRecheckErrorHandler(error => handled.push(error));
    const item = id => ({
      id,
      images: [{ index: 0, params: { source: 'NovelAI', via: 'stealth', verified: false }, origKey: `community/img/${id}/0.png` }],
    });

    const assetItem = item('asset401');
    editor.verifyPendingParams(assetItem);
    await nextTurn();
    assert.equal(handled.length, 1);
    editor.verifyPendingParams(assetItem);
    await nextTurn();
    assert.equal(assetCalls, 1, '未重新登录前不得反复请求已注定 401 的 asset');

    editor.resetParamsRecheckMemo();
    failureStage = 'mutate';
    const mutateItem = item('mutate401');
    editor.verifyPendingParams(mutateItem);
    await nextTurn();
    assert.equal(handled.length, 2, '参数复检后的 mutate 401 也必须进入登录处理');
    assert.equal(mutateCalls, 1);
    editor.verifyPendingParams(mutateItem);
    await nextTurn();
    assert.equal(mutateCalls, 1);

    const actionsSource = await readFile(new URL('../site/assets/admin/actions.js', import.meta.url), 'utf8');
    const apiSource = await readFile(new URL('../site/assets/admin/api.js', import.meta.url), 'utf8');
    assert.match(actionsSource, /setParamsRecheckErrorHandler\(handleError\)/);
    assert.match(actionsSource, /resetParamsRecheckMemo\(\)/);
    assert.doesNotMatch(apiSource, /export function decideFeedback/);
    assert.doesNotMatch(actionsSource, /action === ['"](?:resolve|ignore)['"]/);
  } finally {
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
    else delete globalThis.document;
    delete globalThis.__adminEditor401Test;
  }
}

console.log('community/admin frontend low-risk regressions: PASS');
