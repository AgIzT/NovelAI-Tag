/* 本地法典编辑模式 UI（P0）。仅当 edit_server 在服务本页时由 app.js 动态 import 并 initEditMode()。
   线上生产探测不到编辑服务，本文件不会被加载。
   与主站的耦合全部走注入的 actions（loadCodex/applyFilter）与既有事件，不反向修改主链路。 */
import { state } from './state.js';
import { $, esc } from './utils.js';
import { toast } from './feedback.js';
import { renderLightbox, closeLightbox, openLightbox } from './lightbox.js';
import { setCodexUiActions, closeCodexPicker, invalidateAccessViewMemo, syncCodexPickerCounts } from './codex-ui.js';
import { openMask, closeMask, trapFocus } from './modal.js';
import { fetchDataJson } from '../data-source.js';
import { invalidateSearchableText } from './search.js';
import { invalidateSiteSearchCodex } from './site-search.js';
import {
  buildPathList, diffFields, validateEntryForm, mergeEntryInPlace, joinTreePath, splitTreePath,
} from './edit-core.js';

const EDIT_MODE_KEY = 'fadian-editmode';
const LOCAL_EDIT_MODE_KEY = 'fadian-local-editmode';
const RATING_OPTIONS = [['', '无'], ['safe', 'safe'], ['nsfw', 'nsfw'], ['r18', 'r18'], ['r18g', 'r18g'], ['restricted', 'restricted']];

let caps = null;                 // /__edit__/ping 返回的能力声明
let acts = {};                   // { loadCodex, applyFilter }
let enabled = false;
let saving = false;
let panelEntryId = null;         // 灯箱编辑面板当前对应的词条 id（用于缓存复用）
let activeDialog = null;

