import { state } from './state.js';
import { $ } from './utils.js';
import { toast } from './feedback.js';
import { isEntryAccessBlocked, isCodexLocked } from './access.js';
import { findCodexMeta } from './data.js';
import { bindBackdropDismiss, openMask, closeMask, trapFocus, focusFirstIn } from './modal.js';
import { animateUi, cancelUiMotion } from './ui-motion.js';
import {
  getBlockingPreferences, subscribeContentBlocking, receiveBlockingStorage, contentBlockReason,
  hideContentEntry, restoreContentEntry, addBlockedWords, removeBlockedWord, setContentBlockingEnabled,
} from './content-blocking.js';

const actions = { refresh: () => {} };
let currentTab = 'words';
let shownEntries = 40;
const renderedLists = { words: new Map(), entries: new Map() };
const exitingRows = new Map();
let finishManagerMotion = null;
let resultHiddenCount = 0;

export function setBlockingUiActions(value) { Object.assign(actions, value); }

function showSaveError(result) {
  if (!result.error) return false;
  toast(result.error, '!');
  return true;
}

export function hideCard(entry) {
  const result = hideContentEntry(entry);
  if (showSaveError(result)) return;
  toast(getBlockingPreferences().enabled ? '已隐藏卡片' : '已加入屏蔽清单，屏蔽已暂停', '✓', {
    label: '撤销', onClick: () => {
      if (!showSaveError(restoreContentEntry(result.key))) toast('已撤销隐藏');
    },
  });
}

export function openBlockingManager(trigger = document.activeElement) {
  settleManagerMotion();
  renderBlockingManager({ motion: false });
  openMask($('#contentBlocking'), trigger);
}

export function updateBlockingSummary(hiddenCount = resultHiddenCount) {
  resultHiddenCount = hiddenCount;
  const prefs = getBlockingPreferences();
  const count = prefs.words.length + prefs.entries.length;
  const button = $('#blockingResultBtn');
  if (button) {
    button.textContent = count && !prefs.enabled ? '屏蔽已暂停' : (hiddenCount ? `已屏蔽 ${hiddenCount} 项` : '屏蔽管理');
    button.classList.toggle('is-on', Boolean(count && prefs.enabled));
  }
  const summary = $('#blockingSettingsSummary');
  if (summary) summary.textContent = count
    ? `${prefs.words.length} 个词 · ${prefs.entries.length} 张卡片${prefs.enabled ? '' : ' · 已暂停'}`
    : '屏蔽词与单独隐藏的卡片';
  const empty = $('#empty');
  if (empty && !state.list.length && hiddenCount && !state.searchPlan?.hasActiveSearch) {
    empty.hidden = false;
    empty.innerHTML = '<div class="empty-mark" aria-hidden="true">—</div><h2>当前结果已全部屏蔽</h2>'
      + `<p>${hiddenCount} 项命中了屏蔽清单。</p><div class="empty-actions"><button type="button">管理屏蔽</button></div>`;
    empty.querySelector('button').onclick = event => openBlockingManager(event.currentTarget);
  }
}

function settleManagerMotion() {
  finishManagerMotion?.();
  for (const finish of [...exitingRows.values()]) finish();
  for (const records of Object.values(renderedLists)) {
    for (const row of records.values()) cancelUiMotion(row);
  }
}

function snapshotBlockingList(list, records, visible) {
  if (!visible) return new Map();
  const origin = list.getBoundingClientRect();
  return new Map([...records.values()].map(row => {
    const rect = row.getBoundingClientRect();
    return [row, {
      left: rect.left - origin.left, top: rect.top - origin.top,
      width: rect.width, height: rect.height, opacity: Number(getComputedStyle(row).opacity),
    }];
  }));
}

