// 瀑布流真实可视带与首图加载策略回归：node tools/test_masonry_viewport.mjs
import assert from 'node:assert/strict';

globalThis.HTMLElement = class {};
globalThis.window = {
  addEventListener: () => {},
  clearTimeout,
  innerHeight: 800,
  matchMedia: () => ({ matches: true }),
  performance,
  scrollY: 0,
  setTimeout,
};
globalThis.document = {
  activeElement: null,
  addEventListener: () => {},
  body: { classList: { add: () => {}, remove: () => {}, toggle: () => {} } },
  documentElement: {
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    clientHeight: 800,
    scrollHeight: 2000,
  },
  querySelector: () => null,
  querySelectorAll: () => [],
};
globalThis.location = {
  hash: '',
  hostname: 'localhost',
  href: 'http://localhost/',
  origin: 'http://localhost',
  pathname: '/',
  protocol: 'http:',
  search: '',
};
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.getComputedStyle = () => ({ display: 'block' });

const {
  CARD_DBLCLICK_HINT_KEY,
  CARD_DOUBLE_CLICK_MS,
  applyCardImageLoadPolicy,
  applyCardHeightChanges,
  beginMasonryResize,
  cardImageLoadPolicy,
  cleanupCard,
  clearMasonry,
  computeLayout,
  dismissCardDblclickHint,
  endMasonryResize,
  estimateBodyMetrics,
  estimateImageHeight,
  invalidateBodyMetrics,
  makeCard,
  masonryViewport,
  refreshCopyHints,
  scheduleRelayout,
  setMasonryActions,
  syncCardDblclickHint,
} = await import('../site/assets/app/masonry.js');
const { state, densityConfig, DEFAULT_DENSITY } = await import('../site/assets/app/state.js');

function viewportAt(rectTop, { totalHeight = 2400, viewportHeight = 800 } = {}) {
  window.innerHeight = viewportHeight;
  document.documentElement.clientHeight = viewportHeight;
  return masonryViewport({
    offsetHeight: totalHeight,
    style: { height: `${totalHeight}px` },
    getBoundingClientRect: () => ({ top: rectTop }),
  });
}

// masonry 在页首控件下方：只有 viewportHeight - rect.top 是真实可见区域。
{
  const view = viewportAt(286, { viewportHeight: 720 });
  assert.equal(view.top, 0);
  assert.deepEqual([view.visibleTop, view.visibleBottom], [0, 434]);
}

// 页面已经滚入 masonry：可视带两端都使用 masonry 内部坐标。
{
  const view = viewportAt(-320);
  assert.equal(view.top, 320);
  assert.deepEqual([view.visibleTop, view.visibleBottom], [320, 1120]);
}

// masonry 完全位于视口下方，以及恰好贴住视口底边时，都没有可见卡片。
{
  const below = viewportAt(900);
  const boundary = viewportAt(800);
  const onePixel = viewportAt(799);
  assert.deepEqual([below.visibleTop, below.visibleBottom], [0, 0]);
  assert.deepEqual([boundary.visibleTop, boundary.visibleBottom], [0, 0]);
  assert.deepEqual([onePixel.visibleTop, onePixel.visibleBottom], [0, 1]);
}

// 到达 masonry 尾部时，虚拟化仍保留原先的满视口锚点；真实可视带独立钳制。
{
  const view = viewportAt(-2100);
  assert.equal(view.top, 1600);
  assert.deepEqual([view.visibleTop, view.visibleBottom], [2100, 2400]);
}

// 只有真实可见卡片 eager；fetchpriority=high 仍只属于真正第一行。
{
  const band = { top: 0, bottom: 434 };
  assert.deepEqual(
    cardImageLoadPolicy({ index: 0, top: 0, height: 300 }, band, 4),
    { eager: true, highPriority: true },
  );
  assert.deepEqual(
    cardImageLoadPolicy({ index: 4, top: 310, height: 300 }, band, 4),
    { eager: true, highPriority: false },
  );
  assert.deepEqual(
    cardImageLoadPolicy({ index: 1, top: 434, height: 300 }, band, 4),
    { eager: false, highPriority: false },
  );
  assert.deepEqual(
    cardImageLoadPolicy({ index: 0, top: 0, height: 300 }, { top: 0, bottom: 0 }, 4),
    { eager: false, highPriority: false },
  );
}

