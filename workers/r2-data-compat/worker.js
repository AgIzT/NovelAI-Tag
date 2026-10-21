import { handleAtlasDataRequest } from '../../functions/_atlas_data.js';

function corsHeaders(request, env) {
  const headers = new Headers({ vary: 'Origin' });
  const origin = request.headers.get('origin');
  const origins = String(env?.ATLAS_DATA_CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (origin && origin !== '*' && origins.includes(origin)) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-expose-headers', 'Content-Type, Content-Length, ETag, Accept-Ranges, Content-Range, X-Atlas-Data-Release');
  }
  return headers;
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/data/')) return new Response('not found', { status: 404 });
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      const requestedMethod = request.headers.get('access-control-request-method');
      const requestedHeaders = String(request.headers.get('access-control-request-headers') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
      if (!cors.has('access-control-allow-origin') || !['GET', 'HEAD'].includes(requestedMethod) || requestedHeaders.some(value => value !== 'range')) return new Response('CORS request denied', { status: 403, headers: cors });
      cors.set('access-control-allow-methods', 'GET, HEAD');
      cors.set('access-control-allow-headers', 'Range');
      cors.set('access-control-max-age', '3600');
      return new Response(null, { status: 204, headers: cors });
    }
    const response = await handleAtlasDataRequest(request, env, path.slice('/data/'.length).split('/'));
    const headers = new Headers(response.headers);
    for (const [key, value] of cors) headers.set(key, value);
    return new Response(response.body, { status: response.status, headers });
  },
};
