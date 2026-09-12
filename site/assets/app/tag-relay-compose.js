/* 侧栏「编排」分区：方案条 + 块轨道 + 块编辑器 + 贴底的成品与复制。
   编排和输出刻意合成一屏而不是两个页签——核心场景是「反复组合再复制」，
   分开的话每复制一次都要切一次页。

   所有 DOM 查询都限定在分区根节点内（refs 一次解析好），不再是 document 全局：
   [data-format] 这类选择器在整站范围里迟早会撞车。 */

import { toast } from './feedback.js';
import { copyText } from './copy.js';
import { bindOutsideDismiss } from './modal.js';
import { requestRelayAction } from './tag-relay-action.js';
import {
  appendBlockToPlan,
  appendEntryToPlan,
  clearCopyHistory,
  compilePlan,
  createPlan,
  deletePlan,
  getActivePlan,
  getPlan,
  itemHasCharacterNegative,
  mergedTotal,
  movePlanItem,
  recordCopyHistory,
  removePlanItem,
  renamePlan,
  restorePlanItem,
  restoreHistoryAsPlan,
  setActivePlan,
  stableEntryKey,
  updatePlanItem,
  weightAppliesTo,
} from './tag-relay-core.js';
import { snapshotLocked } from './tag-relay-snapshot.js';
import { commitRelay, relayState } from './tag-relay-store.js';
import { renderRelayList } from './tag-relay-motion.js';
import { animateUi, cancelUiMotion } from './ui-motion.js';
import { prefersReducedMotion } from './utils.js';

let refs = null;

/* 拖拽载荷类型：方案块（重排 / 拖到素材区移出）与素材（拖进方案）各一种，
   接收方只看 dataTransfer.types 就能分辨，不必跨模块共享变量。 */
export const RELAY_PLAN_MIME = 'application/x-relay-plan-item';
export const RELAY_PLAN_CONTEXT_MIME = 'application/x-relay-plan-context';
export const RELAY_SOURCE_MIME = 'application/x-relay-source';
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
let dragPreview = null;

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

/* 素材架把词条送进方案时走这里：点主体加入完整词条，点「负」只加入负向。
   同一词条在一个方案里只能占一个槽位；完整 / 仅负向共用加入前冻结的 relayKey，
   否则没有法典 ID 的本地词条会因「仅负向」清空正向正文而算出另一把内容哈希。 */
export async function addSourceToPlan(entry, { negativeOnly = false, beforeId = '', after = false } = {}) {
  if (itemLocked(entry)) {
    toast('该词条当前处于访问锁定状态', '!');
    return;
  }
  const targetPlanId = plan()?.id || '';
  if (!targetPlanId) return;
  const relayKey = stableEntryKey(entry);
  const shownTitle = entry.title || '未命名词条';
  if (plan()?.items?.some(item => item.kind === 'entry' && item.entryKey === relayKey)) {
    toast(`已在当前方案中：${shownTitle}`, '=');
    return;
  }
  const source = negativeOnly
    ? { ...entry, relayKey, prompt: '', negative: promptParts(entry, 'negative').join(',\n'), characterPrompts: [] }
    : { ...entry, relayKey };
  const action = await commitRelay(
    next => {
      if (itemLocked(source)) return null;
      const result = appendEntryToPlan(next, targetPlanId, source);
      const items = getPlan(next, targetPlanId)?.items || [];
      const index = items.findIndex(item => item.id === beforeId);
      if (result?.added && index >= 0) movePlanItem(next, targetPlanId, result.item.id, index + Number(after));
      return result;
    },
    { changed: 'plan' },
  );
  if (!action.ok || !action.result?.item) return;
  /* 预检查只为省掉常规重复点击的落盘；真正的不变式仍在锁内的 core。
     两个标签页同时加入时，后进入锁的那次会走这里，绝不能给它一个会删掉旧块的「撤销」。 */
  if (action.result.added === false) {
    toast(`已在当前方案中：${shownTitle}`, '=');
    return;
  }
  const addedItemId = action.result.item.id;
  toast(negativeOnly ? '已仅加入负向' : '已加入方案', '+', {
    label: '撤销',
    onClick: () => {
      void commitRelay(next => removePlanItem(next, targetPlanId, addedItemId), { changed: 'plan' })
        .then(result => {
          if (result.ok && result.result) toast(`已撤销加入：${shownTitle}`, '↶');
          else toast('无法撤销：原方案已经变化', '!');
        });
    },
  });
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
  syncLaneSelection();
  refs.blockTitle.focus();
  refs.blockTitle.select();
}

/* ---------------- 块 ---------------- */

/* edit:false = 只选中（芯片高亮 + 分区头出工具条），不弹编辑器。
   否则每排一次序都要被浮层糊一次屏——而排序恰恰是最高频的操作。 */
