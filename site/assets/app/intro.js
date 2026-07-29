/* 首访开场「显影」——照搬 `珍贵的优化建议/动效方案演示.html` 的 INTROS.diffusion 分镜，
   逐条落到真实 UI 上。原方案的四件套一件都不能少：

     ① 全屏噪声层     opacity 0→.14→.05→0（浅色主题按比例抬到 .2/.08，见下），活得比幕布久
     ② 打字机 prompt  `masterpiece, best quality, 法典图鉴`，26ms/字 + ▌ 光标
     ③ step N/28      采样步数，+3 / 90ms，与打字机同起同收 —— 它同时就是**等待逻辑**：
                      数据没到就封顶在 27/28，绝不谎报采样完成；28 这一格留给开幕（「先加载，后播放」）
     ④ 连续显影        横幅封面按桌面 12→4.5→1.2→0 / 移动 8→3→.8→0 平滑收敛，
                      不再把概念稿的 steps(2) 搬到真实照片上（那会被眼睛读成卡帧）

   然后才是收尾的两波（照原方案的形，节奏整体提速一档）：分类圆点 scale(.4)→1 / 200ms / 错峰 50ms；
   卡片壳延迟 30ms 做 translateY(6px)+线性透明度，图片显影提前在幕布下预跑；移动端只取 1 张、
   桌面最多 3 张，并且必须在 420ms 内完成 load + decode，避免冷启动把解码塞进第一帧 filter paint。

   纪律：静止帧 = 终态（收尾把 intro-* 全摘掉；intro-done 只压静态页面骨架，首批动态节点另打
   intro-no-replay，不能顺手锁死以后切换法典新建的 chip/banner 内容）；任意输入立即跳终态。 */

import { $ } from './utils.js';

/* ⚠ 与 index.html 内联脚本共用：改名两处同改。UI 里不暴露，只给截图器 / 回归脚本关动效用
   （tools/verify_ui.py 经 Page.addScriptToEvaluateOnNewDocument 预置成 'off'） */
export const MOTION_STORAGE_KEY = 'fadian-motion';

const PROMPT_TEXT = 'masterpiece, best quality, 法典图鉴';
const TYPE_MS = 26;          // 每字（原方案 34ms，整体提速后同比压掉）
const STEP_TOTAL = 28;
/* 计数与打字机同时起跑、同时收尾：31 字 × 26ms ≈ 806ms，9 tick × 90ms = 810ms 正好到封顶 27 */
const STEP_TICK_MS = 90;
const STEP_ADD = 3;
const DEVELOP_MS = 520;      // hero 封面显影，与 CSS 的 introDevelop 必须同长
const TAIL_MS = 180;         // 等首排图片/分类波落稳；最后一帧不靠 finish() 硬切
const INTRO_ASSET_WAIT_MS = 420;
const PROGRESS_DELAY_MS = 90;
const PROGRESS_MS = 520;

let settled = null;
let settleNow = null;
let dataReadyNow = null;
let dataReady = null;
let dataReadyRequested = false;
let suppressNextDynamicReplay = false;
let finished = false;
let timers = [];
let skipBound = false;

const wait = ms => new Promise(resolve => { timers.push(window.setTimeout(resolve, ms)); });

export function introMode() {
  return document.documentElement.dataset.motion || 'brief';
}

export function isIntroArmed() {
  return document.documentElement.classList.contains('intro-arm');
}

/** 开场落幕后 resolve；没在播就是已落幕。新手引导用它排队，别抢开场的画面。 */
export function introSettled() {
  return settled || Promise.resolve();
}

/** 给首次渲染挂上显影规则；真正的数据闸门由 markIntroDataReady() 打开。
 *  ⚠ 必须在首次渲染**之前**调——显影动画是靠 CSS 挂在新插入的横幅/胶囊/卡片上的，
 *  节点建完再打标就赶不上了。此时动画处于 paused，等 intro-reveal 才真正开跑。 */
export function beginIntroReveal() {
  if (!isIntroArmed() || finished) return;
  document.documentElement.classList.add('intro-run');
}

