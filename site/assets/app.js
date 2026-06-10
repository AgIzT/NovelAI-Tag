'use strict';

const $ = (s, r = document) => r.querySelector(s);

const CARD_MIN_WIDTH = 290;
const GAP = 16;
const VIRTUAL_BUFFER_UP = 0.8;
const VIRTUAL_BUFFER_DOWN = 1.4;
const IMAGE_LOAD_DELAY = 90;
const RELAYOUT_INTERVAL = 150;
const RELAYOUT_ANIM_MS = 320;
const DEFAULT_IMAGE_RATIO = 1.18;
const MAX_TAG_LINES = 6;
const MIN_TAG_HEIGHT = 34;
const MAX_TAG_HEIGHT = 114;

const state = {
  codex: null,        // 当前法典数据
  codexes: [],
  codexCache: new Map(),
  list: [],           // 当前过滤后的词条
  rendered: 0,        // 当前虚拟渲染数量
  placements: [],     // 虚拟瀑布流布局
  nodes: new Map(),   // index -> DOM node
  colN: 0,
  itemWidth: 0,
  activePath: [],     // 选中的目录路径
  query: '',
  onlyImaged: false,
  onlyFav: false,
  favs: new Set(),    // 收藏集合，键为 codexId:entryId
  loadedImages: new Set(),
  lightbox: {
    entry: null,
    images: [],
    index: 0,
  },
  media: {
    baseUrl: '',
    imagePrefix: 'images',
    originalPrefix: 'originals',
    localFallback: true,
  },
};

const THEME_ICONS = {
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8Z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
};

/* ---------------- 数据加载 ---------------- */
async function init() {
  try {
    setLoading('正在加载法典索引…');
    state.favs = new Set(JSON.parse(localStorage.getItem('fadian-favs') || '[]'));
    const [codexes, media] = await Promise.all([
      fetch('data/codexes.json').then(r => r.json()),
      loadMedia(),
    ]);
    state.codexes = codexes;
    state.media = { ...state.media, ...media };
    const sel = $('#codexSelect');
    sel.innerHTML = codexes.map(c => `<option value="${c.id}">${esc(c.title)}</option>`).join('');
    sel.onchange = () => loadCodex(sel.value);
    bindUI();
    if (codexes.length) await loadCodex(codexes[0].id);
    else setLoading('还没有可显示的法典数据');
  } catch (ex) {
    console.error(ex);
    setLoading('加载失败，请刷新页面重试');
  }
}

async function loadMedia() {
  try {
    const res = await fetch('data/media.json', { cache: 'no-store' });
    if (res.ok) return res.json();
  } catch {}
  return {};
}

async function loadCodex(id) {
  setLoading('正在加载词条数据…');
  clearMasonry();
  const meta = state.codexes.find(c => c.id === id) || { id };
  state.codex = await fetchCodex(meta);
  const c = state.codex;
  $('#codexTitle').textContent = c.title;
  $('#codexMeta').textContent = `${c.author ? c.author + ' · ' : ''}${c.version} · ${c.entryCount} 条`;
  state.activePath = [];
  state.query = '';
  $('#search').value = '';
  renderTree();
  applyFilter({ resetScroll: true });
  setLoading('');
}

async function fetchCodex(meta) {
  const key = meta.id || meta.dataUrl;
  if (state.codexCache.has(key)) return state.codexCache.get(key);
  const url = meta.dataUrl || `data/${meta.id}.json`;
  let data;
  let sourceMeta = meta;
  let shouldCache = true;
  try {
    data = await fetchJson(url, meta.dataUrl ? 'no-store' : 'default');
  } catch (ex) {
    if (!meta.fallbackDataUrl) throw ex;
    console.warn(ex);
    shouldCache = false;
    data = await fetchJson(meta.fallbackDataUrl, 'default');
    sourceMeta = {
      ...meta,
      dataUrl: '',
      assetBaseUrl: '',
      assetPathMode: 'codex',
      version: meta.fallbackVersion || meta.version || data.version,
    };
  }
  const codex = normalizeCodex(data, sourceMeta);
  if (shouldCache) state.codexCache.set(key, codex);
  return codex;
}

async function fetchJson(url, cache = 'default') {
  return fetch(url, { cache }).then(r => {
    if (!r.ok) throw new Error(`Failed to load codex: ${url}`);
    return r.json();
  });
}

