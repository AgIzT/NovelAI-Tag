import { state } from './state.js';
import { codexMatches, findCodexMeta } from './data.js';
import { imageItemHasOriginal } from './media.js';

export function entrySourceCodexId(entry) {
  return String(entry?._srcCodexId || state.codex?.id || '');
}

/* 法典级 hasOriginal 是用户可用原图能力的硬上限。条目中的 original
   只说明数据里存在物理字段，不能越过来源法典的显式“无原图”声明。 */
export function entrySourceAllowsOriginal(entry) {
  const sourceId = entrySourceCodexId(entry);
  if (!sourceId) return false;
  const indexed = findCodexMeta(sourceId);
  if (indexed?.hasOriginal != null) return Boolean(indexed.hasOriginal);
  const active = [state.codex, state.browseCodex]
    .find(candidate => codexMatches(candidate, sourceId));
  return Boolean(active?.hasOriginal);
}

export function entryImageCanUseOriginal(entry, item) {
  return entrySourceAllowsOriginal(entry) && imageItemHasOriginal(item, entry);
}
