export async function cleanSiteMetrics(env, now = Date.now()) {
  if (!env?.METRICS_DB || typeof env.METRICS_DB.batch !== 'function') throw new Error('Metrics maintenance binding unavailable');
  const cutoff = new Date(Math.floor(now / 86400000) * 86400000 - 89 * 86400000).toISOString().slice(0, 10);
  const results = await env.METRICS_DB.batch([
    env.METRICS_DB.prepare('DELETE FROM site_metric_counts WHERE day < ?').bind(cutoff),
    env.METRICS_DB.prepare('DELETE FROM site_metric_rate WHERE expires_at <= ?').bind(now),
  ]);
  if (results.some(result => result.success === false)) throw new Error('Metrics maintenance transaction failed');
  return { cutoff, changedRows: results.reduce((sum, result) => sum + (result.meta?.changes || 0), 0) };
}

export default {
  async scheduled(controller, env) {
    try {
      // Use execution time rather than a delayed scheduled time for expiry.
      const result = await cleanSiteMetrics(env);
      console.log(JSON.stringify({ event: 'site_metrics_expiry', scheduledTime: controller.scheduledTime, ...result }));
    } catch {
      console.error(JSON.stringify({ event: 'site_metrics_expiry_failed', scheduledTime: controller.scheduledTime }));
      throw new Error('Metrics expiry failed');
    }
  },
  fetch() { return new Response('Not found', { status: 404 }); },
};
