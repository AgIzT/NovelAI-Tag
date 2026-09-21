import { adaptRelayOutput } from './tag-relay-core.js';
import { tokenizePrompt } from './prompt-fragments.js';

export const ZW = '\u200b';
export const OFF_OPEN = `${ZW}~`;
export const OFF_CLOSE = `~${ZW}`;
const OPEN = { '{': '}', '[': ']', '(': ')' };
const CLOSE = new Set(Object.values(OPEN));
const NUM = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)::/;
const SEP = /[,，\r\n]/;
export const scrub = value => String(value ?? '').replace(/[\u200b-\u200f\ufeff]/g, '');

function foldAt(text, at) {
  if (!text.startsWith(`${ZW}#`, at)) return null;
  const end = text.indexOf(ZW, at + 2);
  return end > at + 2 ? { start: at, end: end + 1, name: text.slice(at + 2, end) } : null;
}

function disabledEnd(text, start) {
  if (!text.startsWith(OFF_OPEN, start)) return -1;
  for (let at = start + OFF_OPEN.length; at < text.length; at += 1) {
    const fold = foldAt(text, at);
    if (fold) { at = fold.end - 1; continue; }
    if (text.startsWith(OFF_CLOSE, at)) return at + OFF_CLOSE.length;
  }
  return -1;
}

export function foldRanges(value) {
  const text = String(value ?? ''), ranges = [];
  for (let at = 0; at < text.length; at += 1) {
    const fold = foldAt(text, at);
    if (fold) { ranges.push(fold); at = fold.end - 1; }
  }
  return ranges;
}

/* 和 prompt-fragments 同源；守卫包裹的禁用段、占位符先作为原子跳过。
   名字里的逗号、括号及数字不是正文语法，不得改变扫描栈。 */
function scan(text) {
  const pieces = [], stack = [];
  let start = 0, boundary = true, quote = false, invalid = false, outerEnd = -1;
  for (let at = 0; at < text.length; at += 1) {
    const ch = text[at];
    const fold = foldAt(text, at);
    if (fold) { at = fold.end - 1; boundary = false; continue; }
    if (text.startsWith(OFF_OPEN, at)) {
      const end = disabledEnd(text, at);
      if (end >= 0) { at = end - 1; boundary = false; continue; }
    }
    if (ch === '\\') { at += 1; boundary = false; continue; }
    if (ch === '"') { quote = !quote; boundary = false; continue; }
    if (quote) continue;
    const num = boundary ? NUM.exec(text.slice(at)) : null;
    if (num) { stack.push('::'); at += num[0].length - 1; boundary = true; continue; }
    if (text.startsWith('::', at)) {
      if (stack.at(-1) === '::') {
        stack.pop();
        if (!stack.length && outerEnd < 0) outerEnd = at + 2;
      } else invalid = true;
      at += 1; boundary = false; continue;
    }
    if (OPEN[ch]) { stack.push(OPEN[ch]); boundary = true; continue; }
    if (CLOSE.has(ch)) {
      if (stack.at(-1) === ch) {
        stack.pop();
        if (!stack.length && outerEnd < 0) outerEnd = at + 1;
      } else invalid = true;
      boundary = false; continue;
    }
    if (SEP.test(ch)) {
      if (!stack.length && !invalid) { pieces.push([start, at]); start = at + 1; }
      boundary = true;
    } else if (!/\s/.test(ch)) boundary = false;
  }
  pieces.push([start, text.length]);
  return { pieces, outerEnd, valid: !invalid && !stack.length && !quote };
}

export function segments(value) { return scan(String(value ?? '')).pieces; }

export function analyze(value) {
  let body = String(value ?? ''), off = false, mult = 1, brace = 0;
  if (disabledEnd(body, 0) === body.length) {
    off = true; body = body.slice(OFF_OPEN.length, -OFF_CLOSE.length);
  }
  for (;;) {
    const num = NUM.exec(body), close = OPEN[body[0]];
    if (!num && !['}', ']'].includes(close)) break;
    const scanned = scan(body);
    if (!scanned.valid || scanned.outerEnd !== body.length) break;
    if (num) {
      const weight = Number.parseFloat(num[0]);
      if (!Number.isFinite(weight) || body.length <= num[0].length + 2) break;
      mult *= weight; body = body.slice(num[0].length, -2);
    } else {
      brace += body[0] === '{' ? 1 : -1; body = body.slice(1, -1);
    }
  }
  const fold = foldAt(body, 0);
  return { name: body.trim(), body, off, mult: mult * Math.pow(1.05, brace), brace,
    fold: fold?.end === body.length ? fold.name : '',
    simple: !/[{}\[\]()|"\r\n]/.test(body) && !body.includes('::') };
}

export function tokens(value) {
  const text = String(value ?? '');
  return segments(text).map(([segStart, segEnd]) => {
    let start = segStart, end = segEnd;
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    const core = text.slice(start, end);
    return { segStart, segEnd, start, end, core, ...analyze(core) };
  }).filter(token => token.core);
}

function weightLabel(weight) {
  return Number(weight.toPrecision(12)).toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 12 });
}

function numericShell(body, weight) {
  const label = weightLabel(weight);
  return label === '1' ? body : `${label}::${body}::`;
}

function hasNumeric(body) {
  let quote = false;
  for (let at = 0; at < body.length; at += 1) {
    const fold = foldAt(body, at);
    if (fold) { at = fold.end - 1; continue; }
    if (body[at] === '\\') { at += 1; continue; }
    if (body[at] === '"') { quote = !quote; continue; }
    if (!quote && NUM.test(body.slice(at))) return true;
  }
  return false;
}

