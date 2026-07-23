import {
  $, $$, state, STATUS_LABELS, FEEDBACK_LABELS, currentItems, selectedItem, selectedFeedback,
  isBatchActionAllowed, feedbackDirectory, feedbackProgressStatus, feedbackProgressInfo,
} from './state.js';
import {
  token, setToken, clearToken, getCommunity, getStats, mutateCommunity,
  getFeedback, updateFeedback, deleteFeedback,
} from './api.js';
import {
  renderAll, renderHeader, renderNav, renderToolbar, renderList, renderDetail,
} from './render.js';
import { collectCommunityEdits, collectFeedbackUpdate } from './editor.js';

let toastTimer;
let searchTimer;
let loadSeq = 0;
let loadController = null;

export function initActions() {
  syncTheme();
  bindTopbar();
  bindNavigation();
  bindDelegates();
  bindKeyboard();
  window.addEventListener('beforeunload', event => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
  if (token()) enter();
  else showLogin();
}

async function enter() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#reloadBtn').hidden = false;
  $('#logoutBtn').hidden = false;
  await loadCurrent();
}

function showLogin(message = '') {
  cancelActiveLoad();
  $('#app').hidden = true;
  $('#reloadBtn').hidden = true;
  $('#logoutBtn').hidden = true;
  $('#login').hidden = false;
  $('#loginErr').textContent = message;
}

function bindTopbar() {
  $('#loginBtn').addEventListener('click', () => {
    const value = $('#tokenInput').value.trim();
    if (!value) return;
    setToken(value);
    enter();
  });
  $('#tokenInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') $('#loginBtn').click();
  });
  $('#logoutBtn').addEventListener('click', () => {
    if (state.busy || !confirmDiscardChanges()) return;
    clearDirty(false);
    clearToken();
    showLogin();
  });
  $('#reloadBtn').addEventListener('click', () => {
    if (state.busy || !confirmDiscardChanges()) return;
    clearDirty(false);
    loadCurrent();
  });
  $('#themeBtn').addEventListener('click', () => {
    const dark = !document.body.classList.contains('dark');
    document.body.classList.toggle('dark', dark);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : '';
    localStorage.setItem('fadian-dark', dark ? '1' : '0');
  });
  $('#globalSearch').addEventListener('input', event => {
    const query = event.target.value || '';
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (state.query === query) return;
      state.query = query;
      state.lastSelectedId = '';
      renderFilteredContent();
    }, 150);
  });
}

function bindNavigation() {
  $$('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view || 'dashboard';
      if (state.busy || view === state.view || !confirmDiscardChanges()) return;
      clearDirty(false);
      state.view = view;
      resetSelection();
      state.selectedId = '';
      state.selectedFeedbackId = '';
      resetBatchFailures();
      loadCurrent();
    });
  });
}

