'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const CARD_MIN_W = 280;
const GAP = 16;
const VIRT_BUF_UP = 0.8;
const VIRT_BUF_DOWN = 1.4;
const IMG_DELAY = 80;
const DEFAULT_IMG_RATIO = 1.18;

const state = {
  data: null,
  entries: [],
  filtered: [],
  placements: [],
  rendered: 0,
  nodes: new Map(),
  colN: 0,
  itemW: 0,
  activePath: null,
  activeCollection: null,
  collections: [],
  viewMode: 'all',
  query: '',
  showNSFW: localStorage.getItem('strings-nsfw') === 'true',
  loadedImages: new Set(),
  treeData: [],
};

const svgCopy = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function normImg(img) { return typeof img === 'string' ? { file: img, label: 'gallery' } : img; }

async function init() {
  bindUI();
  applyTheme(localStorage.getItem('strings-dark') === 'true');
  updateNSFWBtn();

  try {
    const idx = await fetch('data/strings_index.json?_=' + Date.now()).then(r => r.json());
    state.collections = idx.collections || [];

    const sel = $('#stringsSelect');
    sel.innerHTML = state.collections.map((c, i) =>
      `<option value="${i}">${escHtml(c.name)}</option>`
    ).join('');
    sel.onchange = () => {
      const ci = parseInt(sel.value);
      if (state.collections[ci]) {
        state.activeCollection = state.collections[ci];
        localStorage.setItem('strings-collection', state.activeCollection.id);
        loadCollection(state.activeCollection.file);
      }
    };

    const lastId = localStorage.getItem('strings-collection');
    let idx2 = 0;
    if (lastId) {
      const found = state.collections.findIndex(c => c.id === lastId);
      if (found >= 0) idx2 = found;
    }
    sel.value = String(idx2);
    state.activeCollection = state.collections[idx2];
    await loadCollection(state.activeCollection.file);

  } catch (e) {
    console.error(e);
    const empty = $('#empty');
    if (empty) { empty.hidden = false; const sp = empty.querySelector('span'); if (sp) sp.textContent = '数据加载失败，请检查配置'; }
  }
}

async function loadCollection(file) {
  try {
    const data = await fetch('data/' + file + '?_=' + Date.now()).then(r => r.json());
    state.data = data;
    state.entries = (data.entries || []).map(e => ({
      ...e,
      images: (e.images || []).map(normImg)
    }));
    state.activePath = null;
    buildTree();
    updateNSFWTooltip();
    applyFilter({ scrollUp: true });
  } catch (e) {
    console.error('Failed to load', file, e);
  }
}

function buildTree() {
  const categories = state.data.categories || [];
  const root = { name: '全部', path: null, count: state.entries.length, children: [] };

  const nodeMap = new Map();
  nodeMap.set(null, root);

  for (const cat of categories) {
    const segs = String(cat).split('/').filter(Boolean);
    let parent = root;
    let curPath = '';

    for (const seg of segs) {
      curPath = curPath ? `${curPath}/${seg}` : seg;
      let node = nodeMap.get(curPath);
      if (!node) {
        node = { name: seg, path: curPath, count: 0, children: [] };
        parent.children.push(node);
        nodeMap.set(curPath, node);
      }
      parent = node;
    }
  }

  for (const [path, node] of nodeMap) {
    if (!path) continue;
    const segs = path.split('/');
    node.count = state.entries.filter(e => {
      const cat = e.category || [];
      return segs.length <= cat.length && segs.every((s, i) => cat[i] === s);
    }).length;
  }

  state.treeData = [root];
  renderTree();
}

function renderTree() {
  const tree = $('#tree');
  tree.innerHTML = '';

  for (const node of state.treeData) {
    tree.appendChild(renderTreeNode(node, true));
  }

  const activeItem = tree.querySelector(`[data-path="${escAttr(state.activePath || '')}"]`);
  if (activeItem) {
    const row = activeItem.querySelector('.tree-row');
    if (row) row.classList.add('active');
  }
}

