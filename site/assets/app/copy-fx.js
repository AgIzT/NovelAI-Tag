/* 一键复制反馈「采样」——照搬 `珍贵的优化建议/动效方案演示.html` 的 COPY_FX.diffusion。
   理念：复制不是「拷了段字」，是**把这张图的种子取走**。所以三件事同时发生：

     ① 图面闪回一帧噪声   opacity 0 → .28(offset .4) → 0，180ms —— 图像短暂退回未去噪的样子
     ② 卡片一圈采样环     box-shadow 0 → 3px(α.8) → 6px(α0)，340ms
     ③ 种子芯片浮起       乱码 4 帧 × 30ms 重组成「✓ 已采样 · N tags」，
                          +6px → -8px 浮起 260ms，停 1000ms，再用位移 + 透明度退场 180ms

   与原方案的两处差异（都有原因，别当漏做）：
     · 颜色用 var(--accent) 而不是写死的 #8b7cf8 —— 本站有四套主题，写死会在樱粉/暖金下串色
     · 芯片挂 <body> 且 position:fixed —— 卡片在 .masonry 里，那层有 contain:layout paint，
       挂在卡片内部会被裁掉（提 z-index 也没用，见 roadmap 红线）

   纪律（roadmap「复制反馈升级」共同约束）：只在 clipboard 写入 resolve 之后调；
   芯片与噪声都是单例节点复用；600ms 内连点走简化版，不让最高频动作变成噪音。 */

const GLYPHS = '▓▒░#*+=%$@!?';
const SCRAMBLE_FRAMES = 4;
const SCRAMBLE_MS = 30;
const COMBO_MS = 600;
const EXIT_MS = 180;
const TOSS_MS = 500;
const TOSS_DELAY_MS = 140;
const TOSS_COMBO_DELAY_MS = 60;
const TARGET_PULSE_MS = 320;
const EXIT_CLEANUP_GRACE_MS = 80;

let chipEl = null;
let noiseEl = null;
let chipTimers = [];
let chipGen = 0;        // 每次播放一个代号：上一次的收尾回调不许再碰这一次的芯片
let riseAnimation = null;
let exitAnimation = null;
let lastAt = 0;
let pointer = null;

/* 复制可能来自卡片点击、prompt 条、迷你按钮或键盘，copyText 拿不到事件；
   在窗口层记一下最后的指针位置，键盘触发时再退回卡片中心 */
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', e => {
    pointer = { x: e.clientX, y: e.clientY, at: performance.now() };
  }, { passive: true, capture: true });
}

function ensureChip() {
  if (chipEl?.isConnected) return chipEl;
  chipEl = document.createElement('div');
  chipEl.className = 'copy-seed-chip';
  chipEl.setAttribute('aria-hidden', 'true');   // 文案由 toast 的 live region 播报，别重复读一遍
  document.body.appendChild(chipEl);
  return chipEl;
}

function ensureNoise() {
  if (!noiseEl) {
    noiseEl = document.createElement('i');
    noiseEl.className = 'copy-sample-noise';
    noiseEl.setAttribute('aria-hidden', 'true');
  }
  return noiseEl;
}

function clearChipTimers() {
  for (const id of chipTimers) window.clearTimeout(id);
  chipTimers = [];
}

function cancelAnimation(animation) {
  if (!animation) return;
  try { animation.cancel(); } catch { /* 已结束或已被浏览器回收 */ }
}

/* 不把 fill:forwards 的终态留给下一轮复用。Chrome 后台标签页会把已结束、
   已不再出现在 getAnimations() 里的合成结果继续显示；旧 blur/opacity 因而可能
   压住整段下一轮停留期。句柄主动销毁 + 明确的清晰基础态可切断这条残留链。 */
function resetChipAnimations(chip) {
  cancelAnimation(riseAnimation);
  cancelAnimation(exitAnimation);
  riseAnimation = null;
  exitAnimation = null;
  chip.getAnimations().forEach(cancelAnimation);
}

function setChipClearState(chip, hidden = chip.hidden) {
  chip.style.opacity = '1';
  chip.style.filter = 'none';
  chip.style.translate = '0 -8px';
  chip.hidden = hidden;
}

