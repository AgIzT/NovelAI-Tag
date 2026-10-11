/* 本地整份文档提交协调：锁内重读，并验证上一 renderer 的提交已传播。 */
const LOCK_TTL = 2000;
const LOCK_WAIT = 48;
const FENCE_WAIT = 3000;
const FENCE_CHECK = 250;

function token() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
  } catch { /* 受限环境可能暴露 UUID 方法却拒绝读取或调用。 */ }
  return 'local-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}
function isQuotaError(error) {
  return error?.name === 'QuotaExceededError' || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error?.code === 22 || error?.code === 1014;
}

// 所有旧字节先读取；读失败不能被当成缺键。信号必须作为最后一项传入。
export function writeStorageTransaction(storage, writes) {
  const previous = [];
  let attempted = 0;
  try {
    for (const { key } of writes) previous.push([key, storage.getItem(key)]);
    for (const { key, value } of writes) {
      attempted += 1;
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
      if (storage.getItem(key) !== value) throw new Error('storage readback mismatch');
    }
    return { ok: true };
  } catch (error) {
    const rollbackErrors = [];
    for (const [key, raw] of previous.slice(0, attempted).reverse()) {
      try {
        if (storage.getItem(key) === raw) continue;
        if (raw === null) storage.removeItem(key);
        else storage.setItem(key, raw);
        if (storage.getItem(key) !== raw) throw new Error('rollback readback mismatch');
      } catch (rollbackError) { rollbackErrors.push({ key, error: rollbackError }); }
    }
    return { ok: false, reason: rollbackErrors.length ? 'rollback' : isQuotaError(error) ? 'quota' : 'storage', error, rollbackErrors };
  }
}

