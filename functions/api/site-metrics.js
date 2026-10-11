import { json } from '../_lib.js';
import { isSameOriginWrite } from '../_engagements.js';
import { readSiteMetricBody, siteMetricPrivacyBlocked, siteMetricsAvailable, writeSiteMetrics } from '../_site_metrics.js';

function cleanRequestUrl(request) {
  try { return new URL(request.url).search === ''; } catch { return false; }
}

export async function onRequestGet({ request, env }) {
  if (!cleanRequestUrl(request) || siteMetricPrivacyBlocked(request)) return json({ enabled: false });
  return json({ enabled: await siteMetricsAvailable(env) });
}

export async function onRequestPost({ request, env }) {
  if (!cleanRequestUrl(request) || !isSameOriginWrite(request)
    || ['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site'))) {
    return json({ enabled: false }, 403);
  }
  if (siteMetricPrivacyBlocked(request) || !await siteMetricsAvailable(env)) return json({ enabled: false });
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')
    || request.headers.has('content-encoding')) return json({ enabled: true, accepted: false }, 415);
  const body = await readSiteMetricBody(request);
  if (!body.events) return json({ enabled: true, accepted: false }, body.status);
  const result = await writeSiteMetrics(env, body.events);
  if (!result.enabled) return json({ enabled: false });
  if (result.limited) return json({ enabled: true, accepted: false }, 429, { 'retry-after': String(result.retryAfter) });
  return json({ enabled: true, accepted: true });
}
