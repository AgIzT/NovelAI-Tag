import assert from 'node:assert/strict';
import { requireSiteMetricsRead } from '../functions/_site_metrics_read.js';
import { onRequest } from '../functions/api/site-metrics/report.js';
import { onRequestGet as adminGet } from '../functions/api/admin/site-metrics.js';
import { SqliteD1, readMigrations } from './sqlite-d1-test-harness.mjs';
import { cleanSiteMetrics } from './site-metrics-maintenance/worker.js';

const now = Date.parse('2026-10-12T12:00:00Z');
const originalNow = Date.now;
try {
  // HTTP handlers and retention fixtures must share a clock. Wall time would
  // discard the cutoff row, and eventually expire the synthetic read token.
  Date.now = () => now;

  const token = 'a'.repeat(43);
  const env = { SITE_METRICS_ENABLED: 'true', SITE_METRICS_READ_TOKEN: token, SITE_METRICS_READ_TOKEN_EXPIRES_AT: '2027-04-12T00:00:00Z', ADMIN_TOKEN: 'separate-admin-test' };
  const request = (suffix = '', method = 'GET', bearer = token) => new Request(`https://metrics.example.test/api/site-metrics/report${suffix}`, { method, headers: { authorization: `Bearer ${bearer}` } });
  assert.equal(await requireSiteMetricsRead({ env, request: request() }, Date.parse('2026-10-12')), null);
  assert.equal((await requireSiteMetricsRead({ env, request: request('', 'GET', 'b'.repeat(43)) })).status, 401);
  assert.equal((await requireSiteMetricsRead({ env, request: request() }, Date.parse('2027-04-12'))).status, 401);
  assert.equal((await requireSiteMetricsRead({ env: {}, request: request() })).status, 503);
  assert.equal((await adminGet({ env, request: request() })).status, 401, 'read token cannot authenticate administrator routes');
  assert.equal((await onRequest({ env, request: request('', 'POST') })).status, 405);
  assert.equal((await onRequest({ env, request: request('?token=not-accepted') })).status, 400);
  const sql = await readMigrations('0005_site_metrics.sql');
  const db = new SqliteD1(sql + 'CREATE TABLE unrelated_community (id TEXT); INSERT INTO unrelated_community VALUES (\'keep\');');
  const cutoff = '2026-07-15';
  db.sqlite.prepare('INSERT INTO site_metric_counts VALUES (?, ?, ?, ?)').run('2026-07-14', 'copy_success', 'text', 5);
  db.sqlite.prepare('INSERT INTO site_metric_counts VALUES (?, ?, ?, ?)').run(cutoff, 'copy_success', 'text', 2);
  db.sqlite.prepare('INSERT INTO site_metric_rate VALUES (?, ?, ?)').run(1, 1, now);
  db.sqlite.prepare('INSERT INTO site_metric_rate VALUES (?, ?, ?)').run(2, 1, now + 1);
  const cleanup = await cleanSiteMetrics({ METRICS_DB: db }, now);
  assert.equal(cleanup.cutoff, cutoff);
  assert.deepEqual(db.rows('SELECT day FROM site_metric_counts'), [{ day: cutoff }]);
  assert.deepEqual(db.rows('SELECT window_start FROM site_metric_rate'), [{ window_start: 2 }]);
  assert.deepEqual(db.rows('SELECT * FROM unrelated_community'), [{ id: 'keep' }]);
  assert.equal(db.rows('SELECT started_day FROM site_metric_meta')[0].started_day, null);
  assert.equal((await onRequest({ env: { ...env, COMMUNITY_DB: db }, request: request() })).status, 200);
  const body = await (await onRequest({ env: { ...env, COMMUNITY_DB: db }, request: request() })).json();
  assert.equal(body.enabled, true);
  assert.equal(body.startedDay, null);
  assert.equal(body.searchHitRate, null);
  assert.equal(body.totals.copy_success, 2);
  assert.equal(body.capturedAtUtc, '2026-10-12T12:00:00.000Z');
  assert.deepEqual(Object.keys(body).sort(), ['capturedAtUtc','daily','enabled','retentionDays','searchHitRate','startedDay','totals']);
  await cleanSiteMetrics({ METRICS_DB: db }, now);
  assert.deepEqual(db.rows('SELECT * FROM unrelated_community'), [{ id: 'keep' }]);
  await assert.rejects(cleanSiteMetrics({ METRICS_DB: { batch: async () => [{ success: false }], prepare: () => ({ bind: () => ({}) }) } }), /transaction failed/);
  const expiry = Date.parse(env.SITE_METRICS_READ_TOKEN_EXPIRES_AT);
  Date.now = () => expiry - 1;
  assert.equal((await onRequest({ env: { ...env, COMMUNITY_DB: db }, request: request() })).status, 200);
  Date.now = () => expiry;
  assert.equal((await onRequest({ env: { ...env, COMMUNITY_DB: db }, request: request() })).status, 401);
} finally {
  Date.now = originalNow;
}
console.log('PASS metrics read-only authorization, expiry, no administrator privileges, report schema, retention boundaries and unrelated-table preservation');