function leaveBlockingRow(row, snapshot) {
  row.inert = true;
  row.setAttribute('aria-hidden', 'true');
  row.dataset.blockingExit = '';
  const button = row.querySelector('button');
  button.disabled = true;
  button.tabIndex = -1;
  delete button.dataset.removeWord;
  delete button.dataset.restoreEntry;
  if (!snapshot?.width || !snapshot.height) { row.remove(); return; }
  // 残影留在清单内离流；业务与焦点立即前进，不再保留能误触的删除入口。
  Object.assign(row.style, {
    position: 'absolute', left: `${snapshot.left}px`, top: `${snapshot.top}px`,
    width: `${snapshot.width}px`, height: `${snapshot.height}px`, maxWidth: 'none',
    margin: '0', boxSizing: 'border-box', pointerEvents: 'none',
  });
  row.parentElement.append(row);
  const animation = animateUi(row, [
    { opacity: snapshot.opacity, translate: '0 0', scale: '1' },
    { opacity: 0, translate: '0 -4px', scale: '.97' },
  ], { duration: 160 });
  if (!animation) { row.remove(); return; }
  let timer;
  const finish = () => {
    if (exitingRows.get(row) !== finish) return;
    exitingRows.delete(row);
    clearTimeout(timer);
    cancelUiMotion(row);
    row.remove();
  };
  exitingRows.set(row, finish);
  timer = setTimeout(finish, 240);
  animation.finished.then(finish, finish);
}

function reconcileBlockingList(kind, list, items, snapshots, visible, motions) {
  const previous = renderedLists[kind];
  const next = new Map();
  for (const item of items) {
    const key = kind === 'words' ? item : item.key;
    let row = previous.get(key);
    if (!row) {
      row = document.createElement('li');
      row.innerHTML = kind === 'words' ? '<span></span><button type="button">×</button>'
        : '<div><b></b><span></span></div><button type="button" class="panel-action is-sm">恢复</button>';
    }
    const button = row.querySelector('button');
    if (kind === 'words') {
      row.querySelector('span').textContent = item;
      button.dataset.removeWord = item;
      button.setAttribute('aria-label', `取消屏蔽 ${item}`);
    } else {
      const locked = isCodexLocked(findCodexMeta(item.codexId)) || isEntryAccessBlocked({ ...item, _srcCodexId: item.codexId });
      const title = locked ? '受限卡片' : item.title;
      row.querySelector('b').textContent = title;
      row.querySelector('span').textContent = locked ? '开启相应内容分级后可查看名称' : item.codexTitle;
      button.dataset.restoreEntry = item.key;
      button.setAttribute('aria-label', `恢复 ${title}`);
    }
    next.set(key, row);
  }
  for (const [key, row] of previous) {
    if (!next.has(key)) leaveBlockingRow(row, snapshots.get(row));
  }
  const rows = [...next.values()];
  rows.forEach((row, index) => {
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    row.classList.toggle('is-last', index === rows.length - 1);
  });
  renderedLists[kind] = next;
  if (!visible) return;
  const origin = list.getBoundingClientRect();
  const positions = rows.map(row => row.getBoundingClientRect());
  rows.forEach((row, index) => {
    const before = snapshots.get(row);
    const x = before ? before.left - (positions[index].left - origin.left) : 0;
    const y = before ? before.top - (positions[index].top - origin.top) : 4;
    if (!before || Math.abs(x) > .5 || Math.abs(y) > .5 || before.opacity < .99) {
      const animation = animateUi(row, [
        { opacity: before?.opacity ?? 0, translate: `${x}px ${y}px` },
        { opacity: 1, translate: '0 0' },
      ]);
      if (animation) motions.set(row, animation);
    }
  });
}