function bindDelegates() {
  $('#toolbar').addEventListener('change', event => {
    if (event.target.id === 'statusFilter') {
      const nextStatus = event.target.value || 'approved';
      if (state.busy || !confirmDiscardChanges()) {
        event.target.value = state.status;
        return;
      }
      clearDirty(false);
      state.status = nextStatus;
      resetSelection();
      state.selectedId = '';
      resetBatchFailures();
      loadCurrent();
      return;
    }
    if (event.target.id === 'categoryFilter') {
      if (state.busy) {
        event.target.value = state.category;
        return;
      }
      state.category = event.target.value || '';
      state.lastSelectedId = '';
      renderFilteredContent();
      return;
    }
    if (event.target.id === 'nsfwFilter') {
      if (state.busy) {
        event.target.value = state.nsfw;
        return;
      }
      state.nsfw = event.target.value || '';
      state.lastSelectedId = '';
      renderFilteredContent();
      return;
    }
    if (event.target.id === 'selectAllVisible') {
      if (state.busy) return;
      const ids = currentItems().map(item => item.id);
      for (const id of ids) {
        if (event.target.checked) state.selectedIds.add(id);
        else state.selectedIds.delete(id);
      }
      state.lastSelectedId = '';
      renderToolbar();
      syncSelectionControls();
    }
  });

  $('#toolbar').addEventListener('click', event => {
    const contentStatus = event.target.closest('[data-content-status]');
    if (contentStatus) {
      const nextStatus = contentStatus.dataset.contentStatus || 'pending';
      if (state.busy || nextStatus === state.status || !confirmDiscardChanges()) return;
      clearDirty(false);
      state.status = nextStatus;
      resetSelection();
      state.selectedId = '';
      resetBatchFailures();
      loadCurrent();
      return;
    }
    const feedbackStatus = event.target.closest('[data-feedback-status]');
    if (feedbackStatus) {
      const nextStatus = feedbackStatus.dataset.feedbackStatus || 'pending';
      if (state.busy || nextStatus === state.feedbackStatus || !confirmDiscardChanges()) return;
      clearDirty(false);
      state.feedbackStatus = nextStatus;
      state.selectedFeedbackId = '';
      loadCurrent();
      return;
    }
    if (event.target.closest('[data-clear-selection]')) {
      resetSelection();
      resetBatchFailures();
      renderToolbar();
      syncSelectionControls();
      return;
    }
    if (event.target.closest('[data-dismiss-failures]')) {
      resetBatchFailures();
      renderToolbar();
      return;
    }
    if (event.target.closest('[data-retry-failed]')) {
      retryBatchFailures();
      return;
    }
    const batch = event.target.closest('[data-batch-action]');
    if (batch) {
      runBatch(batch.dataset.batchAction);
      return;
    }
    if (event.target.closest('[data-reload]')) {
      if (state.busy || !confirmDiscardChanges()) return;
      clearDirty(false);
      loadCurrent();
    }
  });

  $('#list').addEventListener('click', event => {
    const checkbox = event.target.closest('[data-select-id]');
    if (checkbox) {
      toggleSelection(checkbox.dataset.selectId, checkbox.checked, event.shiftKey);
      return;
    }
    const feedbackPick = event.target.closest('[data-pick-feedback], [data-feedback-id]');
    if (feedbackPick && state.view === 'feedback') {
      const id = feedbackPick.dataset.pickFeedback || feedbackPick.dataset.feedbackId || '';
      if (state.busy || !id || id === state.selectedFeedbackId || !confirmDiscardChanges()) return;
      clearDirty(false);
      state.selectedFeedbackId = id;
      renderHeader();
      syncActiveRows();
      renderDetail();
      return;
    }
    const pick = event.target.closest('[data-pick-id], [data-id]');
    if (pick && state.view !== 'feedback') {
      const id = pick.dataset.pickId || pick.dataset.id || '';
      selectCommunityItem(id);
    }
  });

  $('#detail').addEventListener('input', event => {
    if (event.target.closest('#editorForm, #feedbackEditorForm')) markDirty();
  });
  $('#detail').addEventListener('change', event => {
    if (event.target.closest('#editorForm, #feedbackEditorForm') || event.target.matches('input[name="coverIndex"]')) markDirty();
  });
  $('#detail').addEventListener('submit', event => {
    if (!event.target.matches('#feedbackEditorForm')) return;
    event.preventDefault();
    runFeedbackAction('save');
  });
  $('#detail').addEventListener('click', event => {
    if (event.target.closest('[data-detail-close]')) {
      closeDetail();
      return;
    }
    const action = event.target.closest('[data-action]');
    if (action) {
      runCommunityAction(action.dataset.action);
      return;
    }
    const feedback = event.target.closest('[data-feedback-action]');
    if (feedback) {
      runFeedbackAction(feedback.dataset.feedbackAction);
      return;
    }
    const copy = event.target.closest('[data-copy-feedback]');
    if (copy) copyFeedback(copy.dataset.copyFeedback);
  });
  $('.detail-backdrop')?.addEventListener('click', closeDetail);
}

