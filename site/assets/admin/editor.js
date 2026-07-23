import {
  COMMUNITY_CATEGORIES, STATUS_LABELS, FEEDBACK_LABELS,
  FEEDBACK_PROGRESS, FEEDBACK_PROGRESS_STATUSES,
  feedbackDirectory, feedbackProgressStatus, feedbackProgressInfo,
  feedbackProgressBadgeClass, escHtml, escAttr, formatDate,
} from './state.js';
import { fetchCommunityAsset, mutateCommunity } from './api.js';
import { readImageParams } from '../community/png-metadata.js';

export function renderCommunityDetail(item) {
  if (!item) {
    return `<div class="detail-empty"><b>选择一条内容</b><span>右侧会显示完整信息、编辑表单和管理动作。</span></div>`;
  }
  const status = item.status || 'pending';
  const images = Array.isArray(item.images) ? item.images.filter(image => image && image.file) : [];
  const rawCoverIndex = Number(item.coverIndex || 0);
  const coverIndex = images.length ? Math.max(0, Math.min(Number.isFinite(rawCoverIndex) ? rawCoverIndex : 0, images.length - 1)) : 0;
  const tags = Array.isArray(item.tags) ? item.tags.join(', ') : String(item.tags || '');
  return `
    <div class="detail-head">
      <div class="detail-heading">
        <p class="detail-kicker">内容检查器</p>
        <h2>${escHtml(item.title || '未命名投稿')}</h2>
        <p>${escHtml(STATUS_LABELS[status] || status)} · ${escHtml(formatDate(item.updatedAt || item.createdAt))}</p>
      </div>
      <div class="detail-head-tools">
        <span class="badge ${item.nsfw ? 'red' : 'accent'}">${item.nsfw ? 'NSFW' : 'SFW'}</span>
        ${detailCloseButton()}
      </div>
    </div>
    ${renderImageGallery(images, coverIndex, item.title || '未命名投稿', item.id)}
    <form class="editor-form" id="editorForm">
      <div class="field-row">
        ${field('标题', 'editTitle', 'input', item.title || '', '不填自动生成')}
        ${field('投稿人', 'editSubmitter', 'input', item.submitter || '', '匿名')}
      </div>
      ${field('Prompt', 'editPrompt', 'textarea-mono', item.prompt || '')}
      ${field('负面 Prompt', 'editNegative', 'textarea-mono', item.negative || '')}
      <div class="field-row">
        <label class="field"><span class="field-label">分类</span>${categorySelect(item.category)}</label>
        ${field('标签（逗号分隔）', 'editTags', 'input', tags)}
      </div>
      ${field('说明', 'editComment', 'textarea', item.comment || '')}
      ${field('管理备注', 'editAdminNote', 'textarea', item.adminNote || '')}
      <label class="check-line"><input type="checkbox" id="editNsfw"${item.nsfw ? ' checked' : ''}>标记为 NSFW</label>
    </form>
    <div class="detail-actions" data-detail-actions>
      <div class="editor-state" data-editor-state role="status" aria-live="polite">
        <span class="editor-state-dot" aria-hidden="true"></span>
        <span data-editor-state-text>有未保存的修改</span>
      </div>
      <div class="detail-action-buttons">${communityActions(status)}</div>
    </div>
  `;
}

export function collectCommunityEdits() {
  const cover = document.querySelector('input[name="coverIndex"]:checked');
  return {
    title: valueOf('editTitle'),
    submitter: valueOf('editSubmitter'),
    prompt: valueOf('editPrompt'),
    negative: valueOf('editNegative'),
    category: valueOf('editCategory'),
    tags: valueOf('editTags'),
    comment: valueOf('editComment'),
    adminNote: valueOf('editAdminNote'),
    nsfw: !!document.getElementById('editNsfw')?.checked,
    coverIndex: cover ? Number(cover.value || 0) : 0,
  };
}

