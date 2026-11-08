/* 进站时首屏落在哪本法典。init()（app.js）与首屏数据预热（first-screen-prewarm.js）共用这一份规则：
   两边不一致时预热会白下一本书，所以只在这里写一次。纯函数，不读全局状态，也不引入其它模块，
   预热模块在主模块图下完之前就要用它。 */

export function codexMatches(codex, id) {
  if (!codex || !id) return false;
  return codex.id === id || (codex.aliases || []).includes(id);
}

/* 地址里点名的书：根级 /share/<法典>/<词条>，其次是 ?c= / ?codex=。与 router.js 的 readUrlState 同序。 */
export function requestedCodexFromLocation(loc = globalThis.location) {
  const parts = String(loc?.pathname || '').split('/').filter(Boolean);
  if (parts[0] === 'share' && parts.length >= 2) {
    try {
      return decodeURIComponent(parts[1]).trim();
    } catch {
      return String(parts[1] || '').trim();
    }
  }
  const params = new URLSearchParams(String(loc?.search || ''));
  return params.get('c') || params.get('codex') || '';
}

/* 点名的书未锁就用它；否则生日期的默认书；再否则第一本未锁的书；全锁时退回第一本。 */
export function pickInitialCodex({ codexes, requested = '', birthdayId = '', isLocked = () => false }) {
  const list = Array.isArray(codexes) ? codexes : [];
  const find = id => (id ? list.find(codex => codexMatches(codex, id)) : undefined);
  const requestedMeta = find(requested);
  if (requestedMeta && !isLocked(requestedMeta)) return requestedMeta;
  const birthdayMeta = find(birthdayId);
  if (birthdayMeta && !isLocked(birthdayMeta)) return birthdayMeta;
  return list.find(codex => !isLocked(codex)) || list[0] || null;
}
