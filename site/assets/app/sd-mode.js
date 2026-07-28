export const SD_MODE_STORAGE_KEY = 'fadian-sdmode';

export function readSdMode(storage) {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    return target?.getItem(SD_MODE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSdMode(enabled, storage) {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    if (!target) return false;
    target.setItem(SD_MODE_STORAGE_KEY, enabled ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}
