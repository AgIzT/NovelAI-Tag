import { state, VIRTUAL_BUFFER_UP, VIRTUAL_BUFFER_DOWN, IMAGE_LOAD_DELAY, RELAYOUT_INTERVAL, RELAYOUT_ANIM_MS, DEFAULT_IMAGE_RATIO } from './state.js';
import { densityConfig } from './state.js';
import { $, clamp, prefersReducedMotion, updateScrollProgress } from './utils.js';
import { toast } from './feedback.js';
import { currentHighlightTerms, hiddenSearchMatch, renderHighlightedText } from './search.js';
import { hasEntryImage, entryImages, thumbUrl, localAssetUrl, cacheBustUrl } from './media.js';
import { copyText, combinedPrompt, combinedPromptLabel, entryPromptText } from './copy.js';
import { isFav } from './favorites.js';
import { updateReadingSpy } from './codex-ui.js';

const masonryActions = {
  openLightbox: () => {},
  copyEntry: () => {},
  toggleFav: () => {},
  reportEntry: () => {},
};

const FILTER_EXIT_MS = 140;
const FILTER_EXIT_PAD_MS = 24;

let filterTransitionSeq = 0;
let filterTransitionTimer = 0;
let forceEntryAnim = false;
let suppressNextInitialEntryBatch = false;

export function setMasonryActions(actions = {}) {
  Object.assign(masonryActions, actions);
}

function clearFilterTransitionTimer() {
  if (!filterTransitionTimer) return;
  clearTimeout(filterTransitionTimer);
  filterTransitionTimer = 0;
}

function cleanupFilterTransition(m = $('#masonry')) {
  clearFilterTransitionTimer();
  forceEntryAnim = false;
  if (!m) return;
  m.classList.remove('is-filtering');
  m.querySelectorAll('.card-leaving').forEach(node => {
    node.classList.remove('card-leaving');
    node.style.removeProperty('--filter-delay');
  });
}

function isNearFilterTop() {
  return window.scrollY <= Math.min(window.innerHeight * 0.75, 640);
}

function canRunFilterTransition(m, transition) {
  if (transition !== 'filter' || prefersReducedMotion() || !state.codex || !m) return false;
  if (state.lightbox?.entry) return false;
  const main = $('#main');
  if (main?.classList.contains('has-skeleton') || main?.classList.contains('skeleton-visible')) return false;
  return [...state.nodes.values()].some(node => node.isConnected);
}

function canForceFilterEntry(transition) {
  if (transition !== 'filter' || prefersReducedMotion() || !state.codex) return false;
  if (state.lightbox?.entry) return false;
  const main = $('#main');
  return !(main?.classList.contains('has-skeleton') || main?.classList.contains('skeleton-visible'));
}

function renderListNow({ resetScroll = false, forceEntry = false } = {}) {
  clearMasonry();
  if (resetScroll) window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  computeLayout();
  forceEntryAnim = Boolean(forceEntry);
  updateVirtualCards(true);
  forceEntryAnim = false;
  updateScrollProgress();
}

export function captureMasonryAnchor() {
  const m = $('#masonry');
  if (!m || !state.placements.length) return null;
  const mTop = m.getBoundingClientRect().top + window.scrollY;
  const viewportOffset = Math.min(window.innerHeight * 0.32, 240);
  const anchorY = Math.max(0, window.scrollY + viewportOffset - mTop);
  const placement = state.placements.find(p => p.top + p.height >= anchorY) || state.placements[0];
  if (!placement) return null;
  return {
    entryId: placement.entry.id,
    offset: clamp(anchorY - placement.top, 0, Math.max(0, placement.height - 1)),
    viewportOffset,
  };
}

export function restoreMasonryAnchor(anchor) {
  if (!anchor) return;
  const m = $('#masonry');
  const placement = state.placements.find(p => p.entry.id === anchor.entryId);
  if (!m || !placement) return;
  const mTop = m.getBoundingClientRect().top + window.scrollY;
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const nextTop = mTop + placement.top + Math.min(anchor.offset, Math.max(0, placement.height - 1)) - anchor.viewportOffset;
  window.scrollTo({ top: clamp(nextTop, 0, maxScroll), left: 0, behavior: 'auto' });
}

/* ---------------- 虚拟瀑布流 ---------------- */
export function colCount() {
  const w = $('#masonry').clientWidth || $('#main').clientWidth;
  const cfg = densityConfig();
  return Math.max(1, Math.floor((w + cfg.gap) / (cfg.minWidth + cfg.gap)));
}

export function clearMasonry() {
  cleanupFilterTransition();
  for (const node of state.nodes.values()) cleanupCard(node);
  state.nodes.clear();
  state.placements = [];
  state.rendered = 0;
  const m = $('#masonry');
  if (m) {
    relayoutAnimating = false;
    clearTimeout(relayoutAnimTimer);
    m.classList.remove('is-relayouting', 'is-filtering');
    m.innerHTML = '';
    m.style.height = '0px';
  }
}

