import assert from 'node:assert/strict';

// 模块导入时不得碰 window / matchMedia：test_render_ui 会经 lightbox.js 在 Node 里导入它
const {
  depthTargets, springStep, flattenCardDepth, setupCardDepth,
  SPRINGS, REST, MAX_TILT, PRESS_TILT, HOVER_SCALE, PRESS_SCALE, PAN_MAX, PAN_SCALE,
} = await import('../site/assets/app/card-depth.js');

const close = (a, b, label, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${label}: ${a} ≠ ${b}`);

// 没有悬停也没按下：就是静止值
assert.deepEqual(depthTargets({ px: 0.9, py: 0.1, w: 300, h: 400 }), { ...REST, mx: 90, my: 10 });

// 指针在中心：不倾斜、不平移，只放大并亮起
{
  const t = depthTargets({ px: 0.5, py: 0.5, w: 300, h: 300, hover: 1 });
  close(t.rx, 0, '中心 rx');
  close(t.ry, 0, '中心 ry');
  close(t.ix, 0, '中心 ix');
  assert.equal(t.s, HOVER_SCALE);
  assert.equal(t.is, PAN_SCALE);
  assert.equal(t.light, 1);
  assert.equal(t.lift, 1);
}

// 方向：指针在右上，右边、上边下沉（rotateY 正、rotateX 正），图片朝左下挪
{
  const t = depthTargets({ px: 1, py: 0, w: 300, h: 300, hover: 1 });
  close(t.ry, MAX_TILT, '右缘 ry = 最大倾角');
  close(t.rx, MAX_TILT, '上缘 rx = 最大倾角（方图不收）');
  assert.ok(t.ix < 0 && t.iy > 0, `图片应朝指针反方向挪：${t.ix}, ${t.iy}`);
}

// 长图：横轴角按宽高比收小，最多收到一半
{
  const tall = depthTargets({ px: 0.5, py: 0, w: 300, h: 450, hover: 1 });
  close(tall.rx, MAX_TILT * (300 / 450), '2:3 长图 rx');
  const veryTall = depthTargets({ px: 0.5, py: 0, w: 300, h: 1200, hover: 1 });
  close(veryTall.rx, MAX_TILT * 0.5, '极长图 rx 收到一半为止');
  const wide = depthTargets({ px: 0.5, py: 0, w: 600, h: 300, hover: 1 });
  close(wide.rx, MAX_TILT, '横图不放大角度');
}

// 图片平移：上限 4px，窄卡按宽度收；无图卡不挪
{
  const wide = depthTargets({ px: 0, py: 0.5, w: 800, h: 800, hover: 1 });
  close(wide.ix, PAN_MAX, '宽卡平移封顶 4px');
  const narrow = depthTargets({ px: 0, py: 0.5, w: 150, h: 200, hover: 1 });
  close(narrow.ix, 150 * 0.014, '窄卡按宽度收');
  const noImage = depthTargets({ px: 0, py: 0.5, w: 300, h: 200, hover: 1, image: false });
  assert.equal(noImage.ix, 0);
  assert.equal(noImage.is, 1);
}

// 按压：下沉到 0.975；电脑朝按下点多倾到 7°，触屏（不倾斜）只缩放、不平移
{
  const desk = depthTargets({ px: 1, py: 0.5, w: 300, h: 300, hover: 1, pressed: 1, pressTilt: true });
  assert.equal(desk.s, PRESS_SCALE);
  close(desk.ry, PRESS_TILT, '按下右缘 ry');
  assert.ok(desk.light >= 0.75);
  const touch = depthTargets({ px: 1, py: 0, w: 300, h: 300, pressed: 1 });
  assert.equal(touch.s, PRESS_SCALE);
  assert.equal(touch.rx, 0);
  assert.equal(touch.ry, 0);
  assert.equal(touch.ix, 0);
  assert.equal(touch.is, 1);
}

// 弹簧：跟手临界阻尼不过冲；回弹欠阻尼过冲一次；掉帧 50ms 也稳定收敛
function run(spring, from, to, dt, seconds) {
  const c = { x: from, v: 0 };
  let peak = from;
  for (let t = 0; t < seconds; t += dt) {
    springStep(c, to, spring, dt);
    peak = Math.max(peak, c.x);
  }
  return { end: c.x, peak };
}
{
  const follow = run(SPRINGS.follow, 0, 1, 1 / 60, 1.5);
  close(follow.end, 1, '跟手收敛', 1e-3);
  assert.ok(follow.peak <= 1 + 1e-3, `跟手不该过冲：${follow.peak}`);
  const bounce = run(SPRINGS.bounce, 0, 1, 1 / 60, 2);
  close(bounce.end, 1, '回弹收敛', 1e-3);
  assert.ok(bounce.peak > 1.1, `回弹应过冲一次：${bounce.peak}`);
  for (const [name, spring] of Object.entries(SPRINGS)) {
    const slow = run(spring, 0, 1, 0.05, 3);
    close(slow.end, 1, `${name} 在 50ms 一帧下收敛`, 1e-2);
    assert.ok(Number.isFinite(slow.peak) && slow.peak < 1.6, `${name} 掉帧时不能炸开：${slow.peak}`);
  }
}

// 没装起来时这两个出口都是空操作，不抛错
flattenCardDepth(null);
flattenCardDepth({});
setupCardDepth();

console.log('card depth tests passed');
