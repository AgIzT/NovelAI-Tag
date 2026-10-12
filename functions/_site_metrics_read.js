import { err } from './_lib.js';

export async function requireSiteMetricsRead({ request, env }, now = Date.now()) {
  const expected = String(env?.SITE_METRICS_READ_TOKEN || '').trim();
  const expiry = Date.parse(env?.SITE_METRICS_READ_TOKEN_EXPIRES_AT || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(expected) || !Number.isFinite(expiry)) {
    return err('Read-only metrics access is not configured', 503);
  }
  if (now >= expiry) return err('Read-only metrics access expired', 401);
  const match = (request.headers.get('authorization') || '').match(/^Bearer ([A-Za-z0-9_-]{43})$/i);
  if (!match) return err('Unauthorized', 401);
  const encoder = new TextEncoder();
  const provided = await crypto.subtle.digest('SHA-256', encoder.encode(match[1]));
  const configured = await crypto.subtle.digest('SHA-256', encoder.encode(expected));
  let equal;
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    equal = crypto.subtle.timingSafeEqual(provided, configured);
  } else {
    const a = new Uint8Array(provided), b = new Uint8Array(configured);
    let difference = 0;
    for (let i = 0; i < 32; i++) difference |= a[i] ^ b[i];
    equal = difference === 0;
  }
  return equal ? null : err('Unauthorized', 401);
}
