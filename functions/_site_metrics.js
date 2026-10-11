import { enabledFlag } from './_engagements.js';
import { parseSiteMetrics } from '../site/assets/site-metrics-contract.js';

export const SITE_METRIC_BODY_BYTES = 2048;
export const SITE_METRIC_RETENTION_DAYS = 90;
export const SITE_METRIC_GLOBAL_REQUEST_LIMIT = 240;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export function siteMetricPrivacyBlocked(request) {
  return request.headers.get('sec-gpc') === '1' || request.headers.get('dnt') === '1';
}

export function siteMetricBinding(env) {
  return enabledFlag(env?.SITE_METRICS_ENABLED) && env?.COMMUNITY_DB
    && typeof env.COMMUNITY_DB.prepare === 'function' && typeof env.COMMUNITY_DB.batch === 'function'
    ? env.COMMUNITY_DB : null;
}

export async function siteMetricsAvailable(env) {
  const db = siteMetricBinding(env);
  if (!db) return false;
  try {
    const results = await db.batch([
      db.prepare('SELECT schema_version FROM site_metric_meta WHERE singleton = 1'),
      db.prepare('SELECT day, name, detail, event_count FROM site_metric_counts LIMIT 0'),
      db.prepare('SELECT window_start, request_count, expires_at FROM site_metric_rate LIMIT 0'),
    ]);
    return results.every(result => result.success !== false)
      && results[0].results?.[0]?.schema_version === 1;
  } catch { return false; }
}

export async function readSiteMetricBody(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > SITE_METRIC_BODY_BYTES)) {
    return { status: 413 };
  }
  if (!request.body) return { status: 400 };
  const reader = request.body.getReader();
  let bytes = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > SITE_METRIC_BODY_BYTES) {
        await reader.cancel();
        return { status: 413 };
      }
      chunks.push(value);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    const events = parseSiteMetrics(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)));
    return events ? { events } : { status: 400 };
  } catch { return { status: 400 }; }
  finally { reader.releaseLock(); }
}

export function siteMetricCutoff(now) {
  return new Date(Math.floor(now / DAY_MS) * DAY_MS - (SITE_METRIC_RETENTION_DAYS - 1) * DAY_MS)
    .toISOString().slice(0, 10);
}

export async function writeSiteMetrics(env, events, now = Date.now()) {
  const db = siteMetricBinding(env);
  if (!db) return { enabled: false };
  const day = new Date(now).toISOString().slice(0, 10);
  const windowStart = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const grouped = new Map();
  for (const event of events) {
    const key = `${event.name}:${event.detail}`;
    const item = grouped.get(key) || { ...event, count: 0 };
    item.count += 1;
    grouped.set(key, item);
  }
  // D1 batch is transactional: the global quota and all counts settle together.
  const statements = [
    db.prepare('DELETE FROM site_metric_rate WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM site_metric_counts WHERE day < ?').bind(siteMetricCutoff(now)),
    db.prepare(`INSERT INTO site_metric_rate (window_start, request_count, expires_at)
      VALUES (?, 1, ?) ON CONFLICT (window_start) DO UPDATE SET
      request_count = MIN(site_metric_rate.request_count + 1, 241)`)
      .bind(windowStart, windowStart + 2 * MINUTE_MS),
    db.prepare('SELECT request_count FROM site_metric_rate WHERE window_start = ?').bind(windowStart),
    db.prepare(`UPDATE site_metric_meta SET started_day = COALESCE(started_day, ?)
      WHERE singleton = 1 AND schema_version = 1 AND
      (SELECT request_count FROM site_metric_rate WHERE window_start = ?) <= ?`)
      .bind(day, windowStart, SITE_METRIC_GLOBAL_REQUEST_LIMIT),
  ];
  for (const { name, detail, count } of grouped.values()) {
    statements.push(db.prepare(`INSERT INTO site_metric_counts (day, name, detail, event_count)
      SELECT ?, ?, ?, ? WHERE
      (SELECT request_count FROM site_metric_rate WHERE window_start = ?) <= ?
      ON CONFLICT (day, name, detail) DO UPDATE SET
      event_count = site_metric_counts.event_count + excluded.event_count`)
      .bind(day, name, detail, count, windowStart, SITE_METRIC_GLOBAL_REQUEST_LIMIT));
  }
  try {
    const results = await db.batch(statements);
    if (results.some(result => result.success === false)) return { enabled: false };
    const limited = Number(results[3].results?.[0]?.request_count) > SITE_METRIC_GLOBAL_REQUEST_LIMIT;
    return { enabled: true, limited, retryAfter: Math.ceil((windowStart + MINUTE_MS - now) / 1000) };
  } catch { return { enabled: false }; }
}

export async function readSiteMetricsReport(env, now = Date.now()) {
  const db = siteMetricBinding(env);
  if (!db || !await siteMetricsAvailable(env)) return { enabled: false };
  try {
    const results = await db.batch([
      db.prepare('SELECT started_day FROM site_metric_meta WHERE singleton = 1'),
      db.prepare(`SELECT day, name, detail, event_count FROM site_metric_counts
        WHERE day >= ? ORDER BY day, name, detail`).bind(siteMetricCutoff(now)),
    ]);
    if (results.some(result => result.success === false)) return { enabled: false };
    const daily = results[1].results || [];
    const totals = {};
    for (const row of daily) totals[row.name] = (totals[row.name] || 0) + row.event_count;
    const searches = (totals.search_success || 0) + (totals.search_empty || 0);
    return {
      enabled: true, startedDay: results[0].results?.[0]?.started_day || null,
      retentionDays: SITE_METRIC_RETENTION_DAYS, totals, daily,
      searchHitRate: searches ? (totals.search_success || 0) / searches : null,
    };
  } catch { return { enabled: false }; }
}