function normalizeCodex(data, meta = {}) {
  const codex = {
    ...data,
    id: meta.id || data.id,
    title: meta.title || data.title || data.id || meta.id,
    version: meta.version || data.version || '',
    author: meta.author || data.author || '',
    assetBaseUrl: stripTrailingSlash(meta.assetBaseUrl || meta.baseUrl || data.assetBaseUrl || ''),
    assetPathMode: meta.assetPathMode || data.assetPathMode || (meta.dataUrl ? 'relative' : 'codex'),
    dataUrl: meta.dataUrl || data.dataUrl || '',
  };
  codex.entries = (data.entries || []).map((entry, i) => normalizeEntry(entry, codex, i));
  codex.entryCount = Number(codex.entryCount || codex.entries.length);
  codex.imagedCount = Number(codex.imagedCount || codex.entries.filter(hasEntryImage).length);
  codex.tree = data.tree || buildTreeFromEntries(codex.entries);
  return codex;
}

function normalizeEntry(entry, codex, index) {
  const images = normalizeImageList(entry);
  const primary = images[0];
  return {
    ...entry,
    id: String(entry.id || `${codex.id}-${index + 1}`),
    title: String(entry.title || ''),
    path: Array.isArray(entry.path) ? entry.path : [],
    tags: String(entry.tags || entry.rawTags || ''),
    negative: String(entry.negative || ''),
    note: String(entry.note || ''),
    image: entry.image || primary?.path || '',
    original: entry.original || primary?.original || primary?.path || '',
    images,
  };
}

function normalizeImageList(entry) {
  const out = [];
  const seen = new Set();
  const add = (image, toFront = false) => {
    if (!image) return;
    const item = typeof image === 'string' ? { path: image } : { ...image };
    const path = item.path || item.image || item.url || item.src;
    if (!path || seen.has(path)) return;
    seen.add(path);
    const normalized = {
      ...item,
      path,
      original: item.original || path,
      rawTag: item.rawTag || item.rawTags || '',
    };
    if (toFront) out.unshift(normalized);
    else out.push(normalized);
  };
  for (const image of entry.images || []) add(image);
  if (entry.image && !seen.has(entry.image)) {
    add({ path: entry.image, original: entry.original || entry.image }, true);
  }
  if (entry.image && out.length) {
    const primaryIndex = out.findIndex(image => image.path === entry.image);
    if (primaryIndex > 0) out.unshift(out.splice(primaryIndex, 1)[0]);
    if (entry.original && out[0]?.path === entry.image) out[0].original = entry.original;
  }
  if (!out.length && entry.original) add({ path: entry.original, original: entry.original });
  return out;
}

function buildTreeFromEntries(entries) {
  const root = new Map();
  for (const entry of entries) {
    let node = root;
    for (const name of entry.path || []) {
      if (!node.has(name)) node.set(name, { name, count: 0, children: new Map() });
      const cur = node.get(name);
      cur.count++;
      node = cur.children;
    }
  }
  const toList = map => [...map.values()].map(n => ({
    name: n.name,
    count: n.count,
    children: toList(n.children),
  }));
  return toList(root);
}

function stripTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function setLoading(text) {
  const el = $('#loading');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
  $('#main')?.classList.toggle('is-loading', Boolean(text));
}

/* ---------------- 目录树 ---------------- */
function renderTree() {
  const nav = $('#tree');
  nav.innerHTML = '';
  const all = document.createElement('div');
  all.className = 'tree-row active';
  all.dataset.path = '';
  all.innerHTML = `<span class="tw-arrow"></span><span class="tw-name">全部</span><span class="tw-count">${state.codex.entryCount}</span>`;
  all.onclick = () => selectPath([], all);
  nav.appendChild(all);
  buildNodes(state.codex.tree, nav, [], 0);
}

function buildNodes(nodes, parent, prefix, depth) {
  for (const nd of nodes) {
    const path = prefix.concat(nd.name);
    const item = document.createElement('div');
    item.className = 'tree-item' + (depth >= 1 ? ' collapsed' : '');
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.path = path.join('\u0001');
    const hasKids = nd.children && nd.children.length;
    row.innerHTML =
      `<span class="tw-arrow">${hasKids ? '▾' : ''}</span>` +
      `<span class="tw-name">${esc(nd.name)}</span><span class="tw-count">${nd.count}</span>`;
    row.querySelector('.tw-arrow').onclick = e => { e.stopPropagation(); item.classList.toggle('collapsed'); };
    row.onclick = () => { selectPath(path, row); if (hasKids) item.classList.remove('collapsed'); };
    item.appendChild(row);
    if (hasKids) {
      const kids = document.createElement('div');
      kids.className = 'tree-children';
      buildNodes(nd.children, kids, path, depth + 1);
      item.appendChild(kids);
    }
    parent.appendChild(item);
  }
}

