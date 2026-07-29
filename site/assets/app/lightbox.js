import { state } from './state.js';
import { $, clamp, esc, isTouchPrimaryInput, prefersReducedMotion, safeHttpUrl } from './utils.js';
import { notifyImageLoadError } from './masonry.js';
import { renderHighlightedText, currentHighlightTerms } from './search.js';
import { copyText, combinedPrompt } from './copy.js';
import { naiToSd } from './nai-sd.js';
import { recordRecentEntry } from './history.js';
import { syncUrlState } from './router.js';
import { findCodexMeta } from './data.js';
import { entryImages, hasEntryImage, imageItemUrl } from './media.js';
import {
  entryImageCanUseOriginal,
  entrySourceAllowsOriginal,
  entrySourceCodexId,
} from './original-capability.js';
import { isEntryAccessBlocked, isR18gBlocked, showNsfwLockedHint, showR18gLockedHint } from './access.js';
import { openReportDialog } from './report.js';
import { goBackFrom } from './browser-history.js';
import {
  flushDeferredFavoritesViewRefresh,
  isFav,
  setFavoriteButtonState,
  toggleFav,
} from './favorites.js';

/* ---------------- 灯箱（沉浸浮影 + 原位展开） ---------------- */
let lbSeq = 0;
let lbCloseTimer = 0;
let lbSourceImg = null;
let lbFocusReturn = null;
let lbThumbEntry = null;
let lbThumbImages = null;
let lbThumbState = null;
let lbOriginalStatusTimer = 0;
let lbRecentTimer = 0;
const lbPreloadCache = new Map();
const LB_PRELOAD_CACHE_LIMIT = 300;

export function setLightboxScrollLocked(locked) {
  document.documentElement?.classList?.toggle('lightbox-open', Boolean(locked));
  document.body?.classList?.toggle('lightbox-open', Boolean(locked));
}

function clearLightboxEntryTimers() {
  clearTimeout(lbOriginalStatusTimer);
  clearTimeout(lbRecentTimer);
  lbOriginalStatusTimer = 0;
  lbRecentTimer = 0;
}

function scheduleRecentEntry(entry) {
  clearTimeout(lbRecentTimer);
  lbRecentTimer = window.setTimeout(() => {
    lbRecentTimer = 0;
    if (state.lightbox.entry === entry) recordRecentEntry(entry);
  }, 1000);
}

function lightboxEntrySourceId(entry) {
  return entrySourceCodexId(entry);
}

function sameLightboxEntry(a, b) {
  return Boolean(a && b && a.id === b.id && lightboxEntrySourceId(a) === lightboxEntrySourceId(b));
}

export function lightboxNavigationContext(entry = state.lightbox.entry, list = state.list) {
  if (!entry || !Array.isArray(list)) {
    return { entries: [], index: -1, position: 0, total: 0 };
  }
  const entries = [];
  let exactIndex = -1;
  let equivalentIndex = -1;
  for (const candidate of list) {
    if (!hasEntryImage(candidate) || isEntryAccessBlocked(candidate)) continue;
    const index = entries.length;
    entries.push(candidate);
    if (candidate === entry) exactIndex = index;
    else if (equivalentIndex < 0 && sameLightboxEntry(candidate, entry)) equivalentIndex = index;
  }
  const index = exactIndex >= 0 ? exactIndex : equivalentIndex;
  if (index < 0) return { entries: [], index: -1, position: 0, total: 0 };
  return { entries, index, position: index + 1, total: entries.length };
}

export function getLightboxStepTarget(
  delta,
  lightbox = state.lightbox,
  list = state.list,
  navigation = null,
) {
  const direction = Math.sign(Number(delta) || 0);
  const entry = lightbox?.entry;
  const images = Array.isArray(lightbox?.images) ? lightbox.images : [];
  if (!direction || !entry || !images.length) return null;
  if (direction > 0 && lightbox.index < images.length - 1) {
    return { entry, images, index: lightbox.index + 1, crossEntry: false };
  }
  if (direction < 0 && lightbox.index > 0) {
    return { entry, images, index: lightbox.index - 1, crossEntry: false };
  }
  const nav = navigation || lightboxNavigationContext(entry, list);
  if (nav.index < 0) {
    if (images.length < 2) return null;
    return {
      entry,
      images,
      index: direction > 0 ? 0 : images.length - 1,
      crossEntry: false,
    };
  }
  if (nav.entries.length < 2) {
    if (images.length < 2) return null;
    return {
      entry,
      images,
      index: direction > 0 ? 0 : images.length - 1,
      crossEntry: false,
    };
  }
  const nextIndex = (nav.index + direction + nav.entries.length) % nav.entries.length;
  const nextEntry = nav.entries[nextIndex];
  const nextImages = entryImages(nextEntry);
  if (!nextImages.length) return null;
  return {
    entry: nextEntry,
    images: nextImages,
    index: direction > 0 ? 0 : nextImages.length - 1,
    crossEntry: true,
  };
}

