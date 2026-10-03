import assert from 'node:assert/strict';
import { normalizeArtistIndex } from '../site/assets/app/artist-core.js';
import {
  LAB_MAX_SIZE,
  buildArtistStats,
  clampWeight,
  composeArtistString,
  decodeBoard,
  drawArtist,
  encodeBoard,
  matchStrings,
  normalizeArtistStrings,
  normalizeLabVersion,
  rerollSlots,
} from '../site/assets/lab/lab-core.js';

/* 固定序列的「随机数」，让抽卡结果可断言 */
const sequence = values => {
  let i = 0;
  return () => values[i++ % values.length];
};

const index = normalizeArtistIndex({
  schema: 1,
  versions: {
    n45: { book: 'artist_nai45_personal', paths: [], samples: {} },
    n5: {
      book: 'artist_nai5_personal',
      paths: [],
      samples: {
        a: ['n5_a', '', 'r', 0], b: ['n5_b', '', 'r', 0], c: ['n5_c', '', 'r', 0],
        d: ['n5_d', '', 'r', 0], 'ie (raarami)': ['n5_ie', '', 'r', 0], cold: ['n5_cold', '', 'r', 0],
      },
    },
  },
  codexModel: {},
});

/* 画风串表：成员可带倍率；书序号越界或没有词条 id 的串没有代表作 */
assert.equal(normalizeArtistStrings(null), null);
assert.equal(normalizeArtistStrings({ schema: 2 }), null);
const strings = normalizeArtistStrings({
  schema: 1,
  versions: {
    n5: {
      books: ['nai5_community_pack'],
      artists: ['a', 'b', 'c', 'ie(raarami)', 'd', 'x1', 'x2', 'x3', 'x4'],
      strings: [
        [[0, [1, 0.4], 3], 0, 'p1', '', 'rev1', '', 3],
        [[0, 1], 0, 'p2', 'p2.png', 'rev2', 'mengshen_pack'],
        [[0, 2, 4, 5, 6, 7, 8], 0, 'p3'],
        [[1, 2]],
        [[0]],
      ],
    },
  },
}).n5;
assert.equal(strings.length, 4, '少于两位的串丢掉');
assert.deepEqual(strings[0].members, [{ name: 'a', weight: 1 }, { name: 'b', weight: 0.4 }, { name: 'ie(raarami)', weight: 1 }]);
assert.deepEqual(strings[0].rep, { codexId: 'nai5_community_pack', entryId: 'p1', image: 'p1.jpg', assetRev: 'rev1', assetCodexId: '', images: 3 });
assert.equal(strings[1].rep.image, 'p2.png');
assert.equal(strings[1].rep.assetCodexId, 'mengshen_pack');
assert.equal(strings[3].rep, null, '没有常规级配图的串只用于统计');

/* 热度与搭档：写法不同的同一画师合并到样张索引的名字 */
const stats = buildArtistStats(index, 'n5', strings);
assert.equal(stats.popularity.get('a'), 3);
assert.equal(stats.popularity.get('ie (raarami)'), 1);
assert.equal(stats.partners.get('a').get('b'), 2);
assert.equal(stats.partners.get('b').get('c'), 1);
assert.equal(stats.nameOf('ie(raarami)'), 'ie (raarami)');

/* 抽卡：有锁住的牌且掷中搭档档时只从搭档里抽；没掷中时按热度（冷门有底数） */
const pool = new Set(index.samples.n5.keys());
assert.equal(drawArtist({ pool, stats, locked: ['b'], exclude: new Set(['b']), random: sequence([0.1, 0]) }), 'a');
assert.equal(drawArtist({ pool, stats, locked: ['b'], exclude: new Set(['b', 'a']), random: sequence([0.1, 0.99]) }), 'c');
assert.equal(drawArtist({ pool, stats, random: sequence([0]) }), 'a', '热度第一的排在最前');
assert.equal(drawArtist({ pool, stats, exclude: new Set(pool), random: Math.random }), null, '全排除时抽不出');
const fresh = drawArtist({ pool, stats, exclude: new Set(['a', 'b', 'c', 'd', 'ie (raarami)']), recent: new Set(['cold']), random: Math.random });
assert.equal(fresh, 'cold', '近期抽过的只在没别的可抽时放开');

/* 换一批：锁住的原样保留，其余不重复、倍率回到 1；only 只换指定格 */
const slots = [
  { name: 'a', weight: 1.2, locked: true },
  { name: 'b', weight: 0.5, locked: false },
  { name: 'c', weight: 1, locked: false },
];
for (let round = 0; round < 50; round += 1) {
  const next = rerollSlots(slots, { pool, stats });
  assert.deepEqual(next[0], slots[0]);
  assert.equal(new Set(next.map(slot => slot.name)).size, 3);
  assert.ok(next.slice(1).every(slot => slot.weight === 1 && !slot.locked && slot.name !== 'a'));
}
const one = rerollSlots(slots, { pool, stats, only: [2] });
assert.deepEqual(one.slice(0, 2), slots.slice(0, 2));
assert.notEqual(one[2].name, 'c');

/* 一起出现过：至少两位；撞得多的在前，同样多时整串短的在前；名字按样张索引统一 */
const matches = matchStrings(strings, ['a', 'b', 'ie (raarami)', 'c'], stats.nameOf);
assert.deepEqual(matches.map(m => [m.string.rep.entryId, m.overlap.length]), [['p1', 3], ['p2', 2], ['p3', 2]]);
assert.deepEqual(matchStrings(strings, ['a'], stats.nameOf), []);

/* 输出与网址 */
const board = [
  { name: 'ciloranko', weight: 1, locked: true },
  { name: 'sho (sho lwlw)', weight: 0.4, locked: false },
  { name: '13 (spice!!)', weight: 1.25, locked: false },
];
assert.equal(composeArtistString(board), 'artist:ciloranko, 0.4::artist:sho (sho lwlw)::, 1.25::artist:13 (spice!!)::');
assert.equal(encodeBoard(board), '!ciloranko|sho (sho lwlw)*0.4|13 (spice!!)*1.25');
assert.deepEqual(decodeBoard(encodeBoard(board)), board);
assert.deepEqual(decodeBoard('A|a|*2|b*abc|c*9'), [
  { name: 'a', weight: 1, locked: false },
  { name: '*2', weight: 1, locked: false },
  { name: 'b*abc', weight: 1, locked: false },
  { name: 'c', weight: 2.5, locked: false },
], '大小写合并去重，倍率截到上限，不是数字的星号算名字');
assert.equal(decodeBoard(Array.from({ length: 50 }, (_, i) => `x${i}`).join('|')).length, LAB_MAX_SIZE);
assert.equal(clampWeight(0), 1, '非法倍率回到 1');
assert.equal(clampWeight(0.01), 0.1);
assert.equal(normalizeLabVersion('n45'), 'n45');
assert.equal(normalizeLabVersion('n9'), 'n5');

console.log('lab core tests passed');