function selectBlock(itemId, { edit = true } = {}) {
  const item = plan()?.items?.find(candidate => candidate.id === itemId);
  if (!item || itemLocked(item)) return;
  creatingBlock = false;
  selectedItemId = itemId;
  editorPlanId = plan()?.id || '';
  editorAccessSnapshot = item;
  refs.inspectorTitle.textContent = '编辑素材块';
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
  refs.inspector.hidden = !edit;
  syncLaneSelection();
  if (edit) refs.blockTitle.focus({ preventScroll: true });
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

export function closeInspector({ restoreFocus = false } = {}) {
  const returnItemId = selectedItemId;
  creatingBlock = false;
  selectedItemId = '';
  editorPlanId = '';
  editorAccessSnapshot = null;
  if (refs?.inspector) refs.inspector.hidden = true;
  syncLaneSelection();
  if (restoreFocus) {
    const returnCard = [...(refs?.lane.querySelectorAll('.tag-relay-plan-card') || [])]
      .find(card => card.dataset.itemId === returnItemId);
    (returnCard?.querySelector('.tag-relay-plan-card-main') || refs?.addBlock || refs?.planPickerBtn)?.focus({ preventScroll: true });
  }
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
  const targetPlanId = plan()?.id;
  if (!targetPlanId) return;
  const action = await commitRelay(next => {
    const index = getPlan(next, targetPlanId)?.items?.findIndex(item => item.id === itemId) ?? -1;
    return index < 0 ? null : movePlanItem(next, targetPlanId, itemId, index + delta);
  }, { changed: 'plan' });
  if (!action.ok || !action.result || plan()?.id !== targetPlanId) return;
  const items = plan()?.items || [];
  const moved = items.findIndex(item => item.id === itemId);
  if (moved < 0) return;
  /* ↑↓ 在触屏上是唯一的排序手段，却没有任何非视觉反馈；toast 留给增删，这里只播位置 */
  announceLane(`已${delta < 0 ? '上移' : '下移'}到第 ${moved + 1} 位 · 共 ${items.length} 块`);
}

export async function removeBlock(itemId, { planId: requestedPlanId = '' } = {}) {
  const targetPlanId = requestedPlanId || plan()?.id || '';
  if (!itemId || !targetPlanId) return null;
  const action = await commitRelay(next => {
    const target = getPlan(next, targetPlanId);
    const index = target?.items?.findIndex(item => item.id === itemId) ?? -1;
    if (index < 0) return null;
    const current = target.items[index];
    const maxEntryCopies = current.kind === 'entry'
      ? target.items.filter(item => item.kind === 'entry' && item.entryKey === current.entryKey).length
      : 1;
    const record = {
      planId: targetPlanId,
      index,
      beforeId: target.items[index - 1]?.id || '',
      afterId: target.items[index + 1]?.id || '',
      maxEntryCopies,
      item: null,
    };
    record.item = removePlanItem(next, targetPlanId, itemId);
    return record.item ? record : null;
  }, { changed: 'plan' });
  if (!action.ok || !action.result?.item) return null;
  const removed = action.result;
  if (selectedItemId === itemId && (!editorPlanId || editorPlanId === targetPlanId)) closeInspector();
  toast('已移出方案', '−', {
    label: '撤销',
    onClick: () => {
      void commitRelay(next => {
        const target = getPlan(next, removed.planId);
        if (!target) return null;
        const afterIndex = removed.afterId
          ? target.items.findIndex(item => item.id === removed.afterId)
          : -1;
        const beforeIndex = removed.beforeId
          ? target.items.findIndex(item => item.id === removed.beforeId)
          : -1;
        const targetIndex = afterIndex >= 0
          ? afterIndex
          : beforeIndex >= 0
            ? beforeIndex + 1
            : Math.min(removed.index, target.items.length);
        return restorePlanItem(next, removed.planId, removed.item, targetIndex, {
          maxEntryCopies: removed.maxEntryCopies,
        });
      }, { changed: 'plan' }).then(result => {
        if (result.ok && result.result) toast('已撤销移出', '↶');
        else toast('无法撤销：原方案已经变化', '!');
      });
    },
  });
  return removed;
}

async function toggleBlock(itemId) {
  const item = plan()?.items?.find(candidate => candidate.id === itemId);
  if (!item) return;
  const enabled = item.enabled === false;
  const targetPlanId = plan()?.id;
  const action = await commitRelay(next => updatePlanItem(next, targetPlanId, itemId, { enabled }), { changed: 'plan' });
  if (!action.ok || !action.result) return;
  /* 停用 / 启用没有 toast，视觉上只是块变淡，读屏用户什么都听不到 */
  announceLane(`${enabled ? '已启用' : '已停用'}：${itemLocked(item) ? '已锁定的成人内容' : item.title}`);
}

/* ---------------- 拖动中的实时排序预览 ----------------
   拖着一块不松手时，其余块实时让位；只有 drop 才提交 store，dragend 取消时原样恢复。

   ⚠ 这里有两个反直觉的坑，踩中任何一个都会让卡片「疯狂抽动」：

   ① **落点不能对着卡片量，要对着格子算。**
      卡片此刻正在 FLIP 滑动，`getBoundingClientRect()` 拿到的是动画中的位置；
      拿它做中线判定，等于判定边界自己在指针底下移动——指针微动就来回翻页。
      图墙是 auto-fill 的等宽等高网格，槽位是**不动**的：在 dragstart 时快照一次
      网格几何，之后纯用指针坐标做算术，边界就永远稳定。

   ② **FLIP 的 first 必须是当前视觉位置。**
      正确顺序是「先量 → 再取消动画 → 改 order → 同步量 last」。
      反过来先 `cancelUiMotion` 再量，量到的是卡片弹回布局位之后的坐标，
      于是每次 dragover 都先瞬移回去再滑一次。

   另外 dragover 按指针频率触发，落点在两格边界上会来回横跳，所以加一条
   格宽 14% 的滞回带：已经判成「后插」时，要越过中线往回 14% 才改判。 */
const DRAG_HYSTERESIS = .14;
let dragGrid = null;

/* 在 dragstart 时量一次：此刻没有任何动画在跑，rect 就是真实布局位。 */
function snapshotDragGrid() {
  const lane = refs?.lane;
  if (!lane) return null;
  const cards = [...lane.querySelectorAll('.tag-relay-plan-card')];
  if (!cards.length) return null;
  const first = cards[0].getBoundingClientRect();
  if (!first.width || !first.height) return null;
  const style = getComputedStyle(lane);
  const gapX = parseFloat(style.columnGap) || 0;
  const gapY = parseFloat(style.rowGap) || 0;
  /* 列数要按轨道宽度反推，不能数第一行有几个：只有 3 块时第一行就是 3 个，
     但网格其实是 4 列，照着数会把第 4 格算成下一行。 */
  const laneWidth = lane.clientWidth || first.width;
  const cols = Math.max(1, Math.round((laneWidth + gapX) / (first.width + gapX)));
  return {
    originX: first.left, originY: first.top,
    cellW: first.width, cellH: first.height,
    gapX, gapY, cols, total: cards.length,
  };
}

/* 指针坐标 → 插入下标。纯算术，不碰任何会动的 DOM。 */
function slotIndexAt(x, y, currentIndex) {
  const grid = dragGrid;
  if (!grid) return 0;
  const strideX = grid.cellW + grid.gapX;
  const strideY = grid.cellH + grid.gapY;
  const col = Math.min(grid.cols - 1, Math.max(0, Math.floor((x - grid.originX) / strideX)));
  const row = Math.max(0, Math.floor((y - grid.originY) / strideY));
  const cellLeft = grid.originX + col * strideX;
  /* 格内位置 0~1；0.5 是中线，带一条滞回带免得边界上反复横跳 */
  let ratio = (x - cellLeft) / grid.cellW;
  if (!Number.isFinite(ratio)) ratio = 0;
  const wasAfter = currentIndex != null && currentIndex > row * grid.cols + col;
  const threshold = wasAfter ? .5 - DRAG_HYSTERESIS : .5 + DRAG_HYSTERESIS;
  const index = row * grid.cols + col + (ratio > threshold ? 1 : 0);
  return Math.max(0, Math.min(grid.total, index));
}

/* FLIP：量 → 取消 → 改布局 → 再量 → 播。全程同步，不隔帧。 */
function applyPreviewOrder(ordered) {
  const lane = refs?.lane;
  if (!lane) return;
  const cards = [...lane.querySelectorAll('.tag-relay-plan-card')];
  const first = new Map(cards.map(card => [card, card.getBoundingClientRect()]));
  for (const card of cards) cancelUiMotion(card);
  ordered.forEach((card, order) => { card.style.order = String(order); });
  /* ⚠ 页面不可见时时间轴是冻住的：这时起动画，卡片会停在**位移的首帧**上不动，
     等于把它们钉在错位的地方。和 tag-relay-motion.js 的 motionAllowed 同一条规矩。 */
  if (prefersReducedMotion() || document.visibilityState === 'hidden') return;
  for (const card of cards) {
    const from = first.get(card);
    const to = card.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) < .5 && Math.abs(dy) < .5) continue;
    animateUi(card, [
      { translate: `${dx}px ${dy}px` },
      { translate: '0 0' },
    ], { duration: 170 });
  }
}

