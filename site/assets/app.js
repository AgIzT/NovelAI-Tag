'use strict';
const $ = (s, r = document) => r.querySelector(s);
const CHUNK = 80;

const state = {
  codex: null,        // 当前法典数据
  list: [],           // 当前过滤后的词条
  rendered: 0,        // 已渲染数量
  cols: [],           // 瀑布流列元素
  colN: 0,
  activePath: [],     // 选中的目录路径
  query: '',
  onlyImaged: false,
};

const THEME_ICONS = {
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8Z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
};

/* ---------------- 数据加载 ---------------- */
async function init() {
  const codexes = await fetch('data/codexes.json').then(r => r.json());
  const sel = $('#codexSelect');
  sel.innerHTML = codexes.map(c => `<option value="${c.id}">${c.title}</option>`).join('');
  sel.onchange = () => loadCodex(sel.value);
  bindUI();
  if (codexes.length) await loadCodex(codexes[0].id);
}

async function loadCodex(id) {
  state.codex = await fetch(`data/${id}.json`).then(r => r.json());
  const c = state.codex;
  $('#codexTitle').textContent = c.title;
  $('#codexMeta').textContent = `${c.author ? c.author + ' · ' : ''}${c.version} · ${c.entryCount} 条`;
  state.activePath = []; state.query = ''; $('#search').value = '';
  renderTree();
  applyFilter();
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
    row.dataset.path = path.join('');
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
  state.query = ''; $('#search').value = '';
  document.querySelectorAll('.tree-row.active').forEach(r => r.classList.remove('active'));
  rowEl.classList.add('active');
  if (window.innerWidth <= 600) $('#sidebar').classList.add('hidden');
  applyFilter();
}

/* ---------------- 过滤 ---------------- */
function applyFilter() {
  const q = state.query.trim().toLowerCase();
  let list = state.codex.entries;
  if (q) {
    list = list.filter(e => e.title.toLowerCase().includes(q) || e.tags.toLowerCase().includes(q));
  } else if (state.activePath.length) {
    const p = state.activePath;
    list = list.filter(e => p.every((seg, i) => e.path[i] === seg));
  }
  if (state.onlyImaged) list = list.filter(e => e.image);
  state.list = list;
  updateResultBar();
  renderList();
}

function updateResultBar() {
  const n = state.list.length;
  let t;
  if (state.query.trim()) t = `搜索 “${esc(state.query.trim())}”：<b>${n}</b> 条结果`;
  else if (state.activePath.length) t = `${esc(state.activePath.join(' › '))}：<b>${n}</b> 条`;
  else t = `全部 <b>${n}</b> 条词条 · ${state.codex.imagedCount} 条已配图`;
  $('#resultInfo').innerHTML = t;
  $('#empty').hidden = n > 0;
}

/* ---------------- 瀑布流渲染 ---------------- */
function colCount() {
  const w = $('#masonry').clientWidth || $('#main').clientWidth;
  return Math.max(1, Math.floor((w + 16) / (290 + 16)));
}
function buildColumns(n) {
  const m = $('#masonry');
  m.innerHTML = '';
  state.cols = [];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('div');
    c.className = 'col';
    m.appendChild(c);
    state.cols.push(c);
  }
  state.colN = n;
}
function shortestCol() {
  let best = state.cols[0];
  for (const c of state.cols) if (c.offsetHeight < best.offsetHeight) best = c;
  return best;
}
function renderList() {
  buildColumns(colCount());
  state.rendered = 0;
  renderMore();
}
function renderMore() {
  const end = Math.min(state.rendered + CHUNK, state.list.length);
  for (let i = state.rendered; i < end; i++) shortestCol().appendChild(makeCard(state.list[i]));
  state.rendered = end;
}

function makeCard(e) {
  const node = $('#cardTpl').content.firstElementChild.cloneNode(true);
  node.querySelector('.card-title').textContent = e.title;
  node.querySelector('.card-tags').textContent = e.tags;
  node.querySelector('.card-path').textContent = e.path.join(' › ');
  if (e.isNew) node.querySelector('.badge-new').hidden = false;
  if (e.image) {
    const wrap = node.querySelector('.card-img-wrap');
    const img = node.querySelector('.card-img');
    img.src = `images/${state.codex.id}/${e.image}`;
    img.alt = e.title;
    wrap.hidden = false;
    wrap.querySelector('.zoom-btn').onclick = ev => { ev.stopPropagation(); openLightbox(img.src); };
  } else {
    node.classList.add('no-img');
  }
  node.onclick = () => copyEntry(e, node);
  return node;
}

/* ---------------- 复制 ---------------- */
async function copyEntry(e, node) {
  const text = e.tags;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  node.classList.add('copied');
  setTimeout(() => node.classList.remove('copied'), 600);
  toast(`已复制：${e.title}`);
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = '✓ ' + msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

/* ---------------- 灯箱 ---------------- */
function openLightbox(src) {
  $('#lightboxImg').src = src;
  $('#lightbox').hidden = false;
}

/* ---------------- 交互绑定 ---------------- */
function bindUI() {
  // 搜索（防抖）
  let st;
  $('#search').oninput = e => {
    clearTimeout(st);
    st = setTimeout(() => {
      state.query = e.target.value;
      if (state.query.trim()) {
        document.querySelectorAll('.tree-row.active').forEach(r => r.classList.remove('active'));
      }
      applyFilter();
    }, 180);
  };
  // 只看有图
  $('#onlyImaged').onchange = e => { state.onlyImaged = e.target.checked; applyFilter(); };
  // 主题
  const applyTheme = d => {
    document.body.classList.toggle('dark', d);
    $('#themeBtn').innerHTML = d ? THEME_ICONS.sun : THEME_ICONS.moon;
    $('#themeBtn').setAttribute('aria-label', d ? '切换浅色模式' : '切换深色模式');
    localStorage.setItem('fadian-dark', d ? '1' : '0');
  };
  $('#themeBtn').onclick = () => applyTheme(!document.body.classList.contains('dark'));
  applyTheme(localStorage.getItem('fadian-dark') === '1');
  // 侧栏开关（移动端）
  $('#menuBtn').onclick = () => $('#sidebar').classList.toggle('hidden');
  // 灯箱关闭
  $('#lightbox').onclick = () => { $('#lightbox').hidden = true; };
  // 无限滚动
  new IntersectionObserver(es => {
    if (es[0].isIntersecting && state.rendered < state.list.length) renderMore();
  }, { rootMargin: '600px' }).observe($('#sentinel'));
  // 窗口缩放重排
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (colCount() !== state.colN) {
        const keep = state.rendered;
        buildColumns(colCount());
        state.rendered = 0;
        while (state.rendered < keep && state.rendered < state.list.length) renderMore();
      }
    }, 160);
  });
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

init();