/** 首次视图已插入 DOM：等一小段时间让首排图片完成，避免滤镜在透明 img 上白播。 */
export function markIntroDataReady() {
  /* 用户在数据回来前就跳过/超时：这批节点是在 intro-done 之后才新建的，必须在同一轮
     render 微任务里补上 no-replay；以后切换法典的新节点不受影响。 */
  if (finished) {
    if (suppressNextDynamicReplay) {
      markCurrentDynamicNoReplay();
      /* 收藏墙/全站搜索启动会先渲染一次普通法典，再换成最终视图；masonry 的一次性 suppression
         可能被中间视图消费。最终 render 已完成的这一刻再 settle 当前卡片，保证跳过后不补播 blur。
         skipped=false 很重要：若最终视图为空，不要重新种下一次长期悬着的 initial suppression。 */
      document.dispatchEvent(new CustomEvent('intro:settle', { detail: { skipped: false, late: true } }));
      suppressNextDynamicReplay = false;
    }
    return;
  }
  if (!isIntroArmed() || dataReadyRequested) return;
  dataReadyRequested = true;
  waitForIntroAssets().then(() => {
    if (dataReadyNow) { dataReadyNow(); dataReadyNow = null; }
  });
}

/** 开场脚本本体。app.js 在 init() 最开头调，不等任何网络请求。 */
export function startIntro() {
  if (!isIntroArmed()) return;
  settled = new Promise(resolve => { settleNow = resolve; });
  dataReady = new Promise(resolve => { dataReadyNow = resolve; });
  dataReadyRequested = false;
  bindSkip();
  document.addEventListener('intro:timeout', onIntroTimeout, { once: true });
  runIntro().catch(() => finishIntro({ skipped: true }));
}

const onIntroTimeout = () => finishIntro({ skipped: true });

async function runIntro() {
  const noise = document.querySelector('.intro-noise');
  const promptEl = $('#introPrompt');
  const stepEl = $('#introStep');

  // ① 噪声铺开：站点先是「一片未成形」
  // ⚠ 原方案的 .14 是按近黑舞台（#07080d）调的；同样的灰噪点铺在浅色底上对比度低得多，
  //   几乎看不出来。浅色主题按比例抬一档，两套主题才是同一个「颗粒感」。
  const dark = document.body.classList.contains('dark');
  const peak = dark ? 0.14 : 0.2;
  const mid = dark ? 0.05 : 0.08;
  const noiseIn = noise?.animate([{ opacity: 0 }, { opacity: peak }], { duration: 200, fill: 'both' });
  if (finished) return;

  // ② 采样步数：与打字机**同时**出现并同步推进（读起来是「一边写 prompt 一边采样」）。
  //    封顶 27/28 是本站加的等待闸门：数据没到就绝不谎报采样完成，28 这一格留给开幕那一刻。
  stepEl?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, fill: 'both' });
  let step = 0;
  const stepTimer = window.setInterval(() => {
    if (finished) { window.clearInterval(stepTimer); return; }
    step = Math.min(STEP_TOTAL - 1, step + STEP_ADD);
    if (stepEl) stepEl.textContent = `step ${step}/${STEP_TOTAL}`;
  }, STEP_TICK_MS);
  timers.push(stepTimer);

  // ③ 打字机：把这次「生成」的 prompt 敲出来。等待期就演给用户看，而不是空转转圈
  if (promptEl) {
    for (let i = 1; i <= PROMPT_TEXT.length; i++) {
      if (finished) return;
      promptEl.textContent = `${PROMPT_TEXT.slice(0, i)}▌`;
      await wait(TYPE_MS);
    }
    promptEl.textContent = PROMPT_TEXT;
  }
  if (finished) return;

  await dataReady;              // 打字机敲完 + 首次视图/首排图片到位，两个条件都满足才开幕
  if (finished) return;
  window.clearInterval(stepTimer);
  if (stepEl) stepEl.textContent = `step ${STEP_TOTAL}/${STEP_TOTAL}`;   // 28/28 = 开幕这一格

  // ④ 开幕：幕布让开，真实 UI 在噪声底下连续分段显影（CSS introDevelop / play-state 由此刻放行）
  const html = document.documentElement;
  html.classList.add('intro-reveal');
  noiseIn?.finish();
  const veil = document.querySelector('.intro-veil');
  veil?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-out', fill: 'forwards' });
  timers.push(window.setTimeout(() => { if (veil) veil.style.display = 'none'; }, 180));
  document.dispatchEvent(new CustomEvent('intro:reveal'));

  // 真站横幅比演示舞台更靠上，读数在幕布打开时就退场，避免压住标题/进度条
  const console_ = $('#introConsole');
  console_?.animate([{ opacity: 1 }, { opacity: 0, filter: 'blur(3px)' }],
    { duration: 140, easing: 'ease-out', fill: 'forwards' });

  // 噪声跟着显影两段退场：先在轮廓成形时回落，再在细节清晰时退净
  timers.push(window.setTimeout(() => {
    noise?.animate([{ opacity: peak }, { opacity: mid }], { duration: 180, fill: 'both' });
  }, 180));
  timers.push(window.setTimeout(() => {
    noise?.animate([{ opacity: mid }, { opacity: 0 }], { duration: 160, fill: 'both' });
  }, DEVELOP_MS));

  startProgressCount();
  await wait(DEVELOP_MS + TAIL_MS);
  finishIntro();
}