function beginDragPreview(card) {
  if (!refs?.lane || !card || dragPreview?.card === card) return;
  dragGrid = snapshotDragGrid();
  card.classList.add('is-drag-source');
  dragPreview = { card, index: null };
}

/* 只按指针坐标决定插到第几格；哪张卡片触发的事件完全不重要。 */
function moveDragPreview(clientX, clientY) {
  const preview = dragPreview;
  const lane = refs?.lane;
  if (!preview || !lane || !dragGrid) return;
  const cards = [...lane.querySelectorAll('.tag-relay-plan-card')];
  const others = cards.filter(card => card !== preview.card);
  const index = Math.min(others.length, slotIndexAt(clientX, clientY, preview.index));
  if (index === preview.index) return;
  preview.index = index;
  const ordered = [...others];
  ordered.splice(index, 0, preview.card);
  applyPreviewOrder(ordered);
}

/* 预览期间的排序只活在 style.order 里，store 一个字节都没动；
   这里返回它，好让 drop 用同一个下标提交，避免"看到的"和"提交的"不一致。 */
function previewIndex() {
  return dragPreview?.index ?? null;
}

function finishDragPreview() {
  const preview = dragPreview;
  dragGrid = null;
  if (!preview) return;
  for (const card of refs?.lane?.querySelectorAll('.tag-relay-plan-card') || []) {
    card.style.order = '';
    cancelUiMotion(card);
  }
  preview.card.classList.remove('is-drag-source');
  dragPreview = null;
}

/* 编排芯片：与素材芯片同一套外形，靠 is-plan 区分。
   ⚠ 不再显示 prompt 预览——它本来就被省略号截断、读不全，反而把块撑成满宽一行；
   全文在编辑器里看。↑↓ / 停用 / 移除 移到分区头那条就地工具条上（选中才出现）。 */
/* 方案块＝带图大卡，一行两个。
   NAI 上限 512 token，一个画风 + 一个场景 + 一个角色 + 一套服饰也就五六块——块数天然很少，
   做成小芯片反而难点、难拖、也认不出是哪条词条；带上缩略图才对得上用户脑子里的那张图。
   ⚠ 可选主体不能是原生 <button>：Chrome 里按钮会吞掉拖拽手势。draggable 精确放在
      div[role=button] 主体上，外壳只接冒泡的 DnD 事件；同级删除键因此不可能误启动拖拽。 */
