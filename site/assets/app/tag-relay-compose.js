/* 侧栏「编排」分区：方案条 + 块轨道 + 块编辑器 + 贴底的成品与复制。
   编排和输出刻意合成一屏而不是两个页签——核心场景是「反复组合再复制」，
   分开的话每复制一次都要切一次页。

   所有 DOM 查询都限定在分区根节点内（refs 一次解析好），不再是 document 全局：
   [data-format] 这类选择器在整站范围里迟早会撞车。 */

import { toast } from './feedback.js';
import { copyText } from './copy.js';
import {
  appendEntryToPlan,
  compilePlan,
  createPlan,
  deletePlan,
  getActivePlan,
  mergedTotal,
  movePlanItem,
  removePlanItem,
  renamePlan,
  setActivePlan,
  updatePlanItem,
} from './tag-relay-core.js';
import { snapshotLocked } from './tag-relay-snapshot.js';
import { commitRelay, relayState } from './tag-relay-store.js';

let refs = null;
let bound = false;
let selectedItemId = '';
let outputFormat = 'nai';
let joinMode = 'comma';
let latest = { positive: '', negative: '', positiveTokens: [], negativeTokens: [] };
let dragBlockId = '';
let pendingSource = null;

const plan = () => getActivePlan(relayState());
const itemLocked = item => snapshotLocked(item);

function promptParts(item, channel) {
  const parts = [channel === 'negative' ? item?.negative : item?.prompt];
  for (const character of item?.characterPrompts || []) {
    parts.push(channel === 'negative' ? character.negative : character.prompt);
  }
  return parts.map(value => String(value || '').trim()).filter(Boolean);
}

function itemChannel(item) {
  const positive = promptParts(item, 'positive').length > 0;
  const negative = promptParts(item, 'negative').length > 0;
  if (positive && negative) return { key: 'both', label: '正＋负' };
  if (negative) return { key: 'negative', label: '负向' };
  return { key: 'positive', label: '正向' };
}

const blockPreview = item => promptParts(item, 'positive').join(', ')
  || promptParts(item, 'negative').join(', ')
  || '空块';

/* 素材页签把词条送进方案时走这里；拖拽落点也复用它 */
export function addSourceToPlan(entry, { negativeOnly = false, atIndex = null } = {}) {
  if (itemLocked(entry)) {
    toast('该词条当前处于访问锁定状态', '!');
    return;
  }
  if (!plan()) return;
  const source = negativeOnly
    ? { ...entry, prompt: '', negative: promptParts(entry, 'negative').join(',\n'), characterPrompts: [] }
    : entry;
  const action = commitRelay(next => appendEntryToPlan(next, next.activePlanId, source, { allowDuplicate: true }), { changed: 'plan' });
  if (!action.ok || !action.result?.item) return;
  if (Number.isInteger(atIndex)) {
    commitRelay(next => movePlanItem(next, next.activePlanId, action.result.item.id, atIndex), { changed: 'plan' });
  }
  toast(negativeOnly ? `已加入负向：${entry.title}` : `已加入方案：${entry.title}`, '+');
}

export function beginSourceDrag(entry) { pendingSource = entry; }
export function endSourceDrag() { pendingSource = null; }

/* ---------------- 块 ---------------- */

function selectBlock(itemId) {
  const item = plan()?.items?.find(candidate => candidate.id === itemId);
  if (!item || itemLocked(item)) return;
  selectedItemId = itemId;
  refs.blockTitle.value = item.title;
  refs.blockWeight.value = ['0.8', '1', '1.1', '1.2'].includes(String(item.weight)) ? String(item.weight) : '1';
  refs.blockText.value = promptParts(item, 'positive').join(',\n');
  refs.blockNegative.value = promptParts(item, 'negative').join(',\n');
  refs.inspector.hidden = false;
  renderLane();
}

export function closeInspector() {
  selectedItemId = '';
  if (refs?.inspector) refs.inspector.hidden = true;
  for (const node of refs?.lane.querySelectorAll('.is-selected') || []) node.classList.remove('is-selected');
}

function moveBlock(itemId, delta) {
  const index = plan()?.items?.findIndex(item => item.id === itemId) ?? -1;
  if (index < 0) return;
  commitRelay(next => movePlanItem(next, next.activePlanId, itemId, index + delta), { changed: 'plan' });
}

function removeBlock(itemId) {
  const action = commitRelay(next => removePlanItem(next, next.activePlanId, itemId), { changed: 'plan' });
  if (!action.ok || !action.result) return;
  if (selectedItemId === itemId) closeInspector();
  toast(`已移除：${action.result.title}`, '−');
}

