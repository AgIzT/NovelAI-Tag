import assert from 'node:assert/strict';
import {
  TAG_RELAY_STORAGE_KEY, TAG_RELAY_LEGACY_STORAGE_KEY, createRelayState, normalizeRelayState,
  serializeRelayState, loadRelayStateStatus, saveRelayState, getActivePlan, appendEntryToPlan,
  insertPlanNode, replacePlanItems, updatePlanItem, compilePlan, planItemPrompt, stableFragmentKey,
  touchInboxEntry, recordCopyHistory, restoreHistoryAsPlan, exportRelayBackup, importRelayBackup,
  validateRelayBackup, movePlanItem, removePlanItem, restorePlanItem,
} from '../site/assets/app/tag-relay-core.js';

const now = '2026-09-20T00:00:00.000Z';
const options = { now };
const access = { nsfw: false, r18g: false };
const source = {
  codexId: 'outdoors', entryId: 'equipment', title: 'Hiking equipment',
  prompt: 'backpack, gloves', negative: 'blur', access, accessKnown: true,
  characterPrompts: [{ label: 'guide', prompt: 'beanie', negative: 'closed eyes' }],
};
function memoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return { getItem: key => entries.has(key) ? entries.get(key) : null,
    setItem: (key, value) => entries.set(key, String(value)), removeItem: key => entries.delete(key) };
}

// Legacy plans and history retain effective output and original copied text.
const oldPlan = { id: 'old-plan', name: 'Old', revision: 4, items: [
  { ...source, id: 'old-slot', kind: 'entry', weight: 1.2, enabled: true },
  { id: 'manual', kind: 'block', prompt: 'forest, forest', negative: 'fog', enabled: true, access },
  { id: 'disabled', kind: 'block', prompt: 'rain', enabled: false, access },
] };
const oldOutput = compilePlan(oldPlan);
const legacy = { version: 2, inbox: [source], plans: [oldPlan], activePlanId: 'old-plan', history: [{
  id: 'copy-old', plan: oldPlan, snapshotComplete: true, positive: '  original output\n',
  negative: 'blur', createdAt: now,
}] };
const migrated = normalizeRelayState(legacy, options);
assert.equal(migrated.version, 3);
assert.equal(migrated.plans[0].dedupe, true);
assert.equal(migrated.plans[0].items.length, 5);
assert.equal(migrated.plans[0].items[0].id, 'old-slot');
assert.equal(migrated.plans[0].items[1].linkedId, 'old-slot');
assert.equal(migrated.plans[0].items[1].channel, 'negative');
assert.equal(compilePlan(migrated).positive, oldOutput.positive);
assert.equal(compilePlan(migrated).negative, oldOutput.negative);
for (const target of ['nai', 'sd', 'plain']) {
  assert.equal(compilePlan(migrated, { target }).positive, compilePlan(oldPlan, { target }).positive);
  assert.equal(compilePlan(migrated, { target }).negative, compilePlan(oldPlan, { target }).negative);
}
assert.ok(!compilePlan(migrated).negative.includes('closed eyes'));
assert.equal(migrated.history[0].positive, '  original output\n');
assert.equal(migrated.history[0].plan.dedupe, true);
assert.equal(migrated.history[0].plan.items.length, 5);
assert.deepEqual(normalizeRelayState(migrated, options), migrated);

const legacyBytes = JSON.stringify(legacy);
const storage = memoryStorage({ [TAG_RELAY_LEGACY_STORAGE_KEY]: legacyBytes });
assert.equal(loadRelayStateStatus(storage, options).migrated, true);
assert.equal(saveRelayState(migrated, storage, options), true);
assert.equal(storage.getItem(TAG_RELAY_LEGACY_STORAGE_KEY), legacyBytes);
assert.equal(loadRelayStateStatus(storage, options).migrated, false);
for (const [raw, reason] of [['{broken', 'corrupt-data'], [JSON.stringify({ ...legacy, version: 99 }), 'future-version']]) {
  const guarded = memoryStorage({ [TAG_RELAY_STORAGE_KEY]: raw });
  assert.equal(loadRelayStateStatus(guarded, options).reason, reason);
  assert.equal(saveRelayState(createRelayState(options), guarded, options), false);
  assert.equal(guarded.getItem(TAG_RELAY_STORAGE_KEY), raw);
}