function planBlock(item, index, total) {
  const locked = itemLocked(item);
  const shownTitle = locked ? '已锁定的成人内容' : item.title;
  const cardPlanId = plan()?.id || '';
  const card = document.createElement('div');
  card.className = 'tag-relay-plan-card';
  card.classList.toggle('is-selected', selectedItemId === item.id);
  card.classList.toggle('is-off', item.enabled === false);
  card.classList.toggle('is-locked', locked);
  card.classList.toggle('is-imaged', !locked && Boolean(item.image));
  card.dataset.itemId = item.id;
  card.dataset.relayMotionKey = item.id;
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', (index + 1) + '. ' + shownTitle);
  card.title = locked ? '当前权限关闭，不参与输出' : shownTitle + '　·　' + blockPreview(item);

  /* main 铺满整块并自己承载缩略图：图就是这一块的身份，标题只是补充。
     ⚠ 仍然不能是原生 <button>：Chrome 会吞掉它上面的 dragstart。 */
  const main = document.createElement('div');
  main.className = 'tag-relay-plan-card-main';
  main.setAttribute('role', 'button');
  main.draggable = !locked;
  main.tabIndex = locked ? -1 : 0;
  main.setAttribute('aria-label', (index + 1) + '. ' + shownTitle);
  main.setAttribute('aria-pressed', String(selectedItemId === item.id));
  if (locked) main.setAttribute('aria-disabled', 'true');
  if (!locked && item.image) main.style.backgroundImage = 'url("' + item.image + '")';
  if (locked) {
    const lock = document.createElement('span');
    lock.className = 'tag-relay-plan-card-lock';
    lock.textContent = '锁';
    main.append(lock);
  }

  /* 标题条压在图底，悬停时整条淡出——要看图的时候它自己让开。 */
  const body = document.createElement('div');
  body.className = 'tag-relay-plan-card-body';
  const title = document.createElement('span');
  title.className = 'tag-relay-plan-card-title';
  title.textContent = shownTitle;
  const meta = document.createElement('div');
  meta.className = 'tag-relay-plan-card-meta';

  const channel = itemChannel(item);
  if (!locked && channel.key !== 'positive') {
    const flag = document.createElement('span');
    flag.className = 'tag-relay-channel-badge ' + (channel.key === 'both' ? 'is-both' : 'is-negative');
    flag.textContent = channel.key === 'both' ? '正负' : '负';
    flag.title = channel.key === 'both' ? '这块同时进入正向与负向通道' : '这块只进入负向通道';
    meta.append(flag);
  }
  if (!locked && itemHasCharacterNegative(item)) {
    const warn = document.createElement('span');
    warn.className = 'tag-relay-chip-flag';
    warn.textContent = '⚠';
    warn.title = '角色级负面在 NovelAI 里按角色分槽填，不会并入负向输出';
    meta.append(warn);
  }
  if (!locked && Number(item.weight) !== 1) {
    const weight = document.createElement('span');
    weight.className = 'tag-relay-chip-wt';
    weight.textContent = '×' + item.weight;
    meta.append(weight);
  }
  body.append(title, meta);
  main.append(body);

  /* 序号是图墙里唯一的顺序线索（横条时代那一列数字没地方放了），必须常驻。 */
  const seq = document.createElement('span');
  seq.className = 'tag-relay-plan-card-seq';
  seq.textContent = String(index + 1);

  /* 桌面的快捷删除。触屏没有 hover，那边的主路径是「点块 → 操作条上的 ×」。 */
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'tag-relay-plan-card-remove';
  remove.textContent = '×';
  remove.draggable = false;
  remove.title = '从方案移出';
  remove.setAttribute('aria-label', '从方案移出：' + shownTitle);
  remove.addEventListener('pointerdown', event => event.stopPropagation());
  remove.addEventListener('dragstart', event => {
    event.preventDefault();
    event.stopPropagation();
  });
  remove.addEventListener('click', async event => {
    event.preventDefault();
    event.stopPropagation();
    const currentIndex = plan()?.items?.findIndex(candidate => candidate.id === item.id) ?? index;
    const removed = await removeBlock(item.id, { planId: cardPlanId });
    if (!removed || plan()?.id !== cardPlanId) return;
    requestAnimationFrame(() => {
      const controls = [...(refs?.lane?.querySelectorAll('.tag-relay-plan-card-main') || [])];
      const next = controls[Math.min(Math.max(0, currentIndex), controls.length - 1)] || refs?.addBlock;
      next?.focus?.({ preventScroll: true });
    });
  });
  card.append(main, seq, remove);

  if (!locked) {
    card.onclick = event => {
      if (event.target === card) selectBlock(item.id, { edit: false });
    };
    main.onclick = () => selectBlock(item.id, { edit: false });
    main.ondblclick = () => selectBlock(item.id, { edit: true });
    main.onkeydown = event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      selectBlock(item.id, { edit: event.key === 'Enter' });
    };
  }

  const handleDragStart = event => {
    if (locked || !event.dataTransfer) { event.preventDefault(); return; }
    beginDragPreview(card);
    dragBlockId = item.id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(RELAY_PLAN_MIME, item.id);
    event.dataTransfer.setData(RELAY_PLAN_CONTEXT_MIME, JSON.stringify({
      itemId: item.id,
      planId: cardPlanId,
    }));
    event.dataTransfer.setData('text/plain', item.title);
    if (typeof event.dataTransfer.setDragImage === 'function') {
      const ghost = card.cloneNode(true);
      ghost.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
      ghost.classList.add('tag-relay-plan-drag-image');
      const rect = card.getBoundingClientRect();
      ghost.style.width = rect.width + 'px';
      ghost.style.height = rect.height + 'px';
      document.body.append(ghost);
      event.dataTransfer.setDragImage(ghost, Math.max(12, event.offsetX || 24), Math.max(12, event.offsetY || 24));
      setTimeout(() => ghost.remove(), 0);
    }
    requestAnimationFrame(() => {
      if (dragBlockId === item.id && card.isConnected) card.classList.add('is-dragging');
    });
  };
  const handleDragEnd = () => {
    dragBlockId = '';
    finishDragPreview();
    card.classList.remove('is-dragging');
    clearDropMarkers();
  };
  /* 直接监听真正的 draggable 主体；保留外壳兜底，兼容旧的测试 DOM 与部分嵌入式浏览器。 */
  main.addEventListener('dragstart', handleDragStart);
  main.addEventListener('dragend', handleDragEnd);
  card.addEventListener('dragstart', event => { if (event.target === card) handleDragStart(event); });
  card.addEventListener('dragend', event => { if (event.target === card) handleDragEnd(event); });
  card.addEventListener('dragover', event => {
    const types = event.dataTransfer?.types || [];
    if (!dragBlockId && !types.includes(RELAY_PLAN_MIME) && !types.includes(RELAY_SOURCE_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = types.includes(RELAY_SOURCE_MIME) ? 'copy' : 'move';
    if (types.includes(RELAY_PLAN_MIME) || dragBlockId) {
      /* 方案块自己拖：落点交给网格槽位算（见 moveDragPreview 上方那段注释），
         也不画插入线——让开的那个空位本身就是落点指示，再叠一条线只会打架。 */
      clearDropMarkers();
      moveDragPreview(event.clientX, event.clientY);
      return;
    }
    /* 素材芯片拖进来：没有预览空位，仍用插入线。
       ⚠ 图墙是会换行的网格，落点在**左右**不在上下：横条时代按 Y 轴判断，
       照搬过来会让「拖到某块的右半区」插到它前面，手势和视觉正好相反。 */
    const rect = card.getBoundingClientRect();
    const before = event.clientX < rect.left + rect.width / 2;
    clearDropMarkers(card);
    card.classList.toggle('is-drop-before', before);
    card.classList.toggle('is-drop-after', !before);
  });
  card.addEventListener('dragleave', event => {
    if (!card.contains(event.relatedTarget)) card.classList.remove('is-drop-before', 'is-drop-after');
  });
  card.addEventListener('drop', async event => {
    /* commitRelay 会先异步等待 Web Lock；所有事务参数必须在第一次 await 之前捕获。 */
    const payload = event.dataTransfer?.getData(RELAY_SOURCE_MIME);
    if (payload) {
      event.preventDefault();
      event.stopPropagation();
      const rect = card.getBoundingClientRect();
      const after = event.clientX >= rect.left + rect.width / 2;
      clearDropMarkers();
      finishDragPreview();
      try { await addSourceToPlan(JSON.parse(payload), { beforeId: item.id, after }); }
      catch (error) { console.warn('[tag-relay] 拖入的素材解析失败', error); }
      return;
    }
    const draggedId = event.dataTransfer?.getData(RELAY_PLAN_MIME) || dragBlockId;
    const targetPlanId = plan()?.id || '';
    if (!draggedId || !targetPlanId) return;
    event.preventDefault();
    event.stopPropagation();
    if (draggedId === item.id) {
      clearDropMarkers();
      return;
    }
    const currentItems = plan()?.items || [];
    const fromIndex = currentItems.findIndex(candidate => candidate.id === draggedId);
    if (fromIndex < 0) { clearDropMarkers(); return; }
    /* ⚠ 提交的下标必须就是预览时那个，不能在 drop 里拿卡片矩形重算一遍：
       此刻卡片正停在 FLIP 的终态上，重算出来的和用户眼睛看到的空位可能差一格。
       previewIndex() 是「抽掉被拖那块之后的插入位」，与 movePlanItem 的语义一致。 */
    const previewed = previewIndex();
    let targetIndex = previewed;
    if (targetIndex == null) {
      const rect = card.getBoundingClientRect();
      const after = event.clientX >= rect.left + rect.width / 2;
      const targetItemIndex = currentItems.findIndex(candidate => candidate.id === item.id);
      if (targetItemIndex < 0) { clearDropMarkers(); return; }
      targetIndex = targetItemIndex + (after ? 1 : 0);
      if (fromIndex < targetIndex) targetIndex -= 1;
    }
    targetIndex = Math.max(0, Math.min(currentItems.length - 1, targetIndex));
    dragBlockId = '';
    clearDropMarkers();
    const action = await commitRelay(
      next => movePlanItem(next, targetPlanId, draggedId, targetIndex),
      { changed: 'plan' },
    );
    finishDragPreview();
    if (action.ok && action.result) announceLane('已移动到第 ' + (targetIndex + 1) + ' 位 · 共 ' + currentItems.length + ' 块');
  });
  return card;
}

function clearDropMarkers(except = null) {
  for (const node of refs?.lane?.querySelectorAll('.is-drop-before,.is-drop-after') || []) {
    if (node !== except) node.classList.remove('is-drop-before', 'is-drop-after');
  }
  refs?.lane?.classList.remove('is-drop-target');
  refs?.empty?.classList.remove('is-drop-target');
}

/* ---------------- 选中块的操作条 ----------------
   图墙里每块只有 88×64，塞不下常驻按钮；而**也没必要**每块都常驻一排——
   只有正在管的那一块需要。选中后它出现在图墙下方，占一行 36px。
   这正是 12 块从 366px 压到 246px 的那部分。 */
function renderBlockBar() {
  const bar = refs?.blockBar;
  if (!bar) return;
  const items = plan()?.items || [];
  const index = items.findIndex(candidate => candidate.id === selectedItemId);
  const item = index >= 0 ? items[index] : null;
  bar.hidden = !item;
  if (!item) {
    for (const node of [refs.blockBarTitle, refs.blockBarMeta, refs.blockBarThumb]) {
      if (node) node.textContent = '';
    }
    if (refs.blockBarThumb) refs.blockBarThumb.style.backgroundImage = '';
    return;
  }
  const locked = itemLocked(item);
  const shownTitle = locked ? '已锁定的成人内容' : item.title;

  if (refs.blockBarThumb) {
    refs.blockBarThumb.style.backgroundImage = !locked && item.image ? 'url("' + item.image + '")' : '';
    refs.blockBarThumb.textContent = !locked && item.image ? '' : (locked ? '锁' : (shownTitle.trim()[0] || '块'));
  }
  if (refs.blockBarTitle) refs.blockBarTitle.textContent = shownTitle;
  if (refs.blockBarMeta && !locked) {
    /* 图块上只看得见标题，所以"这块到底装了什么"要在这里补上 */
    const tags = promptParts(item, 'positive').join(', ').split(',').map(part => part.trim()).filter(Boolean);
    const parts = [];
    if (tags.length) parts.push(tags.length + ' 个 tag');
    if (promptParts(item, 'negative').length) parts.push('含负向');
    if (Number(item.weight) !== 1) parts.push('×' + item.weight);
    if (item.enabled === false) parts.push('已停用');
    refs.blockBarMeta.textContent = parts.join(' · ');
  } else if (refs.blockBarMeta) refs.blockBarMeta.textContent = '';
  const at = key => bar.querySelector('[data-block-tool="' + key + '"]');
  const up = at('up'); if (up) up.disabled = index <= 0;
  const down = at('down'); if (down) down.disabled = index >= items.length - 1;
  const toggle = at('toggle');
  if (toggle) {
    toggle.disabled = locked;
    toggle.textContent = item.enabled === false ? '○' : '●';
    toggle.setAttribute('aria-label', item.enabled === false ? '启用这一块' : '停用这一块');
    toggle.title = item.enabled === false ? '启用这一块' : '停用这一块';
    toggle.setAttribute('aria-pressed', String(item.enabled !== false));
  }
  const edit = at('edit'); if (edit) edit.disabled = locked;
}

/* 排序 / 停用会整条重建图墙，刚才那颗按钮已经不在 DOM 里；按 itemId 把焦点找回来。 */
function focusPlanTile(itemId) {
  if (!itemId) return;
  requestAnimationFrame(() => {
    const card = [...(refs?.lane?.querySelectorAll('.tag-relay-plan-card') || [])]
      .find(node => node.dataset.itemId === itemId);
    (card?.querySelector('.tag-relay-plan-card-main') || refs?.addBlock)?.focus?.({ preventScroll: true });
  });
}

function syncLaneSelection() {
  for (const node of refs?.lane?.querySelectorAll('.tag-relay-plan-card') || []) {
    const selected = node.dataset.itemId === selectedItemId;
    node.classList.toggle('is-selected', selected);
    node.querySelector('.tag-relay-plan-card-main')?.setAttribute('aria-pressed', String(selected));
  }
  renderBlockBar();
}

function renderLane({ motion = true } = {}) {
  const items = plan()?.items || [];
  if (selectedItemId && !items.some(item => item.id === selectedItemId)) selectedItemId = '';
  const focused = document.activeElement;
  const focusedId = refs.lane.contains(focused) ? focused.closest?.('[data-item-id]')?.dataset.itemId : '';
  renderRelayList(refs.lane, items.map((item, index) => planBlock(item, index, items.length)), { group: plan()?.id, motion });
  if (focusedId) focusPlanTile(focusedId);
  renderBlockBar();
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
  note.textContent = `${base ? ' · ' : ''}已合并 ${total} 条重复`;
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
  /* refs 要等 setupRelayCompose 才填，订阅可能先到 */
  if (!refs.planStats) return;
  const lockedCount = current?.items?.filter(itemLocked).length || 0;
  /* 「块」在货架上叫「素材」、在瀑布流里叫「词条」，同一个东西不该有三个名字 */
  refs.planStats.textContent = `${total} 个素材块${lockedCount ? ` · ${lockedCount} 个锁定` : ''}`;
}

const FORMAT_LABELS = { nai: 'NAI', sd: 'SD', plain: '纯文本' };
const JOIN_LABELS = { comma: '逗号', newline: '逗号换行' };
const formatLabel = () => FORMAT_LABELS[outputFormat] || 'NAI';
const joinLabel = () => JOIN_LABELS[joinMode] || '逗号';

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
  /* 成品默认收起：两个只读框原先常驻 129px，而用户从不读它们、只按复制。
     这次连「格式 / 连接」一起收进去——它们是设一次就不动的设置，不该和最高频的
     复制键抢同一级视觉重量。收起时那颗按钮自己就是当前格式的标签。 */
  syncSegmentSlider(refs.formatButtons);
  syncSegmentSlider(refs.joinButtons);
  if (refs.outputSummary) refs.outputSummary.textContent = `${formatLabel()} · ${joinLabel()}`;
  /* 主键上的提示回答的是「按下去会得到什么」，所以说 tag 数而不是"段" */
  if (refs.copyAllHint) {
    const hint = [];
    if (compiled.positiveCount) hint.push(`${compiled.positiveCount} 个 tag`);
    if (compiled.negativeCount) hint.push('＋负向');
    refs.copyAllHint.textContent = hint.length ? hint.join(' ') : '还没有内容';
  }
  /* 合并明细原先只写在收起的摘要里；摘要现在让位给格式标签，它单独占一行常驻但克制的说明。 */
  if (refs.outputNote) {
    const merged = [...compiled.positiveMerged, ...compiled.negativeMerged];
    refs.outputNote.hidden = mergedTotal(merged) === 0;
    refs.outputNote.textContent = '';
    if (!refs.outputNote.hidden) applyMergedNote(refs.outputNote, '', merged);
  }
  renderComposeCounters();
}

