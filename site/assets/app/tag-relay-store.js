/* 中转站状态的**唯一所有者**。
   之前 app/tag-relay.js 与 tag-relay-workbench.js 各持一份内存副本、各自往同一个
   localStorage key 上写，谁后写谁赢。把所有权收进这一个模块，是并入主站的前置条件。

   本模块**不 import 任何视图模块**——这条约束就是「单一所有者」的结构保证：
   视图拿不到别的写入口，只能经 commitRelay 改，改完靠订阅回调重绘。 */

import { toast } from './feedback.js';
import {
  TAG_RELAY_STORAGE_KEY,
  getActivePlan,
  loadRelayState,
  normalizeRelayState,
  touchInboxEntry,
  trimStateToBudget,
} from './tag-relay-core.js';
import { snapshotEntry } from './tag-relay-snapshot.js';

let current = null;
let bound = false;
const listeners = new Set();
const RELAY_LOCK_KEY = `${TAG_RELAY_STORAGE_KEY}:lock`;
const RELAY_SIGNAL_KEY = `${TAG_RELAY_STORAGE_KEY}:signal`;
const RELAY_LOCK_TTL = 2_000;
const RELAY_LOCK_WAIT = 48;
/* 撞配额后一次退到七成，而不是刚好退到不撞：只退一点点，下一次复制立刻再撞一次，
   用户会连着看见好几条「已自动清理」。 */
const RELAY_QUOTA_BUDGET_RATIO = 0.7;
const RELAY_CHANGE_KINDS = new Set(['inbox', 'plan', 'history', 'all']);

/* withStorageLock 有两种「callback 根本没轮到跑」的结局，必须与 callback 自己的失败区分开：
   以前它们塌成 null 和 false，于是 mutator 抛异常被 `!transaction` 一把抓住，
   报成「请检查浏览器存储权限」——一条与真实原因毫无关系的文案，console 里还一个字都没有。 */
const LOCK_BUSY = Object.freeze({ ok: false, reason: 'lock' });
const STORAGE_BLOCKED = Object.freeze({ ok: false, reason: 'storage' });

/* 惰性加载：import 本模块不该产生 localStorage 读取，等第一次真要用再读。 */
export function relayState() {
  if (!current) current = loadRelayState();
  return current;
}

export function relayInbox() {
  return relayState().inbox;
}

export function activeRelayPlan() {
  return getActivePlan(relayState());
}

function publish(meta) {
  for (const listener of listeners) {
    try {
      listener(current, meta);
    } catch (error) {
      console.warn('[tag-relay] 订阅者出错', error);
    }
  }
}

function lockToken() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    // Restricted contexts may expose crypto while denying randomUUID().
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/* ⚠ expiresAt 是**写锁那一方**的 Date.now()，读锁这方拿自己的表去比。系统时钟往回拨一小时，
   一把 2 秒 TTL 的残留锁在别人眼里就成了「还有 59 分钟才过期」，提交会一路失败到时钟走回来。
   一把合法的锁，剩余寿命不可能超过一个 TTL；这里放宽到 2 倍容忍正常的时钟微调，
   再多就只能是时钟错位，当脏锁抢占。 */
function isLockStale(holder, now) {
  const expiresAt = Number(holder?.expiresAt);
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt <= now || expiresAt > now + RELAY_LOCK_TTL * 2;
}

/* localStorage 没有事务。两个标签页若都从自己的旧内存副本整份写回，后写者会把
   前一页的新词条/方案抹掉。这里用一个极短期、带过期时间的同源锁把同步写串起来；
   拿到锁后再从磁盘重读，mutator 永远作用在最新版本上。 */
