/* 中转站侧栏的外壳：开合、三种形态、页签切换、脏标记。
   内容由各分区模块渲染，经 setRailPaneRenderers 注入——外壳不认识它们，
   所以分区可以反过来 import { prefersReducedMotion } from './utils.js';
import 本模块（拿 showRailTab）而不成环。

   三种形态：
   - 停靠（>1240px）：走 .layout 的 flex 把瀑布流挤窄。**不是浮层**，
     所以不进 Esc 链、不算 overlayOpen、不注册历史层——它是页面家具，和左边目录栏一个性质。
   - 抽屉（600~1240px）：固定定位 + 遮罩，是浮层。
   - 底部 sheet（≤600px）：同样是浮层。 */

import { prefersReducedMotion } from './utils.js';
import { registerHistoryLayer, closeHistoryLayer, forgetHistoryLayer, openHistoryLayer } from './browser-history.js';
import { trapFocus } from './modal.js';
import { cancelRelayAction } from './tag-relay-action.js';

const RAIL_STORAGE_KEY = 'fadian-tag-relay-rail';
const RAIL_LAYER_ID = 'tag-relay-rail';
/* 断点与 tag-relay.css 里的 @media 必须对齐，否则会出现「CSS 认为是浮层、JS 认为是停靠」的错位 */
const overlayQuery = window.matchMedia('(max-width:1240px)');

let rail = null;
let backdrop = null;
let bound = false;
let activeTab = 'warehouse';
let lastTrigger = null;
/* 只在「灯箱压在栏上面」的那一次 Esc 同步派发期间为 true，见 bindRail 里的捕获监听 */
let escYieldsToTopLayer = false;
const renderers = new Map();
const dirty = new Set();

const isClosed = () => !rail || rail.classList.contains('closed');

export function isRelayRailOpen() {
  return !isClosed();
}

/* 只有浮层形态才算「模态」。ui.js 的 Esc 链与 overlayOpen() 都问这个函数，
   停靠态返回 false —— 否则桌面默认状态下 ? / g / / 三个快捷键会被永久吃掉。
   ⚠ escYieldsToTopLayer 只在灯箱压在栏上面的那一次 Esc 派发里为 true，
   让 ui.js 那条「命中就关栏」的分支自己落空，别把灯箱和抽屉一次关两层。 */
export function isRelayRailModal() {
  if (escYieldsToTopLayer) return false;
  return overlayQuery.matches && !isClosed();
}

function syncChrome() {
  const open = !isClosed();
  const modal = open && overlayQuery.matches;
  document.body.classList.toggle('rail-docked', open && !overlayQuery.matches);
  if (modal) {
    rail.setAttribute('role', 'dialog');
    rail.setAttribute('aria-modal', 'true');
  } else {
    rail.removeAttribute('role');
    rail.removeAttribute('aria-modal');
  }
  const button = document.querySelector('#tagRelayBtn');
  if (button) button.setAttribute('aria-expanded', String(open));
}

/* 素材与编排现在同屏，没有「当前页签」这回事了：脏了哪块就画哪块，两块都可能同时脏。
   ⚠ 收栏时仍然整体跳过（isClosed），开栏那一刻由 setOpenDirect 补一次全量。 */
function flush() {
  if (isClosed()) return;
  for (const name of [...dirty]) {
    renderers.get(name)?.();
    dirty.delete(name);
  }
}

