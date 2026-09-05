// 搜索热路径、法典单飞缓存与全站搜索 memo 回归：node tools/test_search_data.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const moduleUrl = name => pathToFileURL(path.resolve(`site/assets/app/${name}`)).href;
const {
  hiddenSearchMatch,
  invalidateSearchableText,
  matchSearchPlan,
  parseSearchFilter,
  parseSearchFilters,
  parseSearchQuery,
  rankSearchResults,
  removeSearchQueryTerm,
  renderHighlightedText,
  searchRelevanceTier,
  searchableText,
  serializeSearchFilter,
  serializeSearchFilters,
  splitQueryTokens,
} = await import(moduleUrl('search.js'));
const { encodePathCode } = await import(moduleUrl('path-code.js'));
const { fetchCodex, normalizeCodex } = await import(moduleUrl('data.js'));
const {
  buildSiteSearchCodex,
  invalidateSiteSearchCodex,
} = await import(moduleUrl('site-search.js'));
const { buildFavoritesCodex } = await import(moduleUrl('fav-codex.js'));
const { state } = await import(moduleUrl('state.js'));
const { renderSearchFilters, setSearchUiActions, setupSearchUi } = await import(moduleUrl('search-ui.js'));

// 普通词和短语显示为可移除条件，但仍属于 q；删除时保留字段筛选和未完成输入。
{
  const query = '猫 蓝眼睛 "blue eyes"';
  const plan = parseSearchQuery(query, ['-default:男性']);
  assert.deepEqual(plan.queryConditions, [
    { value: '猫', label: '猫', quoted: false },
    { value: '蓝眼睛', label: '蓝眼睛', quoted: false },
    { value: 'blue eyes', label: 'blue eyes', quoted: true },
  ]);
  assert.equal(removeSearchQueryTerm(query, '蓝眼睛'), '猫 "blue eyes"');
  assert.deepEqual(parseSearchQuery(removeSearchQueryTerm(query, '猫'), plan.filterValues).positiveTerms, ['蓝眼睛', 'blue eyes']);
  assert.deepEqual(plan.filterValues, ['-default:男性'], '展示 q chips 不得把关键词转成 f');
  assert.equal(removeSearchQueryTerm('猫 猫 蓝眼睛', '猫'), '蓝眼睛', '删除去重条件必须移除所有等值词');
  assert.equal(parseSearchQuery('猫 猫').queryConditions.length, 1);
  assert.equal(removeSearchQueryTerm('猫,蓝眼睛', '猫'), '蓝眼睛');
  assert.equal(removeSearchQueryTerm('猫 “Blue Eyes”', '猫'), '"Blue Eyes"');
  assert.equal(removeSearchQueryTerm('猫 "path:服装"', '猫'), '"path:服装"');
  const escapedRemainder = parseSearchQuery(removeSearchQueryTerm('artist:foo,has:image', 'artist:foo'));
  assert.deepEqual(escapedRemainder.positiveTerms, ['has:image']);
  assert.deepEqual(escapedRemainder.filters, [], '逗号拆词后不能把剩余普通词误认成字段');
  for (const invalid of ['title:', 'has:other', '"blue eyes']) {
    const next = removeSearchQueryTerm(`猫 ${invalid}`, '猫');
    assert.equal(next, invalid);
    assert.equal(parseSearchQuery(next).hasErrors, true, '移除普通词不能抹掉错误使查询放宽');
  }
  assert.deepEqual(parseSearchQuery('猫 "blue eyes').queryConditions.map(item => item.value), ['猫']);
  assert.equal(removeSearchQueryTerm('猫', '猫'), '');
  const eleven = Array.from({ length: 11 }, (_, index) => `词${index}`).join(' ');
  assert.equal(parseSearchQuery(eleven).hasErrors, true);
  assert.equal(parseSearchQuery(removeSearchQueryTerm(eleven, '词0')).hasErrors, false);
  assert.equal(parseSearchQuery(removeSearchQueryTerm(eleven.replaceAll(' ', ','), '词0')).hasErrors, false);

  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFrame = globalThis.requestAnimationFrame;
  const originalComputedStyle = globalThis.getComputedStyle;
  const makeNode = (tag = 'div') => {
    const node = {
      tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, style: {},
      className: '', hidden: false, listeners: new Map(), parentElement: null,
      get firstElementChild() { return this.children[0] || null; },
      get lastElementChild() { return this.children.at(-1) || null; },
      append(...children) {
        for (const child of children) {
          child.remove();
          child.parentElement = this;
          this.children.push(child);
        }
      },
      insertBefore(child, reference) {
        if (child === reference) return child;
        child.remove();
        if (reference === null) this.append(child);
        else {
          const index = this.children.indexOf(reference);
          assert.notEqual(index, -1, 'insertBefore 的参考节点必须属于当前父节点');
          child.parentElement = this;
          this.children.splice(index, 0, child);
        }
        return child;
      },
      remove() {
        if (!this.parentElement) return;
        const siblings = this.parentElement.children;
        siblings.splice(siblings.indexOf(this), 1);
        this.parentElement = null;
      },
      replaceChildren(...children) {
        for (const child of [...this.children]) child.remove();
        this.append(...children);
      },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      removeAttribute(name) { delete this.attributes[name]; },
      querySelector(selector) { return this.children.find(child => child.tagName.toLowerCase() === selector) || null; },
      closest(selector) {
        if (selector.startsWith('.') && this.classList.contains(selector.slice(1))) return this;
        return this.parentElement?.closest(selector) || null;
      },
      getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 28 }; },
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      focus() { this.onFocus?.(); },
    };
    node.classList = {
      contains(name) { return node.className.split(/\s+/).includes(name); },
      toggle(name, force) {
        const classes = new Set(node.className.split(/\s+/).filter(Boolean));
        const enabled = force ?? !classes.has(name);
        if (enabled) classes.add(name);
        else classes.delete(name);
        node.className = [...classes].join(' ');
        return enabled;
      },
    };
    return node;
  };
  const nodes = new Map(['searchFilterSummary', 'searchFilterChips', 'searchClearAllBtn', 'searchFilterClearAll',
    'searchFilterBtn', 'searchFilterCount', 'searchFilterFeedback', 'searchFilterPanel', 'searchFilterForm'].map(id => [id, makeNode()]));
  globalThis.document = {
    getElementById: id => nodes.get(id), createElement: makeNode, addEventListener() {},
    body: makeNode('body'), documentElement: makeNode('html'),
  };
  globalThis.window = { addEventListener() {}, scrollX: 0, scrollY: 0, matchMedia: () => ({ matches: true }) };
  globalThis.requestAnimationFrame = () => {};
  globalThis.getComputedStyle = () => ({ opacity: '1' });
  try {
    renderSearchFilters({ queryConditions: plan.queryConditions, filters: plan.filters, hasActiveSearch: true });
    assert.deepEqual(nodes.get('searchFilterChips').children.map(chip => chip.children[0].textContent),
      ['关键词 猫', '关键词 蓝眼睛', '完整短语 blue eyes', '关键词 排除 男性']);
    assert.equal(nodes.get('searchFilterCount').textContent, '4', '正向词与字段 chips 合并计数');
    assert.equal(nodes.get('searchFilterSummary').hidden, false);
    renderSearchFilters({ hasActiveSearch: true });
    assert.equal(nodes.get('searchFilterSummary').hidden, true, '无可显示条件时不能留下空行');
    assert.equal(nodes.get('searchClearAllBtn').hidden, false, '错误查询仍可从固定入口清除');
    renderSearchFilters({ hasActiveSearch: false });
    assert.equal(nodes.get('searchClearAllBtn').hidden, true);

    // 新输入尚在防抖期时点旧 chip，pointerdown 不能先触发 blur 使 click 目标被销毁。
    setupSearchUi();
    const chips = nodes.get('searchFilterChips');
    const display = query => renderSearchFilters({ queryConditions: parseSearchQuery(query).queryConditions });
    let draft = '猫 蓝眼睛';
    display(draft);
    const oldRemove = chips.children[0].children[1];
    const target = { closest: () => oldRemove };
    draft = '猫 蓝眼睛 白色';
    let prevented = false;
    chips.listeners.get('pointerdown')({ button: 0, target, preventDefault() { prevented = true; } });
    if (!prevented) display(draft);
    assert.strictEqual(chips.children[0].children[1], oldRemove, '按下时保留目标，不能因输入框 blur 重建它');
    nodes.get('searchFilterBtn').onFocus = () => display(draft);
    setSearchUiActions({ removeQueryTerm(value) { draft = removeSearchQueryTerm(draft, value); display(draft); } });
    chips.listeners.get('click')({ target });
    assert.equal(draft, '蓝眼睛 白色', '第一次点击既删除旧条件，也保留最新输入');
    const keyboardRemove = chips.children[0].children[1];
    chips.listeners.get('click')({ target: { closest: () => keyboardRemove } });
    assert.equal(draft, '白色', '键盘 click 无 pointerdown 也可删除');
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.requestAnimationFrame = originalFrame;
    globalThis.getComputedStyle = originalComputedStyle;
  }
}