/* 负数与零不能用 {} / [] 表示。复用既有片段扫描器分配倍率；仍含
   不透明数字语法（交替、调度或损坏输入）时返回 null，让编辑器保留
   原 token（包括其已有外层权重），不以剥壳正文冒充无损降级。 */
function scaleNumeric(body, weight) {
  const parts = tokenizePrompt(body).map(part => analyze(part.raw));
  if (parts.some(part => hasNumeric(part.body))) return null;
  return parts.map(part => numericShell(part.body, weight * part.mult)).join(', ');
}

/* 文本语法接受负数、零和大于 10 的倍率，不沿用旧块滑杆的 .05..10
   限制。正数嵌套继续沿用 1.05 括号近似，避免数字权重自嵌套。 */
export function wrapWeighted(body, weight) {
  const value = Number(weight);
  if (!body || !Number.isFinite(value) || value === 1) return body;
  if (!hasNumeric(body)) return numericShell(body, value);
  if (value <= 0) return scaleNumeric(body, value);
  const layers = Math.round(Math.log(value) / Math.log(1.05));
  const open = layers > 0 ? '{' : '[', close = layers > 0 ? '}' : ']';
  return open.repeat(Math.abs(layers)) + body + close.repeat(Math.abs(layers));
}

function wrapFold(token, body, target) {
  if (target === 'plain') return adaptRelayOutput(body, target);
  const at = token.core.indexOf(token.body);
  const head = token.core.slice(0, at), tail = token.core.slice(at + token.body.length);
  /* 外层数字与正文自带数字不能写成 1.2::1.3::x::::。
     NAI 走安全包装，SD 直接使用无歧义的括号嵌套。手写的有符号
     不透明组无法安全分配时保留其原始外壳，既不静默丢权，也不声称
     消除了该原始语法本来就有的数字嵌套歧义。 */
  if (head.includes('::') && /[+-]?(?:\d+(?:\.\d+)?|\.\d+)::/.test(body)) {
    return target === 'sd'
      ? `(${adaptRelayOutput(body, target)}:${weightLabel(token.mult)})`
      : wrapWeighted(body, token.mult) ?? `${head}${body}${tail}`;
  }
  return adaptRelayOutput(`${head}${body}${tail}`, target);
}

const tokenKey = value => value.trim().replace(/\s+/g, ' ').toLowerCase();

/* 编辑真相永不去重；这里仅构造成品和镜像层的重复提示。序号指编辑区
   顶层 token（从 1 开始），组内重复归到该组，方便光标面板解释。 */
export function analyzeOutput(value, folds = new Map(), {
  dedupe = true, isLocked = () => false, target = 'nai',
} = {}) {
  const output = [], seen = new Map(), mergedByKey = new Map(), duplicates = new Map(), duplicateDetails = new Map();
  function duplicate(token, first, source, inner) {
    if (!inner || !duplicates.has(source.start)) duplicates.set(source.start, first.ordinal);
    const previous = duplicateDetails.get(source.start);
    duplicateDetails.set(source.start, { kind: inner && previous?.kind !== 'token' ? 'group' : 'token',
      count: (previous?.count || 0) + 1, firstOrdinal: inner ? previous?.firstOrdinal || first.ordinal : first.ordinal });
    const key = tokenKey(token), record = mergedByKey.get(key);
    if (record) record.dropped += 1;
    else mergedByKey.set(key, { token: first.token, dropped: 1 });
  }
  function keep(token, source, ordinal, into = output, table = seen, inner = false) {
    if (!token) return;
    const key = tokenKey(token), first = table.get(key);
    if (dedupe && first) { duplicate(token, first, source, inner); return; }
    if (!first) table.set(key, { token, ordinal });
    into.push(token);
  }
  tokens(value).forEach((token, index) => {
    const ordinal = index + 1;
    if (token.off) return;
    const fold = token.fold && folds.get(token.fold);
    if (fold) {
      if (isLocked(fold)) return;
      const bodyTokens = tokens(scrub(fold.body));
      const weighted = token.core !== token.body && target !== 'plain';
      if (weighted) {
        const body = [], localSeen = new Map();
        for (const child of bodyTokens) keep(child.core, token, ordinal, body, localSeen, true);
        if (body.length) keep(wrapFold(token, body.join(', '), target), token, ordinal);
      } else {
        for (const child of bodyTokens) keep(adaptRelayOutput(child.core, target), token, ordinal, output, seen, true);
      }
      return;
    }
    /* 完整占位符丢了旁路条目时降级成 #名字。边上粘着手写文字时也
       展开已知占位符，避免内部守卫漏给输出；锁定内容只跳过该占位符。 */
    let body = token.core;
    for (const range of foldRanges(body).reverse()) {
      const entry = folds.get(range.name);
      const replacement = entry ? (isLocked(entry) ? '' : scrub(entry.body)) : `#${range.name}`;
      body = body.slice(0, range.start) + replacement + body.slice(range.end);
    }
    keep(adaptRelayOutput(scrub(body), target), token, ordinal);
  });
  return { text: output.join(', '), tokens: output, merged: [...mergedByKey.values()],
    duplicates, duplicateDetails, count: output.length };
}

export function outputOf(text, folds, options) { return analyzeOutput(text, folds, options).text; }
