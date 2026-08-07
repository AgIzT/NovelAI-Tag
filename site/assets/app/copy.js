import { state } from './state.js';
import { toast } from './feedback.js';
import { recordRecentEntry, saveBrowseStateNow } from './history.js';
import { writeClipboardText } from './clipboard.js';
import { showClipboardFallback } from './clipboard-fallback.js';
import { formatCopyText } from './nai-sd.js';
import { playCopySample } from './copy-fx.js';

export { fmtSdWeight, naiToSd } from './nai-sd.js';

const copiedClassTimers = new WeakMap();

function replayCopiedClass(node) {
  const previous = copiedClassTimers.get(node);
  if (previous) {
    clearTimeout(previous);
    node.classList.remove('copied');
    void node.offsetWidth; // 同一节点连点时强制重新建立采样环 / tag 扫光动画
  }
  node.classList.add('copied');
  const timer = setTimeout(() => {
    if (copiedClassTimers.get(node) !== timer) return;
    node.classList.remove('copied');
    copiedClassTimers.delete(node);
  }, 600);
  copiedClassTimers.set(node, timer);
}

/* 一键复制（点卡）与卡片标签预览共用的文本：正面串 + 各角色词内容，
   但**去掉 `char1：` 这个标记本身**。输出等于角色词拆分前的原文减去标记。

   为什么不是只给正面：所长两本里角色词才是 tag 大头（正面 tag 中位 8 个、角色词 26 个，
   89% 的词条角色词比正面多，623 条正面 ≤3 个 tag）。只给正面 = 点一下拿到半句话，
   复刻不出图——2026-08-07 连收两条用户反馈。
   为什么也不是连标记一起给：最初那条 SD 反馈要去掉的正是 `char1：` 这个垃圾 token，
   而不是 girl/blush 这些角色描述词（它们在 SD 里完全合法，且是画面主体）。
   ⚠ 只拼角色词的**正面**。`characterPrompts[].negative`（character N uc 那批）
   绝不能进正面串——那是"不要什么"，混进去等于反向作画。
   要按角色分槽精确填的用户走灯箱分块或卡片「全部」（那两处保留 char1/char2 标签）。 */
export function entryPromptText(e) {
  const parts = [String(e?.tags || '').trim()];
  for (const item of e?.characterPrompts || []) {
    parts.push(String(item?.prompt || '').trim());
  }
  return parts.filter(Boolean).join('\n');
}

export function combinedPromptLabel(e) {
  const prompts = e?.characterPrompts || [];
  const parts = ['正向'];
  if (prompts.length) parts.push('角色词');
  // 角色级负面（所长两本里 character N uc 拆出来的那批）也要在文案里认账
  if (String(e?.negative || '').trim() || prompts.some(item => String(item?.negative || '').trim())) {
    parts.push('负面');
  }
  return parts.join('+');
}

export async function copyEntry(e, node) {
  recordRecentEntry(e);
  saveBrowseStateNow();
  const negative = String(e.negative || '').trim();
  const charCount = (e.characterPrompts || []).length;
  // 提示这条含角色词：既解释「为什么比卡片上看到的多」，也引导想精确填槽的人去开灯箱
  const charNote = charCount ? `（含 ${charCount} 组角色词）` : '';
  const message = `${negative ? '已复制正向' : '已复制'}${charNote}：${e.title}`;
  return copyText(entryPromptText(e), message, node, {
    followUp: negative ? {
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
    replayCopiedClass(node);
  }
  /* 「采样」反馈严格排在剪贴板写入成功之后：失败路径走的是上面的手动复制面板，不该有庆祝动作 */
  playCopySample(node, formatted.text, options.sampleLabel);
  const followUp = options.followUp;
  const action = followUp?.label && String(followUp.text || '').trim()
    ? {
      label: followUp.label,
      duration: 5_000,
      onClick: () => copyText(followUp.text, followUp.message || '已复制负面', node, {
        sampleLabel: '已复制负面',
      }),
    }
    : null;
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
