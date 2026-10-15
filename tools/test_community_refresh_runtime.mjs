// 执行 app.js 实际刷新函数，替换 DOM/网络边界以精确控制在途时序。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { state } from '../site/assets/app/state.js';
import { isEntryAccessBlocked } from '../site/assets/app/access.js';
import { normalizeCodex, buildTreeFromEntries } from '../site/assets/app/data.js';
import { hasEntryImage } from '../site/assets/app/media.js';
import { adaptCommunityCodex, COMMUNITY_META, COMMUNITY_CODEX_ID } from '../site/assets/app/community-codex.js';
import { replaceCommunityEntries } from '../site/assets/app/community-refresh.js';

const source = await readFile(new URL('../site/assets/app.js', import.meta.url), 'utf8');
const start = source.indexOf('let communityRefreshPending = null;');
const end = source.indexOf('function setupCommunityIntegration()', start);
assert.ok(start >= 0 && end > start, '应提取实际 app.js 刷新实现');
const refreshSource = source.slice(start, end);
const virtualStart = source.indexOf('export async function openFavoritesView(');
const virtualEnd = source.indexOf('export async function openRelatedDirectory(', virtualStart);
assert.ok(virtualStart >= 0 && virtualEnd > virtualStart);
const virtualSource = source.slice(virtualStart, virtualEnd).replace(/^export /gm, '');
const favoritesStart = source.indexOf('async function refreshFavoritesView(');
const favoritesEnd = source.indexOf('async function applyAtlasHistoryRoute(', favoritesStart);
assert.ok(favoritesStart >= 0 && favoritesEnd > favoritesStart);
const favoritesSource = source.slice(favoritesStart, favoritesEnd);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const post = (fields = {}) => ({
  id: '1234abcd', title: '原投稿', prompt: 'safe prompt', category: ['场景'], nsfw: false,
  images: [0, 1].map(index => ({ file: `https://images.example.test/${index}.webp`, original: `https://images.example.test/${index}.png` })),
  ...fields,
});
const book = entries => normalizeCodex(adaptCommunityCodex({ entries, features: { likes: true } }), COMMUNITY_META);
const oldBook = () => book([post()]);

