/* 本地法典编辑模式 UI（P0）。仅当 edit_server 在服务本页时由 app.js 动态 import 并 initEditMode()。
   线上生产探测不到编辑服务，本文件不会被加载。
   与主站的耦合全部走注入的 actions（loadCodex/applyFilter）与既有事件，不反向修改主链路。 */
import { state } from './state.js';
import { $, esc } from './utils.js';
import { toast } from './feedback.js';
import { renderLightbox, closeLightbox, openLightbox } from './lightbox.js';
import { setMasonryActions } from './masonry.js';
import {
  buildPathList, diffFields, validateEntryForm, mergeEntryInPlace, joinTreePath, splitTreePath,
} from './edit-core.js';

const EDIT_MODE_KEY = 'fadian-editmode';
const RATING_OPTIONS = [['', '无'], ['safe', 'safe'], ['r18', 'r18'], ['r18g', 'r18g'], ['restricted', 'restricted']];

let caps = null;                 // /__edit__/ping 返回的能力声明
let acts = {};                   // { loadCodex, applyFilter }
let enabled = false;
let saving = false;
let panelEntryId = null;         // 灯箱编辑面板当前对应的词条 id（用于缓存复用）

export function initEditMode(ping, actions) {
  caps = ping;
  acts = actions || {};
  injectStyles();
  buildToggle();
  enabled = localStorage.getItem(EDIT_MODE_KEY) === '1';
  applyEnabledClass();
  document.addEventListener('lightbox:rendered', onLightboxRendered);
  setMasonryActions({ decorateCard });
  bindTreeAdd();
  decorateExistingCards();   // edit.js 晚于首屏渲染加载，补装当前已在 DOM 的卡片
}

/* 给当前已渲染的卡片补角标（此后新建的卡片走注入的 decorateCard） */
function decorateExistingCards() {
  document.querySelectorAll('#masonry .card').forEach(node => {
    const idx = Number(node.dataset.index);
    const entry = state.placements?.[idx]?.entry;
    if (entry) decorateCard(node, entry);
  });
}

/* ---------- 基础设施 ---------- */

function injectStyles() {
  if (document.getElementById('editModeCss')) return;
  const link = document.createElement('link');
  link.id = 'editModeCss';
  link.rel = 'stylesheet';
  link.href = 'assets/edit.css';
  document.head.appendChild(link);
}

function buildToggle() {
  if (document.getElementById('editToggle')) return;
  const anchor = document.getElementById('themeBtn');
  const actionsBar = anchor?.parentElement || document.querySelector('.topbar-actions');
  if (!actionsBar) return;
  const btn = document.createElement('button');
  btn.id = 'editToggle';
  btn.type = 'button';
  btn.className = 'icon-btn';
  btn.title = '编辑模式（本地）';
  btn.setAttribute('aria-label', '切换编辑模式');
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  btn.onclick = toggleEnabled;
  actionsBar.insertBefore(btn, anchor || actionsBar.firstChild);
}

function toggleEnabled() {
  enabled = !enabled;
  localStorage.setItem(EDIT_MODE_KEY, enabled ? '1' : '0');
  applyEnabledClass();
  if (!enabled) removePanel();
  else if (!state.lightbox?.hidden && state.lightbox?.entry) refreshPanel();
  toast(enabled ? '编辑模式已开启' : '编辑模式已关闭');
}

function applyEnabledClass() {
  document.body.classList.toggle('edit-mode', enabled);
  const btn = document.getElementById('editToggle');
  if (btn) btn.classList.toggle('edit-on', enabled);
  updateWarnBar();
}

function currentCodexId() {
  return state.codex?.id || '';
}

/* 当前上下文是否可编辑：开启 + 当前书在可编辑名单 + 不在虚拟视图（收藏/全站搜索） */
function canEditContext() {
  return enabled && !state.favoritesView && !state.siteSearchView
    && caps?.editable?.includes(currentCodexId());
}

function canEditEntry(entry) {
  return canEditContext() && entry && !entry._srcCodexId;
}

/* docx 冲突警告条：当前书若在 docxWarnings 名单里则常驻提示 */
function updateWarnBar() {
  let bar = document.getElementById('editWarnBar');
  const show = enabled && caps?.docxWarnings?.includes(currentCodexId());
  if (!show) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'editWarnBar';
    bar.className = 'edit-warnbar';
    bar.innerHTML = '<span>⚠ 这本书的 docx 仍在「法典源/」，重跑转换法典会覆盖你在这里的手动修改。</span>';
    const main = document.querySelector('.main') || document.body;
    main.insertBefore(bar, main.firstChild);
  }
}

