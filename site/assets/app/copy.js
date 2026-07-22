import { state } from './state.js';
import { toast } from './feedback.js';
import { recordRecentEntry, saveBrowseStateNow } from './history.js';

export async function copyEntry(e, node) {
  recordRecentEntry(e);
  saveBrowseStateNow();
  return copyText(e.tags, `已复制：${e.title}`, node);
}

/* NAI → SD 权重格式转换：NAI 每层括号 ×1.05 / ÷1.05。
   {tag}→(tag:1.05)  {{tag}}→(tag:1.103)  [tag]→(tag:0.952)  1.3::tag::→(tag:1.3)
   支持嵌套；真正未闭合的左括号只丢弃括号本身，避免把后续普通 tag 无声扩大加权。 */
const NAI_WEIGHT_BASE = 1.05;
export function fmtSdWeight(w) { return parseFloat(w.toFixed(3)).toString(); }
export function naiToSd(text) {
  if (!text) return text;
  const n = text.length;

  const readRun = (pos, ch) => {
    let cnt = 0;
    while (text[pos + cnt] === ch) cnt++;
    return cnt;
  };
  const cleanWeightContent = value => value.trim().replace(/[,\s，]+$/, '').trim();

  const parseNumericWeight = pos => {
    const ch = text[pos];
    if (ch !== '-' && ch !== '+' && (ch < '0' || ch > '9')) return null;
    const empty = text.slice(pos).match(/^([+-]?\d+(?:\.\d+)?)::(?=[,\n]|$)/);
    if (empty) return { out: '', pos: pos + empty[0].length };
    const m = text.slice(pos).match(/^([+-]?\d+(?:\.\d+)?)::([\s\S]*?)::/)
      || text.slice(pos).match(/^([+-]?\d+(?:\.\d+)?)::([^,\n]*)/);
    if (!m) return null;
    const content = naiToSd(cleanWeightContent(m[2]));
    if (!content) return { out: '', pos: pos + m[0].length };
    return {
      out: '(' + content + ':' + fmtSdWeight(parseFloat(m[1])) + ')',
      pos: pos + m[0].length
    };
  };

  const parseRange = (pos, stopClose = '') => {
    let out = '';
    while (pos < n) {
      const ch = text[pos];

      if (stopClose && ch === stopClose) {
        const closeCount = readRun(pos, stopClose);
        return { out, closeStart: pos, pos: pos + closeCount, closed: true, closeCount };
      }

      if (ch === '}' || ch === ']') {
        pos += readRun(pos, ch);
        continue;
      }

      const weighted = parseNumericWeight(pos);
      if (weighted) {
        out += weighted.out;
        pos = weighted.pos;
        continue;
      }

      if (ch === '{' || ch === '[') {
        const group = parseBracketWeight(pos);
        out += group.out;
        pos = group.pos;
        continue;
      }

      out += ch;
      pos++;
    }
    return { out, closeStart: pos, pos, closed: false, closeCount: 0 };
  };

  const parseBracketWeight = pos => {
    const open = text[pos];
    const close = open === '{' ? '}' : ']';
    const openCount = readRun(pos, open);
    const inner = parseRange(pos + openCount, close);
    if (!inner.closed) {
      return { out: inner.out, pos: inner.pos };
    }

    const matchedCount = Math.min(openCount, inner.closeCount);
    const nextPos = inner.closeStart + matchedCount;
    const content = cleanWeightContent(inner.out);
    if (!matchedCount || !content) {
      return { out: '', pos: nextPos };
    }
    const dir = open === '{' ? 1 : -1;
    return {
      out: '(' + content + ':' + fmtSdWeight(Math.pow(NAI_WEIGHT_BASE, dir * matchedCount)) + ')',
      pos: nextPos
    };
  };

  return parseRange(0).out;
}

export async function copyText(text, message, node, options = {}) {
  if (options.convert !== false && state.sdMode) {
    text = naiToSd(text);
    message += '（SD 格式）';
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  if (node) {
    node.classList.add('copied');
    setTimeout(() => node.classList.remove('copied'), 600);
  }
  toast(message);
}

export function combinedPrompt(e) {
  const sections = [];
  if (String(e.tags || '').trim()) sections.push(String(e.tags).trim());
  for (const item of e.characterPrompts || []) {
    if (String(item.prompt || '').trim()) {
      sections.push(`${item.label || 'char'}:\n${String(item.prompt).trim()}`);
    }
  }
  if (String(e.negative || '').trim()) sections.push(`Negative:\n${String(e.negative).trim()}`);
  for (const item of e.characterPrompts || []) {
    if (String(item.negative || '').trim()) {
      sections.push(`${item.label || 'char'} Negative:\n${String(item.negative).trim()}`);
    }
  }
  return sections.join('\n\n');
}
