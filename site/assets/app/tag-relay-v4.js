/* 文本方案的唯一持久化模型。旧 core 只负责来源快照及 v1–v3 迁移基线。 */
import * as legacy from './tag-relay-core.js';
import { ZW, OFF_OPEN, OFF_CLOSE, foldRanges, tokens, scrub, analyzeOutput } from './tag-relay-text.js';

export { RelayDataError, TAG_RELAY_INBOX_LIMIT, TAG_RELAY_HISTORY_LIMIT, TAG_RELAY_TARGETS,
  stableEntryKey, stableFragmentKey, normalizeRelayEntry, touchInboxEntry, removeInboxEntry,
  clearInbox, cleanPrompt, splitTopLevel, mergedTotal } from './tag-relay-core.js';
export const TAG_RELAY_STORAGE_KEY = 'fadian-tag-relay-v4';
export const TAG_RELAY_LEGACY_STORAGE_KEY = 'fadian-tag-relay-v3';
export const TAG_RELAY_OLDER_STORAGE_KEY = 'fadian-tag-relay-v1';
export const TAG_RELAY_LEGACY_STORAGE_KEYS = Object.freeze([TAG_RELAY_LEGACY_STORAGE_KEY, TAG_RELAY_OLDER_STORAGE_KEY]);
export const TAG_RELAY_SCHEMA_VERSION = 4;
const CHANNELS = ['positive', 'negative'];
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const raw = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const text = (value, fallback = '') => raw(value).trim() || fallback;
const now = options => {
  const value = typeof options?.now === 'function' ? options.now() : options?.now;
  return value && !Number.isNaN(Date.parse(value)) ? String(value) : new Date().toISOString();
};
const stamp = (value, fallback) => value && !Number.isNaN(Date.parse(value)) ? String(value) : fallback;
const clone = value => JSON.parse(JSON.stringify(value));
const targetOf = value => legacy.TAG_RELAY_TARGETS.includes(value) ? value : 'nai';
const historyLimit = value => Number.isFinite(Number.parseInt(value, 10))
  ? Math.max(1, Number.parseInt(value, 10)) : legacy.TAG_RELAY_HISTORY_LIMIT;