function selectPath(path, rowEl) {
  state.activePath = path;
  state.query = '';
  $('#search').value = '';
  document.querySelectorAll('.tree-row.active').forEach(r => r.classList.remove('active'));
  rowEl.classList.add('active');
  if (window.innerWidth <= 600) $('#sidebar').classList.add('hidden');
  applyFilter({ resetScroll: true });
}

/* ---------------- 过滤 ---------------- */
function applyFilter(options = {}) {
  const q = state.query.trim().toLowerCase();
  let list = state.codex.entries;
  if (q) {
    list = list.filter(e => searchableText(e).includes(q));
  } else if (state.activePath.length) {
    const p = state.activePath;
    list = list.filter(e => p.every((seg, i) => e.path[i] === seg));
  }
  if (state.onlyImaged) list = list.filter(hasEntryImage);
  if (state.onlyFav) list = list.filter(e => state.favs.has(favKey(e)));
  state.list = list;
  updateResultBar();
  renderList(options);
}

function searchableText(e) {
  return [e.title, e.tags, e.negative, e.note, e.rawTags, ...(e.path || [])]
    .join('\n')
    .toLowerCase();
}

function hasEntryImage(e) {
  return Boolean((e.images && e.images.length) || e.image);
}

function updateResultBar() {
  const n = state.list.length;
  let t;
  if (state.query.trim()) t = `搜索 “${esc(state.query.trim())}”：<b>${n}</b> 条结果`;
  else if (state.activePath.length) t = `${esc(state.activePath.join(' › '))}：<b>${n}</b> 条`;
  else if (state.onlyFav) t = `⭐ 我的收藏：<b>${n}</b> 条`;
  else t = `全部 <b>${n}</b> 条词条 · ${state.codex.imagedCount} 条已配图`;
  $('#resultInfo').innerHTML = t;
  $('#empty').hidden = n > 0;
}

/* ---------------- 虚拟瀑布流 ---------------- */
function colCount() {
  const w = $('#masonry').clientWidth || $('#main').clientWidth;
  return Math.max(1, Math.floor((w + GAP) / (CARD_MIN_WIDTH + GAP)));
}

function clearMasonry() {
  for (const node of state.nodes.values()) cleanupCard(node);
  state.nodes.clear();
  state.placements = [];
  state.rendered = 0;
  const m = $('#masonry');
  if (m) {
    relayoutAnimating = false;
    clearTimeout(relayoutAnimTimer);
    m.classList.remove('is-relayouting');
    m.innerHTML = '';
    m.style.height = '0px';
  }
}

function renderList({ resetScroll = false } = {}) {
  clearMasonry();
  if (resetScroll) window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  computeLayout();
  updateVirtualCards(true);
}

function computeLayout() {
  const m = $('#masonry');
  const width = Math.max(1, m.clientWidth || $('#main').clientWidth || 1);
  const n = colCount();
  const itemWidth = Math.max(180, Math.floor((width - GAP * (n - 1)) / n));
  const colHeights = Array.from({ length: n }, () => 0);
  const placements = [];

  for (let i = 0; i < state.list.length; i++) {
    const entry = state.list[i];
    const col = shortestIndex(colHeights);
    const imageHeight = estimateImageHeight(entry, itemWidth);
    const body = estimateBodyMetrics(entry, itemWidth);
    const height = Math.ceil(imageHeight + body.height);
    const left = col * (itemWidth + GAP);
    const top = colHeights[col];

    placements.push({
      index: i,
      entry,
      col,
      left,
      top,
      width: itemWidth,
      height,
      imageHeight,
      tagsHeight: body.tagsHeight,
    });
    colHeights[col] += height + GAP;
  }

  state.placements = placements;
  state.colN = n;
  state.itemWidth = itemWidth;
  const totalHeight = placements.length ? Math.max(...colHeights) - GAP : 0;
  m.style.height = `${Math.max(0, Math.ceil(totalHeight))}px`;
}

