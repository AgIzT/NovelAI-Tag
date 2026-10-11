/* 中转站状态的**唯一所有者**。
   之前 app/tag-relay.js 与 tag-relay-workbench.js 各持一份内存副本、各自往同一个
   localStorage key 上写，谁后写谁赢。把所有权收进这一个模块，是并入主站的前置条件。

   本模块**不 import 任何视图模块**——这条约束就是「单一所有者」的结构保证：
   视图拿不到别的写入口，只能经 commitRelay 改，改完靠订阅回调重绘。 */

import { toast } from './feedback.js';
import {
  TAG_RELAY_STORAGE_KEY,
  TAG_RELAY_LEGACY_STORAGE_KEYS,
  getActivePlan,
  loadRelayStateStatus,
  normalizeRelayState,
  touchInboxEntry,
  trimStateToBudget,
} from './tag-relay-v4.js';
import { snapshotEntry, snapshotFragment } from './tag-relay-snapshot.js';
import { createStorageCoordinator, writeStorageTransaction } from './storage-coordinator.js';

let current = null;
let storageIssue = null;
let bound = false;
let initialization = null;
const listeners = new Set();
const RELAY_LOCK_KEY = `${TAG_RELAY_STORAGE_KEY}:lock`;
const RELAY_SIGNAL_KEY = `${TAG_RELAY_STORAGE_KEY}:signal`;
const coordinator = createStorageCoordinator({ lockKey: RELAY_LOCK_KEY, signalKey: RELAY_SIGNAL_KEY });
/* 撞配额后一次退到七成，而不是刚好退到不撞：只退一点点，下一次复制立刻再撞一次，
   用户会连着看见好几条「已自动清理」。 */
const RELAY_QUOTA_BUDGET_RATIO = 0.7;
const RELAY_CHANGE_KINDS = new Set(['inbox', 'plan', 'history', 'all']);

/* 惰性加载：import 本模块不该产生 localStorage 读取，等第一次真要用再读。 */
export function relayState() {
  if (!current) {
    const loaded = loadRelayStateStatus();
    current = loaded.state;
    storageIssue = loaded.ok ? null : loaded.reason;
    if (storageIssue) reportFailure(storageIssue);
  }
  return current;
}

