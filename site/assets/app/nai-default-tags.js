/* NAI 会自动补上这三项；只去除独立、无权重、含齐三项的连续默认尾段。
   只判断尾段自身，前文的 NAI 权重 / reset 语法原样保留；负面与角色词不调用此函数。 */
const DEFAULT_TAGS = new Set(['very aesthetic', 'masterpiece', 'no text']);
const SEPARATOR = /[,，\r\n]/;
const DEFAULT_TAIL = /(?:^|[,，\r\n])\s*(?:very\s+aesthetic|masterpiece|no\s+text)[\s,，]*$/i;

function promptPieces(source) {
  const pieces = [];
  let start = 0;
  let separatorBefore = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    // 两个反斜杠互相转义；只有奇数个反斜杠会保护后面的逗号 / 换行。
    if (ch === '\\') { i += 1; continue; }
    if (SEPARATOR.test(ch)) {
      pieces.push({ text: source.slice(start, i), separatorBefore });
      start = i + 1;
      separatorBefore = i;
    }
  }
  pieces.push({ text: source.slice(start), separatorBefore });
  return pieces;
}

const tagKey = text => text.trim().replace(/\s+/g, ' ').toLowerCase();

export function stripNaiDefaultTags(value) {
  const source = String(value ?? '');
  if (!DEFAULT_TAIL.test(source)) return source;
  const pieces = promptPieces(source);
  const seen = new Set();
  let first = -1;
  for (let i = pieces.length - 1; i >= 0; i -= 1) {
    const key = tagKey(pieces[i].text);
    if (!key) continue;
    if (!DEFAULT_TAGS.has(key)) break;
    seen.add(key);
    first = i;
  }
  if (seen.size !== DEFAULT_TAGS.size) return source;
  // 默认尾段前的空逗号 / 换行一并去掉，前一个有效标签本身的空白原样保留。
  while (first > 0 && !tagKey(pieces[first - 1].text)) first -= 1;
  return source.slice(0, pieces[first].separatorBefore);
}