function shortestIndex(values) {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[best]) best = i;
  }
  return best;
}

function estimateImageHeight(e, width) {
  if (!hasEntryImage(e)) return 0;
  const iw = Number(e.imageWidth || e.width || e.thumbWidth);
  const ih = Number(e.imageHeight || e.height || e.thumbHeight);
  const ratio = iw > 0 && ih > 0 ? ih / iw : DEFAULT_IMAGE_RATIO;
  return Math.round(width * clamp(ratio, 0.55, 1.9));
}

function estimateBodyMetrics(e, width) {
  const contentWidth = Math.max(120, width - 26);
  const titleLines = clamp(Math.ceil(textUnits(e.title) / Math.max(8, Math.floor(contentWidth / 14))), 1, 2);
  const tagLines = estimateTagLines(e.tags, contentWidth);
  const titleHeight = titleLines * 20;
  const tagsHeight = clamp(tagLines * 19 + 18, MIN_TAG_HEIGHT, MAX_TAG_HEIGHT);
  const footHeight = e.negative ? 21 : 18;
  return {
    height: Math.ceil(12 + titleHeight + 8 + tagsHeight + 9 + footHeight + 11),
    tagsHeight,
  };
}

function estimateTagLines(text, width) {
  const perLine = Math.max(18, Math.floor(width / 7));
  const lines = String(text || '').split(/\n+/).reduce((sum, line) => {
    return sum + Math.max(1, Math.ceil(textUnits(line) / perLine));
  }, 0);
  return clamp(lines, 1, MAX_TAG_LINES);
}

function textUnits(text) {
  let units = 0;
  for (const ch of String(text || '')) units += /[\u4e00-\u9fff]/.test(ch) ? 2 : 1;
  return units;
}

let virtualRaf = 0;
let relayoutTimer = 0;
let relayoutAnimTimer = 0;
let relayoutQueuedAnimate = false;
let relayoutAnimating = false;
let lastRelayoutAt = 0;
function scheduleVirtualUpdate() {
  if (virtualRaf) return;
  virtualRaf = requestAnimationFrame(() => {
    virtualRaf = 0;
    updateVirtualCards();
  });
}

function masonryViewport(m) {
  const rect = m.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const totalHeight = m.offsetHeight || parseFloat(m.style.height) || 0;
  const maxTop = Math.max(0, totalHeight - viewportHeight);
  const rawTop = -rect.top;
  return {
    rect,
    viewportHeight,
    rawTop,
    top: clamp(rawTop, 0, maxTop),
  };
}

function updateVirtualCards(force = false) {
  const m = $('#masonry');
  if (!m || !state.placements.length) {
    state.rendered = 0;
    return;
  }

  const view = masonryViewport(m);
  const viewportTop = view.top;
  const viewportHeight = view.viewportHeight;
  const rangeTop = Math.max(0, viewportTop - viewportHeight * VIRTUAL_BUFFER_UP);
  const rangeBottom = viewportTop + viewportHeight * (1 + VIRTUAL_BUFFER_DOWN);
  const next = new Set();

  for (const placement of state.placements) {
    if (placement.top + placement.height < rangeTop || placement.top > rangeBottom) continue;
    next.add(placement.index);
    let node = state.nodes.get(placement.index);
    if (!node) {
      node = makeCard(placement);
      state.nodes.set(placement.index, node);
      m.appendChild(node);
      if (!relayoutAnimating) calibrateCardHeight(node, placement);
    } else if (force) {
      updateCardPosition(node, placement);
      if (!relayoutAnimating) calibrateCardHeight(node, placement);
    }
  }

  for (const [index, node] of state.nodes) {
    if (next.has(index)) continue;
    if (force && relayoutAnimating) {
      const placement = state.placements[index];
      if (placement) updateCardPosition(node, placement);
      continue;
    }
    cleanupCard(node);
    node.remove();
    state.nodes.delete(index);
  }
  state.rendered = next.size;
}

