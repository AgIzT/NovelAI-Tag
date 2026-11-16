/* 挑画师（原型）：单画师墙上的排序下拉、多选、底部操作条与「只看所选」。
   不另存一份名单：复制照常进中转站素材，加入方案交给中转站，调权重也在那边。
   多选按画师身份记（同一位换了例图来源仍是同一位），只存在本页内存里。
   列表怎么排在 artist-style.js，这里只管界面；刷新列表经 setArtistPickActions 注入，不反向依赖 app.js。 */

import { state } from './state.js';
import { toast } from './feedback.js';
import { createSelectMenu } from './select-menu.js';
import { isGlobalShortcutBlocked } from './modal.js';
import { topHistoryLayerId } from './browser-history.js';
import { isEntryAccessBlocked } from './access.js';
import { copyText, entryPromptText } from './copy.js';
import { prepareCopiedEntry, recordCopiedEntry } from './tag-relay-store.js';
import { snapshotLocked } from './tag-relay-snapshot.js';
import { openRelayRail } from './tag-relay-rail.js';
import {
  SINGLE_ROOT, artistOf, artistNameOf, artistUsageReady, inSingleSection, loadArtistUsage,
  styleActive, styleBookEntry, styleLocation,
} from './artist-style.js';

const actions = {
  applyFilter: () => {},
};

export function setArtistPickActions(next = {}) {
  Object.assign(actions, next);
}

const SORT_LABELS = { style: '按画风', post: 'post 最多', usage: '站内例图用得最多', new: '最近新增' };

let controls = null;     // { root, sort, toggle, only }
let bar = null;
let busy = false;
let unsaved = false;     // 勾选变过、还没复制或加入方案；退出多选时据此给「恢复」

const searching = () => Boolean(state.searchPlan?.hasActiveSearch || String(state.query || '').trim() || state.searchFilterValues?.length);
const pickScope = () => styleActive() && !state.favoritesView && !state.siteSearchView;
const artistList = () => pickScope() && inSingleSection() && !searching() && styleLocation()?.level !== 'unsorted';
const pickable = entry => (pickScope() && entry?.path?.[0] === SINGLE_ROOT ? artistOf(entry) : null);

