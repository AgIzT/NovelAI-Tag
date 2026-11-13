/* 单画师按画风重排（原型）的画师详情：单画师词条打开时，词条详情的信息栏改按画师排（#lightbox.is-artist）。
   浏览页不另加界面：目录、结果栏、卡片都是站里原有的，分类只体现在侧栏目录和卡片顺序上。
   数据与列表逻辑在 artist-style.js；切目录、打开词条、关详情经 setStyleUiActions 注入（app.js 提供），不反向静态依赖 codex-ui / lightbox。 */

import { state } from './state.js';
import { $, esc } from './utils.js';
import { thumbUrl, assetUrl } from './media.js';
import { fetchCodex, findCodexMeta } from './data.js';
import { fetchDataJson } from '../data-source.js';
import { openRecentEntry } from './history.js';
import { isContentBlocked } from './content-blocking.js';
import { isEntryAccessBlocked } from './access.js';
import { artistKey, formatArtistWeight } from './artist-core.js';
import {
  STYLE_CODEX_ID, SINGLE_ROOT,
  artistOf, artistByIndex, groupOf, parentOf, groupPath, artistNameOf,
  formatCount, recOf, recText, loadNearArtists, specimensOf, specimenSource,
  attachArtistStyles, mayHaveStyle, styleActive, styleBookCodex, styleBookEntry, stylePathText,
} from './artist-style.js';

const STRIP_COLLAPSED = 10;
const PATH_SEP = '\u0001';
const styleUiActions = {
  selectPath: () => {},
  openLightbox: () => {},
  closeLightbox: () => {},
};

export function setStyleUiActions(actions = {}) {
  Object.assign(styleUiActions, actions);
}

/* ---------------- 共用 ---------------- */

function entryThumb(entry) {
  const book = styleBookCodex();
  return entry && book ? thumbUrl(entry, book) : '';
}

function repEntry(artist) {
  return artist ? styleBookEntry(artist.entryId) : null;
}

function showable(entry) {
  return Boolean(entry) && !isEntryAccessBlocked(entry) && !isContentBlocked(entry);
}

let bookLoad = null;
/* 从收藏、全站搜索或别的书打开 v5 画师词条时，画风数据可能还没挂上：先挂上那本书 */
function ensureStyleBook() {
  if (styleBookCodex()) return Promise.resolve(true);
  const meta = findCodexMeta(STYLE_CODEX_ID);
  if (!meta) return Promise.resolve(false);
  bookLoad ??= fetchCodex(meta)
    .then(codex => attachArtistStyles(codex))
    .catch(() => false)
    .finally(() => { bookLoad = null; });
  return bookLoad;
}

export function bindArtistStyleUi() {
  $('#artistProfile')?.addEventListener('click', onProfileClick);
}

/* ---------------- 画风串反查（artist_strings.json，随数据发布） ---------------- */

let stringsIndex;      // undefined = 没加载；null = 不可用
let stringsLoad = null;

/* 画风串表里的画师名与词条里的画师名用同一套归一（artistKey 只认带 artist: 前缀的写法） */
function nameKey(name) {
  return name ? artistKey(`artist:${name}`) : '';
}

function loadStringsIndex() {
  if (stringsIndex !== undefined) return Promise.resolve(stringsIndex);
  stringsLoad ??= fetchDataJson('artist_strings.json')
    .then(raw => {
      const info = raw?.schema === 1 ? raw.versions?.n5 : null;
      if (!info || !Array.isArray(info.strings)) return null;
      const books = Array.isArray(info.books) ? info.books : [];
      const names = Array.isArray(info.artists) ? info.artists : [];
      const byArtist = new Map();
      info.strings.forEach((record, index) => {
        if (!Array.isArray(record) || !Array.isArray(record[0])) return;
        const [members, bookIndex, entryId, image, assetRev, assetCodexId, images] = record;
        const rep = typeof books[bookIndex] === 'string' && typeof entryId === 'string' && entryId
          ? { codexId: books[bookIndex], entryId, image: image || `${entryId}.jpg`, assetRev: assetRev || '', assetCodexId: assetCodexId || '', images: Number(images) || 1 }
          : null;
        for (const member of members) {
          const [artistIndex, weight] = Array.isArray(member) ? member : [member, 1];
          const key = nameKey(names[artistIndex]);
          if (!key) continue;
          if (!byArtist.has(key)) byArtist.set(key, []);
          byArtist.get(key).push({ index, weight: Number(weight) || 1, rep, size: members.length });
        }
      });
      return byArtist;
    })
    .catch(() => null)
    .then(result => {
      stringsIndex = result;
      return result;
    });
  return stringsLoad;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) * 50) / 100;
}

