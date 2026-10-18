'use strict';

import {
  json, err, LIMITS, requireStorage,
  cleanLine, cleanText, normTags, normCategory, defaultSubmissionTitle,
  normImageParams, COMMUNITY_STATUSES,
} from '../_lib.js';
import { sniffImageKind, readPngSize, extractTextParams } from '../_params_core.js';
import { reservePendingSlot, releasePendingSlot } from '../_submission_guards.js';

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

// 只补偿本请求已确认首建的媒体，不扫描 ID 前缀，也不把读空当作写入失败证明。
async function compensateMedia(bucket, keys) {
  if (!keys.length) return [];
  try { await bucket.delete(keys); return []; } catch { /* 批量删除可能部分完成，逐 key 重试一次 */ }
  const failed = [];
  for (let i = 0; i < keys.length; i += 4) {
    const results = await Promise.all(keys.slice(i, i + 4).map(async key => {
      try { await bucket.delete(key); return null; } catch { return key; }
    }));
    failed.push(...results.filter(Boolean));
  }
  return failed;
}

async function storeSubmission(env, { id, record, uploads, slot }) {
  const bucket = env.STRINGS_BUCKET;
  const pendingKey = `community/pending/${id}.json`;
  const recoveryKey = `community/submission-recovery/${id}.json`;
  const confirmedMediaKeys = [];
  let intent, intentObject, attemptId;
  let phase = 'identity';
  let uncertainKey = null;
  let pendingUnknown = false;

  async function create(key, value, httpMetadata) {
    uncertainKey = key;
    const result = await bucket.put(key, value, {
      httpMetadata, customMetadata: { submissionAttempt: attemptId },
      onlyIf: new Headers({ 'if-none-match': '*' }),
    });
    uncertainKey = null; // null 返回也是确定的首建冲突，不能据此认领已有对象。
    return result;
  }
  async function removeIntent() {
    try { await bucket.delete(recoveryKey); }
    catch {
      console.warn(JSON.stringify({ event: 'community_submission_recovery_cleanup_failed', id, recoveryKey, phase }));
    }
  }

  try {
    // 只读五个精确记录 key；损坏 JSON 也算已占用，不能复用其 ID。
    const existing = await Promise.all(COMMUNITY_STATUSES.map(status => bucket.head(`community/${status}/${id}.json`)));
    if (existing.some(Boolean)) throw new Error('Submission ID already exists');
    attemptId = crypto.randomUUID();
    intent = { version: 1, id, attemptId, pendingKey, mediaKeys: uploads.map(upload => upload.key), createdAt: record.createdAt };
    phase = 'intent';
    intentObject = await create(recoveryKey, JSON.stringify(intent), { contentType: 'application/json; charset=utf-8' });
    if (!intentObject) throw new Error('Submission recovery key already exists');
    phase = 'media';
    for (const upload of uploads) {
      const saved = await create(upload.key, upload.body, upload.httpMetadata);
      if (!saved) throw new Error('Submission media key already exists');
      confirmedMediaKeys.push(upload.key);
    }
    phase = 'pending';
    pendingUnknown = true;
    const saved = await create(pendingKey, JSON.stringify(record), { contentType: 'application/json; charset=utf-8' });
    if (!saved) {
      pendingUnknown = false;
      throw new Error('Submission pending key already exists');
    }
  } catch (error) {
    // pending 写入一旦结果不明，可能已经提交或稍后提交；保留媒体及占位，避免生成缺图记录。
    const cleanupFailedKeys = pendingUnknown ? [] : await compensateMedia(bucket, confirmedMediaKeys);
    const needsRecovery = pendingUnknown || uncertainKey || cleanupFailedKeys.length;
    if (intentObject && needsRecovery) {
      try {
        const saved = await bucket.put(recoveryKey, JSON.stringify({
          ...intent, phase, confirmedMediaKeys, uncertainKey, cleanupFailedKeys,
          pendingOutcome: pendingUnknown ? 'unknown' : 'not_committed', failedAt: Date.now(),
        }), {
          httpMetadata: { contentType: 'application/json; charset=utf-8' },
          onlyIf: { etagMatches: intentObject.etag },
        });
        if (!saved) throw new Error('Recovery snapshot conflict');
      } catch {
        // 初始清单已在媒体之前持久化；更新失败也不能抹掉原始错误或声称补偿完成。
        console.warn(JSON.stringify({ event: 'community_submission_recovery_update_failed', id, recoveryKey }));
      }
    } else if (intentObject) {
      await removeIntent();
    }
    if (needsRecovery) {
      console.error(JSON.stringify({
        event: 'community_submission_recovery_needed', id, recoveryKey, phase,
        uncertainKey, cleanupFailedKeys, pendingOutcome: pendingUnknown ? 'unknown' : 'not_committed',
      }));
    }
    if (!pendingUnknown) await releasePendingSlot(env, { queue: 'community', id: slot?.id });
    throw error;
  }
  // pending 已确认提交。清单删除失败仅留待核对，不能触发媒体回滚或返回投稿失败。
  phase = 'committed';
  await removeIntent();
}