function runtime({ view = oldBook(), next = oldBook(), favorites = [], initialBuilt = favorites, cached = next,
  virtualResult = view, transitionGate = null, onTransition = () => {} } = {}) {
  Object.assign(state, {
    codex: view, codexes: [COMMUNITY_META], browseCodex: view.id === COMMUNITY_CODEX_ID ? view : oldBook(),
    favoritesView: view.view === 'favorites', siteSearchView: view.view === 'site-search',
    favs: new Set(favorites), allowNsfw: false, allowR18g: false,
    activePath: [], searchReturnPath: [], seenAnimated: new Set(), searchFilterValues: [],
    lightbox: { entry: null, images: [], index: 0 },
  });
  const events = [];
  let pendingResult = next;
  let currentSnapshot = cached;
  let currentVirtual = virtualResult;
  const dependencies = {
    document: { dispatchEvent() {} }, CustomEvent: class { constructor(type) { this.type = type; } },
    state, COMMUNITY_META, COMMUNITY_CODEX_ID, isEntryAccessBlocked, buildTreeFromEntries, normalizeCodex,
    communitySource: { peek: () => currentSnapshot },
    hasEntryImage, replaceCommunityEntries,
    findCodexMeta: () => COMMUNITY_META,
    fetchCodex: async (_meta, options) => {
      events.push(['fetch', options]);
      return typeof pendingResult === 'function' ? pendingResult() : pendingResult;
    },
    virtualView: () => state.favoritesView || state.siteSearchView,
    isFav: entry => state.favs.has(`${entry._srcCodexId || COMMUNITY_CODEX_ID}:${entry.id}`),
    invalidateSiteSearchCodex: () => events.push(['invalidate-search']),
    renderTree: () => events.push(['tree']), renderCodexHeader: () => events.push(['header']),
    syncCommunityActions: () => events.push(['actions']),
    updateCodexPickerState() {},
    syncCodexPickerCounts() {},
    applyFilter: options => events.push(['filter', options]), setLoading: message => events.push(['loading', message]),
    closeLightbox: options => {
      events.push(['close', options]);
      state.lightbox = { entry: null, images: [], index: 0 };
    },
    renderLightbox: () => events.push(['lightbox', state.lightbox.entry, state.lightbox.index]),
    window: { scrollY: 0 },
    $: () => ({ textContent: '', value: '' }),
    cancelSiteSearchObservation() {}, cancelCodexSwitch() {}, invalidateOrganizeRequest() {},
    showSkeleton() {}, hideSkeleton() {}, clearMasonry() {},
    replaceSkeleton: (_seq, render) => render(),
    runCodexViewTransition: async (_seq, render) => {
      onTransition();
      if (transitionGate) await transitionGate;
      return render();
    },
    buildFavoritesCodex: async () => currentVirtual,
    buildSiteSearchCodex: async () => currentVirtual,
    siteSearchStillWanted: () => true,
    renderCodexView: (codex, _seq, options) => { options.enterView(); state.codex = codex; },
    setOnlyFavControl() {}, firstUnlockedCodex: () => COMMUNITY_META,
    normalizeRoutePath: (_tree, path) => path || [], codexMetaText: () => '', codexPickerTitle: () => '',
    historyModeFor: () => 'replace', syncUrlState() {},
    syncFavoritesView() {},
    initialBuilt,
  };
  const api = new Function(...Object.keys(dependencies), `
    let codexLoadSeq = 1, favoritesBuiltKeys = new Set(initialBuilt), favoritesRefreshSeq = 0;
    let favoritesPreviewStamp = 'old', favoritesPreviewEntries = ['old'];
    ${refreshSource}
    ${virtualSource}
    ${favoritesSource}
    return {
      refresh: refreshCommunityView,
      enterSearch: openSiteSearchView, enterFavorites: openFavoritesView, exitSearch: exitSiteSearchView,
      refreshFavorites: refreshFavoritesView,
      switchView: view => { codexLoadSeq += 1; state.codex = view; },
      builtKeys: () => [...favoritesBuiltKeys],
      previews: () => ({ stamp: favoritesPreviewStamp, entries: favoritesPreviewEntries }),
    };
  `)(...Object.values(dependencies));
  return { ...api, events, setResult: value => { pendingResult = value; }, setSnapshot: value => { currentSnapshot = value; } };
}

// 适配对象和 normalize 后对象字段不同，但同一内容不得重建瀑布流或重载原图。
{
  const view = oldBook();
  const test = runtime({ view });
  state.lightbox = { entry: view.entries[0], images: view.entries[0].images, index: 1 };
  const lightboxBefore = state.lightbox.entry;
  await test.refresh();
  assert.equal(state.codex, view);
  assert.equal(state.lightbox.entry, lightboxBefore);
  assert.deepEqual(test.events.map(event => event[0]), ['fetch']);
  assert.deepEqual(test.previews(), { stamp: 'old', entries: ['old'] });
}

// 一般内容更新原地替换灯箱条目，仍停在同一张图，并失效跨书/收藏预览。
{
  const view = oldBook();
  const next = book([post({ title: '审核后标题', comment: '审核后说明' })]);
  const test = runtime({ view, next });
  state.lightbox = { entry: view.entries[0], images: view.entries[0].images, index: 1 };
  await test.refresh();
  assert.equal(state.codex.entries[0].title, '审核后标题');
  assert.equal(state.lightbox.entry.note, '审核后说明');
  assert.equal(state.lightbox.index, 1, '刷新不能回到第一张');
  assert.equal(state.lightbox.images[1].original, 'https://images.example.test/1.png');
  assert.equal(test.events.filter(([name]) => name === 'filter').length, 1);
  assert.ok(test.events.some(([name]) => name === 'invalidate-search'));
  assert.deepEqual(test.previews(), { stamp: '', entries: [] });
}

// 同一聚合版本下 D1 喜欢变化也要更新，不允许只比较 revision。
{
  const test = runtime({ next: book([post({ likeCount: 2, liked: true })]) });
  await test.refresh();
  assert.equal(state.codex.entries[0].likeCount, 2);
  assert.equal(state.codex.entries[0].liked, true);
  assert.ok(test.events.some(([name]) => name === 'filter'));
}

