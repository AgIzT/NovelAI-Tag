/* 收藏夹界面。来源和权限仍由活词条决定，snap 不参与展示或计数。 */
import { state } from './state.js';
import { isEntryAccessBlocked } from './access.js';
import { isContentBlocked, subscribeContentBlocking } from './content-blocking.js';
import { thumbUrl } from './media.js';
import { toast } from './feedback.js';
import { bindBackdropDismiss, bindOutsideDismiss, focusFirstIn, trapFocus } from './modal.js';
import { registerHistoryLayer, openHistoryLayer, closeHistoryLayer, forgetHistoryLayer, topHistoryLayerId } from './browser-history.js';
import { librarySnapshot, commitLibrary, subscribeLibrary } from './favorites-library-store.js';
import { createFolder, renameFolder, deleteFolder, removeLibraryItems, setFolderMembership, FavoritesLibraryError } from './favorites-library-core.js';

const actions = {
  applyFilter: () => {},
  refreshFavoritesView: () => {},
  updateRoute: () => {},
  getEntries: () => state.codex?.entries || [],
  prepareEntries: async () => {},
  entryKey: entry => (entry?._srcCodexId || state.codex?.id || '') + ':' + (entry?.id || ''),
};
const IDS = { drawer: 'favoritesDrawer', organize: 'favoritesOrganize', dialog: 'favoritesDialog', selection: 'favoritesSelection' };
const DRAG_TYPE = 'application/x-novelai-favorite-keys';
const byId = id => document.getElementById(id);
const clone = value => JSON.parse(JSON.stringify(value));
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const entryKey = entry => actions.entryKey(entry);
const selectedKeys = () => [...(state.favSelected || [])].filter(key => visibleIndex().has(key));
let bound = false;
let wasActive = false;
let narrow = false;
let railHome = null;
let memo = null;
subscribeContentBlocking(() => { memo = null; });
let organizeKeys = [];
let organizeFolder = '';
let newFolderOpen = false;
let menuTrigger = null;
let menuFolder = '';
let dialogFolder = '';
let mutationBusy = false;
let folderNavigationSeq = 0;
const openers = new Map();
const selectionInert = new WeakMap();

export function setFavoritesViewActions(next = {}) { Object.assign(actions, next); }

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function button(text, className = '', handler) {
  const node = element('button', className, text);
  node.type = 'button';
  if (handler) node.addEventListener('click', handler);
  return node;
}
function input(placeholder) {
  const node = element('input', 'favorites-input');
  node.type = 'text';
  node.placeholder = placeholder;
  node.setAttribute('aria-label', placeholder);
  node.autocomplete = 'off';
  return node;
}
function errorLine() {
  const node = element('p', 'favorites-error');
  node.setAttribute('role', 'alert');
  node.hidden = true;
  return node;
}
function reportInline(node, result) {
  node.textContent = result.error?.message || '';
  node.hidden = !node.textContent;
}
function library() { return librarySnapshot(); }
function folders() { return [...library().folders].sort((a, b) => a.order - b.order || compareText(a.id, b.id)); }

/* 一个索引服务全部计数；每次来源、权限、屏蔽或库变更后才重新计算。 */
function viewIndex() {
  const doc = library();
  const entries = actions.getEntries() || [];
  if (memo?.doc === doc && memo.entries === entries && memo.codexes === state.codexes
      && memo.nsfw === state.allowNsfw && memo.r18g === state.allowR18g) return memo;
  const itemKeys = new Set(doc.items.map(item => item.key));
  const visible = new Map();
  for (const entry of entries) {
    const key = entryKey(entry);
    if (itemKeys.has(key) && !isEntryAccessBlocked(entry) && !isContentBlocked(entry)) visible.set(key, entry);
  }
  const members = new Map(doc.folders.map(folder => [folder.id, new Set()]));
  const assigned = new Set();
  const itemFolders = new Map();
  for (const relation of doc.memberships) {
    if (!members.has(relation.folderId) || !itemKeys.has(relation.itemKey)) continue;
    members.get(relation.folderId).add(relation.itemKey);
    assigned.add(relation.itemKey);
    if (!itemFolders.has(relation.itemKey)) itemFolders.set(relation.itemKey, []);
    itemFolders.get(relation.itemKey).push(relation.folderId);
  }
  memo = { doc, entries, codexes: state.codexes, nsfw: state.allowNsfw, r18g: state.allowR18g, visible, members, assigned, itemFolders };
  return memo;
}
function visibleIndex() { return viewIndex().visible; }
export function countVisible(keys) {
  const visible = visibleIndex();
  return [...new Set(keys || [])].reduce((total, key) => total + Number(visible.has(key)), 0);
}
function folderKeys(id = state.favFolder || '') {
  const index = viewIndex();
  if (!id) return [...index.visible.keys()];
  if (id === '_unsorted') return [...index.visible.keys()].filter(key => !index.assigned.has(key));
  return [...(index.members.get(id) || [])];
}
function folderTitle() {
  if (!state.favFolder) return '全部';
  if (state.favFolder === '_unsorted') return '未分类';
  return library().folders.find(folder => folder.id === state.favFolder)?.name || '全部';
}
export function filterFavoritesEntries(list) {
  if (!state.favoritesView) return list;
  const keys = new Set(folderKeys());
  const dates = new Map(library().items.map(item => [item.key, item.addedAt]));
  const visible = visibleIndex();
  const filtered = list.filter(entry => visible.has(entryKey(entry)) && keys.has(entryKey(entry))
    && (!state.favSource || entry._srcCodexId === state.favSource));
  return filtered.sort((a, b) => {
    if (state.favSort === 'title') return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN') || compareText(entryKey(a), entryKey(b));
    const left = dates.get(entryKey(a));
    const right = dates.get(entryKey(b));
    if (!left || !right) return left ? -1 : right ? 1 : compareText(entryKey(a), entryKey(b));
    return (state.favSort === 'oldest' ? compareText(left, right) : compareText(right, left)) || compareText(entryKey(a), entryKey(b));
  });
}
export function folderBadges(entry) {
  const ids = new Set(viewIndex().itemFolders.get(entryKey(entry)) || []);
  return folders().filter(folder => ids.has(folder.id)).map(folder => ({ id: folder.id, name: folder.name }));
}
function cover(id) {
  const keys = new Set(folderKeys(id));
  const entry = [...visibleIndex()].find(([key]) => keys.has(key))?.[1];
  if (!entry?.image && !entry?.images?.length) return element('span', 'favorites-folder-cover is-empty', '▢');
  const img = element('img', 'favorites-folder-cover');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = thumbUrl(entry);
  return img;
}
function routeChanged({ historyMode = 'replace', consumeLayer = false } = {}) {
  actions.updateRoute({ historyMode, consumeLayer });
}
function refreshList() {
  if (state.favoritesView) actions.applyFilter({ transition: 'filter' });
}
async function refreshItems() {
  await actions.refreshFavoritesView({ transition: 'filter' });
}
/* 选夹是 route 导航。先折叠由本界面拥有的 transient 记录，避免
   selection → drawer → 选夹之后 Back 落到已经隐藏的选择模式记录。 */
