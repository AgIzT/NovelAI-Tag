/* 中转站在主站里的接线层：浮钮计数 + 侧栏各分区的装配。
   状态与持久化在 tag-relay-store.js，词条→快照的转换在 tag-relay-snapshot.js，
   纯计算在 tag-relay-core.js，侧栏外壳在 tag-relay-rail.js。

   入库是「复制即入库」（见 copy.js 里 recordCopiedEntry 的调用点），
   卡片和灯箱上没有手动入站按钮——卡片因此保持原样，不会和收藏星混淆。 */

import { toast } from './feedback.js';
import { clearInbox, removeInboxEntry } from './tag-relay-core.js';
import {
  markRailDirty,
  railPaneRoot,
  setRailPaneRenderers,
  setupTagRelayRail,
  showRailTab,
} from './tag-relay-rail.js';
import {
  addSourceToPlan,
  beginSourceDrag,
  endSourceDrag,
  renderCompose,
  setupRelayCompose,
} from './tag-relay-compose.js';
import { snapshotLocked } from './tag-relay-snapshot.js';
import { commitRelay, relayInbox, relayState, setupRelayStore, subscribeRelay } from './tag-relay-store.js';

let relayBound = false;
let warehouseRoot = null;

function placeholder(title = '') {
  const node = document.createElement('span');
  node.className = 'tag-relay-quick-thumb is-placeholder';
  node.textContent = String(title || 'T').trim().slice(0, 1).toUpperCase() || 'T';
  return node;
}

function sourceItem(entry) {
  const locked = snapshotLocked(entry);
  const item = document.createElement('article');
  item.className = 'tag-relay-quick-item';

  if (!locked && entry.image) {
    const image = document.createElement('img');
    image.className = 'tag-relay-quick-thumb';
    image.src = entry.image;
    image.alt = '';
    image.loading = 'lazy';
    image.onerror = () => image.replaceWith(placeholder(entry.title));
    item.append(image);
  } else {
    item.append(placeholder(locked ? '锁' : entry.title));
  }

  const copy = document.createElement('div');
  copy.className = 'tag-relay-quick-copy';
  const title = document.createElement('b');
  title.textContent = locked ? '已锁定的成人内容' : entry.title;
  const prompt = document.createElement('small');
  prompt.textContent = locked
    ? '重新开启对应内容权限后可继续使用'
    : (entry.prompt || entry.negative || entry.path?.join?.(' › ') || entry.book || '暂存词条');
  copy.append(title, prompt);

  const actions = document.createElement('div');
  actions.className = 'tag-relay-item-actions';
  if (!locked) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'tag-relay-item-add';
    add.textContent = '加入方案';
    add.onclick = () => { addSourceToPlan(entry); showRailTab('compose'); };
    actions.append(add);
    if (String(entry.negative || '').trim()) {
      const negOnly = document.createElement('button');
      negOnly.type = 'button';
      negOnly.className = 'tag-relay-item-add is-neg';
      negOnly.textContent = '只加负向';
      negOnly.title = '只把负向内容加入方案';
      negOnly.onclick = () => { addSourceToPlan(entry, { negativeOnly: true }); showRailTab('compose'); };
      actions.append(negOnly);
    }
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'tag-relay-quick-remove';
  remove.textContent = '×';
  remove.title = `移除${entry.title}`;
  remove.setAttribute('aria-label', `从中转站移除${entry.title}`);
  remove.onclick = () => {
    const result = commitRelay(next => removeInboxEntry(next, entry.key), { changed: 'inbox' });
    if (!result.ok) return;
    toast(`已移出中转站：${entry.title}`, '−');
  };
  item.append(copy, remove, actions);
  /* 桌面端可以直接把条目拖进编排轨道；触屏没有 HTML5 拖放，靠上面的「加入方案」按钮 */
  if (!locked) {
    item.draggable = true;
    item.addEventListener('dragstart', event => {
      beginSourceDrag(entry);
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/plain', entry.title || '');
    });
    item.addEventListener('dragend', endSourceDrag);
  }
  return item;
}

function renderWarehouse() {
  if (!warehouseRoot) return;
  const list = warehouseRoot.querySelector('#relaySourceList');
  const empty = warehouseRoot.querySelector('#relaySourceEmpty');
  const status = warehouseRoot.querySelector('#relaySourceStatus');
  if (!list || !empty) return;
  const inbox = relayInbox();
  /* inbox 的规范顺序已是新的在前（schema v2），这里不再反转 */
  list.replaceChildren(...inbox.map(sourceItem));
  list.hidden = inbox.length === 0;
  empty.hidden = inbox.length !== 0;
  if (status) status.textContent = inbox.length ? `${inbox.length} 条` : '';
  const clear = warehouseRoot.querySelector('#tagRelayClear');
  if (clear) clear.disabled = inbox.length === 0;
}

function renderRelayChrome() {
  const count = relayInbox().length;
  const badge = document.querySelector('#tagRelayCount');
  if (badge) {
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? '99+' : String(count);
  }
  const button = document.querySelector('#tagRelayBtn');
  if (button) {
    const label = count ? `Tag 中转站 · ${count} 条` : '打开 Tag 中转站';
    button.title = label;
    button.setAttribute('aria-label', label);
  }
  const menuHint = document.querySelector('#tagRelayMenuLink small');
  if (menuHint) menuHint.textContent = count ? `${count} 条在库` : '打开中转站';
  const railCount = document.querySelector('#tagRelayRailCount');
  if (railCount) railCount.textContent = count ? `${count} 条` : '';
}

function bindWarehouse() {
  if (!warehouseRoot) return;
  warehouseRoot.querySelector('#tagRelayClear')?.addEventListener('click', () => {
    const count = relayInbox().length;
    if (!count) return;
    if (!window.confirm(`确认清空 ${count} 条最近复制？方案不会受影响。`)) return;
    const result = commitRelay(next => clearInbox(next), { changed: 'inbox' });
    if (!result.ok) return;
    toast('已清空最近复制', '✓');
  });
}

export function setupTagRelay() {
  setupRelayStore();
  setupTagRelayRail();
  warehouseRoot = railPaneRoot('warehouse');
  setupRelayCompose(railPaneRoot('compose'));
  setRailPaneRenderers({ warehouse: renderWarehouse, compose: renderCompose });
  if (!relayBound) {
    relayBound = true;
    bindWarehouse();
    /* 状态变了由 store 广播：角标永远更新（它是入库唯一的即时反馈），
       列表只打脏标记，等侧栏开着或切过去才真画。 */
    subscribeRelay((_, meta) => {
      renderRelayChrome();
      markRailDirty(meta?.changed || 'all');
    });
  }
  relayState();
  renderRelayChrome();
  renderWarehouse();
}
