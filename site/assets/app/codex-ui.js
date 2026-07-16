import { state, RANDOM_RECENT_LIMIT, NSFW_LOCKED_MESSAGE } from './state.js';
import { $, esc, samePath, pathStartsWith, updateSearchClear, prefersReducedMotion } from './utils.js';
import { isCodexLocked, showNsfwLockedHint, isEntryAccessBlocked, isEntryNsfw, isNsfwPathSegment, isR18gEntry, isR18gName } from './access.js';
import { codexStatusLabel, codexStatusClass, codexStatusTitle } from './data.js';
import { hasEntryImage, thumbUrl } from './media.js';
import { toast } from './feedback.js';
import {
  closeHistoryLayer,
  forgetHistoryLayer,
  openHistoryLayer,
  registerHistoryLayer,
  topHistoryLayerId,
} from './browser-history.js';

/* 选择器类型图标（描边 SVG，跟随 currentColor） */
const TYPE_ICONS = {
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H18a1 1 0 0 1 1 1v15H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M8 4v16"/></svg>',
  palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 1.9-1 1.9-1.9 0-.5-.3-.9-.3-1.6 0-.7.6-1.2 1.4-1.2H17a3.5 3.5 0 0 0 3.5-3.5C20.5 6.9 16.7 3.5 12 3.5Z"/><circle cx="8" cy="10.5" r="1"/><circle cx="12" cy="8" r="1"/><circle cx="16" cy="10.5" r="1"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.5" cy="10" r="1.6"/><path d="m4.5 17 4.8-4.8a1.5 1.5 0 0 1 2.1 0L16.2 17"/><path d="m13.8 14.6 1.4-1.4a1.5 1.5 0 0 1 2.1 0L20 16"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3 2"/></svg>',
};

/* 投稿门图标：加号（贡献语义）+ 外链箭头（离站前往社区） */
const DOOR_PLUS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const DOOR_OUT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4.5"/></svg>';

/* 选择器类型分类法。法典 / 画风串 / 精选图包均可由 codexes.json 按 type 接入。
   某类型在 codexes.json 里没有对应 type 的真法典时，显示其 placeholders（点击只提示「即将上线」，进不去）。
   将来给某本加 type:"string"/"pack" 即自动变为可加载、该类占位被忽略。 */
const CODEX_TYPES = [
  { id: 'codex', name: '法典', sub: '按分类查词条', icon: 'book' },
  { id: 'string', name: '画风串', sub: '画风与画师串', icon: 'palette' },
  { id: 'pack', name: '精选图包', sub: '社区收集原图包', icon: 'image', placeholders: [
    { title: '精选构图图包', meta: '原图直出 · 含 NAI 生成参数' },
  ] },
];

const codexType = c => (c && c.type) || 'codex';
const codexPickerTitle = c => c?.selectorTitle || c?.title || '';
const realCodexesOfType = typeId => state.codexes.filter(c => codexType(c) === typeId);
const pickerActiveCodex = () => (state.favoritesView || state.siteSearchView) ? state.browseCodex : state.codex;
const pickerActiveCodexId = () => pickerActiveCodex()?.id || '';

const codexUiActions = {
  loadCodex: async () => {},
  applyFilter: () => {},
  applySearch: async () => {},
  syncUrlState: () => {},
  openLightbox: () => {},
  updateVirtualCards: () => {},
};

export function setCodexUiActions(actions = {}) {
  Object.assign(codexUiActions, actions);
}

/* 自绘法典选择器：PC = 类型级联双栏（左类型轨 + 右列表）；移动端 = 分组下拉（各类型小标题 + 条目堆叠）。
   原生 #codexSelect 仅做值同步。 */