function countTags(text) {
  return String(text || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .length;
}

function anchorFor(node) {
  const fresh = pointer && performance.now() - pointer.at < 1500;
  if (fresh) return { x: pointer.x, y: pointer.y };
  const rect = node?.getBoundingClientRect?.();
  if (rect && rect.width) return { x: rect.left + rect.width / 2, y: rect.top + Math.min(80, rect.height / 2) };
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

/**
 * 播一次「采样」反馈。
 * @param {HTMLElement|null} node  触发复制的节点（卡片或卡片内的按钮）
 * @param {string} text            实际写进剪贴板的文本，用来数 tag 数
 * @param {string} label           芯片主文案，区分正面 / 负面
 * @param {object} [options]
 * @param {Element|null} [options.flyTo] 给了就把芯片抛向它（复制即入库时指向中转站），
 *                                       芯片不再原地悬停淡出——「这条被收走了」比「复制成功了」信息量大
 */
export function playCopySample(node, text, label = '已复制正面', options = {}) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const now = performance.now();
  const combo = lastAt > 0 && now - lastAt < COMBO_MS; // 首次点击不能因页面刚加载而误判成连点
  lastAt = now;
  const gen = ++chipGen;

  const card = node?.closest?.('.card') || null;

  // ① 图面噪声：单例节点搬进当前卡片的图框（图框有 overflow:hidden，天然裁好）
  if (!combo && card) {
    const wrap = card.querySelector('.card-img-wrap');
    if (wrap && wrap.offsetParent !== null) {
      const noise = ensureNoise();
      wrap.appendChild(noise);
      noise.animate(
        [{ opacity: 0 }, { opacity: 0.28, offset: 0.4 }, { opacity: 0 }],
        { duration: 180, easing: 'linear' },
      ).finished.then(() => noise.remove(), () => {});
    }
  }

  // ② 采样环：由 CSS 的 .card.copied 动画负责（copy.js 已在写入成功后加类）

  // ③ 种子芯片
  const chip = ensureChip();
  const flyTo = options.flyTo;
  const flyBox = flyTo?.getBoundingClientRect?.() || null;
  const hasFlyTarget = Boolean(flyBox && (flyBox.width || flyBox.height));
  chip.className = `copy-seed-chip${hasFlyTarget ? ' is-relay-toss' : ''}`;
  clearChipTimers();
  resetChipAnimations(chip);
  setChipClearState(chip, false);
  const target = hasFlyTarget
    ? `✓ 已存入中转站 · ${countTags(text)} tags`
    : `✓ ${label} · ${countTags(text)} tags`;
  const { x, y } = anchorFor(node);
  chip.style.left = `${Math.round(x)}px`;
  chip.style.top = `${Math.round(y - 14)}px`;
  if (combo) {
    chip.textContent = target;
  } else {
    chip.textContent = '░▒▓ ······';
    let frame = 0;
    const scramble = window.setInterval(() => {
      frame++;
      if (frame >= SCRAMBLE_FRAMES) {
        chip.textContent = target;
        window.clearInterval(scramble);
        return;
      }
      chip.textContent = Array.from(target, ch =>
        Math.random() < 0.6 ? GLYPHS[Math.random() * GLYPHS.length | 0] : ch).join('');
    }, SCRAMBLE_MS);
    chipTimers.push(scramble);
  }

  const riseMs = combo ? 120 : 260;
  const rise = chip.animate([
    { opacity: 0, translate: '0 6px' },
    { opacity: 1, translate: '0 -8px' },
  ], { duration: riseMs, easing: 'cubic-bezier(0.16,1,0.3,1)' });
  riseAnimation = rise;
  rise.finished.then(
    () => {
      if (gen !== chipGen || riseAnimation !== rise) return;
      riseAnimation = null;
      cancelAnimation(rise);
      setChipClearState(chip, false);
    },
    () => { if (riseAnimation === rise) riseAnimation = null; },
  );

  /* 抛入中转站：起点是芯片当下的位置，终点是中转站的落点。
     弧线中点抬高一截（照 docs/动效方案演示.html 检字台那版），末端缩小并淡出，
     落点自己弹一下表示收到。只在真入库时走这条，分享链接之类不会飞。 */
  if (hasFlyTarget) {
    const dx = Math.round(flyBox.left + flyBox.width / 2 - x);
    const dy = Math.round(flyBox.top + flyBox.height / 2 - (y - 14));
    const arcLift = Math.min(110, Math.max(56, Math.round(Math.hypot(dx, dy) * 0.14)));
    chipTimers.push(window.setTimeout(() => {
      if (gen !== chipGen) return;
      cancelAnimation(riseAnimation);
      riseAnimation = null;
      setChipClearState(chip, false);
      const toss = chip.animate([
        { translate: '0 -8px', scale: '1.06', opacity: .96, offset: 0 },
        { translate: `${Math.round(dx * 0.16)}px ${Math.round(dy * 0.12 - 26)}px`, scale: '1.08', opacity: 1, offset: .22 },
        { translate: `${Math.round(dx * 0.68)}px ${Math.round(dy * 0.64 - arcLift)}px`, scale: '.8', opacity: 1, offset: .68 },
        { translate: `${Math.round(dx * 0.94)}px ${Math.round(dy * 0.93 - 8)}px`, scale: '.54', opacity: .94, offset: .92 },
        { translate: `${dx}px ${dy}px`, scale: '.32', opacity: 0, offset: 1 },
      ], { duration: TOSS_MS, easing: 'cubic-bezier(.2,.7,.22,1)' });
      exitAnimation = toss;
      const done = () => {
        if (gen !== chipGen || exitAnimation !== toss) return;
        chip.hidden = true;
        exitAnimation = null;
        cancelAnimation(toss);
        setChipClearState(chip, true);
        flyTo.animate?.(
          [
            { scale: '1', filter: 'brightness(1)', offset: 0 },
            { scale: '1.16', filter: 'brightness(1.22)', offset: .42 },
            { scale: '1.04', filter: 'brightness(1.08)', offset: .72 },
            { scale: '1', filter: 'brightness(1)', offset: 1 },
          ],
          { duration: TARGET_PULSE_MS, easing: 'cubic-bezier(.16,1,.3,1)' },
        );
      };
      toss.finished.then(done, done);
      /* 和下面正常退场那支同一个理由：后台标签页会冻结 WAAPI 时间线却继续推进
         setTimeout，只等 finished 的话芯片会停在飞行途中，直到标签页重新获得前台。 */
      chipTimers.push(window.setTimeout(done, TOSS_MS + EXIT_CLEANUP_GRACE_MS));
    }, combo ? TOSS_COMBO_DELAY_MS : TOSS_DELAY_MS));
    return;
  }

  const holdMs = combo ? 700 : 1000;
  chipTimers.push(window.setTimeout(() => {
    if (gen !== chipGen) return;
    cancelAnimation(riseAnimation);
    riseAnimation = null;
    setChipClearState(chip, false);
    const exit = chip.animate(
      [
        { opacity: 1, translate: '0 -8px', offset: 0 },
        { opacity: 1, translate: '0 -8px', offset: 0.5 },
        { opacity: 0, translate: '0 -13px', offset: 1 },
      ],
      { duration: EXIT_MS, easing: 'linear' },
    );
    exitAnimation = exit;
    const finishExit = () => {
      if (gen !== chipGen || exitAnimation !== exit) return;
      chip.hidden = true;   // 先停止绘制，再撤销动画，避免清晰基础态闪一帧
      exitAnimation = null;
      cancelAnimation(exit);
      setChipClearState(chip, true);
    };
    exit.finished.then(
      finishExit,
      finishExit, // 当前轮若被浏览器主动取消也必须收口；新一轮会被 gen / 句柄双重拦住
    );
    /* 后台标签页可能冻结 WAAPI 时间线，却继续推进 setTimeout。不能只等 finished，
       否则芯片会停在退场首帧直到标签页重新获得前台。 */
    chipTimers.push(window.setTimeout(finishExit, EXIT_MS + EXIT_CLEANUP_GRACE_MS));
  }, riseMs + holdMs));
}