// 引号短语保持整体匹配，高亮词与匹配词必须来自同一份 terms。
{
  const plan = parseSearchQuery('path:服装 "red dress" blue，lace');
  assert.equal(plan.isSyntax, true);
  assert.deepEqual(plan.path, ['服装']);
  assert.deepEqual(plan.terms, ['red dress', 'blue', 'lace']);
  assert.deepEqual(plan.highlightTerms, ['red dress', 'blue', 'lace', '服装']);
  assert.equal(matchSearchPlan({ title: 'red dress with blue lace', path: ['服装'] }, plan), true);
  assert.equal(matchSearchPlan({ title: 'red silk dress with blue lace', path: ['服装'] }, plan), false);

  const plain = parseSearchQuery('"red dress"');
  assert.deepEqual(plain.terms, ['red dress']);
  assert.equal(matchSearchPlan({ title: 'red dress', path: [] }, plain), true);
  assert.equal(matchSearchPlan({ title: 'red summer dress', path: [] }, plain), false);
  const plainWords = parseSearchQuery('red blue');
  assert.equal(plainWords.isSyntax, false);
  assert.equal(plainWords.text, 'red blue');
  assert.deepEqual(plainWords.terms, ['blue', 'red']);
  assert.deepEqual(plainWords.highlightTerms, plainWords.terms);
  assert.deepEqual(splitQueryTokens('path:"a b" "red dress"'), ['path:a b', 'red dress']);

  const escapedSyntax = parseSearchQuery('"path:foo"');
  assert.deepEqual(escapedSyntax.filters, []);
  assert.deepEqual(escapedSyntax.positiveTerms, ['path:foo']);
  assert.equal(escapedSyntax.isSyntax, false);
  assert.equal(matchSearchPlan({ title: '', tags: 'path:foo', path: [] }, escapedSyntax), true);
  assert.equal(matchSearchPlan({ title: '', tags: '', path: ['path:foo'] }, escapedSyntax), false);
  const excludedEscapedSyntax = parseSearchQuery('-"path:foo"');
  assert.deepEqual(excludedEscapedSyntax.filters, [
    { field: 'default', op: 'exclude', value: 'path:foo' },
  ]);
  assert.equal(matchSearchPlan({ title: '', tags: 'path:foo' }, excludedEscapedSyntax), false);
  assert.equal(matchSearchPlan({ title: '', tags: 'other' }, excludedEscapedSyntax), true);
}

