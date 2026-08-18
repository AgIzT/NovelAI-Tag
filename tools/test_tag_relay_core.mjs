import assert from 'node:assert/strict';

import {
  TAG_RELAY_SCHEMA_VERSION,
  appendBlockToPlan,
  appendEntryToPlan,
  clearCopyHistory,
  clearInbox,
  compilePlan,
  touchInboxEntry,
  TAG_RELAY_INBOX_LIMIT,
  mergedTotal,
  createPlan,
  createRelayState,
  deletePlan,
  loadRelayState,
  movePlanItem,
  normalizeRelayState,
  recordCopyHistory,
  removeInboxEntry,
  removePlanItem,
  renamePlan,
  restoreHistoryAsPlan,
  saveRelayState,
  serializeRelayState,
  setActivePlan,
  stableEntryKey,
  updatePlanItem,
} from '../site/assets/app/tag-relay-core.js';

const NOW = '2026-08-13T08:00:00.000Z';

function entry(overrides = {}) {
  return {
    id: 'look-1',
    title: '清透肖像',
    tags: 'masterpiece, {soft light}, shared',
    negative: 'bad hands, shared-negative',
    characterPrompts: [{ label: 'char1', prompt: '1girl, shared', negative: 'extra fingers' }],
    ...overrides,
  };
}

// Stable source keys dedupe title/prompt revisions, but keep codices separate.
{
  const first = stableEntryKey(entry(), { codexId: 'book-a' });
  assert.equal(first, stableEntryKey(entry({ title: '改名后' }), { codexId: 'book-a' }));
  assert.notEqual(first, stableEntryKey(entry(), { codexId: 'book-b' }));
  assert.equal(
    stableEntryKey({ title: 'local', prompt: 'tag-a' }),
    stableEntryKey({ title: 'local', prompt: 'tag-a' }),
  );
}

// 同源词条只保留一条，移除与清空照常；顺序是新的在前。
{
  const state = createRelayState({ now: NOW });
  const one = touchInboxEntry(state, entry(), { codexId: 'book-a', now: NOW });
  const duplicate = touchInboxEntry(
    state,
    entry({ title: '同源的新标题', tags: 'changed' }),
    { codexId: 'book-a', now: NOW },
  );
  const two = touchInboxEntry(state, entry({ id: 'look-2', title: '地雷系' }), {
    codexId: 'book-a',
    now: NOW,
  });
  assert.equal(one.added, true);
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.moved, true);
  assert.deepEqual(state.inbox.map(item => item.title), ['地雷系', '同源的新标题']);
  /* 重复复制会用新快照覆盖旧的（复制一次就刷新一次内容），所以这里取到的是新标题 */
  assert.equal(removeInboxEntry(state, one.entry.key)?.title, '同源的新标题');
  assert.equal(removeInboxEntry(state, 'missing'), null);
  assert.equal(clearInbox(state), 1);
  assert.equal(state.inbox.length, 0);
  assert.equal(two.entry.key.includes('look-2'), true);
}

// Access flags survive inbox, plan and history snapshots so a later lock can hide sensitive text.
{
  const state = createRelayState({ now: NOW });
  const staged = touchInboxEntry(state, entry({ access: { nsfw: true, r18g: true } }), {
    codexId: 'adult-book',
    now: NOW,
  }).entry;
  assert.deepEqual(staged.access, { nsfw: true, r18g: true });
  const item = appendEntryToPlan(state, state.activePlanId, staged, { now: NOW }).item;
  assert.deepEqual(item.access, { nsfw: true, r18g: true });
  const record = recordCopyHistory(state, { target: 'nai' }, { now: NOW });
  assert.deepEqual(record.plan.items[0].access, { nsfw: true, r18g: true });
}

