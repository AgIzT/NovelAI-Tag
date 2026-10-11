// 统一访问总闸：所有消费端共用的评级、显式目录和真实来源门控。
// node tools/test_access.mjs；仅内存 state 与无害词条，不写存储、不发请求。
import assert from 'node:assert/strict';
import { state } from '../site/assets/app/state.js';
import { isEntryAccessBlocked } from '../site/assets/app/access.js';

const saved = { allowNsfw: state.allowNsfw, allowR18g: state.allowR18g, codexes: state.codexes };
const cases = [
  { name: 'ordinary', entry: { rating: 'safe', path: ['常规'] }, blocked: [false, false, false, false] },
  { name: 'literal NSFW overrides safe rating', entry: { rating: 'safe', path: ['作者', 'NSFW', '子目录'] }, blocked: [true, false, false, true] },
  { name: 'legacy NSFW without rating', entry: { path: ['nsfw'] }, blocked: [true, false, false, true] },
  { name: 'case insensitive boundary', entry: { rating: 'safe', path: ['nSfW'] }, blocked: [true, false, false, true] },
  { name: 'similar ordinary directory', entry: { rating: 'safe', path: ['nsfw-reference'] }, blocked: [false, false, false, false] },
  { name: 'R18 rating', entry: { rating: 'r18', path: ['常规'] }, blocked: [true, false, false, true] },
  { name: 'legacy R18 level', entry: { level: 'restricted' }, blocked: [true, false, false, true] },
  { name: 'R18G rating needs separate permission', entry: { rating: 'r18g' }, blocked: [true, true, false, true] },
  { name: 'R18G path overrides safe rating', entry: { rating: 'safe', path: ['r18g/重口'] }, blocked: [true, true, false, true] },
  { name: 'NSFW with R18G child', entry: { rating: 'safe', path: ['NSFW', '重口'] }, blocked: [true, true, false, true] },
  { name: 'locked real source in virtual view', entry: { rating: 'safe', _srcCodexId: 'adult-book' }, blocked: [true, false, false, true] },
  { name: 'locked source alias in virtual view', entry: { rating: 'safe', _srcCodexId: 'old-adult-book' }, blocked: [true, false, false, true] },
];

try {
  state.codexes = [{ id: 'adult-book', aliases: ['old-adult-book'], nsfw: true }];
  // 顺序含全开→关闭，确保已有来源 memo 不会保留过期权限。
  const states = [[false, false], [true, false], [true, true], [false, false]];
  for (const [index, [allowNsfw, allowR18g]] of states.entries()) {
    Object.assign(state, { allowNsfw, allowR18g });
    for (const sample of cases) {
      assert.equal(isEntryAccessBlocked(sample.entry), sample.blocked[index], `${sample.name}: state ${index}`);
    }
  }
  state.allowNsfw = false;
  state.codexes = [{ id: 'public-book' }];
  assert.equal(isEntryAccessBlocked({ _srcCodexId: 'public-book', rating: 'safe' }), false);
  assert.equal(isEntryAccessBlocked(null), false, '无条目不凭空制造受限级别');
} finally {
  Object.assign(state, saved);
}
console.log('access tests passed');
