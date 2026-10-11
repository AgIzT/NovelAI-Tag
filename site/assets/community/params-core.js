// 图片生成参数识别核心（纯逻辑，无 DOM）：浏览器投稿页 / 审核后台 / Pages Functions 共用。
// 识别面 = Akegarasu/stable-diffusion-inspector 的超集：
//   1. PNG 文本块 tEXt / zTXt / iTXt（含 deflate 压缩变体）+ eXIf 块
//   2. JPEG / WebP 的 EXIF UserComment（webui 保存 jpg/webp 时参数所在）
//   3. 隐写通道 LSB 全部 4 变体：stealth_pnginfo / stealth_pngcomp（alpha）
//      + stealth_rgbinfo / stealth_rgbcomp（RGB），gzip 与未压缩均支持
// 字段映射：NovelAI（Comment JSON / v4 caption / Description）→ SD-WEBUI（parameters）→ ComfyUI（prompt/workflow 仅识别不填表）。
// 口径对齐 tools/sd_metadata_inspector.py；改这里时同步检查该脚本。

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function sniffImageKind(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 8 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return 'png';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  return null;
}

function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

/* 解压上限：投稿接口在服务端对匿名上传的原图跑这套解析，压缩文本块解压后的大小不受上传体积约束，
   不设上限时一张小图就能要求很大的内存。真实生成参数（含 ComfyUI workflow）远小于这个量级；
   超限的块整块跳过（截断的 JSON 没有用），不影响同图其它块。tools/sd_metadata_inspector.py 只读本机文件，不需要同步。 */
export const PARAMS_INFLATE_LIMITS = Object.freeze({
  chunkBytes: 4 * 1024 * 1024,   // 单个压缩块解压后的上限
  totalBytes: 8 * 1024 * 1024,   // 一张图所有压缩块解压后的合计上限
});

// DecompressionStream 老浏览器可能没有：缺失时压缩块静默跳过（tEXt/未压缩 iTXt 仍可用）
// 边读边计数，超过上限立刻取消流并返回 null；budget 由同一张图的各块共用。
async function inflateBytes(bytes, format, budget = null) {
  if (typeof DecompressionStream !== 'function') return null;
  const limit = Math.min(PARAMS_INFLATE_LIMITS.chunkBytes, budget ? budget.remaining : Infinity);
  try {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
    const parts = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
    if (budget) budget.remaining -= size;
    const out = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  } catch {
    return null;
  }
}

/* ---- PNG ---- */

export function readPngSize(buffer) {
  const raw = new Uint8Array(buffer);
  if (raw.length < 26 || sniffImageKind(raw) !== 'png') return null;
  const view = new DataView(buffer instanceof ArrayBuffer ? buffer : raw.buffer, raw.byteOffset);
  if (String.fromCharCode(raw[12], raw[13], raw[14], raw[15]) !== 'IHDR') return null;
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (!(width > 0 && height > 0)) return null;
  return { width, height, bitDepth: raw[24], colorType: raw[25] };
}

function parseTextChunk(data) {
  const sep = data.indexOf(0);
  if (sep < 0) return null;
  return { keyword: decodeText(data.subarray(0, sep)), text: decodeText(data.subarray(sep + 1)) };
}

async function parseZtxtChunk(data, budget) {
  const sep = data.indexOf(0);
  if (sep < 0 || sep + 2 > data.length) return null;
  const inflated = await inflateBytes(data.subarray(sep + 2), 'deflate', budget);
  if (!inflated) return null;
  return { keyword: decodeText(data.subarray(0, sep)), text: decodeText(inflated) };
}

async function parseItxtChunk(data, budget) {
  const firstSep = data.indexOf(0);
  if (firstSep < 0 || firstSep + 3 > data.length) return null;
  const keyword = decodeText(data.subarray(0, firstSep));
  const compressed = data[firstSep + 1] === 1;
  let offset = firstSep + 3;
  const langSep = data.indexOf(0, offset);
  if (langSep < 0) return null;
  offset = langSep + 1;
  const translatedSep = data.indexOf(0, offset);
  if (translatedSep < 0) return null;
  offset = translatedSep + 1;
  const payload = data.subarray(offset);
  if (!compressed) return { keyword, text: decodeText(payload) };
  const inflated = await inflateBytes(payload, 'deflate', budget);
  if (!inflated) return null;
  return { keyword, text: decodeText(inflated) };
}

