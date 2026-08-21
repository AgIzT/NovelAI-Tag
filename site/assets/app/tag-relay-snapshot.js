/* 图鉴词条 → 中转站快照的适配层。
   中转站存的是**快照**而不是引用：预览域与正式域的 localStorage 按 origin 隔离，
   而且法典 JSON 动辄 7~11MB，只存引用等于刷新后要重下整本才拼得出词。
   这里只负责「把一条活的词条压成可序列化的快照」，不碰存储、不碰 DOM。 */

import { isEntryNsfw, isR18gEntry } from './access.js';
import { findCodexMeta } from './data.js';
import { hasEntryImage, thumbUrl } from './media.js';
import { state } from './state.js';
import { stableEntryKey } from './tag-relay-core.js';

/* 归属永远算在词条的真实法典下：收藏墙 / 全站搜索里的词条带 _srcCodexId，
   照它回溯正主，否则会记成 favorites / site-search 这两本并不存在的书。 */
export function sourceContext(entry) {
  const codexId = String(entry?._srcCodexId || state.codex?.id || '').trim();
  const meta = findCodexMeta(codexId);
  return {
    codexId,
    codexTitle: String(entry?._srcCodexTitle || meta?.selectorTitle || meta?.title || state.codex?.title || '').trim(),
    meta,
  };
}

export function relayKeyFor(entry) {
  return stableEntryKey(entry, { codexId: sourceContext(entry).codexId });
}

export function snapshotEntry(entry) {
  const context = sourceContext(entry);
  const path = Array.isArray(entry?._srcPath) ? entry._srcPath : (entry?.path || []);
  let image = '';
  try {
    if (hasEntryImage(entry)) image = thumbUrl(entry);
  } catch {
    image = '';
  }
  return {
    ...entry,
    codexId: context.codexId,
    entryId: entry?.id,
    book: context.codexTitle,
    path,
    image,
    /* 分级随快照一起冻住：日后用户关掉 NSFW 开关，已入库的这条也要能被锁住，
       不能因为「当时是解锁状态存进来的」就永久放行。 */
    access: {
      nsfw: context.meta?.nsfw === true || isEntryNsfw(entry),
      r18g: isR18gEntry({ ...entry, path }),
    },
    accessKnown: true,
  };
}

/* ⚠ 判分级只看内存里的 state，不要去读 localStorage：ui.js 是在会话内直接改
   state.allowNsfw 的，同标签页的写入根本不触发 storage 事件，读盘会读到过期值。 */
export function snapshotLocked(snapshot) {
  /* 首版中转站曾把 access 当成可选字段。正常快照都带它；但若用户本地
     留着那批旧数据，至少还能用 codexId 回查整本 NSFW 标记，不能静默放行。 */
  const sourceMeta = findCodexMeta(snapshot?.codexId);
  const sourceNsfw = sourceMeta?.nsfw === true;
  /* 旧的 entry 只留引用、又没有任何分级证据时，未知来源必须锁定。
     accessKnown 的语义是「显式带了就尊重，没带才由 hasAccessEvidence 推断」，
     normalizeRelayEntry / normalizePlanItem 出来的对象一定带布尔值，所以这里
     `=== false` 已经覆盖全部经过 store 的数据。
     ⚠ 不收紧成 `!== true`：snapshotLocked 也被侧栏拿去判 action 结果、编辑器草稿这类
     临时对象，那些不一定跑过 normalize，收紧会把普通词条误锁。
     新建自定义块在 normalizePlanItem 中显式标记 accessKnown=true，不受此规则影响。 */
  if (snapshot?.accessKnown === false && snapshot?.kind !== 'block') return true;
  if ((snapshot?.access?.nsfw || sourceNsfw || isEntryNsfw(snapshot)) && !state.allowNsfw) return true;
  if ((snapshot?.access?.r18g || isR18gEntry(snapshot)) && !state.allowR18g) return true;
  return false;
}
