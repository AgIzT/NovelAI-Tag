import { fetchDataJson, fetchDataJsonBatch } from './data-source.js';
import { $ } from './app/utils.js';
import { state } from './app/state.js';
import { assetUrl } from './app/media.js';
import { ARTIST_VERSION_LABELS, findArtistSample, normalizeArtistIndex, otherArtistVersion } from './app/artist-core.js';
import { formatCopyText } from './app/nai-sd.js';
import { readSdMode } from './app/sd-mode.js';
import { writeClipboardText } from './app/clipboard.js';
import { toast } from './app/feedback.js';
import {
  LAB_DEFAULT_SIZE,
  LAB_MAX_SIZE,
  LAB_WEIGHT_STEP,
  buildArtistStats,
  canonicalArtist,
  clampWeight,
  composeArtistString,
  decodeBoard,
  drawArtist,
  encodeBoard,
  matchStrings,
  normalizeArtistStrings,
  normalizeLabVersion,
  rerollSlots,
  roundWeight,
} from './lab/lab-core.js';

/* ---------------- 画风实验台 ----------------
   牌组（画师 + 倍率 + 是否锁住）是唯一状态，每次变动都写回网址（可直接分享）并存一份到本机，
   下次不带参数打开时接着用。抽卡、搭档与「一起出现过」的计算都在 lab/lab-core.js。 */

const BOARD_STORAGE_KEY = 'fadian-lab-board';
const RECENT_LIMIT = 150;
const UNDO_LIMIT = 30;
const WORKS_LIMIT = 12;

const lab = {
  version: 'n5',
  slots: [],
  codexes: [],
  index: null,
  strings: null,
  stats: new Map(),
  recent: [],
  undo: [],
  worksExpanded: false,
};

function codexMeta(id) {
  return lab.codexes.find(codex => codex.id === id || (Array.isArray(codex.aliases) && codex.aliases.includes(id)));
}

function statsFor(version) {
  if (!lab.stats.has(version)) lab.stats.set(version, buildArtistStats(lab.index, version, lab.strings[version]));
  return lab.stats.get(version);
}

function poolFor(version) {
  return new Set(lab.index.samples[version].keys());
}

function rememberDrawn(names) {
  lab.recent = [...names, ...lab.recent.filter(name => !names.includes(name))].slice(0, RECENT_LIMIT);
}

function pushUndo() {
  lab.undo.push(lab.slots.map(slot => ({ ...slot })));
  if (lab.undo.length > UNDO_LIMIT) lab.undo.shift();
}

/* 这一版没有样张时取另一版，并标出来。 */
function sampleFor(name) {
  const own = findArtistSample(lab.index, lab.version, name);
  if (own) return { sample: own, fallback: false };
  const other = findArtistSample(lab.index, otherArtistVersion(lab.version), name);
  return other ? { sample: other, fallback: true } : { sample: null, fallback: false };
}

function sampleUrl(sample) {
  const meta = codexMeta(lab.index.books[sample.version]);
  if (!meta) return '';
  return assetUrl('image', { image: sample.image, assetCodexId: sample.assetCodexId, assetRev: sample.assetRev }, meta);
}

function workUrl(rep) {
  const meta = codexMeta(rep.codexId);
  if (!meta) return '';
  return assetUrl('image', { image: rep.image, assetCodexId: rep.assetCodexId, assetRev: rep.assetRev }, meta);
}

function shareHref(codexId, entryId) {
  return `/share/${encodeURIComponent(codexId)}/${encodeURIComponent(entryId)}`;
}

