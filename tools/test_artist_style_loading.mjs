// Real data-source loader with synthetic releases; no real data or external requests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const book = () => ({
  id: 'artist_nai5_personal',
  entries: [{ id: 'artist_nai5_personal_one', path: ['单画师词典', 'MayRain'], image: 'one.webp' }],
  tree: [{ name: '单画师词典', children: [{ name: 'MayRain', children: [] }] }],
});
const fingerprint = createHash('sha256').update(JSON.stringify([
  ['artist_nai5_personal_one', ['单画师词典', 'MayRain'], 'one.webp', 'safe', ''],
])).digest('hex');
const raw = () => ({
  schema: 3, codexId: 'artist_nai5_personal', idPrefix: 'artist_nai5_personal_',
  sourceFingerprint: fingerprint, nearShard: 512, nearRevision: '0123456789abcdef',
  parents: [{ name: '平涂', groups: [0] }],
  groups: [{ name: '细线平涂', parent: 0 }],
  artists: [{ e: 'one', g: 0, p: 1 }],
});
let serial = 0;
const fresh = () => import(`../site/assets/app/artist-style.js?loading-case=${++serial}`);
const originalWarn = console.warn;
console.warn = () => {};
try {
  const urls = [];
  let fail = true;
  globalThis.fetch = async url => {
    urls.push(String(url));
    if (fail) throw new Error('temporary offline');
    return { ok: true, json: async () => raw() };
  };
  const retry = await fresh();
  assert.equal(await retry.attachArtistStyles(book()), false);
  fail = false;
  assert.equal(await retry.attachArtistStyles(book()), true, 'temporary root failure is retried');
  assert.ok(urls.every(url => url.endsWith('/data/artist_styles.json')), 'root uses the shared release data source');

  for (const [name, change] of [
    ['bad parent', data => { data.groups[0].parent = 99; }],
    ['bad artist group', data => { data.artists[0].g = 99; }],
    ['duplicate identity', data => { data.artists.push({ ...data.artists[0] }); }],
    ['unrelated canonical identity', data => { data.artists[0].c = 'not-owned'; }],
    ['bad tags', data => { data.groups[0].tags = '平涂'; }],
    ['bad description', data => { data.parents[0].desc = {}; }],
    ['wrong source', data => { data.sourceFingerprint = '0'.repeat(64); }],
  ]) {
    const data = raw();
    change(data);
    globalThis.fetch = async () => ({ ok: true, json: async () => data });
    const style = await fresh();
    const codex = book();
    assert.equal(await style.attachArtistStyles(codex), false, name);
    assert.equal(codex.styleTree, undefined, `${name}: leaves the source tree usable`);
    assert.equal(codex.entries[0].stylePath, undefined, `${name}: no partial mutation`);
  }

  let nearCalls = 0;
  globalThis.fetch = async url => ({ ok: true, json: async () => {
    if (String(url).includes('artist_styles_near')) {
      nearCalls += 1;
      return nearCalls === 1 ? [[9]] : [[]];
    }
    return raw();
  } });
  const near = await fresh();
  assert.equal(await near.attachArtistStyles(book()), true);
  assert.deepEqual(await near.loadNearArtists(0), [], 'invalid neighbor indices are rejected');
  assert.deepEqual(await near.loadNearArtists(0), [], 'valid empty result succeeds on retry');
  assert.equal(nearCalls, 2, 'failed shard is not cached for the page lifetime');

  const oldSetTimeout = globalThis.setTimeout;
  const oldClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = callback => { queueMicrotask(callback); return 1; };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = async (_url, { signal } = {}) => new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  try {
    const timeout = await fresh();
    assert.equal(await timeout.attachArtistStyles(book()), false, 'a stalled root request releases book navigation');
  } finally {
    globalThis.setTimeout = oldSetTimeout;
    globalThis.clearTimeout = oldClearTimeout;
  }
} finally {
  console.warn = originalWarn;
}
console.log('artist style loading: PASS (11 cases)');