function bindKeyboard() {
  document.addEventListener('keydown', event => {
    const editing = isEditingTarget(event.target);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      if (state.view === 'feedback' && selectedFeedback()) {
        event.preventDefault();
        runFeedbackAction('save');
      } else if (state.view !== 'dashboard' && selectedItem()) {
        event.preventDefault();
        runCommunityAction('update');
      }
      return;
    }
    if (event.key === 'Escape' && (state.selectedId || state.selectedFeedbackId)) {
      event.preventDefault();
      closeDetail();
      return;
    }
    if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a'
      && state.view !== 'dashboard' && state.view !== 'feedback') {
      event.preventDefault();
      setVisibleSelection(true);
      return;
    }
    if (!editing && event.key === '/') {
      event.preventDefault();
      $('#globalSearch').focus();
      return;
    }
    if (editing || state.busy || state.view === 'dashboard' || state.view === 'feedback') return;
    if (event.shiftKey && event.key === 'Enter' && state.status === 'pending' && selectedItem()) {
      event.preventDefault();
      runCommunityAction('approve');
      return;
    }
    if (event.key.toLowerCase() === 'j' || event.key.toLowerCase() === 'k') {
      event.preventDefault();
      moveDetailSelection(event.key.toLowerCase() === 'j' ? 1 : -1);
      return;
    }
    if (event.key === ' ' && state.selectedId) {
      event.preventDefault();
      const checked = !state.selectedIds.has(state.selectedId);
      toggleSelection(state.selectedId, checked, false);
    }
  });
}

async function loadCurrent() {
  const seq = ++loadSeq;
  if (loadController) loadController.abort();
  const controller = new AbortController();
  loadController = controller;
  state.loading = true;
  $('#list').innerHTML = '<div class="empty-state">加载中...</div>';
  $('#empty').hidden = true;
  const view = state.view;
  const status = state.status;
  const feedbackStatus = state.feedbackStatus;
  try {
    if (view === 'dashboard') {
      const data = await getStats({ signal: controller.signal });
      if (seq !== loadSeq) return;
      state.stats = data;
      state.items = [];
      state.feedbackItems = [];
      state.selectedId = '';
      state.selectedFeedbackId = '';
    } else if (view === 'feedback') {
      const data = await getFeedback(feedbackStatus, { signal: controller.signal });
      if (seq !== loadSeq) return;
      state.feedbackItems = data.items || [];
      if (!state.feedbackItems.some(item => item.id === state.selectedFeedbackId)) {
        state.selectedFeedbackId = shouldAutoOpenDetail() ? state.feedbackItems[0]?.id || '' : '';
      }
    } else {
      const data = await getCommunity(status, { signal: controller.signal });
      if (seq !== loadSeq) return;
      state.items = data.items || [];
      if (!state.items.some(item => item.id === state.selectedId)) {
        state.selectedId = shouldAutoOpenDetail() ? state.items[0]?.id || '' : '';
      }
      pruneSelection();
    }
    resetBatchFailures();
    state.loading = false;
    renderAll();
  } catch (error) {
    if (error?.name === 'AbortError' || seq !== loadSeq) return;
    state.loading = false;
    handleError(error, true);
  } finally {
    if (seq === loadSeq) loadController = null;
  }
}

async function runCommunityAction(action) {
  if (state.busy || state.loading) return;
  const item = selectedItem();
  if (!item || !isCommunityActionAllowed(item.status, action)) return;

  const edits = collectCommunityEdits();
  const savesEdits = ['update', 'approve', 'publish'].includes(action);
  if (state.dirty && !savesEdits && !confirmDiscardChanges('此操作不会保存表单里的其他修改，仍要继续吗？')) return;
  if (['delete', 'purge'].includes(action) && !confirm(confirmText(action, item))) return;

  const body = { id: item.id, status: item.status };
  if (savesEdits) body.edits = edits;
  if (['reject', 'unpublish'].includes(action)) {
    const reason = requestReason(action, edits.adminNote || item.adminNote || '');
    if (reason == null) return;
    body.reason = reason;
    body.adminNote = reason;
  }
  if (action === 'restore') body.targetStatus = 'hidden';

  const visibleBefore = currentItems();
  setBusy(true);
  try {
    const data = await mutateCommunity(action, body);
    applySingleSuccess(action, item, data, visibleBefore);
    clearDirty(false);
    toast(actionLabel(action));
    renderWorkspace();
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
  }
}

