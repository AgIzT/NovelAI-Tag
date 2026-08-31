// 并册只增加目录层级，不改原分类名。旧书 id 必须保留到路径归一完成，
// 否则同名分类无法判断来自哪本书；只有目标树真实存在时才应用迁移。
const MERGED_PATHS = [
  { target: 'artist_nai45_personal', sources: ['artist_nai45_personal', 'artist_300', 'artist_45_collection'], prefix: '单画师词典' },
  { target: 'artist_nai45_personal', sources: ['artist_nai45_strings'], prefix: '画师串词典' },
  { target: 'nai45_community_pack', sources: ['mengshen_pack'], prefix: '梦神 · 社区图包' },
  { target: 'nai45_community_pack', sources: ['community_ai_misc'], prefix: '社区 · AI杂图' },
];

export function normalizeRoutePath(tree, path) {
  if (!Array.isArray(path) || !path.length) return [];
  let nodes = Array.isArray(tree) ? tree : [];
  const normalized = [];
  for (const seg of path) {
    const node = nodes.find(candidate => candidate?.name === seg);
    if (!node) return [];
    normalized.push(node.name);
    nodes = Array.isArray(node.children) ? node.children : [];
  }
  return normalized;
}

export function normalizeCodexRoutePath(codex, path, sourceCodexId = codex?.id) {
  if (!Array.isArray(path)) return [];
  const current = normalizeRoutePath(codex?.tree, path);
  if (current.length) return current; // 新路径原样保留，反复刷新不重复加前缀。
  if (!path.length && sourceCodexId === codex?.id) return []; // 当前合并册的“全部”。
  const migration = MERGED_PATHS.find(item => (
    item.target === codex?.id && item.sources.includes(sourceCodexId)
  ));
  if (!migration) return [];
  return normalizeRoutePath(codex.tree, [migration.prefix, ...path]);
}
