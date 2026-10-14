/* 目录顺序只描述真实节点的位置；不负责创建目录或判断访问权限。 */
export function normalizeCategoryOrder(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.filter(path => {
    if (!Array.isArray(path) || !path.length || path.some(part => typeof part !== 'string' || !part.trim())) return false;
    const key = JSON.stringify(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(path => [...path]);
}

export function sortCategoryTree(tree, categoryOrder) {
  if (!Array.isArray(tree)) return [];
  const order = normalizeCategoryOrder(categoryOrder);
  if (!order.length) return tree;
  const ranks = new Map(order.map((path, index) => [JSON.stringify(path), index]));
  const sortLevel = (nodes, prefix = []) => nodes
    .map((node, index) => {
      const path = [...prefix, node.name];
      return {
        node: Array.isArray(node.children) ? { ...node, children: sortLevel(node.children, path) } : node,
        rank: ranks.get(JSON.stringify(path)) ?? Infinity,
        index,
      };
    })
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    .map(item => item.node);
  return sortLevel(tree);
}

/* 浏览列表跟随已排序目录树的深度优先顺序；同一目录内保持原次序，不改原数组或词条。 */
export function sortCategoryEntries(entries, tree, categoryOrder) {
  if (!normalizeCategoryOrder(categoryOrder).length) return entries;
  const ranks = new Map();
  const walk = (nodes, prefix = []) => {
    for (const node of nodes || []) {
      const path = [...prefix, node.name];
      ranks.set(JSON.stringify(path), ranks.size);
      walk(node.children, path);
    }
  };
  walk(tree);
  return entries
    .map((entry, index) => ({ entry, index, rank: ranks.get(JSON.stringify(entry.path || [])) ?? Infinity }))
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    .map(item => item.entry);
}
