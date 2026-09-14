import { prefersReducedMotion } from './utils.js';
import {
  closeHistoryLayer,
  forgetHistoryLayer,
  openHistoryLayer,
  registerHistoryLayer,
} from './browser-history.js';

const maskTimers = new WeakMap();
const maskOpeners = new WeakMap();
const maskOptions = new WeakMap();
const maskOrder = new WeakMap();
const eventLayers = new WeakMap();
let openOrder = 0;

export function configureMask(mask, options = {}) {
  if (!mask) return;
  mask.setAttribute('data-modal-root', '');
  maskOptions.set(mask, { ...maskOptions.get(mask), ...options });
}

function interactionStack(element) {
  const stack = [];
  for (let node = element; node && node !== document.body; node = node.parentElement) {
    const z = Number.parseInt(getComputedStyle(node).zIndex, 10);
    if (Number.isFinite(z)) stack.unshift(z);
  }
  return stack;
}

/* 只认当前可交互的模态 DOM。选择模式没有 aria-modal，停靠栏会移除此属性；
   灯箱虽由 route 托管，仍是模态。history 层顺序不能替代实际遮挡关系。 */
export function topInteractionLayer(event = null) {
  if (event && eventLayers.has(event)) return eventLayers.get(event);
  let top = null;
  let topStack = [];
  const seen = new Set();
  for (const dialog of document.querySelectorAll('[aria-modal="true"], [data-modal-root]')) {
    const nestedModal = dialog.parentElement?.closest('[aria-modal="true"]');
    const root = nestedModal ? dialog : dialog.closest('[data-modal-root]') || dialog;
    if (seen.has(root) || root.closest('[hidden], [inert]') || !root.getClientRects().length) continue;
    seen.add(root);
    const style = getComputedStyle(root);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const stack = interactionStack(root);
    let order = 0;
    for (let index = 0; index < Math.max(stack.length, topStack.length); index++) {
      order = (stack[index] || 0) - (topStack[index] || 0);
      if (order) break;
    }
    if (!order && top) {
      order = top.contains(root) ? 1 : root.contains(top) ? -1
        : (maskOrder.get(root) || 0) - (maskOrder.get(top) || 0);
    }
    if (!top || order >= 0) { top = root; topStack = stack; }
  }
  // 同一击 Esc 关闭上层后，后注册的监听仍须让出这一击，不能继续关闭底层。
  if (event) eventLayers.set(event, top);
  return top;
}

export function isGlobalShortcutBlocked(event, owner = null) {
  if (event?.defaultPrevented) return true;
  const top = topInteractionLayer(event);
  const element = typeof owner === 'string' ? document.getElementById(owner) : owner;
  return Boolean(top && (!element || (top !== element && !top.contains(element))));
}

function bindDismissClick(root, onDismiss, isOutside) {
  let pointer = null;
  const reset = () => { pointer = null; };
  const onPointerDown = event => {
    pointer = event.button === 0 && event.isPrimary !== false
      ? { id: event.pointerId, outside: isOutside(event.target), releasedOutside: false }
      : null;
  };
  const onPointerUp = event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    // 触摸会隐式捕获指针，event.target 可能仍是起点；释放位置必须重新命中测试。
    const doc = root.ownerDocument || root;
    const target = doc.elementFromPoint(event.clientX, event.clientY);
    pointer.releasedOutside = event.button === 0 && Boolean(target && isOutside(target));
  };
  const onClick = event => {
    const gesture = pointer;
    reset();
    // 键盘 / 辅助技术产生的 click 没有对应的指针序列。
    const keyboardClick = event.detail === 0 && !event.pointerType;
    const outsideClick = gesture?.outside && gesture.releasedOutside
      && (event.pointerId === undefined || event.pointerId === gesture.id);
    if ((keyboardClick || outsideClick) && isOutside(event.target)) onDismiss(event);
  };
  // 在内容自己的监听之前记下起终点，不阻止选字、滚动或灯箱滑动。
  root.addEventListener('pointerdown', onPointerDown, true);
  root.addEventListener('pointerup', onPointerUp, true);
  root.addEventListener('pointercancel', reset, true);
  root.addEventListener('click', onClick);
  return () => {
    reset();
    root.removeEventListener('pointerdown', onPointerDown, true);
    root.removeEventListener('pointerup', onPointerUp, true);
    root.removeEventListener('pointercancel', reset, true);
    root.removeEventListener('click', onClick);
  };
}

