import assert from 'node:assert/strict';

import {
  TAG_RELAY_STORAGE_KEY,
  loadRelayState,
  recordCopyHistory,
  saveRelayState,
  touchInboxEntry,
} from '../site/assets/app/tag-relay-core.js';

const LOCK_KEY = `${TAG_RELAY_STORAGE_KEY}:lock`;
const SIGNAL_KEY = `${TAG_RELAY_STORAGE_KEY}:signal`;

const previousStorage = globalThis.localStorage;
const previousDocument = globalThis.document;
const previousWindow = globalThis.window;
const previousWarn = console.warn;
const previousSetTimeout = globalThis.setTimeout;

const values = new Map();
/* 配额只对主 key 生效：撞墙时信号 key 仍要能写，才能验到「写失败会补发一条 all」。 */
let quotaLimit = Infinity;
const storage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => {
    const text = String(value);
    if (key === TAG_RELAY_STORAGE_KEY && text.length > quotaLimit) {
      const error = new Error('storage is full');
      error.name = 'QuotaExceededError';
      throw error;
    }
    values.set(key, text);
  },
  removeItem: key => values.delete(key),
};

/* toast 走 document.querySelector('#toast')，给它一个够用的假节点就能把文案捞出来。 */
function fakeElement() {
  const element = {
    className: '',
    textContent: '',
    type: '',
    tabIndex: 0,
    offsetWidth: 0,
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    contains: () => false,
    querySelector: () => null,
    setAttribute() {},
    removeAttribute() {},
    appendChild(child) { element.children.push(child); return child; },
    replaceChildren(...kids) { element.children = kids; },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    blur() {},
  };
  return element;
}

const toastNode = fakeElement();
const lastToast = () => toastNode.children[0]?.textContent || '';

const handlers = new Map();
const fire = (type, event) => {
  for (const handler of handlers.get(type) || []) handler(event);
};

const warnings = [];

globalThis.localStorage = storage;
globalThis.document = {
  activeElement: null,
  querySelector: selector => (selector === '#toast' ? toastNode : null),
  createElement: () => fakeElement(),
};
globalThis.window = {
  addEventListener(type, handler) {
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type).push(handler);
  },
  removeEventListener() {},
};
console.warn = (...args) => { warnings.push(args.map(value => String(value?.message ?? value)).join(' ')); };
/* toast 会排一个 1.6 秒的隐藏定时器，unref 掉免得测试跑完还挂着不退出。 */
globalThis.setTimeout = (fn, ms) => {
  const timer = previousSetTimeout(fn, ms);
  timer?.unref?.();
  return timer;
};

