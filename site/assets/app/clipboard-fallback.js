import { closeMask, isMaskOpen, openMask, trapFocus, bindBackdropDismiss } from './modal.js';

const MASK_ID = 'clipboardFallback';

function selectFallbackText(area) {
  if (!area) return;
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, area.value.length);
  } catch {
    // Mobile WebViews differ in selection support. The textarea stays visible
    // and readonly, so long-press selection remains available.
  }
}

function ensureClipboardFallback() {
  if (!globalThis.document?.body) return null;
  const existing = document.getElementById(MASK_ID);
  if (existing) return existing;

  const mask = document.createElement('div');
  mask.id = MASK_ID;
  mask.className = 'favorites-backup-mask clipboard-fallback-mask';
  mask.hidden = true;
  mask.innerHTML = `
    <section class="favorites-backup-dialog clipboard-fallback-dialog" role="dialog" aria-modal="true" aria-labelledby="clipboardFallbackTitle" aria-describedby="clipboardFallbackDesc">
      <header class="favorites-backup-header">
        <div class="favorites-backup-title-row">
          <span class="favorites-backup-mark" aria-hidden="true">!</span>
          <div>
            <h2 id="clipboardFallbackTitle">自动复制未成功</h2>
            <p id="clipboardFallbackDesc">文本已在下方全选。请长按复制，或按 Ctrl/Cmd+C 手动复制。</p>
          </div>
        </div>
        <button class="favorites-backup-close" type="button" data-clipboard-close aria-label="关闭手动复制面板">×</button>
      </header>
      <div class="favorites-backup-body clipboard-fallback-body">
        <textarea class="clipboard-fallback-text" rows="10" readonly spellcheck="false" autocapitalize="off" aria-label="需要手动复制的文本"></textarea>
      </div>
      <footer class="favorites-backup-footer clipboard-fallback-footer">
        <span class="favorites-backup-status" aria-live="polite">文本已全选</span>
        <div class="clipboard-fallback-actions">
          <button class="favorites-backup-secondary" type="button" data-clipboard-select>重新选择全部</button>
          <button class="favorites-backup-primary" type="button" data-clipboard-close>关闭</button>
        </div>
      </footer>
    </section>`;
  document.body.appendChild(mask);

  const close = () => closeMask(mask);
  mask.querySelectorAll('[data-clipboard-close]').forEach(button => {
    button.addEventListener('click', close);
  });
  mask.querySelector('[data-clipboard-select]')?.addEventListener('click', () => {
    selectFallbackText(mask.querySelector('.clipboard-fallback-text'));
  });
  bindBackdropDismiss(mask, () => close());
  mask.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    trapFocus(event, mask);
  });
  return mask;
}

export function showClipboardFallback(text, { trigger, historyMode = 'push' } = {}) {
  const mask = ensureClipboardFallback();
  if (!mask) return false;
  const area = mask.querySelector('.clipboard-fallback-text');
  area.value = String(text ?? '');
  const alreadyOpen = isMaskOpen(mask);
  if (!alreadyOpen) openMask(mask, trigger, { historyMode });
  requestAnimationFrame(() => requestAnimationFrame(() => selectFallbackText(area)));
  return true;
}

export function closeClipboardFallback(options) {
  const mask = globalThis.document?.getElementById?.(MASK_ID);
  if (mask) closeMask(mask, options);
}

/* 撤销内容权限时，关闭动画期间也不能继续把原文留在 textarea / 可访问树里。 */
export function scrubClipboardFallback(options) {
  const mask = globalThis.document?.getElementById?.(MASK_ID);
  if (!mask) return false;
  const area = mask.querySelector?.('.clipboard-fallback-text');
  if (area) area.value = '';
  if (isMaskOpen(mask)) closeMask(mask, options);
  return true;
}
