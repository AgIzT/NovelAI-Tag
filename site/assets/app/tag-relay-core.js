import { naiToSd } from './nai-sd.js';

export { naiToSd } from './nai-sd.js';

export const TAG_RELAY_STORAGE_KEY = 'fadian-tag-relay-v1';
export const TAG_RELAY_SCHEMA_VERSION = 2;
export const TAG_RELAY_INBOX_LIMIT = 50;
export const TAG_RELAY_HISTORY_LIMIT = 20;
export const TAG_RELAY_TARGETS = Object.freeze(['nai', 'sd', 'plain']);

const DEFAULT_PLAN_ID = 'plan-default';
const DEFAULT_PLAN_NAME = '新方案';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, fallback = '') {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  return fallback;
}

function timestamp(value, fallback = new Date().toISOString()) {
  const source = text(value);
  return source && !Number.isNaN(Date.parse(source)) ? source : fallback;
}

function nowIso(options = {}) {
  if (typeof options.now === 'function') return timestamp(options.now());
  return timestamp(options.now);
}

function hashText(value) {
  let hash = 0x811c9dc5;
  for (const ch of String(value)) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function keyPart(value) {
  return encodeURIComponent(text(value).toLowerCase());
}

function generatedId(prefix) {
  try {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  } catch {
    // Restricted browser contexts can expose crypto while denying the call.
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function uniqueId(values, requested, prefix) {
  const used = new Set(values.map(value => text(value?.id)).filter(Boolean));
  const base = text(requested) || generatedId(prefix);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function normalizeTarget(value) {
  return TAG_RELAY_TARGETS.includes(value) ? value : 'nai';
}

function normalizeCharacterPrompts(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const source = isObject(item) ? item : {};
    return {
      label: text(source.label, `char${index + 1}`),
      prompt: text(source.prompt ?? source.positive ?? source.tags),
      negative: text(source.negative),
    };
  }).filter(item => item.prompt || item.negative);
}

function normalizePath(value) {
  const parts = Array.isArray(value) ? value : [value];
  return parts.map(item => text(item)).filter(Boolean);
}

/* 早期中转站数据只保存了原词条的 rating / level / path，没有显式 access
   快照。迁移时仍要按主站同一套规则补齐，不能因为字段缺失就把成人内容当普通块。 */
function inferredAccess(source = {}) {
  const rating = text(source.rating ?? source.level).toLowerCase();
  const path = Array.isArray(source.path) ? source.path : [source.path];
  const nsfwPath = path.some(segment => {
    const value = text(segment).toLowerCase();
    return value.includes('nsfw') || value.includes('r18') || value.includes('限制级');
  });
  const nsfw = ['restricted', 'r18', 'r18g', 'nsfw'].includes(rating) || nsfwPath;
  const r18gPath = path.some(segment => {
    const value = text(segment).toLowerCase();
    return value.includes('r18g') || value.includes('重口');
  });
  return { nsfw, r18g: rating === 'r18g' || r18gPath };
}

function hasAccessEvidence(source = {}) {
  const access = isObject(source.access) ? source.access : null;
  const direct = Boolean(
    access && (Object.hasOwn(access, 'nsfw') || Object.hasOwn(access, 'r18g'))
  ) || [
    'nsfw', 'r18g', 'sourceNsfw', 'sourceR18g', 'rating', 'level',
  ].some(key => source[key] !== undefined && source[key] !== null);
  return direct || normalizePath(source.path).length > 0;
}

function normalizeAccess(value, source = {}) {
  const access = isObject(value) ? value : {};
  const inferred = inferredAccess(source);
  const r18g = access.r18g === true
    || source.r18g === true
    || source.sourceR18g === true
    || inferred.r18g;
  return {
    /* ⚠ r18g 必然也是成人内容，所以让它直接抬起 nsfw。否则「路径里写了重口、却没写
       nsfw/r18」这类条目只有 r18g 一个标记，是否被锁全靠 ui.js 那条
       `allowR18g = on && allowNsfw` 的隐式不变式兜着——跨文件、无断言，
       哪天有人直接从 storage 恢复 allowR18g，这条就漏了。 */
    nsfw: r18g
      || access.nsfw === true
      || source.nsfw === true
      || source.sourceNsfw === true
      || inferred.nsfw,
    r18g,
  };
}

/**
 * A source identity wins over prompt text, so later title/prompt edits do not
 * create a second staged card. Local blocks fall back to a deterministic hash.
 */
export function stableEntryKey(entry, context = {}) {
  const source = isObject(entry) ? entry : {};
  const explicit = text(source.relayKey);
  if (explicit) return explicit;

  const codexId = text(
    source.codexId
      ?? source._srcCodexId
      ?? source.sourceCodexId
      ?? context.codexId,
  );
  const entryId = text(source.entryId ?? source.id ?? source.key ?? context.entryId);
  if (codexId && entryId) return `entry:${keyPart(codexId)}:${keyPart(entryId)}`;

  const signature = [
    /* \u26a0 title \u5fc5\u987b\u4e0e normalizeRelayEntry \u7528\u540c\u4e00\u5957\u515c\u5e95\uff1a\u5426\u5219\u65e0\u6807\u9898\u6761\u76ee\u7b2c\u4e00\u6b21
       normalize \u8865\u51fa\u6807\u9898\u540e\uff0c\u7b2c\u4e8c\u6b21\u7b97\u7684 key \u5c31\u548c\u7b2c\u4e00\u6b21\u4e0d\u540c\uff0cinbox \u51ed\u7a7a\u591a\u4e00\u5f20\u91cd\u590d\u5361\u3002 */
    text(source.title, entryId || '\u672a\u547d\u540d\u8bcd\u6761'),
    text(source.prompt ?? source.positive ?? source.tags),
    text(source.negative),
    /* \u26a0 \u89d2\u8272\u8bcd\u4e5f\u8981\u8fdb\u7b7e\u540d\uff1a\u53ea\u5dee characterPrompts \u7684\u4e24\u6761\u672c\u5730\u8bcd\u6761\u5426\u5219\u4f1a\u786e\u5b9a\u6027\u649e key\u3001\u4e92\u76f8\u8986\u76d6\u3002
       \u8d70\u5f52\u4e00\u5316\u540e\u7684\u5f62\u6001\uff0c\u624d\u80fd\u4fdd\u8bc1 normalize \u524d\u540e\u7b97\u51fa\u540c\u4e00\u4e2a hash\u3002 */
    normalizeCharacterPrompts(source.characterPrompts)
      .map(item => `${item.label}\u241e${item.prompt}\u241e${item.negative}`)
      .join('\u241d'),
  ].join('\u241f').toLowerCase();
  return `entry:local:${hashText(signature)}`;
}

export function normalizeRelayEntry(entry, context = {}) {
  const source = isObject(entry) ? entry : {};
  const fallbackNow = nowIso(context);
  const codexId = text(
    source.codexId
      ?? source._srcCodexId
      ?? source.sourceCodexId
      ?? context.codexId,
  );
  const entryId = text(source.entryId ?? source.id ?? source.key ?? context.entryId);
  return {
    key: stableEntryKey(source, context),
    codexId,
    entryId,
    title: text(source.title, entryId || '未命名词条'),
    prompt: text(source.prompt ?? source.positive ?? source.tags),
    negative: text(source.negative),
    characterPrompts: normalizeCharacterPrompts(source.characterPrompts),
    book: text(source.book ?? source.codexTitle ?? context.codexTitle),
    path: normalizePath(source.path),
    image: text(source.image ?? source.imageUrl ?? source.thumb),
    access: normalizeAccess(source.access, source),
    /* 旧引用可能没有任何可核验分级字段。把证据是否存在一并保留，
       snapshotLocked 才能对未知来源采取 fail-closed，而不误锁新的安全快照。
       ⚠ 显式带了 accessKnown 就必须尊重它（哪怕是 false）：本函数恒写出
       access:{nsfw,r18g}，若每次都重新推断，hasAccessEvidence 就会把自己的产物
       当成分级证据，序列化一轮 false 便翻回 true，fail-closed 静默失效。 */
    accessKnown: Object.hasOwn(source, 'accessKnown')
      ? source.accessKnown === true
      : hasAccessEvidence(source),
    addedAt: timestamp(source.addedAt, fallbackNow),
  };
}

/* ⚠ 区分「没传权重」和「传了非法值」：缺失/空串/不可解析 → 1（=不加权），
   其余一律 clamp。旧版把 0、负数、Infinity 一并当成「没传」，于是 weight=0 悄悄变回 1，
   而 0.01 却老实地 clamp 到 0.05 —— 同一根滑块两套语义。 */
function normalizeWeight(value) {
  if (value === undefined || value === null || value === '') return 1;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return 1;
  return Math.min(10, Math.max(0.05, parsed));
}

function normalizePlanItem(item, context = {}) {
  const source = isObject(item) ? item : {};
  const embedded = isObject(source.entry) ? source.entry : source;
  const kind = source.kind === 'block' ? 'block' : 'entry';
  const fallbackNow = nowIso(context);
  const entry = kind === 'entry' ? normalizeRelayEntry(embedded, context) : null;
  return {
    id: text(source.id ?? (source.uid != null ? `slot-${source.uid}` : ''))
      || generatedId(kind === 'entry' ? 'entry-slot' : 'block-slot'),
    kind,
    entryKey: kind === 'entry'
      ? text(source.entryKey ?? source.relayKey ?? source.key, entry.key)
      : '',
    codexId: kind === 'entry' ? text(source.codexId, entry.codexId) : '',
    entryId: kind === 'entry' ? text(source.entryId, entry.entryId) : '',
    title: text(source.title, kind === 'entry' ? entry.title : '自定义块'),
    prompt: text(source.prompt ?? source.positive ?? source.tags, kind === 'entry' ? entry.prompt : ''),
    negative: text(source.negative, kind === 'entry' ? entry.negative : ''),
    characterPrompts: kind === 'entry'
      ? normalizeCharacterPrompts(source.characterPrompts ?? entry.characterPrompts)
      : normalizeCharacterPrompts(source.characterPrompts),
    book: kind === 'entry' ? text(source.book, entry.book) : '',
    path: kind === 'entry' ? normalizePath(source.path ?? entry.path) : [],
    image: kind === 'entry' ? text(source.image, entry.image) : '',
      access: kind === 'entry'
        ? normalizeAccess(source.access, entry.access)
        : normalizeAccess(source.access, source),
      /* 同 normalizeRelayEntry：显式的 accessKnown 是最终答案，缺席才回落到推断。
         自定义块的正文由用户自己写，默认视为已知分级。 */
      accessKnown: Object.hasOwn(source, 'accessKnown')
        ? source.accessKnown === true
        : (kind === 'entry' ? entry.accessKnown === true : true),
    enabled: source.enabled !== false && source.on !== false,
    weight: normalizeWeight(source.weight),
    createdAt: timestamp(source.createdAt, fallbackNow),
  };
}

function normalizePlan(plan, context = {}) {
  const source = isObject(plan) ? plan : {};
  const fallbackNow = nowIso(context);
  const items = [];
  const usedIds = new Set();
  for (const rawItem of Array.isArray(source.items) ? source.items : []) {
    const item = normalizePlanItem(rawItem, context);
    const base = item.id;
    let next = base;
    let suffix = 2;
    while (usedIds.has(next)) next = `${base}-${suffix++}`;
    item.id = next;
    usedIds.add(next);
    items.push(item);
  }
  return {
    id: text(source.id) || generatedId('plan'),
    name: text(source.name ?? source.title, DEFAULT_PLAN_NAME),
    revision: Math.max(0, Number.parseInt(source.revision ?? source.rev, 10) || 0),
    items,
    createdAt: timestamp(source.createdAt, fallbackNow),
    updatedAt: timestamp(source.updatedAt, fallbackNow),
  };
}

/* ⚠ 调用方明确写了 0 就是 0：旧写法 `parseInt(...) || split(...).length` 会把显式的 0
   当成缺省再算一遍，于是「只复制负向」的记录被倒填出一个虚假的正向段数。 */
function tokenCount(value, fallbackText) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : splitTopLevel(fallbackText).length;
}

/* history 上限的唯一权威名字是 `historyLimit`：`limit` 在 touchInboxEntry 里表示 inbox 上限，
   而 load/save/serialize 会把同一个 options 对象一路透传，两处同名必然打架
   （给 inbox 传 limit:2 会顺手把复制历史砍到 2 条）。recordCopyHistory 保留 `limit` 别名
   只为兼容既有调用，`historyLimit` 优先。非法值统一按 clamp：0/-5 → 1，缺失/非数字 → 默认值。 */
function resolveHistoryLimit(raw) {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : TAG_RELAY_HISTORY_LIMIT;
}

function normalizeHistoryRecord(record, context = {}) {
  const source = isObject(record) ? record : {};
  const fallbackNow = nowIso(context);
  const rawItems = isObject(source.plan) ? source.plan.items : source.items;
  /* 旧版曾只留 entryKey 引用。normalizePlan 会把它伪装成空 entry，若据此标为
     完整快照就会把无法核验权限的 output 再次放行。新记录必须显式带标记；
     兼容的历史记录也必须每一项都带完整的 access 布尔。
     ⚠ 判定的本意只有一条：这条记录能不能**独立核验权限**。别再要求「有正文」——
     一个空正文的 entry 会让整条复制历史永久锁死（「再次复制」「恢复为方案」全消失、
     开关全开也解不开），界面还会谎称是权限问题；而 kind:'block' 的空块本来就放行，
     两套标准本身就自相矛盾。 */
  const hasVerifiedItemSnapshots = Array.isArray(rawItems) && rawItems.every(item => {
    if (!isObject(item)) return false;
    const access = isObject(item.access) ? item.access : null;
    return Boolean(access) && typeof access.nsfw === 'boolean' && typeof access.r18g === 'boolean';
  });
  const planSource = isObject(source.plan)
    ? source.plan
    : { id: source.planId, name: source.planName ?? source.label, items: source.items };
  const plan = normalizePlan(planSource, context);
  const channel = ['positive', 'negative', 'both'].includes(source.channel)
    ? source.channel
    : 'both';
  const joinMode = ['comma', 'newline'].includes(source.joinMode ?? source.join)
    ? (source.joinMode ?? source.join)
    : 'comma';
  const positive = text(source.positive ?? (channel === 'positive' ? source.output : ''));
  const negative = text(source.negative ?? (channel === 'negative' ? source.output : ''));
  return {
    id: text(source.id) || generatedId('copy'),
    label: text(source.label, plan.name),
    planId: text(source.planId, plan.id),
    planName: text(source.planName, plan.name),
    target: normalizeTarget(source.target),
    joinMode,
    channel,
    positive,
    negative,
    positiveCount: tokenCount(source.positiveCount, positive),
    negativeCount: tokenCount(source.negativeCount, negative),
    plan,
    /* 早期半成品只记了输出字符串，没有可复核权限的方案快照。界面必须把它
       当未知来源锁住，不能因为没有 access 字段就重新展示或恢复明文。 */
    snapshotComplete: source.snapshotComplete === true && hasVerifiedItemSnapshots,
    createdAt: timestamp(source.createdAt ?? source.time, fallbackNow),
  };
}

export function createRelayState(options = {}) {
  const now = nowIso(options);
  const plan = normalizePlan({
    id: text(options.planId, DEFAULT_PLAN_ID),
    name: text(options.planName, DEFAULT_PLAN_NAME),
    items: [],
    createdAt: now,
    updatedAt: now,
  }, { now });
  return {
    version: TAG_RELAY_SCHEMA_VERSION,
    inbox: [],
    plans: [plan],
    activePlanId: plan.id,
    history: [],
  };
}

/** Migrate old/untrusted JSON into the current, fully serializable schema. */
export function normalizeRelayState(raw, options = {}) {
  if (!isObject(raw)) return createRelayState(options);
  const now = nowIso(options);

  const inbox = [];
  const inboxKeys = new Set();
  /* inbox 的规范顺序是**新的在前**（schema v2）。v1 存的是旧在前，这里一次性掉头，
     否则老数据升上来会把最旧那条钉在「最近复制」顶上，直到它被挤掉。
     ⚠ 版本号未知一律当旧数据：`Number(raw.version) < 2` 对缺失/'v1'/{} 得到 NaN<2=false，
     反而把它们当成 v2 放行，而 null/false/'' 得到 0<2=true —— 正好判反。 */
  const rawVersion = Number.parseInt(raw.version, 10);
  const legacyInboxOrder = !Number.isFinite(rawVersion) || rawVersion < 2;
  const rawInbox = raw.inbox ?? raw.staged ?? raw.entries;
  const rawInboxList = Array.isArray(rawInbox) ? rawInbox : [];
  /* ⚠ 掉头必须在去重**之前**：先去重再 reverse 保留的是 v1 顺序下最旧的那份副本，
     而且位置还被挤到列表底部——正好是这次迁移想避免的两件事。 */
  for (const item of legacyInboxOrder ? [...rawInboxList].reverse() : rawInboxList) {
    if (!isObject(item)) continue;
    const entry = normalizeRelayEntry(item, { now });
    if (inboxKeys.has(entry.key)) continue;
    inboxKeys.add(entry.key);
    inbox.push(entry);
  }

  if (inbox.length > TAG_RELAY_INBOX_LIMIT) inbox.length = TAG_RELAY_INBOX_LIMIT;

  const plans = [];
  const planIds = new Set();
  for (const item of Array.isArray(raw.plans) ? raw.plans : []) {
    if (!isObject(item)) continue;
    const plan = normalizePlan(item, { now });
    const base = plan.id;
    let next = base;
    let suffix = 2;
    while (planIds.has(next)) next = `${base}-${suffix++}`;
    plan.id = next;
    planIds.add(next);
    plans.push(plan);
  }
  if (!plans.length) plans.push(createRelayState({ now }).plans[0]);

  const requestedActive = text(raw.activePlanId ?? raw.activePlan);
  const activePlanId = plans.some(plan => plan.id === requestedActive)
    ? requestedActive
    : plans[0].id;
  const limit = resolveHistoryLimit(options.historyLimit);
  const rawHistory = raw.history ?? raw.copyHistory;
  const history = (Array.isArray(rawHistory) ? rawHistory : [])
    .filter(isObject)
    .map(item => normalizeHistoryRecord(item, { now }))
    .slice(0, limit);

  return {
    version: TAG_RELAY_SCHEMA_VERSION,
    inbox,
    plans,
    activePlanId,
    history,
  };
}

export function serializeRelayState(state, options = {}) {
  return JSON.stringify(normalizeRelayState(state, options));
}

export function loadRelayState(storage = globalThis.localStorage, options = {}) {
  try {
    const raw = storage?.getItem?.(options.key || TAG_RELAY_STORAGE_KEY);
    if (!raw) return createRelayState(options);
    return normalizeRelayState(JSON.parse(raw), options);
  } catch {
    return createRelayState(options);
  }
}

export function saveRelayState(state, storage = globalThis.localStorage, options = {}) {
  try {
    storage?.setItem?.(
      options.key || TAG_RELAY_STORAGE_KEY,
      serializeRelayState(state, options),
    );
    return Boolean(storage?.setItem);
  } catch {
    return false;
  }
}

/* localStorage 配额约 5MiB，而每条复制历史都内嵌一整份 plan 快照——实测 150 项的方案
   复制 8 次就能撞满。撞满时 setItem 抛异常、saveRelayState 静默返回 false，用户的整盘
   编辑就此存不下去，所以写盘前先按字节预算把最旧的历史丢掉。
   只动 history：inbox 和 plans 是用户手工攒的资产，宁可存不下也不能替他删。
   ⚠ 历史丢光仍超标就如实返回丢弃数并停手，绝不能空转成死循环。 */
export function trimStateToBudget(state, maxChars, options = {}) {
  const budget = Number(maxChars);
  if (!isObject(state) || !Number.isFinite(budget)) return { trimmed: 0, fits: true };
  if (!Array.isArray(state.history)) state.history = [];
  let trimmed = 0;
  while (serializeRelayState(state, options).length > budget && state.history.length) {
    state.history.pop();
    trimmed += 1;
  }
  return { trimmed, fits: serializeRelayState(state, options).length <= budget };
}

/* 「复制即入库」的入口：与 addInboxEntry 的三点不同——命中已有条目时**移到最前**而不是原地不动，
   新条目 unshift 而不是 push，并且有上限。因为这一列是「最近复制」的流水，不是要用户打理的仓库。 */
export function touchInboxEntry(state, entry, options = {}) {
  if (!Array.isArray(state.inbox)) state.inbox = [];
  const normalized = normalizeRelayEntry(entry, options);
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : TAG_RELAY_INBOX_LIMIT;
  const index = state.inbox.findIndex(item => item.key === normalized.key);
  const moved = index >= 0;
  if (moved) state.inbox.splice(index, 1);
  state.inbox.unshift(normalized);
  const dropped = state.inbox.length > limit ? state.inbox.splice(limit) : [];
  return { entry: normalized, added: !moved, moved, dropped };
}

export function removeInboxEntry(state, keyOrEntry) {
  if (!Array.isArray(state.inbox)) state.inbox = [];
  const key = typeof keyOrEntry === 'string' ? keyOrEntry : stableEntryKey(keyOrEntry);
  const index = state.inbox.findIndex(item => item.key === key);
  if (index < 0) return null;
  return state.inbox.splice(index, 1)[0];
}

export function clearInbox(state) {
  const removed = Array.isArray(state.inbox) ? state.inbox.length : 0;
  state.inbox = [];
  return removed;
}

export function getPlan(state, planId = state?.activePlanId) {
  return (Array.isArray(state?.plans) ? state.plans : []).find(plan => plan.id === planId) || null;
}

export function getActivePlan(state) {
  return getPlan(state, state?.activePlanId) || state?.plans?.[0] || null;
}

function touchPlan(plan, options = {}) {
  plan.revision = Math.max(0, Number.parseInt(plan.revision, 10) || 0) + 1;
  plan.updatedAt = nowIso(options);
}

export function createPlan(state, name = DEFAULT_PLAN_NAME, options = {}) {
  if (!Array.isArray(state.plans)) state.plans = [];
  const now = nowIso(options);
  const plan = normalizePlan({
    id: uniqueId(state.plans, options.id, 'plan'),
    name,
    items: [],
    createdAt: now,
    updatedAt: now,
  }, { now });
  state.plans.push(plan);
  if (options.activate !== false || !state.activePlanId) state.activePlanId = plan.id;
  return plan;
}

export function renamePlan(state, planId, name, options = {}) {
  const plan = getPlan(state, planId);
  if (!plan) return null;
  const nextName = text(name);
  if (!nextName) return null;
  plan.name = nextName;
  touchPlan(plan, options);
  return plan;
}

export function setActivePlan(state, planId) {
  if (!getPlan(state, planId)) return false;
  state.activePlanId = planId;
  return true;
}

export function deletePlan(state, planId, options = {}) {
  if (!Array.isArray(state.plans)) state.plans = [];
  const index = state.plans.findIndex(plan => plan.id === planId);
  if (index < 0) return null;
  const [removed] = state.plans.splice(index, 1);
  if (!state.plans.length) {
    createPlan(state, options.replacementName || DEFAULT_PLAN_NAME, {
      ...options,
      id: options.replacementId || DEFAULT_PLAN_ID,
      activate: true,
    });
  } else if (state.activePlanId === planId) {
    state.activePlanId = state.plans[Math.min(index, state.plans.length - 1)].id;
  }
  return removed;
}

function planItemId(plan, options, prefix) {
  return uniqueId(plan.items || [], options.id, prefix);
}

export function appendEntryToPlan(state, planId, entry, options = {}) {
  const plan = getPlan(state, planId);
  if (!plan) return { added: false, item: null };
  const normalized = normalizeRelayEntry(entry, options);
  if (options.allowDuplicate !== true) {
    const existing = plan.items.find(item => item.kind === 'entry' && item.entryKey === normalized.key);
    if (existing) return { added: false, item: existing };
  }
  const item = normalizePlanItem({
    ...normalized,
    id: planItemId(plan, options, 'entry-slot'),
    kind: 'entry',
    entryKey: normalized.key,
    enabled: options.enabled !== false,
    weight: options.weight,
    createdAt: nowIso(options),
  }, options);
  plan.items.push(item);
  touchPlan(plan, options);
  return { added: true, item };
}

export function appendBlockToPlan(state, planId, block = {}, options = {}) {
  const plan = getPlan(state, planId);
  if (!plan) return null;
  const source = typeof block === 'string' ? { prompt: block } : block;
  const item = normalizePlanItem({
    ...source,
    id: planItemId(plan, options, 'block-slot'),
    kind: 'block',
    enabled: options.enabled ?? source.enabled,
    weight: options.weight ?? source.weight,
    createdAt: nowIso(options),
  }, options);
  plan.items.push(item);
  touchPlan(plan, options);
  return item;
}

export function updatePlanItem(state, planId, itemId, patch = {}, options = {}) {
  const plan = getPlan(state, planId);
  const item = plan?.items?.find(candidate => candidate.id === itemId);
  if (!item || !isObject(patch)) return null;
  /* ⚠ 三个文本分支的语义必须一致：显式传空串才清空，传 undefined 视为没传。
     少了兜底的话 `{prompt: undefined}` 会把正文抹掉，而同一个 patch 里的 title 却安然无恙。 */
  if (Object.hasOwn(patch, 'title')) item.title = text(patch.title, item.title);
  if (Object.hasOwn(patch, 'prompt') || Object.hasOwn(patch, 'positive')) {
    item.prompt = text(patch.prompt ?? patch.positive, item.prompt);
  }
  if (Object.hasOwn(patch, 'negative')) item.negative = text(patch.negative, item.negative);
  if (Object.hasOwn(patch, 'enabled') || Object.hasOwn(patch, 'on')) {
    item.enabled = patch.enabled !== false && patch.on !== false;
  }
  if (Object.hasOwn(patch, 'weight')) item.weight = normalizeWeight(patch.weight);
  if (Object.hasOwn(patch, 'characterPrompts')) {
    item.characterPrompts = normalizeCharacterPrompts(patch.characterPrompts);
  }
  touchPlan(plan, options);
  return item;
}

export function movePlanItem(state, planId, itemId, toIndex, options = {}) {
  const plan = getPlan(state, planId);
  const fromIndex = plan?.items?.findIndex(item => item.id === itemId) ?? -1;
  if (fromIndex < 0 || plan.items.length < 2) return false;
  /* ⚠ 非整数直接拒绝，不能像 `parseInt(...) || 0` 那样把 'abc'/undefined/NaN 悄悄
     变成「移到队首」还回 true —— 拖拽出错时用户会看到条目莫名其妙跳到第一位。
     toIndex=0 是合法意图，越界则按夹取处理（拖到列表外＝拖到头/尾）。 */
  const parsed = typeof toIndex === 'number' ? toIndex : Number.parseInt(toIndex, 10);
  if (!Number.isInteger(parsed)) return false;
  const target = Math.min(plan.items.length - 1, Math.max(0, parsed));
  if (fromIndex === target) return false;
  const [item] = plan.items.splice(fromIndex, 1);
  plan.items.splice(target, 0, item);
  touchPlan(plan, options);
  return true;
}

export function removePlanItem(state, planId, itemId, options = {}) {
  const plan = getPlan(state, planId);
  const index = plan?.items?.findIndex(item => item.id === itemId) ?? -1;
  if (index < 0) return null;
  const [removed] = plan.items.splice(index, 1);
  touchPlan(plan, options);
  return removed;
}

/* 撤销“移出方案”必须把原来的槽位本身放回来，不能重新 append 素材：后者会换 id，
   还可能丢掉用户改过的正文、权重、停用状态与原顺序。maxEntryCopies 默认守住“一条素材
   一槽位”的现行不变式；调用方可传删除前的同 key 数量，让历史遗留的重复槽位也能原样撤销。 */
export function restorePlanItem(state, planId, item, toIndex, options = {}) {
  const plan = getPlan(state, planId);
  if (!plan || !isObject(item)) return null;
  const parsed = typeof toIndex === 'number' ? toIndex : Number.parseInt(toIndex, 10);
  if (!Number.isInteger(parsed)) return null;
  const restored = normalizePlanItem(item, options);
  if (plan.items.some(candidate => candidate.id === restored.id)) return null;
  if (restored.kind === 'entry') {
    const maxCopies = Math.max(1, Number.parseInt(options.maxEntryCopies, 10) || 1);
    const copies = plan.items.filter(candidate => (
      candidate.kind === 'entry' && candidate.entryKey === restored.entryKey
    )).length;
    if (copies >= maxCopies) return null;
  }
  const target = Math.min(plan.items.length, Math.max(0, parsed));
  plan.items.splice(target, 0, restored);
  touchPlan(plan, options);
  return restored;
}

/* 头尾都要剥：只剥尾的话 compileRelayBlock(',a') 会写出 `1.2::,a::`，
   那个前导逗号在 NAI 里是个空 tag。 */
export function cleanPrompt(value) {
  return text(value).replace(/^[\s,，]+/, '').replace(/[\s,，]+$/, '').trim();
}

/** Split only real top-level commas; weighted NAI/SD groups stay intact. */
export function splitTopLevel(value) {
  const source = cleanPrompt(value);
  const output = [];
  let part = '';
  let curly = 0;
  let square = 0;
  let round = 0;
  let numeric = false;
  let numericClosed = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const pair = source.slice(index, index + 2);
    if (pair === '::') {
      if (numeric) {
        numeric = false;
        part += pair;
        index += 1;
        continue;
      }
      if (part.trim().match(/^[+-]?\d+(?:\.\d+)?$/)) {
        numeric = true;
        /* ⚠ 必须和 naiToSd 同一套判断：它先用 `([\s\S]*?)::` 找配对的收尾 ::，找得到就整段
           算一个权重组（`0.6::x,y::` 里的逗号不是分隔符）；找不到才退回兜底分支
           `([^,\n}\]]*)`，在逗号/换行/右括号处截断。少了这一步，未闭合的 `1.5::` 会让
           后面所有顶层逗号都不再切分，两个模块对同一串的理解就分叉了：
           输出台的「N 段」计数错报、该段尾部的重复标签也不再被合并。 */
        numericClosed = source.indexOf('::', index + 2) >= 0;
        part += pair;
        index += 1;
        continue;
      }
    }
    if (numeric && !numericClosed && (char === ',' || char === '\n' || char === '}' || char === ']')) {
      numeric = false;
    }
    if (!numeric) {
      if (char === '{') curly += 1;
      else if (char === '}' && curly) curly -= 1;
      if (char === '[') square += 1;
      else if (char === ']' && square) square -= 1;
      if (char === '(') round += 1;
      else if (char === ')' && round) round -= 1;
    }
    if (char === ',' && !curly && !square && !round && !numeric) {
      const token = cleanPrompt(part);
      if (token) output.push(token);
      part = '';
    } else {
      part += char;
    }
  }
  const tail = cleanPrompt(part);
  if (tail) output.push(tail);
  return output;
}

