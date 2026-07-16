import { state } from './state.js';
import { $, clamp, esc, prefersReducedMotion } from './utils.js';
import { notifyImageLoadError } from './masonry.js';
import { renderHighlightedText, currentHighlightTerms } from './search.js';
import { copyText, combinedPrompt } from './copy.js';
import { recordRecentEntry } from './history.js';
import { syncUrlState } from './router.js';
import { findCodexMeta } from './data.js';
import { entryImages, imageItemUrl } from './media.js';
import { isEntryAccessBlocked, isR18gBlocked, showNsfwLockedHint, showR18gLockedHint } from './access.js';
import { openReportDialog } from './report.js';
import { goBackFrom } from './browser-history.js';

/* ---------------- 灯箱（沉浸浮影 + 原位展开） ---------------- */
let lbSeq = 0;
let lbCloseTimer = 0;
let lbSourceImg = null;
let lbFocusReturn = null;
const lbPreloadCache = new Set();


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
  const images = entryImages(entry);
  if (!images.length) return;
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
  void lb.offsetWidth;
  lb.classList.add('is-open');
  lbFocusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  window.setTimeout(() => $('#lightboxClose')?.focus(), 0);
  if (lbSourceImg && lbSourceImg.naturalWidth && !prefersReducedMotion()) flyIn(lbSourceImg);
}