function withStorageLock(callback) {
  const storage = globalThis.localStorage;
  if (!storage?.getItem || !storage?.setItem || !storage?.removeItem) return callback();
  const token = lockToken();
  const deadline = Date.now() + RELAY_LOCK_WAIT;
  let acquired = false;
  try {
    do {
      const now = Date.now();
      let holder = null;
      try { holder = JSON.parse(storage.getItem(RELAY_LOCK_KEY) || 'null'); } catch { holder = null; }
      if (!holder?.token || isLockStale(holder, now)) {
        storage.setItem(RELAY_LOCK_KEY, JSON.stringify({ token, expiresAt: now + RELAY_LOCK_TTL }));
        let verified = null;
        try { verified = JSON.parse(storage.getItem(RELAY_LOCK_KEY) || 'null'); } catch { verified = null; }
        acquired = verified?.token === token;
      }
    } while (!acquired && Date.now() < deadline);
    return acquired ? callback() : LOCK_BUSY;
  } catch (error) {
    console.warn('[tag-relay] 事务锁不可用', error);
    return STORAGE_BLOCKED;
  } finally {
    if (acquired) {
      try {
        const holder = JSON.parse(storage.getItem(RELAY_LOCK_KEY) || 'null');
        if (holder?.token === token) storage.removeItem(RELAY_LOCK_KEY);
      } catch {
        // TTL 会回收残留锁；不能因清理失败把一次已完成写入报成失败。
      }
    }
  }
}

/* ⚠ 上面那把 localStorage 锁**给不了互斥**：读-改-写不是原子的，两个标签页可以同时看到锁
   空闲、同时写、然后各自回读到自己的 token 并双双判定「拿到了」。回读只能发现「我写完之后
   又被别人覆盖」，发现不了「我写之前别人已经写完并验证过了」——后写的一方必然验证通过。

   navigator.locks 是浏览器提供的真正的同源互斥量，自带排队，也不用 48ms 忙等把主线程钉住
   （入库挂在复制这条最高频路径上，那 48ms 是实打实吃掉一帧多的输入响应）。
   代价是 commitRelay 必须变成 async——调用方一律要 await，忘了 await 会拿到一个 Promise，
   而 Promise 是 truthy 的，`if (action.ok)` 会静默走进失败分支。

   ⚠ 同步短锁保留作兜底：老浏览器没有 navigator.locks 时行为与从前一致（能降低概率、不是事务）。 */
async function withRelayLock(callback) {
  const locks = globalThis.navigator?.locks;
  if (typeof locks?.request !== 'function') return withStorageLock(callback);
  try {
    return await locks.request(RELAY_LOCK_KEY, { mode: 'exclusive' }, () => callback());
  } catch (error) {
    /* 锁服务本身不可用（部分隐私模式 / 沙箱 iframe）时退回同步短锁，别让写入整个失败。 */
    console.warn('[tag-relay] Web Locks 不可用，退回同步短锁', error);
    return withStorageLock(callback);
  }
}

let signalSeq = 0;
/* 每个页面一个前缀：两页在同一毫秒各发一次信号也不会写出同一份 JSON。 */
const signalOrigin = lockToken();
let pendingChange = null;

/* ⚠ 跨标签页也要精细化重绘。本地提交知道自己只脏了 inbox，对端却只看得见「主 key 变了」，
   一律按 changed:'all' 处理 → 侧栏开着的那一页每复制一次就重建 50 张带图卡片。

   把 changed 单开一个 :signal key 传，而**不是**塞进 state：
   一来 normalizeRelayState 只写出白名单字段（version/inbox/plans/activePlanId/history），
      塞进 state 的额外字段会在序列化时被直接丢掉，根本传不出去；
   二来它必须每次都变才能触发对端的 storage 事件（同值 setItem 不派发），
      塞进 state 就等于「同一份数据每次序列化结果都不同」，反过来引起无谓写入。

   ⚠ 信号必须**先于**数据写出：对端收到信号只记下脏区、不重读，等主 key 的事件到了才真读盘。
   写失败时会补发一条 'all' 把这条提示降级，免得它留在对端误导下一次重载。 */
function announceChange(changed) {
  try {
    globalThis.localStorage?.setItem?.(
      RELAY_SIGNAL_KEY,
      JSON.stringify({ changed, rev: `${signalOrigin}-${++signalSeq}` }),
    );
  } catch {
    // 信号写不进去只是退化成对端全量重绘，不能因此把真正的数据写入报成失败。
  }
}

function readChangeKind(raw) {
  try {
    const changed = JSON.parse(raw || 'null')?.changed;
    if (RELAY_CHANGE_KINDS.has(changed)) return changed;
  } catch {
    // 信号是提示不是数据，读不懂就退回全量。
  }
  return 'all';
}