export function canUseNativeShare(
  nav = globalThis.navigator,
  matchMedia = globalThis.window?.matchMedia?.bind(globalThis.window),
) {
  const touchDevice = isTouchPrimaryInput({ navigatorApi: nav, matchMediaApi: matchMedia });
  return touchDevice && typeof nav?.share === 'function';
}

function sourceSupportsReadableOriginal(entry) {
  return entrySourceAllowsOriginal(entry);
}

function lightboxItemHasOriginal(entry, item) {
  return entryImageCanUseOriginal(entry, item);
}


export function applyFlyRect(el, rect, radius) {
  el.style.left = rect.left + 'px';
  el.style.top = rect.top + 'px';
  el.style.width = rect.width + 'px';
  el.style.height = rect.height + 'px';
  el.style.borderRadius = radius + 'px';
}

export function makeFlyClone(src, rect) {
  const clone = document.createElement('img');
  clone.className = 'lb-fly';
  clone.alt = '';
  clone.decoding = 'sync';
  clone.loading = 'eager';
  clone.src = src;
  applyFlyRect(clone, rect, 14);
  document.body.appendChild(clone);
  void clone.offsetWidth;
  return clone;
}

export function clearFlyClones() {
  document.querySelectorAll('.lb-fly').forEach(n => n.remove());
}

export function removeFlyCloneAfterPaint(clone) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => clone.remove());
  });
}

export function fitStageRect(ratio) {
  const box = $('#lightboxStage').getBoundingClientRect();
  if (!box.width || !box.height) return { left: 0, top: 0, width: 0, height: 0 };
  let w = box.width;
  let h = ratio > 0 ? w / ratio : box.height;
  if (h > box.height) {
    h = box.height;
    w = h * ratio;
  }
  return {
    left: box.left + (box.width - w) / 2,
    top: box.top + (box.height - h) / 2,
    width: w,
    height: h,
  };
}

export function resolvedUrl(url) {
  if (!url) return '';
  try {
    return new URL(url, location.href).href;
  } catch {
    return String(url);
  }
}

function canonicalShareEntryId(entry, meta, sourceId) {
  const entryId = String(entry?.id || '').trim();
  if (!entryId) return '';
  for (const alias of [sourceId, ...(meta?.aliases || [])].filter(Boolean)) {
    if (alias !== meta.id && entryId.startsWith(`${alias}-`)) {
      return meta.id + entryId.slice(alias.length);
    }
  }
  return entryId;
}

function shareUrlForEntry(entry) {
  if (!entry?.id) return '';
  const isVirtual = state.favoritesView || state.siteSearchView;
  const sourceId = isVirtual ? entry._srcCodexId : (entry._srcCodexId || state.codex?.id);
  if (!sourceId) return '';
  const meta = findCodexMeta(sourceId);
  if (!meta?.id) return '';
  const entryId = canonicalShareEntryId(entry, meta, sourceId);
  if (!entryId) return '';
  return `${location.origin}/share/${encodeURIComponent(meta.id)}/${encodeURIComponent(entryId)}`;
}

export function flyIn(sourceEl) {
  const lb = $('#lightbox');
  const from = sourceEl.getBoundingClientRect();
  if (!from.width || !from.height) return;
  const ratio = sourceEl.naturalWidth / sourceEl.naturalHeight;
  const targetEl = $('#lightboxImg');
  const renderedTarget = targetEl?.getBoundingClientRect();
  const target = renderedTarget?.width && renderedTarget?.height ? renderedTarget : fitStageRect(ratio);
  if (!target.width) return;
  lb.classList.add('flying');
  const clone = makeFlyClone(sourceEl.currentSrc || sourceEl.src, from);
  requestAnimationFrame(() => applyFlyRect(clone, target, 14));
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    lb.classList.remove('flying');
    removeFlyCloneAfterPaint(clone);
  };
  clone.addEventListener('transitionend', finish, { once: true });
  window.setTimeout(finish, 480);
}

