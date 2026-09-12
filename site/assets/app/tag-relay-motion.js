import { animateUi, cancelUiMotion } from './ui-motion.js';
import { prefersReducedMotion } from './utils.js';

const lists = new WeakMap();
const exits = new Set();
const motions = new Map();

function playMotion(node, frames, options) {
  const animation = animateUi(node, frames, options);
  if (!animation) return;
  motions.set(node, animation);
  const finish = () => { if (motions.get(node) === animation) motions.delete(node); };
  animation.finished.then(finish, finish);
}

function motionAllowed(list) {
  return Boolean(list?.animate && list.isConnected
    && !list.closest('.closed') && document.visibilityState !== 'hidden'
    && !prefersReducedMotion() && !document.documentElement.classList.contains('motion-off'));
}

export function settleRelayMotion() {
  for (const finish of [...exits]) finish();
  for (const node of motions.keys()) cancelUiMotion(node);
  motions.clear();
}

/* 移除的节点抬进一层残影里播退场：它 inert + aria-hidden，不会再被点到或读到；
   分级刷新要清场时 settleRelayMotion 会同步把整层删掉。 */
function leaveItem(node, rect, listRect, rail) {
  const railRect = rail.getBoundingClientRect();
  const layer = document.createElement('div');
  layer.className = 'tag-relay-motion-exit';
  layer.inert = true;
  layer.setAttribute('aria-hidden', 'true');
  Object.assign(layer.style, {
    left: `${listRect.left - railRect.left - rail.clientLeft}px`,
    top: `${listRect.top - railRect.top - rail.clientTop}px`,
    width: `${listRect.width}px`, height: `${listRect.height}px`,
  });
  Object.assign(node.style, {
    position: 'absolute', left: `${rect.left - listRect.left}px`, top: `${rect.top - listRect.top}px`,
    width: `${rect.width}px`, height: `${rect.height}px`, margin: '0', pointerEvents: 'none',
  });
  node.classList.remove('is-dragging');
  layer.append(node);
  rail.append(layer);
  let timer;
  const finish = () => {
    exits.delete(finish);
    clearTimeout(timer);
    cancelUiMotion(node);
    layer.remove();
  };
  exits.add(finish);
  const animation = animateUi(node, [{ opacity: .7, scale: '1' }, { opacity: 0, scale: '.9' }], { duration: 150 });
  if (!animation) { finish(); return; }
  timer = setTimeout(finish, 230);
  animation.finished.then(finish, finish);
}

/* 先量当前**视觉**位置再换内容：上一轮 FLIP 没播完就被打断时，
   新动画才能从它此刻停的地方接着走，而不是先跳回布局位再滑一次。 */
export function renderRelayList(list, nodes, { group = '', motion = true } = {}) {
  const previous = lists.get(list);
  const moving = motion && motionAllowed(list);
  const sameGroup = previous?.group === group;
  const before = new Map();
  const listRect = moving ? list.getBoundingClientRect() : null;
  if (moving && sameGroup) {
    for (const node of previous.nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom > listRect.top && rect.top < listRect.bottom) {
        const style = getComputedStyle(node);
        before.set(node.dataset.relayMotionKey, { node, rect, opacity: Number(style.opacity), filter: style.filter });
      }
    }
  }
  for (const node of previous?.nodes || []) cancelUiMotion(node);
  settleRelayMotion();
  list.replaceChildren(...nodes);
  list.hidden = nodes.length === 0;
  lists.set(list, { group, nodes });
  if (!moving) return;
  const origin = list.getBoundingClientRect();
  const positions = nodes.map(node => node.getBoundingClientRect());
  const keys = new Set(nodes.map(node => node.dataset.relayMotionKey));
  const rail = list.closest('.tag-relay-rail');
  if (rail && sameGroup) {
    for (const [key, old] of before) {
      if (!keys.has(key)) leaveItem(old.node, old.rect, listRect, rail);
    }
  }
  nodes.forEach((node, index) => {
    const rect = positions[index];
    if (rect.bottom <= origin.top || rect.top >= origin.bottom) return;
    const snapshot = before.get(node.dataset.relayMotionKey);
    const old = snapshot?.rect;
    const x = old ? old.left - rect.left : 0;
    const y = old ? old.top - rect.top : 8;
    const opacity = node.classList.contains('is-off') ? .5 : 1;
    const filter = node.classList.contains('is-off') ? 'grayscale(1)' : 'grayscale(0)';
    if (old && Math.abs(x) < .5 && Math.abs(y) < .5 && Math.abs(snapshot.opacity - opacity) < .01) return;
    playMotion(node, [
      { translate: `${x}px ${y}px`, opacity: snapshot?.opacity ?? 0, filter: snapshot?.filter || filter, scale: old ? '1' : '.96' },
      { translate: '0 0', opacity, filter, scale: '1' },
    ], { duration: old ? 260 : 210 });
  });
}