async function collapseNavigationLayers() {
  for (let depth = 0; depth < 3; depth++) {
    const id = topHistoryLayerId();
    if (id !== IDS.drawer && id !== IDS.selection) break;
    if (id === IDS.drawer) closeLayerDirect(id);
    else clearSelectionDirect();
    await new Promise(resolve => {
      const onPop = () => queueMicrotask(resolve);
      window.addEventListener('popstate', onPop, { once: true });
      if (!closeHistoryLayer(id)) {
        window.removeEventListener('popstate', onPop);
        forgetHistoryLayer(id);
        resolve();
      }
    });
  }
}
async function changeFolder(id) {
  const sequence = ++folderNavigationSeq;
  closeMenu();
  await collapseNavigationLayers();
  if (sequence !== folderNavigationSeq || !state.favoritesView) return;
  if (id && id !== '_unsorted' && !library().folders.some(folder => folder.id === id)) id = '';
  clearSelectionDirect();
  state.favFolder = id;
  state.activePath = [];
  routeChanged({ historyMode: 'folder' });
  refreshList();
}

function createInlineForm() {
  const form = element('form', 'favorites-new-form');
  const field = input('收藏夹名称');
  const row = element('div', 'favorites-form-row');
  const submit = button('新建', 'favorites-action is-primary');
  submit.type = 'submit';
  const cancel = button('取消', 'favorites-action', () => { newFolderOpen = false; renderFavoritesRail(); });
  const error = errorLine();
  row.append(field, submit, cancel);
  form.append(row, error);
  field.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      newFolderOpen = false;
      renderFavoritesRail();
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (mutationBusy) return;
    mutationBusy = true;
    submit.disabled = true;
    const result = await commitLibrary(doc => createFolder(doc, field.value), { changed: 'folders' });
    mutationBusy = false;
    submit.disabled = false;
    if (!result.ok) { reportInline(error, result); return; }
    newFolderOpen = false;
    renderFavoritesRail();
    toast('已新建「' + result.result.name + '」');
  });
  return form;
}
function folderRow(id, title, system = false) {
  const row = element('div', 'favorites-folder-row');
  row.classList.toggle('is-active', (state.favFolder || '') === id);
  row.dataset.folderId = id;
  const open = button('', 'favorites-folder-open', () => changeFolder(id));
  open.title = title;
  open.setAttribute('aria-current', (state.favFolder || '') === id ? 'page' : 'false');
  open.append(system ? element('span', 'favorites-folder-cover is-empty', id ? '◇' : '▦') : cover(id));
  open.append(element('span', 'favorites-folder-name', title), element('span', 'favorites-count', String(countVisible(folderKeys(id)))));
  row.append(open);
  if (!system) {
    const more = button('⋯', 'favorites-folder-more', () => openMenu(id, more));
    more.setAttribute('aria-label', '管理「' + title + '」');
    more.setAttribute('aria-haspopup', 'menu');
    row.append(more);
    row.addEventListener('dragover', event => {
      if (!event.dataTransfer?.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      row.classList.add('is-drop-target');
    });
    row.addEventListener('dragleave', event => {
      if (!row.contains(event.relatedTarget)) row.classList.remove('is-drop-target');
    });
    row.addEventListener('drop', async event => {
      row.classList.remove('is-drop-target');
      if (!event.dataTransfer?.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      let keys;
      try { keys = JSON.parse(event.dataTransfer.getData(DRAG_TYPE)); } catch { return; }
      if (!Array.isArray(keys)) return;
      keys = [...new Set(keys)].filter(key => visibleIndex().has(key));
      if (!keys.length) return;
      await joinFolder(keys, id, true);
    });
  }
  return row;
}
export function renderFavoritesRail() {
  if (!bound) setupFavoritesView();
  syncFavoritesView();
  if (!state.favoritesView) return;
  const rail = byId('favoritesRail');
  if (!rail) return;
  const scroll = rail.scrollTop;
  const active = byId('favoritesMenu')?.contains(document.activeElement) && rail.contains(menuTrigger) ? menuTrigger : document.activeElement;
  const activeRow = rail.contains(active) ? active.closest('[data-folder-id]')?.dataset.folderId : undefined;
  const activeMore = active?.classList.contains('favorites-folder-more');
  const activeCreate = active?.classList.contains('favorites-new-button');
  if (!byId('favoritesMenu').hidden && rail.contains(menuTrigger)) closeMenu();
  const oldInput = rail.querySelector('.favorites-new-form input');
  const draft = oldInput?.value;
  const focused = document.activeElement === oldInput;
  rail.replaceChildren(element('div', 'favorites-section-title', '收藏空间'), folderRow('', '全部', true), folderRow('_unsorted', '未分类', true));
  const heading = element('div', 'favorites-section-head');
  heading.append(element('span', 'favorites-section-title', '我的收藏夹'));
  const create = button('＋ 新建', 'favorites-new-button', () => {
    newFolderOpen = !newFolderOpen;
    renderFavoritesRail();
    rail.querySelector('input')?.focus({ preventScroll: true });
  });
  heading.append(create);
  rail.append(heading);
  if (newFolderOpen) {
    const form = createInlineForm();
    if (draft !== undefined) form.querySelector('input').value = draft;
    rail.append(form);
    if (focused) form.querySelector('input').focus({ preventScroll: true });
  }
  for (const folder of folders()) rail.append(folderRow(folder.id, folder.name));
  rail.scrollTop = scroll;
  if (activeRow !== undefined) {
    const row = [...rail.querySelectorAll('[data-folder-id]')].find(node => node.dataset.folderId === activeRow);
    row?.querySelector(activeMore ? '.favorites-folder-more' : '.favorites-folder-open')?.focus({ preventScroll: true });
  } else if (activeCreate) rail.querySelector('.favorites-new-button')?.focus({ preventScroll: true });
}
function sortSelect() {
  const select = element('select', 'favorites-sort');
  select.setAttribute('aria-label', '收藏排序');
  for (const [value, label] of [['recent', '最近收藏'], ['oldest', '最早收藏'], ['title', '按标题']]) {
    const option = element('option', '', label);
    option.value = value;
    select.append(option);
  }
  select.value = state.favSort || 'recent';
  select.addEventListener('change', () => { state.favSort = select.value; routeChanged(); refreshList(); });
  return select;
}
export function renderFavoritesHeader() {
  if (!bound) return;
  if (!state.favoritesView) return;
  const header = byId('favoritesHeader');
  const sourceRail = byId('favoritesSources');
  const active = byId('favoritesMenu')?.contains(document.activeElement) && header.contains(menuTrigger) ? menuTrigger : document.activeElement;
  if (!byId('favoritesMenu').hidden && header.contains(menuTrigger)) closeMenu();
  const focusedHeader = header.contains(active);
  const focusedSort = focusedHeader && active.matches('select');
  const focusedMore = focusedHeader && active.classList.contains('favorites-head-more');
  const focusedSelection = focusedHeader && active.closest('.favorites-desktop-controls') && !focusedSort;
  const focusedSource = sourceRail.contains(active) ? active.dataset.sourceId : undefined;
  const sourceScroll = sourceRail.scrollLeft;
  const all = countVisible(folderKeys());
  const shown = countVisible((state.list || []).map(entryKey));
  const hasFilter = Boolean(state.query || state.favSource || state.searchFilterValues?.length);
  const head = element('div', 'favorites-content-head');
  const title = element('div', 'favorites-heading');
  title.append(element('h1', '', folderTitle()), element('span', 'favorites-count', (hasFilter ? shown + ' / ' + all : all) + ' 项'));
  const controls = element('div', 'favorites-head-controls');
  const desktop = element('div', 'favorites-desktop-controls');
  desktop.append(sortSelect(), button(state.favSelecting ? '完成' : '选择', 'favorites-action', () => state.favSelecting ? endSelection() : beginSelection()));
  controls.append(desktop);
  const more = button('⋯', 'favorites-head-more favorites-action', () => openMenu(state.favFolder, more, true));
  more.setAttribute('aria-label', '收藏操作');
  more.setAttribute('aria-haspopup', 'menu');
  more.classList.toggle('is-system', !state.favFolder || state.favFolder === '_unsorted');
  controls.append(more);
  head.append(title, controls);
  header.replaceChildren(head);
  if (state.favFolder === '_unsorted' && all > 0) {
    const guide = element('div', 'favorites-unsorted-guide');
    guide.append(element('span', '', all + ' 项还没放进收藏夹'), button('批量整理', 'favorites-action', () => beginSelection()));
    header.append(guide);
  }
  sourceRail.replaceChildren();
  const currentKeys = new Set(folderKeys());
  const sources = new Map();
  for (const [key, entry] of visibleIndex()) {
    if (!currentKeys.has(key)) continue;
    const id = entry._srcCodexId || '';
    if (!sources.has(id)) sources.set(id, { name: entry._srcCodexTitle || id, keys: [] });
    sources.get(id).keys.push(key);
  }
  const sourceChip = (id, label, keys) => {
    const chip = button('', 'favorites-source-chip', () => {
      state.favSource = state.favSource === id ? '' : id;
      routeChanged();
      refreshList();
    });
    chip.dataset.sourceId = id;
    chip.classList.toggle('is-active', (state.favSource || '') === id);
    chip.setAttribute('aria-pressed', String((state.favSource || '') === id));
    chip.append(element('span', '', label), element('span', 'favorites-count', String(countVisible(keys))));
    return chip;
  };
  sourceRail.append(sourceChip('', '全部来源', [...currentKeys]));
  for (const [id, source] of sources) {
    const chip = sourceChip(id, source.name, source.keys);
    const dot = element('i', 'favorites-source-dot');
    let hash = 0;
    for (const character of source.name) hash = (hash * 31 + character.codePointAt(0)) % 360;
    dot.style.setProperty('--source-hue', String(hash));
    chip.prepend(dot);
    sourceRail.append(chip);
  }
  const empty = byId('empty');
  if (empty && !state.list?.length) {
    empty.textContent = !library().items.length
      ? '还没有收藏。点卡片上的 ☆ 收藏词条。'
      : hasFilter ? '没有匹配的收藏。换个关键词，或清除来源筛选。'
        : '还没有内容。选中卡片后点「整理」加进来。';
  }
  sourceRail.scrollLeft = sourceScroll;
  if (focusedSort) header.querySelector('select')?.focus({ preventScroll: true });
  else if (focusedMore) header.querySelector('.favorites-head-more')?.focus({ preventScroll: true });
  else if (focusedSelection) header.querySelector('.favorites-desktop-controls button')?.focus({ preventScroll: true });
  else if (focusedSource !== undefined) {
    ([...sourceRail.children].find(node => node.dataset.sourceId === focusedSource) || sourceRail.firstElementChild)?.focus({ preventScroll: true });
  }
  renderBatchBar();
  if (!byId(IDS.organize)?.hidden) renderOrganizeList();
}

function showLayerDirect(id, trigger = document.activeElement) {
  const mask = byId(id);
  if (!mask) return;
  if (trigger?.isConnected) openers.set(id, trigger);
  mask.hidden = false;
  mask.inert = false;
  focusFirstIn(mask);
  syncModalState();
}
function closeLayerDirect(id) {
  const mask = byId(id);
  if (!mask) return;
  mask.hidden = true;
  mask.inert = true;
  if (id === IDS.drawer) byId('favoritesFoldersBtn')?.setAttribute('aria-expanded', 'false');
  restoreLayerFocus(id);
  syncModalState();
}
function restoreLayerFocus(id) {
  const opener = openers.get(id);
  let target = opener?.isConnected ? opener : null;
  if (!target && opener?.id) target = byId(opener.id);
  if (!target && opener?.dataset.favBatch) {
    target = [...document.querySelectorAll('[data-fav-batch]')].find(node => node.dataset.favBatch === opener.dataset.favBatch);
  }
  const cardKey = opener?.closest('[data-favorite-key]')?.dataset.favoriteKey;
  if (!target && cardKey) {
    const card = [...document.querySelectorAll('[data-favorite-key]')].find(node => node.dataset.favoriteKey === cardKey);
    target = card?.querySelector('.favorite-organize-button');
  }
  const folderId = opener?.closest('[data-folder-id]')?.dataset.folderId;
  if (!target && folderId) {
    const row = [...document.querySelectorAll('[data-folder-id]')].find(node => node.dataset.folderId === folderId);
    target = row?.querySelector('.favorites-folder-more');
  }
  if (!target && opener?.classList.contains('favorites-head-more')) target = byId('favoritesHeader')?.querySelector('.favorites-head-more');
  const top = [IDS.dialog, IDS.organize, IDS.drawer].map(byId).find(mask => mask && !mask.hidden);
  if (top && (!target || !top.contains(target))) { focusFirstIn(top); return; }
  if (!target && state.favoritesView) target = byId('favoritesHeader')?.querySelector('button');
  target?.focus({ preventScroll: true });
}
function showLayer(id, trigger) {
  showLayerDirect(id, trigger);
  openHistoryLayer(id);
}
function closeLayer(id, { historyMode = 'back' } = {}) {
  if (historyMode !== 'none' && closeHistoryLayer(id)) return;
  closeLayerDirect(id);
  if (historyMode !== 'none') forgetHistoryLayer(id);
}
function syncModalState() {
  const any = [IDS.drawer, IDS.organize, IDS.dialog].some(id => byId(id) && !byId(id).hidden);
  document.body.classList.toggle('favorites-modal-open', any);
}
function makeMask(id, className, label) {
  const mask = element('div', 'favorites-mask ' + className);
  mask.id = id;
  mask.hidden = true;
  mask.inert = true;
  const dialog = element('section', 'favorites-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', label);
  mask.append(dialog);
  document.body.append(mask);
  registerHistoryLayer(id, { isOpen: () => !mask.hidden, open: () => showLayerDirect(id), close: () => closeLayerDirect(id) });
  bindBackdropDismiss(mask, () => { if (!mutationBusy) closeLayer(id); });
  mask.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!mutationBusy) closeLayer(id);
    }
    trapFocus(event, dialog);
  });
  return dialog;
}
function closeMenu() {
  const menu = byId('favoritesMenu');
  if (menu) menu.hidden = true;
  menuTrigger?.setAttribute('aria-expanded', 'false');
}
function openMenu(id, trigger, fromHeader = false) {
  const menu = byId('favoritesMenu');
  if (!menu) return;
  const same = !menu.hidden && menuTrigger === trigger;
  closeMenu();
  if (same) return;
  menuFolder = id || '';
  menuTrigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  menu.replaceChildren();
  if (fromHeader && narrow) {
    menu.append(sortSelect(), button(state.favSelecting ? '完成' : '选择', 'favorites-menu-item', () => {
      closeMenu();
      state.favSelecting ? endSelection() : beginSelection();
    }));
  }
  if (menuFolder && menuFolder !== '_unsorted') {
    menu.append(button('重命名收藏夹', 'favorites-menu-item', () => { closeMenu(); openFolderDialog(menuFolder, 'rename', trigger); }));
    menu.append(button('删除收藏夹', 'favorites-menu-item is-danger', () => { closeMenu(); openFolderDialog(menuFolder, 'delete', trigger); }));
  }
  menu.hidden = false;
  const rect = trigger.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(rect.right - 200, window.innerWidth - 208)) + 'px';
  menu.style.top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  focusFirstIn(menu);
}
/* 只补回本次删掉的对象。取消后被另一页重新收藏的项已是新操作，
   它的内容和归属均保留，不把旧快照盖回去。 */
