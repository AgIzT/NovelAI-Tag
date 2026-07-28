// 渲染与主 UI 回归：node tools/test_render_ui.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

class FakeHTMLElement {
  constructor(tagName = 'DIV') {
    this.tagName = tagName;
    this.isContentEditable = false;
  }
}

function fakeClassList(initial = []) {
  const values = new Set(initial);
  return {
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
    contains: name => values.has(name),
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : Boolean(force);
      if (enabled) values.add(name);
      else values.delete(name);
      return enabled;
    },
  };
}

function fakeStyle(onSet = () => {}) {
  const values = new Map();
  return {
    get width() { return values.get('width') || ''; },
    set width(value) { values.set('width', value); onSet('width', value); },
    get height() { return values.get('height') || ''; },
    set height(value) { values.set('height', value); onSet('height', value); },
    get transform() { return values.get('transform') || ''; },
    set transform(value) { values.set('transform', value); onSet('transform', value); },
    setProperty(name, value) { values.set(name, value); onSet(name, value); },
    getPropertyValue(name) { return values.get(name) || ''; },
    removeProperty(name) { values.delete(name); },
  };
}

const dom = new Map();
const windowListeners = new Map();
globalThis.HTMLElement = FakeHTMLElement;
globalThis.window = {
  addEventListener(type, listener) { windowListeners.set(type, listener); },
  matchMedia: () => ({ matches: true }),
  setTimeout,
  clearTimeout,
  innerHeight: 800,
  scrollY: 0,
  performance,
};
globalThis.document = {
  activeElement: null,
  documentElement: { clientHeight: 800, scrollHeight: 2000, classList: fakeClassList() },
  body: { classList: fakeClassList() },
  querySelector: selector => dom.get(selector) || null,
  querySelectorAll: () => [],
};
globalThis.location = {
  href: 'http://localhost/',
  origin: 'http://localhost',
  hostname: 'localhost',
  protocol: 'http:',
  pathname: '/',
  search: '',
  hash: '',
};
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.getComputedStyle = element => ({ display: element?.display || 'block' });

const { state } = await import('../site/assets/app/state.js');
const {
  applyCardHeightChanges,
  calibrateCardHeights,
  cleanupCard,
} = await import('../site/assets/app/masonry.js');
const {
  canUseNativeShare,
  getLightboxStepTarget,
  isLightboxKeydownBlocked,
  lightboxNavigationContext,
  lightboxOriginalCopy,
  preloadImage,
  preloadLightboxNeighbors,
  setLightboxScrollLocked,
} = await import('../site/assets/app/lightbox.js');
const { entryImages, imageItemHasOriginal } = await import('../site/assets/app/media.js');
const { normalizeImageList } = await import('../site/assets/app/data.js');
const {
  accessHiddenCount,
  imageSyntaxFilterValue,
  invalidateAccessViewMemo,
  lockedCodexCount,
  railRevealDelta,
  syncCodexPickerCounts,
  visibleEntryCount,
  visibleTree,
} = await import('../site/assets/app/codex-ui.js');
const { nextDensity } = await import('../site/assets/app/ui.js');
const { buildFeedbackContext, feedbackTimeoutSignal, setupReport } = await import('../site/assets/app/report.js');
const { safeHttpUrl } = await import('../site/assets/app/utils.js');
const { atlasUrlForRoute, readUrlState } = await import('../site/assets/app/router.js');
const { loadAnnouncements } = await import('../site/assets/app/announcements.js');