function makeCard(placement) {
  const e = placement.entry;
  const node = $('#cardTpl').content.firstElementChild.cloneNode(true);
  node.dataset.index = String(placement.index);
  updateCardPosition(node, placement);

  node.querySelector('.card-title').textContent = e.title;
  node.querySelector('.card-tags').textContent = e.tags;
  node.querySelector('.card-path').textContent = e.path.join(' › ');
  if (e.isNew) node.querySelector('.badge-new').hidden = false;

  const hasImage = hasEntryImage(e);
  const hasNegative = !!(e.negative && String(e.negative).trim());
  const imageCount = entryImages(e).length;
  const negBadge = node.querySelector('.badge-neg');
  if (negBadge) negBadge.hidden = !(hasImage && hasNegative);
  const countBadge = node.querySelector('.badge-count');
  if (countBadge) {
    countBadge.hidden = imageCount <= 1;
    const count = countBadge.querySelector('.badge-count-n');
    if (count) count.textContent = String(imageCount);
  }
  const negChip = node.querySelector('.badge-neg-chip');
  if (negChip) negChip.hidden = hasImage || !hasNegative;

  const negBtn = node.querySelector('.copy-negative');
  if (negBtn) {
    negBtn.hidden = !e.negative;
    negBtn.onclick = ev => { ev.stopPropagation(); copyText(e.negative, `已复制负面：${e.title}`, node); };
  }
  const allBtn = node.querySelector('.copy-all');
  if (allBtn) {
    allBtn.hidden = !e.negative;
    allBtn.onclick = ev => { ev.stopPropagation(); copyText(combinedPrompt(e), `已复制正向+负面：${e.title}`, node); };
  }

  const fav = node.querySelector('.fav-btn');
  const faved = state.favs.has(favKey(e));
  fav.textContent = faved ? '★' : '☆';
  fav.classList.toggle('on', faved);
  fav.onclick = ev => { ev.stopPropagation(); toggleFav(e, fav); };

  if (hasImage) {
    setupImage(node, placement);
  } else {
    node.classList.add('no-img');
  }

  node.onclick = () => copyEntry(e, node);
  return node;
}

function updateCardPosition(node, placement) {
  node.style.width = `${placement.width}px`;
  node.style.height = `${placement.height}px`;
  node.style.transform = `translate3d(${placement.left}px, ${placement.top}px, 0)`;
  const wrap = node.querySelector('.card-img-wrap');
  if (wrap && placement.imageHeight) wrap.style.height = `${placement.imageHeight}px`;
  const tags = node.querySelector('.card-tags');
  if (tags) tags.style.height = `${placement.tagsHeight}px`;
}

function calibrateCardHeight(node, placement) {
  const tags = node.querySelector('.card-tags');
  if (tags) {
    tags.style.height = 'auto';
    const naturalTagsHeight = Math.ceil(tags.scrollHeight);
    const tagsHeight = clamp(naturalTagsHeight, MIN_TAG_HEIGHT, MAX_TAG_HEIGHT);
    tags.style.height = `${tagsHeight}px`;
    tags.classList.toggle('is-clipped', naturalTagsHeight > tagsHeight + 1);
    placement.tagsHeight = tagsHeight;
  }

  const wrap = node.querySelector('.card-img-wrap');
  const body = node.querySelector('.card-body');
  const imageHeight = wrap && !wrap.hidden && getComputedStyle(wrap).display !== 'none'
    ? wrap.getBoundingClientRect().height
    : 0;
  const bodyHeight = body ? body.getBoundingClientRect().height : 0;
  const measuredHeight = Math.ceil(imageHeight + bodyHeight);
  if (measuredHeight > 0 && Math.abs(measuredHeight - placement.height) > 2) {
    shiftColumnAfterHeightChange(placement, measuredHeight);
  }
}

function shiftColumnAfterHeightChange(placement, nextHeight) {
  const delta = nextHeight - placement.height;
  placement.height = nextHeight;
  const currentNode = state.nodes.get(placement.index);
  if (currentNode) currentNode.style.height = `${placement.height}px`;

  for (const next of state.placements) {
    if (next === placement || next.col !== placement.col || next.top <= placement.top) continue;
    next.top += delta;
    const node = state.nodes.get(next.index);
    if (node) updateCardPosition(node, next);
  }
  syncMasonryHeight();
}

function syncMasonryHeight() {
  const m = $('#masonry');
  if (!m || !state.placements.length) return;
  const totalHeight = Math.max(...state.placements.map(p => p.top + p.height));
  m.style.height = `${Math.max(0, Math.ceil(totalHeight))}px`;
}

