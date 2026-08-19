/* 侧栏「编排」分区：方案条 + 块轨道 + 块编辑器 + 贴底的成品与复制。
   编排和输出刻意合成一屏而不是两个页签——核心场景是「反复组合再复制」，
   分开的话每复制一次都要切一次页。

   所有 DOM 查询都限定在分区根节点内（refs 一次解析好），不再是 document 全局：
   [data-format] 这类选择器在整站范围里迟早会撞车。 */

import { toast } from './feedback.js';
import { copyText } from './copy.js';
import {
  appendBlockToPlan,
  appendEntryToPlan,
  clearCopyHistory,
  compilePlan,
  createPlan,
  deletePlan,
  getActivePlan,
  itemHasCharacterNegative,
  mergedTotal,
  movePlanItem,
  recordCopyHistory,
  removePlanItem,
  renamePlan,
  restoreHistoryAsPlan,
  setActivePlan,
  updatePlanItem,
} from './tag-relay-core.js';
import { snapshotLocked } from './tag-relay-snapshot.js';
import { commitRelay, relayState } from './tag-relay-store.js';

let refs = null;
let bound = false;
let selectedItemId = '';
let creatingBlock = false;
let outputFormat = 'nai';
let joinMode = 'comma';
let latest = { positive: '', negative: '', positiveTokens: [], negativeTokens: [] };
let dragBlockId = '';
let pendingSource = null;
let historyOpen = false;

const plan = () => getActivePlan(relayState());
const itemLocked = item => snapshotLocked(item);

/* 与 core 的 itemPrompt 同一套规则：负向只取词条级，角色级负面不并入 */
function promptParts(item, channel) {
  if (channel === 'negative') {
    const value = String(item?.negative || '').trim();
    return value ? [value] : [];
  }
  const parts = [item?.prompt];
  for (const character of item?.characterPrompts || []) parts.push(character.prompt);
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
  const action = commitRelay(next => {
    const appended = appendEntryToPlan(next, next.activePlanId, source, { allowDuplicate: true });
    if (appended.item && Number.isInteger(atIndex)) {
      movePlanItem(next, next.activePlanId, appended.item.id, atIndex);
    }
    return appended;
  }, { changed: 'plan' });
  if (!action.ok || !action.result?.item) return;
  toast(negativeOnly ? `已加入负向：${entry.title}` : `已加入方案：${entry.title}`, '+');
}

/* 手写块：原始需求里的「随意放入含有标题的小方块」。数据层一直支持 kind:'block'，
   但并入侧栏时漏了 UI 入口，等于这条需求只剩数据没有门。 */
function addManualBlock() {
  creatingBlock = true;
  selectedItemId = '';
  refs.inspectorTitle.textContent = '新建自定义块';
  refs.blockTitle.value = '自定义块';
  refs.blockWeight.value = '1';
  refs.blockText.value = '';
  refs.blockNegative.value = '';
  refs.blockChars.textContent = '';
  refs.blockChars.hidden = true;
  refs.blockRemove.textContent = '取消';
  refs.blockSave.textContent = '加入方案';
  refs.inspector.hidden = false;
  renderLane();
  refs.blockTitle.focus();
  refs.blockTitle.select();
}

export function beginSourceDrag(entry) { pendingSource = entry; }
export function endSourceDrag() { pendingSource = null; }

/* ---------------- 块 ---------------- */

function selectBlock(itemId) {
  const item = plan()?.items?.find(candidate => candidate.id === itemId);
  if (!item || itemLocked(item)) return;
  creatingBlock = false;
  selectedItemId = itemId;
  refs.inspectorTitle.textContent = '编辑块';
  refs.blockTitle.value = item.title;
  refs.blockWeight.value = String(item.weight ?? 1);
  /* ⚠ 只编词条级 prompt / negative。以前这里把角色词摊平进正向框，保存时又把
     characterPrompts 清空——用户点开看一眼再保存，角色分槽结构就永久没了。 */
  refs.blockText.value = String(item.prompt || '');
  refs.blockNegative.value = String(item.negative || '');
  const chars = item.characterPrompts || [];
  if (refs.blockChars) {
    refs.blockChars.hidden = chars.length === 0;
    refs.blockChars.textContent = chars.length
      ? `含 ${chars.length} 组角色词，随块保留、不在此编辑${itemHasCharacterNegative(item) ? '；其中的角色级负面不并入负向输出' : ''}`
      : '';
  }
  refs.blockRemove.textContent = '从方案移除';
  refs.blockSave.textContent = '保存修改';
  refs.inspector.hidden = false;
  renderLane();
}

