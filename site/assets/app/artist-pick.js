/* 挑画师：侧栏「单画师词典」下面的分法开关（画风 / post），以及画师墙上的多选、底部操作条与「只看所选」。
   这面墙怎么排一直由侧栏目录决定，所以排序不做成结果栏里的开关，而是目录的另一种分法：换分法时目录和墙一起换。
   不另存一份名单：复制照常进中转站素材，加入方案交给中转站，调权重也在那边。
   多选按画师身份记（同一位换了例图来源仍是同一位），只存在本页内存里。
   分法和列表逻辑在 artist-style.js，这里只管界面；换分法、刷新列表经 setArtistPickActions 注入，不反向依赖 app.js。 */

import { state } from './state.js';
import { toast } from './feedback.js';
import { isGlobalShortcutBlocked } from './modal.js';
import { topHistoryLayerId } from './browser-history.js';
import { isEntryAccessBlocked } from './access.js';
import { copyText, entryPromptText } from './copy.js';
import { prepareCopiedEntry, recordCopiedEntry } from './tag-relay-store.js';
import { snapshotLocked } from './tag-relay-snapshot.js';
import { openRelayRail } from './tag-relay-rail.js';
import { animateUi, setRollingNumber } from './ui-motion.js';
import {
  ARTIST_DIVISIONS, SINGLE_ROOT, artistDivision, artistOf, styleActive, styleBookEntry,
} from './artist-style.js';

const actions = {
  applyFilter: () => {},
  changeDivision: () => {},
};

export function setArtistPickActions(next = {}) {
  Object.assign(actions, next);
}

const DIVISION_LABELS = { style: '画风', post: 'post' };

let controls = null;     // { root, toggle, only }
let bar = null;
let busy = false;
let unsaved = false;     // 勾选变过、还没复制或加入方案；退出多选时据此给「恢复」

/* bookScope：这本书的普通浏览（分法开关、精简卡片都跟它）；pickScope 再去掉手机——手机上暂时不出多选。 */
const PHONE = '(max-width: 600px)';
const onPhone = () => Boolean(globalThis.matchMedia?.(PHONE).matches);
const bookScope = () => styleActive() && !state.favoritesView && !state.siteSearchView;
const pickScope = () => bookScope() && !onPhone();
const inSingleArtistSection = entry => entry?.path?.[0] === SINGLE_ROOT && bookScope();
const artistCard = entry => (inSingleArtistSection(entry) ? artistOf(entry) : null);

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

/* ---------- 卡片 ----------
   卡片上平时什么都不加。选中的卡片描一圈强调色，图片左上角的徽章列里多一枚序号（复制就按这个顺序）。 */

const cardSemantics = new WeakMap();   // 多选期间卡片临时当复选框用，退出后还原

function syncCard(card, order) {
  const position = order.get(Number(card.dataset.artistPick));
  const on = position != null;
  card.classList.toggle('is-artist-picked', on);
  const badge = card.querySelector('.badge-pick');
  if (badge) {
    badge.hidden = !on;
    badge.textContent = on ? String(position + 1) : '';
  }
  if (state.artistPicking && card.dataset.artistPick != null) {
    if (!cardSemantics.has(card)) {
      cardSemantics.set(card, ['role', 'tabindex', 'aria-checked'].map(name => [name, card.getAttribute(name)]));
    }
    card.setAttribute('role', 'checkbox');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-checked', String(on));
  } else if (cardSemantics.has(card)) {
    for (const [name, value] of cardSemantics.get(card)) {
      if (value === null) card.removeAttribute(name);
      else card.setAttribute(name, value);
    }
    cardSemantics.delete(card);
  }
}

const pickOrder = () => new Map([...state.artistPicked.keys()].map((index, position) => [index, position]));