// 同一批多卡校准：按列累计 delta，每个受影响节点只更新一次，容器高度只同步一次。
{
  let masonryHeightWrites = 0;
  const masonryStyle = fakeStyle(name => { if (name === 'height') masonryHeightWrites += 1; });
  dom.set('#masonry', { style: masonryStyle });

  const placements = [
    { index: 0, col: 0, top: 0, height: 100, width: 200, left: 0, imageHeight: 0, tagsHeight: 30 },
    { index: 1, col: 1, top: 0, height: 90, width: 200, left: 210, imageHeight: 0, tagsHeight: 30 },
    { index: 2, col: 0, top: 110, height: 100, width: 200, left: 0, imageHeight: 0, tagsHeight: 30 },
    { index: 3, col: 1, top: 100, height: 90, width: 200, left: 210, imageHeight: 0, tagsHeight: 30 },
    { index: 4, col: 0, top: 220, height: 100, width: 200, left: 0, imageHeight: 0, tagsHeight: 30 },
  ];
  const positionWrites = new Map();
  const nodes = new Map(placements.map(placement => {
    const tags = { style: fakeStyle() };
    const wrap = { style: fakeStyle() };
    const node = {
      style: fakeStyle(name => {
        if (name === '--card-y') positionWrites.set(placement.index, (positionWrites.get(placement.index) || 0) + 1);
      }),
      querySelector: selector => selector === '.card-tags' ? tags : (selector === '.card-img-wrap' ? wrap : null),
    };
    return [placement.index, node];
  }));
  state.placements = placements;
  state.nodes = nodes;

  assert.equal(applyCardHeightChanges([
    { placement: placements[0], nextHeight: 120 },
    { placement: placements[2], nextHeight: 95 },
  ]), true);
  assert.deepEqual(placements.map(({ top, height }) => [top, height]), [
    [0, 120],
    [0, 90],
    [130, 95],
    [100, 90],
    [235, 100],
  ]);
  assert.deepEqual([...positionWrites], [[0, 1], [2, 1], [4, 1]]);
  assert.equal(masonryHeightWrites, 1);
  assert.equal(masonryStyle.height, '335px');
}

// 校准严格分成“全批 auto 写入 → 全批读取 → 全批最终写入”；钳制标签后高度与旧算法一致。
{
  const events = [];
  const makeMeasuredCard = ({ index, naturalTagsHeight, bodyHeight, imageHeight, oldHeight }) => {
    const placement = {
      index,
      col: index,
      top: 0,
      height: oldHeight,
      width: 200,
      left: index * 210,
      imageHeight,
      tagsHeight: 30,
    };
    const tags = {
      style: fakeStyle((name, value) => { if (name === 'height') events.push(`write:${index}:tags:${value}`); }),
      classList: { toggle: () => events.push(`write:${index}:class`) },
      get scrollHeight() { events.push(`read:${index}:scroll`); return naturalTagsHeight; },
      getBoundingClientRect() { events.push(`read:${index}:tags-box`); return { height: naturalTagsHeight }; },
    };
    const wrap = {
      hidden: imageHeight === 0,
      display: 'block',
      style: fakeStyle(),
      getBoundingClientRect() { events.push(`read:${index}:image`); return { height: imageHeight }; },
    };
    const body = {
      getBoundingClientRect() { events.push(`read:${index}:body`); return { height: bodyHeight }; },
    };
    const node = {
      style: fakeStyle((name, value) => { if (name === 'height') events.push(`write:${index}:card:${value}`); }),
      querySelector(selector) {
        if (selector === '.card-tags') return tags;
        if (selector === '.card-img-wrap') return wrap;
        if (selector === '.card-body') return body;
        return null;
      },
    };
    return { node, placement };
  };

  const first = makeMeasuredCard({ index: 0, naturalTagsHeight: 120, bodyHeight: 170, imageHeight: 50, oldHeight: 180 });
  const second = makeMeasuredCard({ index: 1, naturalTagsHeight: 40, bodyHeight: 80, imageHeight: 0, oldHeight: 80 });
  state.placements = [first.placement, second.placement];
  state.nodes = new Map([[0, first.node], [1, second.node]]);
  dom.set('#masonry', { style: fakeStyle() });

  assert.equal(calibrateCardHeights([first, second]), true);
  assert.equal(first.placement.tagsHeight, 86);
  assert.equal(first.placement.height, 186, 'body 高度应扣掉 auto 标签盒并加回 86px 钳制高度');
  assert.equal(second.placement.height, 80);
  const firstRead = events.findIndex(event => event.startsWith('read:'));
  const lastRead = events.findLastIndex(event => event.startsWith('read:'));
  const autoWrites = events
    .map((event, index) => [event, index])
    .filter(([event]) => event.endsWith(':tags:auto'))
    .map(([, index]) => index);
  const finalWrites = events
    .map((event, index) => [event, index])
    .filter(([event]) => event.startsWith('write:') && !event.endsWith(':tags:auto'))
    .map(([, index]) => index);
  assert.equal(autoWrites.length, 2);
  assert.ok(Math.max(...autoWrites) < firstRead, '所有 auto 写入必须先于首个布局读取');
  assert.ok(Math.min(...finalWrites) > lastRead, '所有最终 DOM 写入必须晚于最后一个布局读取');
}

