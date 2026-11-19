import { animateUi } from './ui-motion.js';

/* 收藏星标的点亮 / 取消反馈——2026-11-19 维护者在 `output/icon-motion-20261119/原型.html` 选定方案 B「迸发」。
   点亮：星形 .2 → 1.28 → .94 → 1 弹出，同时一圈金环扩散、8 颗粒子向外飞散；取消：星形轻缩到 .82 再回来。

   纪律：
     · 只由 toggleFav 的点击路径调用；其它卡片同步、灯箱跟随、撤销恢复都只换形不动
     · 星是按钮的 ::before mask，星形动画挂伪元素：不碰按钮自己的 :active 缩放，也不碰卡片外壳的 transform 槽
     · 金环和粒子挂 <body> 上的 fixed 层——卡片在 .masonry 里，那层有 contain:layout paint，
       挂在卡片内部飞出去会被裁掉（同 copy-fx.js 的芯片）
     · 偏好门控沿用 animateUi：减弱动态效果 / motion-off 下星形动画返回 null，金环粒子也一起不放
     · 同一颗星连点：上一轮的特效层立即撤掉，不叠加 */

const EASE_OUT = 'cubic-bezier(.22,1,.36,1)';
const PARTICLES = 8;
// 金色是收藏的语义色（同 .fav-btn.on），掺强调色跟主题走；不写死紫
const PARTICLE_COLORS = ['#f5b301', 'var(--accent)', '#ffd36b', 'var(--accent)'];
const layers = new WeakMap();

function clearBurst(btn) {
  const layer = layers.get(btn);
  if (!layer) return;
  layers.delete(btn);
  layer.remove();
}

// 卡片角上的星按钮是 44px 热区、星贴顶（align-items:flex-start + padding-top），星心不在按钮正中
function starCenter(btn) {
  const rect = btn.getBoundingClientRect();
  const style = getComputedStyle(btn);
  const x = rect.left + rect.width / 2;
  if (style.alignItems !== 'flex-start') return { x, y: rect.top + rect.height / 2 };
  const starHeight = parseFloat(getComputedStyle(btn, '::before').height) || 16;
  return { x, y: rect.top + (parseFloat(style.paddingTop) || 0) + starHeight / 2 };
}

function part(layer, className) {
  const node = document.createElement('i');
  node.className = className;
  layer.appendChild(node);
  return node;
}

export function playFavoriteBurst(btn) {
  if (!btn) return;
  clearBurst(btn);
  const star = animateUi(btn, [
    { scale: .2 }, { scale: 1.28, offset: .42 }, { scale: .94, offset: .7 }, { scale: 1 },
  ], { duration: 500, easing: 'ease-out', pseudoElement: '::before' });
  if (!star) return;
  const { x, y } = starCenter(btn);
  const layer = document.createElement('div');
  layer.className = 'fav-burst';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.translate = `${x}px ${y}px`;
  const animations = [part(layer, 'fav-burst-ring').animate([
    { scale: .2, opacity: 1, borderWidth: '9px' },
    { scale: 1.55, opacity: 0, borderWidth: '0px' },
  ], { duration: 440, easing: EASE_OUT, fill: 'both' })];
  for (let i = 0; i < PARTICLES; i++) {
    const dot = part(layer, 'fav-burst-dot');
    dot.style.background = PARTICLE_COLORS[i % PARTICLE_COLORS.length];
    const angle = i / PARTICLES * Math.PI * 2 - Math.PI / 2;
    const distance = i % 2 ? 22 : 27;   // 长短交错，散开才不像一个规整的圈
    animations.push(dot.animate([
      { translate: '0 0', scale: 1.2, opacity: 1 },
      { translate: `${(Math.cos(angle) * distance).toFixed(1)}px ${(Math.sin(angle) * distance).toFixed(1)}px`, scale: 0, opacity: 0 },
    ], { duration: 560, delay: 70, easing: EASE_OUT, fill: 'both' }));
  }
  document.body.appendChild(layer);
  layers.set(btn, layer);
  Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
    if (layers.get(btn) === layer) clearBurst(btn);
  });
}

export function playFavoriteRelease(btn) {
  if (!btn) return;
  clearBurst(btn);
  animateUi(btn, [{ scale: 1 }, { scale: .82 }, { scale: 1 }], { duration: 180, pseudoElement: '::before' });
}
