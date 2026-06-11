'use strict';

// GET /r2/community/... — 从绑定的桶里读图片
// 仅当环境变量 STRINGS_PUBLIC_BASE=/r2 时会被前端用到（本地 wrangler dev 调试）；
// 线上默认直连 R2 公开地址，不走这里。
export async function onRequestGet({ env, params }) {
  if (!env.STRINGS_BUCKET) return new Response('no bucket', { status: 503 });
  const key = (params.key || []).map(decodeURIComponent).join('/');
  if (!key.startsWith('community/')) return new Response('forbidden', { status: 403 });
  const obj = await env.STRINGS_BUCKET.get(key);
  if (!obj) return new Response('not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'content-type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
      'cache-control': 'public, max-age=86400',
    },
  });
}
