import { state } from './state.js';
import { $, clamp, esc } from './utils.js';
import { toast } from './feedback.js';
import { openMask, closeMask, trapFocus } from './modal.js';
import { entryImages, imageItemUrl, thumbUrl, originalUrl, hasEntryImage } from './media.js';
import {
  feedbackProgressMeta,
  isFeedbackProgressClosed,
} from './feedback-progress.js';

const REPORT_TYPES = {
  site_bug: '站点 Bug / 使用问题',
  card_content: '卡片内容错误',
  image_error: '图片加载 / 配图问题',
  copy_error: '复制结果问题',
  suggestion: '建议 / 想法',
};

const TYPE_VALUES = Object.keys(REPORT_TYPES);
const MAX_DESC = 1000;
const MIN_DESC = 10;
const MAX_CONTACT = 120;
const MAX_SNIPPET = 420;

let currentPayload = null;
let currentTrigger = null;
let publicFeedbackItems = [];
let publicFeedbackLoaded = false;
let publicFeedbackLoading = false;
let publicFeedbackFilter = 'all';

export function setupReport() {
  const mask = $('#feedbackPanel');
  if (!mask) return;
  $('#feedbackClose')?.addEventListener('click', () => closeMask(mask));
  $('#feedbackCancel')?.addEventListener('click', () => closeMask(mask));
  mask.addEventListener('click', ev => { if (ev.target === mask) closeMask(mask); });
  mask.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeMask(mask);
      return;
    }
    trapFocus(ev, mask);
  });
  $('#feedbackForm')?.addEventListener('submit', submitFeedback);
  $('#feedbackCopyFallback')?.addEventListener('click', copyFallbackText);
  const tabs = [...mask.querySelectorAll('[data-feedback-tab]')];
  tabs.forEach((button, index) => {
    button.addEventListener('click', () => selectFeedbackTab(button.dataset.feedbackTab));
    button.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const offset = event.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(index + offset + tabs.length) % tabs.length];
      selectFeedbackTab(next.dataset.feedbackTab);
      next.focus();
    });
  });
  mask.querySelectorAll('[data-feedback-filter]').forEach(button => {
    button.addEventListener('click', () => {
      publicFeedbackFilter = button.dataset.feedbackFilter || 'all';
      renderPublicFeedback();
    });
  });
  $('#feedbackProgressRefresh')?.addEventListener('click', () => loadPublicFeedback({ force: true }));
}

export function openReportDialog({ source = 'global', entry = null, imageIndex = 0, defaultType = '', imageError = false, trigger = document.activeElement, historyMode = 'push' } = {}) {
  const mask = $('#feedbackPanel');
  if (!mask) return;
  currentTrigger = trigger instanceof HTMLElement ? trigger : document.activeElement;
  const type = TYPE_VALUES.includes(defaultType)
    ? defaultType
    : defaultTypeFor({ source, imageError });
  const context = buildFeedbackContext({ source, entry, imageIndex, imageError });
  currentPayload = { type, description: '', contact: '', publicConsent: true, context, honeypot: '' };
  resetFeedbackForm(type, context);
  selectFeedbackTab('submit');
  openMask(mask, currentTrigger, { historyMode });
}