// 匹配与高亮都使用 NFKC + 小写规范化；展示仍保留原始全角字形与空白。
{
  const plan = parseSearchQuery('abc x');
  assert.equal(matchSearchPlan({ title: 'ＡＢＣ   X', tags: '' }, plan), true);
  const originalDocument = globalThis.document;
  const makeContainer = type => ({
    type,
    children: [],
    appendChild(child) { this.children.push(child); },
  });
  globalThis.document = {
    createDocumentFragment: () => makeContainer('fragment'),
    createTextNode: text => ({ type: 'text', textContent: text }),
    createElement: tag => ({ type: tag, textContent: '' }),
  };
  try {
    const element = {
      children: [],
      replaceChildren(fragment) { this.children = fragment.children; },
    };
    renderHighlightedText(element, 'ＡＢＣ   X 尾部', ['abc x']);
    assert.equal(element.children[0].type, 'mark');
    assert.equal(element.children[0].textContent, 'ＡＢＣ   X');
    assert.equal(element.children[1].textContent, ' 尾部');
  } finally {
    globalThis.document = originalDocument;
  }
}

// 默认召回严格限于标题、tags 与角色正向 prompt，路径和隐藏字段不能让整目录误入结果。
{
  const hiddenOnly = {
    id: 'hidden',
    title: '普通标题',
    tags: 'ordinary tag',
    negative: '负面针',
    note: '备注针',
    rawTags: '原始针',
    path: ['目录针'],
    characterPrompts: [{ label: '标签针', prompt: '角色正向针', negative: '角色负面针' }],
  };
  for (const query of ['负面针', '备注针', '原始针', '目录针', '标签针', '角色负面针']) {
    assert.equal(matchSearchPlan(hiddenOnly, parseSearchQuery(query)), false, `${query} 不应进入默认召回`);
  }
  assert.equal(matchSearchPlan(hiddenOnly, parseSearchQuery('普通标题 ordinary')), true);
  assert.equal(matchSearchPlan(hiddenOnly, parseSearchQuery('角色正向针')), true);
  assert.equal(matchSearchPlan(hiddenOnly, parseSearchQuery('-负面针')), true, '默认排除也只能查看默认可见字段');
  assert.doesNotMatch(searchableText(hiddenOnly), /目录针|负面针|备注针|原始针|标签针/);
}

