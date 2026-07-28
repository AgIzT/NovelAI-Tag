import assert from 'node:assert/strict';
import {
  decodeFavoritesTransfer,
  encodeFavoritesTransfer,
  FAVORITES_TRANSFER_MAX_BYTES,
  FAVORITES_TRANSFER_MAX_COMPRESSED_BYTES,
  FAVORITES_TRANSFER_PREFIX,
} from '../site/assets/app/favorites-transfer.js';

const json = JSON.stringify({
  format: 'novelai-tag-favorites',
  version: 1,
  favorites: { atlas: [{ codexId: '书 A', entryId: '词条/1' }], community: ['投稿-1'] },
});

const encoded = await encodeFavoritesTransfer(json);
assert.match(encoded, new RegExp(`^${FAVORITES_TRANSFER_PREFIX.replace('.', '\\.')}[A-Za-z0-9_-]+$`));
assert.equal(await decodeFavoritesTransfer(encoded), json);

const wrapped = `${encoded.slice(0, 24)}\n  ${encoded.slice(24)}`;
assert.equal(await decodeFavoritesTransfer(wrapped), json);
assert.equal(await decodeFavoritesTransfer(`  ${json}\n`), json);
assert.equal(await encodeFavoritesTransfer(json, { CompressionStream: null }), json);

await assert.rejects(
  () => decodeFavoritesTransfer(`${FAVORITES_TRANSFER_PREFIX}%%%`),
  error => error.code === 'INVALID_TRANSFER_TEXT',
);
await assert.rejects(
  () => decodeFavoritesTransfer(encoded, { DecompressionStream: null }),
  error => error.code === 'DECOMPRESSION_UNSUPPORTED',
);
await assert.rejects(
  () => decodeFavoritesTransfer(encoded, { maxBytes: 8 }),
  error => error.code === 'TRANSFER_TOO_LARGE',
);
const tooLarge = 'x'.repeat(FAVORITES_TRANSFER_MAX_BYTES + 1);
await assert.rejects(
  () => encodeFavoritesTransfer(tooLarge, { CompressionStream: null }),
  error => error.code === 'TRANSFER_TOO_LARGE',
);
await assert.rejects(
  () => encodeFavoritesTransfer(tooLarge),
  error => error.code === 'TRANSFER_TOO_LARGE',
);
await assert.rejects(
  () => decodeFavoritesTransfer(tooLarge),
  error => error.code === 'TRANSFER_TOO_LARGE',
);
await assert.rejects(
  () => decodeFavoritesTransfer(
    `${FAVORITES_TRANSFER_PREFIX}${'A'.repeat(Math.ceil(FAVORITES_TRANSFER_MAX_COMPRESSED_BYTES * 4 / 3) + 8)}`,
  ),
  error => error.code === 'TRANSFER_TOO_LARGE',
);

console.log('favorites transfer tests passed');
