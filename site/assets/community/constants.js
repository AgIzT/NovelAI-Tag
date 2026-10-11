export const COMMUNITY_CATEGORIES = Object.freeze(['随手分享', '画风', '人物', '服装', '动作', '构图', '场景']);
export const DEFAULT_COMMUNITY_CATEGORY = '随手分享';
export const SUBMIT_CATEGORIES = Object.freeze([
  DEFAULT_COMMUNITY_CATEGORY,
  ...COMMUNITY_CATEGORIES.filter(category => category !== DEFAULT_COMMUNITY_CATEGORY),
]);

export const SUBMIT_DISABLED = false;
export const SUBMIT_DISABLED_MESSAGE = '投稿功能暂未开放';

export const LIMITS = Object.freeze({
  title: 60,
  prompt: 2000,
  negative: 2000,
  comment: 500,
  submitter: 20,
  tags: 8,
  imageCount: 6,
  imageBytes: 3 * 1024 * 1024,
  origBytes: 10 * 1024 * 1024,
  totalBytes: 60 * 1024 * 1024,
});

export const STRINGS_R2_BASE = 'https://pub-a66b6b5ffa0d44a89eb7dd6fa1070b58.r2.dev';

export const CATEGORY_ALIASES = new Map([
  ['画风', '画风'],
  ['style', '画风'],
  ['人物', '人物'],
  ['面部', '人物'],
  ['角色', '人物'],
  ['face', '人物'],
  ['服装', '服装'],
  ['穿搭', '服装'],
  ['衣服', '服装'],
  ['outfit', '服装'],
  ['clothing', '服装'],
  ['动作', '动作'],
  ['pose', '动作'],
  ['构图', '构图'],
  ['composition', '构图'],
  ['场景', '场景'],
  ['背景', '场景'],
  ['环境', '场景'],
  ['scene', '场景'],
  ['background', '场景'],
  ['environment', '场景'],
  ['随手分享', '随手分享'],
  ['gallery', '随手分享'],
  ['其他', '随手分享'],
]);
