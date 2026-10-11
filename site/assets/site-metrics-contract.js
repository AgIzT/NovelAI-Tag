export const MAX_SITE_METRIC_EVENTS = 16;

export const SITE_METRIC_DETAILS = Object.freeze({
  search_success: Object.freeze(['codex', 'site', 'favorites']),
  search_empty: Object.freeze(['codex', 'site', 'favorites']),
  copy_success: Object.freeze(['prompt', 'text']),
  share_success: Object.freeze(['native', 'link']),
  export_success: Object.freeze(['favorites_json', 'favorites_text', 'favorites_recovery', 'relay_json']),
  frontend_error: Object.freeze(['runtime', 'syntax', 'promise', 'resource', 'clipboard', 'share', 'export', 'search_data']),
});

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function validSiteMetric(name, detail) {
  return typeof name === 'string' && typeof detail === 'string'
    && Object.hasOwn(SITE_METRIC_DETAILS, name)
    && SITE_METRIC_DETAILS[name].includes(detail);
}

export function parseSiteMetrics(value) {
  if (!exactKeys(value, ['v', 'events']) || value.v !== 1
    || !Array.isArray(value.events) || !value.events.length
    || value.events.length > MAX_SITE_METRIC_EVENTS) return null;
  if (!value.events.every(event => exactKeys(event, ['name', 'detail'])
    && validSiteMetric(event.name, event.detail))) return null;
  return value.events.map(({ name, detail }) => ({ name, detail }));
}
