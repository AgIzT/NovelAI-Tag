// 中转站分级门控回归：node tools/test_tag_relay_access.mjs
//
// 这里写的是**行为**断言：搭好 state / DOM 桩，跑真实模块，检查真实产物。
// 不再用正则去比对源码的字面写法——那种断言改个变量名就红、绕过门控却不一定红。
// 文件末尾保留两条静态断言，各自注明了为什么那一条只能静态测。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  TAG_RELAY_STORAGE_KEY,
  createRelayState,
  normalizeRelayEntry,
  normalizeRelayState,
  restoreHistoryAsPlan,
  serializeRelayState,
} from '../site/assets/app/tag-relay-core.js';
import { snapshotEntry, snapshotLocked } from '../site/assets/app/tag-relay-snapshot.js';
import { state } from '../site/assets/app/state.js';

const APP = new URL('../site/assets/app/', import.meta.url);

/* 分级开关（allowNsfw / allowR18g）和法典列表都是**内存**态，模块间共享同一个 state 对象。
   每组测试必须自己还原，否则前一组的撤权会顺手把后面几组染红，红得还与真实缺陷无关。 */
async function withAccess(patch, run) {
  const saved = {
    allowNsfw: state.allowNsfw,
    allowR18g: state.allowR18g,
    codexes: state.codexes,
    codex: state.codex,
  };
  Object.assign(state, {
    allowNsfw: false,
    allowR18g: false,
    codexes: [],
    codex: null,
  }, patch);
  try {
    return await run();
  } finally {
    Object.assign(state, saved);
  }
}

/* ============================================================
   1. snapshotEntry：入库那一刻把分级冻进快照
   ============================================================ */

// 中转站必须与主站 isR18gEntry 使用同一语义：rating / level 与路径任一命中都锁定。
await withAccess({}, () => {
  const base = { id: 'entry-1', title: 'entry', tags: 'tag', path: ['normal'] };
  assert.equal(snapshotEntry({ ...base, rating: 'r18g' }).access.r18g, true);
  assert.equal(snapshotEntry({ ...base, level: 'R18G' }).access.r18g, true);
  assert.equal(snapshotEntry({ ...base, path: ['r18g'] }).access.r18g, true);
  assert.equal(snapshotEntry(base).access.r18g, false);
});

/* 冻结的意义全在这里：入库时开关是开着的，之后用户关掉开关，这条**必须**被锁住。
   「当时是解锁状态存进来的」不能变成永久放行。 */
await withAccess({ allowNsfw: true, codexes: [{ id: 'adult-book', nsfw: true }] }, () => {
  const entry = { id: 'e1', title: '成人词条', tags: 'adult-tag', rating: 'r18', _srcCodexId: 'adult-book' };
  const snapshot = snapshotEntry(entry);
  assert.equal(snapshot.access.nsfw, true, '入库时就该把 NSFW 冻进快照，而不是留给日后现算');
  assert.equal(snapshotLocked(snapshot), false, '开关还开着时不该锁');

  state.allowNsfw = false;
  assert.equal(snapshotLocked(snapshot), true, '关掉开关后，早先存进来的这条必须立刻被锁住');
});

/* 整本 NSFW 的标记同样要冻住：法典日后被删掉（findCodexMeta 查不到）也不能因此放行。
   词条自身没有任何 rating，唯一的分级证据就是入库时那本书的 nsfw 标记。 */
await withAccess({ allowNsfw: true, codexes: [{ id: 'adult-book', nsfw: true }] }, () => {
  const snapshot = snapshotEntry({ id: 'e2', title: '无 rating 词条', tags: 'x', _srcCodexId: 'adult-book' });
  assert.equal(snapshot.access.nsfw, true);

  state.codexes = [];          // 法典被删/未加载
  state.allowNsfw = false;
  assert.equal(snapshotLocked(snapshot), true, '整本 NSFW 标记必须随快照冻住，查不到 meta 也要锁');
});