export function renderList({ resetScroll = false, transition = 'none' } = {}) {
  const m = $('#masonry');
  const shouldTransition = canRunFilterTransition(m, transition);
  const seq = ++filterTransitionSeq;
  cleanupFilterTransition(m);

  if (!shouldTransition) {
    renderListNow({ resetScroll, forceEntry: canForceFilterEntry(transition) });
    return;
  }

  if (!isNearFilterTop()) {
    renderListNow({ resetScroll, forceEntry: true });
    return;
  }

  const nodes = [...state.nodes.values()].filter(node => node.isConnected);
  if (!nodes.length) {
    renderListNow({ resetScroll, forceEntry: true });
    return;
  }

  m.classList.add('is-filtering');
  let maxDelay = 0;
  for (const node of nodes) {
    const index = Number(node.dataset.index || 0);
    const placement = state.placements[index];
    const col = placement?.col || 0;
    const delay = Math.min(90, col * 18 + (index % Math.max(1, state.colN)) * 6);
    maxDelay = Math.max(maxDelay, delay);
    node.style.setProperty('--filter-delay', `${delay}ms`);
    node.classList.add('card-leaving');
  }

  filterTransitionTimer = window.setTimeout(() => {
    filterTransitionTimer = 0;
    if (seq !== filterTransitionSeq) return;
    m.classList.remove('is-filtering');
    renderListNow({ resetScroll, forceEntry: true });
  }, maxDelay + FILTER_EXIT_MS + FILTER_EXIT_PAD_MS);
}

export function computeLayout() {
  const m = $('#masonry');
  const width = Math.max(1, m.clientWidth || $('#main').clientWidth || 1);
  const cfg = densityConfig();
  const n = colCount();
  const itemWidth = Math.max(180, Math.floor((width - cfg.gap * (n - 1)) / n));
  const colHeights = Array.from({ length: n }, () => 0);
  const placements = [];

  for (let i = 0; i < state.list.length; i++) {
    const entry = state.list[i];
    const col = shortestIndex(colHeights);
    const imageHeight = estimateImageHeight(entry, itemWidth);
    const body = estimateBodyMetrics(entry, itemWidth);
    const height = Math.ceil(imageHeight + body.height);
    const left = col * (itemWidth + cfg.gap);
    const top = colHeights[col];

    placements.push({
      index: i,
      entry,
      col,
      left,
      top,
      width: itemWidth,
      height,
      imageHeight,
      tagsHeight: body.tagsHeight,
    });
    colHeights[col] += height + cfg.gap;
  }

  state.placements = placements;
  state.colN = n;
  state.itemWidth = itemWidth;
  const totalHeight = placements.length ? Math.max(...colHeights) - cfg.gap : 0;
  m.style.height = `${Math.max(0, Math.ceil(totalHeight))}px`;
}

export function shortestIndex(values) {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[best]) best = i;
  }
  return best;
}

export function estimateImageHeight(e, width) {
  if (!hasEntryImage(e)) return 0;
  const iw = Number(e.imageWidth || e.width || e.thumbWidth);
  const ih = Number(e.imageHeight || e.height || e.thumbHeight);
  const ratio = iw > 0 && ih > 0 ? ih / iw : DEFAULT_IMAGE_RATIO;
  return Math.round(width * clamp(ratio, 0.55, 1.9));
}

/* 估高是 computeLayout 的热点：每次搜索/筛选都要对**全部命中条目**跑一遍，而 textUnits 是逐字符正则。
   实测（桌面 Node）5546 条约 17ms、11084 条约 37ms、全站搜索合并 29078 条约 94ms，中端手机再乘 4~6 倍——
   正好对上 RUM 里 #search 键盘输入 INP P75 528ms。而虚拟滚动只渲染约 20 张卡，算出来的绝大多数当场丢弃。
   同一条目在宽度/密度不变时结果恒定，按 entry 缓存即可（沿用 search.js searchableTextCache 的套路）。
   ⚠ 返回的是共享对象，调用方只读不改；本地编辑改词条后要调 invalidateBodyMetrics。 */
const bodyMetricsCache = new WeakMap();

export function invalidateBodyMetrics(e) {
  return e && typeof e === 'object' ? bodyMetricsCache.delete(e) : false;
}

export function estimateBodyMetrics(e, width) {
  const cached = bodyMetricsCache.get(e);
  if (cached && cached.width === width && cached.density === state.density) return cached.value;
  const cfg = densityConfig();
  const contentWidth = Math.max(120, width - cfg.bodyPadX * 2);
  const titleLines = clamp(Math.ceil(textUnits(e.title) / Math.max(8, Math.floor(contentWidth / cfg.titleCharWidth))), 1, 2);
  const tagLines = estimateTagLines(entryPromptText(e), contentWidth, cfg);
  const titleHeight = titleLines * cfg.titleLineHeight;
  const tagsHeight = clamp(tagLines * cfg.tagLineHeight + cfg.tagPaddingY, cfg.minTagHeight, cfg.maxTagHeight);
  const footHeight = e.negative ? cfg.footHeightNegative : cfg.footHeight;
  const value = {
    height: Math.ceil(cfg.bodyPadTop + titleHeight + cfg.titleGap + tagsHeight + cfg.footGap + footHeight + cfg.bodyPadBottom),
    tagsHeight,
  };
  bodyMetricsCache.set(e, { width, density: state.density, value });
  return value;
}

