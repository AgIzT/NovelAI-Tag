'use strict';

const byId = id => document.getElementById(id);
const format = new Intl.NumberFormat('zh-CN');
const PAGE_SIZE = 15;
const VIEW_KEY = 'danbooru-picker-view-v1';
const DEFAULTS = { view: 'browse', query: '', min: '30', max: '499', sort: 'new', hide: true, page: 1, scroll: 0 };
const cards = byId('cards');
const gallery = byId('gallery');
const viewer = byId('viewer');
const cardButtons = new Map();
const workCache = new Map();
const saving = new Set();

let roster = [];
let artistByName = new Map();
let generated = new Set();
let decisions = new Map();
let matching = [];
let observer;
let view = { ...DEFAULTS };
let galleryState;
let viewVersion = 0;
let worksVersion = 0;
let pendingCards = [];
let cardRequests = 0;
let noticeTimer;
let busy = false;

function compact(name) {
  return name.toLowerCase().replace(/[_\s]/g, '');
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(className, text, onClick) {
  const element = node('button', className, text);
  element.type = 'button';
  element.addEventListener('click', onClick);
  return element;
}

async function request(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function showNotice(text) {
  const notice = byId('notice');
  notice.textContent = text;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 3200);
}

function readView(minimum) {
  const defaults = { ...DEFAULTS, min: String(minimum) };
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY));
    if (!saved || !['browse', 'selected', 'skipped'].includes(saved.view)) return defaults;
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

function storeView() {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* review choices are still on disk */ }
}

function listCount(type) {
  return [...decisions.values()].filter(state => state === type).length;
}

function updateCounts() {
  const count = listCount('selected');
  byId('selected-count').textContent = format.format(count);
  byId('skipped-count').textContent = format.format(listCount('skipped'));
  byId('pick-count').textContent = `已选 ${format.format(count)} 位`;
  byId('export').disabled = count === 0;
}

function applyControls() {
  byId('search').value = view.query;
  byId('min').value = view.min;
  byId('max').value = view.max;
  byId('sort').value = view.sort;
  byId('hide-generated').checked = view.hide;
  for (const element of document.querySelectorAll('[data-view]')) {
    element.setAttribute('aria-pressed', element.dataset.view === view.view);
  }
}

function filterList() {
  const name = compact(view.query.replace(/^artist:\s*/i, ''));
  const minimum = Number(view.min || '0');
  const maximum = view.max === '' ? Infinity : Number(view.max);
  const all = view.view === 'browse' ? roster : [...decisions]
    .filter(([, state]) => state === view.view)
    .map(([tag]) => artistByName.get(tag) || { name: tag, post: null, id: 0, key: compact(tag) });
  matching = all.filter(artist => {
    if (name && !artist.key.includes(name)) return false;
    if (view.view !== 'browse') return true;
    return (!view.hide || !generated.has(artist.key)) && (name || (artist.post >= minimum && artist.post <= maximum));
  });
  const byName = (a, b) => a.name.localeCompare(b.name, 'en');
  const compare = {
    high: (a, b) => (b.post ?? -1) - (a.post ?? -1),
    low: (a, b) => (a.post ?? Infinity) - (b.post ?? Infinity),
    new: (a, b) => b.id - a.id,
    name: byName,
  }[view.sort] || byName;
  matching.sort((a, b) => compare(a, b) || byName(a, b));
}

function updateFilterState() {
  const rangeActive = view.view === 'browse' && !view.query.trim();
  byId('min').disabled = !rangeActive;
  byId('max').disabled = !rangeActive;
  byId('hide-generated').disabled = view.view !== 'browse';
}

function panelState(card) {
  const state = decisions.get(card.artist.name);
  const pending = saving.has(card.artist.name);
  card.element.dataset.state = state || '';
  card.select.setAttribute('aria-pressed', state === 'selected');
  card.skip.setAttribute('aria-pressed', state === 'skipped');
  card.select.textContent = state === 'selected' ? '已选 ✓' : '＋ 选中';
  card.skip.textContent = state === 'skipped' ? '已略过' : '略过';
  card.select.disabled = pending || !artistByName.has(card.artist.name);
  card.skip.disabled = pending || !artistByName.has(card.artist.name);
}

