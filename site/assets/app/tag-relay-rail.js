/* 中转站侧栏的外壳：开合、三种形态、页签切换、脏标记。
   内容由各分区模块渲染，经 setRailPaneRenderers 注入——外壳不认识它们，
   所以分区可以反过来 import 本模块（拿 showRailTab）而不成环。

   三种形态：
   - 停靠（>1100px）：走 .layout 的 flex 把瀑布流挤窄。**不是浮层**，
     所以不进 Esc 链、不算 overlayOpen、不注册历史层——它是页面家具，和左边目录栏一个性质。
   - 抽屉（600~1100px）：固定定位 + 遮罩，是浮层。
   - 底部 sheet（≤600px）：同样是浮层。 */

import { registerHistoryLayer, closeHistoryLayer, forgetHistoryLayer, openHistoryLayer } from './browser-history.js';
import { trapFocus } from './modal.js';

const RAIL_STORAGE_KEY = 'fadian-tag-relay-rail';
const RAIL_LAYER_ID = 'tag-relay-rail';
/* 断点与 tag-relay.css 里的 @media 必须对齐，否则会出现「CSS 认为是浮层、JS 认为是停靠」的错位 */
const overlayQuery = window.matchMedia('(max-width:1100px)');

let rail = null;
let backdrop = null;
let bound = false;
let activeTab = 'warehouse';
let lastTrigger = null;
const renderers = new Map();
const dirty = new Set();

const isClosed = () => !rail || rail.classList.contains('closed');

export function isRelayRailOpen() {
  return !isClosed();
}

/* 只有浮层形态才算「模态」。ui.js 的 Esc 链与 overlayOpen() 都问这个函数，
   停靠态返回 false —— 否则桌面默认状态下 ? / g / / 三个快捷键会被永久吃掉。 */
export function isRelayRailModal() {
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

function flush() {
  if (isClosed()) return;
  for (const name of [...dirty]) {
    if (name !== activeTab) continue;
    renderers.get(name)?.();
    dirty.delete(name);
  }
  /* 当前页签之外的脏标记留着，等切过去再画 */
}

function setOpenDirect(open) {
  if (!rail) return;
  rail.classList.toggle('closed', !open);
  /* 收起不能只是视觉隐藏：不加 inert，Tab 仍会走进看不见的按钮和输入框 */
  rail.inert = !open;
  rail.setAttribute('aria-hidden', String(!open));
  try { localStorage.setItem(RAIL_STORAGE_KEY, open ? 'open' : 'closed'); } catch { /* 隐私模式写不了就算了 */ }
  syncChrome();
  if (open) {
    dirty.add(activeTab);
    flush();
    /* 浮层态是模态语义：焦点必须进去，否则读屏与键盘用户还停在页面底下 */
    if (overlayQuery.matches) {
      lastTrigger = document.activeElement;
      (rail.querySelector('[data-rail-tab][aria-selected="true"]') || rail).focus?.();
    }
  } else if (lastTrigger?.isConnected) {
    lastTrigger.focus?.();
    lastTrigger = null;
  }
}

export function openRelayRail() {
  if (!isClosed()) return;
  setOpenDirect(true);
  if (overlayQuery.matches) openHistoryLayer(RAIL_LAYER_ID);
}

export function closeRelayRail() {
  if (isClosed()) return;
  if (overlayQuery.matches && closeHistoryLayer(RAIL_LAYER_ID)) return;
  setOpenDirect(false);
  forgetHistoryLayer(RAIL_LAYER_ID);
}

export function toggleRelayRail() {
  if (isClosed()) openRelayRail();
  else closeRelayRail();
}

export function showRailTab(name) {
  /* 只要有对应的面板就切；渲染器还没注册（分区尚未接上）时切过去是空面板，不是死按钮 */
  if (!rail || !rail.querySelector(`[data-rail-pane="${name}"]`)) return;
  activeTab = name;
  for (const pane of rail.querySelectorAll('[data-rail-pane]')) {
    const on = pane.dataset.railPane === name;
    pane.classList.toggle('is-active', on);
    pane.hidden = !on;
  }
  for (const tab of rail.querySelectorAll('[data-rail-tab]')) {
    const on = tab.dataset.railTab === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  dirty.add(name);
  flush();
}

/* 抛入动效的落点：栏关着就飞浮钮，开着就飞栏头那个计数——两者都是「条数」的所在，
   用户的视线本来就会追过去。 */
export function relayTossTarget() {
  const button = document.querySelector('#tagRelayBtn');
  if (!rail || isClosed()) return button;
  return rail.querySelector('#tagRelayRailCount') || button;
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
  document.querySelector('#tagRelayBtn')?.addEventListener('click', toggleRelayRail);
  document.querySelector('#tagRelayMenuLink')?.addEventListener('click', () => {
    document.querySelector('#moreBtn')?.click();   // 更多菜单点完自己收起，别把栏压在它下面
    openRelayRail();
  });
  document.querySelector('#tagRelayRailClose')?.addEventListener('click', closeRelayRail);
  backdrop?.addEventListener('click', closeRelayRail);

  rail.addEventListener('click', event => {
    const tab = event.target.closest('[data-rail-tab]');
    if (tab) showRailTab(tab.dataset.railTab);
  });

  rail.querySelector('.tag-relay-rail-tabs')?.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...rail.querySelectorAll('[data-rail-tab]')];
    if (!tabs.length) return;
    const current = Math.max(0, tabs.indexOf(document.activeElement));
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    showRailTab(tabs[next].dataset.railTab);
    tabs[next].focus();
  });

  /* Esc 由内向外：先关栏内的浮层（后续分区会自己 stopPropagation），
     最外层只在浮层形态下关栏；停靠态什么都不做，让事件继续冒泡给 ui.js 的链子。 */
  rail.addEventListener('keydown', event => {
    if (isRelayRailModal()) trapFocus(event, rail);
    if (event.key !== 'Escape') return;
    if (!isRelayRailModal()) return;
    event.stopPropagation();
    closeRelayRail();
  });

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
        (rail.querySelector('[data-rail-tab][aria-selected="true"]') || rail).focus?.();
      }
    } else {
      forgetHistoryLayer(RAIL_LAYER_ID);
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