export function estimateTagLines(text, width, cfg = densityConfig()) {
  const perLine = Math.max(18, Math.floor(width / cfg.tagCharWidth));
  const lines = String(text || '').split(/\n+/).reduce((sum, line) => {
    return sum + Math.max(1, Math.ceil(textUnits(line) / perLine));
  }, 0);
  return clamp(lines, 1, cfg.maxTagLines);
}

export function textUnits(text) {
  let units = 0;
  for (const ch of String(text || '')) units += /[\u4e00-\u9fff]/.test(ch) ? 2 : 1;
  return units;
}

let virtualRaf = 0;
/* 由 updateVirtualCards 每轮写入的真实可视带（masonry 内部坐标，不含虚拟缓冲）。 */
const visibleBand = { top: 0, bottom: 0 };

let relayoutTimer = 0;
let relayoutAnimTimer = 0;
let relayoutQueuedAnimate = false;
let relayoutAnimating = false;
let lastRelayoutAt = 0;
export function scheduleVirtualUpdate() {
  if (virtualRaf) return;
  virtualRaf = requestAnimationFrame(() => {
    virtualRaf = 0;
    updateVirtualCards();
  });
}

export function masonryViewport(m) {
  const rect = m.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const totalHeight = m.offsetHeight || parseFloat(m.style.height) || 0;
  const maxTop = Math.max(0, totalHeight - viewportHeight);
  const rawTop = -rect.top;
  return {
    rect,
    viewportHeight,
    rawTop,
    top: clamp(rawTop, 0, maxTop),
    /* top 继续作为虚拟化 overscan 的满视口锚点；真实可见带必须单独取
       viewport 与 masonry 的交集，否则 masonry 尚在页首控件下方时会把
       rect.top 那一段视口也误算成卡片区域。 */
    visibleTop: clamp(rawTop, 0, totalHeight),
    visibleBottom: clamp(rawTop + viewportHeight, 0, totalHeight),
  };
}

export function cardImageLoadPolicy(placement, band = visibleBand, columnCount = state.colN) {
  const eager = placement.top < band.bottom && placement.top + placement.height > band.top;
  return {
    eager,
    highPriority: eager && placement.index < Math.max(1, columnCount),
  };
}

export function applyCardImageLoadPolicy(node, placement, {
  band = visibleBand,
  columnCount = state.colN,
  promote = false,
} = {}) {
  const policy = cardImageLoadPolicy(placement, band, columnCount);
  const img = node?.querySelector?.('.card-img');
  if (!img) return policy;

  const loading = policy.eager ? 'eager' : 'lazy';
  if (img.loading !== loading) img.loading = loading;
  if (policy.highPriority) {
    if (img.getAttribute('fetchpriority') !== 'high') img.setAttribute('fetchpriority', 'high');
  } else {
    img.removeAttribute('fetchpriority');
  }

  /* overscan 内的节点可能先以 lazy + 90ms timer 建好，随后因滚动/转屏进入真实可视带。
     属性更新本身不会取消那道 timer；提升时直接认领并立即发出请求。已经开始的请求不做取消。 */
  if (promote && policy.eager && node._imageTimer && typeof node._loadImage === 'function') {
    clearTimeout(node._imageTimer);
    node._imageTimer = 0;
    node._loadImage();
  }
  return policy;
}