function galleryDecision() {
  if (!galleryState) return;
  const control = byId('gallery-select');
  const name = galleryState.artist.name;
  const selected = decisions.get(name) === 'selected';
  control.textContent = selected ? '已选 ✓' : '＋ 选中';
  control.setAttribute('aria-pressed', selected);
  control.disabled = saving.has(name) || !artistByName.has(name);
}

async function setDecision(artist, choice) {
  const name = artist.name;
  if (saving.has(name)) return;
  const state = decisions.get(name) === choice ? 'none' : choice;
  saving.add(name);
  const syncButtons = () => {
    const card = cardButtons.get(name);
    if (card) panelState(card);
    if (galleryState?.artist.name === name) galleryDecision();
  };
  syncButtons();
  try {
    await request('/api/decisions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ artist: name, state }),
    });
    if (state === 'none') decisions.delete(name);
    else decisions.set(name, state);
    updateCounts();
    if (view.view !== 'browse') {
      filterList();
      renderPage(false);
    }
  } catch {
    showNotice('保存失败，请再点一次。');
  } finally {
    saving.delete(name);
    syncButtons();
  }
}

function worksFor(artist, sort = 'recent', page = 1) {
  const key = new URLSearchParams({ artist, sort, page });
  const handle = key.toString();
  if (!workCache.has(handle)) {
    const load = request(`/api/posts?${key}`).catch(error => {
      workCache.delete(handle);
      throw error;
    });
    if (workCache.size >= 200) workCache.delete(workCache.keys().next().value);
    workCache.set(handle, load);
  }
  return workCache.get(handle);
}

function openPost(post, name) {
  const image = byId('viewer-image');
  byId('viewer-link').href = `https://danbooru.donmai.us/posts/${post.id}`;
  image.alt = `${name} · D 站作品 #${post.id}`;
  image.src = post.large;
  viewer.showModal();
}

function workTile(post, name, eager = false) {
  const tile = button('work', '', () => openPost(post, name));
  tile.setAttribute('aria-label', `放大 D 站作品 #${post.id}`);
  const image = node('img');
  image.alt = '';
  image.loading = eager ? 'eager' : 'lazy';
  image.decoding = 'async';
  image.addEventListener('error', () => {
    tile.classList.add('is-broken');
    image.remove();
  });
  image.src = post.thumb;
  tile.append(image);
  return tile;
}

function sampleMessage(container, text, action) {
  const message = node('div', 'sample-message', text);
  if (action) message.append(button('', '重试', action));
  container.replaceChildren(message);
}

function drainCards() {
  while (cardRequests < 3 && pendingCards.length) {
    const { artist, samples, version } = pendingCards.shift();
    if (version !== viewVersion) continue;
    cardRequests++;
    worksFor(artist.name).then(result => {
      if (version !== viewVersion) return;
      const posts = result.posts.slice(0, 4);
      if (!posts.length) {
        sampleMessage(samples, result.more ? '这一页没有可预览的作品' : '暂无可预览的常规作品');
        return;
      }
      samples.replaceChildren(...posts.map(post => workTile(post, artist.name, true)));
      for (let i = posts.length; i < 4; i++) samples.append(node('div', 'placeholder'));
    }).catch(() => {
      if (version !== viewVersion) return;
      sampleMessage(samples, 'D 站连接失败', () => {
        sampleMessage(samples, '正在读取作品…');
        pendingCards.unshift({ artist, samples, version });
        drainCards();
      });
    }).finally(() => {
      cardRequests--;
      drainCards();
    });
  }
}