// 已有 DOM 节点也要随滚动/转屏重算：离开第一行或列数变化时清掉旧 high。
// 何时发图交给图片队列（test_image_queue.mjs），策略不再改 loading，真正发出时才统一设为 eager。
{
  const attrs = new Map();
  const img = {
    loading: 'lazy',
    getAttribute: name => attrs.get(name) ?? null,
    setAttribute: (name, value) => attrs.set(name, String(value)),
    removeAttribute: name => attrs.delete(name),
  };
  const node = { querySelector: selector => selector === '.card-img' ? img : null };
  const placement = { index: 2, top: 0, height: 300 };

  applyCardImageLoadPolicy(node, placement, { band: { top: 0, bottom: 434 }, columnCount: 4 });
  assert.equal(attrs.get('fetchpriority'), 'high');
  assert.equal(img.loading, 'lazy', '加载时机属于图片队列，策略刷新不得改 loading');

  applyCardImageLoadPolicy(node, placement, { band: { top: 0, bottom: 434 }, columnCount: 1 });
  assert.equal(attrs.has('fetchpriority'), false, '转为单列后第 3 张图不得保留桌面首行 high');

  applyCardImageLoadPolicy(node, placement, { band: { top: 300, bottom: 600 }, columnCount: 1 });
  assert.equal(attrs.has('fetchpriority'), false);
}

// 手机标准必须双列、卡片不能越出可用宽度；长图也必须能在一屏内浏览。
{
  const originalQuery = document.querySelector;
  const masonry = { clientWidth: 0, style: {} };
  document.querySelector = selector => ['#masonry', '#main'].includes(selector) ? masonry : null;
  const tall = { id: 'tall', title: '长图', image: 'tall.webp', imageWidth: 100, imageHeight: 2000, tags: 'tag, '.repeat(200) };
  const textOnly = { id: 'text', title: '文字词条', tags: 'tag, '.repeat(200) };
  state.list = [tall, { ...tall, id: 'tall-2' }, textOnly];
  assert.equal(DEFAULT_DENSITY, 'standard');
  for (const width of [320, 351, 352, 360, 390, 430, 600]) {
    window.innerWidth = width;
    masonry.clientWidth = width - 16;
    for (const density of ['comfort', 'standard', 'compact']) {
      state.density = density;
      computeLayout();
      const expectedColumns = density === 'comfort' ? 1 : density === 'compact' && width >= 352 ? 3 : 2;
      assert.equal(state.colN, expectedColumns, `${width}px ${density} 列数`);
      for (const card of state.placements) {
        assert.ok(card.left + card.width <= masonry.clientWidth, '双列不能被 180px 下限撑出屏幕');
        assert.ok(card.height < 568, '长图与长摘要不能撑出一屏高度');
      }
      assert.ok(estimateImageHeight(tall, state.itemWidth) <= (densityConfig().imageMaxHeight || Infinity));
      assert.equal(estimateImageHeight(textOnly, state.itemWidth), 0);
      assert.ok(estimateBodyMetrics(textOnly, state.itemWidth).tagsHeight > 0, '无图卡保留文字');
      if (density === 'compact') assert.equal(state.placements[0].tagsHeight, 0, '图墙隐藏摘要且不预留空白');
    }
  }

  // 常规竖图沿用原版比例，不能再被正方形高度上限压出侧边空白。
  state.density = 'compact';
  window.innerWidth = 390;
  assert.equal(estimateImageHeight({ image: 'portrait.webp', imageWidth: 753, imageHeight: 1100 }, 120), 175);
  assert.equal(estimateBodyMetrics({ image: 'portrait.webp', title: '卡片', tags: '' }, 120).height, 48, '紧凑标题按单行估高，收藏触区不再撑高正文');

  // 卡宽恰好相同时，跨手机断点也不能复用旧摘要估高。
  state.density = 'compact';
  window.innerWidth = 600;
  assert.equal(estimateBodyMetrics(tall, 200).tagsHeight, 0);
  window.innerWidth = 601;
  assert.ok(estimateBodyMetrics(tall, 200).tagsHeight > 0);
  assert.equal(densityConfig().minWidth, 176, '桌面密度保持原配置');
  assert.equal(estimateImageHeight(tall, 200), 380, '桌面图片比例上限保持原值');
  document.querySelector = originalQuery;
  delete window.innerWidth;
  state.density = DEFAULT_DENSITY;
}