export function restoreFavoriteObjects(doc, snapshot, kind) {
  if (snapshot.folder) {
    if (doc.folders.some(folder => folder.id === snapshot.folder.id || folder.name === snapshot.folder.name)) {
      throw new FavoritesLibraryError('UNDO_CONFLICT', '撤销没能完成');
    }
    createFolder(doc, snapshot.folder.name, { id: snapshot.folder.id });
    Object.assign(doc.folders.find(folder => folder.id === snapshot.folder.id), clone(snapshot.folder));
  }
  const recreated = new Set();
  for (const item of snapshot.items || []) {
    if (doc.items.some(current => current.key === item.key)) recreated.add(item.key);
    else doc.items.push(clone(item));
  }
  const items = new Set(doc.items.map(item => item.key));
  const folderIds = new Set(doc.folders.map(folder => folder.id));
  const relations = new Set(doc.memberships.map(item => JSON.stringify([item.itemKey, item.folderId])));
  for (const membership of snapshot.memberships || []) {
    if (!items.has(membership.itemKey) || recreated.has(membership.itemKey)) continue;
    if (!folderIds.has(membership.folderId)) {
      if (kind === 'folder') continue;
      throw new FavoritesLibraryError('UNDO_CONFLICT', '撤销没能完成');
    }
    const key = JSON.stringify([membership.itemKey, membership.folderId]);
    if (!relations.has(key)) {
      doc.memberships.push(clone(membership));
      relations.add(key);
    }
  }
}
function undoToast(message, snapshot, kind) {
  toast(message, '✓', { label: '撤销', failureMessage: '撤销没能完成', onClick: async () => {
    const result = await commitLibrary(doc => restoreFavoriteObjects(doc, snapshot, kind), { changed: 'all', silent: true });
    if (!result.ok) { toast('撤销没能完成', '!'); return false; }
    if (kind === 'items') await refreshItems();
    else refreshList();
    return true;
  } });
}

