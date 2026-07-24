// edit-core.js 纯函数测试（node 直跑）：node tools/test_edit_client.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const coreUrl = pathToFileURL(path.resolve('site/assets/app/edit-core.js')).href;
const {
  TREE_PATH_SEP, splitTreePath, joinTreePath, buildPathList, diffFields, validateEntryForm, mergeEntryInPlace,
} = await import(coreUrl);

// 分隔符必须是 U+0001（与 codex-ui 的 dataset.path 一致），不能漂成别的字符
assert.equal(TREE_PATH_SEP.length, 1);
assert.equal(TREE_PATH_SEP.charCodeAt(0), 1, 'TREE_PATH_SEP 必须是 U+0001');

// buildPathList：深度优先展开，label 用 ' / '，value 用分隔符
{
  const tree = [
    { name: '甲', count: 3, children: [{ name: '乙', count: 1, children: [] }] },
    { name: '丙', count: 2, children: [] },
  ];
  const list = buildPathList(tree);
  assert.deepEqual(list.map(p => p.label), ['甲', '甲 / 乙', '丙']);
  assert.equal(list[1].value, '甲' + TREE_PATH_SEP + '乙');
  assert.deepEqual(list[1].parts, ['甲', '乙']);
  assert.deepEqual(buildPathList([]), []);
  assert.deepEqual(buildPathList(undefined), []);
}

// split / join 往返
{
  const parts = ['一', '二', '三'];
  assert.equal(splitTreePath(joinTreePath(parts)).join('|'), '一|二|三');
  assert.deepEqual(splitTreePath(''), []);
}

// diffFields：只输出真正变化的字段
{
  const entry = { title: 'A', tags: 't', negative: 'n', note: '', rating: 'safe', isNew: false, path: ['甲'] };
  // 无变化
  assert.deepEqual(diffFields(entry, {
    title: 'A', tags: 't', negative: 'n', note: '', rating: 'safe', isNew: false, pathValue: '甲',
  }), {});
  // 改标题 + 清负面 + 打开 isNew
  assert.deepEqual(diffFields(entry, {
    title: 'B', tags: 't', negative: '', note: '', rating: 'safe', isNew: true, pathValue: '甲',
  }), { title: 'B', negative: '', isNew: true });
  // 改分级为空 = 删除
  assert.deepEqual(diffFields(entry, { rating: '' }), { rating: '' });
  // 改分类
  assert.deepEqual(diffFields(entry, { pathValue: '甲' + TREE_PATH_SEP + '乙' }), { path: ['甲', '乙'] });
  // 空分类不产生 path 变更
  assert.deepEqual(diffFields(entry, { pathValue: '' }), {});
}

// validateEntryForm
{
  assert.equal(validateEntryForm({ title: 'x', tags: 'y' }), '');
  assert.equal(validateEntryForm({ title: '  ', tags: 'y' }), '标题不能为空');
  assert.equal(validateEntryForm({ title: 'x', tags: ' ' }), '正向 Tag 不能为空');
  assert.equal(validateEntryForm({ title: 'x', tags: 'y' }, { requireAll: true }), '必须选择分类');
  assert.equal(validateEntryForm({ title: 'x', tags: 'y', pathValue: '甲' }, { requireAll: true }), '');
  // 只改一个字段时不强求其它字段（非 requireAll）
  assert.equal(validateEntryForm({ note: 'z' }), '');
}

// mergeEntryInPlace：把服务器词条同步进内存对象，删除的键要清掉
{
  const entry = {
    title: '旧', tags: 't', negative: 'n', note: 'x', path: ['甲'], rating: 'safe', isNew: true,
    image: 'a.jpg', assetRev: 'r', imageWidth: 10, imageHeight: 20, characterPrompts: [{ label: 'char1' }],
  };
  mergeEntryInPlace(entry, { title: '新', tags: 't2', path: ['乙'] });
  assert.equal(entry.title, '新');
  assert.equal(entry.tags, 't2');
  assert.equal(entry.negative, '');   // 服务器未带 = 清空
  assert.deepEqual(entry.path, ['乙']);
  assert.ok(!('rating' in entry), 'rating 未带应删除');
  assert.equal(entry.isNew, false);
  assert.ok(!('image' in entry), 'image 未带应删除');
  assert.ok(!('assetRev' in entry));
  // characterPrompts 不在图片键白名单里，mergeEntryInPlace 不管它（保留由前端 normalize 负责）
}

console.log('edit-core pure functions: PASS');
