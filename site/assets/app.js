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
    const [codexes, media, about] = await Promise.all([
      fetch('data/codexes.json').then(r => r.json()),
      loadMedia(),
      loadAbout(),
    ]);
    state.codexes = codexes;
    state.media = { ...state.media, ...media };
    state.about = about;
    const sel = $('#codexSelect');
    sel.innerHTML = codexes.map(c => `<option value="${c.id}">${esc(c.title)}</option>`).join('');
    sel.onchange = () => loadCodex(sel.value);
    setupCodexPicker();
    setupAbout();
    bindUI();
    if (codexes.length) await loadCodex(codexes[0].id);
    else setLoading('还没有可显示的法典数据');
  } catch (ex) {
    console.error(ex);
    setLoading('加载失败，请刷新页面重试');
  }
}

/* 自绘法典下拉菜单（原生 select 隐藏，仅作值同步） */
function setupCodexPicker() {
  const sel = $('#codexSelect');
  const btn = $('#codexBtn');
  const menu = $('#codexMenu');
  if (!btn || !menu) return;
  const items = () => [...menu.querySelectorAll('.codex-item')];
  const activeIndex = () => Math.max(0, items().findIndex(item => item.classList.contains('active')));
  const focusItem = index => {
    const list = items();
    if (!list.length) return;
    list[(index + list.length) % list.length].focus();
  };
  const open = ({ focus = false, index = activeIndex() } = {}) => {
    menu.hidden = false;
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    if (focus) requestAnimationFrame(() => focusItem(index));
  };
  const close = ({ focusButton = false } = {}) => {
    menu.hidden = true;
    btn.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    if (focusButton) btn.focus();
  };
  const choose = item => {
    if (!item) return;
    close({ focusButton: true });
    if (sel.value !== item.dataset.id) {
      sel.value = item.dataset.id;
      loadCodex(item.dataset.id);
    }
  };
  menu.innerHTML = '';
  state.codexes.forEach((c, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'codex-item';
    item.dataset.id = c.id;
    item.id = `codexOption-${i}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', 'false');
    item.tabIndex = -1;
    item.innerHTML = `<span class="ci-name">${esc(c.title)}</span>` +
      '<svg class="ck" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4 4L19 7"/></svg>';
    item.onclick = () => choose(item);
    menu.appendChild(item);
  });
  btn.onclick = ev => {
    ev.stopPropagation();
    if (menu.hidden) open({ focus: true });
    else close();
  };
  btn.onkeydown = ev => {
    const list = items();
    if (!list.length) return;
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      if (menu.hidden) open({ focus: true });
      else close();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      open({ focus: true, index: menu.hidden ? activeIndex() : activeIndex() + 1 });
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      open({ focus: true, index: menu.hidden ? activeIndex() : activeIndex() - 1 });
    }
  };
  menu.onkeydown = ev => {
    const list = items();
    const current = list.indexOf(document.activeElement);
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close({ focusButton: true });
    } else if (ev.key === 'Tab') {
      close();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      focusItem(current + 1);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      focusItem(current - 1);
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      focusItem(0);
    } else if (ev.key === 'End') {
      ev.preventDefault();
      focusItem(list.length - 1);
    } else if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      choose(document.activeElement.closest('.codex-item'));
    }
  };
  document.addEventListener('click', ev => {
    if (!menu.hidden && !menu.contains(ev.target) && !btn.contains(ev.target)) close();
  });
  window.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && !menu.hidden) close({ focusButton: true });
  });
}

async function loadMedia() {
  try {
    const res = await fetch('data/media.json', { cache: 'no-store' });
    if (res.ok) return res.json();
  } catch {}
  return {};
}

async function loadAbout() {
  try {
    const res = await fetch('data/about.json', { cache: 'no-store' });
    if (res.ok) return res.json();
  } catch {}
  return { links: [], tips: [], credits: [] };
}

let codexLoadSeq = 0;
async function loadCodex(id) {
  const seq = ++codexLoadSeq;
  setLoading('正在加载词条数据…');
  clearMasonry();
  const meta = state.codexes.find(c => c.id === id) || { id };
  const codex = await fetchCodex(meta);
  if (seq !== codexLoadSeq) return;
  state.codex = codex;
  const c = state.codex;
  const codexSelect = $('#codexSelect');
  if (codexSelect) codexSelect.value = c.id;
  $('#codexTitle').textContent = c.title;
  $('#codexMeta').textContent = `${c.author ? c.author + ' · ' : ''}${c.version} · ${c.entryCount} 条`;
  const codexBtnText = $('#codexBtnText');
  if (codexBtnText) codexBtnText.textContent = c.title;
  document.querySelectorAll('#codexMenu .codex-item').forEach(it => {
    const active = it.dataset.id === c.id;
    it.classList.toggle('active', active);
    it.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  state.activePath = [];
  state.query = '';
  $('#search').value = '';
  renderTree();
  renderCodexHeader();
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
    source: meta.source || data.source || '',
    contributors: meta.contributors || data.contributors || [],
    links: meta.links || data.links || [],
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
  if (window.innerWidth <= 600) $('#sidebar').classList.add('closed');
  applyFilter({ resetScroll: true });
}

/* 面包屑点击：按路径找到目录行，展开祖先并选中 */
function selectPathByPath(path) {
  const key = path.join('\u0001');
  for (const row of document.querySelectorAll('.tree-row')) {
    if ((row.dataset.path || '') !== key) continue;
    let item = row.closest('.tree-item');
    while (item) {
      item.classList.remove('collapsed');
      item = item.parentElement ? item.parentElement.closest('.tree-item') : null;
    }
    selectPath(path, row);
    row.scrollIntoView({ block: 'nearest' });
    return;
  }
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
  const box = $('#resultInfo');
  box.innerHTML = '';
  const q = state.query.trim();

  const crumbs = document.createElement('span');
  crumbs.className = 'crumbs';
  const addChip = (label, path, isCurrent) => {
    const chip = document.createElement(isCurrent ? 'span' : 'button');
    chip.className = 'crumb' + (isCurrent ? ' current' : '');
    chip.textContent = label;
    if (!isCurrent) {
      chip.type = 'button';
      chip.onclick = () => selectPathByPath(path);
    }
    crumbs.appendChild(chip);
  };
  const addSep = () => {
    const s = document.createElement('span');
    s.className = 'crumb-sep';
    s.textContent = '›';
    crumbs.appendChild(s);
  };
  if (q) {
    addChip('全部', [], false);
  } else {
    addChip('全部', [], state.activePath.length === 0);
    state.activePath.forEach((seg, i) => {
      addSep();
      addChip(seg, state.activePath.slice(0, i + 1), i === state.activePath.length - 1);
    });
  }
  box.appendChild(crumbs);

  const count = document.createElement('span');
  let t;
  if (q) t = `搜索 “${esc(q)}”：<b>${n}</b> 条结果`;
  else if (state.onlyFav) t = `⭐ 我的收藏：<b>${n}</b> 条`;
  else if (state.activePath.length) t = `<b>${n}</b> 条`;
  else t = `共 <b>${n}</b> 条词条 · ${state.codex.imagedCount} 条已配图`;
  count.innerHTML = t;
  box.appendChild(count);

  $('#empty').hidden = n > 0;
  updateRailActive();
}

/* ---------------- 法典横幅 / 分类轨道 ---------------- */
function renderCodexHeader() {
  const c = state.codex;
  const banner = $('#codexBanner');
  if (!banner) return;
  const cover = c.entries.find(hasEntryImage);
  const pct = c.entryCount ? Math.round((c.imagedCount / c.entryCount) * 100) : 0;
  banner.innerHTML =
    `<div class="banner-cover">${cover ? `<img src="${esc(thumbUrl(cover))}" alt="">` : ''}</div>` +
    `<div class="banner-info">` +
    `<div class="banner-title">${esc(c.title)}</div>` +
    `<div class="banner-meta">${esc(c.author || '')}${c.author ? ' · ' : ''}${esc(c.version || '')}</div>` +
    `<div class="banner-progress"><div class="bp-track"><div class="bp-fill" style="width:${pct}%"></div></div>` +
    `<span class="bp-text">${c.imagedCount} / ${c.entryCount} 已配图</span></div>` +
    `</div>`;
  renderBannerAbout(c, banner);
  const rail = $('#chipRail');
  if (!rail) return;
  rail.innerHTML = '';
  const mkChip = (label, path, count, hue) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'rail-chip';
    chip.dataset.path = path.join('\u0001');
    chip.innerHTML = `<span class="rc-dot" style="background:${hue}"></span>${esc(label)}<span class="rc-n">${count}</span>`;
    chip.onclick = () => selectPathByPath(path);
    rail.appendChild(chip);
  };
  mkChip('全部', [], c.entryCount, 'var(--accent)');
  for (const nd of c.tree) {
    let h = 0;
    for (const ch of nd.name) h = (h * 31 + ch.codePointAt(0)) % 360;
    mkChip(nd.name, [nd.name], nd.count, `hsl(${h},58%,52%)`);
  }
  updateRailActive();
}

function updateRailActive() {
  const rail = $('#chipRail');
  if (!rail) return;
  const head = state.query.trim() ? null : (state.activePath[0] || '');
  rail.querySelectorAll('.rail-chip').forEach(ch => {
    ch.classList.toggle('active', head !== null && (ch.dataset.path || '') === head);
  });
}

/* 法典「关于」气泡：来源 / 贡献者 / 相关链接 */
const EXT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>';

function renderBannerAbout(c, banner) {
  const contributors = Array.isArray(c.contributors) ? c.contributors : [];
  const links = Array.isArray(c.links) ? c.links : [];
  if (!c.source && !contributors.length && !links.length) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'banner-about-btn';
  btn.title = '关于本法典';
  btn.setAttribute('aria-label', '关于本法典');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.25"/><path d="M12 11v4.5"/><path d="M12 8.25h.01"/></svg>';

  const pop = document.createElement('div');
  pop.className = 'banner-pop';
  pop.hidden = true;
  let html = '';
  if (c.source) html += `<div class="bp-sub">来源</div><div class="bp-source">${esc(c.source)}</div>`;
  if (contributors.length) {
    html += '<div class="bp-sub">贡献者</div><div class="bp-contrib">';
    for (const p of contributors) {
      const name = typeof p === 'string' ? p : (p.name || '');
      const role = typeof p === 'string' ? '' : (p.role || '');
      if (!name) continue;
      html += `<span class="bp-chip">${esc(name)}${role ? `<small>${esc(role)}</small>` : ''}</span>`;
    }
    html += '</div>';
  }
  const validLinks = links.filter(l => l && l.url && l.url !== '#');
  if (validLinks.length) {
    html += '<div class="bp-sub">相关链接</div>';
    for (const l of validLinks) {
      html += `<a class="bp-link" href="${esc(l.url)}" target="_blank" rel="noopener">${EXT_ICON}<span>${esc(l.label || l.url)}</span></a>`;
    }
  }
  pop.innerHTML = html;

  btn.onclick = ev => {
    ev.stopPropagation();
    const show = pop.hidden;
    pop.hidden = !show;
    btn.classList.toggle('open', show);
  };
  document.addEventListener('click', ev => {
    if (!pop.hidden && !pop.contains(ev.target) && ev.target !== btn) {
      pop.hidden = true;
      btn.classList.remove('open');
    }
  });

  banner.appendChild(btn);
  banner.appendChild(pop);
}

/* 关于本站（设置框）+ 侧栏小贴士轮播 */
let tipTimer = 0;
let tipIndex = 0;
function setupAbout() {
  const about = state.about || {};
  const links = Array.isArray(about.links) ? about.links : [];
  const tips = Array.isArray(about.tips) ? about.tips : [];
  const credits = Array.isArray(about.credits) ? about.credits : [];

  const intro = $('#aboutIntro');
  if (intro) intro.textContent = about.intro || '';

  const linkBox = $('#aboutLinks');
  if (linkBox) {
    linkBox.innerHTML = '';
    for (const l of links) {
      if (!l || !l.label) continue;
      const real = l.url && l.url !== '#';
      const el = document.createElement(real ? 'a' : 'div');
      el.className = 'about-link';
      if (real) { el.href = l.url; el.target = '_blank'; el.rel = 'noopener'; }
      el.innerHTML =
        `<span class="al-text"><span class="al-label">${esc(l.label)}</span>` +
        `<span class="al-desc">${esc(l.desc || (real ? l.url : '链接待补充'))}</span></span>` +
        (real ? `<span class="al-ext">${EXT_ICON}</span>` : '');
      linkBox.appendChild(el);
    }
  }

  const tipBox = $('#aboutTips');
  if (tipBox) {
    tipBox.innerHTML = '';
    for (const t of tips) {
      const li = document.createElement('li');
      li.textContent = t;
      tipBox.appendChild(li);
    }
  }

  const credBox = $('#aboutCredits');
  if (credBox) {
    credBox.innerHTML = '';
    for (const c of credits) {
      const p = document.createElement('p');
      p.textContent = c;
      credBox.appendChild(p);
    }
  }

  /* 侧栏底：轮播贴士 */
  const foot = $('#sbFoot');
  const tipText = $('#sbTipText');
  if (foot && tipText && tips.length) {
    tipIndex = Math.floor(Math.random() * tips.length);
    tipText.textContent = tips[tipIndex];
    const rotate = () => {
      tipText.classList.add('fade');
      window.setTimeout(() => {
        tipIndex = (tipIndex + 1) % tips.length;
        tipText.textContent = tips[tipIndex];
        tipText.classList.remove('fade');
      }, 280);
    };
    const restart = () => {
      clearInterval(tipTimer);
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        tipTimer = window.setInterval(rotate, 9000);
      }
    };
    $('#sbTip').onclick = () => { rotate(); restart(); };
    restart();
    foot.hidden = false;
  }
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
  const url = thumbUrl(e);
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
    const fallback = localAssetUrl('image', e);
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
    openLightbox(e, 0, wrap.querySelector('.card-img'));
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

/* ---------------- 灯箱（沉浸浮影 + 原位展开） ---------------- */
let lbSeq = 0;
let lbCloseTimer = 0;
let lbSourceImg = null;

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function applyFlyRect(el, rect, radius) {
  el.style.left = rect.left + 'px';
  el.style.top = rect.top + 'px';
  el.style.width = rect.width + 'px';
  el.style.height = rect.height + 'px';
  el.style.borderRadius = radius + 'px';
}

function makeFlyClone(src, rect) {
  const clone = document.createElement('img');
  clone.className = 'lb-fly';
  clone.alt = '';
  clone.decoding = 'sync';
  clone.loading = 'eager';
  clone.src = src;
  applyFlyRect(clone, rect, 14);
  document.body.appendChild(clone);
  void clone.offsetWidth;
  return clone;
}

function clearFlyClones() {
  document.querySelectorAll('.lb-fly').forEach(n => n.remove());
}

function removeFlyCloneAfterPaint(clone) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => clone.remove());
  });
}

function fitStageRect(ratio) {
  const box = $('#lightboxStage').getBoundingClientRect();
  if (!box.width || !box.height) return { left: 0, top: 0, width: 0, height: 0 };
  let w = box.width;
  let h = ratio > 0 ? w / ratio : box.height;
  if (h > box.height) {
    h = box.height;
    w = h * ratio;
  }
  return {
    left: box.left + (box.width - w) / 2,
    top: box.top + (box.height - h) / 2,
    width: w,
    height: h,
  };
}

function resolvedUrl(url) {
  if (!url) return '';
  try {
    return new URL(url, location.href).href;
  } catch {
    return String(url);
  }
}

function flyIn(sourceEl) {
  const lb = $('#lightbox');
  const from = sourceEl.getBoundingClientRect();
  if (!from.width || !from.height) return;
  const ratio = sourceEl.naturalWidth / sourceEl.naturalHeight;
  const target = fitStageRect(ratio);
  if (!target.width) return;
  lb.classList.add('flying');
  const clone = makeFlyClone(sourceEl.currentSrc || sourceEl.src, from);
  requestAnimationFrame(() => applyFlyRect(clone, target, 14));
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    lb.classList.remove('flying');
    removeFlyCloneAfterPaint(clone);
  };
  clone.addEventListener('transitionend', finish, { once: true });
  window.setTimeout(finish, 480);
}

function openLightbox(entry, index = 0, sourceEl = null) {
  const images = entryImages(entry);
  if (!images.length) return;
  state.lightbox = {
    entry,
    images,
    index: clamp(index, 0, images.length - 1),
  };
  lbSourceImg = sourceEl && sourceEl.tagName === 'IMG' ? sourceEl : null;
  const lb = $('#lightbox');
  clearTimeout(lbCloseTimer);
  clearFlyClones();
  lb.classList.remove('flying');
  lb.classList.toggle('folded', localStorage.getItem('fadian-lbinfo') === 'folded');
  lb.classList.toggle('has-thumbs', images.length > 1);
  lb.hidden = false;
  renderLightbox();
  void lb.offsetWidth;
  lb.classList.add('is-open');
  if (lbSourceImg && lbSourceImg.naturalWidth && !prefersReducedMotion()) flyIn(lbSourceImg);
}

function closeLightbox() {
  const lb = $('#lightbox');
  if (lb.hidden) return;
  lbSeq++;
  clearTimeout(lbCloseTimer);
  const done = () => {
    lb.hidden = true;
    lb.classList.remove('is-open', 'flying');
    clearFlyClones();
    const img = $('#lightboxImg');
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');
    state.lightbox = { entry: null, images: [], index: 0 };
    lbSourceImg = null;
  };
  if (prefersReducedMotion()) {
    lb.classList.remove('is-open');
    done();
    return;
  }
  const img = $('#lightboxImg');
  const src = lbSourceImg;
  const flying = lb.classList.contains('flying');
  lb.classList.remove('is-open');
  if (!flying && src && src.isConnected && img.naturalWidth) {
    const from = img.getBoundingClientRect();
    const to = src.getBoundingClientRect();
    if (from.width && to.width && to.bottom > -40 && to.top < window.innerHeight + 40) {
      const clone = makeFlyClone(img.currentSrc || img.src, from);
      lb.classList.add('flying');
      requestAnimationFrame(() => applyFlyRect(clone, to, 12));
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        done();
      };
      clone.addEventListener('transitionend', finish, { once: true });
      lbCloseTimer = window.setTimeout(finish, 460);
      return;
    }
  }
  lbCloseTimer = window.setTimeout(done, 270);
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
  const seq = ++lbSeq;
  const img = $('#lightboxImg');
  const thumbSrc = imageItemUrl('image', e, item);
  const origSrc = imageItemUrl('original', e, item);
  const origAbs = resolvedUrl(origSrc);
  img.onload = null;
  img.onerror = () => {
    if (seq !== lbSeq) return;
    if (origSrc && resolvedUrl(img.currentSrc || img.src) !== origAbs) img.src = origSrc;
  };
  /* 垫底加载：先上缩略图，原图加载完成后替换 */
  const showImage = () => {
    if (seq !== lbSeq) return;
    img.src = thumbSrc || origSrc;
    if (origSrc && origSrc !== thumbSrc) {
      const pre = new Image();
      pre.onload = () => {
        if (seq === lbSeq && state.lightbox.entry === e) img.src = origSrc;
      };
      pre.src = origSrc;
    }
  };
  showImage();

  $('#lightboxTitle').textContent = e.title;
  $('#lightboxMeta').textContent = `${lb.index + 1} / ${lb.images.length} · ${e.path.join(' › ')}`;

  const credit = item.credit || item.author || e.credit || e.author || '';
  const creditUrl = item.creditUrl || item.authorUrl || e.creditUrl || e.authorUrl || '';
  const creditEl = $('#lightboxCredit');
  if (credit) {
    creditEl.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M5 20a7 7 0 0 1 14 0"/></svg>' +
      `<span>${esc(credit)}</span>`;
    if (creditUrl) { creditEl.href = creditUrl; creditEl.target = '_blank'; creditEl.rel = 'noopener'; }
    else creditEl.removeAttribute('href');
    creditEl.hidden = false;
  } else {
    creditEl.hidden = true;
    creditEl.removeAttribute('href');
  }

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
  if (!thumbs.hidden) {
    lb.images.forEach((image, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lightbox-thumb' + (i === lb.index ? ' active' : '');
      btn.title = `第 ${i + 1} 张`;
      const ti = document.createElement('img');
      ti.alt = '';
      ti.loading = 'lazy';
      ti.src = imageItemUrl('image', e, image) || imageItemUrl('original', e, image);
      btn.appendChild(ti);
      btn.onclick = ev => {
        ev.stopPropagation();
        if (lb.index === i) return;
        lb.index = i;
        renderLightbox();
      };
      thumbs.appendChild(btn);
    });
    const act = thumbs.querySelector('.lightbox-thumb.active');
    if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
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

  const sidebar = $('#sidebar');
  const savedSidebar = localStorage.getItem('fadian-sidebar');
  if (savedSidebar === 'closed' || (savedSidebar === null && window.innerWidth <= 600)) {
    sidebar.classList.add('closed');
  }
  $('#menuBtn').onclick = () => {
    sidebar.classList.toggle('closed');
    localStorage.setItem('fadian-sidebar', sidebar.classList.contains('closed') ? 'closed' : 'open');
  };

  /* 设置 / 关于 悬浮框：开关三件套（按钮/遮罩/Esc） */
  const settingsMask = $('#settings');
  const aboutMask = $('#about');
  $('#settingsBtn').onclick = () => { settingsMask.hidden = false; };
  $('#settingsClose').onclick = () => { settingsMask.hidden = true; };
  settingsMask.onclick = ev => { if (ev.target === settingsMask) settingsMask.hidden = true; };
  $('#aboutBtn').onclick = () => { aboutMask.hidden = false; };
  $('#aboutClose').onclick = () => { aboutMask.hidden = true; };
  aboutMask.onclick = ev => { if (ev.target === aboutMask) aboutMask.hidden = true; };
  window.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    if (!settingsMask.hidden) settingsMask.hidden = true;
    if (!aboutMask.hidden) aboutMask.hidden = true;
  });
  $('#lightbox').onclick = ev => {
    if (ev.target.id === 'lightbox' || ev.target.id === 'lightboxStage') closeLightbox();
  };
  $('#lightboxFold').onclick = ev => {
    ev.stopPropagation();
    const lbEl = $('#lightbox');
    lbEl.classList.toggle('folded');
    localStorage.setItem('fadian-lbinfo', lbEl.classList.contains('folded') ? 'folded' : 'open');
  };
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
  const backTopBtn = $('#backTop');
  const mobileQuery = window.matchMedia('(max-width:600px)');
  const setTopbarHidden = hide => document.body.classList.toggle('tb-hidden', hide);
  let lastScrollY = Math.max(0, window.scrollY);
  window.addEventListener('scroll', () => {
    const y = Math.max(0, window.scrollY);
    const dy = y - lastScrollY;
    lastScrollY = y;
    backTopBtn.classList.toggle('show', y > 800);
    if (Math.abs(dy) < 4) return;
    if (document.activeElement === searchInput) { setTopbarHidden(false); return; }
    if (mobileQuery.matches && !sidebar.classList.contains('closed')) { setTopbarHidden(false); return; }
    setTopbarHidden(dy > 0 && y > 120);
  }, { passive: true });
  searchInput.addEventListener('focus', () => setTopbarHidden(false));

  /* 分类轨道：纵向滚轮转横向滚动 */
  const rail = $('#chipRail');
  if (rail) rail.addEventListener('wheel', ev => {
    if (!ev.deltaY) return;
    ev.preventDefault();
    rail.scrollLeft += ev.deltaY;
  }, { passive: false });

  backTopBtn.onclick = () => {
    setTopbarHidden(false);
    backTopBtn.classList.remove('show');
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  };

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
