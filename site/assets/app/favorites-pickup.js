// 收藏取件码：把 NAITAG1. 迁移文本暂存到服务端 10 分钟，换一个 8 位短码。
// 规则的服务端真相在 functions/_pickup.js；这里只做输入整理与错误翻译。
export const PICKUP_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const PICKUP_MAX_PAYLOAD_CHARS = 1_000_000;

const CODE_RE = new RegExp(`^[${PICKUP_CODE_ALPHABET}]{8}$`);
const CREATE_URL = '/api/favorites-pickup';
const REDEEM_URL = '/api/favorites-pickup/redeem';

function pickupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// 不区分大小写，空格与横线可有可无；不合法返回空串。
export function normalizePickupCode(value) {
  const code = String(value == null ? '' : value).toUpperCase().replace(/[\s-]+/g, '');
  return CODE_RE.test(code) ? code : '';
}

export function formatPickupCode(code) {
  const normalized = normalizePickupCode(code);
  return normalized ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : '';
}

// 404 只在取件时代表码失效；生成时说明接口不存在，按不可用处理。
function statusMessage(status, fallback, action) {
  if (status === 404 && action === 'redeem') return '取件码无效、已过期或已被取用。';
  if (status === 404) return '取件码暂不可用，请改用迁移文本或 JSON 文件。';
  if (status === 413) return '收藏数据太大，无法用取件码搬运，请改用 JSON 文件。';
  if (status === 429) return '操作太频繁，请过几分钟再试。';
  if (status === 503) return '取件码暂不可用，请改用迁移文本或 JSON 文件。';
  return fallback || '取件码请求失败，请稍后再试。';
}

async function postJson(url, body, fetchImpl, action) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    throw pickupError('PICKUP_NETWORK', '网络连接失败，请检查网络后重试。');
  }
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok || !data?.ok) {
    const serverMessage = response.status === 400 && data?.error ? `${data.error}。` : '';
    throw pickupError(`PICKUP_HTTP_${response.status}`, statusMessage(response.status, serverMessage, action));
  }
  return data;
}

export async function createPickup(transferText, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const payload = String(transferText || '');
  if (!payload.startsWith('NAITAG1.')) {
    throw pickupError('PICKUP_UNSUPPORTED', '当前浏览器不能压缩收藏数据，请改用 JSON 文件。');
  }
  if (payload.length > PICKUP_MAX_PAYLOAD_CHARS) {
    throw pickupError('PICKUP_TOO_LARGE', statusMessage(413));
  }
  const data = await postJson(CREATE_URL, { payload }, fetchImpl, 'create');
  const code = formatPickupCode(data.code);
  const expiresAt = Number(data.expiresAt);
  if (!code || !Number.isFinite(expiresAt)) throw pickupError('PICKUP_BAD_RESPONSE', statusMessage(0));
  return { code, expiresAt };
}

export async function redeemPickup(input, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const code = normalizePickupCode(input);
  if (!code) throw pickupError('PICKUP_INVALID_CODE', '取件码应为 8 位字母或数字。');
  const data = await postJson(REDEEM_URL, { code }, fetchImpl, 'redeem');
  if (typeof data.payload !== 'string' || !data.payload) throw pickupError('PICKUP_BAD_RESPONSE', statusMessage(0));
  return { code: formatPickupCode(code), payload: data.payload };
}
