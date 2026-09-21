import assert from 'node:assert/strict';
import {
  ZW, OFF_OPEN, OFF_CLOSE, scrub, segments, analyze, tokens, outputOf, analyzeOutput, foldRanges, wrapWeighted,
} from '../site/assets/app/tag-relay-text.js';

const placeholder = name => `${ZW}#${name}${ZW}`;
const disabled = value => `${OFF_OPEN}${value}${OFF_CLOSE}`;
const source = '1.2::backpack, gloves::, {{red hair, blue eyes}}, (a, b), "x, y", escaped\\,comma';
assert.deepEqual(tokens(source).map(token => token.core), [
  '1.2::backpack, gloves::', '{{red hair, blue eyes}}', '(a, b)', '"x, y"', 'escaped\\,comma',
]);
assert.equal(outputOf(source), source);
assert.deepEqual(segments(' a，b\r\nc '), [[0, 2], [3, 4], [5, 5], [6, 8]]);
assert.deepEqual(tokens(' a, b ').map(({ segStart, segEnd, start, end }) => ({ segStart, segEnd, start, end })), [
  { segStart: 0, segEnd: 2, start: 1, end: 2 }, { segStart: 3, segEnd: 6, start: 4, end: 5 },
]);
assert.equal(analyze('{{red hair, blue eyes}}').mult, 1.05 ** 2);
assert.equal(analyze('1.2::backpack, gloves::').body, 'backpack, gloves');
assert.equal(analyze('{cat}, {dog}').body, '{cat}, {dog}');
assert.equal(analyze('1.2::cat:: dog::').mult, 1);
assert.equal(analyze('1.2::[cat]::').mult, 1.2 / 1.05);
assert.equal(analyze('~smile~').off, false);
assert.equal(analyze(disabled('cat')).off, true);
assert.equal(tokens(`${disabled('cat, dog')}, sky`).length, 2);
assert.equal(outputOf(`${disabled('cat, dog')}, sky`), 'sky');
const tildeName = placeholder('smile~, 1.2::{test}');
const tildeFold = placeholder('smile~');
const tildeFolds = new Map([['smile~', { body: 'cat' }]]);
assert.equal(analyze(disabled(tildeFold)).off, true);
assert.equal(outputOf(disabled(tildeFold), tildeFolds), '');
assert.equal(outputOf(`${disabled(tildeFold)}, sky`, tildeFolds), 'sky');
assert.equal(tokens(`${disabled(tildeName)}, sky`).length, 2);
assert.equal(outputOf('~smile~, 日本語～, :~)'), '~smile~, 日本語～, :~)');
assert.equal(scrub(`a${ZW}\u200c\u200d\u200e\u200f\ufeffb`), 'ab');