export function initEditMode(ping, actions) {
  caps = ping;
  acts = actions || {};
  injectStyles();
  buildToggle();
  // 独立本地版首次打开默认编辑，但允许切换展示态并独立记忆；
  // 不与同端口的仓库维护编辑器共享偏好，避免两种用途互相串状态。
  const storedMode = localStorage.getItem(editModeStorageKey());
  enabled = storedMode == null ? caps?.localEdition === true : storedMode === '1';
  applyEnabledClass();
  document.addEventListener('lightbox:rendered', onLightboxRendered);
  document.addEventListener('codex:loaded', updateWarnBar);
  document.addEventListener('codex:loaded', syncLocalEditionEmptyState);
  // 深链接可能在动态模块加载前已经打开灯箱，补一次初始面板挂载。
  if (state.lightbox?.entry) {
    onLightboxRendered({ detail: { entry: state.lightbox.entry, index: state.lightbox.index } });
  }
  setCodexUiActions({ decorateDoor });
  bindTreeAdd();
  bindCardClick();
  ensureResultBarButton();
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

/* 编辑模式下，把法典选择器底部那扇「社区共建 · 去投稿」的门改成「法典管理」入口。
   不另设顶栏按钮：增删法典本来就属于法典选择器这个语境。
   关掉编辑模式（或线上）时这个钩子不改任何东西，门还是原来的投稿门。 */
function decorateDoor(wrap) {
  const door = wrap.querySelector('.codex-door');
  if (!door) return;
  if (!enabled) {
    // 展示模式既不能露出线上共创死链，也不应保留法典管理入口。
    if (caps?.localEdition === true) {
      door.remove();
      wrap.hidden = true;
    }
    return;
  }
  const swap = document.createElement('button');
  swap.type = 'button';
  swap.className = 'codex-door edit-door';
  swap.setAttribute('aria-label', '法典管理：新建 / 修改 / 删除法典');
  swap.innerHTML =
    '<span class="cd-ico"><svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></span>' +
    '<span class="cd-main">' +
    '<span class="cd-name">法典管理 · 新建 / 删除</span>' +
    '<span class="cd-sub">本地编辑模式：整理你自己的法典</span>' +
    '</span>';
  swap.onclick = ev => {
    ev.preventDefault();
    ev.stopPropagation();
    closeCodexPicker({ historyMode: 'none' });   // 先收起选择器（含移动端历史层），再开管理弹窗
    openCodexManager();
  };
  door.replaceWith(swap);
}

function editModeStorageKey() {
  return caps?.localEdition === true ? LOCAL_EDIT_MODE_KEY : EDIT_MODE_KEY;
}

function syncLocalEditionEmptyState() {
  if (caps?.localEdition !== true) return;
  const noCodex = !state.codexes?.length && !state.codex;
  for (const id of ['editTreeToolbar', 'editNewEntryBtn', 'randomBtn']) {
    const control = document.getElementById(id);
    if (control) control.style.display = noCodex ? 'none' : '';
  }
  const empty = document.getElementById('empty');
  if (!noCodex) {
    if (empty?.classList.contains('local-first-codex')) {
      empty.hidden = true;
      empty.classList.remove('local-first-codex');
      empty.innerHTML = '';
    }
    return;
  }
  const loading = document.getElementById('loading');
  if (loading) loading.hidden = true;
  document.getElementById('main')?.classList.remove('is-loading');
  if (!empty) return;
  empty.className = 'empty local-first-codex';
  empty.innerHTML = enabled
    ? '<div class="empty-mark" aria-hidden="true">＋</div>' +
      '<h2>这里还没有法典</h2>' +
      '<p>创建第一本法典，然后就可以添加分类、词条和本地图片。</p>' +
      '<div class="empty-actions"><button type="button" id="localFirstCodexBtn">＋ 创建我的第一本法典</button></div>'
    : '<h2>这里还没有法典</h2>';
  empty.hidden = false;
  if (enabled) {
    empty.querySelector('#localFirstCodexBtn')?.addEventListener('click', openCodexManager);
  }
}

function toggleEnabled() {
  enabled = !enabled;
  localStorage.setItem(editModeStorageKey(), enabled ? '1' : '0');
  applyEnabledClass();
  closeCodexPicker();
  if (!enabled) removePanel();
  else if (!state.lightbox?.hidden && state.lightbox?.entry) refreshPanel();
  toast(enabled ? '编辑模式已开启' : '编辑模式已关闭');
}

function applyEnabledClass() {
  document.body.classList.toggle('edit-mode', enabled);
  const btn = document.getElementById('editToggle');
  if (btn) {
    btn.classList.toggle('edit-on', enabled);
    btn.setAttribute('aria-pressed', String(enabled));
    btn.title = enabled ? '切换到展示模式' : '切换到编辑模式';
    btn.setAttribute('aria-label', btn.title);
  }
  const codexBtnText = document.getElementById('codexBtnText');
  if (!state.codex && codexBtnText) codexBtnText.textContent = enabled ? '新建法典' : '暂无法典';
  updateWarnBar();
  syncLocalEditionEmptyState();
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

/* 动态编辑弹窗统一接入主站 modal：历史层、初始聚焦、Tab 陷阱、Esc 与焦点恢复。 */
function mountEditDialog(mask, { trigger = document.activeElement } = {}) {
  if (activeDialog?.isConnected) activeDialog.remove();
  mask.id = 'editDialogLayer';
  mask.hidden = true;
  const close = options => closeMask(mask, options);
  mask.addEventListener('click', ev => { if (ev.target === mask) close(); });
  mask.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close();
      return;
    }
    trapFocus(ev, mask);
  });
  document.body.appendChild(mask);
  activeDialog = mask;
  openMask(mask, trigger);
  return close;
}

/* ---------- 服务器通信 ---------- */

/* 统一 POST：成功返回数据，失败返回 null 并 toast。
   opts.wantError=true 时失败也返回服务器的 {ok:false,code}（调用方需要区分错误种类时用）；
   opts.silent=true 只抑制服务器返回的预期错误，连接失败始终提示。 */
async function editFetch(path, body, opts = {}) {
  if (saving) {
    toast('正在保存，请稍候再试');
    return null;
  }
  saving = true;
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
    if (!data.ok) {
      if (!opts.silent) toast(data.error || '保存失败');
      return opts.wantError ? data : null;
    }
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
    await structuralRefresh({ reopenEntryId: entry.id });
    toast('已保存，分类已更新');
  } else {
    mergeEntryInPlace(entry, res.entry);
    invalidateAccessViewMemo();
    invalidateSearchableText(entry);
    invalidateSiteSearchCodex();
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
  syncCodexPickerCounts();
}

