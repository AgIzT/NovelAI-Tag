// 共创法典兼容、审核新鲜度与实时分享卡回归；仅使用内存 R2。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { onRequestGet as communityGet } from '../functions/api/community.js';
import { onRequestPost as adminPost } from '../functions/api/admin/community/[[path]].js';
import { renderShareResponse } from '../functions/_share.js';
import { rebuildCommunity } from '../functions/_lib.js';
import { communityLegacyTarget } from '../site/assets/community/legacy-route.js';
import { adaptCommunityCodex } from '../site/assets/app/community-codex.js';
import { MemoryR2 } from './memory-r2-test-harness.mjs';

const origin = 'https://novelai.quicktagcloud.com';
const id = '1234abcd-5678';
const bucket = new MemoryR2();
const shell = '<!doctype html><html><head><title>首页</title></head><body><div id="masonry"></div></body></html>';
const env = {
  STRINGS_BUCKET: bucket,
  STRINGS_PUBLIC_BASE: 'https://images.example.test',
  ADMIN_TOKEN: 'test-token',
  // 社区分享不得去读静态 share-index（那份索引不跟审核一起更新）。
  ATLAS_DATA_BUCKET: { get: async () => { throw new Error('unexpected immutable dataset read'); } },
  ATLAS_DATA_HOSTS: 'novelai.quicktagcloud.com',
  ASSETS: { fetch: async request => {
    assert.equal(new URL(request.url).pathname, '/index.html');
    return new Response(shell);
  } },
};

async function mutate(action, fields = {}) {
  const response = await adminPost({
    env,
    params: { path: [action] },
    request: new Request(`${origin}/api/admin/community/${action}`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ id, ...fields }),
    }),
  });
  assert.equal(response.status, 200, await response.text());
}

async function readPublic() {
  const response = await communityGet({ env, request: new Request(`${origin}/api/community`) });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}

async function share({ image = 2, method = 'GET', overrides = {} } = {}) {
  const response = await renderShareResponse({
    env: { ...env, ...overrides },
    request: new Request(`${origin}/share/community/${id}?image=${image}`, { method }),
  });
  assert.equal(response.headers.get('cache-control'), 'no-store', '实时投稿分享不得保留边缘缓存');
  return { response, html: await response.text() };
}

await bucket.put(`community/pending/${id}.json`, JSON.stringify({
  id, status: 'pending', title: '审核前标题', prompt: 'test prompt', comment: '公开说明',
  submitter: '投稿人', category: ['场景'], nsfw: false, createdAt: 100,
  images: [0, 1, 2].map(index => ({
    key: `community/img/${id}/${index}.webp`,
    origKey: `community/img/${id}/${index}.png`, width: 640, height: 480,
  })),
}));

assert.equal((await readPublic()).entries.length, 0, '待审内容不得进入主站');
await mutate('approve');
const approved = await readPublic();
assert.equal(approved.entries[0].id, id);
assert.equal(approved.entries[0].images[1].original, `https://images.example.test/community/img/${id}/1.png`);
assert.equal(approved.entries[0].submitter, '投稿人');
assert.ok(approved.revision);
const visible = await share();
assert.match(visible.html, /审核前标题 · 共创法典/);
assert.ok(visible.html.includes(`community/img/${id}/1.webp`), '分享第二张图不得退回封面');
assert.ok(!visible.html.includes(`community/img/${id}/0.webp`));
assert.ok(visible.html.includes(`/share/community/${id}?image=2`));
assert.match(visible.html, /<base href="\/">/);
assert.match(visible.html, /id="masonry"/);
assert.equal((await share({ method: 'HEAD' })).html, '');

await mutate('update', { status: 'approved', edits: { title: '审核后标题', nsfw: true } });
const edited = await readPublic();
assert.notEqual(edited.revision, approved.revision, '审核修改后内容版本必须变化');
assert.equal(edited.entries[0].title, '审核后标题');
assert.equal(edited.entries[0].nsfw, true);
const gated = await share();
assert.ok(!gated.html.includes('审核后标题'), '成人标题不可借 OG 绕过主站分级');
assert.ok(!gated.html.includes('公开说明'));
assert.ok(!gated.html.includes('community/img/'));
assert.equal(gated.response.headers.get('x-robots-tag'), 'noindex, nofollow');

await mutate('unpublish');
const hidden = await readPublic();
assert.equal(hidden.entries.length, 0, '下架响应成功后的下一读不得保留旧聚合');
assert.notEqual(hidden.revision, edited.revision);
const removed = await share();
assert.ok(!removed.html.includes('审核后标题'));
assert.ok(!removed.html.includes('community/img/'));

await mutate('publish', { status: 'hidden', edits: { nsfw: false } });
assert.equal((await readPublic()).entries.length, 1, '重新发布无需发法典 release');
const republished = await share();
assert.match(republished.html, /审核后标题 · 共创法典/);