function stringThumb(rep) {
  const meta = findCodexMeta(rep.codexId);
  return meta ? assetUrl('image', { image: rep.image, assetCodexId: rep.assetCodexId, assetRev: rep.assetRev }, meta) : '';
}

/* ---------------- 画师详情（词条详情的画师版式） ---------------- */

let profileSeq = 0;
let profileArtist = -1;
const expanded = { near: false, strings: false };
let profileTiles = new Map();   // data-key → 点击动作

function recSentence(artist) {
  if (artist.rank == null) return '识别模型的名单里没有这位';
  if (artist.rank === 1) return '识别模型认得出是这位';
  return `识别模型认作 ${artist.seenAs || '其他画师'}，这位排第 ${artist.rank}`;
}

function tile({ key, src, caption, badge = '', pressed = false, onOpen }) {
  profileTiles.set(key, onOpen);
  return `<button type="button" class="artist-tile ui-press" data-ap-key="${esc(key)}" aria-pressed="${pressed ? 'true' : 'false'}" title="${esc(caption)}">
    <span class="artist-tile-img">${src ? `<img loading="lazy" decoding="async" src="${esc(src)}" alt="">` : ''}${badge ? `<span class="artist-tile-weight${badge.startsWith('×0') ? ' is-down' : ''}">${esc(badge)}</span>` : ''}</span>
    <span class="artist-tile-name">${esc(caption)}</span>
  </button>`;
}

function stripHtml(key, items) {
  const folded = !expanded[key] && items.length > STRIP_COLLAPSED;
  const shown = folded ? items.slice(0, STRIP_COLLAPSED - 1) : items;
  const more = items.length > STRIP_COLLAPSED
    ? `<button type="button" class="artist-tile artist-tile-more ui-press" data-ap-more="${key}"${folded ? ` aria-label="展开全部 ${items.length} 项"` : ''}>${folded ? `+${items.length - shown.length}` : '收起'}</button>`
    : '';
  return `<div class="artist-strip">${shown.join('')}${more}</div>`;
}

function openInPlace(entry, historyMode) {
  styleUiActions.openLightbox(entry, 0, null, { historyMode });
}

function specimensHtml(entry, artist) {
  const specimens = specimensOf(artist).filter(showable);
  if (specimens.length < 2) return '';
  const items = specimens.map(item => tile({
    key: `specimen:${item.id}`,
    src: entryThumb(item),
    caption: specimenSource(item) || item.title,
    pressed: item.id === entry.id,
    onOpen: () => { if (item.id !== entry.id) openInPlace(item, 'replace'); },
  }));
  return `<div class="lightbox-section ap-section"><div class="section-head"><div class="section-label">例图 <span class="artist-strip-count">${items.length}</span></div></div>${stripHtml('specimens', items)}</div>`;
}

function stylePathHtml(group, parent) {
  return `<span class="ap-path">
    <button type="button" class="ap-link ui-press" data-ap-path="${esc([SINGLE_ROOT, parent.name].join(PATH_SEP))}">${esc(parent.name)}</button>
    <span class="ap-sep" aria-hidden="true">›</span>
    <button type="button" class="ap-link ui-press" data-ap-path="${esc(groupPath(group.index).join(PATH_SEP))}">${esc(group.name)}</button>
  </span>`;
}

