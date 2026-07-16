import { prefersReducedMotion } from './utils.js';
import {
  closeHistoryLayer,
  forgetHistoryLayer,
  openHistoryLayer,
  registerHistoryLayer,
} from './browser-history.js';

const maskTimers = new WeakMap();
const maskOpeners = new WeakMap();

export function focusableIn(root) {
  if (!root) return [];
  return [...root.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter(el => el.offsetParent !== null || el === document.activeElement);
}

export function focusFirstIn(root) {
  // 双 rAF：等一帧让弹窗的 display（含 allow-discrete 过渡）落定，
  // 否则单帧时 offsetParent 可能仍为 null、focusableIn 取不到元素而空转（社区弹窗曾因此开时不聚焦）。
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const target = focusableIn(root)[0];
    if (target && !root.contains(document.activeElement)) target.focus();
  }));
}

export function trapFocus(ev, root) {
  if (ev.key !== 'Tab') return;
  const list = focusableIn(root);
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  if (ev.shiftKey && document.activeElement === first) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && document.activeElement === last) {
    ev.preventDefault();
    first.focus();
  }
}

function openMaskDirect(mask, trigger = document.activeElement) {
  if (!mask) return;
  clearTimeout(maskTimers.get(mask));
  if (trigger instanceof HTMLElement) maskOpeners.set(mask, trigger);
  mask.hidden = false;
  void mask.offsetWidth;
  mask.classList.add('show');
  focusFirstIn(mask);
}

function closeMaskDirect(mask) {
  if (!mask) return;
  mask.classList.remove('show');
  const restoreFocus = () => {
    const opener = maskOpeners.get(mask);
    if (opener?.isConnected) opener.focus();
  };
  if (prefersReducedMotion()) {
    mask.hidden = true;
    restoreFocus();
    return;
  }
  maskTimers.set(mask, setTimeout(() => {
    if (!mask.classList.contains('show')) {
      mask.hidden = true;
      restoreFocus();
    }
  }, 240));
}

function registerMaskHistory(mask) {
  if (!mask?.id) return;
  registerHistoryLayer(mask.id, {
    isOpen: () => mask.classList.contains('show'),
    open: () => openMaskDirect(mask),
    close: () => closeMaskDirect(mask),
  });
}

export function openMask(mask, trigger = document.activeElement, { historyMode = 'push' } = {}) {
  if (!mask) return;
  registerMaskHistory(mask);
  openMaskDirect(mask, trigger);
  if (historyMode !== 'none' && mask.id) {
    openHistoryLayer(mask.id, { mode: historyMode === 'replace' ? 'replace' : 'push' });
  }
}

export function closeMask(mask, { historyMode = 'back' } = {}) {
  if (!mask) return;
  if (historyMode !== 'none' && mask.id && closeHistoryLayer(mask.id)) return;
  closeMaskDirect(mask);
  if (historyMode !== 'none' && mask.id) forgetHistoryLayer(mask.id);
}

export function isMaskOpen(mask) {
  return Boolean(mask && !mask.hidden);
}