function renderTreeNode(node, expanded) {
  const item = document.createElement('div');
  item.className = `tree-item${expanded ? '' : ' collapsed'}`;
  item.dataset.path = node.path || '';

  const row = document.createElement('div');
  row.className = 'tree-row';

  const arrow = document.createElement('span');
  arrow.className = 'tw-arrow';
  arrow.textContent = node.children.length ? '▾' : '';

  const name = document.createElement('span');
  name.className = 'tw-name';
  name.textContent = node.name;

  const count = document.createElement('span');
  count.className = 'tw-count';
  count.textContent = node.count || '';

  row.append(arrow, name, count);
  row.onclick = (ev) => {
    ev.stopPropagation();
    if (node.children.length) {
      item.classList.toggle('collapsed');
    }
    $$('.tree-row.active').forEach(r => r.classList.remove('active'));
    row.classList.add('active');
    state.activePath = node.path;
    applyFilter({ scrollUp: true });
  };

  item.appendChild(row);

  if (node.children.length) {
    const children = document.createElement('div');
    children.className = 'tree-children';
    for (const child of node.children) {
      children.appendChild(renderTreeNode(child, true));
    }
    item.appendChild(children);
  }

  return item;
}

function applyFilter({ scrollUp = false } = {}) {
  let list = [...state.entries];
  const q = state.query.trim().toLowerCase();

  if (q) {
    list = list.filter(e =>
      (e.title || '').toLowerCase().includes(q) ||
      (e.prompt || '').toLowerCase().includes(q) ||
      (e.comment || '').toLowerCase().includes(q) ||
      (e.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }

  if (state.activePath) {
    const segs = state.activePath.split('/');
    list = list.filter(e => {
      const cat = e.category || [];
      return segs.length <= cat.length && segs.every((s, i) => cat[i] === s);
    });
  }

  if (state.viewMode !== 'all') {
    list = list.filter(e =>
      (e.images || []).some(img => (img.label || 'gallery') === state.viewMode)
    );
  }

  if (!state.showNSFW) list = list.filter(e => !e.nsfw);

  state.filtered = list;
  updateResultBar(list.length);
  clearMasonry();
  if (scrollUp) window.scrollTo({ top: 0, behavior: 'auto' });
  computeLayout();
  updateVirtualCards(true);
}

function updateResultBar(n) {
  const parts = [];
  if (state.activePath) parts.push(`分类: ${state.activePath}`);
  if (state.query) parts.push(`搜索 "${escHtml(state.query)}"`);
  if (state.viewMode !== 'all') {
    const names = { face: '面部', scene: '场景', nsfw: 'NSFW', gallery: '图库' };
    parts.push(`视图: ${names[state.viewMode] || state.viewMode}`);
  }
  parts.push(`<b>${n}</b> 条画师串`);
  $('#resultInfo').innerHTML = parts.join(' · ');
  $('#empty').hidden = n > 0;
}

function vidx(entry) {
  if (state.viewMode === 'all') return 0;
  return (entry.images || []).findIndex(img => (img.label || 'gallery') === state.viewMode);
}

function vimg(entry) {
  const idx = vidx(entry);
  return idx >= 0 ? entry.images[idx] : null;
}

/* ---- Virtual Masonry ---- */
function colCount() {
  const m = $('#masonry');
  const w = (m ? m.clientWidth : 0) || ($('#main')?.clientWidth || 1);
  return Math.max(1, Math.floor((w + GAP) / (CARD_MIN_W + GAP)));
}

function clearMasonry() {
  for (const node of state.nodes.values()) cleanupCard(node);
  state.nodes.clear();
  state.placements = [];
  state.rendered = 0;
  const m = $('#masonry');
  if (m) { m.innerHTML = ''; m.style.height = '0px'; }
}

function computeLayout() {
  const m = $('#masonry');
  if (!m) return;
  const width = Math.max(1, m.clientWidth || ($('#main')?.clientWidth || 1));
  const n = colCount();
  const itemW = Math.max(200, Math.floor((width - GAP * (n - 1)) / n));
  const colHeights = Array(n).fill(0);
  const placements = [];

  for (let i = 0; i < state.filtered.length; i++) {
    const entry = state.filtered[i];
    const col = colHeights.indexOf(Math.min(...colHeights));
    const hasImg = vimg(entry) !== null;
    const imgH = hasImg ? Math.round(itemW * DEFAULT_IMG_RATIO) : 0;
    const bodyH = estimateBodyH(entry, itemW);
    const h = Math.ceil((imgH > 0 ? imgH : 0) + bodyH);
    const left = col * (itemW + GAP);
    const top = colHeights[col];

    placements.push(Object.freeze({ index: i, entry, left, top, width: itemW, height: h, imgH }));
    colHeights[col] += h + GAP;
  }

  state.placements = placements;
  state.colN = n;
  state.itemW = itemW;
  const totalH = placements.length ? Math.max(...colHeights) - GAP : 0;
  m.style.height = Math.ceil(Math.max(0, totalH)) + 'px';
}

function estimateBodyH(e, w) {
  const titleLines = Math.min(2, Math.ceil((e.title || '').length / Math.max(10, Math.floor(w / 14))));
  const tagLines = (e.tags || []).length > 0 ? 1 : 0;
  return titleLines * 22 + tagLines * 18 + 52;
}

let vRaf = 0;
function scheduleVirtual() {
  if (vRaf) return;
  vRaf = requestAnimationFrame(() => { vRaf = 0; updateVirtualCards(); });
}

function clampNum(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function masonryViewport(m) {
  const rect = m.getBoundingClientRect();
  const vH = window.innerHeight || document.documentElement.clientHeight;
  const totalH = m.offsetHeight || parseFloat(m.style.height) || 0;
  const maxTop = Math.max(0, totalH - vH);
  const rawTop = -rect.top;
  return { rect, vH, rawTop, top: clampNum(rawTop, 0, maxTop) };
}

function updateVirtualCards(force = false) {
  const m = $('#masonry');
  if (!m || !state.placements.length) { state.rendered = 0; return; }

  const view = masonryViewport(m);
  const vTop = view.top;
  const vH = view.vH;
  const rTop = Math.max(0, vTop - vH * VIRT_BUF_UP);
  const rBot = vTop + vH * (1 + VIRT_BUF_DOWN);
  const next = new Set();

  for (const p of state.placements) {
    if (p.top + p.height < rTop || p.top > rBot) continue;
    next.add(p.index);
    let node = state.nodes.get(p.index);
    if (!node) {
      node = makeCard(p);
      state.nodes.set(p.index, node);
      m.appendChild(node);
    } else if (force) {
      updateCardPos(node, p);
    }
  }

  for (const [idx, node] of state.nodes) {
    if (next.has(idx)) continue;
    if (force && relayoutAnimating) {
      const placement = state.placements[idx];
      if (placement) updateCardPos(node, placement);
      continue;
    }
    cleanupCard(node);
    node.remove();
    state.nodes.delete(idx);
  }
  state.rendered = next.size;
}

function makeCard(p) {
  const e = p.entry;
  const node = $('#cardTpl').content.firstElementChild.cloneNode(true);
  node.dataset.index = String(p.index);
  updateCardPos(node, p);

  node.querySelector('.card-title').textContent = e.title;

  const tagsRow = node.querySelector('.card-tags-row');
  if (e.tags && e.tags.length) {
    tagsRow.innerHTML = e.tags.slice(0, 4).map(t => `<span class="card-tag">${escHtml(t)}</span>`).join('');
  }

  if (e.nsfw) {
    const badge = document.createElement('div');
    badge.className = 'nsfw-badge';
    badge.textContent = 'NSFW';
    node.querySelector('.card-img-wrap')?.appendChild(badge);
  }

  const cnt = node.querySelector('.card-count');
  if (cnt) cnt.textContent = (e.images && e.images.length) ? e.images.length + ' 张图' : '无例图';

  const img = vimg(e);
  if (img) {
    setupImage(node, p, img);
  } else {
    node.classList.add('no-img');
  }

  node.onclick = () => openDetail(p.index);
  return node;
}

function updateCardPos(node, p) {
  node.style.width = p.width + 'px';
  node.style.height = p.height + 'px';
  node.style.transform = `translate3d(${p.left}px,${p.top}px,0)`;
  const wrap = node.querySelector('.card-img-wrap');
  if (wrap && p.imgH) wrap.style.height = p.imgH + 'px';
}

function setupImage(node, p, img) {
  const e = p.entry;
  const wrap = node.querySelector('.card-img-wrap');
  const imgEl = node.querySelector('.card-img');
  const url = thumbUrl(img.file);

  wrap.hidden = false;
  wrap.style.height = p.imgH + 'px';
  wrap.classList.add('loading');
  imgEl.alt = e.title;

  const markOk = () => {
    state.loadedImages.add(url);
    wrap.classList.remove('loading', 'error');
    imgEl.classList.add('loaded');
  };

  node._timer = setTimeout(() => {
    node._timer = 0;
    imgEl.src = url;
    imgEl.onload = markOk;
    imgEl.onerror = () => {
      wrap.classList.remove('loading');
      wrap.classList.add('error');
    };
  }, IMG_DELAY);

  wrap.querySelector('.zoom-btn').onclick = ev => {
    ev.stopPropagation();
    openLightbox(url);
  };
}

function cleanupCard(node) {
  if (node._timer) { clearTimeout(node._timer); node._timer = 0; }
}

const STRINGS_R2_BASE = 'https://pub-c1d79beb70aa4807a6803a6fdd5237f8.r2.dev';

function thumbUrl(file) {
  const path = ['images', 'strings', file].map(p => encodeURIComponent(p).replace(/%2F/g, '/')).join('/');
  if (isLocal()) return path;
  return `${STRINGS_R2_BASE}/${path}`;
}

function isLocal() { return ['localhost', '127.0.0.1', '::1'].includes(location.hostname) || location.protocol === 'file:'; }

/* ---- Detail panel ---- */
function openDetail(idx) {
  const e = state.filtered[idx];
  if (!e) return;
  removeDetail();

  const overlay = document.createElement('div');
  overlay.className = 'detail-overlay';
  overlay.id = 'detailOverlay';

  const imgs = e.images || [];
  const imagesHtml = imgs.length ? imgs.map(img => {
    const file = img.file || img;
    const label = img.label || 'gallery';
    const labelNames = { face: '面部', scene: '场景', nsfw: 'NSFW', gallery: '图库' };
    return `
      <div class="detail-img-card" data-img="${escAttr(file)}">
        ${e.nsfw ? '<div class="nsfw-flag">NSFW</div>' : ''}
        <div class="img-label-tag" style="position:absolute;bottom:8px;left:8px;background:rgba(0,0,0,.6);color:#fff;font-size:10px;padding:2px 8px;border-radius:6px;font-weight:600;backdrop-filter:blur(4px);z-index:1">${labelNames[label] || label}</div>
        <img src="${thumbUrl(file)}" alt="" loading="lazy">
      </div>`;
  }).join('') : '<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--muted)">暂无例图</div>';

  const catPath = (e.category || []).join('/') || '未分类';

  overlay.innerHTML = `
    <div class="detail-panel">
      <button class="detail-close">✕</button>
      <div class="detail-body">
        <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:4px">${escHtml(catPath)}</div>
        <h2 class="detail-title">${escHtml(e.title)}</h2>
        <div class="detail-tags">${(e.tags||[]).map(t=>`<span class="detail-tag">${escHtml(t)}</span>`).join('')}</div>

        <div class="detail-section">
          <h4>Prompt</h4>
          <div class="prompt-box">
            <span class="prompt-text">${escHtml(e.prompt)}</span>
            <button class="copy">${svgCopy} 复制</button>
          </div>
        </div>

        ${e.comment ? `
        <div class="detail-section">
          <h4>评价 / 备注</h4>
          <div class="comment-box">${escHtml(e.comment)}</div>
        </div>` : ''}

        <div class="detail-section">
          <h4>例图 (${imgs.length})</h4>
          <div class="detail-images">${imagesHtml}</div>
        </div>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  overlay.querySelector('.detail-close').onclick = removeDetail;
  overlay.onclick = ev => { if (ev.target === overlay) removeDetail(); };
  overlay.querySelector('.copy').onclick = ev => {
    ev.stopPropagation();
    navigator.clipboard.writeText(e.prompt).then(() => toast('已复制 Prompt'));
  };

  overlay.querySelectorAll('.detail-img-card').forEach(card => {
    card.onclick = () => {
      const f = card.dataset.img;
      openLightbox(thumbUrl(f));
    };
  });
}

function removeDetail() {
  const el = $('#detailOverlay');
  if (el) el.remove();
}

/* ---- Lightbox ---- */
function openLightbox(src) {
  const lb = $('#lightbox');
  const img = $('#lightboxImg');
  img.src = src;
  lb.classList.add('on');
}

/* ---- Toast ---- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = '\u2713 ' + msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ---- UI binding ---- */
function bindUI() {
  let st;
  $('#search').oninput = e => {
    clearTimeout(st);
    st = setTimeout(() => {
      state.query = e.target.value;
      applyFilter({ scrollUp: true });
    }, 180);
  };

  $('#nsfwBtn').onclick = () => {
    state.showNSFW = !state.showNSFW;
    localStorage.setItem('strings-nsfw', String(state.showNSFW));
    updateNSFWBtn();
    applyFilter({ scrollUp: true });
  };
  updateNSFWTooltip();

  $$('#viewTabs .view-tab').forEach(btn => {
    btn.onclick = () => {
      $$('#viewTabs .view-tab').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      state.viewMode = btn.dataset.view;
      applyFilter({ scrollUp: true });
    };
  });

  $('#themeBtn').onclick = () => applyTheme(!document.body.classList.contains('dark'));
  $('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');
  $('#lightbox').onclick = () => { $('#lightbox').classList.remove('on'); $('#lightboxImg').src = ''; };

  window.addEventListener('scroll', scheduleVirtual, { passive: true });
  window.addEventListener('resize', () => scheduleRelayout(true), { passive: true });

  if ('ResizeObserver' in window) {
    let lastW = 0;
    const ro = new ResizeObserver(entries => {
      const w = Math.round(entries[0]?.contentRect?.width || 0);
      if (!w || Math.abs(w - lastW) < 2) return;
      lastW = w;
      scheduleRelayout(true);
    });
    ro.observe($('#main'));
  }
}

function applyTheme(dark) {
  document.body.classList.toggle('dark', dark);
  localStorage.setItem('strings-dark', dark ? 'true' : 'false');
}

function updateNSFWBtn() {
  const btn = $('#nsfwBtn');
  btn.classList.toggle('active', state.showNSFW);
}
function updateNSFWTooltip() {
  const n = state.entries.filter(e => e.nsfw).length;
  const btn = $('#nsfwBtn');
  const label = state.showNSFW ? `已开启 · ${n} 条 NSFW 可见` : `已关闭 · 隐藏了 ${n} 条 NSFW`;
  btn.setAttribute('title', label);
}

let relayoutTimer = 0;
let lastRelayout = 0;
let relayoutAnimTimer = 0;
let relayoutAnimating = false;

function startRelayoutAnimation(anim) {
  const m = $('#masonry');
  if (!anim || !m || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  relayoutAnimating = true;
  m.classList.add('relayout');
  void m.offsetWidth;
  clearTimeout(relayoutAnimTimer);
  relayoutAnimTimer = setTimeout(() => {
    relayoutAnimating = false;
    m.classList.remove('relayout');
    updateVirtualCards(true);
  }, 480);
}

function scheduleRelayout(anim = true) {
  if (relayoutTimer) return;
  const delay = Math.max(0, 60 - (performance.now() - lastRelayout));
  relayoutTimer = setTimeout(() => {
    relayoutTimer = 0;
    lastRelayout = performance.now();
    startRelayoutAnimation(anim);
    computeLayout();
    updateVirtualCards(true);
  }, delay);
}

/* ---- Utils ---- */
function escHtml(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function escAttr(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

init();
