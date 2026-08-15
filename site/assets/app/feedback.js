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
let skeletonHideWait = null;
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

function cancelSkeletonHide() {
  clearTimeout(skeletonHideTimer);
  skeletonHideTimer = 0;
  if (!skeletonHideWait) return;
  const { resolve } = skeletonHideWait;
  skeletonHideWait = null;
  resolve(false);
}

function finishSkeleton(token, update, { respectMinVisible = true } = {}) {
  if (skeletonToken !== token) return Promise.resolve(false);
  const grid = $('#skeletonGrid');
  clearTimeout(skeletonDelayTimer);
  skeletonDelayTimer = 0;
  cancelSkeletonHide();

  const commit = () => {
    if (skeletonToken !== token) return false;
    skeletonToken = null;
    setSkeletonPending(false);
    setSkeletonVisible(false);
    update?.();
    return true;
  };

  if (!grid || grid.hidden) {
    try {
      return Promise.resolve(commit());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  const wait = respectMinVisible
    ? Math.max(0, skeletonMinVisible - (timeNow() - skeletonShownAt))
    : 0;
  if (wait <= 0) {
    try {
      return Promise.resolve(commit());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return new Promise((resolve, reject) => {
    skeletonHideWait = { resolve };
    skeletonHideTimer = window.setTimeout(() => {
      if (skeletonHideWait?.resolve !== resolve) return;
      skeletonHideWait = null;
      skeletonHideTimer = 0;
      try {
        resolve(commit());
      } catch (error) {
        reject(error);
      }
    }, wait);
  });
}

export function showSkeleton(token, { delay = 200, minVisible = 300 } = {}) {
  const grid = $('#skeletonGrid');
  if (!grid) return;
  skeletonToken = token;
  skeletonMinVisible = minVisible;
  setSkeletonPending(true);
  clearTimeout(skeletonDelayTimer);
  cancelSkeletonHide();

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
  return finishSkeleton(token);
}

/* 成功态不为凑最短展示时间阻塞真实内容；防闪由 show 的 delay 负责。
   flow skeleton 与真实内容仍须在同一次 DOM 提交，否则异步 hide 会把 masonry 整片上拉。 */
export function replaceSkeleton(token, render) {
  return finishSkeleton(token, render, { respectMinVisible: false });
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
