/* 首访开场「典籍开卷」（Folio Split）：等数据时双页合拢 + 书脊推进，开幕时左右对开 + 内容显影。

   等数据（html.intro-arm）：
     ① 纸感颗粒层     .intro-noise 轻铺（深色 .08 / 浅色 .10），开卷时柔和退净
     ② 典籍双页与书脊  index.html 静态首帧即盖住页面（左「法典」、右「图鉴」），书脊细线与右下角百分比
                      按平滑渐近曲线推进；数据不来就自然减速等待，绝不卡死也不虚假跳满
     ③ 今日画师名字行  只在直接进站时显示（featured.js 的 isPlainFeaturedVisit）：右侧副标 artist: 乱跳，
                      app.js 拿到首屏真放在第一格的今日画师后调 setIntroFeatured()，约 0.22s 内逐字定住
     ③' 生日插页卡     只在所长生日（birthday.js）：中缝中央浮出一张典藏竖卡，封面解码后翻面亮相，
                      翻完停够 BIRTHDAY_HOLD_MS 才允许开卷，开卷前先上浮淡出
   开卷（intro-reveal）：
     ④ 书脊补满与对开  书脊冲满 100% 轻闪，随后左右两扇页幕沿编辑重曲线（cubic-bezier(.76,0,.24,1)）
                      向两侧推开；刚裂开中缝即刻放行下方真实 UI 的入场与显影
     ⑤ 连续显影        横幅封面按桌面 12→4.5→1.2→0 / 移动 8→3→.8→0 平滑收敛，分类胶囊错峰弹入，
                      首排焦点卡经 masonry.js 的 intro:reveal 放行并短显影，横幅计数同步滚动

   纪律：静止帧 = 终态（收尾把 intro-* 全摘掉；intro-done 只压静态页面骨架，首批动态节点另打
   intro-no-replay，不能顺手锁死以后切换法典新建的 chip/banner 内容）；任意输入立即跳终态。 */

import { $, esc } from './utils.js';
import { isPlainFeaturedVisit } from './featured.js';
import { isBirthday, BIRTHDAY_AUTHOR, BIRTHDAY_LABEL } from './birthday.js';

/* ⚠ 与 index.html 内联脚本共用：改名两处同改。UI 里不暴露，只给截图器 / 回归脚本关动效用
   （tools/verify_ui.py 经 Page.addScriptToEvaluateOnNewDocument 预置成 'off'） */
export const MOTION_STORAGE_KEY = 'fadian-motion';

const MIN_SHOW_MS = 560;         // 数据秒到时也让典籍双页稳稳亮个相、书脊走一段
const LOCK_MS = 170;             // 数据就绪后书脊补满 100% 并轻停一拍再推开
const SPLIT_MS = 540;            // 左右双页对开时长
const REVEAL_AT_MS = 110;        // 中缝刚裂开约 12% 时放行下层显影，既不藏在幕后也不慢半拍
const DEVELOP_MS = 520;          // hero 封面显影，与 CSS 的 introDevelop 必须同长
const TAIL_MS = 160;             // 等首排图片/分类波落稳；最后一帧不靠 finish() 硬切
const INTRO_ASSET_WAIT_MS = 420;
const PROGRESS_DELAY_MS = 70;
const PROGRESS_MS = 520;
const BIRTHDAY_FLIP_AT_MS = 220;
const BIRTHDAY_COVER_WAIT_MS = 900;
const BIRTHDAY_FLIP_MS = 480;
const BIRTHDAY_HOLD_MS = 900;
const EASE = 'cubic-bezier(.22,1,.36,1)';
const EASE_SPLIT = 'cubic-bezier(.76,0,.24,1)';

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
  startSpineTrack();
  startBirthdayCard();
  startTodayScramble();
  runIntro().catch(() => finishIntro({ skipped: true }));
}

const onIntroTimeout = () => finishIntro({ skipped: true });

