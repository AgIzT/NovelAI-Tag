/* 卡片悬停立体：电脑上鼠标停在卡片上，卡片朝鼠标轻倾、图片反向挪几像素，鼠标处有反光、卡边亮起、影子投向另一侧；
   按下卡片下沉、松手回弹（触屏只缩放）。决策见本地私有文档 docs/decisions/卡片立体悬停.md。
   - 倾斜进 masonry 位置模板末尾的 --card-tilt 槽，由 CSS 用这里写的 --depth-* 数字拼出来。脚本只写有限数字：
     槽里一旦是坏值，整条 transform 失效，卡片会被甩到瀑布流左上角。
   - 只有正在动的那张卡带 .depth-live，停稳后摘类、删变量，静止卡的 transform 与原来逐字相同。
   - 所有量走弹簧：跟手临界阻尼不过冲，松手回弹欠阻尼过冲一次再落定。
   - 大图飞入前 lightbox.js 调 flattenCardDepth 先把倾斜和图片平移归零，再量卡片图片的位置。
   - 滚动时放掉悬停，鼠标真动了再接上；放手期间 #masonry 带 .depth-hold，压住站里原有的悬停样式，
     否则鼠标一动会先闪回旧样式、再从零起弹簧。
   - 不动：系统「减少动态效果」、motion=off、开场、换书、大图打开、瀑布流重排 / 筛选 / 屏蔽补位。
   导入时不碰 window / matchMedia（test_render_ui 在 Node 里经 lightbox.js 导入本模块），一切在 setupCardDepth 里绑。 */

export const MAX_TILT = 5;          // 悬停最大倾角（度），鼠标那一侧下沉
export const PRESS_TILT = 7;        // 按下时朝按下点的倾角
export const HOVER_SCALE = 1.01;
export const PRESS_SCALE = 0.975;
export const PAN_MAX = 4;           // 图片平移上限（px）
export const PAN_SCALE = 1.04;      // 图片放大留出平移余量

/* k 刚度、c 阻尼（质量取 1）。c = 2√k 为临界阻尼；bounce 的阻尼比约 0.37，过冲一次约两成。 */
export const SPRINGS = {
  follow: { k: 260, c: 32 },
  spot: { k: 520, c: 46 },
  light: { k: 90, c: 19 },
  press: { k: 900, c: 60 },
  bounce: { k: 420, c: 15 },
};

export const REST = { rx: 0, ry: 0, s: 1, lift: 0, light: 0, ix: 0, iy: 0, is: 1, mx: 50, my: 50 };
const EPS = { rx: 0.01, ry: 0.01, s: 0.0003, lift: 0.003, light: 0.003, ix: 0.03, iy: 0.03, is: 0.0003, mx: 0.08, my: 0.08 };
const CHANNELS = Object.keys(REST);
const BOUNCY = new Set(['rx', 'ry', 's', 'lift']);
const BOUNCE_MS = 900;
const TOUCH_DELAY_MS = 70;
const TOUCH_SLOP = 8;
const EDGE_HOLD_PX = 3;
const RESUME_SLOP = 3;
const BUSY_ROOT = ['intro-arm', 'codex-switching', 'codex-developing', 'lightbox-open'];
const BUSY_GRID = ['is-relayouting', 'is-blocking-update', 'is-filtering'];

