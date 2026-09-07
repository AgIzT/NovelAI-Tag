import assert from 'node:assert/strict';
import {
  BLOCKING_STORAGE_KEY, normalizeBlockingPreferences, compileBlockedWords, positiveBlockingFields, matchBlockedWord,
} from '../site/assets/app/content-blocking-core.js';
import { state } from '../site/assets/app/state.js';
import {
  loadContentBlocking, getBlockingPreferences, addBlockedWords, hideContentEntry, restoreContentEntry,
  contentBlockReason, isContentBlocked, setContentBlockingEnabled, removeBlockedWord,
  receiveBlockingStorage, invalidateBlockingEntry,
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
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};
state.codexes = [{ id: 'book', title: '书', aliases: ['old'], entryAliases: { 'book-2': 'book-1' } }, { id: 'other', title: '另一册' }];
state.codex = state.codexes[0];
loadContentBlocking();
const entry = { id: 'book-1', title: '测试', tags: 'smile', path: [] };
const saved = hideContentEntry(entry);
assert.equal(saved.ok, true);
assert.equal(isContentBlocked(entry), true);
assert.equal(isContentBlocked({ ...entry, id: 'book-2' }), true, '旧 ID 合并后仍屏蔽');
assert.equal(isContentBlocked({ ...entry, _srcCodexId: 'book' }), true, '跨书搜索和收藏回溯真实来源');
assert.equal(isContentBlocked({ ...entry, _srcCodexId: 'other' }), false, '不同书同名 ID 不误伤');
assert.equal(isContentBlocked({ ...entry, id: 'old-1', _srcCodexId: 'old' }), true, '旧法典别名兼容');
loadContentBlocking();
assert.equal(isContentBlocked(entry), true, '刷新后保留');
setContentBlockingEnabled(false);
assert.equal(isContentBlocked(entry), false);
assert.equal(getBlockingPreferences().entries.length, 1, '暂停保留清单');
setContentBlockingEnabled(true);
restoreContentEntry(saved.key);
assert.equal(isContentBlocked(entry), false);
assert.equal(addBlockedWords('smile， 蜘蛛, SMILE').ok, true);
assert.equal(contentBlockReason(entry).word, 'smile');
assert.ok(addBlockedWords('smile').error);
assert.ok(addBlockedWords('a'.repeat(81)).error);
assert.ok(addBlockedWords(' ').error);
removeBlockedWord('smile');
assert.equal(isContentBlocked(entry), false);
entry.tags = '蜘蛛';
invalidateBlockingEntry(entry);
assert.equal(isContentBlocked(entry), true, '编辑后缓存失效');
localStorage.setItem(BLOCKING_STORAGE_KEY, JSON.stringify({ version: 1, words: [], entries: [] }));
receiveBlockingStorage({ key: BLOCKING_STORAGE_KEY, storageArea: localStorage });
assert.equal(isContentBlocked(entry), false, '跨标签页同步');
localStorage.setItem = () => { throw new Error('storage denied'); };
assert.ok(addBlockedWords('smile').error);
assert.equal(getBlockingPreferences().words.length, 0, '保存失败不得假装成功');
storage.set(BLOCKING_STORAGE_KEY, 'bad json');
assert.doesNotThrow(loadContentBlocking);
console.log('content blocking: matching, aliases, persistence, pause, restore and storage errors passed');
