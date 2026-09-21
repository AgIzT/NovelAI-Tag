/* 收藏夹界面。来源和权限仍由活词条决定，snap 不参与展示或计数。 */
import { state } from './state.js';
import { isEntryAccessBlocked } from './access.js';
import { isContentBlocked, subscribeContentBlocking } from './content-blocking.js';
import { thumbUrl } from './media.js';
import { toast } from './feedback.js';
import { animateUi, cancelUiMotion } from './ui-motion.js';
import { bindBackdropDismiss, bindOutsideDismiss, focusFirstIn, trapFocus, configureMask, openMask, closeMask, isGlobalShortcutBlocked, topInteractionLayer } from './modal.js';
import { createSelectMenu } from './select-menu.js';
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
const selectedKeys = () => {
  const shown = new Set((state.list || []).map(entryKey));
  return [...(state.favSelected || [])].filter(key => shown.has(key) && visibleIndex().has(key));
};
const layerOpen = id => Boolean(byId(id)?.classList.contains('show'));
let bound = false;
let wasActive = false;
let narrow = false;
let railHome = null;
let memo = null;
subscribeContentBlocking(() => { memo = null; });
let organizeKeys = [];
let organizeFolder = '';
let organizeRequestSeq = 0;
let sortMenu = null;
let menuTrigger = null;
let backupButton = null;
let menuFolder = '';
let dialogFolder = '';
let mutationBusy = false;
let batchBusy = false;
let folderNavigationSeq = 0;
const openers = new Map();
const selectionInert = new WeakMap();
const selectionSemantics = new WeakMap();
const motionElements = new Map();
let railEntered = false;

function favoriteMotion(node, frames, options) {
  if (document.visibilityState === 'hidden') return;
  const animation = animateUi(node, frames, options);
  if (!animation) return;
  motionElements.set(node, animation);
  const release = () => { if (motionElements.get(node) === animation) motionElements.delete(node); };
  animation.finished.then(release, release);
}
function stopFavoriteMotion(node) {
  cancelUiMotion(node);
  motionElements.delete(node);
}
function syncMotionVisibility() {
  const hidden = document.visibilityState === 'hidden';
  document.documentElement.classList.toggle('favorites-motion-paused', hidden);
  if (hidden) for (const node of motionElements.keys()) stopFavoriteMotion(node);
}
function enterRail() {
  if (railEntered || !state.favoritesView || (narrow && !layerOpen(IDS.drawer))) return;
  railEntered = true;
  const rows = [...byId('favoritesRail').querySelectorAll('.favorites-folder-row')];
  rows.forEach((row, index) => {
    const delay = Math.min(index * 18, 108), duration = delay + 132;
    // animateUi 固定 fill:none，等待要放进帧内，否则延迟期间会先亮再闪回首帧。
    favoriteMotion(row, [{ opacity: 0, translate: '0 4px', offset: 0 },
      { opacity: 0, translate: '0 4px', offset: delay / duration },
      { opacity: 1, translate: '0 0', offset: 1 }], { duration });
  });
}