function makeCard(artist) {
  const element = node('article', 'card');
  element.dataset.artist = artist.name;
  const title = node('header', 'card-title');
  const heading = node('h2');
  const name = button('card-name', artist.name, () => openGallery(artist));
  name.title = `查看 ${artist.name} 的作品`;
  heading.append(name);
  title.append(heading, node('span', 'post-count', artist.post === null ? '已移出名单' : `${format.format(artist.post)} post`));
  const samples = node('div', 'samples');
  if (artist.post === null) sampleMessage(samples, '此标签仍保留在本地挑选记录中');
  else for (let i = 0; i < 4; i++) samples.append(node('div', 'placeholder'));
  const actions = node('div', 'card-actions');
  const more = button('quiet', '看更多 →', () => openGallery(artist));
  more.disabled = artist.post === null;
  name.disabled = more.disabled;
  const skip = button('skip', '略过', () => setDecision(artist, 'skipped'));
  const select = button('pick', '＋ 选中', () => setDecision(artist, 'selected'));
  actions.append(more, skip, select);
  if (generated.has(artist.key)) {
    const label = node('span', 'post-count', '已跑');
    label.title = 'AgIzT 例图已生成';
    actions.insertBefore(label, skip);
  }
  element.append(title, samples, actions);
  const record = { element, artist, samples, select, skip };
  cardButtons.set(artist.name, record);
  panelState(record);
  return element;
}

function renderPage(toTop = true) {
  const total = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  view.page = Math.max(1, Math.min(Math.trunc(Number(view.page) || 1), total));
  const start = (view.page - 1) * PAGE_SIZE;
  const visible = matching.slice(start, start + PAGE_SIZE);
  viewVersion++;
  pendingCards = [];
  observer?.disconnect();
  cardButtons.clear();
  cards.replaceChildren(...visible.map(makeCard));
  const version = viewVersion;
  observer = new IntersectionObserver(items => {
    for (const item of items) {
      if (!item.isIntersecting || version !== viewVersion) continue;
      observer.unobserve(item.target);
      const { artist, samples } = cardButtons.get(item.target.dataset.artist);
      pendingCards.push({ artist, samples, version });
    }
    drainCards();
  }, { rootMargin: '175px 0px' });
  for (const item of cardButtons.values()) if (item.artist.post !== null) observer.observe(item.element);
  if (!visible.length) cards.append(node('p', 'empty', view.view === 'browse' ? '没有找到符合条件的画师。' : '这份名单里还没有符合条件的画师。'));
  byId('results-count').textContent = visible.length
    ? `第 ${format.format(start + 1)}–${format.format(start + visible.length)} 位 / 共 ${format.format(matching.length)} 位`
    : '0 位画师';
  byId('page').value = view.page;
  byId('page').max = total;
  byId('total-pages').textContent = `/ ${format.format(total)}`;
  byId('bottom-count').textContent = `第 ${format.format(view.page)} / ${format.format(total)} 页`;
  byId('bottom-pages').hidden = total === 1;
  for (const control of document.querySelectorAll('[data-page]')) {
    control.disabled = control.dataset.page === 'prev' ? view.page === 1 : view.page === total;
  }
  if (toTop) {
    window.scrollTo(0, 0);
    view.scroll = 0;
  }
  storeView();
}

function changeFilters() {
  if (busy) return;
  view.query = byId('search').value.trim();
  view.min = byId('min').value;
  view.max = byId('max').value;
  view.sort = byId('sort').value;
  view.hide = byId('hide-generated').checked;
  view.page = 1;
  updateFilterState();
  filterList();
  renderPage(false);
}

function openGallery(artist) {
  galleryState = { artist, sort: 'recent', page: 1 };
  byId('gallery-title').textContent = artist.name;
  byId('gallery-meta').textContent = `${format.format(artist.post)} post · 常规级作品`;
  const search = new URLSearchParams({ tags: artist.name });
  byId('gallery-link').href = `https://danbooru.donmai.us/posts?${search}`;
  galleryDecision();
  gallery.showModal();
  loadGallery();
}