/* 结构变化（换分类/增删）后：让缓存失效并原地重载当前书，不整页刷新 */
async function structuralRefresh({
  reopenEntryId = '',
  imageIndex = state.lightbox?.index || 0,
  consumeLayer = false,
} = {}) {
  const id = currentCodexId();
  if (!id) return;
  const route = acts.captureRoute?.('') || {
    codex: id,
    path: [...(state.activePath || [])],
    q: state.query || '',
    scope: state.searchScope || '',
    onlyNew: Boolean(state.onlyNew),
  };
  const scrollY = Math.max(0, window.scrollY || 0);
  invalidateSiteSearchCodex();
  state.codexCache?.delete?.(id);
  await acts.loadCodex?.(id, {
    urlState: { ...route, codex: id, entry: '' },
    historyMode: 'replace',
    transition: 'none',
    consumeLayer,
    parentScrollY: scrollY,
    saveBrowse: false,
  });
  syncCodexPickerCounts();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
    window.scrollTo({ top: scrollY, left: 0, behavior: 'auto' });
    resolve();
  })));
  if (reopenEntryId) {
    // 同 id 的面板会刻意保留未保存输入；结构重载则必须重建，避免按钮继续引用旧 entry 对象。
    removePanel();
    reopenLightboxById(reopenEntryId, imageIndex);
  }
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
  if (file.type && !/^image\//.test(file.type)) { toast('请选择图片文件'); return; }
  let dataURL;
  try { dataURL = await readFileAsDataURL(file); }
  catch { toast('读取文件失败'); return; }
  const entryId = entry.id;
  const res = await editFetch('/__edit__/image', {
    codexId: currentCodexId(), entryId, op: 'set', dataURL,
  });
  if (!res) return;
  // 图片改动会牵动归一化的 images[]，走结构重载再按 id 重开灯箱最稳
  await structuralRefresh({ reopenEntryId: entryId });
  toast(res.pendingR2Sync && caps?.localEdition !== true
    ? '图片已保存 · 记得跑「同步 R2」再发布'
    : '图片已保存到本地');
}

async function deleteImage(entry) {
  if (!window.confirm('删除这张卡片的图片？（磁盘文件保留，仅从数据中移除引用）')) return;
  const entryId = entry.id;
  const res = await editFetch('/__edit__/image', {
    codexId: currentCodexId(), entryId, op: 'delete',
  });
  if (!res) return;
  removePanel();
  closeLightbox({ historyMode: 'none', immediate: true });
  await structuralRefresh({ reopenEntryId: entryId });
  toast(caps?.localEdition === true
    ? '图片已从词条移除 · 本地原文件仍保留'
    : '图片已移除 · 记得跑「同步 R2」再发布');
}

/* 结构重载后按 id 找到新 entry 对象重开灯箱（图片/换分类等操作后保持在原词条） */
function reopenLightboxById(id, imageIndex = 0) {
  const fresh = state.codex?.entries?.find(e => e.id === id);
  if (fresh) openLightbox(fresh, imageIndex, null, {
    historyMode: 'replace', recordRecent: false, allowEmpty: true,
  });
}

/* ---------- 编辑模式下卡片点击 = 进灯箱编辑 ---------- */

/* 编辑模式里「复制 tag」没有意义，而单独的 ✎ 角标与右上放大按钮其实是同一个动作。
   所以：整张卡片点击即进灯箱（放大按钮与角标由 CSS 一并隐藏）。
   用捕获阶段委托在 #masonry 上，天然免疫瀑布流虚拟化与编辑模式随时开关。 */
function bindCardClick() {
  const grid = document.getElementById('masonry');
  if (!grid || grid.dataset.editClickBound) return;
  grid.dataset.editClickBound = '1';
  grid.addEventListener('click', ev => {
    if (!canEditContext()) return;
    const card = ev.target.closest('.card');
    if (!card) return;
    // 收藏 / 反馈 / 底部复制按钮仍走各自逻辑
    if (ev.target.closest('.fav-btn, .report-card-btn, .card-actions')) return;
    const entry = state.placements?.[Number(card.dataset.index)]?.entry;
    if (!canEditEntry(entry)) return;
    ev.preventDefault();
    ev.stopPropagation();   // 拦掉 masonry 自己的「点卡复制」
    openLightbox(entry, 0, card.querySelector('.card-img') || null, {
      recordRecent: false, allowEmpty: true,
    });
  }, true);
}

/* ---------- 目录树行菜单（新增词条 / 新建子分类 / 重命名 / 移动 / 删除） ---------- */

let treeAddBtn = null;