export function getRelayStorageIssue() {
  relayState();
  return storageIssue;
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

let signalSeq = 0;
/* 每个页面一个前缀：两页在同一毫秒各发一次信号也不会写出同一份 JSON。 */
const signalOrigin = lockToken();
let pendingChange = null;
let pendingReload = 0;

/* ⚠ 跨标签页也要精细化重绘。本地提交知道自己只脏了 inbox，对端却只看得见「主 key 变了」，
   一律按 changed:'all' 处理 → 侧栏开着的那一页每复制一次就重建 50 张带图卡片。

   把 changed 单开一个 :signal key 传，而**不是**塞进 state：
   一来 normalizeRelayState 只写出白名单字段（version/inbox/plans/activePlanId/history），
      塞进 state 的额外字段会在序列化时被直接丢掉，根本传不出去；
   二来它必须每次都变才能触发对端的 storage 事件（同值 setItem 不派发），
      塞进 state 就等于「同一份数据每次序列化结果都不同」，反过来引起无谓写入。

   信号在主键回读成功后写出，epoch/nonce 对应锁服务中的提交标记。
   下一 renderer 必须等标记可见后才能读底本；信号失败与主键一起补偿，不能宣布成功。 */

function readChangeKind(raw) {
  try {
    const changed = JSON.parse(raw || 'null')?.changed;
    if (RELAY_CHANGE_KINDS.has(changed)) return changed;
  } catch {
    // 信号是提示不是数据，读不懂就退回全量。
  }
  return 'all';
}

/* ⚠ 这里不走 core 的 saveRelayState，有两个它给不了的信息：
   1) 它把异常吞成 false，配额撞墙与「浏览器禁了存储」完全分不出来，而这两者的自救方式相反；
   2) 它的返回值实际上只说明「setItem 这个方法存在」，静默丢弃写入的假 storage 会误报成功。
   所以这一层自己 setItem、自己读回校验。写出的字节与 core 的 serializeRelayState 等价
   （都是 JSON.stringify(normalizeRelayState(x))），拆开只是为了共用同一次 normalize。 */
function tryWrite(storage, payload, changed, fence) {
  const signal = { changed, rev: `${signalOrigin}-${++signalSeq}`, committed: true };
  let marker = fence;
  if (!marker) {
    /* 锁服务暂时不可用时，不能用纯重绘提示抹掉仍被持有的上一提交标记。 */
    try { marker = JSON.parse(storage.getItem(RELAY_SIGNAL_KEY) || 'null'); }
    catch (error) {
      if (!(error instanceof SyntaxError)) return { ok: false, quota: false, error };
    }
  }
  if (Number.isSafeInteger(marker?.epoch) && marker.epoch > 0 && typeof marker.nonce === 'string') {
    Object.assign(signal, { epoch: marker.epoch, nonce: marker.nonce });
  }
  const result = writeStorageTransaction(storage, [
    { key: TAG_RELAY_STORAGE_KEY, value: payload },
    { key: RELAY_SIGNAL_KEY, value: JSON.stringify(signal) },
  ]);
  if (!result.ok && result.reason !== 'quota') console.warn('[tag-relay] 中转站写入失败', result.error);
  return { ...result, quota: result.reason === 'quota' };
}

/* ⚠ 内存换上的必须是**同一次** normalize 的产物：normalizeRelayState 会给缺失的时间戳
   补 new Date()，跑两遍可能差出几毫秒，磁盘与内存就再也字节不一致了。 */
function persistState(storage, next, changed, { allowTrim = true, fence } = {}) {
  if (!storage?.setItem) return { ok: false, reason: 'save' };
  const normalized = normalizeRelayState(next);
  const payload = JSON.stringify(normalized);
  const attempt = tryWrite(storage, payload, changed, fence);
  if (attempt.ok) return { ok: true, written: true, next: normalized };
  if (!attempt.quota) return { ok: false, reason: 'save' };
  /* 首次迁移必须完整保留成品历史。写不下就保留旧 key，等待用户腾出空间后重试。 */
  if (!allowTrim) return { ok: false, reason: 'quota' };

  /* 配额撞墙的自救。真正撑爆的是复制历史，而「清空复制历史」埋在编排页签里，
     一句「请检查浏览器存储权限」不可能把用户领过去；先自己丢掉最旧的几条再试一次。
     ⚠ 全程只动 next（loadRelayState 出来的独立副本），失败时磁盘与内存都还是撞墙前那份。 */
  const { trimmed } = trimStateToBudget(next, Math.floor(payload.length * RELAY_QUOTA_BUDGET_RATIO));
  if (!trimmed) return { ok: false, reason: 'quota', trimmed: 0 };
  const retryState = normalizeRelayState(next);
  /* 历史被裁掉了，脏区不再只是调用方声明的那一块，退回全量。 */
  const retry = tryWrite(storage, JSON.stringify(retryState), 'all', fence);
  if (!retry.ok) return { ok: false, reason: 'quota', trimmed };
  return { ok: true, written: true, next: retryState, trimmed };
}

function reportFailure(reason) {
  if (reason === 'migration-save' || reason === 'migration-quota') {
    toast('旧中转站数据已保留，迁移未保存', '!', {
      label: '重试', onClick: async () => { await initializeRelay(); },
    });
    return;
  }
  if (reason === 'conflict' || reason === 'missing-plan') {
    toast('方案已在另一处更新，本地输入已保留', '!');
    return;
  }
  if (reason === 'future-version') {
    toast('中转站数据来自更新版本，请刷新页面；原数据已保留', '!');
    return;
  }
  if (reason === 'corrupt-data') {
    toast('中转站原数据无法读取，已停止写入以保留内容', '!');
    return;
  }
  if (reason === 'migration-mismatch') {
    toast('旧方案暂时无法无损转换，原数据已保留', '!');
    return;
  }
  if (reason === 'invalid-backup') {
    toast('中转站备份无效，原方案保持不变', '!');
    return;
  }
  if (reason === 'lock') {
    toast('中转站正在被另一个标签页更新，请重试', '!');
    return;
  }
  if (reason === 'mutator') {
    toast('中转站这次操作没能完成，内容保持原样', '!');
    return;
  }
  if (reason === 'quota') {
    toast('中转站已存满，请清理成品记录后重试', '!');
    return;
  }
  toast('中转站保存失败，请检查浏览器存储权限', '!');
}

/* 读取可以同步展示，迁移写入必须与普通提交共用同一把锁。失败时旧 key 一字不动，
   再次调用会重新读取、校验和试编译；成功后 v4 优先，不会重复导入旧方案。 */
export async function initializeRelay() {
  if (initialization) return await initialization;
  /* 先留可读候选，写入失败后仍能查看；锁内会再读一遍作为唯一提交底本。 */
  relayState();
  initialization = (async () => {
    const transaction = await coordinator.run((storage, fence) => {
      const loaded = loadRelayStateStatus(storage);
      if (!loaded.ok) return { ok: false, reason: loaded.reason };
      if (!loaded.migrated) return { ok: true, next: loaded.state, migrated: false };
      const saved = persistState(storage, loaded.state, 'all', { allowTrim: false, fence });
      return saved.ok ? { ...saved, migrated: true } : {
        ...saved, reason: saved.reason === 'quota' ? 'migration-quota' : 'migration-save',
      };
    });
    if (!transaction.ok) {
      storageIssue = transaction.reason;
      reportFailure(storageIssue);
      publish({ changed: 'all', source: 'migration', issue: storageIssue });
      return { ok: false, reason: storageIssue };
    }
    current = transaction.next;
    storageIssue = null;
    publish({ changed: 'all', source: transaction.migrated ? 'migration' : 'load' });
    return { ok: true, migrated: transaction.migrated };
  })();
  try { return await initialization; } finally { initialization = null; }
}

export const retryRelayMigration = initializeRelay;

/* changed 用来告诉视图「脏了哪一块」：inbox / plan / history / all。
   侧栏据此只重绘对应的页签——入库现在挂在复制这条最高频的路径上，
   每次都全量重建 50 张带图卡片会直接压到复制反馈的动效上。 */
export async function commitRelay(mutator, { changed = 'all', planId, revision, expectedRevision = revision } = {}) {
  const transaction = await coordinator.run((storage, fence) => {
    /* ⚠ 不再 clone：loadRelayState 走的是 JSON.parse + normalizeRelayState，产出的已是
       全新对象图，与 current 没有任何共享引用。再 structuredClone + 再 normalize 一遍是白跑，
       实测占单次提交四成耗时。 */
    const loaded = loadRelayStateStatus(storage);
    if (!loaded.ok) {
      storageIssue = loaded.reason;
      return { ok: false, reason: loaded.reason };
    }
    const next = loaded.state;
    if (planId && expectedRevision !== undefined) {
      const plan = next.plans.find(item => item.id === planId);
      if (!plan || plan.revision !== expectedRevision) {
        return { ok: false, reason: plan ? 'conflict' : 'missing-plan', next, planId, revision: plan?.revision };
      }
    }
    let result;
    try {
      result = mutator(next);
    } catch (error) {
      /* 事务语义：锁照样在 finally 里释放，next 是独立副本，内存与磁盘都没被碰过。 */
      console.warn('[tag-relay] 中转站提交回调出错', error);
      return { ok: false, reason: error.reason || 'mutator' };
    }
    if (result?.ok === false && ['conflict', 'missing-plan'].includes(result.reason)) {
      return { ok: false, reason: result.reason, next, result, planId, revision: result.plan?.revision };
    }
    const saved = persistState(storage, next, changed, { allowTrim: !loaded.migrated, fence });
    if (!saved.ok && loaded.migrated) {
      saved.reason = saved.reason === 'quota' ? 'migration-quota' : 'migration-save';
    }
    return { ...saved, result };
  });

  /* ⚠ 先落盘再换内存：写失败时内存与磁盘不会失步，用户手里的中转站还是刚才那份。 */
  if (!transaction.ok) {
    if (transaction.reason === 'conflict' || transaction.reason === 'missing-plan') {
      current = transaction.next;
      storageIssue = null;
      publish({ changed: 'plan', source: 'conflict', issue: transaction.reason, planId: transaction.planId });
    } else if (transaction.reason.startsWith('migration-')) storageIssue = transaction.reason;
    reportFailure(transaction.reason);
    return { ok: false, result: transaction.result, reason: transaction.reason, planId: transaction.planId, revision: transaction.revision };
  }
  /* ⚠ 换上的是**规整后**的那一份，与磁盘上的字节同源。直接换 mutator 改过的 next，
     将来任何加进 normalize 的规整都会让内存与磁盘悄悄分叉。 */
  current = transaction.next;
  storageIssue = null;
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

export function prepareCopiedFragment(entry, fragment) {
  if (!entry) return null;
  try { return snapshotFragment(entry, fragment); } catch (error) {
    console.warn('[tag-relay] 无法建立片段快照', error);
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
  const loaded = loadRelayStateStatus();
  storageIssue = loaded.ok ? null : loaded.reason;
  if (loaded.ok || !current) current = loaded.state;
  if (storageIssue) reportFailure(storageIssue);
  publish({ changed, source, issue: storageIssue });
}

export async function setupRelayStore() {
  if (bound) return await initializeRelay();
  bound = true;
  /* 跨标签页同步。⚠ storage 事件只在**别的**标签页写入时触发，
     所以同页内的修改必须走 commitRelay，指望它兜底是不行的。 */
  window.addEventListener('storage', event => {
    /* ⚠ 同源 iframe 里一次 sessionStorage.clear() 同样派发 key === null 的 storage 事件。
       不认 storageArea 就会被当成 localStorage 被清空，整份重载一次。
       （惯例照抄 favorites-backup.js 的 subscribeFavoritesChanges。） */
    if (event.storageArea !== globalThis.localStorage) return;
    if (TAG_RELAY_LEGACY_STORAGE_KEYS.includes(event.key)) {
      toast('旧版页面更新了中转站，请刷新旧页面；当前方案保持不变', '!');
      publish({ changed: 'legacy', source: 'storage', issue: 'legacy-updated' });
      return;
    }
    if (event.key === RELAY_SIGNAL_KEY) {
      const changed = readChangeKind(event.newValue);
      let signal;
      try { signal = JSON.parse(event.newValue || 'null'); } catch { signal = null; }
      if (signal?.committed === true) {
        /* 新信号在主键之后：完整提交已传播，合并主键事件安排的兜底重读。 */
        clearTimeout(pendingReload); pendingReload = 0; pendingChange = null;
        reloadFromStorage('storage', changed);
      } else {
        // 旧版信号在主键之前，只记脏区；缺 query 的旧浏览器也保留主键兜底。
        pendingChange = changed;
      }
      return;
    }
    /* 锁 key（:lock）落在这一行：它与主 key 不相等，写锁不该引起对端重载。 */
    if (event.key !== null && event.key !== TAG_RELAY_STORAGE_KEY) return;
    clearTimeout(pendingReload);
    if (event.key === null) {
      pendingReload = 0; pendingChange = null;
      reloadFromStorage('storage', 'all');
    } else {
      /* 等后置信号带来精细脏区；旧程序只写主键时下一任务全量重读。 */
      pendingReload = setTimeout(() => {
        const changed = pendingChange || 'all';
        pendingReload = 0; pendingChange = null;
        reloadFromStorage('storage', changed);
      }, 0);
    }
  });
  /* ⚠ 只认 persisted：普通首次加载也会派发 pageshow，白付一次读盘 + 一次 changed:'all'
     的全量重绘（实测大状态下多 13ms 读盘、重建 50 张带图卡片）。
     真正需要重读的只有从 bfcache 回来这一种——那时页面没有重新执行，
     内存里可能还是离开前的旧副本。 */
  window.addEventListener('pageshow', event => {
    if (event?.persisted) reloadFromStorage('pageshow');
  });
  return await initializeRelay();
}