export function createStorageCoordinator({
  lockKey, signalKey,
  fencePrefix = lockKey.replace(/:lock$/, '') + ':fence:',
  getStorage = () => globalThis.localStorage,
  getLocks = () => globalThis.navigator?.locks,
  eventTarget = globalThis.window,
} = {}) {
  let heldFence = null;
  let fenceCheck = null;
  function release() {
    clearTimeout(fenceCheck); fenceCheck = null;
    heldFence?.release(); heldFence = null;
  }
  eventTarget?.addEventListener?.('pagehide', release);
  function releaseMissingFence(storage) {
    // 本页已回读过自己的 signal；严格缺键才表示删除，读取失败仍须拒绝提交。
    // 只释放自己的标记，不能绕过另一 renderer 尚未传播的提交。
    if (heldFence && storage.getItem(signalKey) === null) release();
  }
  function watchFence(storage) {
    // 同页外部清空不派发本页事件；持有者空闲时也要让其它页能够继续提交。
    fenceCheck = setTimeout(() => {
      fenceCheck = null;
      try { releaseMissingFence(storage); } catch { /* 读取失败仍保留传播屏障。 */ }
      if (heldFence) watchFence(storage);
    }, FENCE_CHECK);
    fenceCheck?.unref?.();
  }
  eventTarget?.addEventListener?.('storage', event => {
    if (event.key !== null && !(event.key === signalKey && event.newValue === null)) return;
    try {
      const storage = getStorage();
      if (event.storageArea === storage) releaseMissingFence(storage);
    } catch { /* 存储访问失败不能被当成删除；下次提交仍会检查。 */ }
  });

  // 旧浏览器短锁只能降低碰撞概率，localStorage 没有原子互斥能力。
  function shortLock(storage, callback) {
    const owner = token();
    const deadline = Date.now() + LOCK_WAIT;
    let acquired = false;
    try {
      do {
        const now = Date.now();
        let holder;
        try { holder = JSON.parse(storage.getItem(lockKey) || 'null'); } catch (error) {
          if (error instanceof SyntaxError) holder = null;
          else throw error;
        }
        const expiresAt = Number(holder?.expiresAt);
        const stale = !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + LOCK_TTL * 2;
        if (!holder?.token || stale) {
          storage.setItem(lockKey, JSON.stringify({ token: owner, expiresAt: now + LOCK_TTL }));
          acquired = JSON.parse(storage.getItem(lockKey) || 'null')?.token === owner;
        }
      } while (!acquired && Date.now() < deadline);
      // 暂时降级后也保留上次标记，避免仍 held 的旧标记因信号被抹掉而永远等不到。
      return acquired ? callback(storage, visibleFence(storage)) : { ok: false, reason: 'lock' };
    } catch (error) {
      return { ok: false, reason: isQuotaError(error) ? 'quota' : 'storage', error };
    } finally {
      if (acquired) {
        try {
          if (JSON.parse(storage.getItem(lockKey) || 'null')?.token === owner) storage.removeItem(lockKey);
        } catch { /* 已成功的提交不能因短锁释放失败改判失败，锁会过期。 */ }
      }
    }
  }
  function visibleFence(storage) {
    let signal;
    try { signal = JSON.parse(storage.getItem(signalKey) || 'null'); } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
    return Number.isSafeInteger(signal?.epoch) && signal.epoch > 0
      && typeof signal.nonce === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(signal.nonce)
      ? { epoch: signal.epoch, nonce: signal.nonce } : null;
  }
  async function waitForFence(storage, locks) {
    const deadline = Date.now() + FENCE_WAIT;
    do {
      // 同页 clear/removeItem 不派发本页 storage 事件，锁内再次检查自己的标记。
      releaseMissingFence(storage);
      // Web Locks 的互斥 IPC 不刷新 localStorage 缓存。锁服务标记独立于 renderer，
      // 后置信号可见后，同次提交更早写入的主键才可作为下一笔修改的依据。
      const state = await locks.query();
      const fences = (state.held || []).flatMap(lock => {
        if (!lock.name.startsWith(fencePrefix)) return [];
        const [epochText, nonce] = lock.name.slice(fencePrefix.length).split(':');
        const epoch = Number(epochText);
        return Number.isSafeInteger(epoch) && epoch > 0 && nonce ? [{ epoch, nonce }] : [];
      });
      const latest = fences.sort((a, b) => b.epoch - a.epoch)[0];
      const visible = visibleFence(storage);
      if (!latest || (visible && (visible.epoch > latest.epoch
          || (visible.epoch === latest.epoch && visible.nonce === latest.nonce)))) {
        return Math.max(latest?.epoch || 0, visible?.epoch || 0);
      }
      if (Date.now() >= deadline) throw new Error('storage fence timeout');
      await new Promise(resolve => setTimeout(resolve, 8));
    } while (true);
  }
  async function holdFence(locks, epoch) {
    const fence = { epoch, nonce: token() };
    let unlock, acquired, failed;
    const held = new Promise(resolve => { unlock = resolve; });
    const ready = new Promise((resolve, reject) => { acquired = resolve; failed = reject; });
    try {
      Promise.resolve(locks.request(fencePrefix + epoch + ':' + fence.nonce, { mode: 'shared' }, () => {
        acquired();
        return held;
      })).catch(failed);
      await ready;
      return { ...fence, release: unlock };
    } catch (error) { unlock(); throw error; }
  }
  async function run(callback) {
    let storage;
    try {
      storage = getStorage();
      if (!storage?.getItem || !storage?.setItem || !storage?.removeItem) return { ok: false, reason: 'storage' };
    } catch (error) { return { ok: false, reason: 'storage', error }; }
    let locks;
    try { locks = getLocks(); } catch { locks = null; }
    if (typeof locks?.request !== 'function') return shortLock(storage, callback);
    let started = false;
    try {
      return await locks.request(lockKey, { mode: 'exclusive' }, async () => {
        started = true;
        let nextFence = null;
        if (typeof locks.query === 'function') {
          try {
            nextFence = await holdFence(locks, (await waitForFence(storage, locks)) + 1);
          } catch (error) { return { ok: false, reason: 'lock', error }; }
        }
        try {
          const result = callback(storage, nextFence || visibleFence(storage));
          if (result && typeof result.then === 'function') {
            Promise.resolve(result).catch(() => {});
            throw new TypeError('storage transaction callback must be synchronous');
          }
          if (result.ok && result.written && nextFence) {
            release();
            heldFence = nextFence;
            nextFence = null;
            watchFence(storage);
          }
          return result;
        } finally { nextFence?.release(); }
      });
    } catch (error) {
      // callback 已开始则绝不重放，以免一次用户操作执行两遍。
      if (started) return { ok: false, reason: 'mutator', error };
      return shortLock(storage, callback);
    }
  }
  return { run, release };
}