/* ============================================================
   2. snapshotLocked 的 fail-closed
   ============================================================ */

// 首版数据可能完全没有 access。保留下来的 codexId 仍要继承当前整本 NSFW 门控。
await withAccess({ codexes: [{ id: 'legacy-nsfw', nsfw: true }] }, () => {
  assert.equal(snapshotLocked({ codexId: 'legacy-nsfw', access: {} }), true, '没有 access 的首版数据要靠 codexId 回查整本 NSFW 标记');
});

// 已删法典的旧引用没有任何分级证据时，不能因查不到 meta 而 fail-open。
await withAccess({}, () => {
  assert.equal(snapshotLocked({ codexId: 'gone-book', entryId: 'adult', accessKnown: false, access: {} }), true, '查不到 meta 又没有分级证据时必须 fail-closed');
});

/* 自定义块是用户自己敲进去的正文，没有来源可查，被显式豁免于「未知来源一律锁」。
   这是有意的取舍（源码注释写明），锁在这里防止日后被"顺手收紧"成误锁普通块。 */
await withAccess({}, () => {
  assert.equal(snapshotLocked({ kind: 'block', accessKnown: false, access: {} }), false);
  assert.equal(
    snapshotLocked({ kind: 'block', accessKnown: false, access: { nsfw: true } }),
    true,
    '豁免只针对「未知来源」，块自己带了 NSFW 标记照样锁',
  );
});

/* ============================================================
   3. accessKnown 是黏性的：存一轮盘之后仍然是 false
   ------------------------------------------------------------
   这是整份文件最重要的一条回归防线。曾经的写法每次 normalize 都重新推断，
   而 normalize 自己恒写出 access:{nsfw,r18g}，于是 hasAccessEvidence 把自己的
   产物当成了分级证据 —— 存一轮盘，false 就翻回 true，fail-closed 静默失效。
   ============================================================ */

await withAccess({ allowNsfw: true, allowR18g: true }, () => {
  // 无 access、无 rating、无 path 的未知来源
  const seeded = normalizeRelayState({
    version: 2,
    inbox: [{ title: '来路不明', prompt: 'mystery-tag' }],
    plans: [{ id: 'p1', name: 'p1', items: [{ kind: 'entry', title: '来路不明', prompt: 'mystery-tag' }] }],
    activePlanId: 'p1',
  });
  assert.equal(seeded.inbox[0].accessKnown, false, '没有任何分级证据 → accessKnown 必须是 false');
  assert.equal(seeded.plans[0].items[0].accessKnown, false);
  assert.equal(
    snapshotLocked(seeded.inbox[0]),
    true,
    '两个开关全开也要锁：判不出分级的来源一律 fail-closed',
  );
  assert.equal(snapshotLocked(seeded.plans[0].items[0]), true);

  // serialize → parse → normalize：真实的存盘往返（serializeRelayState 自身还会再 normalize 一次）
  const roundTripped = normalizeRelayState(JSON.parse(serializeRelayState(seeded)));
  assert.equal(roundTripped.inbox[0].accessKnown, false, '存一轮盘后 accessKnown 不得翻回 true');
  assert.equal(roundTripped.plans[0].items[0].accessKnown, false);
  assert.equal(snapshotLocked(roundTripped.inbox[0]), true, '存盘往返后仍必须锁住');
  assert.equal(snapshotLocked(roundTripped.plans[0].items[0]), true);

  // 再存两轮，确认不是"只扛得住一次"
  let drifting = roundTripped;
  for (let round = 0; round < 2; round += 1) {
    drifting = normalizeRelayState(JSON.parse(serializeRelayState(drifting)));
    assert.equal(drifting.inbox[0].accessKnown, false, `第 ${round + 2} 轮存盘后仍必须是 false`);
  }
});

/* ============================================================
   4. hasAccessEvidence：到底什么算「有分级证据」
   （私有函数，通过 normalizeRelayEntry 的产物观察）
   ============================================================ */