async function waitForIntroAssets() {
  const images = [...document.querySelectorAll('.masonry .card.intro-focus .card-img')];
  if (!images.length) return;

  /* load 事件只保证字节到了，第一次 filter paint 仍可能顺带做大图解码，冷启动就会卡一帧。
     只有 decode() 已完成的焦点图才允许显影；420ms 内没准备好的图直接走普通 load settle。 */
  const decoded = new Set();
  const prepare = async img => {
    /* 无 src 的 <img> 也会报告 complete=true；首图由 masonry 的加载定时器稍后才赋 src，
       所以必须把「尚无 src」一起当 pending，否则这里会在 timer task 前误判无图并开幕。 */
    if (!img.hasAttribute('src') || !img.complete) {
      await new Promise(resolve => {
        const done = () => resolve();
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
      });
    }
    if (!img.naturalWidth) return;
    try {
      if (typeof img.decode === 'function') await img.decode();
      decoded.add(img);
    } catch { /* 解码失败或资源被替换：跳过显影，加载逻辑自行兜底 */ }
  };

  let timeout = 0;
  await Promise.race([
    Promise.all(images.map(prepare)),
    new Promise(resolve => { timeout = window.setTimeout(resolve, INTRO_ASSET_WAIT_MS); }),
  ]);
  window.clearTimeout(timeout);
  for (const img of decoded) img.classList.add('intro-image-ready');
  /* 数据若比图片晚，ready class 与揭幕会落在同一 task：第一张带 filter 的 paint 就会暴露给用户。
     给浏览器最多两帧在不透明幕布下建层/栅格；后台标签 rAF 被节流时用 80ms 兜底，绝不锁门。 */
  if (decoded.size && !finished) {
    await new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.clearTimeout(fallback);
        resolve();
      };
      const fallback = window.setTimeout(finish, 80);
      requestAnimationFrame(() => requestAnimationFrame(finish));
    });
  }
}