function renderPlanControls() {
  const state = relayState();
  const current = state.plans.find(item => item.id === state.activePlanId) || state.plans[0];
  refs.planSelect.replaceChildren(...state.plans.map(item => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${item.name} · ${item.items.length}`;
    option.selected = item.id === state.activePlanId;
    return option;
  }));
  /* 块数已经写在「当前方案 · N 个素材块」那行了；这里再挂一个「· N」会和栏头旁边
     的素材条数凑成两个不解释的数字。可访问名仍带上，读屏用户听得到。 */
  refs.planPickerLabel.textContent = current ? current.name : '选择方案';
  refs.planPickerBtn.setAttribute(
    'aria-label',
    current ? `当前方案：${current.name}，${current.items.length} 个素材块` : '选择方案',
  );
  refs.planList.replaceChildren(...state.plans.map((item, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.id = `relayPlanOption${index}`;
    option.className = 'tag-relay-plan-option';
    option.dataset.planId = item.id;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(item.id === state.activePlanId));
    option.tabIndex = -1;

    const name = document.createElement('span');
    name.textContent = item.name;
    const count = document.createElement('small');
    count.textContent = `${item.items.length} 个素材块`;
    const check = document.createElement('span');
    check.className = 'tag-relay-plan-option-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = item.id === state.activePlanId ? '✓' : '';
    option.append(name, count, check);
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
    toast('这条成品记录是旧版本留下的，缺少方案快照，不能再复制', '!');
    return;
  }
  if (reason) {
    toast('这条成品记录包含当前锁定内容，暂不可使用', '!');
    return;
  }
  const text = historyOutput(record, channel);
  if (!text) {
    toast('这条历史没有可复制内容', '!');
    return;
  }
  const label = channel === 'both' ? '完整方案' : (channel === 'positive' ? '正向' : '负向');
  await copyText(text, `已复制记录中的${label}`, trigger, {
    convert: false,
    sampleLabel: `已复制记录中的${label}`,
    accessGuard: () => !historyRecordLocked(record),
    onAccessBlocked: () => toast('这条成品记录已因权限变化锁定', '!'),
  });
}

async function restoreHistoryRecord(record) {
  const reason = historyLockReason(record);
  if (reason === 'stale') {
    toast('这条成品记录是旧版本留下的，缺少方案快照，不能恢复', '!');
    return;
  }
  if (reason) {
    toast('这条成品记录包含当前锁定内容，暂不可恢复', '!');
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

function positionHistory() {
  if (!historyOpen || !refs?.historyPanel?.offsetParent) return;
  const panel = refs.historyPanel;
  const output = panel.offsetParent;
  panel.style.maxHeight = `${Math.min(340, refs.rail.clientHeight - 24)}px`;
  panel.style.bottom = 'auto';
  panel.style.top = `${Math.max(12 - output.offsetTop, 8 - panel.offsetHeight)}px`;
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
    empty.textContent = '复制完整方案后，记录会保存在这里。';
    refs.historyList.append(empty);
    positionHistory();
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
      : (locked ? '已锁定的成品记录' : (record.label || record.planName || '成品记录'));
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
  positionHistory();
}

export function renderCompose({ motion = true } = {}) {
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
  renderLane({ motion });
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
  const picker = refs.planPickerBtn;
  const list = refs.planList;
  const menu = refs.planMenu;
  const planOptions = () => [...list.querySelectorAll('[role="option"]')];
  const menuItems = () => [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
  const closePicker = ({ restoreFocus = false } = {}) => {
    list.hidden = true;
    picker.setAttribute('aria-expanded', 'false');
    if (restoreFocus) picker.focus({ preventScroll: true });
  };
  const closeMenu = ({ restoreFocus = false } = {}) => {
    menu.hidden = true;
    refs.planMenuBtn.setAttribute('aria-expanded', 'false');
    if (restoreFocus) refs.planMenuBtn.focus({ preventScroll: true });
  };
  const openPicker = (focus = 'selected') => {
    closeMenu();
    list.hidden = false;
    picker.setAttribute('aria-expanded', 'true');
    const options = planOptions();
    const selected = options.find(option => option.getAttribute('aria-selected') === 'true');
    const target = focus === 'first'
      ? options[0]
      : focus === 'last'
        ? options.at(-1)
        : selected || options[0];
    target?.focus({ preventScroll: true });
  };
  const openMenu = (focus = 'first') => {
    closePicker();
    menu.hidden = false;
    refs.planMenuBtn.setAttribute('aria-expanded', 'true');
    const items = menuItems();
    (focus === 'last' ? items.at(-1) : items[0])?.focus({ preventScroll: true });
  };
  const selectPlan = async (planId, { restoreFocus = true } = {}) => {
    if (!planId) return;
    closePicker({ restoreFocus });
    refs.planSelect.value = planId;
    await commitRelay(next => setActivePlan(next, planId), { changed: 'plan' });
  };

  /* 隐藏原生 select 只是旧调用方的值桥；可见交互统一走带动画的 listbox。 */
  refs.planSelect.addEventListener('change', () => selectPlan(refs.planSelect.value, { restoreFocus: false }));
  picker.addEventListener('click', event => {
    event.stopPropagation();
    if (list.hidden) openPicker();
    else closePicker({ restoreFocus: true });
  });
  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !list.hidden) {
      event.preventDefault();
      event.stopPropagation();
      closePicker({ restoreFocus: true });
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    openPicker(event.key === 'ArrowUp' || event.key === 'End' ? 'last' : (event.key === 'Home' ? 'first' : 'selected'));
  });
  list.addEventListener('click', event => {
    const option = event.target?.closest?.('[data-plan-id]');
    if (!option || !list.contains(option)) return;
    void selectPlan(option.dataset.planId);
  });
  list.addEventListener('keydown', event => {
    const options = planOptions();
    if (!options.length) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePicker({ restoreFocus: true });
      return;
    }
    if (event.key === 'Tab') {
      /* 先让浏览器完成原生 Tab 移焦，再收起浮层；同步隐藏当前焦点会让部分浏览器
         从 body 重新开始遍历，键盘用户一下跳回页面最前面。 */
      setTimeout(() => closePicker(), 0);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const option = event.target?.closest?.('[data-plan-id]');
      if (!option) return;
      event.preventDefault();
      void selectPlan(option.dataset.planId);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, options.indexOf(document.activeElement));
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next].focus({ preventScroll: true });
  });

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
  bindOutsideDismiss([list, picker], () => {
    if (!list.hidden) closePicker();
  });
  bindOutsideDismiss([menu, refs.planMenuBtn], () => {
    if (!menu.hidden) closeMenu();
  });

  refs.historyToggle?.addEventListener('click', () => {
    closePicker();
    closeMenu();
    historyOpen = !historyOpen;
    renderHistory();
  });
  refs.historyClose?.addEventListener('click', () => {
    historyOpen = false;
    renderHistory();
    refs.historyToggle.focus({ preventScroll: true });
  });
  refs.historyClear?.addEventListener('click', async event => {
    const count = relayState().history.length;
    if (!count) return;
    const accepted = await requestRelayAction({
      title: '清空成品记录？',
      message: `${count} 条成品记录会被删除，当前方案不会受影响。`,
      confirmLabel: '确认清空',
      danger: true,
      trigger: event.currentTarget,
    });
    if (!accepted) return;
    const action = await commitRelay(next => clearCopyHistory(next), { changed: 'history' });
    if (action.ok) toast('已清空成品记录', '−');
  });

  refs.newPlan.addEventListener('click', async () => {
    closeMenu();
    /* 不编号的话连点两次就有两个都叫「新方案」的方案，选择器里只能靠块数分辨 */
    const action = await commitRelay(next => createPlan(next, nextPlanName(next)), { changed: 'plan' });
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
      message: '其中的素材块会一并删除，成品记录不会受影响。',
      confirmLabel: '删除方案',
      danger: true,
      trigger: refs.planMenuBtn,
    });
    if (!accepted) return;
    const action = await commitRelay(next => deletePlan(next, current.id), { changed: 'plan' });
    if (action.ok && action.result && !orphanedDraft) closeInspector();
  });
}

/* 「新方案」「新方案 2」「新方案 3」…… 只在重名时才加序号，第一个仍叫「新方案」。 */
function nextPlanName(state, base = '新方案') {
  const taken = new Set((state?.plans || []).map(item => String(item.name || '').trim()));
  if (!taken.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
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
    closeInspector({ restoreFocus: true });
  });
  refs.blockRemove.addEventListener('click', () => {
    if (orphanedDraft) {
      orphanedDraft = null;
      closeInspector({ restoreFocus: true });
      return;
    }
    if (creatingBlock) closeInspector({ restoreFocus: true });
    else if (selectedItemId) removeBlock(selectedItemId, { planId: editorPlanId });
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
/* 滑块只吃两个整数：第几格、共几格，位置由 CSS calc 算。
   ⚠ 不要退回"用 JS 量 offsetWidth 写 px"——开栏是一段 .26s 的宽度过渡，
     那时量到的是 0，滑块会被钉死在 0 宽再也不动（这个坑踩过一次）。 */
function syncSegmentSlider(buttons) {
  const index = buttons.findIndex(button => button.getAttribute('aria-checked') === 'true');
  const group = buttons[0]?.closest('.tag-relay-segment');
  if (!group || index < 0) return;
  group.style.setProperty('--seg-n', String(buttons.length));
  group.style.setProperty('--seg-i', String(index));
}

function bindSegmentGroup(buttons, apply) {
  const select = button => {
    for (const other of buttons) {
      const on = other === button;
      other.setAttribute('aria-checked', String(on));
      other.tabIndex = on ? 0 : -1;
    }
    apply(button);
    syncSegmentSlider(buttons);
    renderOutput();
    if (!refs.outputBoxes.hidden) {
      for (const field of [refs.positiveOut, refs.negativeOut]) {
        animateUi(field, [{ opacity: .45, translate: '0 3px' }, { opacity: 1, translate: '0 0' }], { duration: 160 });
      }
    }
  };
  buttons.forEach((button, index) => {
    button.tabIndex = button.getAttribute('aria-checked') === 'true' ? 0 : -1;
    if (index === 0) syncSegmentSlider(buttons);
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

/* 操作条作用于当前选中的那一块。
   ⚠ 用事件代理而不是逐按钮绑：操作条只有一份、从不重建，重建的是图块。 */
function bindBlockBar() {
  refs.blockBar?.addEventListener('click', async event => {
    const button = event.target.closest('[data-block-tool]');
    if (!button || button.disabled || !selectedItemId) return;
    const id = selectedItemId;
    const action = button.dataset.blockTool;
    if (action === 'up') await moveBlock(id, -1);
    else if (action === 'down') await moveBlock(id, 1);
    else if (action === 'toggle') await toggleBlock(id);
    else if (action === 'edit') {
      selectBlock(id, { edit: true });
      refs.blockTitle?.focus?.({ preventScroll: true });
      return;
    } else if (action === 'remove') {
      const items = plan()?.items || [];
      const index = items.findIndex(item => item.id === id);
      const nextId = items[index + 1]?.id || items[index - 1]?.id;
      const removed = await removeBlock(id);
      if (removed) {
        if (nextId) focusPlanTile(nextId);
        else refs.addBlock.focus({ preventScroll: true });
      }
      return;
    }
    if (document.activeElement === button && button.disabled) focusPlanTile(id);
  });
}

/* 成品默认收起。展开状态不进 localStorage：它是一次性的「我想看一眼」，
   记住它等于把 129px 永久还回去，而那正是这次要省下来的。 */
function bindOutputToggle() {
  const toggle = refs.outputToggle;
  const boxes = refs.outputBoxes;
  if (!toggle || !boxes) return;
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    boxes.hidden = open;
  });
}

function bindLaneDrop() {
  /* 两个落点：图墙本体与空态引导块 */
  for (const target of [refs.lane, refs.empty].filter(Boolean)) {
    target.addEventListener('dragover', event => {
      const types = event.dataTransfer?.types || [];
      if (!dragBlockId && !types.includes(RELAY_PLAN_MIME) && !types.includes(RELAY_SOURCE_MIME)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = types.includes(RELAY_SOURCE_MIME) ? 'copy' : 'move';
      target.classList.add('is-drop-target');
      /* 轨道空白处同样按指针坐标算槽位：拖到最后一块右边的空档就该插到末尾，
         而不是不管指针在哪都硬塞队尾。 */
      if (types.includes(RELAY_PLAN_MIME) && target === refs.lane && dragPreview) {
        moveDragPreview(event.clientX, event.clientY);
      }
    });
    target.addEventListener('dragleave', event => {
      if (!target.contains(event.relatedTarget)) target.classList.remove('is-drop-target');
    });
    target.addEventListener('drop', async event => {
      target.classList.remove('is-drop-target');
      const types = event.dataTransfer?.types || [];
      if (!dragBlockId && !types.includes(RELAY_PLAN_MIME) && !types.includes(RELAY_SOURCE_MIME)) return;
      event.preventDefault();
      /* 已有块拖到轨道空白处 = 移到末尾。以前这里直接 return，只有拖到另一块上才生效，
         轨道下方那片空白看着像落点却没反应。 */
      /* 素材直接拖进轨道 = 加入方案。载荷里带的是整条快照，省得跨模块回查——
         收藏来源的条目根本不在 relayInbox 里，按 key 查会落空。 */
      const payload = event.dataTransfer?.getData(RELAY_SOURCE_MIME);
      if (payload) {
        try { await addSourceToPlan(JSON.parse(payload)); }
        catch (error) { console.warn('[tag-relay] 拖入的素材解析失败', error); }
        dragBlockId = '';
        return;
      }
      const draggedId = event.dataTransfer?.getData(RELAY_PLAN_MIME) || dragBlockId;
      const targetPlanId = plan()?.id || '';
      /* 和卡片上的 drop 同一条规矩：提交预览时那个下标，没有预览才退回"移到末尾"。 */
      const previewed = previewIndex();
      const targetIndex = previewed == null
        ? Math.max(0, (plan()?.items?.length || 1) - 1)
        : Math.max(0, Math.min((plan()?.items?.length || 1) - 1, previewed));
      if (!draggedId || !targetPlanId) return;
      dragBlockId = '';
      clearDropMarkers();
      finishDragPreview();
      await commitRelay(
        next => movePlanItem(next, targetPlanId, draggedId, targetIndex),
        { changed: 'plan' },
      );
    });
  }
}

/* Esc 由内向外：编辑器开着时先关编辑器，别一路把整个侧栏关掉 */
function bindEscape(root) {
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!refs.planList.hidden) {
      event.preventDefault();
      event.stopPropagation();
      refs.planList.hidden = true;
      refs.planPickerBtn.setAttribute('aria-expanded', 'false');
      refs.planPickerBtn.focus({ preventScroll: true });
      return;
    }
    if (!refs.planMenu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      refs.planMenu.hidden = true;
      refs.planMenuBtn.setAttribute('aria-expanded', 'false');
      refs.planMenuBtn.focus({ preventScroll: true });
      return;
    }
    if (!refs.inspector.hidden) {
      event.preventDefault();
      event.stopPropagation();
      orphanedDraft = null;
      closeInspector({ restoreFocus: true });
      return;
    }
    if (historyOpen) {
      event.preventDefault();
      event.stopPropagation();
      historyOpen = false;
      renderHistory();
      refs.historyToggle.focus({ preventScroll: true });
    }
  });
}

export function setupRelayCompose(root) {
  if (!root) return { render: () => {} };
  /* ⚠ 作用域是**整条栏**而不是编排分区：一屏化之后，方案选择与「⋯」在栏头，
     复制历史 / 块编辑器 / 成品分别是栏级浮层与贴底页脚，都已经不在 root 里面了。
     不放宽就全是 null，renderCompose 第一行读 refs.inspector.hidden 就炸。 */
  const scope = root.closest('.tag-relay-rail') || root;
  const q = selector => scope.querySelector(selector);
  refs = {
    root,
    planSelect: q('#relayPlanSelect'),
    planPickerBtn: q('#relayPlanPickerBtn'),
    planPickerLabel: q('#relayPlanPickerLabel'),
    planList: q('#relayPlanList'),
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
    rail: scope,
    blockBar: q('#relayBlockBar'),
    blockBarThumb: q('#relayBlockBarThumb'),
    blockBarTitle: q('#relayBlockBarTitle'),
    blockBarMeta: q('#relayBlockBarMeta'),
    outputToggle: q('#relayOutputToggle'),
    outputBoxes: q('#relayOutputBoxes'),
    outputSummary: q('#relayOutputSummary'),
    outputNote: q('#relayOutputNote'),
    copyAllHint: q('#relayCopyAllHint'),
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
    formatButtons: [...scope.querySelectorAll('[data-format]')],
    joinButtons: [...scope.querySelectorAll('[data-join]')],
  };
  if (!bound) {
    bound = true;
    bindPlanBar();
    bindInspector();
    bindSegments();
    bindLaneDrop();
    scope.addEventListener('dragend', () => clearDropMarkers());
    bindBlockBar();
    bindOutputToggle();
    bindEscape(scope);
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => positionHistory());
      observer.observe(scope);
      observer.observe(refs.root);
    }
    refs.copyPositive.addEventListener('click', event => copyOutput('positive', event.currentTarget));
    refs.copyNegative.addEventListener('click', event => copyOutput('negative', event.currentTarget));
    refs.copyAll.addEventListener('click', event => copyOutput('both', event.currentTarget));
  }
  renderCompose();
  return { render: renderCompose, closeInspector };
}