/* 目标值。px / py 是指针在卡片里的相对位置（0–1），w / h 是卡片尺寸；image 表示卡片有图可挪。 */
export function depthTargets({ px = 0.5, py = 0.5, w = 1, h = 1, hover = 0, pressed = 0, pressTilt = false, image = true } = {}) {
  const t = { ...REST };
  const dx = px - 0.5;
  const dy = py - 0.5;
  // 长图绕横轴转同样的角度，上下两端甩得比宽度方向多，按宽高比收一点
  const aspect = Math.min(1, Math.max(0.5, w / (h || 1)));
  t.mx = px * 100;
  t.my = py * 100;
  t.light = hover;
  t.lift = hover;
  if (hover) {
    t.ry = dx * 2 * MAX_TILT;
    t.rx = -dy * 2 * MAX_TILT * aspect;
    t.s = HOVER_SCALE;
    if (image) {
      const m = Math.min(PAN_MAX, w * 0.014);
      t.ix = -dx * 2 * m;
      t.iy = -dy * 2 * m;
      t.is = PAN_SCALE;
    }
  }
  if (pressed) {
    t.s = PRESS_SCALE;
    t.lift = 0.2;
    t.light = Math.max(t.light, 0.75);
    if (pressTilt) {
      t.ry = dx * 2 * PRESS_TILT;
      t.rx = -dy * 2 * PRESS_TILT * aspect;
    }
  }
  return t;
}

/* 半隐式欧拉，按 ≤8ms 分步，硬弹簧在掉帧时也不会炸开 */
export function springStep(channel, target, spring, dt) {
  let rem = dt;
  while (rem > 1e-6) {
    const step = Math.min(rem, 0.008);
    channel.v += (spring.k * (target - channel.x) - spring.c * channel.v) * step;
    channel.x += channel.v * step;
    rem -= step;
  }
  return channel;
}

const live = new Map();
const pointer = { x: -1, y: -1, target: null, type: '' };
let bound = false;
let root = null;
let grid = null;
let gridRect = null;
let fineQuery = null;
let reduceQuery = null;
let hoverCard = null;
let pointerDirty = false;
let resumeAt = null;     // 放手后鼠标停在哪；挪开几像素才接回
let wasOff = false;
let press = null;
let raf = 0;
let last = 0;

const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const clamp01 = v => Math.min(1, Math.max(0, v));
const still = () => root.classList.contains('motion-off') || reduceQuery.matches;
const busy = () => BUSY_ROOT.some(c => root.classList.contains(c)) || BUSY_GRID.some(c => grid.classList.contains(c));
const enabled = () => !still() && !busy();
const isCard = el => el?.parentElement === grid && el.classList.contains('card');
const cardOf = el => {
  const card = el?.closest?.('.card');
  return isCard(card) ? card : null;
};
const eligible = card => card.isConnected
  && !card.classList.contains('card-retiring')
  && !card.classList.contains('card-leaving')
  && !card.classList.contains('card-enter');
/* 这一下点击会开大图还是复制：手机一律开详情；电脑上无图卡、开了「点击卡片放大」或图包卡开大图（卡上提示「点击查看」）。
   开大图时按下不倾斜，免得先歪过去、点击那一刻又被 flattenCardDepth 摆正。 */
const opensView = card => innerWidth <= 600
  || card.classList.contains('no-img')
  || Boolean(card.querySelector('.copy-hint')?.classList.contains('is-view'));

/* 卡片没被倾斜过的矩形：瀑布流容器位置 + 卡片自己的 --card-x / --card-y 与内联尺寸，不触发排版。
   不用卡片的 getBoundingClientRect——卡歪了以后那是投影的外包框，拿它算指针位置会和倾斜互相追。 */
function cardBox(card) {
  const r = gridRect || grid.getBoundingClientRect();
  const cs = card.style;
  const x = parseFloat(cs.getPropertyValue('--card-x')) || 0;
  const y = (parseFloat(cs.getPropertyValue('--card-y')) || 0) + (parseFloat(cs.getPropertyValue('--entry-offset')) || 0);
  return { left: r.left + x, top: r.top + y, width: parseFloat(cs.width) || card.offsetWidth, height: parseFloat(cs.height) || card.offsetHeight };
}
const inBox = (b, x, y, pad) => x >= b.left - pad && x <= b.left + b.width + pad && y >= b.top - pad && y <= b.top + b.height + pad;

function aimAt(st, x, y) {
  const b = cardBox(st.card);
  st.px = clamp01((x - b.left) / (b.width || 1));
  st.py = clamp01((y - b.top) / (b.height || 1));
  st.w = b.width;
  st.h = b.height;
}