await withAccess({}, () => {
  const known = source => normalizeRelayEntry(source).accessKnown;

  // —— 没有证据 ——
  assert.equal(known({ title: 't', prompt: 'p' }), false, '只有标题和正文 → 无证据');
  assert.equal(known({ title: 't', path: [] }), false, '空路径不是证据');
  assert.equal(known({ title: 't', rating: null }), false, 'null 字段等于没写');
  assert.equal(known({ title: 't', access: {} }), false, '空 access 对象不是证据');

  // —— 有证据 ——
  assert.equal(known({ path: ['角色'] }), true, '有分类路径就能按主站规则推断');
  assert.equal(known({ rating: 'safe' }), true, '写了 rating（哪怕是安全级）就是证据');
  assert.equal(known({ rating: '' }), true, '字段存在即视为证据：真实词条的 rating 常为空串，全锁会误伤普通条目');
  assert.equal(known({ level: 'r18' }), true);
  assert.equal(known({ access: { nsfw: false } }), true, '显式写了 access.nsfw=false 也是一次明确判定');
  assert.equal(known({ access: { r18g: false } }), true);
  assert.equal(known({ nsfw: false }), true);
  assert.equal(known({ sourceR18g: true }), true);

  // —— 黏性：显式的 accessKnown 是最终答案 ——
  assert.equal(
    known({ accessKnown: false, path: ['r18'], rating: 'r18' }),
    false,
    '显式 false 必须压过一切推断，否则 fail-closed 会被自己的产物解开',
  );
  assert.equal(known({ accessKnown: true, title: 't' }), true, '显式 true 不需要证据');
  assert.equal(known({ accessKnown: 'yes' }), false, '=== true 严格判定：非布尔真值不算已知');
  assert.equal(known({ accessKnown: 1 }), false);
});

/* ============================================================
   5. inferredAccess 的关键字表
   ============================================================ */

await withAccess({}, () => {
  const access = source => normalizeRelayEntry(source).access;

  assert.deepEqual(access({ path: ['nsfw'] }), { nsfw: true, r18g: false });
  assert.deepEqual(access({ path: ['R18'] }), { nsfw: true, r18g: false }, '大小写无关');
  assert.deepEqual(access({ path: ['限制级'] }), { nsfw: true, r18g: false });
  assert.deepEqual(access({ path: ['成人 / R18 分区'] }), { nsfw: true, r18g: false }, '子串命中即可');
  assert.deepEqual(access({ path: ['r18g'] }), { nsfw: true, r18g: true }, 'r18g 里含 r18，两个都命中');
  /* r18g 一律连带抬起 nsfw：r18g 本身就是成人内容，只标 r18g 不标 nsfw 是自相矛盾的状态。
     上面每一条 r18g 用例本来就是 {nsfw:true, r18g:true}（"r18g" 里含 "r18"、rating 也在 nsfw 表里），
     只有「重口」这条路径过去是例外。原先它不漏门，靠的是 ui.js 那句
     `state.allowR18g = Boolean(on) && state.allowNsfw` ——一条跨文件、无断言的隐式不变式；
     现在改由 normalizeAccess 自己保证，谁直接从 storage 恢复 allowR18g 都不会漏。 */
  assert.deepEqual(access({ path: ['重口'] }), { nsfw: true, r18g: true });
  assert.deepEqual(access({ path: ['风景'] }), { nsfw: false, r18g: false });

  assert.deepEqual(access({ rating: 'restricted' }), { nsfw: true, r18g: false });
  assert.deepEqual(access({ rating: 'r18' }), { nsfw: true, r18g: false });
  assert.deepEqual(access({ rating: 'nsfw' }), { nsfw: true, r18g: false });
  assert.deepEqual(access({ rating: 'r18g' }), { nsfw: true, r18g: true });
  assert.deepEqual(access({ level: 'R18G' }), { nsfw: true, r18g: true }, 'level 是 rating 的同义字段');
  assert.deepEqual(access({ rating: 'safe' }), { nsfw: false, r18g: false });

  // 推断出来的分级必须真的能锁住东西，而不是只写在字段里
  state.allowR18g = false;
  state.allowNsfw = true;
  assert.equal(snapshotLocked(normalizeRelayEntry({ path: ['重口'] })), true);
  assert.equal(snapshotLocked(normalizeRelayEntry({ path: ['风景'] })), false);
});