export async function onRequestPost({ request, env }) {
  const noStorage = requireStorage(env);
  if (noStorage) return noStorage;
  const contentLength = Number(request.headers.get('content-length') || 0);
  const multipartAllowance = 8 * 1024 * 1024;
  if (contentLength > LIMITS.totalBytes + multipartAllowance) {
    return err(`图片总体积超过 ${Math.round(LIMITS.totalBytes / 1024 / 1024)} MB，减少图片后重新提交`, 413);
  }
  // 待审区容量保险丝，防恶意灌水撑爆存储。放在读表单、解析原图之前：队列已满时不再花力气处理上传内容
  const pend = await env.STRINGS_BUCKET.list({ prefix: 'community/pending/', limit: 1000 });
  const pendCount = pend.objects.filter(o => o.key.endsWith('.json')).length;
  if (pendCount >= LIMITS.pendingMax) return err('待审投稿已满，过几天再投稿', 429);

  let form;
  try { form = await request.formData(); } catch { return err('投稿请求格式无效，重新打开投稿表单后提交'); }

  // 文本字段
  const prompt = cleanText(form.get('prompt'), LIMITS.prompt);
  const category = normCategory(form.get('category'));
  const title = defaultSubmissionTitle({ title: form.get('title'), category, prompt });
  const negative = cleanText(form.get('negative'), LIMITS.negative);
  const comment = cleanText(form.get('comment'), LIMITS.comment);
  const submitter = cleanLine(form.get('submitter'), LIMITS.submitter);
  const tags = normTags(form.get('tags'));
  const nsfw = ['1', 'true', 'on'].includes(String(form.get('nsfw') || '').toLowerCase());

  if (!prompt) return err('正向提示词不能为空');

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
    if (f.size > LIMITS.imageBytes) return err(`第 ${i + 1} 张图超过 ${Math.round(LIMITS.imageBytes / 1024 / 1024)} MB，移除这张图或换用较小的图片`, 413);
    total += f.size;
    if (total > LIMITS.totalBytes) return err(`图片总体积超过 ${Math.round(LIMITS.totalBytes / 1024 / 1024)} MB，减少图片后重新提交`, 413);
    const buf = new Uint8Array(await f.arrayBuffer());
    const ext = sniffImageKind(buf);
    if (!ext) return err(`第 ${i + 1} 张图不是有效的 JPEG/PNG/WebP 图片，重新选择这张图`);

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

  // 并发保险：前面的 R2 计数只负责尽早拒绝；真正的上限在写入前用 D1 原子占位守住。
  // 放在所有校验和解析之后，无效上传不会白占名额；D1 不可用时 slot 为 null，退回只看 R2 计数。
  const slot = await reservePendingSlot(env, { queue: 'community', pendingCount: pendCount, max: LIMITS.pendingMax });
  if (slot && !slot.reserved) return err('待审投稿已满，过几天再投稿', 429);

  // 先准备完整的精确 key 清单，持久化恢复意图后才开始上传媒体。
  const id = crypto.randomUUID();
  const stored = [];
  const uploads = [];
  for (let i = 0; i < images.length; i++) {
    const im = images[i];
    const key = `community/img/${id}/${i + 1}.${im.ext}`;
    uploads.push({ key, body: im.buf, httpMetadata: {
      contentType: CONTENT_TYPES[im.ext], cacheControl: 'public, max-age=31536000, immutable',
    } });
    const record = { key };
    if (im.origBuf) {
      const origKey = `community/img/${id}/${i + 1}.orig.${im.origExt}`;
      uploads.push({ key: origKey, body: im.origBuf, httpMetadata: {
        contentType: CONTENT_TYPES[im.origExt], cacheControl: 'public, max-age=31536000, immutable',
      } });
      record.origKey = origKey;
    }
    if (im.width && im.height) { record.width = im.width; record.height = im.height; }
    if (im.params) record.params = im.params;
    stored.push(record);
  }

  const record = {
    id, title, prompt, negative, comment, tags, category, nsfw, submitter,
    images: stored, createdAt: Date.now(),
  };
  await storeSubmission(env, { id, record, uploads, slot });

  return json({ ok: true, id }, 201);
}