function bindTreeAdd() {
  const tree = document.getElementById('tree');
  if (!tree || tree.dataset.editBound) return;
  tree.dataset.editBound = '1';
  treeAddBtn = document.createElement('button');
  treeAddBtn.type = 'button';
  treeAddBtn.className = 'edit-tree-add';
  treeAddBtn.title = '编辑这个分类';
  treeAddBtn.setAttribute('aria-label', '编辑这个分类');
  treeAddBtn.textContent = '⋯';
  treeAddBtn.onclick = ev => {
    ev.stopPropagation();
    const row = treeAddBtn.closest('.tree-row');
    const path = splitTreePath(row?.dataset.path || '');
    if (path.length) openTreeMenu(row, path);
  };
  // 单个浮动按钮随悬停行移动，免疫 renderTree 全重建
  tree.addEventListener('pointerover', ev => {
    const row = ev.target.closest?.('.tree-row');
    if (!row) return;
    if (!canEditContext() || row.dataset.locked === '1' || !row.dataset.path) return;
    // ⚠ 已经在这一行就别再 append：重复插入会移动 DOM 节点，
    //   打断进行中的 mousedown→mouseup 配对，click 永不触发（按钮点了没反应的真凶）
    if (treeAddBtn.parentElement === row) return;
    row.appendChild(treeAddBtn);
  });
  ensureTreeToolbar();
}

/* 目录树顶部常驻工具条：新建一级分类（空树时也有入口） */
function ensureTreeToolbar() {
  const tree = document.getElementById('tree');
  if (!tree || document.getElementById('editTreeToolbar')) return;
  const bar = document.createElement('div');
  bar.id = 'editTreeToolbar';
  bar.className = 'edit-tree-toolbar';
  bar.innerHTML = '<button type="button" class="edit-chip" id="edNewTopCat">＋ 新建一级分类</button>';
  tree.parentElement?.insertBefore(bar, tree);
  bar.querySelector('#edNewTopCat').onclick = () => {
    if (!canEditContext()) { toast('当前法典不可编辑'); return; }
    openPromptDialog({
      title: '新建一级分类',
      label: '分类名',
      onSubmit: async name => {
        const res = await editFetch('/__edit__/category', {
          codexId: currentCodexId(), op: 'create', parentPath: [], name,
        });
        if (!res) return false;
        await structuralRefresh({ consumeLayer: true });
        toast('已新建分类：' + name);
        return true;
      },
    });
  };
}

function closeTreeMenu() {
  document.getElementById('editTreeMenu')?.remove();
}

function openTreeMenu(row, path) {
  closeTreeMenu();
  const label = path.join(' / ');
  const menu = document.createElement('div');
  menu.id = 'editTreeMenu';
  menu.className = 'edit-menu';
  menu.innerHTML = `
    <div class="edit-menu-head">${esc(label)}</div>
    <button type="button" data-act="entry">＋ 在此新增词条</button>
    <button type="button" data-act="sub">＋ 新建子分类</button>
    <button type="button" data-act="rename">✎ 重命名</button>
    <button type="button" data-act="move">↦ 移动到…</button>
    <button type="button" data-act="delete" class="danger">✕ 删除分类</button>`;
  const rect = row.getBoundingClientRect();
  menu.style.top = `${Math.round(rect.bottom + 4)}px`;
  menu.style.left = `${Math.round(rect.left)}px`;
  document.body.appendChild(menu);
  requestAnimationFrame(() => document.addEventListener('click', closeTreeMenu, { once: true }));
  menu.onclick = ev => {
    ev.stopPropagation();
    const act = ev.target.closest('button')?.dataset.act;
    if (!act) return;
    closeTreeMenu();
    if (act === 'entry') openCreateDialog(path);
    else if (act === 'sub') createSubCategory(path);
    else if (act === 'rename') renameCategory(path);
    else if (act === 'move') moveCategory(path);
    else if (act === 'delete') deleteCategory(path);
  };
}

function createSubCategory(parentPath) {
  openPromptDialog({
    title: '新建子分类',
    hint: '父分类：' + parentPath.join(' / '),
    label: '分类名',
    onSubmit: async name => {
      const res = await editFetch('/__edit__/category', {
        codexId: currentCodexId(), op: 'create', parentPath, name,
      });
      if (!res) return false;
      await structuralRefresh({ consumeLayer: true });
      toast('已新建子分类：' + name);
      return true;
    },
  });
}

