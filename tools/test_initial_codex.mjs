// 首屏选书规则：node tools/test_initial_codex.mjs
// init() 与首屏数据预热共用 initial-codex.js；这里锁住规则本身，两边各自的接线由
// test_data_source.mjs（预热端到端）与 verify_ui（真实进站）覆盖。
import assert from 'node:assert/strict';

const { codexMatches, pickInitialCodex, requestedCodexFromLocation } = await import('../site/assets/app/initial-codex.js');

const codexes = [
  { id: 'adult', nsfw: true },
  { id: 'n5', aliases: ['old-n5'] },
  { id: 'birthday-book' },
  { id: 'adult-birthday', nsfw: true },
];
const lockedWhenClosed = codex => Boolean(codex?.nsfw);

assert.equal(codexMatches({ id: 'a', aliases: ['b'] }, 'b'), true);
assert.equal(codexMatches({ id: 'a' }, ''), false);
assert.equal(codexMatches(null, 'a'), false);

// 点名的书未锁：用它（含别名）
assert.equal(pickInitialCodex({ codexes, requested: 'old-n5', isLocked: lockedWhenClosed }).id, 'n5');
// 点名的书被锁：退到生日书，再退到第一本未锁的书
assert.equal(pickInitialCodex({ codexes, requested: 'adult', birthdayId: 'birthday-book', isLocked: lockedWhenClosed }).id, 'birthday-book');
assert.equal(pickInitialCodex({ codexes, requested: 'adult', isLocked: lockedWhenClosed }).id, 'n5');
// 生日书本身被锁：不选它
assert.equal(pickInitialCodex({ codexes, birthdayId: 'adult-birthday', isLocked: lockedWhenClosed }).id, 'n5');
// 分级已开：成人书照常可选
assert.equal(pickInitialCodex({ codexes, requested: 'adult', isLocked: () => false }).id, 'adult');
// 不存在的书名、空地址：第一本未锁的书
assert.equal(pickInitialCodex({ codexes, requested: 'missing', isLocked: lockedWhenClosed }).id, 'n5');
// 全部被锁时退回第一本；空列表返回 null
assert.equal(pickInitialCodex({ codexes: [{ id: 'x', nsfw: true }], isLocked: lockedWhenClosed }).id, 'x');
assert.equal(pickInitialCodex({ codexes: [], isLocked: lockedWhenClosed }), null);

// 地址里的书：/share 优先，其次 c，再次 codex；与 router.js readUrlState 同序
assert.equal(requestedCodexFromLocation({ pathname: '/share/n5/entry%2F1', search: '?c=other' }), 'n5');
assert.equal(requestedCodexFromLocation({ pathname: '/share/%E4%B9%A6/x', search: '' }), '书');
assert.equal(requestedCodexFromLocation({ pathname: '/share/%E0%A4%A/x', search: '' }), '%E0%A4%A');
assert.equal(requestedCodexFromLocation({ pathname: '/', search: '?c=n5&codex=other' }), 'n5');
assert.equal(requestedCodexFromLocation({ pathname: '/', search: '?codex=other' }), 'other');
assert.equal(requestedCodexFromLocation({ pathname: '/share', search: '' }), '');
assert.equal(requestedCodexFromLocation({ pathname: '/', search: '' }), '');

console.log('initial codex selection: PASS');