function setupImage(node, placement) {
  const e = placement.entry;
  const wrap = node.querySelector('.card-img-wrap');
  const img = node.querySelector('.card-img');
  const thumb = thumbUrl(e);
  const url = originalUrl(e) || thumb;
  const key = imageKey(e, url);

  wrap.hidden = false;
  wrap.style.height = `${placement.imageHeight}px`;
  wrap.classList.add('is-loading');
  img.alt = e.title;

  const markLoaded = () => {
    state.loadedImages.add(key);
    wrap.classList.remove('is-loading', 'is-error');
    img.classList.add('is-loaded');
  };
  const load = () => {
    node._imageTimer = 0;
    img.src = url;
  };

  img.onload = markLoaded;
  img.onerror = () => {
    const fallback = thumb && thumb !== img.src ? thumb : localAssetUrl('image', e);
    if (fallback && fallback !== img.src && img.dataset.fallbackTried !== '1') {
      img.dataset.fallbackTried = '1';
      img.src = fallback;
      return;
    }
    wrap.classList.remove('is-loading');
    wrap.classList.add('is-error');
  };

  if (state.loadedImages.has(key)) load();
  else node._imageTimer = window.setTimeout(load, IMAGE_LOAD_DELAY);

  wrap.querySelector('.zoom-btn').onclick = ev => {
    ev.stopPropagation();
    openLightbox(e, 0);
  };
}

function cleanupCard(node) {
  if (node._imageTimer) {
    clearTimeout(node._imageTimer);
    node._imageTimer = 0;
  }
}

function imageKey(e, url) {
  return `${state.codex.id}:${e.id}:${e.assetRev || ''}:${url}`;
}

function scheduleRelayout(animate = true) {
  relayoutQueuedAnimate = relayoutQueuedAnimate || animate;
  if (relayoutTimer) return;
  const now = performance.now();
  const delay = Math.max(0, RELAYOUT_INTERVAL - (now - lastRelayoutAt));
  relayoutTimer = window.setTimeout(() => {
    relayoutTimer = 0;
    lastRelayoutAt = performance.now();
    relayoutVisible({ animate: relayoutQueuedAnimate });
    relayoutQueuedAnimate = false;
  }, delay);
}

function startRelayoutAnimation() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const m = $('#masonry');
  if (!m) return;
  relayoutAnimating = true;
  m.classList.add('is-relayouting');
  // Make sure the transition class is active before the new transforms land.
  void m.offsetWidth;
  clearTimeout(relayoutAnimTimer);
  relayoutAnimTimer = window.setTimeout(() => {
    relayoutAnimating = false;
    m.classList.remove('is-relayouting');
    updateVirtualCards(true);
  }, RELAYOUT_ANIM_MS + 80);
}

function relayoutVisible({ animate = false } = {}) {
  if (!state.codex) return;
  if (animate) startRelayoutAnimation();
  computeLayout();
  updateVirtualCards(true);
}

/* ---------------- 复制 ---------------- */
async function copyEntry(e, node) {
  return copyText(e.tags, `已复制：${e.title}`, node);
}

async function copyText(text, message, node) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  if (node) {
    node.classList.add('copied');
    setTimeout(() => node.classList.remove('copied'), 600);
  }
  toast(message);
}