export function setFavoritesViewActions(next = {}) { Object.assign(actions, next); }
export function invalidateOrganizeRequest() { organizeRequestSeq++; }

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
  const node = element('input', 'panel-input favorites-input');
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
/* 屏蔽前的业务范围，不借可见索引提前丢掉待统计的屏蔽项。 */
export function filterFavoritesScope(list) {
  if (!state.favoritesView) return list;
  const index = viewIndex();
  const saved = new Set(index.doc.items.map(item => item.key));
  const folder = state.favFolder || '';
  const members = index.members.get(folder) || new Set();
  return list.filter(entry => {
    const key = entryKey(entry);
    return saved.has(key) && (!state.favSource || entry._srcCodexId === state.favSource)
      && (!folder || (folder === '_unsorted' ? !index.assigned.has(key) : members.has(key)));
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
/* 归类、移出、删夹、改名只改卡片归属：沿用「不想看」的原地路径，离开当前夹的卡退场、
   后面的补位，滚动位置不动。换夹、换来源、换排序才是整屏重排，继续走 refreshList。 */
function refreshContent() {
  if (state.favoritesView) actions.applyFilter({ transition: 'blocking' });
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
  invalidateOrganizeRequest();
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

function folderRow(id, title, system = false) {
  const row = element('div', 'favorites-folder-row');
  row.classList.toggle('is-active', (state.favFolder || '') === id);
  row.dataset.folderId = id;
  const open = button('', 'favorites-folder-open ui-press', () => changeFolder(id));
  open.title = title;
  open.setAttribute('aria-current', (state.favFolder || '') === id ? 'page' : 'false');
  open.append(system ? element('span', 'favorites-folder-cover is-empty', id ? '◇' : '▦') : cover(id));
  open.append(element('span', 'favorites-folder-name', title), element('span', 'favorites-count', String(countVisible(folderKeys(id)))));
  row.append(open);
  if (!system) {
    const more = button('⋯', 'favorites-folder-more ui-press', () => openMenu(id, more));
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
  rail.replaceChildren(element('div', 'favorites-section-title', '收藏空间'), folderRow('', '全部', true), folderRow('_unsorted', '未分类', true));
  const heading = element('div', 'favorites-section-head');
  heading.append(element('span', 'favorites-section-title', '我的收藏夹'));
  const create = button('＋ 新建', 'bar-btn favorites-new-button', () => openFolderDialog('', 'create', create));
  heading.append(create);
  rail.append(heading);
  for (const folder of folders()) rail.append(folderRow(folder.id, folder.name));
  rail.scrollTop = scroll;
  if (activeRow !== undefined) {
    const row = [...rail.querySelectorAll('[data-folder-id]')].find(node => node.dataset.folderId === activeRow);
    row?.querySelector(activeMore ? '.favorites-folder-more' : '.favorites-folder-open')?.focus({ preventScroll: true });
  } else if (activeCreate) rail.querySelector('.favorites-new-button')?.focus({ preventScroll: true });
  enterRail();
}
function sortSelect() {
  sortMenu = createSelectMenu({
    label: '收藏排序', value: state.favSort || 'recent', className: 'favorites-sort is-pill',
    options: [{ value: 'recent', label: '最近收藏' }, { value: 'oldest', label: '最早收藏' }, { value: 'title', label: '按标题' }],
    onChange: value => { state.favSort = value; routeChanged(); refreshList(); },
  });
  return sortMenu.element;
}
function toggleSelection() { state.favSelecting ? endSelection() : beginSelection(); }
export function renderFavoritesHeader() {
  if (!bound) return;
  if (!state.favoritesView) return;
  const header = byId('favoritesHeader');
  const sourceRail = byId('favoritesSources');
  const menuFocused = byId('favoritesMenu')?.contains(document.activeElement) && header.contains(menuTrigger);
  if (!byId('favoritesMenu').hidden && header.contains(menuTrigger)) closeMenu();
  const focusedSource = sourceRail.contains(document.activeElement) ? document.activeElement.dataset.sourceId : undefined;
  const sourceScroll = sourceRail.scrollLeft;
  const all = countVisible(folderKeys());
  const shown = countVisible((state.list || []).map(entryKey));
  const hasFilter = Boolean(state.query || state.favSource || state.searchFilterValues?.length);
  // 头部控件只创建一次；来源、排序与归属更新不会重播入场或丢失键盘焦点。
  if (!header.firstElementChild) {
    const head = element('div', 'favorites-content-head');
    const title = element('div', 'favorites-heading');
    title.append(element('h1'), element('span', 'favorites-count'));
    const controls = element('div', 'favorites-head-controls');
    const desktop = element('div', 'favorites-desktop-controls');
    desktop.append(sortSelect(), button('', 'bar-btn favorites-selection-toggle', toggleSelection));
    controls.append(desktop);
    const more = button('⋯', 'favorites-head-more bar-btn', () => openMenu(state.favFolder, more, true));
    more.setAttribute('aria-label', '收藏操作');
    more.setAttribute('aria-haspopup', 'menu');
    controls.append(more);
    head.append(title, controls);
    header.append(head);
  }
  header.querySelector('h1').textContent = folderTitle();
  header.querySelector('.favorites-heading .favorites-count').textContent = (hasFilter ? shown + ' / ' + all : all) + ' 项';
  const selection = header.querySelector('.favorites-selection-toggle');
  selection.textContent = state.favSelecting ? '完成整理' : '批量整理';
  selection.setAttribute('aria-pressed', String(Boolean(state.favSelecting)));
  header.querySelector('.favorites-head-more').classList.toggle('is-system', !state.favFolder || state.favFolder === '_unsorted');
  sortMenu?.setValue(state.favSort || 'recent');
  const currentKeys = new Set(folderKeys());
  const sources = new Map([['', { name: '全部来源', keys: [...currentKeys] }]]);
  for (const [key, entry] of visibleIndex()) {
    if (!currentKeys.has(key)) continue;
    const id = entry._srcCodexId || '';
    if (!id) continue;
    if (!sources.has(id)) sources.set(id, { name: entry._srcCodexTitle || id, keys: [] });
    sources.get(id).keys.push(key);
  }
  const previous = new Map([...sourceRail.children].map(chip => [chip.dataset.sourceId, chip]));
  let position = 0;
  for (const [id, source] of sources) {
    let chip = previous.get(id);
    if (!chip) {
      chip = button('', 'rail-chip favorites-source-chip', () => {
        state.favSource = state.favSource === id ? '' : id;
        routeChanged();
        refreshList();
      });
      chip.dataset.sourceId = id;
      chip.append(element('span', 'favorites-source-label'), element('span', 'rc-n'));
      if (id) chip.prepend(element('i', 'rc-dot favorites-source-dot'));
    }
    chip.classList.toggle('active', (state.favSource || '') === id);
    chip.setAttribute('aria-pressed', String((state.favSource || '') === id));
    chip.querySelector('.favorites-source-label').textContent = source.name;
    chip.querySelector('.rc-n').textContent = String(countVisible(source.keys));
    if (id) {
      let hash = 0;
      for (const character of source.name) hash = (hash * 31 + character.codePointAt(0)) % 360;
      chip.querySelector('.favorites-source-dot').style.setProperty('--source-hue', String(hash));
    }
    // 不移动已在正确位置的节点；复用后整体append仍会干扰焦点和CSS动画。
    if (sourceRail.children[position] !== chip) sourceRail.insertBefore(chip, sourceRail.children[position] || null);
    previous.delete(id);
    position++;
  }
  for (const chip of previous.values()) chip.remove();
  const empty = byId('empty');
  if (empty && !state.list?.length) {
    empty.replaceChildren();
    const message = !library().items.length ? '还没有收藏。点卡片上的 ☆ 收藏词条。'
      : hasFilter ? '没有匹配的收藏。' : state.favFolder === '_unsorted' ? '收藏都已归类。' : '这个收藏夹还没有内容。';
    empty.append(element('p', '', message));
    if (library().items.length && (hasFilter || state.favFolder)) {
      const add = button(hasFilter ? '清除筛选' : '从全部收藏中选择', 'panel-action', async () => {
        state.favSource = ''; state.query = ''; state.searchFilterValues = [];
        const search = byId('search'); if (search) search.value = '';
        if (hasFilter) { routeChanged(); refreshList(); }
        else { await changeFolder(''); beginSelection(); }
      });
      empty.append(add);
    }
  }
  sourceRail.scrollLeft = sourceScroll;
  if (menuFocused) menuTrigger?.focus({ preventScroll: true });
  else if (focusedSource !== undefined && !sourceRail.contains(document.activeElement)) {
    ([...sourceRail.children].find(node => node.dataset.sourceId === focusedSource) || sourceRail.firstElementChild)?.focus({ preventScroll: true });
  }
  renderBatchBar();
  if (layerOpen(IDS.organize)) renderOrganizeList();
}

function showLayerDirect(id, trigger = document.activeElement) {
  const mask = byId(id);
  if (!mask) return;
  if (trigger?.isConnected) openers.set(id, trigger);
  openMask(mask, trigger, { historyMode: 'none' });
}
function closeLayerDirect(id) {
  const mask = byId(id);
  if (!mask) return;
  if (id === IDS.organize) invalidateOrganizeRequest();
  if (!layerOpen(id)) return;
  closeMask(mask, { historyMode: 'none' });
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
    target = row?.querySelector(opener?.classList.contains('favorites-folder-open') ? '.favorites-folder-open' : '.favorites-folder-more');
  }
  if (!target && opener?.classList.contains('favorites-new-button')) target = byId('favoritesRail')?.querySelector('.favorites-new-button');
  if (!target && opener?.dataset.folderCheck) target = [...document.querySelectorAll('[data-folder-check]')].find(row => row.dataset.folderCheck === opener.dataset.folderCheck);
  if (!target && opener?.classList.contains('favorites-head-more')) target = byId('favoritesHeader')?.querySelector('.favorites-head-more');
  if (target?.closest('[hidden], [inert]')) target = null;
  const top = topInteractionLayer();
  if (top && (!target || !top.contains(target))) { focusFirstIn(top); return; }
  if (!target && state.favoritesView) target = byId('favoritesHeader')?.querySelector('button');
  target?.focus({ preventScroll: true });
}
function showLayer(id, trigger) {
  showLayerDirect(id, trigger);
  openHistoryLayer(id);
}
function closeLayer(id, { historyMode = 'back' } = {}) {
  if (id === IDS.organize) invalidateOrganizeRequest();
  if (historyMode !== 'none' && closeHistoryLayer(id)) return;
  closeLayerDirect(id);
  if (historyMode !== 'none') forgetHistoryLayer(id);
}
function syncModalState() {
  const any = [IDS.drawer, IDS.organize, IDS.dialog].some(layerOpen);
  document.body.classList.toggle('favorites-modal-open', any);
}
function makeMask(id, className, label) {
  const mask = element('div', 'settings-mask favorites-mask ' + className);
  mask.id = id;
  mask.hidden = true;
  mask.inert = true;
  const dialog = element('section', 'settings-panel favorites-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', label);
  dialog.setAttribute('aria-labelledby', id + 'Title');
  mask.append(dialog);
  document.body.append(mask);
  configureMask(mask, {
    onOpen: () => { syncModalState(); if (id === IDS.drawer) enterRail(); },
    onClose: () => {
      if (id === IDS.drawer) {
        byId('menuBtn')?.setAttribute('aria-expanded', 'false');
        if (mask.contains(menuTrigger)) closeMenu();
      }
      syncModalState();
    },
    restoreFocus: () => restoreLayerFocus(id),
  });
  registerHistoryLayer(id, { isOpen: () => layerOpen(id), open: () => showLayerDirect(id), close: () => closeLayerDirect(id) });
  bindBackdropDismiss(mask, () => { if (!mutationBusy) closeLayer(id); });
  return dialog;
}
function closeMenu() {
  const menu = byId('favoritesMenu');
  if (menu) { stopFavoriteMotion(menu); menu.hidden = true; }
  menuTrigger?.setAttribute('aria-expanded', 'false');
}
function menuItem(label, className, handler) {
  const item = button('', className, handler);
  const copy = element('span');
  copy.append(element('b', '', label));
  item.append(copy);
  return item;
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
  const backup = backupButton ||= byId('favoritesViewBackupBtn');
  menu.replaceChildren();
  if (fromHeader) menu.append(menuItem('新建收藏夹', 'more-item favorites-menu-item', () => { closeMenu(); openFolderDialog('', 'create', trigger); }));
  if (menuFolder && menuFolder !== '_unsorted') {
    menu.append(menuItem('重命名收藏夹', 'more-item favorites-menu-item', () => { closeMenu(); openFolderDialog(menuFolder, 'rename', trigger); }));
    menu.append(menuItem('删除收藏夹', 'more-item favorites-menu-item is-danger', () => { closeMenu(); openFolderDialog(menuFolder, 'delete', trigger); }));
  }
  if (fromHeader && backup) {
    backup.className = 'more-item favorites-menu-item';
    if (!backup.querySelector('b')) {
      const copy = element('span');
      copy.append(element('b', '', '备份与恢复'));
      backup.replaceChildren(copy);
    }
    backup.hidden = false;
    menu.append(backup);
  }
  menu.hidden = false;
  const rect = trigger.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  for (const item of menu.querySelectorAll('button')) item.setAttribute('role', 'menuitem');
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
    else refreshContent();
    return true;
  } });
}

function openFolderDialog(id, mode, trigger, itemKeys = []) {
  if (mutationBusy) return;
  const folder = library().folders.find(item => item.id === id);
  if (mode !== 'create' && !folder) return;
  dialogFolder = id;
  const root = byId(IDS.dialog).firstElementChild;
  root.replaceChildren();
  const title = element('h2', 'settings-title', mode === 'create' ? '新建收藏夹' : mode === 'delete' ? '删除「' + folder.name + '」？' : '重命名收藏夹');
  title.id = IDS.dialog + 'Title';
  const form = element('form', 'favorites-name-form');
  const field = mode === 'delete' ? null : input('收藏夹名称');
  if (field) {
    field.id = 'favoritesFolderName';
    field.value = mode === 'rename' ? folder.name : byId('favoritesOrganizeSearch')?.value || '';
    if (!itemKeys.length && mode === 'create') field.value = '';
    const label = element('label', 'favorites-field-label', '名称'); label.htmlFor = field.id;
    form.append(label, field);
  } else form.append(element('p', 'favorites-delete-copy', '收藏的素材会保留。只属于这个夹子的素材会回到「未分类」。'));
  const error = errorLine();
  const footer = element('div', 'favorites-dialog-footer');
  const cancel = button('取消', 'panel-action', () => { if (!mutationBusy) closeLayer(IDS.dialog); });
  const save = button(mode === 'delete' ? '删除收藏夹' : mode === 'create' ? (itemKeys.length ? '新建并加入' : '新建') : '保存',
    'panel-action ' + (mode === 'delete' ? 'is-danger' : 'is-primary'));
  save.type = 'submit';
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (mutationBusy) return;
    mutationBusy = true; save.setAttribute('aria-disabled', 'true'); form.setAttribute('aria-busy', 'true');
    const name = field?.value;
    const result = await commitLibrary(doc => {
      if (mode === 'delete') return deleteFolder(doc, id);
      if (mode === 'rename') return renameFolder(doc, id, name);
      const created = createFolder(doc, name);
      if (itemKeys.length) setFolderMembership(doc, itemKeys, created.id, true);
      return created;
    }, { changed: itemKeys.length ? 'all' : 'folders' });
    mutationBusy = false; save.removeAttribute('aria-disabled'); form.removeAttribute('aria-busy');
    if (!result.ok) { reportInline(error, result); if (layerOpen(IDS.dialog)) field?.focus({ preventScroll: true }); return; }
    if (mode === 'delete' && state.favFolder === id) { state.favFolder = ''; routeChanged(); }
    if (mode === 'create' && itemKeys.length) byId('favoritesOrganizeSearch').value = '';
    refreshContent(); renderOrganizeList();
    if (mode === 'create') {
      const selector = itemKeys.length ? '[data-folder-check]' : '[data-folder-id]';
      const createdRow = [...document.querySelectorAll(selector)].find(row => (row.dataset.folderCheck || row.dataset.folderId) === result.result.id);
      if (createdRow) openers.set(IDS.dialog, itemKeys.length ? createdRow : createdRow.querySelector('.favorites-folder-open'));
      toast('已新建「' + result.result.name + '」' + (itemKeys.length ? '，加入 ' + itemKeys.length + ' 项' : ''));
    } else if (mode === 'delete') undoToast('已删除「' + folder.name + '」', result.result, 'folder');
    else { routeChanged(); toast('已重命名收藏夹'); }
    if (layerOpen(IDS.dialog)) closeLayer(IDS.dialog);
  });
  footer.append(cancel, save); form.append(error, footer); root.append(title, form);
  showLayer(IDS.dialog, trigger);
  field?.focus({ preventScroll: true });
  if (mode === 'rename') field?.select();
}
async function joinFolder(keys, folderId, on) {
  const name = library().folders.find(folder => folder.id === folderId)?.name;
  if (!name) return false;
  const result = await commitLibrary(doc => setFolderMembership(doc, keys, folderId, on), { changed: 'memberships' });
  if (!result.ok) { renderOrganizeList(); return false; }
  refreshContent();
  renderOrganizeList();
  if (on) toast(keys.length === 1 ? '已加入「' + name + '」' : '已加入「' + name + '」' + keys.length + ' 项');
  return true;
}
export async function openOrganize(keys, trigger = document.activeElement) {
  setupFavoritesView();
  const request = ++organizeRequestSeq;
  try { await actions.prepareEntries(); } catch (error) {
    if (request !== organizeRequestSeq) return;
    console.warn('[favorites] 整理所需来源暂未读到', error);
    toast('收藏来源没能加载，重试一次', '!');
    return;
  }
  if (request !== organizeRequestSeq) return;
  memo = null;
  /* 在主图鉴点收藏后的 toast 也能整理；回源可见性由入口活词条负责，库身份仍需存在。 */
  const existing = new Set(library().items.map(item => item.key));
  organizeKeys = [...new Set(keys || [])].filter(key => existing.has(key) && visibleIndex().has(key));
  if (!organizeKeys.length) return;
  organizeFolder = state.favoritesView ? state.favFolder || '' : '';
  byId('favoritesOrganizeSearch').value = '';
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
  const focused = list.contains(document.activeElement) ? document.activeElement?.dataset.folderCheck : '';
  const previous = new Map([...list.querySelectorAll('[data-folder-check]')].map(row => [row.dataset.folderCheck, row]));
  const query = byId('favoritesOrganizeSearch').value.trim();
  const found = folders().filter(folder => folder.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const keep = new Set(found.map(folder => folder.id));
  for (const child of [...list.children]) if (!keep.has(child.dataset.folderCheck)) child.remove();
  for (const [index, folder] of found.entries()) {
    const members = viewIndex().members.get(folder.id) || new Set();
    const selected = organizeKeys.filter(key => members.has(key)).length;
    const status = selected === organizeKeys.length && selected > 0 ? 'true' : selected > 0 ? 'mixed' : 'false';
    const row = previous.get(folder.id) || button('', 'favorites-organize-row ui-press');
    const oldStatus = row.getAttribute('aria-checked');
    row.onclick = async () => {
      if (mutationBusy || !organizeKeys.length) return;
      mutationBusy = true;
      row.setAttribute('aria-disabled', 'true');
      list.setAttribute('aria-busy', 'true');
      try { await joinFolder(organizeKeys.slice(), folder.id, row.getAttribute('aria-checked') !== 'true'); }
      finally {
        mutationBusy = false; list.removeAttribute('aria-busy'); renderOrganizeList();
      }
    };
    row.dataset.folderCheck = folder.id;
    row.setAttribute('role', 'checkbox');
    row.setAttribute('aria-checked', status);
    row.setAttribute('aria-disabled', String(mutationBusy || !organizeKeys.length));
    const check = row.querySelector('.favorites-check') || element('span', 'favorites-check');
    check.textContent = status === 'true' ? '✓' : status === 'mixed' ? '−' : '';
    row.replaceChildren(check, cover(folder.id), element('span', 'favorites-folder-name', folder.name),
      element('span', 'favorites-count', String(countVisible(folderKeys(folder.id)))));
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    if (oldStatus && oldStatus !== status) favoriteMotion(check,
      [{ scale: .9, opacity: .6 }, { scale: 1, opacity: 1 }], { duration: 120 });
  }
  if (!found.length) list.append(element('p', 'favorites-panel-empty', query ? '没有叫「' + query + '」的收藏夹' : '还没有收藏夹。'));
  list.scrollTop = scroll;
  if (focused && !list.contains(document.activeElement) && layerOpen(IDS.organize) && !layerOpen(IDS.dialog)) {
    ([...list.children].find(row => row.dataset.folderCheck === focused) || byId('favoritesOrganizeSearch'))?.focus({ preventScroll: true });
  }
}
function beginSelection() {
  if (!state.favoritesView || state.favSelecting) return;
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
  if (state.favSelecting) {
    if (!selectionSemantics.has(card)) selectionSemantics.set(card,
      new Map(['role', 'tabindex', 'aria-checked'].map(name => [name, card.getAttribute(name)])));
    card.setAttribute('role', 'checkbox');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-checked', String(Boolean(state.favSelected?.has(card.dataset.favoriteKey))));
  } else if (selectionSemantics.has(card)) {
    for (const [name, value] of selectionSemantics.get(card)) {
      if (value === null) card.removeAttribute(name);
      else card.setAttribute(name, value);
    }
    selectionSemantics.delete(card);
  }
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
  const wasHidden = bar.hidden;
  bar.hidden = !state.favoritesView || !state.favSelecting;
  if (bar.hidden) stopFavoriteMotion(bar);
  else if (wasHidden) favoriteMotion(bar, [{ opacity: 0, translate: '-50% 12px' }, { opacity: 1, translate: '-50% 0' }], { duration: 180 });
  if (bar.hidden) return;
  const keys = selectedKeys();
  const focused = bar.contains(document.activeElement) ? document.activeElement.dataset.favBatch : null;
  bar.replaceChildren(element('strong', '', '已选 ' + countVisible(keys) + ' 项'));
  bar.append(button('全选', 'panel-action favorites-action', () => {
    state.favSelected = new Set((state.list || []).map(entryKey).filter(key => visibleIndex().has(key)));
    updateCardSelections();
    renderBatchBar();
  }));
  bar.setAttribute('aria-busy', String(batchBusy));
  const join = button('加入收藏夹', 'panel-action favorites-action is-primary', () => { if (!batchBusy) openOrganize(selectedKeys(), join); });
  join.disabled = !keys.length;
  join.setAttribute('aria-disabled', String(batchBusy || !keys.length));
  bar.append(join);
  if (state.favFolder && state.favFolder !== '_unsorted') {
    const move = button('移出本夹', 'panel-action favorites-action', async () => {
      if (batchBusy) return;
      const folderId = state.favFolder;
      const name = folderTitle();
      const chosen = selectedKeys();
      if (!chosen.length) return;
      batchBusy = true; renderBatchBar();
      try {
        const result = await commitLibrary(doc => {
          const snapshot = { memberships: doc.memberships.filter(item => item.folderId === folderId && chosen.includes(item.itemKey)).map(clone) };
          setFolderMembership(doc, chosen, folderId, false);
          return snapshot;
        }, { changed: 'memberships' });
        if (!result.ok) return;
        refreshContent();
        const count = result.result.memberships.length;
        if (count) undoToast('已从「' + name + '」移出 ' + count + ' 项', result.result, 'memberships');
      } finally { batchBusy = false; renderBatchBar(); }
    });
    move.disabled = !keys.length;
    move.setAttribute('aria-disabled', String(batchBusy || !keys.length));
    bar.append(move);
  }
  const remove = button('取消收藏', 'panel-action favorites-action is-danger', async () => {
    if (batchBusy) return;
    const chosen = selectedKeys();
    if (!chosen.length) return;
    batchBusy = true; renderBatchBar();
    try {
      const result = await commitLibrary(doc => removeLibraryItems(doc, chosen), { changed: 'items' });
      if (!result.ok) return;
      await refreshItems();
      const count = result.result.items.length;
      if (count) undoToast('已取消收藏 ' + count + ' 项', result.result, 'items');
    } finally { batchBusy = false; renderBatchBar(); }
  });
  remove.disabled = !keys.length;
  remove.setAttribute('aria-disabled', String(batchBusy || !keys.length));
  bar.append(remove, button('完成', 'panel-action favorites-action', () => endSelection()));
  for (const control of bar.querySelectorAll('button')) control.dataset.favBatch = control.textContent;
  document.body.style.setProperty('--favorites-batch-height', bar.offsetHeight + 'px');
  if (focused) [...bar.querySelectorAll('button')].find(node => node.dataset.favBatch === focused)?.focus({ preventScroll: true });
}
function badgeSignature(badges) {
  return badges.map(folder => folder.id + '' + folder.name).join('');
}
function renderBadgeRow(card, badges, { animateFrom = null } = {}) {
  const foot = card.querySelector('.card-foot');
  if (!foot) return;
  foot.querySelector('.favorite-folder-badges')?.remove();
  card.dataset.badgeSignature = badgeSignature(badges);
  if (!badges.length) return;
  const row = element('div', 'favorite-folder-badges');
  for (const folder of badges.slice(0, 2)) {
    const chip = element('span', 'favorite-folder-badge', folder.name);
    chip.title = folder.name;
    row.append(chip);
    // 就地对齐时只给新加入的夹子补入场，已有徽章不重播。
    if (!animateFrom || !animateFrom.has(folder.id)) {
      favoriteMotion(chip, [{ opacity: 0, translate: '0 4px' }, { opacity: 1, translate: '0 0' }], { duration: 160 });
    }
  }
  if (badges.length > 2) row.append(element('span', 'favorite-folder-badge favorite-folder-overflow', '+' + (badges.length - 2)));
  foot.append(row);
}
/* 原地刷新会复用卡片节点，徽章不会随 makeCard 重建；库变更后在重算布局前把已渲染卡片对齐。
   估高读的是同一份库（favoriteBadgeHeight），先对齐 DOM 才不会出现一帧重叠。 */
export function refreshFavoriteBadges() {
  if (!state.favoritesView) return;
  const index = viewIndex();
  const ordered = folders();
  for (const card of document.querySelectorAll('.favorite-library-card[data-favorite-key]')) {
    const ids = new Set(index.itemFolders.get(card.dataset.favoriteKey) || []);
    const badges = ordered.filter(folder => ids.has(folder.id)).map(folder => ({ id: folder.id, name: folder.name }));
    const signature = badgeSignature(badges);
    if (card.dataset.badgeSignature === signature) continue;
    const previous = new Set((card.dataset.badgeSignature || '').split('').filter(Boolean).map(part => part.split('')[0]));
    renderBadgeRow(card, badges, { animateFrom: previous });
  }
}

export function decorateFavoriteCard(card, entry) {
  if (!state.favoritesView || !card) return;
  card.dataset.favoriteKey = entryKey(entry);
  card.classList.add('favorite-library-card');
  const checkbox = button('', 'favorite-select-check ui-press');
  checkbox.setAttribute('role', 'checkbox');
  checkbox.tabIndex = -1;
  checkbox.setAttribute('aria-hidden', 'true');
  checkbox.setAttribute('aria-label', '选择「' + String(entry.title || '') + '」');
  checkbox.setAttribute('aria-checked', String(Boolean(state.favSelected?.has(entryKey(entry)))));
  checkbox.hidden = !state.favSelecting;
  checkbox.textContent = state.favSelected?.has(entryKey(entry)) ? '✓' : '';
  card.append(checkbox);
  card.classList.toggle('is-favorite-selected', Boolean(state.favSelecting && state.favSelected?.has(entryKey(entry))));
  const organize = button('整理', 'bar-btn favorite-organize-button', event => {
    event.stopPropagation(); openOrganize([entryKey(entry)], organize);
  });
  organize.setAttribute('aria-label', '整理「' + String(entry.title || '') + '」到收藏夹');
  organize.title = '整理到收藏夹';
  const image = card.querySelector('.card-img-wrap');
  if (image && !card.classList.contains('no-img')) image.append(organize);
  else card.querySelector('.card-title-row')?.append(organize);
  card.querySelector('.hide-card-btn')?.remove();
  renderBadgeRow(card, folderBadges(entry));
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
  if (active && state.favSelecting) {
    const next = selectedKeys();
    const removed = (state.favSelected?.size || 0) - next.length;
    state.favSelected = new Set(next);
    if (removed > 0) toast('已取消选择 ' + removed + ' 项筛选外的收藏');
  }
  document.body.classList.toggle('favorites-library-view', active);
  for (const id of ['favoritesRail', 'favoritesHeader', 'favoritesSources']) {
    if (byId(id)) byId(id).hidden = !active;
  }
  if (active) placeRail();
  const menu = byId('menuBtn');
  if (menu) {
    menu.title = active ? '收藏夹' : '目录';
    menu.setAttribute('aria-label', menu.title);
    if (active && narrow) {
      menu.setAttribute('aria-controls', IDS.drawer);
      menu.setAttribute('aria-expanded', String(layerOpen(IDS.drawer)));
    } else {
      menu.removeAttribute('aria-controls');
      menu.removeAttribute('aria-expanded');
    }
  }
  if (!active && wasActive) {
    closeMenu();
    sortMenu?.close();
    for (const id of [IDS.dialog, IDS.organize, IDS.drawer]) { closeLayerDirect(id); forgetHistoryLayer(id); }
    endSelection({ historyMode: 'none' });
    railHome?.append(byId('favoritesRail'));
    state.favFolder = '';
    state.favSource = '';
  }
  wasActive = active;
  if (active) {
    const id = state.favFolder;
    if (id && id !== '_unsorted' && !library().folders.some(folder => folder.id === id)) {
      state.favFolder = '';
      endSelection({ historyMode: 'none' });
      routeChanged();
    }
    placeRail();
  }
  updateCardSelections();
}
/* 容器归属读取实际断点；这里不改会话状态，避免吞掉断点清理。 */
function placeRail() {
  const rail = byId('favoritesRail');
  if (!rail || !state.favoritesView) return;
  const compact = window.matchMedia('(max-width: 859px)').matches;
  const host = compact ? byId('favoritesDrawerRail') : railHome;
  if (host && rail.parentElement !== host) host.append(rail);
}

/* 收藏视图复用顶栏那颗目录按钮：窄屏唤起抽屉，宽屏折叠/展开收藏夹栏。
   独立按钮会让顶栏在进出收藏时整体位移，也拿不回「收起侧栏看大图」这个动作。 */
export function toggleFavoritesFolders(trigger) {
  if (!state.favoritesView) return false;
  if (window.matchMedia('(max-width: 859px)').matches) {
    const mask = byId(IDS.drawer);
    if (!mask) return false;
    placeRail();
    if (!layerOpen(IDS.drawer)) {
      showLayer(IDS.drawer, trigger);
      trigger?.setAttribute?.('aria-expanded', 'true');
    } else closeLayer(IDS.drawer);
    return true;
  }
  return false;
}

export function setupFavoritesView() {
  if (bound || !globalThis.document?.body) return;
  bound = true;
  syncMotionVisibility();
  document.addEventListener('visibilitychange', syncMotionVisibility);
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
  const drawer = makeMask(IDS.drawer, 'favorites-drawer-mask', '收藏夹');
  const drawerHead = element('header', 'favorites-drawer-head');
  const drawerTitle = element('h2', 'settings-title', '收藏夹'); drawerTitle.id = IDS.drawer + 'Title';
  drawerHead.append(drawerTitle, button('完成', 'panel-action', () => closeLayer(IDS.drawer)));
  const drawerRail = element('div', 'favorites-drawer-rail'); drawerRail.id = 'favoritesDrawerRail';
  drawer.append(drawerHead, drawerRail);
  const organize = makeMask(IDS.organize, 'favorites-organize-mask', '整理到收藏夹');
  const organizeTitle = element('h2', 'settings-title', '整理到收藏夹'); organizeTitle.id = IDS.organize + 'Title';
  organize.append(organizeTitle);
  const subtitle = element('p', 'favorites-organize-subtitle'); subtitle.id = 'favoritesOrganizeSubtitle';
  const search = input('搜索收藏夹'); search.id = 'favoritesOrganizeSearch';
  const list = element('div', 'favorites-organize-list'); list.id = 'favoritesOrganizeList';
  const error = errorLine(); error.id = 'favoritesOrganizeError';
  const create = button('＋ 新建收藏夹', 'panel-action', () => openFolderDialog('', 'create', create, organizeKeys.slice()));
  create.id = 'favoritesOrganizeCreate';
  search.addEventListener('input', renderOrganizeList);
  const footer = element('div', 'favorites-dialog-footer');
  footer.append(create, button('完成', 'panel-action', () => { if (!mutationBusy) closeLayer(IDS.organize); }));
  organize.append(subtitle, search, list, error, footer);
  makeMask(IDS.dialog, 'favorites-folder-dialog-mask', '收藏夹');
  const menu = element('div', 'more-menu favorites-menu'); menu.id = 'favoritesMenu'; menu.hidden = true; menu.setAttribute('role', 'menu');
  menu.setAttribute('data-modal-root', '');
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      closeMenu(); menuTrigger?.focus({ preventScroll: true }); return;
    }
    if (event.key === 'Tab') {
      // 从入口交给原生Tab继续，避免在挂在body末尾的浮层中循环。
      menuTrigger?.focus({ preventScroll: true });
      closeMenu();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const items = [...menu.querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  });
  document.body.append(menu);
  bindOutsideDismiss(() => menu.hidden ? [] : [menu, menuTrigger], closeMenu);
  configureMask(byId('favoritesBackupPanel'), { restoreFocus: (_mask, opener) => {
    const target = opener?.id === 'favoritesViewBackupBtn' && state.favoritesView
      ? byId('favoritesHeader')?.querySelector('.favorites-head-more') : opener;
    const top = topInteractionLayer();
    if (top && (!target || !top.contains(target))) focusFirstIn(top);
    else if (target?.isConnected && !target.closest('[hidden], [inert]')) target.focus({ preventScroll: true });
  } });
  const bar = element('div', 'favorites-batch-bar'); bar.id = 'favoritesBatchBar'; bar.hidden = true; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', '批量整理');
  document.body.append(bar);
  registerHistoryLayer(IDS.selection, {
    isOpen: () => Boolean(state.favSelecting),
    open: () => { state.favSelecting = true; state.favSelected = new Set(); updateCardSelections(); renderFavoritesHeader(); },
    close: () => { state.favSelecting = false; state.favSelected = new Set(); updateCardSelections(); renderFavoritesHeader(); },
  });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    const mask = [IDS.dialog, IDS.organize, IDS.drawer].map(byId)
      .find(node => node?.classList.contains('show') && !isGlobalShortcutBlocked(event, node));
    if (mask) {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!mutationBusy) closeLayer(mask.id);
      } else trapFocus(event, mask.querySelector('.favorites-dialog'));
      return;
    }
    if (event.key === 'Escape' && state.favSelecting && !isGlobalShortcutBlocked(event)
        && (!topHistoryLayerId() || topHistoryLayerId() === IDS.selection)) {
      event.preventDefault(); endSelection();
    }
  });
  const viewport = window.matchMedia('(max-width: 859px)');
  narrow = viewport.matches;
  const syncBreakpoint = () => {
    const changed = narrow !== viewport.matches;
    narrow = viewport.matches;
    if (!changed) return;
    closeMenu(); sortMenu?.close();
    placeRail();
    if (!narrow && layerOpen(IDS.drawer)) closeLayer(IDS.drawer);
    syncFavoritesView();
    if (state.favoritesView) renderFavoritesHeader();
  };
  viewport.addEventListener('change', syncBreakpoint);
  let previousWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    syncBreakpoint();
    if (window.innerWidth === previousWidth) return;
    previousWidth = window.innerWidth;
    closeMenu(); sortMenu?.close();
    placeRail();
    const batchBar = byId('favoritesBatchBar');
    if (batchBar && !batchBar.hidden) document.body.style.setProperty('--favorites-batch-height', batchBar.offsetHeight + 'px');
  });
  subscribeLibrary(() => {
    memo = null;
    if (organizeFolder && organizeFolder !== '_unsorted' && !library().folders.some(folder => folder.id === organizeFolder)
        && layerOpen(IDS.organize)) {
      closeLayer(IDS.organize);
      toast('收藏夹已删除', '!');
    }
    if (dialogFolder && !library().folders.some(folder => folder.id === dialogFolder) && layerOpen(IDS.dialog) && !mutationBusy) closeLayer(IDS.dialog);
    syncFavoritesView();
    if (state.favoritesView) { renderFavoritesRail(); renderFavoritesHeader(); }
    if (layerOpen(IDS.organize)) {
      if (!organizeKeys.some(key => library().items.some(item => item.key === key))) {
        closeLayer(IDS.organize);
        toast('收藏已取消', '!');
      } else renderOrganizeList();
    }
  });
  syncFavoritesView();
}

export function refreshOpenOrganize() {
  if (bound && byId(IDS.organize) && layerOpen(IDS.organize)) renderOrganizeList();
}
