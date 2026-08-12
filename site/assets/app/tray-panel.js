/* Tag 中转站的界面层：吸底浮条 + 拼装台面板 + 拖拽落点。
   数据与快照在 tray.js，纯计算在 tray-core.js。本模块是唯一碰 DOM 的一层。 */

import { $, esc } from './utils.js';
import { toast } from './feedback.js';
import { copyText } from './copy.js';
import { closeMask, isMaskOpen, openMask, registerMaskHistory, trapFocus } from './modal.js';
import {
  TRAY_DRAG_TYPE,
  TRAY_CHANGE_EVENT,
  addSnapshotToTray,
  endTrayDrag,
  getTray,
  loadTray,
  refreshAllTrayButtons,
  saveTray,
} from './tray.js';
import {
  TRAY_BOARD_LIMIT,
  activeBoard,
  composeChannel,
  createBoard,
  findItem,
  itemHasCharNegative,
  itemNegative,
  moveSlot,
  removeBoard,
  removeItem,
  roughTagCount,
  trayStats,
} from './tray-core.js';

let bound = false;
let dragFrom = -1;

const panelEl = () => $('#trayPanel');

export function isTrayPanelOpen() {
  return isMaskOpen(panelEl());
}

export function openTrayPanel(trigger) {
  const panel = panelEl();
  if (!panel) return;
  /* ⚠ 必须先 openMask 再渲染：renderPanel 对 hidden 的面板直接跳过（关着时不做无用功），
     反过来写会开出一个空面板。 */
  openMask(panel, trigger || $('#trayOpen'));
  renderPanel();
}

export function closeTrayPanel() {
  closeMask(panelEl());
}

/* ---------------- 浮条 ---------------- */

function renderBar() {
  const bar = $('#trayBar');
  if (!bar) return;
  const tray = getTray();
  const count = tray.items.length;
  const show = count > 0;
  bar.hidden = !show;
  bar.classList.toggle('show', show);
  /* 浮条会盖住瀑布流最后一行，也会挤右下角浮动按钮：交给 body 类去补位移与内边距 */
  document.body.classList.toggle('has-tray-bar', show);
  const countEl = $('#trayBarCount');
  if (countEl) countEl.textContent = `${count} 条`;
  const quick = $('#trayQuickCopy');
  if (quick) {
    const stats = trayStats(tray);
    quick.disabled = !stats.pos;
    quick.title = stats.pos ? `按「${activeBoard(tray).name}」的顺序复制正面` : '当前方案里没有正面内容';
  }
}

/* ---------------- 面板 ---------------- */

function warehouseHtml(tray) {
  if (!tray.items.length) {
    return '<p class="tray-empty">仓库是空的。<br>浏览时点卡片右上角的 ＋ 就能把词条收进来。</p>';
  }
  const board = activeBoard(tray);
  return tray.items.map(item => {
    const used = board.slots.some(slot => slot.key === item.key);
    const tags = roughTagCount(item.pos);
    const marks = [
      itemNegative(item) ? '<span class="tray-mark neg">负面</span>' : '',
      item.chars.length ? `<span class="tray-mark">角色词 ${item.chars.length}</span>` : '',
    ].join('');
    return `<div class="tray-block${used ? ' used' : ''}" data-key="${esc(item.key)}">
      ${item.thumb ? `<img class="tray-thumb" src="${esc(item.thumb)}" alt="" loading="lazy">` : '<span class="tray-thumb is-blank" aria-hidden="true"></span>'}
      <span class="tray-block-main">
        <span class="tray-block-title">${esc(item.title)}</span>
        <span class="tray-block-sub">${esc(item.book)} · 约 ${tags} tag ${marks}</span>
      </span>
      <button class="tray-act" type="button" data-act="send" title="送进当前方案" aria-label="送进当前方案">→</button>
      <button class="tray-act" type="button" data-act="drop" title="移出仓库" aria-label="移出仓库">×</button>
    </div>`;
  }).join('');
}

function boardsHtml(tray) {
  const tabs = tray.boards.map((board, index) => `
    <button class="tray-tab${index === tray.active ? ' on' : ''}" type="button" data-board="${index}"
      aria-pressed="${index === tray.active}">${esc(board.name)}
      <span class="tray-tab-n">${board.slots.length}</span>
    </button>`).join('');
  const add = tray.boards.length < TRAY_BOARD_LIMIT
    ? '<button class="tray-tab add" type="button" data-board-add="1" title="同一批料再排一版">＋ 新方案</button>'
    : '';
  const del = tray.boards.length > 1
    ? '<button class="tray-tab del" type="button" data-board-del="1" title="删掉当前方案" aria-label="删掉当前方案">删除本方案</button>'
    : '';
  return tabs + add + del;
}

