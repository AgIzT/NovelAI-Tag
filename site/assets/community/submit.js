import { closeMask, isMaskOpen, openMask, trapFocus } from '../app/modal.js';
import { toast } from '../app/feedback.js';
import {
  DEFAULT_COMMUNITY_CATEGORY,
  LIMITS,
  SUBMIT_CATEGORIES,
  SUBMIT_DISABLED,
  SUBMIT_DISABLED_MESSAGE,
} from './constants.js';
import { readImageParams } from './png-metadata.js';
import { $, $$, escHtml } from './utils.js';

let submitMask;
let submitForm;
let submitTriggerSelector = '[data-open-submit]';
let files = [];
let busy = false;
let metadataConsumed = false;
let onSubmitted = null;
let addQueue = Promise.resolve();

export function initSubmitDialog(options = {}) {
  submitMask = $('#submitMask');
  submitForm = $('#submitForm');
  onSubmitted = options.onSubmitted || null;
  if (!submitMask || !submitForm) return;

  bindOpenButtons();
  bindDialog();
  bindDropZone();
  bindCategoryChips();
  updateSubmitDisabledUI();
  setCategory(DEFAULT_COMMUNITY_CATEGORY);
  setPromptSource('manual');
}

export function openSubmitDialog(trigger = document.activeElement) {
  if (SUBMIT_DISABLED) {
    toast(SUBMIT_DISABLED_MESSAGE, '!');
    return;
  }
  if (!submitMask) return;
  clearError();
  openMask(submitMask, trigger);
}

export function closeSubmitDialog() {
  if (!submitMask || !isMaskOpen(submitMask)) return;
  closeMask(submitMask);
}

function bindOpenButtons() {
  $$(submitTriggerSelector).forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault();
      openSubmitDialog(button);
    });
  });
}

function bindDialog() {
  submitMask.addEventListener('click', event => {
    if (event.target === submitMask) closeSubmitDialog();
  });
  submitMask.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSubmitDialog();
      return;
    }
    trapFocus(event, submitMask);
  });
  $('[data-close-submit]', submitMask)?.addEventListener('click', closeSubmitDialog);
  submitForm.addEventListener('submit', submitCommunity);
}

function bindDropZone() {
  const drop = $('#subDrop');
  const input = $('#subFile');
  if (!drop || !input) return;

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    input.click();
  });
  drop.addEventListener('dragover', event => {
    event.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', event => {
    event.preventDefault();
    drop.classList.remove('is-over');
    addFiles([...(event.dataTransfer?.files || [])]);
  });
  input.addEventListener('change', () => {
    addFiles([...input.files]);
    input.value = '';
  });
}

function bindCategoryChips() {
  const box = $('#subCategoryList');
  if (!box) return;
  box.innerHTML = SUBMIT_CATEGORIES.map(category => (
    `<button type="button" class="sub-cat" data-cat="${escHtml(category)}">${escHtml(category)}</button>`
  )).join('');
  box.addEventListener('click', event => {
    const button = event.target.closest('.sub-cat');
    if (button) setCategory(button.dataset.cat);
  });
}

function updateSubmitDisabledUI() {
  $$('[data-open-submit], #submitOpenBtn').forEach(button => {
    button.classList.toggle('is-disabled', SUBMIT_DISABLED);
    button.setAttribute('aria-disabled', String(SUBMIT_DISABLED));
    if (SUBMIT_DISABLED) button.title = SUBMIT_DISABLED_MESSAGE;
  });
}