function combinedPrompt(e) {
  return e.negative ? `${e.tags}\n\nNegative:\n${e.negative}` : e.tags;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = '✓ ' + msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

/* ---------------- 收藏 ---------------- */
function favKey(e) { return state.codex.id + ':' + e.id; }
function toggleFav(e, btn) {
  const k = favKey(e);
  if (state.favs.has(k)) state.favs.delete(k); else state.favs.add(k);
  localStorage.setItem('fadian-favs', JSON.stringify([...state.favs]));
  const on = state.favs.has(k);
  if (btn) { btn.textContent = on ? '★' : '☆'; btn.classList.toggle('on', on); }
  if (state.onlyFav) applyFilter({ resetScroll: true });
}

/* ---------------- 灯箱 ---------------- */
function openLightbox(entry, index = 0) {
  const images = entryImages(entry);
  if (!images.length) return;
  state.lightbox = {
    entry,
    images,
    index: clamp(index, 0, images.length - 1),
  };
  renderLightbox();
  $('#lightbox').hidden = false;
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  $('#lightboxImg').src = '';
  state.lightbox = { entry: null, images: [], index: 0 };
}

function stepLightbox(delta) {
  const lb = state.lightbox;
  if (!lb.entry || lb.images.length < 2) return;
  lb.index = (lb.index + delta + lb.images.length) % lb.images.length;
  renderLightbox();
}

function renderLightbox() {
  const lb = state.lightbox;
  const e = lb.entry;
  const item = lb.images[lb.index];
  if (!e || !item) return;
  const img = $('#lightboxImg');
  img.onerror = () => {
    const fallbackSrc = imageItemUrl('image', e, item);
    if (fallbackSrc && fallbackSrc !== img.src && img.dataset.fallbackTried !== '1') {
      img.dataset.fallbackTried = '1';
      img.src = fallbackSrc;
    }
  };
  img.dataset.fallbackTried = '';
  img.src = imageItemUrl('original', e, item) || imageItemUrl('image', e, item);

  $('#lightboxTitle').textContent = e.title;
  $('#lightboxMeta').textContent = `${lb.index + 1} / ${lb.images.length} · ${e.path.join(' › ')}`;
  $('#lightboxTags').textContent = e.tags || '';
  $('#lightboxNegative').textContent = e.negative || '';
  $('#lightboxNote').textContent = e.note || '';
  $('#negativeBlock').hidden = !e.negative;
  $('#noteBlock').hidden = !e.note;

  $('#copyPositive').onclick = ev => { ev.stopPropagation(); copyText(e.tags, `已复制正向：${e.title}`); };
  $('#copyNegative').hidden = !e.negative;
  $('#copyNegative').onclick = ev => { ev.stopPropagation(); copyText(e.negative, `已复制负面：${e.title}`); };
  $('#copyAll').hidden = !e.negative;
  $('#copyAll').onclick = ev => { ev.stopPropagation(); copyText(combinedPrompt(e), `已复制正向+负面：${e.title}`); };
  $('#copyRawTag').hidden = !item.rawTag;
  $('#copyRawTag').onclick = ev => { ev.stopPropagation(); copyText(item.rawTag, `已复制当前图 raw tag：${e.title}`); };

  const prev = $('#lightboxPrev');
  const next = $('#lightboxNext');
  prev.hidden = next.hidden = lb.images.length < 2;
  const thumbs = $('#lightboxThumbs');
  thumbs.innerHTML = '';
  thumbs.hidden = lb.images.length < 2;
  lb.images.forEach((image, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lightbox-thumb' + (i === lb.index ? ' active' : '');
    btn.textContent = String(i + 1);
    btn.onclick = ev => {
      ev.stopPropagation();
      lb.index = i;
      renderLightbox();
    };
    thumbs.appendChild(btn);
  });
}

function isLocalOrigin() {
  return ['localhost', '127.0.0.1', '::1'].includes(location.hostname) || location.protocol === 'file:';
}

function mediaPath(kind, e) {
  const file = kind === 'original' ? e.original : e.image;
  if (!file) return '';
  if (isAbsoluteUrl(file)) return file;
  if (state.codex.assetPathMode === 'relative') {
    return encodeAssetPath(file);
  }
  const prefix = kind === 'original' ? state.media.originalPrefix : state.media.imagePrefix;
  const assetCodexId = e.assetCodexId || state.codex.id;
  return [prefix || (kind === 'original' ? 'originals' : 'images'), assetCodexId, file]
    .map(part => encodeURIComponent(part).replace(/%2F/g, '/'))
    .join('/');
}

function imageItemPath(kind, e, item) {
  const file = kind === 'original' ? (item.original || item.path) : item.path;
  if (!file) return '';
  if (isAbsoluteUrl(file)) return file;
  if (state.codex.assetPathMode === 'relative') return encodeAssetPath(file);
  return mediaPath(kind, { ...e, image: item.path, original: item.original || item.path });
}

function entryImages(e) {
  return (e.images && e.images.length)
    ? e.images
    : (e.image ? [{ path: e.image, original: e.original || e.image }] : []);
}

function isAbsoluteUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) || String(url || '').startsWith('data:');
}

function encodeAssetPath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