// 虚拟卡回收：未完成下载摘 handler 并移除 src；已完成图只摘 handler，不浪费缓存。
{
  const makeCleanupNode = loading => {
    let removed = false;
    const img = {
      onload: () => {},
      onerror: () => {},
      removeAttribute(name) { if (name === 'src') removed = true; },
    };
    const wrap = { classList: fakeClassList(loading ? ['is-loading'] : []) };
    return {
      node: { _imageTimer: 0, querySelector: selector => selector === '.card-img' ? img : wrap },
      img,
      removed: () => removed,
    };
  };
  const loading = makeCleanupNode(true);
  cleanupCard(loading.node);
  assert.equal(loading.img.onload, null);
  assert.equal(loading.img.onerror, null);
  assert.equal(loading.removed(), true);

  const loaded = makeCleanupNode(false);
  cleanupCard(loaded.node);
  assert.equal(loaded.removed(), false);
  assert.equal(loaded.img.onload, null);
  assert.equal(loaded.img.onerror, null);
}

// 灯箱键盘守卫覆盖输入控件、contentEditable、已 preventDefault 事件与上层反馈弹层。
{
  const feedbackPanel = { hidden: true };
  dom.set('#feedbackPanel', feedbackPanel);
  const plain = new FakeHTMLElement('DIV');
  assert.equal(isLightboxKeydownBlocked({ target: plain, defaultPrevented: false }), false);
  assert.equal(isLightboxKeydownBlocked({ target: new FakeHTMLElement('TEXTAREA'), defaultPrevented: false }), true);
  const editable = new FakeHTMLElement('DIV');
  editable.isContentEditable = true;
  assert.equal(isLightboxKeydownBlocked({ target: editable, defaultPrevented: false }), true);
  assert.equal(isLightboxKeydownBlocked({ target: plain, defaultPrevented: true }), true);
  feedbackPanel.hidden = false;
  assert.equal(isLightboxKeydownBlocked({ target: plain, defaultPrevented: false }), true);
}

// 邻图仍同时预热缩略图和原图；缓存失败可重试，且超过 300 项会淘汰最旧 URL。
{
  const images = [];
  globalThis.Image = class {
    constructor() { images.push(this); }
    set src(value) { this._src = value; }
    get src() { return this._src || ''; }
  };

  preloadImage('https://preload.test/retry.png');
  preloadImage('https://preload.test/retry.png');
  assert.equal(images.length, 1, '缓存命中不应重复建请求');
  const fail = images[0].onerror;
  fail();
  preloadImage('https://preload.test/retry.png');
  assert.equal(images.length, 2, '失败 URL 下次应重新预载');

  for (let i = 0; i <= 300; i++) preloadImage(`https://preload.test/lru-${i}.png`);
  const beforeOldestRetry = images.length;
  preloadImage('https://preload.test/lru-0.png');
  assert.equal(images.length, beforeOldestRetry + 1, '超过上限后最旧 URL 应已被淘汰');

  state.codex = { id: 'book', assetPathMode: 'relative', assetBaseUrl: 'https://assets.test' };
  state.list = [];
  state.lightbox = {
    entry: { id: 'entry', assetRev: 'r1' },
    index: 0,
    images: [
      { path: 'thumb-0.jpg', original: 'original-0.png' },
      { path: 'thumb-1.jpg', original: 'original-1.png' },
      { path: 'thumb-2.jpg', original: 'original-2.png' },
    ],
  };
  const beforeNeighbors = images.length;
  preloadLightboxNeighbors();
  assert.equal(images.length, beforeNeighbors + 4, '前后邻图应各保留缩略图+原图预热');
}

