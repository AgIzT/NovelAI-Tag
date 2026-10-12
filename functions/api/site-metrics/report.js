import { json } from '../../_lib.js';
import { requireSiteMetricsRead } from '../../_site_metrics_read.js';
import { readSiteMetricsReport } from '../../_site_metrics.js';

export async function onRequest(context) {
  if (context.request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { allow: 'GET' });
  if (new URL(context.request.url).search) return json({ error: 'Query parameters are not accepted' }, 400);
  const now = Date.now();
  const denied = await requireSiteMetricsRead(context, now);
  if (denied) return denied;
  const report = await readSiteMetricsReport(context.env, now);
  return json({ ...report, capturedAtUtc: new Date(now).toISOString() });
}
