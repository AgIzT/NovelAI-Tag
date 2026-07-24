/* 本地法典编辑模式 UI（P0）。仅当 edit_server 在服务本页时由 app.js 动态 import 并 initEditMode()。
   线上生产探测不到编辑服务，本文件不会被加载。
   与主站的耦合全部走注入的 actions（loadCodex/applyFilter）与既有事件，不反向修改主链路。 */
import { state } from './state.js';
import { $, esc } from './utils.js';
import { toast } from './feedback.js';
import { renderLightbox, closeLightbox } from './lightbox.js';
import { setMasonryActions } from './masonry.js';
import {
  buildPathList, diffFields, validateEntryForm, mergeEntryInPlace, joinTreePath,
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
    <div class="edit-actions">
      <button type="button" class="edit-btn primary" id="edSave">保存</button>
      <button type="button" class="edit-btn danger" id="edDelete">删除此词条</button>
      <span class="edit-hint" id="edHint"></span>
    </div>`;
  const head = info.querySelector('.lightbox-head');
  head ? head.after(panel) : info.prepend(panel);

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

/* ---------- 卡片装饰（提交4 填充） ---------- */

function decorateCard(/* node, entry */) {
  // 占位：提交4 加卡片 ✎ 角标
}