function toggleBlock(itemId) {
  const item = plan()?.items?.find(candidate => candidate.id === itemId);
  if (!item) return;
  commitRelay(next => updatePlanItem(next, next.activePlanId, itemId, { enabled: item.enabled === false }), { changed: 'plan' });
}

function planBlock(item, index, total) {
  const locked = itemLocked(item);
  const block = document.createElement('article');
  block.className = 'tag-relay-block';
  block.classList.toggle('is-selected', selectedItemId === item.id);
  block.classList.toggle('is-disabled', item.enabled === false);
  block.draggable = !locked;
  block.dataset.itemId = item.id;

  const handle = document.createElement('span');
  handle.className = 'tag-relay-block-handle';
  handle.textContent = '⠿';
  handle.setAttribute('aria-hidden', 'true');

  const number = document.createElement('span');
  number.className = 'tag-relay-block-index';
  number.textContent = String(index + 1).padStart(2, '0');

  const copy = document.createElement('div');
  copy.className = 'tag-relay-block-copy';
  const header = document.createElement('header');
  const title = document.createElement('b');
  title.textContent = locked ? '已锁定的成人内容' : item.title;
  const channel = itemChannel(item);
  const chip = document.createElement('span');
  chip.className = `tag-relay-channel ${channel.key}`;
  chip.textContent = locked ? '锁定' : channel.label;
  header.append(title, chip);
  const preview = document.createElement('p');
  preview.textContent = locked ? '当前权限关闭，不参与输出' : blockPreview(item);
  copy.append(header, preview);
  copy.onclick = () => selectBlock(item.id);

  const tools = document.createElement('div');
  tools.className = 'tag-relay-block-tools';
  const tool = (label, titleText, action, disabled = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = titleText;
    button.setAttribute('aria-label', `${titleText}：${item.title}`);
    button.disabled = disabled;
    button.onclick = action;
    return button;
  };
  /* 触屏没有 HTML5 拖放，↑↓ 是那里唯一的排序手段，所以两套都留 */
  tools.append(
    tool('↑', '上移', () => moveBlock(item.id, -1), index === 0),
    tool('↓', '下移', () => moveBlock(item.id, 1), index === total - 1),
    tool(item.enabled === false ? '○' : '●', item.enabled === false ? '启用' : '停用', () => toggleBlock(item.id), locked),
    tool('×', '移除', () => removeBlock(item.id)),
  );

  block.append(handle, number, copy, tools);

  block.addEventListener('dragstart', event => {
    dragBlockId = item.id;
    pendingSource = null;
    block.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
  });
  block.addEventListener('dragend', () => {
    dragBlockId = '';
    block.classList.remove('is-dragging');
  });
  block.addEventListener('dragover', event => {
    if (!dragBlockId && !pendingSource) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = pendingSource ? 'copy' : 'move';
  });
  block.addEventListener('drop', event => {
    if (!dragBlockId && !pendingSource) return;
    event.preventDefault();
    event.stopPropagation();
    if (pendingSource) addSourceToPlan(pendingSource, { atIndex: index });
    else commitRelay(next => movePlanItem(next, next.activePlanId, dragBlockId, index), { changed: 'plan' });
    dragBlockId = '';
    pendingSource = null;
  });
  return block;
}

function renderLane() {
  const items = plan()?.items || [];
  refs.lane.replaceChildren(...items.map((item, index) => planBlock(item, index, items.length)));
  refs.lane.hidden = items.length === 0;
  refs.empty.hidden = items.length !== 0;
}

/* ---------------- 输出 ---------------- */

/* 锁住的块在编译前就摘掉：关掉分级开关后，已存进方案的内容也不该还能被复制出去 */
const safePlan = current => ({ ...current, items: (current?.items || []).filter(item => !itemLocked(item)) });
const joined = tokens => tokens.join(joinMode === 'newline' ? ',\n' : ', ');

/* 去重默认开着（源串里重复的 tag 多半是整理时的手滑），但合掉了什么必须让用户看得见：
   可见计数 + 点开列出合并了哪几条。做成按钮而不是 title，是因为触屏没有 hover。 */
function applyMergedNote(meta, base, merged) {
  if (!meta) return;
  meta.textContent = base;
  const total = mergedTotal(merged);
  if (!total) return;
  const names = merged.map(record => (record.dropped > 1 ? `${record.token} ×${record.dropped + 1}` : record.token));
  const detail = names.slice(0, 6).join('、') + (names.length > 6 ? ` 等 ${names.length} 条` : '');
  const note = document.createElement('button');
  note.type = 'button';
  note.className = 'tag-relay-merged';
  note.textContent = ` · 已合并 ${total} 条重复`;
  note.title = `重复的 tag 只保留第一次：${detail}`;
  note.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    toast(`已合并重复：${detail}`);
  });
  meta.appendChild(note);
}