// 返回 [{type, keyword, text}]，另把 eXIf 块的 UserComment 以 keyword 'parameters' 混入（若文本块里没有）
export async function readPngTextChunks(buffer) {
  const raw = new Uint8Array(buffer);
  if (sniffImageKind(raw) !== 'png') return [];
  const view = new DataView(buffer instanceof ArrayBuffer ? buffer : raw.buffer, raw.byteOffset);
  const chunks = [];
  const inflateBudget = { remaining: PARAMS_INFLATE_LIMITS.totalBytes };
  let exifData = null;
  let offset = 8;

  while (offset + 12 <= raw.length) {
    const size = view.getUint32(offset, false);
    const type = String.fromCharCode(raw[offset + 4], raw[offset + 5], raw[offset + 6], raw[offset + 7]);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd + 4 > raw.length) break;

    const data = raw.subarray(dataStart, dataEnd);
    let parsed = null;
    if (type === 'tEXt') parsed = parseTextChunk(data);
    else if (type === 'zTXt') parsed = await parseZtxtChunk(data, inflateBudget);
    else if (type === 'iTXt') parsed = await parseItxtChunk(data, inflateBudget);
    else if (type === 'eXIf') exifData = data;
    if (parsed?.keyword) chunks.push({ type, ...parsed });

    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }

  if (exifData && !chunks.some(c => c.keyword === 'parameters')) {
    const comment = userCommentFromTiff(exifData);
    if (comment) chunks.push({ type: 'eXIf', keyword: 'parameters', text: comment });
  }
  return chunks;
}

/* ---- EXIF（JPEG APP1 / WebP EXIF 块 / PNG eXIf 共用 TIFF 解析） ---- */

function decodeUserComment(bytes) {
  if (bytes.length <= 8) return '';
  const prefix = String.fromCharCode(...bytes.subarray(0, 8)).replace(/\0+$/, '');
  const body = bytes.subarray(8);
  if (prefix === 'UNICODE') {
    // BOM 优先；无 BOM 按零字节分布判断 UTF-16 大小端（piexif 写 BE，Windows 写 LE）
    if (body[0] === 0xff && body[1] === 0xfe) return new TextDecoder('utf-16le').decode(body.subarray(2));
    if (body[0] === 0xfe && body[1] === 0xff) return new TextDecoder('utf-16be').decode(body.subarray(2));
    let evenZero = 0;
    let oddZero = 0;
    for (let i = 0; i + 1 < body.length; i += 2) {
      if (body[i] === 0) evenZero++;
      if (body[i + 1] === 0) oddZero++;
    }
    const utf16 = evenZero > oddZero
      ? new TextDecoder('utf-16be').decode(body)
      : new TextDecoder('utf-16le').decode(body);
    return utf16.replace(/\0+/g, '');
  }
  return decodeText(body).replace(/\0+/g, '');
}

function userCommentFromTiff(tiff) {
  try {
    if (tiff.length >= 6 && String.fromCharCode(...tiff.subarray(0, 4)) === 'Exif') tiff = tiff.subarray(6);
    if (tiff.length < 8) return null;
    const little = tiff[0] === 0x49 && tiff[1] === 0x49;
    if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    if (view.getUint16(2, little) !== 42) return null;

    const readIfd = start => {
      const entries = new Map();
      if (start + 2 > tiff.length) return entries;
      const count = view.getUint16(start, little);
      for (let i = 0; i < count; i++) {
        const at = start + 2 + i * 12;
        if (at + 12 > tiff.length) break;
        const tag = view.getUint16(at, little);
        const type = view.getUint16(at + 2, little);
        const num = view.getUint32(at + 4, little);
        entries.set(tag, { type, count: num, valueAt: at + 8 });
      }
      return entries;
    };
    const entryBytes = entry => {
      const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 7: 1 };
      const size = (sizes[entry.type] || 1) * entry.count;
      const start = size <= 4 ? entry.valueAt : view.getUint32(entry.valueAt, little);
      if (start + size > tiff.length) return null;
      return tiff.subarray(start, start + size);
    };

    const ifd0 = readIfd(view.getUint32(4, little));
    let comment = null;
    const exifPointer = ifd0.get(0x8769);
    if (exifPointer) {
      const exifIfd = readIfd(view.getUint32(exifPointer.valueAt, little));
      const entry = exifIfd.get(0x9286);
      if (entry) comment = entryBytes(entry);
    }
    if (!comment) {
      const entry = ifd0.get(0x9286);
      if (entry) comment = entryBytes(entry);
    }
    if (!comment) return null;
    const text = decodeUserComment(comment).trim();
    return text || null;
  } catch {
    return null;
  }
}