function formatWeight(value) {
  return Number(normalizeWeight(value).toFixed(3)).toString();
}

/* 纯文本目标没有权重语法，core 只能把权重丢掉——但界面得知道自己丢了什么，
   才能把权重滑块灰掉／提示「该目标不带权重」，而不是让用户对着无效滑块调半天。 */
export function weightAppliesTo(target) {
  return normalizeTarget(target) !== 'plain';
}

/* ⚠ 与 nai-sd.js 的 NAI_WEIGHT_BASE 同值，那边没导出，改动必须两处同步。 */
const NAI_BRACKET_BASE = 1.05;
/* 正文里已经存在的数字权重（含嵌在括号里的），出现一处就够触发歧义 */
const INLINE_NAI_WEIGHT = /(?:^|[^\d.])[+-]?\d+(?:\.\d+)?::/;

/* ⚠ 正文自带 `1.2::x::` 时再套一层块权重会写出 `1.4::…::::`，而 nai-sd.js 开头明说
   数字权重自嵌套时 `::` 的就近闭合有歧义、不作递归解析——正常路径批量生产歧义串不可接受。
   这里改用 NAI 的括号层数近似（`{}`≈×1.05、`[]`≈÷1.05）：语义无歧义，naiToSd 也能正确还原，
   代价只是权重被量化到 1.05 的整数次幂（0.8 → 5 层 `[]` ≈ 0.784）。
   选它而不是「导出标志让界面提示、块权重干脆不生效」，是因为滑块必须真的起作用：
   静默失效比 2% 的量化误差更容易让人以为功能坏了。 */
