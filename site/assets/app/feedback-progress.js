export const FEEDBACK_PROGRESS = Object.freeze({
  unread: Object.freeze({
    label: '待查看',
    description: '尚未人工查看这条反馈。',
    status: 'pending',
  }),
  accepted: Object.freeze({
    label: '已受理',
    description: '已经查看并纳入处理队列。',
    status: 'pending',
  }),
  investigating: Object.freeze({
    label: '调查中',
    description: '正在复现问题、确认原因和影响范围。',
    status: 'pending',
  }),
  in_progress: Object.freeze({
    label: '处理中',
    description: '已经开始修复、调整或实施。',
    status: 'pending',
  }),
  verifying: Object.freeze({
    label: '待验证',
    description: '处理方案已经完成，正在验证结果。',
    status: 'pending',
  }),
  deferred: Object.freeze({
    label: '暂缓处理',
    description: '反馈有效，但当前暂不排期处理。',
    status: 'pending',
  }),
  completed: Object.freeze({
    label: '已完成',
    description: '处理结果已经完成并确认。',
    status: 'resolved',
  }),
  declined: Object.freeze({
    label: '暂不采纳',
    description: '评估后暂不采纳，具体原因会写在回复中。',
    status: 'ignored',
  }),
});

export const FEEDBACK_PROGRESS_STATUSES = Object.freeze(Object.keys(FEEDBACK_PROGRESS));
export const FEEDBACK_CLOSED_PROGRESS = Object.freeze(['completed', 'declined']);

export function feedbackProgressMeta(value) {
  return FEEDBACK_PROGRESS[String(value || '')] || FEEDBACK_PROGRESS.unread;
}

export function isFeedbackProgressClosed(value) {
  return FEEDBACK_CLOSED_PROGRESS.includes(String(value || ''));
}
