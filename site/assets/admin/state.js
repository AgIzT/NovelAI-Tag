import {
  FEEDBACK_PROGRESS,
  FEEDBACK_PROGRESS_STATUSES,
} from '../app/feedback-progress.js';

export const KEY = 'strings-admin-token';

export {
  FEEDBACK_PROGRESS,
  FEEDBACK_PROGRESS_STATUSES,
};

export const COMMUNITY_CATEGORIES = ['随手分享', '画风', '人物', '服装', '动作', '构图', '场景'];
export const COMMUNITY_STATUSES = ['pending', 'approved', 'hidden', 'rejected', 'deleted'];

export const STATUS_LABELS = {
  pending: '待审',
  approved: '已发布',
  hidden: '已下架',
  rejected: '已拒绝',
  deleted: '已删除',
};

export const FEEDBACK_LABELS = {
  pending: '进行中',
  resolved: '已完成',
  ignored: '暂不采纳',
};
export const FEEDBACK_STATUSES = Object.freeze(Object.keys(FEEDBACK_LABELS));

export const BATCH_ACTIONS_BY_STATUS = {
  pending: ['approve', 'reject', 'moveCategory', 'delete'],
  approved: ['unpublish', 'moveCategory', 'delete'],
  hidden: ['publish', 'moveCategory', 'delete'],
  rejected: ['publish', 'moveCategory', 'delete'],
  deleted: ['restore', 'publish', 'purge'],
};

export const state = {
  view: 'dashboard',
  status: 'pending',
  feedbackStatus: 'pending',
  query: '',
  category: '',
  nsfw: '',
  items: [],
  feedbackItems: [],
  stats: null,
  selectedId: '',
  selectedFeedbackId: '',
  selectedIds: new Set(),
  lastSelectedId: '',
  batchFailures: [],
  batchRetry: null,
  dirty: false,
  dirtyId: '',
  busy: false,
  loading: false,
};

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function escHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]));
}

export function escAttr(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function formatDate(value, withTime = true) {
  const n = Number(value || 0);
  if (!n) return '无时间';
  try {
    return new Date(n).toLocaleString('zh-CN', withTime ? undefined : { year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    return '无时间';
  }
}

export function currentItems() {
  const q = state.query.trim().toLowerCase();
  return state.items.filter(item => {
    if (state.category && (item.category || [])[0] !== state.category) return false;
    if (state.nsfw === 'sfw' && item.nsfw) return false;
    if (state.nsfw === 'nsfw' && !item.nsfw) return false;
    if (!q) return true;
    const haystack = [
      item.title, item.prompt, item.negative, item.comment, item.submitter,
      (item.tags || []).join(' '), (item.category || []).join(' '),
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

export function selectedItem() {
  return state.items.find(item => item.id === state.selectedId) || null;
}

export function selectedFeedback() {
  return state.feedbackItems.find(item => item.id === state.selectedFeedbackId) || null;
}

export function currentFeedbackItems() {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.feedbackItems;
  return state.feedbackItems.filter(item => {
    const context = item.context || {};
    const entry = context.entry || {};
    const codex = context.codex || {};
    const page = context.page || {};
    const progress = feedbackProgressInfo(item);
    return [
      item.type, item.typeLabel, item.description, item.contact,
      entry.id, entry.title, codex.id, codex.title, page.url,
      feedbackDirectory(item), item.adminReply, FEEDBACK_LABELS[item.status],
      progress.label, progress.description,
      item.publicVisible ? '公开中' : '未公开',
    ].join(' ').toLowerCase().includes(q);
  });
}

export function feedbackProgressStatus(item) {
  const status = FEEDBACK_STATUSES.includes(item?.status) ? item.status : 'pending';
  const progressStatus = String(item?.progressStatus || '');
  if (
    FEEDBACK_PROGRESS_STATUSES.includes(progressStatus)
    && FEEDBACK_PROGRESS[progressStatus].status === status
  ) {
    return progressStatus;
  }
  if (status === 'resolved') return 'completed';
  if (status === 'ignored') return 'declined';
  return 'unread';
}

export function feedbackProgressInfo(itemOrStatus) {
  const progressStatus = typeof itemOrStatus === 'string'
    ? itemOrStatus
    : feedbackProgressStatus(itemOrStatus);
  return FEEDBACK_PROGRESS[progressStatus] || FEEDBACK_PROGRESS.unread;
}

export function feedbackProgressBadgeClass(itemOrStatus) {
  const progressStatus = typeof itemOrStatus === 'string'
    ? itemOrStatus
    : feedbackProgressStatus(itemOrStatus);
  if (progressStatus === 'completed') return 'green';
  if (progressStatus === 'declined') return 'red';
  if (progressStatus === 'deferred' || progressStatus === 'verifying') return 'amber';
  return progressStatus === 'unread' ? '' : 'accent';
}

export function feedbackDirectory(item) {
  const context = item?.context || item || {};
  const entryPath = context.entry?.path;
  if (Array.isArray(entryPath) && entryPath.length) return entryPath.map(String).filter(Boolean).join(' › ');
  const routePath = context.route?.path;
  if (Array.isArray(routePath) && routePath.length) return routePath.map(String).filter(Boolean).join(' › ');
  return '';
}

export function selectionCounts(items = currentItems()) {
  const visibleIds = new Set(items.map(item => item.id));
  let visible = 0;
  for (const id of state.selectedIds) {
    if (visibleIds.has(id)) visible += 1;
  }
  return {
    visible,
    hidden: Math.max(0, state.selectedIds.size - visible),
    total: state.selectedIds.size,
  };
}

export function isBatchActionAllowed(status, action) {
  return (BATCH_ACTIONS_BY_STATUS[status] || []).includes(action);
}

export function pluralCount(value) {
  if (value == null || value === '') return '0';
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : String(value);
}