function isQuotaError(error) {
  const name = error?.name;
  return name === 'QuotaExceededError'
    || name === 'NS_ERROR_DOM_QUOTA_REACHED'   // Firefox 的旧名字
    || error?.code === 22
    || error?.code === 1014;
}

/* ⚠ 这里不走 core 的 saveRelayState，有两个它给不了的信息：
   1) 它把异常吞成 false，配额撞墙与「浏览器禁了存储」完全分不出来，而这两者的自救方式相反；
   2) 它的返回值实际上只说明「setItem 这个方法存在」，静默丢弃写入的假 storage 会误报成功。
   所以这一层自己 setItem、自己读回校验。写出的字节与 core 的 serializeRelayState 等价
   （都是 JSON.stringify(normalizeRelayState(x))），拆开只是为了共用同一次 normalize。 */
function tryWrite(storage, payload, changed) {
  try {
    announceChange(changed);
    storage.setItem(TAG_RELAY_STORAGE_KEY, payload);
    if (storage.getItem?.(TAG_RELAY_STORAGE_KEY) !== payload) {
      announceChange('all');
      return { ok: false, quota: false };
    }
    return { ok: true };
  } catch (error) {
    const quota = isQuotaError(error);
    if (!quota) console.warn('[tag-relay] 中转站写入失败', error);
    /* 数据没落地，刚发出去的那条精细信号就成了谎话；降级成全量，免得对端漏刷。 */
    announceChange('all');
    return { ok: false, quota };
  }
}

/* ⚠ 内存换上的必须是**同一次** normalize 的产物：normalizeRelayState 会给缺失的时间戳
   补 new Date()，跑两遍可能差出几毫秒，磁盘与内存就再也字节不一致了。 */
function persistState(next, changed) {
  const storage = globalThis.localStorage;
  if (!storage?.setItem) return { ok: false, reason: 'save' };
  const normalized = normalizeRelayState(next);
  const payload = JSON.stringify(normalized);
  const attempt = tryWrite(storage, payload, changed);
  if (attempt.ok) return { ok: true, next: normalized };
  if (!attempt.quota) return { ok: false, reason: 'save' };

  /* 配额撞墙的自救。真正撑爆的是复制历史，而「清空复制历史」埋在编排页签里，
     一句「请检查浏览器存储权限」不可能把用户领过去；先自己丢掉最旧的几条再试一次。
     ⚠ 全程只动 next（loadRelayState 出来的独立副本），失败时磁盘与内存都还是撞墙前那份。 */
  const { trimmed } = trimStateToBudget(next, Math.floor(payload.length * RELAY_QUOTA_BUDGET_RATIO));
  if (!trimmed) return { ok: false, reason: 'quota', trimmed: 0 };
  const retryState = normalizeRelayState(next);
  /* 历史被裁掉了，脏区不再只是调用方声明的那一块，退回全量。 */
  const retry = tryWrite(storage, JSON.stringify(retryState), 'all');
  if (!retry.ok) return { ok: false, reason: 'quota', trimmed };
  return { ok: true, next: retryState, trimmed };
}

function reportFailure(reason) {
  if (reason === 'lock') {
    toast('中转站正在被另一个标签页更新，请重试', '!');
    return;
  }
  if (reason === 'mutator') {
    toast('中转站这次操作没能完成，内容保持原样', '!');
    return;
  }
  if (reason === 'quota') {
    toast('中转站已存满，请到编排页签清空复制历史', '!');
    return;
  }
  toast('中转站保存失败，请检查浏览器存储权限', '!');
}

/* changed 用来告诉视图「脏了哪一块」：inbox / plan / history / all。
   侧栏据此只重绘对应的页签——入库现在挂在复制这条最高频的路径上，
   每次都全量重建 50 张带图卡片会直接压到复制反馈的动效上。 */
