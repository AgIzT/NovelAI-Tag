import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }

  contains(name) {
    return this.values.has(name);
  }
}

const grid = { hidden: true };
const main = { classList: new FakeClassList() };
const elements = new Map([
  ['#skeletonGrid', grid],
  ['#main', main],
]);

let now = 0;
let nextTimerId = 1;
const timers = new Map();
const setTimer = (callback, delay = 0) => {
  const id = nextTimerId++;
  timers.set(id, { callback, at: now + Number(delay || 0) });
  return id;
};
const clearTimer = id => timers.delete(id);
const advance = ms => {
  now += ms;
  while (true) {
    const due = [...timers.entries()]
      .filter(([, timer]) => timer.at <= now)
      .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
    if (!due.length) break;
    const [id, timer] = due[0];
    timers.delete(id);
    timer.callback();
  }
};

globalThis.document = {
  querySelector(selector) {
    return elements.get(selector) || null;
  },
};
globalThis.window = {
  performance: { now: () => now },
  setTimeout: setTimer,
};
globalThis.setTimeout = setTimer;
globalThis.clearTimeout = clearTimer;

const { showSkeleton, hideSkeleton, replaceSkeleton } = await import('../site/assets/app/feedback.js');

// 错误/空态的普通 hide 仍满足最短展示时长，避免刚出现就闪退。
showSkeleton('failure', { delay: 0, minVisible: 300 });
assert.equal(grid.hidden, false);
assert.equal(main.classList.contains('has-skeleton'), true);
assert.equal(main.classList.contains('skeleton-visible'), true);
advance(120);
const failureHide = hideSkeleton('failure');
assert.equal(grid.hidden, false);
advance(179);
assert.equal(grid.hidden, false);
advance(1);
assert.equal(await failureHide, true);
assert.equal(grid.hidden, true);

// 成功态立即替换：撤 flow skeleton 与插入真实内容必须在同一任务内完成，不能拖慢 LCP。
showSkeleton('success', { delay: 0, minVisible: 300 });
advance(40);
let renderCount = 0;
const successReplacement = replaceSkeleton('success', () => {
  renderCount += 1;
  assert.equal(grid.hidden, true, 'render 时 flow skeleton 应已撤下');
  assert.equal(main.classList.contains('has-skeleton'), false);
  assert.equal(main.classList.contains('skeleton-visible'), false);
});
assert.equal(renderCount, 1, 'replaceSkeleton 返回前应已同步渲染');
assert.equal(await successReplacement, true);
assert.equal(renderCount, 1);

// 快请求要取消延迟出现的骨架，并在同一任务内直接渲染，避免闪一下骨架。
showSkeleton('fast', { delay: 200, minVisible: 300 });
assert.equal(grid.hidden, true);
let fastRendered = false;
const fastReplacement = replaceSkeleton('fast', () => {
  fastRendered = true;
  assert.equal(grid.hidden, true);
});
assert.equal(fastRendered, true);
assert.equal(await fastReplacement, true);
advance(250);
assert.equal(grid.hidden, true, '已取消的延迟 timer 不得重新显示骨架');

// stale token 不能撤掉新加载的骨架，也不能渲染旧内容。
showSkeleton('old', { delay: 0, minVisible: 300 });
showSkeleton('new', { delay: 0, minVisible: 300 });
let staleRendered = false;
const staleReplacement = replaceSkeleton('old', () => { staleRendered = true; });
assert.equal(await staleReplacement, false);
assert.equal(staleRendered, false);
assert.equal(grid.hidden, false);
advance(300);
assert.equal(await hideSkeleton('new'), true);
assert.equal(grid.hidden, true);

// 即使真实渲染抛错，也要先清掉骨架状态，让上层 catch 显示错误信息。
showSkeleton('throws', { delay: 0, minVisible: 300 });
await assert.rejects(
  replaceSkeleton('throws', () => {
    assert.equal(grid.hidden, true);
    throw new Error('render failed');
  }),
  /render failed/,
);
assert.equal(main.classList.contains('has-skeleton'), false);
assert.equal(main.classList.contains('skeleton-visible'), false);

const stylesSource = await readFile(new URL('../site/assets/styles.css', import.meta.url), 'utf8');
const chipRailSkeletonHeights = [...stylesSource.matchAll(
  /\.main\.skeleton-visible \.chip-rail:empty\{[^}]*min-height:(\d+)px/g,
)].map(match => Number(match[1]));
assert.deepEqual(chipRailSkeletonHeights, [46, 46], '基础与移动端骨架 chip rail 高度必须同为 46px');

console.log('skeleton transition regressions: PASS');
