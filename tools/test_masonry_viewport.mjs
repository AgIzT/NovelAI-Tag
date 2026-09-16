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
  cardImageLoadPolicy,
  computeLayout,
  estimateBodyMetrics,
  estimateImageHeight,
  masonryViewport,
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
  for (const width of [320, 360, 390, 430, 600]) {
    window.innerWidth = width;
    masonry.clientWidth = width - 16;
    for (const density of ['comfort', 'standard', 'compact']) {
      state.density = density;
      computeLayout();
      assert.equal(state.colN, density === 'comfort' ? 1 : 2, `${width}px ${density} 列数`);
      for (const card of state.placements) {
        assert.ok(card.left + card.width <= masonry.clientWidth, '双列不能被 180px 下限撑出屏幕');
        assert.ok(card.height < 568, '长图与长摘要不能撑出一屏高度');
      }
      assert.ok(estimateImageHeight(tall, state.itemWidth) <= densityConfig().imageMaxHeight);
      assert.equal(estimateImageHeight(textOnly, state.itemWidth), 0);
      assert.ok(estimateBodyMetrics(textOnly, state.itemWidth).tagsHeight > 0, '无图卡保留文字');
      if (density === 'compact') assert.equal(state.placements[0].tagsHeight, 0, '图墙隐藏摘要且不预留空白');
    }
  }

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

// “全部”也会因角色词出现；窄双列需为它换行，宽卡片与收藏卡则按实际按钮数排布。
{
  const previous = { density: state.density, favoritesView: state.favoritesView, innerWidth: window.innerWidth };
  window.innerWidth = 320;
  state.favoritesView = false;
  const base = { title: '角色测试', image: 'bear.webp', tags: 'tag, '.repeat(200) };
  const characters = { ...base, characterPrompts: [{ label: '角色一', positive: '1girl' }] };
  const negative = { ...base, negative: 'blurry' };
  for (const density of ['standard', 'compact']) {
    state.density = density;
    for (const width of [147, 167]) {
      const plainHeight = estimateBodyMetrics(base, width).height;
      assert.equal(estimateBodyMetrics(characters, width).height - plainHeight, 40, '角色词按钮换到第二行');
      assert.equal(estimateBodyMetrics(negative, width).height - plainHeight, 40, '负面与全部按钮换到第二行');
    }
    assert.equal(estimateBodyMetrics(characters, 182).height, estimateBodyMetrics(base, 182).height, '四个按钮放得下一行时不多留空白');
    assert.equal(estimateBodyMetrics(negative, 300).height, estimateBodyMetrics(base, 300).height, '宽卡片五个按钮无需换行');
    const normalHeight = estimateBodyMetrics(characters, 147).height;
    state.favoritesView = true;
    assert.equal(estimateBodyMetrics(characters, 147).height, normalHeight - 40, '收藏卡没有隐藏按钮，不能复用普通卡的底栏缓存');
    state.favoritesView = false;
    assert.equal(estimateBodyMetrics(characters, 147).height, normalHeight);
  }
  state.density = previous.density;
  state.favoritesView = previous.favoritesView;
  if (previous.innerWidth === undefined) delete window.innerWidth;
  else window.innerWidth = previous.innerWidth;
}

console.log('masonry viewport and mobile density regressions: PASS');
