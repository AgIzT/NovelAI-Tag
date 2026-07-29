/* 一键复制反馈「采样」——照搬 `珍贵的优化建议/动效方案演示.html` 的 COPY_FX.diffusion。
   理念：复制不是「拷了段字」，是**把这张图的种子取走**。所以三件事同时发生：

     ① 图面闪回一帧噪声   opacity 0 → .28(offset .4) → 0，180ms —— 图像短暂退回未去噪的样子
     ② 卡片一圈采样环     box-shadow 0 → 3px(α.8) → 6px(α0)，340ms
     ③ 种子芯片浮起       乱码 4 帧 × 30ms 重组成「✓ 已采样 · N tags」，
                          +6px → -8px 浮起 260ms，停 1000ms，再带 blur(3px) 淡出 260ms

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

let chipEl = null;
let noiseEl = null;
let chipTimers = [];
let chipGen = 0;        // 每次播放一个代号：上一次的收尾回调不许再碰这一次的芯片
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
 */
export function playCopySample(node, text, label = '已复制正面') {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const now = performance.now();
  const combo = now - lastAt < COMBO_MS;      // 连点降格：只留芯片，不再闪噪声、不再乱码重组
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
  clearChipTimers();
  chip.getAnimations().forEach(a => { try { a.cancel(); } catch { /* 已结束 */ } });
  /* ⚠ 淡出用的是 fill:'forwards' 的 blur(3px)。取消动画理论上会撤掉填充值，
     但连点时上一轮的收尾回调仍可能抢在后面执行，把这一轮的芯片按成「糊着 / 隐藏」。
     所以这里显式把视觉状态归零，再配 chipGen 让过期回调整个作废——
     这就是「芯片一直模糊、快消失了才清晰」那个 bug 的根。 */
  chip.style.filter = 'none';
  chip.style.opacity = '';
  const target = `✓ ${label} · ${countTags(text)} tags`;
  const { x, y } = anchorFor(node);
  chip.style.left = `${Math.round(x)}px`;
  chip.style.top = `${Math.round(y - 14)}px`;
  chip.hidden = false;

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
  chip.animate([
    { opacity: 0, translate: '0 6px' },
    { opacity: 1, translate: '0 -8px' },
  ], { duration: riseMs, easing: 'cubic-bezier(0.16,1,0.3,1)', fill: 'forwards' });

  const holdMs = combo ? 700 : 1000;
  chipTimers.push(window.setTimeout(() => {
    if (gen !== chipGen) return;
    chip.style.filter = '';   // 交还给动画，别和内联的 none 打架
    chip.animate(
      [{ opacity: 1, filter: 'blur(0px)' }, { opacity: 0, filter: 'blur(3px)' }],
      { duration: 260, fill: 'forwards' },
    ).finished.then(
      () => { if (gen === chipGen) chip.hidden = true; },
      () => {},   // ⚠ 必须用两参 then：写成 .catch(()=>{}).then(...) 的话，
                  //   被取消的动画也会走进成功分支，把下一次的芯片藏掉
    );
  }, riseMs + holdMs));
}
