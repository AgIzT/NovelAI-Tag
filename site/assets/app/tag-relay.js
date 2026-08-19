/* 中转站在主站里的接线层：浮钮计数 + 侧栏各分区的装配。
   状态与持久化在 tag-relay-store.js，词条→快照的转换在 tag-relay-snapshot.js，
   纯计算在 tag-relay-core.js，侧栏外壳在 tag-relay-rail.js。

   入库是「复制即入库」（见 copy.js 里 recordCopiedEntry 的调用点），
   卡片和灯箱上没有手动入站按钮——卡片因此保持原样，不会和收藏星混淆。 */

import { isEntryNsfw, isR18gEntry } from './access.js';
import { findCodexMeta } from './data.js';
import { buildFavoritesCodex } from './fav-codex.js';
import { subscribeFavoritesChanges } from './favorites-backup.js';
import { toast } from './feedback.js';
import { hasEntryImage, thumbUrl } from './media.js';
import { requestRelayAction } from './tag-relay-action.js';
import { clearInbox, normalizeRelayEntry, removeInboxEntry } from './tag-relay-core.js';
import {
  markRailDirty,
  railPaneRoot,
  setRailPaneRenderers,
  setupTagRelayRail,
  showRailTab,
} from './tag-relay-rail.js';
import {
  addSourceToPlan,
  renderCompose,
  refreshComposeAccess,
  setupRelayCompose,
} from './tag-relay-compose.js';
import { snapshotLocked } from './tag-relay-snapshot.js';
import { commitRelay, relayInbox, relayState, setupRelayStore, subscribeRelay } from './tag-relay-store.js';

let relayBound = false;
let warehouseRoot = null;
let sourceMode = 'inbox';
let favorites = null;
let favoritesLoading = false;
let favoritesGeneration = 0;
let favoritesReloadPending = false;
let favoritesReloadQueued = false;

function placeholder(title = '') {
  const node = document.createElement('span');
  node.className = 'tag-relay-quick-thumb is-placeholder';
  node.textContent = String(title || 'T').trim().slice(0, 1).toUpperCase() || 'T';
  return node;
}

function sourceItem(entry, { removable = true } = {}) {
  const locked = snapshotLocked(entry);
  const visibleTitle = locked ? '已锁定的成人内容' : entry.title;
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
    /* 不切页签：连续浏览、连续收料时来回甩页正是侧栏化要消灭的打断感。
       方案里加了几块由页签上的计数体现。 */
    add.onclick = () => addSourceToPlan(entry);
    actions.append(add);
    if (String(entry.negative || '').trim()) {
      const negOnly = document.createElement('button');
      negOnly.type = 'button';
      negOnly.className = 'tag-relay-item-add is-neg';
      negOnly.textContent = '只加负向';
      negOnly.title = '只把负向内容加入方案';
      negOnly.onclick = () => addSourceToPlan(entry, { negativeOnly: true });
      actions.append(negOnly);
    }
  }

  let remove = null;
  if (removable) {
    remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'tag-relay-quick-remove';
    remove.textContent = '×';
    remove.title = `移除${visibleTitle}`;
    remove.setAttribute('aria-label', `从最近复制移除${visibleTitle}`);
    remove.onclick = () => {
      const result = commitRelay(next => removeInboxEntry(next, entry.key), { changed: 'inbox' });
      if (!result.ok) return;
      toast(`已移出最近复制：${visibleTitle}`, '−');
    };
  }
  /* 收藏来源不给「移出」：那会让人以为是在取消收藏 */
  item.append(copy, remove || document.createElement('span'), actions);
  return item;
}

/* ⚠ 独立工作台那版在这里往共享的 atlasState 里写 codexes / favs / media 来做引导——
   那是因为独立页的 state 是空壳。并进主站后这些全是活的，照搬会在用户点一下
   「收藏」页签的瞬间冲掉正在跑的法典索引和收藏集。所以引导那半段整段删掉，
   只留下「收藏词条 → 中转站快照」的映射。 */
async function loadFavorites() {
  if (favorites !== null) return;
  if (favoritesLoading) {
    favoritesReloadPending = true;
    return;
  }
  const generation = favoritesGeneration;
  favoritesLoading = true;
  renderWarehouse();
  try {
    const codex = await buildFavoritesCodex();
    const loaded = codex.entries.map(entry => {
      const sourceId = String(entry._srcCodexId || '').trim();
      const meta = findCodexMeta(sourceId);
      let image = '';
      try {
        if (hasEntryImage(entry)) image = thumbUrl(entry, codex);
      } catch {
        image = '';
      }
      const path = Array.isArray(entry._srcPath) ? entry._srcPath : (entry.path || []);
      return normalizeRelayEntry({
        ...entry,
        codexId: sourceId,
        entryId: entry.id,
        book: entry._srcCodexTitle || meta?.selectorTitle || meta?.title || '',
        path,
        image,
        access: { nsfw: meta?.nsfw === true || isEntryNsfw(entry), r18g: isR18gEntry({ ...entry, path }) },
      });
    });
    if (generation === favoritesGeneration) favorites = loaded;
  } catch (error) {
    console.warn('[tag-relay] 收藏素材加载失败', error);
    if (generation === favoritesGeneration) {
      favorites = [];
      toast('收藏加载失败，请稍后重试', '!');
    }
  } finally {
    favoritesLoading = false;
    renderWarehouse();
    if (favoritesReloadPending || generation !== favoritesGeneration) {
      favoritesReloadPending = false;
      favorites = null;
      void loadFavorites();
    }
  }
}