function nestNaiWeight(adapted, weight) {
  const layers = Math.round(Math.log(weight) / Math.log(NAI_BRACKET_BASE));
  if (!Number.isFinite(layers) || layers === 0) return adapted;
  const depth = Math.abs(layers);
  const open = (layers > 0 ? '{' : '[').repeat(depth);
  const close = (layers > 0 ? '}' : ']').repeat(depth);
  return `${open}${adapted}${close}`;
}

export function adaptRelayOutput(value, target = 'nai') {
  const source = cleanPrompt(value);
  return normalizeTarget(target) === 'sd' ? naiToSd(source) : source;
}

export function compileRelayBlock(value, options = {}) {
  const source = cleanPrompt(value);
  if (!source) return '';
  const target = normalizeTarget(options.target);
  const weight = normalizeWeight(options.weight);
  const adapted = adaptRelayOutput(source, target);
  const label = formatWeight(weight);
  /* ⚠ 看格式化后的字符串而不是原始数值：1.0001 会被四舍五入成 '1'，
     再套壳就得到纯噪声的 `1::cat::`。 */
  if (!weightAppliesTo(target) || label === '1') return adapted;
  /* SD 目标靠括号嵌套本来就没有歧义，照旧直接套 */
  if (target === 'sd') return `(${adapted}:${label})`;
  if (INLINE_NAI_WEIGHT.test(adapted)) return nestNaiWeight(adapted, weight);
  return `${label}::${adapted}::`;
}