// Plan CRUD and item ordering retain an always-valid active plan.
{
  const state = createRelayState({ now: NOW });
  const plan = createPlan(state, '试验方案', { id: 'plan-test', now: NOW });
  assert.equal(state.activePlanId, 'plan-test');
  assert.equal(renamePlan(state, plan.id, '都市地雷系', { now: NOW })?.name, '都市地雷系');
  assert.equal(setActivePlan(state, 'missing'), false);

  const first = appendEntryToPlan(state, plan.id, entry(), {
    id: 'slot-entry',
    codexId: 'book-a',
    now: NOW,
  });
  const duplicate = appendEntryToPlan(state, plan.id, entry({ title: '新标题' }), {
    codexId: 'book-a',
    now: NOW,
  });
  const block = appendBlockToPlan(state, plan.id, {
    title: '氛围块',
    prompt: 'cinematic lighting',
    negative: 'text',
  }, { id: 'slot-block', now: NOW });
  assert.equal(first.added, true);
  assert.equal(duplicate.added, false);
  assert.deepEqual(plan.items.map(item => item.id), ['slot-entry', 'slot-block']);

  assert.equal(movePlanItem(state, plan.id, block.id, 0, { now: NOW }), true);
  assert.deepEqual(plan.items.map(item => item.id), ['slot-block', 'slot-entry']);
  assert.equal(updatePlanItem(state, plan.id, block.id, {
    weight: 0.8,
    enabled: false,
    prompt: 'film grain',
  }, { now: NOW })?.weight, 0.8);
  assert.equal(plan.items[0].enabled, false);
  assert.equal(removePlanItem(state, plan.id, block.id, { now: NOW })?.title, '氛围块');

  assert.equal(deletePlan(state, plan.id, { now: NOW })?.id, plan.id);
  assert.equal(state.plans.length, 1);
  assert.equal(state.activePlanId, 'plan-default');
  assert.equal(deletePlan(state, 'plan-default', { replacementId: 'replacement', now: NOW })?.id, 'plan-default');
  assert.equal(state.activePlanId, 'replacement');
}

// 「复制即入库」：这一列是最近复制的流水，语义和 addInboxEntry 三点都不同。
{
  const src = id => ({ sourceId: id, codexId: 'book', entryId: id, title: '词条' + id, prompt: 'tag-' + id });
  const state = createRelayState({ now: NOW });

  // 新的在前
  touchInboxEntry(state, src('1'));
  touchInboxEntry(state, src('2'));
  touchInboxEntry(state, src('3'));
  assert.deepEqual(state.inbox.map(item => item.title), ['词条3', '词条2', '词条1']);

  // 重复复制 = 置顶，不是新增、也不是原地不动（addInboxEntry 的老行为）
  const again = touchInboxEntry(state, src('1'));
  assert.equal(again.moved, true);
  assert.equal(again.added, false);
  assert.equal(state.inbox.length, 3);
  assert.deepEqual(state.inbox.map(item => item.title), ['词条1', '词条3', '词条2']);

  // 上限：满了从尾部（最旧）挤掉，并把挤掉的报出来
  const flood = createRelayState({ now: NOW });
  for (let i = 0; i < TAG_RELAY_INBOX_LIMIT + 5; i += 1) touchInboxEntry(flood, src(String(i)));
  assert.equal(flood.inbox.length, TAG_RELAY_INBOX_LIMIT);
  assert.equal(flood.inbox[0].title, '词条54');
  const overflow = touchInboxEntry(flood, src('新'));
  assert.equal(flood.inbox.length, TAG_RELAY_INBOX_LIMIT);
  assert.equal(overflow.dropped.length, 1);
  assert.equal(flood.inbox[0].title, '词条新');

  // 显式 limit 覆盖默认值
  const tiny = createRelayState({ now: NOW });
  for (const id of ['a', 'b', 'c']) touchInboxEntry(tiny, src(id), { limit: 2 });
  assert.deepEqual(tiny.inbox.map(item => item.title), ['词条c', '词条b']);
}

// schema v1 的 inbox 是旧在前；升到 v2 必须掉头，否则最旧那条会钉在「最近复制」顶上。
{
  const legacy = {
    version: 1,
    inbox: [
      { sourceId: 'old', codexId: 'b', entryId: 'old', title: '最旧', prompt: 'x' },
      { sourceId: 'new', codexId: 'b', entryId: 'new', title: '最新', prompt: 'y' },
    ],
    plans: [], activePlanId: '', history: [],
  };
  const migrated = normalizeRelayState(legacy, { now: NOW });
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.inbox.map(item => item.title), ['最新', '最旧']);

  // 已经是 v2 的不能再掉头
  const current = normalizeRelayState({ ...legacy, version: 2 }, { now: NOW });
  assert.deepEqual(current.inbox.map(item => item.title), ['最旧', '最新']);

  // 坏文件塞了超量条目也要按上限截断
  const flood = normalizeRelayState({
    version: 2,
    inbox: Array.from({ length: TAG_RELAY_INBOX_LIMIT + 20 }, (_, i) => ({
      sourceId: 's' + i, codexId: 'b', entryId: 'e' + i, title: 't' + i, prompt: 'p',
    })),
    plans: [], activePlanId: '', history: [],
  }, { now: NOW });
  assert.equal(flood.inbox.length, TAG_RELAY_INBOX_LIMIT);
}

