/* 首访开场：等数据时「发牌」，开幕后「显影」。

   等数据（html.intro-arm）：
     ① 全屏噪声层     opacity 0→.14→.05→0（浅色主题按比例抬到 .16/.065，见下），活得比幕布久
     ② 牌堆切牌        index.html 里写死的一叠卡背（首帧就在，不等模块），这里每 540ms 切一次牌；
                      数据不来就一直切，画面不会停住。等待逻辑仍是 dataReady，不靠动画时长
     ③ 今日画师名字行  只在直接进站时显示（featured.js 的 isPlainFeaturedVisit）：artist: 后面的字乱跳，
                      app.js 拿到首屏真放在第一格的今日画师后调 setIntroFeatured()，约 0.3s 内逐字定住
   开幕（intro-reveal）：
     ④ 发牌            首排几张卡从牌堆顶一张接一张翻面飞到各自的位置（替身是真卡的克隆），图在半空由糊到清，
                      落地即换回真卡；第一张就是今日画师
     ⑤ 连续显影        横幅封面按桌面 12→4.5→1.2→0 / 移动 8→3→.8→0 平滑收敛（原 diffusion 分镜），
                      分类圆点 scale(.4)→1 / 200ms / 错峰 50ms，首排以外的卡片照常短显影

   纪律：静止帧 = 终态（收尾把 intro-* 全摘掉；intro-done 只压静态页面骨架，首批动态节点另打
   intro-no-replay，不能顺手锁死以后切换法典新建的 chip/banner 内容）；任意输入立即跳终态，
   在飞的替身当场收掉、真卡当场显形。 */

import { $ } from './utils.js';
import { isPlainFeaturedVisit } from './featured.js';

const introActions = { settleCardEntry: () => {} };

export function setIntroActions(actions) {
  Object.assign(introActions, actions);
}

/* ⚠ 与 index.html 内联脚本共用：改名两处同改。UI 里不暴露，只给截图器 / 回归脚本关动效用
   （tools/verify_ui.py 经 Page.addScriptToEvaluateOnNewDocument 预置成 'off'） */
export const MOTION_STORAGE_KEY = 'fadian-motion';

const MIN_SHOW_MS = 700;     // 数据秒到时也让牌堆亮个相、切一次牌（原打字机本来就占约 0.8s）
const CUT_FIRST_MS = 300;
const CUT_EVERY_MS = 540;
const DEAL_FLY_MS = 520;
const DEAL_FACE_AT = 0.42;
const DEVELOP_MS = 520;      // hero 封面显影，与 CSS 的 introDevelop 必须同长
const TAIL_MS = 180;         // 等首排图片/分类波落稳；最后一帧不靠 finish() 硬切
const VEIL_MS = 130;         // 幕布只负责交接；不能盖住卡片最有辨识度的模糊→清晰阶段
const INTRO_ASSET_WAIT_MS = 420;
const PROGRESS_DELAY_MS = 90;
const PROGRESS_MS = 520;
const EASE = 'cubic-bezier(.22,1,.36,1)';

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
  startShuffle();
  startTodayScramble();
  runIntro().catch(() => finishIntro({ skipped: true }));
}

const onIntroTimeout = () => finishIntro({ skipped: true });

async function runIntro() {
  const noise = document.querySelector('.intro-noise');

  // ① 噪声铺开：站点先是「一片未成形」
  // ⚠ 原方案的 .14 是按近黑舞台（#07080d）调的；浅色主题略抬一档，但不能让噪声盖住
  //   幕布退开后的图片显影。
  const dark = document.body.classList.contains('dark');
  const peak = dark ? 0.14 : 0.16;
  const mid = dark ? 0.05 : 0.065;
  const noiseIn = noise?.animate([{ opacity: 0 }, { opacity: peak }], { duration: 200, fill: 'both' });
  if (finished) return;

  // ②③ 切牌与名字行已在 startIntro 起跑；这里只等「首次视图 + 首排图片到位」与最短亮相时长
  await Promise.all([dataReady, wait(MIN_SHOW_MS)]);
  if (finished) return;

  // ④ 开幕：幕布让开，真实 UI 在噪声底下连续分段显影（CSS introDevelop / play-state 由此刻放行）
  const html = document.documentElement;
  html.classList.add('intro-reveal');
  noiseIn?.finish();
  const veil = document.querySelector('.intro-veil');
  veil?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: VEIL_MS, easing: 'ease-out', fill: 'forwards' });
  timers.push(window.setTimeout(() => { if (veil) veil.style.display = 'none'; }, VEIL_MS));
  document.dispatchEvent(new CustomEvent('intro:reveal'));
  const dealMs = dealFirstRow();

  // 噪声跟着显影两段退场：先在轮廓成形时回落，再在细节清晰时退净
  timers.push(window.setTimeout(() => {
    noise?.animate([{ opacity: peak }, { opacity: mid }], { duration: 180, fill: 'both' });
  }, VEIL_MS));
  timers.push(window.setTimeout(() => {
    noise?.animate([{ opacity: mid }, { opacity: 0 }], { duration: 160, fill: 'both' });
  }, DEVELOP_MS));

  startProgressCount();
  // 发牌比显影长时多等最后一张落地：动画按帧对齐，定时器若抢在落地之前收尾，那张真卡会再淡入一次
  await wait(Math.max(DEVELOP_MS + TAIL_MS, dealMs + 80));
  finishIntro();
}

