// 只读共享夹具与源码；检查独立默认尾段（前文权重 / reset 原样保留）与统一加载链。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripNaiDefaultTags } from '../site/assets/app/nai-default-tags.js';
import { fetchCodex, normalizeCodex } from '../site/assets/app/data.js';
import { adaptCommunityCodex, COMMUNITY_META } from '../site/assets/app/community-codex.js';
import { state } from '../site/assets/app/state.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/nai_default_tags.json', import.meta.url), 'utf8'));
for (const { name, input, output } of fixtures) {
  assert.equal(stripNaiDefaultTags(input), output, name);
  assert.equal(stripNaiDefaultTags(output), output, `${name}: repeated cleanup preserves the result`);
}
assert.equal(stripNaiDefaultTags(null), '');

const suffix = 'very aesthetic, masterpiece, no text';
const negative = `lowres, ${suffix}`;
const characterPrompts = [{ label: 'char1', prompt: `character, ${suffix}`, negative }];
const raw = {
  id: 'external', entries: [
    {
      id: 'copy', tags: `artist:a, ${suffix}, ${suffix}, no text`, negative,
      characterPrompts,
      images: [
        { path: 'one.webp', original: 'one.png', assetRev: 'r1', rawTag: `image one, ${suffix}`, negative, characterPrompts },
        { path: 'two.webp', rawTags: `image two, ${suffix}`, _hasOriginal: false },
      ],
    },
    { id: 'fallback', rawTags: `artist:b, ${suffix}` },
    { id: 'empty', tags: suffix },
    { id: 'weighted', tags: `artist:c, 1.2::${suffix}::` },
  ],
};
const snapshot = structuredClone(raw);
const codex = normalizeCodex(raw, { id: 'external', dataUrl: 'https://partner.example/book.json' });
assert.equal(codex.entries[0].tags, 'artist:a');
assert.equal(codex.entries[1].tags, 'artist:b', 'legacy rawTags is cleaned when used as the main prompt');
assert.equal(codex.entries[2].tags, '', 'a prompt consisting only of defaults becomes empty');
assert.equal(codex.entries[3].tags, raw.entries[3].tags, 'weighted defaults remain unchanged');
assert.deepEqual(codex.entries[0].images.map(image => image.rawTag), ['image one', 'image two']);
assert.equal(codex.entries[0].negative, negative);
assert.deepEqual(codex.entries[0].characterPrompts, characterPrompts);
assert.equal(codex.entries[0].images[0].negative, negative);
assert.deepEqual(codex.entries[0].images[0].characterPrompts, characterPrompts);
assert.equal(codex.entries[0].images[0].original, 'one.png');
assert.equal(codex.entries[0].images[0].assetRev, 'r1');
assert.equal(codex.entries[0].images[0]._hasOriginal, true);
assert.equal(codex.entries[0].images[1]._hasOriginal, false);
assert.deepEqual(raw, snapshot, 'loading never mutates the input JSON or media records');

const post = {
  id: 'post', prompt: `rain, ${suffix}, masterpiece, ${suffix}`, negative,
  images: [{ file: 'https://images.example/post.webp', original: 'https://images.example/post.png' }],
};
const community = normalizeCodex(adaptCommunityCodex({ entries: [post] }), COMMUNITY_META);
assert.equal(community.entries[0].tags, 'rain', 'the community source.prompt passes through the same normalizer');
assert.equal(community.entries[0].negative, negative);
assert.equal(post.prompt, `rain, ${suffix}, masterpiece, ${suffix}`, 'no online API write or source mutation');

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
try {
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls += 1;
    if (url === 'https://partner.example/book.json') {
      assert.equal(options.cache, 'no-store');
      return { ok: true, json: async () => raw };
    }
    assert.equal(String(url), 'https://atlas.example/api/community');
    return { ok: true, json: async () => ({ entries: [post] }) };
  };
  state.codexCache.delete('default-tail-external-test');
  const fetched = await fetchCodex({ id: 'default-tail-external-test', dataUrl: 'https://partner.example/book.json' });
  assert.equal(fetched.entries[0].tags, 'artist:a', 'external books are cleaned on their actual loading path');
  assert.equal((await fetchCodex({ id: 'default-tail-external-test', dataUrl: 'https://partner.example/book.json' })).entries[0].tags, 'artist:a');
  assert.equal(calls, 1, 'the shared cached result remains clean');
  globalThis.document = { baseURI: 'https://atlas.example/' };
  const fetchedCommunity = await fetchCodex(COMMUNITY_META, { force: true });
  assert.equal(fetchedCommunity.entries[0].tags, 'rain', 'live API entries are cleaned after community adaptation');
  assert.equal(calls, 2);
} finally {
  globalThis.fetch = originalFetch;
  globalThis.document = originalDocument;
  state.codexCache.delete('default-tail-external-test');
}

console.log(`NAI default tags: ${fixtures.length} shared boundary cases and loading integration passed`);
