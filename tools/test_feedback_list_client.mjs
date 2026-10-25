import assert from 'node:assert/strict';
import { getFeedback } from '../site/assets/admin/api.js';
const originalFetch = globalThis.fetch;
const ready = { ok: true, items: [{ id: 'latest' }], indexing: false };
const preparing = { ok: true, items: [], indexing: true, remaining: 400 };
const response = data => new Response(JSON.stringify(data), { status: data.indexing ? 202 : 200 });
let failed = 0;
const cases = [
  ['do not render partial index as an empty finished list', async () => {
    let calls = 0;
    globalThis.fetch = async () => response(++calls < 3 ? preparing : ready);
    assert.deepEqual(await getFeedback('resolved'), ready);
    assert.equal(calls, 3);
  }],
  ['bound preparation requests and tell user how to continue', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return response(preparing); };
    await assert.rejects(getFeedback('resolved'), /准备|刷新/);
    assert.ok(calls > 1 && calls <= 8);
  }],
  ['cancelled navigation must not continue index building', async () => {
    let calls = 0; const controller = new AbortController();
    globalThis.fetch = async (_url, opts) => {
      calls++; assert.equal(opts.signal, controller.signal); controller.abort(); return response(preparing);
    };
    await assert.rejects(getFeedback('resolved', { signal: controller.signal }), error => error.name === 'AbortError');
    assert.equal(calls, 1);
  }],
  ['storage failure is not retried as preparation', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ ok: false, error: 'storage failure' }), { status: 503 }); };
    await assert.rejects(getFeedback('resolved'), /storage failure/); assert.equal(calls, 1);
  }],
  ['page cursor survives 202 preparation and signal is preserved', async () => {
    const controller = new AbortController(); let calls = 0;
    globalThis.fetch = async (url, opts) => {
      assert.equal(new URL(url, 'https://local.test').searchParams.get('cursor'), 'synthetic-cursor');
      assert.equal(opts.signal, controller.signal); calls++; return response(calls === 1 ? preparing : ready);
    };
    assert.deepEqual(await getFeedback('resolved', { cursor: 'synthetic-cursor', signal: controller.signal }), ready);
    assert.equal(calls, 2);
  }],
  ['version conflict restarts from the first page with a visible reset flag', async () => {
    const urls = [];
    globalThis.fetch = async url => {
      urls.push(url);
      return urls.length === 1
        ? new Response(JSON.stringify({ ok: false, error: 'changed', resetPagination: true }), { status: 409 })
        : response(ready);
    };
    const data = await getFeedback('resolved', { cursor: 'old-cursor' });
    assert.equal(data.paginationReset, true); assert.equal(data.items[0].id, 'latest');
    assert.equal(new URL(urls[1], 'https://local.test').searchParams.has('cursor'), false);
  }],
  ['cancelled version conflict must not restart pagination', async () => {
    const controller = new AbortController(); let calls = 0;
    globalThis.fetch = async () => {
      calls++; controller.abort();
      return new Response(JSON.stringify({ ok: false, error: 'changed', resetPagination: true }), { status: 409 });
    };
    await assert.rejects(getFeedback('resolved', { cursor: 'old', signal: controller.signal }), error => error.name === 'AbortError');
    assert.equal(calls, 1);
  }],
];
try {
  for (const [name, test] of cases) {
    try { await test(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
  }
} finally { globalThis.fetch = originalFetch; }
if (failed) { console.error(`feedback list client: FAIL (${failed}/${cases.length})`); process.exitCode = 1; }
else console.log(`feedback list client: PASS (${cases.length} cases)`);
