import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SqliteD1, readMigrations } from './sqlite-d1-test-harness.mjs';
import { onRequestGet, onRequestPost } from '../functions/api/site-metrics.js';
import { onRequestGet as adminGet } from '../functions/api/admin/site-metrics.js';
import { writeSiteMetrics, siteMetricsAvailable, readSiteMetricsReport, siteMetricCutoff } from '../functions/_site_metrics.js';

const migration = await readMigrations('0005_site_metrics.sql');
const previousMigrations = await readMigrations('0001_community_likes.sql', '0002_engagement_tombstones.sql', '0003_favorites_pickup.sql', '0004_submission_guards.sql');
const previousDb = new SqliteD1(previousMigrations);
const previousSchema = previousDb.rows("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name");
previousDb.sqlite.exec(migration);
assert.deepEqual(previousDb.rows("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'site_metric_%' ORDER BY name"), previousSchema);
const origin = 'https://metrics.example.test';
const events = [{ name: 'search_success', detail: 'codex' }, { name: 'copy_success', detail: 'prompt' }];
const now = Date.parse('2026-10-12T03:04:05Z');
const db = new SqliteD1(migration);
const env = { SITE_METRICS_ENABLED: 'true', COMMUNITY_DB: db, ADMIN_TOKEN: 'test-only-token' };
function context(body = { v: 1, events }, options = {}) {
  return {
    env: options.env || env,
    request: new Request(`${origin}/api/site-metrics${options.query || ''}`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json', ...options.headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  };
}
const disabled = async response => assert.deepEqual(await response.json(), { enabled: false });
await disabled(await onRequestPost(context(undefined, { env: {} })));
await disabled(await onRequestPost(context(undefined, { env: { ...env, SITE_METRICS_ENABLED: 'false' } })));
await disabled(await onRequestPost(context(undefined, { env: { ...env, COMMUNITY_DB: new SqliteD1('') } })));
assert.equal(await siteMetricsAvailable({ ...env, COMMUNITY_DB: new SqliteD1('') }), false);
assert.equal(await siteMetricsAvailable(env), true);
await disabled(await onRequestPost(context(undefined, { headers: { dnt: '1' } })));
await disabled(await onRequestPost(context(undefined, { headers: { 'sec-gpc': '1' } })));
assert.equal(db.rows('SELECT * FROM site_metric_counts').length, 0);
assert.equal(db.rows('SELECT * FROM site_metric_rate').length, 0);
assert.equal((await onRequestPost(context(undefined, { headers: { origin: 'https://other.example.test' } }))).status, 403);
assert.equal((await onRequestPost(context(undefined, { headers: { origin: '' } }))).status, 403);
assert.equal((await onRequestPost(context(undefined, { headers: { 'sec-fetch-site': 'cross-site' } }))).status, 403);
assert.equal((await onRequestPost(context(undefined, { query: '?prompt=secret' }))).status, 403);
assert.equal((await onRequestPost(context(undefined, { headers: { 'content-type': 'text/plain' } }))).status, 415);
assert.equal((await onRequestPost(context(undefined, { headers: { 'content-encoding': 'gzip' } }))).status, 415);
for (const invalid of [
  {}, { v: 2, events }, { v: 1, events: [] }, { v: 1, events: Array(17).fill(events[0]) },
  { v: 1, events, visitor: 'secret' }, { v: 1, events: [{ ...events[0], query: 'secret' }] },
  { v: 1, events: [{ name: 'copy_success', detail: 'prompt secret' }] }, '{',
]) assert.equal((await onRequestPost(context(invalid))).status, 400);
assert.equal((await onRequestPost(context('x'.repeat(2049)))).status, 413);
assert.equal((await onRequestPost(context('字'.repeat(700)))).status, 413, 'byte limit, not character limit');
assert.equal((await onRequestPost(context(undefined, { headers: { 'content-length': '999999' } }))).status, 413);
assert.equal(db.rows('SELECT * FROM site_metric_counts').length, 0);
const good = await onRequestPost(context());
assert.equal(good.status, 200);
assert.equal(good.headers.get('set-cookie'), null);
assert.equal(good.headers.get('cache-control'), 'no-store');
assert.equal(good.headers.get('access-control-allow-origin'), null);
assert.equal((await good.json()).accepted, true);
await disabled(await onRequestGet({ env, request: new Request(`${origin}/api/site-metrics`, { headers: { dnt: '1' } }) }));
assert.deepEqual(await (await onRequestGet({ env, request: new Request(`${origin}/api/site-metrics`) })).json(), { enabled: true });

// Actual SQL batch, quota, expiration, no fake history and report denominators.
const fixedDb = new SqliteD1(migration);
const fixedEnv = { ...env, COMMUNITY_DB: fixedDb };
assert.equal((await readSiteMetricsReport(fixedEnv, now)).startedDay, null);
assert.equal((await readSiteMetricsReport(fixedEnv, now)).searchHitRate, null);
await writeSiteMetrics(fixedEnv, [...events, { name: 'search_empty', detail: 'site' }], now);
assert.equal((await readSiteMetricsReport(fixedEnv, now)).searchHitRate, 0.5);
assert.equal((await readSiteMetricsReport(fixedEnv, now)).startedDay, '2026-10-12');
await writeSiteMetrics(fixedEnv, [events[1], events[1]], now + 60_000);
assert.equal(fixedDb.rows("SELECT event_count FROM site_metric_counts WHERE name = 'copy_success'")[0].event_count, 3);
fixedDb.sqlite.exec("INSERT INTO site_metric_counts VALUES ('2026-07-14','copy_success','text',1)");
await writeSiteMetrics(fixedEnv, [events[1]], now + 120_000);
assert.equal(siteMetricCutoff(now), '2026-07-15');
assert.equal(fixedDb.rows("SELECT * FROM site_metric_counts WHERE day < '2026-07-15'").length, 0);
assert.equal(fixedDb.rows('SELECT * FROM site_metric_rate WHERE expires_at <= ?', now + 120_000).length, 0);

const quotaDb = new SqliteD1(migration);
const quotaEnv = { ...env, COMMUNITY_DB: quotaDb };
for (let i = 0; i < 240; i++) assert.equal((await writeSiteMetrics(quotaEnv, [events[1]], now)).limited, false);
for (let i = 0; i < 5; i++) assert.equal((await writeSiteMetrics(quotaEnv, [events[1]], now)).limited, true);
assert.equal(quotaDb.rows('SELECT event_count FROM site_metric_counts')[0].event_count, 240);
assert.equal(quotaDb.rows('SELECT request_count FROM site_metric_rate')[0].request_count, 241);
const originalNow = Date.now;
let requestTime = now;
try {
  // The seeded quota and request must use the same clock, even at a minute edge.
  Date.now = () => requestTime;
  const throttleMinute = Math.floor(requestTime / 60_000) * 60_000;
  quotaDb.sqlite.exec(`INSERT OR REPLACE INTO site_metric_rate VALUES (${throttleMinute}, 240, ${throttleMinute + 120_000})`);
  const throttled = await onRequestPost(context(undefined, { env: quotaEnv }));
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers.get('retry-after')) >= 1);
  requestTime = throttleMinute + 60_000;
  assert.equal((await onRequestPost(context(undefined, { env: quotaEnv }))).status, 200);
} finally {
  Date.now = originalNow;
}
assert.equal((await writeSiteMetrics(quotaEnv, [events[1]], now + 60_000)).limited, false);
const unavailable = { ...env, COMMUNITY_DB: { prepare() { throw new Error('private internal error'); }, batch() {} } };
await disabled(await onRequestPost(context(undefined, { env: unavailable })));
assert.deepEqual(await writeSiteMetrics({ ...env, COMMUNITY_DB: new SqliteD1('') }, events, now), { enabled: false });

