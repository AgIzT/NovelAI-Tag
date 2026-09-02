import assert from 'node:assert/strict';
import { encodePathCode, pathFromCode } from '../site/assets/app/path-code.js';

// 真实数据里的形状：中文、空格、间隔号，还有名字里自带 '/' 和 '+' 的分类
const tree = [
  {
    name: '梦神 · 社区图包',
    children: [
      { name: '个人精选韩国图包', children: [{ name: '常规' }, { name: 'NSFW' }] },
      { name: '韩国大舞台' },
    ],
  },
  { name: '社区 · AI杂图', children: [{ name: '2+girl/+1boy系列' }] },
  { name: '腿/脚' },
];

{
  const path = ['梦神 · 社区图包', '个人精选韩国图包'];
  const code = encodePathCode(path);
  assert.match(code, /^[0-9a-z]+$/, '短码必须是纯 ASCII');
  assert.ok(code.length <= 7, `短码不该超过 7 字符，实际 ${code.length}`);
  assert.deepEqual(pathFromCode(tree, code), path);
  assert.equal(code, encodePathCode([...path]), '同一路径必须稳定出同一个码');
}

// 名字里带 '/' 和 '+' 的分类是这套设计的由来：不能靠字符串拼接表示层级
{
  for (const path of [['腿/脚'], ['社区 · AI杂图', '2+girl/+1boy系列']]) {
    assert.deepEqual(pathFromCode(tree, encodePathCode(path)), path);
  }
  assert.notEqual(
    encodePathCode(['a', 'b']),
    encodePathCode(['a/b']),
    '层级不同就必须是不同的码，否则 腿/脚 会被当成两层',
  );
}

// 全站每本法典的目录节点都在几十到几百个量级，同一本书里不许撞码
{
  const seen = new Map();
  const walk = (nodes, prefix) => {
    for (const node of nodes || []) {
      const path = [...prefix, node.name];
      const code = encodePathCode(path);
      const previous = seen.get(code);
      assert.ok(!previous, `短码撞车：${JSON.stringify(previous)} vs ${JSON.stringify(path)}`);
      seen.set(code, path);
      walk(node.children, path);
    }
  };
  walk(tree, []);
}

// 解不出来就退回根目录，不抛错——分类改名后的旧链接走的就是这条路
{
  assert.deepEqual(pathFromCode(tree, 'zzzzzz'), []);
  assert.deepEqual(pathFromCode(tree, ''), []);
  assert.deepEqual(pathFromCode(null, 'zzzzzz'), []);
  assert.deepEqual(pathFromCode(tree, null), []);
  assert.equal(encodePathCode([]), '');
  assert.equal(encodePathCode(null), '');
  assert.equal(encodePathCode(['  ', '']), '', '空白段等同于没有路径');
}

// 短码只查树，不认不存在的路径
{
  assert.deepEqual(pathFromCode(tree, encodePathCode(['不存在的分类'])), []);
}

console.log('path code tests passed');
