'use strict';

// 投稿字段上限（前后端一致）
export const LIMITS = {
  title: 60,
  prompt: 2000,
  negative: 2000,
  comment: 500,
  submitter: 20,
  category: 60,
  tagLen: 30,
  tagCount: 8,
  imageCount: 6,
  imageBytes: 3 * 1024 * 1024,
  origBytes: 10 * 1024 * 1024,
  totalBytes: 60 * 1024 * 1024,
  pendingMax: 300,
};

// 原图生成参数标注：source=生成器，via=读取途径，verified=是否服务端亲自解析确认
// （text/exif 服务端可低成本复验=true；stealth 需全图像素解码，Workers CPU 配额跑不动，
//   只能记录客户端读取结果=false，审核后台会用同一套解析在浏览器里自动复检）
export const PARAMS_VIAS = ['text', 'exif', 'stealth'];

export function normImageParams(v) {
  if (!v || typeof v !== 'object') return null;
  const source = cleanLine(v.source, 20);
  const via = PARAMS_VIAS.includes(v.via) ? v.via : '';
  if (!source || !via) return null;
  return { source, via, verified: !!v.verified };
}

function clampDim(v) {
  const n = Math.floor(Number(v || 0));
  return Number.isFinite(n) && n > 0 && n <= 20000 ? n : 0;
}

export function normCommunityImage(im) {
  if (!im || typeof im !== 'object') return null;
  const out = {};
  if (im.key) out.key = String(im.key);
  if (im.file) out.file = String(im.file);
  if (!out.key && !out.file) return null;
  if (im.origKey) out.origKey = String(im.origKey);
  const width = clampDim(im.width);
  const height = clampDim(im.height);
  if (width && height) { out.width = width; out.height = height; }
  const params = normImageParams(im.params);
  if (params) out.params = params;
  if (IMAGE_LABELS.includes(im.label)) out.label = im.label; // 旧记录兼容
  return out;
}

export const IMAGE_LABELS = ['gallery', 'face', 'scene', 'nsfw'];
export const COMMUNITY_CATEGORIES = ['随手分享', '画风', '人物', '服装', '动作', '构图', '场景'];
export const DEFAULT_COMMUNITY_CATEGORY = '随手分享';
export const COMMUNITY_STATUSES = ['pending', 'approved', 'hidden', 'rejected', 'deleted'];
export const DEFAULT_COMMUNITY_STATUS = 'pending';

const CATEGORY_ALIASES = new Map([
  ['画风', '画风'],
  ['style', '画风'],
  ['人物', '人物'],
  ['面部', '人物'],
  ['角色', '人物'],
  ['face', '人物'],
  ['服装', '服装'],
  ['穿搭', '服装'],
  ['衣服', '服装'],
  ['outfit', '服装'],
  ['clothing', '服装'],
  ['动作', '动作'],
  ['pose', '动作'],
  ['构图', '构图'],
  ['composition', '构图'],
  ['场景', '场景'],
  ['背景', '场景'],
  ['环境', '场景'],
  ['scene', '场景'],
  ['background', '场景'],
  ['environment', '场景'],
  ['随手分享', '随手分享'],
  ['gallery', '随手分享'],
  ['其他', '随手分享'],
]);

const ABS_URL_RE = /^(?:https?:)?\/\//i;
const HOST_PATH_RE = /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/|$)/i;

// 社区专用 R2 桶的公开访问地址，来自 Pages 环境变量 STRINGS_PUBLIC_BASE
// （线上=新桶的 https://pub-….r2.dev 地址；本地 wrangler dev 在 .dev.vars 设为 /r2，经 functions/r2/ 代理读本地模拟桶）
export function publicBase(env) {
  const raw = String(env.STRINGS_PUBLIC_BASE || '').trim().replace(/\/+$/, '');
  if (!raw || raw.startsWith('/') || /^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return 'https:' + raw;
  return 'https://' + raw;
}

// 存储相关配置齐全则返回 null，否则返回应直接回给客户端的错误 Response
export function requireStorage(env) {
  if (!env.STRINGS_BUCKET) return err('服务端未绑定存储桶 STRINGS_BUCKET（见配置指南第 3 步）', 503);
  if (!publicBase(env)) return err('服务端未配置 STRINGS_PUBLIC_BASE（新存储桶的公开地址，见配置指南第 4 步）', 503);
  return null;
}

export function imageUrl(env, key) {
  return publicBase(env) + '/' + String(key).split('/').map(encodeURIComponent).join('/');
}

export function normalizeImageFile(file) {
  const s = String(file == null ? '' : file).trim();
  if (!s || ABS_URL_RE.test(s) || s.startsWith('/') || s.startsWith('data:')) return s;
  if (HOST_PATH_RE.test(s)) return 'https://' + s;
  return s;
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function err(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

async function digestAdminToken(value) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
}

function equalAdminTokenDigests(left, right) {
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(left, right);
  }
  // Node.js 的 WebCrypto 测试环境暂未实现 Workers 的 timingSafeEqual 扩展。
  // 两侧已固定为 SHA-256 的 32 字节摘要，回退循环不会泄露原口令长度。
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] || 0) ^ (b[i] || 0);
  }
  return diff === 0;
}