/* ---------- 服务器通信 ---------- */

async function editFetch(path, body) {
  if (saving) return null;
  saving = true;
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
    if (!data.ok) { toast(data.error || '保存失败'); return null; }
    return data;
  } catch (ex) {
    toast('无法连接编辑服务：' + (ex?.message || ex));
    return null;
  } finally {
    saving = false;
  }
}

/* ---------- 灯箱编辑面板 ---------- */

function onLightboxRendered(ev) {
  const entry = ev.detail?.entry;
  if (!canEditEntry(entry)) { removePanel(); return; }
  buildPanel(entry);
}

function refreshPanel() {
  const entry = state.lightbox?.entry;
  if (canEditEntry(entry)) buildPanel(entry, { force: true });
}

function removePanel() {
  document.getElementById('editPanel')?.remove();
  document.querySelectorAll('.lb-edit-hidden').forEach(el => el.classList.remove('lb-edit-hidden'));
  panelEntryId = null;
}

function buildPanel(entry, { force = false } = {}) {
  const info = $('#lightboxInfo');
  if (!info) return;
  // 同一词条重渲染（如切缩略图）时不重建，保留未保存输入
  if (!force && panelEntryId === entry.id && document.getElementById('editPanel')) return;
  removePanel();
  panelEntryId = entry.id;

  // 隐藏被面板接管的只读展示区
  hideSection('#lightboxTags');
  hideSection('#negativeBlock');
  hideSection('#noteBlock');

  const pathList = buildPathList(state.codex?.tree || []);
  const curPathValue = joinTreePath(entry.path || []);
  const ratingHas = RATING_OPTIONS.some(([v]) => v === (entry.rating || ''));

  const panel = document.createElement('div');
  panel.id = 'editPanel';
  panel.className = 'edit-panel';
  panel.innerHTML = `
    <div class="edit-panel-title">✎ 编辑这张卡片</div>
    <label>标题<input type="text" id="edTitle"></label>
    <label>正向 Tag<textarea id="edTags"></textarea></label>
    <label>负面 Tag<textarea id="edNeg"></textarea></label>
    <label>备注<textarea id="edNote"></textarea></label>
    <div class="edit-panel-row">
      <label>分类
        <select id="edPath">${pathList.map(p => `<option value="${esc(p.value)}">${esc(p.label)}</option>`).join('')}</select>
      </label>
      <label>分级
        <select id="edRating">
          ${RATING_OPTIONS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
          ${ratingHas ? '' : `<option value="${esc(entry.rating)}">${esc(entry.rating)}（原值）</option>`}
        </select>
      </label>
      <label class="edit-check"><input type="checkbox" id="edNew"> 标记为「本次更新」</label>
    </div>
    <div class="edit-imgzone" id="edImgZone"></div>
    <div class="edit-actions">
      <button type="button" class="edit-btn primary" id="edSave">保存</button>
      <button type="button" class="edit-btn danger" id="edDelete">删除此词条</button>
      <span class="edit-hint" id="edHint"></span>
    </div>`;
  const head = info.querySelector('.lightbox-head');
  head ? head.after(panel) : info.prepend(panel);
  buildImageZone(panel.querySelector('#edImgZone'), entry);

  panel.querySelector('#edTitle').value = entry.title || '';
  panel.querySelector('#edTags').value = entry.tags || '';
  panel.querySelector('#edNeg').value = entry.negative || '';
  panel.querySelector('#edNote').value = entry.note || '';
  panel.querySelector('#edPath').value = curPathValue;
  panel.querySelector('#edRating').value = entry.rating || '';
  panel.querySelector('#edNew').checked = entry.isNew === true;

  panel.querySelector('#edSave').onclick = () => saveEntry(entry);
  panel.querySelector('#edDelete').onclick = () => deleteEntry(entry);
  // 面板内交互不冒泡到灯箱关闭
  panel.onclick = ev => ev.stopPropagation();
}

function hideSection(sel) {
  const el = document.querySelector(sel);
  if (!el) return;
  const section = el.closest('.lightbox-section') || el;
  section.classList.add('lb-edit-hidden');
}

