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
  activeTags: new Set(),
  query: '',
  showNSFW: localStorage.getItem('strings-nsfw') === 'true',
  loadedImages: new Set(),
  media: null,
};

const svgCopy = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

async function init() {
  bindUI();
  applyTheme(localStorage.getItem('strings-dark') === 'true');
  updateNSFWBtn();

  try {
    const [data, media] = await Promise.all([
      fetch('data/strings.json?_=' + Date.now()).then(r => r.json()),
      loadMedia(),
    ]);
    state.data = data;
    state.media = media;
    state.entries = data.entries || [];

    buildTagUI();
    updateNSFWTooltip();
    applyFilter({ scrollUp: true });

  } catch (e) {
    console.error(e);
    const empty = $('#empty');
    if (empty) { empty.hidden = false; const sp = empty.querySelector('span'); if (sp) sp.textContent = '数据加载失败，请检查 strings.json'; }
  }
}

async function loadMedia() {
  try {
    const res = await fetch('data/media.json', { cache: 'no-store' });
    if (res.ok) return res.json();
  } catch {}
  return { baseUrl: '', imagePrefix: 'images', originalPrefix: 'originals', localFallback: true };
}

function buildTagUI() {
  const all = new Set();
  for (const e of state.entries) {
    for (const t of e.tags || []) all.add(t);
  }
  const sorted = [...all].sort();
  const grid = $('#tagGrid');
  grid.innerHTML = sorted.map(t => {
    const n = state.entries.filter(e => (e.tags || []).includes(t)).length;
    return `<button class="tag-btn" data-tag="${escAttr(t)}">${escHtml(t)}<span class="tag-count">${n}</span></button>`;
  }).join('');

  $$('.tag-btn', grid).forEach(btn => {
    btn.onclick = () => {
      const tag = btn.dataset.tag;
      if (state.activeTags.has(tag)) state.activeTags.delete(tag);
      else state.activeTags.add(tag);
      btn.classList.toggle('on', state.activeTags.has(tag));
      updateClearBtn();
      applyFilter({ scrollUp: true });
    };
  });
  updateClearBtn();
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

  if (state.activeTags.size > 0) {
    list = list.filter(e => {
      const et = new Set((e.tags || []).map(t => t.toLowerCase()));
      return [...state.activeTags].every(t => et.has(t.toLowerCase()));
    });
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
  if (state.query) parts.push(`搜索 "${escHtml(state.query)}"`);
  if (state.activeTags.size > 0) parts.push(`标签: ${[...state.activeTags].map(escHtml).join(' + ')}`);
  parts.push(`<b>${n}</b> 条画师串`);
  $('#resultInfo').innerHTML = parts.join(' · ');
  $('#empty').hidden = n > 0;
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
    const imgH = estimateImgH(entry, itemW);
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

function estimateImgH(e, w) {
  if (!(e.images && e.images.length)) return 0;
  return Math.round(w * DEFAULT_IMG_RATIO);
}
function estimateBodyH(e, w) {
  const titleLines = Math.min(2, Math.ceil((e.title || '').length / Math.max(10, Math.floor(w / 14))));
  const tagLines = (e.tags || []).length > 0 ? 1 : 0;
  return titleLines * 21 + tagLines * 24 + 42;
}

let vRaf = 0;
function scheduleVirtual() {
  if (vRaf) return;
  vRaf = requestAnimationFrame(() => { vRaf = 0; updateVirtualCards(); });
}

function updateVirtualCards(force = false) {
  const m = $('#masonry');
  if (!m || !state.placements.length) { state.rendered = 0; return; }

  const rect = m.getBoundingClientRect();
  const vTop = -rect.top;
  const vH = window.innerHeight || document.documentElement.clientHeight;
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

  if (e.images && e.images.length) {
    setupImage(node, p);
    const cnt = node.querySelector('.image-count');
    if (cnt) cnt.textContent = e.images.length + ' 图';
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

function setupImage(node, p) {
  const e = p.entry;
  const wrap = node.querySelector('.card-img-wrap');
  const img = node.querySelector('.card-img');
  if (!e.images || !e.images.length) return;

  const file = e.images[0];
  const url = thumbUrl(file);

  wrap.hidden = false;
  wrap.style.height = p.imgH + 'px';
  wrap.classList.add('loading');
  img.alt = e.title;

  const markOk = () => {
    state.loadedImages.add(url);
    wrap.classList.remove('loading', 'error');
    img.classList.add('loaded');
  };

  node._timer = setTimeout(() => {
    node._timer = 0;
    img.src = url;
    img.onload = markOk;
    img.onerror = () => {
      wrap.classList.remove('loading');
      wrap.classList.add('error');
    };
  }, IMG_DELAY);

  wrap.querySelector('.zoom-btn').onclick = ev => {
    ev.stopPropagation();
    openLightbox(originalUrl(file) || url);
  };
}

function cleanupCard(node) {
  if (node._timer) { clearTimeout(node._timer); node._timer = 0; }
}

function thumbUrl(file) {
  const path = [state.media.imagePrefix, 'strings', file].map(p => encodeURIComponent(p).replace(/%2F/g, '/')).join('/');
  if (isLocal()) return withRev(path);
  const base = String(state.media.baseUrl || '').replace(/\/+$/, '');
  return withRev(base ? `${base}/${path}` : path);
}

function originalUrl(file) {
  const path = [state.media.originalPrefix, 'strings', file].map(p => encodeURIComponent(p).replace(/%2F/g, '/')).join('/');
  if (isLocal()) return path;
  const base = String(state.media.baseUrl || '').replace(/\/+$/, '');
  return base ? `${base}/${path}` : path;
}

function withRev(url) { return url + (url.includes('?') ? '&' : '?') + 'v=' + Date.now(); }
function isLocal() { return ['localhost', '127.0.0.1', '::1'].includes(location.hostname) || location.protocol === 'file:'; }

/* ---- Detail panel ---- */
function openDetail(idx) {
  const e = state.filtered[idx];
  if (!e) return;
  removeDetail();

  const overlay = document.createElement('div');
  overlay.className = 'detail-overlay';
  overlay.id = 'detailOverlay';

  const imagesHtml = (e.images && e.images.length) ? e.images.map(f => {
    const isNsfw = e.nsfw && !state.showNSFW;
    return `
      <div class="detail-img-card" data-img="${escAttr(f)}">
        ${e.nsfw ? '<div class="nsfw-flag">NSFW</div>' : ''}
        <img src="${thumbUrl(f)}" alt="" loading="lazy">
      </div>`;
  }).join('') : '<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--muted)">暂无例图</div>';

  overlay.innerHTML = `
    <div class="detail-panel">
      <button class="detail-close">✕</button>
      <div class="detail-body">
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
          <h4>例图 (${(e.images||[]).length})</h4>
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
      openLightbox(originalUrl(f) || thumbUrl(f));
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
  t.textContent = '✓ ' + msg;
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

  $('#clearTags').onclick = () => {
    state.activeTags.clear();
    $$('.tag-btn').forEach(b => b.classList.remove('on'));
    updateClearBtn();
    applyFilter({ scrollUp: true });
  };

  $('#nsfwBtn').onclick = () => {
    state.showNSFW = !state.showNSFW;
    localStorage.setItem('strings-nsfw', String(state.showNSFW));
    updateNSFWBtn();
    applyFilter({ scrollUp: true });
  };
  updateNSFWTooltip();

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

function updateClearBtn() {
  const hasTags = state.activeTags.size > 0;
  const btn = $('#clearTags');
  const hint = $('#tagHint');
  if (btn) btn.hidden = !hasTags;
  if (hint) hint.hidden = hasTags;
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
function scheduleRelayout(anim = true) {
  if (relayoutTimer) return;
  const delay = Math.max(0, 60 - (performance.now() - lastRelayout));
  relayoutTimer = setTimeout(() => {
    relayoutTimer = 0;
    lastRelayout = performance.now();
    if (anim) {
      const m = $('#masonry');
      if (m) { m.classList.add('relayout'); void m.offsetWidth; }
    }
    computeLayout();
    updateVirtualCards(true);
  }, delay);
}

/* ---- Utils ---- */
function escHtml(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function escAttr(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

init();
