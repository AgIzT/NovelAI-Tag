// 卡片图片调度：node tools/test_image_queue.mjs
// 可见的先下且限并发、屏外等可见都完成后再少量预取、回收时撤队或取消、命中缓存与重试不排队、卡住的不占名额。
import assert from 'node:assert/strict';

const { createImageQueue } = await import('../site/assets/app/image-queue.js');

function harness({ visibleLimit = 2, prefetchLimit = 1, stalledMs = 1000 } = {}) {
  const band = { top: 0, bottom: 1000 };
  let clock = 0;
  const timers = new Map();
  let nextTimer = 1;
  const started = [];
  const stopped = [];
  const deferred = [];
  const queue = createImageQueue({
    band: () => band,
    visibleLimit,
    prefetchLimit,
    stalledMs,
    now: () => clock,
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: id => timers.delete(id),
    defer: fn => deferred.push(fn),
  });
  // 模拟同一任务末尾的微任务：一批卡片登记完才统一分配名额
  const flush = () => { while (deferred.length) deferred.shift()(); };
  const job = (name, top, height = 100, index = top) => ({
    name,
    placement: { top, height, index },
    start() { started.push(name); },
    stop() { stopped.push(name); },
  });
  const advance = ms => {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= clock) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  return { band, queue, job, started, stopped, advance, flush };
}

// 可见带内按从上到下限并发；屏外在可见的都完成前一张不发
{
  const h = harness();
  const below = h.job('below', 1500);
  const v3 = h.job('v3', 800);
  const v1 = h.job('v1', 0);
  const v2 = h.job('v2', 300);
  for (const item of [below, v3, v1, v2]) h.queue.request(item);
  assert.deepEqual(h.started, [], '登记当场不分配名额');
  h.flush();
  assert.deepEqual(h.started, ['v1', 'v2'], '可见的按位置从上到下，最多 visibleLimit 张');
  h.queue.finish(v1);
  assert.deepEqual(h.started, ['v1', 'v2', 'v3']);
  h.queue.finish(v2);
  assert.deepEqual(h.started, ['v1', 'v2', 'v3'], '可见图还在飞时不预取屏外');
  h.queue.finish(v3);
  assert.deepEqual(h.started, ['v1', 'v2', 'v3', 'below'], '可见的都完成后才预取屏外');
  assert.deepEqual(h.queue.stats(), { waiting: 0, running: 1, visible: 0, offscreen: 1 });
}

// 屏外预取：先下方由近到远，后上方，最多 prefetchLimit 张
{
  const h = harness({ prefetchLimit: 2 });
  h.band.top = 1000;
  h.band.bottom = 2000;
  const far = h.job('far-below', 3500);
  const near = h.job('near-below', 2100);
  const above = h.job('above', 700);
  for (const item of [above, far, near]) h.queue.request(item);
  h.flush();
  assert.deepEqual(h.started, ['near-below', 'far-below']);
  h.queue.finish(near);
  assert.deepEqual(h.started, ['near-below', 'far-below', 'above']);
}

// 回收：排队的直接撤掉不发；在飞的取消请求并把名额让给下一张
{
  const h = harness({ visibleLimit: 1 });
  const a = h.job('a', 0);
  const b = h.job('b', 200);
  const c = h.job('c', 400);
  for (const item of [a, b, c]) h.queue.request(item);
  h.flush();
  h.queue.cancel(b);
  assert.deepEqual(h.stopped, [], '排队中的图撤队，不需要取消任何请求');
  h.queue.cancel(a);
  assert.deepEqual(h.stopped, ['a'], '在飞的图回收时取消请求');
  assert.deepEqual(h.started, ['a', 'c'], '名额让给下一张可见图，撤队的 b 永远不发');
  h.queue.cancel(a);
  assert.deepEqual(h.stopped, ['a'], '重复回收是空操作');
}

