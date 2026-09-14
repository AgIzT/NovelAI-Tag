import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  danbooruWikiUrl,
  lookupTagZh,
  normalizeTagZhShard,
  splitPromptPieces,
  tagZhKey,
} from '../site/assets/app/tag-zh-core.js';

/* 查表键与 build_tag_zh.py 共用夹具：两边任何一侧改了规则，这里或 Python 那边就会红 */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/tag_zh_keys.json', import.meta.url), 'utf8'));
for (const [input, expected] of fixture.cases) {
  assert.equal(tagZhKey(input), expected, `tagZhKey(${JSON.stringify(input)})`);
}

/* 切段必须无损：拼回去就是原文（换行、全角逗号、首尾空白、空段都要保住） */
for (const text of [
  '1girl,white sweater,{{collared shirt,shirt under sweater}},',
  '1girl,solo,\n\n0.6::artist:chigusa minori::,  0.77::artist:toosaka asagi,\r\n{year 2024},',
  'smile，blush、 open mouth ,, ',
  '',
  ',,,',
]) {
  assert.equal(splitPromptPieces(text).map(p => p.lead + p.text + p.sep).join(''), text);
}
const pieces = splitPromptPieces('1girl, {{collared shirt,shirt under sweater}}\nsolo');
assert.deepEqual(pieces.map(p => [p.lead, p.text, p.sep, p.key]), [
  ['', '1girl', ',', '1girl'],
  [' ', '{{collared shirt', ',', 'collared shirt'],
  ['', 'shirt under sweater}}', '\n', 'shirt under sweater'],
  ['', 'solo', '', 'solo'],
]);

/* NAI 数字权重组跨逗号生效；只有段首「数字::」开组，其余 :: 一律收组 */
const weights = text => splitPromptPieces(text).map(p => p.weight);
assert.deepEqual(weights('-1::nipples,pasties,bra::,feet out of frame'), [-1, -1, -1, null]);
assert.deepEqual(weights('2::black reverse outfit,see-through body,fire body,::,skin tight'), [2, 2, 2, 2, null]);
assert.deepEqual(weights('1.3::pale skin::,1.4:: a chibi skeleton,hood,glowing fireflies::,sleepy'), [1.3, 1.4, 1.4, 1.4, null]);
assert.deepEqual(weights('{year 2025::},smile'), [null, null], '段内的 2025:: 不能当成开组');
assert.deepEqual(weights('{{-3::chibi::}},wide shot'), [-3, null]);

/* 分片：形态校验 + 人工 > 词库 > AI 的优先级，core 与书分片一起查 */
assert.equal(normalizeTagZhShard(null), null);
assert.equal(normalizeTagZhShard({ schema: 2, d: { a: 'b' } }), null);
/* 分片来自 JSON.parse：键里的 __proto__ 是普通自有属性，必须照常查到、也不能污染原型 */
const core = normalizeTagZhShard(JSON.parse(`{
  "schema": 1,
  "m": { "text": "文字" },
  "d": { "text": "文字焦点", "1girl": "单人女性", "empty": "  " },
  "a": { "very aesthetic": "极具美感", "__proto__": "原型" },
  "shards": ["suozhang", 7],
  "source": { "name": "词库" }
}`));
const shard = normalizeTagZhShard({ schema: 1, m: {}, d: {}, a: { 'oil paint scent': '油画颜料味' } });
assert.deepEqual(core.shards, ['suozhang', '7']);
assert.deepEqual(lookupTagZh([core], 'text'), { zh: '文字', source: 'm' });
assert.deepEqual(lookupTagZh([core], '1girl'), { zh: '单人女性', source: 'd' });
assert.deepEqual(lookupTagZh([core, shard], 'oil paint scent'), { zh: '油画颜料味', source: 'a' });
assert.deepEqual(lookupTagZh([core], '__proto__'), { zh: '原型', source: 'a' });
assert.equal(lookupTagZh([core], 'empty'), null, '空白译名不算');
assert.equal(lookupTagZh([core], 'constructor'), null);
assert.equal(lookupTagZh([core], ''), null);
assert.equal(lookupTagZh(null, '1girl'), null);

assert.equal(danbooruWikiUrl('arrow (projectile)'), 'https://danbooru.donmai.us/wiki_pages/arrow_(projectile)');

console.log('tag zh core tests passed');