export function buildFeedbackContext({ source = 'global', entry = null, imageIndex = 0, imageError = false } = {}) {
  const params = new URLSearchParams(location.search);
  const hash = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
  const virtualView = state.favoritesView || state.siteSearchView;
  const codex = virtualView ? (state.browseCodex || state.codex || {}) : (state.codex || {});
  const images = entry ? entryImages(entry) : [];
  const index = clamp(Number(imageIndex) || 0, 0, Math.max(0, images.length - 1));
  const image = images[index] || null;
  return {
    source,
    page: {
      url: location.href,
      pathname: location.pathname,
      query: location.search,
      hash: location.hash,
    },
    route: {
      codex: params.get('codex') || codex.id || '',
      path: params.getAll('path'),
      q: params.get('q') || state.query || '',
      entry: params.get('entry') || hash.get('entry') || state.lightbox?.entry?.id || '',
      onlyImaged: Boolean(state.onlyImaged),
      onlyFav: Boolean(state.onlyFav),
      favoritesView: Boolean(state.favoritesView),
      siteSearchView: Boolean(state.siteSearchView),
      searchScope: state.searchScope || '',
    },
    codex: {
      id: codex.id || '',
      title: codex.title || '',
      version: codex.version || '',
      author: codex.author || '',
      dataStatus: codex.dataStatus || '',
      sourceDataUrl: codex.sourceDataUrl || '',
      dataUrl: codex.dataUrl || '',
    },
    entry: entry ? {
      id: entry.id || '',
      title: entry.title || '',
      /* 收藏墙里的词条回报真实来源，维护者按 sourceCodexId 定位原书 */
      sourceCodexId: entry._srcCodexId || '',
      path: Array.isArray(entry._srcPath || entry.path) ? (entry._srcPath || entry.path) : [],
      hasImage: hasEntryImage(entry),
      imageCount: images.length,
      selectedImageIndex: image ? index : -1,
      thumbnailUrl: image ? imageItemUrl('image', entry, image) : (hasEntryImage(entry) ? thumbUrl(entry) : ''),
      originalUrl: image ? imageItemUrl('original', entry, image) : (hasEntryImage(entry) ? originalUrl(entry) : ''),
      imageError: Boolean(imageError),
      tagsSnippet: snippet(entry.tags),
      negativeSnippet: snippet(entry.negative),
      noteSnippet: snippet(entry.note),
    } : null,
    environment: {
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      devicePixelRatio: window.devicePixelRatio || 1,
      language: navigator.language || '',
      timestamp: new Date().toISOString(),
    },
  };
}

function resetFeedbackForm(type, context) {
  const form = $('#feedbackForm');
  if (form) form.reset();
  $('#feedbackType').value = type;
  $('#feedbackDesc').value = '';
  $('#feedbackContact').value = '';
  $('#feedbackPrivate').checked = false;
  $('#feedbackHoneypot').value = '';
  const fallback = $('#feedbackFallback');
  if (fallback) fallback.hidden = true;
  const status = $('#feedbackStatus');
  if (status) {
    status.textContent = '';
    status.classList.remove('error', 'success');
  }
  renderContextPreview(context);
}

function renderContextPreview(context) {
  const preview = $('#feedbackContextPreview');
  if (!preview) return;
  const entry = context.entry;
  const bits = [
    `页面：${context.page.url}`,
    `法典：${context.codex.title || context.codex.id || '未加载'}`,
  ];
  if (entry) {
    bits.push(`词条：${entry.title || entry.id}`);
    if (entry.path?.length) bits.push(`路径：${entry.path.join(' > ')}`);
    if (entry.originalUrl) bits.push(`原图：${entry.originalUrl}`);
  }
  preview.textContent = bits.join('\n');
}

async function submitFeedback(ev) {
  ev.preventDefault();
  if (!currentPayload) return;
  const submit = $('#feedbackSubmit');
  const status = $('#feedbackStatus');
  const type = $('#feedbackType')?.value || 'site_bug';
  const description = ($('#feedbackDesc')?.value || '').trim();
  const contact = ($('#feedbackContact')?.value || '').trim();
  const publicConsent = !Boolean($('#feedbackPrivate')?.checked);
  const honeypot = $('#feedbackHoneypot')?.value || '';
  if (!TYPE_VALUES.includes(type)) {
    showStatus('请选择有效的反馈类型。', true);
    return;
  }
  if (description.length < MIN_DESC) {
    showStatus(`请再多写一点，至少 ${MIN_DESC} 个字。`, true);
    return;
  }
  if (description.length > MAX_DESC) {
    showStatus(`反馈内容最多 ${MAX_DESC} 个字。`, true);
    return;
  }
  if (contact.length > MAX_CONTACT) {
    showStatus(`联系方式最多 ${MAX_CONTACT} 个字。`, true);
    return;
  }

  currentPayload = {
    type,
    description,
    contact,
    publicConsent,
    context: currentPayload.context,
    honeypot,
  };
  const fallbackText = buildFallbackText(currentPayload);
  if (submit) submit.disabled = true;
  if (status) {
    status.textContent = '正在提交...';
    status.classList.remove('error', 'success');
  }
  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(currentPayload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `提交失败（${res.status}）`);
    toast('反馈已提交，感谢你帮忙把这里修得更好');
    $('#feedbackDesc').value = '';
    $('#feedbackContact').value = '';
    $('#feedbackPrivate').checked = false;
    $('#feedbackHoneypot').value = '';
    currentPayload = {
      type,
      description: '',
      contact: '',
      publicConsent: true,
      context: currentPayload.context,
      honeypot: '',
    };
    showStatus(publicConsent
      ? '反馈已提交。维护者确认公开后，会出现在「处理进度」中。'
      : '反馈已提交。本条已选择不公开，因此无法查看处置进度和维护者回复。', false, true);
  } catch (err) {
    console.warn(err);
    showFallback(fallbackText);
    showStatus('提交失败，下面已生成可复制的反馈文本。', true);
  } finally {
    if (submit) submit.disabled = false;
  }
}

