import { state } from './state.js';
import { $, clamp, esc } from './utils.js';
import { toast } from './feedback.js';
import { openMask, closeMask, trapFocus, bindBackdropDismiss } from './modal.js';
import { animateUi, cancelUiMotion } from './ui-motion.js';
import { entryImages, imageItemUrl, thumbUrl, hasEntryImage } from './media.js';
import { entryImageCanUseOriginal } from './original-capability.js';
import {
  feedbackProgressMeta,
  feedbackProgressFlow,
  isFeedbackProgressClosed,
} from './feedback-progress.js';
import { ownedRecordIds, readOwnedRecords, rememberOwnedRecord } from './local-ownership.js';
import { writeClipboardText } from './clipboard.js';
import { showClipboardFallback } from './clipboard-fallback.js';

export function feedbackTimeoutSignal(timeout = 20_000, signalApi = globalThis.AbortSignal) {
  return signalApi?.timeout?.(timeout);
}

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
const OWNED_FEEDBACK_KEY = 'fadian-feedback-owned-v1';

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
  bindBackdropDismiss(mask, () => closeMask(mask));
  mask.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
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
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const offset = event.key === 'ArrowRight' ? 1 : -1;
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + offset + tabs.length) % tabs.length;
      const next = tabs[nextIndex];
      selectFeedbackTab(next.dataset.feedbackTab);
      next.focus({ preventScroll: true });
    });
  });
  mask.querySelectorAll('[data-feedback-filter]').forEach(button => {
    button.addEventListener('click', () => {
      publicFeedbackFilter = button.dataset.feedbackFilter || 'all';
      renderPublicFeedback();
    });
  });
  $('#feedbackProgressRefresh')?.addEventListener('click', () => loadPublicFeedback({ force: true }));
  // 共享遮罩的 Back / Esc 关闭同样结束局部动效，重开不会接续旧页的半帧。
  new MutationObserver(() => {
    if (mask.hidden || !mask.classList.contains('show')) cancelFeedbackTabMotion();
  }).observe(mask, { attributes: true, attributeFilter: ['class', 'hidden'] });
}

export function openReportDialog({ source = 'global', entry = null, imageIndex = 0, defaultType = '', imageError = false, tab = 'submit', trigger = document.activeElement, historyMode = 'push' } = {}) {
  const mask = $('#feedbackPanel');
  if (!mask) return;
  cancelFeedbackTabMotion();
  currentTrigger = trigger instanceof HTMLElement ? trigger : document.activeElement;
  const type = TYPE_VALUES.includes(defaultType)
    ? defaultType
    : defaultTypeFor({ source, imageError });
  const context = buildFeedbackContext({ source, entry, imageIndex, imageError });
  currentPayload = { type, description: '', contact: '', context, honeypot: '' };
  resetFeedbackForm(type, context);
  selectFeedbackTab(tab === 'progress' ? 'progress' : 'submit');
  openMask(mask, currentTrigger, { historyMode });
  /* 无论停在哪个 tab 都预取一次公开进度，让「处理进度」tab 的计数尽早出现（本会话仅拉一次）。 */
  loadPublicFeedback();
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
      codex: params.get('c') || params.get('codex') || codex.id || '',
      path: params.getAll('path'),
      pathCode: params.get('p') || '',
      q: params.get('q') || state.query || '',
      searchFilters: params.getAll('f').length ? params.getAll('f') : [...(state.searchFilterValues || [])],
      entry: params.get('entry') || hash.get('entry') || state.lightbox?.entry?.id || '',
      updateFilter: String(state.updateFilter || ''),
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
      originalUrl: image && entryImageCanUseOriginal(entry, image)
        ? imageItemUrl('original', entry, image)
        : '',
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
      signal: feedbackTimeoutSignal(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `提交失败（${res.status}）`);
    if (data.id) {
      rememberOwnedRecord(OWNED_FEEDBACK_KEY, {
        id: data.id,
        createdAt: Date.now(),
      });
    }
    toast('反馈已提交，感谢你帮忙把这里修得更好');
    $('#feedbackDesc').value = '';
    $('#feedbackContact').value = '';
    $('#feedbackHoneypot').value = '';
    currentPayload = {
      type,
      description: '',
      contact: '',
      context: currentPayload.context,
      honeypot: '',
    };
    showStatus('反馈已提交。维护者确认公开后，会出现在「处理进度」中。', false, true);
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
  const trigger = $('#feedbackCopyFallback');
  const result = await writeClipboardText(text);
  if (result.ok) {
    toast('反馈文本已复制');
    return;
  }
  const manualFallbackShown = showClipboardFallback(text, { trigger });
  toast(
    manualFallbackShown
      ? '自动复制未成功，已打开手动复制面板'
      : '自动复制未成功，请长按/手动选择文本',
    '!',
  );
}