export function openLightbox(entry, index = 0, sourceEl = null, options = {}) {
  const parentScrollY = Math.max(0, window.scrollY || 0);
  if (isR18gBlocked(entry)) { showR18gLockedHint(); return; }  // 深链/最近记录等绕过路径的兜底拦截
  if (isEntryAccessBlocked(entry)) { showNsfwLockedHint(); return; }
  const sourceImages = entryImages(entry);
  const images = sourceImages.length
    ? sourceImages
    : (options.allowEmpty ? [{ _editPlaceholder: true }] : []);
  if (!images.length) return;
  clearLightboxEntryTimers();
  if (options.recordRecent !== false) recordRecentEntry(entry);
  state.lightbox = {
    entry,
    images,
    index: clamp(index, 0, images.length - 1),
  };
  /* Commit before rendering: thumbnail scrollIntoView/focus work inside the fixed
     overlay and may move the document, but the parent list record must retain
     the exact pre-detail scroll position. */
  syncUrlState({
    entry: entry.id,
    historyMode: options.historyMode || 'push',
    transition: 'detail',
    consumeLayer: Boolean(options.consumeLayer),
    parentScrollY,
  });
  lbSourceImg = sourceEl && sourceEl.tagName === 'IMG' ? sourceEl : null;
  const lb = $('#lightbox');
  clearTimeout(lbCloseTimer);
  clearFlyClones();
  lb.classList.remove('flying');
  lb.classList.toggle('folded', localStorage.getItem('fadian-lbinfo') === 'folded');
  lb.classList.toggle('has-thumbs', images.length > 1);
  lb.hidden = false;
  try {
    renderLightbox();
  } catch (err) {
    console.error('[lightbox] 渲染失败，回退关闭以免整页卡死', err);
    closeLightbox();
    return;
  }
  setLightboxScrollLocked(true);
  void lb.offsetWidth;
  lb.classList.add('is-open');
  lbFocusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  window.setTimeout(() => $('#lightboxClose')?.focus(), 0);
  if (lbSourceImg && lbSourceImg.naturalWidth && !prefersReducedMotion()) flyIn(lbSourceImg);
}

export function closeLightbox(options = {}) {
  const lb = $('#lightbox');
  if (lb.hidden) {
    setLightboxScrollLocked(false);
    flushDeferredFavoritesViewRefresh();
    return;
  }
  const historyMode = options.historyMode || 'back';
  if (historyMode === 'back' && goBackFrom('detail')) {
    clearTimeout(lbRecentTimer);
    lbRecentTimer = 0;
    return;
  }
  syncUrlState({ entry: '', historyMode: historyMode === 'none' ? 'none' : 'replace' });
  const closeSeq = ++lbSeq;
  clearTimeout(lbCloseTimer);
  clearLightboxEntryTimers();
  const done = () => {
    if (closeSeq !== lbSeq) return;
    lb.hidden = true;
    lb.classList.remove('is-open', 'flying');
    clearFlyClones();
    const img = $('#lightboxImg');
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');
    state.lightbox = { entry: null, images: [], index: 0 };
    lbSourceImg = null;
    setLightboxScrollLocked(false);
    flushDeferredFavoritesViewRefresh();
    if (lbFocusReturn?.isConnected) lbFocusReturn.focus({ preventScroll: true });
    lbFocusReturn = null;
  };
  if (options.immediate) {
    lb.classList.remove('is-open');
    done();
    return;
  }
  if (prefersReducedMotion()) {
    lb.classList.remove('is-open');
    done();
    return;
  }
  const img = $('#lightboxImg');
  const src = lbSourceImg;
  const flying = lb.classList.contains('flying');
  lb.classList.remove('is-open');
  if (!flying && src && src.isConnected && img.naturalWidth) {
    const from = img.getBoundingClientRect();
    const to = src.getBoundingClientRect();
    if (from.width && to.width && to.bottom > -40 && to.top < window.innerHeight + 40) {
      const clone = makeFlyClone(img.currentSrc || img.src, from);
      lb.classList.add('flying');
      requestAnimationFrame(() => applyFlyRect(clone, to, 12));
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        done();
      };
      clone.addEventListener('transitionend', finish, { once: true });
      lbCloseTimer = window.setTimeout(finish, 460);
      return;
    }
  }
  lbCloseTimer = window.setTimeout(done, 270);
}

