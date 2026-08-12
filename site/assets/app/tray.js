/* Tag 中转站的状态层：读写 localStorage、快照词条、卡片按钮态、拖拽载荷。
   界面（浮条 + 拼装台）在 tray-panel.js；masonry 只依赖本模块，拿不到面板，
   与 favorites.js / favorites-backup-core.js 的分工一致。 */

import { state, TRAY_STORAGE_KEY } from './state.js';
import { safeJsonParse } from './utils.js';
import { toast } from './feedback.js';
import { findCodexMeta } from './data.js';
import { hasEntryImage, thumbUrl } from './media.js';
import {
  TRAY_ITEM_LIMIT,
  addItem,
  emptyTray,
  findItem,
  normalizeTray,
  removeItem,
  trayItemKey,
} from './tray-core.js';

export const TRAY_DRAG_TYPE = 'application/x-fadian-tray';
export const TRAY_CHANGE_EVENT = 'tray:change';

let tray = emptyTray();
let loaded = false;

export function getTray() {
  if (!loaded) loadTray();
  return tray;
}

export function loadTray() {
  loaded = true;
  tray = normalizeTray(safeJsonParse(localStorage.getItem(TRAY_STORAGE_KEY), null));
  return tray;
}

export function saveTray() {
  try {
    localStorage.setItem(TRAY_STORAGE_KEY, JSON.stringify(tray));
    return true;
  } catch (error) {
    /* 配额爆了不能静默丢数据：内存里的中转站照旧可用，只是这次没落盘 */
    console.warn('[tray] 无法保存中转站', error);
    toast('浏览器存储写满了，本次改动没能保存', '!');
    return false;
  }
}

/* 中转站的归属永远算在词条的真实法典下：收藏墙 / 全站搜索里的词条带 _srcCodexId，
   照它回溯正主，否则会记成 favorites 这本并不存在的书。与 favorites.js 的 ownerCodex 同理。 */
function ownerCodex(e) {
  return (e?._srcCodexId && findCodexMeta(e._srcCodexId)) || state.codex;
}

export function trayKey(e) {
  const codex = ownerCodex(e);
  return trayItemKey(codex?.id || '', e?.id || '');
}

export function isInTray(e) {
  return Boolean(e && findItem(getTray(), trayKey(e)));
}

/* 入站即写快照：正面、负面、角色词全存下来，刷新后不必重下整本法典就能拼词。
   角色词只留 prompt 与「有没有负面」这个事实，角色级负面本身不参与合并（见 tray-core）。 */
export function snapshotEntry(e) {
  const codex = ownerCodex(e);
  return {
    codexId: codex?.id || '',
    entryId: e.id,
    title: e.title,
    book: e._srcCodexTitle || codex?.title || '',
    path: (e._srcPath || e.path || []).join(' › '),
    thumb: hasEntryImage(e) ? thumbUrl(e) : '',
    pos: e.tags || '',
    neg: e.negative || '',
    chars: (e.characterPrompts || []).map(item => ({
      label: item?.label || 'char',
      prompt: item?.prompt || '',
      negative: item?.negative || '',
    })),
  };
}

export function setTrayButtonState(btn, on) {
  if (!btn) return;
  btn.textContent = on ? '✓' : '＋';
  btn.classList.toggle('on', on);
  btn.title = on ? '移出中转站' : '加入中转站';
  btn.setAttribute('aria-label', on ? '移出中转站' : '加入中转站');
  btn.setAttribute('aria-pressed', String(on));
}

function sameTrayEntry(a, b) {
  if (!a || !b) return false;
  try {
    return trayKey(a) === trayKey(b);
  } catch {
    return false;
  }
}

/* 瀑布流会回收卡片，按钮态不能只改被点的那一颗：同一词条可能同时出现在多张在场卡上
   （收藏墙 / 全站搜索），照 favorites.js 的 syncRenderedFavoriteButtons 一并刷。 */
function syncRenderedTrayButtons(e, on) {
  if (!(state.nodes instanceof Map) || !Array.isArray(state.list)) return;
  for (const [index, node] of state.nodes) {
    if (!sameTrayEntry(state.list[index], e)) continue;
    setTrayButtonState(node?.querySelector?.('.tray-btn'), on);
  }
}

export function notifyTrayChange() {
  document.dispatchEvent(new CustomEvent(TRAY_CHANGE_EVENT));
}

export function addEntryToTray(e) {
  if (!e) return false;
  if (isInTray(e)) return false;
  const result = addItem(getTray(), snapshotEntry(e));
  if (!result.ok) {
    if (result.reason === 'full') toast(`中转站最多放 ${TRAY_ITEM_LIMIT} 条，先清理几条`, '!');
    return false;
  }
  saveTray();
  syncRenderedTrayButtons(e, true);
  notifyTrayChange();
  toast(`已入站：${e.title}`);
  return true;
}

export function removeEntryFromTray(e) {
  if (!e || !isInTray(e)) return false;
  removeItem(getTray(), trayKey(e));
  saveTray();
  syncRenderedTrayButtons(e, false);
  notifyTrayChange();
  toast(`已移出：${e.title}`);
  return true;
}

export function toggleTray(e, btn) {
  const added = isInTray(e) ? !removeEntryFromTray(e) : addEntryToTray(e);
  setTrayButtonState(btn, isInTray(e));
  return added;
}

/* 按住卡片上的 ＋ 往下拖：dataTransfer 在 dragstart 当场序列化，
   所以后面卡片被瀑布流回收掉也不影响这次拖拽。移动端不走这条路（长按拖拽会和滚动打架）。 */
export function beginTrayDrag(e, ev) {
  if (!ev?.dataTransfer || !e) return;
  const payload = JSON.stringify(snapshotEntry(e));
  ev.dataTransfer.setData(TRAY_DRAG_TYPE, payload);
  ev.dataTransfer.setData('text/plain', e.title || '');
  ev.dataTransfer.effectAllowed = 'copy';
  document.body.classList.add('tray-dragging');
}

export function endTrayDrag() {
  document.body.classList.remove('tray-dragging');
}

export function addSnapshotToTray(rawItem) {
  const result = addItem(getTray(), rawItem);
  if (!result.ok) {
    if (result.reason === 'full') toast(`中转站最多放 ${TRAY_ITEM_LIMIT} 条，先清理几条`, '!');
    return false;
  }
  saveTray();
  refreshAllTrayButtons();
  notifyTrayChange();
  toast(`已入站：${result.item.title}`);
  return true;
}

/* 面板里删条目、清空之后调用：在场卡片挨个按当前中转站重算按钮态 */
export function refreshAllTrayButtons() {
  if (!(state.nodes instanceof Map) || !Array.isArray(state.list)) return;
  for (const [index, node] of state.nodes) {
    const entry = state.list[index];
    if (!entry) continue;
    setTrayButtonState(node?.querySelector?.('.tray-btn'), isInTray(entry));
  }
}