/* 分级开关由主站 ui.js 显式通知。撤权时不只重绘轨道：编辑器里的输入框本身也
   可能仍然留着成人明文，必须立即关掉并清空，避免随后保存或复制。 */
export function refreshComposeAccess() {
  if (!refs) return;
  const selected = selectedItemId
    ? plan()?.items?.find(item => item.id === selectedItemId)
    : null;
  /* 解锁或切换其它安全项不应销毁用户正在编辑的草稿；只有当前选中块
     已变成锁定状态（或从活动方案消失）时，才需要撤掉编辑器里的明文。 */
  if (!selectedItemId || (selected && !itemLocked(selected))) return;
  closeInspector();
  for (const field of [refs.blockTitle, refs.blockWeight, refs.blockText, refs.blockNegative, refs.blockChars]) {
    if (!field) continue;
    if ('value' in field) field.value = '';
    else field.textContent = '';
    field.hidden = field === refs.blockChars;
  }
}

export function closeInspector() {
  creatingBlock = false;
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
  const title = itemLocked(action.result) ? '已锁定的成人内容' : action.result.title;
  toast(`已移除：${title}`, '−');
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
  if (!locked) {
    copy.setAttribute('role', 'button');
    copy.tabIndex = 0;
    copy.setAttribute('aria-label', `编辑块：${item.title}`);
  }
  const header = document.createElement('header');
  const title = document.createElement('b');
  title.textContent = locked ? '已锁定的成人内容' : item.title;
  const channel = itemChannel(item);
  const chip = document.createElement('span');
  chip.className = `tag-relay-channel ${channel.key}`;
  chip.textContent = locked ? '锁定' : channel.label;
  header.append(title, chip);
  if (!locked && itemHasCharacterNegative(item)) {
    const warn = document.createElement('span');
    warn.className = 'tag-relay-channel warn';
    warn.textContent = '角色负面未并入';
    warn.title = '角色级负面在 NovelAI 里按角色分槽填，合并没有意义，不会进入负向输出';
    header.append(warn);
  }
  const preview = document.createElement('p');
  preview.textContent = locked ? '当前权限关闭，不参与输出' : blockPreview(item);
  copy.append(header, preview);
  copy.onclick = () => selectBlock(item.id);
  copy.onkeydown = event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectBlock(item.id);
  };

  const tools = document.createElement('div');
  tools.className = 'tag-relay-block-tools';
  const tool = (label, titleText, action, disabled = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = titleText;
    button.setAttribute('aria-label', `${titleText}：${locked ? '已锁定的成人内容' : item.title}`);
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
  const tabCount = document.querySelector('#tagRelayComposeCount');
  if (tabCount) {
    const n = current?.items?.length || 0;
    tabCount.textContent = n ? String(n) : '';
    tabCount.hidden = !n;
  }
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

function historyRecordLocked(record) {
  /* 没有完整方案快照的早期记录无法证明输出来自哪些权限范围，宁可锁住，
     也不能把孤立的旧 output 字符串重新放进页面或剪贴板。 */
  if (record?.snapshotComplete !== true) return true;
  const items = Array.isArray(record.plan?.items) ? record.plan.items : [];
  if (!items.length && (record.positive || record.negative)) return true;
  return items.some(itemLocked);
}

function historyOutput(record, channel = record?.channel) {
  if (channel === 'positive') return String(record?.positive || '').trim();
  if (channel === 'negative') return String(record?.negative || '').trim();
  const sections = [];
  if (String(record?.positive || '').trim()) sections.push(String(record.positive).trim());
  if (String(record?.negative || '').trim()) sections.push(`Negative:\n${String(record.negative).trim()}`);
  return sections.join('\n\n');
}

function historyTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '较早记录';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function copyHistoryRecord(record, channel, trigger) {
  if (historyRecordLocked(record)) {
    toast('这条复制历史包含当前锁定内容，暂不可使用', '!');
    return;
  }
  const text = historyOutput(record, channel);
  if (!text) {
    toast('这条历史没有可复制内容', '!');
    return;
  }
  const label = channel === 'both' ? '完整方案' : (channel === 'positive' ? '正向' : '负向');
  await copyText(text, `已复制历史${label}`, trigger, {
    convert: false,
    sampleLabel: `已复制历史${label}`,
  });
}

function restoreHistoryRecord(record) {
  if (historyRecordLocked(record)) {
    toast('这条复制历史包含当前锁定内容，暂不可恢复', '!');
    return;
  }
  const action = commitRelay(next => restoreHistoryAsPlan(next, record.id), { changed: 'plan' });
  if (!action.ok || !action.result) return;
  historyOpen = false;
  toast(`已恢复方案：${action.result.name}`, '+');
}

function renderHistory() {
  if (!refs?.historyPanel) return;
  refs.historyPanel.hidden = !historyOpen;
  refs.historyToggle?.setAttribute('aria-expanded', String(historyOpen));
  const records = relayState().history || [];
  refs.historyStatus.textContent = records.length ? String(records.length) : '';
  refs.historyClear.disabled = records.length === 0;
  refs.historyList.replaceChildren();
  if (!historyOpen) return;
  if (!records.length) {
    const empty = document.createElement('p');
    empty.className = 'tag-relay-history-empty';
    empty.textContent = '复制过的方案会留在这里，方便对比和恢复。';
    refs.historyList.append(empty);
    return;
  }
  for (const record of records) {
    const locked = historyRecordLocked(record);
    const card = document.createElement('article');
    card.className = 'tag-relay-history-card';
    const head = document.createElement('header');
    const title = document.createElement('b');
    title.textContent = locked ? '已锁定的复制历史' : (record.label || record.planName || '复制历史');
    const time = document.createElement('time');
    time.dateTime = record.createdAt || '';
    time.textContent = locked ? '当前权限已关闭' : historyTime(record.createdAt);
    head.append(title, time);
    const preview = document.createElement('p');
    preview.textContent = locked
      ? '这条记录含有当前不可用的内容，重新开启对应权限后可继续使用。'
      : historyOutput(record).slice(0, 180);
    card.append(head, preview);
    const actions = document.createElement('div');
    actions.className = 'tag-relay-history-actions';
    if (locked) {
      const lockedNote = document.createElement('span');
      lockedNote.className = 'tag-relay-history-locked';
      lockedNote.textContent = '已锁定';
      actions.append(lockedNote);
    } else {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = '再次复制';
      copy.onclick = () => copyHistoryRecord(record, record.channel, copy);
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.textContent = '恢复为方案';
      restore.onclick = () => restoreHistoryRecord(record);
      actions.append(copy, restore);
    }
    card.append(actions);
    refs.historyList.append(card);
  }
}

export function renderCompose() {
  if (!refs) return;
  renderPlanControls();
  renderLane();
  renderOutput();
  renderHistory();
  if (!creatingBlock && selectedItemId && !plan()?.items?.some(item => item.id === selectedItemId)) closeInspector();
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
  const sourcePlan = safePlan(plan());
  const historyPlan = sourcePlan ? { ...sourcePlan, items: [...sourcePlan.items] } : null;
  const historyOutputSnapshot = {
    positive: latest.positive,
    negative: latest.negative,
    positiveCount: latest.positiveCount,
    negativeCount: latest.negativeCount,
  };
  const result = await copyText(text, `已复制${label}`, trigger, { convert: false, sampleLabel: `已复制${label}` });
  if (!result?.ok || !historyPlan) return;
  commitRelay(next => recordCopyHistory(next, {
    label: `${historyPlan.name} · ${label}`,
    planId: historyPlan.id,
    plan: historyPlan,
    target: outputFormat,
    joinMode,
    channel,
    output: historyOutputSnapshot,
  }), { changed: 'history' });
}

/* ---------------- 绑定 ---------------- */

function bindPlanBar() {
  refs.planSelect.addEventListener('change', () => {
    const action = commitRelay(next => setActivePlan(next, refs.planSelect.value), { changed: 'plan' });
    if (action.ok) closeInspector();
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

  refs.historyToggle?.addEventListener('click', () => {
    closeMenu();
    historyOpen = !historyOpen;
    renderHistory();
  });
  refs.historyClose?.addEventListener('click', () => {
    historyOpen = false;
    renderHistory();
  });
  refs.historyClear?.addEventListener('click', () => {
    const count = relayState().history.length;
    if (!count || !window.confirm(`确认清空 ${count} 条复制历史？`)) return;
    const action = commitRelay(next => clearCopyHistory(next), { changed: 'history' });
    if (action.ok) toast('已清空复制历史', '−');
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
    const action = commitRelay(next => {
      const created = createPlan(next, `${source.name} 副本`);
      for (const item of source.items) {
        /* ⚠ 按原本的 kind 复制。以前一律走 appendEntryToPlan，手写块会被悄悄转成
           entry，标题与来源信息错位且不可逆。 */
        const options = { allowDuplicate: true, enabled: item.enabled !== false, weight: item.weight };
        if (item.kind === 'block') appendBlockToPlan(next, created.id, item, options);
        else appendEntryToPlan(next, created.id, item, options);
      }
      return created;
    }, { changed: 'plan' });
    if (action.ok) toast('已复制为副本', '+');
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
    const action = commitRelay(next => deletePlan(next, next.activePlanId), { changed: 'plan' });
    if (action.ok) closeInspector();
  });
}

function editorWeight() {
  const weight = Number(refs.blockWeight.value);
  if (Number.isFinite(weight) && weight >= 0.05 && weight <= 10) return weight;
  toast('权重需填写 0.05 到 10 之间的数字', '!');
  refs.blockWeight.focus();
  return null;
}

function bindInspector() {
  refs.addBlock?.addEventListener('click', addManualBlock);
  refs.inspectorClose.addEventListener('click', closeInspector);
  refs.blockRemove.addEventListener('click', () => {
    if (creatingBlock) closeInspector();
    else if (selectedItemId) removeBlock(selectedItemId);
  });
  refs.blockSave.addEventListener('click', () => {
    const weight = editorWeight();
    if (weight === null) return;
    if (creatingBlock) {
      const action = commitRelay(next => appendBlockToPlan(next, next.activePlanId, {
        title: refs.blockTitle.value || '自定义块',
        weight,
        prompt: refs.blockText.value,
        negative: refs.blockNegative.value,
      }), { changed: 'plan' });
      if (!action.ok) return;
      closeInspector();
      toast('已加入自定义块', '+');
      return;
    }
    if (!selectedItemId) return;
    const current = plan()?.items?.find(item => item.id === selectedItemId);
    if (!current || itemLocked(current)) {
      refreshComposeAccess();
      toast('该词条当前处于访问锁定状态', '!');
      return;
    }
    const action = commitRelay(next => updatePlanItem(next, next.activePlanId, selectedItemId, {
      title: refs.blockTitle.value,
      weight,
      prompt: refs.blockText.value,
      negative: refs.blockNegative.value,
      /* characterPrompts 原样保留：编辑器不碰它，就不该顺手清掉 */
    }), { changed: 'plan' });
    /* 配额写失败时 commitRelay 会返回 ok:false 并自己弹错误，这里不能再报成功 */
    if (action.ok) toast('已保存修改', '✓');
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
      if (!pendingSource && !dragBlockId) return;
      event.preventDefault();
      if (pendingSource) {
        addSourceToPlan(pendingSource);
        pendingSource = null;
        return;
      }
      /* 已有块拖到轨道空白处 = 移到末尾。以前这里直接 return，只有拖到另一块上才生效，
         轨道下方那片空白看着像落点却没反应。 */
      const items = plan()?.items || [];
      commitRelay(next => movePlanItem(next, next.activePlanId, dragBlockId, items.length - 1), { changed: 'plan' });
      dragBlockId = '';
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
      return;
    }
    if (historyOpen) {
      event.stopPropagation();
      historyOpen = false;
      renderHistory();
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
    historyToggle: q('#relayHistoryToggle'),
    historyPanel: q('#relayCopyHistory'),
    historyClose: q('#relayHistoryClose'),
    historyClear: q('#relayHistoryClear'),
    historyStatus: q('#relayHistoryStatus'),
    historyList: q('#relayHistoryList'),
    newPlan: q('#relayNewPlan'),
    duplicatePlan: q('#relayDuplicatePlan'),
    renamePlan: q('#relayRenamePlan'),
    deletePlan: q('#relayDeletePlan'),
    planStats: q('#relayPlanStats'),
    addBlock: q('#relayAddBlock'),
    lane: q('#relayPlanLane'),
    empty: q('#relayPlanEmpty'),
    inspector: q('#relayInspector'),
    inspectorTitle: q('#relayInspectorTitle'),
    inspectorClose: q('#relayInspectorClose'),
    blockTitle: q('#relayBlockTitle'),
    blockWeight: q('#relayBlockWeight'),
    blockText: q('#relayBlockText'),
    blockNegative: q('#relayBlockNegative'),
    blockChars: q('#relayBlockChars'),
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
