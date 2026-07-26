'use strict';

import {
  json, err, LIMITS, requireStorage,
  cleanLine, cleanText, normTags, normCategory, defaultSubmissionTitle,
  normImageParams,
} from '../_lib.js';
import { sniffImageKind, readPngSize, extractTextParams } from '../_params_core.js';

// POST /api/submit — 游客投稿（multipart 表单）
// 流程：字段/图片校验 → 压缩图 + 原图写入 R2 待审区
// 图片字段：images=压缩图(瀑布流用) / originals=原图(放大与参数保全用,文件名=对应序号)
//          / imagesMeta=JSON [{width,height,params}]（客户端读出的尺寸与隐写参数声明）
// 参数标注可信度：text/exif 由本函数服务端亲自解析原图=verified:true；
// stealth 需全图像素解码(CPU 配额跑不动)，记录客户端声明=verified:false，审核后台复检。

const CONTENT_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function parseImagesMeta(raw, count) {
  let meta;
  try { meta = JSON.parse(String(raw || '[]')); } catch { meta = []; }
  if (!Array.isArray(meta)) meta = [];
  return Array.from({ length: count }, (_, i) => (meta[i] && typeof meta[i] === 'object' ? meta[i] : {}));
}

function clampDim(v) {
  const n = Math.floor(Number(v || 0));
  return Number.isFinite(n) && n > 0 && n <= 20000 ? n : 0;
}

export async function onRequestPost({ request, env }) {
  const noStorage = requireStorage(env);
  if (noStorage) return noStorage;
  const contentLength = Number(request.headers.get('content-length') || 0);
  const multipartAllowance = 8 * 1024 * 1024;
  if (contentLength > LIMITS.totalBytes + multipartAllowance) {
    return err('图片总体积过大', 413);
  }
  let form;
  try { form = await request.formData(); } catch { return err('请求格式错误'); }

  // 文本字段
  const prompt = cleanText(form.get('prompt'), LIMITS.prompt);
  const category = normCategory(form.get('category'));
  const title = defaultSubmissionTitle({ title: form.get('title'), category, prompt });
  const negative = cleanText(form.get('negative'), LIMITS.negative);
  const comment = cleanText(form.get('comment'), LIMITS.comment);
  const submitter = cleanLine(form.get('submitter'), LIMITS.submitter);
  const tags = normTags(form.get('tags'));
  const nsfw = ['1', 'true', 'on'].includes(String(form.get('nsfw') || '').toLowerCase());

  if (!prompt) return err('Prompt 不能为空');

  // 压缩图（必需，瀑布流展示）
  const files = form.getAll('images').filter(f => f && typeof f.arrayBuffer === 'function');
  if (files.length < 1) return err('至少需要 1 张例图');
  if (files.length > LIMITS.imageCount) return err(`例图最多 ${LIMITS.imageCount} 张`);

  // 原图（可选，按文件名序号与压缩图配对；单张超限/损坏时静默降级为只有压缩图）
  const origByIndex = new Map();
  for (const f of form.getAll('originals')) {
    if (!f || typeof f.arrayBuffer !== 'function') continue;
    const m = /^(\d+)\./.exec(String(f.name || ''));
    if (!m) continue;
    const index = Number(m[1]) - 1;
    if (index >= 0 && index < files.length && !origByIndex.has(index)) origByIndex.set(index, f);
  }
  const metas = parseImagesMeta(form.get('imagesMeta'), files.length);

  let total = 0;
  const images = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.size > LIMITS.imageBytes) return err(`第 ${i + 1} 张图超过 ${Math.round(LIMITS.imageBytes / 1024 / 1024)}MB`, 413);
    total += f.size;
    if (total > LIMITS.totalBytes) return err('图片总体积过大', 413);
    const buf = new Uint8Array(await f.arrayBuffer());
    const ext = sniffImageKind(buf);
    if (!ext) return err(`第 ${i + 1} 张图不是有效的 JPEG/PNG/WebP 图片`);

    const image = { buf, ext, width: clampDim(metas[i].width), height: clampDim(metas[i].height) };

    const orig = origByIndex.get(i);
    if (orig && orig.size <= LIMITS.origBytes && total + orig.size <= LIMITS.totalBytes) {
      const origBuf = new Uint8Array(await orig.arrayBuffer());
      const origExt = sniffImageKind(origBuf);
      if (origExt) {
        total += orig.size;
        image.origBuf = origBuf;
        image.origExt = origExt;
        // 尺寸以原图为准；PNG 直接读 IHDR，比客户端上报更可信
        if (origExt === 'png') {
          const size = readPngSize(origBuf.buffer);
          if (size) { image.width = size.width; image.height = size.height; }
        }
        // 服务端亲自解析文本块/EXIF；命中即为已验证参数
        const found = await extractTextParams(origBuf.buffer).catch(() => null);
        if (found) {
          image.params = { source: cleanLine(found.source, 20) || 'PNG', via: found.via, verified: true };
        } else {
          // 服务端没读到 → 只接受客户端的隐写声明（text/exif 声明服务端读不到即视为无效）
          const claim = normImageParams(metas[i].params);
          if (claim && claim.via === 'stealth') image.params = { ...claim, verified: false };
        }
      }
    }
    images.push(image);
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
    const record = { key };
    if (im.origBuf) {
      const origKey = `community/img/${id}/${i + 1}.orig.${im.origExt}`;
      await env.STRINGS_BUCKET.put(origKey, im.origBuf, {
        httpMetadata: { contentType: CONTENT_TYPES[im.origExt], cacheControl: 'public, max-age=31536000, immutable' },
      });
      record.origKey = origKey;
    }
    if (im.width && im.height) { record.width = im.width; record.height = im.height; }
    if (im.params) record.params = im.params;
    stored.push(record);
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
