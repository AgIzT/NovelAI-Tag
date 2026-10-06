import { state } from './state.js';
import { esc, samePath } from './utils.js';
import { isEntryAccessBlocked } from './access.js';
import { codexUpdateFilters } from './data.js';
import { createBannerInsertChooser, findCoverCaption, matchingCoverPalette, eligibleBannerInserts } from './banner-insert-core.js';

let sessionStorageRef = null;
try { sessionStorageRef = window.sessionStorage; } catch {}
const choose = createBannerInsertChooser({ storage: sessionStorageRef });
const requests = new WeakMap();

/* 等词条与派生索引就绪后才抽选；待接力封面落定，CSS 才放行滑出动画。
   异步工作只认本次节点与法典身份，旧书返回的数据不能覆盖新书。 */
export async function renderBannerInsert(banner, codex, actions) {
  const slot = banner.querySelector('.banner-insert');
  if (!slot || !codex?.entries) return;
  const request = {};
  requests.set(slot, request);
  try { await actions.loadUpdates(); } catch {}
  if (!slot.isConnected || requests.get(slot) !== request || banner.dataset.identity !== codex.id
    || state.codex?.id !== codex.id || state.favoritesView || state.siteSearchView) return;

  let caption = findCoverCaption(codex);
  if (caption && (isEntryAccessBlocked(caption.entry, codex)
    || actions.isContentBlocked({ ...caption.entry, _srcCodexId: codex.id }))) caption = null;
  const palette = actions.bookPalette(codex.id);
  let colors = matchingCoverPalette(codex, palette);
  // 独立封面没有词条时仍可取色；能匹配词条的封面沿用其分级与个人屏蔽。
  if ((palette?.nsfw && !state.allowNsfw) || (findCoverCaption(codex) && !caption)) colors = [];
  const history = codexUpdateFilters(codex);
  const groups = actions.groups();
  const variant = choose(codex.id, eligibleBannerInserts({ caption, history, colors, groups }));
  slot.dataset.variant = variant;
  if (!variant) { slot.replaceChildren(); return; }
  const models = { caption, history, colors, groups };
  slot.innerHTML = templates[variant](models);
  slot.onclick = event => {
    const button = event.target.closest('button');
    if (!button || !slot.contains(button) || state.codex?.id !== codex.id) return;
    if (button.dataset.insertAction === 'caption') {
      if (caption && !isEntryAccessBlocked(caption.entry, codex)
        && !actions.isContentBlocked({ ...caption.entry, _srcCodexId: codex.id })) {
        actions.openCaption(caption.entry, caption.imageIndex);
      }
    } else if (button.dataset.insertAction === 'history') {
      actions.selectUpdate(button.dataset.filter || history[0].id);
    } else if (button.dataset.insertAction === 'directory') {
      actions.openDirectory(button);
    } else if (button.dataset.group != null) {
      actions.selectPath(groups[Number(button.dataset.group)].path);
    }
    syncBannerInsertState(banner);
  };
  syncBannerInsertState(banner);
}

const rowNo = index => String(index + 1).padStart(2, '0');
const foldedTab = (label, action, ariaLabel) => `<button type="button" class="bi-tab" data-insert-action="${action}" aria-label="${esc(ariaLabel)}">${label}</button>`;

const templates = {
  caption: ({ caption: { entry } }) => {
    const source = (entry.path || []).slice(-2).join(' / ');
    const prompt = String(entry.tags || '').trim().slice(0, 180);
    return `<div class="bi-sheet bi-caption"><div class="bi-content">
      <span class="bi-heading">封面题注 <span>01</span></span>
      <strong class="bi-caption-title">${esc(entry.title)}</strong>
      <span class="bi-caption-source">${esc(source)}</span>
      ${prompt ? `<span class="bi-caption-prompt">${esc(prompt)}</span>` : ''}
      <button type="button" class="bi-link" data-insert-action="caption">查看封面词条 <span aria-hidden="true">↗</span></button>
    </div>${foldedTab('题注', 'caption', `查看封面词条：${entry.title}`)}</div>`;
  },
  history: ({ history }) => `<div class="bi-sheet bi-history"><div class="bi-content">
    <span class="bi-heading">更新史 <span>${String(history.length).padStart(2, '0')} 期</span></span>
    <div class="bi-history-rows">${history.slice(0, 3).map((batch, i) => `<button type="button" class="bi-row bi-history-row" style="--row:${i}" data-insert-action="history" data-filter="${esc(batch.id)}" aria-pressed="false">
      <i class="bi-history-dot" aria-hidden="true"></i><span class="bi-name">${esc(batch.label)}</span><span class="bi-history-bar" style="--amount:${Math.max(6, Math.round(batch.count / Math.max(...history.map(item => item.count)) * 100))}%" aria-hidden="true"></span><b>+${batch.count}</b>
    </button>`).join('')}</div>
    <span class="bi-foot">最近三期 · 点击筛选</span>
  </div>${foldedTab('更新', 'history', `筛选${history[0].label}`)}</div>`,
  palette: ({ colors }) => `<div class="bi-bookmarks" role="img" aria-label="封面配色书签">${colors.map((color, i) => `<span class="bi-bookmark" style="--bookmark:${i};--swatch:${color}"><i aria-hidden="true">${rowNo(i)}</i></span>`).join('')}<span class="bi-palette-label">封面配色</span></div>`,
  index: ({ groups }) => {
    const ranked = groups.map((group, i) => ({ ...group, i })).sort((a, b) => b.count - a.count).slice(0, 3);
    return `<nav class="bi-sheet bi-index" aria-label="卷内目录"><div class="bi-content">
      <span class="bi-heading">卷内目录 <span>INDEX</span></span>
      <div class="bi-index-rows">${ranked.map((group, i) => `<button type="button" class="bi-row" style="--row:${i}" data-group="${group.i}" data-path="${esc(group.path.join('\u0001'))}" title="${esc(group.name)} · ${group.count} 条">
        <span class="bi-no">${rowNo(group.i)}</span><span class="bi-name">${esc(group.name)}</span><span class="bi-dots" aria-hidden="true"></span><span class="bi-count">${group.count}</span>
      </button>`).join('')}</div>
      <span class="bi-tape" aria-hidden="true">${groups.map(group => `<i style="flex:${group.count};--ink:${group.color}"></i>`).join('')}</span>
      <div class="bi-foot"><span>${groups.length} 类</span><button type="button" class="bi-link" data-insert-action="directory">全部目录 <span aria-hidden="true">↗</span></button></div>
    </div>${foldedTab('目录', 'directory', '打开卷内目录')}</nav>`;
  },
};

/* 筛选只更新选中态，不重放入场；按钮与主分类轨 / 更新胶囊保持同一状态。 */
export function syncBannerInsertState(banner = document.querySelector('#codexBanner')) {
  banner?.querySelectorAll('.bi-row[data-path]').forEach(row => {
    const active = !state.searchPlan?.hasActiveSearch && samePath((row.dataset.path || '').split('\u0001'), state.activePath.slice(0, 1));
    row.classList.toggle('is-active', active);
    if (active) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  });
  banner?.querySelectorAll('.bi-history-row').forEach(row => {
    row.setAttribute('aria-pressed', String(state.updateFilter === row.dataset.filter));
  });
}
