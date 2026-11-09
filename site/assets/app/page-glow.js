/* 动态背景：各皮肤浅色档下，页面两角的光晕慢慢呼吸；电脑上再带一团跟着鼠标的光（触屏不响应，手机只呼吸）。
   - 只动页面最底层：body 末尾一张不透明画布（.page-glow），盖在 body::before 的静态光晕上；卡片、顶栏、控件都不碰。
   - 画布只有视口的 1/6，由浏览器放大铺满：光团本来就是糊的，放大看不出差别，也不用给每团光单独建整屏合成层。
   - t=0 那一帧与 tokens.css 的 --page-wash 完全一致：开场幕布带的是静态光晕，开幕时接得上；停用时淡出也接得上。
   - 颜色读当前皮肤的 --glow-1/2/3 与 --glow-spot；换皮肤、切深浅色时由 ui.js 调 syncPageGlow 重读，逐帧不读样式。
   - 不动的情形：设置里关掉、系统「减少动态效果」、motion=off、深色档、皮肤没有光晕色。词条详情打开时暂停（遮罩的毛玻璃会每帧重新模糊）。
   决策见本地私有文档 docs/decisions/梦境动态背景.md。 */

import { prefersReducedMotion } from './utils.js';

const SCALE = 6;
// 呼吸约 20 帧：光团最快每秒挪几十像素，每帧不到 2px；顶栏毛玻璃背后每变一次就要重新模糊，帧数能省就省
const BREATH_FRAME_MS = 50;
// 跟手：光团每帧追上剩余距离的一部分。鼠标每秒划 1000px 时落后约 45px
export const FOLLOW_SEC = 0.04;
const SPOT_IN_SEC = 0.18;
const SPOT_OUT_SEC = 0.7;
const SPOT_RADIUS = 380;
const PAUSE_POLL_MS = 300;
const TAU = Math.PI * 2;

const S = (t, period) => Math.sin(TAU * t / period);
const C = (t, period) => (1 - Math.cos(TAU * t / period)) / 2;

/* 三团光：底部第三色先画，再画左上、右上两团（就是 --page-wash 那两团）。各自周期互质，不会整齐地循环。
   t=0 时第三色透明、两团在原位原大，和静态光晕一模一样。 */
export function breathingBlobs(t, vw, vh) {
  const vm = Math.max(vw, vh) / 100;
  const s1 = 1 + 0.09 * S(t, 39);
  const s2 = 1 - 0.08 * S(t, 44);
  return [
    { color: 3, x: vw * 0.5 + vm * 16 * S(t, 71), y: vh * 1.04 - vm * 12 * C(t, 53), rx: 64 * vm, ry: 46 * vm, alpha: 0.8 * C(t, 67) },
    { color: 1, x: vm * (8 * S(t, 46) + 3 * S(t, 27)), y: vm * (7 * S(t, 58) + 3 * S(t, 33)), rx: 70 * vm * s1, ry: 52 * vm * s1, alpha: 1 },
    { color: 2, x: vw - vm * (9 * S(t, 52) + 3 * S(t, 31)), y: vh * 0.06 + vm * (8 * S(t, 63) + 3 * S(t, 23)), rx: 70 * vm * s2, ry: 56 * vm * s2, alpha: 1 },
  ];
}

export function followStep(current, target, dt, tau) {
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

const glow = {
  enabled: true, bound: false, live: false,
  layer: null, canvas: null, ctx: null, pal: null,
  raf: 0, timer: 0, last: 0, lastDraw: 0, t: 0, vw: 0, vh: 0,
  spot: { x: 0, y: 0, tx: 0, ty: 0, a: 0, ta: 0 },
};

const hex = value => {
  let s = String(value || '').trim();
  if (s.length === 4 && s[0] === '#') s = '#' + [...s.slice(1)].map(c => c + c).join('');
  if (!/^#[0-9a-f]{6}$/i.test(s)) return null;
  return [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16));
};
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));