function stateFor(card, at) {
  let st = live.get(card);
  if (st) return st;
  st = { card, hover: 0, pressed: 0, pressTilt: false, px: 0.5, py: 0.5, w: 1, h: 1, bounceUntil: 0, image: !card.classList.contains('no-img'), ch: {}, out: {} };
  for (const k of CHANNELS) st.ch[k] = { x: REST[k], v: 0 };
  if (at && at.x >= 0) {
    aimAt(st, at.x, at.y);
    // 光从指针处亮起，不从卡片中心滑过去
    st.ch.mx.x = st.px * 100;
    st.ch.my.x = st.py * 100;
  }
  live.set(card, st);
  card.classList.add('depth-live');
  return st;
}

function drop(st) {
  live.delete(st.card);
  st.card.classList.remove('depth-live');
  for (const name of Object.keys(st.out)) st.card.style.removeProperty(name);
  if (hoverCard === st.card) hoverCard = null;
}

function setVar(st, name, value) {
  if (st.out[name] === value) return;
  st.out[name] = value;
  st.card.style.setProperty(name, value);
}

function render(st) {
  const c = st.ch;
  const lift = finite(c.lift.x, 0);
  const mx = finite(c.mx.x, 50);
  const my = finite(c.my.x, 50);
  setVar(st, '--depth-rx', `${finite(c.rx.x, 0).toFixed(3)}deg`);
  setVar(st, '--depth-ry', `${finite(c.ry.x, 0).toFixed(3)}deg`);
  setVar(st, '--depth-s', finite(c.s.x, 1).toFixed(4));
  setVar(st, '--depth-lift', lift.toFixed(3));
  setVar(st, '--depth-light', finite(c.light.x, 0).toFixed(3));
  setVar(st, '--depth-mx', `${mx.toFixed(2)}%`);
  setVar(st, '--depth-my', `${my.toFixed(2)}%`);
  // 光在指针处，影子投向另一侧；抬得越高影子越远越散
  setVar(st, '--depth-sx', (-(mx / 100 - 0.5) * 14 * lift).toFixed(1));
  setVar(st, '--depth-sy', (2 + 10 * lift - (my / 100 - 0.5) * 8 * lift).toFixed(1));
  setVar(st, '--depth-sb', Math.max(0, 12 + 22 * lift).toFixed(1));
  if (st.image) {
    setVar(st, '--depth-ix', `${finite(c.ix.x, 0).toFixed(2)}px`);
    setVar(st, '--depth-iy', `${finite(c.iy.x, 0).toFixed(2)}px`);
    setVar(st, '--depth-is', finite(c.is.x, 1).toFixed(4));
  }
}

function springFor(st, k, now) {
  if (k === 'mx' || k === 'my') return SPRINGS.spot;
  if (k === 'light') return SPRINGS.light;
  if (st.pressed) return SPRINGS.press;
  if (now < st.bounceUntil && BOUNCY.has(k)) return SPRINGS.bounce;
  return SPRINGS.follow;
}

function step(st, dt, now) {
  const t = depthTargets(st);
  let moving = false;
  for (const k of CHANNELS) {
    const c = springStep(st.ch[k], t[k], springFor(st, k, now), dt);
    if (Math.abs(t[k] - c.x) < EPS[k] && Math.abs(c.v) < EPS[k] * 8) {
      c.x = t[k];
      c.v = 0;
    } else {
      moving = true;
    }
  }
  return moving;
}

// 瞬间回到静止值（保留 .depth-live，下一帧停稳后再摘），用于忙时放手、拖拽开始
function snapRest(st) {
  st.hover = 0;
  st.pressed = 0;
  st.pressTilt = false;
  st.bounceUntil = 0;
  for (const k of CHANNELS) { st.ch[k].x = REST[k]; st.ch[k].v = 0; }
  render(st);
}

