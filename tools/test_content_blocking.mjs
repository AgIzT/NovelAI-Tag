import assert from 'node:assert/strict';
import {
  BLOCKING_STORAGE_KEY, normalizeBlockingPreferences, compileBlockedWords, positiveBlockingFields, matchBlockedWord,
} from '../site/assets/app/content-blocking-core.js';
import { state } from '../site/assets/app/state.js';
import {
  loadContentBlocking, getBlockingPreferences, addBlockedWords, hideContentEntry, restoreContentEntry,
  contentBlockReason, isContentBlocked, setContentBlockingEnabled, removeBlockedWord,
  receiveBlockingStorage, invalidateBlockingEntry, BLOCKING_SIGNAL_KEY,
} from '../site/assets/app/content-blocking.js';

const match = (word, entry) => matchBlockedWord(positiveBlockingFields(entry), compileBlockedWords([word]));
assert.equal(match('male', { tags: 'female, smile' }), '', '整词匹配不能误伤 female');
assert.equal(match('male', { tags: '{male}, solo' }), 'male');
assert.equal(match('blue eyes', { tags: '1.2::BLUE_EYES::' }), 'blue eyes');
assert.equal(match('蜘蛛', { title: '机械蜘蛛' }), '蜘蛛');
assert.equal(match('blood', { negative: 'blood', note: 'blood', path: ['blood'], tags: 'smile' }), '');
assert.equal(match('blood', { characterPrompts: [{ prompt: 'smile', negative: 'blood' }] }), '');
assert.equal(match('blood', { characterPrompts: [{ prompt: 'blood' }] }), 'blood');
assert.equal(match('blood', { images: [{ rawTag: 'smile' }, { rawTag: 'blood', negative: 'other' }] }), 'blood');
assert.equal(match('blood', { images: [{ negative: 'blood' }] }), '');
assert.equal(match('blue eyes', { title: 'blue', tags: 'eyes' }), '', '短语不能跨字段拼接');
assert.equal(match('a.b', { tags: 'axb' }), '', '屏蔽词必须按字面解释');
assert.equal(match('a.b', { tags: 'a.b' }), 'a.b');
assert.deepEqual(normalizeBlockingPreferences({ version: 1, words: ['ＢＬＵＥ_ＥＹＥＳ', 'blue eyes', 3] }).words, ['blue eyes']);
assert.deepEqual(normalizeBlockingPreferences({ version: 99, words: ['test'] }).words, []);
assert.doesNotThrow(() => normalizeBlockingPreferences({ version: 1, entries: [null, {}, { key: 'a' }, { key: 'a' }] }));

const storage = new Map();
// 此单页存储夹具走旧浏览器短锁；真实 Web Locks / renderer 传播另由浏览器回归覆盖。
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key),
};
state.codexes = [{ id: 'book', title: '书', aliases: ['old'], entryAliases: { 'book-2': 'book-1' } }, { id: 'other', title: '另一册' }];
state.codex = state.codexes[0];
loadContentBlocking();
const entry = { id: 'book-1', title: '测试', tags: 'smile', path: [] };
const saved = await hideContentEntry(entry);
assert.equal(saved.ok, true);
assert.equal(isContentBlocked(entry), true);
assert.equal(isContentBlocked({ ...entry, id: 'book-2' }), true, '旧 ID 合并后仍屏蔽');
assert.equal(isContentBlocked({ ...entry, _srcCodexId: 'book' }), true, '跨书搜索和收藏回溯真实来源');
assert.equal(isContentBlocked({ ...entry, _srcCodexId: 'other' }), false, '不同书同名 ID 不误伤');
assert.equal(isContentBlocked({ ...entry, id: 'old-1', _srcCodexId: 'old' }), true, '旧法典别名兼容');
loadContentBlocking();
assert.equal(isContentBlocked(entry), true, '刷新后保留');
await setContentBlockingEnabled(false);
assert.equal(isContentBlocked(entry), false);
assert.equal(getBlockingPreferences().entries.length, 1, '暂停保留清单');
await setContentBlockingEnabled(true);
await restoreContentEntry(saved.key);
assert.equal(isContentBlocked(entry), false);
assert.equal((await addBlockedWords('smile， 蜘蛛, SMILE')).ok, true);
assert.equal(contentBlockReason(entry).word, 'smile');
assert.ok((await addBlockedWords('smile')).error);
assert.ok((await addBlockedWords('a'.repeat(81))).error);
assert.ok((await addBlockedWords(' ')).error);
await removeBlockedWord('smile');
assert.equal(isContentBlocked(entry), false);
entry.tags = '蜘蛛';
invalidateBlockingEntry(entry);
assert.equal(isContentBlocked(entry), true, '编辑后缓存失效');
localStorage.setItem(BLOCKING_STORAGE_KEY, JSON.stringify({ version: 1, words: [], entries: [] }));
receiveBlockingStorage({ key: BLOCKING_STORAGE_KEY, storageArea: localStorage });
assert.equal(isContentBlocked(entry), false, '跨标签页同步');
const write = localStorage.setItem;
const read = localStorage.getItem;
localStorage.setItem = () => { throw new Error('storage denied'); };
assert.ok((await addBlockedWords('smile')).error);
assert.equal(getBlockingPreferences().words.length, 0, '保存失败不得假装成功');
localStorage.setItem = write;
storage.set(BLOCKING_STORAGE_KEY, 'bad json');
assert.doesNotThrow(loadContentBlocking);

