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
} from './tag-relay-core.js';

let current = null;
let bound = false;
const listeners = new Set();

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

/* changed 用来告诉视图「脏了哪一块」：inbox / plan / history / all。
   侧栏据此只重绘对应的页签——入库现在挂在复制这条最高频的路径上，
   每次都全量重建 50 张带图卡片会直接压到复制反馈的动效上。 */
export function commitRelay(mutator, { changed = 'all' } = {}) {
  const next = cloneState(relayState());
  const result = mutator(next);
  /* 先落盘再换内存：配额写失败时内存与磁盘不会失步，用户手里的中转站还是刚才那份。 */
  if (!saveRelayState(next)) {
    toast('中转站保存失败，请检查浏览器存储权限', '!');
    return { ok: false, result };
  }
  current = next;
  publish({ changed, source: 'local' });
  return { ok: true, result };
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
    if (event.key !== TAG_RELAY_STORAGE_KEY) return;
    reloadFromStorage('storage');
  });
  /* 从 bfcache 回来时页面没有重新执行，内存里可能是离开前的旧副本 */
  window.addEventListener('pageshow', () => reloadFromStorage('pageshow'));
}
