// 相关目录独立于图片召回：node tools/test_search_directories.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = name => pathToFileURL(path.resolve(`site/assets/app/${name}`)).href;
const {
  findRelatedDirectories,
  invalidateSearchDirectories,
  listSearchDirectories,
} = await import(moduleUrl('search-directories.js'));
const { state } = await import(moduleUrl('state.js'));
const { isEntryAccessBlocked } = await import(moduleUrl('access.js'));

state.allowNsfw = false;
state.allowR18g = false;

{
  const entries = [
    { id: 'a', title: 'A', path: ['各式场景', '场景'] },
    { id: 'b', title: 'B', path: ['场景', '室内'] },
    { id: 'c', title: 'C', path: ['各式场景', '室外'] },
  ];
  const matches = findRelatedDirectories({
    entries,
    codex: { id: 'demo', title: '示例法典' },
    positiveTerms: ['场景'],
    queryText: '场景',
  });
  assert.equal(matches[0].name, '场景', '目录名完全匹配应排在面包屑包含之前');
  assert.equal(matches[0].codexId, 'demo');
  assert.ok(matches.every(item => item.count > 0 && item.pathCode));
}

// 最终 tie-break 必须来自真实 tree preorder，不能被 entries 的首次出现顺序反转。
{
  const codex = {
    id: 'tree-demo',
    title: '原树排序测试',
    tree: [
      { name: '排序甲', children: [] },
      { name: '排序乙', children: [] },
    ],
  };
  const entries = [
    { id: 'second-first', path: ['排序乙'] },
    { id: 'first-last', path: ['排序甲'] },
  ];
  const matches = findRelatedDirectories({
    entries,
    codex,
    positiveTerms: ['排序'],
    queryText: '排序',
  });
  assert.deepEqual(matches.map(item => item.name), ['排序甲', '排序乙']);
  assert.deepEqual(
    listSearchDirectories({ entries, codex }).map(item => item.name),
    ['排序甲', '排序乙'],
    '目录选项本身也应沿用真实 tree preorder',
  );
}

// 全站 synthetic tree 含虚拟书名且顺序故意相反；只能读取 composite 中各真实来源树。
{
  const codex = {
    id: 'site-search',
    title: '全站搜索',
    tree: [
      { name: '虚拟乙书', children: [{ name: '真实目录丁', children: [] }] },
      { name: '虚拟甲书', children: [{ name: '真实目录乙', children: [] }] },
    ],
    _sourceDirectoryTrees: [
      {
        codexId: 'source-a',
        tree: [
          { name: '真实目录甲', children: [] },
          { name: '真实目录乙', children: [] },
        ],
      },
      {
        codexId: 'source-b',
        tree: [
          { name: '真实目录丙', children: [] },
          { name: '真实目录丁', children: [] },
        ],
      },
    ],
  };
  const entries = [
    { id: 'b-second', path: ['虚拟乙书', '真实目录丁'], _srcCodexId: 'source-b', _srcCodexTitle: '乙书', _srcPath: ['真实目录丁'] },
    { id: 'a-second', path: ['虚拟甲书', '真实目录乙'], _srcCodexId: 'source-a', _srcCodexTitle: '甲书', _srcPath: ['真实目录乙'] },
    { id: 'b-first', path: ['虚拟乙书', '真实目录丙'], _srcCodexId: 'source-b', _srcCodexTitle: '乙书', _srcPath: ['真实目录丙'] },
    { id: 'a-first', path: ['虚拟甲书', '真实目录甲'], _srcCodexId: 'source-a', _srcCodexTitle: '甲书', _srcPath: ['真实目录甲'] },
  ];
  const matches = findRelatedDirectories({
    entries,
    codex,
    siteSearchView: true,
    positiveTerms: ['真实目录'],
    queryText: '真实目录',
    limit: 10,
  });
  assert.deepEqual(
    matches.map(item => `${item.codexId}:${item.name}`),
    [
      'source-a:真实目录甲',
      'source-a:真实目录乙',
      'source-b:真实目录丙',
      'source-b:真实目录丁',
    ],
    '全站相关目录应按来源法典顺序及各自真实 tree preorder 排列',
  );
  assert.ok(matches.every(item => !item.breadcrumb.includes('虚拟')), '虚拟书名分组不得进入相关目录');
}

{
  const entries = [
    {
      id: 'site-a',
      title: 'A',
      path: ['梦神法典', '服装'],
      _srcCodexId: 'mengshen',
      _srcCodexTitle: '梦神法典',
      _srcPath: ['服装'],
    },
  ];
  const noVirtualMatches = findRelatedDirectories({
    entries,
    siteSearchView: true,
    positiveTerms: ['梦神'],
    queryText: '梦神',
  });
  assert.deepEqual(noVirtualMatches, [], '全站虚拟视图的书名分组不能成为目录候选');
  assert.equal(noVirtualMatches.totalCount, 0);
  const matches = findRelatedDirectories({
    entries,
    siteSearchView: true,
    positiveTerms: ['服装'],
    queryText: '服装',
  });
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].path, ['服装']);
  assert.equal(matches[0].codexId, 'mengshen');
}

{
  const entries = Array.from({ length: 8 }, (_, index) => ({
    id: `e${index}`,
    title: `E${index}`,
    path: [`测试目录${index}`],
  }));
  const matches = findRelatedDirectories({
    entries,
    codex: { id: 'demo', title: '示例法典' },
    positiveTerms: ['测试'],
    queryText: '测试',
  });
  assert.equal(matches.length, 5, '相关目录始终最多展示五项');
  assert.equal(matches.totalCount, 8, '展示截断后仍应保留权限过滤后的真实目录总数');
}

