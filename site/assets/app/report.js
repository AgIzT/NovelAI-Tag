import { state } from './state.js';
import { $, clamp } from './utils.js';
import { toast } from './feedback.js';
import { openMask, closeMask, trapFocus } from './modal.js';
import { entryImages, imageItemUrl, thumbUrl, originalUrl, hasEntryImage } from './media.js';

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
}

export function openReportDialog({ source = 'global', entry = null, imageIndex = 0, defaultType = '', imageError = false, trigger = document.activeElement, historyMode = 'push' } = {}) {
  const mask = $('#feedbackPanel');
  if (!mask) return;
  currentTrigger = trigger instanceof HTMLElement ? trigger : document.activeElement;
  const type = TYPE_VALUES.includes(defaultType)
    ? defaultType
    : defaultTypeFor({ source, imageError });
  const context = buildFeedbackContext({ source, entry, imageIndex, imageError });
  currentPayload = { type, description: '', contact: '', context, honeypot: '' };
  resetFeedbackForm(type, context);
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
      /* 收藏墙里的词条回报真实来源，站长按 sourceCodexId 定位原书 */
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
  $('#feedbackHoneypot').value = '';
  const fallback = $('#feedbackFallback');
  if (fallback) fallback.hidden = true;
  const status = $('#feedbackStatus');
  if (status) {
    status.textContent = '';
    status.classList.remove('error');
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

  currentPayload = { type, description, contact, context: currentPayload.context, honeypot };
  const fallbackText = buildFallbackText(currentPayload);
  if (submit) submit.disabled = true;
  if (status) status.textContent = '正在提交...';
  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(currentPayload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `提交失败（${res.status}）`);
    toast('反馈已提交，感谢你帮忙把这里修得更好');
    closeMask($('#feedbackPanel'));
  } catch (err) {
    console.warn(err);
    showFallback(fallbackText);
    showStatus('提交失败，下面已生成可复制的反馈文本。', true);
  } finally {
    if (submit) submit.disabled = false;
  }
}

function showStatus(text, isError = false) {
  const status = $('#feedbackStatus');
  if (!status) return;
  status.textContent = text;
  status.classList.toggle('error', Boolean(isError));
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
