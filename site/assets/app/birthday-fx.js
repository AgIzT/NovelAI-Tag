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
  // 连点时纸屑还在飞的节点太多就先不喷，免得把页面拖慢
  if (!layer || !canCelebrate() || layer.childElementCount > 220) return;
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

/* 送祝福的连击：上一下之后 COMBO_GAP_MS 内接着点算一串。
   - 每一下：被点的头像 / 生日签弹一下，喷一小簇纸屑；第一下冒「+1」，第二下起换成一枚「×N 连击」章，每下鼓一鼓，停手后淡出。
   - 连到 COMBO_MILESTONES 那几下：两侧大放一次（调用方的 big），章闪一圈光。
   - 连得越久章越亮：10 起烛光色底，30 起渐变底，99 起彩虹字（styles.css 的 data-tier）。
   - 本页送满后章上的小字改成「已送满」，照样能连。
   动效关闭时不弹、不喷、不飘，只把章上的数字换掉。 */
export const COMBO_MILESTONES = [10, 30, 66, 99, 233, 520, 666, 999];
const COMBO_GAP_MS = 700;
const COMBO_HOLD_MS = 900;
const BURST_GAP_MS = 90;

const comboTier = n => (n >= 99 ? 4 : n >= 30 ? 3 : n >= 10 ? 2 : 1);

function floatPlus(layer, x, y) {
  const plus = document.createElement('span');
  plus.className = 'wish-plus';
  plus.textContent = '+1';
  plus.style.left = `${x}px`;
  plus.style.top = `${y}px`;
  layer.append(plus);
  plus.animate([
    { translate: '-50% -60%', opacity: 0, scale: 0.6 },
    { translate: '-50% -110%', opacity: 1, scale: 1, offset: 0.25 },
    { translate: '-50% -210%', opacity: 0, scale: 1 },
  ], { duration: 760, easing: 'cubic-bezier(.2,.7,.3,1)' }).finished.then(() => plus.remove(), () => plus.remove());
}

/** 每个入口一套连击状态。hit({ target, layer, x, y, side, counted, full, burst, big })：
    (x, y) 是连击章的落点（layer 坐标）——默认是章的底边中点；side 时是章的左边中点（横幅里挂在生日签右边，别压书名） */
export function createWishCombo() {
  let n = 0;
  let last = 0;
  let lastBurst = 0;
  let badge = null;
  let fade = 0;
  return ({ target, layer, x, y, side = false, counted = true, full = false, burst, big }) => {
    const now = performance.now();
    n = now - last <= COMBO_GAP_MS ? n + 1 : 1;
    last = now;
    const motion = canCelebrate();
    const milestone = COMBO_MILESTONES.includes(n);
    if (motion) {
      target.animate([{ scale: 1 }, { scale: 0.86 }, { scale: 1.08 }, { scale: 1 }],
        { duration: 280, easing: 'cubic-bezier(.3,.7,.4,1)', composite: 'replace' });
      if (milestone) big?.();
      else if (now - lastBurst >= BURST_GAP_MS) { lastBurst = now; burst?.(); }
    }
    window.clearTimeout(fade);
    if (n === 1) {
      badge?.remove();
      badge = null;
      if (motion && counted) floatPlus(layer, x, y);
      return;
    }
    if (!badge || !badge.isConnected || badge.parentElement !== layer) {
      badge?.remove();
      badge = document.createElement('span');
      badge.className = 'wish-combo';
      badge.innerHTML = '<b></b><small></small>';
      layer.append(badge);
    }
    badge.classList.toggle('is-side', side);
    badge.style.left = `${x}px`;
    badge.style.top = `${y}px`;
    badge.dataset.tier = comboTier(n);
    badge.firstChild.textContent = `×${n}`;
    badge.lastChild.textContent = full ? '已送满' : '连击';
    if (motion) {
      badge.animate([{ scale: milestone ? 1.6 : 1.22 }, { scale: 1 }], { duration: milestone ? 420 : 200, easing: 'cubic-bezier(.3,1.4,.5,1)' });
      if (milestone) {
        badge.classList.remove('is-milestone');
        void badge.offsetWidth;
        badge.classList.add('is-milestone');
      }
    }
    const current = badge;
    fade = window.setTimeout(() => {
      if (badge === current) badge = null;
      if (!motion) { current.remove(); return; }
      current.animate([{ opacity: 1 }, { opacity: 0, translate: side ? '10px -50%' : '-50% -130%' }],
        { duration: 280, easing: 'ease-in', fill: 'forwards' })
        .finished.then(() => current.remove(), () => current.remove());
    }, COMBO_HOLD_MS);
  };
}

/** 生日帽翻个跟头：连击到整数关时调 */
export function flipPartyHat(avatar) {
  if (!canCelebrate()) return;
  avatar?.querySelector('.bd-hat')?.animate([
    { translate: '0 0', rotate: '-14deg' },
    { translate: '0 -38%', rotate: '200deg', offset: 0.55 },
    { translate: '0 0', rotate: '346deg' },
  ], { duration: 620, easing: 'cubic-bezier(.3,.7,.4,1)' });
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
