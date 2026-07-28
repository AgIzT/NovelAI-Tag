import { state } from './state.js';
import { toast } from './feedback.js';
import { recordRecentEntry, saveBrowseStateNow } from './history.js';
import { writeClipboardText } from './clipboard.js';
import { showClipboardFallback } from './clipboard-fallback.js';
import { formatCopyText } from './nai-sd.js';
import { novelAiToastAction } from './novelai-link.js';

export { fmtSdWeight, naiToSd } from './nai-sd.js';

export async function copyEntry(e, node) {
  recordRecentEntry(e);
  saveBrowseStateNow();
  return copyText(e.tags, `已复制正向：${e.title}`, node, {
    offerNovelAi: true,
    followUp: String(e.negative || '').trim() ? {
      label: '再复制负面',
      text: e.negative,
      message: `已复制负面：${e.title}`,
    } : null,
  });
}

export async function copyText(text, message, node, options = {}) {
  const formatted = formatCopyText(text, {
    sdMode: state.sdMode,
    convert: options.convert !== false,
  });
  const result = await writeClipboardText(formatted.text, options.clipboardOptions);
  if (!result.ok) {
    let manualFallbackShown = false;
    if (options.manualFallback !== false) {
      try {
        manualFallbackShown = showClipboardFallback(formatted.text, {
          trigger: node || globalThis.document?.activeElement,
        });
      } catch {
        // A broken overlay must not resurrect the old false-success path.
      }
    }
    toast(
      manualFallbackShown
        ? '自动复制未成功，已打开手动复制面板'
        : '自动复制未成功，请长按/手动选择文本',
      '!',
    );
    return { ...result, converted: formatted.converted, manualFallbackShown };
  }

  if (node) {
    node.classList.add('copied');
    setTimeout(() => node.classList.remove('copied'), 600);
  }
  const followUp = options.followUp;
  const action = followUp?.label && String(followUp.text || '').trim()
    ? {
      label: followUp.label,
      duration: 5_000,
      onClick: () => copyText(followUp.text, followUp.message || '已复制负面', node, {
        offerNovelAi: true,
      }),
    }
    : (options.offerNovelAi ? novelAiToastAction() : null);
  toast(`${message}${formatted.converted ? '（SD 格式）' : ''}`, '✓', action);
  return { ...result, converted: formatted.converted, manualFallbackShown: false };
}

export function combinedPrompt(e) {
  const sections = [];
  if (String(e.tags || '').trim()) sections.push(String(e.tags).trim());
  for (const item of e.characterPrompts || []) {
    if (String(item.prompt || '').trim()) {
      sections.push(`${item.label || 'char'}:\n${String(item.prompt).trim()}`);
    }
  }
  if (String(e.negative || '').trim()) sections.push(`Negative:\n${String(e.negative).trim()}`);
  for (const item of e.characterPrompts || []) {
    if (String(item.negative || '').trim()) {
      sections.push(`${item.label || 'char'} Negative:\n${String(item.negative).trim()}`);
    }
  }
  return sections.join('\n\n');
}
