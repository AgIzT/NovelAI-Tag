import { $ } from './utils.js';

export function setLoading(text) {
  const el = $('#loading');
  if (!el) return;
  const message = String(text || '');
  const visibleMessage = message.startsWith('正在加载') ? '' : message;
  el.textContent = visibleMessage;
  el.hidden = !visibleMessage;
  $('#main')?.classList.toggle('is-loading', Boolean(visibleMessage));
}

let skeletonToken = null;
let skeletonDelayTimer = 0;
let skeletonHideTimer = 0;
let skeletonShownAt = 0;
let skeletonMinVisible = 300;

function timeNow() {
  return window.performance?.now ? window.performance.now() : Date.now();
}

function setSkeletonPending(pending) {
  $('#main')?.classList.toggle('has-skeleton', pending);
}

function setSkeletonVisible(visible) {
  const grid = $('#skeletonGrid');
  const main = $('#main');
  if (grid) grid.hidden = !visible;
  main?.classList.toggle('skeleton-visible', visible);
}

export function showSkeleton(token, { delay = 200, minVisible = 300 } = {}) {
  const grid = $('#skeletonGrid');
  if (!grid) return;
  skeletonToken = token;
  skeletonMinVisible = minVisible;
  setSkeletonPending(true);
  clearTimeout(skeletonDelayTimer);
  clearTimeout(skeletonHideTimer);
  skeletonHideTimer = 0;

  if (!grid.hidden) {
    skeletonShownAt = timeNow();
    setSkeletonVisible(true);
    return;
  }

  if (delay <= 0) {
    skeletonShownAt = timeNow();
    setSkeletonVisible(true);
    return;
  }

  skeletonDelayTimer = window.setTimeout(() => {
    if (skeletonToken !== token) return;
    skeletonDelayTimer = 0;
    skeletonShownAt = timeNow();
    setSkeletonVisible(true);
  }, delay);
}

export function hideSkeleton(token) {
  if (skeletonToken !== token) return;
  const grid = $('#skeletonGrid');
  clearTimeout(skeletonDelayTimer);
  skeletonDelayTimer = 0;

  if (!grid || grid.hidden) {
    skeletonToken = null;
    setSkeletonPending(false);
    setSkeletonVisible(false);
    return;
  }

  const wait = Math.max(0, skeletonMinVisible - (timeNow() - skeletonShownAt));
  clearTimeout(skeletonHideTimer);
  skeletonHideTimer = window.setTimeout(() => {
    if (skeletonToken !== token) return;
    skeletonHideTimer = 0;
    skeletonToken = null;
    setSkeletonPending(false);
    setSkeletonVisible(false);
  }, wait);
}

let toastTimer;
let toastFocusReturn = null;

function hideToast(element) {
  clearTimeout(toastTimer);
  toastTimer = 0;
  element.classList.remove('show');
  const active = globalThis.document?.activeElement;
  if (active && element.contains?.(active)) {
    const focusReturn = toastFocusReturn;
    if (focusReturn?.isConnected && typeof focusReturn.focus === 'function') {
      try {
        focusReturn.focus({ preventScroll: true });
      } catch {
        active.blur?.();
      }
    } else {
      active.blur?.();
    }
  }
  element.setAttribute?.('aria-hidden', 'true');
  const action = element.querySelector?.('.toast-action');
  if (action) action.tabIndex = -1;
  toastFocusReturn = null;
}

function scheduleToastHide(element, delay) {
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hideToast(element), delay);
}

export function toast(msg, icon = '✓', action = null) {
  const t = $('#toast');
  if (!t) return;
  hideToast(t);
  const active = globalThis.document?.activeElement;
  toastFocusReturn = active && !t.contains?.(active) ? active : null;
  // 先恢复 live region，再改变其文本；否则辅助技术可能错过整次更新。
  t.removeAttribute?.('aria-hidden');
  t.replaceChildren();
  const message = document.createElement('span');
  message.className = 'toast-message';
  message.textContent = icon ? `${icon} ${msg}` : msg;
  t.appendChild(message);
  const hasAction = Boolean(action?.label && typeof action?.onClick === 'function');
  t.classList.toggle('has-action', hasAction);
  t.onpointerenter = null;
  t.onpointerleave = null;
  if (hasAction) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', event => {
      event.stopPropagation();
      hideToast(t);
      let result = false;
      try {
        result = action.onClick();
      } catch {}
      if (result === false && action.failureMessage) {
        toast(action.failureMessage, '!');
      }
    });
    t.appendChild(button);
  }
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  const duration = hasAction
    ? Math.max(4_000, Math.min(10_000, Number(action.duration) || 5_000))
    : 1_600;
  scheduleToastHide(t, duration);
  if (hasAction) {
    t.onpointerenter = () => clearTimeout(toastTimer);
    t.onpointerleave = () => scheduleToastHide(t, 1_600);
  }
}