function syncCards() {
  document.body.classList.toggle('artist-picking', Boolean(state.artistPicking));
  const order = pickOrder();
  for (const card of document.querySelectorAll('[data-artist-pick]')) syncCard(card, order);
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

/* 多选中点卡片就是勾选；没进多选时按住 Ctrl / ⌘ 点卡片，直接从这一张开始。放大镜和重试照常。 */
function handleCardClick(event) {
  if (!pickScope()) return;
  const inner = event.target.closest?.('button, a');
  if (!state.artistPicking) {
    if (!(event.ctrlKey || event.metaKey) || inner) return;
  } else if (inner?.matches('.zoom-btn, .img-retry')) return;
  const entry = event.currentTarget._entry;
  const artist = artistCard(entry);
  if (!artist) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  togglePick(entry, artist);
}

function handleCardKeydown(event) {
  const card = event.currentTarget;
  if (!state.artistPicking || event.target !== card || event.repeat || !pickScope()) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const entry = card._entry;
  const artist = artistCard(entry);
  if (!artist) return;
  event.preventDefault();
  togglePick(entry, artist);
}

/* 新建卡片和开场包接管都调用。复用时按当前词条更新，多选事件只绑定一次。 */
export function decorateArtistPickCard(card, entry) {
  const artist = artistCard(entry);
  card.classList.toggle('artist-pick-card', Boolean(artist));
  if (!artist || onPhone()) {
    if (card.dataset.artistPick == null) return;
    delete card.dataset.artistPick;
    card.querySelector('.badge-pick')?.remove();
    card.removeEventListener('click', handleCardClick, true);
    card.removeEventListener('keydown', handleCardKeydown);
    syncCard(card, pickOrder());
    return;
  }
  if (card.dataset.artistPick == null) {
    const badge = element('span', 'badge-pick');
    badge.hidden = true;
    card.querySelector('.card-badges')?.prepend(badge);
    card.addEventListener('click', handleCardClick, true);
    card.addEventListener('keydown', handleCardKeydown);
  }
  card.dataset.artistPick = String(artist.index);
  syncCard(card, pickOrder());
}

/* 单画师卡的标题已经是画师名，提示词行不再重复一遍；瀑布流估高、测高与样式用同一判断。 */
export function leanArtistCard(entry) {
  if (!inSingleArtistSection(entry)) return false;
  // 开场包只给已识别的画师卡标记 styleRep，画风索引随后才到。
  return state.codex._openingStyle ? entry.styleRep === true : Boolean(artistOf(entry));
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

/* ---------- 侧栏：分法开关 ---------- */

/* renderTree 每次重画目录后调：在「单画师词典」那一项的子目录最前面放一排「按 画风 / post」。
   目录是这面墙的目录，所以换分法的开关放在它要换的那段目录上，不放结果栏。 */
export function renderArtistDivisionSwitch(nav) {
  if (!nav || !bookScope()) return;
  const row = [...nav.querySelectorAll(':scope > .tree-item > .tree-row')].find(node => node.dataset.path === SINGLE_ROOT);
  const kids = row?.parentElement?.querySelector(':scope > .tree-children');
  if (!kids) return;
  const current = artistDivision(state.codex);
  const line = element('div', 'tree-division');
  line.setAttribute('role', 'group');
  line.setAttribute('aria-label', '单画师词典的分法');
  line.append(element('span', 'tree-division-label', '按'));
  for (const mode of ARTIST_DIVISIONS) {
    const node = button(DIVISION_LABELS[mode], 'tree-division-btn', event => {
      event.stopPropagation();
      if (mode === artistDivision(state.codex)) return;
      actions.changeDivision(mode);
      // 目录整个重画了，把焦点还给同一枚按钮
      const selected = nav.querySelector(`.tree-division-btn[data-division="${mode}"][aria-pressed="true"]`);
      if (!selected) return;
      selected.focus({ preventScroll: true });
      // 只动换出的分类文字和计数，目录行仍可用于定位与点击。
      const rows = selected.closest('.tree-children').querySelectorAll(':scope > .tree-item > .tree-row');
      rows.forEach((row, index) => {
        const duration = 180 + Math.min(index, 8) * 12;
        row.querySelectorAll('.tw-name, .tw-count').forEach(label => animateUi(label, [
          { opacity: .3, translate: '-5px 0' },
          { opacity: 1, translate: '0 0' },
        ], { duration }));
      });
    });
    node.dataset.division = mode;
    node.setAttribute('aria-pressed', String(mode === current));
    line.append(node);
  }
  kids.prepend(line);
}

/* ---------- 结果栏里的控件 ---------- */

function buildControls(root) {
  const toggle = button('多选', 'bar-btn artist-pick-toggle', () => (state.artistPicking ? endPicking() : beginPicking()));
  toggle.title = '按住 Ctrl 或 ⌘ 点卡片，也能从那一张开始多选';
  const only = button('', 'bar-btn update-filter-btn artist-pick-only', () => setPickOnly(false));
  only.setAttribute('aria-pressed', 'true');
  root.replaceChildren(toggle, only);
  return { root, toggle, only };
}

/* updateResultBar 每次都调：这本书的墙上有画师卡（全部、单画师各层、书内搜索），就给「多选」。 */
export function renderArtistPickControls() {
  const root = document.getElementById('artistPickControls');
  if (!root) return;
  if (!pickScope()) {
    if (state.artistPicking || state.artistPicked.size) endPicking({ silent: true });
    root.hidden = true;
    return;
  }
  root.hidden = false;
  if (!controls || controls.root !== root) controls = buildControls(root);
  const only = state.artistPickOnly && state.artistPicked.size > 0;
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

/* 操作条上一次显示的已选人数：数字变了才滚动 */
let shownPickCount = null;

function renderBar() {
  if (!bar) return;
  const wasHidden = bar.hidden;
  bar.hidden = !state.artistPicking || !pickScope();
  if (bar.hidden) { shownPickCount = null; return; }
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
  const summary = element('strong', '', count ? '' : '点卡片选画师');
  if (count) {
    const number = document.createElement('span');
    setRollingNumber(number, count, shownPickCount);
    summary.append('已选 ', number, ' 位');
  }
  shownPickCount = count || null;
  bar.replaceChildren(summary, copy, add, only, done);
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
  // 窗口缩到手机宽度时收起多选；放宽后结果栏的入口随下一次刷新回来。
  globalThis.matchMedia?.(PHONE).addEventListener?.('change', () => renderArtistPickControls());
}