export function updateVirtualCards(force = false) {
  const m = $('#masonry');
  if (!m || !state.placements.length) {
    state.rendered = 0;
    updateReadingSpy();   // 无内容时收起目录浏览指示条
    return;
  }

  const view = masonryViewport(m);
  const viewportTop = view.top;
  const viewportHeight = view.viewportHeight;
  const rangeTop = Math.max(0, viewportTop - viewportHeight * VIRTUAL_BUFFER_UP);
  const rangeBottom = viewportTop + viewportHeight * (1 + VIRTUAL_BUFFER_DOWN);
  /* 真实可视带（不含虚拟缓冲）在这里存一份，给 setupImage 判首屏用：
     它本身就是这一轮唯一一次布局读取，卡片各自去量等于每张卡一次强制回流。 */
  visibleBand.top = view.visibleTop;
  visibleBand.bottom = view.visibleBottom;
  /* 虚拟缓冲区负责预建 DOM / 预载图，不等于用户已经看见。进场只在接近真实视口时触发，
     否则动画会在下方 1.4 屏白播，真正滚到时只剩终态。 */
  const entryMargin = Math.min(120, viewportHeight * 0.15);
  const entryTop = Math.max(0, viewportTop - entryMargin);
  const entryBottom = viewportTop + viewportHeight + entryMargin;
  const suppressThisBatch = suppressNextInitialEntryBatch;
  const next = new Set();
  const calibrations = [];

  for (const placement of state.placements) {
    if (placement.top + placement.height < rangeTop || placement.top > rangeBottom) continue;
    next.add(placement.index);
    let node = state.nodes.get(placement.index);
    if (!node) {
      node = makeCard(placement);
      node.dataset.entryPending = '1';
      state.nodes.set(placement.index, node);
      m.appendChild(node);
      if (!relayoutAnimating) calibrations.push({ node, placement });
    } else if (force) {
      updateCardPosition(node, placement);
      if (!relayoutAnimating) calibrations.push({ node, placement });
    }
    if (node._loadImage) applyCardImageLoadPolicy(node, placement, { promote: true });
    const nearViewport = placement.top + placement.height >= entryTop && placement.top <= entryBottom;
    if (node.dataset.entryPending === '1' && nearViewport) {
      delete node.dataset.entryPending;
      if (suppressThisBatch) {
        state.seenAnimated.add(`${state.codex.id}:${placement.entry.id}`);
        settleCardEntry(node, { immediate: true });
      } else {
        maybeAnimateCardEntry(node, placement);
      }
    }
  }
  if (suppressThisBatch && next.size) suppressNextInitialEntryBatch = false;

  /* 新卡先全部入 DOM，再统一写开标签高度、统一读取真实尺寸。这样一批卡
     只触发一次布局结算，后续位置修正也只需按列累计一次。 */
  const layoutChanged = calibrations.length && calibrateCardHeights(calibrations);

  for (const [index, node] of state.nodes) {
    if (next.has(index)) continue;
    if (force && relayoutAnimating) {
      const placement = state.placements[index];
      if (placement) updateCardPosition(node, placement);
      continue;
    }
    cleanupCard(node);
    node.remove();
    state.nodes.delete(index);
  }
  state.rendered = next.size;
  // 批量校准可能让缓冲区边缘的 placement 进出范围；下一帧按新位置收敛虚拟节点。
  if (layoutChanged) scheduleVirtualUpdate();
  updateReadingSpy();   // 借这里现成的 rAF 滚动节流驱动目录浏览指示条
}

export function makeCard(placement) {
  const e = placement.entry;
  const node = $('#cardTpl').content.firstElementChild.cloneNode(true);
  node.dataset.index = String(placement.index);
  updateCardPosition(node, placement);

  const highlightTerms = currentHighlightTerms();
  renderHighlightedText(node.querySelector('.card-title'), e.title, highlightTerms);
  renderHighlightedText(node.querySelector('.card-tags'), entryPromptText(e), highlightTerms);
  node.querySelector('.card-path').textContent = e.path.join(' › ');
  const hiddenMatch = hiddenSearchMatch(e, highlightTerms);
  const hiddenMatchChip = node.querySelector('.search-match-chip');
  if (hiddenMatchChip && hiddenMatch) {
    hiddenMatchChip.hidden = false;
    hiddenMatchChip.textContent = `命中：${hiddenMatch.label}`;
    hiddenMatchChip.title = hiddenMatch.excerpt;
  }
  if (e.isNew) node.querySelector('.badge-new').hidden = false;

  const hasImage = hasEntryImage(e);
  const hasNegative = !!(e.negative && String(e.negative).trim());
  const charPrompts = Array.isArray(e.characterPrompts) ? e.characterPrompts : [];
  const imageCount = entryImages(e).length;
  const negBadge = node.querySelector('.badge-neg');
  if (negBadge) negBadge.hidden = !(hasImage && hasNegative);
  const charTitle = charPrompts.length
    ? `含 ${charPrompts.length} 组角色词：${charPrompts.map(item => item.label).join(' / ')}`
    : '';
  const charBadge = node.querySelector('.badge-char');
  if (charBadge) {
    charBadge.hidden = !(hasImage && charPrompts.length);
    charBadge.title = charTitle;
  }
  const charChip = node.querySelector('.badge-char-chip');
  if (charChip) {
    charChip.hidden = hasImage || !charPrompts.length;
    charChip.title = charTitle;
  }
  const countBadge = node.querySelector('.badge-count');
  if (countBadge) {
    countBadge.hidden = imageCount <= 1;
    const count = countBadge.querySelector('.badge-count-n');
    if (count) count.textContent = String(imageCount);
  }
  const negChip = node.querySelector('.badge-neg-chip');
  if (negChip) negChip.hidden = hasImage || !hasNegative;

  const negBtn = node.querySelector('.copy-negative');
  if (negBtn) {
    negBtn.hidden = !e.negative;
    negBtn.onclick = ev => {
      ev.stopPropagation();
      copyText(e.negative, `已复制负面：${e.title}`, node, {
        sampleLabel: '已复制负面',
      });
    };
  }
  const allBtn = node.querySelector('.copy-all');
  if (allBtn) {
    allBtn.hidden = !e.negative && !charPrompts.length;
    allBtn.onclick = ev => {
      ev.stopPropagation();
      copyText(combinedPrompt(e), `已复制${combinedPromptLabel(e)}：${e.title}`, node);
    };
  }

  const fav = node.querySelector('.fav-btn');
  const faved = isFav(e);
  fav.textContent = faved ? '★' : '☆';
  fav.classList.toggle('on', faved);
  fav.title = faved ? '取消收藏' : '收藏';
  fav.setAttribute('aria-label', faved ? '取消收藏' : '收藏');
  fav.onclick = ev => { ev.stopPropagation(); masonryActions.toggleFav(e, fav); };

  const reportBtn = node.querySelector('.report-card-btn');
  if (reportBtn) {
    reportBtn.onclick = ev => {
      ev.stopPropagation();
      const imageError = Boolean(node.querySelector('.card-img-wrap')?.classList.contains('is-error'));
      masonryActions.reportEntry(e, {
        source: 'card',
        imageIndex: 0,
        imageError,
        defaultType: imageError ? 'image_error' : 'card_content',
        trigger: reportBtn,
      });
    };
  }

  if (hasImage) {
    setupImage(node, placement);
  } else {
    node.classList.add('no-img');
  }

  const packMode = state.codex?.type === 'pack' || e._srcType === 'pack';   // 收藏墙里的图包词条保持「点卡看图」行为
  const copyHint = node.querySelector('.copy-hint');
  if (copyHint && packMode) {
    copyHint.textContent = hasImage ? '点击查看' : '暂无图片';
    copyHint.classList.toggle('is-view', hasImage);
  }
  node.onclick = () => {
    if (packMode && hasImage) {
      const img = node.querySelector('.card-img');
      masonryActions.openLightbox(e, 0, img || null);
      return;
    }
    masonryActions.copyEntry(e, node);
  };
  return node;
}

