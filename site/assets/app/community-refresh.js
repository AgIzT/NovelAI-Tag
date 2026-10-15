import { COMMUNITY_CODEX_ID } from './community-codex.js';

// 虚拟视图只替换在线来源；其它书保留对象身份，收藏归类仍由主站现有逻辑处理。
export function replaceCommunityEntries(view, community, { isFavorite = () => true } = {}) {
  if (view.id === COMMUNITY_CODEX_ID) return community;
  const entries = community.entries.map(entry => ({
    ...entry, path: [community.title, ...entry.path],
    _srcCodexId: COMMUNITY_CODEX_ID, _srcCodexTitle: community.title, _srcType: 'pack',
    _srcPath: entry.path, _srcAuthor: community.author,
  })).filter(entry => view.view !== 'favorites' || isFavorite(entry));
  return {
    ...view,
    communityStamp: community.communityStamp,
    entries: [...view.entries.filter(entry => entry._srcCodexId !== COMMUNITY_CODEX_ID), ...entries],
    _sourceDirectoryTrees: [
      ...(view._sourceDirectoryTrees || []).filter(source => source.codexId !== COMMUNITY_CODEX_ID),
      { codexId: COMMUNITY_CODEX_ID, tree: community.tree },
    ],
  };
}