export function setupCodexPicker() {
  const sel = $('#codexSelect');
  const btn = $('#codexBtn');
  const menu = $('#codexMenu');
  if (!btn || !menu) return;

  let activeType = null;  // 级联模式下当前选中的类型

  const focusableItems = () => [...menu.querySelectorAll('.codex-type, .codex-item, .codex-door')];
  const focusItem = index => {
    const list = focusableItems();
    if (!list.length) return;
    list[(index + list.length) % list.length].focus();
  };
  const focusPreferredItem = () => {
    const target = menu.querySelector('.codex-item.active') || menu.querySelector('.codex-type.active') || focusableItems()[0];
    target?.focus();
  };
  const isMobile = () => window.matchMedia('(max-width: 600px)').matches;
  const openDirect = ({ focus = false } = {}) => {
    renderMenu();
    menu.hidden = false;
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    if (focus) requestAnimationFrame(focusPreferredItem);
  };
  const closeDirect = ({ focusButton = false } = {}) => {
    menu.hidden = true;
    btn.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    if (focusButton) btn.focus();
  };
  registerHistoryLayer('codex-menu', {
    isOpen: () => !menu.hidden,
    open: () => openDirect(),
    close: () => closeDirect({ focusButton: true }),
  });
  const open = ({ focus = false, historyMode = 'push' } = {}) => {
    const replaceLayer = isMobile() && topHistoryLayerId() === 'banner-about';
    if (replaceLayer) closeBannerAbout();
    openDirect({ focus });
    if (isMobile() && historyMode !== 'none') {
      openHistoryLayer('codex-menu', { mode: replaceLayer ? 'replace' : historyMode });
    }
  };
  const close = ({ focusButton = false, historyMode = 'back' } = {}) => {
    if (isMobile() && historyMode !== 'none' && closeHistoryLayer('codex-menu')) return;
    closeDirect({ focusButton });
    if (isMobile() && historyMode !== 'none') forgetHistoryLayer('codex-menu');
  };

  const chooseCodex = c => {
    if (!c) return;
    if (isCodexLocked(c)) { showNsfwLockedHint(); return; }
    const changed = state.favoritesView || state.siteSearchView || sel.value !== c.id;
    if (!changed) {
      close({ focusButton: true });
      return;
    }
    close({ focusButton: true, historyMode: 'none' });
    sel.value = c.id;
    codexUiActions.loadCodex(c.id, { historyMode: 'push', transition: 'route', consumeLayer: isMobile() });
  };

  /* 类型清单：每类带真实法典 real[] 与是否占位 soon */
  const buildTypes = () => CODEX_TYPES.map(t => {
    const real = realCodexesOfType(t.id);
    return { ...t, real, soon: real.length === 0 };
  });

  const makeRealItem = (c, n) => {
    const locked = isCodexLocked(c);
    const active = pickerActiveCodexId() === c.id;
    const pct = c.entryCount ? Math.round((Number(c.imagedCount || 0) / Number(c.entryCount || 1)) * 100) : 0;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `codex-item${locked ? ' locked' : ''}${active ? ' active' : ''}`;
    item.dataset.id = c.id;
    item.setAttribute('aria-disabled', locked ? 'true' : 'false');
    if (active) item.setAttribute('aria-current', 'true');
    if (locked) item.title = NSFW_LOCKED_MESSAGE;
    item.innerHTML =
      `<span class="ci-mark">${String(n).padStart(2, '0')}</span>` +
      `<span class="ci-main">` +
      `<span class="ci-name">${esc(codexPickerTitle(c))}</span>` +
      `<span class="ci-meta">${esc(c.author || '未知作者')} · ${Number(c.entryCount || 0)} 条 · ${pct}% 配图</span>` +
      `<span class="ci-bar"><i style="width:${pct}%"></i></span>` +
      `<span class="ci-lock"${locked ? '' : ' hidden'}>开启设置解锁</span>` +
      `</span>` +
      '<svg class="ck" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4 4L19 7"/></svg>';
    item.onclick = () => chooseCodex(c);
    return item;
  };

  const makeSoonItem = (t, ph) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'codex-item soon';
    item.dataset.soon = t.id;
    item.innerHTML =
      `<span class="ci-mark ico">${TYPE_ICONS[t.icon]}</span>` +
      `<span class="ci-main">` +
      `<span class="ci-name">${esc(ph.title)}</span>` +
      `<span class="ci-meta">${esc(ph.meta || '')}</span>` +
      `<span class="ci-soon-chip">占位册</span>` +
      `</span>`;
    item.onclick = () => toast(`「${t.name}」即将上线`, '');
    return item;
  };

  const makeSoonBanner = t => {
    const b = document.createElement('div');
    b.className = 'codex-soon-banner';
    b.innerHTML = `${TYPE_ICONS.clock}<span><b>${esc(t.name)}</b> 即将上线 —— 下面是预览，一切内容均为占位，非实际内容。</span>`;
    return b;
  };

  /* 社区投稿门：置底一扇明确标记的「门」（虚线卡+加号），点击离站前往社区共建站（走跨页 View Transition）。
     刻意做成和策展书行视觉区分的样子——它是共建入口，不是第四本书。 */
  const makeSubmitDoor = () => {
    const wrap = document.createElement('div');
    wrap.className = 'codex-door-wrap';
    const a = document.createElement('a');
    a.className = 'codex-door';
    a.href = '/strings.html';
    a.setAttribute('aria-label', '前往社区共建，投稿你的画风串');
    a.innerHTML =
      `<span class="cd-ico">${DOOR_PLUS_ICON}</span>` +
      `<span class="cd-main">` +
      `<span class="cd-name">社区共建 · 去投稿</span>` +
      `<span class="cd-sub">这里是大家的画风串，加入你的一条</span>` +
      `</span>` +
      `<span class="cd-out">${DOOR_OUT_ICON}</span>`;
    wrap.appendChild(a);
    return wrap;
  };

  const fillItems = (container, t) => {
    if (t.soon) {
      (t.placeholders || []).forEach(ph => container.appendChild(makeSoonItem(t, ph)));
    } else {
      t.real.forEach((c, i) => container.appendChild(makeRealItem(c, i + 1)));
    }
  };

  /* PC：级联双栏 */
  const renderCascade = types => {
    menu.classList.add('cascade');
    menu.classList.remove('grouped');
    menu.innerHTML = '';
    if (!activeType || !types.some(t => t.id === activeType)) {
      const preferred = codexType(pickerActiveCodex());
      activeType = types.some(t => t.id === preferred) ? preferred : types[0].id;
    }
    const rail = document.createElement('div');
    rail.className = 'codex-rail';
    const listWrap = document.createElement('div');
    listWrap.className = 'codex-list';
    const setActive = id => {
      activeType = id;
      rail.querySelectorAll('.codex-type').forEach(el => {
        const active = el.dataset.type === id;
        el.classList.toggle('active', active);
        el.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      listWrap.innerHTML = '';
      const t = types.find(x => x.id === id);
      if (t.soon) listWrap.appendChild(makeSoonBanner(t));
      fillItems(listWrap, t);
    };
    types.forEach(t => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'codex-type';
      el.dataset.type = t.id;
      el.setAttribute('aria-pressed', 'false');
      const count = t.soon ? (t.placeholders || []).length : t.real.length;
      el.innerHTML =
        `<span class="ct-ico">${TYPE_ICONS[t.icon]}</span>` +
        `<span class="ct-main"><span class="ct-name">${esc(t.name)}${t.soon ? '<span class="codex-soon-tag">占位</span>' : ''}</span>` +
        `<span class="ct-sub">${esc(t.sub)}</span></span>` +
        `<span class="ct-n">${count}</span>`;
      el.onclick = () => setActive(t.id);
      rail.appendChild(el);
    });
    menu.appendChild(rail);
    menu.appendChild(listWrap);
    setActive(activeType);
  };

  /* 移动端：分组下拉（方案 A） */
  const renderGrouped = types => {
    menu.classList.add('grouped');
    menu.classList.remove('cascade');
    menu.innerHTML = '';
    types.forEach(t => {
      const head = document.createElement('div');
      head.className = 'codex-group-head';
      head.innerHTML =
        `<span class="cg-ico">${TYPE_ICONS[t.icon]}</span>` +
        `<span class="cg-name">${esc(t.name)}</span>` +
        `<span class="cg-sub">${esc(t.sub)}</span>` +
        (t.soon ? '<span class="codex-soon-tag">占位</span>' : '');
      menu.appendChild(head);
      if (t.soon) menu.appendChild(makeSoonBanner(t));
      fillItems(menu, t);
    });
  };

  const renderMenu = () => {
    if (isMobile()) renderGrouped(buildTypes());
    else renderCascade(buildTypes());
    menu.appendChild(makeSubmitDoor());  // 两套布局末尾都挂投稿门
  };

  btn.onclick = ev => {
    ev.stopPropagation();
    if (menu.hidden) open({ focus: true });
    else close();
  };
  btn.onkeydown = ev => {
    if ((ev.key === 'Enter' || ev.key === ' ' || ev.key === 'ArrowDown') && menu.hidden) {
      ev.preventDefault();
      open({ focus: true });
    } else if (!menu.hidden && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
      ev.preventDefault();
      focusItem(ev.key === 'ArrowUp' ? -1 : 0);
    }
  };
  menu.onkeydown = ev => {
    const list = focusableItems();
    const current = list.indexOf(document.activeElement);
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close({ focusButton: true });
    } else if (ev.key === 'Tab') {
      close();
    } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      focusItem(current + 1);
    } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') {
      ev.preventDefault();
      focusItem(current - 1);
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      focusItem(0);
    } else if (ev.key === 'End') {
      ev.preventDefault();
      focusItem(list.length - 1);
    }
  };
  document.addEventListener('click', ev => {
    if (!menu.hidden && !menu.contains(ev.target) && !btn.contains(ev.target)) close();
  });
  window.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && !menu.hidden) close({ focusButton: true });
  });
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (!isMobile() && !menu.hidden) {
      closeDirect();
      forgetHistoryLayer('codex-menu');
      return;
    }
    if (menu.hidden) return;
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(renderMenu);
  });
}