function cancelFeedbackTabMotion() {
  cancelUiMotion($('#feedbackSubmitView'));
  cancelUiMotion($('#feedbackProgressView'));
}

function selectFeedbackTab(value) {
  const tab = value === 'progress' ? 'progress' : 'submit';
  const mask = $('#feedbackPanel');
  const submitView = $('#feedbackSubmitView');
  const progressView = $('#feedbackProgressView');
  const nextView = tab === 'progress' ? progressView : submitView;
  const open = Boolean(mask && !mask.hidden && mask.classList.contains('show'));
  // 重复选择不重画进度列表，保留已经展开的反馈卡片，也不重播动画。
  if (open && nextView && !nextView.hidden) return;
  const changed = Boolean(nextView?.hidden);
  cancelFeedbackTabMotion();
  mask?.querySelector('.feedback-tabs')?.style.setProperty('--feedback-tab-index', tab === 'progress' ? '1' : '0');
  document.querySelectorAll('[data-feedback-tab]').forEach(button => {
    const active = button.dataset.feedbackTab === tab;
    button.setAttribute('aria-selected', active ? 'true' : 'false');
    button.tabIndex = active ? 0 : -1;
  });
  if (submitView) submitView.hidden = tab !== 'submit';
  if (progressView) progressView.hidden = tab !== 'progress';
  if (tab === 'progress') loadPublicFeedback();
  // 请求与状态立即交接；只动新页内容，不锁定异步进度列表的高度。
  if (open && changed) animateUi(nextView, [
    { opacity: 0, translate: tab === 'progress' ? '8px 0' : '-8px 0' },
    { opacity: 1, translate: '0 0' },
  ]);
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
    const response = await fetch('/api/feedback-public', {
      cache: 'no-store',
      signal: feedbackTimeoutSignal(),
    });
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
  const ownedRecords = readOwnedRecords(OWNED_FEEDBACK_KEY);
  const ownedIds = ownedRecordIds(OWNED_FEEDBACK_KEY);
  const publicOwnedCount = publicFeedbackItems.filter(item => ownedIds.has(String(item.id || ''))).length;
  const items = publicFeedbackItems.filter(item => {
    const closed = isFeedbackProgressClosed(item.progressStatus);
    if (publicFeedbackFilter === 'open') return !closed;
    if (publicFeedbackFilter === 'closed') return closed;
    return true;
  }).sort((a, b) => Number(ownedIds.has(String(b.id || ''))) - Number(ownedIds.has(String(a.id || ''))));
  if (!items.length) {
    const message = publicFeedbackItems.length
      ? '当前筛选下没有公开反馈。'
      : '还没有公开反馈。由维护者确认公开后，会显示在这里。';
    const owned = ownedRecords.length
      ? `<small>本设备提交过 ${ownedRecords.length} 条，其中 ${publicOwnedCount} 条已公开；未公开不代表丢失。</small>`
      : '';
    list.innerHTML = `<div class="feedback-public-state">${esc(message)}${owned}</div>`;
    return;
  }
  const ownedSummary = ownedRecords.length
    ? `<div class="feedback-public-owned-summary">本设备提交过 ${ownedRecords.length} 条，其中 ${publicOwnedCount} 条已公开；记录仅保存在当前浏览器。</div>`
    : '';
  list.innerHTML = ownedSummary + items.map(item => renderPublicFeedbackCard(item, ownedIds)).join('');
}