// 标题 / tags / 角色正向 prompt 可见命中无需解释；显式隐藏字段命中给出可核对摘录。
{
  assert.equal(hiddenSearchMatch({ title: 'Blue dress', tags: 'lace' }, ['blue']), null);
  assert.deepEqual(
    hiddenSearchMatch({ title: 'A', tags: 'B', negative: 'low quality, blurry' }, ['blurry']),
    { label: '负面词', excerpt: 'low quality, blurry' },
  );
  assert.equal(hiddenSearchMatch({ title: 'red', tags: '', note: 'blue detail' }, ['red', 'blue']).label, '备注');
  assert.equal(hiddenSearchMatch({
    title: 'A',
    tags: '',
    characterPrompts: [{ label: 'girl', prompt: 'green eyes' }],
  }, ['green']), null);
  assert.equal(hiddenSearchMatch({
    title: 'A',
    tags: '',
    characterPrompts: [{ label: 'girl', prompt: 'green eyes', negative: 'bad hand' }],
  }, ['bad']).label, '负面词');
  assert.equal(hiddenSearchMatch({ title: 'A', tags: '', note: 'hidden' }, []), null);
}

// typed syntax 与 repeated f 共用一种 SearchFilter；未知冒号仍是普通 NovelAI tag。
{
  const plan = parseSearchQuery('猫 “blue eyes” -男性 标题：少女 图片：有 作者：Alice artist:foo');
  assert.deepEqual(plan.positiveTerms, ['猫', 'blue eyes', 'artist:foo']);
  assert.equal(plan.canonicalQuery, '猫 "blue eyes" artist:foo');
  assert.deepEqual(plan.filterValues, [
    '-default:男性',
    'title:少女',
    'has:image',
    'author:Alice',
  ]);
  assert.equal(plan.hasLegacyFilters, true);
  assert.equal(plan.canCanonicalize, true);
  assert.equal(plan.issues.length, 0);
  assert.equal(matchSearchPlan({ title: '少女和猫', tags: 'blue eyes, artist:foo', images: [{}], _srcAuthor: 'Alice' }, plan), true);
  assert.equal(matchSearchPlan({ title: '少女和男性猫', tags: 'blue eyes, artist:foo', images: [{}], _srcAuthor: 'Alice' }, plan), false);

  const unknown = parseSearchQuery('artist:foo');
  assert.deepEqual(unknown.positiveTerms, ['artist:foo']);
  assert.deepEqual(unknown.filters, []);
  assert.equal(unknown.hasErrors, false);
  assert.equal(matchSearchPlan({ title: '', tags: 'artist:foo' }, unknown), true);
}