export function closeLightbox(options = {}) {
  const lb = $('#lightbox');
  if (lb.hidden) return;
  const historyMode = options.historyMode || 'back';
  if (historyMode === 'back' && goBackFrom('detail')) return;
  syncUrlState({ entry: '', historyMode: historyMode === 'none' ? 'none' : 'replace' });
  lbSeq++;
  clearTimeout(lbCloseTimer);
  const done = () => {
    lb.hidden = true;
    lb.classList.remove('is-open', 'flying');
    clearFlyClones();
    const img = $('#lightboxImg');
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');
    state.lightbox = { entry: null, images: [], index: 0 };
    lbSourceImg = null;
    if (lbFocusReturn?.isConnected) lbFocusReturn.focus();
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
  const lb = state.lightbox;
  if (!lb.entry || lb.images.length < 2) return;
  lb.index = (lb.index + delta + lb.images.length) % lb.images.length;
  renderLightbox();
  syncUrlState({ entry: lb.entry.id, historyMode: 'replace' });
}

export function preloadImage(url) {
  if (!url || lbPreloadCache.has(url)) return;
  lbPreloadCache.add(url);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
}

export function preloadLightboxNeighbors() {
  const lb = state.lightbox;
  const e = lb.entry;
  if (!e || lb.images.length < 2) return;
  const indexes = [
    (lb.index - 1 + lb.images.length) % lb.images.length,
    (lb.index + 1) % lb.images.length,
  ];
  for (const i of [...new Set(indexes)]) {
    const item = lb.images[i];
    preloadImage(imageItemUrl('image', e, item));
    preloadImage(imageItemUrl('original', e, item));
  }
}

export function renderLightbox() {
  const lb = state.lightbox;
  const e = lb.entry;
  const item = lb.images[lb.index];
  if (!e || !item) return;
  const seq = ++lbSeq;
  const img = $('#lightboxImg');
  const thumbSrc = imageItemUrl('image', e, item);
  const origSrc = imageItemUrl('original', e, item);
  const origAbs = resolvedUrl(origSrc);
  img.onload = null;
  img.onerror = () => {
    if (seq !== lbSeq) return;
    if (origSrc && resolvedUrl(img.currentSrc || img.src) !== origAbs) {
      img.src = origSrc;
      return;
    }
    notifyImageLoadError(e);
  };
  /* 垫底加载：先上缩略图，原图加载完成后替换 */
  const showImage = () => {
    if (seq !== lbSeq) return;
    img.src = thumbSrc || origSrc;
    if (origSrc && origSrc !== thumbSrc) {
      const pre = new Image();
      pre.onload = () => {
        if (seq === lbSeq && state.lightbox.entry === e) img.src = origSrc;
      };
      pre.src = origSrc;
    }
  };
  showImage();

  $('#lightboxTitle').textContent = e.title;
  $('#lightboxMeta').textContent = `${lb.index + 1} / ${lb.images.length} · ${e.path.join(' › ')}`;

  const credit = item.credit || item.author || e.credit || e.author || '';
  const creditUrl = item.creditUrl || item.authorUrl || e.creditUrl || e.authorUrl || '';
  const creditEl = $('#lightboxCredit');
  if (credit) {
    creditEl.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M5 20a7 7 0 0 1 14 0"/></svg>' +
      `<span>${esc(credit)}</span>`;
    if (creditUrl) { creditEl.href = creditUrl; creditEl.target = '_blank'; creditEl.rel = 'noopener'; }
    else creditEl.removeAttribute('href');
    creditEl.hidden = false;
  } else {
    creditEl.hidden = true;
    creditEl.removeAttribute('href');
  }

  const hasPositive = Boolean(String(e.tags || '').trim());
  if (hasPositive) renderHighlightedText($('#lightboxTags'), e.tags || '', currentHighlightTerms());
  else $('#lightboxTags').textContent = '暂无站内可复制 tags；可尝试将原图拖入 NovelAI 读取。';
  $('#lightboxNegative').textContent = e.negative || '';
  $('#lightboxNote').textContent = e.note || '';
  $('#negativeBlock').hidden = !e.negative;
  $('#noteBlock').hidden = !e.note;

  $('#copyPositive').hidden = !hasPositive;
  $('#copyPositive').onclick = ev => { ev.stopPropagation(); copyText(e.tags, `已复制正向：${e.title}`); };
  $('#copyNegative').hidden = !e.negative;
  $('#copyNegative').onclick = ev => { ev.stopPropagation(); copyText(e.negative, `已复制负面：${e.title}`); };
  $('#copyAll').hidden = !e.negative;
  $('#copyAll').onclick = ev => { ev.stopPropagation(); copyText(combinedPrompt(e), `已复制正向+负面：${e.title}`); };
  $('#copyRawTag').hidden = !item.rawTag;
  $('#copyRawTag').onclick = ev => { ev.stopPropagation(); copyText(item.rawTag, `已复制当前图 raw tag：${e.title}`); };
  const shareBtn = $('#shareLightbox');
  const shareUrl = shareUrlForEntry(e);
  if (shareBtn) {
    shareBtn.hidden = !shareUrl;
    shareBtn.onclick = ev => {
      ev.stopPropagation();
      if (shareUrl) copyText(shareUrl, '已复制分享链接', shareBtn, { convert: false });
    };
  }
  const reportBtn = $('#reportLightbox');
  if (reportBtn) {
    reportBtn.hidden = false;
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
  if (actions) actions.hidden = $('#copyAll').hidden && $('#copyRawTag').hidden && shareBtn?.hidden && reportBtn?.hidden;

  const prev = $('#lightboxPrev');
  const next = $('#lightboxNext');
  prev.hidden = next.hidden = lb.images.length < 2;
  const thumbs = $('#lightboxThumbs');
  thumbs.innerHTML = '';
  thumbs.hidden = lb.images.length < 2;
  if (!thumbs.hidden) {
    lb.images.forEach((image, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lightbox-thumb' + (i === lb.index ? ' active' : '');
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
    const act = thumbs.querySelector('.lightbox-thumb.active');
    if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  preloadLightboxNeighbors();
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
    if (state.lightbox.images.length < 2) return false;
    if (elapsed > 800 || Math.abs(dx) < 54 || Math.abs(dx) < Math.abs(dy) * 1.2) return false;
    stepLightbox(dx < 0 ? 1 : -1);
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
    if (ev.key === 'Escape') closeLightbox();
    if (ev.key === 'ArrowLeft') stepLightbox(-1);
    if (ev.key === 'ArrowRight') stepLightbox(1);
  });


}
