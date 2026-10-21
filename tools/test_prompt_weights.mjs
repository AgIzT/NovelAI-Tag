// 权重上色的纯计算：只断言标记位置与方向，不碰 DOM。
import assert from 'node:assert/strict';
import { promptWeightMarks } from '../site/assets/app/prompt-weights.js';

const view = text => promptWeightMarks(text).map(m => `${m.kind}:${text.slice(m.start, m.end)}`);

// NAI 数字权重：开头与收尾同色，负权重算减权，权重 1 淡化
assert.deepEqual(view('0.6::artist:a::, 1.2::b::'), ['down:0.6::', 'down:::', 'sep:,', 'up:1.2::', 'up:::']);
assert.deepEqual(view('-1::simple illustration,flat color::'), ['down:-1::', 'sep:,', 'down:::']);
assert.deepEqual(view('1::reset::'), ['flat:1::', 'flat:::']);
// 没有开头的 :: 与单冒号（artist: 前缀）
assert.deepEqual(view('artist:a, ::'), ['sep:,', 'flat:::']);
// tag 里的数字不是权重；1girl 不是权重
assert.deepEqual(view('1girl, year 2025, mx2j::'), ['sep:,', 'sep:,', 'flat:::']);
assert.deepEqual(view('0.5::kanzarin:year 2026 ::'), ['down:0.5::', 'down:::']);
// 旧式括号
assert.deepEqual(view('{{a}}, [b]'), ['up:{', 'up:{', 'up:}', 'up:}', 'sep:,', 'down:[', 'down:]']);
// SD 显式权重只上色外壳；tag 名里的圆括号和转义括号不动
assert.deepEqual(view('(a, hiro (dismaless):1.3), (b:0.8)'), ['up:(', 'sep:,', 'up::1.3)', 'sep:,', 'down:(', 'down::0.8)']);
assert.deepEqual(view('hiro \\(dismaless\\), ie (raarami)'), ['sep:,']);
// 全角逗号
assert.deepEqual(view('a，b'), ['sep:，']);

// 标记有序、不重叠、不越界
for (const text of ['0.6::a::,b', '(x:1.2)', '{a}[b]', '1.5::a20 (atsumaru), noyu::', '']) {
  let last = 0;
  for (const mark of promptWeightMarks(text)) {
    assert.ok(mark.start >= last && mark.end > mark.start && mark.end <= text.length, text);
    last = mark.end;
  }
}
assert.deepEqual(promptWeightMarks(null), []);

console.log('prompt weights: ok');
