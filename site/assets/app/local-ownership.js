const DEFAULT_LIMIT = 20;
const DEFAULT_TTL_MS = 180 * 24 * 60 * 60 * 1000;

function safeStorage(storage) {
  try {
    return storage || globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function cleanRecord(value, now, ttlMs) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || '').trim();
  if (!id) return null;
  const createdAt = Number(value.createdAt);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
  if (now - createdAt > ttlMs) return null;
  const title = String(value.title || '').trim().slice(0, 160);
  return title ? { id, title, createdAt } : { id, createdAt };
}

export function readOwnedRecords(key, {
  storage,
  now = Date.now(),
  limit = DEFAULT_LIMIT,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  const target = safeStorage(storage);
  if (!target || !key) return [];
  try {
    const parsed = JSON.parse(target.getItem(key) || '[]');
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    const records = [];
    for (const value of parsed) {
      const record = cleanRecord(value, now, ttlMs);
      if (!record || seen.has(record.id)) continue;
      seen.add(record.id);
      records.push(record);
    }
    return records.sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(0, limit));
  } catch {
    return [];
  }
}

export function rememberOwnedRecord(key, value, options = {}) {
  const target = safeStorage(options.storage);
  if (!target || !key) return [];
  const now = Number(options.now) || Date.now();
  const record = cleanRecord({
    id: value?.id,
    title: value?.title,
    createdAt: Number(value?.createdAt) || now,
  }, now, options.ttlMs || DEFAULT_TTL_MS);
  if (!record) return readOwnedRecords(key, { ...options, now });
  const records = readOwnedRecords(key, { ...options, now })
    .filter(item => item.id !== record.id);
  records.unshift(record);
  const limited = records.slice(0, Math.max(0, options.limit || DEFAULT_LIMIT));
  try {
    target.setItem(key, JSON.stringify(limited));
  } catch {
    return records;
  }
  return limited;
}

export function ownedRecordIds(key, options = {}) {
  return new Set(readOwnedRecords(key, options).map(record => record.id));
}
