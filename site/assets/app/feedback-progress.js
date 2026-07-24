export const FEEDBACK_PROGRESS = Object.freeze({
  unread: Object.freeze({
    label: '待查看',
    description: '维护者尚未查看这条反馈。',
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
    description: '评估后暂不采纳，具体原因请查看回复。',
    status: 'ignored',
  }),
});

export const FEEDBACK_PROGRESS_STATUSES = Object.freeze(Object.keys(FEEDBACK_PROGRESS));
export const FEEDBACK_CLOSED_PROGRESS = Object.freeze(['completed', 'declined']);

/* 公开卡片里的「进度流水线」可视化：把 8 个进度状态压成 5 段里程碑并点亮到当前。
   纯前端展示，不参与与后端字典的一致性校验（那校验只看 FEEDBACK_PROGRESS）。 */
export const FEEDBACK_PROGRESS_FLOW = Object.freeze([
  Object.freeze({ key: 'received', label: '收到' }),
  Object.freeze({ key: 'accepted', label: '受理' }),
  Object.freeze({ key: 'processing', label: '处理' }),
  Object.freeze({ key: 'verifying', label: '验证' }),
  Object.freeze({ key: 'completed', label: '完成' }),
]);

const FEEDBACK_FLOW_INDEX = Object.freeze({
  unread: 0,
  accepted: 1,
  deferred: 1,
  investigating: 2,
  in_progress: 2,
  verifying: 3,
  completed: 4,
});

export function feedbackProgressMeta(value) {
  return FEEDBACK_PROGRESS[String(value || '')] || FEEDBACK_PROGRESS.unread;
}

export function isFeedbackProgressClosed(value) {
  return FEEDBACK_CLOSED_PROGRESS.includes(String(value || ''));
}

/* 暂不采纳(declined)不是线性推进，返回 null 让卡片不画流水线。 */
export function feedbackProgressFlow(value) {
  const status = String(value || '');
  const index = FEEDBACK_FLOW_INDEX[status];
  if (index == null) return null;
  return {
    steps: FEEDBACK_PROGRESS_FLOW,
    currentIndex: index,
    done: status === 'completed',
    paused: status === 'deferred',
  };
}
