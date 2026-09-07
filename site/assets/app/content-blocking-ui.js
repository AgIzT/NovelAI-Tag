import { state } from './state.js';
import { $, esc } from './utils.js';
import { toast } from './feedback.js';
import { isEntryAccessBlocked, isCodexLocked } from './access.js';
import { findCodexMeta } from './data.js';
import { bindBackdropDismiss, openMask, closeMask, trapFocus, focusFirstIn } from './modal.js';
import {
  getBlockingPreferences, subscribeContentBlocking, receiveBlockingStorage, contentBlockReason,
  hideContentEntry, restoreContentEntry, addBlockedWords, removeBlockedWord, setContentBlockingEnabled,
} from './content-blocking.js';

const actions = { refresh: () => {} };
let currentTab = 'words';
let shownEntries = 40;
let renderedWords = new Set();   // 只给真正新增的屏蔽词加入场动画，整表重绘不闪
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
  renderBlockingManager();
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

function renderBlockingManager() {
  const prefs = getBlockingPreferences();
  const mask = $('#contentBlocking');
  if (!mask) return;
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
  $('#blockingWordsPanel').hidden = currentTab !== 'words';
  $('#blockingEntriesPanel').hidden = currentTab !== 'entries';
  $('#blockingWordList').innerHTML = prefs.words.map(word => `<li${renderedWords.has(word) ? '' : ' class="is-new"'}><span>${esc(word)}</span><button type="button" data-remove-word="${esc(word)}" aria-label="取消屏蔽 ${esc(word)}">×</button></li>`).join('');
  renderedWords = new Set(prefs.words);
  $('#blockingWordsEmpty').hidden = Boolean(prefs.words.length);
  $('#blockingEntryList').innerHTML = prefs.entries.slice(0, shownEntries).map(item => {
    const locked = isCodexLocked(findCodexMeta(item.codexId)) || isEntryAccessBlocked({ ...item, _srcCodexId: item.codexId });
    const title = locked ? '受限卡片' : item.title;
    const source = locked ? '开启相应内容分级后可查看名称' : item.codexTitle;
    return `<li><div><b>${esc(title)}</b><span>${esc(source)}</span></div><button type="button" class="panel-action is-sm" data-restore-entry="${esc(item.key)}" aria-label="恢复 ${esc(title)}">恢复</button></li>`;
  }).join('');
  $('#blockingEntriesEmpty').hidden = Boolean(prefs.entries.length);
  $('#blockingMoreEntries').hidden = prefs.entries.length <= shownEntries;
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
  $('#blockingSettingsBtn').onclick = event => openBlockingManager(event.currentTarget);
  $('#blockingResultBtn').onclick = event => openBlockingManager(event.currentTarget);
  for (const [id, closeId] of [['contentBlocking', 'blockingClose'], ['blockingReveal', 'blockingRevealClose']]) {
    const panel = $(`#${id}`);
    $(`#${closeId}`).onclick = () => closeMask(panel);
    bindBackdropDismiss(panel, () => closeMask(panel));
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMask(panel); }
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
      closeMask(top);
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
  const chooseTab = tab => { currentTab = tab.dataset.blockingTab; renderBlockingManager(); tab.focus(); };
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
    if (button && !showSaveError(removeBlockedWord(button.dataset.removeWord))) $('#blockingWordInput').focus();
  };
  $('#blockingEntryList').onclick = event => {
    const button = event.target.closest('[data-restore-entry]');
    if (button && !showSaveError(restoreContentEntry(button.dataset.restoreEntry))) {
      ($('#blockingEntryList button') || $('#blockingEntriesTab')).focus();
    }
  };
  $('#blockingMoreEntries').onclick = () => { shownEntries += 40; renderBlockingManager(); };
  subscribeContentBlocking(() => { actions.refresh(); renderBlockingManager(); updateBlockingSummary(); });
  window.addEventListener('storage', receiveBlockingStorage);
  document.addEventListener('codex:loaded', renderBlockingManager);
  renderBlockingManager();
  updateBlockingSummary();
}