export function updateCardPosition(node, placement) {
  node.style.width = `${placement.width}px`;
  node.style.height = `${placement.height}px`;
  node.style.setProperty('--card-x', `${placement.left}px`);
  node.style.setProperty('--card-y', `${placement.top}px`);
  if (!node.style.getPropertyValue('--entry-offset')) node.style.setProperty('--entry-offset', '0px');
  node.style.transform = 'translate3d(var(--card-x), calc(var(--card-y) + var(--entry-offset, 0px)), 0)';
  const wrap = node.querySelector('.card-img-wrap');
  if (wrap && placement.imageHeight) wrap.style.height = `${placement.imageHeight}px`;
  const tags = node.querySelector('.card-tags');
  if (tags) tags.style.height = `${placement.tagsHeight}px`;
}

/* 卡片进场 = 显影术：壳只做合成友好的位移/透明度，滤镜只落在图片层。
   原型页的 blur12→5→0 是一张小卡；把它放到真实瀑布流整卡上会连文字、阴影一起重栅格化，
   快速滚动时尤其容易掉帧。图片显影仍保留，但目标数和半径都收窄，避免「糊成一片」。 */
const ENTRY_WAVES = {
  intro: {
    lift: 6, dur: 220, ease: 'cubic-bezier(.16,1,.3,1)',
    imageBlur: 6, imageDur: 340, base: 30, step: 24, cap: 110, imageOffset: 30,
  },
  scroll: {
    lift: 6, dur: 220, ease: 'cubic-bezier(.16,1,.3,1)',
    imageBlur: 4, imageDur: 260, base: 0, step: 18, cap: 90, imageOffset: 0,
  },
};

/* 大图的滤镜预算按「列」而不是按固定张数分配：移动端一张图已经占掉大半屏，
   同时显影三张只是白做两层栅格化；桌面每列较窄，最多保留三列的焦点波。 */
function introFocusCount() {
  if (window.matchMedia('(max-width: 600px)').matches) return 1;
  return Math.min(3, Math.max(1, state.colN));
}

