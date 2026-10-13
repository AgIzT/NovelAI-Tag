import assert from 'node:assert/strict';
import { tokenizePrompt, serializeSelection, splitDraft } from '../site/assets/app/prompt-fragments.js';
import { naiToSd } from '../site/assets/app/nai-sd.js';

const rawPieces = raw => tokenizePrompt(raw).map(piece => piece.raw);
assert.deepEqual(rawPieces('backpack, gloves， blue sky\nforest'), ['backpack', 'gloves', 'blue sky', 'forest']);
assert.deepEqual(rawPieces('1.2::backpack, gloves::'), ['1.2::backpack::', '1.2::gloves::']);
assert.deepEqual(rawPieces('{{red hair, blue eyes}}'), ['{{red hair}}', '{{blue eyes}}']);
assert.deepEqual(rawPieces('[forest, blue sky]'), ['[forest]', '[blue sky]']);
assert.deepEqual(rawPieces('(backpack, gloves:1.25)'), ['(backpack:1.25)', '(gloves:1.25)']);
assert.deepEqual(rawPieces('1.2::{backpack, [gloves, beanie]}::'), [
  '1.2::{backpack}::', '1.2::{[gloves]}::', '1.2::{[beanie]}::',
]);
assert.deepEqual(rawPieces('1.2::1.3::backpack, gloves::::'), [
  '1.2::1.3::backpack, gloves::::',
]);
assert.equal(tokenizePrompt('1.2::{1.3::backpack, gloves::}::')[0].opaque, true);
assert.equal(serializeSelection('1.2::{backpack, gloves}::', ['p1']), '1.2::{gloves}::');
assert.equal(naiToSd(serializeSelection('1.2::{backpack, gloves}::', ['p1'])), '((gloves:1.05):1.2)');
assert.deepEqual(rawPieces('blue sky, [forest:city:0.5]'), ['blue sky', '[forest:city:0.5]']);
assert.equal(tokenizePrompt('[forest:city:0.5]')[0].opaque, true);
assert.deepEqual(rawPieces('blue sky, (forest|city)'), ['blue sky', '(forest|city)']);
assert.deepEqual(rawPieces('forest, 1.2::backpack, gloves'), ['forest', '1.2::backpack, gloves']);
assert.deepEqual(rawPieces('{backpack, gloves]'), ['{backpack, gloves]']);
assert.deepEqual(rawPieces('prefix {backpack, gloves}'), ['prefix {backpack, gloves}']);
assert.deepEqual(rawPieces('label\\, variant, sky'), ['label\\, variant', 'sky']);
assert.deepEqual(rawPieces('"blue sky, sunlight", forest'), ['"blue sky, sunlight"', 'forest']);
assert.deepEqual(rawPieces('{}'), ['{}']);
assert.deepEqual(rawPieces(',,\n'), []);
assert.deepEqual(rawPieces(', forest,'), ['forest']);

const source = '  {{red_hair, blue eyes}}, forest\n';
const pieces = tokenizePrompt(source);
assert.equal(pieces[0].key, 'red hair');
assert.equal(serializeSelection(source, [pieces[1].id]), '{{blue eyes}}');
assert.equal(serializeSelection(source, pieces.map(piece => piece.id)), source);
assert.equal(serializeSelection(source, []), '');
assert.equal(naiToSd(serializeSelection('{{red hair, blue eyes}}', ['p1'])), '(blue eyes:1.103)');
assert.equal(serializeSelection('forest, forest', ['p1']), 'forest');
assert.equal(new Set(tokenizePrompt('forest, forest').map(piece => piece.id)).size, 2);
assert.equal(tokenizePrompt('{-1.2::rain, fog::}')[1].negative, true);
assert.equal(serializeSelection('{-1.2::rain, fog::}', ['p1']), '{-1.2::fog::}');

/* 已确认的前缀可选；异常尾段不按内部逗号猜拆，复制保留原权重与异常标记。 */
const weightedPrefix = '1.2::{backpack, [gloves, beanie]}::, {blue sky';
assert.deepEqual(rawPieces(weightedPrefix), [
  '1.2::{backpack}::', '1.2::{[gloves]}::', '1.2::{[beanie]}::', '{blue sky',
]);
assert.equal(serializeSelection(weightedPrefix, ['p1']), '1.2::{[gloves]}::');
assert.equal(tokenizePrompt(weightedPrefix).at(-1).opaque, true);
for (const [text, expected] of [
  ['forest, [backpack}, gloves, blue sky', ['forest', '[backpack}, gloves, blue sky']],
  ['forest, "backpack, gloves, blue sky', ['forest', '"backpack, gloves, blue sky']],
  ['"blue sky, sunlight", {forest', ['"blue sky, sunlight"', '{forest']],
  ['label\\, variant, {forest', ['label\\, variant', '{forest']],
  ['1.2::{backpack, gloves', ['1.2::{backpack, gloves']],
  ['forest, }', ['forest', '}']],
  ['::bad::, forest', ['::bad::, forest']],
]) {
  assert.deepEqual(rawPieces(text), expected, `recover only confirmed prefix: ${text}`);
  assert.equal(tokenizePrompt(text).at(-1).opaque, true);
}

/* 社区图包词条的异常尾段，复现选择 tag 整段降级。 */
const affected = '1.5:: artist:ask (askzy) ::, 1girl, -1:: character background, multiple views ::, '
  + '::-1::thick eyebrows::, ::-2::featureless black, pitch black, deep black::, no text, professional illustration';
const affectedPieces = tokenizePrompt(affected);
assert.deepEqual(affectedPieces.map(piece => piece.raw), [
  '1.5::artist:ask (askzy)::', '1girl', '-1::character background::', '-1::multiple views::',
  '::-1::thick eyebrows::, ::-2::featureless black, pitch black, deep black::, no text, professional illustration',
]);
assert.equal(affectedPieces.at(-1).opaque, true);
assert.equal(affectedPieces[2].negative, true);
assert.equal(serializeSelection(affected, ['p0']), '1.5::artist:ask (askzy)::');
assert.equal(serializeSelection(affected, ['p2']), '-1::character background::');
assert.equal(serializeSelection(affected, ['p4']), affectedPieces.at(-1).raw);
const exactSource = ` \t{{red_hair, blue eyes}}，\r\n forest, ${affected}\n `;
assert.deepEqual(
  Buffer.from(serializeSelection(exactSource, tokenizePrompt(exactSource).map(piece => piece.id))),
  Buffer.from(exactSource),
  '完整选择必须逐字节返回原文（空白、全角逗号、换行、异常标记均保留）',
);

assert.deepEqual(splitDraft(', blue sky, soft lighting'), { committed: ['blue sky'], tail: ' soft lighting' });
assert.deepEqual(splitDraft('forest，gloves\n'), { committed: ['forest', 'gloves'], tail: '' });
assert.deepEqual(splitDraft('1.2::backpack, gloves::,sunlight'), {
  committed: ['1.2::backpack, gloves::'], tail: 'sunlight',
});
assert.deepEqual(splitDraft('{{red hair, blue eyes}}, (forest, sunlight:1.2),'), {
  committed: ['{{red hair, blue eyes}}', '(forest, sunlight:1.2)'], tail: '',
});
assert.deepEqual(splitDraft('forest, {backpack, gloves'), { committed: ['forest'], tail: ' {backpack, gloves' });
assert.deepEqual(splitDraft('forest, [backpack}, gloves,'), { committed: ['forest'], tail: ' [backpack}, gloves,' });
console.log('prompt fragments: selection weights, opaque syntax and draft boundaries passed');
