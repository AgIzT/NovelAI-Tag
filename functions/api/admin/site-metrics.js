import { json, requireAdmin } from '../../_lib.js';
import { readSiteMetricsReport } from '../../_site_metrics.js';

export async function onRequestGet(context) {
  const auth = await requireAdmin(context);
  if (auth) return auth;
  if (new URL(context.request.url).search) return json({ enabled: false }, 400);
  return json(await readSiteMetricsReport(context.env));
}