/* ============================================================
   6. 历史记录的 snapshotComplete：能不能独立核验权限
   ============================================================ */

await withAccess({}, () => {
  const full = { kind: 'entry', title: 'a', prompt: 'a-tag', access: { nsfw: false, r18g: false } };
  const complete = record => normalizeRelayState({
    version: 2,
    plans: [{ id: 'p', name: 'p', items: [] }],
    activePlanId: 'p',
    history: [record],
  }).history[0].snapshotComplete;

  assert.equal(
    complete({ id: 'h1', snapshotComplete: true, positive: 'a-tag', plan: { id: 'p1', name: 'p1', items: [full] } }),
    true,
  );
  /* 空正文的词条块**不再**让整条记录降级。以前会——于是一条空块能让整条复制历史
     永久不可恢复（「再次复制」「恢复为方案」全消失），界面还谎称是权限问题。 */
  assert.equal(
    complete({
      id: 'h2',
      snapshotComplete: true,
      positive: 'a-tag',
      plan: { id: 'p2', name: 'p2', items: [full, { kind: 'entry', title: '空块', prompt: '', access: { nsfw: false, r18g: false } }] },
    }),
    true,
    '空正文不是权限问题，不该让整条历史永久锁死',
  );
  assert.equal(
    complete({ id: 'h3', snapshotComplete: true, positive: 'a-tag', plan: { id: 'p3', name: 'p3', items: [{ kind: 'entry', title: 'b', prompt: 'b-tag' }] } }),
    false,
    '有一项缺 access 布尔 → 无法独立核验权限',
  );
  assert.equal(
    complete({ id: 'h4', snapshotComplete: true, positive: 'a-tag', plan: { id: 'p4', name: 'p4', items: [{ ...full, access: { nsfw: true } }] } }),
    false,
    'access 缺 r18g 一半也不算完整',
  );
  assert.equal(
    complete({ id: 'h5', positive: 'a-tag', plan: { id: 'p5', name: 'p5', items: [full] } }),
    false,
    '没有显式 snapshotComplete 标记的旧记录一律不认',
  );
});

/* ============================================================
   7. restoreHistoryAsPlan 的 isLocked 谓词
   ------------------------------------------------------------
   core 不许 import state/access（它要能零 DOM 直测），所以谓词由调用方注入；
   真正的不变式在 core 里兜：任一条目命中就整条拒绝，绝不放一半内容进新方案。
   ============================================================ */