async function runBatch(action, options = {}) {
  if (state.busy || state.loading || !isBatchActionAllowed(state.status, action)) return;
  const requestedIds = (options.ids || Array.from(state.selectedIds)).filter(Boolean);
  const ids = requestedIds.slice(0, 100);
  const deferredCount = Math.max(0, requestedIds.length - ids.length);
  if (!ids.length) {
    toast('先勾选要操作的内容');
    return;
  }
  if (state.dirty && !confirmDiscardChanges('批量操作会离开当前编辑状态，仍要继续吗？')) return;

  const payload = { ...(options.payload || {}) };
  if (action === 'moveCategory' && !payload.category) {
    payload.category = $('#batchCategory')?.value || '';
    if (!payload.category) {
      toast('请选择目标分类');
      return;
    }
  }
  if (['reject', 'unpublish'].includes(action) && !payload.reason) {
    const reason = requestReason(action, '');
    if (reason == null) return;
    payload.reason = reason;
    payload.adminNote = reason;
  }
  if (action === 'restore') payload.targetStatus = 'hidden';
  const limitNote = deferredCount ? `（单次最多 100 条，另有 ${deferredCount} 条会保持选中）` : '';
  if (!options.retry && action !== 'moveCategory' && !confirm(`确认对 ${ids.length} 条内容执行「${actionLabel(action)}」？${limitNote}`)) return;

  const body = { action, ids, status: state.status, ...payload };
  const visibleBefore = currentItems();
  setBusy(true);
  try {
    const data = await mutateCommunity('batch', body);
    const failures = normalizeBatchFailures(data.failed || data.errors, ids);
    const failedIds = new Set(failures.map(failure => failure.id));
    const succeeded = Array.isArray(data.succeeded) ? data.succeeded.filter(result => ids.includes(String(result?.id || ''))) : null;
    const successIds = succeeded ? succeeded.map(result => String(result.id)) : ids.filter(id => !failedIds.has(id));
    applyBatchSuccess(action, successIds, payload, visibleBefore, succeeded || []);
    for (const id of failures.map(failure => failure.id)) state.selectedIds.add(id);
    state.batchFailures = failures;
    state.batchRetry = failures.length ? { action, payload } : null;
    clearDirty(false);
    const changed = Number.isFinite(Number(data.changed)) ? Number(data.changed) : successIds.length;
    const deferredNote = deferredCount ? `，剩余 ${deferredCount} 条待处理` : '';
    toast(failures.length ? `完成 ${changed} 条，失败 ${failures.length} 条${deferredNote}` : `已处理 ${changed} 条${deferredNote}`);
    renderWorkspace();
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
  }
}

function retryBatchFailures() {
  const retry = state.batchRetry;
  const ids = state.batchFailures.map(failure => failure.id);
  if (!retry || !ids.length) return;
  runBatch(retry.action, { ids, payload: retry.payload, retry: true });
}