function schedule() {
  if (!raf) raf = requestAnimationFrame(tick);
}

function tick(now) {
  raf = 0;
  const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
  last = now;
  // 先读：整帧只量一次瀑布流位置，下面只读内联样式、只写变量
  gridRect = grid.getBoundingClientRect();
  if (pointerDirty) resolveHover();
  let again = false;
  for (const st of [...live.values()]) {
    if (!eligible(st.card)) { drop(st); continue; }
    if (st.card === hoverCard && pointer.x >= 0) aimAt(st, pointer.x, pointer.y);
    const moving = step(st, dt, now);
    render(st);
    if (moving || now < st.bounceUntil) again = true;
    else if (!st.hover && !st.pressed) drop(st);
  }
  gridRect = null;
  if (again) schedule();
  else last = 0;
}

/* ---------- 悬停 ---------- */
function hoverAllowed() {
  return fineQuery.matches && pointer.type !== 'touch' && !resumeAt && enabled();
}

function setHover(card) {
  if (card === hoverCard) return;
  const old = hoverCard && live.get(hoverCard);
  if (old) old.hover = 0;
  hoverCard = card;
  if (card) stateFor(card, pointer).hover = 1;
}

function resolveHover() {
  pointerDirty = false;
  if (!hoverAllowed()) { setHover(null); return; }
  const el = pointer.target;
  const cand = cardOf(el);
  if (cand && eligible(cand)) { setHover(cand); return; }
  // 卡片倾斜后，下沉的那条边会从指针底下退开几像素；指针还在卡片原来的位置里就别放手，免得边上来回抖
  const cur = hoverCard?.isConnected ? hoverCard : null;
  if (cur && el?.closest?.('.masonry') && inBox(cardBox(cur), pointer.x, pointer.y, EDGE_HOLD_PX)) return;
  setHover(null);
}

function setHold(on) {
  grid.classList.toggle('depth-hold', on);
}

/* 放手并等指针真的挪开再接回：滚动、忙状态结束、拖拽之后。期间压住站里原有的悬停样式。 */
function holdUntilMoved() {
  if (pointer.x < 0 || pointer.type === 'touch' || !fineQuery.matches) return;
  resumeAt = { x: pointer.x, y: pointer.y };
  setHold(true);
  pointerDirty = true;
  schedule();
}

function releaseAll() {
  cancelPress();
  for (const st of live.values()) snapRest(st);
  hoverCard = null;
  schedule();
}

function onStateChange() {
  if (!enabled()) {
    if (live.size || press) releaseAll();
    if (resumeAt) { resumeAt = null; setHold(false); }
    wasOff = true;
    return;
  }
  if (wasOff) {
    wasOff = false;
    holdUntilMoved();
  }
}

/* ---------- 按压 ---------- */
function startPress() {
  if (!press || press.on) return;
  press.on = true;
  press.at = performance.now();
  const st = stateFor(press.card, press);
  aimAt(st, press.x, press.y);
  st.pressed = 1;
  st.pressTilt = press.type !== 'touch' && !press.view;
  schedule();
}

function releasePress(bounce) {
  if (!press) return;
  clearTimeout(press.timer);
  const p = press;
  press = null;
  const now = performance.now();
  if (p.on) {
    const st = live.get(p.card);
    if (!st) return;
    st.pressed = 0;
    st.pressTilt = false;
    if (bounce) {
      st.bounceUntil = now + BOUNCE_MS;
      // 点得太快，下沉还没走完就松手了：补一点向下的速度，保证看得到一次「按下—弹回」
      if (now - p.at < 90) st.ch.s.v -= 0.35;
    }
  } else if (bounce && eligible(p.card)) {
    // 手指快速点一下，按压延时还没到：直接给一次向下的冲量，弹簧自己完成下沉和回弹
    const st = stateFor(p.card, p);
    st.ch.s.v -= 0.55;
    st.bounceUntil = now + BOUNCE_MS;
  }
  schedule();
}