// 逐帧会调，只看类名和开关；皮肤有没有光晕色由 syncPageGlow 读样式时一并判断
function shouldRun() {
  const body = document.body;
  return Boolean(body) && glow.enabled && !body.classList.contains('dark')
    && !document.documentElement.classList.contains('motion-off') && !prefersReducedMotion();
}

// 读当前皮肤的光晕色；没有 --glow-1/2 的页面或皮肤返回 false，动态层不起
function readPalette() {
  const cs = getComputedStyle(document.body);
  const get = name => hex(cs.getPropertyValue(name));
  const g1 = get('--glow-1');
  const g2 = get('--glow-2');
  if (!g1 || !g2) { glow.pal = null; return false; }
  const g3 = get('--glow-3') || g1;
  glow.pal = {
    bg: get('--bg') || [247, 247, 251],
    1: g1,
    2: g2,
    3: g3,
    spot: get('--glow-spot') || mix(g3, get('--accent') || g1, 0.28),
  };
  return true;
}

function ensureLayer() {
  if (glow.layer) return;
  const layer = document.createElement('div');
  layer.className = 'page-glow';
  layer.setAttribute('aria-hidden', 'true');
  layer.dataset.state = 'off';
  const canvas = document.createElement('canvas');
  layer.appendChild(canvas);
  document.body.appendChild(layer);
  glow.layer = layer;
  glow.canvas = canvas;
  glow.ctx = canvas.getContext('2d', { alpha: false });
}

function resize() {
  glow.vw = innerWidth;
  glow.vh = innerHeight;
  const w = Math.max(24, Math.ceil(glow.vw / SCALE));
  const h = Math.max(24, Math.ceil(glow.vh / SCALE));
  // 赋值就会清空画布并重新分配，尺寸没变不碰
  if (glow.canvas.width !== w) glow.canvas.width = w;
  if (glow.canvas.height !== h) glow.canvas.height = h;
}

// 一团光：中心 (x,y)、横纵半径 rx/ry（CSS 像素），到 72% 处淡尽——和 --page-wash 同一条渐变
function blob(x, y, rx, ry, color, alpha) {
  if (alpha <= 0.003) return;
  const { ctx, canvas } = glow;
  const kx = canvas.width / glow.vw;
  const ky = canvas.height / glow.vh;
  ctx.save();
  ctx.translate(x * kx, y * ky);
  ctx.scale(rx * kx, ry * ky);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(0.72, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
}

function draw() {
  const { ctx, canvas, pal, spot } = glow;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = rgba(pal.bg, 1);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const b of breathingBlobs(glow.t, glow.vw, glow.vh)) blob(b.x, b.y, b.rx, b.ry, pal[b.color], b.alpha);
  blob(spot.x, spot.y, SPOT_RADIUS, SPOT_RADIUS, pal.spot, 0.95 * spot.a);
}

// 推进指尖光，返回它是否还在动（位置没追上或正在亮起 / 淡出）
function stepSpot(dt) {
  const spot = glow.spot;
  if (!dt) return spot.a !== spot.ta;
  spot.x = followStep(spot.x, spot.tx, dt, FOLLOW_SEC);
  spot.y = followStep(spot.y, spot.ty, dt, FOLLOW_SEC);
  spot.a = followStep(spot.a, spot.ta, dt, spot.ta > spot.a ? SPOT_IN_SEC : SPOT_OUT_SEC);
  if (Math.abs(spot.ta - spot.a) < 0.004) spot.a = spot.ta;
  return spot.a !== spot.ta || (spot.a > 0 && (Math.abs(spot.tx - spot.x) > 0.4 || Math.abs(spot.ty - spot.y) > 0.4));
}

function setState(next) {
  if (glow.layer && glow.layer.dataset.state !== next) glow.layer.dataset.state = next;
}

function stopLoop() {
  if (glow.raf) cancelAnimationFrame(glow.raf);
  clearTimeout(glow.timer);
  glow.raf = 0;
  glow.timer = 0;
  glow.last = 0;
}

