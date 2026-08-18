/* 中转站在主站里的接线层：浮钮计数、快捷抽屉、卡片/灯箱的入站按钮。
   状态与持久化在 tag-relay-store.js，词条→快照的转换在 tag-relay-snapshot.js，
   纯计算在 tag-relay-core.js。本模块只碰 DOM。 */

import { toast } from './feedback.js';
import { closeMask, openMask, trapFocus } from './modal.js';
import { state } from './state.js';
import { addInboxEntry, clearInbox, removeInboxEntry } from './tag-relay-core.js';
import { relayKeyFor, snapshotEntry, snapshotLocked, sourceContext } from './tag-relay-snapshot.js';
import { commitRelay, relayInbox, relayState, setupRelayStore, subscribeRelay } from './tag-relay-store.js';

let relayBound = false;

function setStageButtonState(button, staged) {
  if (!button) return;
  const label = staged ? '已在 Tag 中转站，点击移除' : '加入 Tag 中转站';
  button.classList.toggle('on', staged);
  button.setAttribute('aria-pressed', String(staged));
  button.title = label;
  button.setAttribute('aria-label', label);
  if (button.id === 'stageLightbox') button.textContent = staged ? '已加入中转站' : '加入中转站';
}

export function isEntryStaged(entry) {
  const key = relayKeyFor(entry);
  return relayInbox().some(item => item.key === key);
}

/* 瀑布流会回收卡片，同一条词条也可能同时出现在多张在场卡上（收藏墙 / 全站搜索），
   所以状态变了要把所有在场按钮一起刷，不能只改被点的那颗。 */
function syncRenderedStageButtons() {
  if (state.nodes instanceof Map && Array.isArray(state.list)) {
    for (const [index, node] of state.nodes) {
      const entry = state.list[index];
      if (!entry) continue;
      setStageButtonState(node?.querySelector?.('.stage-btn'), isEntryStaged(entry));
    }
  }
  const current = state.lightbox?.entry;
  setStageButtonState(document.querySelector('#stageLightbox'), current ? isEntryStaged(current) : false);
}

export function toggleEntryStage(entry, trigger) {
  const key = relayKeyFor(entry);
  const staged = relayInbox().some(item => item.key === key);
  const action = commitRelay(next => (
    staged
      ? removeInboxEntry(next, key)
      : addInboxEntry(next, snapshotEntry(entry), sourceContext(entry))
  ), { changed: 'inbox' });
  if (!action.ok) return false;
  const nowStaged = !staged;
  setStageButtonState(trigger, nowStaged);
  syncRenderedStageButtons();
  toast(nowStaged ? `已加入中转站：${entry.title}` : `已移出中转站：${entry.title}`, nowStaged ? '+' : '−');
  return nowStaged;
}

function placeholder(title = '') {
  const node = document.createElement('span');
  node.className = 'tag-relay-quick-thumb is-placeholder';
  node.textContent = String(title || 'T').trim().slice(0, 1).toUpperCase() || 'T';
  return node;
}

function quickItem(entry) {
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

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'tag-relay-quick-remove';
  remove.textContent = '×';
  remove.title = `移除${entry.title}`;
  remove.setAttribute('aria-label', `从中转站移除${entry.title}`);
  remove.onclick = () => {
    const result = commitRelay(next => removeInboxEntry(next, entry.key), { changed: 'inbox' });
    if (!result.ok) return;
    syncRenderedStageButtons();
    toast(`已移出中转站：${entry.title}`, '−');
  };
  item.append(copy, remove);
  return item;
}

function renderQuickList() {
  const list = document.querySelector('#tagRelayQuickList');
  const empty = document.querySelector('#tagRelayQuickEmpty');
  if (!list || !empty) return;
  const inbox = relayInbox();
  /* inbox 的规范顺序已是新的在前（schema v2），这里不再反转 */
  list.replaceChildren(...inbox.map(quickItem));
  list.hidden = inbox.length === 0;
  empty.hidden = inbox.length !== 0;
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
    button.title = count ? `Tag 中转站 · ${count} 条` : '打开 Tag 中转站暂存区';
    button.setAttribute('aria-label', button.title);
  }
  const menuHint = document.querySelector('#tagRelayMenuLink small');
  if (menuHint) menuHint.textContent = count ? `${count} 条暂存中` : '打开组合工作台';
  const clear = document.querySelector('#tagRelayClear');
  if (clear) clear.disabled = count === 0;
  renderQuickList();
  syncRenderedStageButtons();
}

function bindQuickPanel() {
  const mask = document.querySelector('#tagRelayQuick');
  const open = document.querySelector('#tagRelayBtn');
  const close = document.querySelector('#tagRelayQuickClose');
  const clear = document.querySelector('#tagRelayClear');
  if (!mask || !open || !close || !clear) return;

  open.onclick = () => {
    renderRelayChrome();
    openMask(mask, open);
  };
  close.onclick = () => closeMask(mask);
  mask.onclick = event => {
    if (event.target === mask) closeMask(mask);
  };
  mask.onkeydown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMask(mask);
      return;
    }
    trapFocus(event, mask);
  };
  clear.onclick = () => {
    const count = relayInbox().length;
    if (!count) return;
    if (!window.confirm(`确认清空 ${count} 条暂存词条？方案和复制记录不会受影响。`)) return;
    const result = commitRelay(next => clearInbox(next), { changed: 'inbox' });
    if (!result.ok) return;
    syncRenderedStageButtons();
    toast('已清空中转站暂存区', '✓');
  };
}

function bindLightboxStage() {
  document.addEventListener('lightbox:rendered', event => {
    const entry = event.detail?.entry;
    const button = document.querySelector('#stageLightbox');
    if (!entry || !button) return;
    setStageButtonState(button, isEntryStaged(entry));
    button.onclick = click => {
      click.stopPropagation();
      toggleEntryStage(entry, button);
    };
  });
}

export function setupTagRelay() {
  setupRelayStore();
  if (!relayBound) {
    relayBound = true;
    bindQuickPanel();
    bindLightboxStage();
    /* 状态变了由 store 广播，本模块只负责把它画出来——
       跨标签页同步与 bfcache 恢复也走同一条路，不必各绑一份监听。 */
    subscribeRelay(() => renderRelayChrome());
  }
  relayState();
  renderRelayChrome();
  return {
    isStaged: isEntryStaged,
    toggleStage: toggleEntryStage,
  };
}
