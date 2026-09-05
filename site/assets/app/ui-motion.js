import { prefersReducedMotion } from './utils.js';

const animations = new WeakMap();

export function cancelUiMotion(element) {
  const animation = element && animations.get(element);
  if (!animation) return;
  animations.delete(element);
  animation.cancel();
}

// 只管理本模块启动的动画，结束即交还普通样式；快速操作时取消旧一轮。
export function animateUi(element, keyframes, options = {}) {
  if (!element) return null;
  cancelUiMotion(element);
  if (!element.animate || prefersReducedMotion() || document.documentElement.classList.contains('motion-off')) return null;
  const animation = element.animate(keyframes, {
    duration: 220,
    easing: 'cubic-bezier(.22,1,.36,1)',
    ...options,
    fill: 'none',
  });
  animations.set(element, animation);
  const release = () => {
    if (animations.get(element) !== animation) return;
    animations.delete(element);
    animation.cancel();
  };
  animation.finished.then(release, release);
  return animation;
}
