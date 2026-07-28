/* Clipboard capability layer. It reports the real outcome and owns no UI, so
   atlas/community pages can share it while keeping their feedback thin. */

function copyError(message, cause) {
  const error = new Error(message);
  if (cause !== undefined) error.cause = cause;
  return error;
}

function restoreFocus(element) {
  if (!element?.isConnected || typeof element.focus !== 'function') return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    // Focus restoration is best-effort and must not turn a successful copy
    // into a reported failure.
  }
}

export async function writeClipboardText(value, options = {}) {
  const text = String(value ?? '');
  const navigatorApi = options.navigatorApi === undefined ? globalThis.navigator : options.navigatorApi;
  const documentApi = options.documentApi === undefined ? globalThis.document : options.documentApi;
  const failures = [];

  if (typeof navigatorApi?.clipboard?.writeText === 'function') {
    try {
      await navigatorApi.clipboard.writeText(text);
      return { ok: true, method: 'clipboard', text };
    } catch (error) {
      failures.push(copyError('Clipboard API 写入失败', error));
    }
  }

  if (
    documentApi?.body
    && typeof documentApi.createElement === 'function'
    && typeof documentApi.execCommand === 'function'
  ) {
    const previousFocus = documentApi.activeElement;
    const area = documentApi.createElement('textarea');
    area.value = text;
    area.setAttribute?.('readonly', '');
    area.setAttribute?.('aria-hidden', 'true');
    if (area.style) {
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      area.style.top = '0';
      area.style.opacity = '0';
    }
    let copied = false;
    try {
      documentApi.body.appendChild(area);
      area.focus?.({ preventScroll: true });
      area.select?.();
      area.setSelectionRange?.(0, text.length);
      copied = documentApi.execCommand('copy') === true;
      if (!copied) failures.push(copyError('document.execCommand("copy") 返回 false'));
    } catch (error) {
      failures.push(copyError('execCommand 复制失败', error));
    } finally {
      area.remove?.();
      restoreFocus(previousFocus);
    }
    if (copied) return { ok: true, method: 'execCommand', text };
  } else {
    failures.push(copyError('当前环境没有可用的自动复制接口'));
  }

  return {
    ok: false,
    method: 'manual',
    text,
    error: failures.at(-1) || copyError('自动复制失败'),
    failures,
  };
}