// 单项与批量 f 可稳定往返；目录 filter 保留真实法典和路径短码。
{
  const directory = {
    field: 'directory',
    op: 'include',
    value: '',
    codexId: 'book-a',
    pathCode: encodePathCode(['服装', '礼服']),
  };
  assert.equal(serializeSearchFilter(directory), `dir:book-a:${directory.pathCode}`);
  assert.deepEqual(parseSearchFilter('标签:blue eyes').filter, {
    field: 'prompt', op: 'include', value: 'blue eyes',
  });
  const serialized = serializeSearchFilters([
    { field: 'title', op: 'include', value: '少女' },
    { field: 'negative', op: 'exclude', value: 'low quality' },
    { field: 'has', op: 'is', value: false },
    { field: 'fav', op: 'is', value: true },
    directory,
  ]);
  assert.deepEqual(serialized, [
    'title:少女',
    '-negative:low quality',
    'has:noimage',
    'fav:true',
    `dir:book-a:${directory.pathCode}`,
  ]);
  const parsed = parseSearchFilters(serialized);
  assert.equal(parsed.issues.length, 0);
  assert.deepEqual(serializeSearchFilters(parsed.filters), serialized);

  state.codex = { id: 'other-book', type: 'codex', contributors: [] };
  assert.equal(matchSearchPlan({
    _srcCodexId: 'book-a',
    _srcPath: ['服装', '礼服'],
    path: ['虚拟书名', '服装', '礼服'],
  }, parseSearchQuery('', [`dir:book-a:${directory.pathCode}`])), true);
  const parentDirectory = encodePathCode(['服装']);
  assert.equal(matchSearchPlan({
    _srcCodexId: 'book-a',
    _srcPath: ['服装', '礼服'],
  }, parseSearchQuery('', [`dir:book-a:${parentDirectory}`])), true, '精确目录应包含全部后代词条');
  assert.equal(matchSearchPlan({
    _srcCodexId: 'book-a',
    _srcPath: ['服装', '日常'],
  }, parseSearchQuery('', [`dir:book-a:${directory.pathCode}`])), false);
  assert.equal(matchSearchPlan({
    _srcCodexId: 'book-a',
    _srcPath: ['其他', '礼服'],
  }, parseSearchQuery('', [`dir:book-a:${parentDirectory}`])), false, '同名后代不能越过所选父目录');
}

