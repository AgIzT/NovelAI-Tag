import assert from 'node:assert/strict';
import * as old from '../site/assets/app/tag-relay-core.js';
import * as v4 from '../site/assets/app/tag-relay-v4.js';
import { ZW, OFF_OPEN, OFF_CLOSE, analyzeOutput } from '../site/assets/app/tag-relay-text.js';

const now = '2026-09-21T00:00:00.000Z', options = { now };
const access = { nsfw: false, r18g: false };
// 复用 test_tag_relay_v3 的真实迁移形态，并补入 parts、嵌套权重及未完成尾段。
const source = { codexId: 'outdoors', entryId: 'equipment', title: 'Hiking equipment, 2025',
  prompt: 'backpack, gloves', negative: 'blur', access, accessKnown: true,
  characterPrompts: [{ label: 'guide', prompt: 'beanie', negative: 'closed eyes' }] };
const legacyPlan = { id: 'old-plan', name: 'Old', revision: 4, items: [
  { ...source, id: 'old-slot', kind: 'entry', weight: 1.2, enabled: true },
  { id: 'manual', kind: 'block', prompt: 'forest, forest', negative: 'fog', enabled: true, access },
  { id: 'disabled', kind: 'block', prompt: 'rain', enabled: false, access },
] };
const fixture = old.normalizeRelayState({ version: 2, inbox: [source], plans: [legacyPlan], activePlanId: legacyPlan.id,
  history: [{ id: 'copy-old', plan: legacyPlan, snapshotComplete: true, positive: '  original output\n', negative: 'blur', createdAt: now }] }, options);
const mixed = old.createPlan(fixture, 'Mixed', { ...options, id: 'mixed' });
old.appendEntryToPlan(fixture, mixed.id, { ...source, title: '#Same\u200b name' }, { ...options, id: 'first' });
old.appendEntryToPlan(fixture, mixed.id, { ...source, title: '#Same\u200b name', prompt: '1.3::cat::, dog', negative: '' }, { ...options, id: 'second', weight: 1.4 });
old.updatePlanItem(fixture, mixed.id, 'first', { weight: 1.2, parts: [
  { id: 'drop', raw: 'backpack', enabled: false }, { id: 'keep', raw: 'gloves, gloves' }, { id: 'character', raw: 'beanie' },
] }, options);
old.insertPlanNode(fixture, mixed.id, { nodeType: 'tag', prompt: '"blue sky, sunlight"' }, undefined, options);
old.insertPlanNode(fixture, mixed.id, { nodeType: 'tag', prompt: 'label\\, variant' }, undefined, options);
old.insertPlanNode(fixture, mixed.id, { nodeType: 'text', prompt: '  unfinished tail  ' }, undefined, options);
old.insertPlanNode(fixture, mixed.id, { nodeType: 'tag', prompt: '1.3::cat::, dog', weight: 1.4 }, undefined, options);
old.insertPlanNode(fixture, mixed.id, { nodeType: 'text', prompt: 'line one\nline two', weight: 0.8 }, undefined, options);
old.insertPlanNode(fixture, mixed.id, { nodeType: 'text', prompt: 'hidden line\nsecond line', enabled: false }, undefined, options);
old.recordCopyHistory(fixture, { planId: mixed.id, joinMode: 'newline' }, options);

