'use strict';

import { json, emptyCollection } from '../_lib.js';

// GET /api/community — 已发布的社区画风串列表（strings.js 的 dataUrl 指向这里）
export async function onRequestGet({ env }) {
  if (!env.STRINGS_BUCKET) return json(emptyCollection());
  const obj = await env.STRINGS_BUCKET.get('community/community.json');
  if (!obj) return json(emptyCollection());
  return new Response(obj.body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
