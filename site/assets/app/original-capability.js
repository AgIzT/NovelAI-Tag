import { state } from './state.js';
import { codexMatches, findCodexMeta } from './data.js';
import { imageItemHasOriginal } from './media.js';

export function entrySourceCodexId(entry) {
  return String(entry?._srcCodexId || state.codex?.id || '');
}

/* 整本无原图的书可在书目里声明个别一级目录保留原图（originalSections，目录名数组）。 */
export function originalSectionsOf(meta) {
  const sections = meta?.originalSections;
  return Array.isArray(sections) ? sections.map(name => String(name || '').trim()).filter(Boolean) : [];
}

/* 收藏墙 / 全站搜索改写了 path，真实目录在 _srcPath。 */
function entrySourceTopDir(entry) {
  const path = Array.isArray(entry?._srcPath) ? entry._srcPath : entry?.path;
  const top = Array.isArray(path) ? path[0] : String(path || '').split('/')[0];
  return String(top ?? '').trim();
}

function sectionAllowsOriginal(meta, entry) {
  const top = entrySourceTopDir(entry);
  return Boolean(top) && originalSectionsOf(meta).includes(top);
}

/* 线上 hasOriginal 是原图能力的硬上限，originalSections 只在声明的目录里放开它；本地版自建书没有这项发布声明，
   可按逐图 original 查看上传文件。显式 false 与外部数据源仍服从来源声明。逐图仍要有物理原图。 */
export function entrySourceAllowsOriginal(entry) {
  const sourceId = entrySourceCodexId(entry);
  if (!sourceId) return false;
  const indexed = findCodexMeta(sourceId);
  if (indexed?.hasOriginal != null) return Boolean(indexed.hasOriginal) || sectionAllowsOriginal(indexed, entry);
  if (globalThis.document?.body?.classList?.contains('local-edition')
    && indexed && !indexed.dataUrl && !indexed.assetBaseUrl) return true;
  const active = [state.codex, state.browseCodex]
    .find(candidate => codexMatches(candidate, sourceId));
  return Boolean(active?.hasOriginal) || sectionAllowsOriginal(active, entry);
}

export function entryImageCanUseOriginal(entry, item) {
  return entrySourceAllowsOriginal(entry) && imageItemHasOriginal(item, entry);
}