for (const fields of [{ nsfw: true }, { images: [{ file: 'https://images.example.test/a.webp', label: 'nsfw' }] }, { rating: 'r18g' }]) {
  const view = oldBook();
  const test = runtime({ view, next: book([post(fields)]) });
  state.lightbox = { entry: view.entries[0], images: view.entries[0].images, index: 1 };
  await test.refresh();
  assert.equal(state.lightbox.entry, null, '审核改级后立即关闭当前失权灯箱');
  assert.equal(isEntryAccessBlocked(state.codex.entries[0]), true);
  const closure = test.events.find(([name]) => name === 'close');
  assert.deepEqual(closure[1], { historyMode: 'replace', immediate: true });
}

for (const failure of [false, true]) {
  const view = oldBook();
  const test = runtime({ view, next: failure ? () => Promise.reject(new DOMException('Timed out', 'AbortError')) : book([]) });
  state.lightbox = { entry: view.entries[0], images: view.entries[0].images, index: 1 };
  await test.refresh();
  assert.equal(state.codex.entries.length, 0, failure ? '请求超时须撤掉旧内容' : '下架须撤掉旧内容');
  assert.equal(state.browseCodex.entries.length, 0, '返回浏览书不能复活旧内容');
  assert.equal(state.lightbox.entry, null);
  if (failure) {
    assert.equal(state.codex.communityStamp, 'unavailable');
    assert.ok(test.events.some(([name, message]) => name === 'loading' && /无法更新/.test(message)));
    test.setResult(oldBook());
    await test.refresh();
    assert.equal(state.codex.entries.length, 1, '失败后可再次取到现行内容');
  }
}

// 正在重验时切换到别本，完成只更新在线来源/缓存，不覆盖新视图及其灯箱。
{
  const request = deferred();
  const test = runtime({ next: request.promise });
  const first = test.refresh();
  const duplicate = test.refresh();
  const other = { id: 'other', entries: [{ id: 'other-entry' }] };
  test.switchView(other);
  request.resolve(book([]));
  await Promise.all([first, duplicate]);
  assert.equal(state.codex, other);
  assert.equal(test.events.filter(([name]) => name === 'fetch').length, 1, '同时触发只读一次 API');
  assert.equal(test.events.some(([name]) => name === 'filter' || name === 'lightbox' || name === 'header'), false);
}

// 虚拟视图清理下架稿件时保留其它法典对象，传播版本；收藏撤销基线随实际构建键更新。
for (const kind of ['site-search', 'favorites']) {
  const previous = oldBook();
  const other = { id: 'other-entry', _srcCodexId: 'other', path: ['其它书'], images: [] };
  const clone = { ...previous.entries[0], _srcCodexId: COMMUNITY_CODEX_ID };
  const view = { id: kind, view: kind, communityStamp: previous.communityStamp, entries: [other, clone] };
  const test = runtime({ view, next: book([]), favorites: [], initialBuilt: [`community:${clone.id}`] });
  await test.refresh();
  assert.deepEqual(state.codex.entries, [other]);
  assert.equal(state.codex.entries[0], other);
  assert.equal(state.codex.communityStamp, book([]).communityStamp);
  if (kind === 'favorites') assert.deepEqual(test.builtKeys(), [], '取消后刷新不能保留过期的已构建收藏键');
  const changedEvents = test.events.length;
  await test.refresh();
  assert.deepEqual(test.events.slice(changedEvents).map(event => event[0]), ['fetch'], '虚拟视图未变也不重建');
}

// 虚拟视图先读到新快照：即使当前 stamp 未变，返回共创书仍须同步，不能复活下架稿。
{
  const fresh = book([]);
  const view = { id: 'site-search', view: 'site-search', communityStamp: fresh.communityStamp, entries: [] };
  const test = runtime({ view, next: fresh });
  assert.equal(state.browseCodex.entries.length, 1);
  await test.refresh();
  assert.equal(state.codex, view, '未变的当前视图不必重建');
  assert.equal(state.browseCodex.entries.length, 0, '早退之前也须同步返回书');
  assert.deepEqual(test.events.map(event => event[0]), ['fetch']);
}