function readPanelValues() {
  return {
    title: $('#edTitle')?.value ?? '',
    tags: $('#edTags')?.value ?? '',
    negative: $('#edNeg')?.value ?? '',
    note: $('#edNote')?.value ?? '',
    pathValue: $('#edPath')?.value ?? '',
    rating: $('#edRating')?.value ?? '',
    isNew: Boolean($('#edNew')?.checked),
  };
}

async function saveEntry(entry) {
  const values = readPanelValues();
  const invalid = validateEntryForm(values);
  if (invalid) { toast(invalid); return; }
  const diff = diffFields(entry, values);
  if (!Object.keys(diff).length) { toast('没有改动'); return; }
  const btn = $('#edSave');
  if (btn) btn.disabled = true;
  const res = await editFetch('/__edit__/entry', {
    codexId: currentCodexId(), op: 'update', entryId: entry.id, fields: diff,
  });
  if (btn) btn.disabled = false;
  if (!res) return;
  const structural = 'path' in diff;
  if (structural) {
    await structuralRefresh();
    toast('已保存，分类已更新');
  } else {
    mergeEntryInPlace(entry, res.entry);
    applyServerCounts(res);
    renderLightbox();
    acts.applyFilter?.({ transition: 'none' });
    toast('已保存');
  }
}

async function deleteEntry(entry) {
  if (!window.confirm(`确定删除词条「${entry.title || entry.id}」？\n（图片文件会保留在磁盘，可从 output/edit-backups/ 找回数据）`)) return;
  const res = await editFetch('/__edit__/entry', {
    codexId: currentCodexId(), op: 'delete', entryId: entry.id,
  });
  if (!res) return;
  removePanel();
  closeLightbox();
  await structuralRefresh();
  toast('词条已删除');
}

function applyServerCounts(res) {
  if (!state.codex) return;
  if (typeof res.entryCount === 'number') state.codex.entryCount = res.entryCount;
  if (typeof res.imagedCount === 'number') state.codex.imagedCount = res.imagedCount;
  if (res.tree) state.codex.tree = res.tree;
}

/* 结构变化（换分类/增删）后：让缓存失效并原地重载当前书，不整页刷新 */
async function structuralRefresh() {
  const id = currentCodexId();
  if (!id) return;
  state.codexCache?.delete?.(id);
  await acts.loadCodex?.(id, { historyMode: 'replace', saveBrowse: false });
}

/* ---------- 图片编辑区 ---------- */

