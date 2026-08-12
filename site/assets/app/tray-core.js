/* Tag 中转站的纯数据层：结构规范化、接缝拼接、方案增删。
   刻意零 import、不碰 DOM 与 localStorage —— `node tools/test_tray_core.mjs` 直接跑得动。
   有状态与副作用的部分在 tray.js，界面在 tray-panel.js。 */

export const TRAY_VERSION = 1;
/* 上限按实测定：词条快照中位 0.3~1.6KB，100 条约 250KB，localStorage 5MB 放得下。
   只存引用则刷新后要重下 7~11MB 的大本 JSON 才拼得出文本，手机上不可接受。 */
export const TRAY_ITEM_LIMIT = 100;
export const TRAY_BOARD_LIMIT = 8;

export function trayItemKey(codexId, entryId) {
  return `${codexId}:${entryId}`;
}

export function emptyTray() {
  return { v: TRAY_VERSION, items: [], boards: [newBoard(0)], active: 0 };
}

export function boardLabel(index) {
  /* A..Z 之后回落到数字，反正 TRAY_BOARD_LIMIT 早就拦住了 */
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

function newBoard(index) {
  return { id: `b${Date.now().toString(36)}${index}`, name: `方案 ${boardLabel(index)}`, slots: [] };
}

function str(value) {
  return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

function normalizeChars(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => ({
      label: str(item?.label) || 'char',
      prompt: str(item?.prompt),
      hasNegative: Boolean(str(item?.negative).trim()),
    }))
    .filter(item => item.prompt.trim() || item.hasNegative);
}

export function normalizeItem(value) {
  const codexId = str(value?.codexId).trim();
  const entryId = str(value?.entryId).trim();
  if (!codexId || !entryId) return null;
  return {
    key: trayItemKey(codexId, entryId),
    codexId,
    entryId,
    title: str(value?.title) || entryId,
    book: str(value?.book),
    path: str(value?.path),
    thumb: str(value?.thumb),
    pos: str(value?.pos),
    neg: str(value?.neg),
    chars: normalizeChars(value?.chars),
    at: Number(value?.at) || Date.now(),
  };
}

/* localStorage 里的东西不可信：结构坏了宁可退回空中转站，也不要让面板半死不活。
   槽位引用不到词条就丢掉（词条被移出仓库时也走这条路收尾）。 */
export function normalizeTray(value) {
  if (!value || typeof value !== 'object') return emptyTray();
  const items = [];
  const seen = new Set();
  for (const raw of Array.isArray(value.items) ? value.items : []) {
    const item = normalizeItem(raw);
    if (!item || seen.has(item.key)) continue;
    seen.add(item.key);
    items.push(item);
    if (items.length >= TRAY_ITEM_LIMIT) break;
  }
  const boards = [];
  for (const raw of Array.isArray(value.boards) ? value.boards : []) {
    if (!raw || typeof raw !== 'object') continue;
    const slots = (Array.isArray(raw.slots) ? raw.slots : [])
      .map(slot => ({ key: str(slot?.key), on: slot?.on !== false }))
      .filter(slot => seen.has(slot.key));
    boards.push({
      id: str(raw.id) || `b${boards.length}`,
      name: str(raw.name) || `方案 ${boardLabel(boards.length)}`,
      slots,
    });
    if (boards.length >= TRAY_BOARD_LIMIT) break;
  }
  if (!boards.length) boards.push(newBoard(0));
  const active = Number(value.active);
  return {
    v: TRAY_VERSION,
    items,
    boards,
    active: Number.isInteger(active) && active >= 0 && active < boards.length ? active : 0,
  };
}

export function findItem(tray, key) {
  return tray.items.find(item => item.key === key) || null;
}

export function activeBoard(tray) {
  return tray.boards[tray.active] || tray.boards[0];
}

/* 接缝规范化：实测所长那本 5546 条里有 5336 条 tag 串以逗号结尾，
   直接首尾相接会拼出 `,,` 和空 tag。 */
export function normalizeBlock(text) {
  return str(text).trim().replace(/^[,，\s]+/, '').replace(/[,，\s]+$/, '').trim();
}

/* 与 copy.js 的 entryPromptText 同一套规则：正面串 + 各角色词的**正面**，去掉 char1 标记本身。
   ⚠ 角色词的 negative 绝不能进这里 —— 那是「不要什么」，混进正面等于反向作画。 */
export function itemPositive(item) {
  const parts = [str(item?.pos).trim()];
  for (const char of item?.chars || []) parts.push(str(char.prompt).trim());
  return parts.filter(Boolean).join('\n');
}

export function itemNegative(item) {
  /* 只取词条级负面。角色级负面（character N uc）在 NAI 里是按角色分槽填的，
     多条词条的角色负面合并成一坨没有意义，面板上另给「含角色负面」提示引导去灯箱。 */
  return str(item?.neg).trim();
}

export function itemHasCharNegative(item) {
  return (item?.chars || []).some(char => char.hasNegative);
}

export function composeChannel(tray, board = activeBoard(tray), channel = 'pos') {
  const pick = channel === 'neg' ? itemNegative : itemPositive;
  return (board?.slots || [])
    .filter(slot => slot.on)
    .map(slot => findItem(tray, slot.key))
    .filter(Boolean)
    .map(item => normalizeBlock(pick(item)))
    .filter(Boolean)
    .join(',\n');
}

/* 只用来给用户一个量级感（顶栏「约 N tag」）。真正的 tag 级拆分要尊重
   `0.6::a,b,c::` 这类跨逗号的权重组，等抽出共享 tokenizer 再做，别拿这个函数去做去重。 */
export function roughTagCount(text) {
  return str(text).split(/[,\n]/).map(part => part.trim()).filter(Boolean).length;
}

export function addItem(tray, rawItem, { toBoard = true } = {}) {
  const item = normalizeItem(rawItem);
  if (!item) return { ok: false, reason: 'invalid' };
  if (findItem(tray, item.key)) return { ok: false, reason: 'exists' };
  if (tray.items.length >= TRAY_ITEM_LIMIT) return { ok: false, reason: 'full' };
  tray.items.push(item);
  if (toBoard) activeBoard(tray).slots.push({ key: item.key, on: true });
  return { ok: true, item };
}

/* 移出仓库 = 从所有方案里一并撤掉，否则会留下引用不到词条的空槽 */
export function removeItem(tray, key) {
  const before = tray.items.length;
  tray.items = tray.items.filter(item => item.key !== key);
  for (const board of tray.boards) board.slots = board.slots.filter(slot => slot.key !== key);
  return tray.items.length !== before;
}

export function createBoard(tray) {
  if (tray.boards.length >= TRAY_BOARD_LIMIT) return { ok: false, reason: 'full' };
  tray.boards.push(newBoard(tray.boards.length));
  tray.active = tray.boards.length - 1;
  return { ok: true, board: activeBoard(tray) };
}

export function removeBoard(tray, index) {
  if (tray.boards.length <= 1) return false;
  if (!tray.boards[index]) return false;
  tray.boards.splice(index, 1);
  tray.active = Math.min(tray.active, tray.boards.length - 1);
  return true;
}

export function moveSlot(slots, from, to) {
  if (!Array.isArray(slots)) return false;
  if (from === to || from < 0 || to < 0 || from >= slots.length || to >= slots.length) return false;
  const [moved] = slots.splice(from, 1);
  slots.splice(to, 0, moved);
  return true;
}

export function trayStats(tray) {
  const board = activeBoard(tray);
  const pos = composeChannel(tray, board, 'pos');
  const neg = composeChannel(tray, board, 'neg');
  return {
    items: tray.items.length,
    boards: tray.boards.length,
    slots: board?.slots.length || 0,
    onSlots: (board?.slots || []).filter(slot => slot.on).length,
    pos,
    neg,
    posTags: roughTagCount(pos),
    negTags: roughTagCount(neg),
  };
}
