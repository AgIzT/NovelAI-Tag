import { COMMUNITY_CATEGORIES } from './constants.js';
import { isFavorite } from './favorites.js';
import { createLikeButton } from './likes.js';
import { state } from './state.js';
import { $, escHtml, imageUrl, promptExcerpt } from './utils.js';

function imageRatio(image, fallback = 4 / 5) {
  const width = Number(image?.width);
  const height = Number(image?.height);
  if (!(width > 0 && height > 0)) return fallback;
  return Math.max(.52, Math.min(1.82, width / height));
}

export function renderCategoryRail(onSelect) {
  const rail = $('#categoryRail');
  if (!rail) return;
  const items = [{ label: '全部', value: null }, ...COMMUNITY_CATEGORIES.map(category => ({ label: category, value: category }))];
  const existing = new Map([...rail.children].map(button => [button.dataset.category, button]));

  for (const item of items) {
    const key = item.value || '';
    let btn = existing.get(key);
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'category-chip ui-press';
      btn.textContent = item.label;
      btn.dataset.category = key;
      btn.addEventListener('click', () => onSelect(item.value));
      rail.appendChild(btn);
    }
    btn.setAttribute('aria-pressed', String((state.activeCategory || '') === key));
  }
}

export function renderResultBar() {
  const result = $('#resultInfo');
  if (!result) return;
  if (state.loading) {
    result.textContent = '正在加载共创广场…';
    return;
  }
  if (state.loadError) {
    result.textContent = '共创广场加载失败';
    return;
  }

  const parts = [];
  if (state.activeCategory) parts.push(`分类: ${state.activeCategory}`);
  if (state.query) parts.push(`搜索 "${state.query}"`);
  if (state.onlyFavorites) parts.push('只看收藏');
  if (!state.showNSFW) parts.push('已隐藏 NSFW');
  parts.push(`<b>${state.filtered.length}</b> 条投稿`);
  result.innerHTML = parts.map(part => part.startsWith('<b>') ? part : escHtml(part)).join(' · ');
}

export function renderEmptyState({ onSubmit, onClearSearch, onShowAll, onShowNSFW, onShowFavoritesAll } = {}) {
  const empty = $('#empty');
  if (!empty) return;
  const visible = !state.loading && state.filtered.length === 0;
  empty.hidden = !visible;
  if (!visible) return;

  const hasEntries = state.entries.length > 0;
  let title = '还没有人投稿，来当第一个';
  let desc = '提交作品信息，之后会进入这里。';
  const actions = [];

  if (state.loadError) {
    title = '共创广场加载失败';
    desc = '暂时无法取得投稿数据，请刷新后重试。';
    actions.push({ label: '刷新重试', action: () => window.location.reload() });
  } else if (!hasEntries) {
    actions.push({ label: '分享你的作品', action: onSubmit });
  } else if (state.onlyFavorites) {
    title = '还没有收藏的投稿';
    desc = '在卡片右上角点星标，就能把喜欢的作品收进这里。';
    actions.push({ label: '查看全部投稿', action: onShowFavoritesAll });
  } else if (!state.showNSFW && state.entries.some(entry => entry.nsfw)) {
    title = '当前筛选下没有可见投稿';
    desc = 'NSFW 投稿已被隐藏，开启后会和普通投稿混合显示。';
    actions.push({ label: '开启 NSFW 混显', action: onShowNSFW });
    actions.push({ label: '查看全部', action: onShowAll });
  } else if (state.query) {
    title = '没有找到匹配投稿';
    desc = '换个关键词，或清空搜索回到当前分类。';
    actions.push({ label: '清空搜索', action: onClearSearch });
  } else if (state.activeCategory) {
    title = '这个分类还没有投稿';
    desc = '先回到全部视图看看，或者贡献这个分类的第一条。';
    actions.push({ label: '查看全部', action: onShowAll });
    actions.push({ label: '分享你的作品', action: onSubmit });
  }

  empty.innerHTML = `
    <div class="empty-mark" aria-hidden="true">+</div>
    <h2>${escHtml(title)}</h2>
    <p>${escHtml(desc)}</p>
    ${actions.length ? '<div class="empty-actions"></div>' : ''}
  `;

  const actionBox = empty.querySelector('.empty-actions');
  for (const item of actions) {
    if (!item.action) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ui-press';
    btn.textContent = item.label;
    btn.addEventListener('click', item.action);
    actionBox?.appendChild(btn);
  }
}

const cardEntries = new WeakMap();

