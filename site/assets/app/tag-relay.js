import { isEntryNsfw, isR18gPath } from './access.js';
import { findCodexMeta } from './data.js';
import { toast } from './feedback.js';
import { hasEntryImage, thumbUrl } from './media.js';
import { closeMask, openMask, trapFocus } from './modal.js';
import { state } from './state.js';
import {
  TAG_RELAY_STORAGE_KEY,
  addInboxEntry,
  clearInbox,
  loadRelayState,
  normalizeRelayState,
  removeInboxEntry,
  saveRelayState,
  stableEntryKey,
} from './tag-relay-core.js';

let relayState = null;
let relayBound = false;

function sourceContext(entry) {
  const codexId = String(entry?._srcCodexId || state.codex?.id || '').trim();
  const meta = findCodexMeta(codexId);
  return {
    codexId,
    codexTitle: String(entry?._srcCodexTitle || meta?.selectorTitle || meta?.title || state.codex?.title || '').trim(),
    meta,
  };
}

function relayKey(entry) {
  const context = sourceContext(entry);
  return stableEntryKey(entry, { codexId: context.codexId });
}

function snapshotEntry(entry) {
  const context = sourceContext(entry);
  const path = Array.isArray(entry?._srcPath) ? entry._srcPath : (entry?.path || []);
  let image = '';
  try {
    if (hasEntryImage(entry)) image = thumbUrl(entry);
  } catch {
    image = '';
  }
  return {
    ...entry,
    codexId: context.codexId,
    entryId: entry?.id,
    book: context.codexTitle,
    path,
    image,
    access: {
      nsfw: context.meta?.nsfw === true || isEntryNsfw(entry),
      r18g: isR18gPath(path),
    },
  };
}

function cloneRelayState(value) {
  try {
    return normalizeRelayState(structuredClone(value));
  } catch {
    return normalizeRelayState(JSON.parse(JSON.stringify(value)));
  }
}

function notifyRelayChanged() {
  document.dispatchEvent(new CustomEvent('tag-relay:changed', {
    detail: { state: relayState },
  }));
}

function commitRelay(mutator) {
  const next = cloneRelayState(relayState);
  const result = mutator(next);
  if (!saveRelayState(next)) {
    toast('中转站保存失败，请检查浏览器存储权限', '!');
    return { ok: false, result };
  }
  relayState = next;
  renderRelayChrome();
  notifyRelayChanged();
  return { ok: true, result };
}

function snapshotLocked(entry) {
  if (entry?.access?.nsfw && !state.allowNsfw) return true;
  if (entry?.access?.r18g && !state.allowR18g) return true;
  return false;
}

function setStageButtonState(button, staged) {
  if (!button) return;
  const label = staged ? '已在 Tag 中转站，点击移除' : '加入 Tag 中转站';
  button.classList.toggle('on', staged);
  button.setAttribute('aria-pressed', String(staged));
  button.title = label;
  button.setAttribute('aria-label', label);
  if (button.id === 'stageLightbox') button.textContent = staged ? '已加入中转站' : '加入中转站';
}

export function isEntryStaged(entry) {
  if (!relayState) relayState = loadRelayState();
  const key = relayKey(entry);
  return relayState.inbox.some(item => item.key === key);
}

function syncRenderedStageButtons() {
  if (state.nodes instanceof Map && Array.isArray(state.list)) {
    for (const [index, node] of state.nodes) {
      const entry = state.list[index];
      if (!entry) continue;
      setStageButtonState(node?.querySelector?.('.stage-btn'), isEntryStaged(entry));
    }
  }
  const current = state.lightbox?.entry;
  setStageButtonState(document.querySelector('#stageLightbox'), current ? isEntryStaged(current) : false);
}

export function toggleEntryStage(entry, trigger) {
  const key = relayKey(entry);
  const staged = relayState.inbox.some(item => item.key === key);
  const action = commitRelay(next => (
    staged
      ? removeInboxEntry(next, key)
      : addInboxEntry(next, snapshotEntry(entry), sourceContext(entry))
  ));
  if (!action.ok) return false;
  const nowStaged = !staged;
  setStageButtonState(trigger, nowStaged);
  syncRenderedStageButtons();
  toast(nowStaged ? `已加入中转站：${entry.title}` : `已移出中转站：${entry.title}`, nowStaged ? '+' : '−');
  return nowStaged;
}

function placeholder(title = '') {
  const node = document.createElement('span');
  node.className = 'tag-relay-quick-thumb is-placeholder';
  node.textContent = String(title || 'T').trim().slice(0, 1).toUpperCase() || 'T';
  return node;
}