await withAccess({}, () => {
  const items = [
    { kind: 'block', id: 'i1', title: '普通块', prompt: 'sunlight', access: { nsfw: false, r18g: false } },
    { kind: 'entry', id: 'i2', title: '成人词条', prompt: 'adult-tag', access: { nsfw: true, r18g: false }, accessKnown: true },
  ];
  const seed = () => normalizeRelayState({
    version: 2,
    plans: [{ id: 'p', name: 'p', items: [] }],
    activePlanId: 'p',
    history: [{
      id: 'h-ok',
      label: '记录',
      snapshotComplete: true,
      positive: 'sunlight, adult-tag',
      plan: { id: 'src', name: '源方案', items },
    }],
  });

  // 命中即整条拒绝
  const blocked = seed();
  assert.equal(
    restoreHistoryAsPlan(blocked, 'h-ok', { isLocked: item => item.title === '成人词条' }),
    null,
    '谓词命中任一条目就必须整条拒绝恢复',
  );
  assert.equal(blocked.plans.length, 1, '拒绝时不得留下半份新方案');
  assert.equal(blocked.activePlanId, 'p', '拒绝时不得切换活动方案');

  // 谓词对第一项命中同样整条拒绝（不是只看最后一项）
  const blockedFirst = seed();
  assert.equal(
    restoreHistoryAsPlan(blockedFirst, 'h-ok', { isLocked: item => item.title === '普通块' }),
    null,
    '命中的是第一项也一样整条拒绝',
  );
  assert.equal(blockedFirst.plans.length, 1);

  // 不命中即放行
  const allowed = seed();
  const restored = restoreHistoryAsPlan(allowed, 'h-ok', { isLocked: () => false });
  assert.ok(restored, '没有任何条目被锁时必须能恢复');
  assert.equal(allowed.plans.length, 2);
  assert.equal(allowed.activePlanId, restored.id);
  assert.deepEqual(restored.items.map(item => item.title), ['普通块', '成人词条']);

  // 不传谓词时保持原行为（调用方自己负责）
  const bare = seed();
  assert.ok(restoreHistoryAsPlan(bare, 'h-ok'));

  // 谓词再宽松也救不了缺快照的旧记录
  const stale = normalizeRelayState({
    version: 2,
    plans: [{ id: 'p', name: 'p', items: [] }],
    activePlanId: 'p',
    history: [{ id: 'h-stale', positive: 'legacy', plan: { id: 'x', name: 'x', items } }],
  });
  assert.equal(
    restoreHistoryAsPlan(stale, 'h-stale', { isLocked: () => false }),
    null,
    'snapshotComplete 不成立时，谓词再宽松也不许恢复',
  );
});

/* ============================================================
   8. 侧栏「编排」分区：混合方案编译 + 复制历史三分支
   ------------------------------------------------------------
   safePlan / historyLockReason 都是 tag-relay-compose.js 的私有函数，只能连着
   真实 DOM 一起驱动。这里搭一套按选择器惰性生成节点的假 DOM：新增 ref 不会让
   桩崩掉，断言只看用户真能看到的产物（输出框文本、历史卡片有没有可用按钮）。
   ============================================================ */

function fakeClassList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
    contains: name => values.has(name),
    toggle(name, force) {
      const on = force === undefined ? !values.has(name) : Boolean(force);
      if (on) values.add(name);
      else values.delete(name);
      return on;
    },
  };
}

function fakeElement(tag = 'div') {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    listeners: new Map(),
    dataset: {},
    style: {},
    attrs: new Map(),
    classList: fakeClassList(),
    className: '',
    textContent: '',
    value: '',
    title: '',
    type: '',
    dateTime: '',
    hidden: false,
    disabled: false,
    draggable: false,
    tabIndex: 0,
    isConnected: true,
    offsetWidth: 1,
    offsetParent: {},
    addEventListener(type, listener) {
      node.listeners.set(type, [...(node.listeners.get(type) || []), listener]);
    },
    removeEventListener() {},
    /* 一屏化之后 setupRelayCompose 会 root.closest('.tag-relay-rail')：方案选择在栏头、
       编辑器与成品是栏级浮层，ref 的作用域得放宽到整条栏。这个假 DOM 是「按选择器惰性生成」
       的单层结构，没有真的父链，所以直接把自己当成那条栏返回——本测试只关心能不能查到节点。 */
    closest(selector) {
      return String(selector).includes('tag-relay-rail') ? node : null;
    },
    fire(type, event = {}) {
      for (const listener of node.listeners.get(type) || []) {
        listener({ type, target: node, currentTarget: node, preventDefault() {}, stopPropagation() {}, ...event });
      }
    },
    setAttribute(name, value) { node.attrs.set(name, String(value)); },
    getAttribute(name) { return node.attrs.has(name) ? node.attrs.get(name) : null; },
    removeAttribute(name) { node.attrs.delete(name); },
    append(...nodes) { node.children.push(...nodes); },
    appendChild(child) { node.children.push(child); return child; },
    replaceChildren(...nodes) { node.children = [...nodes]; },
    remove() {},
    contains(other) { return other === node || node.children.some(child => child.contains?.(other)); },
    focus() {},
    select() {},
    setSelectionRange() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return node;
}

