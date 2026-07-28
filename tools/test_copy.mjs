import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const copyUrl = new URL('../site/assets/app/copy.js', import.meta.url);
const copySource = (await readFile(copyUrl, 'utf8'))
  .replace("import { state } from './state.js';", 'const state = { sdMode: false };')
  .replace("import { toast } from './feedback.js';", 'const toast = () => {};')
  .replace(
    "import { recordRecentEntry, saveBrowseStateNow } from './history.js';",
    'const recordRecentEntry = () => {}; const saveBrowseStateNow = () => {};',
  );
assert.doesNotMatch(copySource, /^import /m, '测试替身未覆盖 copy.js 的全部依赖');

const { naiToSd } = await import(
  `data:text/javascript;base64,${Buffer.from(copySource).toString('base64')}`
);

// NAI v3 括号与 v4 数字权重混排时，数字权重的回退分支不得吞掉外层收尾括号。
assert.equal(naiToSd('{x, 1.3::a}'), '(x, (a:1.3):1.05)');
assert.equal(naiToSd('{1.3::a}, b'), '((a:1.3):1.05), b');
assert.equal(naiToSd('[x, 1.3::a]'), '(x, (a:1.3):0.952)');

// 无收尾 :: 且后接逗号的原有回退语义保持不变。
assert.equal(naiToSd('2.5::a, b'), '(a:2.5), b');

console.log('copy: all tests passed');