async function runFeedbackAction(action) {
  if (state.busy || state.loading) return;
  const item = selectedFeedback();
  if (!item) return;
  if (action === 'delete') {
    if (state.dirty && !confirmDiscardChanges('删除反馈会丢弃尚未保存的展示进度与回复，仍要继续吗？')) return;
    if (!confirm('确认永久删除这条反馈？')) return;
  }

  const update = collectFeedbackUpdate();
  if (action === 'resolve') update.progressStatus = 'completed';
  if (action === 'ignore') update.progressStatus = 'declined';
  const before = state.feedbackItems.slice();
  const index = before.findIndex(entry => entry.id === item.id);
  setBusy(true);
  try {
    if (action === 'delete') {
      await deleteFeedback(item.id, item.status || state.feedbackStatus);
      state.feedbackItems = state.feedbackItems.filter(entry => entry.id !== item.id);
      state.selectedFeedbackId = state.feedbackItems[Math.min(index, state.feedbackItems.length - 1)]?.id || '';
      toast('反馈已删除');
    } else {
      const sourceStatus = item.status || state.feedbackStatus;
      const targetProgress = feedbackProgressInfo(update.progressStatus);
      const data = await updateFeedback(item.id, sourceStatus, update.progressStatus, update.adminReply);
      const saved = data.item || {
        ...item,
        status: targetProgress.status,
        progressStatus: update.progressStatus,
        adminReply: update.adminReply,
        statusUpdatedAt: sourceStatus === targetProgress.status ? item.statusUpdatedAt : Date.now(),
        progressStatusUpdatedAt: feedbackProgressStatus(item) === update.progressStatus
          ? item.progressStatusUpdatedAt
          : Date.now(),
        replyUpdatedAt: update.adminReply === (item.adminReply || '') ? item.replyUpdatedAt : Date.now(),
      };
      if (saved.status === state.feedbackStatus) {
        state.feedbackItems.splice(index, 1, saved);
        state.selectedFeedbackId = saved.id;
      } else {
        state.feedbackItems = state.feedbackItems.filter(entry => entry.id !== item.id);
        state.selectedFeedbackId = state.feedbackItems[Math.min(index, state.feedbackItems.length - 1)]?.id || '';
      }
      const savedProgress = feedbackProgressInfo(saved);
      toast(sourceStatus === saved.status
        ? `已保存 · ${savedProgress.label}`
        : `已更新为「${savedProgress.label}」，归入「${FEEDBACK_LABELS[saved.status] || saved.status}」`);
    }
    clearDirty(false);
    renderWorkspace();
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
  }
}