function setOpenDirect(open, trigger = null) {
  if (!rail) return;
  /* ⚠ inert 会立刻把焦点踢到 <body>，所以「关栏前焦点在不在栏里」必须先算好 */
  const heldFocus = !open && rail.contains(document.activeElement);
  rail.classList.toggle('closed', !open);
  /* 收起不能只是视觉隐藏：不加 inert，Tab 仍会走进看不见的按钮和输入框 */
  rail.inert = !open;
  rail.setAttribute('aria-hidden', String(!open));
  /* ⚠ 这条偏好只描述「桌面停靠态要不要常驻」（读取处也带着 !overlayQuery.matches）。
     浮层态的开合是一次性动作，跟着写就会让手机上开一次再关，把桌面端的常驻偏好冲掉。 */
  if (!overlayQuery.matches) {
    try { localStorage.setItem(RAIL_STORAGE_KEY, open ? 'open' : 'closed'); } catch { /* 隐私模式写不了就算了 */ }
  }
  syncChrome();
  if (open) {
    dirty.add('warehouse');
    dirty.add('compose');
    flush();
    /* 触发者一律记下来（停靠态也记）：停靠态收栏后同样要有地方还焦点，
       否则 Tab 进栏、按 × 收起，焦点掉回 <body>，下一次 Tab 从文档最开头重来。 */
    const fallback = document.activeElement;
    lastTrigger = trigger instanceof HTMLElement
      ? trigger
      : (fallback instanceof HTMLElement && fallback !== document.body ? fallback : null);
    /* 浮层态是模态语义：焦点必须进去，否则读屏与键盘用户还停在页面底下 */
    if (overlayQuery.matches) {
      (rail.querySelector('#relayPlanPickerBtn') || rail.querySelector('button') || rail).focus?.();
    }
  } else {
    /* 没走完的确认 / 命名条不能留到下一次打开——「清空最近复制」「删除方案」
       这类 danger 条尤其危险：用户以为已经放弃，回来随手一点就真执行了。 */
    cancelRelayAction();
    /* 焦点原本不在栏里就别抢回来；栏是用户主动 Tab 进去的才需要还 */
    if (heldFocus) {
      const back = lastTrigger?.isConnected ? lastTrigger : document.querySelector('#tagRelayBtn');
      back?.focus?.({ preventScroll: true });
    }
    lastTrigger = null;
  }
}

export function openRelayRail(trigger = null) {
  if (!isClosed()) return;
  setOpenDirect(true, trigger);
  if (overlayQuery.matches) openHistoryLayer(RAIL_LAYER_ID);
}

export function closeRelayRail() {
  if (isClosed()) return;
  if (overlayQuery.matches && closeHistoryLayer(RAIL_LAYER_ID)) return;
  setOpenDirect(false);
  forgetHistoryLayer(RAIL_LAYER_ID);
}

export function toggleRelayRail(trigger = null) {
  if (isClosed()) openRelayRail(trigger);
  else closeRelayRail();
}

/* 页签没了，但这个名字还留着：调用方（浮钮、抛入动效）表达的是「让我看到某个分区」，
   同屏之后这件事就是把它滚进视野 + 保证它是新的，而不是切显隐。 */