function openFolderDialog(id, mode, trigger) {
  const folder = library().folders.find(item => item.id === id);
  if (!folder) return;
  dialogFolder = id;
  const root = byId(IDS.dialog).firstElementChild;
  root.replaceChildren();
  const title = element('h2', '', mode === 'delete' ? '删除「' + folder.name + '」？' : '重命名收藏夹');
  root.append(title);
  const field = mode === 'rename' ? input('收藏夹名称') : null;
  if (field) { field.value = folder.name; root.append(field); }
  else root.append(element('p', 'favorites-delete-copy', '夹子里的 ' + countVisible(folderKeys(id)) + ' 项素材会保留在收藏里，只属于这个夹子的会回到「未分类」。'));
  const error = errorLine();
  const footer = element('div', 'favorites-dialog-footer');
  const cancel = button('取消', 'favorites-action', () => closeLayer(IDS.dialog));
  const save = button(mode === 'delete' ? '删除收藏夹' : '保存', 'favorites-action ' + (mode === 'delete' ? 'is-danger' : 'is-primary'), async () => {
    if (mutationBusy) return;
    mutationBusy = true;
    save.disabled = true;
    const result = await commitLibrary(doc => mode === 'delete' ? deleteFolder(doc, id) : renameFolder(doc, id, field.value), { changed: 'folders' });
    mutationBusy = false;
    save.disabled = false;
    if (!result.ok) { reportInline(error, result); return; }
    closeLayer(IDS.dialog);
    if (mode === 'delete') {
      if (state.favFolder === id) { state.favFolder = ''; routeChanged(); }
      refreshList();
      undoToast('已删除「' + folder.name + '」', result.result, 'folder');
    } else {
      routeChanged();
      refreshList();
    }
  });
  footer.append(cancel, save);
  root.append(error, footer);
  field?.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); save.click(); }
  });
  showLayer(IDS.dialog, trigger);
}
async function joinFolder(keys, folderId, on) {
  const name = library().folders.find(folder => folder.id === folderId)?.name;
  if (!name) return false;
  const result = await commitLibrary(doc => setFolderMembership(doc, keys, folderId, on), { changed: 'memberships' });
  if (!result.ok) { renderOrganizeList(); return false; }
  refreshList();
  renderOrganizeList();
  if (on) toast(keys.length === 1 ? '已加入「' + name + '」' : '已加入「' + name + '」' + keys.length + ' 项');
  return true;
}
export async function openOrganize(keys, trigger = document.activeElement) {
  setupFavoritesView();
  try { await actions.prepareEntries(); } catch (error) {
    console.warn('[favorites] 整理所需来源暂未读到', error);
    toast('收藏来源没能加载，重试一次', '!');
    return;
  }
  memo = null;
  /* 在主图鉴点收藏后的 toast 也能整理；回源可见性由入口活词条负责，库身份仍需存在。 */
  const existing = new Set(library().items.map(item => item.key));
  organizeKeys = [...new Set(keys || [])].filter(key => existing.has(key));
  if (!organizeKeys.length) return;
  organizeFolder = state.favoritesView ? state.favFolder || '' : '';
  byId('favoritesOrganizeSearch').value = '';
  byId('favoritesOrganizeName').value = '';
  byId('favoritesOrganizeError').hidden = true;
  renderOrganizeList();
  showLayer(IDS.organize, trigger);
}
function organizeEntries() {
  const all = [...(actions.getEntries() || []), ...(state.codex?.entries || []), ...(state.list || [])];
  return new Map(all.map(entry => [entryKey(entry), entry]));
}
function renderOrganizeList() {
  const list = byId('favoritesOrganizeList');
  if (!list) return;
  const existing = new Set(library().items.map(item => item.key));
  organizeKeys = organizeKeys.filter(key => existing.has(key));
  const entry = organizeEntries().get(organizeKeys[0]);
  byId('favoritesOrganizeSubtitle').textContent = organizeKeys.length === 1 ? entry?.title || '' : '已选 ' + organizeKeys.length + ' 项';
  const scroll = list.scrollTop;
  const focused = document.activeElement?.dataset.folderCheck;
  list.replaceChildren();
  const query = byId('favoritesOrganizeSearch').value.trim();
  const found = folders().filter(folder => folder.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  for (const folder of found) {
    const members = viewIndex().members.get(folder.id) || new Set();
    const selected = organizeKeys.filter(key => members.has(key)).length;
    const status = selected === organizeKeys.length && selected > 0 ? 'true' : selected > 0 ? 'mixed' : 'false';
    const row = button('', 'favorites-organize-row', async () => {
      if (mutationBusy || !organizeKeys.length) return;
      mutationBusy = true;
      row.disabled = true;
      await joinFolder(organizeKeys.slice(), folder.id, status !== 'true');
      mutationBusy = false;
      renderOrganizeList();
    });
    row.dataset.folderCheck = folder.id;
    row.setAttribute('role', 'checkbox');
    row.setAttribute('aria-checked', status);
    row.disabled = mutationBusy || !organizeKeys.length;
    row.append(element('span', 'favorites-check', status === 'true' ? '✓' : status === 'mixed' ? '−' : ''), cover(folder.id),
      element('span', 'favorites-folder-name', folder.name), element('span', 'favorites-count', String(countVisible(folderKeys(folder.id)))));
    list.append(row);
  }
  if (!found.length && query) {
    list.append(element('p', 'favorites-panel-empty', '没有叫「' + query + '」的收藏夹'));
    if (!byId('favoritesOrganizeName').value) byId('favoritesOrganizeName').value = query;
  }
  list.scrollTop = scroll;
  if (focused) [...list.children].find(row => row.dataset.folderCheck === focused)?.focus({ preventScroll: true });
}
function beginSelection() {
  state.favSelecting = true;
  state.favSelected = new Set();
  closeMenu();
  openHistoryLayer(IDS.selection);
  renderFavoritesHeader();
  updateCardSelections();
}
function clearSelectionDirect() {
  state.favSelecting = false;
  state.favSelected = new Set();
  updateCardSelections();
  renderBatchBar();
}
function endSelection({ historyMode = 'back' } = {}) {
  if (!state.favSelecting) return;
  if (historyMode === 'back' && closeHistoryLayer(IDS.selection)) return;
  state.favSelecting = false;
  state.favSelected = new Set();
  if (historyMode !== 'back') forgetHistoryLayer(IDS.selection);
  updateCardSelections();
  renderBatchBar();
  renderFavoritesHeader();
}
export function handleFavoriteCardSelection(event, entry) {
  if (!state.favoritesView || !state.favSelecting) return false;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  const key = entryKey(entry);
  if (!visibleIndex().has(key)) return true;
  if (!(state.favSelected instanceof Set)) state.favSelected = new Set();
  if (state.favSelected.has(key)) state.favSelected.delete(key);
  else state.favSelected.add(key);
  updateCardSelections();
  renderBatchBar();
  return true;
}
function updateCardSelections() {
  document.body.classList.toggle('favorites-selecting', Boolean(state.favoritesView && state.favSelecting));
  for (const card of document.querySelectorAll('[data-favorite-key]')) {
    const on = Boolean(state.favSelected?.has(card.dataset.favoriteKey));
    card.classList.toggle('is-favorite-selected', on && Boolean(state.favSelecting));
    syncSelectionControls(card);
    const checkbox = card.querySelector('.favorite-select-check');
    if (checkbox) {
      checkbox.hidden = !state.favSelecting;
      checkbox.setAttribute('aria-checked', String(on));
      checkbox.textContent = on ? '✓' : '';
    }
  }
}
function syncSelectionControls(card) {
  for (const control of card.querySelectorAll('button:not(.favorite-select-check), a')) {
    if (state.favSelecting) {
      if (!selectionInert.has(control)) selectionInert.set(control, control.inert);
      control.inert = true;
    } else if (selectionInert.has(control)) {
      control.inert = selectionInert.get(control);
      selectionInert.delete(control);
    }
  }
}
function renderBatchBar() {
  const bar = byId('favoritesBatchBar');
  if (!bar) return;
  bar.hidden = !state.favoritesView || !state.favSelecting;
  if (bar.hidden) return;
  const keys = selectedKeys();
  const focused = bar.contains(document.activeElement) ? document.activeElement.dataset.favBatch : null;
  bar.replaceChildren(element('strong', '', '已选 ' + countVisible(keys) + ' 项'));
  bar.append(button('全选', 'favorites-action', () => {
    state.favSelected = new Set((state.list || []).map(entryKey).filter(key => visibleIndex().has(key)));
    updateCardSelections();
    renderBatchBar();
  }));
  const join = button('加入收藏夹', 'favorites-action is-primary', () => openOrganize(selectedKeys(), join));
  join.disabled = !keys.length;
  bar.append(join);
  if (state.favFolder && state.favFolder !== '_unsorted') {
    const move = button('移出本夹', 'favorites-action', async () => {
      const folderId = state.favFolder;
      const name = folderTitle();
      const chosen = selectedKeys();
      const result = await commitLibrary(doc => {
        const snapshot = { memberships: doc.memberships.filter(item => item.folderId === folderId && chosen.includes(item.itemKey)).map(clone) };
        setFolderMembership(doc, chosen, folderId, false);
        return snapshot;
      }, { changed: 'memberships' });
      if (!result.ok) return;
      state.favSelected.clear();
      refreshList();
      undoToast('已从「' + name + '」移出 ' + chosen.length + ' 项', result.result, 'memberships');
    });
    move.disabled = !keys.length;
    bar.append(move);
  }
  const remove = button('取消收藏', 'favorites-action is-danger', async () => {
    const chosen = selectedKeys();
    const result = await commitLibrary(doc => removeLibraryItems(doc, chosen), { changed: 'items' });
    if (!result.ok) return;
    state.favSelected.clear();
    await refreshItems();
    undoToast('已取消收藏 ' + chosen.length + ' 项', result.result, 'items');
  });
  remove.disabled = !keys.length;
  bar.append(remove, button('完成', 'favorites-action', () => endSelection()));
  for (const control of bar.querySelectorAll('button')) control.dataset.favBatch = control.textContent;
  if (focused) [...bar.querySelectorAll('button')].find(node => node.dataset.favBatch === focused)?.focus({ preventScroll: true });
}
export function decorateFavoriteCard(card, entry) {
  if (!state.favoritesView || !card) return;
  card.dataset.favoriteKey = entryKey(entry);
  card.classList.add('favorite-library-card');
  const checkbox = button('', 'favorite-select-check');
  checkbox.setAttribute('role', 'checkbox');
  checkbox.setAttribute('aria-label', '选择「' + String(entry.title || '') + '」');
  checkbox.setAttribute('aria-checked', String(Boolean(state.favSelected?.has(entryKey(entry)))));
  checkbox.hidden = !state.favSelecting;
  checkbox.textContent = state.favSelected?.has(entryKey(entry)) ? '✓' : '';
  card.append(checkbox);
  card.classList.toggle('is-favorite-selected', Boolean(state.favSelecting && state.favSelected?.has(entryKey(entry))));
  const foot = card.querySelector('.card-foot');
  if (foot) {
    const organize = button('整理', 'favorite-organize-button', event => {
      event.stopPropagation();
      openOrganize([entryKey(entry)], organize);
    });
    organize.setAttribute('aria-label', '整理到收藏夹');
    (foot.querySelector('.card-actions') || foot).prepend(organize);
    const badges = folderBadges(entry);
    if (badges.length) {
      const row = element('div', 'favorite-folder-badges');
      for (const folder of badges.slice(0, 2)) {
        const chip = element('span', 'favorite-folder-badge', folder.name);
        chip.title = folder.name;
        row.append(chip);
      }
      if (badges.length > 2) row.append(element('span', 'favorite-folder-badge favorite-folder-overflow', '+' + (badges.length - 2)));
      foot.append(row);
    }
  }
  syncSelectionControls(card);
  card.addEventListener('click', event => handleFavoriteCardSelection(event, entry), true);
  card.addEventListener('keydown', event => {
    if (state.favSelecting && (event.key === 'Enter' || event.key === ' ') && !event.repeat) handleFavoriteCardSelection(event, entry);
  }, true);
  card.draggable = true;
  card.addEventListener('dragstart', event => {
    if (!event.dataTransfer || !state.favoritesView) return;
    const key = entryKey(entry);
    const keys = state.favSelecting && state.favSelected?.has(key) ? selectedKeys() : [key];
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(keys));
    event.dataTransfer.effectAllowed = 'copy';
  });
  card.addEventListener('dragend', () => document.querySelectorAll('.is-drop-target').forEach(node => node.classList.remove('is-drop-target')));
}
export function syncFavoritesView() {
  if (!bound) return;
  const active = Boolean(state.favoritesView);
  document.body.classList.toggle('favorites-library-view', active);
  for (const id of ['favoritesRail', 'favoritesHeader', 'favoritesSources', 'favoritesFoldersBtn']) {
    if (byId(id)) byId(id).hidden = !active;
  }
  if (!active && wasActive) {
    closeMenu();
    for (const id of [IDS.dialog, IDS.organize, IDS.drawer]) { closeLayerDirect(id); forgetHistoryLayer(id); }
    endSelection({ historyMode: 'none' });
    railHome?.append(byId('favoritesRail'));
    state.favFolder = '';
    state.favSource = '';
    newFolderOpen = false;
  }
  wasActive = active;
  if (active) {
    const id = state.favFolder;
    if (id && id !== '_unsorted' && !library().folders.some(folder => folder.id === id)) {
      state.favFolder = '';
      endSelection({ historyMode: 'none' });
      routeChanged();
    }
    const host = narrow ? byId('favoritesDrawerRail') : railHome;
    if (host && byId('favoritesRail').parentElement !== host) host.append(byId('favoritesRail'));
  }
  updateCardSelections();
}
export function setupFavoritesView() {
  if (bound || !globalThis.document?.body) return;
  bound = true;
  narrow = window.matchMedia('(max-width: 859px)').matches;
  if (!(state.favSelected instanceof Set)) state.favSelected = new Set();
  if (!state.favSort) state.favSort = 'recent';
  const sidebar = byId('sidebar');
  railHome = sidebar;
  if (!byId('favoritesRail') && sidebar) {
    const rail = element('nav', 'favorites-library-rail');
    rail.id = 'favoritesRail';
    rail.hidden = true;
    rail.setAttribute('aria-label', '收藏夹');
    sidebar.append(rail);
  }
  const main = byId('main');
  if (main) {
    const header = byId('favoritesHeader') || element('section', 'favorites-library-header');
    header.id = 'favoritesHeader'; header.hidden = true;
    const sources = byId('favoritesSources') || element('nav', 'favorites-sources');
    sources.id = 'favoritesSources'; sources.hidden = true; sources.setAttribute('aria-label', '收藏来源');
    byId('codexBanner')?.after(header, sources);
  }
  if (!byId('favoritesFoldersBtn')) {
    const trigger = button('收藏夹 ▾', 'bar-btn favorites-folders-button', () => {
      showLayer(IDS.drawer, trigger);
      trigger.setAttribute('aria-expanded', 'true');
    });
    trigger.id = 'favoritesFoldersBtn';
    trigger.hidden = true;
    trigger.setAttribute('aria-controls', IDS.drawer);
    trigger.setAttribute('aria-expanded', 'false');
    (document.querySelector('.topbar-actions') || document.querySelector('.topbar'))?.prepend(trigger);
  }
  const drawer = makeMask(IDS.drawer, 'favorites-drawer-mask', '收藏夹');
  const drawerHead = element('header', 'favorites-drawer-head');
  drawerHead.append(element('h2', '', '收藏夹'), button('完成', 'favorites-action', () => closeLayer(IDS.drawer)));
  const drawerRail = element('div', 'favorites-drawer-rail'); drawerRail.id = 'favoritesDrawerRail';
  drawer.append(drawerHead, drawerRail);
  const organize = makeMask(IDS.organize, 'favorites-organize-mask', '整理到收藏夹');
  organize.append(element('h2', '', '整理到收藏夹'));
  const subtitle = element('p', 'favorites-organize-subtitle'); subtitle.id = 'favoritesOrganizeSubtitle';
  const search = input('搜索收藏夹'); search.id = 'favoritesOrganizeSearch';
  const list = element('div', 'favorites-organize-list'); list.id = 'favoritesOrganizeList';
  const form = element('form', 'favorites-organize-new');
  const name = input('新建收藏夹'); name.id = 'favoritesOrganizeName';
  const create = button('新建并加入', 'favorites-action is-primary'); create.type = 'submit';
  const error = errorLine(); error.id = 'favoritesOrganizeError';
  const formRow = element('div', 'favorites-form-row'); formRow.append(name, create);
  form.append(formRow, error);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (mutationBusy || !organizeKeys.length) return;
    mutationBusy = true; create.disabled = true;
    const keys = organizeKeys.slice();
    const result = await commitLibrary(doc => {
      const folder = createFolder(doc, name.value);
      setFolderMembership(doc, keys, folder.id, true);
      return folder;
    }, { changed: 'all' });
    mutationBusy = false; create.disabled = false;
    if (!result.ok) { reportInline(error, result); return; }
    name.value = ''; search.value = ''; error.hidden = true;
    refreshList(); renderOrganizeList();
    toast('已新建「' + result.result.name + '」，加入 ' + keys.length + ' 项');
  });
  search.addEventListener('input', renderOrganizeList);
  const footer = element('div', 'favorites-dialog-footer');
  footer.append(button('完成', 'favorites-action', () => closeLayer(IDS.organize)));
  organize.append(subtitle, search, list, form, footer);
  makeMask(IDS.dialog, 'favorites-folder-dialog-mask', '收藏夹');
  const menu = element('div', 'favorites-menu'); menu.id = 'favoritesMenu'; menu.hidden = true; menu.setAttribute('role', 'menu');
  menu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); menuTrigger?.focus({ preventScroll: true }); } });
  document.body.append(menu);
  bindOutsideDismiss(() => menu.hidden ? [] : [menu, menuTrigger], closeMenu);
  const bar = element('div', 'favorites-batch-bar'); bar.id = 'favoritesBatchBar'; bar.hidden = true; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', '批量整理');
  document.body.append(bar);
  registerHistoryLayer(IDS.selection, {
    isOpen: () => Boolean(state.favSelecting),
    open: () => { state.favSelecting = true; state.favSelected = new Set(); updateCardSelections(); renderFavoritesHeader(); },
    close: () => { state.favSelecting = false; state.favSelected = new Set(); updateCardSelections(); renderFavoritesHeader(); },
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.favSelecting && (!topHistoryLayerId() || topHistoryLayerId() === IDS.selection)) {
      event.preventDefault(); endSelection();
    }
  });
  let previousWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (Math.abs(window.innerWidth - previousWidth) < 2) return;
    previousWidth = window.innerWidth;
    const next = window.matchMedia('(max-width: 859px)').matches;
    closeMenu();
    if (next !== narrow) {
      narrow = next;
      /* resize 不是打开抽屉；手机会话跨回桌面时仍消费原来的 history layer。 */
      if (!narrow && !byId(IDS.drawer).hidden) closeLayer(IDS.drawer);
      syncFavoritesView();
    }
    if (state.favoritesView) renderFavoritesHeader();
  });
  subscribeLibrary(() => {
    memo = null;
    if (organizeFolder && organizeFolder !== '_unsorted' && !library().folders.some(folder => folder.id === organizeFolder)
        && !byId(IDS.organize).hidden) {
      closeLayer(IDS.organize);
      toast('收藏夹已删除', '!');
    }
    if (dialogFolder && !library().folders.some(folder => folder.id === dialogFolder) && !byId(IDS.dialog).hidden && !mutationBusy) closeLayer(IDS.dialog);
    state.favSelected = new Set(selectedKeys());
    syncFavoritesView();
    if (state.favoritesView) { renderFavoritesRail(); renderFavoritesHeader(); }
    if (!byId(IDS.organize).hidden) {
      if (!organizeKeys.some(key => library().items.some(item => item.key === key))) {
        closeLayer(IDS.organize);
        toast('收藏已取消', '!');
      } else renderOrganizeList();
    }
  });
  syncFavoritesView();
}

export function refreshOpenOrganize() {
  if (bound && byId(IDS.organize) && !byId(IDS.organize).hidden) renderOrganizeList();
}
