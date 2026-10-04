/* 换法典过渡：封面接力 + 显影落地。

   一次同文档 View Transition 把「按下的那本书」接力进横幅：封面从书卡飞进横幅封面位，横幅、侧栏标题与
   顶栏按钮当场换成新书——身份只用 codexes.json 的 meta，不等数据；旧内容淡成潜影、撒一层颗粒（加噪）。
   数据到了才落地：新书首屏卡片先摆好起始态，等首排焦点图 load + decode，再一起显影、对角浮入，
   颗粒退场，进度条揭开并从 0 数到配图数（开场同款）。
   慢的时候（点击后 SAMPLE_SHOW_MS 数据还没到）进度行计步 step N/28，按时间渐近、封顶 27——
   跟开场同一条规矩：数据没到绝不谎报采样完成，28 这一格留给落地。

   红线同开场：不做全屏 blur/filter，模糊只给首排焦点图（预算见 masonry.js introFocusCount）。
   减少动效、motion=off、不支持 View Transition 时不走这里，由 app.js loadCodex 的原路处理。 */

import { $, prefersReducedMotion } from './utils.js';
import { holdSwitchEntries, releaseSwitchEntries, settleSwitchEntries, switchFocusImages } from './masonry.js';

/* 「按下」这一拍：书卡高亮、同卷其它书淡下去，再起飞。数据秒到时过渡回调里还要同步渲染整本书
   （大书约 80ms，渲染完浏览器才拍新画面），这一拍再拉长就成了「点了没反应」。 */
const PRESS_MS = 40;
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
let vtToken = 0;

export function canAnimateSwitch() {
  return typeof document.startViewTransition === 'function'
    && !prefersReducedMotion()
    && !document.documentElement.classList.contains('motion-off');
}

/** 原路加载（收藏墙、全站搜索、减少动效）抢在接力中途进来时，先把加噪撤干净。 */
export function cancelCodexSwitch() {
  current?.abort();
}

/** 换书第一段：按下 → 起飞。commit 在过渡回调里同步执行（关菜单、横幅换身份、回顶）。
 *  返回控制器：land(render, codex) 在数据到了时调；abort() 在失败或被原路接管时撤掉加噪。 */
export function beginCodexSwitch({ origin = null, commit, isCurrent }) {
  current?.cancel();
  const html = document.documentElement;
  const ctl = {
    alive: true,
    startedAt: performance.now(),
    sampled: false,
    dataIn: false,
    progressRaf: 0,
    timers: new Set(),
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
    resolveReady();
  };
  ctl.abort = () => {
    ctl.cancel();
    settleSwitchEntries();
    html.classList.remove('codex-switching', 'codex-developing');
    if (current === ctl) current = null;
  };
  ctl.land = async (render, codex) => {
    await ctl.ready;
    /* 封面正飞在半路时别同步渲染：补间框的宽高动画跑在主线程，整本书的渲染长任务会让它顿一下。
       数据赶在新画面拍下之前到（秒到）就直接渲染进新画面；飞行中途才到的等落地再渲染。 */
    if (ctl.flying) await ctl.flight;
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
    await waitForImages(switchFocusImages(), ctl.sampled ? SLOW_IMAGE_WAIT_MS : FAST_IMAGE_WAIT_MS);
    // 等图期间被新的一次换书顶掉：那一次的 hold 会把这批卡落终态，这里什么都不做
    if (ctl.alive) develop(ctl, codex);
  };
  current = ctl;

  ctl.later(() => {
    if (!ctl.alive || !isCurrent()) { resolveReady(); return; }
    const transition = startTransition(origin, () => {
      commit();
      html.classList.remove('codex-developing');
      html.classList.add('codex-switching');
      ctl.later(() => startSampling(ctl), Math.max(0, SAMPLE_SHOW_MS - (performance.now() - ctl.startedAt)));
    });
    ctl.flight = transition.finished.catch(() => {});
    transition.ready.then(() => { ctl.flying = true; }, () => {});
    ctl.flight.then(() => { ctl.flying = false; });
    transition.updateCallbackDone.then(resolveReady, resolveReady);
  }, origin ? PRESS_MS : 0);
  return ctl;
}

/* 封面接力：书卡封面与横幅封面同名 codex-cover，由浏览器从旧位置补间到新位置；
   菜单和旧页面跟着根层交叉淡化溶掉。两边的名字都只活到这次过渡结束，避免下次过渡撞名中止。
   返回值与 ViewTransition 同形（ready / finished / updateCallbackDone），起不了过渡时三者都立即兑现。 */
function startTransition(origin, commit) {
  const html = document.documentElement;
  const token = ++vtToken;
  const source = origin?.el?.isConnected ? origin.el : null;
  let target = null;
  const clearNames = () => {
    if (source) source.style.viewTransitionName = '';
    if (target) target.style.viewTransitionName = '';
  };
  if (source) {
    source.style.viewTransitionName = 'codex-cover';
    html.style.setProperty('--vt-r0', origin.radius || '10px');
  }
  html.classList.add('vt-switch');
  let transition;
  try {
    transition = document.startViewTransition(() => {
      if (source) source.style.viewTransitionName = '';
      commit();
      if (!source) return;
      target = document.querySelector('#codexBanner .banner-cover img');
      if (!target) return;
      target.style.viewTransitionName = 'codex-cover';
      html.style.setProperty('--vt-r1', getComputedStyle(target.parentElement).borderRadius || '10px');
    });
  } catch {
    clearNames();
    html.classList.remove('vt-switch');
    commit();
    const settled = Promise.resolve();
    return { ready: settled, finished: settled, updateCallbackDone: settled };
  }
  const done = () => {
    clearNames();
    if (token !== vtToken) return;
    html.classList.remove('vt-switch');
    html.style.removeProperty('--vt-r0');
    html.style.removeProperty('--vt-r1');
  };
  transition.finished.then(done, done);
  return transition;
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
  /* 带滤镜的第一帧别落在放行那一刻：给浏览器两帧在卡片仍近乎透明时建层；rAF 停摆时 80ms 兜底 */
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