export function renderFeedbackDetail(item) {
  if (!item) {
    return `<div class="detail-empty"><b>选择一条反馈</b><span>右侧会显示上下文和处理动作。</span></div>`;
  }
  const ctx = item.context || {};
  const entry = ctx.entry || {};
  const page = ctx.page || {};
  const codex = ctx.codex || {};
  const progressStatus = feedbackProgressStatus(item);
  const progress = feedbackProgressInfo(progressStatus);
  const directory = feedbackDirectory(item);
  const updatedAt = [
    item.replyUpdatedAt,
    item.progressStatusUpdatedAt,
    item.statusUpdatedAt,
    item.handledAt,
    item.createdAt,
  ].reduce((latest, value) => Math.max(latest, Number(value) || 0), 0);
  return `
    <div class="detail-head">
      <div class="detail-heading">
        <p class="detail-kicker">反馈详情</p>
        <h2>${escHtml(item.typeLabel || item.type || '反馈')}</h2>
        <p>收到于 ${escHtml(formatDate(item.createdAt))}</p>
      </div>
      <div class="detail-head-tools">
        <span class="badge ${feedbackProgressBadgeClass(progressStatus)}">${escHtml(progress.label)}</span>
        ${detailCloseButton()}
      </div>
    </div>
    <form class="editor-form" id="feedbackEditorForm">
      <div class="field"><label>反馈内容</label><div class="copy-block">${escHtml(item.description || '')}</div></div>
      <div class="field-row">
        <div class="field"><label>联系方式</label><input readonly value="${escAttr(item.contact || '未填写')}"></div>
        <div class="field"><label>法典</label><input readonly value="${escAttr(codex.title || codex.id || '无')}"></div>
      </div>
      <div class="field"><label>词条</label><input readonly value="${escAttr(entry.title || entry.id || '无')}"></div>
      <div class="field"><label>词条目录</label><input readonly value="${escAttr(directory || '无')}"></div>
      <div class="field"><label>页面 URL</label><input readonly value="${escAttr(page.url || '')}"></div>
      <div class="field"><label>完整上下文</label><div class="copy-block">${escHtml(JSON.stringify(ctx, null, 2))}</div></div>
      <section class="feedback-workflow" aria-labelledby="feedbackWorkflowTitle">
        <div class="feedback-workflow-head">
          <div>
            <b id="feedbackWorkflowTitle">反馈者可见进度与回复</b>
            <span>公开反馈页启用后，将展示这里的处理进度和经审核回复；后台归档会自动同步。</span>
          </div>
          <small>最近更新：${escHtml(formatDate(updatedAt))}</small>
        </div>
        <div class="field-row">
          <div class="field">
            <label for="feedbackProgressSelect">展示进度</label>
            <select id="feedbackProgressSelect" aria-describedby="feedbackProgressHint">
              ${feedbackProgressOptions(progressStatus)}
            </select>
            <small class="field-help" id="feedbackProgressHint">${escHtml(feedbackProgressHint(progressStatus))}</small>
          </div>
          <label class="field feedback-reply-field">
            <span class="field-label">站长回复</span>
            <textarea id="feedbackReply" maxlength="2000" placeholder="填写处理说明、修复结果，或不予处理的具体原因">${escHtml(item.adminReply || '')}</textarea>
          </label>
        </div>
      </section>
    </form>
    <div class="detail-actions" data-detail-actions>
      <div class="editor-state" data-editor-state role="status" aria-live="polite">
        <span class="editor-state-dot" aria-hidden="true"></span>
        <span data-editor-state-text>展示进度或回复尚未保存</span>
      </div>
      <div class="detail-action-buttons">
        <button class="soft-btn" type="button" data-copy-feedback="${escAttr(item.id)}">复制上下文</button>
        <button class="primary-btn action-primary" type="button" data-feedback-action="save">保存进度与回复</button>
        <button class="danger-btn danger-quiet" type="button" data-feedback-action="delete">删除反馈</button>
      </div>
    </div>
  `;
}

export function collectFeedbackUpdate() {
  const progressStatus = valueOf('feedbackProgressSelect');
  return {
    progressStatus: FEEDBACK_PROGRESS_STATUSES.includes(progressStatus) ? progressStatus : 'unread',
    adminReply: valueOf('feedbackReply').trim(),
  };
}

function field(label, id, type, value, placeholder = '') {
  if (type === 'textarea' || type === 'textarea-mono') {
    return `<label class="field"><span class="field-label">${escHtml(label)}</span><textarea id="${id}" class="${type === 'textarea-mono' ? 'mono' : ''}" placeholder="${escAttr(placeholder)}">${escHtml(value)}</textarea></label>`;
  }
  return `<label class="field"><span class="field-label">${escHtml(label)}</span><input id="${id}" type="text" value="${escAttr(value)}" placeholder="${escAttr(placeholder)}"></label>`;
}

function categorySelect(category) {
  const current = Array.isArray(category) ? category[0] : category;
  return `<select id="editCategory">${COMMUNITY_CATEGORIES.map(cat => `<option value="${escAttr(cat)}"${cat === current ? ' selected' : ''}>${escHtml(cat)}</option>`).join('')}</select>`;
}

