/* 换法典过渡：封面接力 + 显影落地。

   点下的那一帧就起飞：按下那本书的封面换成一个替身，从书卡飞进横幅封面位；旧内容同时淡成潜影、撒一层颗粒
   （加噪），菜单照常退场。JUMP_MS 后旧内容基本淡尽，页面回顶，横幅、侧栏标题与顶栏按钮换成新书——身份只用
   codexes.json 的 meta，不等数据。数据到了才落地：新书首屏卡片先停在潜影，等首排焦点图 load + decode，
   再一起显影、对角浮入，颗粒退场，进度条揭开并从 0 数到配图数（开场同款）。
   慢的时候（点击后 SAMPLE_SHOW_MS 数据还没到）进度行计步 step N/28，按时间渐近、封顶 27——
   跟开场同一条规矩：数据没到绝不谎报采样完成，28 这一格留给落地。

   ⚠ 不用 View Transition：它要等新画面整页画好才开播，渲染整本书（大书约 80ms）的这段时间旧画面是冻住的，
   点下去会先顿一下（2026-10-05 维护者试用反馈）；补间框的宽高动画还跑在主线程，取数据、解析、渲染的长任务
   都会让它卡。现在飞行与淡入淡出只动 transform / opacity，交给合成线程，主线程再忙也不掉帧；
   回顶、换身份、渲染这些主线程上的变化都落在旧内容已经淡成潜影之后。

   红线同开场：不做全屏 blur/filter，模糊只给首排焦点图（预算见 masonry.js introFocusCount）。
   减少动效、motion=off 时不走这里，由 app.js loadCodex 的原路处理。 */

import { $, prefersReducedMotion } from './utils.js';
import { animateUi } from './ui-motion.js';
import { holdSwitchEntries, releaseSwitchEntries, settleSwitchEntries, switchFocusImages } from './masonry.js';

const FLIGHT_MS = 480;           // 封面从书卡飞到横幅
const JUMP_MS = 150;             // 旧内容淡到潜影（.2s）后再回顶、换身份；早了会看见页面跳
const LANDING_FADE_MS = 140;     // 替身落定后淡出，底下就是同一张图、同一取景的横幅封面
const SAMPLE_SHOW_MS = 260;      // 过了这么久数据还没到才计步；秒到的切换不出现计步
const STEP_TOTAL = 28;
const STEP_TICK_MS = 90;
const STEP_TAU_MS = 1600;        // 渐近爬升：1s≈12、2s≈19、4s≈25，封顶 27
const FAST_IMAGE_WAIT_MS = 160;  // 数据秒到：首排图最多再等这么久，迟到的图走普通渐显
const SLOW_IMAGE_WAIT_MS = 420;  // 已经在计步：多等一点换完整显影（同开场 INTRO_ASSET_WAIT_MS）
const PROGRESS_DELAY_MS = 90;
const PROGRESS_MS = 520;
const DEVELOP_TAIL_MS = 760;     // 颗粒退场、卡片波、进度计数都跑完再摘类

let current = null;   // 正在进行的那次换书；被新的一次顶掉时由它自己收手
/* 已提前换上、但数据还没落地的新书身份：存的是换上之前那一刻的还原函数。连着换几本时只留第一次的，
   撤销（失败、被收藏墙 / 全站搜索 / 原路接管）时用它退回真正还在显示的那本。 */
let pendingRestore = null;

/* 等数据这段时间页面上还是旧书的内容：鼠标靠 CSS 的 pointer-events 挡住，键盘、读屏和「随机」要靠 inert——
   否则能 Tab 进旧卡片、在旧书灯箱里点收藏，落地后收藏键会记到新书名下（PR #37 审查）。 */
const STALE_REGIONS = '#masonry, #tree, #chipRail, .result-bar, #randomBtn';

function setStale(on) {
  document.querySelectorAll(STALE_REGIONS).forEach(el => { el.inert = on; });
}

export function canAnimateSwitch() {
  return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function'
    && !prefersReducedMotion()
    && !document.documentElement.classList.contains('motion-off');
}

/** 原路加载（收藏墙、全站搜索、减少动效）抢在接力中途进来时，先把加噪撤干净。 */
export function cancelCodexSwitch() {
  current?.abort();
}

/** 换书：点下这一帧起飞、开始加噪；JUMP_MS 后由 arrive 回顶并把横幅换成新书。
 *  origin 是按下那本书的封面（codex-ui.js chooseCodex 给），没有就不飞。
 *  snapshotIdentity 在换身份之前调，返回把横幅、标题、按钮退回当前所示那本的函数。
 *  返回控制器：land(render, codex) 在数据到了时调；abort() 在失败或被原路接管时撤掉加噪并退回身份。 */
