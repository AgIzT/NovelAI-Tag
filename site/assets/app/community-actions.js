import { toast } from './feedback.js';
import { isMaskOpen } from './modal.js';
import { createLikeButton } from '../community/likes.js';

let actions = { getEntries: () => [], openEntry: () => false, refreshEntries: null };
let dialogsPromise = null;
let initialized = false;
let opening = false;

function communityId(entry) {
  return String(entry?.communityId || '');
}

function resolveEntry(id, fallback) {
  return actions.getEntries().find(entry => communityId(entry) === id) || fallback;
}

// 收藏和全站搜索持有词条副本；互动以投稿 ID 归一，完成后同步当前源条目。
export function createCommunityLikeButton(entry, className = '') {
  if (!communityId(entry)) return null;
  return createLikeButton(resolveEntry(communityId(entry), entry), className, {
    isEnabled: item => item?.communityFeatures?.likes === true,
    resolveEntry,
    onChange: item => {
      entry.liked = item.liked;
      entry.likeCount = item.likeCount;
      for (const candidate of actions.getEntries()) {
        if (communityId(candidate) !== communityId(item)) continue;
        candidate.liked = item.liked;
        candidate.likeCount = item.likeCount;
      }
    },
  });
}

function renderLightboxLike(entry) {
  const toolbar = document.querySelector('.lightbox-actions');
  if (!toolbar) return;
  let host = toolbar.querySelector('[data-community-like-host]');
  if (!host) {
    host = document.createElement('span');
    host.dataset.communityLikeHost = '';
    toolbar.appendChild(host);
  }
  const button = createCommunityLikeButton(entry);
  host.replaceChildren(...(button ? [button] : []));
  host.hidden = !button;
}

async function ensureDialogs() {
  if (!dialogsPromise) {
    dialogsPromise = Promise.all([
      import('../community/submit-dialog.js'),
      import('../community/submit.js'),
      import('../community/my-submissions.js'),
    ]).then(([fragment, submit, submissions]) => {
      fragment.mountSubmitDialog();
      submit.initSubmitDialog({
        bindTriggers: false,
        onSubmitted: () => submissions.renderMySubmissions(),
      });
      submissions.initMySubmissions({
        bindTriggers: false,
        maskClass: 'community-mask community-action-mask',
        getEntries: () => actions.getEntries(),
        openEntry: async (entry, options) => {
          try {
            return await actions.openEntry(entry, options);
          } catch (error) {
            console.warn('共创投稿详情打开失败', error);
            toast('暂时无法打开这条投稿，稍后重试', '!');
            return false;
          }
        },
      });
      return { submit, submissions };
    }).catch(error => {
      dialogsPromise = null;
      throw error;
    });
  }
  return dialogsPromise;
}

async function openAction(button, kind) {
  if (opening) return;
  opening = true;
  button.setAttribute('aria-busy', 'true');
  try {
    const { submit, submissions } = await ensureDialogs();
    if (kind === 'submit') {
      submit.openSubmitDialog(button);
      return;
    }
    // 每次检查公开状态时请求现行列表，避免把已下架的投稿继续标为已发布。
    await actions.refreshEntries?.();
    const replacing = isMaskOpen(document.getElementById('submitMask'));
    if (replacing) submit.closeSubmitDialog({ historyMode: 'none' });
    const trigger = replacing
      ? document.querySelector('#communityCodexActions [data-my-submissions-open]') || button : button;
    submissions.openMySubmissions(trigger, { historyMode: replacing ? 'replace' : 'push' });
  } catch (error) {
    console.warn('共创法典入口加载失败', error);
    toast('暂时无法打开，稍后重试', '!');
  } finally {
    opening = false;
    button.removeAttribute('aria-busy');
  }
}

export function initCommunityActions(options = {}) {
  actions = { ...actions, ...options };
  if (initialized) return;
  initialized = true;
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-open-submit], [data-my-submissions-open]');
    if (!button || button.disabled) return;
    event.preventDefault();
    void openAction(button, button.hasAttribute('data-open-submit') ? 'submit' : 'submissions');
  });
  document.addEventListener('lightbox:rendered', event => renderLightboxLike(event.detail?.entry));
  document.addEventListener('community:updated', () => {
    // 审核/下架刷新已打开的本机投稿状态；没有打开过面板时不触发懒加载。
    dialogsPromise?.then(({ submissions }) => submissions.renderMySubmissions()).catch(() => {});
  });
}