/* 正向 = 词条正向 + 各角色词的**正向**（与 copy.js 的 entryPromptText 同一套规则）。
   ⚠ 负向**只取词条级** negative，角色级负面绝不并进来：NAI 里那是按角色分槽填的，
   把几条词条的角色 uc 揉成一个全局 uc 会过度压制画面。想精确填槽的走灯箱。
   （这是 docs/decisions/Tag中转站.md 的明文约束，要改先去改文档。） */
function itemPrompt(item, channel) {
  if (channel === 'negative') return cleanPrompt(item.negative);
  const parts = [item.prompt];
  for (const character of item.characterPrompts || []) parts.push(character.prompt);
  return parts.map(cleanPrompt).filter(Boolean).join(',\n');
}

/** 这个块带没带角色级负面——界面据此提示「未并入」，别让它悄无声息地消失 */
export function itemHasCharacterNegative(item) {
  return (item?.characterPrompts || []).some(character => String(character?.negative || '').trim());
}

/* 去重默认开着：源串里同一个 tag 出现两次多半是整理时的手滑，帮用户合掉是服务。
   但合掉了必须说出来——`merged` 把合并了哪几条、各丢了几次一并带出去，界面显示成「已合并 N 条重复」。
   透明比给一个开关便宜：用户不用做选择，也不会某天疑惑「我明明加了两条怎么少了」。 */