export function showRailTab(name) {
  const pane = rail?.querySelector(`[data-rail-pane="${name}"]`);
  if (!pane) return;
  activeTab = name;
  dirty.add(name);
  flush();
  pane.scrollIntoView?.({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

/* 抛入动效的落点：栏关着就飞最上方的中转浮钮；栏开着则飞「最近复制」页签，
   因为新素材实际落在这里。不要再飞栏头总计数——那会把“收入仓库”误画成“加入方案”。 */
export function relayTossTarget() {
  const button = document.querySelector('#tagRelayBtn');
  if (!rail || isClosed()) return button;
  return rail.querySelector('#relaySourceTabInbox')
    || rail.querySelector('#tagRelayPaneWarehouse')
    || button;
}

export function railPaneRoot(name) {
  return rail?.querySelector(`[data-rail-pane="${name}"]`) || null;
}

export function setRailPaneRenderers(map) {
  for (const [name, render] of Object.entries(map)) {
    if (typeof render === 'function') renderers.set(name, render);
  }
}

/* store 广播过来的 changed 描述符 → 哪个页签脏了。
   入库现在挂在复制这条最高频路径上，栏关着时不该重建 50 张带图卡片，
   所以只记账、等打开或切过去再画。 */
export function markRailDirty(changed) {
  if (changed === 'inbox' || changed === 'all') dirty.add('warehouse');
  if (changed === 'plan' || changed === 'history' || changed === 'all') dirty.add('compose');
  flush();
}

function bindRail() {
  document.querySelector('#tagRelayBtn')?.addEventListener('click', event => toggleRelayRail(event.currentTarget));
  document.querySelector('#tagRelayMenuLink')?.addEventListener('click', () => {
    const moreButton = document.querySelector('#moreBtn');
    moreButton?.click();   // 更多菜单点完自己收起，别把栏压在它下面
    openRelayRail(moreButton);
  });
  document.querySelector('#tagRelayRailClose')?.addEventListener('click', closeRelayRail);
  backdrop?.addEventListener('click', closeRelayRail);

  rail.addEventListener('click', event => {
    const tab = event.target.closest('[data-rail-tab]');
    if (tab) showRailTab(tab.dataset.railTab);
  });

  /* Esc 由内向外。Inspector / 历史的处理器也绑在 rail 上，而且 compose 比本模块晚初始化；
     stopPropagation 阻止不了同一节点上已经排在前面的监听。因此外壳必须先看 DOM 状态主动
     让出这一击，不能指望内层事后截断，否则抽屉 / sheet 会一键把面板和整栏一起关掉。 */
  const hasOpenInnerLayer = () => [
    '#relayPlanList',
    '#relayPlanMenu',
    '#relayCopyHistory',
    '#relayInspector',
  ].some(selector => {
    const layer = rail.querySelector(selector);
    return layer && !layer.hidden;
  });
  rail.addEventListener('keydown', event => {
    if (isRelayRailModal()) trapFocus(event, rail);
    if (event.key !== 'Escape') return;
    const inlineAction = rail.querySelector('#relayInlineAction');
    if (inlineAction && !inlineAction.hidden) {
      event.preventDefault();
      event.stopPropagation();
      cancelRelayAction();
      return;
    }
    if (!isRelayRailModal()) return;
    if (hasOpenInnerLayer()) return;
    event.stopPropagation();
    closeRelayRail();
  });

  /* ⚠ Esc 一次只该关一层。ui.js 的 window keydown 命中 isRelayRailModal() 后只有
     `closeRelayRail(); return;`，既没有 preventDefault 也没有 stopImmediatePropagation，
     而 lightbox.js 那个监听同样挂在 window 上、照样会跑：1240px 以下开着抽屉再开灯箱，
     一次 Esc 把灯箱和抽屉一起关掉。
     灯箱（z-index 80）本就压在栏（68）上面，这一下应当只关灯箱。捕获阶段必然早于
     window 上的冒泡监听，所以在这里给本轮 Esc 打一个「让给上层」的标记，
     让 ui.js 那条分支自己落空。标记只活在这一次同步派发里：keydown 的所有监听同属
     一个任务，微任务必然排在它们之后。 */
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    escYieldsToTopLayer = false;
    if (!overlayQuery.matches || isClosed()) return;
    const lightbox = document.querySelector('#lightbox');
    if (!lightbox || lightbox.hidden) return;
    escYieldsToTopLayer = true;
    queueMicrotask(() => { escYieldsToTopLayer = false; });
  }, true);

  registerHistoryLayer(RAIL_LAYER_ID, {
    isOpen: () => isRelayRailModal(),
    open: () => setOpenDirect(true),
    close: () => setOpenDirect(false),
  });

  /* 形态切换（拖窗口、转屏）：停靠 ⇄ 浮层的历史层归属会变，先把旧账清掉 */
  overlayQuery.addEventListener('change', () => {
    if (overlayQuery.matches) {
      /* 停靠 → 浮层：栏若开着，此刻才变成浮层，必须补注册历史层，
         否则用户按返回键会直接离开页面而不是先关栏。 */
      if (!isClosed()) openHistoryLayer(RAIL_LAYER_ID);
      if (!isClosed() && !rail.contains(document.activeElement)) {
        lastTrigger = document.activeElement;
        (rail.querySelector('#relayPlanPickerBtn') || rail.querySelector('button') || rail).focus?.();
      }
    } else {
      /* 浮层 → 停靠：开栏时 openHistoryLayer 是 push 出来的一条真记录，
         ⚠ 只 forget（replaceState 清空 layers）不会让那条记录消失，用户按返回键
         第一下「没反应」，来回拖窗口跨断点还会一直攒。closeHistoryLayer 在它确实是
         栈顶时真退一格（此时 isRelayRailModal() 已为 false，回退不会顺手把栏关掉），
         不是栈顶才退化成 forget。 */
      closeHistoryLayer(RAIL_LAYER_ID);
    }
    syncChrome();
  });
}

export function setupTagRelayRail() {
  rail = document.querySelector('#tagRelayRail');
  backdrop = document.querySelector('#tagRelayRailBackdrop');
  if (!rail) return { open: () => {}, showTab: () => {} };
  if (!bound) {
    bound = true;
    bindRail();
  }
  /* 默认收起：宽屏也一样。中转站是「要用的时候才展开」的东西，
     一进站就占掉 440px 会让第一次来的人莫名其妙。 */
  let saved = null;
  try { saved = localStorage.getItem(RAIL_STORAGE_KEY); } catch { saved = null; }
  const shouldOpen = saved === 'open' && !overlayQuery.matches;
  rail.classList.toggle('closed', !shouldOpen);
  rail.inert = !shouldOpen;
  rail.setAttribute('aria-hidden', String(!shouldOpen));
  syncChrome();
  return { open: openRelayRail, close: closeRelayRail, showTab: showRailTab };
}