function formatWeightValue(weight) {
  const value = roundWeight(weight);
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

function freshBoard(size = LAB_DEFAULT_SIZE) {
  const slots = Array.from({ length: size }, () => ({ name: '', weight: 1, locked: false }));
  return rerollSlots(slots, {
    pool: poolFor(lab.version),
    stats: statsFor(lab.version),
    recent: new Set(lab.recent),
    only: slots.map((slot, i) => i),
  }).filter(slot => slot.name);
}

/* ---------------- 状态写回 ---------------- */

function boardQuery() {
  const params = new URLSearchParams();
  params.set('v', lab.version);
  const board = encodeBoard(lab.slots);
  if (board) params.set('a', board);
  return params.toString();
}

function persist() {
  const query = boardQuery();
  history.replaceState(history.state, '', `${location.pathname}?${query}`);
  try { localStorage.setItem(BOARD_STORAGE_KEY, query); } catch { /* 无痕模式写不进也照常用 */ }
}

function readInitialState() {
  const params = new URLSearchParams(location.search);
  let saved = null;
  if (!params.has('a') && !params.has('v')) {
    try { saved = new URLSearchParams(localStorage.getItem(BOARD_STORAGE_KEY) || ''); } catch { saved = null; }
  }
  const source = saved || params;
  lab.version = normalizeLabVersion(source.get('v'));
  lab.slots = decodeBoard(source.get('a'));
  if (!lab.slots.length) lab.slots = freshBoard();
  rememberDrawn(lab.slots.map(slot => slot.name));
}

/* ---------------- 渲染 ---------------- */

const ICONS = {
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>',
  reroll: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

function iconButton(action, index, icon, label, extra = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `lab-icon ui-press is-${action}`;
  button.dataset.action = action;
  button.dataset.index = String(index);
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = icon;
  for (const [key, value] of Object.entries(extra)) button.setAttribute(key, value);
  return button;
}

function renderCard(slot, index) {
  const card = document.createElement('article');
  card.className = 'lab-card';
  card.classList.toggle('is-locked', slot.locked);
  const { sample, fallback } = sampleFor(slot.name);

  const frame = document.createElement('button');
  frame.type = 'button';
  frame.className = 'lab-card-img';
  frame.dataset.action = 'preview';
  frame.dataset.index = String(index);
  frame.setAttribute('aria-label', `放大 artist:${slot.name}`);
  if (sample) {
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.src = sampleUrl(sample);
    frame.append(img);
    if (fallback) {
      const badge = document.createElement('span');
      badge.className = 'lab-card-ver';
      badge.textContent = `${ARTIST_VERSION_LABELS[sample.version]} 样张`;
      frame.append(badge);
    }
  } else {
    frame.disabled = true;
    const empty = document.createElement('span');
    empty.className = 'lab-card-missing';
    empty.textContent = '无样张';
    frame.append(empty);
  }

  const icons = document.createElement('div');
  icons.className = 'lab-card-icons';
  icons.append(
    iconButton('lock', index, slot.locked ? ICONS.lock : ICONS.unlock, slot.locked ? '解锁' : '锁住', { 'aria-pressed': slot.locked ? 'true' : 'false' }),
    iconButton('reroll-one', index, ICONS.reroll, '换这一位'),
    iconButton('remove', index, ICONS.remove, '移除'),
  );

  const name = document.createElement('div');
  name.className = 'lab-card-name';
  name.textContent = slot.name;
  name.title = `artist:${slot.name}`;

  const weight = document.createElement('div');
  weight.className = 'lab-weight';
  const minus = document.createElement('button');
  minus.type = 'button';
  minus.className = 'ui-press';
  minus.dataset.action = 'weight-down';
  minus.dataset.index = String(index);
  minus.setAttribute('aria-label', '降低权重');
  minus.textContent = '−';
  const value = document.createElement('span');
  value.className = 'lab-weight-value';
  value.classList.toggle('is-changed', roundWeight(slot.weight) !== 1);
  value.textContent = formatWeightValue(slot.weight);
  const plus = minus.cloneNode(false);
  plus.dataset.action = 'weight-up';
  plus.setAttribute('aria-label', '提高权重');
  plus.textContent = '+';
  weight.append(minus, value, plus);

  card.append(frame, icons, name, weight);
  return card;
}

function renderVersion() {
  const switcher = $('#labVersion');
  [...switcher.querySelectorAll('button[data-version]')].forEach((button, i) => {
    const on = button.dataset.version === lab.version;
    button.setAttribute('aria-checked', on ? 'true' : 'false');
    if (on) switcher.style.setProperty('--seg-index', String(i));
  });
}

function renderArtistList() {
  const list = $('#labArtistList');
  if (list.dataset.version === lab.version) return;
  list.dataset.version = lab.version;
  const fragment = document.createDocumentFragment();
  for (const name of [...poolFor(lab.version)].sort()) {
    const option = document.createElement('option');
    option.value = name;
    fragment.append(option);
  }
  list.replaceChildren(fragment);
}

function outputText() {
  return formatCopyText(composeArtistString(lab.slots), { sdMode: readSdMode() }).text;
}

function renderOutput() {
  $('#labOutput').value = outputText();
  $('#labCopy').title = readSdMode() ? '将以 Stable Diffusion 格式复制' : '复制 NovelAI 原文';
}

function renderWorks() {
  const stats = statsFor(lab.version);
  const matches = matchStrings(lab.strings[lab.version], lab.slots.map(slot => slot.name), stats.nameOf);
  const shown = lab.worksExpanded ? matches : matches.slice(0, WORKS_LIMIT);
  $('#labWorksCount').textContent = matches.length ? String(matches.length) : '';
  $('#labWorksEmpty').hidden = matches.length > 0 || lab.slots.length < 2;
  const more = $('#labWorksMore');
  more.hidden = matches.length <= WORKS_LIMIT;
  more.textContent = lab.worksExpanded ? '收起' : `显示全部 ${matches.length} 条`;
  $('#labWorks').replaceChildren(...shown.map((match, i) => renderWork(match, i)));
}

function renderWork({ string, overlap }, index) {
  const work = document.createElement('article');
  work.className = 'lab-work';
  const link = document.createElement('a');
  link.className = 'lab-work-img';
  link.href = shareHref(string.rep.codexId, string.rep.entryId);
  link.setAttribute('aria-label', '打开作品');
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = workUrl(string.rep);
  link.append(img);
  const body = document.createElement('div');
  body.className = 'lab-work-body';
  const hit = document.createElement('div');
  hit.className = 'lab-work-hit';
  hit.textContent = `含 ${overlap.length} 位：${overlap.join('、')}`;
  const meta = document.createElement('div');
  meta.className = 'lab-work-meta';
  meta.textContent = `${string.members.length} 位画师 · ${string.rep.images} 张图`;
  const adopt = document.createElement('button');
  adopt.type = 'button';
  adopt.className = 'lab-btn is-small ui-press';
  adopt.dataset.action = 'adopt';
  adopt.dataset.index = String(index);
  adopt.textContent = '用这串';
  body.append(hit, meta, adopt);
  work.append(link, body);
  work.dataset.matchIndex = String(index);
  return work;
}

function render() {
  renderVersion();
  renderArtistList();
  $('#labBoard').replaceChildren(...lab.slots.map(renderCard));
  $('#labUndo').disabled = !lab.undo.length;
  $('#labAdd').disabled = lab.slots.length >= LAB_MAX_SIZE;
  renderOutput();
  renderWorks();
  persist();
}

/* ---------------- 动作 ---------------- */

function rerollAll() {
  if (lab.slots.length && lab.slots.every(slot => slot.locked)) {
    toast('全部已锁住', '!');
    return;
  }
  pushUndo();
  const slots = lab.slots.length ? lab.slots : Array.from({ length: LAB_DEFAULT_SIZE }, () => ({ name: '', weight: 1, locked: false }));
  lab.slots = rerollSlots(slots, { pool: poolFor(lab.version), stats: statsFor(lab.version), recent: new Set(lab.recent) })
    .filter(slot => slot.name);
  rememberDrawn(lab.slots.filter(slot => !slot.locked).map(slot => slot.name));
  render();
}

function rerollOne(index) {
  pushUndo();
  lab.slots = rerollSlots(lab.slots, {
    pool: poolFor(lab.version), stats: statsFor(lab.version), recent: new Set(lab.recent), only: [index],
  });
  rememberDrawn([lab.slots[index].name]);
  render();
}

function addRandom() {
  if (lab.slots.length >= LAB_MAX_SIZE) return;
  const name = drawArtist({
    pool: poolFor(lab.version),
    stats: statsFor(lab.version),
    locked: lab.slots.map(slot => slot.name),
    exclude: new Set(lab.slots.map(slot => slot.name)),
    recent: new Set(lab.recent),
  });
  if (!name) return;
  lab.slots.push({ name, weight: 1, locked: false });
  rememberDrawn([name]);
  render();
}

function addNamed(raw) {
  const typed = String(raw || '').trim().toLowerCase().replace(/^artist\s*:\s*/, '').replace(/_/g, ' ').replace(/\s+/g, ' ');
  if (!typed) return false;
  const nameOf = statsFor(lab.version).nameOf;
  const name = canonicalArtist(lab.index, lab.version, typed);
  if (lab.slots.some(slot => nameOf(slot.name) === nameOf(name))) {
    toast(`artist:${name} 已在牌组里`, '!');
    return false;
  }
  if (lab.slots.length >= LAB_MAX_SIZE) {
    toast(`最多 ${LAB_MAX_SIZE} 位`, '!');
    return false;
  }
  lab.slots.push({ name, weight: 1, locked: true });
  render();
  return true;
}

function adopt(match) {
  if (!match) return;
  pushUndo();
  const nameOf = statsFor(lab.version).nameOf;
  const seen = new Set();
  lab.slots = match.string.members
    .map(item => ({ name: item.name, weight: item.weight, locked: true }))
    .filter(slot => !seen.has(nameOf(slot.name)) && seen.add(nameOf(slot.name)))
    .slice(0, LAB_MAX_SIZE);
  lab.worksExpanded = false;
  render();
  toast(`已换成这串（${lab.slots.length} 位）`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function copyOutput() {
  const text = outputText();
  if (!text) return;
  const result = await writeClipboardText(text);
  if (result.ok) {
    toast(`已复制画风串（${lab.slots.length} 位）`);
  } else {
    const output = $('#labOutput');
    output.focus();
    output.select();
    toast('复制失败：已选中文本，手动复制', '!');
  }
}

async function copyLink() {
  const url = `${location.origin}${location.pathname}?${boardQuery()}`;
  const result = await writeClipboardText(url);
  toast(result.ok ? '已复制链接' : '复制失败', result.ok ? '✓' : '!');
}

/* ---------------- 大图预览 ---------------- */

function openPreview(index) {
  const slot = lab.slots[index];
  const { sample } = slot ? sampleFor(slot.name) : {};
  if (!sample) return;
  const book = lab.index.books[sample.version];
  $('#labPreviewImg').src = sampleUrl(sample);
  $('#labPreviewName').textContent = `artist:${slot.name}`;
  const title = codexMeta(book)?.title || ARTIST_VERSION_LABELS[sample.version];
  $('#labPreviewSource').textContent = sample.count > 1 ? `${title} · 共 ${sample.count} 张` : title;
  $('#labPreviewOpen').href = shareHref(book, sample.entryId);
  $('#labPreview').hidden = false;
  $('#labPreviewClose').focus({ preventScroll: true });
}

function closePreview() {
  const preview = $('#labPreview');
  if (preview.hidden) return false;
  preview.hidden = true;
  $('#labPreviewImg').removeAttribute('src');
  return true;
}

/* ---------------- 接线 ---------------- */

function bind() {
  $('#labBoard').addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target) return;
    const index = Number(target.dataset.index);
    const slot = lab.slots[index];
    if (!slot) return;
    switch (target.dataset.action) {
      case 'lock':
        slot.locked = !slot.locked;
        render();
        break;
      case 'reroll-one':
        rerollOne(index);
        break;
      case 'remove':
        pushUndo();
        lab.slots.splice(index, 1);
        render();
        break;
      case 'weight-down':
      case 'weight-up':
        slot.weight = clampWeight(roundWeight(slot.weight) + (target.dataset.action === 'weight-up' ? LAB_WEIGHT_STEP : -LAB_WEIGHT_STEP));
        render();
        break;
      case 'preview':
        openPreview(index);
        break;
      default:
    }
  });
  $('#labVersion').addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('button[data-version]') : null;
    if (!button || button.dataset.version === lab.version) return;
    lab.version = normalizeLabVersion(button.dataset.version);
    render();
  });
  $('#labReroll').addEventListener('click', rerollAll);
  $('#labUndo').addEventListener('click', () => {
    const previous = lab.undo.pop();
    if (!previous) return;
    lab.slots = previous;
    render();
  });
  $('#labAdd').addEventListener('click', addRandom);
  $('#labPickForm').addEventListener('submit', event => {
    event.preventDefault();
    const input = $('#labPickInput');
    if (addNamed(input.value)) input.value = '';
  });
  $('#labCopy').addEventListener('click', copyOutput);
  $('#labCopyLink').addEventListener('click', copyLink);
  $('#labWorks').addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('[data-action="adopt"]') : null;
    if (!button) return;
    const matches = matchStrings(lab.strings[lab.version], lab.slots.map(slot => slot.name), statsFor(lab.version).nameOf);
    adopt(matches[Number(button.dataset.index)]);
  });
  $('#labWorksMore').addEventListener('click', () => {
    lab.worksExpanded = !lab.worksExpanded;
    renderWorks();
  });
  $('#labPreview').addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('.lab-preview-bar')) return;
    closePreview();
  });
  $('#labPreviewClose').addEventListener('click', closePreview);
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && closePreview()) event.preventDefault();
  });
  // 主站切了 SD 模式，回到这页时输出跟着变
  window.addEventListener('storage', event => {
    if (event.key === 'fadian-sdmode') renderOutput();
  });
}

async function boot() {
  try {
    const [codexResult, mediaResult] = await fetchDataJsonBatch([
      { path: 'codexes.json' },
      { path: 'media.json', fallbackValue: {} },
    ]);
    lab.codexes = Array.isArray(codexResult.data) ? codexResult.data : [];
    state.media = { ...state.media, ...(mediaResult.data || {}) };
    const [indexJson, stringsJson] = await Promise.all([
      fetchDataJson('artist_index.json'),
      fetchDataJson('artist_strings.json'),
    ]);
    lab.index = normalizeArtistIndex(indexJson);
    lab.strings = normalizeArtistStrings(stringsJson);
    if (!lab.index || !lab.strings) throw new Error('画师数据形态不对');
  } catch (error) {
    console.warn('画风实验台数据加载失败。', error);
    $('#labStatus').textContent = '数据加载失败，刷新页面重试';
    return;
  }
  readInitialState();
  bind();
  $('#labStatus').hidden = true;
  for (const id of ['#labBoardSection', '#labOutputSection', '#labWorksSection']) $(id).hidden = false;
  render();
}

boot();
