// 投稿后端内存流测试：原图收录 + 服务端参数验证 + schema 透出 + 前后端识别核心防漂移
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { onRequestPost as submitPost } from '../functions/api/submit.js';
import { onRequestGet as communityGet } from '../functions/api/community.js';
import { onRequestGet as adminGet, onRequestPost as adminPost } from '../functions/api/admin/community/[[path]].js';
import { toEntry, normalizeCommunityRecord } from '../functions/_lib.js';

// ---- 防漂移：functions/_params_core.js 必须与 site 端字节一致（Pages 构建不跨目录 import 的保守复制方案） ----
{
  const a = await readFile(new URL('../functions/_params_core.js', import.meta.url), 'utf-8');
  const b = await readFile(new URL('../site/assets/community/params-core.js', import.meta.url), 'utf-8');
  assert.equal(a, b, 'functions/_params_core.js 与 site/assets/community/params-core.js 漂移了，请重新同步');
}

class MemoryR2 {
  constructor() { this.objects = new Map(); this.metas = new Map(); }
  async get(key) {
    if (!this.objects.has(key)) return null;
    const raw = this.objects.get(key);
    return {
      json: async () => JSON.parse(new TextDecoder().decode(raw)),
      body: raw,
      httpMetadata: this.metas.get(key),
    };
  }
  async put(key, value, options) {
    let raw;
    if (typeof value === 'string') raw = new TextEncoder().encode(value);
    else if (value instanceof Uint8Array) raw = value;
    else raw = new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, raw);
    this.metas.set(key, options?.httpMetadata);
  }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
  async list({ prefix }) {
    return {
      objects: [...this.objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })),
      truncated: false,
    };
  }
}

/* ---- 手工构造测试图片字节（解析器不校验 CRC，置零即可） ---- */

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
}

function makePng({ width = 96, height = 80, texts = {} } = {}) {
  const enc = new TextEncoder();
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width, false);
  new DataView(ihdr.buffer).setUint32(4, height, false);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
  ];
  for (const [keyword, text] of Object.entries(texts)) {
    parts.push(pngChunk('tEXt', enc.encode(`${keyword}\0${text}`)));
  }
  parts.push(pngChunk('IDAT', new Uint8Array(0)), pngChunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function makeJpg(size = 64) {
  const out = new Uint8Array(Math.max(size, 4));
  out.set([0xff, 0xd8, 0xff, 0xe0]);
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9;
  return out;
}

const NAI_TEXTS = {
  Description: '1girl, test prompt',
  Software: 'NovelAI',
  Comment: JSON.stringify({ prompt: '1girl, test prompt', uc: 'lowres' }),
};

function submitContext(fields, images) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const metas = [];
  images.forEach((im, i) => {
    fd.append('images', new File([im.thumb], `${i + 1}.jpg`, { type: 'image/jpeg' }));
    if (im.orig) fd.append('originals', new File([im.orig], `${i + 1}.${im.origName || 'png'}`, { type: im.origType || 'image/png' }));
    metas.push(im.meta || {});
  });
  fd.append('imagesMeta', JSON.stringify(metas));
  return {
    env,
    request: new Request('https://example.test/api/submit', { method: 'POST', body: fd }),
  };
}

const bucket = new MemoryR2();
const env = {
  STRINGS_BUCKET: bucket,
  STRINGS_PUBLIC_BASE: 'https://cdn.example.test',
  ADMIN_TOKEN: 'test-token',
};

async function pendingRecord(id) {
  return (await bucket.get(`community/pending/${id}.json`)).json();
}

// ---- 1. 带 NAI 文本块原图：origKey / IHDR 尺寸 / 服务端验证参数 ----
{
  const res = await submitPost(submitContext(
    { prompt: 'hand prompt', category: '画风' },
    [{ thumb: makeJpg(), orig: makePng({ width: 832, height: 1216, texts: NAI_TEXTS }), meta: { width: 1, height: 1 } }],
  ));
  const data = await res.json();
  assert.equal(res.status, 201, JSON.stringify(data));
  const rec = await pendingRecord(data.id);
  const im = rec.images[0];
  assert.equal(im.key, `community/img/${data.id}/1.jpg`);
  assert.equal(im.origKey, `community/img/${data.id}/1.orig.png`);
  assert.equal(im.width, 832, 'PNG 尺寸应以服务端 IHDR 为准，不信客户端上报');
  assert.equal(im.height, 1216);
  assert.deepEqual(im.params, { source: 'NovelAI', via: 'text', verified: true });
  assert.ok(bucket.objects.has(im.origKey), '原图字节应已写入 R2');
  console.log('  ok  submit: NAI 原图 + 服务端验证');
}

// ---- 2. 无文本参数原图 + 客户端隐写声明：记录 verified:false ----
let stealthId;
{
  const res = await submitPost(submitContext(
    { prompt: 'stealth prompt' },
    [{
      thumb: makeJpg(),
      orig: makePng({ width: 128, height: 128 }),
      meta: { width: 128, height: 128, params: { source: 'NovelAI', via: 'stealth' } },
    }],
  ));
  const data = await res.json();
  assert.equal(res.status, 201);
  stealthId = data.id;
  const rec = await pendingRecord(data.id);
  assert.deepEqual(rec.images[0].params, { source: 'NovelAI', via: 'stealth', verified: false });
  console.log('  ok  submit: 隐写声明落库 verified:false');
}

// ---- 3. 伪造 text 声明（服务端读不到）→ 参数被丢弃 ----
{
  const res = await submitPost(submitContext(
    { prompt: 'fake claim' },
    [{
      thumb: makeJpg(),
      orig: makePng({ width: 64, height: 64 }),
      meta: { params: { source: 'NovelAI', via: 'text' } },
    }],
  ));
  const data = await res.json();
  const rec = await pendingRecord(data.id);
  assert.equal(rec.images[0].params, undefined, '服务端验证不过的 text 声明必须丢弃');
  assert.ok(rec.images[0].origKey, '原图本身仍保留');
  console.log('  ok  submit: 伪造 text 声明被丢弃');
}

