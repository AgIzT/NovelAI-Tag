/* 图鉴词条 → 中转站快照的适配层。
   中转站存的是**快照**而不是引用：预览域与正式域的 localStorage 按 origin 隔离，
   而且法典 JSON 动辄 7~11MB，只存引用等于刷新后要重下整本才拼得出词。
   这里只负责「把一条活的词条压成可序列化的快照」，不碰存储、不碰 DOM。 */

import { isEntryNsfw, isR18gPath } from './access.js';
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
      r18g: isR18gPath(path),
    },
  };
}

/* ⚠ 判分级只看内存里的 state，不要去读 localStorage：ui.js 是在会话内直接改
   state.allowNsfw 的，同标签页的写入根本不触发 storage 事件，读盘会读到过期值。 */
export function snapshotLocked(snapshot) {
  if (snapshot?.access?.nsfw && !state.allowNsfw) return true;
  if (snapshot?.access?.r18g && !state.allowR18g) return true;
  return false;
}
