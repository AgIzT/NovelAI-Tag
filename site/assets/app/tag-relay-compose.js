/* 侧栏「编排」分区：方案条 + 块轨道 + 块编辑器 + 贴底的成品与复制。
   编排和输出刻意合成一屏而不是两个页签——核心场景是「反复组合再复制」，
   分开的话每复制一次都要切一次页。

   所有 DOM 查询都限定在分区根节点内（refs 一次解析好），不再是 document 全局：
   [data-format] 这类选择器在整站范围里迟早会撞车。 */

import { toast } from './feedback.js';
import { copyText } from './copy.js';
import { requestRelayAction } from './tag-relay-action.js';
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
  weightAppliesTo,
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
let historyOpen = false;
let orphanedDraft = null;
let editorPlanId = '';
let editorAccessSnapshot = null;

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

/* 素材页签把词条送进方案时走这里。素材与编排是互斥页签，所以来源条目
   明确用按钮加入；拖拽只留给编排轨道内的重新排序。 */
export async function addSourceToPlan(entry, { negativeOnly = false } = {}) {
  if (itemLocked(entry)) {
    toast('该词条当前处于访问锁定状态', '!');
    return;
  }
  if (!plan()) return;
  const source = negativeOnly
    ? { ...entry, prompt: '', negative: promptParts(entry, 'negative').join(',\n'), characterPrompts: [] }
    : entry;
  const action = await commitRelay(
    next => appendEntryToPlan(next, next.activePlanId, source, { allowDuplicate: true }),
    { changed: 'plan' },
  );
  if (!action.ok || !action.result?.item) return;
  toast(negativeOnly ? `已加入负向：${entry.title}` : `已加入方案：${entry.title}`, '+');
}

/* 手写块：原始需求里的「随意放入含有标题的小方块」。数据层一直支持 kind:'block'，
   但并入侧栏时漏了 UI 入口，等于这条需求只剩数据没有门。 */
