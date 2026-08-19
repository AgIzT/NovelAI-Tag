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
  saveRelayState,
  touchInboxEntry,
} from './tag-relay-core.js';
import { snapshotEntry } from './tag-relay-snapshot.js';

let current = null;
let bound = false;
const listeners = new Set();
const RELAY_LOCK_KEY = `${TAG_RELAY_STORAGE_KEY}:lock`;
const RELAY_LOCK_TTL = 2_000;
const RELAY_LOCK_WAIT = 48;

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

function cloneState(value) {
  try {
    return normalizeRelayState(structuredClone(value));
  } catch {
    return normalizeRelayState(JSON.parse(JSON.stringify(value)));
  }
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
      if (!holder?.token || Number(holder.expiresAt) <= now) {
        storage.setItem(RELAY_LOCK_KEY, JSON.stringify({ token, expiresAt: now + RELAY_LOCK_TTL }));
        let verified = null;
        try { verified = JSON.parse(storage.getItem(RELAY_LOCK_KEY) || 'null'); } catch { verified = null; }
        acquired = verified?.token === token;
      }
    } while (!acquired && Date.now() < deadline);
    return acquired ? callback() : null;
  } catch {
    return false;
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

/* changed 用来告诉视图「脏了哪一块」：inbox / plan / history / all。
   侧栏据此只重绘对应的页签——入库现在挂在复制这条最高频的路径上，
   每次都全量重建 50 张带图卡片会直接压到复制反馈的动效上。 */
export function commitRelay(mutator, { changed = 'all' } = {}) {
  const transaction = withStorageLock(() => {
    const next = cloneState(loadRelayState());
    const result = mutator(next);
    if (!saveRelayState(next)) return { ok: false, result };
    return { ok: true, result, next };
  });
  /* 先落盘再换内存：配额写失败时内存与磁盘不会失步，用户手里的中转站还是刚才那份。 */
  if (transaction === null) {
    toast('中转站正在被另一个标签页更新，请重试', '!');
    return { ok: false, result: undefined };
  }
  if (!transaction || !transaction.ok) {
    toast('中转站保存失败，请检查浏览器存储权限', '!');
    return { ok: false, result: transaction?.result };
  }
  current = transaction.next;
  publish({ changed, source: 'local' });
  return { ok: true, result: transaction.result };
}

/* 复制即入库：复制成功的那一刻把词条压成快照丢进「最近复制」。
   调用方只管把活的词条递进来，快照转换、归属回溯、分级冻结都在这一层完成。
   ⚠ 静默：copyText 自己已经弹了「已复制…」的 toast，入库由角标和动效表达，
   再弹一条只会变成噪音。 */
export function recordCopiedEntry(entry) {
  if (!entry) return false;
  return recordPreparedCopiedEntry(prepareCopiedEntry(entry));
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

export function recordPreparedCopiedEntry(snapshot) {
  if (!snapshot) return false;
  const result = commitRelay(next => touchInboxEntry(next, snapshot), { changed: 'inbox' });
  return result.ok;
}

export function subscribeRelay(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function reloadFromStorage(source) {
  current = loadRelayState();
  publish({ changed: 'all', source });
}

export function setupRelayStore() {
  if (bound) return;
  bound = true;
  /* 跨标签页同步。⚠ storage 事件只在**别的**标签页写入时触发，
     所以同页内的修改必须走 commitRelay，指望它兜底是不行的。 */
  window.addEventListener('storage', event => {
    if (event.key !== null && event.key !== TAG_RELAY_STORAGE_KEY) return;
    reloadFromStorage('storage');
  });
  /* 从 bfcache 回来时页面没有重新执行，内存里可能是离开前的旧副本 */
  window.addEventListener('pageshow', () => reloadFromStorage('pageshow'));
}
