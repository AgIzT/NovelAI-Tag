'use strict';

import {
  json, err, LIMITS, IMAGE_LABELS, requireStorage,
  cleanLine, cleanText, normTags, normCategory,
} from '../_lib.js';

// POST /api/submit — 游客投稿（multipart 表单）
// 流程：字段/图片校验 → 图片与记录写入 R2 待审区

// 魔数嗅探：只收 JPEG / PNG / WebP
function sniffImage(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  return null;
}

const CONTENT_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export async function onRequestPost({ request, env }) {
  const noStorage = requireStorage(env);
  if (noStorage) return noStorage;
  let form;
  try { form = await request.formData(); } catch { return err('请求格式错误'); }

  // 文本字段
  const title = cleanLine(form.get('title'), LIMITS.title);
  const prompt = cleanText(form.get('prompt'), LIMITS.prompt);
  const negative = cleanText(form.get('negative'), LIMITS.negative);
  const comment = cleanText(form.get('comment'), LIMITS.comment);
  const submitter = cleanLine(form.get('submitter'), LIMITS.submitter);
  const tags = normTags(form.get('tags'));
  const category = normCategory(form.get('category'));
  const nsfw = ['1', 'true', 'on'].includes(String(form.get('nsfw') || '').toLowerCase());

  if (!title) return err('标题不能为空');
  if (!prompt) return err('画风串内容不能为空');

  // 图片字段
  const files = form.getAll('images').filter(f => f && typeof f.arrayBuffer === 'function');
  const labels = form.getAll('labels').map(String);
  if (files.length < 1) return err('至少需要 1 张例图');
  if (files.length > LIMITS.imageCount) return err(`例图最多 ${LIMITS.imageCount} 张`);

  let total = 0;
  const images = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.size > LIMITS.imageBytes) return err(`第 ${i + 1} 张图超过 ${Math.round(LIMITS.imageBytes / 1024 / 1024)}MB`, 413);
    total += f.size;
    if (total > LIMITS.totalBytes) return err('图片总体积过大', 413);
    const buf = new Uint8Array(await f.arrayBuffer());
    const ext = sniffImage(buf);
    if (!ext) return err(`第 ${i + 1} 张图不是有效的 JPEG/PNG/WebP 图片`);
    const label = IMAGE_LABELS.includes(labels[i]) ? labels[i] : 'gallery';
    images.push({ buf, ext, label });
  }

  // 待审区容量保险丝，防恶意灌水撑爆存储
  const pend = await env.STRINGS_BUCKET.list({ prefix: 'community/pending/', limit: 1000 });
  const pendCount = pend.objects.filter(o => o.key.endsWith('.json')).length;
  if (pendCount >= LIMITS.pendingMax) return err('待审投稿已满，请过几天再来', 429);

  // 写入 R2
  const id = crypto.randomUUID();
  const stored = [];
  for (let i = 0; i < images.length; i++) {
    const im = images[i];
    const key = `community/img/${id}/${i + 1}.${im.ext}`;
    await env.STRINGS_BUCKET.put(key, im.buf, {
      httpMetadata: { contentType: CONTENT_TYPES[im.ext], cacheControl: 'public, max-age=31536000, immutable' },
    });
    stored.push({ key, label: im.label });
  }

  const record = {
    id, title, prompt, negative, comment, tags, category, nsfw, submitter,
    images: stored,
    createdAt: Date.now(),
  };
  await env.STRINGS_BUCKET.put(`community/pending/${id}.json`, JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });

  return json({ ok: true, id }, 201);
}