function pickedEntries() {
  return [...state.artistPicked.values()].map(styleBookEntry).filter(entry => entry && !isEntryAccessBlocked(entry));
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(text, className, onClick) {
  const node = element('button', className, text);
  node.type = 'button';
  node.onclick = onClick;
  return node;
}

/* ---------- 卡片 ---------- */

function syncCard(card) {
  const on = state.artistPicked.has(Number(card.dataset.artistPick));
  card.classList.toggle('is-artist-picked', on);
  const check = card.querySelector('.artist-pick-check');
  if (check) {
    check.setAttribute('aria-checked', String(on));
    check.textContent = on ? '✓' : '';
  }
}

function syncCards() {
  document.body.classList.toggle('artist-picking', Boolean(state.artistPicking));
  for (const card of document.querySelectorAll('[data-artist-pick]')) syncCard(card);
}

function refreshAll({ list = false } = {}) {
  if (list) actions.applyFilter();
  else renderArtistPickControls();
  syncCards();
  renderBar();
}

function togglePick(entry, artist) {
  const wasOnly = state.artistPickOnly;
  if (state.artistPicked.has(artist.index)) state.artistPicked.delete(artist.index);
  else state.artistPicked.set(artist.index, entry.id);
  state.artistPicking = true;
  unsaved = state.artistPicked.size > 0;
  if (wasOnly && !state.artistPicked.size) state.artistPickOnly = false;
  refreshAll({ list: wasOnly });
}

function handleCardClick(event, entry, artist) {
  if (!state.artistPicking) return;
  if (event.target.closest?.('.zoom-btn, .img-retry, .artist-pick-check')) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  togglePick(entry, artist);
}

/* makeCard 末尾调用：单画师卡加角标勾；进入多选后点卡片就是勾选。 */
export function decorateArtistPickCard(card, entry) {
  const artist = pickable(entry);
  if (!artist) return;
  card.dataset.artistPick = String(artist.index);
  card.classList.add('artist-pick-card');
  const check = button('', 'artist-pick-check', event => {
    event.stopPropagation();
    togglePick(entry, artist);
  });
  check.setAttribute('role', 'checkbox');
  check.setAttribute('aria-label', `选中 ${artistNameOf(entry)}`);
  (card.querySelector('.card-img-wrap:not([hidden])') || card).append(check);
  card.addEventListener('click', event => handleCardClick(event, entry, artist), true);
  syncCard(card);
}

/* ?lean=1 的对照：单画师卡的标题已经是画师名，提示词行不再重复一遍；估高与样式用同一判断。 */
let lean = false;
export function leanArtistCard(entry) {
  return lean && Boolean(pickable(entry));
}

/* ---------- 进入与退出 ---------- */

function beginPicking() {
  if (state.artistPicking) return;
  state.artistPicking = true;
  refreshAll();
}

function endPicking({ silent = false } = {}) {
  if (!state.artistPicking && !state.artistPicked.size) return;
  const kept = new Map(state.artistPicked);
  const wasOnly = state.artistPickOnly;
  const offerRestore = !silent && unsaved && kept.size > 0;
  state.artistPicking = false;
  state.artistPicked = new Map();
  state.artistPickOnly = false;
  unsaved = false;
  if (silent) { syncCards(); renderBar(); return; }
  refreshAll({ list: wasOnly });
  if (offerRestore) {
    toast(`已退出多选，清空 ${kept.size} 位`, '✓', {
      label: '恢复',
      duration: 6_000,
      onClick: () => {
        if (!pickScope() || state.artistPicking) return;
        state.artistPicked = kept;
        state.artistPicking = true;
        unsaved = true;
        refreshAll();
      },
    });
  }
}

function setPickOnly(on) {
  const next = Boolean(on) && state.artistPicked.size > 0;
  if (next === state.artistPickOnly) return;
  state.artistPickOnly = next;
  window.scrollTo({ top: 0 });
  refreshAll({ list: true });
}

/* ---------- 结果栏里的控件 ---------- */

function sortOptions() {
  return ['style', 'post', ...(artistUsageReady() ? ['usage'] : []), 'new'].map(value => ({ value, label: SORT_LABELS[value] }));
}

function buildControls(root) {
  const sort = createSelectMenu({
    label: '画师排序', value: state.artistSort, className: 'artist-sort is-pill', options: sortOptions(),
    onChange: value => {
      state.artistSort = value;
      window.scrollTo({ top: 0 });
      actions.applyFilter();
    },
  });
  const toggle = button('多选', 'bar-btn artist-pick-toggle', () => (state.artistPicking ? endPicking() : beginPicking()));
  const only = button('', 'bar-btn update-filter-btn artist-pick-only', () => setPickOnly(false));
  only.setAttribute('aria-pressed', 'true');
  root.replaceChildren(sort.element, toggle, only);
  return { root, sort, toggle, only };
}

/* updateResultBar 每次都调：按当前视图决定三个控件各自出不出现。 */
export function renderArtistPickControls() {
  const root = document.getElementById('artistPickControls');
  if (!root) return;
  if (!pickScope()) {
    if (state.artistPicking || state.artistPicked.size) endPicking({ silent: true });
    root.hidden = true;
    return;
  }
  const list = artistList();
  root.hidden = !list && !state.artistPicking;
  if (root.hidden) return;
  if (!controls || controls.root !== root) controls = buildControls(root);
  const only = state.artistPickOnly && state.artistPicked.size > 0;
  controls.sort.element.hidden = !list || only;
  const optionsKey = sortOptions().map(option => option.value).join();
  if (optionsKey !== controls.optionsKey) { controls.optionsKey = optionsKey; controls.sort.setOptions(sortOptions()); }
  controls.sort.setValue(state.artistSort);
  controls.toggle.textContent = state.artistPicking ? '完成' : '多选';
  controls.toggle.setAttribute('aria-pressed', String(Boolean(state.artistPicking)));
  controls.only.hidden = !only;
  controls.only.textContent = `只看所选 · ${state.artistPicked.size}`;
  controls.only.title = '退出只看所选';
}

/* ---------- 底部操作条 ---------- */

async function copyPicked(trigger) {
  const entries = pickedEntries();
  if (!entries.length || busy) return;
  busy = true; renderBar();
  try {
    const text = entries.map(entry => entryPromptText(entry)).join(', ');
    const result = await copyText(text, `已复制 ${entries.length} 位画师`, trigger, {
      promptCopy: true,
      accessGuard: () => entries.every(entry => !isEntryAccessBlocked(entry)),
    });
    if (!result?.ok) return;
    // 复制即入库：每位各记一条，和单张复制一致。
    for (const entry of entries) await recordCopiedEntry(entry);
    unsaved = false;
  } finally { busy = false; renderBar(); }
}

async function addPickedToPlan(trigger) {
  const entries = pickedEntries();
  if (!entries.length || busy) return;
  busy = true; renderBar();
  let added = 0;
  try {
    const { addSourceToPlan } = await import('./tag-relay-compose.js');
    for (const entry of entries) {
      const snapshot = prepareCopiedEntry(entry);
      if (!snapshot || snapshotLocked(snapshot)) continue;
      if (await addSourceToPlan(snapshot, { focus: false })) added += 1;
    }
  } catch {
    toast('未能加入方案，再点一次重试', '!');
  } finally { busy = false; renderBar(); }
  if (!added) return;
  unsaved = false;
  toast(`已加入当前方案：${added} 位画师`);
  openRelayRail(trigger);
}

function renderBar() {
  if (!bar) return;
  const wasHidden = bar.hidden;
  bar.hidden = !state.artistPicking || !pickScope();
  if (bar.hidden) return;
  const count = state.artistPicked.size;
  const focused = bar.contains(document.activeElement) ? document.activeElement.dataset.pickAction : null;
  const copy = button('复制', 'panel-action favorites-action is-primary', () => copyPicked(copy));
  const add = button('加入中转站', 'panel-action favorites-action', () => addPickedToPlan(add));
  const only = button('只看所选', 'panel-action favorites-action', () => setPickOnly(!state.artistPickOnly));
  only.setAttribute('aria-pressed', String(Boolean(state.artistPickOnly)));
  for (const node of [copy, add, only]) {
    node.disabled = !count;
    node.setAttribute('aria-disabled', String(busy || !count));
  }
  const done = button('完成', 'panel-action favorites-action', () => endPicking());
  bar.setAttribute('aria-busy', String(busy));
  bar.replaceChildren(element('strong', '', `已选 ${count} 位`), copy, add, only, done);
  for (const node of bar.querySelectorAll('button')) node.dataset.pickAction = node.textContent;
  document.body.style.setProperty('--artist-pick-bar-height', bar.offsetHeight + 'px');
  if (focused) [...bar.querySelectorAll('button')].find(node => node.dataset.pickAction === focused)?.focus({ preventScroll: true });
  if (wasHidden && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    bar.animate?.([{ opacity: 0, translate: '-50% 12px' }, { opacity: 1, translate: '-50% 0' }], { duration: 180, easing: 'ease-out' });
  }
}

export function setupArtistPick() {
  if (bar) return;
  bar = element('div', 'favorites-batch-bar artist-pick-bar');
  bar.id = 'artistPickBar';
  bar.hidden = true;
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', '多选画师');
  document.body.append(bar);
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.key !== 'Escape' || !state.artistPicking) return;
    if (isGlobalShortcutBlocked(event) || topHistoryLayerId()) return;
    event.preventDefault();
    endPicking();
  });
  window.addEventListener('resize', () => {
    if (bar && !bar.hidden) document.body.style.setProperty('--artist-pick-bar-height', bar.offsetHeight + 'px');
  });
  lean = new URLSearchParams(location.search).get('lean') === '1';
  document.body.classList.toggle('artist-lean', lean);
  // 使用量是原型数据：取到了才出现在排序里。
  void loadArtistUsage().then(() => renderArtistPickControls());
}