function uniqueId(values, requested, prefix) {
  const used = new Set(values.map(value => value.id));
  const base = text(requested) || `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
  let id = base, index = 2;
  while (used.has(id)) id = `${base}-${index++}`;
  return id;
}
export function uniqueFoldName(folds, requested = '词组') {
  const has = key => folds instanceof Map ? folds.has(key) : Object.hasOwn(folds, key);
  const base = scrub(requested).replace(/#/g, '').trim() || '词组';
  let name = base, index = 2;
  while (has(name)) name = `${base} ${index++}`;
  return name;
}
export function normalizeFold(source = {}, options = {}) {
  const entry = legacy.normalizeRelayEntry(source, options);
  return { ...entry, body: raw(source.body),
    kind: source.kind === 'block' ? 'block' : 'entry',
    ...(source.rating !== undefined ? { rating: raw(source.rating) } : {}),
    ...(source.level !== undefined ? { level: raw(source.level) } : {}),
    characters: clone(Array.isArray(source.characters) ? source.characters : source.characterPrompts || []),
    ...(Array.isArray(source.parts) ? { parts: clone(source.parts) } : {}),
  };
}
/* 只在存储边界回收。编辑器保留未引用条目，供展开撤销及“折叠回”使用。 */
export function normalizeChannel(source = {}, options = {}) {
  if (!object(source)) source = {};
  let value = raw(source.text);
  const entries = source.folds instanceof Map ? [...source.folds] : Object.entries(object(source.folds) ? source.folds : {});
  const folds = {}, renamed = new Map();
  for (const [key, item] of entries) {
    if (!object(item)) continue;
    const name = uniqueFoldName(folds, key);
    Object.defineProperty(folds, name, { value: normalizeFold(item, options), enumerable: true, writable: true, configurable: true });
    renamed.set(key, name);
  }
  const used = new Set();
  for (const range of foldRanges(value).reverse()) {
    const name = renamed.get(range.name);
    if (name) used.add(name);
    const replacement = name ? `${ZW}#${name}${ZW}` : `#${scrub(range.name).replace(/#/g, '')}`;
    value = value.slice(0, range.start) + replacement + value.slice(range.end);
  }
  if (options.gc !== false) for (const name of Object.keys(folds)) if (!used.has(name)) delete folds[name];
  const compatibility = (Array.isArray(source.legacySegments) ? source.legacySegments : []).filter(item => (
    object(item) && Number.isInteger(item.start) && Number.isInteger(item.end)
    && item.start >= 0 && item.end > item.start && item.end <= value.length
    && typeof item.source === 'string' && value.slice(item.start, item.end) === item.source
    && (typeof item.body === 'string' || typeof item.fold === 'string') && Number.isFinite(item.weight)
    && item.source === migrationSource(item.fold ? `${ZW}#${item.fold}${ZW}` : item.body, item.weight, item.enabled)
  )).map(item => ({ start: item.start, end: item.end, source: item.source,
    ...(item.fold ? { fold: item.fold } : { body: item.body }), weight: item.weight, enabled: item.enabled !== false }));
  return { text: value, folds, ...(compatibility.length ? { legacySegments: compatibility } : {}) };
}
export function normalizePlan(source = {}, options = {}) {
  if (!object(source)) source = {};
  const time = now(options);
  return { id: text(source.id) || uniqueId([], '', 'plan'), name: text(source.name ?? source.title, '新方案'),
    revision: Math.max(0, Number.parseInt(source.revision ?? source.rev, 10) || 0),
    dedupe: source.dedupe !== false,
    positive: normalizeChannel(source.positive, options), negative: normalizeChannel(source.negative, options),
    createdAt: stamp(source.createdAt, time), updatedAt: stamp(source.updatedAt, time) };
}
export function createRelayState(options = {}) {
  const plan = normalizePlan({ id: options.planId || 'plan-default', name: options.planName }, options);
  return { version: 4, inbox: [], plans: [plan], activePlanId: plan.id, history: [] };
}
export function getPlan(state, id = state?.activePlanId) { return state?.plans?.find(plan => plan.id === id) || null; }
export function getActivePlan(state) { return getPlan(state) || state?.plans?.[0] || null; }
function touchPlan(plan, options) { plan.revision += 1; plan.updatedAt = now(options); }
export function createPlan(state, name = '新方案', options = {}) {
  const plan = normalizePlan({ id: uniqueId(state.plans, options.id, 'plan'), name }, options);
  state.plans.push(plan);
  if (options.activate !== false || !state.activePlanId) state.activePlanId = plan.id;
  return plan;
}
export function copyPlan(state, id, options = {}) {
  const source = getPlan(state, id);
  if (!source) return null;
  const time = now(options);
  const plan = normalizePlan({ ...source, id: uniqueId(state.plans, options.id, 'plan'),
    name: text(options.name, `${source.name}（副本）`), revision: 0, createdAt: time, updatedAt: time }, options);
  state.plans.push(plan);
  if (options.activate !== false) state.activePlanId = plan.id;
  return plan;
}
export const duplicatePlan = copyPlan;
export function renamePlan(state, id, name, options = {}) {
  const plan = getPlan(state, id);
  if (!plan || !text(name)) return null;
  plan.name = text(name); touchPlan(plan, options); return plan;
}
export function setActivePlan(state, id) {
  if (!getPlan(state, id)) return false;
  state.activePlanId = id; return true;
}
export function deletePlan(state, id, options = {}) {
  const index = state.plans.findIndex(plan => plan.id === id);
  if (index < 0) return null;
  const [removed] = state.plans.splice(index, 1);
  if (!state.plans.length) createPlan(state, options.replacementName, { ...options, id: options.replacementId || 'plan-default' });
  else if (state.activePlanId === id) state.activePlanId = state.plans[Math.min(index, state.plans.length - 1)].id;
  return removed;
}
export function replacePlanText(state, id, session, options = {}) {
  const plan = getPlan(state, id);
  if (!plan) return { ok: false, reason: 'missing-plan' };
  if (options.expectedRevision !== undefined && plan.revision !== options.expectedRevision) return { ok: false, reason: 'conflict' };
  const snapshot = planForSession(plan, session, options);
  for (const channel of CHANNELS) plan[channel] = snapshot[channel];
  plan.dedupe = snapshot.dedupe;
  touchPlan(plan, options);
  return { ok: true, plan };
}
export function planForSession(plan, session, options = {}) {
  const snapshot = { ...plan, dedupe: session.dedupe !== false };
  for (const channel of CHANNELS) {
    const source = session[channel] || {};
    snapshot[channel] = normalizeChannel({ ...source,
      legacySegments: source.legacySegments || rebaseLegacySegments(plan?.[channel], raw(source.text)),
    }, options);
  }
  return snapshot;
}