export function stepLightbox(delta) {
  const previous = state.lightbox;
  const previousIndex = previous.index;
  const target = getLightboxStepTarget(delta, previous, state.list);
  if (!target) return false;
  const previousSource = lbSourceImg;
  if (target.crossEntry) {
    clearTimeout(lbRecentTimer);
    lbRecentTimer = 0;
    state.lightbox = { entry: target.entry, images: target.images, index: target.index };
    lbSourceImg = null;  // 已离开首张卡片，关闭时不能再飞回错误来源。
    clearFlyClones();
    $('#lightbox').classList.remove('flying');
  } else {
    previous.index = target.index;
  }
  try {
    renderLightbox();
  } catch (err) {
    console.error('[lightbox] 切换失败，保留当前图片', err);
    if (target.crossEntry) {
      state.lightbox = previous;
      lbSourceImg = previousSource;
    } else {
      previous.index = previousIndex;
    }
    try { renderLightbox(); } catch {}
    return false;
  }
  const current = state.lightbox.entry;
  syncUrlState({ entry: current.id, historyMode: 'replace', transition: 'detail' });
  if (target.crossEntry) scheduleRecentEntry(current);
  return true;
}

export function preloadImage(url) {
  if (!url) return;
  if (lbPreloadCache.has(url)) {
    // Map 的插入顺序兼作轻量 LRU；命中时挪到队尾。
    const token = lbPreloadCache.get(url);
    lbPreloadCache.delete(url);
    lbPreloadCache.set(url, token);
    return;
  }
  while (lbPreloadCache.size >= LB_PRELOAD_CACHE_LIMIT) {
    lbPreloadCache.delete(lbPreloadCache.keys().next().value);
  }
  const token = {};
  lbPreloadCache.set(url, token);
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    img.onload = null;
    img.onerror = null;
  };
  img.onerror = () => {
    // 失败不留永久命中；下次成为邻图时可以重新预热。
    if (lbPreloadCache.get(url) === token) lbPreloadCache.delete(url);
    img.onload = null;
    img.onerror = null;
  };
  try {
    img.src = url;
  } catch {
    if (lbPreloadCache.get(url) === token) lbPreloadCache.delete(url);
    img.onload = null;
    img.onerror = null;
  }
}

export function preloadLightboxNeighbors(navigation = null) {
  const lb = state.lightbox;
  const e = lb.entry;
  if (!e) return;
  const targets = [-1, 1]
    .map(delta => getLightboxStepTarget(delta, lb, state.list, navigation))
    .filter(Boolean);
  const seen = new Set();
  for (const target of targets) {
    const item = target.images[target.index];
    const thumb = imageItemUrl('image', target.entry, item);
    const original = lightboxItemHasOriginal(target.entry, item)
      ? imageItemUrl('original', target.entry, item)
      : '';
    for (const url of [thumb, original]) {
      if (!url || seen.has(url)) continue;
      seen.add(url);
      preloadImage(url);
    }
  }
}

export function isLightboxKeydownBlocked(ev) {
  const target = ev.target instanceof HTMLElement ? ev.target : document.activeElement;
  const tag = target?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable;
  const feedbackPanel = $('#feedbackPanel');
  return Boolean(ev.defaultPrevented || typing || (feedbackPanel && !feedbackPanel.hidden));
}

export function renderCharacterPrompts(entry) {
  const block = $('#characterPromptsBlock');
  const container = $('#lightboxCharacterPrompts');
  if (!block || !container) return;
  const prompts = Array.isArray(entry?.characterPrompts) ? entry.characterPrompts : [];
  container.replaceChildren();
  block.hidden = !prompts.length;
  if (!prompts.length) return;

  const addPromptBox = (parent, labelText, prompt, message) => {
    if (!String(prompt || '').trim()) return;
    const head = document.createElement('div');
    head.className = 'section-head';
    const label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = labelText;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = `复制 ${labelText}`;
    copy.onclick = ev => {
      ev.stopPropagation();
      copyText(prompt, `${message}：${entry.title}`, copy);
    };
    head.append(label, copy);
    const content = document.createElement('pre');
    renderHighlightedText(content, prompt, currentHighlightTerms());
    parent.append(head, content);
  };

  for (const item of prompts) {
    const prompt = document.createElement('section');
    prompt.className = 'character-prompt';
    const label = String(item.label || 'char').trim() || 'char';
    addPromptBox(prompt, label, item.prompt, `已复制 ${label}`);
    if (String(item.negative || '').trim()) {
      const negative = document.createElement('div');
      negative.className = 'character-prompt-negative';
      addPromptBox(negative, `${label} Negative`, item.negative, `已复制 ${label} 负面`);
      prompt.appendChild(negative);
    }
    container.appendChild(prompt);
  }
}