// 同宽重排必须保住实测尺寸、原列与屏外累计高度；变化的布局输入不能复用旧实测。
{
  const originalQuery = document.querySelector;
  const saved = { density: state.density, sdMode: state.sdMode, innerWidth: window.innerWidth };
  const masonry = { clientWidth: 780, style: {} };
  document.querySelector = selector => ['#masonry', '#main'].includes(selector) ? masonry : null;
  window.innerWidth = 1280;
  state.density = 'standard';
  state.nodes.clear();
  state.list = Array.from({ length: 8 }, (_, i) => ({ id: `resize-${i}`, title: '卡片', tags: 'tag' }));
  computeLayout();
  applyCardHeightChanges([{ placement: state.placements[0], nextHeight: state.placements[0].height + 37 }]);
  let previous = new Map(state.placements.map(p => [p.entry, p]));
  const geometry = () => state.placements.map(p => [p.col, p.top, p.width, p.height, p.tagsHeight]);
  const before = geometry();
  computeLayout({ previous, preserveColumns: true });
  assert.deepEqual(geometry(), before, '同宽重排不丢实测高度，也不重新分列制造位置变化');

  const entry = state.list[0];
  const expectedHeight = () => Math.ceil(estimateImageHeight(entry, state.itemWidth) + estimateBodyMetrics(entry, state.itemWidth).height);
  state.density = 'comfort';
  masonry.clientWidth = previous.get(entry).width;
  computeLayout({ previous, preserveColumns: true });
  assert.equal(state.itemWidth, previous.get(entry).width, '卡宽相同的密度切换夹具');
  assert.equal(state.placements[0].height, expectedHeight(), '同宽但密度变化时不能保留旧实测高度');

  applyCardHeightChanges([{ placement: state.placements[0], nextHeight: state.placements[0].height + 37 }]);
  previous = new Map(state.placements.map(p => [p.entry, p]));
  state.sdMode = !state.sdMode;
  computeLayout({ previous, preserveColumns: true });
  assert.equal(state.placements[0].height, expectedHeight(), '复制模式变化不能复用旧实测高度');

  applyCardHeightChanges([{ placement: state.placements[0], nextHeight: state.placements[0].height + 37 }]);
  previous = new Map(state.placements.map(p => [p.entry, p]));
  entry.tags = 'tag, '.repeat(80);
  invalidateBodyMetrics(entry);
  computeLayout({ previous, preserveColumns: true });
  assert.equal(state.placements[0].height, expectedHeight(), '词条内容失效后不能复用旧实测高度');
  document.querySelector = originalQuery;
  state.density = saved.density;
  state.sdMode = saved.sdMode;
  if (saved.innerWidth === undefined) delete window.innerWidth;
  else window.innerWidth = saved.innerWidth;
}

