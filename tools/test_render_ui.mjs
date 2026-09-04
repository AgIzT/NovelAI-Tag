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
const documentListeners = new Map();
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
  baseURI: 'http://localhost/',
  activeElement: null,
  documentElement: { clientHeight: 800, scrollHeight: 2000, classList: fakeClassList() },
  body: { classList: fakeClassList() },
  addEventListener(type, listener, options) {
    const listeners = documentListeners.get(type) || [];
    listeners.push({ listener, once: Boolean(options?.once) });
    documentListeners.set(type, listeners);
  },
  dispatchEvent(event) {
    const listeners = documentListeners.get(event.type) || [];
    documentListeners.set(event.type, listeners.filter(record => !record.once));
    listeners.forEach(record => record.listener(event));
    return true;
  },
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
  lightboxOriginalAction,
  lightboxOriginalCopy,
  preloadImage,
  preloadLightboxNeighbors,
  shareUrlForEntry,
  setLightboxScrollLocked,
} = await import('../site/assets/app/lightbox.js');
const { entryImages, imageItemHasOriginal } = await import('../site/assets/app/media.js');
const {
  entryImageCanUseOriginal,
  entrySourceAllowsOriginal,
} = await import('../site/assets/app/original-capability.js');
const {
  codexUpdateFilters,
  entryMatchesUpdateFilter,
  normalizeImageList,
  resolveUpdateFilter,
  updateFilterDefinitions,
} = await import('../site/assets/app/data.js');
const {
  accessHiddenCount,
  codexBannerCoverEntry,
  invalidateAccessViewMemo,
  isN5LaunchCodex,
  lockedCodexCount,
  railRevealDelta,
  renderCodexChips,
  syncCodexPickerCounts,
  visibleEntryCount,
  visibleTree,
} = await import('../site/assets/app/codex-ui.js');
const { nextDensity } = await import('../site/assets/app/ui.js');
const { buildFeedbackContext, feedbackTimeoutSignal, setupReport } = await import('../site/assets/app/report.js');
const { safeHttpUrl } = await import('../site/assets/app/utils.js');
const {
  atlasUrlForRoute,
  documentTitleForRoute,
  openEntryDeepLink,
  readUrlState,
  setRouterActions,
  syncUrlState,
} = await import('../site/assets/app/router.js');
const { loadAnnouncements } = await import('../site/assets/app/announcements.js');

// 法典选择器与详情横幅共用 cover 元数据；首条词条只作为无封面时的兜底。
{
  const firstEntry = { id: 'first', image: 'first.jpg', assetRev: 'first-rev' };
  assert.deepEqual(
    codexBannerCoverEntry({
      cover: 'chosen.jpg',
      coverRev: 'chosen-rev',
      coverCodexId: 'shared-assets',
      entries: [firstEntry],
    }),
    { image: 'chosen.jpg', assetRev: 'chosen-rev', assetCodexId: 'shared-assets' },
  );
  assert.equal(codexBannerCoverEntry({ entries: [firstEntry] }), firstEntry);
  assert.equal(codexBannerCoverEntry({ entries: [] }), null);
}

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

  state.codexes = [];
  state.codex = {
    id: 'book', hasOriginal: true,
    assetPathMode: 'relative', assetBaseUrl: 'https://assets.test',
  };
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

  state.codex = {
    id: 'thumb-book', hasOriginal: false,
    assetPathMode: 'relative', assetBaseUrl: 'https://assets.test',
  };
  state.lightbox = {
    entry: { id: 'thumb-entry', assetRev: 'r2' },
    index: 0,
    images: [
      { path: 'only-thumb-0.jpg', original: 'blocked-original-0.png' },
      { path: 'only-thumb-1.jpg', original: 'blocked-original-1.png' },
      { path: 'only-thumb-2.jpg', original: 'blocked-original-2.png' },
    ],
  };
  const beforeNoOriginalNeighbors = images.length;
  preloadLightboxNeighbors();
  assert.equal(
    images.length,
    beforeNoOriginalNeighbors + 2,
    '无原图法典的邻图只能预热缩略图，不能后台请求 original',
  );
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
  const sharedNavigation = lightboxNavigationContext(last);
  assert.deepEqual(
    { ...sharedNavigation, entries: undefined },
    { entries: undefined, index: 1, position: 2, total: 2 },
  );
  let accessReads = 0;
  const counted = state.list.map(entry => ({
    ...entry,
    get rating() {
      accessReads += 1;
      return entry.rating;
    },
  }));
  const countedEntry = counted.at(-1);
  const countedBox = { entry: countedEntry, images: entryImages(countedEntry), index: 0 };
  const countedNavigation = lightboxNavigationContext(countedEntry, counted);
  const readsAfterContext = accessReads;
  getLightboxStepTarget(-1, countedBox, counted, countedNavigation);
  getLightboxStepTarget(1, countedBox, counted, countedNavigation);
  assert.equal(
    accessReads,
    readsAfterContext,
    '同一轮 render 的前后目标必须复用 nav context，不再重复扫描访问状态',
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
  const physicalOriginal = { path: 'thumb.jpg', original: 'source.png', _hasOriginal: true };
  state.codexes = [
    { id: 'with-original', hasOriginal: true },
    { id: 'without-original', hasOriginal: false },
  ];
  state.codex = { id: 'virtual-view', hasOriginal: true };
  assert.equal(
    entrySourceAllowsOriginal({ _srcCodexId: 'without-original' }),
    false,
    '虚拟视图必须服从词条真实来源，不能被聚合法典的 true 放行',
  );
  assert.equal(
    entryImageCanUseOriginal({ _srcCodexId: 'without-original' }, physicalOriginal),
    false,
    '法典显式无原图时，遗留 original 字段不得越权',
  );
  assert.equal(
    entryImageCanUseOriginal({ _srcCodexId: 'with-original' }, physicalOriginal),
    true,
    '含原图法典的显式物理原图仍可用',
  );
  assert.equal(
    entryImageCanUseOriginal({ _srcCodexId: 'with-original' }, { path: 'thumb.jpg' }),
    false,
    '含原图法典仍需逐张确认物理 original',
  );
  assert.equal(lightboxOriginalCopy('ready', true).tip, '可拖入 NovelAI 读取生成参数');
  assert.match(lightboxOriginalCopy('ready', false).tip, /不提供可读取的生成参数/);
  assert.match(lightboxOriginalCopy('failed', true).label, /失败/);
  assert.match(lightboxOriginalCopy('thumbnail', false).label, /仅缩略图/);
  assert.equal(lightboxOriginalCopy('unavailable', false).label, '无原图');
  assert.deepEqual(
    lightboxOriginalAction(false, false),
    { disabled: true, label: '无原图', title: '本法典不提供原图' },
  );
  assert.deepEqual(
    lightboxOriginalAction(true, true),
    { disabled: false, label: '查看原图', title: '在新标签页查看原图' },
  );
}