async function loadGallery() {
  const { artist, sort, page } = galleryState;
  const version = ++worksVersion;
  const results = byId('gallery-works');
  const pages = byId('gallery-pages');
  pages.hidden = true;
  results.replaceChildren(node('p', 'empty', '正在读取作品…'));
  gallery.scrollTop = 0;
  for (const control of document.querySelectorAll('[data-works]')) control.setAttribute('aria-pressed', control.dataset.works === sort);
  try {
    const payload = await worksFor(artist.name, sort, page);
    if (version !== worksVersion) return;
    results.replaceChildren(...payload.posts.map(post => workTile(post, artist.name)));
    if (!payload.posts.length) results.append(node('p', 'empty', '这一页没有可预览的常规作品。'));
    byId('gallery-page').textContent = `第 ${page} 页${payload.stale ? ' · 本机缓存' : ''}`;
    byId('gallery-prev').disabled = page === 1;
    byId('gallery-next').disabled = !payload.more || page >= 500;
    pages.hidden = page === 1 && !payload.more;
  } catch {
    if (version !== worksVersion) return;
    const message = node('div', 'empty', 'D 站连接失败。');
    message.append(button('', '重试', loadGallery));
    results.replaceChildren(message);
    byId('gallery-page').textContent = `第 ${page} 页`;
    byId('gallery-prev').disabled = page === 1;
    byId('gallery-next').disabled = true;
    pages.hidden = page === 1;
  }
}

function exportList() {
  const selected = [...decisions].filter(([, state]) => state === 'selected').map(([name]) => name);
  if (!selected.length) return;
  const url = URL.createObjectURL(new Blob([selected.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }));
  const link = node('a');
  link.href = url;
  link.download = 'danbooru-artist-picks.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showNotice(`已导出 ${selected.length} 个画师标签，每行一个。`);
}

async function initialize() {
  busy = true;
  try {
    const [catalog, state] = await Promise.all([request('/api/catalog'), request('/api/decisions')]);
    roster = catalog.artists.map(([name, post, id]) => ({ name, post, id, key: compact(name) }));
    artistByName = new Map(roster.map(artist => [artist.name, artist]));
    generated = new Set(catalog.generated);
    decisions = new Map(state.decisions);
    byId('catalog-line').textContent = `Danbooru · ${format.format(roster.length)} 个画师标签 · ${catalog.minimum} post 起 · 页内展示常规级原作`;
    view = readView(catalog.minimum);
    applyControls();
    updateFilterState();
    filterList();
    updateCounts();
    renderPage(false);
    requestAnimationFrame(() => window.scrollTo(0, Number(view.scroll) || 0));
  } catch {
    byId('catalog-line').textContent = '画师名单加载失败';
    const message = node('p', 'empty', '请确认本地窗口仍在运行。');
    message.append(button('', '重试', initialize));
    cards.replaceChildren(message);
  } finally {
    busy = false;
  }
}

let searchTimer;
byId('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(changeFilters, 150);
});
for (const id of ['min', 'max', 'sort', 'hide-generated']) byId(id).addEventListener('change', changeFilters);
byId('filters').addEventListener('submit', event => { event.preventDefault(); clearTimeout(searchTimer); changeFilters(); });
byId('reset').addEventListener('click', () => { view = { ...DEFAULTS, view: view.view }; applyControls(); changeFilters(); });
for (const item of document.querySelectorAll('[data-view]')) {
  item.addEventListener('click', () => { view.view = item.dataset.view; applyControls(); changeFilters(); });
}
for (const item of document.querySelectorAll('[data-page]')) {
  item.addEventListener('click', () => { view.page += item.dataset.page === 'next' ? 1 : -1; renderPage(); });
}
byId('jump').addEventListener('submit', event => { event.preventDefault(); view.page = byId('page').value; renderPage(); });
byId('gallery-close').addEventListener('click', () => gallery.close());
gallery.addEventListener('close', () => { worksVersion++; galleryState = null; });
byId('viewer-close').addEventListener('click', () => viewer.close());
viewer.addEventListener('close', () => byId('viewer-image').removeAttribute('src'));
byId('gallery-select').addEventListener('click', () => setDecision(galleryState.artist, 'selected'));
for (const control of document.querySelectorAll('[data-works]')) {
  control.addEventListener('click', () => { galleryState.sort = control.dataset.works; galleryState.page = 1; loadGallery(); });
}
byId('gallery-prev').addEventListener('click', () => { galleryState.page--; loadGallery(); });
byId('gallery-next').addEventListener('click', () => { galleryState.page++; loadGallery(); });
byId('export').addEventListener('click', exportList);
window.addEventListener('pagehide', () => { view.scroll = window.scrollY; storeView(); });
initialize();