/** 立刻落到终态：结束所有 intro 动画、数字给终值、摘类换 intro-done。可重复调用。 */
export function finishIntro({ skipped = false } = {}) {
  if (finished) return;
  finished = true;
  for (const id of timers) { window.clearTimeout(id); window.clearInterval(id); }
  timers = [];
  cancelAnimationFrame(counterRaf);
  counterRaf = 0;
  unbindSkip();
  document.removeEventListener('intro:timeout', onIntroTimeout);
  settleCounter();
  /* 先把在飞的动画推到终点，再摘类；只摘类会让元素从半途「跳」回终态。
     CSS 动画认 animationName（都以 intro 打头），WAAPI 那几条认自取的 id */
  if (typeof document.getAnimations === 'function') {
    for (const anim of document.getAnimations()) {
      const name = String(anim.animationName || '');
      if (!name.startsWith('intro') && !String(anim.id || '').startsWith('intro-')) continue;
      try { anim.finish(); } catch { /* 已结束或不可完成，忽略 */ }
    }
  }
  /* 掀幕前被跳过时，masonry 那边还攒着一批「起始态」卡片，必须叫它们落终态，否则首屏是空白 */
  document.dispatchEvent(new CustomEvent('intro:settle', { detail: { skipped } }));
  const stage = $('#introStage');
  if (stage) stage.remove();
  const html = document.documentElement;
  /* 只给**当前首批动态节点**打标；换法典 innerHTML 新建的节点没有此类，常规二段浮现仍可用。
     数据前跳过时节点还不存在，留一个一次性标志，等 markIntroDataReady() 在首次 render 后补标。 */
  markCurrentDynamicNoReplay();
  if (skipped && !dataReadyRequested) suppressNextDynamicReplay = true;
  html.classList.remove('intro-arm', 'intro-run', 'intro-reveal');
  /* ⚠ intro-done 必须留下：它压掉静态骨架与当前首批节点的常规入场动画。
     少了这一手，摘掉 intro-* 的瞬间那些规则重新生效 = 常规入场紧接着再播一遍（看着像加载了两次）；
     但不能全局压 rail-chip / banner 内容，否则以后切换法典的新节点也永远不会动。 */
  html.classList.add('intro-done');
  if (settleNow) { settleNow(); settleNow = null; }
  if (dataReadyNow) { dataReadyNow(); dataReadyNow = null; }
}

function markCurrentDynamicNoReplay() {
  document.querySelectorAll('.banner-cover,.banner-info,.banner-about-btn,.rail-chip')
    .forEach(node => node.classList.add('intro-no-replay'));
}

/* ---------- 进度条：全站唯一「把规模说出口」的地方，跟着显影一起跑 ---------- */

let counterRaf = 0;
let counterEl = null;
let counterFinal = '';

function startProgressCount() {
  const banner = $('#codexBanner');
  if (!banner) return;
  const fill = banner.querySelector('.bp-fill');
  const text = banner.querySelector('.bp-text');
  if (fill) {
    /* 用 clip-path 而不是 width：不动布局、保得住 999px 圆角 */
    const anim = fill.animate(
      [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }],
      { duration: PROGRESS_MS, delay: PROGRESS_DELAY_MS, easing: 'cubic-bezier(0.16,1,0.3,1)', fill: 'backwards' },
    );
    anim.id = 'intro-progress';
  }
  if (!text) return;
  const parsed = /^\s*(\d+)\s*\/\s*(\d+)([\s\S]*)$/.exec(text.textContent || '');
  if (!parsed) return;
  const target = Number(parsed[1]);
  const total = parsed[2];
  const tail = parsed[3];
  counterEl = text;
  counterFinal = text.textContent;
  if (!Number.isFinite(target) || target <= 0) return;
  const start = performance.now() + PROGRESS_DELAY_MS;
  const tick = now => {
    const t = Math.min(1, Math.max(0, (now - start) / PROGRESS_MS));
    const eased = 1 - Math.pow(1 - t, 3);
    text.textContent = `${Math.round(target * eased)} / ${total}${tail}`;
    counterRaf = t < 1 ? requestAnimationFrame(tick) : 0;
  };
  text.textContent = `0 / ${total}${tail}`;
  counterRaf = requestAnimationFrame(tick);
}

function settleCounter() {
  if (counterEl && counterFinal) counterEl.textContent = counterFinal;
  counterEl = null;
  counterFinal = '';
}

/* ---------- 跳过：任何输入都算「我不想看」 ---------- */

const SKIP_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];
const onSkip = () => finishIntro({ skipped: true });

function bindSkip() {
  if (skipBound) return;
  skipBound = true;
  for (const type of SKIP_EVENTS) window.addEventListener(type, onSkip, { passive: true, capture: true });
}

function unbindSkip() {
  if (!skipBound) return;
  skipBound = false;
  for (const type of SKIP_EVENTS) window.removeEventListener(type, onSkip, { capture: true });
}