// Groups, tags and unfinished input share one ordered, persistable sequence.
const state = createRelayState(options);
const plan = getActivePlan(state);
assert.equal(plan.dedupe, false);
const literalState = createRelayState(options);
insertPlanNode(literalState, literalState.activePlanId, { nodeType: 'tag', prompt: 'label\\, variant' });
insertPlanNode(literalState, literalState.activePlanId, { nodeType: 'tag', prompt: '"blue sky, sunlight"' });
assert.deepEqual(compilePlan(literalState).positiveTokens, ['label\\, variant', '"blue sky, sunlight"']);
const added = appendEntryToPlan(state, plan.id, source, { ...options, id: 'equipment' });
assert.equal(added.items.length, 2);
assert.equal(added.items[0].channel, 'positive');
assert.equal(added.items[1].channel, 'negative');
const sky = insertPlanNode(state, plan.id, { nodeType: 'tag', prompt: 'blue sky' }, 1, options);
const draft = insertPlanNode(state, plan.id, { nodeType: 'text', prompt: ' soft lighting ' }, 2, options);
assert.equal(planItemPrompt(draft), ' soft lighting ');
assert.equal(compilePlan(state).positive, 'backpack,\ngloves,\nbeanie,\nblue sky,\nsoft lighting');
assert.equal(compilePlan(state).negative, 'blur');
assert.equal(normalizeRelayState(JSON.parse(serializeRelayState(state))).plans[0].items[2].prompt, ' soft lighting ');
assert.equal(appendEntryToPlan(state, plan.id, source, options).added, true);
assert.equal(compilePlan(state).positiveTokens.filter(value => value === 'backpack').length, 2);
assert.equal(appendEntryToPlan(state, plan.id, { ...source, channel: 'character-negative' }).reason, 'character-channel');

// Group parts replace that group's full channel, without duplicating characters.
updatePlanItem(state, plan.id, added.item.id, { parts: [
  { id: 'backpack', raw: 'backpack', enabled: false }, { id: 'gloves', raw: 'gloves' },
  { id: 'beanie', raw: 'beanie' },
], weight: 1.2 });
assert.equal(planItemPrompt(added.item), 'gloves, beanie');
assert.equal(compilePlan(state).positiveTokens[0], '1.2::gloves, beanie::');
assert.equal(compilePlan(state).positiveTokens[1], 'blue sky');
assert.equal(compilePlan(state, { target: 'sd' }).positiveTokens[0], '(gloves, beanie:1.2)');
assert.equal(compilePlan(state, { target: 'sd' }).positiveTokens[1], 'blue sky');
updatePlanItem(state, plan.id, added.item.id, { prompt: undefined });
assert.equal(added.item.parts.length, 3);
updatePlanItem(state, plan.id, added.item.id, { prompt: 'backpack' });
assert.equal(added.item.parts, undefined);

const staleRevision = plan.revision - 1;
const beforeConflict = serializeRelayState(state);
assert.equal(replacePlanItems(state, plan.id, [], { expectedRevision: staleRevision }).reason, 'conflict');
assert.equal(serializeRelayState(state), beforeConflict);
const undoItems = structuredClone(plan.items);
assert.equal(replacePlanItems(state, plan.id, [sky], { expectedRevision: plan.revision }).ok, true);
assert.equal(replacePlanItems(state, plan.id, undoItems, { expectedRevision: plan.revision }).ok, true);
assert.equal(movePlanItem(state, plan.id, sky.id, 0), true);
const removed = removePlanItem(state, plan.id, added.item.id);
assert.ok(restorePlanItem(state, plan.id, removed, 1));

// The same source may have distinct fragments and repeated plan instances.
const fragment = raw => ({ ...source, prompt: raw, negative: '', characterPrompts: [], channel: 'positive',
  fragmentKey: stableFragmentKey(source, { text: raw, channel: 'positive' }) });
touchInboxEntry(state, fragment('backpack'));
touchInboxEntry(state, fragment('gloves'));
touchInboxEntry(state, fragment('backpack'));
assert.equal(state.inbox.length, 2);
assert.equal(state.inbox[0].prompt, 'backpack');
assert.deepEqual(normalizeRelayState(state).inbox.map(item => item.key), state.inbox.map(item => item.key));

const history = recordCopyHistory(state, { planId: plan.id }, options);
const restored = restoreHistoryAsPlan(state, history.id, options);
assert.ok(restored.id !== plan.id);
assert.deepEqual(compilePlan(restored).positiveTokens, compilePlan(plan).positiveTokens);
const backup = exportRelayBackup(state, options);
assert.equal(validateRelayBackup(backup).plans.length, state.plans.length);
const destination = createRelayState(options);
const originalId = destination.activePlanId;
const imported = importRelayBackup(destination, backup, options);
assert.equal(imported.planCount, 2);
assert.equal(destination.plans[0].id, originalId);
assert.equal(destination.plans.length, 3);
assert.deepEqual(compilePlan(destination.plans[1]).positiveTokens, compilePlan(plan).positiveTokens);
const fullHistory = createRelayState(options);
for (let index = 0; index < 20; index += 1) {
  recordCopyHistory(fullHistory, {}, { now: '2026-09-21T00:00:00.000Z', id: `recent-${index}` });
}
const olderImport = importRelayBackup(fullHistory, backup, options);
assert.equal(olderImport.historyCount, 0);
assert.equal(olderImport.droppedHistoryCount, state.history.length);
assert.throws(() => validateRelayBackup('{}'), error => error.reason === 'invalid-backup');
assert.throws(() => validateRelayBackup(JSON.stringify({ format: 'fadian-tag-relay', version: 99, state })),
  error => error.reason === 'future-version');
