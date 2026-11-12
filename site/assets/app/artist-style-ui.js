/* 画风分类（原型）的界面：结果栏下方的分类导读与排序筛选、词条详情里的「画风」一栏。
   数据与列表逻辑在 artist-style.js；打开词条、切目录、关详情经 setStyleUiActions 注入，避免反向静态依赖。 */

import { state } from './state.js';
import { $, esc } from './utils.js';
import { thumbUrl } from './media.js';
import { createSelectMenu } from './select-menu.js';
import { openSamplePeek, closeArtistPeek } from './artist-strip.js';
import { openRecentEntry } from './history.js';
import {
  STYLE_CODEX_ID, STYLE_ROOT, STYLE_SORTS, STYLE_FILTERS, styleView,
  artistStyles, artistOf, artistByIndex, groupOf, parentOf, groupPath, styleLocation, inStyleView,
  styleFiltersActive, formatPost, recOf, recText, loadNearArtists,
} from './artist-style.js';

const NEAR_COLLAPSED = 10;
const styleUiActions = {
  applyFilter: () => {},
  selectPath: () => {},
  openEntry: () => {},
  closeLightbox: () => {},
};

export function setStyleUiActions(actions = {}) {
  Object.assign(styleUiActions, actions);
}

function styleCodex() {
  return state.codex?.id === STYLE_CODEX_ID ? state.codex : null;
}

function entryById(id) {
  return state.codex?.styleEntryById?.get(id) || null;
}

function repEntry(artist) {
  return artist ? entryById(artist.entryId) : null;
}

function artistName(entry) {
  const match = String(entry?.tags || '').match(/artist:\s*([^,\n]+)/);
  return (match ? match[1] : entry?.title || '').trim();
}

function entryThumb(entry) {
  const codex = styleCodex();
  return entry && codex ? thumbUrl(entry, codex) : '';
}

/* ---------------- 分类导读与排序筛选 ---------------- */

let sortMenu = null;
const filterMenus = new Map();

function controlsNode(where) {
  if (!sortMenu) {
    sortMenu = createSelectMenu({
      label: '排序', className: 'style-select is-pill',
      onChange: value => { styleView.sort = value; styleUiActions.applyFilter({ resetScroll: true }); },
    });
  }
  sortMenu.setOptions(STYLE_SORTS.map(option => ({
    ...option, disabled: option.value === 'near' && where.level === 'root',
  })));
  if (styleView.sort === 'near' && where.level === 'root') styleView.sort = 'post';
  sortMenu.setValue(styleView.sort);
  const row = document.createElement('div');
  row.className = 'style-controls';
  row.append(sortMenu.element);
  for (const filter of STYLE_FILTERS) {
    let menu = filterMenus.get(filter.key);
    if (!menu) {
      menu = createSelectMenu({
        label: filter.label, className: 'style-select is-pill',
        options: [{ value: '', label: filter.label }, ...filter.options.map(([value, label]) => ({
          value, label: filter.key === 'rec' ? `辨识度${label}` : label,
        }))],
        onChange: value => { styleView[filter.key] = value; styleUiActions.applyFilter({ resetScroll: true }); },
      });
      filterMenus.set(filter.key, menu);
    }
    menu.setValue(styleView[filter.key]);
    menu.element.classList.toggle('is-active', styleView[filter.key] !== '');
    row.append(menu.element);
  }
  if (styleFiltersActive()) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'bar-btn style-clear';
    clear.textContent = '清除筛选';
    clear.onclick = () => {
      for (const filter of STYLE_FILTERS) styleView[filter.key] = '';
      styleUiActions.applyFilter({ resetScroll: true });
    };
    row.append(clear);
  }
  return row;
}

function miniHtml(artists) {
  const cells = artists.slice(0, 4).map(artist => {
    const src = entryThumb(repEntry(artist));
    return src ? `<img loading="lazy" decoding="async" src="${esc(src)}" alt="">` : '<span></span>';
  });
  while (cells.length < 4) cells.push('<span></span>');
  return `<span class="style-mini" aria-hidden="true">${cells.join('')}</span>`;
}

function tileHtml({ path, name, size, desc, tags = [], artists, current = false }) {
  return `<button type="button" class="style-tile ui-press${current ? ' is-current' : ''}" data-style-path="${esc(path.join('\u0001'))}"${current ? ' aria-current="true"' : ''}>
    ${miniHtml(artists)}
    <span class="style-tile-text">
      <span class="style-tile-name">${esc(name)}<small>${size.toLocaleString('en-US')} 位</small></span>
      ${tags.length ? `<span class="style-tile-tags">${tags.map(esc).join(' · ')}</span>` : ''}
      <span class="style-tile-desc">${esc(desc || '')}</span>
    </span>
  </button>`;
}

