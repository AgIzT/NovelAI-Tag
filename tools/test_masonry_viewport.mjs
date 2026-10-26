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
  applyCardImageLoadPolicy,
  applyCardHeightChanges,
  beginMasonryResize,
  cardImageLoadPolicy,
  computeLayout,
  endMasonryResize,
  estimateBodyMetrics,
  estimateImageHeight,
  invalidateBodyMetrics,
  masonryViewport,
  scheduleRelayout,
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

// 已有 DOM 节点也要随滚动/转屏重算：进入视口时立即认领 timer，离开或列数变化时清掉旧 high。
{
  const attrs = new Map();
  const img = {
    loading: 'lazy',
    getAttribute: name => attrs.get(name) ?? null,
    setAttribute: (name, value) => attrs.set(name, String(value)),
    removeAttribute: name => attrs.delete(name),
  };
  let loadCount = 0;
  const node = {
    _imageTimer: 123,
    _loadImage() {
      loadCount += 1;
      this._imageTimer = 0;
    },
    querySelector: selector => selector === '.card-img' ? img : null,
  };
  const placement = { index: 2, top: 0, height: 300 };

  applyCardImageLoadPolicy(node, placement, {
    band: { top: 0, bottom: 434 },
    columnCount: 4,
    promote: true,
  });
  assert.equal(img.loading, 'eager');
  assert.equal(attrs.get('fetchpriority'), 'high');
  assert.equal(loadCount, 1, '进入真实可视带应跳过尚未触发的 90ms timer');

  applyCardImageLoadPolicy(node, placement, {
    band: { top: 0, bottom: 434 },
    columnCount: 1,
    promote: true,
  });
  assert.equal(img.loading, 'eager');
  assert.equal(attrs.has('fetchpriority'), false, '转为单列后第 3 张图不得保留桌面首行 high');
  assert.equal(loadCount, 1, '重复策略刷新不得重复发图请求');

  applyCardImageLoadPolicy(node, placement, {
    band: { top: 300, bottom: 600 },
    columnCount: 1,
    promote: true,
  });
  assert.equal(img.loading, 'lazy');
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
  assert.equal(estimateBodyMetrics({ image: 'portrait.webp', title: '卡片', tags: '' }, 120).height, 48);

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

console.log('masonry viewport and mobile density regressions: PASS');
