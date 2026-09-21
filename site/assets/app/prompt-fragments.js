import { tagZhKey } from './tag-zh-core.js';

/* 展示片段与可复制片段分开：每个 raw 都含完整的外层权重。
   不猜测调度、交替或损坏语法；不能安全拆开的内容作为一个整体保留。 */
const OPEN = { '{': '}', '[': ']', '(': ')' };
const CLOSE = new Set(Object.values(OPEN));
const NUMBER_OPEN = /^-?(?:\d+(?:\.\d+)?|\.\d+)::/;
const SEPARATOR = /[,，\r\n]/;

function scan(value) {
  const source = String(value ?? '');
  const stack = [];
  const pieces = [];
  let start = 0;
  let invalid = false;
  let nestedNumeric = false;
  let quote = false;
  let boundary = true;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') { i += 1; boundary = false; continue; }
    if (ch === '"') { quote = !quote; boundary = false; continue; }
    if (quote) continue;
    const numeric = boundary ? source.slice(i).match(NUMBER_OPEN) : null;
    if (numeric) {
      if (stack.includes('::')) nestedNumeric = true;
      stack.push('::');
      i += numeric[0].length - 1;
      boundary = true;
      continue;
    }
    if (source.slice(i, i + 2) === '::') {
      if (stack.at(-1) !== '::') invalid = true;
      else stack.pop();
      i += 1;
      boundary = false;
      continue;
    }
    if (OPEN[ch]) { stack.push(OPEN[ch]); boundary = true; continue; }
    if (CLOSE.has(ch)) {
      if (stack.at(-1) !== ch) invalid = true;
      else stack.pop();
      boundary = false;
      continue;
    }
    if (SEPARATOR.test(ch)) {
      if (!stack.length && !invalid) {
        const raw = source.slice(start, i).trim();
        if (raw) pieces.push(raw);
        start = i + 1;
      }
      boundary = true;
    } else if (!/\s/.test(ch)) {
      boundary = false;
    }
  }
  return { pieces, tail: source.slice(start), valid: !invalid && !stack.length && !quote, nestedNumeric };
}

/* 输入框只提交已经结束的顶层片段。未确认尾段和未闭合语法原样保留。 */
export function splitDraft(value) {
  const result = scan(value);
  return { committed: result.pieces, tail: result.tail };
}

/* 找出覆盖整段的单层括号；词名内部的括号不会被当作权重拆开。 */
function outerBracket(raw) {
  const close = OPEN[raw[0]];
  if (!close || raw.at(-1) !== close) return null;
  let depth = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '\\') { i += 1; continue; }
    if (raw[i] === raw[0]) depth += 1;
    if (raw[i] === close) depth -= 1;
    if (!depth && i < raw.length - 1) return null;
  }
  if (depth) return null;
  return { open: raw[0], close, body: raw.slice(1, -1) };
}

function flatten(raw, wrap = text => text, depth = 0) {
  const text = raw.trim();
  if (!text) return [];
  if (depth > 32) return [{ raw: wrap(text), label: text, opaque: true }];
  const scanned = scan(text);
  if (!scanned.valid) return [{ raw: wrap(text), label: text, opaque: true }];
  const parts = [...scanned.pieces, scanned.tail.trim()].filter(Boolean);
  if (!parts.length) return [];
  if (parts.length > 1 || parts[0] !== text) return parts.flatMap(part => flatten(part, wrap, depth + 1));
  if (scanned.nestedNumeric) return [{ raw: wrap(text), label: text, opaque: true }];

  const numeric = text.match(NUMBER_OPEN);
  if (numeric && text.endsWith('::')) {
    const body = text.slice(numeric[0].length, -2);
    if (body.trim() && scan(body).valid) return flatten(body, part => wrap(`${numeric[0]}${part}::`), depth + 1);
  }
  const bracket = outerBracket(text);
  if (bracket) {
    let body = bracket.body;
    let suffix = '';
    if (bracket.open === '(') {
      const weight = body.match(/:\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*$/);
      if (weight) { suffix = weight[0]; body = body.slice(0, -suffix.length); }
    }
    // 冒号调度与竖线交替的含义依赖整组，选择时保持原样。
    if (body.trim() && !/[|:]/.test(body.replace(/-?(?:\d+(?:\.\d+)?|\.\d+)::|::/g, ''))) {
      return flatten(body, part => wrap(`${bracket.open}${part}${suffix}${bracket.close}`), depth + 1);
    }
  }
  const opaque = /[{}\[\]()|]/.test(text) || text.includes('::') || text.includes('"');
  return [{ raw: wrap(text), label: text, opaque }];
}

export function tokenizePrompt(value) {
  return flatten(String(value ?? '')).map((piece, index) => ({
    ...piece,
    id: `p${index}`,
    key: piece.opaque ? '' : tagZhKey(piece.label),
    negative: !piece.opaque && /-(?:\d+(?:\.\d+)?|\.\d+)::/.test(piece.raw),
  }));
}

export function serializeSelection(value, ids) {
  const source = String(value ?? '');
  const pieces = tokenizePrompt(source);
  const selected = new Set(ids || []);
  const picked = pieces.filter(piece => selected.has(piece.id));
  if (picked.length === pieces.length && picked.length) return source;
  return picked.map(piece => piece.raw).join(', ');
}