// 显式字段查询覆盖隐藏字段；path 使用真实来源路径而不是全站搜索的虚拟书名分组。
{
  state.codex = { id: 'book-a', title: 'Book A', type: 'pack', author: 'Owner', contributors: [] };
  const entry = {
    id: 'e1',
    title: 'Hero',
    tags: 'red cape',
    negative: 'low quality',
    note: 'curated note',
    rawTags: 'raw secret',
    characterPrompts: [{ prompt: 'green eyes', negative: 'bad hand' }],
    _srcCodexId: 'book-a',
    _srcCodexTitle: 'Book A',
    _srcType: 'pack',
    _srcAuthor: 'Alice',
    _srcPath: ['服装', '披风'],
    path: ['Book A', '服装', '披风'],
    images: [{ path: 'x.webp', author: 'Bob' }],
  };
  for (const filter of [
    'title:hero',
    'prompt:green eyes',
    'negative:bad hand',
    'note:curated',
    'raw:secret',
    'author:alice',
    'author:bob',
    'codex:book a',
    'type:图包',
    'path:服装/披风',
    'has:image',
  ]) {
    assert.equal(matchSearchPlan(entry, parseSearchQuery('', [filter])), true, `${filter} 应命中`);
  }
  assert.equal(matchSearchPlan(entry, parseSearchQuery('', ['path:Book A'])), false, '虚拟书名不属于真实路径');
  assert.equal(matchSearchPlan(entry, parseSearchQuery('', ['-negative:quality'])), false);
  assert.equal(matchSearchPlan(entry, parseSearchQuery('', ['-negative:blurry'])), true);
  state.codexes = [{ id: 'book-a', aliases: [] }];
  state.favs.clear();
  state.favs.add('book-a:e1');
  assert.equal(matchSearchPlan(entry, parseSearchQuery('', ['fav:true'])), true);
  assert.equal(matchSearchPlan({ ...entry, id: 'e2' }, parseSearchQuery('', ['fav:true'])), false);
  state.favs.clear();
}

// 已知错误必须 fail closed，非法 f 原值要保留，且文本条件不再静默截断。
{
  for (const plan of [
    parseSearchQuery('title:'),
    parseSearchQuery('has:maybe'),
    parseSearchQuery('"未闭合'),
    parseSearchQuery('""'),
    parseSearchQuery('，；、'),
    parseSearchQuery('，；、', ['has:image']),
    parseSearchQuery('', ['']),
    parseSearchQuery('', ['unknown:value']),
    parseSearchQuery('一 二 三 四 五 六 七 八 九 十 十一'),
  ]) {
    assert.equal(plan.hasErrors, true);
    assert.equal(matchSearchPlan({ title: '一二三四五六七八九十十一', tags: '' }, plan), false);
  }
  const invalidF = parseSearchQuery('', ['has:maybe', '']);
  assert.deepEqual(invalidF.filterValues, ['has:maybe', '']);
  assert.ok(invalidF.issues.some(issue => issue.code === 'invalid_enum'));
  assert.ok(invalidF.issues.some(issue => issue.code === 'empty_filter'));
  assert.equal(parseSearchQuery('title:').isSyntax, true);
  assert.equal(parseSearchQuery('，；、').issues[0].code, 'empty_search');
  assert.equal(parseSearchQuery('一 二 三 四 五 六 七 八 九 十 十一').issues[0].code, 'too_many_text_conditions');
}

// 相关性分层固定，同层保持输入顺序；纯结构筛选不改变顺序。
{
  const plan = parseSearchQuery('blue eyes');
  const entries = [
    { id: 'prompt-a', title: 'Portrait', tags: 'blue eyes' },
    { id: 'mixed', title: 'Blue portrait', tags: 'bright eyes' },
    { id: 'all-title', title: 'Portrait blue clear eyes', tags: '' },
    { id: 'prefix', title: 'Blue eyes portrait', tags: '' },
    { id: 'exact', title: 'Blue Eyes', tags: '' },
    { id: 'prompt-b', title: 'Another', tags: 'blue eyes' },
  ];
  assert.deepEqual(entries.map(entry => searchRelevanceTier(entry, plan)), [4, 3, 2, 1, 0, 4]);
  assert.deepEqual(rankSearchResults(entries, plan).map(entry => entry.id), [
    'exact', 'prefix', 'all-title', 'mixed', 'prompt-a', 'prompt-b',
  ]);
  const structural = parseSearchQuery('', ['has:noimage']);
  assert.deepEqual(rankSearchResults(entries, structural), entries);
  assert.notStrictEqual(rankSearchResults(entries, structural), entries);
}

// searchableText 按对象缓存，编辑态就地修改后可显式失效。
{
  const entry = { title: '旧标题', tags: '', path: [] };
  assert.match(searchableText(entry), /旧标题/);
  entry.title = '新标题';
  assert.match(searchableText(entry), /旧标题/, '失效前应命中同一对象的缓存');
  assert.equal(invalidateSearchableText(entry), true);
  assert.match(searchableText(entry), /新标题/);
}

