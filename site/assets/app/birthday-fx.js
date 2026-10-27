/* 所长生日的小动效（birthday.js 判定当天才用得上）：
   - 礼花：一点处「噗」地冒一圈气，喷出一簇纸屑，先冲出去再打着转落下、淡出；节点用完即删。
   - 生日帽、彩旗：纯标记 + CSS（styles.css「所长生日」段），这里只给 HTML。
   礼花只在完整动效（html[data-motion=full]）时放；减弱动效 / 关动效时一律不放，静态装饰照常显示。 */

const COLORS = ['var(--bday)', 'var(--accent)', '#ff8fb1', '#57c3ef', '#7fcf78', '#b597ff'];
const SHAPES = ['is-rect', 'is-dot', 'is-strip'];

export function canCelebrate() {
  return document.documentElement.dataset.motion === 'full';
}

/** 在 layer（定位元素）里的 (x, y) 喷一簇纸屑。angle 以度计：0 朝右、-90 朝上；reach 冲出距离，fall 之后下坠距离。 */
export function burstConfetti(layer, x, y, { angle = -90, spread = 70, count = 14, reach = 110, fall = 100 } = {}) {
  if (!layer || !canCelebrate()) return;
  const drop = node => () => node.remove();
  const puff = document.createElement('i');
  puff.className = 'confetti-puff';
  puff.style.left = `${x}px`;
  puff.style.top = `${y}px`;
  layer.append(puff);
  puff.animate([{ scale: 0.2, opacity: 0.85 }, { scale: 1.7, opacity: 0 }],
    { duration: 340, easing: 'cubic-bezier(.2,.7,.3,1)' }).finished.then(drop(puff), drop(puff));
  const hue = Math.floor(Math.random() * COLORS.length);
  for (let i = 0; i < count; i++) {
    const bit = document.createElement('i');
    bit.className = `confetti-bit ${SHAPES[i % SHAPES.length]}`;
    bit.style.left = `${x}px`;
    bit.style.top = `${y}px`;
    bit.style.background = COLORS[(hue + i) % COLORS.length];
    layer.append(bit);
    const a = (angle + (Math.random() - 0.5) * spread) * Math.PI / 180;
    const r = reach * (0.5 + Math.random() * 0.5);
    const dx = Math.cos(a) * r;
    const dy = Math.sin(a) * r;
    const spin = (Math.random() - 0.5) * 760;
    const drift = (Math.random() - 0.5) * 36;
    bit.animate([
      { transform: 'translate(-50%,-50%) rotate(0deg) scale(.4)', opacity: 1, easing: 'cubic-bezier(.12,.75,.3,1)' },
      { transform: `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px)) rotate(${spin * 0.45}deg) scale(1)`, opacity: 1, offset: 0.34, easing: 'cubic-bezier(.4,0,.7,.55)' },
      { transform: `translate(calc(-50% + ${dx * 1.15 + drift}px),calc(-50% + ${dy + fall}px)) rotate(${spin}deg) scale(.85)`, opacity: 0 },
    ], { duration: 1000 + Math.random() * 520, delay: Math.random() * 50, fill: 'backwards' }).finished.then(drop(bit), drop(bit));
  }
}

/** 铺满视口的礼花层，压在弹层之上、开场幕之下；常驻 body，空着没有开销。 */
export function viewportConfettiLayer() {
  let layer = document.querySelector('.confetti-layer.is-viewport');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'confetti-layer is-viewport';
    layer.setAttribute('aria-hidden', 'true');
    document.body.append(layer);
  }
  return layer;
}

/** 元素里的礼花层（横幅用）：跟着元素裁切，元素重建时一起消失。 */
export function innerConfettiLayer(host) {
  let layer = host.querySelector(':scope > .confetti-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'confetti-layer';
    layer.setAttribute('aria-hidden', 'true');
    host.append(layer);
  }
  return layer;
}

/** 生日帽：条纹圆锥 + 顶上一颗绒球，CSS 负责摆到头像头顶 */
export const PARTY_HAT_HTML =
  '<span class="bd-hat" aria-hidden="true"><i class="bd-hat-cone"></i><i class="bd-hat-pom"></i></span>';

/** 彩旗：一根下垂的细绳挂七面小三角旗，每面旗绕绳上的挂点轻轻摆 */
export function buntingSVG() {
  const flags = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const x = 2 + t * 216;                       // 绳子是 M2 2 Q110 30 218 2：x 随 t 线性，y = 2 + 56t(1−t)
    const y = 2 + 56 * t * (1 - t);
    const color = COLORS[i % COLORS.length];
    flags.push(`<path class="bb-flag" style="--i:${i};fill:${color}" d="M${(x - 9).toFixed(1)} ${y.toFixed(1)}L${(x + 9).toFixed(1)} ${y.toFixed(1)}L${x.toFixed(1)} ${(y + 15).toFixed(1)}Z"/>`);
  }
  return '<svg class="banner-bunting" viewBox="0 0 220 34" aria-hidden="true">' +
    '<path class="bb-string" d="M2 2Q110 30 218 2"/>' + flags.join('') + '</svg>';
}