// 灯箱把当前过滤列表展平成循环画廊：图内优先，边界跨词条，跳过无图/受限项；
// 不在列表的深链只保留原有多图循环，不擅自跨词条。
{
  state.codex = { id: 'book', assetPathMode: 'relative', assetBaseUrl: 'https://assets.test' };
  state.allowNsfw = false;
  state.allowR18g = false;
  const first = {
    id: 'first', path: ['A'],
    images: [{ path: 'first-1.jpg' }, { path: 'first-2.jpg' }],
  };
  const noImage = { id: 'empty', path: ['A'] };
  const blocked = { id: 'blocked', path: ['A'], rating: 'r18', image: 'blocked.jpg' };
  const last = { id: 'last', path: ['A'], image: 'last.jpg' };
  state.list = [first, noImage, blocked, last];

  const firstBox = { entry: first, images: entryImages(first), index: 0 };
  assert.equal(getLightboxStepTarget(1, firstBox).index, 1, '同词条应先切下一张');
  assert.equal(getLightboxStepTarget(-1, firstBox).entry, last, '首图向前应跨列表首尾循环');
  const firstEnd = { ...firstBox, index: 1 };
  const nextEntry = getLightboxStepTarget(1, firstEnd);
  assert.equal(nextEntry.entry, last);
  assert.equal(nextEntry.crossEntry, true);
  const lastBox = { entry: last, images: entryImages(last), index: 0 };
  assert.equal(getLightboxStepTarget(1, lastBox).entry, first, '末条向后应回到过滤列表首条');
  assert.equal(getLightboxStepTarget(-1, lastBox).index, 1, '上一条多图时应落到其末图');
  assert.deepEqual(
    { ...lightboxNavigationContext(last), entries: undefined },
    { entries: undefined, index: 1, position: 2, total: 2 },
  );

  const deep = { id: 'deep', images: [{ path: 'deep-1.jpg' }, { path: 'deep-2.jpg' }] };
  const deepBox = { entry: deep, images: entryImages(deep), index: 1 };
  const deepNext = getLightboxStepTarget(1, deepBox);
  assert.equal(deepNext.entry, deep);
  assert.equal(deepNext.index, 0);
  assert.equal(deepNext.crossEntry, false);
  assert.equal(getLightboxStepTarget(1, { entry: { id: 'single', image: 'one.jpg' }, images: [{ path: 'one.jpg' }], index: 0 }), null);
}

// 物理 original 与缩略 fallback 分开；提示是否承诺可读参数还要看来源 hasOriginal。
{
  assert.equal(imageItemHasOriginal(entryImages({ image: 'thumb.jpg' })[0]), false);
  assert.equal(imageItemHasOriginal(entryImages({ image: 'thumb.jpg', original: 'source.png' })[0]), true);
  const normalizedFallback = normalizeImageList({
    image: 'same.jpg',
    images: [{ path: 'same.jpg' }],
  })[0];
  assert.equal(imageItemHasOriginal(normalizedFallback), false, '归一化补出的同路径 fallback 不能冒充原图');
  const sameNamePhysicalOriginal = normalizeImageList({
    image: 'same.jpg',
    original: 'same.jpg',
    images: [{ path: 'same.jpg', original: 'same.jpg' }],
  })[0];
  assert.equal(imageItemHasOriginal(sameNamePhysicalOriginal), true, 'images/ 与 originals/ 分目录时同名仍是物理原图');
  const multiWithOriginalRoot = {
    image: 'first.jpg', original: 'first.png',
    images: [{ path: 'second.jpg', original: 'second.jpg' }],
  };
  assert.equal(imageItemHasOriginal(entryImages(multiWithOriginalRoot)[0], multiWithOriginalRoot), true);
  assert.equal(lightboxOriginalCopy('ready', true).tip, '可拖入 NovelAI 读取生成参数');
  assert.match(lightboxOriginalCopy('ready', false).tip, /不提供可读取的生成参数/);
  assert.match(lightboxOriginalCopy('failed', true).label, /失败/);
  assert.match(lightboxOriginalCopy('thumbnail', false).label, /仅缩略图/);
}

// 原生分享只在触屏设备启用；桌面即使暴露 navigator.share 也维持复制路径。
{
  const share = async () => {};
  assert.equal(canUseNativeShare({ maxTouchPoints: 0, share }, () => ({ matches: false })), false);
  assert.equal(canUseNativeShare({ maxTouchPoints: 1, share }, () => ({ matches: false })), true);
  assert.equal(canUseNativeShare({ maxTouchPoints: 0, share }, () => ({ matches: true })), true);
  assert.equal(canUseNativeShare({ maxTouchPoints: 1 }, () => ({ matches: true })), false);
}