function communityActions(status) {
  const save = '<button class="soft-btn" type="button" data-action="update">保存修改</button>';
  if (status === 'pending') {
    return `<button class="primary-btn action-primary" type="button" data-action="approve">通过并下一条</button>${save}<button class="danger-btn" type="button" data-action="reject">拒绝留档</button><button class="danger-btn danger-quiet" type="button" data-action="delete">删除</button>`;
  }
  if (status === 'approved') {
    return `${save}<button class="soft-btn" type="button" data-action="unpublish">下架</button><button class="danger-btn" type="button" data-action="delete">删除</button>`;
  }
  if (status === 'hidden') {
    return `${save}<button class="primary-btn" type="button" data-action="publish">重新上架</button><button class="danger-btn" type="button" data-action="delete">删除</button>`;
  }
  if (status === 'rejected') {
    return `${save}<button class="primary-btn" type="button" data-action="publish">改为发布</button><button class="danger-btn" type="button" data-action="delete">删除</button>`;
  }
  return `<button class="soft-btn" type="button" data-action="restore">恢复为下架</button><button class="primary-btn" type="button" data-action="publish">重新上架</button><button class="danger-btn" type="button" data-action="purge">永久删除</button>`;
}

function valueOf(id) {
  return document.getElementById(id)?.value || '';
}

function feedbackProgressOptions(current) {
  const groups = [
    ['处理中', ['unread', 'accepted', 'investigating', 'in_progress', 'verifying']],
    ['暂停', ['deferred']],
    ['结案', ['completed', 'declined']],
  ];
  return groups.map(([label, values]) => `
    <optgroup label="${escAttr(label)}">
      ${values.map(value => `<option value="${escAttr(value)}"${value === current ? ' selected' : ''}>${escHtml(FEEDBACK_PROGRESS[value].label)}</option>`).join('')}
    </optgroup>
  `).join('');
}

function feedbackProgressHint(progressStatus) {
  const progress = feedbackProgressInfo(progressStatus);
  return `${progress.description} 保存后归入后台「${FEEDBACK_LABELS[progress.status]}」分组。`;
}

function paramsBadgeText(params) {
  if (!params) return '';
  const source = params.source || '未知来源';
  if (params.verified) return `✦ 参数已验证 · ${source}${params.via === 'stealth' ? '（隐写）' : ''}`;
  return `✦ 参数待复检 · ${source}（隐写声明）`;
}

function renderImageGallery(images, coverIndex, title, itemId = '') {
  if (!images.length) {
    return `<section class="detail-media is-empty" aria-label="投稿图片"><div class="detail-stage-empty"><span>暂无图片</span></div></section>`;
  }
  const cover = images[coverIndex] || images[0];
  const coverAlt = `${title} · 第 ${coverIndex + 1} 张`;
  const coverFull = cover.original || cover.file;
  return `
    <section class="detail-media${images.length > 1 ? ' has-thumbs' : ''}" aria-label="投稿图片" data-gallery-item="${escAttr(itemId)}">
      <div class="detail-stage">
        <a class="detail-stage-link" data-cover-preview href="${escAttr(coverFull)}" target="_blank" rel="noopener" aria-label="查看原图：${escAttr(coverAlt)}">
          <img data-cover-preview-image src="${escAttr(cover.file)}" alt="${escAttr(coverAlt)}">
          <span class="stage-open-hint" data-cover-hint>${cover.original ? '查看原图 ↗' : '查看大图 ↗'}</span>
        </a>
        <span class="stage-count"><span data-cover-position>第 ${coverIndex + 1} 张</span> / ${images.length}</span>
        <span class="stage-param-badge" data-params-badge="${Number(cover.index ?? coverIndex)}"${cover.params ? '' : ' hidden'}>${escHtml(paramsBadgeText(cover.params))}</span>
      </div>
      ${images.length > 1 ? `
        <div class="image-strip" role="radiogroup" aria-label="选择封面">
          ${images.map((image, index) => `
            <label class="image-choice${index === coverIndex ? ' is-cover' : ''}" data-cover-choice data-image-src="${escAttr(image.file)}" data-image-full="${escAttr(image.original || image.file)}" data-image-index="${index}" data-params-text="${escAttr(paramsBadgeText(image.params))}" data-has-original="${image.original ? '1' : ''}">
              <input type="radio" name="coverIndex" value="${index}"${index === coverIndex ? ' checked' : ''} aria-label="设第 ${index + 1} 张为封面">
              <span class="image-choice-frame"><img src="${escAttr(image.file)}" loading="lazy" alt=""><i class="param-mini" data-params-mini="${index}" title="${escAttr(paramsBadgeText(image.params))}"${image.params ? '' : ' hidden'}>✦</i></span>
              <span class="image-choice-caption"><span>第 ${index + 1} 张</span><b>封面</b></span>
            </label>
          `).join('')}
        </div>` : '<input type="radio" name="coverIndex" value="0" checked hidden>'}
    </section>`;
}