// 立即排下一帧（指针动了、刚启用）；已在排队的定时器作废
function kickNow() {
  if (!glow.live) return;
  if (glow.timer) { clearTimeout(glow.timer); glow.timer = 0; }
  if (!glow.raf) glow.raf = requestAnimationFrame(tick);
}

function scheduleLater(ms) {
  glow.timer = setTimeout(() => {
    glow.timer = 0;
    if (glow.live && !glow.raf) glow.raf = requestAnimationFrame(tick);
  }, ms);
}

function tick(now) {
  glow.raf = 0;
  if (!glow.live) return;
  // 皮肤、深浅色由 ui.js 主动同步；motion-off 之类别处改的状态在这里兜底
  if (!shouldRun()) { syncPageGlow(); return; }
  const html = document.documentElement;
  if (html.classList.contains('lightbox-open')) {
    setState('paused');
    glow.last = 0;
    scheduleLater(PAUSE_POLL_MS);
    return;
  }
  setState('running');
  const dt = glow.last ? Math.min(0.05, (now - glow.last) / 1000) : 0;   // 切后台回来不跳
  glow.last = now;
  // 开场幕布带的是静态光晕：开幕前时钟停在 0，掀开时两边一模一样
  if (!html.classList.contains('intro-arm')) glow.t += dt;
  const moving = stepSpot(dt);
  if (moving || now - glow.lastDraw >= BREATH_FRAME_MS) {
    draw();
    glow.lastDraw = now;
  }
  // 指尖在动时每帧都画，否则光团会一顿一顿地跟；只剩呼吸时隔一段再画
  if (moving) glow.raf = requestAnimationFrame(tick);
  else scheduleLater(Math.max(0, BREATH_FRAME_MS - 17));
}

/* 按当前皮肤 / 深浅色 / 开关 / 动效偏好开或关。fade 只给设置开关用：换皮肤、切深色时静态光晕本来也是立刻变的，
   动态层跟着立刻换，免得浅色光晕在黑底上慢慢褪掉。 */
export function syncPageGlow({ fade = false } = {}) {
  const want = shouldRun() && readPalette();
  if (want) {
    ensureLayer();
    resize();
    draw();   // 先画好再显形，第一眼就是对的
    if (!glow.live) {
      glow.live = true;
      showLayer(true, fade);
    }
    setState('running');
    kickNow();
  } else if (glow.live) {
    glow.live = false;
    stopLoop();
    showLayer(false, fade);
    setState('off');
  }
}

function showLayer(on, fade) {
  const layer = glow.layer;
  if (!fade) {
    layer.style.transition = 'none';
    layer.classList.toggle('is-live', on);
    void layer.offsetWidth;
    layer.style.transition = '';
  } else {
    layer.classList.toggle('is-live', on);
  }
}

export function setPageGlowEnabled(on) {
  glow.enabled = Boolean(on);
  syncPageGlow({ fade: true });
}

export function setupPageGlow({ enabled = true } = {}) {
  glow.enabled = Boolean(enabled);
  if (!glow.bound) {
    glow.bound = true;
    let resizeRaf = 0;
    addEventListener('resize', () => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        if (!glow.live) return;
        resize();
        draw();
      });
    });
    addEventListener('pointermove', event => {
      if (event.pointerType !== 'mouse' || !glow.live) return;
      const spot = glow.spot;
      spot.tx = event.clientX;
      spot.ty = event.clientY;
      // 光已经灭了就从指针处直接亮起，不从上次的位置扫过来
      if (spot.a < 0.02) { spot.x = spot.tx; spot.y = spot.ty; }
      spot.ta = 1;
      kickNow();
    }, { passive: true });
    document.documentElement.addEventListener('mouseleave', () => {
      glow.spot.ta = 0;
      kickNow();
    });
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => syncPageGlow());
  }
  syncPageGlow();
}