// 锁滚同时覆盖根元素和 body，并可幂等解锁。
{
  setLightboxScrollLocked(true);
  assert.equal(document.documentElement.classList.contains('lightbox-open'), true);
  assert.equal(document.body.classList.contains('lightbox-open'), true);
  setLightboxScrollLocked(false);
  assert.equal(document.documentElement.classList.contains('lightbox-open'), false);
  assert.equal(document.body.classList.contains('lightbox-open'), false);
}

// 访问树与隐藏数共享 memo；同长度编辑只要 entries 换引用就必须失效。
{
  const entries = [
    { id: 'safe', path: ['A'], rating: 'safe' },
    { id: 'adult', path: ['NSFW'], rating: 'r18' },
    { id: 'gore', path: ['R18G'], rating: 'r18g' },
  ];
  state.codex = { id: 'memo', entryCount: 3, entries, emptyCategories: [] };
  state.codexes = [{ id: 'safe' }, { id: 'adult', nsfw: true }, { id: 'adult-2', nsfw: true }];
  state.allowNsfw = false;
  state.allowR18g = false;
  assert.equal(lockedCodexCount(), 2);
  const tree = visibleTree();
  assert.equal(visibleTree(), tree, '相同 entries 引用和访问开关应复用树对象');
  assert.equal(accessHiddenCount(), 2);
  assert.equal(visibleEntryCount(), 1);

  state.codex.entries = entries.map(entry => entry.id === 'safe' ? { ...entry, path: ['Edited'] } : { ...entry });
  const editedTree = visibleTree();
  assert.notEqual(editedTree, tree, '同长度的新 entries 数组必须让 memo 失效');
  assert.equal(editedTree[0].name, 'Edited');

  state.allowR18g = true;
  const r18gTree = visibleTree();
  assert.notEqual(r18gTree, editedTree, '访问开关变化必须让 memo 失效');
  assert.ok(r18gTree.some(node => node.name === 'R18G'));
  state.allowNsfw = true;
  assert.equal(accessHiddenCount(), 0);
  assert.equal(lockedCodexCount(), 0);

  // 编辑器仅改 rating 时会原地合并词条；显式失效入口覆盖这种引用不变的写路径。
  state.allowNsfw = false;
  assert.equal(accessHiddenCount(), 2);
  state.codex.entries[0].rating = 'r18';
  invalidateAccessViewMemo();
  assert.equal(accessHiddenCount(), 3);
}

// 反馈上下文只能在显式确认存在原图时打包 originalUrl，不能把缩略 fallback 误报成原图。
{
  state.favoritesView = false;
  state.siteSearchView = false;
  state.codex = {
    id: 'report',
    title: 'Report',
    assetPathMode: 'relative',
    assetBaseUrl: '/assets',
  };
  const entry = {
    id: 'thumb-only',
    title: 'Thumb only',
    image: 'thumb.jpg',
    images: [{ path: 'thumb.jpg', original: 'thumb.jpg', _hasOriginal: false }],
  };
  assert.equal(buildFeedbackContext({ entry }).entry.originalUrl, '');
  entry.images[0] = { ...entry.images[0], _hasOriginal: true };
  assert.match(buildFeedbackContext({ entry }).entry.originalUrl, /thumb\.jpg/);
}

// 快速密度循环不改变默认值；分类 rail 只为被裁切的 active 胶囊计算横向位移。
{
  assert.equal(nextDensity('standard'), 'compact');
  assert.equal(nextDensity('compact'), 'comfort');
  assert.equal(nextDensity('comfort'), 'standard');
  assert.equal(railRevealDelta({ left: 0, right: 100 }, { left: 12, right: 88 }), 0);
  assert.equal(railRevealDelta({ left: 0, right: 100 }, { left: -14, right: 42 }), -14);
  assert.equal(railRevealDelta({ left: 0, right: 100 }, { left: 72, right: 118 }), 18);
  assert.equal(imageSyntaxFilterValue({ isSyntax: true, hasImage: true }), true);
  assert.equal(imageSyntaxFilterValue({ isSyntax: true, hasImage: false }), false);
  assert.equal(imageSyntaxFilterValue({ isSyntax: false, hasImage: false }), null);
}

// 编辑器把当前书计数同步回选择器索引；零值也不能被旧计数吞掉。
{
  state.codexes = [{ id: 'counts', entryCount: 9, imagedCount: 8 }];
  assert.equal(syncCodexPickerCounts({ id: 'counts', entryCount: 0, imagedCount: 0 }), true);
  assert.deepEqual(state.codexes[0], { id: 'counts', entryCount: 0, imagedCount: 0 });
  assert.equal(syncCodexPickerCounts({ id: 'missing', entryCount: 1, imagedCount: 1 }), false);
}