export function maybeAnimateCardEntry(node, placement) {
  if (prefersReducedMotion() || relayoutAnimating || !state.codex) return;
  // 急滑门控：滚得比阈值快时直接落终态。快速掠过的卡还去演一遍显影，只会糊成一片拖影
  if (isFlinging()) return;
  const key = `${state.codex.id}:${placement.entry.id}`;
  if (!forceEntryAnim && state.seenAnimated.has(key)) return;
  state.seenAnimated.add(key);

  const html = document.documentElement;
  /* 开场期间卡片是在幕布背后渲染的。进场走的是 CSS 过渡，过渡**没法像动画那样 paused**，
     所以这里只摆好起始态（抬起 + 透明，图片显影另行暂停），等 intro:reveal 掀幕那一刻再统一放行——
     不然开场结束掀开幕布，卡片早就自己演完了，只剩终态。 */
  const introHold = html.classList.contains('intro-run') && !html.classList.contains('intro-reveal');
  const wave = introHold || html.classList.contains('intro-reveal')
    ? ENTRY_WAVES.intro
    : ENTRY_WAVES.scroll;
  const stagger = placement.col * wave.step + (placement.index % Math.max(1, state.colN)) * 10;
  const delay = wave.base + Math.min(wave.cap, stagger);
  const imageDelay = Math.max(0, delay + (wave.imageOffset || 0));
  const imageBlur = wave === ENTRY_WAVES.intro && window.matchMedia('(max-width: 600px)').matches
    ? 5
    : wave.imageBlur;
  node.style.setProperty('--entry-offset', `${wave.lift}px`);
  node.style.setProperty('--entry-delay', `${delay}ms`);
  node.style.setProperty('--entry-image-delay', `${imageDelay}ms`);
  node.style.setProperty('--entry-dur', `${wave.dur}ms`);
  node.style.setProperty('--entry-image-blur', `${imageBlur}px`);
  node.style.setProperty('--entry-image-dur', `${wave.imageDur}ms`);
  node.style.setProperty('--entry-ease', wave.ease);
  const image = node.querySelector('.card-img');
  if (html.classList.contains('intro-run')) {
    /* 开场只挑首排一列（移动）/ 最多三列（桌面）做真正的显影，其他卡片保持轻量的壳动画。
       placement.index 比 nth-child 稳定，虚拟列表重插时不会把滤镜错给屏外卡。 */
    const focusCount = introFocusCount();
    const imageRank = hasEntryImage(placement.entry)
      ? state.placements.slice(0, placement.index)
        .filter(candidate => hasEntryImage(candidate.entry)).length
      : focusCount;
    if (imageRank < focusCount) {
      node.classList.add('intro-focus');
      image?.classList.add('card-img-diffusion');
    }
  } else if (hasEntryImage(placement.entry) && image?.classList.contains('is-loaded')) {
    /* 缓冲区预载命中时才做滚动显影；图片尚未回来就让既有 load settle 接管，
       避免动画迟到开跑后又被固定 cleanup 时刻截断。 */
    image?.classList.add('card-img-diffusion');
  }
  node.classList.add('card-enter');
  if (introHold) {
    introHeld.add(node);
    return;
  }
  releaseCardEntry(node, cleanupMsFor(wave, delay));
}

/* 清理要等到卡片壳与图片显影都跑完；intro 图片现在比壳晚 30ms，不能再只按壳的结束点算。 */
function cleanupMsFor(wave, delay) {
  const imageDelay = Math.max(0, delay + (wave.imageOffset || 0));
  return Math.max(delay + wave.dur, imageDelay + (wave.imageDur || 0)) + 180;
}

function releaseCardEntry(node, cleanupMs) {
  requestAnimationFrame(() => {
    if (!node.isConnected || !node.classList.contains('card-enter')) return;
    node.classList.add('is-entered');
    node.style.setProperty('--entry-offset', '0px');
  });
  window.setTimeout(() => settleCardEntry(node), cleanupMs);
}

function settleCardEntry(node, { immediate = false } = {}) {
  /* skip/late-settle 要真落终态：直接摘 card-enter 时会重新命中 .card 的 opacity .16s，
     从当前半透明值补播一小段淡入。先用 inline transition:none 结算一帧，再恢复基础规则。 */
  const previousTransition = node.style.transition;
  if (immediate) node.style.transition = 'none';
  node.classList.remove('card-enter', 'is-entered', 'intro-focus');
  for (const prop of ['--entry-delay', '--entry-image-delay', '--entry-dur', '--entry-image-blur', '--entry-image-dur', '--entry-ease']) {
    node.style.removeProperty(prop);
  }
  node.querySelector('.card-img')?.classList.remove('card-img-diffusion', 'intro-image-ready');
  node.style.setProperty('--entry-offset', '0px');
  introHeld.delete(node);
  if (immediate) {
    requestAnimationFrame(() => {
      if (previousTransition) node.style.transition = previousTransition;
      else node.style.removeProperty('transition');
    });
  }
}

/* 掀幕 → 把攒着的首屏卡片一次性放行；开场被跳过 → 直接落终态。
   ⚠ intro:settle 这条兜底不能省：用户在打字机阶段就点/滑走时没有掀幕事件，
   攒下的卡片会永远停在 opacity:0 + blur 的起始态（= 首屏空白）。 */
const introHeld = new Set();
if (typeof document !== 'undefined') {
  document.addEventListener('intro:reveal', () => {
    const cleanup = cleanupMsFor(ENTRY_WAVES.intro, ENTRY_WAVES.intro.base + ENTRY_WAVES.intro.cap);
    for (const node of introHeld) releaseCardEntry(node, cleanup);
    introHeld.clear();
  }, { once: true });
  document.addEventListener('intro:settle', event => {
    const active = new Set([...introHeld, ...document.querySelectorAll('.masonry .card.card-enter')]);
    for (const node of active) settleCardEntry(node, { immediate: true });
    introHeld.clear();
    /* 用户在数据回来前就跳过：下一次首次虚拟批次必须直接终态，不能被当成 scroll wave
       给整个 2.4 屏缓冲区重新挂 blur。屏外 pending 卡之后靠近视口仍可正常播放。 */
    if (event.detail?.skipped && !state.nodes.size) suppressNextInitialEntryBatch = true;
  });
}