try {
  const store = await import(`../site/assets/app/tag-relay-store.js?test=${Date.now()}`);
  const entry = id => ({
    key: `entry:test:${id}`,
    codexId: 'test',
    entryId: id,
    title: `词条 ${id}`,
    prompt: `tag-${id}`,
  });

  const events = [];
  store.subscribeRelay((_, meta) => events.push(meta));
  store.setupRelayStore();

  assert.equal((await store.commitRelay(next => touchInboxEntry(next, entry('one')), { changed: 'inbox' })).ok, true);

  // 模拟另一标签页在本模块尚未收到 storage 事件时写入；下一次本地提交必须先重读磁盘。
  const external = loadRelayState(storage);
  touchInboxEntry(external, entry('two'));
  assert.equal(saveRelayState(external, storage), true);
  assert.equal((await store.commitRelay(next => touchInboxEntry(next, entry('three')), { changed: 'inbox' })).ok, true);
  assert.deepEqual(
    loadRelayState(storage).inbox.map(item => item.entryId),
    ['three', 'two', 'one'],
    '基于旧内存提交不得覆盖另一标签页刚写入的词条',
  );

  // localStorage.clear() 之后即使 storage 事件尚未处理，也不能把旧内存整份复活。
  values.delete(TAG_RELAY_STORAGE_KEY);
  assert.equal((await store.commitRelay(next => touchInboxEntry(next, entry('fresh')), { changed: 'inbox' })).ok, true);
  assert.deepEqual(loadRelayState(storage).inbox.map(item => item.entryId), ['fresh']);
  assert.equal(values.has(LOCK_KEY), false, '事务锁必须在写入后释放');

  /* 内存与磁盘必须字节一致：内存换的若是未经 normalize 的那份，
     将来任何加进 normalize 的规整都会让两边悄悄分叉。 */
  assert.equal(
    JSON.stringify(store.relayState()),
    values.get(TAG_RELAY_STORAGE_KEY),
    'relayState() 必须与磁盘上的字节完全一致',
  );

  // 本地提交要把脏区写进信号，对端才可能只重绘一块。
  assert.equal(JSON.parse(values.get(SIGNAL_KEY)).changed, 'inbox', '提交必须广播自己的脏区');

  /* ⚠ 以下三段验的是**没有 navigator.locks 时的同步兜底**。首选路径是 Web Locks——
     那是浏览器给的真互斥量，压根不看 localStorage 里那把锁，所以这几段预置的"他人锁"
     在首选路径下本就该被忽略（Node 24 自带 navigator.locks，不遮掉的话这里会假绿）。 */
  Object.defineProperty(globalThis.navigator, 'locks',
    { value: undefined, configurable: true, writable: true });
  // ---- 锁竞争：未过期的他人锁 ----
  const rawBeforeLock = values.get(TAG_RELAY_STORAGE_KEY);
  const signalBeforeLock = values.get(SIGNAL_KEY);
  // ⚠ 一把合法的锁剩余寿命不会超过一个 TTL(2s)；写 5s 会被当成时钟错位的脏锁抢占掉。
  values.set(LOCK_KEY, JSON.stringify({ token: 'other-tab', expiresAt: Date.now() + 1_500 }));
  const busy = await store.commitRelay(next => touchInboxEntry(next, entry('locked')), { changed: 'inbox' });
  assert.equal(busy.ok, false, '锁被别的标签页占着时不得提交');
  assert.equal(values.get(TAG_RELAY_STORAGE_KEY), rawBeforeLock, '拿不到锁就一个字节都不能写盘');
  assert.equal(values.get(SIGNAL_KEY), signalBeforeLock, '拿不到锁就不该广播脏区');
  assert.equal(JSON.parse(values.get(LOCK_KEY)).token, 'other-tab', '不得抢走未过期的他人锁');
  assert.match(lastToast(), /另一个标签页/, '拿不到锁要说是并发，不能说成存储权限');
  values.delete(LOCK_KEY);

  // ---- 锁竞争：已过期的残留锁可抢占 ----
  values.set(LOCK_KEY, JSON.stringify({ token: 'expired-tab', expiresAt: Date.now() - 1 }));
  assert.equal(
    (await store.commitRelay(next => touchInboxEntry(next, entry('expired')), { changed: 'inbox' })).ok,
    true,
    '已过期的残留锁必须能被抢占',
  );
  assert.equal(values.has(LOCK_KEY), false, '抢占后同样要释放锁');

  // ---- 锁竞争：系统时钟回拨造成的 far-future 脏锁 ----
  values.set(LOCK_KEY, JSON.stringify({ token: 'skewed-tab', expiresAt: Date.now() + 3_600_000 }));
  assert.equal(
    (await store.commitRelay(next => touchInboxEntry(next, entry('skew')), { changed: 'inbox' })).ok,
    true,
    'expiresAt 远超一个 TTL 只可能是时钟错位，必须当脏锁抢占',
  );
  assert.equal(values.has(LOCK_KEY), false);
  /* 兜底路径验完，把真实的 Web Locks 放回去。 */
  delete globalThis.navigator.locks;

  // ---- mutator 抛异常 ----
  const rawBeforeThrow = values.get(TAG_RELAY_STORAGE_KEY);
  const memoryBeforeThrow = JSON.stringify(store.relayState());
  warnings.length = 0;
  const thrown = await store.commitRelay(() => { throw new Error('mutator-boom'); }, { changed: 'inbox' });
  assert.equal(thrown.ok, false);
  assert.equal(values.get(TAG_RELAY_STORAGE_KEY), rawBeforeThrow, 'mutator 抛异常不得污染磁盘');
  assert.equal(JSON.stringify(store.relayState()), memoryBeforeThrow, 'mutator 抛异常不得污染内存');
  assert.equal(values.has(LOCK_KEY), false, '异常路径也必须释放锁');
  assert.ok(warnings.some(line => line.includes('mutator-boom')), 'mutator 异常必须留下 console 记录');
  assert.doesNotMatch(lastToast(), /存储权限/, 'mutator 异常不该被报成存储权限问题');

  // ---- 配额：撞墙后自动裁剪最旧的复制历史再试一次 ----
  const bulk = 'copy-tag-'.repeat(220);
  for (let index = 0; index < 6; index += 1) {
    assert.equal((await store.commitRelay(next => recordCopyHistory(next, {
      label: `记录${index}`,
      target: 'nai',
      channel: 'both',
      output: { positive: `${bulk}${index}`, negative: '', positiveCount: 1, negativeCount: 0 },
    }), { changed: 'history' })).ok, true);
  }
  assert.equal(store.relayState().history.length, 6);

  quotaLimit = values.get(TAG_RELAY_STORAGE_KEY).length;   // 再长一个字节就撞墙
  const trimmedCommit = await store.commitRelay(next => touchInboxEntry(next, entry('quota')), { changed: 'inbox' });
  assert.equal(trimmedCommit.ok, true, '撞配额后应当裁剪历史并重试成功');
  assert.match(lastToast(), /已自动清理 \d+ 条最旧的复制历史/, '配额撞墙的提示要指向复制历史，不是存储权限');
  const survivors = store.relayState().history.map(item => item.label);
  assert.ok(survivors.length < 6, '必须真的丢掉了历史');
  assert.deepEqual(
    survivors,
    Array.from({ length: survivors.length }, (_, index) => `记录${5 - index}`),
    '只能从最旧的一端丢',
  );
  assert.equal(
    store.relayState().inbox[0].entryId,
    'quota',
    '重试成功后这次提交的改动必须生效',
  );
  assert.equal(
    JSON.stringify(store.relayState()),
    values.get(TAG_RELAY_STORAGE_KEY),
    '裁剪重试后内存仍须与磁盘一致',
  );
  quotaLimit = Infinity;

  // ---- 配额：裁剪也救不回来时，磁盘与内存都必须保持旧值 ----
  const rawBeforeDoom = values.get(TAG_RELAY_STORAGE_KEY);
  const memoryBeforeDoom = JSON.stringify(store.relayState());
  quotaLimit = 10;
  const doomed = await store.commitRelay(next => touchInboxEntry(next, entry('doomed')), { changed: 'inbox' });
  assert.equal(doomed.ok, false);
  assert.equal(values.get(TAG_RELAY_STORAGE_KEY), rawBeforeDoom, '先落盘再换内存：写失败必须保住磁盘旧值');
  assert.equal(JSON.stringify(store.relayState()), memoryBeforeDoom, '先落盘再换内存：写失败时内存不得改变');
  assert.equal(values.has(LOCK_KEY), false, '配额失败路径也必须释放锁');
  assert.match(lastToast(), /已存满/, '救不回来时也要指向复制历史');
  quotaLimit = Infinity;

  // ---- pageshow：只有真从 bfcache 回来才重载 ----
  const beforePageshow = events.length;
  fire('pageshow', { persisted: false });
  assert.equal(events.length, beforePageshow, '普通首次加载的 pageshow 不该触发全量重载');
  fire('pageshow', { persisted: true });
  assert.equal(events.length, beforePageshow + 1, '从 bfcache 回来必须重载');
  assert.equal(events.at(-1).source, 'pageshow');

  // ---- storage：认 storageArea，别把 sessionStorage.clear() 当成自己被清空 ----
  const sessionArea = { getItem: () => null, setItem() {}, removeItem() {} };
  const beforeStorage = events.length;
  fire('storage', { key: null, storageArea: sessionArea });
  assert.equal(events.length, beforeStorage, '别的 storage 区域被清空不该触发中转站重载');
  fire('storage', { key: LOCK_KEY, storageArea: storage });
  assert.equal(events.length, beforeStorage, '写事务锁不该引起对端重载');

  // ---- 跨标签页同步：信号先到只记脏区，主 key 的事件才真读盘 ----
  fire('storage', {
    key: SIGNAL_KEY,
    newValue: JSON.stringify({ changed: 'inbox', rev: 'peer-1' }),
    storageArea: storage,
  });
  assert.equal(events.length, beforeStorage, '信号本身不该触发重读');
  fire('storage', { key: TAG_RELAY_STORAGE_KEY, storageArea: storage });
  assert.equal(events.at(-1).changed, 'inbox', '对端同步必须沿用信号给出的脏区');
  fire('storage', { key: TAG_RELAY_STORAGE_KEY, storageArea: storage });
  assert.equal(events.at(-1).changed, 'all', '没有信号（或信号已消费）时退回全量');
  fire('storage', { key: null, storageArea: storage });
  assert.equal(events.at(-1).changed, 'all', 'localStorage 整体被清空必须全量重载');

  // ---- Web Locks 必须真的被用上 ----
  /* ⚠ 光靠「两笔并发都成功」区分不出走没走真互斥量：Node 没有真并行，同步兜底那条路
     也会自然串行，两条路径**都**是绿的（实测把 withRelayLock 强制退回兜底，下面那段并发
     测试照样全过）。所以这条直接监视 navigator.locks.request 有没有被调用——它才是
     「有真锁就必须用真锁」这条不变式的唯一有牙断言。 */
  const realLocks = globalThis.navigator.locks;
  const lockCalls = [];
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    writable: true,
    value: {
      request: (name, options, callback) => {
        lockCalls.push({ name, mode: options?.mode });
        return realLocks.request(name, options, callback);
      },
    },
  });
  const spied = await store.commitRelay(next => touchInboxEntry(next, entry('spy')), { changed: 'inbox' });
  delete globalThis.navigator.locks;
  assert.equal(spied.ok, true, '经 Web Locks 的提交同样要成功');
  assert.equal(lockCalls.length, 1, 'navigator.locks 可用时，提交必须经它排队，不能走同步兜底');
  assert.equal(lockCalls[0].mode, 'exclusive', '必须是独占锁');
  assert.equal(lockCalls[0].name, LOCK_KEY);

  // ---- Web Locks 首选路径：两笔并发提交都得落地，谁都不能被覆盖 ----
  /* 同步短锁做不到这件事：两页可以同时看到锁空闲、同时写、各自回读到自己的 token 而
     双双判定「拿到了」，后写的把先写的整份盖掉。navigator.locks 是真互斥量，会排队。 */
  const raceBefore = JSON.parse(values.get(TAG_RELAY_STORAGE_KEY)).inbox.length;
  const raced = await Promise.all([
    store.commitRelay(next => touchInboxEntry(next, entry('race-a')), { changed: 'inbox' }),
    store.commitRelay(next => touchInboxEntry(next, entry('race-b')), { changed: 'inbox' }),
  ]);
  assert.deepEqual(raced.map(r => r.ok), [true, true], '两笔并发提交都应成功');
  const racedKeys = JSON.parse(values.get(TAG_RELAY_STORAGE_KEY)).inbox.map(item => item.entryId);
  assert.ok(racedKeys.includes('race-a'), '先落地的那笔不能被后一笔整份盖掉');
  assert.ok(racedKeys.includes('race-b'));
  assert.equal(
    JSON.parse(values.get(TAG_RELAY_STORAGE_KEY)).inbox.length,
    raceBefore + 2,
    '两笔都要计入，不能有一笔被覆盖丢失',
  );
  assert.equal(
    JSON.stringify(store.relayState()),
    values.get(TAG_RELAY_STORAGE_KEY),
    '并发结束后内存仍须与磁盘字节一致',
  );
} finally {
  console.warn = previousWarn;
  globalThis.setTimeout = previousSetTimeout;
  if (previousStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previousStorage;
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
}

console.log('tag relay store: all tests passed');