// 去重必须把合掉了什么报出来：只算数量不够，界面要能列出是哪几条。
{
  const plan = {
    items: [
      { enabled: true, weight: 1, prompt: 'a, masterpiece, b, masterpiece, no text', negative: 'lowres, lowres', characterPrompts: [] },
      { enabled: true, weight: 1, prompt: 'c, NO TEXT, 0.6::x,y::', negative: '', characterPrompts: [] },
    ],
  };
  const compiled = compilePlan(plan, { target: 'nai' });
  // 权重组跨逗号，不能被拆开当成两个 tag
  assert.deepEqual(compiled.positiveTokens, ['a', 'masterpiece', 'b', 'no text', 'c', '0.6::x,y::']);
  assert.equal(compiled.positiveMergedCount, 2);
  assert.deepEqual(compiled.positiveMerged, [
    { token: 'masterpiece', dropped: 1 },
    { token: 'no text', dropped: 1 },
  ]);
  // 大小写不同视为同一个 tag，保留第一次出现的写法
  assert.equal(compiled.positive.includes('NO TEXT'), false);
  assert.equal(compiled.negativeMergedCount, 1);
  assert.deepEqual(compiled.negativeMerged, [{ token: 'lowres', dropped: 1 }]);

  // 同一个 tag 出现三次要报 dropped: 2，不是两条记录
  const thrice = compilePlan({ items: [{ enabled: true, weight: 1, prompt: 'q, q, q', negative: '', characterPrompts: [] }] });
  assert.deepEqual(thrice.positiveMerged, [{ token: 'q', dropped: 2 }]);
  assert.equal(mergedTotal(thrice.positiveMerged), 2);

  // 关掉去重就不该报合并，也不该少 token
  const off = compilePlan(plan, { target: 'nai', dedupe: false });
  assert.equal(off.positiveTokens.length, 8);
  assert.deepEqual(off.positiveMerged, []);
  assert.equal(off.positiveMergedCount, 0);

  // 没有重复时不能报出空记录，界面靠这个决定显不显示
  const clean = compilePlan({ items: [{ enabled: true, weight: 1, prompt: 'm, n', negative: '', characterPrompts: [] }] });
  assert.deepEqual(clean.positiveMerged, []);
  assert.equal(mergedTotal(clean.positiveMerged), 0);
  assert.equal(mergedTotal(undefined), 0);
}

// Positive and negative channels compile independently, preserve order, and dedupe top-level tokens.
{
  const state = createRelayState({ now: NOW });
  const plan = state.plans[0];
  appendEntryToPlan(state, plan.id, entry(), {
    id: 'entry-a',
    codexId: 'book-a',
    now: NOW,
  });
  appendBlockToPlan(state, plan.id, {
    title: '补光',
    prompt: '{soft light}, cinematic',
    negative: 'shared-negative, watermark',
  }, { id: 'block-a', now: NOW });

  const nai = compilePlan(state, { target: 'nai' });
  assert.deepEqual(nai.positiveTokens, [
    'masterpiece',
    '{soft light}',
    'shared',
    '1girl',
    'cinematic',
  ]);
  assert.deepEqual(nai.negativeTokens, [
    'bad hands',
    'shared-negative',
    'extra fingers',
    'watermark',
  ]);
  assert.equal(nai.positive.includes('bad hands'), false);
  assert.equal(nai.negative.includes('masterpiece'), false);

  updatePlanItem(state, plan.id, 'block-a', { weight: 0.8 }, { now: NOW });
  const weightedNai = compilePlan(state, { target: 'nai' });
  assert.match(weightedNai.positive, /0\.8::\{soft light\}, cinematic::/);
  const sd = compilePlan(state, { target: 'sd' });
  assert.match(sd.positive, /\(soft light:1\.05\)/);
  assert.match(sd.positive, /\(\(soft light:1\.05\), cinematic:0\.8\)/);
  const plain = compilePlan(state, { target: 'plain', dedupe: false });
  assert.match(plain.positive, /\{soft light\}/);
  assert.doesNotMatch(plain.positive, /0\.8::/);
  assert.equal(plain.positiveTokens.filter(token => token === '{soft light}').length, 2);
}