function canvasHtml(tray) {
  const board = activeBoard(tray);
  if (!board.slots.length) {
    return '<p class="tray-empty">这套方案还没排料。<br>点左边方块的「→」送进来，然后拖着上下排序。</p>';
  }
  return board.slots.map((slot, index) => {
    const item = findItem(tray, slot.key);
    if (!item) return '';
    const charNeg = itemHasCharNegative(item)
      ? '<span class="tray-mark warn" title="这条含角色级负面。角色负面在 NovelAI 里按角色分槽填，合并没有意义，没有并进负面串；要精确填槽请开灯箱。">含角色负面</span>'
      : '';
    return `<div class="tray-block tray-slot${slot.on ? '' : ' off'}" draggable="true" data-i="${index}">
      <span class="tray-grip" aria-hidden="true">⠿</span>
      <span class="tray-move">
        <button class="tray-act" type="button" data-act="up" title="上移" aria-label="上移">↑</button>
        <button class="tray-act" type="button" data-act="down" title="下移" aria-label="下移">↓</button>
      </span>
      <span class="tray-block-main">
        <span class="tray-block-title">${esc(item.title)}</span>
        <span class="tray-block-sub">${esc(item.book)} · 约 ${roughTagCount(item.pos)} tag ${charNeg}</span>
      </span>
      <button class="tray-act" type="button" data-act="toggle"
        title="${slot.on ? '熄灭：留着但不参与输出' : '点亮：重新参与输出'}"
        aria-pressed="${slot.on}">${slot.on ? '◉' : '○'}</button>
      <button class="tray-act" type="button" data-act="del" title="从这套方案里去掉" aria-label="从这套方案里去掉">×</button>
    </div>`;
  }).join('');
}

export function renderPanel() {
  const panel = panelEl();
  if (!panel || panel.hidden) {
    renderBar();
    return;
  }
  const tray = getTray();
  const stats = trayStats(tray);

  const sub = $('#trayPanelSub');
  if (sub) sub.textContent = tray.items.length ? `仓库 ${stats.items} 条 · ${stats.boards} 套方案` : '';
  $('#trayWarehouse').innerHTML = warehouseHtml(tray);
  $('#trayBoards').innerHTML = boardsHtml(tray);
  $('#trayCanvas').innerHTML = canvasHtml(tray);

  const preview = $('#trayPreview');
  if (preview) preview.textContent = stats.pos || '（当前方案没有正面内容）';
  const meta = $('#trayMeta');
  if (meta) {
    meta.textContent = stats.pos
      ? `成品 · 正面约 ${stats.posTags} tag${stats.neg ? ` · 负面约 ${stats.negTags} tag` : ' · 无负面'}`
      : '画布是空的';
  }
  const copyPos = $('#trayCopyPos');
  if (copyPos) copyPos.disabled = !stats.pos;
  const copyNeg = $('#trayCopyNeg');
  if (copyNeg) {
    copyNeg.disabled = !stats.neg;
    copyNeg.title = stats.neg ? '负面单独一条通道，不会混进正面' : '当前方案里没有带负面的词条';
  }
  const clear = $('#trayClear');
  if (clear) clear.disabled = !tray.items.length;
  renderBar();
}

function renderAll() {
  renderBar();
  if (isTrayPanelOpen()) renderPanel();
}

/* ---------------- 交互 ---------------- */

function commit() {
  saveTray();
  renderPanel();
}

function bindWarehouse() {
  $('#trayWarehouse').addEventListener('click', ev => {
    const block = ev.target.closest('.tray-block');
    if (!block) return;
    const tray = getTray();
    const key = block.dataset.key;
    const act = ev.target.closest('.tray-act')?.dataset.act;
    if (act === 'drop') {
      removeItem(tray, key);
      saveTray();
      refreshAllTrayButtons();
      renderPanel();
      return;
    }
    if (!findItem(tray, key)) return;
    /* 同一条允许重复送进画布：确实有人靠重复来加权，去重交给用户自己判断 */
    activeBoard(tray).slots.push({ key, on: true });
    commit();
  });
}

function bindBoards() {
  $('#trayBoards').addEventListener('click', ev => {
    const tab = ev.target.closest('.tray-tab');
    if (!tab) return;
    const tray = getTray();
    if (tab.dataset.boardAdd) {
      const result = createBoard(tray);
      if (!result.ok) { toast(`最多 ${TRAY_BOARD_LIMIT} 套方案`, '!'); return; }
      commit();
      return;
    }
    if (tab.dataset.boardDel) {
      if (removeBoard(tray, tray.active)) commit();
      return;
    }
    const index = Number(tab.dataset.board);
    if (!Number.isInteger(index) || index === tray.active) return;
    tray.active = index;
    commit();
  });
}