export function lightboxOriginalCopy(status, readable) {
  if (status === 'unavailable') {
    return { label: '无原图', tip: '本法典不提供原图，仅可查看缩略图' };
  }
  if (status === 'loading') {
    return {
      label: '原图加载中…',
      tip: readable ? '原图加载中，拖入 NovelAI 请稍候' : '原图加载中，仅供查看或保存',
    };
  }
  if (status === 'ready') {
    return {
      label: '原图 ✓',
      tip: readable
        ? '可拖入 NovelAI 读取生成参数'
        : '原图可查看或保存；此来源不提供可读取的生成参数',
    };
  }
  if (status === 'failed') {
    return { label: '原图加载失败', tip: '原图加载失败；当前缩略图不含生成参数' };
  }
  return { label: '仅缩略图', tip: '仅提供缩略图，无法从图片读取生成参数' };
}

export function lightboxOriginalAction(available, sourceAllowsOriginal = available) {
  if (available) {
    return { disabled: false, label: '查看原图', title: '在新标签页查看原图' };
  }
  return {
    disabled: true,
    label: '无原图',
    title: sourceAllowsOriginal ? '当前图片未提供原图' : '本法典不提供原图',
  };
}

function applyOriginalPresentation(seq, status, readable) {
  if (seq !== lbSeq) return;
  clearTimeout(lbOriginalStatusTimer);
  lbOriginalStatusTimer = 0;
  const statusEl = $('#lightboxOriginalStatus');
  const tip = $('#lightboxTip') || document.querySelector('.lightbox-tip');
  const copy = lightboxOriginalCopy(status, readable);
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.dataset.state = status;
    statusEl.classList.remove('is-faded');
    statusEl.textContent = copy.label;
  }
  if (tip) tip.textContent = copy.tip;
  if (status === 'ready' && statusEl) {
    lbOriginalStatusTimer = window.setTimeout(() => {
      lbOriginalStatusTimer = 0;
      if (seq === lbSeq) statusEl.classList.add('is-faded');
    }, 2000);
  }
}