// Store protection also applies to transaction entry and external-page updates.
const { TAG_RELAY_STORAGE_KEY: STORE_KEY, TAG_RELAY_LEGACY_STORAGE_KEY: STORE_LEGACY_KEY, replacePlanText } = await import('../site/assets/app/tag-relay-v4.js');
const storeLegacyBytes = serializeRelayState(migrated, options);
const previous = { localStorage: globalThis.localStorage, document: globalThis.document,
  window: globalThis.window, setTimeout: globalThis.setTimeout, warn: console.warn };
const handlers = new Map();
const events = [];
function fakeElement() {
  return { children: [], classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {},
    contains() { return false; }, focus() {}, blur() {}, querySelector() { return null; }, offsetWidth: 0 };
}
const toastElement = fakeElement();
let rejectWrites = false;
const transactionStorage = memoryStorage({ [STORE_LEGACY_KEY]: storeLegacyBytes });
const originalSet = transactionStorage.setItem;
transactionStorage.setItem = (key, value) => {
  if (rejectWrites && key === STORE_KEY) throw new Error('writing unavailable');
  originalSet(key, value);
};
globalThis.localStorage = transactionStorage;
globalThis.document = { querySelector: selector => selector === '#toast' ? toastElement : null,
  createElement: fakeElement, activeElement: null };
globalThis.window = { addEventListener: (type, handler) => handlers.set(type, handler), removeEventListener() {} };
globalThis.setTimeout = (fn, ms) => { const timer = previous.setTimeout(fn, ms); timer.unref?.(); return timer; };
console.warn = () => {};
try {
  const store = await import('../site/assets/app/tag-relay-store.js');
  const precise = store.prepareCopiedFragment({ id: 'gear', _srcCodexId: 'outdoors', title: 'Equipment',
    tags: '1.2::backpack, gloves::' }, { text: '{{gloves}}', channel: 'positive', scope: 'selection' });
  assert.equal(precise.prompt, '{{gloves}}');
  assert.equal(precise.negative, '');
  assert.deepEqual(precise.characterPrompts, []);
  assert.ok(precise.fragmentKey.startsWith(precise.sourceKey + ':fragment:'));
  const roleFragment = store.prepareCopiedFragment({ id: 'guide', _srcCodexId: 'outdoors', title: 'Guide', tags: 'beanie' },
    { text: 'closed eyes', channel: 'character-negative', characterIndex: 0 });
  assert.equal(roleFragment.prompt, '');
  assert.equal(roleFragment.negative, 'closed eyes');
  assert.equal(roleFragment.characterIndex, 0);
  store.subscribeRelay((_, meta) => events.push(meta));
  await store.setupRelayStore();
  assert.equal(store.relayState().plans[0].id, 'old-plan');
  assert.equal((await store.commitRelay(next => {
    const plan = next.plans.find(item => item.id === next.activePlanId);
    return replacePlanText(next, plan.id, { ...plan, positive: { ...plan.positive, text: plan.positive.text + ', sunset ' } }, { expectedRevision: plan.revision });
  })).ok, true);
  assert.match(store.relayState().plans[0].positive.text, /, sunset $/, 'v4 store 按 revision 接收文本尾段');
  assert.equal(transactionStorage.getItem(STORE_LEGACY_KEY), storeLegacyBytes);
  const storedBefore = transactionStorage.getItem(STORE_KEY);
  const before = JSON.stringify(store.relayState());
  rejectWrites = true;
  assert.equal((await store.commitRelay(next => { next.plans[0].name = 'Unsaved'; })).ok, false);
  assert.equal(JSON.stringify(store.relayState()), before);
  assert.equal(transactionStorage.getItem(STORE_KEY), storedBefore);
  rejectWrites = false;
  for (const [raw, reason] of [['{broken', 'corrupt-data'], [JSON.stringify({ version: 99 }), 'future-version']]) {
    transactionStorage.setItem(STORE_KEY, raw);
    const result = await store.commitRelay(next => { next.plans[0].name = 'Must not overwrite'; });
    assert.equal(result.reason, reason);
    assert.equal(transactionStorage.getItem(STORE_KEY), raw);
    assert.equal(JSON.stringify(store.relayState()), before);
  }
  transactionStorage.setItem(STORE_KEY, storedBefore);
  handlers.get('storage')({ storageArea: transactionStorage, key: STORE_KEY });
  assert.equal(store.getRelayStorageIssue(), null);
  handlers.get('storage')({ storageArea: transactionStorage, key: STORE_LEGACY_KEY });
  assert.equal(events.at(-1).issue, 'legacy-updated');
  assert.equal(transactionStorage.getItem(STORE_KEY), storedBefore);
} finally {
  globalThis.localStorage = previous.localStorage;
  globalThis.document = previous.document;
  globalThis.window = previous.window;
  globalThis.setTimeout = previous.setTimeout;
  console.warn = previous.warn;
}
console.log('tag relay v3: migration, exact mixed output, fragments, conflicts, storage protection and recovery passed');