async function copyFeedback(id) {
  const item = state.feedbackItems.find(entry => entry.id === id);
  if (!item) return;
  const ctx = item.context || {};
  const entry = ctx.entry || {};
  const page = ctx.page || {};
  const directory = feedbackDirectory(item);
  const progress = feedbackProgressInfo(item);
  const lines = [
    '【法典图鉴反馈】',
    `类型：${item.typeLabel || item.type}`,
    `展示进度：${progress.label}`,
    `后台分组：${FEEDBACK_LABELS[item.status] || item.status || '进行中'}`,
    `描述：${item.description}`,
    `联系方式：${item.contact || '未填写'}`,
    `页面：${page.url || ''}`,
    `词条：${entry.title || entry.id || ''}`,
    `词条目录：${directory || '无'}`,
    `站长回复：${item.adminReply || '未回复'}`,
    '',
    '【完整上下文】',
    JSON.stringify(ctx, null, 2),
  ].join('\n');
  try {
    await navigator.clipboard.writeText(lines);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = lines;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
  toast('反馈上下文已复制');
}

function toggleSelection(id, checked, useRange) {
  if (!id || state.busy) return;
  const items = currentItems();
  const ids = items.map(item => item.id);
  const index = ids.indexOf(id);
  const anchor = ids.indexOf(state.lastSelectedId);
  if (useRange && index >= 0 && anchor >= 0) {
    const start = Math.min(index, anchor);
    const end = Math.max(index, anchor);
    for (const rangeId of ids.slice(start, end + 1)) {
      if (checked) state.selectedIds.add(rangeId);
      else state.selectedIds.delete(rangeId);
    }
  } else if (checked) {
    state.selectedIds.add(id);
  } else {
    state.selectedIds.delete(id);
  }
  state.lastSelectedId = id;
  renderToolbar();
  syncSelectionControls();
}

function selectCommunityItem(id) {
  if (state.busy || !id || id === state.selectedId) return;
  if (!confirmDiscardChanges()) return;
  clearDirty(false);
  state.selectedId = id;
  renderHeader();
  syncActiveRows();
  renderDetail();
}

function moveDetailSelection(delta) {
  const items = currentItems();
  if (!items.length) return;
  const index = items.findIndex(item => item.id === state.selectedId);
  const nextIndex = Math.max(0, Math.min(items.length - 1, (index < 0 ? 0 : index) + delta));
  selectCommunityItem(items[nextIndex]?.id || '');
}

function closeDetail() {
  if (state.busy || !confirmDiscardChanges()) return;
  clearDirty(false);
  if (state.view === 'feedback') state.selectedFeedbackId = '';
  else state.selectedId = '';
  renderHeader();
  syncActiveRows();
  renderDetail();
}

function setVisibleSelection(checked) {
  if (state.busy) return;
  for (const item of currentItems()) {
    if (checked) state.selectedIds.add(item.id);
    else state.selectedIds.delete(item.id);
  }
  state.lastSelectedId = '';
  renderToolbar();
  syncSelectionControls();
}

function syncSelectionControls() {
  $$('#list [data-select-id]').forEach(control => {
    control.checked = state.selectedIds.has(control.dataset.selectId || '');
  });
}

function syncActiveRows() {
  $$('#list [data-id]').forEach(row => {
    const active = row.dataset.id === state.selectedId;
    row.classList.toggle('on', active);
    row.setAttribute('aria-selected', String(active));
  });
  $$('#list [data-feedback-id]').forEach(row => {
    row.classList.toggle('on', row.dataset.feedbackId === state.selectedFeedbackId);
  });
}

function markDirty() {
  if (state.view === 'dashboard') return;
  const id = state.view === 'feedback' ? state.selectedFeedbackId : state.selectedId;
  if (!id) return;
  state.dirty = true;
  state.dirtyId = id;
  const detail = $('#detail');
  detail.dataset.dirty = 'true';
  renderHeader();
}

function clearDirty(updateHeader = true) {
  state.dirty = false;
  state.dirtyId = '';
  const detail = $('#detail');
  if (detail) detail.dataset.dirty = 'false';
  if (updateHeader && $('#viewMeta')) renderHeader();
}

function confirmDiscardChanges(message = '') {
  if (!state.dirty) return true;
  const item = state.view === 'feedback' ? selectedFeedback() : selectedItem();
  const title = state.view === 'feedback'
    ? item?.typeLabel || item?.type || item?.id || '当前反馈'
    : item?.title || item?.id || '当前内容';
  return confirm(message || `「${title}」有未保存修改，确定放弃并离开吗？`);
}

function requestReason(action, initialValue) {
  const verb = action === 'reject' ? '拒绝' : '下架';
  const reason = prompt(`请填写${verb}原因（会保存为管理备注）`, initialValue || '');
  if (reason == null) return null;
  const clean = reason.trim();
  if (!clean) {
    toast(`请填写${verb}原因`);
    return null;
  }
  return clean;
}

function applySingleSuccess(action, before, data, visibleBefore) {
  const saved = data.item || null;
  if (action === 'update') {
    if (saved) {
      updateStatsForEdit(before, saved);
      replaceItem(saved);
    }
    return;
  }

  if (saved) updateStatsForEdit(before, saved);
  const target = targetStatusForAction(action, before.status, data);
  adjustStatsForMove(saved || before, before.status, target, action === 'purge');
  state.items = state.items.filter(item => item.id !== before.id);
  state.selectedIds.delete(before.id);
  if (state.selectedId === before.id) {
    state.selectedId = nextIdAfterRemoval(visibleBefore, new Set([before.id]), before.id);
  }
}

function applyBatchSuccess(action, successIds, payload, visibleBefore, succeeded = []) {
  if (!successIds.length) return;
  const success = new Set(successIds);
  const savedById = new Map(succeeded.filter(result => result?.item).map(result => [String(result.id), result.item]));
  const beforeItems = state.items.filter(item => success.has(item.id));
  if (action === 'moveCategory') {
    state.items = state.items.map(item => {
      if (!success.has(item.id)) return item;
      const updated = savedById.get(item.id) || { ...item, category: [payload.category], updatedAt: Date.now() };
      updateStatsForEdit(item, updated);
      return updated;
    });
  } else {
    const target = targetStatusForAction(action, state.status, {});
    for (const item of beforeItems) adjustStatsForMove(item, item.status || state.status, target, action === 'purge');
    state.items = state.items.filter(item => !success.has(item.id));
  }
  for (const id of success) state.selectedIds.delete(id);

  const visibleNow = new Set(currentItems().map(item => item.id));
  const removedFromView = new Set(visibleBefore.filter(item => !visibleNow.has(item.id)).map(item => item.id));
  if (state.selectedId && removedFromView.has(state.selectedId)) {
    state.selectedId = nextIdAfterRemoval(visibleBefore, removedFromView, state.selectedId);
  }
}

function replaceItem(item) {
  const index = state.items.findIndex(entry => entry.id === item.id);
  if (index >= 0) state.items.splice(index, 1, item);
}

function nextIdAfterRemoval(items, removedIds, selectedId) {
  const index = items.findIndex(item => item.id === selectedId);
  if (index < 0) return currentItems()[0]?.id || '';
  for (let i = index + 1; i < items.length; i += 1) {
    if (!removedIds.has(items[i].id)) return items[i].id;
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    if (!removedIds.has(items[i].id)) return items[i].id;
  }
  return '';
}

function normalizeBatchFailures(errors, attemptedIds) {
  if (!Array.isArray(errors)) return [];
  const attempted = new Set(attemptedIds);
  return errors.map(error => ({
    id: String(error?.id || ''),
    error: String(error?.error || error?.message || '操作失败'),
  })).filter(error => error.id && attempted.has(error.id));
}

function updateStatsForEdit(before, after) {
  const stats = state.stats;
  if (!stats || !before || !after) return;
  const beforeCategory = (before.category || [])[0] || '随手分享';
  const afterCategory = (after.category || [])[0] || '随手分享';
  stats.categories ||= {};
  if (beforeCategory !== afterCategory) {
    changeCount(stats.categories, beforeCategory, -1);
    changeCount(stats.categories, afterCategory, 1);
  }
  if (!!before.nsfw !== !!after.nsfw) stats.nsfw = Math.max(0, Number(stats.nsfw || 0) + (after.nsfw ? 1 : -1));
  const imageDelta = (after.images || []).length - (before.images || []).length;
  if (imageDelta) stats.images = Math.max(0, Number(stats.images || 0) + imageDelta);
  stats.generatedAt = Date.now();
}

function adjustStatsForMove(item, from, to, purge) {
  const stats = state.stats;
  if (!stats || !item) return;
  stats.counts ||= {};
  if (from && from !== to) changeCount(stats.counts, from, -1);
  if (to && from !== to) changeCount(stats.counts, to, 1);
  if (purge) {
    stats.total = Math.max(0, Number(stats.total || 0) - 1);
    stats.images = Math.max(0, Number(stats.images || 0) - (item.images || []).length);
    if (item.nsfw) stats.nsfw = Math.max(0, Number(stats.nsfw || 0) - 1);
    stats.categories ||= {};
    changeCount(stats.categories, (item.category || [])[0] || '随手分享', -1);
  }
  stats.generatedAt = Date.now();
}

function changeCount(record, key, delta) {
  record[key] = Math.max(0, Number(record[key] || 0) + delta);
}

function targetStatusForAction(action, currentStatus, data) {
  if (data.item?.status) return data.item.status;
  if (data.status) return data.status;
  return ({
    approve: 'approved',
    reject: 'rejected',
    publish: 'approved',
    unpublish: 'hidden',
    delete: 'deleted',
    restore: 'hidden',
    purge: '',
  }[action] ?? currentStatus);
}

function isCommunityActionAllowed(status, action) {
  const actions = {
    pending: ['update', 'approve', 'reject', 'delete'],
    approved: ['update', 'unpublish', 'delete'],
    hidden: ['update', 'publish', 'delete'],
    rejected: ['update', 'publish', 'delete'],
    deleted: ['restore', 'publish', 'purge'],
  };
  return (actions[status] || []).includes(action);
}

function renderFilteredContent() {
  renderHeader();
  if (state.view !== 'dashboard') renderToolbar();
  renderList();
}

function renderWorkspace() {
  renderHeader();
  renderNav();
  renderToolbar();
  renderList();
  renderDetail();
}

function pruneSelection() {
  const ids = new Set(state.items.map(item => item.id));
  for (const id of Array.from(state.selectedIds)) {
    if (!ids.has(id)) state.selectedIds.delete(id);
  }
  if (state.lastSelectedId && !ids.has(state.lastSelectedId)) state.lastSelectedId = '';
}

function resetSelection() {
  state.selectedIds.clear();
  state.lastSelectedId = '';
}

function resetBatchFailures() {
  state.batchFailures = [];
  state.batchRetry = null;
}

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll('[data-action], [data-batch-action], [data-feedback-action], [data-retry-failed], [data-content-status], [data-feedback-status]').forEach(control => {
    control.disabled = busy;
  });
  document.querySelectorAll('#statusFilter, #categoryFilter, #nsfwFilter, #batchCategory, #feedbackProgressSelect, #feedbackReply, [data-select-id]').forEach(control => {
    control.disabled = busy;
  });
  const selectAll = $('#selectAllVisible');
  if (selectAll) selectAll.disabled = busy || currentItems().length === 0;
}

