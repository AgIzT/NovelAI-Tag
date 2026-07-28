import { isTouchPrimaryInput } from './utils.js';

export const NOVELAI_IMAGE_URL = 'https://novelai.net/image';
export const NOVELAI_WINDOW_NAME = 'fadian-novelai-image';

export function canOfferNovelAiLink({
  navigatorApi = globalThis.navigator,
  matchMediaApi = globalThis.window?.matchMedia?.bind(globalThis.window),
} = {}) {
  return isTouchPrimaryInput({ navigatorApi, matchMediaApi });
}

export function openNovelAiImage({ windowApi = globalThis.window } = {}) {
  try {
    const opened = windowApi?.open?.(NOVELAI_IMAGE_URL, NOVELAI_WINDOW_NAME);
    if (!opened) return false;
    try {
      opened.opener = null;
    } catch {}
    return true;
  } catch {
    return false;
  }
}

export function novelAiToastAction(options = {}) {
  if (!canOfferNovelAiLink(options)) return null;
  return {
    label: '打开 NovelAI（需粘贴）↗',
    duration: 5_000,
    onClick: () => openNovelAiImage(options),
    failureMessage: '浏览器未能打开 NovelAI，请检查弹窗设置',
  };
}
