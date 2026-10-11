import { MAX_SITE_METRIC_EVENTS, validSiteMetric } from '../site-metrics-contract.js';

export const SITE_ANALYTICS_ENABLED = false;

const MINUTE_MS = 60_000;
const QUEUE_LIMIT = 48;
const EVENT_LIMIT = 60;
const REQUEST_LIMIT = 6;
const FLUSH_MS = 5_000;
const TIMEOUT_MS = 3_000;

function privacyBlocked(host) {
  try {
    const nav = host.navigator;
    const dnt = nav?.doNotTrack ?? host.doNotTrack;
    return nav?.globalPrivacyControl === true || dnt === '1' || dnt === 'yes'
      || host.doNotTrack === '1' || host.doNotTrack === 'yes';
  } catch { return true; }
}

// The factory is injectable for offline tests. No storage or identity exists.
export function createSiteAnalytics({ enabled = false, host = globalThis } = {}) {
  let ready = false;
  let stopped = false;
  let started = false;
  let queue = [];
  let timer = null;
  let controller = null;
  let sending = false;
  let eventTimes = [];
  let requestTimes = [];
  const listeners = [];
  let endpoint = '';
  let searchObservation = null;
  let searchTimer = null;

  function cancelSearch() {
    const pending = searchTimer;
    searchTimer = null;
    searchObservation = null;
    try { if (pending !== null) host.clearTimeout(pending); }
    catch { /* Cancellation must not interrupt navigation. */ }
  }

  function stop() {
    stopped = true;
    ready = false;
    queue = [];
    if (timer !== null) host.clearTimeout(timer);
    timer = null;
    cancelSearch();
    controller?.abort();
    for (const [target, type, handler, capture] of listeners.splice(0)) {
      target.removeEventListener(type, handler, capture);
    }
  }

  function allowed() {
    if (!enabled || stopped) return false;
    if (privacyBlocked(host)) { stop(); return false; }
    return true;
  }

  function listen(target, type, handler, capture = false) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, capture);
    listeners.push([target, type, handler, capture]);
  }

  async function request(options) {
    controller = new host.AbortController();
    const current = controller;
    const timeout = host.setTimeout(() => current.abort(), TIMEOUT_MS);
    try {
      const response = await host.fetch(endpoint, {
        ...options, credentials: 'omit', referrerPolicy: 'no-referrer',
        cache: 'no-store', signal: current.signal,
      });
      if (!response.ok) return { ok: false };
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
        throw new Error('Unexpected metrics response');
      }
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 256) { await reader.cancel(); throw new Error('Metrics response too large'); }
          chunks.push(new TextDecoder().decode(value));
        }
        return { ok: true, data: JSON.parse(chunks.join('')) };
      } finally { reader.releaseLock(); }
    } finally {
      host.clearTimeout(timeout);
      if (controller === current) controller = null;
    }
  }

  function schedule() {
    if (timer !== null || !queue.length || !ready || stopped) return;
    timer = host.setTimeout(() => {
      timer = null;
      void flush();
    }, FLUSH_MS);
  }

  function record(name, detail) {
    try {
      if (!allowed() || !ready || !validSiteMetric(name, detail)) return;
      const now = host.Date.now();
      eventTimes = eventTimes.filter(time => time > now - MINUTE_MS);
      if (eventTimes.length >= EVENT_LIMIT || queue.length >= QUEUE_LIMIT) return;
      eventTimes.push(now);
      queue.push({ name, detail });
      schedule();
    } catch { /* Metrics must never break a product action. */ }
  }

  function beginSearch() {
    try {
      cancelSearch();
      if (!allowed() || !ready) return () => {};
      const observation = {};
      searchObservation = observation;
      return (result = {}) => {
        try {
          if (searchObservation !== observation) return;
          const { active, valid, hasResults, scope } = result;
          if (!active || !valid || !allowed() || !validSiteMetric('search_success', scope)) {
            cancelSearch();
            return;
          }
          if (searchTimer !== null) host.clearTimeout(searchTimer);
          searchTimer = host.setTimeout(() => {
            searchTimer = null;
            if (searchObservation !== observation) return;
            searchObservation = null;
            record(hasResults ? 'search_success' : 'search_empty', scope);
          }, 800);
        } catch { if (searchObservation === observation) cancelSearch(); }
      };
    } catch { return () => {}; }
  }

  async function flush() {
    try {
      if (!allowed() || !ready || sending || !queue.length) return;
      if (timer !== null) host.clearTimeout(timer);
      timer = null;
      const now = host.Date.now();
      requestTimes = requestTimes.filter(time => time > now - MINUTE_MS);
      if (requestTimes.length >= REQUEST_LIMIT) { queue = []; return; }
      requestTimes.push(now);
      const events = queue.splice(0, MAX_SITE_METRIC_EVENTS);
      sending = true;
      const response = await request({
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, events }),
      });
      // No replay/retry IDs: failed batches are dropped, never resent.
      if (!response.ok || response.data.enabled !== true) stop();
    } catch { stop(); }
    finally { sending = false; if (!stopped) schedule(); }
  }

  async function start() {
    try {
      if (started || !allowed()) return;
      started = true;
      if (!/^https?:$/.test(host.location?.protocol || '')) return;
      endpoint = new URL('/api/site-metrics', host.location.origin).href;
      const response = await request({ method: 'GET' });
      if (!allowed() || !response.ok || response.data.enabled !== true) { stop(); return; }
      ready = true;
      listen(host, 'error', event => {
        // Read no resource URL, filename, stack or message.
        try {
          record('frontend_error', event.target && event.target !== host ? 'resource'
            : event.error?.name === 'SyntaxError' ? 'syntax' : 'runtime');
        } catch { /* A hostile error getter must not recurse through this listener. */ }
      }, true);
      listen(host, 'unhandledrejection', () => record('frontend_error', 'promise'));
      listen(host.document, 'visibilitychange', () => {
        if (host.document.visibilityState === 'hidden') void flush();
      });
    } catch { stop(); }
  }

  return { start, record, beginSearch, cancelSearch, flush, stop };
}

const siteAnalytics = createSiteAnalytics({ enabled: SITE_ANALYTICS_ENABLED });
export function setupSiteAnalytics() { void siteAnalytics.start(); }
export function recordSiteEvent(name, detail) { siteAnalytics.record(name, detail); }
export function beginSiteSearchObservation() { return siteAnalytics.beginSearch(); }
export function cancelSiteSearchObservation() { siteAnalytics.cancelSearch(); }
