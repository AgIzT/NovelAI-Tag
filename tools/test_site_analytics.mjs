import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSiteAnalytics, SITE_ANALYTICS_ENABLED } from '../site/assets/app/site-analytics.js';
import { parseSiteMetrics, SITE_METRIC_DETAILS } from '../site/assets/site-metrics-contract.js';

function fixture(nav = {}) {
  let now = 100_000;
  let nextTimer = 1;
  const timers = new Map();
  const calls = [];
  const listeners = new Map();
  const host = {
    navigator: nav,
    location: { protocol: 'https:', origin: 'https://metrics.example.test', search: '?private=secret' },
    Date: { now: () => now }, AbortController,
    setTimeout(fn, ms) { const key = nextTimer++; timers.set(key, { fn, at: now + ms }); return key; },
    clearTimeout(key) { timers.delete(key); },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    async fetch(url, options) {
      calls.push({ url, options });
      return Response.json({ enabled: true });
    },
  };
  host.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  for (const key of ['localStorage', 'sessionStorage', 'crypto']) {
    Object.defineProperty(host, key, { get() { throw new Error(`Forbidden ${key}`); } });
  }
  return {
    host, timers, calls, listeners,
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        const item = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!item) break;
        now = item[1].at;
        timers.delete(item[0]);
        item[1].fn();
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
      now = end;
    },
  };
}