// 原生分享只在触屏设备启用；桌面即使暴露 navigator.share 也维持复制路径。
{
  const share = async () => {};
  assert.equal(canUseNativeShare({ maxTouchPoints: 0, share }, () => ({ matches: false })), false);
  assert.equal(canUseNativeShare({ maxTouchPoints: 1, share }, () => ({ matches: false })), false);
  assert.equal(canUseNativeShare({ maxTouchPoints: 0, share }, () => ({ matches: true })), true);
  assert.equal(canUseNativeShare({ maxTouchPoints: 1, share }, null), true);
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

  state.codex.entries = [
    { id: 'mixed-safe', path: ['Mixed', 'Safe'], rating: 'safe' },
    { id: 'mixed-adult', path: ['Mixed', 'Adult'], rating: 'r18' },
  ];
  invalidateAccessViewMemo();
  const mixedTree = visibleTree();
  assert.equal(mixedTree[0].locked, false, '含安全条目的混合父目录不能被 NSFW 子目录连坐锁定');
  assert.equal(mixedTree[0].children.find(node => node.name === 'Safe').locked, false);
  assert.equal(mixedTree[0].children.find(node => node.name === 'Adult').locked, true);

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
    hasOriginal: true,
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
  state.codex.hasOriginal = false;
  assert.equal(
    buildFeedbackContext({ entry }).entry.originalUrl,
    '',
    '无原图法典不能在反馈上下文中泄露遗留 original 字段',
  );
}

// 快速密度循环不改变默认值；分类 rail 只为被裁切的 active 胶囊计算横向位移。
{
  assert.equal(nextDensity('standard'), 'compact');
  assert.equal(nextDensity('compact'), 'comfort');
  assert.equal(nextDensity('comfort'), 'standard');
  assert.equal(railRevealDelta({ left: 0, right: 100 }, { left: 12, right: 88 }), 0);
  assert.equal(railRevealDelta({ left: 0, right: 100 }, { left: -14, right: 42 }), -14);
  assert.equal(railRevealDelta({ left: 0, right: 100 }, { left: 72, right: 118 }), 18);
}

// 更新批次由索引声明、词条登记；latest 兼容旧 isNew，多个按钮共享一个互斥状态。
{
  const meta = {
    id: 'updates', version: '2026.8.14', newFilterLabel: '本次8.14更新',
    updateFilters: [
      { id: '2026.7.15', label: '7.15更新' },
      { id: '2026.8.14', label: '8.14更新', latest: true },
    ],
  };
  const codex = {
    id: 'updates',
    entries: [
      { id: 'old', updateBatches: ['2026.7.15'] },
      { id: 'new', updateBatches: ['2026.8.14'], isNew: true },
    ],
  };
  state.codexes = [meta];
  const filters = codexUpdateFilters(codex);
  assert.deepEqual(filters.map(({ id, label, latest, count }) => ({ id, label, latest, count })), [
    { id: '2026.7.15', label: '7.15更新', latest: false, count: 1 },
    { id: '2026.8.14', label: '8.14更新', latest: true, count: 1 },
  ]);
  assert.equal(resolveUpdateFilter(codex, 'latest'), '2026.8.14');
  assert.equal(resolveUpdateFilter(codex, 'missing'), '');
  assert.equal(entryMatchesUpdateFilter(codex.entries[0], filters[0]), true);
  assert.deepEqual(updateFilterDefinitions({ version: '2026.8.14', newFilterLabel: '本次8.14更新' }), [
    { id: '2026.8.14', label: '8.14更新', latest: true },
  ]);
}

