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
  if (Array.isArray(value)) return value.map(item => text(item)).filter(Boolean);
  return text(value);
}

function normalizeAccess(value, source = {}) {
  const access = isObject(value) ? value : {};
  return {
    nsfw: access.nsfw === true || source.nsfw === true || source.sourceNsfw === true,
    r18g: access.r18g === true || source.r18g === true || source.sourceR18g === true,
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
    text(source.title),
    text(source.prompt ?? source.positive ?? source.tags),
    text(source.negative),
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
    addedAt: timestamp(source.addedAt, fallbackNow),
  };
}

function normalizeWeight(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
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
    path: kind === 'entry' ? normalizePath(source.path ?? entry.path) : '',
    image: kind === 'entry' ? text(source.image, entry.image) : '',
    access: kind === 'entry'
      ? normalizeAccess(source.access, entry.access)
      : normalizeAccess(source.access, source),
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

function normalizeHistoryRecord(record, context = {}) {
  const source = isObject(record) ? record : {};
  const fallbackNow = nowIso(context);
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
    positiveCount: Math.max(0, Number.parseInt(source.positiveCount, 10) || splitTopLevel(positive).length),
    negativeCount: Math.max(0, Number.parseInt(source.negativeCount, 10) || splitTopLevel(negative).length),
    plan,
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
     否则老数据升上来会把最旧那条钉在「最近复制」顶上，直到它被挤掉。 */
  const legacyInboxOrder = Number(raw.version) < 2;
  const rawInbox = raw.inbox ?? raw.staged ?? raw.entries;
  for (const item of Array.isArray(rawInbox) ? rawInbox : []) {
    if (!isObject(item)) continue;
    const entry = normalizeRelayEntry(item, { now });
    if (inboxKeys.has(entry.key)) continue;
    inboxKeys.add(entry.key);
    inbox.push(entry);
  }

  if (legacyInboxOrder) inbox.reverse();
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
  const limit = Math.max(1, Number.parseInt(options.historyLimit, 10) || TAG_RELAY_HISTORY_LIMIT);
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
  if (Object.hasOwn(patch, 'title')) item.title = text(patch.title, item.title);
  if (Object.hasOwn(patch, 'prompt') || Object.hasOwn(patch, 'positive')) {
    item.prompt = text(patch.prompt ?? patch.positive);
  }
  if (Object.hasOwn(patch, 'negative')) item.negative = text(patch.negative);
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
  const target = Math.min(plan.items.length - 1, Math.max(0, Number.parseInt(toIndex, 10) || 0));
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

export function cleanPrompt(value) {
  return text(value).replace(/[\s,，]+$/, '').trim();
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
        part += pair;
        index += 1;
        continue;
      }
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
  if (target === 'plain' || weight === 1) return adapted;
  if (target === 'sd') return `(${adapted}:${formatWeight(weight)})`;
  return `${formatWeight(weight)}::${adapted}::`;
}

function itemPrompt(item, channel) {
  const parts = [channel === 'negative' ? item.negative : item.prompt];
  for (const character of item.characterPrompts || []) {
    parts.push(channel === 'negative' ? character.negative : character.prompt);
  }
  return parts.map(cleanPrompt).filter(Boolean).join(',\n');
}

/* 去重默认开着：源串里同一个 tag 出现两次多半是整理时的手滑，帮用户合掉是服务。
   但合掉了必须说出来——`merged` 把合并了哪几条、各丢了几次一并带出去，界面显示成「已合并 N 条重复」。
   透明比给一个开关便宜：用户不用做选择，也不会某天疑惑「我明明加了两条怎么少了」。 */
export function compilePlanChannel(plan, channel, options = {}) {
  if (!plan || !['positive', 'negative'].includes(channel)) return { text: '', tokens: [], merged: [] };
  let tokens = [];
  for (const item of plan.items || []) {
    if (item.enabled === false) continue;
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
      const key = token.trim().toLowerCase();
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
  const plan = getPlan(state, details.planId ?? state.activePlanId);
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
    createdAt: nowIso(options),
  }, options);
  state.history.unshift(record);
  const limit = Math.max(1, Number.parseInt(options.limit, 10) || TAG_RELAY_HISTORY_LIMIT);
  state.history.splice(limit);
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
  if (!record?.plan) return null;
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
