// 仅内存夹具：集中适配、访问门控、动态缓存、虚拟视图和同图深链。
import assert from 'node:assert/strict';
import { adaptCommunityCodex, COMMUNITY_META, COMMUNITY_REFRESH_MS, createCommunitySource, withCommunityCodex } from '../site/assets/app/community-codex.js';
import { replaceCommunityEntries } from '../site/assets/app/community-refresh.js';
import { normalizeCodex } from '../site/assets/app/data.js';
import { isEntryAccessBlocked } from '../site/assets/app/access.js';
import { state } from '../site/assets/app/state.js';
import { searchableText, parseSearchQuery, matchSearchPlan } from '../site/assets/app/search.js';
import { atlasUrlForRoute, readUrlState, openEntryDeepLink, setRouterActions } from '../site/assets/app/router.js';

globalThis.document = { baseURI: 'https://example.com/', querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.location = new URL('https://example.com/');
const post = { id: 'post-1', title: '雨后街景', prompt: 'rain, street', negative: 'lowres', comment: '说明原文', submitter: '投稿者甲', tags: ['雨夜'], category: ['场景'], images: [
  { file: '/r2/community/one.jpg', original: '/r2/community/one.png', width: 800, height: 1200 },
  { file: '/r2/community/two.jpg', width: 1200, height: 800 },
] };
const raw = { features: { likes: true }, revision: 'rev-1', entries: [post,
  { ...post, id: 'adult', nsfw: true },
  { ...post, id: 'legacy-adult', images: [{ file: '/r2/legacy.jpg', label: 'nsfw' }] },
  { ...post, id: 'gated', rating: 'r18g' },
  { ...post, id: 'pending', status: 'pending' },
] };
const codex = normalizeCodex(adaptCommunityCodex(raw), COMMUNITY_META);
assert.equal(codex.type, 'pack');
assert.equal(codex.entries.length, 4);
const entry = codex.entries[0];
assert.equal(entry.id, post.id);
assert.equal(entry.tags, post.prompt);
assert.equal(entry.note, post.comment);
assert.equal(entry.author, post.submitter);
assert.equal(entry.images.length, 2);
assert.equal(entry.images[0]._hasOriginal, true);
assert.equal(entry.images[1]._hasOriginal, false);
assert.equal(entry.images[1].rawTag, '');
assert.equal(entry.images[1].path, 'https://example.com/r2/community/two.jpg');
assert.equal(entry.communityFeatures.likes, true);
assert.ok(searchableText(entry).includes('投稿者甲'));
assert.ok(matchSearchPlan(entry, parseSearchQuery('雨夜')));
assert.ok(matchSearchPlan(entry, parseSearchQuery('说明原文')));
state.codexes = [COMMUNITY_META];
state.codex = codex;
state.allowNsfw = false; state.allowR18g = false;
assert.deepEqual(codex.entries.map(isEntryAccessBlocked), [false, true, true, true]);
state.allowNsfw = true;
assert.deepEqual(codex.entries.map(isEntryAccessBlocked), [false, false, false, true]);
state.allowR18g = true;
assert.deepEqual(codex.entries.map(isEntryAccessBlocked), [false, false, false, false]);
const books = [{ id: 'existing' }];
assert.equal(withCommunityCodex(books).filter(book => book.id === 'community').length, 1);
assert.equal(withCommunityCodex(withCommunityCodex(books)).length, 2);
assert.equal(withCommunityCodex(books, { localEdition: true }).length, 1);

let now = 1, count = 0, fail = false, current = raw;
const source = createCommunitySource({ now: () => now, fetcher: async (url, options) => {
  count++;
  assert.equal(url, 'https://example.com/api/community');
  assert.equal(options.cache, 'no-store');
  if (fail) throw new Error('offline');
  return { ok: true, json: async () => current };
} });
const [first, concurrent] = await Promise.all([source.load(), source.load()]);
assert.equal(first, concurrent); assert.equal(count, 1);
await source.load(); assert.equal(count, 1);
current = { ...raw, entries: [], revision: 'rev-2' };
await source.load({ force: true }); assert.equal(source.peek().entries.length, 0);
now += COMMUNITY_REFRESH_MS + 1;
fail = true;
await assert.rejects(source.load(), /offline/);
assert.equal(source.peek(), null, '不能用旧 API、静态 strings 或示例回填下架内容');
fail = false; current = raw;
assert.equal((await source.load()).entries.length, 4);

const other = { id: 'other', _srcCodexId: 'another' };
const view = { id: 'favorites', view: 'favorites', entries: [other, { id: 'gone', _srcCodexId: 'community' }] };
const replaced = replaceCommunityEntries(view, codex, { isFavorite: entry => entry.id === 'post-1' });
assert.equal(replaced.entries[0], other);
assert.deepEqual(replaced.entries.map(entry => entry.id), ['other', 'post-1']);
assert.equal(replaced.entries[1]._srcCodexId, 'community');
assert.equal(replaced.entries[1].images[1]._hasOriginal, false);
assert.deepEqual(replaceCommunityEntries(view, { ...codex, entries: [] }).entries, [other]);

globalThis.location = new URL('https://example.com/share/community/post-1?image=2');
assert.equal(readUrlState().imageIndex, 1);
assert.equal(atlasUrlForRoute({ codex: 'community', entry: 'post-1', imageIndex: 1 }), '/share/community/post-1?image=2');
document.baseURI = 'https://example.com/sub/';
assert.equal(atlasUrlForRoute({ codex: 'community', entry: 'post-1', imageIndex: 1 }), '/sub/?c=community&entry=post-1&image=2');
state.list = []; state.nodes = new Map(); state.activePath = [];
let opened;
setRouterActions({ applyFilter() {}, renderTree() {}, openLightbox: (...args) => { opened = args; } });
assert.equal(openEntryDeepLink('post-1', { imageIndex: 1, consumeLayer: true }), 'post-1');
assert.equal(opened[1], 1); assert.equal(opened[3].consumeLayer, true);
console.log('community codex adapter, grading, cache, search, virtual views and same-image routes passed');
