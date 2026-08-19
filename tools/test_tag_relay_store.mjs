import assert from 'node:assert/strict';

import {
  TAG_RELAY_STORAGE_KEY,
  loadRelayState,
  saveRelayState,
  touchInboxEntry,
} from '../site/assets/app/tag-relay-core.js';

const previousStorage = globalThis.localStorage;
const previousDocument = globalThis.document;
const values = new Map();
const storage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key),
};
globalThis.localStorage = storage;
globalThis.document = { querySelector: () => null };

try {
  const store = await import(`../site/assets/app/tag-relay-store.js?test=${Date.now()}`);
  const entry = id => ({
    key: `entry:test:${id}`,
    codexId: 'test',
    entryId: id,
    title: `词条 ${id}`,
    prompt: `tag-${id}`,
  });

  assert.equal(store.commitRelay(next => touchInboxEntry(next, entry('one')), { changed: 'inbox' }).ok, true);

  // 模拟另一标签页在本模块尚未收到 storage 事件时写入；下一次本地提交必须先重读磁盘。
  const external = loadRelayState(storage);
  touchInboxEntry(external, entry('two'));
  assert.equal(saveRelayState(external, storage), true);
  assert.equal(store.commitRelay(next => touchInboxEntry(next, entry('three')), { changed: 'inbox' }).ok, true);
  assert.deepEqual(
    loadRelayState(storage).inbox.map(item => item.entryId),
    ['three', 'two', 'one'],
    '基于旧内存提交不得覆盖另一标签页刚写入的词条',
  );

  // localStorage.clear() 之后即使 storage 事件尚未处理，也不能把旧内存整份复活。
  values.delete(TAG_RELAY_STORAGE_KEY);
  assert.equal(store.commitRelay(next => touchInboxEntry(next, entry('fresh')), { changed: 'inbox' }).ok, true);
  assert.deepEqual(loadRelayState(storage).inbox.map(item => item.entryId), ['fresh']);
  assert.equal(values.has(`${TAG_RELAY_STORAGE_KEY}:lock`), false, '事务锁必须在写入后释放');
} finally {
  if (previousStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previousStorage;
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}

console.log('tag relay store: all tests passed');