// 法典书卡状态签顺序：原图能力必显，NSFW 第二，更新日期最后；旧 R18 文案不得回流。
{
  assert.equal(isN5LaunchCodex({ id: 'artist_nai5_personal' }), true);
  assert.equal(isN5LaunchCodex({ id: 'nai5_community_pack' }), true);
  assert.equal(isN5LaunchCodex({ id: 'artist_nai45_personal' }), false);

  const full = renderCodexChips({
    hasOriginal: true,
    nsfw: true,
    dataUrl: 'https://example.com/codex.json',
    version: '2026.8.26',
    newFilterLabel: '本次8.26更新',
  });
  const originalAt = full.indexOf('含原图');
  const nsfwAt = full.indexOf('NSFW');
  const externalAt = full.indexOf('外部源');
  const updateAt = full.indexOf('8.26更新');
  assert.ok(originalAt >= 0 && originalAt < nsfwAt, '含原图必须是第一枚状态签');
  assert.ok(nsfwAt < externalAt && externalAt < updateAt, 'NSFW 后接其他状态，更新日期必须最后');
  assert.match(full, /orig has-orig/);
  assert.doesNotMatch(full, />R18</);

  const withoutOriginal = renderCodexChips({ hasOriginal: false, version: '2026.8.26' });
  assert.match(withoutOriginal, /orig no-orig[^>]*>无原图</);
  assert.doesNotMatch(withoutOriginal, /NSFW/);

  const chipStyles = await readFile(new URL('../site/assets/styles.css', import.meta.url), 'utf8');
  // 2026-08-27 起状态签中性化：四档靠形态区分，红/绿/琥珀写死色值不允许回潮。
  assert.match(chipStyles, /\.ci-chip\{[^}]*border:1px solid var\(--line\);background:transparent;color:var\(--muted\)/);
  assert.match(chipStyles, /\.ci-chip\.nsfw,\.ci-chip\.lock\{border-color:var\(--text\);color:var\(--text\)\}/);
  assert.doesNotMatch(chipStyles, /\.ci-chip\.(?:orig\.has-orig|nsfw)\{color:#/, '状态签不得再写死配色');
  // ⚠ 含原图必须实底、无原图必须描边——两枚同色是 2026-08-27 修过一次的回归。
  assert.match(chipStyles, /\.ci-chip\.has-orig\{border-color:transparent;background:rgba\(29,29,31,\.07\);color:var\(--text\)\}/);
  assert.match(chipStyles, /body\.dark \.ci-chip\.has-orig\{background:rgba\(255,255,255,\.1\)\}/);
  assert.match(chipStyles, /\.ci-chip\.new\{border-color:var\(--accent\);color:var\(--accent\)\}/, '时效签走描边强调色，别退回最底档');
  assert.match(chipStyles, /\.data-pill\.has-orig\{color:var\(--text\);background:rgba\(29,29,31,\.07\)/, '横幅原图签要跟书卡同一套');
  assert.doesNotMatch(chipStyles, /\.data-pill\.has-orig\{color:#356b64/, '横幅原图签不得回到绿底');
  assert.doesNotMatch(chipStyles, /\.ci-chip\.orig\{display:none\}/, '窄屏也必须保留原图状态签');

  // V5 上线版面的美术契约：唯一强调色只给 eyebrow，版面内禁止渐变/玻璃，书卡靠纯黑药丸而非发光底。
  assert.match(chipStyles, /\.ci-n5-chip\{[^}]*background:#1d1d1f;color:#fff/);
  assert.doesNotMatch(chipStyles, /\.codex-item\.n5-highlight/, 'V5 书卡不再用底色渐变突出');
  const launchBlock = chipStyles.slice(
    chipStyles.indexOf('.n5-launch-panel,.n5-launch-notice{'),
    chipStyles.indexOf('/* ── 书卡'));
  assert.ok(launchBlock.length > 500, '没定位到 V5 版面样式块');
  assert.doesNotMatch(launchBlock, /gradient|backdrop-filter/, 'V5 版面禁止渐变与玻璃拟态');
  const menuRule = chipStyles.slice(chipStyles.indexOf('.codex-menu{'), chipStyles.indexOf('}', chipStyles.indexOf('.codex-menu{')));
  assert.match(menuRule, /background:var\(--panel\)/);
  assert.doesNotMatch(menuRule, /backdrop-filter/, '选择器面板已去玻璃');

  const codexUiSource = await readFile(new URL('../site/assets/app/codex-ui.js', import.meta.url), 'utf8');
  assert.match(codexUiSource, /NEW · NOVELAI V5/);
  assert.match(codexUiSource, /class="ci-n5-chip">V5</);
  assert.doesNotMatch(codexUiSource, /NOVELAI 5/, '对外文案统一叫 V5');

  const settingsSource = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.match(settingsSource, /显示 NSFW 内容/);
  assert.doesNotMatch(settingsSource, /允许 NSFW 法典展示/);
}

// 编辑器把当前书计数同步回选择器索引；零值也不能被旧计数吞掉。
{
  state.codexes = [{ id: 'counts', entryCount: 9, imagedCount: 8 }];
  assert.equal(syncCodexPickerCounts({ id: 'counts', entryCount: 0, imagedCount: 0 }), true);
  assert.deepEqual(state.codexes[0], { id: 'counts', entryCount: 0, imagedCount: 0 });
  assert.equal(syncCodexPickerCounts({ id: 'missing', entryCount: 1, imagedCount: 1 }), false);
}

/* 地址栏写的是短链：目录发短码、词条发 /share/。旧的 codex= / path= 链接只读不写。
   衡量标准就是"用户直接复制地址栏"那条串——中文逐字 percent-encode 会撑到两百字符。 */
{
  const originalSearch = location.search;
  const originalPathname = location.pathname;
  const originalBaseURI = document.baseURI;

  const url = atlasUrlForRoute({ codex: 'book', path: ['r18g/重口', '二级'] });
  const generated = new URL(url, location.href);
  assert.deepEqual(generated.searchParams.getAll('path'), [], '不再往 URL 里塞中文目录名');
  assert.equal(generated.searchParams.get('c'), 'book');
  assert.match(generated.searchParams.get('p'), /^[0-9a-z]+$/, '短码只用 ASCII');
  assert.ok(generated.href.length < 60, `短链不该超过 60 字符，实际 ${generated.href.length}`);
  location.search = generated.search;
  assert.equal(readUrlState().codex, 'book');
  assert.equal(readUrlState().pathCode, generated.searchParams.get('p'));

  // 词条深链走 /share/<法典>/<词条>：这条路由带 OG 卡
  const entryUrl = atlasUrlForRoute({ codex: 'book', entry: 'book-0001', path: ['分类'] });
  assert.equal(entryUrl, '/share/book/book-0001');
  location.pathname = '/share/book/book-0001';
  location.search = '';
  assert.equal(readUrlState().codex, 'book');
  assert.equal(readUrlState().entry, 'book-0001');
  location.pathname = originalPathname;

  // 静态子路径没有 /share Function；必须退回可刷新、可直接分享的查询参数路由。
  document.baseURI = 'http://localhost/NovelAI-Tag/';
  const subpathEntryUrl = atlasUrlForRoute({ codex: 'book', entry: 'book-0001', path: ['分类'] });
  const subpathEntry = new URL(subpathEntryUrl, location.href);
  assert.equal(subpathEntry.pathname, '/NovelAI-Tag/');
  assert.equal(subpathEntry.searchParams.get('c'), 'book');
  assert.equal(subpathEntry.searchParams.get('entry'), 'book-0001');
  assert.match(subpathEntry.searchParams.get('p'), /^[0-9a-z]+$/);
  location.pathname = subpathEntry.pathname;
  location.search = subpathEntry.search;
  assert.equal(readUrlState().codex, 'book');
  assert.equal(readUrlState().entry, 'book-0001');
  document.baseURI = originalBaseURI;
  location.pathname = originalPathname;

  // 收藏 / 全站搜索是私人视图，换成 /share/ 会把上下文丢给收链接的人
  const favUrl = atlasUrlForRoute({ codex: 'book', favorites: true, entry: 'book-0001' });
  assert.equal(new URL(favUrl, location.href).pathname, '/');
  assert.equal(new URL(favUrl, location.href).searchParams.get('entry'), 'book-0001');

  const searchUrl = atlasUrlForRoute({ codex: 'book', siteSearch: true, q: 'x', path: ['一级/分类'] });
  assert.deepEqual(new URL(searchUrl, location.href).searchParams.getAll('path'), []);
  assert.ok(new URL(searchUrl, location.href).searchParams.get('p'));

  const updateUrl = atlasUrlForRoute({ codex: 'book', updateFilter: '2026.7.15' });
  assert.equal(new URL(updateUrl, location.href).searchParams.get('update'), '2026.7.15');
  location.search = '?new=1';
  assert.equal(readUrlState().updateFilter, 'latest');

  // 老链接三种形态继续能开
  location.search = '?path=parent%2Fchild';
  assert.deepEqual(readUrlState().path, ['parent', 'child'], '旧 slash 形态');
  location.search = '?path=r18g%2F%E9%87%8D%E5%8F%A3&path=';
  assert.deepEqual(readUrlState().path, ['r18g/重口'], '旧分段形态的空值标记');
  location.search = '?codex=book&entry=book-0001';
  assert.equal(readUrlState().codex, 'book', '旧 codex= 参数');
  assert.equal(readUrlState().entry, 'book-0001');

  location.search = originalSearch;
}

// 灯箱切词条、关闭以及 history restore 期间都要刷新标题；不能沿用 Function 注入的首条标题。
{
  const previous = {
    codex: state.codex,
    browseCodex: state.browseCodex,
    lightbox: state.lightbox,
    favoritesView: state.favoritesView,
    siteSearchView: state.siteSearchView,
    suppressUrlSync: state.suppressUrlSync,
    title: document.title,
  };
  const first = { id: 'book-0001', title: '第一条' };
  const second = { id: 'book-0002', title: '第二条' };
  state.codex = { id: 'book', title: '测试法典', entries: [first, second] };
  state.lightbox = { entry: first, images: [], index: 0 };
  state.favoritesView = false;
  state.siteSearchView = false;
  state.suppressUrlSync = true;
  document.title = '服务端注入的旧标题';

  syncUrlState({ entry: first.id, historyMode: 'none', saveBrowse: false });
  assert.equal(document.title, '第一条 · 测试法典 | 法典图鉴');
  syncUrlState({ entry: second.id, historyMode: 'none', saveBrowse: false });
  assert.equal(document.title, '第二条 · 测试法典 | 法典图鉴');
  syncUrlState({ entry: '', historyMode: 'none', saveBrowse: false });
  assert.equal(document.title, '法典图鉴 · NovelAI 提示词');

  // 收藏/全站搜索是合成法典，详情标题必须沿用词条的真实来源书名。
  const virtualEntry = {
    id: 'community_ai_misc-0001',
    title: '来源词条',
    _srcCodexId: 'community_ai_misc',
    _srcCodexTitle: '社区 AI 杂图',
  };
  const virtualCodex = { id: 'favorites', title: '全部收藏', entries: [virtualEntry] };
  assert.equal(
    documentTitleForRoute({ codex: 'nai45_community_pack', favorites: true, entry: virtualEntry.id }, virtualCodex),
    '来源词条 · 社区 AI 杂图 | 法典图鉴',
  );

  Object.assign(state, {
    codex: previous.codex,
    browseCodex: previous.browseCodex,
    lightbox: previous.lightbox,
    favoritesView: previous.favoritesView,
    siteSearchView: previous.siteSearchView,
    suppressUrlSync: previous.suppressUrlSync,
  });
  document.title = previous.title;
}

// 显式分享按钮与地址栏共用同一生成器：根部署发 /share，子路径部署发查询参数链接。
{
  const previousCodexes = state.codexes;
  const previousCodex = state.codex;
  const previousBrowseCodex = state.browseCodex;
  const previousFavoritesView = state.favoritesView;
  const previousSiteSearchView = state.siteSearchView;
  const originalBaseURI = document.baseURI;
  state.codexes = [{ id: 'book', aliases: [] }];
  state.codex = { id: 'book', entries: [] };
  state.browseCodex = state.codex;
  state.favoritesView = false;
  state.siteSearchView = false;

  document.baseURI = 'http://localhost/';
  assert.equal(shareUrlForEntry({ id: 'book-0001' }), 'http://localhost/share/book/book-0001');
  document.baseURI = 'http://localhost/NovelAI-Tag/';
  const subpathShare = new URL(shareUrlForEntry({ id: 'book-0001' }));
  assert.equal(subpathShare.pathname, '/NovelAI-Tag/');
  assert.equal(subpathShare.searchParams.get('c'), 'book');
  assert.equal(subpathShare.searchParams.get('entry'), 'book-0001');

  // 合并册规范化书级 alias，但真实来源词条 ID（旧前缀）不能被改写。
  state.codexes = [{ id: 'nai45_community_pack', aliases: ['community_ai_misc'] }];
  state.codex = { id: 'nai45_community_pack', entries: [] };
  state.browseCodex = state.codex;
  document.baseURI = 'http://localhost/';
  assert.equal(
    shareUrlForEntry({ _srcCodexId: 'community_ai_misc', id: 'community_ai_misc-0001' }),
    'http://localhost/share/nai45_community_pack/community_ai_misc-0001',
  );

  state.codexes = previousCodexes;
  state.codex = previousCodex;
  state.browseCodex = previousBrowseCodex;
  state.favoritesView = previousFavoritesView;
  state.siteSearchView = previousSiteSearchView;
  document.baseURI = originalBaseURI;
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
  assert.match(moduleMap, /\| `data\.js` \| 引导数据、法典加载、规范化/);
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
  assert.match(appSource, /state\.allowNsfw = localStorage\.getItem\(NSFW_STORAGE_KEY\) === '1';[\s\S]*if \(state\.allowNsfw\) localStorage\.setItem\(ADULT_CONFIRMATION_STORAGE_KEY, '1'\)/);
  assert.match(uiSource, /localStorage\.setItem\(ADULT_CONFIRMATION_STORAGE_KEY, '1'\)/);
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
  assert.match(reportSource, /image && entryImageCanUseOriginal\(entry, image\)/);
  assert.match(lightboxSource, /return entryImageCanUseOriginal\(entry, item\);/);
  assert.match(indexSource, /rel="modulepreload" href="assets\/app\/original-capability\.js"/);
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
  assert.match(indexSource, /id="updateFilterControls"[^>]*hidden/);
  assert.doesNotMatch(indexSource, /onlyImaged|只看有图/);
  assert.match(codexUiSource, /className = `update-filter-btn\$\{filter\.latest \? ' is-latest' : ''\}`/);
  assert.match(codexUiSource, /if \(filter\.latest\) \{[\s\S]*mark\.textContent = 'NEW'/);
  assert.match(uiSource, /closest\?\.\('\[data-update-filter\]'\)/);
  assert.match(appSource, /entryMatchesUpdateFilter\(entry, updateFilter\)/);
  assert.doesNotMatch(`${appSource}\n${codexUiSource}\n${historySource}\n${uiSource}`, /state\.onlyImaged|setOnlyImaged/);
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

// 角色词拆进 characterPrompts 之后的复制契约：一键复制 = 正面 + 角色词内容、去掉 char1： 标记，
// 等于拆分前的原文减去标记（只给正面会让 623 条词条只剩两三个 tag，复刻不出图）。
// 卡片预览与一键复制共用同一个文本源。见 tools/migrate_suozhang_char_prompts.py。
{
  const { combinedPrompt, combinedPromptLabel, entryPromptText } = await import('../site/assets/app/copy.js');
  const normal = {
    title: 'a',
    tags: '1girl,indoor,',
    characterPrompts: [{ label: 'char1', prompt: 'girl,blush,' }, { label: 'char2', prompt: 'boy,' }],
  };
  assert.equal(entryPromptText(normal), '1girl,indoor,\ngirl,blush,\nboy,');
  assert.equal(combinedPromptLabel(normal), '正向+角色词');
  assert.equal(combinedPrompt(normal), '1girl,indoor,\n\nchar1:\ngirl,blush,\n\nchar2:\nboy,');

  // ⚠ 角色级负面（character N uc 拆出来的 11 个框）绝不能混进正面串
  const withCharNegative = {
    title: 'e',
    tags: 'scene,',
    characterPrompts: [{ label: 'char1', prompt: 'girl,', negative: 'calm face,ugly,deformed,' }],
  };
  assert.equal(entryPromptText(withCharNegative), 'scene,\ngirl,');
  assert.doesNotMatch(entryPromptText(withCharNegative), /ugly|deformed/);
  assert.equal(combinedPromptLabel(withCharNegative), '正向+角色词+负面');

  // 整条都是角色词的词条（所长两本共 372 条）：不能复制出空串，也不带标签
  const charOnly = { title: 'b', tags: '', characterPrompts: [{ label: 'char1', prompt: 'school uniform,' }] };
  assert.equal(entryPromptText(charOnly), 'school uniform,');

  const plain = { title: 'c', tags: '1girl,' };
  assert.equal(entryPromptText(plain), '1girl,');
  assert.equal(combinedPromptLabel(plain), '正向');
  assert.equal(combinedPromptLabel({ ...normal, negative: 'bad anatomy' }), '正向+角色词+负面');
  assert.equal(entryPromptText({ title: 'd', tags: '' }), '');
  assert.equal(entryPromptText({ title: 'd', tags: '', characterPrompts: [{ label: 'char1', prompt: '' }] }), '');

  // 高度预估、卡片渲染、一键复制必须共用同一个文本源，否则预览和剪贴板对不上、布局也会算错。
  const masonrySource = await readFile(new URL('../site/assets/app/masonry.js', import.meta.url), 'utf8');
  assert.match(masonrySource, /estimateTagLines\(entryPromptText\(e\), contentWidth, cfg\)/);
  assert.match(masonrySource, /renderHighlightedText\(node\.querySelector\('\.card-tags'\), entryPromptText\(e\), highlightTerms\)/);
  const indexSource = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.match(indexSource, /<span class="badge-char" hidden>角色词<\/span>/);
  assert.match(indexSource, /<span class="badge-char-chip" hidden title="含角色词">角色词<\/span>/);
  assert.match(masonrySource, /charBadge\.hidden = !\(hasImage && charPrompts\.length\)/);
  assert.match(masonrySource, /charChip\.hidden = hasImage \|\| !charPrompts\.length/);
  const stylesSource = await readFile(new URL('../site/assets/styles.css', import.meta.url), 'utf8');
  for (const selector of ['.badge-char{', '.badge-char-chip{', 'body.dark .badge-char{', 'body.dark .badge-char-chip{']) {
    assert.ok(stylesSource.includes(selector), `styles.css 缺少 ${selector}`);
  }
  // 带动作的 toast 会承载中转站撤销；长标题也不得把胶囊撑出视口或撑成 58px 高的大框。
  assert.match(stylesSource, /\.toast\{[\s\S]*max-width:min\(360px,calc\(100vw - 24px\)\)/);
  assert.match(stylesSource, /\.toast\.has-action\{[\s\S]*min-height:44px[\s\S]*padding:4px 6px 4px 14px/);
  assert.match(stylesSource, /\.toast\.has-action \.toast-message\{[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/);
}

// 中转站侧栏契约：窄桌面不再硬停靠；所有确认留在侧栏内。
// ⚠ 2026-08-20 一屏化后，「素材拖拽」这条禁令作废并反转：当初禁它是因为素材与编排
//    是互斥页签，拖到一半目标页签根本不在屏上；现在两个分区同屏，拖拽是可完成的，
//    反而成了必须保证的入口（用户实测反馈：素材不能拖、方案块能拖却什么也不会发生）。
{
  const [relaySource, composeSource, railSource, actionSource, copyFxSource, relayCss, stylesSource, indexSource] = await Promise.all([
    '../site/assets/app/tag-relay.js',
    '../site/assets/app/tag-relay-compose.js',
    '../site/assets/app/tag-relay-rail.js',
    '../site/assets/app/tag-relay-action.js',
    '../site/assets/app/copy-fx.js',
    '../site/assets/tag-relay.css',
    '../site/assets/styles.css',
    '../site/index.html',
  ].map(path => readFile(new URL(path, import.meta.url), 'utf8')));
  assert.doesNotMatch(`${relaySource}\n${composeSource}`, /window\.(?:prompt|confirm)\s*\(/);
  // 页签已经不存在了：存在任何一个 role=tab 指向分区，就说明一屏化被改回去了。
  assert.doesNotMatch(indexSource, /data-rail-tab/);
  // 素材必须可拖，且载荷是带类型的快照（收藏来源不在 relayInbox 里，按 key 回查会落空）。
  assert.match(relaySource, /chip\.draggable = !locked/);
  assert.match(relaySource, /setData\(RELAY_SOURCE_MIME, JSON\.stringify\(entry\)\)/);
  // 同一词条在一个方案里只占一个槽位；完整 / 仅负向先冻结同一身份，重复分支不能给撤销。
  const addSourceBody = composeSource.slice(
    composeSource.indexOf('export async function addSourceToPlan'),
    composeSource.indexOf('/* 手写块：'),
  );
  assert.match(addSourceBody, /const relayKey = stableEntryKey\(entry\)/);
  assert.doesNotMatch(addSourceBody, /allowDuplicate/);
  assert.match(addSourceBody, /action\.result\.added === false[\s\S]*已在当前方案中/);
  assert.match(addSourceBody, /toast\(negativeOnly \? '已仅加入负向' : '已加入方案', '\+', \{/);
  // main 同时承载拖拽与选择，删除是真实同级按钮；外壳不能 draggable，否则从 × 起拖时
  // 部分浏览器会把祖先卡片当拖拽源，反过来又让直接删除变成误操作入口。
  assert.match(composeSource, /main\.draggable = !locked/);
  assert.doesNotMatch(composeSource, /card\.draggable = !locked/);
  assert.match(composeSource, /card\.setAttribute\('role', 'group'\)/);
  assert.match(composeSource, /main\.className = 'tag-relay-plan-card-main'[\s\S]*main\.setAttribute\('role', 'button'\)/);
  assert.match(composeSource, /remove\.className = 'tag-relay-plan-card-remove'[\s\S]*removeBlock\(item\.id, \{ planId: cardPlanId \}\)/);
  assert.doesNotMatch(indexSource, /data-block-tool="remove"/);
  assert.doesNotMatch(composeSource, /main\.className = 'tag-relay-chip-main'/);
  // footer 是 compose 的兄弟：格式/连接必须从整条 rail 取；行为差异另由 access 测试驱动。
  assert.match(composeSource, /formatButtons:\s*\[\.\.\.scope\.querySelectorAll\('\[data-format\]'\)\]/);
  assert.match(composeSource, /joinButtons:\s*\[\.\.\.scope\.querySelectorAll\('\[data-join\]'\)\]/);
  // drop 进入 Web Lock 前必须把 ID 抄到局部变量，事务闭包不能再读取会被 dragend 清空的全局值。
  assert.match(composeSource, /const draggedId = event\.dataTransfer\?\.getData\(RELAY_PLAN_MIME\) \|\| dragBlockId;[\s\S]*movePlanItem\(next, targetPlanId, draggedId, targetIndex\)/);
  // 方案头只留「N 个块」一份计数；格式/连接各自成组，窄屏换行也不会拆散标签与控件。
  assert.doesNotMatch(indexSource, /tagRelayComposeCount/);
  assert.equal((indexSource.match(/class="tag-relay-output-option-group"/g) || []).length, 2);
  assert.match(relayCss, /\.tag-relay-rail \.tag-relay-plan-lane\{[\s\S]*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(relayCss, /\.tag-relay-plan-card-body\{[\s\S]*display:flex;align-items:center/);
  assert.match(composeSource, /event\.clientY < rect\.top \+ rect\.height \/ 2/);
  assert.match(relayCss, /\.tag-relay-rail \.tag-relay-zone-source\{[^}]*min-height:88px/);
  assert.match(relayCss, /\.tag-relay-primary:disabled,\.tag-relay-secondary:disabled/);
  assert.match(relaySource, /tag-relay-chip-negative/);
  // 素材区、法典正文与抽屉遮罩都接收显式方案 drop；载荷固定来源方案，取消拖拽不删除。
  assert.match(composeSource, /setData\(RELAY_PLAN_CONTEXT_MIME/);
  assert.match(relaySource, /document\.querySelector\('#main'\)/);
  assert.match(relaySource, /document\.querySelector\('#tagRelayRailBackdrop'\)/);
  // 移出目标只接收 drop，不给万卡主区切 class / 画提示框，以免 dragover 重绘拖慢松手提交。
  assert.doesNotMatch(relaySource, /is-relay-remove-target/);
  assert.doesNotMatch(relayCss, /is-relay-remove-target|松手移出方案/);
  assert.match(railSource, /matchMedia\('\(max-width:1240px\)'\)/);
  assert.match(relayCss, /@media \(max-width:1240px\)/);
  assert.match(actionSource, /export function requestRelayAction/);
  assert.match(indexSource, /id="relayInlineAction"/);
  assert.match(indexSource, /rel="modulepreload" href="assets\/app\/tag-relay-action\.js"/);
  // 浮动入口沿用全局圆钮材质并排在最上方；收入反馈在开栏时必须落向「最近复制」。
  assert.ok(indexSource.indexOf('id="tagRelayBtn"') < indexSource.indexOf('id="randomBtn"'));
  assert.match(relayCss, /\.tag-relay-float-btn\{transform:translateY\(-52px\)\}/);
  assert.match(relayCss, /\.float-actions\.has-backtop \.tag-relay-float-btn\{transform:translateY\(-104px\)\}/);
  assert.match(relayCss, /@media \(max-width:600px\)\{[\s\S]*\.float-actions \.tag-relay-float-btn\{transform:translateY\(-92px\)\}[\s\S]*\.float-actions\.has-backtop \.tag-relay-float-btn\{transform:translateY\(-138px\)\}/);
  assert.doesNotMatch(relayCss, /\.tag-relay-float-btn\{[^}]*\b(?:color|background|border-color):/);
  assert.match(railSource, /return rail\.querySelector\('#relaySourceTabInbox'\)[\s\S]*#tagRelayPaneWarehouse/);
  assert.match(copyFxSource, /const TOSS_MS = 500;[\s\S]*opacity: \.94/);
  /* 抛入芯片只提层级、不改外观；z-index 必须高过侧栏(68)，否则最后一段会钻到栏底下。 */
  assert.match(stylesSource, /\.copy-seed-chip\.is-relay-toss\{[^}]*z-index:95/);
  assert.doesNotMatch(stylesSource, /copyRelayBeacon/, '实心底+信标环那版已回退，别再长回来');
  // 方案选择不再暴露系统 select；可见按钮 + listbox 与来源滑块都必须在 DOM 中。
  assert.match(indexSource, /id="relayPlanSelect" hidden tabindex="-1" aria-hidden="true"/);
  assert.match(indexSource, /id="relayPlanPickerBtn"[\s\S]*aria-haspopup="listbox"[\s\S]*aria-controls="relayPlanList"/);
  assert.match(indexSource, /id="relayPlanList" class="tag-relay-plan-list" role="listbox"/);
  assert.match(indexSource, /class="tag-relay-source-slider" aria-hidden="true"/);
  assert.match(composeSource, /\[role="option"\][\s\S]*ArrowDown[\s\S]*ArrowUp[\s\S]*Home[\s\S]*End/);
  assert.match(railSource, /querySelector\('#relayPlanPickerBtn'\)/);
  assert.match(railSource, /const hasOpenInnerLayer = \(\) => \[[\s\S]*#relayCopyHistory[\s\S]*#relayInspector[\s\S]*cancelRelayAction\(\);[\s\S]*if \(hasOpenInnerLayer\(\)\) return/);
  // 与格式 / 连接同源的滑块语言，以及各披露面板统一的入退场与减弱动效兜底。
  assert.match(relayCss, /@supports selector\(:has\(\*\)\)[\s\S]*tag-relay-source-slider[\s\S]*transition:translate \.24s/);
  assert.match(relayCss, /tag-relay-plan-list[\s\S]*tag-relay-output-boxes[\s\S]*display \.18s allow-discrete/);
  assert.match(relayCss, /tag-relay-plan-list\[hidden\],[^\{]+\{\s*display:none/);
  assert.match(relayCss, /tag-relay-output-boxes\[hidden\],[^\{]+\{\s*display:none/);
  assert.match(relayCss, /tag-relay-history\[hidden\],[^\{]+tag-relay-inspector\[hidden\]\{\s*display:none/);
  assert.match(relayCss, /@starting-style[\s\S]*tag-relay-plan-list:not\(\[hidden\]\)[\s\S]*tag-relay-inspector:not\(\[hidden\]\)/);
  assert.match(relayCss, /@media \(prefers-reduced-motion:reduce\)[\s\S]*tag-relay-source-slider[\s\S]*transition:none!important/);
  /* 方案被另一标签页切走或删掉时，正在编辑的内容必须转成可另存的草稿，不能由
     下一次 render 直接 closeInspector 后静默消失。 */
  assert.match(
    composeSource,
    /function draftFromInspector\(\)[\s\S]*return \{[\s\S]*function preserveOrphanedDraft\(\)[\s\S]*orphanedDraft = draft;[\s\S]*function renderCompose\(\)[\s\S]*if \(editorTargetGone\) \{[\s\S]*preserveOrphanedDraft\(\);[\s\S]*renderOrphanedDraft\(\);/,
  );
}

// 合并册旧分享链接：alias 前缀可正向归一；旧 canonical 前缀只有唯一来源时反解，
// 多来源同号必须拒绝，且成功结果返回真实 entry id 供 history 规范化。
{
  const previous = {
    codex: state.codex,
    list: state.list,
    placements: state.placements,
    nodes: state.nodes,
    lightbox: state.lightbox,
    activePath: state.activePath,
    query: state.query,
    suppressUrlSync: state.suppressUrlSync,
    favoritesView: state.favoritesView,
    siteSearchView: state.siteSearchView,
  };
  const opened = [];
  const uniqueEntry = {
    id: 'community_ai_misc-0001',
    title: '旧链接唯一来源',
    path: [],
    image: 'community.jpg',
  };
  state.codex = {
    id: 'nai45_community_pack',
    aliases: ['community_ai_misc'],
    entries: [uniqueEntry],
  };
  state.list = [];
  state.placements = [];
  state.nodes = new Map();
  state.lightbox = { entry: null, images: [], index: 0 };
  state.activePath = [];
  state.query = '';
  state.suppressUrlSync = true;
  state.favoritesView = false;
  state.siteSearchView = false;
  setRouterActions({
    openLightbox: entry => {
      opened.push(entry);
      state.lightbox = { entry, images: [{ path: entry.image }], index: 0 };
    },
    renderTree: () => {},
    applyFilter: () => {},
    updateVirtualCards: () => {},
  });
  assert.equal(openEntryDeepLink('nai45_community_pack-0001'), 'community_ai_misc-0001');
  assert.equal(opened.at(-1), uniqueEntry);

  state.codex.aliases = ['mengshen_pack', 'community_ai_misc'];
  state.codex.entries = [
    uniqueEntry,
    { ...uniqueEntry, id: 'mengshen_pack-0001', title: '另一个来源' },
  ];
  opened.length = 0;
  assert.equal(openEntryDeepLink('nai45_community_pack-0001'), false, '歧义旧链接不得猜来源');
  assert.equal(opened.length, 0);

  state.codex = {
    id: 'nai45_community_pack',
    aliases: ['community_ai_misc'],
    entries: [{ id: 'nai45_community_pack-0001', title: '规范来源', path: [], image: 'canonical.jpg' }],
  };
  assert.equal(openEntryDeepLink('community_ai_misc-0001'), 'nai45_community_pack-0001');

  state.codex = previous.codex;
  state.list = previous.list;
  state.placements = previous.placements;
  state.nodes = previous.nodes;
  state.lightbox = previous.lightbox;
  state.activePath = previous.activePath;
  state.query = previous.query;
  state.suppressUrlSync = previous.suppressUrlSync;
  state.favoritesView = previous.favoritesView;
  state.siteSearchView = previous.siteSearchView;
  setRouterActions({
    openLightbox: () => {},
    renderTree: () => {},
    applyFilter: () => {},
    updateVirtualCards: () => {},
  });
}

console.log('render UI regressions: PASS');
