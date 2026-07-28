import assert from 'node:assert/strict';
import {
  ownedRecordIds,
  readOwnedRecords,
  rememberOwnedRecord,
} from '../site/assets/app/local-ownership.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

const now = Date.UTC(2026, 6, 28);
const storage = memoryStorage();

assert.deepEqual(readOwnedRecords('mine', { storage, now }), []);
rememberOwnedRecord('mine', { id: 'a', title: ' 第一条 ', createdAt: now - 20 }, { storage, now });
rememberOwnedRecord('mine', { id: 'b', createdAt: now - 10 }, { storage, now });
rememberOwnedRecord('mine', { id: 'a', title: '更新标题', createdAt: now }, { storage, now });
assert.deepEqual(readOwnedRecords('mine', { storage, now }), [
  { id: 'a', title: '更新标题', createdAt: now },
  { id: 'b', createdAt: now - 10 },
]);
assert.deepEqual([...ownedRecordIds('mine', { storage, now })], ['a', 'b']);

const crowded = memoryStorage();
for (let i = 0; i < 25; i += 1) {
  rememberOwnedRecord('mine', { id: `id-${i}`, createdAt: now + i }, { storage: crowded, now: now + i });
}
assert.equal(readOwnedRecords('mine', { storage: crowded, now: now + 25 }).length, 20);
assert.equal(readOwnedRecords('mine', { storage: crowded, now: now + 25 })[0].id, 'id-24');

const stale = memoryStorage({
  mine: JSON.stringify([
    { id: 'old', createdAt: now - 181 * 24 * 60 * 60 * 1000 },
    { id: 'fresh', createdAt: now - 1000 },
    { id: '', createdAt: now },
    { id: 'fresh', createdAt: now - 2000 },
  ]),
});
assert.deepEqual(readOwnedRecords('mine', { storage: stale, now }), [
  { id: 'fresh', createdAt: now - 1000 },
]);

const broken = memoryStorage({ mine: '{not json' });
assert.deepEqual(readOwnedRecords('mine', { storage: broken, now }), []);

const denied = {
  getItem() { throw new Error('denied'); },
  setItem() { throw new Error('denied'); },
};
assert.deepEqual(readOwnedRecords('mine', { storage: denied, now }), []);
assert.doesNotThrow(() => rememberOwnedRecord('mine', { id: 'x', createdAt: now }, { storage: denied, now }));

console.log('local ownership tests passed');
