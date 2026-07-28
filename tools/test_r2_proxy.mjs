import assert from 'node:assert/strict';

import { onRequestGet } from '../functions/r2/[[key]].js';

const calls = [];
const bucket = {
  async get(key) {
    calls.push(key);
    if (key !== 'community/img/12345678/1.png') return null;
    return {
      body: new Uint8Array([1, 2, 3]),
      httpMetadata: { contentType: 'image/png' },
    };
  },
};

const invoke = key => onRequestGet({ env: { STRINGS_BUCKET: bucket }, params: { key } });

{
  const response = await invoke(['community', 'pending', '12345678.json']);
  assert.equal(response.status, 403);
  assert.deepEqual(calls, [], '非图片 key 不得触碰桶');
}

{
  const response = await invoke(['community', 'img', '%zz']);
  assert.equal(response.status, 400);
  assert.deepEqual(calls, [], '畸形编码不得触碰桶');
}

{
  const response = await invoke(['community', 'img', '12345678', '1.png']);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
  assert.deepEqual(calls, ['community/img/12345678/1.png']);
}

console.log('r2 proxy tests passed');