// A late count write failure rolls back quota and metadata as well.
const rollbackDb = new SqliteD1(migration);
rollbackDb.sqlite.exec('DROP TABLE site_metric_counts');
assert.deepEqual(await writeSiteMetrics({ ...env, COMMUNITY_DB: rollbackDb }, events, now), { enabled: false });
assert.equal(rollbackDb.rows('SELECT * FROM site_metric_rate').length, 0);
assert.equal(rollbackDb.rows('SELECT started_day FROM site_metric_meta')[0].started_day, null);

const admin = { env: fixedEnv, request: new Request(`${origin}/api/admin/site-metrics`, { headers: { authorization: 'Bearer test-only-token' } }) };
assert.equal((await adminGet({ ...admin, request: new Request(admin.request.url) })).status, 401);
const reportResponse = await adminGet(admin);
assert.equal(reportResponse.status, 200);
assert.equal(reportResponse.headers.get('cache-control'), 'no-store');
const report = await reportResponse.json();
assert.ok(!JSON.stringify(report).includes('actor'));
for (const table of ['site_metric_counts', 'site_metric_rate', 'site_metric_meta']) {
  const cols = fixedDb.rows(`PRAGMA table_info(${table})`).map(row => row.name);
  assert.ok(!cols.some(name => /id|actor|visitor|session|ip|url|prompt|query|stack/.test(name)));
}
const backend = await readFile(new URL('../functions/_site_metrics.js', import.meta.url), 'utf8');
assert.ok(!/clientIp|readLikeActor|rateIdentifier|console\.|user-agent|cf-connecting-ip/.test(backend));
console.log('PASS anonymous metrics backend: real SQLite migration, strict schema, disabled fallback, privacy, atomic throttle, retention, authenticated aggregates');