function addManualBlock() {
  orphanedDraft = null;
  creatingBlock = true;
  selectedItemId = '';
  editorPlanId = plan()?.id || '';
  editorAccessSnapshot = null;
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

/* ---------------- 块 ---------------- */

function selectBlock(itemId) {
  const item = plan()?.items?.find(candidate => candidate.id === itemId);
  if (!item || itemLocked(item)) return;
  creatingBlock = false;
  selectedItemId = itemId;
  editorPlanId = plan()?.id || '';
  editorAccessSnapshot = item;
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
  orphanedDraft = null;
  refs.inspector.hidden = false;
  renderLane();
}

/* 分级开关由主站 ui.js 显式通知。撤权时不只重绘轨道：编辑器里的输入框本身也
   可能仍然留着成人明文，必须立即关掉并清空，避免随后保存或复制。 */
export function refreshComposeAccess() {
  if (!refs) return;
  const orphanLocked = orphanedDraft?.accessSnapshot && itemLocked(orphanedDraft.accessSnapshot);
  if (orphanLocked) {
    orphanedDraft = null;
    closeInspector();
    for (const field of [refs.blockTitle, refs.blockWeight, refs.blockText, refs.blockNegative, refs.blockChars]) {
      if (!field) continue;
      if ('value' in field) field.value = '';
      else field.textContent = '';
      field.hidden = field === refs.blockChars;
    }
    return;
  }
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

function draftFromInspector() {
  if (!refs?.inspector || refs.inspector.hidden || (!creatingBlock && !selectedItemId)) return null;
  return {
    planId: editorPlanId,
    mode: creatingBlock ? 'create' : 'edit',
    itemId: selectedItemId,
    title: refs.blockTitle.value,
    weight: refs.blockWeight.value,
    prompt: refs.blockText.value,
    negative: refs.blockNegative.value,
    characterPrompts: editorAccessSnapshot?.characterPrompts || [],
    accessSnapshot: editorAccessSnapshot,
  };
}

function preserveOrphanedDraft() {
  const draft = draftFromInspector();
  if (draft) orphanedDraft = draft;
}

function renderOrphanedDraft() {
  if (!orphanedDraft || !refs?.inspector || !refs.inspector.hidden) return;
  refs.inspectorTitle.textContent = '未保存的编辑';
  refs.blockTitle.value = orphanedDraft.title;
  refs.blockWeight.value = orphanedDraft.weight;
  refs.blockText.value = orphanedDraft.prompt;
  refs.blockNegative.value = orphanedDraft.negative;
  refs.blockChars.hidden = true;
  refs.blockRemove.textContent = '放弃草稿';
  refs.blockSave.textContent = '新建为自定义块';
  refs.inspector.hidden = false;
  selectedItemId = '';
  creatingBlock = false;
  editorPlanId = plan()?.id || '';
  editorAccessSnapshot = orphanedDraft.accessSnapshot || null;
}

export function closeInspector() {
  creatingBlock = false;
  selectedItemId = '';
  editorPlanId = '';
  editorAccessSnapshot = null;
  if (refs?.inspector) refs.inspector.hidden = true;
  for (const node of refs?.lane.querySelectorAll('.is-selected') || []) node.classList.remove('is-selected');
}

/* 轨道自己不再当活区（每次全量重建会让读屏把 N 个块重念一遍），
   结果改由这个 sr-only 的 role="status" 播一句短的。 */
function announceLane(message) {
  if (!refs?.laneStatus) return;
  /* 连点两次「上移」的文案可能一模一样，活区不会重播；先清空强制它认成新内容 */
  refs.laneStatus.textContent = '';
  refs.laneStatus.textContent = String(message || '');
}

async function moveBlock(itemId, delta) {
  const index = plan()?.items?.findIndex(item => item.id === itemId) ?? -1;
  if (index < 0) return;
  await commitRelay(next => movePlanItem(next, next.activePlanId, itemId, index + delta), { changed: 'plan' });
  const items = plan()?.items || [];
  const moved = items.findIndex(item => item.id === itemId);
  if (moved < 0) return;
  /* ↑↓ 在触屏上是唯一的排序手段，却没有任何非视觉反馈；toast 留给增删，这里只播位置 */
  announceLane(`已${delta < 0 ? '上移' : '下移'}到第 ${moved + 1} 位 · 共 ${items.length} 块`);
}

async function removeBlock(itemId) {
  const action = await commitRelay(next => removePlanItem(next, next.activePlanId, itemId), { changed: 'plan' });
  if (!action.ok || !action.result) return;
  if (selectedItemId === itemId) closeInspector();
  const title = itemLocked(action.result) ? '已锁定的成人内容' : action.result.title;
  toast(`已移除：${title}`, '−');
}

async function toggleBlock(itemId) {
  const item = plan()?.items?.find(candidate => candidate.id === itemId);
  if (!item) return;
  const enabled = item.enabled === false;
  await commitRelay(next => updatePlanItem(next, next.activePlanId, itemId, { enabled }), { changed: 'plan' });
  /* 停用 / 启用没有 toast，视觉上只是块变淡，读屏用户什么都听不到 */
  announceLane(`${enabled ? '已启用' : '已停用'}：${itemLocked(item) ? '已锁定的成人内容' : item.title}`);
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
    block.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
  });
  block.addEventListener('dragend', () => {
    dragBlockId = '';
    block.classList.remove('is-dragging');
  });
  block.addEventListener('dragover', event => {
    if (!dragBlockId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });
  block.addEventListener('drop', async event => {
    if (!dragBlockId) return;
    event.preventDefault();
    event.stopPropagation();
    await commitRelay(next => movePlanItem(next, next.activePlanId, dragBlockId, index), { changed: 'plan' });
    dragBlockId = '';
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
  /* 外框已从 <label> 换成 <div>（label 内嵌按钮是无效 HTML），不再需要 preventDefault
     去压 label 的转发点击；stopPropagation 留着，免得将来给输出框加整块点击时被顺带触发。 */
  note.addEventListener('click', event => {
    event.stopPropagation();
    toast(`已合并重复：${detail}`);
  });
  meta.appendChild(note);
}

/* 角标与「N 个块」必须独立于 renderOutput：在「素材」页签加块时 compose 不是当前分区，
   flush() 会整个跳过 renderCompose，角标就停在旧数字上——而页签上那个数字正是
   「刚加进去了」的唯一反馈。所以这一小段拆出来，由 subscribeRelay 无条件跑。 */
export function renderComposeCounters() {
  const current = plan();
  const total = current?.items?.length || 0;
  const tabCount = document.querySelector('#tagRelayComposeCount');
  if (tabCount) {
    tabCount.textContent = total ? String(total) : '';
    tabCount.hidden = !total;
  }
  /* refs 要等 setupRelayCompose 才填，订阅可能先到 */
  if (!refs.planStats) return;
  const lockedCount = current?.items?.filter(itemLocked).length || 0;
  refs.planStats.textContent = `${total} 个块${lockedCount ? ` · ${lockedCount} 个锁定` : ''}`;
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
  renderComposeCounters();
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

/* 历史记录不可用有两种成因，界面必须分开说：
   - 'stale'：早期版本留下的记录没有完整方案快照，无法证明输出来自哪些权限范围。
     这是数据本身的缺陷，⚠ 用户把分级开关全打开也解不开，说成「权限变化」是在骗他去试。
   - 'locked'：快照完整，但里面有条目被当前分级开关关掉了，开回来就能继续用。
   返回空字符串表示可用。 */
function historyLockReason(record) {
  if (record?.snapshotComplete !== true) return 'stale';
  const items = Array.isArray(record.plan?.items) ? record.plan.items : [];
  if (!items.length && (record.positive || record.negative)) return 'stale';
  return items.some(itemLocked) ? 'locked' : '';
}

function historyRecordLocked(record) {
  return historyLockReason(record) !== '';
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
  const reason = historyLockReason(record);
  if (reason === 'stale') {
    toast('这条复制历史是旧版本留下的，缺少方案快照，不能再复制', '!');
    return;
  }
  if (reason) {
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
    accessGuard: () => !historyRecordLocked(record),
    onAccessBlocked: () => toast('这条复制历史已因权限变化锁定', '!'),
  });
}

async function restoreHistoryRecord(record) {
  const reason = historyLockReason(record);
  if (reason === 'stale') {
    toast('这条复制历史是旧版本留下的，缺少方案快照，不能恢复', '!');
    return;
  }
  if (reason) {
    toast('这条复制历史包含当前锁定内容，暂不可恢复', '!');
    return;
  }
  /* 分级把关下沉到 core：视图层这一处判断只是提前给提示，真正的不变式由 isLocked 谓词
     在 restoreHistoryAsPlan 内部兜住——任一条目命中就整条拒绝、返回 null。
     ⚠ core 不许 import 分级状态（要能零 DOM 直测），所以谓词必须由这里注入。 */
  const action = await commitRelay(next => restoreHistoryAsPlan(next, record.id, { isLocked: itemLocked }), { changed: 'plan' });
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
    const reason = historyLockReason(record);
    const stale = reason === 'stale';
    const locked = reason !== '';
    const card = document.createElement('article');
    card.className = 'tag-relay-history-card';
    const head = document.createElement('header');
    const title = document.createElement('b');
    title.textContent = stale
      ? '缺少快照的旧记录'
      : (locked ? '已锁定的复制历史' : (record.label || record.planName || '复制历史'));
    const time = document.createElement('time');
    time.dateTime = record.createdAt || '';
    time.textContent = stale ? '旧版本记录' : (locked ? '当前权限已关闭' : historyTime(record.createdAt));
    head.append(title, time);
    const preview = document.createElement('p');
    /* 两句话必须不一样：「开开关就能解锁」只对 locked 成立，对 stale 是死路。 */
    preview.textContent = stale
      ? '这条记录来自旧版本，没有留下方案快照，无法再复制或恢复，可以直接清掉。'
      : (locked
        ? '这条记录含有当前不可用的内容，重新开启对应权限后可继续使用。'
        : historyOutput(record).slice(0, 180));
    card.append(head, preview);
    const actions = document.createElement('div');
    actions.className = 'tag-relay-history-actions';
    if (locked) {
      const lockedNote = document.createElement('span');
      lockedNote.className = 'tag-relay-history-locked';
      lockedNote.textContent = stale ? '缺少快照' : '已锁定';
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
  const current = plan();
  const editorTargetGone = !refs.inspector.hidden && editorPlanId && (
    current?.id !== editorPlanId
    || (!creatingBlock && selectedItemId && !current?.items?.some(item => item.id === selectedItemId))
  );
  if (editorTargetGone) {
    preserveOrphanedDraft();
    closeInspector();
    renderOrphanedDraft();
  }
  renderPlanControls();
  renderLane();
  renderOutput();
  renderHistory();
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
  const result = await copyText(text, `已复制${label}`, trigger, {
    convert: false,
    sampleLabel: `已复制${label}`,
    accessGuard: () => historyPlan.items.every(item => !itemLocked(item)),
    onAccessBlocked: () => toast('方案中有内容已因权限变化锁定', '!'),
  });
  if (!result?.ok || !historyPlan) return;
  await commitRelay(next => recordCopyHistory(next, {
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
  refs.planSelect.addEventListener('change', async () => {
    await commitRelay(next => setActivePlan(next, refs.planSelect.value), { changed: 'plan' });
  });
  const menu = refs.planMenu;
  const menuItems = () => [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
  const closeMenu = ({ restoreFocus = false } = {}) => {
    menu.hidden = true;
    refs.planMenuBtn.setAttribute('aria-expanded', 'false');
    if (restoreFocus) refs.planMenuBtn.focus({ preventScroll: true });
  };
  const openMenu = (focus = 'first') => {
    menu.hidden = false;
    refs.planMenuBtn.setAttribute('aria-expanded', 'true');
    const items = menuItems();
    (focus === 'last' ? items.at(-1) : items[0])?.focus({ preventScroll: true });
  };
  refs.planMenuBtn.addEventListener('click', event => {
    event.stopPropagation();
    if (menu.hidden) openMenu();
    else closeMenu({ restoreFocus: true });
  });
  refs.planMenuBtn.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    openMenu(event.key === 'ArrowUp' ? 'last' : 'first');
  });
  menu.addEventListener('keydown', event => {
    const items = menuItems();
    if (!items.length) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu({ restoreFocus: true });
      return;
    }
    if (event.key === 'Tab') {
      closeMenu();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, items.indexOf(document.activeElement));
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus({ preventScroll: true });
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
  refs.historyClear?.addEventListener('click', async event => {
    const count = relayState().history.length;
    if (!count) return;
    const accepted = await requestRelayAction({
      title: '清空复制历史？',
      message: `${count} 条成品记录会被删除，当前方案不会受影响。`,
      confirmLabel: '确认清空',
      danger: true,
      trigger: event.currentTarget,
    });
    if (!accepted) return;
    const action = await commitRelay(next => clearCopyHistory(next), { changed: 'history' });
    if (action.ok) toast('已清空复制历史', '−');
  });

  refs.newPlan.addEventListener('click', async () => {
    closeMenu();
    const action = await commitRelay(next => createPlan(next), { changed: 'plan' });
    if (action.ok) toast('已新建方案', '+');
  });
  refs.duplicatePlan.addEventListener('click', async () => {
    closeMenu();
    const source = plan();
    if (!source) return;
    const action = await commitRelay(next => {
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
  refs.renamePlan.addEventListener('click', async () => {
    closeMenu();
    const current = plan();
    if (!current) return;
    const name = await requestRelayAction({
      title: '重命名方案',
      confirmLabel: '保存名称',
      input: { label: '方案名称', value: current.name, maxLength: 60 },
      trigger: refs.planMenuBtn,
    });
    if (!name) return;
    const action = await commitRelay(next => renamePlan(next, current.id, name), { changed: 'plan' });
    if (action.ok && action.result) toast('已重命名方案', '✓');
  });
  refs.deletePlan.addEventListener('click', async () => {
    closeMenu();
    const current = plan();
    if (!current || relayState().plans.length <= 1) return;
    const accepted = await requestRelayAction({
      title: `删除「${current.name}」？`,
      message: '其中的编排块会一并删除，复制历史不会受影响。',
      confirmLabel: '删除方案',
      danger: true,
      trigger: refs.planMenuBtn,
    });
    if (!accepted) return;
    const action = await commitRelay(next => deletePlan(next, current.id), { changed: 'plan' });
    if (action.ok && action.result && !orphanedDraft) closeInspector();
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
  refs.inspectorClose.addEventListener('click', () => {
    orphanedDraft = null;
    closeInspector();
  });
  refs.blockRemove.addEventListener('click', () => {
    if (orphanedDraft) {
      orphanedDraft = null;
      closeInspector();
      return;
    }
    if (creatingBlock) closeInspector();
    else if (selectedItemId) removeBlock(selectedItemId);
  });
  refs.blockSave.addEventListener('click', async () => {
    const weight = editorWeight();
    if (weight === null) return;
    if (creatingBlock || orphanedDraft) {
      const draft = orphanedDraft;
      const action = await commitRelay(next => appendBlockToPlan(next, next.activePlanId, {
        title: refs.blockTitle.value || draft?.title || '自定义块',
        weight,
        prompt: refs.blockText.value,
        negative: refs.blockNegative.value,
        characterPrompts: draft?.characterPrompts,
        access: draft?.accessSnapshot?.access,
      }), { changed: 'plan' });
      if (!action.ok) return;
      orphanedDraft = null;
      closeInspector();
      toast(draft ? '未保存内容已保留为自定义块' : '已加入自定义块', '+');
      return;
    }
    if (!selectedItemId) return;
    const current = plan()?.items?.find(item => item.id === selectedItemId);
    if (!current || itemLocked(current)) {
      refreshComposeAccess();
      toast('该词条当前处于访问锁定状态', '!');
      return;
    }
    const action = await commitRelay(next => updatePlanItem(next, next.activePlanId, selectedItemId, {
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

/* role="radiogroup" 的键盘契约：整组只有**一个**能 Tab 到的按钮（当前选中那个），
   方向键在组内移动并顺带选中——这正是 radio 与 tab 的分别（tab 只移动、不激活）。
   ⚠ 只把 role 换成 radiogroup 却不接方向键，读屏会念「单选按钮」但按键没反应，
   比原来的 role="group" + aria-pressed 更糟。要换就得连键盘一起换。 */
function bindSegmentGroup(buttons, apply) {
  const select = button => {
    for (const other of buttons) {
      const on = other === button;
      other.setAttribute('aria-checked', String(on));
      other.tabIndex = on ? 0 : -1;
    }
    apply(button);
    renderOutput();
  };
  buttons.forEach((button, index) => {
    button.tabIndex = button.getAttribute('aria-checked') === 'true' ? 0 : -1;
    button.addEventListener('click', () => select(button));
    button.addEventListener('keydown', event => {
      const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
      let target = null;
      if (step) target = buttons[(index + step + buttons.length) % buttons.length];
      else if (event.key === 'Home') target = buttons[0];
      else if (event.key === 'End') target = buttons[buttons.length - 1];
      if (!target) return;
      event.preventDefault();
      select(target);
      target.focus();
    });
  });
}

function bindSegments() {
  bindSegmentGroup(refs.formatButtons, button => { outputFormat = button.dataset.format; });
  bindSegmentGroup(refs.joinButtons, button => { joinMode = button.dataset.join; });
}

function bindLaneDrop() {
  for (const target of [refs.lane, refs.empty]) {
    target.addEventListener('dragover', event => {
      if (!dragBlockId) return;
      event.preventDefault();
      target.classList.add('is-drop-target');
    });
    target.addEventListener('dragleave', () => target.classList.remove('is-drop-target'));
    target.addEventListener('drop', async event => {
      target.classList.remove('is-drop-target');
      if (!dragBlockId) return;
      event.preventDefault();
      /* 已有块拖到轨道空白处 = 移到末尾。以前这里直接 return，只有拖到另一块上才生效，
         轨道下方那片空白看着像落点却没反应。 */
      const items = plan()?.items || [];
      await commitRelay(next => movePlanItem(next, next.activePlanId, dragBlockId, items.length - 1), { changed: 'plan' });
      dragBlockId = '';
    });
  }
}

/* Esc 由内向外：编辑器开着时先关编辑器，别一路把整个侧栏关掉 */
function bindEscape(root) {
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!refs.planMenu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      refs.planMenu.hidden = true;
      refs.planMenuBtn.setAttribute('aria-expanded', 'false');
      refs.planMenuBtn.focus({ preventScroll: true });
      return;
    }
    if (!refs.inspector.hidden) {
      event.stopPropagation();
      orphanedDraft = null;
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
    /* 轨道自己不是活区了，播报走这个 sr-only 容器（见 announceLane） */
    laneStatus: q('#relayLaneStatus'),
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
