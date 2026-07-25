import { state, VIRTUAL_BUFFER_UP, VIRTUAL_BUFFER_DOWN, IMAGE_LOAD_DELAY, RELAYOUT_INTERVAL, RELAYOUT_ANIM_MS, DEFAULT_IMAGE_RATIO } from './state.js';
import { densityConfig } from './state.js';
import { $, clamp, prefersReducedMotion, updateScrollProgress } from './utils.js';
import { toast } from './feedback.js';
import { currentHighlightTerms, renderHighlightedText } from './search.js';
import { hasEntryImage, entryImages, thumbUrl, localAssetUrl, cacheBustUrl } from './media.js';
import { copyText, combinedPrompt } from './copy.js';
import { isFav } from './favorites.js';
import { updateResultBar, updateEmptyState, updateReadingSpy } from './codex-ui.js';

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

export function estimateBodyMetrics(e, width) {
  const cfg = densityConfig();
  const contentWidth = Math.max(120, width - cfg.bodyPadX * 2);
  const titleLines = clamp(Math.ceil(textUnits(e.title) / Math.max(8, Math.floor(contentWidth / cfg.titleCharWidth))), 1, 2);
  const tagLines = estimateTagLines(e.tags, contentWidth, cfg);
  const titleHeight = titleLines * cfg.titleLineHeight;
  const tagsHeight = clamp(tagLines * cfg.tagLineHeight + cfg.tagPaddingY, cfg.minTagHeight, cfg.maxTagHeight);
  const footHeight = e.negative ? cfg.footHeightNegative : cfg.footHeight;
  return {
    height: Math.ceil(cfg.bodyPadTop + titleHeight + cfg.titleGap + tagsHeight + cfg.footGap + footHeight + cfg.bodyPadBottom),
    tagsHeight,
  };
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
  };
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
  const next = new Set();

  for (const placement of state.placements) {
    if (placement.top + placement.height < rangeTop || placement.top > rangeBottom) continue;
    next.add(placement.index);
    let node = state.nodes.get(placement.index);
    if (!node) {
      node = makeCard(placement);
      state.nodes.set(placement.index, node);
      m.appendChild(node);
      if (!relayoutAnimating) calibrateCardHeight(node, placement);
    } else if (force) {
      updateCardPosition(node, placement);
      if (!relayoutAnimating) calibrateCardHeight(node, placement);
    }
  }

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
  updateReadingSpy();   // 借这里现成的 rAF 滚动节流驱动目录浏览指示条
}

export function makeCard(placement) {
  const e = placement.entry;
  const node = $('#cardTpl').content.firstElementChild.cloneNode(true);
  node.dataset.index = String(placement.index);
  updateCardPosition(node, placement);

  node.querySelector('.card-title').textContent = e.title;
  renderHighlightedText(node.querySelector('.card-tags'), e.tags, currentHighlightTerms());
  node.querySelector('.card-path').textContent = e.path.join(' › ');
  if (e.isNew) node.querySelector('.badge-new').hidden = false;

  const hasImage = hasEntryImage(e);
  const hasNegative = !!(e.negative && String(e.negative).trim());
  const imageCount = entryImages(e).length;
  const negBadge = node.querySelector('.badge-neg');
  if (negBadge) negBadge.hidden = !(hasImage && hasNegative);
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
    negBtn.onclick = ev => { ev.stopPropagation(); copyText(e.negative, `已复制负面：${e.title}`, node); };
  }
  const allBtn = node.querySelector('.copy-all');
  if (allBtn) {
    allBtn.hidden = !e.negative;
    allBtn.onclick = ev => { ev.stopPropagation(); copyText(combinedPrompt(e), `已复制正向+负面：${e.title}`, node); };
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
  if (copyHint && packMode) copyHint.textContent = hasImage ? '🔍 点击查看' : '暂无图片';
  node.onclick = () => {
    if (packMode && hasImage) {
      const img = node.querySelector('.card-img');
      masonryActions.openLightbox(e, 0, img || null);
      return;
    }
    masonryActions.copyEntry(e, node);
  };
  maybeAnimateCardEntry(node, placement);
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

export function maybeAnimateCardEntry(node, placement) {
  if (prefersReducedMotion() || relayoutAnimating || !state.codex) return;
  const key = `${state.codex.id}:${placement.entry.id}`;
  if (!forceEntryAnim && state.seenAnimated.has(key)) return;
  state.seenAnimated.add(key);

  const delay = Math.min(210, placement.col * 30 + (placement.index % Math.max(1, state.colN)) * 10);
  node.style.setProperty('--entry-offset', '18px');
  node.style.setProperty('--entry-delay', `${delay}ms`);
  node.classList.add('card-enter');
  requestAnimationFrame(() => {
    if (!node.isConnected) return;
    node.classList.add('is-entered');
    node.style.setProperty('--entry-offset', '0px');
  });
  window.setTimeout(() => {
    node.classList.remove('card-enter', 'is-entered');
    node.style.removeProperty('--entry-delay');
  }, delay + 560);
}

export function calibrateCardHeight(node, placement) {
  const tags = node.querySelector('.card-tags');
  if (tags) {
    const cfg = densityConfig();
    tags.style.height = 'auto';
    const naturalTagsHeight = Math.ceil(tags.scrollHeight);
    const tagsHeight = clamp(naturalTagsHeight, cfg.minTagHeight, cfg.maxTagHeight);
    tags.style.height = `${tagsHeight}px`;
    tags.classList.toggle('is-clipped', naturalTagsHeight > tagsHeight + 1);
    placement.tagsHeight = tagsHeight;
  }

  const wrap = node.querySelector('.card-img-wrap');
  const body = node.querySelector('.card-body');
  const imageHeight = wrap && !wrap.hidden && getComputedStyle(wrap).display !== 'none'
    ? wrap.getBoundingClientRect().height
    : 0;
  const bodyHeight = body ? body.getBoundingClientRect().height : 0;
  const measuredHeight = Math.ceil(imageHeight + bodyHeight);
  if (measuredHeight > 0 && Math.abs(measuredHeight - placement.height) > 2) {
    shiftColumnAfterHeightChange(placement, measuredHeight);
  }
}

export function shiftColumnAfterHeightChange(placement, nextHeight) {
  const delta = nextHeight - placement.height;
  placement.height = nextHeight;
  const currentNode = state.nodes.get(placement.index);
  if (currentNode) currentNode.style.height = `${placement.height}px`;

  for (const next of state.placements) {
    if (next === placement || next.col !== placement.col || next.top <= placement.top) continue;
    next.top += delta;
    const node = state.nodes.get(next.index);
    if (node) updateCardPosition(node, next);
  }
  syncMasonryHeight();
}

export function syncMasonryHeight() {
  const m = $('#masonry');
  if (!m || !state.placements.length) return;
  const totalHeight = Math.max(...state.placements.map(p => p.top + p.height));
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

  markLoading();
  if (state.loadedImages.has(key)) load();
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