/* 急滑判定：采两次滚动位置算瞬时速度，超过 3.5px/ms（≈3500px/s）就算「在甩」，跳过进场直接落终态。
   阈值刻意留高：正常阅读式滚动约 0.5–1.5px/ms、快速滚轮约 2–3px/ms，都应该照常显影；
   只有真甩起来（以及 scrollTo 瞬移）才门控——那时候每张卡都演一遍只会糊成拖影。
   ⚠ 一批渲染里共用一次采样：按张采样的话批内第一张 dt 正常、其余 dt≈0 判成静止，
   同一批卡会一半有进场一半没有，参差得很明显。 */
let flingLastY = 0;
let flingLastT = 0;
let flingOn = false;
let flingSampledAt = -1;
const FLING_PX_PER_MS = 3.5;

function isFlinging() {
  const now = performance.now();
  if (now - flingSampledAt < 16) return flingOn;
  flingSampledAt = now;
  const y = window.scrollY;
  const dt = now - flingLastT;
  flingOn = dt > 0 && dt < 260 && Math.abs(y - flingLastY) / dt > FLING_PX_PER_MS;
  flingLastY = y;
  flingLastT = now;
  return flingOn;
}

export function calibrateCardHeight(node, placement) {
  calibrateCardHeights([{ node, placement }]);
}

export function calibrateCardHeights(cards) {
  const cfg = densityConfig();
  const prepared = [];
  for (const card of cards || []) {
    if (!card?.node || !card?.placement) continue;
    prepared.push({
      ...card,
      tags: card.node.querySelector('.card-tags'),
      wrap: card.node.querySelector('.card-img-wrap'),
      body: card.node.querySelector('.card-body'),
    });
  }

  // 写阶段 1：先让整批标签恢复自然高度，中间不穿插任何尺寸读取。
  for (const card of prepared) {
    if (card.tags) card.tags.style.height = 'auto';
  }

  // 读阶段：第一张卡会结算上面的整批写入，随后读取不再反复弄脏布局。
  const measurements = prepared.map(card => {
    const naturalTagsHeight = card.tags ? Math.ceil(card.tags.scrollHeight) : 0;
    const naturalTagsBoxHeight = card.tags ? card.tags.getBoundingClientRect().height : 0;
    const tagsHeight = card.tags
      ? clamp(naturalTagsHeight, cfg.minTagHeight, cfg.maxTagHeight)
      : card.placement.tagsHeight;
    const imageHeight = card.wrap && !card.wrap.hidden && getComputedStyle(card.wrap).display !== 'none'
      ? card.wrap.getBoundingClientRect().height
      : 0;
    const naturalBodyHeight = card.body ? card.body.getBoundingClientRect().height : 0;
    // body 是在 tags:auto 时读取的；扣掉自然标签盒、加回钳制后的盒高，
    // 即可保持旧版“先钳制标签再量 body”的结果，又不引入第二轮布局读取。
    const bodyHeight = card.tags
      ? Math.max(0, naturalBodyHeight - naturalTagsBoxHeight + tagsHeight)
      : naturalBodyHeight;
    return {
      ...card,
      naturalTagsHeight,
      tagsHeight,
      measuredHeight: Math.ceil(imageHeight + bodyHeight),
    };
  });

  // 写阶段 2：统一落标签高度，再一次性修正各列后续 placement。
  const heightChanges = [];
  for (const measurement of measurements) {
    const { tags, placement, naturalTagsHeight, tagsHeight, measuredHeight } = measurement;
    if (tags) {
      tags.style.height = `${tagsHeight}px`;
      tags.classList.toggle('is-clipped', naturalTagsHeight > tagsHeight + 1);
      placement.tagsHeight = tagsHeight;
    }
    if (measuredHeight > 0 && Math.abs(measuredHeight - placement.height) > 2) {
      heightChanges.push({ placement, nextHeight: measuredHeight });
    }
  }
  return applyCardHeightChanges(heightChanges);
}

export function shiftColumnAfterHeightChange(placement, nextHeight) {
  return applyCardHeightChanges([{ placement, nextHeight }]);
}

export function applyCardHeightChanges(changes) {
  if (!changes?.length) return false;
  const nextHeights = new Map();
  for (const { placement, nextHeight } of changes) {
    if (placement && Number.isFinite(nextHeight)) nextHeights.set(placement, nextHeight);
  }
  if (!nextHeights.size) return false;

  const columnDeltas = [];
  let changed = false;
  for (const placement of state.placements) {
    const col = placement.col;
    const shift = columnDeltas[col] || 0;
    let positionChanged = false;
    if (shift) {
      placement.top += shift;
      positionChanged = true;
    }

    const nextHeight = nextHeights.get(placement);
    if (nextHeight !== undefined) {
      const delta = nextHeight - placement.height;
      if (delta) {
        placement.height = nextHeight;
        columnDeltas[col] = shift + delta;
        positionChanged = true;
        changed = true;
      }
    }

    const node = positionChanged ? state.nodes.get(placement.index) : null;
    if (node) updateCardPosition(node, placement);
  }
  if (changed) syncMasonryHeight();
  return changed;
}

export function syncMasonryHeight() {
  const m = $('#masonry');
  if (!m || !state.placements.length) return;
  let totalHeight = 0;
  for (const placement of state.placements) {
    totalHeight = Math.max(totalHeight, placement.top + placement.height);
  }
  m.style.height = `${Math.max(0, Math.ceil(totalHeight))}px`;
}