export function compilePlanChannel(plan, channel, options = {}) {
  if (!plan || !['positive', 'negative'].includes(channel)) return { text: '', tokens: [], merged: [] };
  let tokens = [];
  for (const item of plan.items || []) {
    if (item.enabled === false) continue;
    /* ⚠ 负向通道**也**吃块权重，这是有意的：块权重表达的是「这一整块的存在感」，
       拉低它意味着连同这块的负面约束一起放松，而不是只削弱正向。
       看起来像 bug（用户想少一点某个概念，结果负面也被削弱），但拆成两个权重会
       让界面多出一根谁也说不清语义的滑块。测试里有断言锁住现状，要改先改这条注释。 */
    const compiled = compileRelayBlock(itemPrompt(item, channel), {
      target: options.target,
      weight: item.weight,
    });
    if (compiled) tokens.push(...splitTopLevel(compiled));
  }
  const merged = [];
  if (options.dedupe !== false) {
    const seen = new Map();
    const kept = [];
    for (const token of tokens) {
      /* 内部空白也要压平：`soft  light` 和 `soft light` 对 NAI 是同一个 tag，
         不合并的话「已合并 N 条」会漏报。
         ⚠ 只压空白和大小写：`(cat:1.2)` 与 `(CAT:1.2)` 该合，`1.2::cat::` 与 `cat` 不该合
         （权重不同就是两个不同的意思），别把归一化做过头。 */
      const key = token.trim().replace(/\s+/g, ' ').toLowerCase();
      const hit = seen.get(key);
      if (hit) {
        hit.dropped += 1;
        continue;
      }
      seen.set(key, { token, dropped: 0 });
      kept.push(token);
    }
    for (const record of seen.values()) {
      if (record.dropped) merged.push({ token: record.token, dropped: record.dropped });
    }
    tokens = kept;
  }
  return { text: tokens.join(',\n'), tokens, merged };
}