/* ---------- 牌堆：切牌（等数据）与发牌（开幕） ---------- */

const deal = { cards: [], shuffling: false, flyers: [], dealt: [] };
const slot = k => `translate(${k * 2}px,${k * 2.4}px)`;

function placeDeck() {
  const n = deal.cards.length;
  deal.cards.forEach((card, k) => { card.style.zIndex = String(n - k); card.style.transform = slot(k); });
}

/* 切牌：顶牌往一侧抽出、塞回牌底，左右交替；其余每张上移一格。
   index.html 里最后一张牌画在最上面，所以倒过来排：cards[0] 是顶牌。 */
function startShuffle() {
  const deck = $('#introDeck');
  if (!deck) return;
  deal.cards = [...deck.children].reverse();
  deal.shuffling = true;
  placeDeck();
  let dir = 1;
  const cut = () => {
    if (!deal.shuffling || finished) return;
    const width = deck.getBoundingClientRect().width;
    const top = deal.cards.shift();
    const out = `translate(${dir * width * 0.7}px,-10px) rotate(${dir * 8}deg)`;
    top.style.zIndex = String(deal.cards.length + 2);   // 抽出途中压在所有牌之上，塞回时再落到牌底
    const lift = top.animate([{ transform: slot(0) }, { transform: out }],
      { duration: 200, easing: 'cubic-bezier(.3,.6,.3,1)', fill: 'forwards' });
    const n = deal.cards.length + 1;
    deal.cards.forEach((card, k) => {
      card.animate([{ transform: slot(k + 1) }, { transform: slot(k) }], { duration: 240, easing: EASE });
      card.style.transform = slot(k);
      card.style.zIndex = String(n - k);
    });
    deal.cards.push(top);
    lift.finished.then(() => {
      if (!deal.shuffling) return;
      top.style.zIndex = '0';
      top.style.transform = slot(n - 1);
      top.animate([{ transform: out }, { transform: slot(n - 1) }], { duration: 240, easing: EASE });
      lift.cancel();
    }, () => {});
    dir = -dir;
    timers.push(window.setTimeout(cut, CUT_EVERY_MS));
  };
  timers.push(window.setTimeout(cut, CUT_FIRST_MS));
}

/* 首排 = 视口里最靠上的那一排卡，按 left 从左到右（瀑布流第一格在最左）。
   取落地矩形时临时归零主内容与卡片的入场位移；同一任务内还原，不结束或重启原动画。 */
function firstRowCards() {
  const nodes = [...document.querySelectorAll('#masonry .card')];
  const styles = [];
  const override = (node, prop, value) => {
    if (!node) return;
    styles.push([node, prop, node.style.getPropertyValue(prop), node.style.getPropertyPriority(prop)]);
    node.style.setProperty(prop, value, 'important');
  };
  try {
    override($('#main'), 'translate', 'none');
    for (const card of nodes) {
      override(card, 'transition', 'none');
      override(card, '--entry-offset', '0px');
    }
    const cards = nodes.map(card => [card, card.getBoundingClientRect()])
      .filter(([, r]) => r.width > 0 && r.bottom > 0 && r.top < innerHeight);
    if (!cards.length) return [];
    const top = Math.min(...cards.map(([, r]) => r.top));
    return cards.filter(([, r]) => r.top - top < 10).sort((a, b) => a[1].left - b[1].left);
  } finally {
    for (const [node, prop, value, priority] of styles.reverse()) {
      if (value) node.style.setProperty(prop, value, priority);
      else node.style.removeProperty(prop);
    }
  }
}

/* 发牌：每张首排卡克隆成替身，从牌堆顶翻面飞到真卡的位置，落地即换回真卡。返回整段时长。
   只有原本就是显影焦点（intro-focus）的那几张替身做模糊收清，守住「桌面 ≤3、手机 1 张滤镜」的预算；
   开幕时图还没到的，替身逐帧跟着真卡补上 src / 加载完成态。 */