export function beginCodexSwitch({ origin = null, arrive, snapshotIdentity, isCurrent }) {
  current?.cancel();
  const html = document.documentElement;
  const ctl = {
    alive: true,
    startedAt: performance.now(),
    sampled: false,
    dataIn: false,
    progressRaf: 0,
    timers: new Set(),
    flight: null,
  };
  let resolveReady = () => {};
  ctl.ready = new Promise(resolve => { resolveReady = resolve; });
  ctl.later = (fn, ms) => {
    const id = window.setTimeout(() => { ctl.timers.delete(id); fn(); }, ms);
    ctl.timers.add(id);
  };
  ctl.cancel = () => {
    ctl.alive = false;
    for (const id of ctl.timers) window.clearTimeout(id);
    ctl.timers.clear();
    cancelAnimationFrame(ctl.progressRaf);
    ctl.flight?.abandon();
    resolveReady();
  };
  ctl.abort = () => {
    ctl.cancel();
    settleSwitchEntries();
    setStale(false);
    html.classList.remove('codex-switching', 'codex-developing');
    if (current === ctl) current = null;
    const restore = pendingRestore;
    pendingRestore = null;
    restore?.();
  };
  ctl.land = async (render, codex) => {
    await ctl.ready;
    /* 数据赶在回顶之前就到了（秒到）：先让回顶、新横幅这一帧画出来，下一帧再渲染整本书。
       同一个任务里做的话，大书约 80ms 的渲染会把回顶这一帧也拖后，封面已经飞到了、横幅却还没出现。 */
    if (performance.now() - ctl.arrivedAt < 50) await afterPaint();
    if (!ctl.alive || !isCurrent()) return;
    ctl.dataIn = true;
    const text = $('#codexBanner .bp-text');
    if (ctl.sampled && text) text.textContent = `step ${STEP_TOTAL}/${STEP_TOTAL}`;
    holdSwitchEntries();
    try {
      render();
    } catch (error) {
      ctl.abort();
      throw error;
    }
    // 新书已经真正渲染上去，身份不再是「提前换的」
    pendingRestore = null;
    await waitForImages(switchFocusImages(), ctl.sampled ? SLOW_IMAGE_WAIT_MS : FAST_IMAGE_WAIT_MS);
    // 等图期间被新的一次换书顶掉：那一次的 hold 会把这批卡落终态，这里什么都不做
    if (ctl.alive) develop(ctl, codex);
  };
  current = ctl;

  ctl.flight = origin ? launchCoverFlight(origin) : null;
  html.classList.remove('codex-developing');
  html.classList.add('codex-switching');
  setStale(true);
  ctl.later(() => {
    if (!ctl.alive || !isCurrent()) { resolveReady(); return; }
    // 横幅原本被滚出视口（看到一半才换书）时，回顶这一下让它浮现，而不是凭空冒出来
    const banner = $('#codexBanner');
    const before = banner?.getBoundingClientRect();
    pendingRestore ??= snapshotIdentity?.() || null;
    arrive({ awaitingCover: Boolean(ctl.flight) });
    if (banner && before?.height && before.bottom <= 64) {
      animateUi(banner, [{ opacity: 0, translate: '0 10px' }, { opacity: 1, translate: '0 0' }], { duration: 300 });
    }
    ctl.arrivedAt = performance.now();
    resolveReady();
  }, JUMP_MS);
  ctl.later(() => startSampling(ctl), SAMPLE_SHOW_MS);
  ctl.flight?.finished.then(() => { if (ctl.alive) ctl.flight.land(); });
  return ctl;
}

/* 封面替身：外层框按横幅封面位定尺寸，用 translate + scale 补间窗口的位置与大小；里层图按反向缩放保持不变形，
   在两端取景（object-fit: cover + object-position + 封面构图缩放，含书卡悬停放大）之间线性过渡——
   两端都盖满窗口，中间也一定盖满。两层只动 transform、交给合成线程；圆角按缩放反算，跑在主线程，
   主线程忙时只是圆角慢一拍。终点按「回顶后」的横幅封面位算：横幅几何全法典恒定，回顶前就能量。 */
