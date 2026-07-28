import { SD_MODE_STORAGE_KEY, readSdMode, writeSdMode } from '../app/sd-mode.js';

let sessionMode = null;

function renderCommunitySdMode(enabled) {
  globalThis.document?.body?.classList?.toggle('sd-mode', enabled);
  const badge = globalThis.document?.getElementById?.('communitySdBadge');
  if (!badge) return;
  badge.hidden = !enabled;
  badge.setAttribute('aria-hidden', enabled ? 'false' : 'true');
}

export function isCommunitySdModeEnabled() {
  return sessionMode === null ? readSdMode() : sessionMode;
}

export function setCommunitySdMode(enabled, { persist = true } = {}) {
  sessionMode = Boolean(enabled);
  if (persist) writeSdMode(sessionMode);
  renderCommunitySdMode(sessionMode);
  return sessionMode;
}

export function initCommunitySdMode() {
  setCommunitySdMode(readSdMode(), { persist: false });
  globalThis.document?.getElementById?.('communitySdBadge')?.addEventListener('click', () => {
    setCommunitySdMode(false);
  });
  globalThis.addEventListener?.('storage', event => {
    if (event.key !== SD_MODE_STORAGE_KEY) return;
    setCommunitySdMode(event.newValue === '1', { persist: false });
  });
}
