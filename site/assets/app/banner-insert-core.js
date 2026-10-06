/* 卷首滑出物的会话选择与封面匹配；不持有 DOM 或全局浏览状态。 */
export const BANNER_INSERT_STORAGE_KEY = 'fadian-banner-inserts-v1';
const VARIANTS = new Set(['caption', 'history', 'palette', 'index']);

export function createBannerInsertChooser({ storage = null, random = Math.random } = {}) {
  let choices = {};
  try {
    const saved = JSON.parse(storage?.getItem(BANNER_INSERT_STORAGE_KEY) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      choices = Object.fromEntries(Object.entries(saved).filter(([, value]) => VARIANTS.has(value)).slice(-80));
    }
  } catch {}
  return (codexId, candidates) => {
    const eligible = [...new Set(candidates)].filter(value => VARIANTS.has(value));
    if (!eligible.length) return '';
    if (eligible.includes(choices[codexId])) return choices[codexId];
    const pick = Math.min(eligible.length - 1, Math.max(0, Math.floor(random() * eligible.length)));
    choices[codexId] = eligible[pick];
    choices = Object.fromEntries(Object.entries(choices).slice(-80));
    try { storage?.setItem(BANNER_INSERT_STORAGE_KEY, JSON.stringify(choices)); } catch {}
    return choices[codexId];
  };
}

export function findCoverCaption(codex) {
  if (!codex?.cover) return null;
  const source = codex.coverCodexId || codex.id;
  for (const entry of codex.entries || []) {
    if ((entry.assetCodexId || codex.id) !== source) continue;
    const images = entry.images?.length ? entry.images : [{ path: entry.image }];
    const index = images.findIndex(image => image.path === codex.cover);
    if (index >= 0 && entry.title) return { entry, imageIndex: index };
  }
  return null;
}

export function matchingCoverPalette(codex, palette) {
  if (!palette || palette.image !== codex.cover
    || String(palette.assetCodexId || codex.id) !== String(codex.coverCodexId || codex.id)
    || String(palette.assetRev || '') !== String(codex.coverRev || '')) return [];
  const colors = [...new Set((Array.isArray(palette.colors) ? palette.colors : [])
    .filter(color => typeof color === 'string' && /^#[\da-f]{6}$/i.test(color)).map(color => color.toLowerCase()))].slice(0, 4);
  return colors.length >= 3 ? colors : [];
}

export function eligibleBannerInserts({ caption, history = [], colors = [], groups = [] }) {
  return [caption && 'caption', history.length >= 3 && 'history', colors.length >= 3 && 'palette', groups.length >= 2 && 'index'].filter(Boolean);
}