export function readExifUserComment(buffer) {
  const raw = new Uint8Array(buffer);
  const kind = sniffImageKind(raw);
  if (kind === 'jpg') {
    const view = new DataView(buffer instanceof ArrayBuffer ? buffer : raw.buffer, raw.byteOffset);
    let offset = 2;
    while (offset + 4 <= raw.length) {
      if (raw[offset] !== 0xff) break;
      const marker = raw[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      if (marker === 0xda) break; // SOS 之后是压缩数据
      const size = view.getUint16(offset + 2, false);
      if (size < 2 || offset + 2 + size > raw.length) break;
      if (marker === 0xe1) {
        const seg = raw.subarray(offset + 4, offset + 2 + size);
        if (seg.length > 6 && String.fromCharCode(...seg.subarray(0, 4)) === 'Exif') {
          const comment = userCommentFromTiff(seg);
          if (comment) return comment;
        }
      }
      offset += 2 + size;
    }
    return null;
  }
  if (kind === 'webp') {
    const view = new DataView(buffer instanceof ArrayBuffer ? buffer : raw.buffer, raw.byteOffset);
    let offset = 12;
    while (offset + 8 <= raw.length) {
      const fourcc = String.fromCharCode(raw[offset], raw[offset + 1], raw[offset + 2], raw[offset + 3]);
      const size = view.getUint32(offset + 4, true);
      const dataStart = offset + 8;
      if (dataStart + size > raw.length) break;
      if (fourcc === 'EXIF') {
        const comment = userCommentFromTiff(raw.subarray(dataStart, dataStart + size));
        if (comment) return comment;
      }
      offset = dataStart + size + (size % 2);
    }
    return null;
  }
  return null;
}

/* ---- 字段映射（NovelAI / SD-WEBUI / ComfyUI） ---- */

export function splitWebuiParameters(text) {
  const settingsIndex = text.indexOf('Steps: ');
  const promptBlock = settingsIndex >= 0 ? text.slice(0, settingsIndex) : text;
  const marker = 'Negative prompt:';
  const negativeIndex = promptBlock.indexOf(marker);
  if (negativeIndex < 0) return { prompt: promptBlock.trim(), negative: '' };
  return {
    prompt: promptBlock.slice(0, negativeIndex).trim(),
    negative: promptBlock.slice(negativeIndex + marker.length).trim(),
  };
}

function naiV4CaptionText(data, key) {
  const node = data && typeof data === 'object' ? data[key] : null;
  const caption = node && typeof node === 'object' && node.caption && typeof node.caption === 'object' ? node.caption : {};
  const parts = [];
  if (caption.base_caption) parts.push(String(caption.base_caption));
  for (const item of caption.char_captions || []) {
    if (item && typeof item === 'object' && item.char_caption) parts.push(String(item.char_caption));
  }
  return parts.join('\n').trim();
}

function looksLikeComfyGraph(text) {
  if (!text || text[0] !== '{') return false;
  try {
    const graph = JSON.parse(text);
    if (!graph || typeof graph !== 'object') return false;
    if (Array.isArray(graph.nodes)) return true; // workflow 格式
    return Object.values(graph).some(node => node && typeof node === 'object' && node.class_type); // API prompt 格式
  } catch {
    return false;
  }
}

export function paramsFromFields(fields) {
  let prompt = '';
  let negative = '';
  let source = fields.Software || fields.Source || 'PNG';

  if (fields.Comment) {
    try {
      const comment = JSON.parse(fields.Comment);
      prompt = naiV4CaptionText(comment, 'v4_prompt') || String(comment.prompt || '');
      negative = naiV4CaptionText(comment, 'v4_negative_prompt') || String(comment.uc || comment.negative_prompt || '');
      if (fields.Software === 'NovelAI' || prompt || negative) source = 'NovelAI';
    } catch {
      // 普通文本 Comment 不是错误；继续尝试 Description / parameters。
    }
  }

  if (!prompt && fields.Description) {
    prompt = fields.Description;
    if (fields.Software === 'NovelAI' || fields.Source === 'NovelAI' || fields.Comment) source = 'NovelAI';
  }

  if (!prompt && fields.parameters) {
    const webui = splitWebuiParameters(fields.parameters);
    prompt = webui.prompt;
    negative = webui.negative;
    source = 'SD-WEBUI';
  }

  prompt = prompt.trim();
  negative = negative.trim();
  if (prompt || negative) return { prompt, negative, source };
  // ComfyUI：图里有节点图参数但没有可直接填表的 prompt 文本，只识别不填
  if (looksLikeComfyGraph(fields.prompt) || looksLikeComfyGraph(fields.workflow)) {
    return { prompt: '', negative: '', source: 'ComfyUI' };
  }
  return null;
}

export function fieldsFromChunks(chunks) {
  const fields = {};
  for (const chunk of chunks) fields[chunk.keyword] = chunk.text;
  return fields;
}

// 文本块 + EXIF 两条路（隐写要像素，见 readStealthParams，由调用方喂 RGBA）
export async function extractTextParams(buffer) {
  const raw = new Uint8Array(buffer);
  const kind = sniffImageKind(raw);
  if (kind === 'png') {
    const chunks = await readPngTextChunks(buffer);
    if (!chunks.length) return null;
    const result = paramsFromFields(fieldsFromChunks(chunks));
    return result ? { ...result, via: 'text' } : null;
  }
  if (kind === 'jpg' || kind === 'webp') {
    const comment = readExifUserComment(buffer);
    if (!comment) return null;
    const result = paramsFromFields({ parameters: comment });
    return result ? { ...result, via: 'exif' } : null;
  }
  return null;
}

/* ---- 隐写通道（LSB，列优先，4 变体） ----
   规范来自 sd_webui_stealth_pnginfo：magic(15字节) + 数据位长(int32 BE) + 数据；
   alpha 模式读 alpha LSB，rgb 模式依次读 R/G/B LSB；comp 变体 gzip。
   NovelAI 官方原图 = stealth_pngcomp（gzip JSON）。 */

const STEALTH_MAGICS = {
  alpha: { stealth_pnginfo: false, stealth_pngcomp: true },
  rgb: { stealth_rgbinfo: false, stealth_rgbcomp: true },
};

function stealthBitAt(pixels, mode, bitIndex) {
  const { data, width, height } = pixels;
  let pixelIndex;
  let channel;
  if (mode === 'alpha') {
    pixelIndex = bitIndex;
    channel = 3;
  } else {
    pixelIndex = Math.floor(bitIndex / 3);
    channel = bitIndex % 3;
  }
  // 列优先：第 i 个像素 = (x=i/height, y=i%height)
  const x = Math.floor(pixelIndex / height);
  const y = pixelIndex % height;
  return data[(y * width + x) * 4 + channel] & 1;
}

function stealthReadBytes(pixels, mode, bitOffset, byteCount) {
  const out = new Uint8Array(byteCount);
  for (let i = 0; i < byteCount; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | stealthBitAt(pixels, mode, bitOffset + i * 8 + b);
    out[i] = byte;
  }
  return out;
}

// pixels = {data: RGBA 字节数组, width, height}（ImageData 或等价结构）
export function readStealthPayload(pixels) {
  if (!pixels || !pixels.data || !(pixels.width > 0 && pixels.height > 0)) return null;
  const magicLen = 15;
  for (const mode of ['alpha', 'rgb']) {
    const totalBits = mode === 'alpha' ? pixels.width * pixels.height : pixels.width * pixels.height * 3;
    if (totalBits < (magicLen + 4) * 8) continue;
    const magic = decodeText(stealthReadBytes(pixels, mode, 0, magicLen));
    if (!(magic in STEALTH_MAGICS[mode])) continue;
    const lenBytes = stealthReadBytes(pixels, mode, magicLen * 8, 4);
    const bitLength = ((lenBytes[0] << 24) | (lenBytes[1] << 16) | (lenBytes[2] << 8) | lenBytes[3]) >>> 0;
    const dataOffset = (magicLen + 4) * 8;
    if (!(bitLength > 0) || bitLength > totalBits - dataOffset || bitLength > 64 * 1024 * 1024) return null;
    const bytes = stealthReadBytes(pixels, mode, dataOffset, Math.ceil(bitLength / 8));
    return { magic, mode, compressed: STEALTH_MAGICS[mode][magic], bytes };
  }
  return null;
}

export async function readStealthParams(pixels) {
  const payload = readStealthPayload(pixels);
  if (!payload) return null;
  let bytes = payload.bytes;
  if (payload.compressed) {
    bytes = await inflateBytes(bytes, 'gzip');
    if (!bytes) return null;
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

  // NAI = JSON 字典（Description/Comment/Software…）；webui 隐写扩展 = parameters 文本
  let fields = null;
  if (text[0] === '{') {
    try {
      const json = JSON.parse(text);
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        fields = {};
        for (const [key, value] of Object.entries(json)) {
          fields[key] = typeof value === 'string' ? value : JSON.stringify(value);
        }
      }
    } catch {
      // 落回按 parameters 文本处理
    }
  }
  if (!fields) fields = { parameters: text };
  const result = paramsFromFields(fields);
  return result ? { ...result, via: 'stealth', stealthMagic: payload.magic } : null;
}
