import { normalizeRelayEntry, planItemPrompt } from './tag-relay-core.js';
import { analyzeOutput, foldRanges, outputOf, scrub, tokens, wrapWeighted } from './tag-relay-text.js';

const ZW = '\u200b';
const OFF_OPEN = `${ZW}~`, OFF_CLOSE = `~${ZW}`;
const SOURCE_MIME = 'application/x-relay-source';
const SEP = /[,，\r\n]/;
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/* 会话只存文本和旁路表。未引用的折叠记录暂不回收：浏览器撤销仍可能恢复它。 */
export function createRelayEditor({ root, onChange = () => {}, isLocked = () => false, translate = () => '', onSourceDrop,
  notify = () => {}, requestName = async () => '词组' }) {
  const session = { channel: 'positive', dedupe: true,
    positive: { text: '', folds: new Map() }, negative: { text: '', folds: new Map() } };
  const views = new Map();
  const panel = element('div', 'relay-token-panel');
  const actions = element('div', 'relay-editor-actions');
  actions.append(panel);
  /* 通道切换用站内共用的 .seg-tabs（ui-kit.css），别再造第五套。
     列数与选中位置走 JS 写的 --seg-count / --seg-index，与公告、屏蔽清单、反馈三处同源。 */
  const channels = element('div', 'seg-tabs relay-editor-channels');
  channels.setAttribute('role', 'tablist');
  channels.setAttribute('aria-label', '提示词通道');
  channels.style.setProperty('--seg-count', '2');
  const buttons = new Map();
  let panelActive = false, panelSignature = '';
  let editVersion = 0;
  const expansions = new Map();
  root.classList.add('relay-editor');
  root.replaceChildren(channels, actions);
  const here = () => session[session.channel];
  const view = () => views.get(session.channel);
  const button = (label, action, host = panel) => {
    const node = element('button', '', label);
    node.type = 'button';
    node.addEventListener('mousedown', event => event.preventDefault());
    node.addEventListener('click', action);
    host.append(node);
    return node;
  };
  for (const [channel, label] of [['positive', '正向'], ['negative', '负向']]) {
    const channelButton = element('button', '', label);
    channelButton.type = 'button';
    channelButton.setAttribute('role', 'tab');
    channelButton.id = `relayEditorTab-${channel}`;
    channelButton.setAttribute('aria-selected', 'false');
    channelButton.setAttribute('aria-controls', `relayEditorSurface-${channel}`);
    channelButton.addEventListener('click', () => switchChannel(channel));
    channels.append(channelButton);
    buttons.set(channel, channelButton);
    /* 外框加在新的一层 .relay-editor-frame 上，**不能加在 surface 上**：
       surface 里 mirror 是 position:absolute;inset:0，给它加 padding 会让镜像层偏移、
       与 textarea 的字符落点错开。外框只包一层，两层的排版参数一个都不动。 */
    const frame = element('div', 'relay-editor-frame');
    const surface = element('div', 'relay-editor-surface');
    surface.id = `relayEditorSurface-${channel}`;
    surface.setAttribute('role', 'tabpanel');
    surface.setAttribute('aria-labelledby', channelButton.id);
    const mirror = element('div', 'relay-editor-mirror');
    mirror.setAttribute('aria-hidden', 'true');
    const input = element('textarea', 'relay-editor-input');
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', `${label}提示词编辑区`);
    input.setAttribute('autocapitalize', 'off');
    surface.append(mirror, input);
    frame.append(surface);
    root.insertBefore(frame, actions);
    views.set(channel, { frame, surface, mirror, input, aliases: new Map(), duplicates: new Map(), fallback: null, writing: false, replaying: false, before: null });
    bindInput(channel);
  }
  channels.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'positive' : event.key === 'End' ? 'negative'
      : session.channel === 'positive' ? 'negative' : 'positive';
    switchChannel(next); buttons.get(next).focus();
  });

  const snapshot = input => ({ text: input.value, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection });
  function changed() {
    editVersion += 1;
    here().text = view().input.value;
    paint();
    onChange();
  }

  /* 唯一的程序写入口。正常路径完全使用原生撤销，仅命令失败后启用降级记录。 */
  function splice(start, end, text, caret) {
    const v = view(), input = v.input, before = snapshot(input);
    const next = before.text.slice(0, start) + text + before.text.slice(end);
    input.focus({ preventScroll: true });
    input.setSelectionRange(start, end);
    v.writing = true;
    try {
      let inserted = false;
      if (!v.fallback) {
        try { inserted = document.execCommand('insertText', false, text); } catch { /* 使用同一路降级 */ }
      }
      if (!inserted || input.value !== next) {
        v.fallback ||= { undo: [], redo: [] };
        input.value = next;
      }
      const at = caret ?? start + text.length;
      input.setSelectionRange(at, at);
      if (v.fallback && !v.replaying && before.text !== next) {
        v.fallback.undo.push({ before, after: snapshot(input) });
        v.fallback.redo.length = 0;
      }
    } finally { v.writing = false; }
    changed();
  }

  function fallbackHistory(redo) {
    const v = view(), history = v.fallback;
    if (!history) return;
    const source = redo ? history.redo : history.undo;
    const record = source.pop();
    if (!record) return;
    const target = redo ? record.after : record.before;
    v.replaying = true;
    try {
      splice(0, v.input.value.length, target.text, target.start);
      v.input.setSelectionRange(target.start, target.end, target.direction);
    } finally { v.replaying = false; }
    (redo ? history.undo : history.redo).push(record);
    paint();
  }

  function currentToken() {
    const at = view().input.selectionStart;
    return tokens(here().text).find(t => at >= t.start && at <= t.end) || null;
  }

  function paint() {
    const v = view();
    if (v.surface.classList.contains('is-composing')) return;
    const { text, folds } = here(), cur = currentToken();
    const duplicates = analyzeOutput(text, folds, { dedupe: session.dedupe, isLocked }).duplicateDetails;
    v.duplicates = duplicates;
    const fragment = document.createDocumentFragment();
    let at = 0;
    for (const t of tokens(text)) {
      fragment.append(text.slice(at, t.start));
      const fold = folds.get(t.fold), locked = fold && isLocked(fold);
      const span = element('span', 'relay-token', t.core);
      span.dataset.start = String(t.start);
      span.classList.toggle('is-fold', Boolean(fold));
      span.classList.toggle('is-locked', Boolean(locked));
      span.classList.toggle('is-off', t.off);
      span.classList.toggle('is-up', t.mult > 1.001);
      span.classList.toggle('is-down', t.mult < .999);
      const duplicate = duplicates.get(t.start);
      span.classList.toggle('is-duplicate', duplicate?.kind === 'token');
      span.classList.toggle('is-partial-duplicate', duplicate?.kind === 'group');
      const label = locked ? '内容已锁定' : fold ? duplicate?.kind === 'group'
        ? `合并${duplicate.count}项` : duplicate ? '整组重复' : `${tokens(fold.body).length} 项` : translate(t);
      if (label) {
        const note = element('span', 'zh');
        if (fold?.image && !locked) {
          const pic = element('img', 'pic');
          pic.src = fold.image; pic.alt = ''; pic.draggable = false;
          note.append(pic);
        }
        note.append(label); span.append(note);
      }
      fragment.append(span);
      at = t.end;
    }
    fragment.append(text.slice(at));
    /* textarea 为末尾换行保留空行；哨兵不属于正文，也不参与落点下标。 */
    if (!text || text.endsWith('\n')) {
      const end = element('span', '', ZW); end.dataset.decoration = 'true'; fragment.append(end);
    }
    v.mirror.replaceChildren(fragment);
    v.surface.classList.toggle('is-empty', !text);
    const scroll = v.surface.scrollTop;
    v.input.style.height = `${v.mirror.scrollHeight}px`;
    v.surface.scrollTop = scroll;
    paintPanel(cur, duplicates);
  }

  function rewrite(t, next) {
    if (next === t.core) return;
    const offset = view().input.selectionStart - t.start;
    splice(t.start, t.end, next, t.start + Math.min(Math.max(0, offset), next.length));
  }
  function wrapped(t, body, weight = t.mult) {
    const fold = here().folds.get(t.fold);
    if (weight <= 0 && fold && wrapWeighted(fold.body, weight) === null) return t.core;
    const value = wrapWeighted(body, weight);
    if (value === null) return t.core;
    return t.off ? `${OFF_OPEN}${value}${OFF_CLOSE}` : value;
  }
  function remove(t) {
    const text = here().text;
    let a = t.segStart, b = t.segEnd;
    if (SEP.test(text[b] || '')) b += 1;
    else if (SEP.test(text[a - 1] || '')) a -= 1;
    splice(a, b, '', a);
  }
  function expand(t) {
    const fold = here().folds.get(t.fold);
    if (!fold || isLocked(fold)) return;
    const enabled = t.off ? t.core.slice(2, -2) : t.core;
    const body = outputOf(enabled, here().folds, { dedupe: false, isLocked });
    const replacement = t.off ? `${OFF_OPEN}${body}${OFF_CLOSE}` : body;
    const channel = session.channel;
    expansions.set(`${channel}:${replacement}`, { name: t.fold, core: t.core });
    panelActive = false;
    splice(t.start, t.end, replacement, t.start + (t.off ? 2 : 0));
    const version = editVersion;
    notify(`已展开 #${t.fold}`, { label: '撤销', onClick: () => {
      if (version !== editVersion || channel !== session.channel || isLocked(fold)) return false;
      splice(t.start, t.start + replacement.length, t.core, t.start + t.core.length);
      return true;
    }, failureMessage: '内容已有变化，可选中文本折叠回词组' });
  }
  function selectedFold() {
    const input = view().input, text = input.value.slice(input.selectionStart, input.selectionEnd);
    const expanded = expansions.get(`${session.channel}:${text}`);
    const match = expanded || [...here().folds].map(([name, fold]) => ({ name, fold }))
      .find(item => item.fold.body === text);
    return { text, start: input.selectionStart, end: input.selectionEnd,
      match: match && !isLocked(here().folds.get(match.name)) ? match : null };
  }
  async function foldSelection(event) {
    const selected = selectedFold(), channel = session.channel, version = editVersion;
    if (!selected.text.trim() || foldRanges(selected.text).length) {
      notify('请先选中要折叠的普通文本'); return;
    }
    let { match } = selected;
    if (!match) {
      const proposed = await requestName({ before: panel, trigger: event?.currentTarget || view().input });
      if (!proposed || version !== editVersion || channel !== session.channel) return;
      const base = scrub(proposed).replaceAll('#', '').trim() || '词组';
      let name = base, count = 2;
      while (here().folds.has(name)) name = `${base} ${count++}`;
      here().folds.set(name, { body: scrub(selected.text), title: name, kind: 'block',
        accessKnown: true, access: { nsfw: false, r18g: false }, characters: [], addedAt: new Date().toISOString() });
      match = { name };
    }
    if (isLocked(here().folds.get(match.name))) return;
    panelActive = false;
    splice(selected.start, selected.end, match.core || `${ZW}#${match.name}${ZW}`);
  }
  function paintPanel(t, duplicates = view().duplicates) {
    if (view().selecting) return;
    const selected = selectedFold();
    const hasSelection = Boolean(selected.text.trim());
    /* 原子词组被自动选中仍是单条操作，不能误入“折叠选区”。 */
    const singleFold = t?.fold && selected.start >= t.start && selected.end <= t.end;
    panel.hidden = !panelActive || (!t && !hasSelection);
    if (panel.hidden) { if (panel.childNodes.length) panel.replaceChildren(); return; }
    const signature = JSON.stringify([session.channel, editVersion, selected.start, selected.end, t?.core,
      duplicates.get(t?.start), t?.fold && isLocked(here().folds.get(t.fold))]);
    /* selectionchange / pointerup / click 可能连发。不要在按下动作按钮后重建它。 */
    if (signature === panelSignature && panel.childNodes.length) return;
    panelSignature = signature;
    panel.replaceChildren();
    /* 选中态：面板整块换成「已选 N 项 + 折叠」，不再并列 tag 操作。 */
    if (hasSelection && !singleFold) {
      panel.append(element('span', 'relay-token-name', `已选 ${tokens(selected.text).length || 1} 项`));
      if (foldRanges(selected.text).length) {
        panel.append(element('span', 'relay-token-meaning', '先展开选中的词组，再合并文本'));
        button('展开所选词组', () => {
          let body = selected.text;
          for (const token of tokens(body).reverse()) {
            const fold = here().folds.get(token.fold);
            if (!fold || isLocked(fold)) continue;
            const enabled = token.off ? token.core.slice(2, -2) : token.core;
            const expanded = outputOf(enabled, here().folds, { dedupe: false, isLocked });
            const value = token.off ? `${OFF_OPEN}${expanded}${OFF_CLOSE}` : expanded;
            body = body.slice(0, token.start) + value + body.slice(token.end);
          }
          splice(selected.start, selected.end, body);
          view().input.setSelectionRange(selected.start, selected.start + body.length);
          panelActive = true; paintPanel(currentToken());
        }).disabled = foldRanges(selected.text).some(range => isLocked(here().folds.get(range.name)));
        return;
      }
      const name = selected.match ? `折叠回 #${selected.match.name}` : '折叠为词组';
      button(name, foldSelection);
      return;
    }
    if (!t) return;
    const fold = here().folds.get(t.fold), locked = fold && isLocked(fold);
    panel.append(element('span', 'relay-token-name', locked ? '内容已锁定' : fold ? `#${t.fold}` : t.name));
    const duplicate = duplicates.get(t.start);
    const note = duplicate?.kind === 'group' ? `组内 ${duplicate.count} 个 tag 会在输出时合并`
      : duplicate ? `${fold ? '整组' : '此 tag'}重复，输出时与第 ${duplicate.firstOrdinal} 项合并`
        : fold ? `${tokens(fold.body).length} 项` : translate(t);
    if (!locked && note) panel.append(element('span', 'relay-token-meaning', note));
    if (!locked) {
      // 按十分位整数加减，按钮始终落在 0.1 刻度，避免浮点尾数累积。
      button('−', () => rewrite(t, wrapped(t, t.body, (Math.round(t.mult * 10) - 1) / 10)));
      panel.append(element('span', 'relay-token-mult', `×${Number(t.mult.toFixed(1))}`));
      button('+', () => rewrite(t, wrapped(t, t.body, (Math.round(t.mult * 10) + 1) / 10)));
      button('清除权重', () => rewrite(t, wrapped(t, t.body, 1))).disabled = Math.abs(t.mult - 1) < .001;
      button(t.off ? '启用' : '禁用', () => rewrite(t, t.off ? t.core.slice(2, -2) : `${OFF_OPEN}${t.core}${OFF_CLOSE}`));
      if (fold) {
        button('展开', () => expand(t));
        if (fold.codexId && fold.entryId) {
          const link = element('a', 'relay-token-source', '查看来源');
          link.href = `/share/${encodeURIComponent(fold.codexId)}/${encodeURIComponent(fold.entryId)}`;
          link.target = '_blank'; link.rel = 'noopener noreferrer'; panel.append(link);
        }
      }
    }
    button('删除', () => remove(t));
  }

  function atomicSelection() {
    const v = view(), input = v.input;
    if (document.activeElement !== input || v.writing || v.selecting || v.surface.classList.contains('is-composing')) return;
    let a = input.selectionStart, b = input.selectionEnd;
    for (const range of foldRanges(input.value)) {
      if (a === b && a > range.start && a < range.end) { a = range.start; b = range.end; }
      else {
        if (a > range.start && a < range.end) a = range.start;
        if (b > range.start && b < range.end) b = range.end;
      }
    }
    if (a !== input.selectionStart || b !== input.selectionEnd) input.setSelectionRange(a, b, input.selectionDirection);
  }

  function deleteAtomic(backwards) {
    const input = view().input;
    const a = input.selectionStart, b = input.selectionEnd;
    const list = tokens(input.value);
    const hit = foldRanges(input.value).find(r => {
      const t = list.find(t => t.fold === r.name && t.start <= r.start && t.end >= r.end);
      return a === b ? backwards ? a === r.end || a === t?.end : a === r.start || a === t?.start
        : a < r.end && b > r.start;
    });
    if (!hit) return false;
    const t = tokens(input.value).find(t => t.fold === hit.name && t.start <= hit.start && t.end >= hit.end);
    const start = Math.min(a, t?.start ?? hit.start), end = Math.max(b, t?.end ?? hit.end);
    splice(start, end, '', start);
    return true;
  }

  /* mirror 的零宽字符算下标，注音和末尾哨兵不算；临时穿透 textarea 后立即恢复。 */
  function offsetAtPoint(x, y) {
    const { input, mirror } = view();
    const oldInput = input.style.pointerEvents, oldMirror = mirror.style.pointerEvents;
    try {
      input.style.pointerEvents = 'none'; mirror.style.pointerEvents = 'auto';
      const caret = document.caretPositionFromPoint?.(x, y);
      const range = caret ? null : document.caretRangeFromPoint?.(x, y);
      const node = caret?.offsetNode || range?.startContainer;
      const offset = caret?.offset ?? range?.startOffset ?? 0;
      if (!node || !mirror.contains(node)) return input.selectionStart;
      const marker = document.createRange(); marker.setStart(mirror, 0); marker.setEnd(node, offset);
      const copy = marker.cloneContents();
      copy.querySelectorAll('.zh,.pic,[data-decoration]').forEach(el => el.remove());
      return Math.min(input.value.length, copy.textContent.length);
    } finally { input.style.pointerEvents = oldInput; mirror.style.pointerEvents = oldMirror; }
  }

  function insertionAt(at) {
    const text = view().input.value;
    at = Math.max(0, Math.min(at, text.length));
    const hit = foldRanges(text).find(r => at > r.start && at < r.end);
    if (!hit) return at;
    const token = tokens(text).find(t => t.fold === hit.name && t.start <= hit.start && t.end >= hit.end);
    return at - hit.start < hit.end - at ? token?.start ?? hit.start : token?.end ?? hit.end;
  }

  function bindInput(channel) {
    const v = views.get(channel), input = v.input;
    let pointerStart = null;
    input.addEventListener('compositionstart', () => {
      v.before = snapshot(input);
      v.surface.classList.add('is-composing');
    });
    input.addEventListener('compositionend', () => {
      if (v.fallback && v.before && v.before.text !== input.value) {
        v.fallback.undo.push({ before: v.before, after: snapshot(input) }); v.fallback.redo.length = 0;
      }
      v.before = null;
      v.surface.classList.remove('is-composing'); changed();
    });
    input.addEventListener('beforeinput', event => {
      if (v.writing || event.isComposing) return;
      if (event.data && scrub(event.data) !== event.data) {
        event.preventDefault(); atomicSelection(); splice(input.selectionStart, input.selectionEnd, scrub(event.data)); return;
      }
      if (v.fallback && ['historyUndo', 'historyRedo'].includes(event.inputType)) {
        event.preventDefault(); fallbackHistory(event.inputType === 'historyRedo'); return;
      }
      if (['deleteContentBackward', 'deleteContentForward'].includes(event.inputType) && deleteAtomic(event.inputType === 'deleteContentBackward')) event.preventDefault();
      v.before = snapshot(input);
    });
    input.addEventListener('input', event => {
      if (v.writing) return;
      session[channel].text = input.value;
      if (event.isComposing || v.surface.classList.contains('is-composing')) return;
      if (v.fallback && v.before && v.before.text !== input.value) {
        v.fallback.undo.push({ before: v.before, after: snapshot(input) }); v.fallback.redo.length = 0;
      }
      v.before = null;
      panelActive = false;
      changed();
    });
    input.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape' && panelActive) {
        event.preventDefault(); event.stopPropagation(); panelActive = false; paintPanel(null); return;
      }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) panelActive = true;
      if (v.fallback && (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault(); fallbackHistory(event.shiftKey || event.key.toLowerCase() === 'y'); return;
      }
      if (['Backspace', 'Delete'].includes(event.key) && deleteAtomic(event.key === 'Backspace')) { event.preventDefault(); return; }
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey && input.selectionStart === input.selectionEnd && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        const at = input.selectionStart, right = event.key === 'ArrowRight';
        const range = foldRanges(input.value).find(r => right ? at >= r.start && at < r.end : at > r.start && at <= r.end);
        if (range) { event.preventDefault(); input.setSelectionRange(right ? range.end : range.start, right ? range.end : range.start); paintPanel(currentToken(), v.duplicates); }
      }
    });
    input.addEventListener('paste', event => {
      const text = event.clipboardData?.getData('text/plain');
      if (text === undefined) return;
      event.preventDefault(); atomicSelection(); splice(input.selectionStart, input.selectionEnd, scrub(text));
    });
    for (const type of ['copy', 'cut']) input.addEventListener(type, event => {
      atomicSelection();
      const text = input.value.slice(input.selectionStart, input.selectionEnd);
      if (!text.includes(ZW)) return;
      event.preventDefault();
      event.clipboardData?.setData('text/plain', outputOf(text, session[channel].folds, { dedupe: false, isLocked }));
      if (type === 'cut') splice(input.selectionStart, input.selectionEnd, '');
    });
    input.addEventListener('focus', () => root.closest('.tag-relay-rail')?.classList.add('is-editing'));
    input.addEventListener('blur', () => root.closest('.tag-relay-rail')?.classList.remove('is-editing'));
    input.addEventListener('pointerdown', event => {
      pointerStart = { x: event.clientX, y: event.clientY, moved: false };
      v.selecting = true;
      paintPanel(currentToken(), v.duplicates);
    });
    input.addEventListener('pointermove', event => {
      if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4) pointerStart.moved = true;
    });
    document.addEventListener('pointerup', () => {
      if (!v.selecting) return;
      v.selecting = false;
      panelActive = document.activeElement === input;
      atomicSelection(); paintPanel(currentToken(), v.duplicates);
    });
    input.addEventListener('pointercancel', () => { pointerStart = null; v.selecting = false; });
    input.addEventListener('click', event => {
      const direct = pointerStart && !pointerStart.moved && event.detail === 1
        && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
      pointerStart = null;
      /* 等原生拖选结束再更新面板，单击只选词条，不改正文。 */
      if (direct) atomicSelection();
      panelActive = true;
      paintPanel(currentToken(), v.duplicates);
    });
    /* 展开词组是双击。单击已经让位给「选中这个 tag」，不能再兼任展开。 */
    input.addEventListener('dblclick', event => {
      const at = offsetAtPoint(event.clientX, event.clientY);
      const fold = foldRanges(input.value).find(r => at >= r.start && at < r.end);
      const token = fold && tokens(input.value).find(t => t.fold === fold.name && t.start <= fold.start && t.end >= fold.end);
      if (token) { event.preventDefault(); expand(token); }
    });
    input.addEventListener('keyup', () => { atomicSelection(); paintPanel(currentToken(), v.duplicates); });
    v.surface.addEventListener('dragover', event => {
      if (![...(event.dataTransfer?.types || [])].some(type => [SOURCE_MIME, 'text/plain'].includes(type))) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
    });
    v.surface.addEventListener('drop', event => {
      const raw = event.dataTransfer?.getData(SOURCE_MIME);
      const plain = event.dataTransfer?.getData('text/plain');
      if (!raw && !plain) return;
      event.preventDefault(); event.stopPropagation();
      const at = offsetAtPoint(event.clientX, event.clientY);
      if (!raw) { const landing = insertionAt(at); splice(landing, landing, scrub(plain)); return; }
      try { const source = JSON.parse(raw); if (source && !isLocked(source)) onSourceDrop?.(source, { at, focus: true }); } catch { /* 外部拖入的损坏载荷不进入会话 */ }
    });
    let width = 0;
    new ResizeObserver(entries => {
      const next = entries[0].contentRect.width;
      if (next === width) return;
      width = next;
      requestAnimationFrame(() => { if (session.channel === channel) paint(); });
    }).observe(v.surface);
    /* 字体晚到也会改变行数；镜像是绝对定位，不由输入框高度反推。 */
    new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (session.channel !== channel) return;
        const height = v.mirror.scrollHeight;
        if (height !== input.offsetHeight) input.style.height = `${height}px`;
      });
    }).observe(v.mirror);
  }

  function switchChannel(next) {
    if (!views.has(next)) return;
    session.channel = next;
    panelActive = false;
    for (const [channel, v] of views) {
      v.frame.hidden = channel !== next;
      v.surface.hidden = channel !== next;
      const on = channel === next;
      const channelButton = buttons.get(channel);
      channelButton.setAttribute('aria-selected', String(on));
      channelButton.tabIndex = on ? 0 : -1;
    }
    /* .seg-tabs 的滑块位置靠这个自定义属性，与站内公告 / 屏蔽清单 / 反馈三处同源。 */
    channels.style.setProperty('--seg-index', String([...views.keys()].indexOf(next)));
    paint(); onChange({ content: false });
  }

  function insertSource(entry, { negativeOnly = false, focus = true, at } = {}) {
    if (!entry || isLocked(entry) || entry.channel === 'character-negative') return null;
    if (negativeOnly || entry.channel === 'negative') switchChannel('negative');
    const target = here(), input = view().input, previousFocus = document.activeElement;
    const body = scrub(session.channel === 'negative' ? entry.negative : planItemPrompt({ ...entry, prompt: entry.prompt ?? entry.tags ?? '', channel: 'positive' }));
    if (!body.trim()) return null;
    panelActive = false;
    const base = scrub(entry.title || entry.name || '词条').replaceAll('#', '').trim() || '词条';
    let name = base, n = 2;
    while (target.folds.has(name)) name = `${base} ${n++}`;
    const characters = structuredClone(entry.characters || entry.characterPrompts || []).map(character => ({ ...character,
      prompt: scrub(character.prompt), negative: scrub(character.negative) }));
    /* 保留选段身份与收入时间，避免每次保存 / 历史恢复重新生成来源元数据。 */
    target.folds.set(name, { ...normalizeRelayEntry(entry), body, title: scrub(entry.title || base),
      rating: entry.rating, level: entry.level, kind: entry.kind, characters,
      ...(Array.isArray(entry.parts) ? { parts: structuredClone(entry.parts) } : {}) });
    if (Number.isInteger(at)) {
      const landing = insertionAt(at);
      input.setSelectionRange(landing, landing);
    }
    input.focus({ preventScroll: true }); atomicSelection();
    const a = input.selectionStart, b = input.selectionEnd, before = input.value.slice(0, a), after = input.value.slice(b);
    const lead = before.trimEnd() && !SEP.test(before.trimEnd().at(-1)) ? ', ' : '';
    const tail = after.trimStart() && !SEP.test(after.trimStart()[0]) ? ', ' : '';
    splice(a, b, `${lead}${ZW}#${name}${ZW}${tail}`, a + lead.length + name.length + 3);
    if (!focus && previousFocus && previousFocus !== input) previousFocus.focus({ preventScroll: true });
    return { name, channel: session.channel };
  }

  document.addEventListener('selectionchange', () => {
    if (document.activeElement !== view().input || view().writing) return;
    if (view().input.selectionStart !== view().input.selectionEnd && !view().selecting) panelActive = true;
    atomicSelection(); paintPanel(currentToken(), view().duplicates);
  });
  /* 撤权时用无敏感名称的占位符投影输入面；提交时还原规范名称。
     重新赋值同时清掉含旧标题的原生历史，防止撤销将标题带回 DOM。 */
  function snapshotSession() {
    const result = { dedupe: session.dedupe };
    for (const channel of ['positive', 'negative']) {
      const value = session[channel], aliases = views.get(channel).aliases;
      let text = value.text;
      for (const range of foldRanges(text).reverse()) {
        const name = aliases.get(range.name);
        if (name) text = text.slice(0, range.start) + `${ZW}#${name}${ZW}` + text.slice(range.end);
      }
      result[channel] = { text, folds: Object.fromEntries([...value.folds].map(([key, fold]) =>
        [aliases.get(key) || key, structuredClone(fold)])) };
    }
    return result;
  }
  function loadPlan(plan, { preserveChannel = false } = {}) {
    const currentChannel = session.channel;
    editVersion += 1; expansions.clear();
    session.dedupe = plan?.dedupe !== false;
    for (const channel of ['positive', 'negative']) {
      const value = plan?.[channel] || { text: '', folds: {} }, v = views.get(channel);
      let text = String(value.text || '');
      const entries = value.folds instanceof Map ? [...value.folds] : Object.entries(value.folds || {});
      const folds = new Map(), aliases = new Map();
      for (const [name, fold] of entries) {
        let key = name;
        if (isLocked(fold)) {
          let n = aliases.size + 1;
          do { key = `内容已锁定 ${n++}`; } while (entries.some(([existing]) => existing === key) || folds.has(key));
          aliases.set(key, name);
          text = text.split(`${ZW}#${name}${ZW}`).join(`${ZW}#${key}${ZW}`);
        }
        folds.set(key, structuredClone(fold));
      }
      session[channel] = { text, folds }; v.aliases = aliases;
      v.input.value = text; v.fallback = null; v.before = null; v.selecting = false;
      v.surface.classList.remove('is-composing');
      v.mirror.replaceChildren();
    }
    switchChannel(preserveChannel ? currentChannel : 'positive');
  }
  function refreshAccess() {
    const canonical = snapshotSession();
    const changed = ['positive', 'negative'].some(channel => {
      const v = views.get(channel);
      return [...session[channel].folds].some(([name, fold]) => isLocked(fold) !== v.aliases.has(name));
    });
    if (changed) loadPlan(canonical, { preserveChannel: true });
    else paint();
  }
  switchChannel('positive');
  return { insertSource, splice, switchChannel, getSession: () => session, getSnapshot: snapshotSession, loadPlan, foldSelection,
    setDedupe(enabled) { session.dedupe = Boolean(enabled); paint(); onChange(); },
    render: paint, refreshAccess, focus() { view().input.focus(); } };
}