function cancelPress() {
  releasePress(false);
}

/**
 * 大图飞入量卡片图片前调用：把倾斜和图片平移瞬间归零并立刻写回，量到的就是卡片端正时的位置。
 * 卡片缩放保留：缩放绕卡片中心，量到的矩形就是屏幕上看到的那张。随后 lightbox-open 会让整张卡放手。
 * @param {Element|null} el 卡片或卡片里的元素；不是瀑布流卡片时什么都不做
 */
export function flattenCardDepth(el) {
  const card = el?.closest?.('.card');
  const st = card && live.get(card);
  if (!st) return;
  for (const k of ['rx', 'ry', 'ix', 'iy', 'is']) { st.ch[k].x = REST[k]; st.ch[k].v = 0; }
  st.pressTilt = false;
  render(st);
}

export function setupCardDepth() {
  if (bound || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  root = document.documentElement;
  grid = document.getElementById('masonry');
  if (!grid) return;
  bound = true;
  fineQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
  reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  wasOff = !enabled();

  window.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch') {
      pointer.type = 'touch';
      if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > TOUCH_SLOP) cancelPress();
      return;
    }
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.target = e.target;
    pointer.type = e.pointerType;
    if (!fineQuery.matches || !enabled()) return;
    if (resumeAt) {
      if (Math.hypot(e.clientX - resumeAt.x, e.clientY - resumeAt.y) < RESUME_SLOP) return;
      resumeAt = null;
      setHold(false);
    }
    if (!hoverCard && !cardOf(e.target)) return;
    pointerDirty = true;
    schedule();
  }, { passive: true, capture: true });

  const pointerGone = () => {
    pointer.target = null;
    pointer.x = -1;
    if (resumeAt) { resumeAt = null; setHold(false); }
    if (!hoverCard) return;
    pointerDirty = true;
    schedule();
  };
  root.addEventListener('mouseleave', pointerGone);
  window.addEventListener('blur', pointerGone);

  window.addEventListener('scroll', () => {
    if (press?.type === 'touch') cancelPress();
    if (!enabled()) return;
    if (hoverCard || resumeAt || grid.contains(pointer.target)) holdUntilMoved();
  }, { passive: true });

  window.addEventListener('pointerdown', e => {
    pointer.type = e.pointerType;
    if (e.button !== 0 || !e.isPrimary || !enabled()) return;
    const card = cardOf(e.target);
    if (!card || !eligible(card) || e.target.closest('button, a, input, textarea, select, label')) return;
    cancelPress();
    press = { card, id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, timer: 0, on: false, at: 0, view: opensView(card) };
    if (e.pointerType === 'touch') press.timer = setTimeout(startPress, TOUCH_DELAY_MS);
    else startPress();
  }, { passive: true, capture: true });
  window.addEventListener('pointerup', e => {
    if (press && e.pointerId === press.id) releasePress(true);
  }, { passive: true, capture: true });
  window.addEventListener('pointercancel', e => {
    if (press && e.pointerId === press.id) cancelPress();
  }, { passive: true, capture: true });

  // 收藏卡可拖拽：拖拽图像在 dragstart 这一刻截取，先把卡片摆正、灭光
  window.addEventListener('dragstart', e => {
    const card = cardOf(e.target);
    cancelPress();
    const st = card && live.get(card);
    if (!st) return;
    snapRest(st);
    if (hoverCard === card) hoverCard = null;
    holdUntilMoved();
  }, true);

  // 开场、换书、大图、重排、筛选、屏蔽补位、motion=off：放手；结束后等指针挪开再接回
  const observer = new MutationObserver(onStateChange);
  observer.observe(root, { attributes: true, attributeFilter: ['class'] });
  observer.observe(grid, { attributes: true, attributeFilter: ['class'] });
  reduceQuery.addEventListener?.('change', onStateChange);
}