/* 旧 tag/text 的外置权重在纯文本导出时不生效，正文里自带的权重却要保留。
   仅记录迁移时的语法边界；正文仍只以 text 为准。编辑命中的边界立即失效，
   其它边界按同一次替换平移，避免把未改动的旧语义随任意输入一起抹掉。 */
function rebaseLegacySegments(channel, nextText) {
  const previous = channel?.text || '', records = channel?.legacySegments || [];
  if (previous === nextText) return records;
  let prefix = 0, suffix = 0;
  while (prefix < previous.length && prefix < nextText.length && previous[prefix] === nextText[prefix]) prefix += 1;
  while (suffix < previous.length - prefix && suffix < nextText.length - prefix
    && previous[previous.length - suffix - 1] === nextText[nextText.length - suffix - 1]) suffix += 1;
  const oldEnd = previous.length - suffix, difference = nextText.length - previous.length;
  return records.flatMap(item => item.end <= prefix ? [item]
    : item.start >= oldEnd ? [{ ...item, start: item.start + difference, end: item.end + difference }] : []);
}
export function setPlanDedupe(state, id, enabled, options = {}) {
  const plan = getPlan(state, id);
  if (!plan) return null;
  plan.dedupe = enabled === true; touchPlan(plan, options); return plan;
}

/* 原节点边界只用于无损迁移；当前文本统一由 textarea 的同一解析器解释。 */
function compilationParts(value, compatibility = []) {
  const protectedParts = [], legacyParts = new Map();
  let masked = String(value || '');
  let marker = '\ue000';
  while (masked.includes(marker)) marker += '\ue000';
  const protect = (range, body, record) => {
    const key = `${marker}${protectedParts.length}\ue001`;
    protectedParts.push(body);
    if (record) legacyParts.set(key, record);
    masked = masked.slice(0, range.start) + key + masked.slice(range.end);
  };
  for (const item of [...compatibility].sort((a, b) => b.start - a.start)) {
    if (String(value).slice(item.start, item.end) === item.source) protect(item, item.source, item);
  }
  return tokens(masked).map(token => {
    const part = token.core;
    const record = legacyParts.get(part);
    const restored = part.replace(new RegExp(`${marker}(\\d+)\ue001`, 'g'), (_, index) => protectedParts[Number(index)]);
    return { raw: restored, record };
  });
}
export function compilePlanChannel(plan, channel, options = {}) {
  const value = plan?.[channel];
  if (!value || !CHANNELS.includes(channel)) return { text: '', tokens: [], merged: [], count: 0 };
  const folds = value.folds instanceof Map ? value.folds : new Map(Object.entries(value.folds || {}));
  const target = targetOf(options.target), isLocked = options.isLocked || (() => false);
  const dedupe = (options.dedupe ?? plan.dedupe ?? true) === true, localMerged = [];
  let output = [];
  for (const { raw: part, record } of compilationParts(value.text, value.legacySegments)) {
    if (record) {
      const source = record.fold ? folds.get(record.fold) : null;
      if (record.enabled && (!record.fold || source && !isLocked(source))) {
        output.push(...legacy.splitTopLevel(legacy.compileRelayBlock(source ? source.body : record.body, { target, weight: record.weight })));
      }
      continue;
    }
    const compiled = analyzeOutput(part, folds, { target, dedupe, isLocked });
    output.push(...compiled.tokens); localMerged.push(...compiled.merged);
  }
  const merged = [];
  if (dedupe) {
    const seen = new Map(), kept = [];
    for (const token of output) {
      const key = token.trim().replace(/\s+/g, ' ').toLowerCase(), previous = seen.get(key);
      if (previous) previous.dropped += 1;
      else { seen.set(key, { token, dropped: 0 }); kept.push(token); }
    }
    output = kept;
    for (const item of localMerged) {
      const key = item.token.trim().replace(/\s+/g, ' ').toLowerCase(), found = seen.get(key);
      if (found) found.dropped += item.dropped;
      else seen.set(key, { ...item });
    }
    for (const item of seen.values()) if (item.dropped) merged.push(item);
  }
  const separator = options.joinMode === 'comma' || options.join === 'comma' ? ', ' : ',\n';
  return { text: output.join(separator), tokens: output, merged, count: output.length };
}
export function compilePlan(stateOrPlan, options = {}) {
  const plan = object(stateOrPlan?.positive) ? stateOrPlan : getPlan(stateOrPlan, options.planId ?? stateOrPlan?.activePlanId);
  const target = targetOf(options.target);
  const positive = compilePlanChannel(plan, 'positive', { ...options, target });
  const negative = compilePlanChannel(plan, 'negative', { ...options, target });
  return { planId: plan?.id || '', target, positive: positive.text, negative: negative.text,
    positiveTokens: positive.tokens, negativeTokens: negative.tokens,
    positiveCount: positive.count, negativeCount: negative.count,
    positiveMerged: positive.merged, negativeMerged: negative.merged,
    positiveMergedCount: legacy.mergedTotal(positive.merged), negativeMergedCount: legacy.mergedTotal(negative.merged) };
}

