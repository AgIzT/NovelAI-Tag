// 社区分支专用：真实适配器和 fetchCodex 接线；缺模块时明确 BLOCKED，不代替 main 回归。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

async function main() {
  const communityUrl = new URL('../site/assets/app/community-codex.js', import.meta.url);
  if (!existsSync(communityUrl)) {
    console.error('NAI default tags community: BLOCKED (community-codex.js is absent; run on feature/community-codex or after its reviewed merge)');
    process.exitCode = 2;
    return;
  }
  const { adaptCommunityCodex, COMMUNITY_META } = await import(communityUrl);
  const { fetchCodex, normalizeCodex } = await import('../site/assets/app/data.js');
  const { state } = await import('../site/assets/app/state.js');
  const suffix = 'very aesthetic, masterpiece, no text';
  const negative = `lowres, ${suffix}`;
  const post = {
    id: 'post', prompt: `rain, ${suffix}, masterpiece, ${suffix}`, negative,
    images: [{ file: 'https://images.example/post.webp', original: 'https://images.example/post.png' }],
  };
  const snapshot = structuredClone(post);
  const community = normalizeCodex(adaptCommunityCodex({ entries: [post] }), COMMUNITY_META);
  assert.equal(community.entries[0].tags, 'rain', 'community source.prompt passes through the same normalizer');
  assert.equal(community.entries[0].negative, negative);
  assert.deepEqual(post, snapshot, 'adapter never mutates the online source');
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  try {
    let calls = 0;
    globalThis.document = { baseURI: 'https://atlas.example/' };
    globalThis.fetch = async url => {
      calls += 1;
      assert.equal(String(url), 'https://atlas.example/api/community');
      return { ok: true, json: async () => ({ entries: [post] }) };
    };
    const fetched = await fetchCodex(COMMUNITY_META, { force: true });
    assert.equal(fetched.entries[0].tags, 'rain', 'live API entries are cleaned after community adaptation');
    assert.equal(fetched.entries[0].negative, negative);
    assert.equal(calls, 1);
    assert.deepEqual(post, snapshot, 'loading never writes the API or mutates its source');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    state.codexCache.delete(COMMUNITY_META.id);
  }
  console.log('NAI default tags community: PASS (adapter and live loading integration)');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