function renderPublicFeedbackCard(item, ownedIds = new Set()) {
  const progress = feedbackProgressMeta(item.progressStatus);
  const context = publicFeedbackContext(item.context);
  const updatedAt = Number(item.updatedAt || item.replyUpdatedAt || item.progressStatusUpdatedAt || item.createdAt || 0);
  const dateTime = updatedAt ? ` datetime="${new Date(updatedAt).toISOString()}"` : '';
  const owned = ownedIds.has(String(item.id || ''));
  return `
    <details class="feedback-public-card${owned ? ' is-owned' : ''}">
      <summary>
        <span class="feedback-public-card-top">
          <span class="feedback-public-type">${esc(item.typeLabel || item.type || '反馈')}${owned ? '<b>我提交的</b>' : ''}</span>
          <span class="feedback-public-status ${publicProgressTone(item.progressStatus)}">${esc(progress.label)}</span>
        </span>
        <span class="feedback-public-description">${esc(item.description || '无反馈内容')}</span>
        <span class="feedback-public-card-meta">
          ${context ? `<span>${esc(context)}</span>` : ''}
          <time${dateTime}>更新于 ${esc(formatPublicDate(updatedAt))}</time>
        </span>
      </summary>
      <div class="feedback-public-card-body">
        ${renderProgressFlow(item.progressStatus)}
        <p class="feedback-public-progress-copy">${esc(progress.description)}</p>
        ${renderPublicReply(item)}
        <small>反馈提交于 ${esc(formatPublicDate(item.createdAt))}</small>
      </div>
    </details>`;
}

/* 把当前进度画成一条 5 段迷你步骤条；暂不采纳不走线性流程，返回空串。 */
function renderProgressFlow(status) {
  const flow = feedbackProgressFlow(status);
  if (!flow) return '';
  const nodes = flow.steps.map((step, i) => {
    const cls = i < flow.currentIndex
      ? 'is-done'
      : i === flow.currentIndex
        ? (flow.done ? 'is-done' : flow.paused ? 'is-paused' : 'is-current')
        : 'is-todo';
    return `<li class="${cls}"><span class="feedback-flow-dot" aria-hidden="true"></span><span class="feedback-flow-label">${esc(step.label)}</span></li>`;
  }).join('');
  return `<ol class="feedback-flow" aria-label="处理进度">${nodes}</ol>`;
}

/* 有回复就展示；没回复时只有已结案（完成/暂不采纳）才显示占位——处理中没回复是正常的，不必制造「没有回复」的负面暗示。 */
function renderPublicReply(item) {
  if (item.adminReply) {
    return `<div class="feedback-public-reply"><b>维护者回复</b><p>${esc(item.adminReply)}</p></div>`;
  }
  if (isFeedbackProgressClosed(item.progressStatus)) {
    return '<div class="feedback-public-reply is-empty"><b>维护者回复</b><p>已结案，维护者暂未留下公开说明。</p></div>';
  }
  return '';
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
  const total = publicFeedbackItems.length;
  const closed = publicFeedbackItems.filter(item => isFeedbackProgressClosed(item.progressStatus)).length;
  const counts = { all: total, open: total - closed, closed };
  const badge = $('#feedbackPublicCount');
  if (badge) {
    badge.textContent = total ? `${closed}/${total}` : '';
    badge.hidden = total === 0;
  }
  const tab = $('#feedbackProgressTab');
  if (tab) {
    if (total) tab.title = `已公开 ${total} 条 · 已结案 ${closed} 条`;
    else tab.removeAttribute('title');
  }
  document.querySelectorAll('[data-filter-count]').forEach(node => {
    node.textContent = String(counts[node.dataset.filterCount] || 0);
    node.hidden = total === 0;
  });
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