/* 卡片内所有可见文字（含子节点），断言「锁住的内容一个字都不许露出来」时用。 */
function visibleText(node) {
  if (!node) return '';
  return [node.textContent || '', ...(node.children || []).map(visibleText)].join(' ');
}

function buttonsIn(node) {
  if (!node) return [];
  const own = node.tagName === 'BUTTON' ? [node.textContent] : [];
  return [...own, ...(node.children || []).flatMap(buttonsIn)];
}

const savedGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  localStorage: globalThis.localStorage,
  HTMLElement: globalThis.HTMLElement,
  requestAnimationFrame: globalThis.requestAnimationFrame,
};
const storage = new Map();
const pool = new Map();
const relayRoot = fakeElement('section');
relayRoot.querySelector = selector => {
  if (!pool.has(selector)) pool.set(selector, fakeElement('div'));
  return pool.get(selector);
};
const ref = selector => relayRoot.querySelector(selector);

globalThis.HTMLElement = class HTMLElement {};
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: true, addEventListener() {} }),
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  innerWidth: 1200,
  innerHeight: 800,
  performance,
};
globalThis.requestAnimationFrame = callback => { callback(); return 1; };
globalThis.localStorage = {
  getItem: key => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: key => { storage.delete(key); },
};
globalThis.document = {
  activeElement: null,
  body: fakeElement('body'),
  documentElement: fakeElement('html'),
  addEventListener() {},
  removeEventListener() {},
  createElement: tag => fakeElement(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
};

try {
  const LOCKED_ITEM = {
    kind: 'entry',
    id: 'locked-1',
    title: '成人词条',
    prompt: 'adult-positive',
    negative: 'adult-negative',
    rating: 'r18',
    codexId: 'c1',
    entryId: 'x1',
    access: { nsfw: true, r18g: false },
    accessKnown: true,
  };
  const PLAIN_ITEM = {
    kind: 'block',
    id: 'plain-1',
    title: '普通块',
    prompt: 'sunlight',
    negative: 'blurry',
    access: { nsfw: false, r18g: false },
  };

  storage.set(TAG_RELAY_STORAGE_KEY, JSON.stringify(normalizeRelayState({
    version: 2,
    inbox: [],
    plans: [{ id: 'plan-1', name: '混合方案', items: [PLAIN_ITEM, LOCKED_ITEM] }],
    activePlanId: 'plan-1',
    history: [
      {
        id: 'h-usable',
        label: '可用记录',
        snapshotComplete: true,
        channel: 'positive',
        positive: 'sunlight',
        plan: { id: 'sp1', name: '普通方案', items: [PLAIN_ITEM] },
      },
      {
        id: 'h-locked',
        label: '含锁定内容',
        snapshotComplete: true,
        channel: 'positive',
        positive: 'adult-positive',
        plan: { id: 'sp2', name: '成人方案', items: [LOCKED_ITEM] },
      },
      {
        // 有输出、方案却是空的：无法证明这段输出来自哪些权限范围
        id: 'h-empty-items',
        label: '空方案记录',
        snapshotComplete: true,
        channel: 'positive',
        positive: 'orphan-output',
        plan: { id: 'sp3', name: '空方案', items: [] },
      },
      {
        // 条目缺 access 布尔：normalizeHistoryRecord 会把 snapshotComplete 打回 false
        id: 'h-no-access',
        label: '旧版记录',
        snapshotComplete: true,
        channel: 'positive',
        positive: 'legacy-output',
        plan: { id: 'sp4', name: '旧方案', items: [{ kind: 'entry', title: '旧条目', prompt: 'legacy-output' }] },
      },
    ],
  })));

  const compose = await import('../site/assets/app/tag-relay-compose.js');

  await withAccess({}, async () => {
    const view = compose.setupRelayCompose(relayRoot);

    /* —— 混合方案编译：受限块的 tag 一个字都不许进成品 —— */
    assert.equal(ref('#relayPositiveOutput').value, 'sunlight');
    assert.equal(ref('#relayNegativeOutput').value, 'blurry');
    assert.doesNotMatch(ref('#relayPositiveOutput').value, /adult-positive/);
    assert.doesNotMatch(ref('#relayNegativeOutput').value, /adult-negative/, '负向通道同样要摘掉受限块');
    assert.equal(ref('#relayCopyPositive').disabled, false);

    // 开关打开后同一方案要能编出完整成品（证明上面不是把内容永久丢了）
    state.allowNsfw = true;
    view.render();
    assert.equal(ref('#relayPositiveOutput').value, 'sunlight, adult-positive');
    assert.equal(ref('#relayNegativeOutput').value, 'blurry, adult-negative');

    /* —— 复制历史的三条分支 —— */
    state.allowNsfw = false;
    view.render();
    ref('#relayHistoryToggle').fire('click');   // 展开历史面板

    const cards = () => ref('#relayHistoryList').children;
    assert.equal(cards().length, 4);
    const [usable, locked, emptyItems, noAccess] = cards();

    // ① 完整且未锁：显示输出预览，两个动作按钮都在
    assert.match(visibleText(usable), /sunlight/);
    assert.equal(buttonsIn(usable).length, 2, '可用记录必须同时提供「再次复制」和「恢复为方案」');

    // ② items.some(itemLocked)：正文不得露出，动作按钮必须撤掉
    assert.doesNotMatch(visibleText(locked), /adult-positive/, '锁定记录的明文不许出现在卡片上');
    assert.equal(buttonsIn(locked).length, 0);

    // ③ 空 items 却有输出 → 无法核验，按 stale 处理
    assert.doesNotMatch(visibleText(emptyItems), /orphan-output/);
    assert.equal(buttonsIn(emptyItems).length, 0);

    // ④ 条目缺 access 布尔 → snapshotComplete 被打回 false，同样按 stale 处理
    assert.doesNotMatch(visibleText(noAccess), /legacy-output/);
    assert.equal(buttonsIn(noAccess).length, 0);

    /* stale 与 locked 的解释必须是两句不同的话：「开开关就能解锁」只对 locked 成立，
       对 stale 是死路，混为一谈等于骗用户去试一个永远不会成功的操作。 */
    assert.notEqual(visibleText(locked), visibleText(emptyItems));
    assert.notEqual(visibleText(locked), visibleText(noAccess));

    // 开回权限：locked 那条复活，两条 stale 永远不会
    state.allowNsfw = true;
    view.render();
    const [, unlockedCard, stillEmpty, stillNoAccess] = cards();
    assert.match(visibleText(unlockedCard), /adult-positive/, '重新开启权限后锁定记录必须恢复可用');
    assert.equal(buttonsIn(unlockedCard).length, 2);
    assert.equal(buttonsIn(stillEmpty).length, 0, '缺快照是数据缺陷，开关全开也解不开');
    assert.equal(buttonsIn(stillNoAccess).length, 0);
  });

  /* ============================================================
     9. copyText 的 accessGuard：抛异常必须 fail-closed
     ============================================================ */

  const { copyText } = await import('../site/assets/app/copy.js');

  const spyClipboard = () => {
    const record = { writes: [] };
    record.clipboardOptions = {
      navigatorApi: { clipboard: { writeText: async value => { record.writes.push(value); } } },
      documentApi: { execCommand() { record.writes.push('execCommand'); return true; } },
    };
    return record;
  };

  await withAccess({}, async () => {
    const thrown = spyClipboard();
    const blocked = await copyText('secret', '已复制', null, {
      accessGuard: () => { throw new Error('分级状态读取失败'); },
      clipboardOptions: thrown.clipboardOptions,
      manualFallback: false,
    });
    assert.deepEqual(blocked, { ok: false, blocked: true }, 'accessGuard 抛异常 = 判不出来 = 拒绝');
    assert.deepEqual(thrown.writes, [], '拒绝时一个字节都不许进剪贴板');

    const denied = spyClipboard();
    assert.deepEqual(
      await copyText('secret', '已复制', null, { accessGuard: () => false, clipboardOptions: denied.clipboardOptions, manualFallback: false }),
      { ok: false, blocked: true },
    );
    assert.deepEqual(denied.writes, []);

    const allowed = spyClipboard();
    const ok = await copyText('plain', '已复制', null, {
      accessGuard: () => true,
      clipboardOptions: allowed.clipboardOptions,
      manualFallback: false,
    });
    assert.equal(ok.ok, true, '守卫放行时必须照常复制，否则测的就不是门控而是「全都不许复制」');
    assert.deepEqual(allowed.writes, ['plain']);
  });

  /* ============================================================
     10. scrubClipboardFallback：撤权时真的把 textarea 清空
     ============================================================ */

  const { scrubClipboardFallback } = await import('../site/assets/app/clipboard-fallback.js');

  {
    const savedGetElementById = globalThis.document.getElementById;
    try {
      globalThis.document.getElementById = () => null;
      assert.equal(scrubClipboardFallback(), false, '面板从未打开过时安静返回 false');

      const area = fakeElement('textarea');
      area.value = '已锁定的成人明文';
      const mask = fakeElement('div');
      mask.id = 'clipboardFallback';
      mask.hidden = false;                 // 面板正开着
      mask.querySelector = () => area;
      globalThis.document.getElementById = id => (id === 'clipboardFallback' ? mask : null);

      assert.equal(scrubClipboardFallback({ historyMode: 'none' }), true);
      assert.equal(area.value, '', '撤权后 textarea 里不能再留着原文');
      assert.equal(mask.hidden, true, '清空之后面板本身也要关掉');
    } finally {
      globalThis.document.getElementById = savedGetElementById;
    }
  }
} finally {
  for (const [name, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
}

/* ============================================================
   11. 只能静态测的架构约束
   ============================================================ */

{
  const [snapshotSource, coreSource] = await Promise.all([
    readFile(new URL('tag-relay-snapshot.js', APP), 'utf8'),
    readFile(new URL('tag-relay-core.js', APP), 'utf8'),
  ]);

  // 注释里当然可以谈 localStorage（那正是解释「为什么不读盘」的地方），只查真实代码
  const code = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  /* 只能静态测的理由：读盘拿到的**恰好是过期值**这件事没法在单进程里稳定复现——
     ui.js 是在会话内直接改 state.allowNsfw 的，同标签页的写入根本不触发 storage 事件。
     一旦 snapshotLocked 改成读 localStorage，行为测试里的假 storage 反而会跟着一起对，
     真实浏览器里才在用户关掉开关的那一刻放行。所以这条只能盯住「源码里不许出现」。 */
  assert.doesNotMatch(
    code(snapshotSource),
    /localStorage|sessionStorage/,
    'snapshotLocked 判分级只许读内存里的 state，读盘会读到过期值',
  );

  /* 只能静态测的理由：core 在 Node 里本来就能 import 到 state/access（跑得通不代表没违规），
     真正要守的是「core 必须零 DOM、可直测」这条结构约束——它只在依赖图上体现。
     restoreHistoryAsPlan 的 isLocked 谓词由调用方注入，正是这条约束的产物。 */
  assert.doesNotMatch(
    code(coreSource),
    /from\s+'\.\/(state|access|ui|data|media)\.js'/,
    'tag-relay-core.js 必须保持零 DOM、零分级状态依赖，分级判定只能由调用方注入',
  );
}

console.log('tag relay access: all tests passed');