function buildImageZone(zone, entry) {
  if (!zone) return;
  // 前端 normalizeEntry 会给单图词条也合成 1 元素 images[]，故只有 >1 才是真多图（留 P1）
  if (Array.isArray(entry.images) && entry.images.length > 1) {
    zone.classList.add('disabled');
    zone.textContent = '这是多图词条，图片编辑将在后续版本支持。';
    return;
  }
  const hasImage = Boolean(entry.image);
  zone.innerHTML = hasImage
    ? '<div>拖入或点击更换图片</div><button type="button" class="edit-btn danger" id="edImgDel" style="margin-top:6px">删除图片</button>'
    : '<div>拖入或点击添加图片（原图会原样保存 + 生成缩略图）</div>';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';
  zone.appendChild(fileInput);

  zone.onclick = ev => {
    if (ev.target.id === 'edImgDel') return;
    fileInput.click();
  };
  fileInput.onchange = () => { if (fileInput.files[0]) uploadImage(entry, fileInput.files[0]); };
  zone.ondragover = ev => { ev.preventDefault(); zone.classList.add('dragover'); };
  zone.ondragleave = () => zone.classList.remove('dragover');
  zone.ondrop = ev => {
    ev.preventDefault();
    zone.classList.remove('dragover');
    const file = ev.dataTransfer?.files?.[0];
    if (file) uploadImage(entry, file);
  };
  const delBtn = zone.querySelector('#edImgDel');
  if (delBtn) delBtn.onclick = ev => { ev.stopPropagation(); deleteImage(entry); };
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

async function uploadImage(entry, file) {
  if (!/^image\//.test(file.type)) { toast('请选择图片文件'); return; }
  let dataURL;
  try { dataURL = await readFileAsDataURL(file); }
  catch { toast('读取文件失败'); return; }
  const entryId = entry.id;
  const res = await editFetch('/__edit__/image', {
    codexId: currentCodexId(), entryId, op: 'set', dataURL,
  });
  if (!res) return;
  // 图片改动会牵动归一化的 images[]，走结构重载再按 id 重开灯箱最稳
  await structuralRefresh();
  reopenLightboxById(entryId);
  toast(res.pendingR2Sync ? '图片已保存 · 记得跑「同步 R2」再发布' : '图片已保存');
}

async function deleteImage(entry) {
  if (!window.confirm('删除这张卡片的图片？（磁盘文件保留，仅从数据中移除引用）')) return;
  const entryId = entry.id;
  const res = await editFetch('/__edit__/image', {
    codexId: currentCodexId(), entryId, op: 'delete',
  });
  if (!res) return;
  await structuralRefresh();
  reopenLightboxById(entryId);
  toast('图片已移除 · 记得跑「同步 R2」再发布');
}

/* 结构重载后按 id 找到新 entry 对象重开灯箱（图片/换分类等操作后保持在原词条） */
function reopenLightboxById(id) {
  const fresh = state.codex?.entries?.find(e => e.id === id);
  if (fresh) openLightbox(fresh, 0, null);
}

/* ---------- 卡片 ✎ 角标 ---------- */

function decorateCard(node, entry) {
  if (!node || !entry || node.querySelector('.edit-badge')) return;
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'edit-badge';
  badge.title = '编辑这张卡片';
  badge.setAttribute('aria-label', '编辑这张卡片');
  badge.textContent = '✎';
  badge.onclick = ev => {
    ev.stopPropagation();
    if (!canEditEntry(entry)) return;
    openLightbox(entry, 0, node.querySelector('.card-img') || null);
  };
  node.appendChild(badge);
}

/* ---------- 目录树「＋ 新增」 ---------- */

let treeAddBtn = null;

function bindTreeAdd() {
  const tree = document.getElementById('tree');
  if (!tree || tree.dataset.editBound) return;
  tree.dataset.editBound = '1';
  treeAddBtn = document.createElement('button');
  treeAddBtn.type = 'button';
  treeAddBtn.className = 'edit-tree-add';
  treeAddBtn.title = '在此分类下新增词条';
  treeAddBtn.setAttribute('aria-label', '在此分类下新增词条');
  treeAddBtn.textContent = '＋';
  treeAddBtn.onclick = ev => {
    ev.stopPropagation();
    const row = treeAddBtn.closest('.tree-row');
    const path = splitTreePath(row?.dataset.path || '');
    if (path.length) openCreateDialog(path);
  };
  // 单个浮动按钮随悬停行移动，免疫 renderTree 全重建
  tree.addEventListener('pointerover', ev => {
    const row = ev.target.closest?.('.tree-row');
    if (!row) return;
    if (!canEditContext() || row.dataset.locked === '1' || !row.dataset.path) return;
    row.appendChild(treeAddBtn);
  });
}

function openCreateDialog(path) {
  const label = path.join(' / ');
  const mask = document.createElement('div');
  mask.className = 'edit-dialog-mask';
  mask.innerHTML = `
    <div class="edit-dialog" role="dialog" aria-modal="true" aria-label="新增词条">
      <h3>新增词条</h3>
      <div class="edit-dialog-path">分类：${esc(label)}</div>
      <label>标题 *<input type="text" id="ndTitle"></label>
      <label>正向 Tag *<textarea id="ndTags"></textarea></label>
      <label>备注（可选）<textarea id="ndNote"></textarea></label>
      <div class="edit-actions">
        <button type="button" class="edit-btn primary" id="ndSave">创建</button>
        <button type="button" class="edit-btn" id="ndCancel">取消</button>
      </div>
    </div>`;
  const close = () => mask.remove();
  mask.onclick = ev => { if (ev.target === mask) close(); };
  document.body.appendChild(mask);
  mask.querySelector('#ndTitle').focus();
  mask.querySelector('#ndCancel').onclick = close;
  mask.querySelector('#ndSave').onclick = async () => {
    const values = {
      title: mask.querySelector('#ndTitle').value,
      tags: mask.querySelector('#ndTags').value,
      pathValue: joinTreePath(path),
    };
    const invalid = validateEntryForm(values, { requireAll: true });
    if (invalid) { toast(invalid); return; }
    const note = mask.querySelector('#ndNote').value.trim();
    const entry = { title: values.title.trim(), tags: values.tags.trim(), path };
    if (note) entry.note = note;
    const btn = mask.querySelector('#ndSave');
    btn.disabled = true;
    const res = await editFetch('/__edit__/entry', { codexId: currentCodexId(), op: 'create', entry });
    btn.disabled = false;
    if (!res) return;
    close();
    await structuralRefresh();
    toast('已新增词条：' + (res.entry?.id || ''));
  };
}