// ---- 4. 原图超限 → 静默降级只留压缩图 ----
{
  const big = new Uint8Array(10 * 1024 * 1024 + 16);
  big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const res = await submitPost(submitContext(
    { prompt: 'oversized original' },
    [{ thumb: makeJpg(), orig: big, meta: { width: 500, height: 700 } }],
  ));
  const data = await res.json();
  assert.equal(res.status, 201);
  const rec = await pendingRecord(data.id);
  assert.equal(rec.images[0].origKey, undefined);
  assert.equal(rec.images[0].width, 500, '客户端尺寸仍可用于瀑布流比例');
  assert.equal([...bucket.objects.keys()].filter(k => k.startsWith(`community/img/${data.id}/`)).length, 1);
  console.log('  ok  submit: 超限原图降级');
}

// ---- 5. 无原图投稿（老前端语义）照常工作 ----
{
  const res = await submitPost(submitContext({ prompt: 'thumb only' }, [{ thumb: makeJpg() }]));
  const data = await res.json();
  assert.equal(res.status, 201, JSON.stringify(data));
  const rec = await pendingRecord(data.id);
  assert.equal(rec.images[0].origKey, undefined);
  assert.equal(rec.images[0].params, undefined);
  console.log('  ok  submit: 仅压缩图兼容');
}

// ---- 6. 审核通过 → 公开聚合透出 original/params；旧记录零迁移兼容 ----
{
  const decideRes = await adminPost(adminContext('POST', 'approve', { id: stealthId }));
  assert.equal(decideRes.status, 200, JSON.stringify(await decideRes.json()));

  const publicRes = await communityGet({ env });
  const data = await publicRes.json();
  const entry = data.entries.find(e => e.id === stealthId);
  assert.ok(entry, '通过的投稿应出现在公开聚合');
  const image = entry.images[0];
  assert.equal(image.file, `https://cdn.example.test/community/img/${stealthId}/1.jpg`);
  assert.equal(image.original, `https://cdn.example.test/community/img/${stealthId}/1.orig.png`);
  assert.equal(image.width, 128);
  assert.deepEqual(image.params, { source: 'NovelAI', via: 'stealth', verified: false });
  console.log('  ok  approve: 聚合透出 original/params');
}

// ---- 7a. 管理端 asset 代理：合法 key 出字节，越权 key 拒绝 ----
function adminContext(method, path, body, query = '') {
  const options = { method, headers: { authorization: 'Bearer test-token' } };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  return {
    env,
    params: { path: path ? [path] : [] },
    request: new Request(`https://admin.example.test/api/admin/community/${path || ''}${query}`, options),
  };
}
{
  const key = `community/img/${stealthId}/1.orig.png`;
  const res = await adminGet(adminContext('GET', 'asset', undefined, `?key=${encodeURIComponent(key)}`));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(bytes[0], 0x89, '应返回原图字节');
  const bad = await adminGet(adminContext('GET', 'asset', undefined, `?key=${encodeURIComponent('community/pending/x.json')}`));
  assert.equal(bad.status, 400, '非图片前缀 key 必须拒绝');
  console.log('  ok  admin: asset 代理与 key 白名单');
}

// ---- 7b. 管理端 params 动作：复检结论覆盖 / 移除，approved 触发聚合重建 ----
{
  const verified = await adminPost(adminContext('POST', 'params', {
    id: stealthId, imageIndex: 0, params: { source: 'NovelAI', via: 'stealth', verified: true },
  }));
  const verifiedData = await verified.json();
  assert.equal(verified.status, 200, JSON.stringify(verifiedData));
  assert.deepEqual(verifiedData.item.images[0].params, { source: 'NovelAI', via: 'stealth', verified: true });

  let aggregate = JSON.parse(new TextDecoder().decode(bucket.objects.get('community/community.json')));
  let entry = aggregate.entries.find(e => e.id === stealthId);
  assert.equal(entry.images[0].params.verified, true, 'approved 记录复检后应重建公开聚合');

  const removed = await adminPost(adminContext('POST', 'params', { id: stealthId, imageIndex: 0, params: null }));
  const removedData = await removed.json();
  assert.equal(removed.status, 200, JSON.stringify(removedData));
  assert.equal(removedData.item.images[0].params, null, '复检未检出应移除标注');
  aggregate = JSON.parse(new TextDecoder().decode(bucket.objects.get('community/community.json')));
  entry = aggregate.entries.find(e => e.id === stealthId);
  assert.equal(entry.images[0].params, undefined, '公开聚合徽标应随之消失');
  assert.equal(entry.images[0].original, `https://cdn.example.test/community/img/${stealthId}/1.orig.png`, '原图不受影响');
  console.log('  ok  admin: params 复检持久化');
}

// ---- 7. 旧 schema 图片（只有 key/label）经 toEntry 不变形 ----
{
  const legacy = normalizeCommunityRecord({
    id: 'legacy01', prompt: 'p', images: [{ key: 'community/img/legacy01/1.jpg', label: 'gallery' }],
  });
  const entry = toEntry(env, legacy);
  assert.equal(entry.images[0].file, 'https://cdn.example.test/community/img/legacy01/1.jpg');
  assert.equal(entry.images[0].original, undefined);
  assert.equal(entry.images[0].params, undefined);
  assert.equal(entry.images[0].label, 'gallery');
  console.log('  ok  legacy: 旧记录零迁移兼容');
}

console.log('community submit backend: PASS');