function detailCloseButton() {
  return `<button class="detail-close-btn" type="button" data-detail-close aria-label="关闭详情" title="关闭详情"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg></button>`;
}

/* 封面缩略图即时驱动主预览；数据保存仍由 collectCommunityEdits 统一完成。
   预览图用压缩图（快），链接与"查看原图"指向原图（有则用）。 */
if (typeof document !== 'undefined') {
  document.addEventListener('change', event => {
    const progressSelect = event.target instanceof Element
      ? event.target.closest('#feedbackProgressSelect')
      : null;
    if (progressSelect) {
      const hint = document.getElementById('feedbackProgressHint');
      if (hint) hint.textContent = feedbackProgressHint(progressSelect.value);
      return;
    }
    const input = event.target instanceof Element ? event.target.closest('input[name="coverIndex"]') : null;
    if (!input) return;
    const panel = input.closest('.detail-panel') || document;
    const choice = input.closest('[data-cover-choice]');
    const src = choice?.dataset.imageSrc || '';
    const full = choice?.dataset.imageFull || src;
    const index = Number(choice?.dataset.imageIndex || input.value || 0);
    panel.querySelectorAll('[data-cover-choice]').forEach(node => {
      node.classList.toggle('is-cover', node === choice);
    });
    const preview = panel.querySelector('[data-cover-preview]');
    const image = panel.querySelector('[data-cover-preview-image]');
    const position = panel.querySelector('[data-cover-position]');
    const hint = panel.querySelector('[data-cover-hint]');
    const badge = panel.querySelector('[data-params-badge]');
    if (full && preview) preview.href = full;
    if (src && image) image.src = src;
    if (position) position.textContent = `第 ${index + 1} 张`;
    if (hint) hint.textContent = choice?.dataset.hasOriginal ? '查看原图 ↗' : '查看大图 ↗';
    if (badge && choice) {
      const text = choice.dataset.paramsText || '';
      badge.dataset.paramsBadge = String(index);
      badge.hidden = !text;
      badge.textContent = text;
    }
  });
}

/* ---- 隐写声明自动复检 ----
   verified:false 的参数标注来自投稿端浏览器（服务端 CPU 配额解不了全图像素），
   打开详情时在审核端浏览器用同一套识别核心对存储的原图复检，并把结论写回记录：
   检出 → verified:true；未检出 → 移除标注（公开页徽标随之消失）。 */
const paramsChecked = new Set(); // `${id}:${index}`，成功复检过的本会话不重跑

export function verifyPendingParams(item) {
  if (!item || !Array.isArray(item.images)) return;
  for (const image of item.images) {
    const index = Number(image && image.index || 0);
    if (!image || !image.params || image.params.verified || !image.origKey) continue;
    const memoKey = `${item.id}:${index}`;
    if (paramsChecked.has(memoKey)) continue;
    paramsChecked.add(memoKey);
    recheckImageParams(item, image, index).catch(error => {
      paramsChecked.delete(memoKey); // 失败允许下次打开时重试
      console.warn('隐写参数复检失败', error);
    });
  }
}

async function recheckImageParams(item, image, index) {
  const blob = await fetchCommunityAsset(image.origKey);
  const found = await readImageParams(blob);
  const params = found ? { source: found.source, via: found.via, verified: true } : null;
  await mutateCommunity('params', { id: item.id, imageIndex: index, params });
  image.params = params; // item 是 state 引用，后续重渲染直接生效
  updateParamsBadgeDom(item.id, index, params);
}

function updateParamsBadgeDom(itemId, index, params) {
  const gallery = document.querySelector(`[data-gallery-item="${CSS.escape(String(itemId))}"]`);
  if (!gallery) return; // 检查器已切到别的条目
  const text = paramsBadgeText(params);
  const mini = gallery.querySelector(`[data-params-mini="${index}"]`);
  if (mini) {
    mini.hidden = !params;
    mini.title = text;
  }
  const choice = gallery.querySelector(`[data-cover-choice][data-image-index="${index}"]`);
  if (choice) choice.dataset.paramsText = text;
  const badge = gallery.querySelector('[data-params-badge]');
  if (badge && Number(badge.dataset.paramsBadge) === index) {
    badge.hidden = !params;
    badge.textContent = text;
  }
}
