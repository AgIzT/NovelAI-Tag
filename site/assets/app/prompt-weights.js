/* 提示词权重上色：只改显示，不改文字。
   NAI 的 1.2::…:: 与 {…} / […]、SD 预览的 (…:1.2) 按方向分两色：加权绿、减权蓝（负权重也算减权），
   与 Tag 中转站同一套颜色；权重恰为 1 的外壳和逗号淡化。
   promptWeightMarks 是零 DOM 的纯计算，node 直测；decoratePromptWeights 把结果套到已渲染的提示词框上，
   跳过中文对照的译名节点。英文原文必须与 source 逐字相同才动手，拖选复制得到的仍是原文。 */

const NAI_OPEN = /^-?\d+(?:\.\d+)?::/;
const SD_CLOSE = /^:\s*(-?\d+(?:\.\d+)?)\)/;

function direction(weight) {
  if (!Number.isFinite(weight)) return 'flat';
  if (weight > 1.001) return 'up';
  if (weight < 0.999) return 'down';
  return 'flat';
}

/* 返回 [{ start, end, kind }]，kind 为 up / down / flat / sep，按 start 升序且互不重叠。
   - 数字权重只认前面不是字母数字的位置，免得把 tag 里的数字（year 2025）当成权重；
   - 裸 :: 收在最近一个数字权重上，颜色跟开头一致；没有开头的 :: 记为 flat；
   - 括号只上色 SD 显式权重 (…:1.2)：普通圆括号是 tag 名的一部分（hiro (dismaless)），反斜杠转义的一律跳过。 */
export function promptWeightMarks(text) {
  const source = String(text ?? '');
  const marks = [];
  const parens = [];
  let open = null;
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === ',' || ch === '，') {
      marks.push({ start: i, end: i + 1, kind: 'sep' });
      i += 1;
      continue;
    }
    if ((ch === '-' || (ch >= '0' && ch <= '9')) && !/[\p{L}\p{N}._]/u.test(source[i - 1] || '')) {
      const match = source.slice(i, i + 24).match(NAI_OPEN);
      if (match) {
        open = direction(parseFloat(match[0]));
        marks.push({ start: i, end: i + match[0].length, kind: open });
        i += match[0].length;
        continue;
      }
    }
    if (ch === ':' && source[i + 1] === ':') {
      marks.push({ start: i, end: i + 2, kind: open || 'flat' });
      open = null;
      i += 2;
      continue;
    }
    if (ch === '{' || ch === '}') { marks.push({ start: i, end: i + 1, kind: 'up' }); i += 1; continue; }
    if (ch === '[' || ch === ']') { marks.push({ start: i, end: i + 1, kind: 'down' }); i += 1; continue; }
    if (ch === '(') { parens.push(i); i += 1; continue; }
    if (ch === ':') {
      const match = source.slice(i, i + 24).match(SD_CLOSE);
      if (match && parens.length) {
        const kind = direction(parseFloat(match[1]));
        marks.push({ start: parens.pop(), end: 0, kind, opener: true });
        marks.push({ start: i, end: i + match[0].length, kind });
        i += match[0].length;
        continue;
      }
    }
    if (ch === ')') parens.pop();
    i += 1;
  }
  return marks
    .map(mark => (mark.opener ? { start: mark.start, end: mark.start + 1, kind: mark.kind } : mark))
    .sort((a, b) => a.start - b.start);
}

const SKIP = '.tag-zh-zh';

function textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => (node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

/* 在已渲染好的提示词框里给权重语法套 span.pw-<kind>；节点文本拼起来与 source 不符时原样放弃。 */
export function decoratePromptWeights(root, source) {
  if (!root) return;
  const text = String(source ?? '');
  const marks = promptWeightMarks(text);
  if (!marks.length) return;
  const nodes = textNodes(root);
  if (nodes.map(node => node.data).join('') !== text) return;
  let offset = 0;
  let cursor = 0;
  for (const node of nodes) {
    const start = offset;
    const end = start + node.data.length;
    offset = end;
    while (cursor < marks.length && marks[cursor].end <= start) cursor += 1;
    if (cursor >= marks.length || marks[cursor].start >= end) continue;
    const fragment = document.createDocumentFragment();
    let position = start;
    for (let i = cursor; i < marks.length && marks[i].start < end; i += 1) {
      const from = Math.max(marks[i].start, start);
      const to = Math.min(marks[i].end, end);
      if (from > position) fragment.append(text.slice(position, from));
      const span = document.createElement('span');
      span.className = `pw pw-${marks[i].kind}`;
      span.textContent = text.slice(from, to);
      fragment.append(span);
      position = to;
    }
    if (position < end) fragment.append(text.slice(position, end));
    node.replaceWith(fragment);
  }
}