/* weight：undefined = 画风串表还在加载；null = 没出现在画风串里 */
function weightStatHtml(weight) {
  const value = weight === undefined ? '…' : weight ? String(Number(weight.median.toFixed(2))) : '—';
  const note = weight === undefined ? '' : weight ? `${formatCount(weight.count)} 条画风串的中位数` : '没出现在画风串里';
  return `<div class="ap-stat" data-ap-weight><dt>常用权重</dt><dd>${esc(value)}</dd><small>${esc(note)}</small></div>`;
}

function statsHtml(artist, weight) {
  const rec = recOf(artist.rank);
  return `<dl class="ap-stats">
    <div class="ap-stat"><dt>post 数</dt><dd>${artist.post == null ? '—' : formatCount(artist.post)}</dd><small>Danbooru 作品数</small></div>
    <div class="ap-stat"><dt>辨识度</dt><dd class="ap-rec is-${rec}">${esc(recText(artist.rank))}</dd><small>${esc(recSentence(artist))}</small></div>
    ${weightStatHtml(weight)}
  </dl>`;
}

function weightOf(list) {
  return list.length ? { median: median(list.map(item => item.weight)), count: list.length } : null;
}

function paintNear(box, indexes) {
  const items = indexes.map(artistByIndex).map(near => {
    const rep = repEntry(near);
    if (!showable(rep)) return '';
    const name = artistNameOf(rep);
    return tile({
      key: `near:${near.index}`, src: entryThumb(rep), caption: name,
      onOpen: () => openInPlace(rep, 'push'),
    });
  }).filter(Boolean);
  box.innerHTML = items.length
    ? `<div class="section-head"><div class="section-label">画风接近 <span class="artist-strip-count">${items.length}</span></div></div>${stripHtml('near', items)}`
    : '';
  box.hidden = !items.length;
}

function paintStrings(box, list) {
  // 串表的代表图只取常规级有图词条（build_artist_index.py），没有代表图的串不列图
  const shown = list.filter(item => item.rep).sort((a, b) => b.rep.images - a.rep.images || a.size - b.size);
  const items = shown.map(item => {
    const own = item.rep.codexId === STYLE_CODEX_ID ? styleBookEntry(item.rep.entryId) : null;
    const caption = own?.title || findCodexMeta(item.rep.codexId)?.title || '';
    return tile({
      key: `string:${item.index}`, src: stringThumb(item.rep), caption, badge: formatArtistWeight(item.weight) || '',
      onOpen: () => {
        if (own && state.codex?.id === STYLE_CODEX_ID && !state.favoritesView && !state.siteSearchView) openInPlace(own, 'push');
        else openRecentEntry({ codexId: item.rep.codexId, entryId: item.rep.entryId }, { historyMode: 'push' });
      },
    });
  });
  box.innerHTML = items.length
    ? `<div class="section-head"><div class="section-label">出现在画风串 <span class="artist-strip-count">${formatCount(list.length)}</span></div></div>${stripHtml('strings', items)}`
    : '';
  box.hidden = !items.length;
}