// 管理接口口令校验；通过返回 null，失败返回应直接回给客户端的 Response
export async function requireAdmin(context) {
  const token = String(context.env.ADMIN_TOKEN || '').trim();
  if (!token) return err('服务端未配置 ADMIN_TOKEN（见配置指南）', 503);
  const auth = context.request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return err('管理口令错误或未提供', 401);
  const [providedDigest, expectedDigest] = await Promise.all([
    digestAdminToken(m[1].trim()),
    digestAdminToken(token),
  ]);
  if (!equalAdminTokenDigests(providedDigest, expectedDigest)) {
    return err('管理口令错误或未提供', 401);
  }
  return null;
}

export function validId(id) {
  return /^[0-9a-fA-F-]{8,40}$/.test(id);
}

export function normCommunityStatus(v, fallback = DEFAULT_COMMUNITY_STATUS) {
  const status = cleanLine(v, 20);
  return COMMUNITY_STATUSES.includes(status) ? status : fallback;
}

/* ---- 字段清洗（投稿与审核编辑共用） ---- */
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function cleanLine(v, max) {
  return String(v == null ? '' : v).replace(CTRL_RE, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function cleanText(v, max) {
  return String(v == null ? '' : v).replace(CTRL_RE, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

export function normTags(v) {
  const arr = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,，]/);
  const out = [];
  for (const t of arr) {
    const s = cleanLine(t, LIMITS.tagLen);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= LIMITS.tagCount) break;
  }
  return out;
}

export function normCategoryName(v) {
  const s = cleanLine(v, LIMITS.category);
  if (!s) return DEFAULT_COMMUNITY_CATEGORY;
  if (COMMUNITY_CATEGORIES.includes(s)) return s;
  const key = s.toLowerCase().replace(/\s+/g, '');
  return CATEGORY_ALIASES.get(key) || DEFAULT_COMMUNITY_CATEGORY;
}

export function normCategory(v) {
  const raw = Array.isArray(v) ? v[0] : String(v == null ? '' : v).split('/')[0];
  return [normCategoryName(raw)];
}

export function communityCategoriesFromEntries(entries) {
  const used = new Set((entries || []).map(e => normCategory(e && e.category)[0]));
  return COMMUNITY_CATEGORIES.filter(c => used.has(c));
}

export function defaultSubmissionTitle({ title, category, prompt } = {}) {
  const given = cleanLine(title, LIMITS.title);
  if (given) return given;
  if (category != null && (!Array.isArray(category) || category.length)) {
    const cat = normCategoryName(Array.isArray(category) ? category[0] : category);
    return cat.endsWith('分享') ? cat : `${cat}分享`;
  }
  const promptHead = cleanLine(String(prompt || '').replace(/[{}[\](),，]+/g, ' '), 18);
  return promptHead || DEFAULT_COMMUNITY_CATEGORY;
}

export function normalizeCommunityRecord(record, status = DEFAULT_COMMUNITY_STATUS, now = Date.now()) {
  const rec = record && typeof record === 'object' ? { ...record } : {};
  rec.id = String(rec.id || '');
  rec.status = normCommunityStatus(status, normCommunityStatus(rec.status));
  rec.title = defaultSubmissionTitle({ title: rec.title, category: rec.category, prompt: rec.prompt });
  rec.prompt = cleanText(rec.prompt, LIMITS.prompt);
  rec.negative = cleanText(rec.negative, LIMITS.negative);
  rec.comment = cleanText(rec.comment, LIMITS.comment);
  rec.submitter = cleanLine(rec.submitter, LIMITS.submitter);
  rec.tags = normTags(rec.tags);
  rec.category = normCategory(rec.category);
  rec.nsfw = !!rec.nsfw;
  rec.images = Array.isArray(rec.images) ? rec.images.map(normCommunityImage).filter(Boolean) : [];
  rec.createdAt = Number(rec.createdAt || now);
  rec.updatedAt = Number(rec.updatedAt || rec.createdAt || now);
  rec.reviewedAt = Number(rec.reviewedAt || 0);
  rec.publishedAt = Number(rec.publishedAt || 0);
  rec.hiddenAt = Number(rec.hiddenAt || 0);
  rec.deletedAt = Number(rec.deletedAt || 0);
  rec.coverIndex = clampIndex(rec.coverIndex, rec.images.length);
  rec.adminNote = cleanText(rec.adminNote, LIMITS.comment);
  return rec;
}

export function applyCommunityEdits(record, edits = {}, now = Date.now()) {
  const rec = normalizeCommunityRecord(record, record && record.status, now);
  const e = edits && typeof edits === 'object' ? edits : {};
  const has = name => Object.prototype.hasOwnProperty.call(e, name);
  const titleInput = has('title') ? e.title : rec.title;
  if (has('prompt')) rec.prompt = cleanText(e.prompt, LIMITS.prompt);
  if (has('negative')) rec.negative = cleanText(e.negative, LIMITS.negative);
  if (has('comment')) rec.comment = cleanText(e.comment, LIMITS.comment);
  if (has('submitter')) rec.submitter = cleanLine(e.submitter, LIMITS.submitter);
  if (has('tags')) rec.tags = normTags(e.tags);
  if (has('category')) rec.category = normCategory(e.category);
  if (has('nsfw')) rec.nsfw = !!e.nsfw;
  if (has('coverIndex')) rec.coverIndex = clampIndex(e.coverIndex, rec.images.length);
  if (has('adminNote')) rec.adminNote = cleanText(e.adminNote, LIMITS.comment);
  if (!rec.prompt) return { error: 'Prompt 不能为空' };
  rec.title = defaultSubmissionTitle({ title: titleInput, category: rec.category, prompt: rec.prompt });
  rec.updatedAt = now;
  return { record: rec };
}

function clampIndex(value, length) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0 || !length) return 0;
  return Math.min(Math.floor(n), Math.max(0, length - 1));
}