// 手机卡片的标题只保留收藏星星，负面/角色操作不再占据底栏。
{
  const previous = { density: state.density, favoritesView: state.favoritesView, innerWidth: window.innerWidth };
  window.innerWidth = 320;
  const base = { title: '角色测试', image: 'bear.webp', tags: 'tag, '.repeat(200) };
  const characters = { ...base, characterPrompts: [{ label: '角色一', positive: '1girl' }] };
  const negative = { ...base, negative: 'blurry' };
  for (const density of ['comfort', 'standard', 'compact']) {
    state.density = density;
    for (const width of [147, 167, 182, 300]) {
      const plainHeight = estimateBodyMetrics(base, width).height;
      assert.equal(estimateBodyMetrics(characters, width).height, plainHeight, '角色操作在灯箱中，卡片不预留按钮行');
      assert.equal(estimateBodyMetrics(negative, width).height, plainHeight, '负面操作在灯箱中，卡片不预留按钮行');
      state.favoritesView = true;
      assert.equal(estimateBodyMetrics(characters, width).height, plainHeight);
      state.favoritesView = false;
    }
  }
  state.density = previous.density;
  state.favoritesView = previous.favoritesView;
  if (previous.innerWidth === undefined) delete window.innerWidth;
  else window.innerWidth = previous.innerWidth;
}

// 容器动画只消费终态宽度；快速反向接管锁，结束后真实 resize 与密度变化仍能重排。
{
  const saved = {
    query: document.querySelector, timeout: window.setTimeout, clear: globalThis.clearTimeout,
    codex: state.codex, list: state.list, density: state.density, innerWidth: window.innerWidth,
  };
  const timers = new Map();
  let timerId = 0, commits = 0;
  const masonry = {
    clientWidth: 1119, offsetWidth: 1119,
    classList: { add() {}, remove() {} },
    style: { set height(value) { commits++; }, get height() { return '0px'; } },
  };
  document.querySelector = selector => ['#masonry', '#main'].includes(selector) ? masonry : null;
  window.setTimeout = callback => { timers.set(++timerId, callback); return timerId; };
  globalThis.clearTimeout = id => timers.delete(id);
  window.innerWidth = 1440;
  state.codex = { id: 'resize-test' };
  state.list = [];
  state.nodes.clear();
  state.density = 'standard';
  try {
    computeLayout();
    masonry.clientWidth = 681;
    scheduleRelayout();
    assert.equal(timers.size, 1, '先模拟一条尚未执行的普通 resize');
    beginMasonryResize();
    assert.equal(commits, 2, '本次开栏只提交一次终态');
    assert.equal(timers.size, 0, '开栏接管并取消旧 resize timer');
    assert.equal(state.itemWidth, 334);

    masonry.clientWidth = 900;
    scheduleRelayout();
    assert.equal(timers.size, 0, '动画中间的 RO 不安排额外重排');
    computeLayout();
    assert.equal(state.itemWidth, 334, '动画中更新列表也使用终态卡宽');

    masonry.clientWidth = 1119;
    beginMasonryResize();
    assert.equal(state.itemWidth, 270, '快速反向采用新一轮终态');
    const beforeEnd = commits;
    endMasonryResize();
    scheduleRelayout();
    assert.equal(timers.size, 0, '收尾与最后一条 RO 都不能补排相同宽度');
    assert.equal(commits, beforeEnd);

    const drain = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); };
    masonry.clientWidth = 800;
    scheduleRelayout();
    assert.equal(timers.size, 1, '解锁后真实宽度变化仍会排队');
    drain();
    assert.equal(commits, beforeEnd + 1);
    state.density = 'compact';
    scheduleRelayout();
    assert.equal(timers.size, 1, '同宽但布局密度变化不能被去重掉');
    drain();
    assert.equal(commits, beforeEnd + 2);
  } finally {
    endMasonryResize();
    timers.clear();
    document.querySelector = saved.query;
    window.setTimeout = saved.timeout;
    globalThis.clearTimeout = saved.clear;
    state.codex = saved.codex;
    state.list = saved.list;
    state.density = saved.density;
    if (saved.innerWidth === undefined) delete window.innerWidth;
    else window.innerWidth = saved.innerWidth;
  }
}

