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
assert.deepEqual(rawPieces('forest, 1.2::backpack, gloves'), ['forest, 1.2::backpack, gloves']);
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