function showStatus(text, isError = false, isSuccess = false) {
  const status = $('#feedbackStatus');
  if (!status) return;
  status.textContent = text;
  status.classList.toggle('error', Boolean(isError));
  status.classList.toggle('success', Boolean(isSuccess));
}

function showFallback(text) {
  const box = $('#feedbackFallback');
  const ta = $('#feedbackFallbackText');
  if (ta) ta.value = text;
  if (box) box.hidden = false;
}

async function copyFallbackText() {
  const text = $('#feedbackFallbackText')?.value || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('反馈文本已复制');
}

function selectFeedbackTab(value) {
  const tab = value === 'progress' ? 'progress' : 'submit';
  document.querySelectorAll('[data-feedback-tab]').forEach(button => {
    const active = button.dataset.feedbackTab === tab;
    button.setAttribute('aria-selected', active ? 'true' : 'false');
    button.tabIndex = active ? 0 : -1;
  });
  const submitView = $('#feedbackSubmitView');
  const progressView = $('#feedbackProgressView');
  if (submitView) submitView.hidden = tab !== 'submit';
  if (progressView) progressView.hidden = tab !== 'progress';
  if (tab === 'progress') loadPublicFeedback();
}

async function loadPublicFeedback({ force = false } = {}) {
  if (publicFeedbackLoading) return;
  if (publicFeedbackLoaded && !force) {
    renderPublicFeedback();
    return;
  }
  publicFeedbackLoading = true;
  const refresh = $('#feedbackProgressRefresh');
  const list = $('#feedbackPublicList');
  if (refresh) {
    refresh.disabled = true;
    refresh.setAttribute('aria-busy', 'true');
  }
  if (list) {
    list.setAttribute('aria-busy', 'true');
    list.innerHTML = '<div class="feedback-public-state is-loading"><i></i><span>正在加载公开处理进度…</span></div>';
  }
  try {
    const response = await fetch('/api/feedback-public', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || `加载失败（${response.status}）`);
    }
    publicFeedbackItems = Array.isArray(data.items) ? data.items : [];
    publicFeedbackLoaded = true;
    updatePublicFeedbackCount();
    renderPublicFeedback();
  } catch (error) {
    console.warn(error);
    if (list) {
      list.innerHTML = `
        <div class="feedback-public-state is-error">
          <b>处理进度暂时加载失败</b>
          <span>请稍后刷新重试，提交反馈仍可正常使用。</span>
          <button type="button" data-feedback-retry>重新加载</button>
        </div>`;
      list.querySelector('[data-feedback-retry]')?.addEventListener('click', () => loadPublicFeedback({ force: true }));
    }
  } finally {
    publicFeedbackLoading = false;
    if (refresh) {
      refresh.disabled = false;
      refresh.removeAttribute('aria-busy');
    }
    list?.removeAttribute('aria-busy');
  }
}