// 同一数据引用、视图、法典和权限组合复用目录表；任一维度改变都必须得到独立结果。
{
  const entries = [
    { id: 'public', path: ['公开目录'] },
    { id: 'nsfw', path: ['受限目录'], rating: 'nsfw' },
    { id: 'r18g', path: ['重口目录'], rating: 'r18g' },
  ];
  const codex = { id: 'cache-demo', title: '缓存测试' };
  invalidateSearchDirectories(entries);
  state.allowNsfw = false;
  state.allowR18g = false;
  const locked = listSearchDirectories({ entries, codex });
  assert.deepEqual(locked.map(item => item.name), ['公开目录']);
  assert.strictEqual(listSearchDirectories({ entries, codex }), locked, '相同缓存键应返回同一目录表');
  assert.notStrictEqual(
    listSearchDirectories({ entries, codex: { ...codex, title: '缓存测试二' } }),
    locked,
    '法典上下文改变后不能复用旧目录表',
  );
  assert.notStrictEqual(
    listSearchDirectories({ entries, codex, sourceView: true }),
    locked,
    '真实来源视图与普通法典视图不能共用目录表',
  );

  state.allowNsfw = true;
  const nsfwAllowed = listSearchDirectories({ entries, codex });
  assert.notStrictEqual(nsfwAllowed, locked, '权限改变后不能复用旧目录表');
  assert.deepEqual(nsfwAllowed.map(item => item.name), ['公开目录', '受限目录']);
  state.allowR18g = true;
  const allAllowed = listSearchDirectories({ entries, codex });
  assert.deepEqual(allAllowed.map(item => item.name), ['公开目录', '受限目录', '重口目录']);

  assert.equal(invalidateSearchDirectories(entries), true);
  assert.notStrictEqual(listSearchDirectories({ entries, codex }), allAllowed, '定点失效后应重新构建目录表');
  state.allowNsfw = false;
  state.allowR18g = false;
}

// 虚拟全站/收藏视图撤权后会先同步重过滤、再异步重建法典；同步阶段必须按真实来源整书锁态清空。
{
  const entries = [{
    id: 'source-secret',
    title: '来源受限词条',
    path: ['受限法典', '秘密目录'],
    _srcCodexId: 'locked-source',
    _srcCodexTitle: '受限法典',
    _srcPath: ['秘密目录'],
  }];
  state.codexes = [{ id: 'locked-source', title: '受限法典', nsfw: true }];
  state.allowNsfw = true;
  assert.equal(entries.filter(entry => !isEntryAccessBlocked(entry)).length, 1);
  assert.equal(listSearchDirectories({ entries, sourceView: true }).length, 1);

  state.allowNsfw = false;
  assert.equal(entries.filter(entry => !isEntryAccessBlocked(entry)).length, 0, '同步图片列表过滤不得保留整本锁定来源');
  const lockedDirectories = listSearchDirectories({ entries, sourceView: true });
  assert.deepEqual(lockedDirectories, [], '目录选择器不得保留整本锁定来源');
  const lockedRelated = findRelatedDirectories({
    entries,
    siteSearchView: true,
    positiveTerms: ['秘密'],
    queryText: '秘密',
  });
  assert.deepEqual(lockedRelated, [], '相关目录不得保留整本锁定来源');
  assert.equal(lockedRelated.totalCount, 0, '相关目录计数不得包含整本锁定来源');

  const r18gEntries = [{
    id: 'source-r18g',
    path: ['公开法典', 'R18G'],
    _srcCodexId: 'open-source',
    _srcCodexTitle: '公开法典',
    _srcPath: ['R18G'],
    rating: 'r18g',
  }];
  state.codexes = [{ id: 'open-source', title: '公开法典' }];
  state.allowNsfw = true;
  state.allowR18g = true;
  assert.equal(listSearchDirectories({ entries: r18gEntries, sourceView: true }).length, 1);
  state.allowR18g = false;
  assert.equal(r18gEntries.filter(entry => !isEntryAccessBlocked(entry)).length, 0, '同步图片列表过滤不得保留已撤权 R18G 来源词条');
  assert.deepEqual(listSearchDirectories({ entries: r18gEntries, sourceView: true }), [], '目录选择器不得保留已撤权 R18G 来源词条');
  state.codexes = [];
  state.allowNsfw = false;
}

// 调用方可把筛选器已生成的目录表传回相关目录查询，避免再次遍历词条。
{
  const entries = [
    { id: 'a', path: ['服装', '礼服'] },
    { id: 'b', path: ['服装', '日常'] },
  ];
  const codex = { id: 'reuse-demo', title: '复用测试' };
  const directories = listSearchDirectories({ entries, codex });
  const poisonEntries = new Proxy([], {
    get(target, key, receiver) {
      if (key === Symbol.iterator) throw new Error('传入预计算目录表后不应再次遍历 entries');
      return Reflect.get(target, key, receiver);
    },
  });
  const matches = findRelatedDirectories({
    entries: poisonEntries,
    directories,
    codex,
    positiveTerms: ['服装'],
    queryText: '服装',
  });
  assert.equal(matches.length, 3);
  assert.equal(matches.totalCount, 3);
  assert.deepEqual(matches[0].path, ['服装']);
}

console.log('search directories: PASS');
