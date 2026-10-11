import { toast } from './feedback.js';
import { writeStorageTransaction } from './storage-coordinator.js';

export function readPreference(key, fallback = null, storage) {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    return target?.getItem(key) ?? fallback;
  } catch { return fallback; }
}

// 设置只在落盘、回读成功后生效；多键偏好失败时补偿原字节。
export function writePreferences(writes, { storage, announce = true } = {}) {
  let result;
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    result = target ? writeStorageTransaction(target, writes) : { ok: false, reason: 'storage' };
  } catch { result = { ok: false, reason: 'storage' }; }
  if (!result.ok && announce) {
    const message = result.reason === 'quota'
      ? '浏览器存储已满，设置未保存；清理最近浏览或复制历史后重试'
      : result.reason === 'rollback'
        ? '设置未能完整保存，重新加载后检查设置'
        : '浏览器存储不可用，设置未保存；恢复存储权限后重试';
    toast(message, '!');
  }
  return result.ok;
}

export function writePreference(key, value, options) {
  return writePreferences([{ key, value }], options);
}
