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
  masonryViewport,
} = await import('../site/assets/app/masonry.js');

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

console.log('masonry viewport regressions: PASS');