function migrationSource(body, weight, enabled) {
  let result = body;
  if (weight !== 1) result = `${Number(weight.toFixed(3))}::${result}::`;
  return enabled === false ? `${OFF_OPEN}${result}${OFF_CLOSE}` : result;
}
function migratePlan(source, options) {
  const plan = normalizePlan({ ...source, positive: {}, negative: {} }, options);
  for (const item of source.items) {
    const channel = item.channel === 'negative' ? 'negative' : 'positive';
    const value = plan[channel], body = legacy.planItemPrompt(item);
    let part = body, foldName = '';
    if (item.nodeType === 'group') {
      const name = uniqueFoldName(value.folds, item.title);
      Object.defineProperty(value.folds, name, { value: normalizeFold({ ...item, body, characters: item.characterPrompts }, options),
        enumerable: true, writable: true, configurable: true });
      part = `${ZW}#${name}${ZW}`;
      foldName = name;
    }
    part = migrationSource(part, item.weight, item.enabled);
    if (part) {
      const start = value.text.length + (value.text ? 2 : 0);
      value.text += `${value.text ? ', ' : ''}${part}`;
      (value.legacySegments ||= []).push({ start, end: value.text.length, source: part,
        ...(foldName ? { fold: foldName } : { body }), weight: item.weight, enabled: item.enabled !== false });
    }
  }
  return plan;
}
function assertMigratedOutput(before, after) {
  for (const target of legacy.TAG_RELAY_TARGETS) for (const joinMode of ['comma', 'newline']) {
    const expected = legacy.compilePlan(before, { target });
    const separator = joinMode === 'comma' ? ', ' : ',\n';
    const actual = compilePlan(after, { target, joinMode });
    if (expected.positiveTokens.join(separator) !== actual.positive || expected.negativeTokens.join(separator) !== actual.negative) {
      throw new legacy.RelayDataError('migration-mismatch', '旧方案无法无损转换，原始数据已保留，请导出备份后重试');
    }
  }
}
export function migrateRelayState(rawState, options = {}) {
  const old = legacy.normalizeRelayState(rawState, options);
  const plans = old.plans.map(plan => {
    const migrated = migratePlan(plan, options); assertMigratedOutput(plan, migrated); return migrated;
  });
  const history = old.history.map(record => {
    const plan = migratePlan(record.plan, options); assertMigratedOutput(record.plan, plan);
    return { ...record, plan, snapshotComplete: record.snapshotComplete === true
      && (!record.positive.trim() || Boolean(plan.positive.text.trim()))
      && (!record.negative.trim() || Boolean(plan.negative.text.trim())) };
  });
  return { ...old, version: 4, plans, history };
}
function normalizeHistory(source, options) {
  const plan = normalizePlan(source.plan, options);
  const positive = raw(source.positive), negative = raw(source.negative);
  const number = (value, output) => Number.isFinite(Number.parseInt(value, 10))
    ? Math.max(0, Number.parseInt(value, 10)) : legacy.splitTopLevel(output).length;
  const verified = CHANNELS.every(channel => object(source.plan?.[channel])
    && Object.values(source.plan[channel].folds || {}).every(fold => object(fold.access)
      && typeof fold.access.nsfw === 'boolean' && typeof fold.access.r18g === 'boolean'));
  return { id: text(source.id) || uniqueId([], '', 'copy'), label: text(source.label, plan.name),
    planId: text(source.planId, plan.id), planName: text(source.planName, plan.name),
    target: targetOf(source.target), joinMode: source.joinMode === 'newline' ? 'newline' : 'comma',
    channel: ['positive', 'negative', 'both'].includes(source.channel) ? source.channel : 'both',
    positive, negative, positiveCount: number(source.positiveCount, positive), negativeCount: number(source.negativeCount, negative),
    plan, snapshotComplete: source.snapshotComplete === true && verified
      && (!positive.trim() || Boolean(plan.positive.text.trim()))
      && (!negative.trim() || Boolean(plan.negative.text.trim())), createdAt: stamp(source.createdAt, now(options)) };
}
export function normalizeRelayState(source, options = {}) {
  if (!object(source)) return createRelayState(options);
  if (Number(source.version) > 4) throw new legacy.RelayDataError('future-version', '中转站数据来自更新版本，请更新页面后重试');
  if (Number(source.version) !== 4) return migrateRelayState(source, options);
  const plans = [];
  for (const item of Array.isArray(source.plans) ? source.plans : []) {
    const plan = normalizePlan(item, options);
    plan.id = uniqueId(plans, plan.id, 'plan'); plans.push(plan);
  }
  if (!plans.length) plans.push(createRelayState(options).plans[0]);
  const inbox = legacy.normalizeRelayState({ version: 3, inbox: source.inbox, plans: [], history: [] }, options).inbox;
  return { version: 4, inbox, plans,
    activePlanId: plans.some(plan => plan.id === source.activePlanId) ? source.activePlanId : plans[0].id,
    history: (Array.isArray(source.history) ? source.history : []).filter(object).map(record => normalizeHistory(record, options)).slice(0, historyLimit(options.historyLimit)) };
}
export function serializeRelayState(state, options = {}) { return JSON.stringify(normalizeRelayState(state, options)); }
function parseStoredState(payload, options = {}) {
  let source;
  try { source = JSON.parse(payload); } catch { throw new legacy.RelayDataError('corrupt-data', '中转站数据损坏，原始内容已保留'); }
  if (Number(source?.version) > 4) throw new legacy.RelayDataError('future-version', '中转站数据来自更新版本，请更新页面后重试');
  const validChannel = value => object(value) && typeof value.text === 'string' && object(value.folds)
    && Object.values(value.folds).every(fold => object(fold) && typeof fold.body === 'string');
  if (!object(source) || !Array.isArray(source.plans)
    || source.plans.some(plan => !object(plan) || (Number(source.version) === 4
      ? !CHANNELS.every(channel => validChannel(plan[channel])) : !Array.isArray(plan.items) || plan.items.some(item => !object(item))))
    || (source.inbox !== undefined && !Array.isArray(source.inbox))
    || (source.history !== undefined && !Array.isArray(source.history))) {
    throw new legacy.RelayDataError('corrupt-data', '中转站数据结构不完整，原始内容已保留');
  }
  return normalizeRelayState(source, options);
}
export function loadRelayStateStatus(storage = globalThis.localStorage, options = {}) {
  try {
    for (const key of options.key ? [options.key] : [TAG_RELAY_STORAGE_KEY, ...TAG_RELAY_LEGACY_STORAGE_KEYS]) {
      const payload = storage?.getItem?.(key);
      if (payload !== null && payload !== undefined) return { ok: true, state: parseStoredState(payload, options),
        migrated: !options.key && key !== TAG_RELAY_STORAGE_KEY, sourceKey: key };
    }
    return { ok: true, state: createRelayState(options), migrated: false, sourceKey: '' };
  } catch (error) { return { ok: false, state: createRelayState(options), reason: error.reason || 'storage', error }; }
}
export function loadRelayState(storage = globalThis.localStorage, options = {}) { return loadRelayStateStatus(storage, options).state; }
export function saveRelayState(state, storage = globalThis.localStorage, options = {}) {
  try {
    if (!loadRelayStateStatus(storage, options).ok) return false;
    const key = options.key || TAG_RELAY_STORAGE_KEY, payload = serializeRelayState(state, options);
    storage?.setItem?.(key, payload); return storage?.getItem?.(key) === payload;
  } catch { return false; }
}
export function trimStateToBudget(state, maxChars, options = {}) {
  const budget = Number(maxChars);
  if (!object(state) || !Number.isFinite(budget)) return { trimmed: 0, fits: true };
  let trimmed = 0;
  while (serializeRelayState(state, options).length > budget && state.history.length) { state.history.pop(); trimmed += 1; }
  return { trimmed, fits: serializeRelayState(state, options).length <= budget };
}
export function recordCopyHistory(state, details = {}, options = {}) {
  const plan = object(details.plan) ? normalizePlan(details.plan, options) : getPlan(state, details.planId ?? state.activePlanId);
  if (!plan) return null;
  const output = details.output || compilePlan(plan, details);
  const record = normalizeHistory({ ...details, ...output, id: uniqueId(state.history, options.id, 'copy'),
    label: details.label || plan.name, planId: plan.id, planName: plan.name, plan,
    snapshotComplete: true, createdAt: now(options) }, options);
  state.history.unshift(record); state.history.splice(historyLimit(options.historyLimit ?? options.limit)); return record;
}
export function clearCopyHistory(state) { const count = state.history.length; state.history = []; return count; }
export function planFolds(plan) { return CHANNELS.flatMap(channel => {
  const folds = plan?.[channel]?.folds;
  return folds instanceof Map ? [...folds.values()] : Object.values(folds || {});
}); }
export function restoreHistoryAsPlan(state, id, options = {}) {
  const record = state.history.find(item => item.id === id);
  if (!record?.snapshotComplete || !record.plan || (options.isLocked && planFolds(record.plan).some(options.isLocked))) return null;
  const time = now(options);
  const plan = normalizePlan({ ...record.plan, id: uniqueId(state.plans, options.id, 'plan'),
    name: text(options.name, `${record.planName || record.label}（恢复）`), revision: 0, createdAt: time, updatedAt: time }, options);
  state.plans.push(plan); state.activePlanId = plan.id; return plan;
}
export function exportRelayBackup(state, options = {}) {
  return JSON.stringify({ format: 'fadian-tag-relay', version: 4, exportedAt: now(options), state: normalizeRelayState(state, options) }, null, 2);
}
export function validateRelayBackup(value) {
  let backup = value;
  if (typeof value === 'string') { try { backup = JSON.parse(value); } catch { throw new legacy.RelayDataError('invalid-backup', '文件不是有效的中转站 JSON 备份'); } }
  if (!object(backup) || backup.format !== 'fadian-tag-relay' || !object(backup.state)) throw new legacy.RelayDataError('invalid-backup', '请选择中转站导出的备份文件');
  if (Number(backup.version) > 4) throw new legacy.RelayDataError('future-version', '备份来自更新版本，请更新页面后恢复');
  try { return parseStoredState(JSON.stringify(backup.state)); } catch (error) {
    if (error.reason === 'future-version' || error.reason === 'migration-mismatch') throw error;
    throw new legacy.RelayDataError('invalid-backup', '备份结构不完整，现有方案保持原样');
  }
}
export function importRelayBackup(state, value, options = {}) {
  const imported = validateRelayBackup(value), plans = [];
  for (const source of imported.plans) {
    const time = now(options);
    const plan = normalizePlan({ ...source, id: uniqueId(state.plans, '', 'plan'), name: `${source.name}（恢复）`,
      revision: 0, createdAt: time, updatedAt: time }, options);
    state.plans.push(plan); plans.push(plan);
  }
  if (plans.length && options.activate !== false) state.activePlanId = plans[0].id;
  const inboxKeys = new Set();
  for (const entry of [...imported.inbox].reverse()) if (!state.inbox.some(item => item.key === entry.key)) {
    state.inbox.unshift(entry); inboxKeys.add(entry.key);
  }
  state.inbox.splice(legacy.TAG_RELAY_INBOX_LIMIT);
  const historyIds = new Set();
  for (const record of imported.history) {
    const id = uniqueId(state.history, '', 'copy'); state.history.push({ ...record, id }); historyIds.add(id);
  }
  state.history.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  state.history.splice(legacy.TAG_RELAY_HISTORY_LIMIT);
  const inboxCount = state.inbox.filter(item => inboxKeys.has(item.key)).length;
  const historyCount = state.history.filter(item => historyIds.has(item.id)).length;
  return { plans, planCount: plans.length, inboxCount, historyCount,
    droppedInboxCount: inboxKeys.size - inboxCount, droppedHistoryCount: historyIds.size - historyCount };
}