function parentTiles(data) {
  return data.parents.map(parent => {
    // 缩略图从各小组的代表画师里轮流取，凑满四格；只有两三个小组的大类也不留空格
    const pools = parent.groups.map(g => data.groups[g].reps);
    const picks = [];
    for (let round = 0; picks.length < 4 && round < 4; round += 1) {
      for (const pool of pools) if (picks.length < 4 && pool[round] != null) picks.push(pool[round]);
    }
    return tileHtml({
      path: [STYLE_ROOT, parent.name], name: parent.name, size: parent.size, desc: parent.desc,
      artists: picks.map(artistByIndex).filter(Boolean),
    });
  }).join('');
}

function groupTiles(data, parent, currentGroup = null) {
  return parent.groups.map(g => {
    const group = data.groups[g];
    return tileHtml({
      path: groupPath(g), name: group.name, size: group.size, desc: group.desc, tags: group.tags,
      artists: group.reps.map(artistByIndex).filter(Boolean), current: currentGroup?.index === g,
    });
  }).join('');
}

export function renderStyleIntro() {
  const box = $('#styleIntro');
  if (!box) return;
  const data = artistStyles();
  const where = data && inStyleView() && !state.searchPlan?.hasActiveSearch ? styleLocation() : null;
  if (!where) {
    box.hidden = true;
    box.replaceChildren();
    delete box.dataset.key;
    return;
  }
  const key = state.activePath.join('\u0001');
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    let html = '';
    if (where.level === 'root') {
      html = `<div class="style-tiles is-parents">${parentTiles(data)}</div>`;
    } else if (where.level === 'parent') {
      html = `<p class="style-desc">${esc(where.parent.desc || '')}</p>
        <div class="style-tiles">${groupTiles(data, where.parent)}</div>`;
    } else {
      const g = where.group;
      const famous = (g.famous || []).map(artistByIndex).filter(Boolean)
        .map(artist => `<button type="button" class="style-famous ui-press" data-style-entry="${esc(artist.entryId)}">${esc(artistName(repEntry(artist)))}</button>`);
      html = `<p class="style-desc">${esc(g.desc || '')}</p>
        <div class="style-facts">
          ${g.tags?.length ? `<span class="style-tags" title="这一组和全部画师相比明显偏离的实测项">${g.tags.map(tag => `<span>${esc(tag)}</span>`).join('')}</span>` : ''}
          ${famous.length ? `<span class="style-famous-list"><span class="style-famous-label">代表画师</span>${famous.join('')}</span>` : ''}
        </div>
        <div class="style-tiles is-siblings">${groupTiles(data, where.parent, g)}</div>`;
    }
    box.innerHTML = html;
  }
  box.querySelector('.style-controls')?.remove();
  box.append(controlsNode(where));
  box.hidden = false;
}

export function bindStyleIntro() {
  $('#styleIntro')?.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    const tile = target?.closest('[data-style-path]');
    if (tile) {
      if (tile.classList.contains('is-current')) return;
      styleUiActions.selectPath(tile.dataset.stylePath.split('\u0001'));
      return;
    }
    const famous = target?.closest('[data-style-entry]');
    if (famous) styleUiActions.openEntry(famous.dataset.styleEntry);
  });
}

/* ---------------- 词条详情里的「画风」一栏 ---------------- */

let sectionSeq = 0;
let nearExpanded = false;
let sectionArtist = -1;

function tileButton({ key, src, name, label, badge = '', onPeek }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'artist-tile ui-press';
  button.dataset.peekKey = key;
  button.title = label;
  button.setAttribute('aria-pressed', 'false');
  const frame = document.createElement('span');
  frame.className = 'artist-tile-img';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = '';
  if (src) img.src = src;
  frame.append(img);
  if (badge) {
    const mark = document.createElement('span');
    mark.className = 'artist-tile-ver';
    mark.textContent = badge;
    frame.append(mark);
  }
  const text = document.createElement('span');
  text.className = 'artist-tile-name';
  text.textContent = name;
  button.append(frame, text);
  button.onclick = event => {
    event.stopPropagation();
    if (button.getAttribute('aria-pressed') === 'true') closeArtistPeek();
    else onPeek();
  };
  return button;
}

function recSentence(artist) {
  if (artist.rank == null) return '识别模型的名单里没有这位';
  if (artist.rank === 1) return '识别模型认得出是这位';
  return `识别模型认作 ${artist.seenAs || '其他画师'}，这位排第 ${artist.rank}`;
}

function openStyleEntry(entry, path) {
  closeArtistPeek();
  openRecentEntry({ codexId: STYLE_CODEX_ID, entryId: entry.id, path }, { historyMode: 'push' });
}