// 还没等首次轮询：进入搜索/收藏后与退出搜索时都以共享源最新快照为准。
for (const kind of ['site-search', 'favorites']) {
  const fresh = book([post({ nsfw: true })]);
  const virtual = { id: kind, view: kind, communityStamp: fresh.communityStamp, entries: fresh.entries };
  const test = runtime({ cached: fresh, virtualResult: virtual });
  if (kind === 'site-search') await test.enterSearch();
  else await test.enterFavorites();
  assert.equal(state.browseCodex.entries[0].rating, 'nsfw', `${kind} 进入后返回书必须沿用当前分级`);
  assert.equal(isEntryAccessBlocked(state.browseCodex.entries[0]), true);
}
for (const fresh of [book([]), null]) {
  const view = { id: 'site-search', view: 'site-search', entries: [] };
  const test = runtime({ view, cached: fresh });
  test.exitSearch();
  assert.equal(state.codex.id, COMMUNITY_CODEX_ID);
  assert.equal(state.codex.entries.length, 0, '退出搜索不依赖轮询，也不得返回下架/失败前的旧稿');
  if (!fresh) assert.equal(state.codex.communityStamp, 'unavailable');
}

// 社区先返回 F0、外部书迟迟未完成：构建结束不能盖回期间已重验的 F1。
const virtualBook = (kind, community = oldBook()) => ({
  id: kind, view: kind, communityStamp: community.communityStamp,
  entries: [{ id: 'other-entry', _srcCodexId: 'other', images: [], path: ['其它书'] },
    ...community.entries.map(entry => ({ ...entry, _srcCodexId: COMMUNITY_CODEX_ID }))],
});
for (const kind of ['site-search', 'favorites']) {
  const waitingBook = deferred();
  const previous = virtualBook(kind);
  const test = runtime({ virtualResult: waitingBook.promise, cached: oldBook(), favorites: ['community:1234abcd'] });
  const entering = kind === 'favorites' ? test.enterFavorites() : test.enterSearch();
  test.setSnapshot(book([]));
  waitingBook.resolve(previous);
  await entering;
  assert.deepEqual(state.codex.entries.map(entry => entry.id), ['other-entry'], `${kind} 慢构建不能复活下架稿`);
  assert.equal(state.codex.entries[0], previous.entries[0], '其它法典对象身份不变');
  assert.equal(state.codex.entryCount, 1);
  assert.equal(state.codex.communityStamp, book([]).communityStamp);
}

// 数据已构建，但过渡尚未落地；重验发生在动画等待期间也必须参与最终呈现。
for (const kind of ['site-search', 'favorites']) {
  for (const snapshot of [book([post({ nsfw: true })]), null]) {
    const transition = deferred();
    const arrived = deferred();
    const previous = virtualBook(kind);
    const test = runtime({ virtualResult: previous, cached: oldBook(), favorites: ['community:1234abcd'],
      transitionGate: transition.promise, onTransition: () => arrived.resolve() });
    const entering = kind === 'favorites' ? test.enterFavorites() : test.enterSearch();
    await arrived.promise;
    test.setSnapshot(snapshot);
    transition.resolve();
    await entering;
    const community = state.codex.entries.find(entry => entry._srcCodexId === COMMUNITY_CODEX_ID);
    if (snapshot) {
      assert.equal(community.rating, 'nsfw', `${kind} 过渡结束时必须使用当前审核分级`);
      assert.equal(isEntryAccessBlocked(community), true);
    } else {
      assert.equal(community, undefined, `${kind} 过渡结束时失效源必须清空`);
    }
  }
}

// 收藏视图内异步增量重建也走同一核对，不能绕过首次进入视图的保护。
{
  const waitingBook = deferred();
  const previous = virtualBook('favorites');
  const test = runtime({ view: previous, virtualResult: waitingBook.promise, cached: oldBook(),
    initialBuilt: [], favorites: ['community:1234abcd', 'other:other-entry'] });
  const refreshing = test.refreshFavorites();
  test.setSnapshot(book([]));
  waitingBook.resolve(previous);
  await refreshing;
  assert.deepEqual(state.codex.entries.map(entry => entry.id), ['other-entry']);
}

// 没有社区来源的收藏视图保持完整原对象；不得因后台已加载社区而注入另一份条目。
{
  const unrelated = { id: 'favorites', view: 'favorites', communityStamp: '', entries: [{ id: 'other-entry', _srcCodexId: 'other' }] };
  const test = runtime({ virtualResult: unrelated, cached: oldBook(), favorites: ['other:other-entry'] });
  await test.enterFavorites();
  assert.equal(state.codex, unrelated);
}

console.log('community refresh runtime: PASS');