function renderBlockingManager({ tab = currentTab, motion = true } = {}) {
  const prefs = getBlockingPreferences();
  const mask = $('#contentBlocking');
  if (!mask) return;
  const shell = mask.querySelector('.blocking-views');
  const views = { words: $('#blockingWordsPanel'), entries: $('#blockingEntriesPanel') };
  const lists = { words: $('#blockingWordList'), entries: $('#blockingEntryList') };
  const moving = Boolean(motion && !mask.hidden && mask.classList.contains('show'));
  const previousTab = currentTab;
  const previousView = views[previousTab];
  const oldHeight = moving ? shell.getBoundingClientRect().height : 0;
  const oldOpacity = moving ? getComputedStyle(previousView).opacity : '1';
  const oldTranslate = moving ? getComputedStyle(previousView).translate : 'none';
  const snapshots = Object.fromEntries(Object.entries(lists).map(([kind, list]) => [kind,
    snapshotBlockingList(list, renderedLists[kind], moving && kind === previousTab && tab === previousTab),
  ]));
  const focused = document.activeElement;
  const focusedRows = [...renderedLists[previousTab].values()];
  const focusedIndex = focusedRows.findIndex(row => row.contains(focused));
  // 快速操作先取画面中的位置与高度，再结清旧轮；迟到回调不能收起新的当前页。
  settleManagerMotion();
  currentTab = tab;
  const motions = new Map();
  $('#blockingEnabled').checked = prefs.enabled;
  $('#blockingPaused').hidden = prefs.enabled;
  $('#blockingWordsTab').textContent = `屏蔽词 ${prefs.words.length}`;
  $('#blockingEntriesTab').textContent = `单独隐藏 ${prefs.entries.length}`;
  mask.querySelector('.blocking-tabs')?.style.setProperty('--seg-index', currentTab === 'entries' ? '1' : '0');
  for (const tab of mask.querySelectorAll('[data-blocking-tab]')) {
    const active = tab.dataset.blockingTab === currentTab;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  for (const [kind, view] of Object.entries(views)) {
    view.hidden = kind !== currentTab;
    view.inert = kind !== currentTab;
    view.setAttribute('aria-hidden', String(kind !== currentTab));
  }
  reconcileBlockingList('words', lists.words, prefs.words, snapshots.words, moving && tab === previousTab && tab === 'words', motions);
  reconcileBlockingList('entries', lists.entries, prefs.entries.slice(0, shownEntries), snapshots.entries,
    moving && tab === previousTab && tab === 'entries', motions);
  $('#blockingWordsEmpty').hidden = Boolean(prefs.words.length);
  $('#blockingEntriesEmpty').hidden = Boolean(prefs.entries.length);
  $('#blockingMoreEntries').hidden = prefs.entries.length <= shownEntries;
  if (moving) animateManagerChange(shell, views, { previousTab, oldHeight, oldOpacity, oldTranslate, motions });
  if (moving && tab === previousTab && focusedIndex >= 0) {
    const retained = [...renderedLists[tab].values()];
    const target = focused.isConnected && !focused.closest('[inert]') ? focused
      : retained[Math.min(focusedIndex, retained.length - 1)]?.querySelector('button')
        || (tab === 'words' ? $('#blockingWordInput') : $('#blockingEntriesTab'));
    if (document.activeElement !== target) target.focus({ preventScroll: true });
  }
}

function animateManagerChange(shell, views, { previousTab, oldHeight, oldOpacity, oldTranslate, motions }) {
  const previous = views[previousTab];
  const next = views[currentTab];
  const changedTab = previous !== next;
  const newHeight = shell.getBoundingClientRect().height;
  const shellStyle = shell.style.cssText;
  const previousStyle = previous.style.cssText;
  let timer;
  const finish = () => {
    if (finishManagerMotion !== finish) return;
    finishManagerMotion = null;
    clearTimeout(timer);
    for (const element of motions.keys()) cancelUiMotion(element);
    if (changedTab) previous.hidden = true;
    previous.style.cssText = previousStyle;
    shell.style.cssText = shellStyle;
  };
  finishManagerMotion = finish;
  const play = (element, frames, options) => {
    const animation = animateUi(element, frames, options);
    if (animation) motions.set(element, animation);
    return animation;
  };
  if (changedTab) {
    const direction = currentTab === 'entries' ? 1 : -1;
    previous.hidden = false;
    Object.assign(previous.style, { position: 'absolute', inset: '0 0 auto', pointerEvents: 'none' });
    const outgoing = play(previous, [
      { opacity: oldOpacity, translate: oldTranslate }, { opacity: 0, translate: `${-direction * 8}px 0` },
    ], { duration: 150, easing: 'ease-out' });
    play(next, [{ opacity: 0, translate: `${direction * 10}px 0` }, { opacity: 1, translate: '0 0' }]);
    outgoing?.finished.then(() => { if (finishManagerMotion === finish) previous.hidden = true; }, () => {});
  }
  if (Math.abs(oldHeight - newHeight) > .5) {
    play(shell, [{ height: `${oldHeight}px` }, { height: `${newHeight}px` }]);
  }
  if (!motions.size) { finish(); return; }
  shell.style.overflow = 'clip';
  timer = setTimeout(finish, 320);
  Promise.allSettled([...motions.values()].map(animation => animation.finished)).then(finish);
}

export function promptBlockedEntry(entry, reveal) {
  const reason = contentBlockReason(entry);
  if (!reason) { reveal(); return; }
  const mask = $('#blockingReveal');
  if (!mask) return;
  $('#blockingRevealReason').textContent = reason.type === 'word'
    ? `命中屏蔽词「${reason.word}」。` : '这张卡片已在屏蔽清单中。';
  const sourceId = entry._srcCodexId || state.codex?.id;
  $('#blockingRevealOnce').onclick = () => {
    if (sourceId !== (entry._srcCodexId || state.codex?.id)) { closeMask(mask); return; }
    closeMask(mask, { historyMode: 'none' });
    reveal();
  };
  openMask(mask);
}

export function setupContentBlocking() {
  const mask = $('#contentBlocking');
  if (!mask) return;
  // 浏览器 Back 也会走共享遮罩状态；关闭时清掉退场残影和未完成的高度动画。
  new MutationObserver(() => {
    if (mask.hidden || !mask.classList.contains('show')) settleManagerMotion();
  }).observe(mask, { attributes: true, attributeFilter: ['class', 'hidden'] });
  const closePanel = panel => {
    if (panel === mask) settleManagerMotion();
    closeMask(panel);
  };
  $('#blockingSettingsBtn').onclick = event => openBlockingManager(event.currentTarget);
  $('#blockingResultBtn').onclick = event => openBlockingManager(event.currentTarget);
  for (const [id, closeId] of [['contentBlocking', 'blockingClose'], ['blockingReveal', 'blockingRevealClose']]) {
    const panel = $(`#${id}`);
    $(`#${closeId}`).onclick = () => closePanel(panel);
    bindBackdropDismiss(panel, () => closePanel(panel));
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePanel(panel); }
      else trapFocus(event, panel);
    });
  }
  $('#blockingRevealCancel').onclick = () => closeMask($('#blockingReveal'));
  // 拖选到遮罩外后焦点可能落回 body；仍由最上层窗口接住 Esc。
  document.addEventListener('keydown', event => {
    const top = ['contentBlocking', 'blockingReveal'].map(id => $(`#${id}`)).find(panel => panel.classList.contains('show'));
    if (!top) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      closePanel(top);
    } else if (event.key === 'Tab' && !top.contains(document.activeElement)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      focusFirstIn(top);
    }
  }, true);
  $('#blockingRevealManage').onclick = event => openBlockingManager(event.currentTarget);
  $('#blockingEnabled').onchange = event => {
    if (showSaveError(setContentBlockingEnabled(event.target.checked))) renderBlockingManager();
  };
  const chooseTab = tab => {
    if (currentTab !== tab.dataset.blockingTab) renderBlockingManager({ tab: tab.dataset.blockingTab });
    tab.focus({ preventScroll: true });
  };
  const tabs = [...mask.querySelectorAll('[data-blocking-tab]')];
  tabs.forEach((tab, index) => {
    tab.onclick = () => chooseTab(tab);
    tab.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      chooseTab(tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + 1) % tabs.length]);
    };
  });
  $('#blockingWordInput').oninput = event => {
    $('#blockingWordError').hidden = true;
    event.target.setAttribute('aria-invalid', 'false');
  };
  $('#blockingWordForm').onsubmit = event => {
    event.preventDefault();
    const input = $('#blockingWordInput');
    const result = addBlockedWords(input.value);
    const error = $('#blockingWordError');
    error.textContent = result.error || '';
    error.hidden = !result.error;
    input.setAttribute('aria-invalid', String(Boolean(result.error)));
    if (!result.error) input.value = '';
    input.focus();
  };
  $('#blockingWordList').onclick = event => {
    const button = event.target.closest('[data-remove-word]');
    if (button && !button.closest('[inert]')) showSaveError(removeBlockedWord(button.dataset.removeWord));
  };
  $('#blockingEntryList').onclick = event => {
    const button = event.target.closest('[data-restore-entry]');
    if (button && !button.closest('[inert]')) showSaveError(restoreContentEntry(button.dataset.restoreEntry));
  };
  $('#blockingMoreEntries').onclick = () => { shownEntries += 40; renderBlockingManager(); };
  subscribeContentBlocking(() => { actions.refresh(); renderBlockingManager(); updateBlockingSummary(); });
  window.addEventListener('storage', receiveBlockingStorage);
  document.addEventListener('codex:loaded', renderBlockingManager);
  renderBlockingManager();
  updateBlockingSummary();
}