function quickItem(entry) {
  const locked = snapshotLocked(entry);
  const item = document.createElement('article');
  item.className = 'tag-relay-quick-item';

  if (!locked && entry.image) {
    const image = document.createElement('img');
    image.className = 'tag-relay-quick-thumb';
    image.src = entry.image;
    image.alt = '';
    image.loading = 'lazy';
    image.onerror = () => image.replaceWith(placeholder(entry.title));
    item.append(image);
  } else {
    item.append(placeholder(locked ? '锁' : entry.title));
  }

  const copy = document.createElement('div');
  copy.className = 'tag-relay-quick-copy';
  const title = document.createElement('b');
  title.textContent = locked ? '已锁定的成人内容' : entry.title;
  const prompt = document.createElement('small');
  prompt.textContent = locked
    ? '重新开启对应内容权限后可继续使用'
    : (entry.prompt || entry.negative || entry.path?.join?.(' › ') || entry.book || '待整理词条');
  copy.append(title, prompt);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'tag-relay-quick-remove';
  remove.textContent = '×';
  remove.title = `移除${entry.title}`;
  remove.setAttribute('aria-label', `从中转站移除${entry.title}`);
  remove.onclick = () => {
    const result = commitRelay(next => removeInboxEntry(next, entry.key));
    if (!result.ok) return;
    syncRenderedStageButtons();
    toast(`已移出中转站：${entry.title}`, '−');
  };
  item.append(copy, remove);
  return item;
}

function renderQuickList() {
  const list = document.querySelector('#tagRelayQuickList');
  const empty = document.querySelector('#tagRelayQuickEmpty');
  if (!list || !empty) return;
  list.replaceChildren(...relayState.inbox.slice().reverse().map(quickItem));
  list.hidden = relayState.inbox.length === 0;
  empty.hidden = relayState.inbox.length !== 0;
}

function renderRelayChrome() {
  if (!relayState) return;
  const count = relayState.inbox.length;
  const badge = document.querySelector('#tagRelayCount');
  if (badge) {
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? '99+' : String(count);
  }
  const button = document.querySelector('#tagRelayBtn');
  if (button) {
    button.title = count ? `Tag 中转站 · ${count} 条待整理` : '打开 Tag 中转站暂存区';
    button.setAttribute('aria-label', button.title);
  }
  const menuHint = document.querySelector('#tagRelayMenuLink small');
  if (menuHint) menuHint.textContent = count ? `${count} 条待整理 · 进入排列组合` : '暂存词条 · 排列组合 · 一键复制';
  const clear = document.querySelector('#tagRelayClear');
  if (clear) clear.disabled = count === 0;
  renderQuickList();
  syncRenderedStageButtons();
}

function bindQuickPanel() {
  const mask = document.querySelector('#tagRelayQuick');
  const open = document.querySelector('#tagRelayBtn');
  const close = document.querySelector('#tagRelayQuickClose');
  const clear = document.querySelector('#tagRelayClear');
  if (!mask || !open || !close || !clear) return;

  open.onclick = () => {
    renderRelayChrome();
    openMask(mask, open);
  };
  close.onclick = () => closeMask(mask);
  mask.onclick = event => {
    if (event.target === mask) closeMask(mask);
  };
  mask.onkeydown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMask(mask);
      return;
    }
    trapFocus(event, mask);
  };
  clear.onclick = () => {
    if (!relayState.inbox.length) return;
    if (!window.confirm(`确认清空 ${relayState.inbox.length} 条暂存词条？方案和复制记录不会受影响。`)) return;
    const result = commitRelay(next => clearInbox(next));
    if (!result.ok) return;
    syncRenderedStageButtons();
    toast('已清空中转站暂存区', '✓');
  };
}

function bindLightboxStage() {
  document.addEventListener('lightbox:rendered', event => {
    const entry = event.detail?.entry;
    const button = document.querySelector('#stageLightbox');
    if (!entry || !button) return;
    setStageButtonState(button, isEntryStaged(entry));
    button.onclick = click => {
      click.stopPropagation();
      toggleEntryStage(entry, button);
    };
  });
}

export function setupTagRelay() {
  if (!relayState) relayState = loadRelayState();
  if (!relayBound) {
    relayBound = true;
    bindQuickPanel();
    bindLightboxStage();
    window.addEventListener('storage', event => {
      if (event.key !== TAG_RELAY_STORAGE_KEY) return;
      relayState = loadRelayState();
      renderRelayChrome();
    });
    window.addEventListener('pageshow', () => {
      relayState = loadRelayState();
      renderRelayChrome();
    });
  }
  renderRelayChrome();
  return {
    isStaged: isEntryStaged,
    toggleStage: toggleEntryStage,
  };
}