function renderOutput() {
  const current = plan();
  const compiled = compilePlan(safePlan(current), { target: outputFormat });
  latest = { ...compiled, positive: joined(compiled.positiveTokens), negative: joined(compiled.negativeTokens) };
  refs.positiveOut.value = latest.positive;
  refs.negativeOut.value = latest.negative;
  applyMergedNote(refs.positiveMeta, `${compiled.positiveCount} 段 · ${latest.positive.length} 字符`, compiled.positiveMerged);
  applyMergedNote(refs.negativeMeta, `${compiled.negativeCount} 段 · ${latest.negative.length} 字符`, compiled.negativeMerged);
  refs.copyPositive.disabled = !latest.positive;
  refs.copyNegative.disabled = !latest.negative;
  refs.copyAll.disabled = !latest.positive && !latest.negative;
  const lockedCount = current?.items?.filter(itemLocked).length || 0;
  refs.planStats.textContent = `${current?.items?.length || 0} 个块${lockedCount ? ` · ${lockedCount} 个锁定` : ''}`;
}

function renderPlanControls() {
  const state = relayState();
  refs.planSelect.replaceChildren(...state.plans.map(item => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${item.name} · ${item.items.length}`;
    option.selected = item.id === state.activePlanId;
    return option;
  }));
  refs.deletePlan.disabled = state.plans.length <= 1;
}

export function renderCompose() {
  if (!refs) return;
  renderPlanControls();
  renderLane();
  renderOutput();
  if (!plan()?.items?.some(item => item.id === selectedItemId)) closeInspector();
}

function outputText(channel) {
  if (channel === 'positive') return latest.positive;
  if (channel === 'negative') return latest.negative;
  const sections = [];
  if (latest.positive) sections.push(latest.positive);
  if (latest.negative) sections.push(`Negative:\n${latest.negative}`);
  return sections.join('\n\n');
}

async function copyOutput(channel, trigger) {
  /* 先重编译再复制：另一个标签页可能刚刚改过分级开关，不能把上一次渲染留下的
     缓存文本原样发出去。 */
  renderOutput();
  const text = outputText(channel);
  if (!text) {
    toast('当前没有可复制内容', '!');
    return;
  }
  const label = channel === 'both' ? '完整方案' : (channel === 'positive' ? '正向' : '负向');
  /* ⚠ convert:false —— 格式已经由上面的 NAI/SD/纯文本 选择器决定过了，
     再让 copyText 按全局 SD 开关转一次就是二次转换。
     也不传 entry：中转站自己的成品不该再回流进「最近复制」，否则复制一次成品，
     成品又变成新料。 */
  copyText(text, `已复制${label}`, trigger, { convert: false });
}

/* ---------------- 绑定 ---------------- */

function bindPlanBar() {
  refs.planSelect.addEventListener('change', () => {
    commitRelay(next => setActivePlan(next, refs.planSelect.value), { changed: 'plan' });
    closeInspector();
  });
  const menu = refs.planMenu;
  const closeMenu = () => { menu.hidden = true; refs.planMenuBtn.setAttribute('aria-expanded', 'false'); };
  refs.planMenuBtn.addEventListener('click', event => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
    refs.planMenuBtn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', event => {
    if (!menu.hidden && !menu.contains(event.target) && event.target !== refs.planMenuBtn) closeMenu();
  });

  refs.newPlan.addEventListener('click', () => {
    closeMenu();
    const action = commitRelay(next => createPlan(next), { changed: 'plan' });
    if (action.ok) toast('已新建方案', '+');
  });
  refs.duplicatePlan.addEventListener('click', () => {
    closeMenu();
    const source = plan();
    if (!source) return;
    commitRelay(next => {
      const created = createPlan(next, `${source.name} 副本`);
      for (const item of source.items) {
        appendEntryToPlan(next, created.id, item, { allowDuplicate: true, enabled: item.enabled !== false, weight: item.weight });
      }
      return created;
    }, { changed: 'plan' });
    toast('已复制为副本', '+');
  });
  refs.renamePlan.addEventListener('click', () => {
    closeMenu();
    const current = plan();
    if (!current) return;
    const name = window.prompt('方案名称', current.name);
    if (!name) return;
    commitRelay(next => renamePlan(next, next.activePlanId, name), { changed: 'plan' });
  });
  refs.deletePlan.addEventListener('click', () => {
    closeMenu();
    const current = plan();
    if (!current || relayState().plans.length <= 1) return;
    if (!window.confirm(`确认删除「${current.name}」？`)) return;
    commitRelay(next => deletePlan(next, next.activePlanId), { changed: 'plan' });
    closeInspector();
  });
}

function bindInspector() {
  refs.inspectorClose.addEventListener('click', closeInspector);
  refs.blockRemove.addEventListener('click', () => { if (selectedItemId) removeBlock(selectedItemId); });
  refs.blockSave.addEventListener('click', () => {
    if (!selectedItemId) return;
    commitRelay(next => updatePlanItem(next, next.activePlanId, selectedItemId, {
      title: refs.blockTitle.value,
      weight: Number(refs.blockWeight.value) || 1,
      prompt: refs.blockText.value,
      negative: refs.blockNegative.value,
      characterPrompts: [],
    }), { changed: 'plan' });
    toast('已保存修改', '✓');
  });
}

function bindSegments() {
  refs.formatButtons.forEach(button => button.addEventListener('click', () => {
    outputFormat = button.dataset.format;
    refs.formatButtons.forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    renderOutput();
  }));
  refs.joinButtons.forEach(button => button.addEventListener('click', () => {
    joinMode = button.dataset.join;
    refs.joinButtons.forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    renderOutput();
  }));
}

function bindLaneDrop() {
  for (const target of [refs.lane, refs.empty]) {
    target.addEventListener('dragover', event => {
      if (!pendingSource && !dragBlockId) return;
      event.preventDefault();
      target.classList.add('is-drop-target');
    });
    target.addEventListener('dragleave', () => target.classList.remove('is-drop-target'));
    target.addEventListener('drop', event => {
      target.classList.remove('is-drop-target');
      if (!pendingSource) return;
      event.preventDefault();
      addSourceToPlan(pendingSource);
      pendingSource = null;
    });
  }
}

/* Esc 由内向外：编辑器开着时先关编辑器，别一路把整个侧栏关掉 */
function bindEscape(root) {
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!refs.planMenu.hidden) {
      event.stopPropagation();
      refs.planMenu.hidden = true;
      refs.planMenuBtn.setAttribute('aria-expanded', 'false');
      return;
    }
    if (!refs.inspector.hidden) {
      event.stopPropagation();
      closeInspector();
    }
  });
}

export function setupRelayCompose(root) {
  if (!root) return { render: () => {} };
  const q = selector => root.querySelector(selector);
  refs = {
    root,
    planSelect: q('#relayPlanSelect'),
    planMenuBtn: q('#relayPlanMenuBtn'),
    planMenu: q('#relayPlanMenu'),
    newPlan: q('#relayNewPlan'),
    duplicatePlan: q('#relayDuplicatePlan'),
    renamePlan: q('#relayRenamePlan'),
    deletePlan: q('#relayDeletePlan'),
    planStats: q('#relayPlanStats'),
    lane: q('#relayPlanLane'),
    empty: q('#relayPlanEmpty'),
    inspector: q('#relayInspector'),
    inspectorClose: q('#relayInspectorClose'),
    blockTitle: q('#relayBlockTitle'),
    blockWeight: q('#relayBlockWeight'),
    blockText: q('#relayBlockText'),
    blockNegative: q('#relayBlockNegative'),
    blockRemove: q('#relayBlockRemove'),
    blockSave: q('#relayBlockSave'),
    positiveOut: q('#relayPositiveOutput'),
    negativeOut: q('#relayNegativeOutput'),
    positiveMeta: q('#relayPositiveMeta'),
    negativeMeta: q('#relayNegativeMeta'),
    copyPositive: q('#relayCopyPositive'),
    copyNegative: q('#relayCopyNegative'),
    copyAll: q('#relayCopyAll'),
    formatButtons: [...root.querySelectorAll('[data-format]')],
    joinButtons: [...root.querySelectorAll('[data-join]')],
  };
  if (!bound) {
    bound = true;
    bindPlanBar();
    bindInspector();
    bindSegments();
    bindLaneDrop();
    bindEscape(root);
    refs.copyPositive.addEventListener('click', event => copyOutput('positive', event.currentTarget));
    refs.copyNegative.addEventListener('click', event => copyOutput('negative', event.currentTarget));
    refs.copyAll.addEventListener('click', event => copyOutput('both', event.currentTarget));
  }
  renderCompose();
  return { render: renderCompose, closeInspector };
}
