import { state } from './state.js';
import { toast } from './feedback.js';
import { recordRecentEntry, saveBrowseStateNow } from './history.js';
import { writeClipboardText } from './clipboard.js';
import { showClipboardFallback } from './clipboard-fallback.js';
import { formatCopyText } from './nai-sd.js';
import { playCopySample } from './copy-fx.js';
import { relayTossTarget } from './tag-relay-rail.js';
import { prepareCopiedEntry, recordPreparedCopiedEntry } from './tag-relay-store.js';
import { snapshotLocked } from './tag-relay-snapshot.js';
import { isEntryAccessBlocked, isR18gEntry, showNsfwLockedHint, showR18gLockedHint } from './access.js';
import { findCodexMeta } from './data.js';

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
  saveBrowseStateNow(e?.id, e);
  const negative = String(e.negative || '').trim();
  const charCount = (e.characterPrompts || []).length;
  // 提示这条含角色词：既解释「为什么比卡片上看到的多」，也引导想精确填槽的人去开灯箱
  const charNote = charCount ? `（含 ${charCount} 组角色词）` : '';
  const message = `${negative ? '已复制正向' : '已复制'}${charNote}：${e.title}`;
  return copyText(entryPromptText(e), message, node, {
    entry: e,
    followUp: negative ? {
      label: '再复制负面',
      text: e.negative,
      message: `已复制负面：${e.title}`,
    } : null,
  });
}

/* 快照建不出来时的实时判定探针。只取分级要用的四个字段，**不整份展开 entry**：
   走到这条路径就说明 snapshotEntry 刚刚在 `{...entry}` 上抛过异常，再展开一次只会再炸。
   codexId 在这里就冻住（和快照同一时刻），之后的 await 期间换法典也不影响本次判定。 */
function accessProbe(entry) {
  try {
    return {
      rating: entry?.rating,
      level: entry?.level,
      path: Array.isArray(entry?._srcPath) ? entry._srcPath : (entry?.path || []),
      codexId: String(entry?._srcCodexId || state.codex?.id || '').trim(),
    };
  } catch {
    return null;   // 连字段都读不出来 → 判不了 → 交给下面按锁定处理
  }
}

/* snapshotLocked 的实时对应物，口径必须与 snapshotEntry + snapshotLocked 一致：
   词条自身的 rating / level 与 r18g 路径（复用 access.js 同一套判定），
   外加整本 NSFW 标记（快照是靠 codexId 回查 meta 拿到的，这里同样回查）。
   ⚠ 判不出来一律算「锁定」——这条路径本身就是异常兜底，不能再吞一次异常放行。 */
function probeLocked(probe) {
  if (!probe) return true;
  try {
    if (isEntryAccessBlocked(probe)) return true;
    return findCodexMeta(probe.codexId)?.nsfw === true && !state.allowNsfw;
  } catch {
    return true;
  }
}

export async function copyText(text, message, node, options = {}) {
  /* 词条归属必须在任何 await 之前冻住；否则剪贴板授权等待期间切换法典，
     snapshotEntry 会读到新的 state.codex，把刚复制的旧词条挂到错误书下。 */
  const relaySnapshot = options.entry ? prepareCopiedEntry(options.entry) : null;
  /* 有些复制仍归属于一条词条、却不应入库（例如图片的 raw tag）。用
     accessEntry 复用同一份冻结分级快照，而不是把它伪装成没有来源的普通文本。 */
  const accessSnapshot = relaySnapshot
    || (options.accessEntry ? prepareCopiedEntry(options.accessEntry) : null)
    || options.accessSnapshot
    || null;
  /* ⚠ 快照建不出来时必须 fail closed。prepareCopiedEntry 会吞掉异常返回 null，而
     accessAllowed 里 `accessSnapshot &&` 对 null 是**整条跳过**的——语义就从「不知道」
     滑成了「放行」。卡片复制（masonry 的复制负面 / 全部）唯一的分级守卫就是这份快照，
     一滑掉就是完全无守卫。
     这里退回实时判定而不是直接拒绝整次复制：null 只说明快照层出了异常（多半是
     state.codexes 尚未就绪之类的内部错误），普通词条不该被连坐；受限词条照样拦住，
     强度与快照相同，判不出来的一律算锁定。 */
  const liveGateEntry = accessSnapshot ? null : (options.entry || options.accessEntry || null);
  const liveGate = liveGateEntry ? accessProbe(liveGateEntry) : null;
  const accessAllowed = () => {
    if (accessSnapshot && snapshotLocked(accessSnapshot)) return false;
    if (liveGateEntry && probeLocked(liveGate)) return false;
    if (typeof options.accessGuard !== 'function') return true;
    try { return options.accessGuard() !== false; }
    catch { return false; }
  };
  const showAccessBlocked = () => {
    if (typeof options.onAccessBlocked === 'function') {
      options.onAccessBlocked();
      return;
    }
    const r18g = accessSnapshot
      ? accessSnapshot.access?.r18g === true
      : Boolean(liveGate && isR18gEntry(liveGate));
    if (r18g && !state.allowR18g) showR18gLockedHint();
    else showNsfwLockedHint();
  };
  if (!accessAllowed()) {
    showAccessBlocked();
    return { ok: false, blocked: true };
  }
  const formatted = formatCopyText(text, {
    sdMode: state.sdMode,
    convert: options.convert !== false,
  });
  const result = await writeClipboardText(formatted.text, {
    ...(options.clipboardOptions || {}),
    canWrite: accessAllowed,
  });
  if (!result.ok) {
    if (result.blocked) {
      showAccessBlocked();
      return result;
    }
    let manualFallbackShown = false;
    if (options.manualFallback !== false && accessAllowed()) {
      try {
        manualFallbackShown = showClipboardFallback(formatted.text, {
          trigger: node || globalThis.document?.activeElement,
        });
      } catch {
        // A broken overlay must not resurrect the old false-success path.
      }
    } else if (!accessAllowed()) {
      showAccessBlocked();
      return { ...result, blocked: true, manualFallbackShown: false };
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
  /* 复制即入库，就在这里：
     ① 排在上面的失败早退之后 —— 没真复制到就不入库，手动兜底面板那条路也天然排除；
     ② opt-in —— 不传 entry 就不入库，分享链接与所有非词条复制天然免疫；
     ③ 排在 playCopySample **之前** —— 芯片要不要抛向中转站，取决于这次到底存没存进去，
        存失败了还演一遍「收走了」就是撒谎。写盘代价是 50 条快照的 stringify，约 1ms，可以忍。 */
  const intake = relaySnapshot ? await recordPreparedCopiedEntry(relaySnapshot) : false;
  playCopySample(node, formatted.text, options.sampleLabel, {
    flyTo: intake ? relayTossTarget() : null,
  });
  const followUp = options.followUp;
  const action = followUp?.label && String(followUp.text || '').trim()
    ? {
      label: followUp.label,
      duration: 5_000,
      onClick: () => copyText(followUp.text, followUp.message || '已复制负面', node, {
        sampleLabel: '已复制负面',
        accessSnapshot,
      }),
    }
    : null;
  /* 看 options.entry 而不是 relaySnapshot：快照压根没建出来也是「没入库」，
     用户点的是词条复制，中转站里却什么都没多，这件事必须说出来。 */
  const intakeFailed = Boolean(options.entry) && !intake;
  toast(
    `${message}${formatted.converted ? '（SD 格式）' : ''}${intakeFailed ? '；中转站未保存，请重试' : ''}`,
    intakeFailed ? '!' : '✓',
    action,
  );
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