/* 返回是否按画师版式显示；由 lightbox.js 的 renderLightbox 调用 */
export function renderArtistProfile(entry) {
  const box = $('#artistProfile');
  const lb = $('#lightbox');
  const seq = ++profileSeq;
  profileTiles = new Map();
  const off = () => {
    lb?.classList.remove('is-artist');
    if (box) {
      box.hidden = true;
      box.replaceChildren();
    }
    profileArtist = -1;
    return false;
  };
  if (!box || !lb) return off();
  if (mayHaveStyle(entry) && !styleBookCodex()) {
    ensureStyleBook().then(ok => {
      if (ok && seq === profileSeq && state.lightbox?.entry === entry) renderArtistProfile(entry);
    });
    return off();
  }
  if (!profileApplies(entry)) return off();
  const artist = artistOf(entry);
  if (artist.index !== profileArtist) {
    expanded.near = false;
    expanded.strings = false;
  }
  profileArtist = artist.index;
  const group = groupOf(artist);
  const parent = parentOf(group);
  const name = artistNameOf(entry);
  $('#lightboxTitle').textContent = name;
  lb.classList.add('is-artist');
  const key = nameKey(name);
  const strings = stringsIndex === undefined ? undefined : (stringsIndex?.get(key) || []);
  const weight = strings === undefined ? undefined : weightOf(strings);
  box.innerHTML = `
    <div class="ap-tag"><code>artist:${esc(name)}</code><button type="button" class="ui-press ap-copy">复制正向</button></div>
    <div class="lightbox-section ap-section ap-style">
      <div class="section-head"><div class="section-label">画风</div>${stylePathHtml(group, parent)}</div>
      ${group.tags.length ? `<div class="ap-tags">${group.tags.map(tag => `<span>${esc(tag)}</span>`).join('')}</div>` : ''}
      <p class="ap-desc">${esc(group.desc)}</p>
    </div>
    ${statsHtml(artist, weight)}
    ${specimensHtml(entry, artist)}
    <div class="lightbox-section ap-section" data-ap-near hidden></div>
    <div class="lightbox-section ap-section" data-ap-strings hidden></div>
    ${entry.note ? `<p class="ap-note">${esc(entry.note)}</p>` : ''}`;
  box.hidden = false;
  loadNearArtists(artist.index).then(indexes => {
    if (seq !== profileSeq) return;
    const near = box.querySelector('[data-ap-near]');
    if (near) paintNear(near, indexes);
  });
  const paintStringPart = list => {
    const holder = box.querySelector('[data-ap-strings]');
    if (holder) paintStrings(holder, list);
  };
  if (strings === undefined) {
    loadStringsIndex().then(index => {
      if (seq !== profileSeq) return;
      const list = index?.get(key) || [];
      const stat = box.querySelector('[data-ap-weight]');
      if (stat) stat.outerHTML = weightStatHtml(weightOf(list));
      paintStringPart(list);
    });
  } else {
    paintStringPart(strings);
  }
  return true;
}

export function resetArtistProfile() {
  profileSeq += 1;
  profileArtist = -1;
  profileTiles = new Map();
  $('#lightbox')?.classList.remove('is-artist');
}

function onProfileClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.closest('.ap-copy')) {
    event.stopPropagation();
    $('#copyPositive')?.click();
    return;
  }
  const more = target.closest('[data-ap-more]');
  if (more) {
    event.stopPropagation();
    expanded[more.dataset.apMore] = !expanded[more.dataset.apMore];
    const entry = state.lightbox?.entry;
    if (entry) renderArtistProfile(entry);
    return;
  }
  const tileButton = target.closest('[data-ap-key]');
  if (tileButton) {
    event.stopPropagation();
    profileTiles.get(tileButton.dataset.apKey)?.();
    return;
  }
  const link = target.closest('[data-ap-path]');
  if (link) {
    event.stopPropagation();
    const path = link.dataset.apPath.split(PATH_SEP);
    styleUiActions.closeLightbox();
    window.setTimeout(() => styleUiActions.selectPath(path), 0);
  }
}

/* 收藏、全站搜索里的词条是拷贝，路径前面加了书名：按 ID 找回书里的原词条再判断 */
function originalOf(entry) {
  return styleBookEntry(entry?.id) || entry;
}

/* 这条词条打开时是否用画师版式（画风数据已挂上、单画师词条、找得到画师） */
function profileApplies(entry) {
  return Boolean(styleActive(styleBookCodex()) && originalOf(entry)?.path?.[0] === SINGLE_ROOT && artistOf(entry));
}

/* 词条详情第一行：画师版式写例图来源；其它单画师词条写画风路径（与侧栏一致）；其余照旧。
   refreshLightboxNavigation 先于 renderArtistProfile 运行，所以这里自己判定版式，不看 is-artist。 */
export function lightboxPathText(entry) {
  if (profileApplies(entry)) {
    const source = specimenSource(originalOf(entry));
    return source ? `例图来源 ${source}` : '';
  }
  return stylePathText(entry) || (entry?.path || []).join(' › ');
}