export function renderLightbox() {
  const lb = state.lightbox;
  const e = lb.entry;
  const item = lb.images[lb.index];
  if (!e || !item) return;
  const emptyImage = item._editPlaceholder === true;
  const seq = ++lbSeq;
  clearTimeout(lbOriginalStatusTimer);
  lbOriginalStatusTimer = 0;
  const img = $('#lightboxImg');
  const stage = $('#lightboxStage');
  $('#lightbox').classList.toggle('has-thumbs', lb.images.length > 1);
  stage.classList.toggle('edit-empty', emptyImage);
  img.hidden = emptyImage;
  const thumbSrc = emptyImage ? '' : imageItemUrl('image', e, item);
  const sourceAllowsOriginal = !emptyImage && sourceSupportsReadableOriginal(e);
  const hasOriginal = !emptyImage && lightboxItemHasOriginal(e, item);
  const origSrc = hasOriginal ? imageItemUrl('original', e, item) : '';
  const origAbs = resolvedUrl(origSrc);
  const readableOriginal = hasOriginal;
  img.onload = null;
  img.onerror = emptyImage ? null : () => {
    if (seq !== lbSeq) return;
    if (hasOriginal && resolvedUrl(img.currentSrc || img.src) !== origAbs) {
      img.src = origSrc;
      return;
    }
    if (hasOriginal) applyOriginalPresentation(seq, 'failed', readableOriginal);
    notifyImageLoadError(e);
  };
  img.onload = emptyImage ? null : () => {
    if (seq !== lbSeq || !hasOriginal) return;
    if (resolvedUrl(img.currentSrc || img.src) === origAbs) {
      applyOriginalPresentation(seq, 'ready', readableOriginal);
    }
  };
  /* 垫底加载：先上缩略图，原图加载完成后替换 */
  const showImage = () => {
    if (seq !== lbSeq) return;
    img.src = thumbSrc || origSrc;
    if (hasOriginal && origSrc !== thumbSrc) {
      const pre = new Image();
      pre.decoding = 'async';
      pre.onload = () => {
        pre.onload = null;
        pre.onerror = null;
        if (seq === lbSeq && state.lightbox.entry === e) img.src = origSrc;
      };
      pre.onerror = () => {
        pre.onload = null;
        pre.onerror = null;
        applyOriginalPresentation(seq, 'failed', readableOriginal);
      };
      pre.src = origSrc;
    }
  };
  const statusEl = $('#lightboxOriginalStatus');
  if (emptyImage) {
    img.removeAttribute('src');
    if (statusEl) statusEl.hidden = true;
  } else {
    const originalStatus = !sourceAllowsOriginal
      ? 'unavailable'
      : (hasOriginal ? 'loading' : 'thumbnail');
    applyOriginalPresentation(seq, originalStatus, readableOriginal);
    showImage();
  }

  $('#lightboxTitle').textContent = e.title;
  const nav = lightboxNavigationContext(e, state.list);
  const entryPosition = nav.index >= 0 ? ` · 第 ${nav.position} / ${nav.total} 条` : '';
  $('#lightboxMeta').textContent = emptyImage
    ? `暂无图片 · ${e.path.join(' › ')}`
    : `${lb.index + 1} / ${lb.images.length}${entryPosition} · ${e.path.join(' › ')}`;
  const tip = $('#lightboxTip') || document.querySelector('.lightbox-tip');
  if (tip) tip.hidden = emptyImage;

  const credit = item.credit || item.author || e.credit || e.author || '';
  const creditUrl = item.creditUrl || item.authorUrl || e.creditUrl || e.authorUrl || '';
  const safeCreditUrl = safeHttpUrl(creditUrl);
  const creditEl = $('#lightboxCredit');
  if (credit) {
    creditEl.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M5 20a7 7 0 0 1 14 0"/></svg>' +
      `<span>${esc(credit)}</span>`;
    if (safeCreditUrl) { creditEl.href = safeCreditUrl; creditEl.target = '_blank'; creditEl.rel = 'noopener'; }
    else {
      creditEl.removeAttribute('href');
      creditEl.removeAttribute('target');
      creditEl.removeAttribute('rel');
    }
    creditEl.hidden = false;
  } else {
    creditEl.hidden = true;
    creditEl.removeAttribute('href');
  }

  const hasPositive = Boolean(String(e.tags || '').trim());
  if (hasPositive) renderHighlightedText($('#lightboxTags'), e.tags || '', currentHighlightTerms());
  else $('#lightboxTags').textContent = readableOriginal
    ? '暂无站内可复制 tags；原图就绪后可尝试拖入 NovelAI 读取。'
    : '暂无站内可复制 tags。';
  renderCharacterPrompts(e);
  $('#lightboxNegative').textContent = e.negative || '';
  $('#lightboxNote').textContent = e.note || '';
  $('#negativeBlock').hidden = !e.negative;
  $('#noteBlock').hidden = !e.note;

  const bindSdPreview = (button, pre, source, { highlighted = false } = {}) => {
    if (!button || !pre) return;
    const available = Boolean(state.sdMode && String(source || '').trim());
    button.hidden = !available;
    button.setAttribute('aria-pressed', 'false');
    button.textContent = 'SD 预览';
    pre.classList.remove('sd-previewing');
    button.onclick = available ? event => {
      event.stopPropagation();
      const enabled = button.getAttribute('aria-pressed') !== 'true';
      button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      button.textContent = enabled ? '恢复原文' : 'SD 预览';
      pre.classList.toggle('sd-previewing', enabled);
      if (enabled) pre.textContent = naiToSd(source);
      else if (highlighted) renderHighlightedText(pre, source, currentHighlightTerms());
      else pre.textContent = source;
    } : null;
  };
  bindSdPreview($('#sdPositivePreview'), $('#lightboxTags'), e.tags || '', { highlighted: true });
  bindSdPreview($('#sdNegativePreview'), $('#lightboxNegative'), e.negative || '');

  $('#copyPositive').hidden = !hasPositive;
  $('#copyPositive').title = state.sdMode ? '将以 Stable Diffusion 格式复制' : '复制 NovelAI 原文';
  $('#copyPositive').onclick = ev => {
    ev.stopPropagation();
    copyText(e.tags, `已复制正向：${e.title}`, ev.currentTarget, {
      followUp: String(e.negative || '').trim() ? {
        label: '再复制负面',
        text: e.negative,
        message: `已复制负面：${e.title}`,
      } : null,
    });
  };
  $('#copyNegative').hidden = !e.negative;
  $('#copyNegative').title = state.sdMode ? '将以 Stable Diffusion 格式复制' : '复制 NovelAI 原文';
  $('#copyNegative').onclick = ev => {
    ev.stopPropagation();
    copyText(e.negative, `已复制负面：${e.title}`, ev.currentTarget, {
      sampleLabel: '已复制负面',
    });
  };
  $('#copyAll').hidden = !e.negative && !(e.characterPrompts || []).length;
  $('#copyAll').onclick = ev => {
    ev.stopPropagation();
    copyText(combinedPrompt(e), `已复制正向+负面：${e.title}`, ev.currentTarget);
  };
  $('#copyRawTag').hidden = !item.rawTag;
  $('#copyRawTag').onclick = ev => {
    ev.stopPropagation();
    copyText(item.rawTag, `已复制当前图 raw tag：${e.title}`, ev.currentTarget);
  };
  const favoriteBtn = $('#favoriteLightbox');
  if (favoriteBtn) {
    favoriteBtn.hidden = emptyImage;
    setFavoriteButtonState(favoriteBtn, isFav(e));
    favoriteBtn.onclick = ev => {
      ev.stopPropagation();
      toggleFav(e, favoriteBtn, { deferViewRefresh: true });
    };
  }
  const originalBtn = $('#viewOriginal');
  if (originalBtn) {
    const action = lightboxOriginalAction(Boolean(hasOriginal && origSrc), sourceAllowsOriginal);
    originalBtn.hidden = emptyImage;
    originalBtn.disabled = action.disabled;
    originalBtn.textContent = action.label;
    originalBtn.title = action.title;
    originalBtn.onclick = action.disabled ? null : ev => {
      ev.stopPropagation();
      const opened = window.open(origSrc, '_blank', 'noopener');
      if (opened) opened.opener = null;
    };
  }
  const shareBtn = $('#shareLightbox');
  const shareUrl = shareUrlForEntry(e);
  if (shareBtn) {
    shareBtn.hidden = emptyImage || !shareUrl;
    shareBtn.onclick = async ev => {
      ev.stopPropagation();
      if (!shareUrl) return;
      if (canUseNativeShare()) {
        try {
          await navigator.share({ title: e.title, url: shareUrl });
          return;
        } catch (error) {
          if (error?.name === 'AbortError') return;
        }
      }
      await copyText(shareUrl, '已复制分享链接', shareBtn, { convert: false });
    };
  }
  const reportBtn = $('#reportLightbox');
  if (reportBtn) {
    reportBtn.hidden = emptyImage;
    reportBtn.onclick = ev => {
      ev.stopPropagation();
      openReportDialog({
        source: 'lightbox',
        entry: e,
        imageIndex: lb.index,
        defaultType: 'card_content',
        trigger: reportBtn,
      });
    };
  }
  const actions = document.querySelector('.lightbox-actions');
  if (actions) {
    actions.hidden = [favoriteBtn, $('#copyAll'), $('#copyRawTag'), originalBtn, shareBtn, reportBtn]
      .filter(Boolean)
      .every(button => button.hidden);
  }

  const prev = $('#lightboxPrev');
  const next = $('#lightboxNext');
  const prevTarget = getLightboxStepTarget(-1, lb, state.list, nav);
  const nextTarget = getLightboxStepTarget(1, lb, state.list, nav);
  const configureNavButton = (button, target, direction) => {
    button.hidden = !target;
    if (!target) {
      button.removeAttribute('data-nav-label');
      return;
    }
    const word = direction < 0 ? '上一' : '下一';
    const label = target.crossEntry ? `${word}条：${target.entry.title}` : `${word}张`;
    button.setAttribute('aria-label', label);
    button.title = label;
    if (target.crossEntry) button.dataset.navLabel = label;
    else button.removeAttribute('data-nav-label');
  };
  configureNavButton(prev, prevTarget, -1);
  configureNavButton(next, nextTarget, 1);
  const thumbs = $('#lightboxThumbs');
  const reuseThumbs = lbThumbEntry === e
    && lbThumbImages === lb.images
    && lbThumbState === lb
    && thumbs.childElementCount === lb.images.length;
  if (!reuseThumbs) {
    thumbs.innerHTML = '';
    lbThumbEntry = e;
    lbThumbImages = lb.images;
    lbThumbState = lb;
  }
  thumbs.hidden = lb.images.length < 2;
  if (!thumbs.hidden) {
    if (!reuseThumbs) {
      lb.images.forEach((image, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lightbox-thumb';
        btn.title = `第 ${i + 1} 张`;
        const ti = document.createElement('img');
        ti.alt = '';
        ti.loading = 'lazy';
        ti.src = imageItemUrl('image', e, image) || imageItemUrl('original', e, image);
        btn.appendChild(ti);
        btn.onclick = ev => {
          ev.stopPropagation();
          if (lb.index === i) return;
          lb.index = i;
          renderLightbox();
          syncUrlState({ entry: lb.entry.id, historyMode: 'replace', transition: 'detail' });
        };
        thumbs.appendChild(btn);
      });
    }
    thumbs.querySelectorAll('.lightbox-thumb').forEach((btn, i) => {
      btn.classList.toggle('active', i === lb.index);
    });
    const act = thumbs.querySelector('.lightbox-thumb.active');
    if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  preloadLightboxNeighbors(nav);
  document.dispatchEvent(new CustomEvent('lightbox:rendered', { detail: { entry: e, index: lb.index } }));
}


export function bindLightboxControls({ mobileQuery = window.matchMedia('(max-width:600px)') } = {}) {
  let suppressLightboxClick = false;
  $('#lightbox').onclick = ev => {
    if (suppressLightboxClick) {
      suppressLightboxClick = false;
      return;
    }
    if (ev.target.id === 'lightbox' || ev.target.id === 'lightboxStage') closeLightbox();
  };
  $('#lightboxFold').onclick = ev => {
    ev.stopPropagation();
    const lbEl = $('#lightbox');
    lbEl.classList.toggle('folded');
    localStorage.setItem('fadian-lbinfo', lbEl.classList.contains('folded') ? 'folded' : 'open');
  };
  $('#lightboxClose').onclick = closeLightbox;
  $('#lightboxPrev').onclick = ev => { ev.stopPropagation(); stepLightbox(-1); };
  $('#lightboxNext').onclick = ev => { ev.stopPropagation(); stepLightbox(1); };
  let lightboxTouch = null;
  let lightboxPointer = null;
  let lastLightboxSwipeAt = 0;
  const canStartLightboxSwipe = target =>
    !target.closest('.lightbox-info,.lightbox-thumbs,.lb-circle,.lb-fold');
  const commitLightboxSwipe = (dx, dy, elapsed) => {
    if (elapsed > 800 || Math.abs(dx) < 54 || Math.abs(dx) < Math.abs(dy) * 1.2) return false;
    const direction = dx < 0 ? 1 : -1;
    if (!stepLightbox(direction)) return false;
    lastLightboxSwipeAt = Date.now();
    suppressLightboxClick = true;
    window.setTimeout(() => { suppressLightboxClick = false; }, 80);
    return true;
  };
  $('#lightbox').addEventListener('touchstart', ev => {
    if ($('#lightbox').hidden || ev.touches.length !== 1) return;
    if (!canStartLightboxSwipe(ev.target)) return;
    const t = ev.touches[0];
    lightboxTouch = { x: t.clientX, y: t.clientY, at: Date.now() };
  }, { passive: true });
  $('#lightbox').addEventListener('touchmove', ev => {
    if (!lightboxTouch || ev.touches.length !== 1) return;
    const t = ev.touches[0];
    const dx = t.clientX - lightboxTouch.x;
    const dy = t.clientY - lightboxTouch.y;
    if (Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy) * 1.15) ev.preventDefault();
  }, { passive: false });
  $('#lightbox').addEventListener('touchend', ev => {
    if (!lightboxTouch) return;
    const t = ev.changedTouches[0];
    const dx = t.clientX - lightboxTouch.x;
    const dy = t.clientY - lightboxTouch.y;
    const elapsed = Date.now() - lightboxTouch.at;
    lightboxTouch = null;
    commitLightboxSwipe(dx, dy, elapsed);
  }, { passive: true });
  $('#lightbox').addEventListener('touchcancel', () => { lightboxTouch = null; }, { passive: true });
  $('#lightbox').addEventListener('pointerdown', ev => {
    if ($('#lightbox').hidden || ev.button !== 0) return;
    if (!mobileQuery.matches && ev.pointerType !== 'touch') return;
    if (!canStartLightboxSwipe(ev.target)) return;
    lightboxPointer = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, at: Date.now() };
  });
  $('#lightbox').addEventListener('pointermove', ev => {
    if (!lightboxPointer || ev.pointerId !== lightboxPointer.id) return;
    const dx = ev.clientX - lightboxPointer.x;
    const dy = ev.clientY - lightboxPointer.y;
    if (Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy) * 1.15) ev.preventDefault();
  }, { passive: false });
  $('#lightbox').addEventListener('pointerup', ev => {
    if (!lightboxPointer || ev.pointerId !== lightboxPointer.id) return;
    const dx = ev.clientX - lightboxPointer.x;
    const dy = ev.clientY - lightboxPointer.y;
    const elapsed = Date.now() - lightboxPointer.at;
    lightboxPointer = null;
    if (Date.now() - lastLightboxSwipeAt < 220) return;
    commitLightboxSwipe(dx, dy, elapsed);
  });
  $('#lightbox').addEventListener('pointercancel', ev => {
    if (lightboxPointer?.id === ev.pointerId) lightboxPointer = null;
  });
  window.addEventListener('keydown', ev => {
    if ($('#lightbox').hidden) return;
    if (isLightboxKeydownBlocked(ev)) return;
    if (ev.key === 'Escape') closeLightbox();
    if (ev.key === 'ArrowLeft') stepLightbox(-1);
    if (ev.key === 'ArrowRight') stepLightbox(1);
  });


}
