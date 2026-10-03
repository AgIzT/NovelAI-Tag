import { fetchDataJson } from '../data-source.js';
import { $ } from './utils.js';
import { findCodexMeta } from './data.js';
import { assetUrl } from './media.js';
import { openRecentEntry } from './history.js';
import {
  ARTIST_VERSION_LABELS,
  formatArtistWeight,
  normalizeArtistIndex,
  promptArtists,
  resolveArtistTiles,
} from './artist-core.js';
import { encodeBoard } from '../lab/lab-core.js';

/* ---------------- 画师串拆解（灯箱「画师」一栏） ----------------
   把正向提示词里的 artist:xxx 逐个对到画师词典的单画师样张，排成缩略图。
   点缩略图在大图位置换成样张，再点或点「回到原图」换回；「打开词条」跳到那条画师词条。
   索引 artist_index.json 第一次遇到带画师的词条才下载；旧数据版本没有这个文件时整栏不显示。 */

const INDEX_PATH = 'artist_index.json';
const COLLAPSED_LIMIT = 10;
const DEFAULT_VERSION = 'n5';

let artistIndex;          // undefined = 还没加载完；null = 当前数据版本没有索引
let indexLoad = null;
let renderSeq = 0;
let chosenVersion = '';   // 本次灯箱里手动切过的版本；关灯箱清空
let expanded = false;
let current = null;       // { entry, codexId, artists }
let peekKey = '';

function loadArtistIndex() {
  if (artistIndex !== undefined) return Promise.resolve(artistIndex);
  indexLoad ??= fetchDataJson(INDEX_PATH)
    .then(normalizeArtistIndex)
    .catch(error => {
      console.warn('画师样张索引不可用，灯箱不显示画师一栏。', error);
      return null;
    })
    .then(index => {
      artistIndex = index;
      return index;
    });
  return indexLoad;
}

function sampleUrl(sample) {
  const book = artistIndex?.books[sample.version];
  const meta = findCodexMeta(book);
  if (!meta) return '';
  return assetUrl('image', { image: sample.image, assetCodexId: sample.assetCodexId, assetRev: sample.assetRev }, meta);
}

function currentVersion() {
  if (chosenVersion) return chosenVersion;
  return artistIndex?.codexModel.get(current?.codexId) || DEFAULT_VERSION;
}

function skipEntryFor(entry, codexId) {
  const isBook = Object.values(artistIndex?.books || {}).includes(codexId);
  return isBook ? { codexId, entryId: entry.id } : null;
}

export function renderArtistStrip(entry, positive, codexId) {
  const block = $('#artistStripBlock');
  if (!block) return;
  const seq = ++renderSeq;
  closeArtistPeek();
  const artists = promptArtists(positive);
  current = { entry, codexId, artists };
  if (!artists.length || artistIndex === null) {
    block.hidden = true;
    return;
  }
  if (artistIndex === undefined) {
    block.hidden = true;
    loadArtistIndex().then(() => {
      if (seq === renderSeq) paintArtistStrip();
    });
    return;
  }
  paintArtistStrip();
}

function paintArtistStrip() {
  const block = $('#artistStripBlock');
  const grid = $('#artistStrip');
  const missingLine = $('#artistStripMissing');
  if (!block || !grid || !current || !artistIndex) return;
  const version = currentVersion();
  const { tiles, missing, bothVersions } = resolveArtistTiles(artistIndex, current.artists, version, {
    skipEntry: skipEntryFor(current.entry, current.codexId),
  });
  block.hidden = !tiles.length;
  if (!tiles.length) return;

  $('#artistStripCount').textContent = `${current.artists.length} 位`;
  // 整串带去画风实验台：画师、倍率原样，全部锁住，换哪位由用户自己挑
  const labLink = $('#artistLabLink');
  if (labLink) {
    const params = new URLSearchParams({
      v: version,
      a: encodeBoard(current.artists.map(artist => ({ name: artist.name, weight: artist.weight, locked: true }))),
    });
    labLink.href = `/lab.html?${params}`;
  }
  const switcher = $('#artistVersion');
  switcher.hidden = !bothVersions;
  const buttons = [...switcher.querySelectorAll('button[data-version]')];
  buttons.forEach((button, i) => {
    const on = button.dataset.version === version;
    button.setAttribute('aria-checked', on ? 'true' : 'false');
    if (on) switcher.style.setProperty('--seg-index', String(i));
  });

  const folded = !expanded && tiles.length > COLLAPSED_LIMIT;
  const shown = folded ? tiles.slice(0, COLLAPSED_LIMIT - 1) : tiles;
  const nodes = shown.map(tile => artistTile(tile));
  if (folded) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'artist-tile artist-tile-more ui-press';
    more.textContent = `+${tiles.length - shown.length}`;
    more.setAttribute('aria-label', `展开全部 ${tiles.length} 位`);
    more.onclick = ev => {
      ev.stopPropagation();
      expanded = true;
      paintArtistStrip();
    };
    nodes.push(more);
  } else if (tiles.length > COLLAPSED_LIMIT) {
    const less = document.createElement('button');
    less.type = 'button';
    less.className = 'artist-tile artist-tile-more ui-press';
    less.textContent = '收起';
    less.onclick = ev => {
      ev.stopPropagation();
      expanded = false;
      paintArtistStrip();
    };
    nodes.push(less);
  }
  grid.replaceChildren(...nodes);

  missingLine.hidden = !missing.length;
  missingLine.textContent = missing.length
    ? `无样张（${missing.length}）：${missing.map(artist => artist.name).join('、')}`
    : '';
}