function setCategory(category) {
  const value = SUBMIT_CATEGORIES.includes(category) ? category : DEFAULT_COMMUNITY_CATEGORY;
  $('#subCategory').value = value;
  $$('#subCategoryList .sub-cat').forEach(button => {
    const active = button.dataset.cat === value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

const SOURCE_LABELS = {
  manual: '手动填写',
  read: '已从图片读出',
  none: '图中未含参数',
};

function setPromptSource(type) {
  const badge = $('#subPromptSrc');
  if (!badge) return;
  badge.className = `sub-source sub-source-${type}`;
  badge.textContent = SOURCE_LABELS[type] || SOURCE_LABELS.manual;
}

function clearError() {
  const error = $('#subErr');
  if (error) error.textContent = '';
}

function showError(message) {
  const error = $('#subErr');
  if (error) error.textContent = message || '';
}

export function addFiles(list) {
  const batch = Array.from(list || []);
  const job = addQueue.then(() => addFilesInner(batch));
  addQueue = job.catch(error => {
    console.error('图片处理队列失败', error);
    showError(error?.message || '图片处理失败');
  });
  return job;
}

async function addFilesInner(list) {
  for (const file of list) {
    if (files.length >= LIMITS.imageCount) {
      showError(`图片最多 ${LIMITS.imageCount} 张`);
      break;
    }
    if (!/^image\//.test(file.type || '')) continue;

    try {
      // 每张图都读参数（文本块 → EXIF → 隐写），角标与"含参数原图"标注按图记录；表单只吃第一张命中的
      const meta = await readImageParams(file);
      if (!metadataConsumed) {
        if (meta && (meta.prompt || meta.negative)) {
          metadataConsumed = true;
          const sourceText = meta.via === 'stealth' ? `${meta.source || '图片'}（隐写）` : (meta.source || '图片');
          if (fillPromptFromMetadata(meta)) toast(`已从${sourceText}读出 prompt，可修改`);
          setPromptSource('read');
        } else {
          setPromptSource('none');
        }
      }

      const { blob, width, height } = await compressImage(file);
      const item = {
        blob,
        url: URL.createObjectURL(blob),
        file,
        width,
        height,
        params: meta ? { source: meta.source, via: meta.via } : null,
      };
      // 原图超限时降级：只收压缩图，原图与"原图参数"标注一并放弃
      if (file.size > LIMITS.origBytes) {
        item.noOriginal = true;
        item.params = null;
        toast(`第 ${files.length + 1} 张原图超过 ${Math.round(LIMITS.origBytes / 1024 / 1024)}MB，将只收录压缩图`, '!');
      } else if (totalUploadBytes() + blob.size + file.size > LIMITS.totalBytes) {
        item.noOriginal = true;
        item.params = null;
        toast('图片总体积接近上限，这张只收录压缩图', '!');
      }
      files.push(item);
      clearError();
    } catch (error) {
      showError(error.message || '图片处理失败');
    }
  }
  renderPreviews();
}

function totalUploadBytes() {
  return files.reduce((sum, item) => sum + item.blob.size + (item.noOriginal ? 0 : item.file?.size || 0), 0);
}

function fillPromptFromMetadata(meta) {
  let filled = false;
  const prompt = $('#subPrompt');
  const negative = $('#subNegative');
  if (meta.prompt && prompt && !prompt.value.trim()) {
    prompt.value = meta.prompt.slice(0, LIMITS.prompt);
    filled = true;
  }
  if (meta.negative && negative && !negative.value.trim()) {
    negative.value = meta.negative.slice(0, LIMITS.negative);
    filled = true;
  }
  return filled;
}

async function compressImage(file) {
  const max = 1100;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('无法读取图片：' + (file.name || ''));
  }

  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const scale = Math.min(1, max / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new Error('图片压缩失败');
  if (blob.size > LIMITS.imageBytes) throw new Error('图片压缩后仍过大');
  return { blob, width: sourceWidth, height: sourceHeight };
}

function renderPreviews() {
  const box = $('#subPreviews');
  if (!box) return;
  box.innerHTML = '';
  files.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'sub-preview';
    const paramBadge = item.params
      ? `<i class="sub-param-badge" title="原图含生成参数（${escHtml(item.params.source || '')}），将随投稿保留">✦</i>`
      : '';
    card.innerHTML = `
      <img src="${item.url}" alt="">
      ${paramBadge}
      <button type="button" aria-label="移除第 ${index + 1} 张图">×</button>
      <span>图 ${index + 1}</span>
    `;
    card.querySelector('button')?.addEventListener('click', () => {
      URL.revokeObjectURL(item.url);
      files.splice(index, 1);
      if (!files.length) {
        metadataConsumed = false;
        setPromptSource('manual');
      }
      renderPreviews();
    });
    box.appendChild(card);
  });
}

function resetSubmitForm() {
  submitForm.reset();
  setCategory(DEFAULT_COMMUNITY_CATEGORY);
  setPromptSource('manual');
  $('#subMore').open = false;
  metadataConsumed = false;
  files.forEach(item => URL.revokeObjectURL(item.url));
  files = [];
  renderPreviews();
  clearError();
}

async function submitCommunity(event) {
  event.preventDefault();
  if (busy || SUBMIT_DISABLED) {
    if (SUBMIT_DISABLED) toast(SUBMIT_DISABLED_MESSAGE, '!');
    return;
  }

  const prompt = $('#subPrompt').value.trim();
  if (!files.length) {
    showError('请至少添加 1 张图');
    return;
  }
  if (!prompt) {
    showError('请填写 Prompt');
    return;
  }

  const fd = new FormData();
  fd.append('title', $('#subTitle').value.trim());
  fd.append('prompt', prompt);
  fd.append('negative', $('#subNegative').value.trim());
  fd.append('comment', $('#subComment').value.trim());
  fd.append('category', $('#subCategory').value);
  fd.append('tags', $('#subTags').value.trim());
  fd.append('submitter', $('#subName').value.trim());
  fd.append('nsfw', $('#subNsfw').checked ? '1' : '0');
  // images=压缩图（瀑布流）；originals=原图（放大 + 参数保全，文件名序号与压缩图配对）
  files.forEach((item, index) => {
    fd.append('images', item.blob, `${index + 1}.jpg`);
    if (item.file && !item.noOriginal) {
      const ext = /\.(png|jpe?g|webp)$/i.exec(item.file.name || '')?.[1]?.toLowerCase() || 'png';
      fd.append('originals', item.file, `${index + 1}.${ext}`);
    }
  });
  fd.append('imagesMeta', JSON.stringify(files.map(item => ({
    width: item.width,
    height: item.height,
    params: item.params || undefined,
  }))));

  busy = true;
  const submit = $('#subGo');
  submit.disabled = true;
  submit.textContent = '上传中…';
  clearError();

  try {
    const response = await fetch('/api/submit', { method: 'POST', body: fd });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      showError(data.error || `提交失败（HTTP ${response.status}）`);
      return;
    }
    resetSubmitForm();
    closeSubmitDialog();
    toast('投稿已提交');
    onSubmitted?.();
  } catch {
    showError('网络错误，请稍后重试');
  } finally {
    busy = false;
    submit.disabled = false;
    submit.textContent = '提交投稿';
  }
}
