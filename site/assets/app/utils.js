export const $ = (s, r = document) => r.querySelector(s);

export function safeJsonParse(raw, fallback) {
  try {
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function stripTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

export function safeHttpUrl(value) {
  const url = String(value || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

export function samePath(a, b) {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

export function pathStartsWith(path, prefix) {
  return prefix.length <= path.length && prefix.every((seg, i) => seg === path[i]);
}

export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* 触点数量只说明设备带触屏，不代表当前主输入是触屏（例如 Windows 触屏本）。
   浏览器能回答输入媒体特征时以它为准；只有 API 缺失/不可用时才退回 maxTouchPoints。 */
export function isTouchPrimaryInput({
  navigatorApi = globalThis.navigator,
  matchMediaApi = globalThis.window?.matchMedia?.bind(globalThis.window)
    || globalThis.matchMedia?.bind(globalThis),
} = {}) {
  if (typeof matchMediaApi === 'function') {
    try {
      return Boolean(matchMediaApi('(hover: none), (pointer: coarse)')?.matches);
    } catch {
      // 受限 WebView 可能暴露但拒绝 matchMedia；按 API 不可用处理。
    }
  }
  return Number(navigatorApi?.maxTouchPoints || 0) > 0;
}

export function updateSearchClear() {
  const btn = $('#searchClear');
  const input = $('#search');
  if (btn && input) btn.hidden = !input.value;
}

export function updateScrollProgress() {
  const bar = $('#scrollProgress');
  if (!bar) return;
  const root = document.documentElement;
  const max = Math.max(0, root.scrollHeight - window.innerHeight);
  const progress = max ? clamp(window.scrollY / max, 0, 1) : 0;
  bar.style.transform = `scaleX(${progress})`;
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* 只做到「天」的粒度：更新是按批次发的，精确到小时既不真实也没有意义。
   接受 ISO 日期串（2026-09-19）或已解析的本地时间戳，两种批次口径共用一套措辞。 */
export function relativeDay(value) {
  const ts = typeof value === 'number' ? value : Date.parse(`${value}T00:00:00`);
  if (!Number.isFinite(ts)) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - ts) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}