assert.equal(SITE_ANALYTICS_ENABLED, true);
{
  const f = fixture();
  const analytics = createSiteAnalytics({ host: f.host });
  await analytics.start();
  analytics.record('copy_success', 'prompt');
  analytics.beginSearch()({ active: true, valid: true, hasResults: true, scope: 'site' });
  await analytics.flush();
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
}
for (const nav of [{ globalPrivacyControl: true }, { doNotTrack: '1' }, { doNotTrack: 'yes' }]) {
  const f = fixture(nav);
  const analytics = createSiteAnalytics({ enabled: true, host: f.host });
  await analytics.start();
  analytics.record('copy_success', 'text');
  await analytics.flush();
  assert.equal(f.calls.length, 0);
  assert.equal(f.listeners.size, 0);
}
{
  const f = fixture(); f.host.doNotTrack = '1';
  await createSiteAnalytics({ enabled: true, host: f.host }).start();
  assert.equal(f.calls.length, 0);
}
{
  const f = fixture();
  f.host.fetch = async (url, options) => { f.calls.push({ url, options }); return Response.json({ enabled: false }); };
  const analytics = createSiteAnalytics({ enabled: true, host: f.host });
  await analytics.start();
  analytics.record('copy_success', 'text');
  await analytics.flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
}
{
  const f = fixture();
  const analytics = createSiteAnalytics({ enabled: true, host: f.host });
  await analytics.start();
  analytics.record('copy_success', 'private prompt');
  analytics.record('unknown', 'text');
  analytics.record('copy_success', 'prompt');
  await analytics.flush();
  assert.equal(f.calls.length, 2);
  const sent = f.calls[1];
  assert.equal(sent.url, 'https://metrics.example.test/api/site-metrics');
  assert.equal(sent.options.credentials, 'omit');
  assert.equal(sent.options.referrerPolicy, 'no-referrer');
  assert.deepEqual(JSON.parse(sent.options.body), { v: 1, events: [{ name: 'copy_success', detail: 'prompt' }] });
  assert.deepEqual(Object.keys(sent.options.headers), ['content-type']);
  f.listeners.get('error')({ target: f.host, error: { name: 'SyntaxError', message: 'secret', stack: 'secret' } });
  f.listeners.get('error')({ target: { src: 'https://private.example.test/file?secret' } });
  f.listeners.get('unhandledrejection')({ reason: 'private prompt' });
  await analytics.flush();
  const errors = JSON.parse(f.calls[2].options.body).events;
  assert.deepEqual(errors.map(item => item.detail), ['syntax', 'resource', 'promise']);
  assert.ok(!f.calls[2].options.body.includes('secret'));
  analytics.stop();
}
{
  const f = fixture();
  const analytics = createSiteAnalytics({ enabled: true, host: f.host });
  await analytics.start();
  analytics.record('copy_success', 'text');
  f.host.navigator.globalPrivacyControl = true;
  await analytics.flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
}
{
  const f = fixture();
  const analytics = createSiteAnalytics({ enabled: true, host: f.host });
  await analytics.start();
  const old = analytics.beginSearch();
  old({ active: true, valid: true, hasResults: false, scope: 'codex' });
  const latest = analytics.beginSearch();
  old({ active: true, valid: true, hasResults: false, scope: 'site' });
  latest({ active: true, valid: true, hasResults: true, scope: 'favorites' });
  await f.tick(800);
  await analytics.flush();
  assert.deepEqual(JSON.parse(f.calls[1].options.body).events, [{ name: 'search_success', detail: 'favorites' }]);
  analytics.beginSearch()({ active: true, valid: false, hasResults: false, scope: 'codex' });
  analytics.beginSearch()({ active: false, valid: true, hasResults: false, scope: 'codex' });
  await f.tick(800);
  await analytics.flush();
  assert.equal(f.calls.length, 2);
  analytics.stop();
}
{
  const f = fixture();
  const analytics = createSiteAnalytics({ enabled: true, host: f.host });
  await analytics.start();
  for (let i = 0; i < 200; i++) analytics.record('copy_success', 'text');
  await analytics.flush(); await analytics.flush(); await analytics.flush(); await analytics.flush();
  assert.equal(f.calls.length, 4, '48-event queue, at most 16 per batch');
  for (const call of f.calls.slice(1)) assert.equal(JSON.parse(call.options.body).events.length, 16);
  for (let i = 0; i < 10; i++) { analytics.record('copy_success', 'text'); await analytics.flush(); }
  assert.equal(f.calls.length, 7, 'at most 6 event requests per rolling minute');
  analytics.stop();
}
{
  const f = fixture();
  const analytics = createSiteAnalytics({ enabled: true, host: f.host });
  await analytics.start();
  f.host.fetch = async (url, options) => { f.calls.push({ url, options }); throw new Error('offline'); };
  analytics.record('copy_success', 'text');
  await analytics.flush();
  await f.tick(100_000);
  analytics.record('copy_success', 'text');
  await analytics.flush();
  assert.equal(f.calls.length, 2, 'failed batch has no retry or offline replay');
  assert.equal(f.timers.size, 0);
}
{
  const f = fixture();
  f.host.fetch = (url, options) => {
    f.calls.push({ url, options });
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout'))));
  };
  const analytics = createSiteAnalytics({ enabled: true, host: f.host });
  const started = analytics.start();
  await f.tick(3000); await started;
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
}
for (const events of Object.entries(SITE_METRIC_DETAILS).map(([name, details]) => details.map(detail => ({ name, detail }))).flat()) {
  assert.deepEqual(parseSiteMetrics({ v: 1, events: [events] }), [events]);
}
for (const field of ['id', 'visitor', 'session', 'batch', 'actorId', 'timestamp', 'prompt', 'query', 'ip', 'url', 'stack']) {
  assert.equal(parseSiteMetrics({ v: 1, events: [{ name: 'copy_success', detail: 'text', [field]: 'secret' }] }), null);
  assert.equal(parseSiteMetrics({ v: 1, events: [{ name: 'copy_success', detail: 'text' }], [field]: 'secret' }), null);
}
const client = await readFile(new URL('../site/assets/app/site-analytics.js', import.meta.url), 'utf8');
{
  const f = fixture();
  f.host.fetch = async (url, options) => {
    f.calls.push({ url, options });
    return new Response('x'.repeat(257), { headers: { 'content-type': 'application/json' } });
  };
  const analytics = createSiteAnalytics({ enabled: true, host: f.host });
  await analytics.start();
  analytics.record('copy_success', 'text');
  await analytics.flush();
  assert.equal(f.calls.length, 1, 'oversized response disables metrics');
  assert.equal(f.timers.size, 0);
}
{
  const f = fixture();
  const analytics = createSiteAnalytics({ enabled: true, host: f.host });
  await analytics.start();
  const event = { target: f.host };
  Object.defineProperty(event, 'error', { get() { throw new Error('private getter'); } });
  assert.doesNotThrow(() => f.listeners.get('error')(event));
  analytics.stop();
}
assert.ok(!/localStorage|sessionStorage|sendBeacon|randomUUID|cookie|actorId|fingerprint/.test(client));
console.log('PASS anonymous metrics client: privacy, zero-send defaults, queue, throttle, timeout, no replay');
