/* 目录短码：把「梦神 · 社区图包 / 个人精选韩国图包」压成 ?p=1z3k9ab。

   URL 只认 ASCII，中文按 UTF-8 percent-encode 是一个汉字九个字符，两层中文目录就能把
   地址栏撑到两百字符。用户不点分享按钮、直接复制地址栏，复制出来的就是那串东西。

   短码是路径段的纯函数（不查树），所以写 URL 时不需要任何数据；只有反解才要树。
   ⚠ 短码跟着分类名走：分类改名 = 旧链接失效（退回法典根目录，不报错）。
     这是有意的取舍——重排/增删词条不影响短码，而本项目重排远比改名频繁。 */

const SEP = '\u001f';   // 分类名里出现过 '/' 和 '+'，分隔符只能挑名字里不可能有的控制符

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (code >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function cleanSegments(path) {
  return (Array.isArray(path) ? path : [])
    .map(seg => String(seg || '').trim())
    .filter(Boolean);
}

export function encodePathCode(path) {
  const segments = cleanSegments(path);
  if (!segments.length) return '';
  return fnv1a(segments.join(SEP)).toString(36);
}

function walkTree(nodes, prefix, visit) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const name = String(node?.name || '').trim();
    if (!name) continue;
    const path = [...prefix, name];
    if (visit(path)) return true;
    if (walkTree(node.children, path, visit)) return true;
  }
  return false;
}

/** 反解短码。解不出来返回空路径＝退回法典根目录，调用方不必区分"没写"和"写错了"。 */
export function pathFromCode(tree, code) {
  const wanted = String(code || '').trim();
  if (!wanted) return [];
  let found = [];
  walkTree(tree, [], path => {
    if (encodePathCode(path) !== wanted) return false;
    found = path;
    return true;
  });
  return found;
}