// 滚动：可见带移动后重新分配；已经在飞的旧图不被抢占，新可见图不受屏外名额限制
{
  const h = harness({ visibleLimit: 2, prefetchLimit: 1 });
  const old1 = h.job('old1', 0);
  const old2 = h.job('old2', 300);
  const next1 = h.job('next1', 1200);
  const next2 = h.job('next2', 1500);
  for (const item of [old1, old2, next1, next2]) h.queue.request(item);
  h.flush();
  assert.deepEqual(h.started, ['old1', 'old2']);
  h.band.top = 1100;
  h.band.bottom = 2100;
  h.queue.pump();
  assert.deepEqual(h.started, ['old1', 'old2', 'next1', 'next2'], '新可见图立刻拿到名额，旧图继续下完不被取消');
  assert.deepEqual(h.stopped, []);
}

// 命中缓存与重试：不排队直接发，也不挤掉排队顺序
{
  const h = harness({ visibleLimit: 1 });
  const a = h.job('a', 0);
  const cached = h.job('cached', 2000);
  h.queue.request(a);
  h.queue.request(cached, { immediate: true });
  h.flush();
  assert.deepEqual(h.started, ['cached', 'a'], '命中缓存的当场发出，排队的随批次分配');
  h.queue.finish(cached);
  h.queue.request(a, { immediate: true });
  assert.deepEqual(h.started, ['cached', 'a', 'a'], '重试同一张图会重新发出');
  h.queue.finish(a);
  assert.deepEqual(h.queue.stats(), { waiting: 0, running: 0, visible: 0, offscreen: 0 });
}

// 卡住的图超过 stalledMs 后不再占名额，但请求本身不取消
{
  const h = harness({ visibleLimit: 1, stalledMs: 1000 });
  const stuck = h.job('stuck', 0);
  const next = h.job('next', 200);
  h.queue.request(stuck);
  h.queue.request(next);
  h.flush();
  assert.deepEqual(h.started, ['stuck']);
  h.advance(999);
  assert.deepEqual(h.started, ['stuck']);
  h.advance(1);
  assert.deepEqual(h.started, ['stuck', 'next'], '超时后名额让出');
  assert.deepEqual(h.stopped, [], '卡住的请求不取消，下完照样能用');
  h.queue.finish(stuck);
  assert.equal(h.queue.stats().running, 1);
}

// clear：全部撤销，在飞的取消
{
  const h = harness({ visibleLimit: 1 });
  const a = h.job('a', 0);
  const b = h.job('b', 100);
  h.queue.request(a);
  h.queue.request(b);
  h.flush();
  h.queue.clear();
  assert.deepEqual(h.stopped, ['a']);
  assert.deepEqual(h.queue.stats(), { waiting: 0, running: 0, visible: 0, offscreen: 0 });
}

// 可见按图片区域判断：图片在视口上方、只露出正文的卡不占可见名额
{
  const h = harness({ visibleLimit: 1, prefetchLimit: 1 });
  h.band.top = 1000;
  h.band.bottom = 2000;
  const bodyOnly = { name: 'body-only', placement: { top: 600, height: 500, imageHeight: 350, index: 1 }, start() { h.started.push('body-only'); }, stop() {} };
  const image = h.job('image', 1200, 300, 2);
  h.queue.request(bodyOnly);
  h.queue.request(image);
  h.flush();
  assert.deepEqual(h.started, ['image'], '只露出正文的卡排在屏外');
  h.queue.finish(image);
  assert.deepEqual(h.started, ['image', 'body-only']);
}

// 默认上限：一屏常见的可见图数一次发完
{
  const { VISIBLE_IMAGE_CONCURRENCY } = await import('../site/assets/app/image-queue.js');
  assert.ok(VISIBLE_IMAGE_CONCURRENCY >= 12, '可见上限低于一屏可见图数会让最后几张白等');
}

// 回归：往下滚时虚拟列表先建视口上方的卡，它们不能在可见卡登记之前抢走名额
{
  const h = harness({ visibleLimit: 2, prefetchLimit: 1 });
  h.band.top = 2000;
  h.band.bottom = 3000;
  for (const item of [h.job('above1', 1300), h.job('above2', 1600), h.job('vis1', 2100), h.job('vis2', 2400)]) h.queue.request(item);
  h.flush();
  assert.deepEqual(h.started, ['vis1', 'vis2']);
}

console.log('image queue scheduling: PASS');