export function bindBackdropDismiss(mask, onDismiss, { isBackdrop = target => target === mask } = {}) {
  if (!mask) return () => {};
  return bindDismissClick(mask, onDismiss, isBackdrop);
}

export function bindOutsideDismiss(elements, onDismiss) {
  return bindDismissClick(document, onDismiss, target => {
    const inside = (typeof elements === 'function' ? elements() : elements).filter(Boolean);
    return inside.length > 0 && inside.every(element => !element.contains(target));
  });
}

export function focusableIn(root) {
  if (!root) return [];
  return [...root.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.closest('[inert]') && (el.offsetParent !== null || el === document.activeElement));
}

export function focusFirstIn(root) {
  if (!root) return;
  // 双 rAF：等一帧让弹窗的 display（含 allow-discrete 过渡）落定，
  // 否则单帧时 offsetParent 可能仍为 null、focusableIn 取不到元素而空转（社区弹窗曾因此开时不聚焦）。
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (root.closest('[hidden], [inert]') || isGlobalShortcutBlocked(null, root)) return;
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
  if (!root.contains(document.activeElement)) {
    ev.preventDefault();
    (ev.shiftKey ? last : first).focus();
  } else if (ev.shiftKey && document.activeElement === first) {
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
  maskTimers.delete(mask);
  configureMask(mask);
  if (trigger instanceof HTMLElement) maskOpeners.set(mask, trigger);
  mask.hidden = false;
  mask.inert = false;
  maskOrder.set(mask, ++openOrder);
  void mask.offsetWidth;
  mask.classList.add('show');
  maskOptions.get(mask)?.onOpen?.(mask, maskOpeners.get(mask));
  focusFirstIn(mask);
}

function closeMaskDirect(mask) {
  if (!mask || mask.hidden || !mask.classList.contains('show')) return;
  clearTimeout(maskTimers.get(mask));
  maskTimers.delete(mask);
  mask.classList.remove('show');
  mask.inert = true;
  maskOptions.get(mask)?.onClose?.(mask, maskOpeners.get(mask));
  const restoreFocus = () => {
    const opener = maskOpeners.get(mask);
    const restore = maskOptions.get(mask)?.restoreFocus;
    if (restore) { restore(mask, opener); return; }
    const top = topInteractionLayer();
    if (top && (!opener || !top.contains(opener))) { focusFirstIn(top); return; }
    /* preventScroll：开启按钮都是顶栏/浮动等视口锚定元素，无需滚动页面去
       "露出"它；顶栏自动隐藏时浏览器的 scroll-into-view 反而会把列表拉走。 */
    if (opener?.isConnected && !opener.closest('[hidden], [inert]')) opener.focus({ preventScroll: true });
  };
  if (prefersReducedMotion()) {
    mask.hidden = true;
    restoreFocus();
    return;
  }
  const timer = setTimeout(() => {
    if (maskTimers.get(mask) === timer && !mask.classList.contains('show')) {
      maskTimers.delete(mask);
      mask.hidden = true;
      restoreFocus();
    }
  }, 240);
  maskTimers.set(mask, timer);
}

export function registerMaskHistory(mask) {
  if (!mask?.id) return;
  configureMask(mask);
  registerHistoryLayer(mask.id, {
    isOpen: () => mask.classList.contains('show'),
    open: () => openMaskDirect(mask),
    close: () => closeMaskDirect(mask),
  });
}

export function openMask(mask, trigger = document.activeElement, { historyMode = 'push' } = {}) {
  if (!mask) return;
  if (historyMode !== 'none') registerMaskHistory(mask);
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