function renameCategory(path) {
  openPromptDialog({
    title: '重命名分类',
    hint: '当前：' + path.join(' / '),
    label: '新分类名',
    value: path[path.length - 1],
    onSubmit: async name => {
      const res = await editFetch('/__edit__/category', {
        codexId: currentCodexId(), op: 'rename', path, name,
      });
      if (!res) return false;
      await structuralRefresh({ consumeLayer: true });
      toast(`已重命名（${res.entry?.movedEntries ?? 0} 条词条随之更新）`);
      return true;
    },
  });
}

function moveCategory(path) {
  const options = buildPathList(state.codex?.tree || [])
    .filter(p => {
      const parts = p.parts;
      if (parts.length >= path.length && joinTreePath(parts.slice(0, path.length)) === joinTreePath(path)) return false;
      return true;   // 排除自己与自己的子树
    });
  const cur = path.slice(0, -1).join(' / ') || '（顶层）';
  openSelectDialog({
    title: '移动分类',
    hint: `「${path.join(' / ')}」当前在：${cur}`,
    label: '移动到',
    options: [{ value: '', label: '（顶层）' }, ...options.map(p => ({ value: p.value, label: p.label }))],
    onSubmit: async value => {
      const res = await editFetch('/__edit__/category', {
        codexId: currentCodexId(), op: 'move', path, newParentPath: splitTreePath(value),
      });
      if (!res) return false;
      await structuralRefresh({ consumeLayer: true });
      toast(`已移动（${res.entry?.movedEntries ?? 0} 条词条随之更新）`);
      return true;
    },
  });
}

async function deleteCategory(path) {
  const label = path.join(' / ');
  if (!window.confirm(`删除分类「${label}」？`)) return;
  let res = await editFetch(
    '/__edit__/category',
    { codexId: currentCodexId(), op: 'delete', path },
    { wantError: true, silent: true },
  );
  if (res && res.ok === false) {
    if (res.code !== 'category-not-empty') { toast(res.error || '删除失败'); return; }
    // 非空分类：服务器拒绝并报了条数，二次确认后才连词条一并删
    if (!window.confirm(`${res.error}\n\n确定连同其中所有词条一起删除吗？\n（图片文件保留在磁盘，数据可从 output/edit-backups/ 找回）`)) return;
    res = await editFetch('/__edit__/category', {
      codexId: currentCodexId(), op: 'delete', path, withEntries: true,
    });
  }
  if (!res || res.ok === false) return;
  await structuralRefresh();
  const n = res.entry?.deletedEntries ?? 0;
  toast(n ? `分类已删除（连带 ${n} 条词条）` : '分类已删除');
}

/* ---------- 法典管理（新建 / 改元信息 / 删除） ---------- */

