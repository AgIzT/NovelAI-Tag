/* 编辑模块的纯函数核心（无 DOM 依赖，node 可直接单测）。
   树路径分隔符与 codex-ui 的 dataset.path 保持一致：U+0001，源码里只写转义序列。 */

export const TREE_PATH_SEP = '\u0001';

export function splitTreePath(value) {
  return value ? String(value).split(TREE_PATH_SEP) : [];
}

export function joinTreePath(parts) {
  return (parts || []).join(TREE_PATH_SEP);
}

/* tree [{name,count,children[]}] → 深度优先的全部分类路径
   [{ parts:[..], value:'a\u0001b', label:'a / b' }, ...] */
export function buildPathList(tree) {
  const out = [];
  const walk = (nodes, prefix) => {
    for (const node of nodes || []) {
      const parts = [...prefix, node.name];
      out.push({ parts, value: joinTreePath(parts), label: parts.join(' / ') });
      walk(node.children, parts);
    }
  };
  walk(tree, []);
  return out;
}

/* 全站搜索词条是来源法典的克隆；编辑前必须先解析回可写的原法典。
   普通词条、外部源或锁定法典均返回 null，继续沿用主站的复制行为。 */
export function resolveSiteSearchEditTarget(entry, editableCodexIds) {
  const codexId = String(entry?._srcCodexId || '').trim();
  const entryId = String(entry?.id || '').trim();
  if (!codexId || !entryId || !Array.isArray(editableCodexIds) || !editableCodexIds.includes(codexId)) {
    return null;
  }
  return {
    codexId,
    entryId,
    codexTitle: String(entry._srcCodexTitle || codexId),
    path: Array.isArray(entry._srcPath) ? entry._srcPath.slice() : [],
  };
}

/* 图片文件名 → 新词条默认标题；只去掉最后一个扩展名，保留文件名中的其它点。 */
export function titleFromImageFilename(name) {
  const leaf = String(name || '').split(/[\\/]/).pop() || '';
  return leaf.replace(/\.[^.]+$/, '').trim();
}

/* 服务端元数据 → 前端角色框安全形状。保留 char 原序号，空框不展示也不提交。 */
export function normalizeImportedCharacterPrompts(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const label = String(item?.label || '').trim();
    const prompt = String(item?.prompt || '').trim();
    const negative = String(item?.negative || '').trim();
    if (!/^char[1-9]\d*$/.test(label) || seen.has(label) || (!prompt && !negative)) continue;
    const clean = { label, prompt };
    if (negative) clean.negative = negative;
    seen.add(label);
    out.push(clean);
  }
  return out;
}

/* 表单值 → 只含真正变化字段的 dirty 子集（服务器白名单同款字段）。
   values: { title, tags, negative, note, rating, isNew, pathValue } */
export function diffFields(entry, values) {
  const diff = {};
  const strKeys = ['title', 'tags', 'negative', 'note'];
  for (const key of strKeys) {
    if (values[key] === undefined) continue;
    const next = String(values[key]);
    const prev = String(entry[key] || '');
    if (next !== prev) diff[key] = next;
  }
  if (values.rating !== undefined) {
    const next = String(values.rating || '');
    const prev = String(entry.rating || '');
    if (next !== prev) diff.rating = next;
  }
  if (values.isNew !== undefined) {
    const next = Boolean(values.isNew);
    if (next !== Boolean(entry.isNew)) diff.isNew = next;
  }
  if (values.pathValue !== undefined) {
    const next = splitTreePath(values.pathValue);
    const prev = Array.isArray(entry.path) ? entry.path : [];
    if (next.length && joinTreePath(next) !== joinTreePath(prev)) diff.path = next;
  }
  return diff;
}

/* 提交前的本地校验；返回错误文案，'' 表示通过。requireAll=true 用于新增表单。 */
export function validateEntryForm(values, { requireAll = false } = {}) {
  const title = values.title === undefined ? undefined : String(values.title).trim();
  const tags = values.tags === undefined ? undefined : String(values.tags).trim();
  if ((requireAll || title !== undefined) && !title) return '标题不能为空';
  if ((requireAll || tags !== undefined) && !tags) return '正向 Tag 不能为空';
  if (requireAll && !splitTreePath(values.pathValue).length) return '必须选择分类';
  return '';
}

/* 把服务器返回的原始词条同步进内存里已 normalize 的同一个词条对象。 */
export function mergeEntryInPlace(entry, serverEntry) {
  if (!entry || !serverEntry) return entry;
  entry.title = String(serverEntry.title || '');
  entry.tags = String(serverEntry.tags || '');
  entry.negative = String(serverEntry.negative || '');
  entry.note = String(serverEntry.note || '');
  entry.path = Array.isArray(serverEntry.path) ? serverEntry.path.slice() : entry.path;
  if (serverEntry.rating) entry.rating = serverEntry.rating;
  else delete entry.rating;
  // 服务器返回的是完整词条，缺 isNew 即代表非新（无该键），按权威值无条件同步
  entry.isNew = serverEntry.isNew === true;
  for (const key of ['image', 'original', 'assetRev', 'imageWidth', 'imageHeight', 'assetCodexId']) {
    if (key in serverEntry) entry[key] = serverEntry[key];
    else delete entry[key];
  }
  return entry;
}
