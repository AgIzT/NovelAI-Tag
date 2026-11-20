import { prefersReducedMotion } from './utils.js';

const animations = new WeakMap();

/* 统一节奏：调用方给的时长按 tokens.css 的五档换算，分档同 tools/check_motion_tokens.py
   （≤160 快、≤240 短、≤380 中、≤560 长、≤1000 情节；100ms 以下和 1 秒以上照原值），
   曲线认出主曲线和回弹曲线就换成 --ease-out / --ease-spring。读不到变量（测试替身等）时用原值。
   custom property 的计算值是未求值的 calc()，所以这里读每档的 *-base 和 --motion-scale 自己乘。 */
const RHYTHM_TIERS = [[160, 'fast'], [240, 'short'], [380, 'medium'], [560, 'long'], [1000, 'story']];
const SPRING_EASINGS = new Set(['cubic-bezier(.34,1.56,.64,1)', 'cubic-bezier(.3,1.5,.5,1)', 'cubic-bezier(.3,1.4,.5,1)']);

function rhythmTiming(duration, easing) {
  const root = document.documentElement;
  if (!root || typeof getComputedStyle !== 'function') return { duration, easing };
  let style;
  try { style = getComputedStyle(root); } catch { return { duration, easing }; }
  if (typeof style?.getPropertyValue !== 'function') return { duration, easing };
  let nextDuration = duration;
  if (typeof duration === 'number' && duration >= 100 && duration <= 1000) {
    const tier = RHYTHM_TIERS.find(([max]) => duration <= max)[1];
    const base = parseFloat(style.getPropertyValue(`--dur-${tier}-base`));
    const scale = parseFloat(style.getPropertyValue('--motion-scale'));
    if (Number.isFinite(base) && Number.isFinite(scale)) nextDuration = base * scale;
  }
  const compact = String(easing).replace(/\s+/g, '');
  const token = compact === 'cubic-bezier(.22,1,.36,1)' ? '--ease-out' : SPRING_EASINGS.has(compact) ? '--ease-spring' : '';
  const nextEasing = (token && style.getPropertyValue(token).trim()) || easing;
  return { duration: nextDuration, easing: nextEasing };
}

/* 数字变化：像里程表一样，从第一位变了的数字起往右都滚进来，变大从下往上、变小从上往下。
   按右端对齐比较，所以 1203 → 1208 只动末位，15673 → 14653 动后四位。
   没有旧值或值没变时只写字，不加动画。动画在样式表（.num-roll），
   减少动态效果和 motion-off 由样式表统一关掉。 */
export function setRollingNumber(element, next, prev) {
  if (!element) return;
  const text = String(next);
  const before = prev === null || prev === undefined ? null : String(prev);
  if (before === null || before === text || typeof document === 'undefined') {
    element.textContent = text;
    return;
  }
  const dir = Number(next) >= Number(prev) ? 1 : -1;
  const shift = text.length - before.length;
  let first = 0;
  while (first < text.length && text[first] === before[first - shift]) first++;
  const digits = [...text.slice(first)].map((ch, i) => {
    const digit = document.createElement('span');
    digit.className = 'num-roll';
    digit.style.setProperty('--roll-dir', String(dir));
    digit.style.setProperty('--roll-i', String(i));
    digit.textContent = ch;
    return digit;
  });
  element.replaceChildren(...(first ? [text.slice(0, first)] : []), ...digits);
}

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
  const merged = { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)', ...options };
  const animation = element.animate(keyframes, {
    ...merged,
    ...rhythmTiming(merged.duration, merged.easing),
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
