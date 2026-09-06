import { state } from './state.js';
import { codexMatches, findCodexMeta } from './data.js';
import { imageItemHasOriginal } from './media.js';

export function entrySourceCodexId(entry) {
  return String(entry?._srcCodexId || state.codex?.id || '');
}

/* 线上 hasOriginal 是原图能力的硬上限；本地版自建书没有这项发布声明，
   可按逐图 original 查看上传文件。显式 false 与外部数据源仍服从来源声明。 */
export function entrySourceAllowsOriginal(entry) {
  const sourceId = entrySourceCodexId(entry);
  if (!sourceId) return false;
  const indexed = findCodexMeta(sourceId);
  if (indexed?.hasOriginal != null) return Boolean(indexed.hasOriginal);
  if (globalThis.document?.body?.classList?.contains('local-edition')
    && indexed && !indexed.dataUrl && !indexed.assetBaseUrl) return true;
  const active = [state.codex, state.browseCodex]
    .find(candidate => codexMatches(candidate, sourceId));
  return Boolean(active?.hasOriginal);
}

export function entryImageCanUseOriginal(entry, item) {
  return entrySourceAllowsOriginal(entry) && imageItemHasOriginal(item, entry);
}