export function updateCodexPickerState() {
  document.querySelectorAll('#codexMenu .codex-item').forEach(it => {
    if (!it.dataset.id) return;  // 跳过占位条目
    const c = state.codexes.find(item => item.id === it.dataset.id);
    const locked = isCodexLocked(c);
    const active = pickerActiveCodexId() === c?.id;
    it.classList.toggle('locked', locked);
    it.classList.toggle('active', active);
    it.setAttribute('aria-disabled', locked ? 'true' : 'false');
    if (active) it.setAttribute('aria-current', 'true');
    else it.removeAttribute('aria-current');
    if (locked) it.title = NSFW_LOCKED_MESSAGE;
    else it.removeAttribute('title');
    const lock = it.querySelector('.ci-lock');
    if (lock) lock.hidden = !locked;
  });
}

export function accessHiddenCount() {
  if (!state.codex) return 0;
  return (state.codex.entries || []).filter(isEntryAccessBlocked).length;
}

export function visibleEntryCount() {
  return Math.max(0, Number(state.codex?.entryCount || 0) - accessHiddenCount());
}

/* ---------------- ??? ---------------- */
let treeEnterTimer = 0;
let resultEnterTimer = 0;

export function renderTree() {
  const nav = $('#tree');
  const shouldAnimate = nav.dataset.codexId !== (state.codex?.id || '');
  clearTimeout(treeEnterTimer);
  nav.classList.remove('tree-entering');
  nav.innerHTML = '';   // 同时清掉了 .tree-spy 指示条，下面 reset 后由下次滚动更新重建
  resetTreeSpy();
  nav.dataset.codexId = state.codex?.id || '';
  const searching = state.query.trim();
  const allActive = (!searching || state.siteSearchView) && !state.activePath.length;
  const all = document.createElement('div');
  all.className = 'tree-row' + (allActive ? ' active' : '');
  all.dataset.path = '';
  all.innerHTML = `<span class="tw-arrow"></span><span class="tw-name">全部</span><span class="tw-count">${visibleEntryCount()}</span>`;
  all.onclick = () => selectPath([], all);
  nav.appendChild(all);
  buildNodes(visibleTree(), nav, [], 0);
  if (shouldAnimate) {
    /* 只给可见行编错峰序号——折叠子树里的行不占号，否则可见行延迟带空洞、节奏乱掉 */
    const visibleRows = [...nav.querySelectorAll('.tree-row')].filter(row => row.offsetParent !== null);
    visibleRows.forEach((row, i) => row.style.setProperty('--tree-i', String(Math.min(i, 18))));
    void nav.offsetWidth;
    nav.classList.add('tree-entering');
    /* 错峰播完即摘类：之后展开折叠分类时不再带着陈旧延迟补播入场动画 */
    treeEnterTimer = window.setTimeout(() => nav.classList.remove('tree-entering'), 720);
  }
}

