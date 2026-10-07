/* 今日画师：默认进站那本书（v5 画师词典）每天抽一位画师，放在「全部」视图的第一格并挂小签。
   - 按**本地日期**抽，同一天所有人同一位；抽签池只看词条本身（单画师、不受分级限制、有竖图），
     与个人的分级开关、屏蔽清单无关——被某人屏蔽了就对他不置顶，不会换成别人。
   - 只挪显示列表，不改 entries：目录树按 entries 顺序现算，挪数据会把那位画师所在的整组顶到目录最前。
   决策见本地私有文档 docs/decisions/今日画师.md。 */

export const FEATURED_CODEX_ID = 'artist_nai5_personal';

let memo = { entries: null, day: '', entry: null };

function localDay(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function isCandidate(entry) {
  return entry?.rating === 'safe'
    && Boolean(entry.image)
    && /^artist:/.test(String(entry.tags || ''))
    && String(entry.path?.[0] || '').startsWith('单画师')
    && Number(entry.imageHeight) > Number(entry.imageWidth);
}

/** 当天的今日画师词条；不是那本书或池子为空时返回 null。按 entries 引用与日期记忆化。 */
export function todayFeatured(codex) {
  if (codex?.id !== FEATURED_CODEX_ID || !Array.isArray(codex.entries)) return null;
  const day = localDay();
  if (memo.entries === codex.entries && memo.day === day) return memo.entry;
  const pool = codex.entries.filter(isCandidate);
  let entry = null;
  if (pool.length) {
    let hash = 2166136261;
    for (const ch of day) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
    entry = pool[(hash >>> 0) % pool.length];
  }
  memo = { entries: codex.entries, day, entry };
  return entry;
}

export function isFeaturedEntry(entry, codex) {
  return Boolean(entry) && entry === todayFeatured(codex);
}

/** 把今日画师挪到第 0 位的新数组；不在列表里（被屏蔽、被筛掉）就原样返回。 */
export function pinFeatured(list, codex) {
  const entry = todayFeatured(codex);
  const index = entry ? list.indexOf(entry) : -1;
  if (index <= 0) return list;
  const pinned = list.slice();
  pinned.splice(index, 1);
  pinned.unshift(entry);
  return pinned;
}

/** 「artist:xxx」里的名字部分，开场名字行用 */
export function featuredArtistName(entry) {
  return String(entry?.tags || '').split(',')[0].trim().replace(/^artist:/, '');
}

/** 直接进站、会落在那本书「全部」视图的访问：路径为根、查询参数为空或只有 c=那本书、没有词条深链。
   开场在数据回来之前就要决定显不显示名字行，只能看地址；数据到了以后再以实际有没有置顶为准。 */
export function isPlainFeaturedVisit() {
  if (!/^\/(index\.html)?$/.test(location.pathname)) return false;
  if (/(^|[#&])entry=/.test(location.hash)) return false;
  for (const [key, value] of new URLSearchParams(location.search)) {
    if (key !== 'c' || value !== FEATURED_CODEX_ID) return false;
  }
  return true;
}