function openCodexManager() {
  const meta = state.codexes?.find(c => c.id === currentCodexId());
  const editable = caps?.editable?.includes(currentCodexId());
  const mask = document.createElement('div');
  mask.className = 'edit-dialog-mask';
  mask.innerHTML = `
    <div class="edit-dialog" role="dialog" aria-modal="true" aria-label="法典管理">
      <h3>法典管理</h3>
      <div class="edit-dialog-path">当前：${esc(meta?.title || '尚未创建法典')}</div>
      ${editable ? `
      <label>书名<input type="text" id="cxTitle" value="${esc(meta?.title || '')}"></label>
      <label>选择器短标题（留空则使用书名）<input type="text" id="cxSelectorTitle" value="${esc(meta?.selectorTitle || '')}"></label>
      <label>作者<input type="text" id="cxAuthor" value="${esc(meta?.author || '')}"></label>
      <label>版本<input type="text" id="cxVersion" value="${esc(meta?.version || '')}"></label>
      <div class="edit-panel-row">
        <label>类型
          <select id="cxType">
            <option value="codex">法典</option>
            <option value="string">画风串</option>
            <option value="pack">精选图包</option>
          </select>
        </label>
        <label class="edit-check"><input type="checkbox" id="cxNsfw" ${meta?.nsfw ? 'checked' : ''}> 整本 NSFW</label>
      </div>
      <div class="edit-actions">
        <button type="button" class="edit-btn primary" id="cxSave">保存本书信息</button>
        <button type="button" class="edit-btn danger" id="cxDelete">删除这本法典</button>
      </div>` : `<div class="edit-hint">${meta ? '这本是外部数据源，不能在本地编辑。' : '当前还没有法典，请在下面创建第一本。'}</div>`}
      <hr class="edit-sep">
      <div class="edit-panel-title">新建一本法典</div>
      <label>id（小写字母/数字/下划线，建后不可改）<input type="text" id="cxNewId" placeholder="my_codex"></label>
      <label>书名<input type="text" id="cxNewTitle" placeholder="我的法典"></label>
      <label>选择器短标题（可选）<input type="text" id="cxNewSelectorTitle"></label>
      <div class="edit-panel-row">
        <label>作者（可选）<input type="text" id="cxNewAuthor"></label>
        <label>版本（可选）<input type="text" id="cxNewVersion"></label>
      </div>
      <div class="edit-panel-row">
        <label>类型
          <select id="cxNewType">
            <option value="codex">法典</option>
            <option value="string">画风串</option>
            <option value="pack">精选图包</option>
          </select>
        </label>
        <label class="edit-check"><input type="checkbox" id="cxNewNsfw"> 整本 NSFW</label>
      </div>
      <div class="edit-actions">
        <button type="button" class="edit-btn primary" id="cxCreate">创建并切换过去</button>
        <button type="button" class="edit-btn" id="cxClose">关闭</button>
      </div>
    </div>`;
  const close = mountEditDialog(mask, { trigger: document.getElementById('codexBtn') });
  mask.querySelector('#cxClose').onclick = () => close();
  if (editable) mask.querySelector('#cxType').value = meta?.type || 'codex';

  const saveBtn = mask.querySelector('#cxSave');
  if (saveBtn) {
    saveBtn.onclick = async () => {
      const fields = {};
      const title = mask.querySelector('#cxTitle').value.trim();
      const selectorTitle = mask.querySelector('#cxSelectorTitle').value.trim();
      const author = mask.querySelector('#cxAuthor').value.trim();
      const version = mask.querySelector('#cxVersion').value.trim();
      const type = mask.querySelector('#cxType').value;
      const nsfw = mask.querySelector('#cxNsfw').checked;
      if (!title) { toast('书名不能为空'); return; }
      if (title !== (meta?.title || '')) fields.title = title;
      if (selectorTitle !== (meta?.selectorTitle || '')) fields.selectorTitle = selectorTitle;
      if (author !== (meta?.author || '')) fields.author = author;
      if (version !== (meta?.version || '')) fields.version = version;
      if (type !== (meta?.type || 'codex')) fields.type = type;
      if (nsfw !== Boolean(meta?.nsfw)) fields.nsfw = nsfw;
      if (!Object.keys(fields).length) { toast('没有改动'); return; }
      const res = await editFetch('/__edit__/codex', { codexId: currentCodexId(), op: 'meta', fields });
      if (!res) return;
      await reloadCodexIndex();
      await structuralRefresh({ consumeLayer: true });
      close();
      toast('法典信息已保存');
    };
  }

  const delBtn = mask.querySelector('#cxDelete');
  if (delBtn) {
    delBtn.onclick = async () => {
      const codexId = currentCodexId();
      const name = meta?.title || codexId;
      if (!window.confirm(`确定删除法典「${name}」？\n数据文件会归档到 output/edit-backups/，图片文件保留在磁盘。`)) return;
      if (!window.confirm('再确认一次：这会把它从法典列表中移除。')) return;
      const res = await editFetch('/__edit__/codex', { codexId, op: 'delete' });
      if (!res) return;
      state.codexCache?.delete?.(codexId);
      invalidateSiteSearchCodex();
      await reloadCodexIndex();
      const next = state.codexes?.[0]?.id;
      if (next) {
        await acts.loadCodex?.(next, {
          historyMode: 'replace', transition: 'none', consumeLayer: true, saveBrowse: false,
        });
        close();
      } else {
        close();
        window.setTimeout(() => location.reload(), 80);
      }
      toast('法典已删除（副本在 ' + res.backupDir + '）');
    };
  }

  mask.querySelector('#cxCreate').onclick = async () => {
    const codex = {
      id: mask.querySelector('#cxNewId').value.trim(),
      title: mask.querySelector('#cxNewTitle').value.trim(),
      selectorTitle: mask.querySelector('#cxNewSelectorTitle').value.trim(),
      author: mask.querySelector('#cxNewAuthor').value.trim(),
      version: mask.querySelector('#cxNewVersion').value.trim(),
      type: mask.querySelector('#cxNewType').value,
    };
    if (mask.querySelector('#cxNewNsfw').checked) codex.nsfw = true;
    if (!codex.id || !codex.title) { toast('id 与书名都要填'); return; }
    const res = await editFetch('/__edit__/codex', { op: 'create', codex });
    if (!res) return;
    await reloadCodexIndex();
    await acts.loadCodex?.(codex.id, {
      historyMode: 'replace', transition: 'none', consumeLayer: true, saveBrowse: false,
    });
    close();
    toast('已创建并切换到：' + codex.title);
  };
}

