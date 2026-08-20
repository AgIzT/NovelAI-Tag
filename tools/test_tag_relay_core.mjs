import assert from 'node:assert/strict';

import {
  TAG_RELAY_HISTORY_LIMIT,
  TAG_RELAY_SCHEMA_VERSION,
  appendBlockToPlan,
  appendEntryToPlan,
  cleanPrompt,
  clearCopyHistory,
  clearInbox,
  compilePlan,
  compileRelayBlock,
  touchInboxEntry,
  TAG_RELAY_INBOX_LIMIT,
  itemHasCharacterNegative,
  mergedTotal,
  createPlan,
  createRelayState,
  deletePlan,
  loadRelayState,
  movePlanItem,
  naiToSd,
  normalizeRelayState,
  recordCopyHistory,
  removeInboxEntry,
  removePlanItem,
  renamePlan,
  restoreHistoryAsPlan,
  saveRelayState,
  serializeRelayState,
  setActivePlan,
  splitTopLevel,
  stableEntryKey,
  trimStateToBudget,
  updatePlanItem,
  weightAppliesTo,
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
  /* 挤掉的是**最旧**那条，界面要能把它报出来——只断言个数看不出挤错了人 */
  assert.deepEqual(overflow.dropped.map(item => item.title), ['词条5']);
  assert.equal(flood.inbox[0].title, '词条新');

  // 显式 limit 覆盖默认值
  const tiny = createRelayState({ now: NOW });
  const drops = ['a', 'b', 'c'].map(id => touchInboxEntry(tiny, src(id), { limit: 2 }));
  assert.deepEqual(tiny.inbox.map(item => item.title), ['词条c', '词条b']);
  assert.deepEqual(drops.map(result => result.dropped.map(item => item.title)), [[], [], ['词条a']]);
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
  /* ⚠ 角色级负面（extra fingers）**不得**出现在这里：它在 NAI 里按角色分槽填，
     几条词条的角色 uc 揉成一个全局 uc 会过度压制画面。见 decisions/Tag中转站.md。
     这条断言以前把错误行为固化成了预期，2026-08-18 纠正。 */
  assert.deepEqual(nai.negativeTokens, [
    'bad hands',
    'shared-negative',
    'watermark',
  ]);
  assert.equal(nai.negative.includes('extra fingers'), false, '角色级负面绝不能进全局负向');
  assert.equal(itemHasCharacterNegative(state.plans[0].items[0]), true, '有角色负面这件事要能被界面查到');
  assert.equal(nai.positive.includes('bad hands'), false);
  assert.equal(nai.positive.includes('1girl'), true, '角色级**正向**照旧并入正向');
  assert.equal(nai.negative.includes('masterpiece'), false);

  /* 断言整份 token 列表而不是 assert.match：多出无关内容也要能被发现 */
  updatePlanItem(state, plan.id, 'block-a', { weight: 0.8 }, { now: NOW });
  const weightedNai = compilePlan(state, { target: 'nai' });
  assert.deepEqual(weightedNai.positiveTokens, [
    'masterpiece',
    '{soft light}',
    'shared',
    '1girl',
    '0.8::{soft light}, cinematic::',
  ]);
  /* ⚠ 锁住现状：块权重**同样**作用于负向通道。用户拉低块权重想「少一点这个概念」时，
     这块的负面约束也会一起放松——这是有意设计（块权重＝整块的存在感），
     见 tag-relay-core.js 里 compilePlanChannel 的注释。别当 bug 改掉。 */
  assert.deepEqual(weightedNai.negativeTokens, [
    'bad hands',
    'shared-negative',
    '0.8::shared-negative, watermark::',
  ]);

  const sd = compilePlan(state, { target: 'sd' });
  assert.deepEqual(sd.positiveTokens, [
    'masterpiece',
    '(soft light:1.05)',
    'shared',
    '1girl',
    '((soft light:1.05), cinematic:0.8)',
  ]);
  assert.deepEqual(sd.negativeTokens, [
    'bad hands',
    'shared-negative',
    '(shared-negative, watermark:0.8)',
  ]);

  const plain = compilePlan(state, { target: 'plain', dedupe: false });
  assert.deepEqual(plain.positiveTokens, [
    'masterpiece',
    '{soft light}',
    'shared',
    '1girl',
    'shared',
    '{soft light}',
    'cinematic',
  ], 'plain 目标丢权重、保留 NAI 括号原样');
  assert.equal(weightAppliesTo('plain'), false, '界面靠这个知道 plain 目标下权重滑块是无效的');
  assert.equal(weightAppliesTo('nai'), true);
  assert.equal(weightAppliesTo('sd'), true);
  assert.equal(weightAppliesTo('未知目标'), true, '未知目标按 nai 处理');
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

// History records may receive a pre-filtered plan snapshot. This is what lets
// the UI preserve the text actually copied without serializing a now-locked
// source block; output-only legacy records remain unavailable by default.
{
  const state = createRelayState({ now: NOW });
  const original = state.plans[0];
  appendBlockToPlan(state, original.id, { title: 'safe', prompt: 'safe-tag' }, { now: NOW });
  appendBlockToPlan(state, original.id, {
    title: 'adult', prompt: 'adult-tag', access: { nsfw: true },
  }, { now: NOW });
  const safeSnapshot = { ...original, items: [original.items[0]] };
  const record = recordCopyHistory(state, {
    plan: safeSnapshot,
    channel: 'positive',
    output: { positive: 'safe-tag', negative: '', positiveCount: 1, negativeCount: 0 },
  }, { now: NOW });
  assert.equal(record.snapshotComplete, true);
  assert.deepEqual(record.plan.items.map(item => item.title), ['safe']);
  assert.equal(record.positive, 'safe-tag');

  const outputOnly = normalizeRelayState({
    version: 2,
    history: [{ id: 'old-output-only', label: 'old', channel: 'positive', output: 'secret' }],
  }, { now: NOW });
  assert.equal(outputOnly.history[0].snapshotComplete, false);
  assert.equal(restoreHistoryAsPlan(outputOnly, 'old-output-only', { now: NOW }), null);
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
  /* v1 是旧在前，所以这两条同源记录里 'changed' 才是较新的那份。掉头必须发生在去重之前，
     否则留下的是最旧的副本（旧行为断言的正是那个 bug）。 */
  assert.equal(migrated.inbox[0].prompt, 'changed');
  assert.equal(migrated.activePlanId, 'legacy-plan');
  assert.equal(migrated.plans[0].name, '旧方案');
  assert.equal(migrated.plans[0].revision, 4);
  assert.equal(migrated.plans[0].items[0].enabled, false);
  assert.equal(migrated.history[0].positive, 'old-positive');
}

// Legacy relay snapshots without an access object still inherit the main site's
// rating / level / path gates during normalization.
{
  const migrated = normalizeRelayState({
    version: 1,
    inbox: [
      { id: 'r18g-rating', codexId: 'book', rating: 'r18g', title: 'hidden', prompt: 'x' },
      { id: 'r18-path', codexId: 'book', path: 'r18g', title: 'hidden path', prompt: 'y' },
      { id: 'nsfw-level', codexId: 'book', level: 'restricted', title: 'hidden level', prompt: 'z' },
    ],
    plans: [{
      id: 'plan-legacy-access',
      items: [{ id: 'raw-r18g', kind: 'block', rating: 'r18g', title: 'hidden block', prompt: 'secret' }],
    }],
  }, { now: NOW });
  const rating = migrated.inbox.find(item => item.entryId === 'r18g-rating');
  const path = migrated.inbox.find(item => item.entryId === 'r18-path');
  const level = migrated.inbox.find(item => item.entryId === 'nsfw-level');
  assert.equal(rating.access.nsfw, true);
  assert.equal(rating.access.r18g, true);
  assert.equal(path.access.r18g, true);
  assert.deepEqual(path.path, ['r18g']);
  assert.deepEqual(migrated.plans[0].items[0].path, [], '自定义块也应保持数组形 path 契约');
  assert.equal(level.access.nsfw, true);
  assert.equal(migrated.plans[0].items[0].access.r18g, true);
}

// 未知的旧引用不能因为 normalizePlan 补成空 entry 就被当成完整历史快照放行；
// 字符串 NSFW path 也要成为迁移时的分级证据。
{
  const migrated = normalizeRelayState({
    version: 1,
    inbox: [{ id: 'legacy-nsfw-path', codexId: 'gone-book', path: 'NSFW', title: 'hidden', prompt: 'secret' }],
    history: [{
      id: 'reference-only',
      channel: 'positive',
      output: 'adult-secret',
      items: [{ kind: 'entry', entryKey: 'entry:gone-book:adult' }],
    }],
  }, { now: NOW });
  assert.equal(migrated.inbox[0].access.nsfw, true);
  assert.equal(migrated.history[0].snapshotComplete, false);
  assert.equal(restoreHistoryAsPlan(migrated, 'reference-only', { now: NOW }), null);
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

/* ⚠ 最重要的一条：normalize 必须是不动点，它的产物再喂回去要一模一样。
   旧版 hasAccessEvidence 把 normalizeRelayEntry 自己写出的 access:{nsfw,r18g} 当成分级证据，
   于是 accessKnown:false 序列化一轮就翻回 true，snapshotLocked 的 fail-closed 静默失效。 */
{
  const seed = createRelayState({ now: NOW });
  touchInboxEntry(seed, { id: 'unknown-src', title: '来源不明', prompt: 'mystery', accessKnown: false }, { now: NOW });
  touchInboxEntry(seed, { id: 'known', codexId: 'book', title: '有据可查', prompt: 'x', rating: 'r18g' }, { now: NOW });
  touchInboxEntry(seed, { title: '无 id 的本地条目', prompt: 'local', characterPrompts: [{ prompt: '1girl' }] }, { now: NOW });
  appendBlockToPlan(seed, seed.activePlanId, { title: '未知块', prompt: 'a, b', accessKnown: false }, { id: 'unknown-block', now: NOW });
  appendEntryToPlan(seed, seed.activePlanId, {
    id: 'unknown-src', title: '来源不明', prompt: 'mystery', accessKnown: false,
  }, { id: 'unknown-slot', now: NOW });
  recordCopyHistory(seed, { target: 'nai' }, { id: 'snap', now: NOW });

  const once = normalizeRelayState(seed, { now: NOW });
  const twice = normalizeRelayState(once, { now: NOW });
  assert.deepEqual(twice, once, 'normalizeRelayState 必须是不动点');
  assert.deepEqual(JSON.parse(serializeRelayState(once, { now: NOW })), once, 'JSON 往返同样不能漂移');

  const unknown = key => twice.inbox.find(item => item.entryId === key);
  assert.equal(once.inbox.find(item => item.entryId === 'unknown-src').accessKnown, false);
  assert.equal(unknown('unknown-src').accessKnown, false, 'accessKnown:false 必须黏住');
  assert.equal(unknown('known').accessKnown, true, '有 rating 依据的仍然算已知');
  const slot = id => twice.plans[0].items.find(item => item.id === id);
  assert.equal(slot('unknown-slot').accessKnown, false);
  assert.equal(slot('unknown-block').accessKnown, false, '自定义块的显式 accessKnown:false 同样要黏住');
  assert.equal(twice.history[0].plan.items.find(item => item.id === 'unknown-slot').accessKnown, false);

  // 没写 accessKnown 时才回落到推断，别把显式的 false 和「没说」混为一谈
  const inferred = normalizeRelayState({
    version: 2,
    inbox: [
      { id: 'no-evidence', title: '啥都没有', prompt: 'p' },
      { id: 'with-path', title: '有路径', prompt: 'p', path: ['画风', 'nsfw'] },
    ],
  }, { now: NOW });
  assert.equal(inferred.inbox.find(item => item.entryId === 'no-evidence').accessKnown, false);
  assert.equal(inferred.inbox.find(item => item.entryId === 'with-path').accessKnown, true);
  assert.deepEqual(normalizeRelayState(inferred, { now: NOW }), inferred);
}

// splitTopLevel 直测：它和 naiToSd 对同一串的理解必须一致，否则「N 段」计数会错报。
{
  assert.deepEqual(splitTopLevel(''), []);
  assert.deepEqual(splitTopLevel(',,,'), []);
  assert.deepEqual(splitTopLevel('a,'), ['a']);
  assert.deepEqual(splitTopLevel(',a'), ['a']);
  assert.deepEqual(splitTopLevel('a, b'), ['a', 'b']);
  assert.deepEqual(splitTopLevel('{a, b}, c'), ['{a, b}', 'c'], '括号组内的逗号不是分隔符');
  assert.deepEqual(splitTopLevel('{{a}, b}, c'), ['{{a}, b}', 'c'], '嵌套括号要按层数配对');
  assert.deepEqual(splitTopLevel('[a, b], c'), ['[a, b]', 'c']);
  assert.deepEqual(splitTopLevel('(a:1.2), (b:0.8)'), ['(a:1.2)', '(b:0.8)'], 'SD 形也不能被拆开');
  assert.deepEqual(splitTopLevel('{a, b, c'), ['{a, b, c'], '未闭合左括号：整段保持原样');
  assert.deepEqual(splitTopLevel('a}, b'), ['a}', 'b'], '多余右括号不该让计数变负');

  // 闭合的数字权重整段算一个 token（naiToSd 先找配对的收尾 ::）
  assert.deepEqual(splitTopLevel('masterpiece, 1.2::a::, best'), ['masterpiece', '1.2::a::', 'best']);
  assert.deepEqual(splitTopLevel('0.6::x,y::'), ['0.6::x,y::']);
  assert.deepEqual(splitTopLevel('1.2::{a, b}::'), ['1.2::{a, b}::']);
  assert.deepEqual(splitTopLevel('-1.5::a::, b'), ['-1.5::a::', 'b'], '带符号权重');
  assert.deepEqual(splitTopLevel('+2::a::, b'), ['+2::a::', 'b']);

  /* ⚠ 未闭合的 `1.5::` 不能吃掉后面所有顶层逗号：naiToSd 的兜底分支
     `([^,\n}\]]*)` 在逗号/换行处就截断了，两边不同判就会分叉。 */
  const drift = 'masterpiece, 1.5::detailed face, best quality, 1girl';
  assert.deepEqual(splitTopLevel(drift), ['masterpiece', '1.5::detailed face', 'best quality', '1girl']);
  assert.equal(
    splitTopLevel(drift).length,
    splitTopLevel(naiToSd(drift)).length,
    'splitTopLevel 与 naiToSd 必须对同一串给出同样的段数',
  );
  assert.deepEqual(splitTopLevel('1.5::a\nb, c'), ['1.5::a\nb', 'c'], '换行同样终止未闭合权重');
  assert.deepEqual(splitTopLevel('1.2::a::, 1.5::loose, tail'), ['1.2::a::', '1.5::loose', 'tail']);

  // 非权重语境的 `::` 不该触发权重状态机
  assert.deepEqual(splitTopLevel('note:: something, b'), ['note:: something', 'b']);
  assert.deepEqual(splitTopLevel('a::b, c'), ['a::b', 'c']);
}

// compileRelayBlock / 权重归一化 / 格式化：三处语义必须自洽。
{
  const nai = (value, weight) => compileRelayBlock(value, { target: 'nai', weight });
  // 缺失或不可解析 → 不加权；这是「没传」，不是「传了非法值」
  for (const missing of [undefined, null, '', 'abc', {}]) {
    assert.equal(nai('a', missing), 'a', `缺省权重 ${String(missing)} 应视为不加权`);
  }
  /* ⚠ 0 / 负数 / Infinity 一律按 clamp 语义走。旧版把它们当成「没设权重」，
     而 0.01 却老实 clamp 到 0.05 —— 同一根滑块两套语义。 */
  assert.equal(nai('a', 0), '0.05::a::');
  assert.equal(nai('a', -3), '0.05::a::');
  assert.equal(nai('a', 0.01), '0.05::a::');
  assert.equal(nai('a', Number.NEGATIVE_INFINITY), '0.05::a::');
  assert.equal(nai('a', 99), '10::a::');
  assert.equal(nai('a', Number.POSITIVE_INFINITY), '10::a::');

  // 四舍五入后等于 '1' 就不套壳：`1::cat::` 是纯噪声
  assert.equal(nai('cat', 1), 'cat');
  assert.equal(nai('cat', 1.0001), 'cat');
  assert.equal(nai('cat', 1.0006), '1.001::cat::', '真的不等于 1 才套壳');

  // cleanPrompt 头尾都要剥，否则会写出 `1.2::,a::` 这种带空 tag 的串
  assert.equal(nai(',a', 1.2), '1.2::a::');
  assert.equal(cleanPrompt(' ，, a, '), 'a');
  assert.equal(nai('', 1.2), '');
  assert.equal(nai('  ，  ', 1.2), '');

  // SD 靠括号嵌套本来就没有歧义
  assert.equal(compileRelayBlock('a', { target: 'sd', weight: 0.8 }), '(a:0.8)');
  assert.equal(compileRelayBlock('{a}', { target: 'sd', weight: 0.8 }), '((a:1.05):0.8)');
  // plain 目标丢权重（core 侧丢是对的，界面靠 weightAppliesTo 得知）
  assert.equal(compileRelayBlock('{a}, b', { target: 'plain', weight: 0.8 }), '{a}, b');

  /* ⚠ 正文已含数字权重时改用 `{}`/`[]` 层数近似，绝不能产出 `1.4::…::::`：
     nai-sd.js 开头明说数字权重自嵌套时 :: 的就近闭合有歧义、不作递归解析。
     代价是权重被量化到 1.05 的整数次幂（0.8 → 5 层 `[]` ≈ 0.784）。 */
  const inline = nai('masterpiece, 1.2::detailed::', 0.8);
  assert.equal(inline.includes('::::'), false, '正常路径不许批量生产歧义串');
  assert.equal(inline, '[[[[[masterpiece, 1.2::detailed::]]]]]');
  assert.equal(naiToSd(inline), '(masterpiece, (detailed:1.2):0.784)', '近似值仍能被 naiToSd 正确还原');
  assert.equal(nai('1.2::detailed::', 1.3), '{{{{{1.2::detailed::}}}}}');
  assert.equal(nai('1.2::detailed::', 1.02), '1.2::detailed::', '近似层数为 0 时原样返回，不留空括号');
}

// movePlanItem：非法 toIndex 不能被 `|| 0` 悄悄变成「移到队首」还回 true。
{
  const state = createRelayState({ now: NOW });
  const plan = state.plans[0];
  for (const id of ['m1', 'm2', 'm3']) {
    appendBlockToPlan(state, plan.id, { title: id, prompt: id }, { id, now: NOW });
  }
  const ids = () => plan.items.map(item => item.id);

  for (const bad of ['abc', undefined, null, Number.NaN, 1.5, {}, '']) {
    assert.equal(movePlanItem(state, plan.id, 'm3', bad, { now: NOW }), false, `非法 toIndex ${String(bad)} 必须拒绝`);
  }
  assert.deepEqual(ids(), ['m1', 'm2', 'm3'], '被拒绝的移动不许改动顺序');

  assert.equal(movePlanItem(state, plan.id, 'm3', 0, { now: NOW }), true, 'toIndex=0 是合法意图');
  assert.deepEqual(ids(), ['m3', 'm1', 'm2']);
  assert.equal(movePlanItem(state, plan.id, 'm3', 0, { now: NOW }), false, '原地移动返回 false');
  // 越界按夹取处理：拖出列表 = 拖到头/尾
  assert.equal(movePlanItem(state, plan.id, 'm3', 99, { now: NOW }), true);
  assert.deepEqual(ids(), ['m1', 'm2', 'm3']);
  assert.equal(movePlanItem(state, plan.id, 'm3', -4, { now: NOW }), true);
  assert.deepEqual(ids(), ['m3', 'm1', 'm2']);

  /* 下标语义是 remove-then-insert：向下拖落在目标之后、向上落在目标之前。别改这套算术。 */
  assert.equal(movePlanItem(state, plan.id, 'm3', 1, { now: NOW }), true);
  assert.deepEqual(ids(), ['m1', 'm3', 'm2'], '向下拖到 1：落在原 index 1 的元素之后');
  assert.equal(movePlanItem(state, plan.id, 'm2', 1, { now: NOW }), true);
  assert.deepEqual(ids(), ['m1', 'm2', 'm3'], '向上拖到 1：落在原 index 1 的元素之前');

  assert.equal(movePlanItem(state, plan.id, 'missing', 0, { now: NOW }), false);
  assert.equal(movePlanItem(state, 'missing-plan', 'm1', 0, { now: NOW }), false);
  const single = createRelayState({ now: NOW });
  appendBlockToPlan(single, single.activePlanId, { title: 'only', prompt: 'x' }, { id: 'only', now: NOW });
  assert.equal(movePlanItem(single, single.activePlanId, 'only', 0, { now: NOW }), false, '只有一项时无处可移');
}

// updatePlanItem 的各个 Object.hasOwn 分支：传 undefined ＝ 没传，显式空串才是清空。
{
  const state = createRelayState({ now: NOW });
  const plan = state.plans[0];
  const item = appendBlockToPlan(state, plan.id, {
    title: '原标题', prompt: '原正文', negative: '原负面',
  }, { id: 'patch-target', now: NOW });
  const patch = body => updatePlanItem(state, plan.id, 'patch-target', body, { now: NOW });

  patch({ title: undefined, prompt: undefined, negative: undefined });
  assert.deepEqual(
    [item.title, item.prompt, item.negative],
    ['原标题', '原正文', '原负面'],
    'undefined 不该把字段清空（旧版只有 title 分支有兜底）',
  );
  patch({ enabled: false });
  assert.deepEqual([item.title, item.prompt, item.negative], ['原标题', '原正文', '原负面']);
  assert.equal(item.enabled, false);
  patch({ prompt: '', negative: '' });
  assert.deepEqual([item.prompt, item.negative], ['', ''], '显式空串才是清空');
  patch({ positive: '别名正文' });
  assert.equal(item.prompt, '别名正文', 'positive 是 prompt 的别名');
  patch({ weight: 0 });
  assert.equal(item.weight, 0.05, '权重 0 走 clamp，不是「没设权重」');
  patch({ weight: undefined });
  assert.equal(item.weight, 1, '不可解析的权重回落到 1（=不加权）');
  patch({ on: true });
  assert.equal(item.enabled, true);
  patch({ characterPrompts: [{ prompt: '1girl', negative: 'extra fingers' }, { prompt: '' }] });
  assert.deepEqual(item.characterPrompts, [{ label: 'char1', prompt: '1girl', negative: 'extra fingers' }]);

  assert.equal(updatePlanItem(state, plan.id, 'missing', { title: 'x' }, { now: NOW }), null);
  assert.equal(updatePlanItem(state, plan.id, 'patch-target', null, { now: NOW }), null);
}

/* 版本号未知一律当旧数据。旧写法 `Number(raw.version) < 2` 正好判反：
   缺失/'v1'/{} 得 NaN<2=false 被当成 v2，而 null/false/'' 得 0<2=true 反倒掉头。 */
{
  const order = version => normalizeRelayState({
    version,
    inbox: [
      { id: 'first', codexId: 'b', title: '第一条', prompt: 'x' },
      { id: 'second', codexId: 'b', title: '第二条', prompt: 'y' },
    ],
  }, { now: NOW }).inbox.map(item => item.title);
  const LEGACY = ['第二条', '第一条'];
  const CURRENT = ['第一条', '第二条'];
  for (const unknown of [undefined, 'v1', {}, Number.NaN, null, false, '']) {
    assert.deepEqual(order(unknown), LEGACY, `未知版本号 ${String(unknown)} 必须按旧数据掉头`);
  }
  assert.deepEqual(order(0), LEGACY);
  assert.deepEqual(order(1), LEGACY);
  assert.deepEqual(order('1'), LEGACY);
  assert.deepEqual(order(2), CURRENT);
  assert.deepEqual(order('2'), CURRENT);
  assert.deepEqual(order(3), CURRENT, '未来版本不掉头');
}

/* trimStateToBudget：localStorage 配额约 5MiB，而每条复制历史都内嵌整份 plan 快照。
   撞配额时 setItem 抛异常、整盘编辑存不下去，所以写盘前按字节预算丢最旧的历史。 */
{
  const state = createRelayState({ now: NOW });
  appendBlockToPlan(state, state.activePlanId, { title: '块', prompt: 'a'.repeat(200) }, { now: NOW });
  for (let i = 0; i < 6; i += 1) {
    recordCopyHistory(state, { target: 'nai' }, { id: `h${i}`, now: `2026-08-13T08:00:0${i}.000Z` });
  }
  const budget = Math.floor(serializeRelayState(state).length * 0.6);
  const planCount = state.plans.length;
  const inboxSnapshot = JSON.stringify(state.inbox);
  const itemCount = state.plans[0].items.length;

  const result = trimStateToBudget(state, budget);
  assert.equal(result.trimmed > 0, true);
  assert.equal(result.fits, true);
  assert.equal(serializeRelayState(state).length <= budget, true);
  assert.deepEqual(
    state.history.map(record => record.id),
    ['h5', 'h4', 'h3', 'h2', 'h1', 'h0'].slice(0, state.history.length),
    '必须从最旧的一端开始丢（history 是新在前）',
  );
  assert.equal(state.plans.length, planCount, 'plans 是用户手工资产，一根汗毛都不许动');
  assert.equal(state.plans[0].items.length, itemCount);
  assert.equal(JSON.stringify(state.inbox), inboxSnapshot, 'inbox 同样不许动');

  // ⚠ 历史丢光仍然超标：如实报数量并停手，绝不能空转成死循环
  const stubborn = createRelayState({ now: NOW });
  appendBlockToPlan(stubborn, stubborn.activePlanId, { title: '大块', prompt: 'x'.repeat(400) }, { now: NOW });
  for (let i = 0; i < 3; i += 1) recordCopyHistory(stubborn, { target: 'nai' }, { id: `k${i}`, now: NOW });
  const stuck = trimStateToBudget(stubborn, 10);
  assert.equal(stuck.trimmed, 3);
  assert.equal(stuck.fits, false);
  assert.equal(stubborn.history.length, 0);
  assert.equal(stubborn.plans[0].items.length, 1, '预算再紧也不能拿 plans 开刀');

  // 本来就放得下 / 预算非法：一条都不丢
  assert.deepEqual(trimStateToBudget(stubborn, 10_000_000), { trimmed: 0, fits: true });
  assert.deepEqual(trimStateToBudget(stubborn, Number.NaN), { trimmed: 0, fits: true });
  assert.deepEqual(trimStateToBudget(null, 10), { trimmed: 0, fits: true });
}

/* restoreHistoryAsPlan 接受调用方注入的锁定谓词：core 层不许 import state/access
   （它必须零 DOM 可直测），所以分级把关只能靠注入。 */
{
  const state = createRelayState({ now: NOW });
  const plan = state.plans[0];
  appendBlockToPlan(state, plan.id, { title: '安全块', prompt: 'safe' }, { id: 'safe-block', now: NOW });
  appendBlockToPlan(state, plan.id, {
    title: '成人块', prompt: 'adult', access: { nsfw: true },
  }, { id: 'adult-block', now: NOW });
  recordCopyHistory(state, { target: 'nai' }, { id: 'mixed', now: NOW });

  assert.equal(restoreHistoryAsPlan(state, 'mixed', {
    id: 'blocked-plan',
    now: NOW,
    isLocked: item => item.access?.nsfw === true,
  }), null, '任一项命中锁定谓词就整条拒绝恢复');
  assert.equal(state.plans.length, 1, '拒绝时不能留下半个新方案');
  assert.equal(state.activePlanId, plan.id);

  assert.equal(restoreHistoryAsPlan(state, 'mixed', {
    id: 'ok-plan', now: NOW, isLocked: () => false,
  })?.id, 'ok-plan', '谓词全不命中照常恢复');
  assert.equal(restoreHistoryAsPlan(state, 'mixed', { id: 'legacy-plan', now: NOW })?.id, 'legacy-plan', '不传谓词维持旧行为');
}

/* 空正文的 entry 不该把整条复制历史永久锁死：完整性判定只问「这条记录能不能独立核验权限」。
   旧版还要求每项都有正文，于是一个只有标题的词条就让「再次复制」「恢复为方案」全消失，
   开关全开也解不开，文案还谎称是权限问题。 */
{
  const state = createRelayState({ now: NOW });
  const plan = state.plans[0];
  appendEntryToPlan(state, plan.id, { id: 'title-only', codexId: 'book', title: '只有标题的词条' }, {
    id: 'empty-entry', now: NOW,
  });
  appendBlockToPlan(state, plan.id, { title: '有正文', prompt: 'alpha' }, { id: 'real-block', now: NOW });
  const record = recordCopyHistory(state, { target: 'nai' }, { id: 'with-empty-entry', now: NOW });
  assert.equal(record.snapshotComplete, true, '空正文 ≠ 无法核验权限');
  assert.equal(
    restoreHistoryAsPlan(state, 'with-empty-entry', { id: 'restored-empty', now: NOW })?.id,
    'restored-empty',
  );

  // 但缺 access 布尔的考古记录仍然 fail-closed，哪怕它自称 snapshotComplete
  const archaic = normalizeRelayState({
    version: 2,
    history: [{
      id: 'no-access',
      channel: 'positive',
      positive: 'x',
      snapshotComplete: true,
      plan: { id: 'p', items: [{ id: 'i', kind: 'block', prompt: 'x' }] },
    }],
  }, { now: NOW });
  assert.equal(archaic.history[0].snapshotComplete, false);
  assert.equal(restoreHistoryAsPlan(archaic, 'no-access', { now: NOW }), null);
}

// history 上限的选项名与非法值行为：两处必须同一套。
{
  const depth = options => {
    const state = createRelayState({ now: NOW });
    appendBlockToPlan(state, state.activePlanId, { title: 'b', prompt: 'a' }, { now: NOW });
    for (let i = 0; i < 5; i += 1) {
      recordCopyHistory(state, { target: 'nai' }, { id: `r${i}`, ...options, now: NOW });
    }
    return state.history.length;
  };
  assert.equal(depth({ limit: 3 }), 3, '既有的 limit 别名要继续认');
  assert.equal(depth({ historyLimit: 2 }), 2, 'historyLimit 是权威名字');
  assert.equal(depth({ historyLimit: 2, limit: 4 }), 2, '两个都给时 historyLimit 优先');
  assert.equal(depth({ limit: 0 }), 1, '非法值一致按 clamp，不是一个走默认值另一个 clamp');
  assert.equal(depth({ limit: -5 }), 1);
  assert.equal(depth({}), 5);

  /* ⚠ load/save/serialize 透传的 options 只认 historyLimit：`limit` 在 touchInboxEntry 里
     表示 inbox 上限，同名会打架（给 inbox 传 limit:2 会顺手把复制历史砍到 2 条）。 */
  const state = createRelayState({ now: NOW });
  appendBlockToPlan(state, state.activePlanId, { title: 'b', prompt: 'a' }, { now: NOW });
  for (let i = 0; i < 5; i += 1) recordCopyHistory(state, { target: 'nai' }, { id: `q${i}`, now: NOW });
  assert.equal(normalizeRelayState(state, { historyLimit: 2, now: NOW }).history.length, 2);
  assert.equal(normalizeRelayState(state, { historyLimit: 0, now: NOW }).history.length, 1);
  assert.equal(normalizeRelayState(state, { limit: 2, now: NOW }).history.length, 5, 'inbox 的 limit 不该殃及历史');
  assert.equal(normalizeRelayState(state, { now: NOW }).history.length, 5);
  assert.equal(TAG_RELAY_HISTORY_LIMIT, 20);
}

// 调用方明确写 positiveCount: 0 就是 0，不能被倒填成重算值。
{
  const explicit = normalizeRelayState({
    version: 2,
    history: [{
      id: 'explicit-zero',
      channel: 'negative',
      positive: 'a, b, c',
      negative: 'x',
      positiveCount: 0,
      negativeCount: 1,
      plan: { id: 'p', items: [] },
    }],
  }, { now: NOW });
  assert.equal(explicit.history[0].positiveCount, 0, '显式 0 必须被尊重');
  assert.equal(explicit.history[0].negativeCount, 1);

  const inferred = normalizeRelayState({
    version: 2,
    history: [{ id: 'inferred', channel: 'both', positive: 'a, b, c', plan: { id: 'p', items: [] } }],
  }, { now: NOW });
  assert.equal(inferred.history[0].positiveCount, 3, '没给才重算');
}

// 去重 key 归一化：压平内部空白，但不许把权重不同的 token 也当成同一个。
{
  const spaced = compilePlan({
    items: [{ enabled: true, weight: 1, prompt: 'soft  light, soft light, SOFT   LIGHT', negative: '', characterPrompts: [] }],
  }, { target: 'nai' });
  assert.deepEqual(spaced.positiveTokens, ['soft  light'], '保留第一次出现的写法');
  assert.deepEqual(spaced.positiveMerged, [{ token: 'soft  light', dropped: 2 }]);

  /* ⚠ 这两条是**正确**的现状，别顺手「优化」掉：
     `(cat:1.2)` 与 `(CAT:1.2)` 该合（只差大小写），`1.2::cat::` 与 `cat` 不该合（权重不同＝不同意思）。 */
  const weighted = compilePlan({
    items: [{ enabled: true, weight: 1, prompt: 'cat, 1.2::cat::, (cat:1.2), (CAT:1.2)', negative: '', characterPrompts: [] }],
  }, { target: 'nai' });
  assert.deepEqual(weighted.positiveTokens, ['cat', '1.2::cat::', '(cat:1.2)']);
  assert.deepEqual(weighted.positiveMerged, [{ token: '(cat:1.2)', dropped: 1 }]);
}

// 本地 hash key 必须把角色词也算进去，否则只差 characterPrompts 的两条会确定性撞 key、互相覆盖。
{
  const base = { title: '本地块', prompt: 'tag-a', negative: '' };
  const withChar = { ...base, characterPrompts: [{ prompt: '1girl' }] };
  const otherChar = { ...base, characterPrompts: [{ prompt: '1boy' }] };
  assert.notEqual(stableEntryKey(withChar), stableEntryKey(base));
  assert.notEqual(stableEntryKey(withChar), stableEntryKey(otherChar));
  // 归一化前后签名要一致，否则 normalize 一轮就分裂成两条
  assert.equal(
    stableEntryKey(withChar),
    stableEntryKey({ ...withChar, characterPrompts: [{ label: 'char1', prompt: '1girl', negative: '' }] }),
  );
  // 无标题条目：签名要和 normalizeRelayEntry 的 title 兜底对齐，否则 key 会漂移
  assert.equal(
    stableEntryKey({ prompt: 'x' }),
    stableEntryKey({ title: '未命名词条', prompt: 'x' }),
  );
}

console.log('tag relay core: all tests passed');