// 纯语法查询不应触碰 searchableText 的字段 getter。
{
  const entry = {
    get title() { throw new Error('纯语法查询不应构建文本'); },
    path: [],
    images: [],
  };
  assert.equal(matchSearchPlan(entry, parseSearchQuery('has:noimage')), true);
  const authorOnly = {
    get title() { throw new Error('作者筛选不应构建默认文本'); },
    _srcAuthor: 'Alice',
    images: [],
  };
  assert.equal(matchSearchPlan(authorOnly, parseSearchQuery('author:alice')), true);
  const visibleOnly = {
    title: 'needle',
    tags: '',
    get negative() { throw new Error('默认搜索不应读取隐藏字段'); },
    get note() { throw new Error('默认搜索不应读取隐藏字段'); },
    get rawTags() { throw new Error('默认搜索不应读取隐藏字段'); },
    get path() { throw new Error('默认搜索不应读取路径'); },
  };
  assert.equal(matchSearchPlan(visibleOnly, parseSearchQuery('needle')), true);
}

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
try {
  // 首次并发请求共享一个在途 Promise，完成后继续复用同一个归一化对象。
  {
    state.codexCache.clear();
    let releaseFetch;
    const gate = new Promise(resolve => { releaseFetch = resolve; });
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      await gate;
      return {
        ok: true,
        json: async () => ({ id: 'remote', title: 'Remote', entries: [{ id: 'e1', title: 'A' }] }),
      };
    };
    const meta = { id: 'remote', dataUrl: 'https://example.test/remote.json' };
    const first = fetchCodex(meta);
    const second = fetchCodex(meta);
    assert.equal(calls, 1);
    assert.ok(state.codexCache.get('remote') instanceof Promise);
    releaseFetch();
    const [a, b] = await Promise.all([first, second]);
    assert.strictEqual(a, b);
    assert.strictEqual(await fetchCodex(meta), a);
    assert.equal(calls, 1);
  }

  // reject 后删除在途项，让下一次调用能够重试。
  {
    state.codexCache.clear();
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error('offline');
    };
    const meta = { id: 'retry', dataUrl: 'https://example.test/retry.json' };
    await assert.rejects(fetchCodex(meta), /offline/);
    assert.equal(state.codexCache.has('retry'), false);
    await assert.rejects(fetchCodex(meta), /offline/);
    assert.equal(calls, 2);
  }

  // 外部源降级成功也不留缓存，下一次仍会优先重试外部源。
  {
    state.codexCache.clear();
    let primaryCalls = 0;
    let fallbackCalls = 0;
    console.warn = () => {};
    globalThis.fetch = async url => {
      if (String(url).includes('primary.test')) {
        primaryCalls += 1;
        throw new Error('primary down');
      }
      fallbackCalls += 1;
      return {
        ok: true,
        json: async () => ({ id: 'fallback', title: 'Fallback', entries: [] }),
      };
    };
    const meta = {
      id: 'fallback',
      dataUrl: 'https://primary.test/fallback.json',
      fallbackDataUrl: 'https://fallback.test/fallback.json',
    };
    assert.equal((await fetchCodex(meta)).dataStatus, '发布回退数据');
    assert.equal(state.codexCache.has('fallback'), false);
    await fetchCodex(meta);
    assert.equal(primaryCalls, 2);
    assert.equal(fallbackCalls, 2);
  }

  // 全站搜索只 memo 全成功结果；显式失效后重建，失败的半成品不会冻结。
  {
    const metaA = { id: 'a', title: 'A', entryCount: 1 };
    const codexA = normalizeCodex({ id: 'a', title: 'A', entries: [{ id: 'a1', title: 'one' }] }, metaA);
    state.allowNsfw = false;
    state.allowR18g = false;
    state.codexes = [metaA];
    state.codexCache.clear();
    state.codexCache.set('a', Promise.resolve(codexA));
    invalidateSiteSearchCodex();
    const built = await buildSiteSearchCodex();
    assert.strictEqual(await buildSiteSearchCodex(), built);
    assert.deepEqual(built._sourceDirectoryTrees.map(source => source.codexId), ['a']);
    assert.strictEqual(built._sourceDirectoryTrees[0].tree, codexA.tree, '全站 composite 必须保留真实来源 tree');
    codexA.entries.push({ id: 'a2', title: 'two', path: [], images: [] });
    assert.equal((await buildSiteSearchCodex()).entryCount, 1, '命中时应复用完整构建结果');
    invalidateSiteSearchCodex();
    const rebuilt = await buildSiteSearchCodex();
    assert.notStrictEqual(rebuilt, built);
    assert.equal(rebuilt.entryCount, 2);

    const metaB = { id: 'b', title: 'B', entryCount: 1 };
    const codexB = normalizeCodex({ id: 'b', title: 'B', entries: [{ id: 'b1', title: 'three' }] }, metaB);
    state.codexes = [metaA, metaB];
    state.codexCache.set('b', Promise.reject(new Error('temporary')));
    console.warn = () => {};
    const partial = await buildSiteSearchCodex();
    assert.match(partial.dataNotice, /加载失败/);
    state.codexCache.set('b', Promise.resolve(codexB));
    const retried = await buildSiteSearchCodex();
    assert.notStrictEqual(retried, partial);
    assert.equal(retried.entryCount, 3);
    assert.equal(retried.dataNotice, '');

    state.codexes = [metaA];
    state.codexCache.set('a', Promise.resolve({ ...codexA, dataStatus: '发布回退数据' }));
    invalidateSiteSearchCodex();
    const degraded = await buildSiteSearchCodex();
    state.codexCache.set('a', Promise.resolve(codexA));
    const recovered = await buildSiteSearchCodex();
    assert.notStrictEqual(recovered, degraded, '外部源降级结果不能进入全站搜索 memo');

    let releaseOldBuild;
    const oldBuild = new Promise(resolve => { releaseOldBuild = resolve; });
    const latestCodex = normalizeCodex(
      { id: 'a', title: 'A', entries: [{ id: 'latest', title: 'latest' }] },
      metaA,
    );
    state.codexCache.set('a', oldBuild);
    invalidateSiteSearchCodex();
    const pendingBuild = buildSiteSearchCodex();
    state.codexCache.set('a', Promise.resolve(latestCodex));
    invalidateSiteSearchCodex();
    releaseOldBuild(codexA);
    const refreshedDuringBuild = await pendingBuild;
    assert.equal(refreshedDuringBuild.entries[0].id, 'latest', '失效中的旧构建不能迟到覆盖新结果');
  }

  // 收藏 composite 与全站使用同一真实来源树契约，不能拿虚拟书名分组 tree 排同级目录。
  {
    const meta = { id: 'fav-source', title: '收藏来源' };
    const sourceTree = [
      { name: '原树甲', count: 1, children: [] },
      { name: '原树乙', count: 1, children: [] },
    ];
    const codex = normalizeCodex({
      id: 'fav-source',
      title: '收藏来源',
      tree: sourceTree,
      entries: [{ id: 'fav-entry', title: '收藏词条', path: ['原树甲'] }],
    }, meta);
    state.codexes = [meta];
    state.codexCache.clear();
    state.codexCache.set(meta.id, Promise.resolve(codex));
    state.favs.clear();
    state.favs.add('fav-source:fav-entry');
    const favorites = await buildFavoritesCodex();
    assert.deepEqual(favorites._sourceDirectoryTrees.map(source => source.codexId), ['fav-source']);
    assert.strictEqual(favorites._sourceDirectoryTrees[0].tree, sourceTree, '收藏 composite 必须保留真实来源 tree');
    state.favs.clear();
  }
} finally {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  state.codexCache.clear();
  state.favs.clear();
}

console.log('search/data/site-search: PASS');