function launchCoverFlight({ img, frame, framing }) {
  const target = $('#codexBanner .banner-cover');
  if (!img?.isConnected || !frame?.isConnected || !target) return null;
  const from = frame.getBoundingClientRect();
  const box = target.getBoundingClientRect();
  const natW = img.naturalWidth;
  const natH = img.naturalHeight;
  if (!from.width || !from.height || !box.width || !box.height || !natW || !natH) return null;
  const pic = new Image();
  pic.alt = '';
  pic.src = img.currentSrc || img.src;
  // 替身第一帧就得有图：藏起原图那一下要是替身还空着，就会闪一下
  if (!pic.complete || !pic.naturalWidth) return null;

  const to = { left: box.left, top: box.top + window.scrollY, width: box.width, height: box.height };
  const shown = img.getBoundingClientRect();
  const k = shown.width / (img.offsetWidth || shown.width);
  const startFit = coverFit(img.offsetWidth || shown.width, img.offsetHeight || shown.height, natW, natH, objectPosition(img));
  const start = { x: shown.left + startFit.x * k, y: shown.top + startFit.y * k, s: startFit.s * k };
  const fx = framing?.x ?? 0.5;
  const fy = framing?.y ?? 0.5;
  const zoom = framing?.scale ?? 1;
  const endFit = coverFit(to.width, to.height, natW, natH, { x: fx, y: fy });
  const ox = to.width * fx;
  const oy = to.height * fy;
  const end = { x: to.left + ox + (endFit.x - ox) * zoom, y: to.top + oy + (endFit.y - oy) * zoom, s: endFit.s * zoom };
  const r0 = radiusPx(frame, from);
  const r1 = radiusPx(target, box);

  const ease = cubicBezier(0.22, 1, 0.36, 1);
  const steps = Math.max(12, Math.round(FLIGHT_MS / 16));
  const outer = [];
  const inner = [];
  const round = [];
  for (let i = 0; i <= steps; i++) {
    const offset = i / steps;
    const p = ease(offset);
    const x = lerp(from.left, to.left, p);
    const y = lerp(from.top, to.top, p);
    const sx = lerp(from.width, to.width, p) / to.width;
    const sy = lerp(from.height, to.height, p) / to.height;
    const s = lerp(start.s, end.s, p);
    const r = lerp(r0, r1, p);
    outer.push({ offset, transform: `translate(${x - to.left}px,${y - to.top}px) scale(${sx},${sy})` });
    inner.push({
      offset,
      transform: `translate(${(lerp(start.x, end.x, p) - x) / sx}px,${(lerp(start.y, end.y, p) - y) / sy}px) scale(${s / sx},${s / sy})`,
    });
    round.push({ offset, borderRadius: `${r / sx}px / ${r / sy}px` });
  }

  const shell = document.createElement('div');
  shell.className = 'cover-flight';
  shell.setAttribute('aria-hidden', 'true');
  shell.style.cssText = `left:${to.left}px;top:${to.top}px;width:${to.width}px;height:${to.height}px`;
  pic.style.cssText = `width:${natW}px;height:${natH}px`;
  shell.appendChild(pic);
  document.body.appendChild(shell);
  img.style.visibility = 'hidden';
  const timing = { duration: FLIGHT_MS, easing: 'linear', fill: 'forwards' };
  const travel = shell.animate(outer, timing);
  pic.animate(inner, timing);
  shell.animate(round, timing);

  let gone = false;
  const fadeOut = () => {
    if (gone) return;
    gone = true;
    const remove = () => shell.remove();
    shell.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LANDING_FADE_MS, easing: 'ease', fill: 'forwards' })
      .finished.then(remove, remove);
  };
  const reveal = () => $('#codexBanner .banner-cover.awaiting-cover')?.classList.remove('awaiting-cover');
  return {
    finished: travel.finished.catch(() => {}),
    // 落定：先让横幅自己的封面露出来（就在替身正下方），再淡掉替身
    land() { reveal(); fadeOut(); },
    abandon() { reveal(); fadeOut(); },
  };
}

// object-fit: cover 在 boxW × boxH 里的取景：缩放比与图左上角的偏移（object-position 按比例）
function coverFit(boxW, boxH, natW, natH, pos) {
  const s = Math.max(boxW / natW, boxH / natH);
  return { s, x: (boxW - natW * s) * pos.x, y: (boxH - natH * s) * pos.y };
}

function objectPosition(el) {
  const [px, py] = String(getComputedStyle(el).objectPosition || '').split(/\s+/);
  const ratio = value => (value && value.endsWith('%') ? parseFloat(value) / 100 : 0.5);
  return { x: ratio(px), y: ratio(py ?? px) };
}

function radiusPx(el, rect) {
  const value = String(getComputedStyle(el).borderTopLeftRadius || '0');
  const n = parseFloat(value) || 0;
  return value.trim().endsWith('%') ? Math.min(rect.width, rect.height) * n / 100 : n;
}

const lerp = (a, b, p) => a + (b - a) * p;

/* 等下一帧画完：rAF 里再排一个宏任务，落在这一帧出图之后；后台标签 rAF 停摆时 50ms 兜底 */
function afterPaint() {
  return new Promise(resolve => {
    const fallback = window.setTimeout(resolve, 50);
    requestAnimationFrame(() => window.setTimeout(() => { window.clearTimeout(fallback); resolve(); }, 0));
  });
}