async function runIntro() {
  const stage = $('#introStage');
  const noise = stage?.querySelector('.intro-noise');
  const left = $('#introFolioLeft');
  const right = $('#introFolioRight');
  const spine = $('#introSpine');
  const spineFill = $('#introSpineFill');
  const pct = $('#introPct');

  // ① 轻铺一层纸感颗粒：衬出精装画册触感，不抢双页干净底色
  const dark = document.body.classList.contains('dark');
  const peak = dark ? 0.08 : 0.10;
  const noiseIn = noise?.animate([{ opacity: 0 }, { opacity: peak }], { duration: 200, fill: 'both' });
  if (noiseIn) noiseIn.id = 'intro-noise-in';
  if (finished) return;

  // ②③ 等「首次视图 + 首排焦点图解码到位」与最短亮相时长（生日当天还要等插页卡翻完停够）
  await Promise.all([dataReady, wait(MIN_SHOW_MS), bday.shown]);
  if (finished) return;

  // ④ 书脊冲满 100% 并轻停一拍；如有生日插页卡，先上浮让路
  stopSpineTrack();
  const fromRatio = spineRatio;
  if (spineFill) {
    const fillEnd = spineFill.animate(
      [{ transform: `scaleY(${fromRatio})` }, { transform: 'scaleY(1)' }],
      { duration: LOCK_MS, easing: EASE, fill: 'forwards' },
    );
    fillEnd.id = 'intro-spine-lock';
  }
  spine?.classList.add('is-full');
  if (pct) pct.textContent = '100%';
  if (bday.card) {
    const bdayOut = bday.card.animate(
      [{ opacity: 1, translate: '-50% -50%' }, { opacity: 0, translate: '-50% calc(-50% - 28px)' }],
      { duration: 200, easing: 'ease-in', fill: 'forwards' },
    );
    bdayOut.id = 'intro-bday-out';
  }

  await wait(LOCK_MS);
  if (finished) return;

  // ⑤ 正式对开：双页立即让出交互，沿重曲线向左右推开
  stage?.classList.add('is-opening');
  noiseIn?.finish();
  if (spine) {
    const spineOut = spine.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-out', fill: 'forwards' });
    spineOut.id = 'intro-spine-out';
  }
  if (left) {
    const openL = left.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-102%)' }],
      { duration: SPLIT_MS, easing: EASE_SPLIT, fill: 'forwards' },
    );
    openL.id = 'intro-folio-open-l';
  }
  if (right) {
    const openR = right.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(102%)' }],
      { duration: SPLIT_MS, easing: EASE_SPLIT, fill: 'forwards' },
    );
    openR.id = 'intro-folio-open-r';
  }
  if (noise) {
    const noiseOut = noise.animate([{ opacity: peak }, { opacity: 0 }], { duration: 260, easing: 'ease-out', fill: 'forwards' });
    noiseOut.id = 'intro-noise-out';
  }

  // ⑥ 中缝裂开瞬间放行下方页面入场、横幅/首排卡片显影与进度条滚数
  timers.push(window.setTimeout(() => {
    if (finished) return;
    document.documentElement.classList.add('intro-reveal');
    document.dispatchEvent(new CustomEvent('intro:reveal'));
    startProgressCount();
  }, REVEAL_AT_MS));

  await wait(Math.max(SPLIT_MS + 60, REVEAL_AT_MS + DEVELOP_MS + TAIL_MS));
  finishIntro();
}

/* ---------- 书脊渐近进度（等数据时平滑推进，不假满、不倒退） ---------- */

let spineRaf = 0;
let spineRatio = 0;

function startSpineTrack() {
  const fill = $('#introSpineFill');
  const pct = $('#introPct');
  if (!fill && !pct) return;
  const start = performance.now();
  const tick = now => {
    if (finished) return;
    const elapsed = Math.max(0, now - start);
    // 指数渐近曲线：快网前段利落，慢网柔和贴近 92% 等待数据到来
    spineRatio = Math.min(0.92, 0.92 * (1 - Math.exp(-elapsed / 880)));
    if (fill) fill.style.transform = `scaleY(${spineRatio.toFixed(4)})`;
    if (pct) pct.textContent = `${String(Math.round(spineRatio * 100)).padStart(2, '0')}%`;
    spineRaf = requestAnimationFrame(tick);
  };
  spineRaf = requestAnimationFrame(tick);
}

function stopSpineTrack() {
  cancelAnimationFrame(spineRaf);
  spineRaf = 0;
}

/* ---------- 今日画师名字行 ---------- */

const GLYPHS = 'abcdefghijklmnopqrstuvwxyz0123456789_';
const noiseText = n => Array.from({ length: n }, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]).join('');
let scrambleTimer = 0;

function startTodayScramble() {
  const line = $('#introToday');
  const name = $('#introTodayName');
  if (!line || !name || !isPlainFeaturedVisit()) return;
  line.hidden = false;
  name.textContent = noiseText(8);
  scrambleTimer = window.setInterval(() => { name.textContent = noiseText(8); }, 55);
  timers.push(scrambleTimer);
}

/** app.js 在首次视图渲染后调：首屏第一格真是今日画师就把名字定住，否则（被屏蔽、深链进别处等）淡出名字行。 */
export function setIntroFeatured(artist) {
  const line = $('#introToday');
  const name = $('#introTodayName');
  if (finished || !line || !name || line.hidden) return;
  window.clearInterval(scrambleTimer);
  if (!artist) {
    line.classList.add('is-gone');
    const out = line.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    out.id = 'intro-today-out';
    return;
  }
  const per = Math.max(1, Math.ceil(artist.length / 8));
  let locked = 0;
  const tick = () => {
    if (finished) return;
    locked = Math.min(artist.length, locked + per);
    name.textContent = artist.slice(0, locked) + noiseText(artist.length - locked);
    if (locked < artist.length) timers.push(window.setTimeout(tick, 28));
    else line.classList.add('is-locked');
  };
  tick();
}