/* 重新拉取 codexes.json 让选择器/元信息跟上（增删本或改书名后）。
   自绘选择器每次 open 都按 state.codexes 重建，但顶栏原生 <select> 是 init 时一次性填的，要手动重刷。 */
async function reloadCodexIndex() {
  try {
    const list = await fetchDataJson('codexes.json', { cache: 'no-store' });
    state.codexes = list;
    invalidateSiteSearchCodex();
    const sel = document.getElementById('codexSelect');
    if (sel) {
      const keep = sel.value;
      sel.innerHTML = list
        .map(c => `<option value="${esc(c.id)}">${esc(c.selectorTitle || c.title || c.id)}</option>`)
        .join('');
      if (list.some(c => c.id === keep)) sel.value = keep;
    }
    caps = await fetch('/__edit__/ping', { cache: 'no-store' }).then(r => r.json()).catch(() => caps);
  } catch { /* 忽略 */ }
}

/* ---------- 通用小弹层：单输入 / 单选择 ---------- */

function openPromptDialog({ title, hint, label, value = '', onSubmit }) {
  const mask = document.createElement('div');
  mask.className = 'edit-dialog-mask';
  mask.innerHTML = `
    <div class="edit-dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h3>${esc(title)}</h3>
      ${hint ? `<div class="edit-dialog-path">${esc(hint)}</div>` : ''}
      <label>${esc(label)}<input type="text" id="pdInput" value="${esc(value)}"></label>
      <div class="edit-actions">
        <button type="button" class="edit-btn primary" id="pdOk">确定</button>
        <button type="button" class="edit-btn" id="pdCancel">取消</button>
      </div>
    </div>`;
  const close = mountEditDialog(mask);
  const input = mask.querySelector('#pdInput');
  requestAnimationFrame(() => requestAnimationFrame(() => input.select()));
  const submit = async () => {
    const v = input.value.trim();
    if (!v) { toast('不能为空'); return; }
    const btn = mask.querySelector('#pdOk');
    btn.disabled = true;
    const ok = await onSubmit(v);
    btn.disabled = false;
    if (ok) close();
  };
  mask.querySelector('#pdOk').onclick = submit;
  mask.querySelector('#pdCancel').onclick = () => close();
  input.onkeydown = ev => { if (ev.key === 'Enter') submit(); };
}

function openSelectDialog({ title, hint, label, options, onSubmit }) {
  const mask = document.createElement('div');
  mask.className = 'edit-dialog-mask';
  mask.innerHTML = `
    <div class="edit-dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h3>${esc(title)}</h3>
      ${hint ? `<div class="edit-dialog-path">${esc(hint)}</div>` : ''}
      <label>${esc(label)}
        <select id="sdSelect">${options.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>
      </label>
      <div class="edit-actions">
        <button type="button" class="edit-btn primary" id="sdOk">确定</button>
        <button type="button" class="edit-btn" id="sdCancel">取消</button>
      </div>
    </div>`;
  const close = mountEditDialog(mask);
  const submit = async () => {
    const btn = mask.querySelector('#sdOk');
    btn.disabled = true;
    const ok = await onSubmit(mask.querySelector('#sdSelect').value);
    btn.disabled = false;
    if (ok) close();
  };
  mask.querySelector('#sdOk').onclick = submit;
  mask.querySelector('#sdCancel').onclick = () => close();
}

/* 新增词条弹窗。path 给定时锁定分类（从目录树菜单进）；
   不给时列出分类下拉、默认选中当前正在浏览的分类（从结果栏按钮进）。 */