function tileKey(tile) {
  return `${tile.sample.version}:${tile.sample.entryId}`;
}

function artistTile(tile) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'artist-tile ui-press';
  button.title = `artist:${tile.name}`;
  button.setAttribute('aria-pressed', peekKey === tileKey(tile) ? 'true' : 'false');
  const frame = document.createElement('span');
  frame.className = 'artist-tile-img';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = '';
  img.src = sampleUrl(tile.sample);
  frame.append(img);
  const weight = formatArtistWeight(tile.weight);
  if (weight) {
    const badge = document.createElement('span');
    badge.className = 'artist-tile-weight';
    badge.classList.toggle('is-down', tile.weight < 1);
    badge.textContent = weight;
    frame.append(badge);
  }
  if (tile.fallback) {
    const ver = document.createElement('span');
    ver.className = 'artist-tile-ver';
    ver.textContent = ARTIST_VERSION_LABELS[tile.sample.version];
    frame.append(ver);
  }
  const name = document.createElement('span');
  name.className = 'artist-tile-name';
  name.textContent = tile.name;
  button.append(frame, name);
  button.onclick = ev => {
    ev.stopPropagation();
    if (peekKey === tileKey(tile)) closeArtistPeek();
    else openArtistPeek(tile);
  };
  return button;
}

function syncPressedTiles() {
  const grid = $('#artistStrip');
  if (!grid) return;
  for (const button of grid.querySelectorAll('.artist-tile:not(.artist-tile-more)')) {
    button.setAttribute('aria-pressed', 'false');
  }
}

function openArtistPeek(tile) {
  const peek = $('#artistPeek');
  if (!peek) return;
  peekKey = tileKey(tile);
  const book = artistIndex.books[tile.sample.version];
  const img = $('#artistPeekImg');
  img.src = sampleUrl(tile.sample);
  $('#artistPeekName').textContent = `artist:${tile.name}`;
  const title = findCodexMeta(book)?.title || ARTIST_VERSION_LABELS[tile.sample.version];
  $('#artistPeekSource').textContent = tile.sample.count > 1 ? `${title} · 共 ${tile.sample.count} 张` : title;
  $('#artistPeekOpen').onclick = ev => {
    ev.stopPropagation();
    closeArtistPeek();
    openRecentEntry({ codexId: book, entryId: tile.sample.entryId, path: tile.sample.path }, { historyMode: 'push' });
  };
  peek.hidden = false;
  $('#lightbox')?.classList.add('artist-peeking');
  syncPressedTiles();
  for (const button of $('#artistStrip').querySelectorAll('.artist-tile:not(.artist-tile-more)')) {
    if (button.title === `artist:${tile.name}`) button.setAttribute('aria-pressed', 'true');
  }
}

/* 收起样张、换回原图；本来就没开返回 false（Esc 据此决定是否继续关灯箱）。 */
export function closeArtistPeek() {
  const peek = $('#artistPeek');
  const wasOpen = Boolean(peek && !peek.hidden);
  peekKey = '';
  if (peek) {
    peek.hidden = true;
    $('#artistPeekImg')?.removeAttribute('src');
  }
  $('#lightbox')?.classList.remove('artist-peeking');
  syncPressedTiles();
  return wasOpen;
}

export function resetArtistStrip() {
  renderSeq += 1;
  chosenVersion = '';
  current = null;
  closeArtistPeek();
}

export function bindArtistStripControls() {
  $('#artistVersion')?.addEventListener('click', ev => {
    const button = ev.target instanceof Element ? ev.target.closest('button[data-version]') : null;
    if (!button) return;
    ev.stopPropagation();
    chosenVersion = button.dataset.version;
    closeArtistPeek();
    paintArtistStrip();
  });
  $('#artistPeekClose')?.addEventListener('click', ev => {
    ev.stopPropagation();
    closeArtistPeek();
  });
  // 点样张本身或它周围的空白都是换回原图，不冒泡成「点背景关灯箱」
  $('#artistPeek')?.addEventListener('click', ev => {
    if (ev.target instanceof Element && ev.target.closest('.artist-peek-bar')) return;
    ev.stopPropagation();
    closeArtistPeek();
  });
}