/* ---------- 生日插页卡（所长生日当天居中压在书脊之上翻面亮相） ---------- */

const bday = { card: null, coverReadyNow: null, coverReady: Promise.resolve(), shown: Promise.resolve() };

function startBirthdayCard() {
  const stage = $('#introStage');
  if (!stage || !isBirthday()) return;
  stage.classList.add('has-bday');
  const card = document.createElement('div');
  card.className = 'intro-bday';
  card.innerHTML =
    '<div class="intro-bday-face"><span class="ibd-img"></span>' +
    `<span class="ibd-body"><b>所长生日快乐</b><span class="ibd-meta"><span class="ibd-pill">${esc(BIRTHDAY_LABEL)}</span>` +
    `<small>${esc(BIRTHDAY_AUTHOR)}</small></span></span></div>` +
    `<i class="intro-bday-back" data-mark="${esc(BIRTHDAY_LABEL)}"><b>法典<span>图鉴</span></b></i>`;
  stage.append(card);
  bday.card = card;
  bday.coverReady = new Promise(resolve => { bday.coverReadyNow = resolve; });
  bday.shown = (async () => {
    await wait(BIRTHDAY_FLIP_AT_MS);
    await Promise.race([bday.coverReady, wait(BIRTHDAY_COVER_WAIT_MS - BIRTHDAY_FLIP_AT_MS)]);
    if (finished) return;
    const flip = card.animate([
      { transform: 'perspective(1400px) translateY(0) rotateY(180deg) rotate(0deg)' },
      { transform: 'perspective(1400px) translateY(-22px) rotateY(90deg) rotate(-3deg)', offset: 0.5 },
      { transform: 'perspective(1400px) translateY(-8px) rotateY(0deg) rotate(-2deg)' },
    ], { duration: BIRTHDAY_FLIP_MS, easing: EASE, fill: 'forwards' });
    flip.id = 'intro-bday-flip';
    await flip.finished.catch(() => {});
    await wait(BIRTHDAY_HOLD_MS);
  })();
}

/** app.js 拿到 codexes.json 后调：给生日插页卡正面换上图。没有图就让翻面不再等。 */
export function setIntroBirthdayCover(url, styleAttr = '') {
  const slot = bday.card?.querySelector('.ibd-img');
  if (finished || !slot) return;
  const ready = () => { bday.coverReadyNow?.(); bday.coverReadyNow = null; };
  if (!url) { ready(); return; }
  slot.innerHTML = `<img src="${esc(url)}" alt=""${styleAttr}>`;
  const img = slot.firstElementChild;
  const loaded = () => Promise.resolve(img.decode?.()).catch(() => {}).then(() => { img.classList.add('is-loaded'); ready(); });
  if (img.complete && img.naturalWidth) loaded();
  else { img.onload = loaded; img.onerror = ready; }
}

/* ---------- 资产预解码闸门（确保焦点图在双页背后解码并建层） ---------- */

async function waitForIntroAssets() {
  const images = [...document.querySelectorAll('.masonry .card.intro-focus .card-img')];
  if (!images.length) return;

  const decoded = new Set();
  const prepare = async img => {
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
  stopSpineTrack();
  cancelAnimationFrame(counterRaf);
  counterRaf = 0;
  unbindSkip();
  document.removeEventListener('intro:timeout', onIntroTimeout);
  settleCounter();
  /* 先把在飞的页面 intro 动画推到终点，再摘类；只摘类会让元素从半途「跳」回终态。
     CSS 动画认 animationName（都以 intro 打头），WAAPI 认自取的 intro- 前缀 id。 */
  if (typeof document.getAnimations === 'function') {
    for (const anim of document.getAnimations()) {
      const name = String(anim.animationName || '');
      const id = String(anim.id || '');
      if (!name.startsWith('intro') && !id.startsWith('intro-')) continue;
      try { anim.finish(); } catch { /* 已结束或不可完成，忽略 */ }
    }
  }
  /* 掀幕前被跳过时，masonry 那边还攒着一批「起始态」卡片，必须叫它们落终态，否则首屏是空白 */
  document.dispatchEvent(new CustomEvent('intro:settle', { detail: { skipped } }));
  const stage = $('#introStage');
  if (stage) stage.remove();
  bday.card = null;
  const html = document.documentElement;
  /* 只给**当前首批动态节点**打标；换法典 innerHTML 新建的节点没有此类，常规二段浮现仍可用。
     数据前跳过时节点还不存在，留一个一次性标志，等 markIntroDataReady() 在首次 render 后补标。 */
  markCurrentDynamicNoReplay();
  if (skipped && !dataReadyRequested) suppressNextDynamicReplay = true;
  html.classList.remove('intro-arm', 'intro-run', 'intro-reveal');
  /* ⚠ intro-done 必须留下：它压掉静态骨架与当前首批节点的常规入场动画。 */
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