function bindCanvas() {
  const canvas = $('#trayCanvas');
  canvas.addEventListener('click', ev => {
    const row = ev.target.closest('.tray-slot');
    if (!row) return;
    const act = ev.target.closest('.tray-act')?.dataset.act;
    if (!act) return;
    const tray = getTray();
    const slots = activeBoard(tray).slots;
    const index = Number(row.dataset.i);
    if (act === 'toggle') slots[index].on = !slots[index].on;
    else if (act === 'del') slots.splice(index, 1);
    else if (act === 'up') { if (!moveSlot(slots, index, index - 1)) return; }
    else if (act === 'down') { if (!moveSlot(slots, index, index + 1)) return; }
    else return;
    commit();
  });

  canvas.addEventListener('dragstart', ev => {
    const row = ev.target.closest('.tray-slot');
    if (!row) return;
    dragFrom = Number(row.dataset.i);
    row.classList.add('is-dragging');
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', 'tray-slot');
  });
  canvas.addEventListener('dragend', () => {
    dragFrom = -1;
    renderPanel();
  });
  canvas.addEventListener('dragover', ev => {
    if (dragFrom < 0) return;
    const row = ev.target.closest('.tray-slot');
    if (!row) return;
    ev.preventDefault();
    for (const node of canvas.querySelectorAll('.is-dragover')) node.classList.remove('is-dragover');
    row.classList.add('is-dragover');
  });
  canvas.addEventListener('drop', ev => {
    if (dragFrom < 0) return;
    const row = ev.target.closest('.tray-slot');
    if (!row) return;
    ev.preventDefault();
    const to = Number(row.dataset.i);
    if (moveSlot(activeBoard(getTray()).slots, dragFrom, to)) {
      dragFrom = -1;
      commit();
    }
  });
}

/* 从卡片 ＋ 拖进来：浮条与专用落点都接，dataTransfer 里是入站当场做好的快照 */
function bindDropTargets() {
  const accept = el => {
    if (!el) return;
    el.addEventListener('dragover', ev => {
      if (!ev.dataTransfer?.types?.includes(TRAY_DRAG_TYPE)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      el.classList.add('is-dragover');
    });
    el.addEventListener('dragleave', () => el.classList.remove('is-dragover'));
    el.addEventListener('drop', ev => {
      const raw = ev.dataTransfer?.getData(TRAY_DRAG_TYPE);
      if (!raw) return;
      ev.preventDefault();
      el.classList.remove('is-dragover');
      endTrayDrag();
      let payload = null;
      try { payload = JSON.parse(raw); } catch { payload = null; }
      if (payload) addSnapshotToTray(payload);
    });
  };
  accept($('#trayBar'));
  accept($('#trayDrop'));
  document.addEventListener('dragend', endTrayDrag);
}

function bindCopy() {
  const copy = (channel, node) => {
    const tray = getTray();
    const text = composeChannel(tray, activeBoard(tray), channel);
    if (!text) {
      toast(channel === 'neg' ? '当前方案里没有带负面的词条' : '当前方案没有正面内容', '!');
      return;
    }
    const count = roughTagCount(text);
    const label = channel === 'neg' ? '负面' : '正面';
    /* 走 copy.js 的统一管线：SD 权重在这一刻按用户当下的开关转换，中转站里不固化 */
    copyText(text, `已复制${activeBoard(tray).name}${label} · 约 ${count} tag`, node, {
      sampleLabel: `已复制${label}`,
    });
  };
  $('#trayQuickCopy').onclick = ev => copy('pos', ev.currentTarget);
  $('#trayCopyPos').onclick = ev => copy('pos', ev.currentTarget);
  $('#trayCopyNeg').onclick = ev => copy('neg', ev.currentTarget);
}

export function setupTray() {
  if (bound) { renderAll(); return; }
  const panel = panelEl();
  if (!panel || !$('#trayBar')) return;
  bound = true;
  loadTray();

  registerMaskHistory(panel);
  $('#trayOpen').onclick = ev => openTrayPanel(ev.currentTarget);
  $('#trayClose').onclick = () => closeTrayPanel();
  panel.onclick = ev => { if (ev.target === panel) closeTrayPanel(); };
  panel.onkeydown = ev => trapFocus(ev, panel);
  $('#trayClear').onclick = () => {
    const tray = getTray();
    if (!tray.items.length) return;
    tray.items = [];
    for (const board of tray.boards) board.slots = [];
    saveTray();
    refreshAllTrayButtons();
    renderPanel();
    toast('已清空中转站');
  };

  bindWarehouse();
  bindBoards();
  bindCanvas();
  bindDropTargets();
  bindCopy();
  document.addEventListener(TRAY_CHANGE_EVENT, renderAll);
  renderAll();
}