const migrated = v4.normalizeRelayState(fixture, options);
assert.equal(migrated.version, 4);
assert.ok(migrated.plans.every(plan => !Object.hasOwn(plan, 'items')));
for (let index = 0; index < fixture.plans.length; index += 1) {
  for (const target of ['nai', 'sd', 'plain']) for (const joinMode of ['comma', 'newline']) {
    const before = old.compilePlan(fixture.plans[index], { target });
    const after = v4.compilePlan(migrated.plans[index], { target, joinMode });
    for (const channel of ['positive', 'negative']) {
      assert.equal(after[channel], before[`${channel}Tokens`].join(joinMode === 'comma' ? ', ' : ',\n'), `${index}/${target}/${joinMode}/${channel}`);
    }
  }
}
assert.equal(migrated.history[1].positive, '  original output\n');
assert.ok(!v4.compilePlan(migrated.plans[0]).negative.includes('closed eyes'));
const initialFold = Object.values(migrated.plans[0].positive.folds)[0];
assert.deepEqual(initialFold.characters, source.characterPrompts);
assert.equal(initialFold.image, '');
assert.deepEqual(initialFold.access, access);
assert.equal(initialFold.accessKnown, true);
assert.equal(Object.values(migrated.plans[1].positive.folds)[0].parts[0].enabled, false);
assert.ok(Object.keys(migrated.plans[1].positive.folds).every(name => !/[#\u200b]/.test(name)));
assert.ok(migrated.plans[1].positive.text.includes('  unfinished tail  '));
assert.deepEqual(v4.normalizeRelayState(migrated, options), migrated);
const reservedTitle = old.normalizeRelayState({ version: 3, plans: [{ items: [
  { nodeType:'group', kind:'block', title:'__proto__', prompt:'reserved title body', access },
] }], history: [], inbox: [] }, options);
assert.equal(v4.compilePlan(v4.normalizeRelayState(reservedTitle, options)).positive, 'reserved title body');
const compatibilityPlan = migrated.plans[1], compatibilityState = structuredClone(migrated);
const tailSnapshot = { dedupe: compatibilityPlan.dedupe, positive: { text: compatibilityPlan.positive.text + ', trailing', folds: compatibilityPlan.positive.folds }, negative: compatibilityPlan.negative };
assert.equal(v4.replacePlanText(compatibilityState, compatibilityPlan.id, tailSnapshot, options).ok, true);
for (const target of ['nai', 'sd', 'plain']) {
  assert.equal(v4.compilePlan(compatibilityState.plans[1], { target }).positive,
    v4.compilePlan(compatibilityPlan, { target }).positive + ',\ntrailing');
}
const editedCompatibility = compatibilityState.plans[1];
const changedSegment = editedCompatibility.positive.legacySegments.find(item => item.body?.includes('line one'));
const changedText = editedCompatibility.positive.text.replace('line one', 'edited line');
v4.replacePlanText(compatibilityState, editedCompatibility.id, { ...editedCompatibility, positive: { ...editedCompatibility.positive, text: changedText, legacySegments: undefined } }, options);
assert.ok(!editedCompatibility.positive.legacySegments.some(item => item.source === changedSegment.source), 'edited legacy span becomes normal current text');
// 旧版允许的非整权重、带引号/损坏的内联语法也必须逐字迁移，不能仅验漂亮输入。
for (const body of ['cat, dog', '1.3::cat::, dog', 'cat, cat', 'line1\nline2', '{{cat}}, [dog]',
  'a\\,b, c', 'a，b', '0.6::x,y::', '1.5::x,y', '::', '"1.2::quoted::"']) {
  for (const weight of [1, 1.0001, 0.333333, 0.8, 1.2, 0.05, 10]) {
    const before = old.normalizeRelayState({ version: 3, plans: [{ id: 'matrix', dedupe: true, items: [
      { id: 'i', nodeType: 'group', kind: 'block', channel: 'positive', prompt: body, weight, access },
    ] }], history: [], inbox: [] }, options);
    const after = v4.normalizeRelayState(before, options);
    for (const target of ['nai', 'sd', 'plain']) {
      assert.equal(v4.compilePlan(after, { target }).positive, old.compilePlan(before, { target }).positive, `${body}/${weight}/${target}`);
    }
    assert.deepEqual(v4.normalizeRelayState(after, options), after);
  }
}

const memory = initial => {
  const values = new Map(Object.entries(initial || {}));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
};
const legacyBytes = JSON.stringify(fixture);
const storage = memory({ [v4.TAG_RELAY_LEGACY_STORAGE_KEY]: legacyBytes });
assert.equal(v4.loadRelayStateStatus(storage, options).migrated, true);
assert.equal(storage.getItem(v4.TAG_RELAY_STORAGE_KEY), null, 'candidate load must not write without store lock');
assert.equal(v4.saveRelayState(migrated, storage, options), true);
assert.equal(storage.getItem(v4.TAG_RELAY_LEGACY_STORAGE_KEY), legacyBytes);
assert.equal(v4.loadRelayStateStatus(storage, options).migrated, false);
for (const [payload, reason] of [['{broken', 'corrupt-data'], [JSON.stringify({ version: 99 }), 'future-version'],
  [JSON.stringify({ version: 4, plans: [{ positive: { text: '', folds: [] }, negative: { text: '', folds: {} } }] }), 'corrupt-data']]) {
  const guarded = memory({ [v4.TAG_RELAY_STORAGE_KEY]: payload });
  assert.equal(v4.loadRelayStateStatus(guarded, options).reason, reason);
  assert.equal(v4.saveRelayState(migrated, guarded, options), false);
  assert.equal(guarded.getItem(v4.TAG_RELAY_STORAGE_KEY), payload);
}
const v1 = { version: 1, plans: [legacyPlan], inbox: [{ ...source, entryId: 'oldest' }, source], history: [] };
const v1Storage = memory({ [v4.TAG_RELAY_OLDER_STORAGE_KEY]: JSON.stringify(v1) });
assert.equal(v4.loadRelayStateStatus(v1Storage, options).state.inbox[0].entryId, source.entryId);

const session = { dedupe: false, positive: { text: `${ZW}#book${ZW}, loose, unfinished `,
  folds: new Map([['book', { ...source, body: 'gloves, beanie', characters: source.characterPrompts }],
    ['unused', { body: 'must be collected', access }]]) }, negative: { text: 'fog', folds: {} } };
const state = v4.createRelayState(options), plan = v4.getActivePlan(state), revision = plan.revision;
assert.equal(v4.replacePlanText(state, plan.id, session, { ...options, expectedRevision: revision }).ok, true);
assert.equal(plan.revision, revision + 1);
assert.ok(!Object.hasOwn(plan.positive.folds, 'unused'));
assert.equal(session.positive.folds.has('unused'), true, 'persistence GC cannot mutate session side table');
const beforeConflict = v4.serializeRelayState(state, options);
assert.equal(v4.replacePlanText(state, plan.id, session, { expectedRevision: revision }).reason, 'conflict');
assert.equal(v4.serializeRelayState(state, options), beforeConflict);
const dangling = v4.normalizeChannel({ text: `${ZW}#missing${ZW}, ${ZW}#book${ZW}`, folds: {} });
assert.equal(dangling.text, '#missing, #book');
const renamed = v4.normalizeChannel({ text: `${ZW}##book${ZW}, ${ZW}#book${ZW}`, folds: { '#book': { body: 'a', access }, book: { body: 'b', access } } });
assert.deepEqual(Object.keys(renamed.folds), ['book', 'book 2']);
assert.equal(renamed.text, `${ZW}#book${ZW}, ${ZW}#book 2${ZW}`);
const copy = v4.copyPlan(state, plan.id, options);
assert.ok(copy.id !== plan.id);
assert.equal(v4.compilePlan(copy).positive, v4.compilePlan(plan).positive);
copy.positive.folds.book.body = 'other';
assert.equal(plan.positive.folds.book.body, 'gloves, beanie');
assert.ok(v4.renamePlan(state, copy.id, 'Renamed', options));
assert.equal(copy.revision, 1);
assert.ok(v4.setActivePlan(state, plan.id));
assert.ok(v4.deletePlan(state, copy.id, options));

const history = v4.recordCopyHistory(state, { planId: plan.id, joinMode: 'comma' }, options);
assert.equal(history.snapshotComplete, true);
const restored = v4.restoreHistoryAsPlan(state, history.id, options);
assert.ok(restored && restored.id !== plan.id);
assert.equal(v4.compilePlan(restored).positive, v4.compilePlan(plan).positive);
assert.equal(v4.restoreHistoryAsPlan(state, history.id, { isLocked: () => true }), null);
const backup = v4.exportRelayBackup(state, options), destination = v4.createRelayState(options);
const restoredBackup = v4.importRelayBackup(destination, backup, options);
assert.equal(restoredBackup.planCount, 2);
assert.equal(destination.plans.length, 3);
assert.deepEqual(destination.plans[1].positive, plan.positive);
assert.deepEqual(destination.plans[1].negative, plan.negative);
assert.equal(destination.history[0].positive, history.positive);
assert.equal(v4.compilePlan(destination.plans[1]).positive, v4.compilePlan(plan).positive);
assert.equal(v4.validateRelayBackup(old.exportRelayBackup(fixture, options)).version, 4);
const orphanHistory = v4.normalizeRelayState({ version: 3, plans: [], inbox: [], history: [
  { id: 'orphan', snapshotComplete: true, positive: 'orphan-output', plan: { items: [] } },
] }, options);
assert.equal(orphanHistory.history[0].positive, 'orphan-output', 'unsafe history original bytes are still recoverable');
assert.equal(orphanHistory.history[0].snapshotComplete, false);
assert.equal(v4.restoreHistoryAsPlan(orphanHistory, 'orphan'), null);
const rawTextHistoryState = v4.createRelayState(options);
rawTextHistoryState.plans[0].positive.text = 'ordinary typed text';
assert.equal(v4.recordCopyHistory(rawTextHistoryState, {}, options).snapshotComplete, true);
assert.throws(() => v4.validateRelayBackup('{}'), error => error.reason === 'invalid-backup');
assert.throws(() => v4.validateRelayBackup(JSON.stringify({ format: 'fadian-tag-relay', version: 99, state })), error => error.reason === 'future-version');

const disabled = v4.normalizePlan({ positive: { text: `${OFF_OPEN}${ZW}#locked${ZW}${OFF_CLOSE}, visible`,
  folds: { locked: { ...source, body: 'hidden words', access: { nsfw: true, r18g: false } } } } }, options);
assert.equal(v4.compilePlan(disabled).positive, 'visible');
disabled.positive.text = `${ZW}#locked${ZW}, visible`;
assert.equal(v4.compilePlan(disabled, { isLocked: fold => fold.access.nsfw }).positive, 'visible');
const freshWeights = v4.normalizePlan({ dedupe: false, positive: { text: `15::${ZW}#x${ZW}::, -2::${ZW}#x${ZW}::, {{${ZW}#x${ZW}}}`,
  folds: { x: { body: 'cat', access } } } }, options);
assert.equal(v4.compilePlan(freshWeights).positive, '15::cat::,\n-2::cat::,\n{{cat}}');
assert.equal(v4.compilePlan(freshWeights, { target: 'plain' }).positive, 'cat,\ncat,\ncat');
assert.equal(v4.compilePlan(v4.normalizePlan({ positive: { text: 'one\ntwo，three', folds: {} } })).positive, 'one,\ntwo,\nthree');
const freshFolds = new Map([['x', { body: 'cat, CAT, line\nbreak', access }], ['numeric', { body: '1.3::cat::, sky', access }]]);
for (const input of [`${ZW}#x${ZW}, cat`, `1.2::${ZW}#x${ZW}::, cat`, `prefix${ZW}#x${ZW}suffix`,
  `-1::${ZW}#numeric${ZW}::`, `{{${ZW}#numeric${ZW}}}`, `0::${ZW}#numeric${ZW}::`]) {
  for (const target of ['nai', 'sd', 'plain']) for (const dedupe of [true, false]) {
    const expected = analyzeOutput(input, freshFolds, { target, dedupe });
    const actual = v4.compilePlanChannel({ dedupe, positive: { text: input, folds: freshFolds } }, 'positive', { target, joinMode: 'comma' });
    assert.equal(actual.text, expected.text, `${input}/${target}/${dedupe}`);
    assert.deepEqual(actual.merged, expected.merged);
  }
}
const plansBeforeTrim = JSON.stringify(state.plans);
const trimmed = v4.trimStateToBudget(state, 0, options);
assert.equal(trimmed.trimmed, 1);
assert.equal(trimmed.fits, false);
assert.equal(JSON.stringify(state.plans), plansBeforeTrim);
console.log('tag relay v4: exact migration (3 targets × 2 joins), persistence, revisions, fold GC, history, backups and access passed');