/* ---------------- 浏览进度 ↔ 目录联动（scroll spy） ---------------- */
let spyLastPathKey = '';
let spyLastRowKey = '';
let spyLastIndex = 0;
let spyPointerIn = false;

export function setupTreeSpy() {
  const sidebar = $('#sidebar');
  if (!sidebar) return;
  /* 指针悬在侧栏上=用户在自己翻目录：指示条照常滑，但目录不自动滚，避免打架 */
  sidebar.addEventListener('pointerenter', () => { spyPointerIn = true; });
  sidebar.addEventListener('pointerleave', () => { spyPointerIn = false; });
}

export function resetTreeSpy() {
  spyLastPathKey = '';
  spyLastRowKey = '';
  spyLastIndex = 0;
}

/* 折叠开合后行的可见性变了：清缓存强制重解析一次 */
function refreshTreeSpy() {
  spyLastPathKey = '';
  spyLastRowKey = '';
  updateReadingSpy();
}

/* 阅读线（视口上沿下约 1/3，与 captureMasonryAnchor 同口径）落在哪张卡上，
   指示条就滑到目录里对应的分类行；由 masonry 的 rAF 虚拟滚动更新顺带驱动。
   命中折叠的子分类时不强行展开，退而指到其最深的可见祖先 */
export function updateReadingSpy() {
  const nav = $('#tree');
  const m = $('#masonry');
  if (!nav || !m) return;
  const spy = nav.querySelector('.tree-spy');
  if (!state.codex || !state.placements.length) {
    if (spy) spy.hidden = true;
    resetTreeSpy();
    return;
  }
  const mTop = m.getBoundingClientRect().top + window.scrollY;
  const anchorY = Math.max(0, window.scrollY + Math.min(window.innerHeight * 0.32, 240) - mTop);
  const P = state.placements;
  let i = Math.min(Math.max(spyLastIndex, 0), P.length - 1);
  const below = p => anchorY < p.top + p.height;
  if (below(P[i])) { while (i > 0 && below(P[i - 1])) i--; }
  else { while (i < P.length - 1 && !below(P[i])) i++; }
  spyLastIndex = i;
  const path = P[i].entry.path || [];
  const pathKey = path.join('\u0001');
  if (pathKey === spyLastPathKey && spy && !spy.hidden) return;
  spyLastPathKey = pathKey;
  let row = null;
  for (let d = path.length; d >= 1; d--) {
    const cand = nav.querySelector(`.tree-row[data-path="${CSS.escape(path.slice(0, d).join('\u0001'))}"]`);
    if (cand && cand.offsetParent !== null) { row = cand; break; }
  }
  if (!row) {
    if (spy) spy.hidden = true;
    spyLastRowKey = '';
    return;
  }
  if (row.dataset.path === spyLastRowKey && spy && !spy.hidden) return;
  spyLastRowKey = row.dataset.path;
  let el = spy;
  if (!el) {
    el = document.createElement('div');
    el.className = 'tree-spy';
    el.hidden = true;
    nav.prepend(el);
  }
  const navRect = nav.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const top = Math.round(r.top - navRect.top + nav.scrollTop);
  const left = Math.round(r.left - navRect.left);   // 跟随行自身缩进：层级越深条越短越靠右
  if (el.hidden) {   // 新建/重建后的首次定位直接瞬移，别从旧书的位置飞过来
    el.style.transition = 'none';
    el.hidden = false;
  }
  el.style.width = `${Math.round(r.width)}px`;
  el.style.height = `${Math.round(r.height)}px`;
  el.style.translate = `${left}px ${top}px`;
  if (el.style.transition) {
    void el.offsetWidth;
    el.style.removeProperty('transition');
  }
  /* 目录滚动跟随：指示条快出目录视野时平滑带过去 */
  if (!spyPointerIn) {
    const pad = 44;
    if (top < nav.scrollTop + pad || top + r.height > nav.scrollTop + nav.clientHeight - pad) {
      nav.scrollTo({ top: Math.max(0, top - nav.clientHeight * 0.38), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  }
}

export function visibleTree() {
  return buildAccessTree(state.codex?.entries || []);
}

function nsfwLockStart(entry, path) {
  if (state.allowNsfw || !isEntryNsfw(entry)) return -1;
  const nsfwIndex = path.findIndex(isNsfwPathSegment);
  return nsfwIndex >= 0 ? nsfwIndex : 0;
}

function buildAccessTree(entries) {
  const root = new Map();
  for (const entry of entries) {
    if (!state.allowR18g && isR18gEntry(entry)) continue;
    const path = Array.isArray(entry.path) ? entry.path : [];
    const lockFrom = nsfwLockStart(entry, path);
    let node = root;
    path.forEach((name, index) => {
      if (!node.has(name)) node.set(name, { name, count: 0, locked: false, children: new Map() });
      const cur = node.get(name);
      cur.count += 1;
      if (lockFrom >= 0 && index >= lockFrom) cur.locked = true;
      node = cur.children;
    });
  }
  const toList = map => [...map.values()].map(n => ({
    name: n.name,
    count: n.count,
    locked: Boolean(n.locked),
    children: toList(n.children),
  }));
  return toList(root);
}

export function buildNodes(nodes, parent, prefix, depth) {
  for (const nd of nodes) {
    if (!state.allowR18g && isR18gName(nd.name)) continue;  // 隐藏 R18G/重口 分类
    const path = prefix.concat(nd.name);
    const item = document.createElement('div');
    const locked = Boolean(nd.locked && !state.allowNsfw);
    const active = !locked && (!state.query.trim() || state.siteSearchView) && samePath(path, state.activePath);
    const activeAncestor = pathStartsWith(state.activePath, path);
    item.className = 'tree-item' + (depth >= 1 && !activeAncestor ? ' collapsed' : '');
    const row = document.createElement('div');
    row.className = 'tree-row' + (active ? ' active' : '') + (locked ? ' locked' : '');
    row.dataset.path = path.join('\u0001');
    row.dataset.locked = locked ? '1' : '';
    row.setAttribute('aria-disabled', locked ? 'true' : 'false');
    if (locked) row.title = NSFW_LOCKED_MESSAGE;
    const hasKids = nd.children && nd.children.length;
    row.innerHTML =
      `<span class="tw-arrow">${hasKids ? '▾' : ''}</span>` +
      `<span class="tw-name">${esc(nd.name)}</span>` +
      `<span class="tw-count">${nd.count}</span>`;
    row.querySelector('.tw-arrow').onclick = e => { e.stopPropagation(); item.classList.toggle('collapsed'); refreshTreeSpy(); };
    row.onclick = () => {
      if (locked) {
        showNsfwLockedHint();
        if (hasKids) item.classList.remove('collapsed');
        return;
      }
      selectPath(path, row);
      if (hasKids) item.classList.remove('collapsed');
      refreshTreeSpy();   // 展开后行可见性变了，指示条重解析
    };
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

export function selectPath(path, rowEl) {
  const parentScrollY = Math.max(0, window.scrollY || 0);
  const isMobile = window.innerWidth <= 600;
  const routeChanged = !samePath(state.activePath, path) || (!state.siteSearchView && Boolean(state.query.trim()));
  if (!routeChanged) {
    if (isMobile && closeHistoryLayer('mobile-sidebar')) return;
    if (isMobile) {
      $('#sidebar').classList.add('closed');
      localStorage.setItem('fadian-sidebar', 'closed');
      forgetHistoryLayer('mobile-sidebar');
    }
    return;
  }
  document.querySelectorAll('.tree-row.active').forEach(r => r.classList.remove('active'));
  rowEl.classList.add('active');
  if (isMobile) {
    $('#sidebar').classList.add('closed');
    localStorage.setItem('fadian-sidebar', 'closed');
  }
  if (state.siteSearchView) {
    // 全站搜索：点目录 = 保留搜索词，把结果收窄到该来源法典/分类（点「全部」回到全站）
    state.activePath = path;
    codexUiActions.applyFilter({ resetScroll: true, transition: 'filter' });
    codexUiActions.syncUrlState({ historyMode: 'push', transition: 'route', consumeLayer: true, parentScrollY });
    return;
  }
  state.activePath = path;
  state.query = '';
  $('#search').value = '';
  updateSearchClear();
  codexUiActions.applyFilter({ resetScroll: true, transition: 'filter' });
  codexUiActions.syncUrlState({ historyMode: 'push', transition: 'route', consumeLayer: true, parentScrollY });
}

/* 面包屑点击：按路径找到目录行，展开祖先并选中 */
export function selectPathByPath(path) {
  const key = path.join('\u0001');
  for (const row of document.querySelectorAll('.tree-row')) {
    if ((row.dataset.path || '') !== key) continue;
    if (row.dataset.locked === '1') {
      showNsfwLockedHint();
      return;
    }
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


export function updateResultBar() {
  const n = state.list.length;
  const box = $('#resultInfo');
  const favoritesBackupButton = $('#favoritesViewBackupBtn');
  if (favoritesBackupButton) favoritesBackupButton.hidden = !state.favoritesView;
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
  if (q && !state.siteSearchView) {
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
  if (q) {
    const scope = state.siteSearchView ? '全站' : (state.searchScope === 'codex' ? '本书' : '');
    t = `${scope}${state.searchPlan?.isSyntax ? '筛选' : '搜索'} “${esc(q)}”：<b>${n}</b> 条结果`;
  }
  else if (state.favoritesView) t = `收藏：<b>${n}</b> 条`;
  else if (state.activePath.length) t = `<b>${n}</b> 条`;
  else t = `共 <b>${n}</b> 条词条 · ${state.list.filter(hasEntryImage).length} 条已配图`;
  count.innerHTML = t;
  box.appendChild(count);

  updateEmptyState(n);
  updateRailActive();
}

export function updateEmptyState(n) {
  const empty = $('#empty');
  if (!empty) return;
  empty.hidden = n > 0;
  if (n > 0) return;

  const q = state.query.trim();
  const hasFilter = state.onlyImaged || state.onlyFav || state.activePath.length || q;
  let title = '这里还没有词条';
  let desc = '换个分类或稍后再来看看。';
  const actions = [];

  if (q) {
    title = state.searchPlan?.isSyntax ? '没有符合条件的筛选结果' : '没有找到匹配词条';
    desc = state.siteSearchView
      ? '试试换个关键词，或切到“本书”只在当前法典里找。'
      : (state.searchPlan?.isSyntax
        ? '删掉一两个筛选条件，或加一个普通关键词继续缩小范围。'
        : '试试换个关键词，或清空搜索回到当前法典。');
    actions.push({ label: '清空搜索', action: 'clear-search' });
  } else if (state.favoritesView && !state.onlyImaged && !state.activePath.length) {
    title = '收藏夹还是空的';
    desc = '逛任意法典时点卡片右上角的星标，收藏就会集中到这里。';
  } else if (state.onlyFav) {
    title = '收藏夹还是空的';
    desc = '先在卡片右上角点星标收藏。';
    actions.push({ label: '查看全部词条', action: 'show-all' });
  } else if (state.onlyImaged) {
    title = '这个范围里暂时没有配图';
    desc = '关闭“只看有图”后，可以查看待配图词条。';
    actions.push({ label: '关闭只看有图', action: 'show-unimaged' });
  } else if (state.activePath.length) {
    title = '这个分类还没有词条';
    desc = '可以返回全部，或从上方横向分类继续逛。';
    actions.push({ label: '返回全部', action: 'show-all' });
  } else if (!hasFilter) {
    desc = '当前法典暂未提供可显示的词条数据。';
  }

  empty.innerHTML =
    `<div class="empty-mark" aria-hidden="true">—</div>` +
    `<h2>${esc(title)}</h2>` +
    `<p>${esc(desc)}</p>` +
    (actions.length ? `<div class="empty-actions">${actions.map(a => `<button type="button" data-empty-action="${esc(a.action)}">${esc(a.label)}</button>`).join('')}</div>` : '');

  empty.querySelectorAll('[data-empty-action]').forEach(btn => {
    btn.onclick = () => handleEmptyAction(btn.dataset.emptyAction);
  });
}

export function handleEmptyAction(action) {
  if (action === 'clear-search') {
    state.query = '';
    const search = $('#search');
    if (search) search.value = '';
    updateSearchClear();
    renderTree();
  } else if (action === 'show-unimaged') {
    state.onlyImaged = false;
    const onlyImaged = $('#onlyImaged');
    if (onlyImaged) onlyImaged.checked = false;
  } else if (action === 'show-all') {
    state.query = '';
    state.activePath = [];
    state.onlyFav = false;
    state.onlyImaged = false;
    const search = $('#search');
    if (search) search.value = '';
    const onlyFav = $('#onlyFav');
    if (onlyFav) onlyFav.checked = false;
    const onlyImaged = $('#onlyImaged');
    if (onlyImaged) onlyImaged.checked = false;
    updateSearchClear();
    renderTree();
  }
  void codexUiActions.applySearch({ resetScroll: true, transition: 'filter' });
}

export function randomExplore() {
  if (!state.codex) return;
  if (!state.list.length) {
    toast('当前结果为空，换个筛选再试试', '!');
    return;
  }
  const candidates = state.list.filter(hasEntryImage);
  if (!candidates.length) {
    toast('当前筛选下没有可随机探索的配图词条', '!');
    return;
  }
  const recent = new Set(state.recentRandomIds);
  let pool = candidates.filter(e => !recent.has(randomKey(e)));
  if (!pool.length) {
    pool = candidates;
    state.recentRandomIds = [];
  }
  const entry = pool[Math.floor(Math.random() * pool.length)];
  rememberRandomEntry(entry);
  openRandomEntry(entry);
}

export function randomKey(entry) {
  return `${state.codex?.id || ''}:${entry.id}`;
}

export function rememberRandomEntry(entry) {
  const key = randomKey(entry);
  state.recentRandomIds = [key, ...state.recentRandomIds.filter(id => id !== key)].slice(0, RANDOM_RECENT_LIMIT);
}

export function openRandomEntry(entry) {
  const index = state.list.findIndex(e => e.id === entry.id);
  const placement = index >= 0 ? state.placements[index] : null;
  if (placement) {
    const top = Math.max(0, placement.top + $('#masonry').getBoundingClientRect().top + window.scrollY - 120);
    window.scrollTo({ top, left: 0, behavior: 'auto' });
    codexUiActions.updateVirtualCards(true);
  }
  requestAnimationFrame(() => {
    const node = index >= 0 ? state.nodes.get(index) : null;
    const img = node?.querySelector('.card-img');
    codexUiActions.openLightbox(entry, 0, img || null);
    toast(`随机到了：${entry.title}`, '');
  });
}

/* ---------------- 法典横幅 / 分类轨道 ---------------- */
export function renderCodexHeader() {
  const c = state.codex;
  const banner = $('#codexBanner');
  if (!banner) return;
  closeBannerAbout();
  document.querySelectorAll('.banner-pop').forEach(pop => pop.remove());
  const cover = c.entries.find(hasEntryImage);
  const pct = c.entryCount ? Math.round((c.imagedCount / c.entryCount) * 100) : 0;
  const metaText = [c.author, c.version].filter(Boolean).join(' · ');
  const virtualView = state.favoritesView || state.siteSearchView;
  const originalPill = virtualView ? '' :
    `<span class="data-pill ${c.hasOriginal ? 'has-orig' : 'no-orig'}" title="${esc(c.hasOriginal ? '本法典保留原图：放大后可拖入 NovelAI 读取生成参数' : '本法典为压缩缩略图，拖入 NovelAI 读不出参数')}">${c.hasOriginal ? '含原图' : '无原图'}</span>`;
  banner.innerHTML =
    `<div class="banner-cover">${cover ? `<img src="${esc(thumbUrl(cover))}" alt="">` : ''}</div>` +
    `<div class="banner-info">` +
    `<div class="banner-title">${esc(c.title)}</div>` +
    `<div class="banner-meta"><span>${esc(metaText)}</span>${originalPill}</div>` +
    `<div class="banner-progress"><div class="bp-track"><div class="bp-fill" style="width:${pct}%"></div></div>` +
    `<span class="bp-text">${c.imagedCount} / ${c.entryCount} 已配图</span></div>` +
    `</div>`;
  /* 封面图 onload 渐显（同卡片图 is-loaded 模式）；缓存命中时 complete 已为真，直接显示 */
  const coverImg = banner.querySelector('.banner-cover img');
  if (coverImg) {
    const reveal = () => coverImg.classList.add('is-loaded');
    if (coverImg.complete && coverImg.naturalWidth) reveal();
    else { coverImg.onload = reveal; coverImg.onerror = reveal; }
  }
  if (!virtualView) renderBannerAbout(c, banner);
  renderCategoryRail();
  /* 结果栏只在换书时一次性淡入（renderCodexHeader 只在 loadCodex/换书渲染时调）；搜索/筛选/就地刷新的高频更新保持瞬时 */
  const resultBar = document.querySelector('.result-bar');
  if (resultBar) {
    clearTimeout(resultEnterTimer);
    resultBar.classList.remove('result-entering');
    void resultBar.offsetWidth;
    resultBar.classList.add('result-entering');
    resultEnterTimer = window.setTimeout(() => resultBar.classList.remove('result-entering'), 420);
  }
}

/* 顶部横向分类轨道（chip rail）。animate=false 用于就地刷新（如收藏视图内取消收藏后重算计数），
   避免 chipIn 入场错峰在每次删收藏时重放。 */
export function renderCategoryRail({ animate = true } = {}) {
  const rail = $('#chipRail');
  if (!rail) return;
  rail.innerHTML = '';
  const mkChip = (label, path, count, hue, { locked = false } = {}) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'rail-chip' + (locked ? ' locked' : '');
    chip.dataset.path = path.join('\u0001');
    chip.setAttribute('aria-disabled', locked ? 'true' : 'false');
    if (locked) chip.title = NSFW_LOCKED_MESSAGE;
    chip.innerHTML = `<span class="rc-dot" style="background:${hue}"></span>${esc(label)}<span class="rc-n">${count}</span>`;
    chip.onclick = () => locked ? showNsfwLockedHint() : selectPathByPath(path);
    chip.style.setProperty('--chip-i', String(Math.min(rail.childElementCount, 12)));   // 错峰序号=插入位置，封顶防长尾
    if (!animate) chip.style.animation = 'none';
    rail.appendChild(chip);
  };
  mkChip('全部', [], visibleEntryCount(), 'var(--accent)');
  for (const nd of visibleTree()) {
    if (!state.allowR18g && isR18gName(nd.name)) continue;  // 隐藏 R18G/重口 胶囊
    let h = 0;
    for (const ch of nd.name) h = (h * 31 + ch.codePointAt(0)) % 360;
    mkChip(nd.name, [nd.name], nd.count, `hsl(${h},58%,52%)`, { locked: Boolean(nd.locked && !state.allowNsfw) });
  }
  updateRailActive();
}

export function updateRailActive() {
  const rail = $('#chipRail');
  if (!rail) return;
  const head = (state.query.trim() && !state.siteSearchView) ? null : (state.activePath[0] || '');
  rail.querySelectorAll('.rail-chip').forEach(ch => {
    ch.classList.toggle('active', head !== null && (ch.dataset.path || '') === head);
  });
}

/* 法典「关于」气泡：来源 / 贡献者 / 相关链接 */
const EXT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>';

function positionBannerPop(pop, banner) {
  const r = banner.getBoundingClientRect();
  const isMobile = window.matchMedia('(max-width: 600px)').matches;
  const gap = isMobile ? 8 : 12;
  const topOffset = isMobile ? 40 : 46;
  const width = Math.min(280, Math.max(0, r.width - gap * 2));
  const left = Math.min(window.innerWidth - gap - width, Math.max(gap, r.right - gap - width));
  pop.style.width = `${Math.round(width)}px`;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(Math.max(gap, r.top + topOffset))}px`;
}

function positionOpenBannerPop() {
  const openBtn = document.querySelector('.banner-about-btn.open');
  const openPop = document.querySelector('.banner-pop:not([hidden])');
  const banner = openBtn?.closest('.codex-banner');
  if (openPop && banner) positionBannerPop(openPop, banner);
}

function closeBannerAboutDirect() {
  const openBtn = document.querySelector('.banner-about-btn.open');
  const openPop = document.querySelector('.banner-pop:not([hidden])');
  if (openPop) openPop.hidden = true;
  if (openBtn) openBtn.classList.remove('open');
}

function openBannerAboutDirect() {
  const btn = document.querySelector('.banner-about-btn');
  const pop = document.querySelector('.banner-pop');
  const banner = btn?.closest('.codex-banner');
  if (!btn || !pop || !banner) return;
  positionBannerPop(pop, banner);
  pop.hidden = false;
  btn.classList.add('open');
}

registerHistoryLayer('banner-about', {
  isOpen: () => Boolean(document.querySelector('.banner-pop:not([hidden])')),
  open: openBannerAboutDirect,
  close: closeBannerAboutDirect,
});

export function closeBannerAbout({ historyMode = 'none' } = {}) {
  if (historyMode === 'back' && closeHistoryLayer('banner-about')) return;
  closeBannerAboutDirect();
  if (historyMode !== 'none') forgetHistoryLayer('banner-about');
}

export function renderBannerAbout(c, banner) {
  const contributors = Array.isArray(c.contributors) ? c.contributors : [];
  const links = Array.isArray(c.links) ? c.links : [];
  if (!c.source && !contributors.length && !links.length && !c.dataStatus) return;

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
  html += `<div class="bp-sub">数据</div><div class="bp-data"><span class="data-pill ${codexStatusClass(c)}">${esc(codexStatusLabel(c))}</span>${c.dataNotice ? `<small>${esc(c.dataNotice)}</small>` : ''}</div>`;
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
  html += '<button class="bp-archive" type="button">查看完整档案</button>';
  pop.innerHTML = html;
  pop.querySelector('.bp-archive')?.addEventListener('click', ev => {
    ev.stopPropagation();
    document.dispatchEvent(new CustomEvent('openCodexArchive', { detail: { trigger: ev.currentTarget } }));
  });

  btn.onclick = ev => {
    ev.stopPropagation();
    const show = pop.hidden;
    if (!show) {
      closeBannerAbout({ historyMode: 'back' });
      return;
    }
    closeBannerAboutDirect();
    if (show) {
      positionBannerPop(pop, banner);
      pop.hidden = false;
      btn.classList.add('open');
      openHistoryLayer('banner-about');
    }
  };

  banner.appendChild(btn);
  document.body.appendChild(pop);
}

window.addEventListener('resize', positionOpenBannerPop, { passive: true });
window.addEventListener('scroll', positionOpenBannerPop, { passive: true });

export function renderCodexArchive() {
  const c = state.codex;
  const body = $('#archiveBody');
  if (!c || !body) return;
  const pct = c.entryCount ? Math.round((c.imagedCount / c.entryCount) * 100) : 0;
  const contributors = Array.isArray(c.contributors) ? c.contributors : [];
  const links = (Array.isArray(c.links) ? c.links : []).filter(l => l && l.url && l.url !== '#');
  const statRows = [
    ['作者', c.author || '未标注'],
    ['版本', c.version || '未标注'],
    ['词条', `${c.entryCount} 条`],
    ['配图', `${c.imagedCount} / ${c.entryCount} (${pct}%)`],
    ['数据', codexStatusLabel(c)],
  ];
  if (c.dataNotice) statRows.push(['状态说明', c.dataNotice]);
  if (c.dataError) statRows.push(['失败原因', c.dataError]);
  if (c.sourceDataUrl) statRows.push(['外部源', c.sourceDataUrl]);
  else if (c.dataUrl) statRows.push(['源地址', c.dataUrl]);
  if (c.fallbackDataUrl) statRows.push(['回退', c.fallbackDataUrl]);
  body.innerHTML =
    `<div class="archive-hero">` +
    `<div><div class="archive-title">${esc(c.title)}</div><div class="archive-sub">${esc(c.source || '本地整理数据')}</div></div>` +
    `<div class="archive-pct">${pct}%<span>配图率</span></div>` +
    `</div>` +
    `<div class="archive-grid">${statRows.map(([k, v]) => `<div class="archive-kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>` +
    (contributors.length ? `<div class="archive-section"><h3>贡献者</h3><div class="archive-chips">${contributors.map(p => {
      const name = typeof p === 'string' ? p : (p.name || '');
      const role = typeof p === 'string' ? '' : (p.role || '');
      return name ? `<span>${esc(name)}${role ? `<small>${esc(role)}</small>` : ''}</span>` : '';
    }).join('')}</div></div>` : '') +
    (links.length ? `<div class="archive-section"><h3>相关链接</h3>${links.map(l => `<a class="archive-link" href="${esc(l.url)}" target="_blank" rel="noopener">${EXT_ICON}<span>${esc(l.label || l.url)}</span></a>`).join('')}</div>` : '') +
    `<div class="archive-section"><h3>说明</h3><p>例图与法典内容版权归各自作者所有，本站仅作可视化整理与索引，感谢所有法典作者的无私分享。</p></div>`;
}

/* 关于本站（设置框）+ 侧栏小贴士轮播 */
let tipTimer = 0;
let tipIndex = 0;
export function setupAbout() {
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
