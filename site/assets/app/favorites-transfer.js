export const FAVORITES_TRANSFER_PREFIX = 'NAITAG1.';
export const FAVORITES_TRANSFER_MAX_BYTES = 2 * 1024 * 1024;
export const FAVORITES_TRANSFER_MAX_COMPRESSED_BYTES = FAVORITES_TRANSFER_MAX_BYTES + 64 * 1024;

function transferError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  const size = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += size) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + size));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value, maxBytes = FAVORITES_TRANSFER_MAX_COMPRESSED_BYTES) {
  const compact = String(value || '').replace(/\s+/g, '');
  if (compact.length > Math.ceil(maxBytes * 4 / 3) + 4) {
    throw transferError('TRANSFER_TOO_LARGE', '迁移文本压缩数据超过大小限制');
  }
  if (!compact || !/^[A-Za-z0-9_-]+$/.test(compact)) {
    throw transferError('INVALID_TRANSFER_TEXT', '迁移文本编码无效');
  }
  const padded = compact.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(compact.length / 4) * 4, '=');
  let binary;
  try {
    binary = atob(padded);
  } catch (cause) {
    throw transferError('INVALID_TRANSFER_TEXT', `迁移文本编码无效：${cause?.message || 'base64'}`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  if (bytes.byteLength > maxBytes) {
    throw transferError('TRANSFER_TOO_LARGE', '迁移文本压缩数据超过大小限制');
  }
  return bytes;
}

async function streamBytes(stream, maxBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw transferError('TRANSFER_TOO_LARGE', '迁移文本解压后超过 2 MiB');
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function encodeFavoritesTransfer(json, {
  CompressionStream: Compression = globalThis.CompressionStream,
} = {}) {
  const source = String(json || '').trim();
  const input = new TextEncoder().encode(source);
  if (input.byteLength > FAVORITES_TRANSFER_MAX_BYTES) {
    throw transferError('TRANSFER_TOO_LARGE', '收藏数据超过文本迁移的 2 MiB 上限，请改用 JSON 文件');
  }
  if (!Compression) return source;
  const compressed = new Blob([input]).stream().pipeThrough(new Compression('gzip'));
  const bytes = await streamBytes(compressed, FAVORITES_TRANSFER_MAX_COMPRESSED_BYTES);
  return `${FAVORITES_TRANSFER_PREFIX}${bytesToBase64Url(bytes)}`;
}

export async function decodeFavoritesTransfer(text, {
  DecompressionStream: Decompression = globalThis.DecompressionStream,
  maxBytes = FAVORITES_TRANSFER_MAX_BYTES,
} = {}) {
  const source = String(text || '').trim();
  if (!source.startsWith(FAVORITES_TRANSFER_PREFIX)) {
    if (new TextEncoder().encode(source).byteLength > maxBytes) {
      throw transferError('TRANSFER_TOO_LARGE', '收藏数据超过文本迁移的 2 MiB 上限，请改用 JSON 文件');
    }
    return source;
  }
  if (!Decompression) {
    throw transferError('DECOMPRESSION_UNSUPPORTED', '当前浏览器不能解压迁移文本，请改用 JSON 文件');
  }
  const compressed = base64UrlToBytes(
    source.slice(FAVORITES_TRANSFER_PREFIX.length),
    FAVORITES_TRANSFER_MAX_COMPRESSED_BYTES,
  );
  let stream;
  try {
    stream = new Blob([compressed]).stream().pipeThrough(new Decompression('gzip'));
    const bytes = await streamBytes(stream, maxBytes);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  } catch (error) {
    if (error?.code) throw error;
    throw transferError('INVALID_TRANSFER_TEXT', '迁移文本损坏或不完整');
  }
}