export async function commitRelay(mutator, { changed = 'all' } = {}) {
  const transaction = await withRelayLock(() => {
    /* ⚠ 不再 clone：loadRelayState 走的是 JSON.parse + normalizeRelayState，产出的已是
       全新对象图，与 current 没有任何共享引用。再 structuredClone + 再 normalize 一遍是白跑，
       实测占单次提交四成耗时。 */
    const next = loadRelayState();
    let result;
    try {
      result = mutator(next);
    } catch (error) {
      /* 事务语义：锁照样在 finally 里释放，next 是独立副本，内存与磁盘都没被碰过。 */
      console.warn('[tag-relay] 中转站提交回调出错', error);
      return { ok: false, reason: 'mutator' };
    }
    return { ...persistState(next, changed), result };
  });

  /* ⚠ 先落盘再换内存：写失败时内存与磁盘不会失步，用户手里的中转站还是刚才那份。 */
  if (!transaction.ok) {
    reportFailure(transaction.reason);
    return { ok: false, result: transaction.result };
  }
  /* ⚠ 换上的是**规整后**的那一份，与磁盘上的字节同源。直接换 mutator 改过的 next，
     将来任何加进 normalize 的规整都会让内存与磁盘悄悄分叉。 */
  current = transaction.next;
  if (transaction.trimmed) {
    toast(`中转站已存满，已自动清理 ${transaction.trimmed} 条最旧的复制历史`, '!');
  }
  publish({ changed: transaction.trimmed ? 'all' : changed, source: 'local' });
  return { ok: true, result: transaction.result };
}

/* 复制即入库：复制成功的那一刻把词条压成快照丢进「最近复制」。
   调用方只管把活的词条递进来，快照转换、归属回溯、分级冻结都在这一层完成。
   ⚠ 静默：copyText 自己已经弹了「已复制…」的 toast，入库由角标和动效表达，
   再弹一条只会变成噪音。 */
export async function recordCopiedEntry(entry) {
  if (!entry) return false;
  return await recordPreparedCopiedEntry(prepareCopiedEntry(entry));
}

export function prepareCopiedEntry(entry) {
  if (!entry) return null;
  try {
    return snapshotEntry(entry);
  } catch (error) {
    console.warn('[tag-relay] 无法建立复制快照', error);
    return null;
  }
}

export async function recordPreparedCopiedEntry(snapshot) {
  if (!snapshot) return false;
  const result = await commitRelay(next => touchInboxEntry(next, snapshot), { changed: 'inbox' });
  return result.ok;
}

export function subscribeRelay(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function reloadFromStorage(source, changed = 'all') {
  current = loadRelayState();
  publish({ changed, source });
}

export function setupRelayStore() {
  if (bound) return;
  bound = true;
  /* 跨标签页同步。⚠ storage 事件只在**别的**标签页写入时触发，
     所以同页内的修改必须走 commitRelay，指望它兜底是不行的。 */
  window.addEventListener('storage', event => {
    /* ⚠ 同源 iframe 里一次 sessionStorage.clear() 同样派发 key === null 的 storage 事件。
       不认 storageArea 就会被当成 localStorage 被清空，整份重载一次。
       （惯例照抄 favorites-backup.js 的 subscribeFavoritesChanges。） */
    if (event.storageArea !== globalThis.localStorage) return;
    if (event.key === RELAY_SIGNAL_KEY) {
      /* 信号先到、数据后到：这里只记脏区，真正的重读等主 key 的事件。 */
      pendingChange = readChangeKind(event.newValue);
      return;
    }
    /* 锁 key（:lock）落在这一行：它与主 key 不相等，写锁不该引起对端重载。 */
    if (event.key !== null && event.key !== TAG_RELAY_STORAGE_KEY) return;
    const changed = event.key === null ? 'all' : (pendingChange || 'all');
    pendingChange = null;
    reloadFromStorage('storage', changed);
  });
  /* ⚠ 只认 persisted：普通首次加载也会派发 pageshow，白付一次读盘 + 一次 changed:'all'
     的全量重绘（实测大状态下多 13ms 读盘、重建 50 张带图卡片）。
     真正需要重读的只有从 bfcache 回来这一种——那时页面没有重新执行，
     内存里可能还是离开前的旧副本。 */
  window.addEventListener('pageshow', event => {
    if (event?.persisted) reloadFromStorage('pageshow');
  });
}
