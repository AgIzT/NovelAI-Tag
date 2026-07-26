// 渲染与主 UI 中高危修复回归：node tools/test_render_ui.mjs
import assert from 'node:assert/strict';

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
  documentElement: { clientHeight: 800, scrollHeight: 2000 },
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
  isLightboxKeydownBlocked,
  preloadImage,
  preloadLightboxNeighbors,
} = await import('../site/assets/app/lightbox.js');
const {
  accessHiddenCount,
  invalidateAccessViewMemo,
  visibleEntryCount,
  visibleTree,
} = await import('../site/assets/app/codex-ui.js');
const { setupReport } = await import('../site/assets/app/report.js');

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

// 访问树与隐藏数共享 memo；同长度编辑只要 entries 换引用就必须失效。
{
  const entries = [
    { id: 'safe', path: ['A'], rating: 'safe' },
    { id: 'adult', path: ['NSFW'], rating: 'r18' },
    { id: 'gore', path: ['R18G'], rating: 'r18g' },
  ];
  state.codex = { id: 'memo', entryCount: 3, entries, emptyCategories: [] };
  state.allowNsfw = false;
  state.allowR18g = false;
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

  // 编辑器仅改 rating 时会原地合并词条；显式失效入口覆盖这种引用不变的写路径。
  state.allowNsfw = false;
  assert.equal(accessHiddenCount(), 2);
  state.codex.entries[0].rating = 'r18';
  invalidateAccessViewMemo();
  assert.equal(accessHiddenCount(), 3);
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

console.log('render UI regressions: PASS');