export function mergedTotal(merged) {
  return (merged || []).reduce((sum, record) => sum + (Number(record?.dropped) || 0), 0);
}

export function compilePlan(stateOrPlan, options = {}) {
  const isPlan = Array.isArray(stateOrPlan?.items);
  const plan = isPlan ? stateOrPlan : getPlan(stateOrPlan, options.planId ?? stateOrPlan?.activePlanId);
  const target = normalizeTarget(options.target);
  const positive = compilePlanChannel(plan, 'positive', { ...options, target });
  const negative = compilePlanChannel(plan, 'negative', { ...options, target });
  return {
    planId: plan?.id || '',
    target,
    positive: positive.text,
    negative: negative.text,
    positiveTokens: positive.tokens,
    negativeTokens: negative.tokens,
    positiveCount: positive.tokens.length,
    negativeCount: negative.tokens.length,
    positiveMerged: positive.merged,
    negativeMerged: negative.merged,
    positiveMergedCount: mergedTotal(positive.merged),
    negativeMergedCount: mergedTotal(negative.merged),
  };
}

export function recordCopyHistory(state, details = {}, options = {}) {
  if (!Array.isArray(state.history)) state.history = [];
  /* 调用方可以传入已经过权限过滤的 plan 快照。复制历史必须反映“实际写进
     剪贴板的内容”，而不是从活方案重新取一份可能含当前已锁内容的副本。 */
  const plan = isObject(details.plan)
    ? normalizePlan(details.plan, { now: nowIso(options) })
    : getPlan(state, details.planId ?? state.activePlanId);
  if (!plan) return null;
  const target = normalizeTarget(details.target);
  const compiled = isObject(details.output)
    ? details.output
    : compilePlan(plan, { target, dedupe: details.dedupe });
  const channel = ['positive', 'negative', 'both'].includes(details.channel)
    ? details.channel
    : 'both';
  const planSnapshot = normalizePlan(plan, { now: nowIso(options) });
  const record = normalizeHistoryRecord({
    id: uniqueId(state.history, options.id, 'copy'),
    label: details.label || plan.name,
    planId: plan.id,
    planName: plan.name,
    target,
    joinMode: details.joinMode,
    channel,
    positive: compiled.positive,
    negative: compiled.negative,
    positiveCount: compiled.positiveCount,
    negativeCount: compiled.negativeCount,
    plan: planSnapshot,
    snapshotComplete: true,
    createdAt: nowIso(options),
  }, options);
  state.history.unshift(record);
  state.history.splice(resolveHistoryLimit(options.historyLimit ?? options.limit));
  return record;
}

export function clearCopyHistory(state) {
  const removed = Array.isArray(state.history) ? state.history.length : 0;
  state.history = [];
  return removed;
}

/** Restoring never overwrites current work: it creates and activates a new plan. */
export function restoreHistoryAsPlan(state, historyId, options = {}) {
  const record = state.history?.find(item => item.id === historyId);
  if (!record?.plan || record.snapshotComplete !== true) return null;
  /* 分级把关不能只靠调用方自觉：任一项被判定为锁定就整条拒绝恢复，别把一半内容放进新方案。
     ⚠ core 层不许 import state/access（它要能零 DOM 直测），所以谓词只能由调用方注入。 */
  if (typeof options.isLocked === 'function'
    && (record.plan.items || []).some(item => Boolean(options.isLocked(item)))) return null;
  if (!Array.isArray(state.plans)) state.plans = [];
  const now = nowIso(options);
  const plan = normalizePlan({
    ...record.plan,
    id: uniqueId(state.plans, options.id, 'plan'),
    name: text(options.name, `${record.planName || record.label}（恢复）`),
    createdAt: now,
    updatedAt: now,
  }, { now });
  state.plans.push(plan);
  state.activePlanId = plan.id;
  return plan;
}