function cancelActiveLoad() {
  loadSeq += 1;
  if (loadController) loadController.abort();
  loadController = null;
  state.loading = false;
}

function isEditingTarget(target) {
  return !!target?.closest?.('input, textarea, select, [contenteditable="true"]');
}

function shouldAutoOpenDetail() {
  return !window.matchMedia?.('(max-width: 1024px)').matches;
}

function syncTheme() {
  const primaryDark = localStorage.getItem('fadian-dark');
  const legacyDark = localStorage.getItem('strings-dark');
  const dark = primaryDark == null
    ? legacyDark === 'true' || legacyDark === '1' || document.documentElement.classList.contains('dark')
    : primaryDark === '1' || primaryDark === 'true';
  document.body.classList.toggle('dark', dark);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : '';
  const theme = localStorage.getItem('fadian-theme') || '';
  for (const id of ['teal', 'sakura', 'amber']) document.body.classList.toggle(`theme-${id}`, theme === id);
}

function handleError(error, replaceList = false) {
  if (error?.name === 'AbortError') return;
  if (error.unauthorized) {
    showLogin(error.message);
    return;
  }
  if (replaceList) $('#list').innerHTML = `<div class="empty-state">加载失败：${escapeText(error.message || '未知错误')}</div>`;
  toast(error.message || '操作失败');
}

function escapeText(value) {
  return String(value).replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2200);
}

function confirmText(action, item) {
  const title = item.title || item.id;
  if (action === 'delete') return `确认软删除「${title}」？之后仍可恢复。`;
  if (action === 'purge') return `确认永久删除「${title}」？记录和图片都会删除。`;
  return `确认操作「${title}」？`;
}

function actionLabel(action) {
  return ({
    update: '已保存',
    approve: '已通过并发布',
    reject: '已拒绝留档',
    publish: '已上架',
    unpublish: '已下架',
    delete: '已软删除',
    restore: '已恢复',
    purge: '已永久删除',
    moveCategory: '移动分类',
  }[action] || STATUS_LABELS[action] || FEEDBACK_LABELS[action] || action);
}