function invalidateFavorites() {
  favorites = null;
  favoritesGeneration += 1;
  if (favoritesLoading) favoritesReloadPending = true;
  if (sourceMode !== 'favorites' || favoritesLoading || favoritesReloadQueued) return;
  /* storage / CustomEvent listeners run in registration order.主站更新 state.favs
     的监听可能排在本模块之后；延到当前事件派发结束，避免用旧集合构建收藏列。 */
  favoritesReloadQueued = true;
  Promise.resolve().then(() => {
    favoritesReloadQueued = false;
    if (sourceMode === 'favorites') void loadFavorites();
  });
}

function setSourceMode(next) {
  sourceMode = next;
  for (const button of warehouseRoot?.querySelectorAll('[data-relay-source]') || []) {
    const on = button.dataset.relaySource === next;
    button.setAttribute('aria-selected', String(on));
    button.tabIndex = on ? 0 : -1;
  }
  /* 每次切过来都重建：点星标走的是 favorites.js 的 saveFavs，同页内不发任何事件，
     缓存着就会显示上一次的收藏。buildFavoritesCodex 用的是已缓存的法典，重建很便宜。 */
  if (next === 'favorites') {
    favorites = null;
    favoritesGeneration += 1;
  }
  renderWarehouse();
  if (next === 'favorites') void loadFavorites();
}

function renderWarehouse() {
  if (!warehouseRoot) return;
  const list = warehouseRoot.querySelector('#relaySourceList');
  const empty = warehouseRoot.querySelector('#relaySourceEmpty');
  const status = warehouseRoot.querySelector('#relaySourceStatus');
  if (!list || !empty) return;
  const fav = sourceMode === 'favorites';
  /* inbox 的规范顺序已是新的在前（schema v2），这里不再反转 */
  const items = fav ? (favorites || []) : relayInbox();
  list.replaceChildren(...items.map(entry => sourceItem(entry, { removable: !fav })));
  list.hidden = items.length === 0;
  empty.hidden = items.length !== 0 || (fav && favoritesLoading);
  const emptyTitle = empty.querySelector('b');
  const emptyHint = empty.querySelector('small');
  if (emptyTitle && emptyHint) {
    emptyTitle.textContent = fav ? '还没有收藏' : '还没有复制过词条';
    emptyHint.textContent = fav ? '点卡片标题旁的星标收藏，词条会出现在这里。' : '点卡片复制，词条会自动收到这里。';
  }
  if (status) {
    if (fav && favoritesLoading) status.textContent = '正在读取跨法典收藏…';
    else status.textContent = items.length ? `${items.length} 条` : '';
  }
  const clear = warehouseRoot.querySelector('#tagRelayClear');
  if (clear) {
    clear.hidden = fav;
    clear.disabled = relayInbox().length === 0;
  }
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
  for (const button of warehouseRoot.querySelectorAll('[data-relay-source]')) {
    button.addEventListener('click', () => setSourceMode(button.dataset.relaySource));
  }
  warehouseRoot.querySelector('.tag-relay-source-tabs')?.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...warehouseRoot.querySelectorAll('[data-relay-source]')];
    if (!tabs.length) return;
    const current = Math.max(0, tabs.indexOf(document.activeElement));
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    setSourceMode(tabs[next].dataset.relaySource);
    tabs[next].focus();
  });
  /* 这个订阅只覆盖备份恢复与跨标签页（同页点星标不发事件，靠上面切页签时重建）。
     ⚠ scope 只接受 atlas / community，传别的会静默返回空函数。 */
  subscribeFavoritesChanges('atlas', () => {
    invalidateFavorites();
  });
  warehouseRoot.querySelector('#tagRelayClear')?.addEventListener('click', async event => {
    const count = relayInbox().length;
    if (!count) return;
    const accepted = await requestRelayAction({
      title: '清空最近复制？',
      message: `${count} 条素材会移出中转站，已有方案不会受影响。`,
      confirmLabel: '确认清空',
      danger: true,
      trigger: event.currentTarget,
    });
    if (!accepted) return;
    const result = commitRelay(next => clearInbox(next), { changed: 'inbox' });
    if (!result.ok) return;
    toast('已清空最近复制', '✓');
  });
}

/* 分级开关由 ui.js 直接改内存 state，中转站收不到任何事件——必须由那边显式喊一声。
   收藏缓存一并作废：它按当时的锁态映射过 access 标记。 */
export function refreshRelayAccess() {
  invalidateFavorites();
  renderWarehouse();
  refreshComposeAccess();
  renderCompose();
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
