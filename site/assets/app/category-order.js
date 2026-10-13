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