export function setupImage(node, placement) {
  const e = placement.entry;
  const wrap = node.querySelector('.card-img-wrap');
  const img = node.querySelector('.card-img');
  const retryBtn = node.querySelector('.img-retry');
  const url = thumbUrl(e);
  const key = imageKey(e, url);

  wrap.hidden = false;
  wrap.style.height = `${placement.imageHeight}px`;
  img.alt = e.title;

  const markLoading = () => {
    wrap.classList.add('is-loading');
    wrap.classList.remove('is-error');
    img.classList.remove('is-loaded');
    if (retryBtn) retryBtn.hidden = true;
  };
  const markLoaded = () => {
    state.loadedImages.add(key);
    wrap.classList.remove('is-loading', 'is-error');
    img.classList.add('is-loaded');
    if (retryBtn) retryBtn.hidden = true;
  };
  const markError = () => {
    wrap.classList.remove('is-loading');
    wrap.classList.add('is-error');
    if (retryBtn) retryBtn.hidden = false;
    notifyImageLoadError(e);
  };
  const load = (retry = false) => {
    node._imageTimer = 0;
    markLoading();
    if (retry) {
      img.dataset.fallbackTried = '';
      state.loadedImages.delete(key);
    }
    img.src = retry ? cacheBustUrl(url) : url;
  };
  node._loadImage = load;

  img.onload = markLoaded;
  img.onerror = () => {
    const fallback = localAssetUrl('image', e);
    if (fallback && fallback !== img.src && img.dataset.fallbackTried !== '1') {
      img.dataset.fallbackTried = '1';
      img.src = fallback;
      return;
    }
    markError();
  };

  /* 首屏图就是 LCP 元素：模板默认的 loading="lazy" 会降优先级并要等布局定完，
     后面的 90ms 错峰定时器又把 src 再推一拍。RUM 实测 #masonry 卡片图 P75 7108ms，
     代码链路也确认图片要等模块、数据与布局完成后才发现；FCP/LCP 不同分位数不能直接相减归因。
     可视带内的卡改成即时加载、第一行再抢 fetchpriority=high；带外维持 lazy + 错峰，
     否则近万卡的图会一次性铺满带宽，反而拖慢首屏那几张。 */
  // computeLayout 按最短列排布，前 colN 个 placement 恰好是第一行。
  const imagePolicy = applyCardImageLoadPolicy(node, placement);

  markLoading();
  if (state.loadedImages.has(key) || imagePolicy.eager) load();
  else node._imageTimer = window.setTimeout(load, IMAGE_LOAD_DELAY);

  if (retryBtn) {
    retryBtn.onclick = ev => {
      ev.stopPropagation();
      load(true);
    };
  }
  wrap.querySelector('.zoom-btn').onclick = ev => {
    ev.stopPropagation();
    masonryActions.openLightbox(e, 0, wrap.querySelector('.card-img'));
  };
}

export function notifyImageLoadError(e) {
  const key = `image:${state.codex?.id || ''}`;
  if (state.sourceNoticesShown.has(key)) return;
  state.sourceNoticesShown.add(key);
  toast(`有图片加载失败，可在卡片上点击重试：${e.title}`);
}

export function cleanupCard(node) {
  if (node._imageTimer) {
    clearTimeout(node._imageTimer);
    node._imageTimer = 0;
  }
  node._loadImage = null;
  const img = node.querySelector('.card-img');
  if (!img) return;
  const wrap = node.querySelector('.card-img-wrap');
  img.onload = null;
  img.onerror = null;
  if (wrap?.classList.contains('is-loading')) img.removeAttribute('src');
}

export function imageKey(e, url) {
  return `${state.codex.id}:${e.id}:${e.assetRev || ''}:${url}`;
}

export function scheduleRelayout(animate = true) {
  relayoutQueuedAnimate = relayoutQueuedAnimate || animate;
  if (relayoutTimer) return;
  const now = performance.now();
  const delay = Math.max(0, RELAYOUT_INTERVAL - (now - lastRelayoutAt));
  relayoutTimer = window.setTimeout(() => {
    relayoutTimer = 0;
    lastRelayoutAt = performance.now();
    relayoutVisible({ animate: relayoutQueuedAnimate });
    relayoutQueuedAnimate = false;
  }, delay);
}

export function startRelayoutAnimation() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const m = $('#masonry');
  if (!m) return;
  relayoutAnimating = true;
  m.classList.add('is-relayouting');
  // Make sure the transition class is active before the new transforms land.
  void m.offsetWidth;
  clearTimeout(relayoutAnimTimer);
  relayoutAnimTimer = window.setTimeout(() => {
    relayoutAnimating = false;
    m.classList.remove('is-relayouting');
    updateVirtualCards(true);
  }, RELAYOUT_ANIM_MS + 80);
}

export function relayoutVisible({ animate = false } = {}) {
  if (!state.codex) return;
  if (animate) startRelayoutAnimation();
  computeLayout();
  updateVirtualCards(true);
}