// Copy history is newest-first, capped, snapshot-based, and restores into a new plan.
{
  const state = createRelayState({ now: NOW });
  const plan = state.plans[0];
  appendBlockToPlan(state, plan.id, { title: '原始块', prompt: 'alpha' }, {
    id: 'original-block',
    now: NOW,
  });
  for (let index = 1; index <= 5; index += 1) {
    updatePlanItem(state, plan.id, 'original-block', { prompt: `alpha-${index}` }, { now: NOW });
    recordCopyHistory(state, { target: 'nai', joinMode: index === 5 ? 'newline' : 'comma', channel: 'positive', label: `v${index}` }, {
      id: `history-${index}`,
      limit: 3,
      now: `2026-08-13T08:00:0${index}.000Z`,
    });
  }
  assert.deepEqual(state.history.map(item => item.id), ['history-5', 'history-4', 'history-3']);
  assert.equal(state.history[0].joinMode, 'newline');
  assert.equal(state.history[2].plan.items[0].prompt, 'alpha-3');
  updatePlanItem(state, plan.id, 'original-block', { prompt: 'current' }, { now: NOW });
  assert.equal(state.history[0].plan.items[0].prompt, 'alpha-5');

  const restored = restoreHistoryAsPlan(state, 'history-3', {
    id: 'restored-plan',
    name: '恢复版',
    now: NOW,
  });
  assert.equal(restored.items[0].prompt, 'alpha-3');
  assert.equal(state.activePlanId, 'restored-plan');
  assert.equal(clearCopyHistory(state), 3);
}

// Legacy aliases migrate; malformed nested values are dropped without breaking invariants.
{
  const migrated = normalizeRelayState({
    version: 0,
    staged: [
      { id: 'legacy-entry', codexId: 'legacy-book', title: '旧词条', tags: 'legacy-tag' },
      { id: 'legacy-entry', codexId: 'legacy-book', title: '重复', tags: 'changed' },
      'broken',
    ],
    plans: [{
      id: 'legacy-plan',
      title: '旧方案',
      rev: 4,
      items: [{ uid: 7, kind: 'block', positive: 'old-positive', on: false }],
    }],
    activePlan: 'legacy-plan',
    copyHistory: [{
      id: 'legacy-history',
      planId: 'legacy-plan',
      planName: '旧方案',
      channel: 'positive',
      output: 'old-positive',
      items: [{ uid: 7, kind: 'block', positive: 'old-positive' }],
      time: NOW,
    }],
  }, { now: NOW });
  assert.equal(migrated.version, TAG_RELAY_SCHEMA_VERSION);
  assert.equal(migrated.inbox.length, 1);
  assert.equal(migrated.inbox[0].prompt, 'legacy-tag');
  assert.equal(migrated.activePlanId, 'legacy-plan');
  assert.equal(migrated.plans[0].name, '旧方案');
  assert.equal(migrated.plans[0].revision, 4);
  assert.equal(migrated.plans[0].items[0].enabled, false);
  assert.equal(migrated.history[0].positive, 'old-positive');
}

// Storage round-trips valid JSON and safely falls back for corrupt/blocked storage.
{
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const state = createRelayState({ now: NOW });
  touchInboxEntry(state, entry(), { codexId: 'book-a', now: NOW });
  assert.equal(saveRelayState(state, storage, { now: NOW }), true);
  const loaded = loadRelayState(storage, { now: NOW });
  assert.deepEqual(loaded, JSON.parse(serializeRelayState(state, { now: NOW })));

  values.set('fadian-tag-relay-v1', '{bad json');
  const fallback = loadRelayState(storage, { now: NOW });
  assert.equal(fallback.activePlanId, 'plan-default');
  assert.equal(fallback.plans.length, 1);

  const blocked = {
    getItem() { throw new DOMException('blocked', 'SecurityError'); },
    setItem() { throw new DOMException('blocked', 'SecurityError'); },
  };
  assert.doesNotThrow(() => loadRelayState(blocked, { now: NOW }));
  assert.equal(saveRelayState(state, blocked, { now: NOW }), false);
}

console.log('tag relay core: all tests passed');
