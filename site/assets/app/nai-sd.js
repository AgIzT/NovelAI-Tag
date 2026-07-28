/* NovelAI -> Stable Diffusion prompt conversion.
   This module is deliberately dependency-free so every page can share the
   exact same conversion semantics without importing the atlas copy/history
   pipeline. */

const NAI_WEIGHT_BASE = 1.05;

export function fmtSdWeight(weight) {
  return parseFloat(weight.toFixed(3)).toString();
}

export function naiToSd(text) {
  if (!text) return text;
  const n = text.length;

  const readRun = (pos, ch) => {
    let count = 0;
    while (text[pos + count] === ch) count += 1;
    return count;
  };
  const cleanWeightContent = value => value.trim().replace(/[,\s，]+$/, '').trim();

  const parseNumericWeight = pos => {
    const ch = text[pos];
    if (ch !== '-' && ch !== '+' && (ch < '0' || ch > '9')) return null;
    const empty = text.slice(pos).match(/^([+-]?\d+(?:\.\d+)?)::(?=[,\n]|$)/);
    if (empty) return { out: '', pos: pos + empty[0].length };
    const match = text.slice(pos).match(/^([+-]?\d+(?:\.\d+)?)::([\s\S]*?)::/)
      || text.slice(pos).match(/^([+-]?\d+(?:\.\d+)?)::([^,\n}\]]*)/);
    if (!match) return null;
    const content = naiToSd(cleanWeightContent(match[2]));
    if (!content) return { out: '', pos: pos + match[0].length };
    return {
      out: `(${content}:${fmtSdWeight(parseFloat(match[1]))})`,
      pos: pos + match[0].length,
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
      pos += 1;
    }
    return { out, closeStart: pos, pos, closed: false, closeCount: 0 };
  };

  const parseBracketWeight = pos => {
    const open = text[pos];
    const close = open === '{' ? '}' : ']';
    const openCount = readRun(pos, open);
    const inner = parseRange(pos + openCount, close);
    if (!inner.closed) return { out: inner.out, pos: inner.pos };

    const matchedCount = Math.min(openCount, inner.closeCount);
    const nextPos = inner.closeStart + matchedCount;
    const content = cleanWeightContent(inner.out);
    if (!matchedCount || !content) return { out: '', pos: nextPos };
    const direction = open === '{' ? 1 : -1;
    return {
      out: `(${content}:${fmtSdWeight(Math.pow(NAI_WEIGHT_BASE, direction * matchedCount))})`,
      pos: nextPos,
    };
  };

  return parseRange(0).out;
}

export function formatCopyText(value, { sdMode = false, convert = true } = {}) {
  const source = String(value ?? '');
  const converted = Boolean(convert && sdMode);
  return {
    source,
    text: converted ? naiToSd(source) : source,
    converted,
  };
}
