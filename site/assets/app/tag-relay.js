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
} from './tag-relay-rail.js';
import {
  RELAY_PLAN_MIME,
  RELAY_SOURCE_MIME,
  addSourceToPlan,
  removeBlock,
  renderCompose,
  renderComposeCounters,
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

/* 栏级作用域：素材分区之外的节点（栏头菜单等）要从这里找。 */
function relayScope() {
  return warehouseRoot?.closest('.tag-relay-rail') || warehouseRoot || document;
}

/* 素材芯片：30px 高、宽随标题自适应，440px 的栏一行放得下 2~3 个。
   原先一条占 100px（42px 缩略图 + 28px 常驻按钮行 + 边距），一屏只看得到 4 条，
   而那行 tag 预览还是被省略号截断的——真正承载信息的只有中间 37px。
   ⚠ 单击主体加入完整词条；带负向的条目另有一个小「负」键，避免把仅负向藏在菜单里。
      每次加入后的 toast 都提供撤销。 */
function sourceItem(entry, { removable = true } = {}) {
  const locked = snapshotLocked(entry);
  const visibleTitle = locked ? '已锁定的成人内容' : entry.title;
  const hasNegative = !locked && Boolean(String(entry.negative || '').trim());

  const chip = document.createElement('div');
  chip.className = locked ? 'tag-relay-chip is-locked' : 'tag-relay-chip';
  chip.draggable = !locked;

  /* ⚠ 主体是 div + role=button，不是 <button>：Chrome 里按钮会吞掉拖拽手势，
     draggable 的祖先根本收不到 dragstart，芯片就成了"看着能拖、拖了没反应"。 */
  const main = document.createElement('div');
  main.className = 'tag-relay-chip-main';
  if (!locked) {
    main.setAttribute('role', 'button');
    main.tabIndex = 0;
  }
  main.title = locked ? '重新开启对应内容权限后可继续使用' : visibleTitle + '　·　点一下加入方案，也可以直接拖上去';

  /* 缩略图缩成 16px 圆点：它在这里只是视觉锚点，42px 的图在芯片里没有位置。 */
  const dot = document.createElement('span');
  dot.className = 'tag-relay-chip-dot';
  if (!locked && entry.image) dot.style.backgroundImage = 'url("' + entry.image + '")';

  const name = document.createElement('span');
  name.className = 'tag-relay-chip-name';
  name.textContent = visibleTitle;
  main.append(dot, name);

  if (!locked) {
    main.onclick = () => addSourceToPlan(entry);
    main.onkeydown = event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      addSourceToPlan(entry);
    };
  }
  chip.append(main);

  if (hasNegative) {
    const negative = document.createElement('button');
    negative.type = 'button';
    negative.className = 'tag-relay-chip-negative';
    negative.textContent = '负';
    negative.title = '仅把这条的负向内容加入方案';
    negative.setAttribute('aria-label', `仅将${visibleTitle}的负向内容加入方案`);
    negative.onclick = () => addSourceToPlan(entry, { negativeOnly: true });
    chip.append(negative);
  }

  if (!locked) {
    chip.addEventListener('dragstart', event => {
      chip.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'copy';
      /* 载荷带整条快照：收藏来源的条目不在 relayInbox 里，接收方按 key 回查会落空。 */
      event.dataTransfer.setData(RELAY_SOURCE_MIME, JSON.stringify(entry));
      event.dataTransfer.setData('text/plain', entry.title || '');
    });
    chip.addEventListener('dragend', () => chip.classList.remove('is-dragging'));
  }

  /* 收藏来源不给「移出」：那会让人以为是在取消收藏。 */
  if (removable) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'tag-relay-chip-x';
    remove.textContent = '×';
    remove.setAttribute('aria-label', '从最近复制移除' + visibleTitle);
    remove.onclick = async () => {
      const result = await commitRelay(next => removeInboxEntry(next, entry.key), { changed: 'inbox' });
      if (!result.ok) return;
      toast('已移出最近复制：' + visibleTitle, '−');
    };
    chip.append(remove);
  }
  return chip;
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
  /* 面板只有一个，两个页签共用。aria-label 不跟着换的话，读屏进到面板里
     永远听到同一个名字，分不清现在看的是「最近复制」还是「收藏」。 */
  const panel = warehouseRoot?.querySelector('#relaySourcePanel');
  const activeTab = warehouseRoot?.querySelector(`[data-relay-source="${next}"]`);
  if (panel && activeTab) panel.setAttribute('aria-label', activeTab.textContent.trim());
  /* 每次切过来都重建：favorites.js 的 emitFavoritesChanged 只覆盖得到订阅的场景，
     缓存着仍可能显示上一次的收藏。buildFavoritesCodex 用的是已缓存的法典，重建很便宜。 */
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
  /* 空态一屏化后压成一行纯文本（原先是 b + small 两行，占地方）。 */
  empty.textContent = fav
    ? '还没有收藏。点卡片标题旁的星标，词条会出现在这里。'
    : '还没有复制过词条。点卡片复制，它会自动落到这里。';
  if (status) {
    if (fav && favoritesLoading) status.textContent = '正在读取跨法典收藏…';
    else status.textContent = items.length ? `${items.length} 条` : '';
  }
  /* 「清空最近复制」已并进栏头的「⋯」菜单，不在素材分区里了。 */
  const clear = relayScope().querySelector('#tagRelayClear');
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

/* 把方案块拖回素材区 = 移出方案。方向和直觉一致：往上拖是加进来，往下拖是拿出去。
   ⚠ 只认 RELAY_PLAN_MIME，素材自己在区内拖不会误触发。 */
function bindRemoveByDrag() {
  const zone = warehouseRoot;
  if (!zone) return;
  const isPlanDrag = event => (event.dataTransfer?.types || []).includes(RELAY_PLAN_MIME);
  zone.addEventListener('dragover', event => {
    if (!isPlanDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    zone.classList.add('is-remove-target');
  });
  zone.addEventListener('dragleave', event => {
    if (event.target === zone) zone.classList.remove('is-remove-target');
  });
  zone.addEventListener('drop', async event => {
    zone.classList.remove('is-remove-target');
    if (!isPlanDrag(event)) return;
    event.preventDefault();
    const itemId = event.dataTransfer.getData(RELAY_PLAN_MIME);
    if (itemId) await removeBlock(itemId);
  });
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
  /* 备份恢复、跨标签页，以及同页点星标（favorites.js 现在会发 emitFavoritesChanged）
     都走这一条；切页签时的重建是兜底，两者都留着。
     ⚠ scope 只接受 atlas / community，传别的会静默返回空函数。 */
  subscribeFavoritesChanges('atlas', () => {
    invalidateFavorites();
  });
  relayScope().querySelector('#tagRelayClear')?.addEventListener('click', async event => {
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
    const result = await commitRelay(next => clearInbox(next), { changed: 'inbox' });
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
  bindRemoveByDrag();
    /* 状态变了由 store 广播：角标永远更新（它是入库唯一的即时反馈），
       列表只打脏标记，等侧栏开着或切过去才真画。
       ⚠ 编排页签上的块数同属「角标」：在素材页签点「加入方案」时 compose 不是当前
       页签，flush() 会直接跳过，只有这里无条件跑才对得上「不切页签，计数体现在页签上」。 */
    subscribeRelay((_, meta) => {
      renderRelayChrome();
      renderComposeCounters();
      markRailDirty(meta?.changed || 'all');
    });
  }
  relayState();
  renderRelayChrome();
  renderComposeCounters();
  renderWarehouse();
}