function otherTiles(entry, artist) {
  const ids = [artist.entryId, ...artist.otherIds].filter(id => id !== entry.id);
  return ids.map(entryById).filter(Boolean).map(other => {
    const source = other.path?.[1] || '';
    return tileButton({
      key: `style-other:${other.id}`, src: entryThumb(other), name: source, label: other.path?.join(' › ') || '',
      onPeek: () => openSamplePeek({
        key: `style-other:${other.id}`, src: entryThumb(other), name: other.title, source: other.path?.join(' › ') || '',
        onOpen: () => openStyleEntry(other, other.path),
      }),
    });
  });
}

function nearTiles(indexes) {
  return indexes.map(artistByIndex).filter(Boolean).map(near => {
    const rep = repEntry(near);
    if (!rep) return null;
    const name = artistName(rep);
    const group = groupOf(near);
    return tileButton({
      key: `style-near:${near.index}`, src: entryThumb(rep), name, label: `artist:${name}`,
      onPeek: () => openSamplePeek({
        key: `style-near:${near.index}`, src: entryThumb(rep), name: `artist:${name}`,
        source: `${group.name} · ${formatPost(near.post)} · 辨识度${recText(near.rank)}`,
        onOpen: () => openStyleEntry(rep, rep.stylePath || rep.path),
      }),
    });
  }).filter(Boolean);
}

function paintNear(list, indexes) {
  const folded = !nearExpanded && indexes.length > NEAR_COLLAPSED;
  const shown = folded ? indexes.slice(0, NEAR_COLLAPSED - 1) : indexes;
  const nodes = nearTiles(shown);
  if (indexes.length > NEAR_COLLAPSED) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'artist-tile artist-tile-more ui-press';
    more.textContent = folded ? `+${indexes.length - shown.length}` : '收起';
    if (folded) more.setAttribute('aria-label', `展开全部 ${indexes.length} 位`);
    more.onclick = event => {
      event.stopPropagation();
      nearExpanded = !nearExpanded;
      paintNear(list, indexes);
    };
    nodes.push(more);
  }
  list.replaceChildren(...nodes);
}

export function renderStyleSection(entry) {
  const block = $('#styleBlock');
  if (!block) return;
  const seq = ++sectionSeq;
  const artist = artistOf(entry);
  if (!artist) {
    block.hidden = true;
    sectionArtist = -1;
    return;
  }
  if (artist.index !== sectionArtist) nearExpanded = false;
  sectionArtist = artist.index;
  const group = groupOf(artist);
  const parent = parentOf(group);
  const rec = recOf(artist.rank);
  block.innerHTML = `
    <div class="section-head">
      <div class="section-label">画风</div>
      <span class="style-path">
        <button type="button" class="style-path-link ui-press" data-style-path="${esc([STYLE_ROOT, parent.name].join('\u0001'))}">${esc(parent.name)}</button>
        <span aria-hidden="true">›</span>
        <button type="button" class="style-path-link ui-press" data-style-path="${esc(groupPath(group.index).join('\u0001'))}">${esc(group.name)}</button>
      </span>
    </div>
    <dl class="style-stats">
      <dt>post 数</dt><dd>${artist.post == null ? '未知' : artist.post.toLocaleString('en-US')}</dd>
      <dt title="画师识别模型看例图认不认得出是这位画师：排第 1 为高，第 2–10 为中，10 名以外为低">辨识度</dt>
      <dd><span class="style-rec is-${rec}">${recText(artist.rank)}</span> · ${esc(recSentence(artist))}</dd>
      ${artist.weights ? `<dt>常用权重</dt><dd>${artist.weights.median} · 画风串里出现 ${artist.weights.count} 次</dd>` : ''}
    </dl>
    <div class="style-sub" data-style-other hidden><div class="style-sub-label">其它来源的例图</div><div class="artist-strip"></div></div>
    <div class="style-sub" data-style-near hidden><div class="style-sub-label">画风接近</div><div class="artist-strip"></div></div>`;
  block.hidden = false;
  const others = otherTiles(entry, artist);
  const otherBox = block.querySelector('[data-style-other]');
  if (others.length) {
    otherBox.querySelector('.artist-strip').replaceChildren(...others);
    otherBox.hidden = false;
  }
  loadNearArtists(artist.index).then(indexes => {
    if (seq !== sectionSeq || !indexes.length) return;
    const box = block.querySelector('[data-style-near]');
    if (!box) return;
    box.querySelector('.style-sub-label').textContent = `画风接近 ${indexes.length} 位`;
    paintNear(box.querySelector('.artist-strip'), indexes);
    box.hidden = false;
  });
}

export function resetStyleSection() {
  sectionSeq += 1;
  sectionArtist = -1;
  nearExpanded = false;
}

export function bindStyleSection() {
  $('#styleBlock')?.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('.style-path-link') : null;
    if (!link) return;
    event.stopPropagation();
    const path = link.dataset.stylePath.split('\u0001');
    styleUiActions.closeLightbox();
    window.setTimeout(() => styleUiActions.selectPath(path), 0);
  });
}