const folds = new Map([
  ['画风, {1.2::}', { body: 'cat, dog', image: 'thumb.jpg', codexId: 'book', access: {} }],
  ['画风 2', { body: 'cat, forest' }],
  ['numeric', { body: '1.3::cat::, sky' }],
]);
const first = placeholder('画风, {1.2::}'), second = placeholder('画风 2');
assert.equal(tokens(`${first}, sky`).length, 2);
assert.equal(analyze(`1.2::${first}::`).fold, '画风, {1.2::}');
assert.deepEqual(foldRanges(`a, ${first}, ${second}`), [
  { start: 3, end: 3 + first.length, name: '画风, {1.2::}' },
  { start: 5 + first.length, end: 5 + first.length + second.length, name: '画风 2' },
]);
assert.equal(outputOf(`${first}, blue sky, soft lighting`, folds), 'cat, dog, blue sky, soft lighting');
assert.equal(outputOf(`1.2::${first}::, blue sky`, folds), '1.2::cat, dog::, blue sky');
assert.equal(outputOf(`{{${first}}}, blue sky`, folds), '{{cat, dog}}, blue sky');
assert.equal(outputOf(`${first}, ${second}`, folds), 'cat, dog, forest');
assert.equal(outputOf(`${first}, ${second}`, folds, { dedupe: false }), 'cat, dog, cat, forest');
assert.equal(outputOf(`${first}, sky`, folds, { isLocked: fold => fold.codexId === 'book' }), 'sky');
assert.equal(outputOf(`${disabled(`1.2::${first}::`)}, sky`, folds), 'sky');
assert.equal(outputOf(placeholder('孤儿')), '#孤儿');
assert.equal(outputOf(`1.2::${placeholder('孤儿')}::`), '1.2::#孤儿::');
assert.equal(outputOf(`prefix${first}suffix`, folds), 'prefixcat, dogsuffix');
assert.equal(outputOf(`prefix${first}suffix`, folds, { isLocked: () => true }), 'prefixsuffix');
assert.equal(outputOf(`1.2::${first}::`, folds, { target: 'sd' }), '(cat, dog:1.2)');
assert.equal(outputOf(`1.2::${first}::`, folds, { target: 'plain' }), 'cat, dog');
const nested = outputOf(`1.2::${placeholder('numeric')}::, forest`, folds);
assert.equal(nested, '{{{{1.3::cat::, sky}}}}, forest');
assert.equal(outputOf(`1.2::${placeholder('numeric')}::`, folds, { target: 'sd' }), '((cat:1.3), sky:1.2)');
assert.equal(wrapWeighted('cat, 1.3::dog::', 1.1), '{{cat, 1.3::dog::}}');
assert.equal(wrapWeighted('cat', 1.1), '1.1::cat::');
assert.equal(wrapWeighted(first, 1.2), `1.2::${first}::`);
for (const weight of [-1.05, 0, .01, 12.6]) {
  assert.equal(analyze(wrapWeighted('cat', weight)).mult, weight);
  assert.equal(analyze(wrapWeighted(first, weight)).mult, weight);
}
assert.equal(wrapWeighted('cat', .05 * 1.05), '0.0525::cat::');
assert.equal(wrapWeighted('cat', .00000001), '0.00000001::cat::');
assert.equal(wrapWeighted('cat, 1.3::dog::', -1), '-1::cat::, -1.3::dog::');
assert.equal(wrapWeighted('cat, 1.3::dog::', 0), '0::cat::, 0::dog::');
assert.equal(wrapWeighted('{{cat, 1.3::dog::}}', -1), '-1.1025::cat::, -1.43325::dog::');
assert.equal(wrapWeighted('cat, 1.3::{dog}, sky::', -1), '-1::cat::, -1.365::dog::, -1.3::sky::');
assert.equal(wrapWeighted('"1.3::dog::"', -1), '-1::"1.3::dog::"::');
assert.equal(wrapWeighted('[cat|1.3::dog::]', -1), null);
assert.equal(wrapWeighted('1.3::cat::', 12.6), '{'.repeat(52) + '1.3::cat::' + '}'.repeat(52));
assert.equal(outputOf(`-1::${placeholder('numeric')}::, forest`, folds), '-1.3::cat::, -1::sky::, forest');
assert.equal(outputOf(`0::${placeholder('numeric')}::, forest`, folds), '0::cat::, 0::sky::, forest');
assert.equal(outputOf(`-1::${placeholder('numeric')}::`, folds, { target: 'sd' }), '((cat:1.3), sky:-1)');
assert.equal(outputOf(`0::${placeholder('numeric')}::`, folds, { target: 'sd' }), '((cat:1.3), sky:0)');
assert.equal(outputOf(`12.6::${placeholder('numeric')}::`, folds, { target: 'sd' }), '((cat:1.3), sky:12.6)');
assert.equal(outputOf('-1::cat::, 0::dog::, 12.6::sky::'), '-1::cat::, 0::dog::, 12.6::sky::');
const opaqueFolds = new Map([['opaque', { body: '[cat|1.3::dog::]' }]]);
assert.equal(outputOf(`-1::${placeholder('opaque')}::`, opaqueFolds), '-1::[cat|1.3::dog::]::');
assert.equal(outputOf(`0::${placeholder('opaque')}::`, opaqueFolds), '0::[cat|1.3::dog::]::');

const repeated = `cat, ${first}, CAT, 1.2::cat::, cat`;
const result = analyzeOutput(repeated, folds);
assert.equal(result.text, 'cat, dog, 1.2::cat::');
assert.equal(result.count, 3);
assert.deepEqual(result.merged, [{ token: 'cat', dropped: 3 }]);
assert.deepEqual([...result.duplicates], [[5, 1], [7 + first.length, 1], [repeated.lastIndexOf('cat'), 1]]);
assert.deepEqual(result.duplicateDetails.get(5), { kind: 'group', count: 1, firstOrdinal: 1 });
assert.deepEqual(result.duplicateDetails.get(7 + first.length), { kind: 'token', count: 1, firstOrdinal: 1 });
const duplicatedBody = new Map([['dup', { body: `soft  light, SOFT LIGHT, cat${ZW}` }]]);
const duplicateOutput = analyzeOutput(`1.2::${placeholder('dup')}::`, duplicatedBody);
assert.equal(duplicateOutput.text, '1.2::soft  light, cat::');
assert.deepEqual(duplicateOutput.merged, [{ token: 'soft  light', dropped: 1 }]);
assert.deepEqual([...duplicateOutput.duplicates], [[0, 1]]);
assert.deepEqual(duplicateOutput.duplicateDetails.get(0), { kind: 'group', count: 1, firstOrdinal: 1 });
const wholeGroup = `1.2::${placeholder('dup')}::`;
const repeatedGroups = analyzeOutput(`${wholeGroup}, ${wholeGroup}`, duplicatedBody);
assert.deepEqual(repeatedGroups.duplicateDetails.get(wholeGroup.length + 2),
  { kind: 'token', count: 2, firstOrdinal: 1 }, 'whole-group duplicate points to the earlier group even when it also contains inner repeats');
assert.equal(analyzeOutput('cat, cat', folds, { dedupe: false }).duplicateDetails.size, 0);
assert.equal(analyzeOutput('cat, cat', folds, { dedupe: false }).duplicates.size, 0);
assert.equal(folds.size, 3);
assert.equal(folds.get('画风, {1.2::}').body, 'cat, dog');
console.log('relay text: passed');