// 新格式单段 path 用空参数作格式标记；旧 slash 链接继续走 legacy 解码。
{
  const originalSearch = location.search;
  const url = atlasUrlForRoute({ codex: 'book', path: ['r18g/重口'] });
  const generated = new URL(url, location.href);
  assert.deepEqual(generated.searchParams.getAll('path'), ['r18g/重口', '']);
  location.search = generated.search;
  assert.deepEqual(readUrlState().path, ['r18g/重口']);

  const searchUrl = atlasUrlForRoute({ codex: 'book', siteSearch: true, q: 'x', path: ['一级/分类'] });
  assert.deepEqual(new URL(searchUrl, location.href).searchParams.getAll('path'), ['一级/分类', '']);

  location.search = '?path=parent%2Fchild';
  assert.deepEqual(readUrlState().path, ['parent', 'child']);
  location.search = originalSearch;
}

// 外链仅允许绝对 HTTP(S)，反馈超时在旧浏览器没有 timeout() 时自然降级。
{
  assert.equal(safeHttpUrl(' https://example.test/a '), 'https://example.test/a');
  assert.equal(safeHttpUrl('http://example.test'), 'http://example.test');
  assert.equal(safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(safeHttpUrl('/relative'), '');
  assert.deepEqual(feedbackTimeoutSignal(321, { timeout: value => ({ value }) }), { value: 321 });
  assert.equal(feedbackTimeoutSignal(321, {}), undefined);
}

// 公告的瞬时失败不能冻结为空结果；下一次打开会重新发起请求。
{
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let calls = 0;
  console.warn = () => {};
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error('temporary offline');
    return {
      ok: true,
      status: 200,
      json: async () => [{ id: 'retry-ok', title: '恢复', body: '公告已恢复', date: '2026-07-27' }],
    };
  };
  try {
    assert.deepEqual(await loadAnnouncements(), []);
    assert.equal((await loadAnnouncements())[0].id, 'retry-ok');
    assert.equal(calls, 2);
    assert.equal((await loadAnnouncements())[0].id, 'retry-ok');
    assert.equal(calls, 2, '成功结果仍应缓存');
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
}

// 反馈弹层 Escape 必须在本层截断，防止同一击继续冒泡关闭灯箱。
{
  const handlers = new Map();
  const mask = {
    id: '',
    hidden: false,
    offsetWidth: 1,
    classList: fakeClassList(['show']),
    addEventListener(type, handler) { handlers.set(type, handler); },
    querySelectorAll: () => [],
  };
  dom.clear();
  dom.set('#feedbackPanel', mask);
  setupReport();
  let prevented = false;
  let stopped = false;
  handlers.get('keydown')({
    key: 'Escape',
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(mask.hidden, true);
}

// 私有 DOM 流程的关键接线以静态契约锁住，避免后续重构悄悄退回旧路径。
{
  const paths = [
    '../site/assets/app/data.js',
    '../site/assets/app/MODULE_MAP.md',
    '../site/assets/app/masonry.js',
    '../site/assets/app/lightbox.js',
    '../site/assets/app/codex-ui.js',
    '../site/assets/app/modal.js',
    '../site/assets/app/ui.js',
    '../site/assets/app/history.js',
    '../site/assets/app/onboarding.js',
    '../site/assets/app/announcements.js',
    '../site/assets/app/report.js',
    '../site/assets/app/edit.js',
    '../site/assets/app.js',
    '../site/index.html',
    '../site/assets/styles.css',
    '../site/assets/edit.css',
    './build_local_edition.py',
  ];
  const [
    dataSource,
    moduleMap,
    masonrySource,
    lightboxSource,
    codexUiSource,
    modalSource,
    uiSource,
    historySource,
    onboardingSource,
    announcementsSource,
    reportSource,
    editSource,
    appSource,
    indexSource,
    stylesSource,
    editCssSource,
    localEditionBuilderSource,
  ] = await Promise.all(paths.map(path => readFile(new URL(path, import.meta.url), 'utf8')));

  assert.doesNotMatch(dataSource, /export async function load(?:CodexIndex|Media|About)\b/);
  assert.match(moduleMap, /\| `data\.js` \| atomic bootstrap, codex loading, normalization/);
  assert.match(masonrySource, /import \{ updateReadingSpy \} from '\.\/codex-ui\.js';/);
  assert.match(lightboxSource, /const reuseThumbs = lbThumbEntry === e[\s\S]*if \(!reuseThumbs\) \{\s*thumbs\.innerHTML = '';/);
  assert.match(lightboxSource, /&& lbThumbState === lb/);
  assert.match(lightboxSource, /const safeCreditUrl = safeHttpUrl\(creditUrl\)/);
  assert.match(lightboxSource, /historyMode: 'replace', transition: 'detail'/);
  assert.match(lightboxSource, /error\?\.name === 'AbortError'/);
  assert.match(indexSource, /id="favoriteLightbox"[^>]*aria-pressed="false"/);
  assert.match(indexSource, /id="lightboxOriginalStatus"[^>]*aria-live="polite"/);
  assert.match(indexSource, /id="sdPositivePreview"[^>]*aria-pressed="false"[^>]*hidden/);
  assert.match(indexSource, /id="sdNegativePreview"[^>]*aria-pressed="false"[^>]*hidden/);
  assert.match(lightboxSource, /pre\.textContent = naiToSd\(source\)/);
  assert.match(indexSource, /id="homeShortcutBtn"[^>]*role="menuitem"[^>]*hidden/);
  assert.match(uiSource, /setupHomeShortcutGuide\(\)/);
  assert.match(indexSource, /class="search-match-chip" hidden/);
  assert.match(masonrySource, /hiddenSearchMatch\(e, highlightTerms\)/);
  assert.match(indexSource, /class="zoom-btn"[^>]*type="button"[^>]*aria-label="放大查看"/);
  assert.match(stylesSource, /html\.lightbox-open,body\.lightbox-open\{overflow:hidden;overscroll-behavior:none\}/);
  assert.match(stylesSource, /@media \(hover:none\), \(pointer:coarse\)\{[\s\S]*\.zoom-btn\{[\s\S]*width:44px;height:44px/);
  assert.match(codexUiSource, /function positionOpenBannerPop\(\) \{\s*if \(!bannerAboutOpen\) return;/);
  assert.match(codexUiSource, /const validLinks = safeExternalLinks\(links\)/);
  assert.match(codexUiSource, /const links = safeExternalLinks\(Array\.isArray\(c\.links\)/);
  assert.match(codexUiSource, /const url = safeHttpUrl\(l\.url\)/);
  assert.match(modalSource, /export function registerMaskHistory\(mask\)/);
  assert.match(uiSource, /querySelectorAll\('\.settings-mask\[id\], \.favorites-backup-mask\[id\]'\)[\s\S]*forEach\(registerMaskHistory\)/);
  assert.match(onboardingSource, /function finishOnboarding\(\) \{\s*try \{\s*localStorage\.setItem/);
  assert.match(onboardingSource, /export function openOnboarding\(\{ trigger = document\.activeElement, historyMode = 'push' \} = \{\}\)/);
  assert.equal((onboardingSource.match(/cls: 'obs-[1-4]'/g) || []).length, 4);
  assert.match(onboardingSource, /十本法典随时切，也能全站搜/);
  assert.match(onboardingSource, /点顶栏书名可在十本法典间切换/);
  assert.match(onboardingSource, /社区整理的 NovelAI 提示词法典图鉴/);
  assert.match(indexSource, /id="onboardingStep"[^>]*>1 \/ 4</);
  assert.equal((indexSource.match(/class="onboarding-dot(?: active)?"/g) || []).length, 4);
  assert.match(indexSource, /id="onboardingBtn"/);
  assert.match(uiSource, /onboardingBtn\.onclick = \(\) => \{[\s\S]*openOnboarding\(\{/);
  assert.match(indexSource, /id="communityBrowseLink"[^>]*href="\/strings\.html"/);
  assert.match(codexUiSource, /<span class="cd-name">社区共建 · 去投稿<\/span>/);
  assert.match(codexUiSource, /图片与提示词作品/);
  assert.doesNotMatch(codexUiSource, /这里是大家的画风串/);
  assert.match(localEditionBuilderSource, /body\.local-edition #communityBrowseLink,/);
  assert.match(localEditionBuilderSource, /body\.local-edition #onboardingBtn,/);
  assert.match(codexUiSource, /const hiddenCount = \(!state\.siteSearchView && !state\.favoritesView\) \? accessHiddenCount\(\) : 0;/);
  assert.match(codexUiSource, /另有 \$\{hiddenCount\} 条受限内容/);
  assert.match(codexUiSource, /另有 \$\{lockedBooks\} 本受限法典未解锁，未纳入全站搜索/);
  assert.match(codexUiSource, /查看未解锁范围[\s\S]*access-hint/);
  assert.match(reportSource, /image && imageItemHasOriginal\(image, entry\)/);
  assert.match(indexSource, /id="searchSyntaxHint"[\s\S]*path:构图[\s\S]*has:image[\s\S]*fav:true/);
  assert.match(stylesSource, /\.search-wrap:focus-within #search:placeholder-shown~\.search-syntax-hint/);
  assert.match(uiSource, /searchInput\.addEventListener\('compositionstart'/);
  assert.match(uiSource, /searchInput\.addEventListener\('compositionend'/);
  assert.match(uiSource, /if \(searchComposing \|\| e\.isComposing\)/);
  assert.match(indexSource, /id="sidebar"[\s\S]*id="sidebarBackdrop"[\s\S]*id="main"/);
  assert.match(stylesSource, /\.sidebar:not\(\.closed\)\+\.sidebar-backdrop\{[\s\S]*z-index:24[\s\S]*touch-action:none/);
  assert.match(stylesSource, /\.tree\{overscroll-behavior:contain\}/);
  assert.match(uiSource, /sidebarBackdrop\?\.addEventListener\('click', \(\) => \{\s*if \(closeHistoryLayer\('mobile-sidebar'\)\) return;/);
  assert.match(indexSource, /id="densityQuickBtn"/);
  assert.match(uiSource, /densityQuickBtn\.onclick = \(\) => applyDensity\(nextDensity\(state\.density\), \{ render: true, announce: true \}\)/);
  const railActiveSource = codexUiSource.match(/export function updateRailActive\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(railActiveSource, /rail\.scrollTo\(\{[\s\S]*left,[\s\S]*top: rail\.scrollTop/);
  assert.doesNotMatch(railActiveSource, /window\.scroll|scrollIntoView/);
  assert.match(indexSource, /id="onlyImagedResultBtn"[^>]*aria-pressed="false"/);
  assert.match(codexUiSource, /btn\.hidden = Boolean\(state\.onlyNew\)/);
  assert.match(codexUiSource, /搜索已限定有图/);
  assert.match(codexUiSource, /搜索已限定无图/);
  assert.match(appSource, /state\.onlyImaged && !state\.onlyNew && imageSyntaxFilterValue\(plan\) === null/);
  assert.equal((`${appSource}\n${codexUiSource}\n${historySource}\n${uiSource}`.match(/state\.onlyImaged\s*=/g) || []).length, 1);
  assert.match(historySource, /historyActions\.setOnlyImaged\(snapshot\.onlyImaged, \{ apply: false, syncHistory: false \}\)/);
  assert.match(announcementsSource, /function markVisibleAnnouncementsRead\(\) \{[\s\S]*try \{\s*localStorage\.setItem/);
  assert.equal((announcementsSource.match(/loaded = true/g) || []).length, 1);
  assert.equal((reportSource.match(/signal: feedbackTimeoutSignal\(\)/g) || []).length, 2);
  assert.match(reportSource, /const result = await writeClipboardText\(text\)/);
  assert.match(reportSource, /showClipboardFallback\(text, \{ trigger \}\)/);
  assert.doesNotMatch(reportSource, /document\.execCommand\('copy'\)/);
  assert.equal((editSource.match(/syncCodexPickerCounts\(\);/g) || []).length, 2);
  const toastZ = Number(stylesSource.match(/\.toast\s*\{[^}]*z-index:(\d+)/)?.[1]);
  const editMenuZ = Number(editCssSource.match(/\.edit-menu\s*\{[^}]*z-index:(\d+)/)?.[1]);
  assert.ok(toastZ > editMenuZ, `toast 层级必须高于编辑菜单（${toastZ} <= ${editMenuZ}）`);
}

console.log('render UI regressions: PASS');
