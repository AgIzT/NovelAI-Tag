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

function copyStillAllowed(options) {
  if (typeof options.canWrite !== 'function') return true;
  try {
    return options.canWrite() !== false;
  } catch {
    /* 权限判断本身异常时必须 fail closed，不能借降级路径继续写入。 */
    return false;
  }
}

function blockedResult() {
  return { ok: false, blocked: true, method: 'blocked', text: '' };
}

export async function writeClipboardText(value, options = {}) {
  const text = String(value ?? '');
  const navigatorApi = options.navigatorApi === undefined ? globalThis.navigator : options.navigatorApi;
  const documentApi = options.documentApi === undefined ? globalThis.document : options.documentApi;
  const failures = [];

  if (!copyStillAllowed(options)) return blockedResult();

  if (typeof navigatorApi?.clipboard?.writeText === 'function') {
    try {
      await navigatorApi.clipboard.writeText(text);
      /* Clipboard API 等待期间另一标签页可能撤权。写入本身无法撤销，但至少不能
         把这次结果继续当成可展示、可入库的成功。 */
      if (!copyStillAllowed(options)) return blockedResult();
      return { ok: true, method: 'clipboard', text };
    } catch (error) {
      failures.push(copyError('Clipboard API 写入失败', error));
    }
  }

  /* 最关键的二次守卫：Clipboard API 异步失败后，不能在已经撤权的状态下
     继续降级到 execCommand。 */
  if (!copyStillAllowed(options)) return blockedResult();

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
      if (!copyStillAllowed(options)) return blockedResult();
      copied = documentApi.execCommand('copy') === true;
      if (!copied) failures.push(copyError('document.execCommand("copy") 返回 false'));
    } catch (error) {
      failures.push(copyError('execCommand 复制失败', error));
    } finally {
      area.remove?.();
      restoreFocus(previousFocus);
    }
    if (!copyStillAllowed(options)) return blockedResult();
    if (copied) return { ok: true, method: 'execCommand', text };
  } else {
    failures.push(copyError('当前环境没有可用的自动复制接口'));
  }

  if (!copyStillAllowed(options)) return blockedResult();
  return {
    ok: false,
    method: 'manual',
    text,
    error: failures.at(-1) || copyError('自动复制失败'),
    failures,
  };
}