/* ---- R2 辅助 ---- */
export async function readJson(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return null;
  try { return await obj.json(); } catch { return null; }
}

export async function listAll(bucket, prefix) {
  const keys = [];
  let cursor;
  do {
    const res = await bucket.list({ prefix, cursor });
    for (const o of res.objects) keys.push(o.key);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return keys;
}

export async function readJsonBatch(bucket, keys) {
  const out = [];
  const BATCH = 20;
  for (let i = 0; i < keys.length; i += BATCH) {
    const part = await Promise.all(keys.slice(i, i + BATCH).map(k => readJson(bucket, k)));
    for (const r of part) if (r) out.push(r);
  }
  return out;
}

export async function deleteImages(env, id) {
  const keys = await listAll(env.STRINGS_BUCKET, `community/img/${id}/`);
  if (keys.length) await env.STRINGS_BUCKET.delete(keys);
}

export function communityRecordKey(status, id) {
  return `community/${normCommunityStatus(status)}/${id}.json`;
}

export async function readCommunityRecord(env, status, id) {
  if (!validId(id)) return null;
  const rec = await readJson(env.STRINGS_BUCKET, communityRecordKey(status, id));
  return rec ? normalizeCommunityRecord(rec, status) : null;
}

export async function findCommunityRecord(env, id, statuses = COMMUNITY_STATUSES) {
  if (!validId(id)) return null;
  const search = (Array.isArray(statuses) ? statuses : [statuses])
    .map(s => normCommunityStatus(s, ''))
    .filter(Boolean);
  for (const status of search) {
    const key = communityRecordKey(status, id);
    const rec = await readJson(env.STRINGS_BUCKET, key);
    if (rec) return { status, key, record: normalizeCommunityRecord(rec, status) };
  }
  return null;
}

export async function writeCommunityRecord(env, status, record) {
  const rec = normalizeCommunityRecord(record, status);
  rec.status = normCommunityStatus(status);
  await env.STRINGS_BUCKET.put(communityRecordKey(rec.status, rec.id), JSON.stringify(rec), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  return rec;
}

export async function moveCommunityRecord(env, found, nextStatus, updates = {}) {
  const now = updates.now || Date.now();
  const status = normCommunityStatus(nextStatus);
  const fromStatus = found.status;
  const rec = normalizeCommunityRecord({ ...found.record, ...(updates.fields || {}) }, status, now);
  rec.status = status;
  rec.updatedAt = now;
  if (status === 'approved') {
    rec.publishedAt = now;
    rec.hiddenAt = 0;
    rec.deletedAt = 0;
  } else if (status === 'hidden') {
    rec.hiddenAt = now;
  } else if (status === 'deleted') {
    rec.deletedAt = now;
    rec.previousStatus = fromStatus;
  } else if (status === 'rejected') {
    rec.rejectedAt = now;
  }
  const nextKey = communityRecordKey(status, rec.id);
  await writeCommunityRecord(env, status, rec);
  if (fromStatus !== status) {
    try {
      await env.STRINGS_BUCKET.delete(found.key);
    } catch {
      try {
        await env.STRINGS_BUCKET.delete(found.key);
      } catch (error) {
        console.error(JSON.stringify({
          event: 'community_record_move_delete_failed',
          id: rec.id,
          fromKey: found.key,
          toKey: nextKey,
          error: error instanceof Error ? error.message : String(error),
        }));
        throw error;
      }
    }
  }
  // 旧调用方默认仍立即刷新公开聚合；统一管理 API 的批量操作可显式延迟，
  // 待整批记录写完后只重建一次。
  if ((fromStatus === 'approved' || status === 'approved') && updates.rebuild !== false) {
    await rebuildCommunity(env);
  }
  return rec;
}

/* ---- 投稿记录 -> 前端 entry（图片转绝对 URL，结构对齐 strings.js） ---- */
export function toEntry(env, rec) {
  return {
    id: rec.id,
    title: rec.title || '',
    prompt: rec.prompt || '',
    negative: rec.negative || '',
    comment: rec.comment || '',
    tags: Array.isArray(rec.tags) ? rec.tags : [],
    category: normCategory(rec.category),
    nsfw: !!rec.nsfw,
    submitter: rec.submitter || '',
    createdAt: rec.createdAt || 0,
    coverIndex: Number(rec.coverIndex || 0),
    images: (rec.images || []).map(im => {
      const key = String(im && im.key || '');
      const image = { file: key ? imageUrl(env, key) : normalizeImageFile(im && im.file) };
      if (im.origKey) image.original = imageUrl(env, im.origKey);
      if (im.width && im.height) { image.width = im.width; image.height = im.height; }
      if (im.params) image.params = im.params;
      if (IMAGE_LABELS.includes(im.label)) image.label = im.label;
      return image;
    }),
  };
}

export function toAdminEntry(env, rec, status = rec && rec.status) {
  const item = normalizeCommunityRecord(rec, status);
  return {
    ...item,
    images: (item.images || []).map((im, index) => {
      const key = String(im && im.key || '');
      return {
        key,
        file: key ? imageUrl(env, key) : normalizeImageFile(im && im.file),
        origKey: String(im && im.origKey || ''),
        original: im && im.origKey ? imageUrl(env, im.origKey) : '',
        width: Number(im && im.width || 0),
        height: Number(im && im.height || 0),
        params: im && im.params ? im.params : null,
        label: String(im && im.label || ''),
        index,
      };
    }),
  };
}

export function emptyCollection() {
  return { title: '共创广场', author: '', categories: [], entries: [], imagedCount: 0 };
}

// 重新生成聚合发布文件 community/community.json（每次通过/下架后调用）
export async function rebuildCommunity(env) {
  const bucket = env.STRINGS_BUCKET;
  const keys = (await listAll(bucket, 'community/approved/')).filter(k => k.endsWith('.json'));
  const rebuildLog = {
    event: 'community_rebuild',
    approvedCount: keys.length,
    readBatches: Math.ceil(keys.length / 20),
  };
  if (keys.length >= 900) {
    console.warn(JSON.stringify({ ...rebuildLog, risk: 'internal_subrequest_limit' }));
  } else {
    console.log(JSON.stringify(rebuildLog));
  }
  const records = await readJsonBatch(bucket, keys);
  records.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const entries = records.map(r => toEntry(env, r));
  const categories = communityCategoriesFromEntries(entries);
  const data = {
    ...emptyCollection(),
    categories,
    entries,
    imagedCount: entries.filter(e => e.images.length).length,
    generatedAt: Date.now(),
  };
  await bucket.put('community/community.json', JSON.stringify(data), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  return data;
}