// 旧逐图 NSFW 标签也必须 fail-closed；不依赖 aggregate 的误标副本。
const recordKey = `community/approved/${id}.json`;
const record = JSON.parse(bucket.objects.get(recordKey));
record.images[0].label = 'nsfw';
await bucket.put(recordKey, JSON.stringify(record));
assert.ok(!(await share()).html.includes('审核后标题'));

// 独立 rating/旧 level 的受限标记也与主站同义；不能因缺少 nsfw 布尔值而出安全卡。
for (const field of ['rating', 'level']) {
  for (const rating of ['restricted', 'r18', 'nsfw', 'r18g', 'R18G']) {
    const rated = { ...record, nsfw: false, images: record.images.map(({ label, ...image }) => image), [field]: rating };
    await bucket.put(recordKey, JSON.stringify(rated));
    const restrictedShare = await share();
    assert.ok(!restrictedShare.html.includes('审核后标题'), `${field}=${rating} 不得泄露标题`);
    assert.ok(!restrictedShare.html.includes('公开说明'), `${field}=${rating} 不得泄露说明`);
    assert.ok(!restrictedShare.html.includes('community/img/'), `${field}=${rating} 不得泄露配图`);
    assert.equal(restrictedShare.response.headers.get('x-robots-tag'), 'noindex, nofollow');
    await rebuildCommunity(env);
    const published = await readPublic();
    assert.equal(published.entries[0].rating, rating.toLowerCase(), `${field} 应通过审核聚合透传到 API`);
    const adapted = adaptCommunityCodex(published);
    assert.equal(adapted.entries[0].rating, rating.toLowerCase() === 'r18g' ? 'r18g' : 'nsfw',
      `${field}=${rating} 经 rebuild → API → adapter 后必须保持受限`);
  }
}
await bucket.put(recordKey, JSON.stringify({
  ...record, nsfw: false, rating: 'safe', images: record.images.map(({ label, ...image }) => image),
}));
assert.match((await share()).html, /审核后标题 · 共创法典/, '明确安全的投稿仍可出完整卡');

// 降级外壳的手动入口也要携带相同投稿和相同图片。
const savedWarn = console.warn;
console.warn = () => {};
try {
  const fallback = await share({ overrides: { ASSETS: { fetch: async () => new Response('missing', { status: 404 }) } } });
  assert.ok(fallback.html.includes(`entry=${id}&amp;image=2`));
} finally {
  console.warn = savedWarn;
}

for (const path of ['/strings.html', '/strings', '/strings/']) {
  assert.equal(communityLegacyTarget(`${origin}${path}?entry=${id}&image=2`), `/?c=community&entry=${id}&image=2`);
}
assert.equal(communityLegacyTarget(`${origin}/sub/strings.html?entry=${id}&image=3`), `/sub/?c=community&entry=${id}&image=3`);
assert.equal(communityLegacyTarget(`${origin}/strings.html?entry=${id}&image=Infinity`), `/?c=community&entry=${id}`);
assert.equal(communityLegacyTarget(`${origin}/strings.html?entry=${id}&image=-3`), `/?c=community&entry=${id}`);
assert.equal(communityLegacyTarget(`${origin}/strings.html?image=5`), '/?c=community');
const legacyPage = await readFile(new URL('../site/strings.html', import.meta.url), 'utf8');
assert.match(legacyPage, /community\/legacy-route\.js/);
assert.doesNotMatch(legacyPage, /communityGrid|communityMain|assets\/community\.js|detailMask/);

// 慢重建已读到旧稿件时，另一审核请求完成下架；慢请求不能把它重新写回公开列表。
// 同时覆盖已有聚合与首份聚合尚不存在的竞争。
for (const hadAggregate of [true, false]) {
  const racingBucket = new MemoryR2();
  const racingEnv = { ...env, STRINGS_BUCKET: racingBucket };
  const approvedKey = `community/approved/${id}.json`;
  await racingBucket.put(approvedKey, JSON.stringify({ ...record, images: [], nsfw: false }));
  if (hadAggregate) await rebuildCommunity(racingEnv);
  let interleaved = false;
  racingBucket.afterGet = async key => {
    if (key !== approvedKey || interleaved) return;
    interleaved = true;
    await racingBucket.delete(approvedKey);
    await rebuildCommunity(racingEnv);
  };
  await rebuildCommunity(racingEnv);
  assert.equal(interleaved, true);
  assert.equal(JSON.parse(racingBucket.objects.get('community/community.json')).entries.length, 0,
    `慢重建不得复活下架稿件（已有聚合：${hadAggregate}）`);
}

console.log('community codex backend / legacy compatibility: PASS');
