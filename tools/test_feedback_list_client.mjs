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
];
try {
  for (const [name, test] of cases) {
    try { await test(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
  }
} finally { globalThis.fetch = originalFetch; }
if (failed) { console.error(`feedback list client: FAIL (${failed}/${cases.length})`); process.exitCode = 1; }
else console.log(`feedback list client: PASS (${cases.length} cases)`);