// 电脑端默认「单击复制」卡片：单击延迟 220ms 判双击，双击整卡取消待发复制并进灯箱，避开按钮/多选/编辑态。
{
  const makeClassList = () => {
    const names = new Set();
    return {
      add: (...list) => list.forEach(n => names.add(n)),
      remove: (...list) => list.forEach(n => names.delete(n)),
      contains: name => names.has(name),
      toggle(name, force) {
        const on = force ?? !names.has(name);
        if (on) names.add(name);
        else names.delete(name);
        return on;
      },
    };
  };
  class StubNode {
    constructor(tag = 'DIV') {
      this.tagName = tag;
      this.dataset = {};
      this.classList = makeClassList();
      this.children = new Map();
      this.childNodes = [];
      this.parentElement = null;
      this.isConnected = true;
      const props = new Map();
      this.style = {
        setProperty: (k, v) => props.set(k, v),
        getPropertyValue: k => props.get(k) || '',
        removeProperty: k => props.delete(k),
      };
    }
    querySelector(selector) {
      if (!this.children.has(selector)) {
        const tag = selector === '.card-img' ? 'IMG' : selector.includes('btn') ? 'BUTTON' : 'DIV';
        const child = new StubNode(tag);
        child.parentElement = this;
        this.children.set(selector, child);
      }
      return this.children.get(selector);
    }
    appendChild(child) {
      if (child.parentElement) child.remove();
      child.parentElement = this;
      this.childNodes.push(child);
      return child;
    }
    append(...nodes) {
      for (const node of nodes) this.appendChild(node);
    }
    remove() {
      if (!this.parentElement) return;
      const siblings = this.parentElement.childNodes;
      const i = siblings.indexOf(this);
      if (i >= 0) siblings.splice(i, 1);
      this.parentElement = null;
    }
    contains(target) {
      for (let cur = target; cur; cur = cur.parentElement) {
        if (cur === this) return true;
      }
      return false;
    }
    closest(selector) {
      for (let cur = this; cur; cur = cur.parentElement) {
        if (selector === '.card' && cur.tagName === 'ARTICLE') return cur;
      }
      return null;
    }
    setAttribute(k, v) { this[k] = v; }
    removeAttribute(k) { delete this[k]; }
    getAttribute(k) { return this[k] ?? null; }
    cloneNode() { return new StubNode(this.tagName); }
  }

  const saved = {
    query: document.querySelector,
    createElement: document.createElement,
    bodyClassList: document.body.classList,
    localStorage: globalThis.localStorage,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    innerWidth: window.innerWidth,
    getSelection: window.getSelection,
    codex: state.codex,
    list: state.list,
    placements: state.placements,
    cardZoom: state.cardZoom,
    artistPicking: state.artistPicking,
    favSelecting: state.favSelecting,
    lightbox: state.lightbox,
  };
  const timers = new Map();
  const storage = new Map();
  let timerId = 0;
  let selectionCleared = 0;
  const template = { content: { firstElementChild: new StubNode('ARTICLE') } };
  const resultBar = new StubNode('DIV');
  const resultBarActions = resultBar.querySelector('.result-bar-actions');
  resultBar.insertBefore = (node, ref) => {
    if (node.parentElement) node.remove();
    node.parentElement = resultBar;
    const i = resultBar.childNodes.indexOf(ref);
    if (i >= 0) resultBar.childNodes.splice(i, 0, node);
    else resultBar.childNodes.push(node);
    return node;
  };
  resultBar.appendChild(resultBarActions);
  document.querySelector = selector => {
    if (selector === '#cardTpl') return template;
    if (selector === '.result-bar') return resultBar;
    return null;
  };
  document.createElement = tag => new StubNode(String(tag || 'DIV').toUpperCase());
  document.body.classList = makeClassList();
  globalThis.localStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k),
  };
  globalThis.setTimeout = (fn, delay) => {
    const id = ++timerId;
    timers.set(id, { fn, delay });
    return id;
  };
  globalThis.clearTimeout = id => timers.delete(id);
  window.innerWidth = 1440;
  window.getSelection = () => ({ removeAllRanges: () => { selectionCleared += 1; } });
  const runTimers = () => {
    const entries = [...timers.entries()];
    for (const [id, item] of entries) {
      if (!timers.has(id)) continue;
      timers.delete(id);
      item.fn();
    }
  };
  const copied = [];
  const opened = [];
  const favToggled = [];
  setMasonryActions({
    copyEntry: (entry, node) => copied.push({ entry, node }),
    openLightbox: (entry, index, img, opts) => opened.push({ entry, index, img, opts }),
    toggleFav: entry => favToggled.push(entry),
    hideCard: () => {},
    reportEntry: () => {},
    decorateFavoriteCard: () => {},
    decorateArtistPickCard: () => {},
    leanCard: () => false,
    favoriteBadgeHeight: () => 0,
  });

  state.codex = { id: 'suozhang', type: 'codex' };
  state.cardZoom = false;
  state.artistPicking = false;
  state.favSelecting = false;
  state.lightbox = { entry: null, images: [], index: 0 };

  const entryA = { id: 'a1', title: '词条 A', path: ['分类'], image: 'a1.webp', tags: '1girl' };
  const entryB = { id: 'b1', title: '词条 B', path: ['分类'], image: 'b1.webp', tags: '1boy' };
  const packEntry = { id: 'p1', title: '图包卡', path: ['分类'], image: 'p1.webp', tags: '1girl', _srcType: 'pack' };
  const plainTarget = { closest: () => null };
  const buttonTarget = { closest: sel => (sel.includes('button') ? {} : null) };
  const makePlacement = (entry, index) => ({ index, entry, col: 0, left: 0, top: 0, width: 240, height: 320, imageHeight: 200, tagsHeight: 40 });

  try {
    const cardA = makeCard(makePlacement(entryA, 0));
    const cardB = makeCard(makePlacement(entryB, 1));

    // 1. 真实单击：先等 CARD_DOUBLE_CLICK_MS，再复制，不开灯箱
    cardA.onclick({ detail: 1, target: plainTarget });
    assert.equal(copied.length, 0, '单击在双击窗口内不得提前复制');
    assert.equal(timers.size, 1);
    assert.equal([...timers.values()][0].delay, CARD_DOUBLE_CLICK_MS);
    runTimers();
    assert.equal(copied.length, 1);
    assert.equal(copied[0].entry, entryA);
    assert.equal(opened.length, 0);

    // 2. 快速双击：取消待发复制，阻止选字，清空选区，携带 card-img 进入灯箱，且 0 次复制
    let prevented = false;
    cardA.onclick({ detail: 1, target: plainTarget });
    cardA.onmousedown({ detail: 2, target: plainTarget, preventDefault: () => { prevented = true; } });
    cardA.onclick({ detail: 2, target: plainTarget });
    cardA.ondblclick({ detail: 2, target: plainTarget });
    runTimers();
    assert.equal(prevented, true, '双击第二下应阻止选中卡片文字');
    assert.equal(selectionCleared, 1, '双击打开前应清理残留选区');
    assert.equal(copied.length, 1, '双击不得触发误复制');
    assert.equal(opened.length, 1, '双击应进入灯箱');
    assert.equal(opened[0].entry, entryA);
    assert.equal(opened[0].img, cardA.querySelector('.card-img'));

    // 3. 连续点不同卡片：点 B 时立即兑现 A 的待发复制，再为 B 排队
    cardA.onclick({ detail: 1, target: plainTarget });
    cardB.onclick({ detail: 1, target: plainTarget });
    assert.equal(copied.length, 2, '切到另一张卡时立即兑现上一张的单击复制');
    assert.equal(copied[1].entry, entryA);
    runTimers();
    assert.equal(copied.length, 3);
    assert.equal(copied[2].entry, entryB);

    // 4. 点卡片后迅速点卡内按钮（如收藏）：取消待发复制；双击按钮本身不进灯箱
    cardA.onclick({ detail: 1, target: plainTarget });
    cardA.querySelector('.fav-btn').onclick({ stopPropagation() {} });
    runTimers();
    assert.equal(favToggled.length, 1);
    assert.equal(copied.length, 3, '点卡内按钮应取消待发复制');
    let btnPrevented = false;
    cardA.onmousedown({ detail: 2, target: buttonTarget, preventDefault: () => { btnPrevented = true; } });
    cardA.ondblclick({ detail: 2, target: buttonTarget });
    assert.equal(btnPrevented, false);
    assert.equal(opened.length, 1, '双击卡内按钮不得误进灯箱');

    // 5. 多选、收藏批量整理、编辑态、修饰键、已开灯箱均屏蔽双击进灯箱
    for (const toggle of [
      () => { state.artistPicking = true; return () => { state.artistPicking = false; }; },
      () => { state.favSelecting = true; return () => { state.favSelecting = false; }; },
      () => { document.body.classList.add('edit-mode'); return () => document.body.classList.remove('edit-mode'); },
      () => { state.lightbox = { entry: entryA, images: [{}], index: 0 }; return () => { state.lightbox = { entry: null, images: [], index: 0 }; }; },
    ]) {
      const restore = toggle();
      cardA.ondblclick({ detail: 2, target: plainTarget });
      restore();
    }
    cardA.ondblclick({ detail: 2, ctrlKey: true, target: plainTarget });
    assert.equal(opened.length, 1, '特殊模式或修饰键下双击不触发灯箱');

    // 6. 开启「点击卡片放大」、图包卡、手机宽度：单击直接进灯箱，不延迟且双击不重复开
    const packCard = makeCard(makePlacement(packEntry, 2));
    packCard.onclick({ detail: 1, target: plainTarget });
    assert.equal(opened.length, 2);
    assert.equal(opened[1].entry, packEntry);
    packCard.ondblclick({ detail: 2, target: plainTarget });
    assert.equal(opened.length, 2);

    state.cardZoom = true;
    cardA.onclick({ detail: 1, target: plainTarget });
    assert.equal(opened.length, 3);
    state.cardZoom = false;

    window.innerWidth = 390;
    cardA.onclick({ detail: 1, target: plainTarget });
    assert.equal(opened.length, 4);
    window.innerWidth = 1440;

    // 7. 程序触发 click（detail === 0）立即复制；cleanupCard / clearMasonry 取消待发复制
    cardA.onclick({ detail: 0, target: plainTarget });
    assert.equal(copied.length, 4, '程序触发 click 应立即复制');
    cardA.onclick({ detail: 1, target: plainTarget });
    cleanupCard(cardA);
    runTimers();
    assert.equal(copied.length, 4, '卡片回收必须取消待发复制');
    cardB.onclick({ detail: 1, target: plainTarget });
    clearMasonry();
    runTimers();
    assert.equal(copied.length, 4, '清空瀑布流必须取消待发复制');

    // 8. 卡片上方结果栏一次性引导胶囊：有合格有图卡时挂在结果栏中部（操作区前），仅在双击卡片或点「知道了」后永久收起，点放大镜不收起
    storage.clear();
    const noImgEntry = { id: 'n1', title: '无图卡', path: ['分类'], image: '', tags: '1girl' };
    const cardNoImg = makeCard(makePlacement(noImgEntry, 0));
    const cardFirstImg = makeCard(makePlacement(entryA, 1));
    const cardSecondImg = makeCard(makePlacement(entryB, 2));
    state.list = [noImgEntry, entryA, entryB];
    state.placements = [makePlacement(noImgEntry, 0), makePlacement(entryA, 1), makePlacement(entryB, 2)];
    state.nodes.clear();
    state.nodes.set(0, cardNoImg);
    state.nodes.set(1, cardFirstImg);
    state.nodes.set(2, cardSecondImg);
    const barHint = () => resultBar.childNodes.find(n => n.className === 'card-dblclick-hint') || null;

    syncCardDblclickHint();
    assert.ok(barHint(), '有可双击卡片时应在上方结果栏中部显示引导胶囊');
    assert.ok(resultBar.childNodes.indexOf(barHint()) < resultBar.childNodes.indexOf(resultBarActions), '引导胶囊应插在右侧操作区之前');
    assert.equal(cardFirstImg.querySelector('.zoom-btn').title, '放大查看（也可双击卡片）');

    // 开「点击卡片放大」时暂时隐藏，关闭后若尚未看过应恢复
    state.cardZoom = true;
    refreshCopyHints();
    assert.equal(barHint(), null, '开启点击卡片放大时应隐藏双击引导');
    assert.equal(storage.has(CARD_DBLCLICK_HINT_KEY), false, '临时切换设置不应提前消耗一次性提示');
    state.cardZoom = false;
    refreshCopyHints();
    assert.ok(barHint(), '关闭点击卡片放大后应恢复尚未看过的提示');

    // 点放大镜不算学会双击：不得关闭或消耗一次性引导
    cardFirstImg.querySelector('.card-img-wrap').querySelector('.zoom-btn').onclick({ stopPropagation() {} });
    assert.equal(storage.has(CARD_DBLCLICK_HINT_KEY), false, '点击放大镜不得消耗双击引导');
    assert.ok(barHint(), '点击放大镜后引导胶囊应继续保留');

    // 方式 1：点「知道了」永久关闭，且不触发复制或开灯箱
    const dismissBtn = barHint().childNodes.find(n => n.className?.includes('card-dblclick-hint-dismiss'));
    const copiedBeforeDismiss = copied.length;
    const openedBeforeDismiss = opened.length;
    dismissBtn.onclick({ stopPropagation() {} });
    assert.equal(storage.get(CARD_DBLCLICK_HINT_KEY), '1', '点「知道了」必须落盘标记');
    assert.equal(barHint(), null, 'reduced-motion 下点「知道了」应立即移除');
    assert.equal(copied.length, copiedBeforeDismiss);
    assert.equal(opened.length, openedBeforeDismiss);
    syncCardDblclickHint();
    assert.equal(barHint(), null, '已记住后不再出现');

    // 方式 2：双击任意合格卡片进入灯箱 → 永久关闭
    storage.clear();
    syncCardDblclickHint();
    assert.ok(barHint());
    cardSecondImg.ondblclick({ detail: 2, target: plainTarget });
    assert.equal(storage.get(CARD_DBLCLICK_HINT_KEY), '1', '双击任意合格卡片必须永久关闭引导');
    assert.equal(barHint(), null);

    // 手机宽度或图包法典不显示
    storage.clear();
    window.innerWidth = 390;
    syncCardDblclickHint();
    assert.equal(barHint(), null, '手机宽度不显示双击引导');
    window.innerWidth = 1440;
    state.codex = { id: 'pack1', type: 'pack' };
    syncCardDblclickHint();
    assert.equal(barHint(), null, '图包法典不显示双击引导');
    dismissCardDblclickHint();
  } finally {
    clearMasonry();
    timers.clear();
    document.querySelector = saved.query;
    document.createElement = saved.createElement;
    document.body.classList = saved.bodyClassList;
    globalThis.localStorage = saved.localStorage;
    globalThis.setTimeout = saved.setTimeout;
    globalThis.clearTimeout = saved.clearTimeout;
    window.getSelection = saved.getSelection;
    if (saved.innerWidth === undefined) delete window.innerWidth;
    else window.innerWidth = saved.innerWidth;
    state.codex = saved.codex;
    state.list = saved.list;
    state.placements = saved.placements;
    state.nodes.clear();
    state.cardZoom = saved.cardZoom;
    state.artistPicking = saved.artistPicking;
    state.favSelecting = saved.favSelecting;
    state.lightbox = saved.lightbox;
  }
}

console.log('masonry viewport and mobile density regressions: PASS');