/* 关键帧要逐帧算两端取景，曲线只能自己求值：同站内 cubic-bezier(.22,1,.36,1)，牛顿法反解 x→t */
function cubicBezier(x1, y1, x2, y2) {
  const ax = 3 * x1 - 3 * x2 + 1;
  const bx = 3 * x2 - 6 * x1;
  const cx = 3 * x1;
  const ay = 3 * y1 - 3 * y2 + 1;
  const by = 3 * y2 - 6 * y1;
  const cy = 3 * y1;
  return x => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = ((ax * t + bx) * t + cx) * t - x;
      const slope = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(err) < 1e-6 || !slope) break;
      t = Math.min(1, Math.max(0, t - err / slope));
    }
    return ((ay * t + by) * t + cy) * t;
  };
}

function startSampling(ctl) {
  if (!ctl.alive || ctl.dataIn) return;
  const text = $('#codexBanner .bp-text');
  if (!text) return;
  ctl.sampled = true;
  text.classList.add('is-sampling');
  const tick = () => {
    if (!ctl.alive || ctl.dataIn) return;
    const t = performance.now() - ctl.startedAt;
    const step = Math.max(1, Math.min(STEP_TOTAL - 1, Math.floor((STEP_TOTAL - 1) * (1 - Math.exp(-t / STEP_TAU_MS)))));
    text.textContent = `step ${step}/${STEP_TOTAL}`;
    ctl.later(tick, STEP_TICK_MS);
  };
  tick();
}

function develop(ctl, codex) {
  const html = document.documentElement;
  html.classList.remove('codex-switching');
  html.classList.add('codex-developing');
  setStale(false);
  releaseSwitchEntries();
  playProgress(ctl, codex);
  ctl.later(() => {
    if (current !== ctl) return;
    html.classList.remove('codex-developing');
    current = null;
  }, DEVELOP_TAIL_MS);
}

/* 落地时把规模说出口：进度条从左揭开，数字从 0 数到配图数（同开场 startProgressCount；
   用 clip-path 不动布局、保得住圆角）。后台标签 rAF 停摆时由定时器直接给终值。 */
function playProgress(ctl, codex) {
  const row = $('#codexBanner .banner-progress');
  if (!row) return;
  const fill = row.querySelector('.bp-fill');
  const text = row.querySelector('.bp-text');
  const total = Number(codex.entryCount) || 0;
  const target = Number(codex.imagedCount) || 0;
  const final = `${target} / ${total} 已配图`;
  row.classList.remove('is-pending');
  text?.classList.remove('is-sampling');
  fill?.animate(
    [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }],
    { duration: PROGRESS_MS, delay: PROGRESS_DELAY_MS, easing: 'cubic-bezier(0.16,1,0.3,1)', fill: 'backwards' },
  );
  if (!text) return;
  if (target <= 0) { text.textContent = final; return; }
  text.textContent = `0 / ${total} 已配图`;
  const start = performance.now() + PROGRESS_DELAY_MS;
  const tick = now => {
    if (!ctl.alive) return;
    const t = Math.min(1, Math.max(0, (now - start) / PROGRESS_MS));
    const eased = 1 - Math.pow(1 - t, 3);
    text.textContent = `${Math.round(target * eased)} / ${total} 已配图`;
    ctl.progressRaf = t < 1 ? requestAnimationFrame(tick) : 0;
  };
  ctl.progressRaf = requestAnimationFrame(tick);
  ctl.later(() => { cancelAnimationFrame(ctl.progressRaf); text.textContent = final; }, PROGRESS_DELAY_MS + PROGRESS_MS + 60);
}

/* 照 intro.js 的 waitForIntroAssets：load 只保证字节到了，decode 完的图才允许显影；
   无 src 的 <img> 也会报 complete=true（首图由 masonry 的加载定时器稍后才赋 src），一并当 pending。 */
async function waitForImages(images, limit) {
  if (!images.length) return;
  const ready = new Set();
  const prepare = async img => {
    if (!img.hasAttribute('src') || !img.complete) {
      await new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
    }
    if (!img.naturalWidth) return;
    try {
      if (typeof img.decode === 'function') await img.decode();
      ready.add(img);
    } catch { /* 解码失败或资源被替换：跳过显影，加载逻辑自行兜底 */ }
  };
  let timer = 0;
  await Promise.race([
    Promise.all(images.map(prepare)),
    new Promise(resolve => { timer = window.setTimeout(resolve, limit); }),
  ]);
  window.clearTimeout(timer);
  for (const img of ready) img.classList.add('switch-image-ready');
  /* 带滤镜的第一帧别落在放行那一刻：给浏览器两帧在卡片仍是潜影时建层；rAF 停摆时 80ms 兜底 */
  if (!ready.size) return;
  await new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(fallback);
      resolve();
    };
    const fallback = window.setTimeout(finish, 80);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
}
