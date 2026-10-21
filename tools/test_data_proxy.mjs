import assert from 'node:assert/strict';
import { onRequest } from '../functions/data/[[path]].js';

const release = 'r-0123456789abcdefabcd';

function r2Object(value, etag = '"test-etag"') {
  const body = JSON.stringify(value);
  let consumed = false;
  return {
    get body() {
      if (consumed) throw new Error('R2 body was already consumed');
      consumed = true;
      return body;
    },
    httpEtag: etag,
    text: async () => {
      if (consumed) throw new Error('R2 body was already consumed');
      consumed = true;
      return body;
    },
    writeHttpMetadata(headers) {
      headers.set('content-type', 'application/json; charset=utf-8');
    },
  };
}

function makeContext(path, { method = 'GET', objects = {}, binding = true } = {}) {
  const calls = [];
  return {
    calls,
    context: {
      request: new Request(`https://preview.example/data/${path.join('/')}`, { method }),
      params: { path },
      env: {
        ATLAS_DATA_PREFIX: 'data',
        ...(binding ? {
          ATLAS_DATA_BUCKET: {
            get: async key => {
              calls.push(key);
              return Object.hasOwn(objects, key) ? r2Object(objects[key]) : null;
            },
          },
        } : {}),
      },
    },
  };
}

const objects = {
  'data/current.json': { release, schemaVersion: 1 },
  [`data/releases/${release}/codexes.json`]: [{ id: 'demo' }],
  [`data/releases/${release}/share/demo.json`]: { id: 'demo' },
};

{
  const { context, calls } = makeContext(['current.json'], { objects });
  const response = await onRequest(context);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-atlas-data-release'), release);
  assert.equal((await response.json()).release, release);
  assert.deepEqual(calls, ['data/current.json']);
}

{
  const { context, calls } = makeContext(['releases', release, 'codexes.json'], { objects });
  const response = await onRequest(context);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal((await response.json())[0].id, 'demo');
  assert.deepEqual(calls, [`data/releases/${release}/codexes.json`]);
}

{
  const { context, calls } = makeContext(['share', 'demo.json'], { objects });
  const response = await onRequest(context);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).id, 'demo');
  assert.deepEqual(calls, ['data/current.json', `data/releases/${release}/share/demo.json`]);
}

{
  const { context } = makeContext(['releases', release, 'codexes.json'], { method: 'HEAD', objects });
  const response = await onRequest(context);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
}

for (const path of [
  ['..', 'codexes.json'],
  ['releases', 'not-a-release', 'codexes.json'],
  ['secrets.txt'],
]) {
  const { context } = makeContext(path, { objects });
  assert.equal((await onRequest(context)).status, 400);
}

{
  const { context } = makeContext(['codexes.json'], { objects: {} });
  assert.equal((await onRequest(context)).status, 503);
}

{
  const { context } = makeContext(['codexes.json'], { objects, binding: false });
  assert.equal((await onRequest(context)).status, 503);
}

// Public-domain compatibility must retain ranged v1 reads without buffering bodies.
{
  const raw = new TextEncoder().encode('[{"id":"demo"}]');
  const calls = [];
  const bucket = {
    head: async key => { calls.push(['head', key]); return { size: raw.length, httpEtag: '"v1-range"' }; },
    get: async (key, options) => {
      calls.push(['get', key, options]);
      assert.deepEqual(options.range, { offset: 1, length: 4 });
      return {
        size: raw.length, range: options.range, httpEtag: '"v1-range"',
        body: new ReadableStream({ start(controller) { controller.enqueue(raw.slice(1, 5)); controller.close(); } }),
      };
    },
  };
  const context = {
    request: new Request(`https://assets.example/data/releases/${release}/codexes.json`, { headers: { range: 'bytes=1-4' } }),
    params: { path: ['releases', release, 'codexes.json'] }, env: { ATLAS_DATA_BUCKET: bucket },
  };
  const response = await onRequest(context);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 1-4/${raw.length}`);
  assert.equal((await response.arrayBuffer()).byteLength, 4);
  assert.equal(calls.length, 2);
}
console.log('data proxy tests passed');