function openCreateDialog(path = null) {
  const pathList = buildPathList(state.codex?.tree || []);
  if (!path && !pathList.length) {
    toast('先新建一个分类，才能往里加词条');
    return;
  }
  const fixed = Array.isArray(path) && path.length ? path : null;
  const preferred = joinTreePath(state.activePath || []);
  const mask = document.createElement('div');
  mask.className = 'edit-dialog-mask';
  mask.innerHTML = `
    <div class="edit-dialog" role="dialog" aria-modal="true" aria-label="新增词条">
      <h3>新增词条</h3>
      ${fixed
        ? `<div class="edit-dialog-path">分类：${esc(fixed.join(' / '))}</div>`
        : `<label>分类 *<select id="ndPath">${pathList
            .map(p => `<option value="${esc(p.value)}">${esc(p.label)}</option>`).join('')}</select></label>`}
      <label>标题 *<input type="text" id="ndTitle"></label>
      <label>正向 Tag *<textarea id="ndTags"></textarea></label>
      <label>负面 Tag（可选）<textarea id="ndNegative"></textarea></label>
      <label>备注（可选）<textarea id="ndNote"></textarea></label>
      <div class="edit-panel-row">
        <label>分级
          <select id="ndRating">${RATING_OPTIONS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>
        </label>
        <label class="edit-check"><input type="checkbox" id="ndNew"> 标记为「本次更新」</label>
      </div>
      <label>图片（可选；原图会原样保存）<input type="file" id="ndImage" accept="image/*"></label>
      <div class="edit-actions">
        <button type="button" class="edit-btn primary" id="ndSave">创建</button>
        <button type="button" class="edit-btn" id="ndCancel">取消</button>
      </div>
    </div>`;
  const close = mountEditDialog(mask);
  const pathSel = mask.querySelector('#ndPath');
  if (pathSel && pathList.some(p => p.value === preferred)) pathSel.value = preferred;
  mask.querySelector('#ndCancel').onclick = () => close();
  mask.querySelector('#ndSave').onclick = async () => {
    const targetPath = fixed || splitTreePath(pathSel?.value || '');
    const values = {
      title: mask.querySelector('#ndTitle').value,
      tags: mask.querySelector('#ndTags').value,
      pathValue: joinTreePath(targetPath),
    };
    const invalid = validateEntryForm(values, { requireAll: true });
    if (invalid) { toast(invalid); return; }
    const imageFile = mask.querySelector('#ndImage').files?.[0] || null;
    if (imageFile?.type && !/^image\//.test(imageFile.type)) { toast('请选择图片文件'); return; }
    let imageDataURL = null;
    if (imageFile) {
      try { imageDataURL = await readFileAsDataURL(imageFile); }
      catch { toast('读取图片失败'); return; }
    }
    const negative = mask.querySelector('#ndNegative').value.trim();
    const note = mask.querySelector('#ndNote').value.trim();
    const entry = { title: values.title.trim(), tags: values.tags.trim(), path: targetPath };
    if (negative) entry.negative = negative;
    if (note) entry.note = note;
    const rating = mask.querySelector('#ndRating').value;
    if (rating) entry.rating = rating;
    if (mask.querySelector('#ndNew').checked) entry.isNew = true;
    const btn = mask.querySelector('#ndSave');
    btn.disabled = true;
    const res = await editFetch('/__edit__/entry', { codexId: currentCodexId(), op: 'create', entry });
    if (!res) { btn.disabled = false; return; }
    let imageRes = null;
    if (imageDataURL) {
      imageRes = await editFetch('/__edit__/image', {
        codexId: currentCodexId(), entryId: res.entry.id, op: 'set', dataURL: imageDataURL,
      });
    }
    await structuralRefresh({ reopenEntryId: res.entry.id, consumeLayer: true });
    close();
    toast(imageDataURL && !imageRes
      ? `已新增词条 ${res.entry?.id || ''}，但图片未保存`
      : '已新增词条：' + (res.entry?.id || ''));
  };
}

/* 结果栏常驻「＋ 新增词条」——新增是高频操作，不该只藏在目录树菜单里 */
function ensureResultBarButton() {
  const bar = document.querySelector('.result-bar');
  if (!bar || document.getElementById('editNewEntryBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'editNewEntryBtn';
  btn.type = 'button';
  btn.className = 'edit-newentry-btn';
  btn.textContent = '＋ 新增词条';
  btn.onclick = () => {
    if (!canEditContext()) { toast('当前法典不可编辑'); return; }
    openCreateDialog();
  };
  bar.appendChild(btn);
}