function withRev(url, e) {
  if (!url || !e.assetRev) return url;
  return url + (url.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(e.assetRev);
}

function localAssetUrl(kind, e) {
  if (state.codex.assetPathMode === 'relative') return '';
  return withRev(mediaPath(kind, e), e);
}

function assetUrl(kind, e) {
  const path = mediaPath(kind, e);
  if (!path) return '';
  if (isAbsoluteUrl(path)) return withRev(path, e);
  if (state.codex.assetPathMode === 'relative') {
    const base = state.codex.assetBaseUrl;
    return withRev(base ? `${base}/${path}` : path, e);
  }
  if (isLocalOrigin() && state.media.localFallback !== false) return withRev(path, e);
  const base = String(state.media.baseUrl || '').replace(/\/+$/, '');
  return withRev(base ? `${base}/${path}` : path, e);
}

function imageItemUrl(kind, e, item) {
  const path = imageItemPath(kind, e, item);
  if (!path) return '';
  if (isAbsoluteUrl(path)) return withRev(path, e);
  if (state.codex.assetPathMode === 'relative') {
    const base = state.codex.assetBaseUrl;
    return withRev(base ? `${base}/${path}` : path, e);
  }
  return assetUrl(kind, { ...e, image: item.path, original: item.original || item.path });
}

function thumbUrl(e) {
  return assetUrl('image', e);
}

function originalUrl(e) {
  return assetUrl('original', e);
}

/* ---------------- 交互绑定 ---------------- */
function bindUI() {
  let st;
  $('#search').oninput = e => {
    clearTimeout(st);
    st = setTimeout(() => {
      state.query = e.target.value;
      if (state.query.trim()) {
        document.querySelectorAll('.tree-row.active').forEach(r => r.classList.remove('active'));
      }
      applyFilter({ resetScroll: true });
    }, 180);
  };

  $('#onlyImaged').onchange = e => { state.onlyImaged = e.target.checked; applyFilter({ resetScroll: true }); };
  $('#onlyFav').onchange = e => { state.onlyFav = e.target.checked; applyFilter({ resetScroll: true }); };

  const applyTheme = d => {
    document.body.classList.toggle('dark', d);
    $('#themeBtn').innerHTML = d ? THEME_ICONS.sun : THEME_ICONS.moon;
    $('#themeBtn').setAttribute('aria-label', d ? '切换浅色模式' : '切换深色模式');
    localStorage.setItem('fadian-dark', d ? '1' : '0');
  };
  $('#themeBtn').onclick = () => applyTheme(!document.body.classList.contains('dark'));
  applyTheme(localStorage.getItem('fadian-dark') === '1');

  $('#menuBtn').onclick = () => $('#sidebar').classList.toggle('hidden');
  $('#lightbox').onclick = closeLightbox;
  $('#lightboxPanel').onclick = ev => ev.stopPropagation();
  $('#lightboxClose').onclick = closeLightbox;
  $('#lightboxPrev').onclick = ev => { ev.stopPropagation(); stepLightbox(-1); };
  $('#lightboxNext').onclick = ev => { ev.stopPropagation(); stepLightbox(1); };
  window.addEventListener('keydown', ev => {
    if ($('#lightbox').hidden) return;
    if (ev.key === 'Escape') closeLightbox();
    if (ev.key === 'ArrowLeft') stepLightbox(-1);
    if (ev.key === 'ArrowRight') stepLightbox(1);
  });

  window.addEventListener('scroll', scheduleVirtualUpdate, { passive: true });

  /* 智能顶栏：下滑隐藏、上滑立现；搜索聚焦/移动端目录打开时锁定不收 */
  const searchInput = $('#search');
  const mobileQuery = window.matchMedia('(max-width:600px)');
  const setTopbarHidden = hide => document.body.classList.toggle('tb-hidden', hide);
  let lastScrollY = Math.max(0, window.scrollY);
  window.addEventListener('scroll', () => {
    const y = Math.max(0, window.scrollY);
    const dy = y - lastScrollY;
    lastScrollY = y;
    if (Math.abs(dy) < 4) return;
    if (document.activeElement === searchInput) { setTopbarHidden(false); return; }
    if (mobileQuery.matches && !$('#sidebar').classList.contains('hidden')) { setTopbarHidden(false); return; }
    setTopbarHidden(dy > 0 && y > 120);
  }, { passive: true });
  searchInput.addEventListener('focus', () => setTopbarHidden(false));

  window.addEventListener('resize', () => {
    scheduleRelayout(true);
  }, { passive: true });

  if ('ResizeObserver' in window) {
    let lastMainWidth = 0;
    const ro = new ResizeObserver(entries => {
      const width = Math.round(entries[0]?.contentRect?.width || 0);
      if (!width || Math.abs(width - lastMainWidth) < 2) return;
      lastMainWidth = width;
      scheduleRelayout(true);
    });
    ro.observe($('#main'));
  }
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

init();