const original = JSON.stringify({ version: 1, enabled: false, words: ['old-word'], entries: [
  { key: 'book:old-card', codexId: 'book', title: '旧卡片', codexTitle: '旧册', rating: '', path: ['旧目录'] },
] }, null, 2);
storage.set(BLOCKING_STORAGE_KEY, original);
assert.equal(loadContentBlocking().ok, true);
const known = getBlockingPreferences();
localStorage.getItem = key => {
  if (key === BLOCKING_STORAGE_KEY) throw new Error('temporarily unavailable');
  return read(key);
};
assert.ok(loadContentBlocking().error);
assert.deepEqual(getBlockingPreferences(), known, '读失败保留最后已知清单，不安装空底本');
assert.ok((await addBlockedWords('blocked-during-failure')).error);
assert.equal(storage.get(BLOCKING_STORAGE_KEY), original, '读失败期间普通动作拒写，原字节保留');
localStorage.getItem = read;
assert.equal((await addBlockedWords('new-word')).ok, true);
let disk = JSON.parse(storage.get(BLOCKING_STORAGE_KEY));
assert.deepEqual(disk.words, ['old-word', 'new-word'], '权限恢复后锁内重读原清单再新增');
assert.deepEqual(disk.entries, known.entries);
assert.equal(disk.enabled, false, '权限恢复后保留暂停设置');

// 不经过 storage 回调或 load，用外部持久化值检验每个动作只改变自身字段。
storage.set(BLOCKING_STORAGE_KEY, original);
assert.equal((await removeBlockedWord('old-word')).ok, true);
disk = JSON.parse(storage.get(BLOCKING_STORAGE_KEY));
assert.deepEqual(disk.words, []);
assert.deepEqual(disk.entries, known.entries);
assert.equal(disk.enabled, false);
storage.set(BLOCKING_STORAGE_KEY, original);
assert.equal((await restoreContentEntry('book:old-card')).ok, true);
disk = JSON.parse(storage.get(BLOCKING_STORAGE_KEY));
assert.deepEqual(disk.words, ['old-word']);
assert.equal(disk.enabled, false);
storage.set(BLOCKING_STORAGE_KEY, original);
assert.equal((await setContentBlockingEnabled(true)).ok, true);
disk = JSON.parse(storage.get(BLOCKING_STORAGE_KEY));
assert.deepEqual(disk.words, ['old-word']);
assert.deepEqual(disk.entries, known.entries);
storage.set(BLOCKING_STORAGE_KEY, original);
assert.equal((await hideContentEntry(entry)).ok, true);
disk = JSON.parse(storage.get(BLOCKING_STORAGE_KEY));
assert.equal(disk.entries.length, 2);
assert.deepEqual(disk.words, ['old-word']);
assert.equal(disk.enabled, false);

const invalidRaws = [
  'invalid-json', 'null', '{"version":2,"enabled":false,"words":["future-word"],"entries":[]}',
  '{"version":1,"words":[42],"entries":[]}',
  '{"version":1,"words":["kept-word"],"entries":[{"title":"broken identity"}]}',
];
for (const raw of invalidRaws) {
  storage.set(BLOCKING_STORAGE_KEY, raw);
  const before = getBlockingPreferences();
  assert.ok(loadContentBlocking().error);
  assert.deepEqual(getBlockingPreferences(), before);
  for (const operation of [() => addBlockedWords('new-word'), () => removeBlockedWord('kept-word'),
    () => hideContentEntry(entry), () => restoreContentEntry('book:old-card'), () => setContentBlockingEnabled(true)]) {
    assert.ok((await operation()).error, '损坏或未来版本清单拒绝普通写入');
    assert.equal(storage.get(BLOCKING_STORAGE_KEY), raw, '损坏或未来版本原字节保持不变');
    assert.deepEqual(getBlockingPreferences(), before);
  }
}

storage.set(BLOCKING_STORAGE_KEY, original);
loadContentBlocking();
storage.set(BLOCKING_SIGNAL_KEY, 'previous-signal-bytes');
let failSignal = true;
localStorage.setItem = (key, value) => {
  if (key === BLOCKING_SIGNAL_KEY && failSignal) { failSignal = false; throw new Error('signal denied'); }
  return write(key, value);
};
assert.ok((await addBlockedWords('signal-failed-word')).error);
assert.equal(storage.get(BLOCKING_STORAGE_KEY), original, 'signal失败补偿主键的精确原字节');
assert.equal(storage.get(BLOCKING_SIGNAL_KEY), 'previous-signal-bytes');
assert.deepEqual(getBlockingPreferences(), known, 'signal失败不得安装新内存');
localStorage.setItem = (key, value) => { if (key !== BLOCKING_STORAGE_KEY) write(key, value); };
assert.ok((await addBlockedWords('ignored-write-word')).error);
assert.equal(storage.get(BLOCKING_STORAGE_KEY), original, '主键静默未写入时回读拒绝成功');
assert.deepEqual(getBlockingPreferences(), known);
localStorage.setItem = write;
assert.equal((await addBlockedWords('retry-word')).ok, true, '写权限恢复后允许重新提交');
assert.deepEqual(JSON.parse(storage.get(BLOCKING_STORAGE_KEY)).words, ['old-word', 'retry-word']);
console.log('content blocking: matching, aliases, persistence, latest-base edits, read recovery, invalid raw preservation, signal rollback and readback passed');