function renderPublicFeedback() {
  const list = $('#feedbackPublicList');
  if (!list) return;
  document.querySelectorAll('[data-feedback-filter]').forEach(button => {
    button.setAttribute('aria-pressed', button.dataset.feedbackFilter === publicFeedbackFilter ? 'true' : 'false');
  });
  const items = publicFeedbackItems.filter(item => {
    const closed = isFeedbackProgressClosed(item.progressStatus);
    if (publicFeedbackFilter === 'open') return !closed;
    if (publicFeedbackFilter === 'closed') return closed;
    return true;
  });
  if (!items.length) {
    const message = publicFeedbackItems.length
      ? '当前筛选下没有公开反馈。'
      : '还没有公开反馈。经过反馈者和维护者均确认公开后，会显示在这里。';
    list.innerHTML = `<div class="feedback-public-state">${esc(message)}</div>`;
    return;
  }
  list.innerHTML = items.map(renderPublicFeedbackCard).join('');
}

function renderPublicFeedbackCard(item) {
  const progress = feedbackProgressMeta(item.progressStatus);
  const context = publicFeedbackContext(item.context);
  const updatedAt = Number(item.updatedAt || item.replyUpdatedAt || item.progressStatusUpdatedAt || item.createdAt || 0);
  const dateTime = updatedAt ? ` datetime="${new Date(updatedAt).toISOString()}"` : '';
  return `
    <details class="feedback-public-card">
      <summary>
        <span class="feedback-public-card-top">
          <span class="feedback-public-type">${esc(item.typeLabel || item.type || '反馈')}</span>
          <span class="feedback-public-status ${publicProgressTone(item.progressStatus)}">${esc(progress.label)}</span>
        </span>
        <span class="feedback-public-description">${esc(item.description || '无反馈内容')}</span>
        <span class="feedback-public-card-meta">
          ${context ? `<span>${esc(context)}</span>` : ''}
          <time${dateTime}>更新于 ${esc(formatPublicDate(updatedAt))}</time>
        </span>
      </summary>
      <div class="feedback-public-card-body">
        <p class="feedback-public-progress-copy">${esc(progress.description)}</p>
        <div class="feedback-public-reply${item.adminReply ? '' : ' is-empty'}">
          <b>维护者回复</b>
          <p>${esc(item.adminReply || '暂时还没有公开回复。')}</p>
        </div>
        <small>反馈提交于 ${esc(formatPublicDate(item.createdAt))}</small>
      </div>
    </details>`;
}

function publicFeedbackContext(value) {
  const context = value && typeof value === 'object' ? value : {};
  const codex = context.codex && typeof context.codex === 'object' ? context.codex : {};
  const entry = context.entry && typeof context.entry === 'object' ? context.entry : {};
  const directory = Array.isArray(entry.path) ? entry.path.filter(Boolean).join(' › ') : '';
  return [
    codex.title || codex.id,
    entry.title || entry.id,
    directory,
  ].filter(Boolean).join(' · ');
}

function publicProgressTone(status) {
  if (status === 'completed') return 'is-completed';
  if (status === 'declined') return 'is-declined';
  if (status === 'deferred' || status === 'verifying') return 'is-paused';
  return status === 'unread' ? 'is-received' : 'is-active';
}

function formatPublicDate(value) {
  const time = Number(value || 0);
  if (!time) return '暂无时间';
  try {
    return new Date(time).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return '暂无时间';
  }
}

function updatePublicFeedbackCount() {
  const count = $('#feedbackPublicCount');
  if (!count) return;
  count.textContent = String(publicFeedbackItems.length);
  count.hidden = publicFeedbackItems.length === 0;
}

function defaultTypeFor({ source, imageError }) {
  if (imageError) return 'image_error';
  if (source === 'card' || source === 'lightbox') return 'card_content';
  return 'site_bug';
}

function buildFallbackText(payload) {
  return [
    '【法典图鉴反馈】',
    `类型：${REPORT_TYPES[payload.type] || payload.type}`,
    `类型ID：${payload.type}`,
    `描述：${payload.description}`,
    `联系方式：${payload.contact || '未填写'}`,
    `选择不公开：${payload.publicConsent ? '否' : '是'}`,
    '',
    '【自动打包上下文】',
    JSON.stringify(payload.context, null, 2),
  ].join('\n');
}

function snippet(value) {
  const text = String(value || '').trim();
  return text.length > MAX_SNIPPET ? `${text.slice(0, MAX_SNIPPET)}...` : text;
}

export function reportTypeLabel(type) {
  return REPORT_TYPES[type] || type;
}