function dealFirstRow() {
  deal.shuffling = false;
  const deck = $('#introDeck');
  const today = $('#introToday');
  if (today && !today.hidden && !today.classList.contains('is-gone')) {
    today.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
  }
  if (!deck) return 0;
  for (const card of deal.cards) for (const anim of card.getAnimations()) anim.cancel();
  placeDeck();
  const row = firstRowCards();
  const stagger = innerWidth <= 600 ? 110 : 85;
  const fadeDeck = delay => deck.animate([{ opacity: 1, scale: 1 }, { opacity: 0, scale: 0.92 }],
    { duration: 220, delay, easing: 'ease-in', fill: 'forwards' });
  if (!row.length) {
    fadeDeck(0);
    return 220;
  }
  const d = deck.getBoundingClientRect();
  const cx = d.left + d.width / 2;
  const cy = d.top + d.height / 2;
  row.forEach(([card, r], i) => {
    card.classList.add('intro-dealt');
    deal.dealt.push(card);
    const fly = document.createElement('div');
    fly.className = 'intro-flyer';
    fly.inert = true;
    fly.setAttribute('aria-hidden', 'true');
    fly.style.width = `${r.width}px`;
    fly.style.height = `${r.height}px`;
    const face = card.cloneNode(true);
    const focus = face.classList.contains('intro-focus');
    face.classList.remove('card-enter', 'is-entered', 'intro-focus', 'switch-focus', 'intro-dealt', 'intro-no-replay');
    face.removeAttribute('data-entry-pending');
    face.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;transform:none;opacity:1;margin:0;transition:none';
    const back = document.createElement('i');
    back.className = 'intro-card';
    back.innerHTML = '<b>法典<span>图鉴</span></b>';
    fly.append(face, back);
    document.body.append(fly);
    deal.flyers.push(fly);

    const delay = i * stagger;
    timers.push(window.setTimeout(() => { if (deal.cards[i]) deal.cards[i].style.visibility = 'hidden'; }, delay));
    const s0 = d.width / r.width;
    const sx = cx - r.width / 2;
    const sy = cy - r.height / 2;
    const tilt = (i % 2 ? 1 : -1) * (4 + i);
    const flight = fly.animate([
      { transform: `perspective(1600px) translate(${sx}px,${sy}px) rotateY(180deg) rotate(0deg) scale(${s0})` },
      { transform: `perspective(1600px) translate(${(sx + r.left) / 2}px,${Math.min(sy, r.top) - 46}px) rotateY(95deg) rotate(${tilt}deg) scale(${(s0 + 1) / 2})`, offset: DEAL_FACE_AT },
      { transform: `perspective(1600px) translate(${r.left}px,${r.top}px) rotateY(0deg) rotate(0deg) scale(1)` },
    ], { duration: DEAL_FLY_MS, delay, easing: 'cubic-bezier(.3,.7,.25,1)', fill: 'both' });

    const img = face.querySelector('.card-img');
    const realImg = card.querySelector('.card-img');
    if (img && realImg) {
      const follow = () => {
        if (!fly.isConnected) return;
        const src = realImg.getAttribute('src');
        if (src && img.getAttribute('src') !== src) img.setAttribute('src', src);
        if (realImg.classList.contains('is-loaded') || (img.complete && img.naturalWidth)) {
          img.classList.add('is-loaded');
          face.querySelector('.card-img-wrap')?.classList.remove('is-loading');
          return;
        }
        requestAnimationFrame(follow);
      };
      follow();
      // 翻过来那一刻图还带一点糊，落地前收清
      if (focus) {
        img.animate([{ filter: 'blur(6px) saturate(.75)' }, { filter: 'blur(2px) saturate(.92)', offset: 0.5 }, { filter: 'blur(0) saturate(1)' }],
          { duration: DEAL_FLY_MS * (1 - DEAL_FACE_AT), delay: delay + DEAL_FLY_MS * DEAL_FACE_AT, easing: 'linear', fill: 'backwards' });
      }
    }
    flight.finished.then(() => landCard(card, fly), () => {});
  });
  // 首排以外的余牌不能留在原地淡出；最后一张起飞时整副牌堆立即退场。
  deck.animate([{ opacity: 1 }, { opacity: 0 }],
    { duration: 1, delay: (row.length - 1) * stagger, easing: 'step-start', fill: 'forwards' });
  return (row.length - 1) * stagger + DEAL_FLY_MS;
}

/* 交回真卡前由瀑布流统一结算壳与图片；先撤显影规则再显形，避免图片重播与两处恢复过渡相互覆盖。 */
function revealDealt(card) {
  introActions.settleCardEntry(card, { immediate: true });
  card.classList.remove('intro-dealt');
  void card.offsetWidth;
}

function landCard(card, fly) {
  if (!fly.isConnected) return;
  revealDealt(card);
  fly.remove();
  deal.flyers = deal.flyers.filter(item => item !== fly);
  deal.dealt = deal.dealt.filter(item => item !== card);
}

/* 跳过、超时或收尾：在飞的替身当场收掉，真卡当场显形 */
function settleDeal() {
  deal.shuffling = false;
  for (const fly of deal.flyers) {
    for (const anim of fly.getAnimations()) anim.cancel();
    fly.remove();
  }
  for (const card of deal.dealt) revealDealt(card);
  deal.flyers = [];
  deal.dealt = [];
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
    // 记一笔：开幕时别再从不透明淡一次（那会让已经淡掉的名字行闪回来）
    line.classList.add('is-gone');
    line.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    return;
  }
  // 不管名字多长都在约 0.3 秒内定完：数据到了离开幕通常只剩零点几秒
  const per = Math.max(1, Math.ceil(artist.length / 9));
  let locked = 0;
  const tick = () => {
    locked = Math.min(artist.length, locked + per);
    name.textContent = artist.slice(0, locked) + noiseText(artist.length - locked);
    if (locked < artist.length) timers.push(window.setTimeout(tick, 32));
    else line.classList.add('is-locked');
  };
  tick();
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
  settleDeal();
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
