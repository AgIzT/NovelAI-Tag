import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  artistKey,
  formatArtistWeight,
  normalizeArtistIndex,
  promptArtists,
  resolveArtistTiles,
} from '../site/assets/app/artist-core.js';

/* 画师名归一与 build_artist_index.py 共用夹具：两边任何一侧改了规则，这里或 Python 那边就会红 */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/artist_keys.json', import.meta.url), 'utf8'));
for (const [input, expected] of fixture.cases) {
  assert.equal(artistKey(input), expected, `artistKey(${JSON.stringify(input)})`);
}

/* 按出现顺序去重；倍率 = 数字权重组 × 1.05^花括号 ÷ 1.05^方括号，括号跨逗号按所在层算 */
const round = list => list.map(({ name, weight }) => [name, Number(weight.toFixed(4))]);
assert.deepEqual(round(promptArtists(
  'artist:a, 0.4::artist:b, artist:c::, [[artist:d]], {artist:e, smile}, artist:a, year 2024',
)), [
  ['a', 1],
  ['b', 0.4],
  ['c', 0.4],
  ['d', Number((1 / 1.05 ** 2).toFixed(4))],
  ['e', 1.05],
]);
assert.deepEqual(round(promptArtists('{{1girl, artist:f}}, artist:g')), [['f', 1.1025], ['g', 1]]);
assert.deepEqual(promptArtists('1girl, solo, smile'), []);

/* 相邻 NAI 括号组只在画师提取时拆开，各组倍率、外层与数字权重分别保留。 */
assert.deepEqual(round(promptArtists(
  '{{artist:pottsness}}, [[artist:onineko]][[artist:as109]], year 2024',
)), [['pottsness', 1.1025], ['onineko', 0.907], ['as109', 0.907]]);
assert.deepEqual(round(promptArtists('{{artist:a}}{{artist:b}}, artist:c')), [
  ['a', 1.1025], ['b', 1.1025], ['c', 1],
]);
assert.deepEqual(round(promptArtists('{artist:a}[[artist:b]], [{{artist:c}}{{artist:d}}]')), [
  ['a', 1.05], ['b', 0.907], ['c', 1.05], ['d', 1.05],
]);
assert.deepEqual(round(promptArtists('{{1girl,[[artist:a]][[artist:b]],artist:c}},artist:d')), [
  ['a', 1], ['b', 1], ['c', 1.1025], ['d', 1],
]);
assert.deepEqual(round(promptArtists('0.4::{{artist:a}}[[artist:b]]::,artist:c')), [
  ['a', 0.441], ['b', 0.3628], ['c', 1],
]);
assert.deepEqual(round(promptArtists('{{0.5::artist:a::}}{{2::artist:b::}},artist:c')), [
  ['a', 0.5513], ['b', 2.205], ['c', 1],
]);
assert.deepEqual(round(promptArtists('{{smile}}{artist:a}{smile}[[artist:a]]{artist:b}')), [
  ['a', 1.05], ['b', 1.05],
]);
assert.deepEqual(round(promptArtists('artist:senji_(tegone_spike){artist:tomose_shunsaku}')), [
  ['senji (tegone spike)', 1], ['tomose shunsaku', 1.05],
]);
assert.deepEqual(round(promptArtists('[[artist:ie(raarami)]][[artist:382]]')), [
  ['ie(raarami)', 0.907], ['382', 0.907],
]);
assert.deepEqual(round(promptArtists('artist:[ [a]]{{artist:b}}')), [
  [artistKey('artist:[ [a]]'), 0.907], ['b', 1.1025],
], '括号外的 artist: 前缀仍按既有 artistKey 归一');
assert.deepEqual(round(promptArtists('0.4::{year} 2025::,artist:a')), [['a', 1]],
  '闭括号后的段内数字仍是收组标记，不能被补分隔符提升为开组');
assert.deepEqual(round(promptArtists('0.4::{year} 2025::,[[artist:a]][[artist:b]]')), [
  ['a', 0.907], ['b', 0.907],
]);
assert.deepEqual(round(promptArtists('0.4::year {2025::},artist:a')), [['a', 1]],
  '原始段内的数字不能因开括号分组而变成跨逗号数字权重');
assert.deepEqual(round(promptArtists('0.4::year [2025::][[artist:a]][[artist:b]]')), [
  ['a', 0.907], ['b', 0.907],
], '段内数字收组对同段后面的画师组也生效');

assert.equal(formatArtistWeight(1), '');
assert.equal(formatArtistWeight(1.001), '');
assert.equal(formatArtistWeight(0.4), '×0.4');
assert.equal(formatArtistWeight(1 / 1.05 ** 2), '×0.91');
assert.equal(formatArtistWeight(-1), '×-1');

/* 索引：省略的图片名补成「id.jpg」，目录按序号还原；形态不对返回 null */
assert.equal(normalizeArtistIndex(null), null);
assert.equal(normalizeArtistIndex({ schema: 99 }), null);
const index = normalizeArtistIndex({
  schema: 1,
  versions: {
    n45: {
      book: 'artist_nai45_personal',
      paths: [['单画师词典', '300画师']],
      samples: {
        a: ['artist_300_0001', '', 'r1', 0, 'artist_300'],
        'ie (raarami)': ['n45_ie', 'n45_ie.png', 'r2', 0, '', 3],
        self: ['n45_self', '', 'r3', 0],
      },
    },
    n5: {
      book: 'artist_nai5_personal',
      paths: [],
      samples: { a: ['n5_a', '', 'r4', 0], self: ['n5_self', '', 'r5', 0] },
    },
  },
  codexModel: { nai45_community_pack: 'n45', bogus: 'n9' },
});
assert.deepEqual(index.books, { n45: 'artist_nai45_personal', n5: 'artist_nai5_personal' });
assert.deepEqual([...index.codexModel], [['nai45_community_pack', 'n45']]);
const sampleA = index.samples.n45.get('a');
assert.equal(sampleA.image, 'artist_300_0001.jpg');
assert.equal(sampleA.assetCodexId, 'artist_300');
assert.deepEqual(sampleA.path, ['单画师词典', '300画师']);
assert.equal(index.samples.n45.get('ie (raarami)').count, 3);
assert.deepEqual(index.samples.n5.get('a').path, [], '目录序号越界时给空目录');

/* 拆解：本版没有取另一版并标 fallback；空白写法不同也能兜底对上；两版都没有的进 missing */
const artists = promptArtists('artist:a, artist:ie(raarami), artist:nobody');
const v5 = resolveArtistTiles(index, artists, 'n5');
assert.deepEqual(v5.tiles.map(t => [t.name, t.sample.entryId, t.fallback]), [
  ['a', 'n5_a', false],
  ['ie(raarami)', 'n45_ie', true],
]);
assert.deepEqual(v5.missing.map(a => a.name), ['nobody']);
assert.equal(v5.bothVersions, true);

/* 画师词典里的单画师词条不把自己列成样张，改用另一版 */
const own = resolveArtistTiles(index, promptArtists('artist:self'), 'n45', {
  skipEntry: { codexId: 'artist_nai45_personal', entryId: 'n45_self' },
});
assert.deepEqual(own.tiles.map(t => [t.sample.entryId, t.fallback]), [['n5_self', true]]);
assert.equal(own.bothVersions, false);

console.log('artist core tests passed');
