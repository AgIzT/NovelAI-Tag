import { isEntryAccessBlocked } from './access.js';
import { encodePathCode } from './path-code.js';
import { state } from './state.js';

const PATH_SEP = '\u0001';
let directoryListCache = new WeakMap();

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedTerms(values) {
  return [...new Set((values || [])
    .map(value => normalizeText(typeof value === 'object' ? value.value : value))
    .filter(Boolean))];
}

function cleanPath(path) {
  return (Array.isArray(path) ? path : [])
    .map(part => String(part || '').trim())
    .filter(Boolean);
}

function directoryKey(codexId, path) {
  return `${String(codexId || '').trim()}${PATH_SEP}${path.join(PATH_SEP)}`;
}

function sourceTrees(codex, sourceView) {
  if (sourceView) {
    return Array.isArray(codex?._sourceDirectoryTrees)
      ? codex._sourceDirectoryTrees
      : [];
  }
  const codexId = String(codex?.id || '').trim();
  return codexId ? [{ codexId, tree: codex?.tree }] : [];
}

function treeOrdering(codex, sourceView) {
  const sourceOrder = new Map();
  const pathOrder = new Map();
  for (const source of sourceTrees(codex, sourceView)) {
    const codexId = String(source?.codexId || '').trim();
    if (!codexId || sourceOrder.has(codexId)) continue;
    sourceOrder.set(codexId, sourceOrder.size);
    let order = 0;
    const visit = (nodes, prefix = []) => {
      for (const node of Array.isArray(nodes) ? nodes : []) {
        const name = String(node?.name || '').trim();
        if (!name) continue;
        const path = [...prefix, name];
        pathOrder.set(directoryKey(codexId, path), order++);
        visit(node.children, path);
      }
    };
    visit(source?.tree);
  }
  return { sourceOrder, pathOrder };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDirectoryTreeOrder(left, right, ordering) {
  const leftSource = ordering.sourceOrder.get(left.codexId);
  const rightSource = ordering.sourceOrder.get(right.codexId);
  const leftHasSource = leftSource !== undefined;
  const rightHasSource = rightSource !== undefined;
  if (leftHasSource !== rightHasSource) return leftHasSource ? -1 : 1;
  if (leftHasSource && leftSource !== rightSource) return leftSource - rightSource;
  if (!leftHasSource) {
    const sourceFallback = compareText(normalizeText(left.codexId), normalizeText(right.codexId));
    if (sourceFallback) return sourceFallback;
  }
  const leftPath = ordering.pathOrder.get(left.id);
  const rightPath = ordering.pathOrder.get(right.id);
  const leftHasPath = leftPath !== undefined;
  const rightHasPath = rightPath !== undefined;
  if (leftHasPath !== rightHasPath) return leftHasPath ? -1 : 1;
  if (leftHasPath && leftPath !== rightPath) return leftPath - rightPath;
  // 来源树缺失或与词条路径不一致时，使用规范化路径作稳定 fallback，不依赖 entries 顺序。
  return compareText(normalizeText(left.breadcrumb), normalizeText(right.breadcrumb))
    || compareText(left.breadcrumb, right.breadcrumb);
}

/**
 * 从用户当前有权看到的词条反推目录候选。全站视图只读取真实来源 `_srcPath`，
 * 因而不会把虚拟法典为展示而插入的书名分组误当作目录命中。
 * `directories` 可复用筛选器已计算的目录表；返回数组至多 `limit` 项，
 * 未截断的权限内命中数保存在数组的 `totalCount` 属性中。
 */
export function findRelatedDirectories({
  entries = [],
  codex = null,
  siteSearchView = false,
  directories = null,
  positiveTerms = [],
  queryText = '',
  limit = 5,
} = {}) {
  const terms = normalizedTerms(positiveTerms);
  if (!terms.length) return relatedResult([], 0);
  const available = Array.isArray(directories)
    ? directories
    : listSearchDirectories({ entries, codex, sourceView: siteSearchView });
  const normalizedQuery = normalizeText(queryText);
  const matches = available
    .map(node => {
      const name = normalizeText(node.name);
      const breadcrumb = normalizeText(node.breadcrumb);
      let matchRank = -1;
      if (normalizedQuery && name === normalizedQuery) matchRank = 0;
      else if (terms.every(term => name.includes(term))) matchRank = 1;
      else if (terms.every(term => breadcrumb.includes(term))) matchRank = 2;
      return { ...node, matchRank };
    })
    .filter(node => node.matchRank >= 0)
    .sort((left, right) => (
      left.matchRank - right.matchRank
      || left.path.length - right.path.length
      || left.order - right.order
    ));
  const totalCount = matches.length;
  const visible = matches
    .slice(0, Math.max(0, Number(limit) || 0))
    .map(({ order: _order, ...node }) => node);
  return relatedResult(visible, totalCount);
}

function relatedResult(items, totalCount) {
  Object.defineProperty(items, 'totalCount', { value: totalCount, enumerable: false });
  return items;
}

/**
 * 返回当前可见词条实际覆盖的全部目录，供精确目录筛选器使用。
 * 结果按 entries 对象引用、法典/来源视图和当前访问权限组合缓存。
 */
export function listSearchDirectories({ entries = [], codex = null, sourceView = false } = {}) {
  const cacheable = entries && (typeof entries === 'object' || typeof entries === 'function');
  const cacheKey = `${sourceView ? 'source' : 'codex'}${PATH_SEP}${stateKey()}`;
  if (cacheable) {
    const cached = directoryListCache.get(entries)?.get(cacheKey)?.get(codex);
    if (cached) return cached;
  }
  const ordering = treeOrdering(codex, sourceView);
  const nodes = new Map();
  for (const entry of entries || []) {
    if (!entry || isEntryAccessBlocked(entry)) continue;
    const sourcePath = sourceView
      ? (Array.isArray(entry._srcPath) ? entry._srcPath : [])
      : (Array.isArray(entry.path) ? entry.path : []);
    const path = cleanPath(sourcePath);
    if (!path.length) continue;
    const codexId = String(sourceView ? entry._srcCodexId : codex?.id || '').trim();
    if (!codexId) continue;
    const codexTitle = String(sourceView
      ? (entry._srcCodexTitle || entry._srcCodexId)
      : (codex?.title || codexId));

    for (let depth = 1; depth <= path.length; depth += 1) {
      const nodePath = path.slice(0, depth);
      const key = directoryKey(codexId, nodePath);
      const old = nodes.get(key);
      if (old) {
        old.count += 1;
        continue;
      }
      nodes.set(key, {
        id: key,
        codexId,
        codexTitle,
        path: nodePath,
        pathCode: encodePathCode(nodePath),
        name: nodePath.at(-1) || '',
        breadcrumb: nodePath.join(' › '),
        count: 1,
      });
    }
  }
  const result = [...nodes.values()]
    .sort((left, right) => compareDirectoryTreeOrder(left, right, ordering))
    .map((node, order) => ({ ...node, order }));
  if (cacheable) {
    let variants = directoryListCache.get(entries);
    if (!variants) {
      variants = new Map();
      directoryListCache.set(entries, variants);
    }
    let contexts = variants.get(cacheKey);
    if (!contexts) {
      contexts = new Map();
      variants.set(cacheKey, contexts);
    }
    contexts.set(codex, result);
  }
  return result;
}

function stateKey() {
  return `${state.allowNsfw ? 1 : 0}${state.allowR18g ? 1 : 0}`;
}

/**
 * 编辑态就地修改词条路径后传入原 entries 数组定点失效；无参数时清空全部目录 memo。
 */
export function invalidateSearchDirectories(entries) {
  if (entries && (typeof entries === 'object' || typeof entries === 'function')) {
    return directoryListCache.delete(entries);
  }
  directoryListCache = new WeakMap();
  return true;
}