export function renderGrid(entries, handlers = {}) {
  const grid = $('#communityGrid');
  if (!grid) return;
  const focused = document.activeElement;
  const focusedCard = focused?.closest('.community-card');
  const previousCards = [...grid.children];
  const focusedIndex = previousCards.indexOf(focusedCard);
  const existing = new Map(previousCards.map(card => [card.dataset.entryId, card]));
  const nextCards = entries.map((entry, index) => {
    const previous = existing.get(String(entry.id));
    const card = previous && cardEntries.get(previous) === entry
      ? previous : createCard(entry, handlers);
    if (card !== previous) card.style.setProperty('--card-i', String(Math.min(index, 18)));
    const favorite = card.querySelector('.card-fav-btn');
    const active = isFavorite(entry);
    favorite.setAttribute('aria-pressed', String(active));
    favorite.setAttribute('aria-label', active ? '取消收藏' : '收藏');
    return card;
  });
  const nextSet = new Set(nextCards);
  for (const card of previousCards) if (!nextSet.has(card)) card.remove();
  // 不把保留节点移入 fragment：卸载再插入也会丢焦点并重播入场。
  let cursor = grid.firstElementChild;
  for (const card of nextCards) {
    if (card !== cursor) grid.insertBefore(card, cursor);
    cursor = card.nextElementSibling;
  }
  if (focusedIndex >= 0 && document.activeElement !== focused) {
    const card = nextCards.find(item => item.dataset.entryId === focusedCard.dataset.entryId)
      || nextCards[Math.min(focusedIndex, nextCards.length - 1)];
    const target = focused.isConnected ? focused
      : focused.matches('.card-fav-btn') ? card?.querySelector('.card-fav-btn') : card;
    (target || $('#favFilterBtn'))?.focus({ preventScroll: true });
  }
}

function createCard(entry, { onOpenDetail, onToggleFavorite } = {}) {
  const firstImage = entry.images[0];
  const category = entry.category?.[0] || '随手分享';
  const card = document.createElement('article');
  card.className = 'community-card';
  card.dataset.entryId = String(entry.id);
  cardEntries.set(card, entry);
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `查看投稿：${entry.title || category}`);

  const media = document.createElement('div');
  media.className = firstImage ? 'community-card-media' : 'community-card-media no-image';
  if (firstImage) {
    media.style.setProperty('--img-ratio', String(imageRatio(firstImage)));
    const img = document.createElement('img');
    img.src = imageUrl(firstImage.file);
    img.alt = entry.title || category;
    img.loading = 'lazy';
    img.addEventListener('load', () => {
      if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) return;
      if (!(Number(firstImage.width) > 0)) firstImage.width = img.naturalWidth;
      if (!(Number(firstImage.height) > 0)) firstImage.height = img.naturalHeight;
      media.style.setProperty('--img-ratio', String(imageRatio(firstImage)));
    }, { once: true });
    media.appendChild(img);
    if (entry.images.length > 1) {
      const count = document.createElement('span');
      count.className = 'image-count';
      count.textContent = `${entry.images.length} 张`;
      media.appendChild(count);
    }
    if (firstImage.params) {
      const param = document.createElement('span');
      param.className = 'param-badge';
      param.textContent = '✦';
      param.title = '原图含生成参数，详情页可查看原图';
      media.appendChild(param);
    }
  } else {
    media.innerHTML = '<span>Prompt</span>';
  }
  if (entry.nsfw) {
    const badge = document.createElement('span');
    badge.className = 'nsfw-badge';
    badge.textContent = 'NSFW';
    media.appendChild(badge);
  }

  const body = document.createElement('div');
  body.className = 'community-card-body';
  body.innerHTML = `
    <div class="card-meta"><span>${escHtml(category)}</span>${entry.submitter ? `<span>投稿人 ${escHtml(entry.submitter)}</span>` : ''}</div>
    <h2>${escHtml(entry.title || category + '分享')}</h2>
    <p>${escHtml(promptExcerpt(entry.prompt))}</p>
    <div class="card-tags">${(entry.tags || []).slice(0, 4).map(tag => `<span>${escHtml(tag)}</span>`).join('')}</div>
  `;
  const likeButton = createLikeButton(entry, 'card-like-overlay');
  if (likeButton) media.appendChild(likeButton);

  const fav = document.createElement('button');
  fav.type = 'button';
  fav.className = 'card-fav-btn ui-press';
  fav.setAttribute('aria-label', isFavorite(entry) ? '取消收藏' : '收藏');
  fav.setAttribute('aria-pressed', String(isFavorite(entry)));
  fav.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.8 2.45 4.96 5.48.8-3.96 3.86.94 5.46L12 16.3l-4.9 2.58.93-5.46-3.96-3.86 5.48-.8L12 3.8Z"/></svg>';
  fav.addEventListener('click', event => {
    event.stopPropagation();
    onToggleFavorite?.(entry);
  });
  fav.addEventListener('keydown', event => event.stopPropagation());

  card.appendChild(fav);
  card.append(media, body);
  card.addEventListener('click', () => onOpenDetail?.(entry, 0, { trigger: card }));
  card.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onOpenDetail?.(entry, 0, { trigger: card });
  });
  return card;
}
