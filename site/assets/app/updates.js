import { esc, safeJsonParse } from './utils.js';
import { fetchDataJson } from '../data-source.js';
import { findCodexMeta } from './data.js';
import { codexCoverUrl } from './codex-ui.js';

/* 跨书更新时间线。数据来自 site/data/updates.json（`tools/build_updates_index.py`
   聚合 codexes.json 的批次与各书词条的 updateBatches/isNew 生成）；条数口径与进书后的
   「NEW x.xx更新」筛选是同一套判定，改一侧必须同步另一侧。

   已读粒度是「书×批次」而不是「批次」：同一天两本书更新、用户只点进其中一本时，
   另一本仍应保持未读。存储沿用公告那套 localStorage 集合的形状。 */

const READ_STORAGE_KEY = 'fadian-updates-read-ids';
const SEEDED_STORAGE_KEY = 'fadian-updates-seeded';
const MAX_READ_KEYS = 200;
const MAX_BATCHES = 20;

let batches = [];
let loaded = false;
let loadingPromise = null;

const updatesActions = {
  openBatch: async () => {},
};

export function setUpdatesActions(actions = {}) {
  Object.assign(updatesActions, actions);
}

export async function loadUpdates() {
  if (loaded) return batches;
  if (loadingPromise) return loadingPromise;
  loadingPromise = fetchDataJson('updates.json', { cache: 'no-store' })
    .then(data => {
      batches = normalizeUpdates(data);
      loaded = true;
      seedFirstRun();
      return batches;
    })
    .catch(error => {
      /* 更新索引是增量能力：老 release 里没有这个文件是正常的，不能让它拖垮面板。 */
      console.warn('[updates] 更新索引加载失败，页签将显示为空', error);
      batches = [];
      return batches;
    })
    .finally(() => { loadingPromise = null; });
  return loadingPromise;
}

export function updatesLoaded() {
  return loaded;
}

/* 顶栏气泡与红点的唯一数字来源：只统计未读的「书×批次」。 */
export function updatesDigest() {
  const unread = batches.flatMap(batch => (
    batch.books
      .filter(book => !isRead(batch.id, book.codexId))
      .map(book => ({ batch, book }))
  ));
  return {
    entries: unread.reduce((sum, item) => sum + item.book.count, 0),
    books: new Set(unread.map(item => item.book.codexId)).size,
    batches: new Set(unread.map(item => item.batch.id)).size,
    latestDate: batches[0]?.date || '',
    hasAny: batches.length > 0,
  };
}

export function markUpdatesRead() {
  const ids = readIds();
  for (const batch of batches) {
    for (const book of batch.books) ids.add(readKey(batch.id, book.codexId));
  }
  writeReadIds(ids);
}

export function markBatchBookRead(batchId, codexId) {
  const ids = readIds();
  ids.add(readKey(batchId, codexId));
  writeReadIds(ids);
}

/* ---------- 渲染 ---------- */

/* 面板「更新」页签：按日期倒序分组，每行一本书，点进去直达该书该批次的筛选。 */
export function renderUpdatesList(container) {
  if (!container) return;
  if (!batches.length) {
    container.innerHTML = '<div class="announcement-empty">暂无更新记录。</div>';
    return;
  }
  container.innerHTML = batches.map(batch => `
    <section class="update-day">
      <div class="update-day-head">
        <span class="update-day-date">${esc(formatBatchDate(batch.date))}</span>
        <span class="update-day-rel">${esc(relativeDay(batch.date))}</span>
        <span class="update-day-line" aria-hidden="true"></span>
        <span class="update-day-total">+${batch.count}</span>
      </div>
      ${batch.books.map(book => updateRow(batch, book)).join('')}
    </section>
  `).join('');
}

/* 顶栏气泡：先给一个总数回答「有没有、有多少」，再列最近几行。 */
export function renderUpdatesDigest(container, { limit = 3 } = {}) {
  if (!container) return;
  const digest = updatesDigest();
  const rows = [];
  for (const batch of batches) {
    for (const book of batch.books) {
      if (rows.length >= limit) break;
      if (digest.entries > 0 && isRead(batch.id, book.codexId)) continue;
      rows.push(updateRow(batch, book, { showDate: true }));
    }
    if (rows.length >= limit) break;
  }
  const hero = digest.entries > 0
    ? `<div class="update-pop-eyebrow">自你上次访问</div>
       <div class="update-pop-big">${digest.entries}<small>条新增</small></div>
       <div class="update-pop-sub">${digest.books} 本法典更新 · 最近 ${esc(formatBatchDate(digest.latestDate))}</div>`
    : `<div class="update-pop-eyebrow">更新动态</div>
       <div class="update-pop-big is-quiet">暂无新更新</div>
       <div class="update-pop-sub">${digest.hasAny ? `最近一次 ${esc(formatBatchDate(digest.latestDate))}` : '还没有记录在案的更新'}</div>`;
  container.innerHTML = `
    <div class="update-pop-hero">${hero}</div>
    ${rows.length ? `<div class="update-pop-list">${rows.join('')}</div>` : ''}
    <div class="update-pop-foot">
      <button type="button" class="update-pop-more" data-updates-open="updates">查看全部更新记录</button>
      <div class="update-pop-links">
        <button type="button" data-updates-open="announcements">公告<i class="update-pop-dot" data-updates-ann-dot hidden></i></button>
        <button type="button" data-updates-open="feedback">反馈进度</button>
      </div>
    </div>`;
}

function updateRow(batch, book, { showDate = false } = {}) {
  const meta = findCodexMeta(book.codexId);
  const cover = meta ? codexCoverUrl(meta) : '';
  const title = meta?.title || book.title || book.codexId;
  const unread = !isRead(batch.id, book.codexId);
  const sub = showDate
    ? `${esc(formatBatchDate(batch.date))} · ${esc(book.label || '更新')}`
    : esc(book.label || '更新');
  return `
    <button type="button" class="update-row${unread ? ' is-unread' : ''}"
            data-update-batch="${esc(batch.id)}" data-update-codex="${esc(book.codexId)}">
      ${cover
        ? `<img class="update-row-cover" src="${esc(cover)}" alt="" loading="lazy" decoding="async">`
        : '<span class="update-row-cover is-empty" aria-hidden="true"></span>'}
      <span class="update-row-main">
        <span class="update-row-title">${esc(title)}</span>
        <span class="update-row-sub">${sub}</span>
      </span>
      <span class="update-row-count">+${book.count}</span>
    </button>`;
}

/* 面板与气泡共用的行点击：认下 data 属性就跳，不关心自己长在哪个容器里。
   consumeLayer 交给调用方声明——从面板里点是「顶掉面板这一层」，从气泡里点没有层可顶；
   猜错会顶掉别人的浮层，所以不在这里推断。 */
export function handleUpdateRowClick(event, { consumeLayer = false } = {}) {
  const row = event.target.closest?.('[data-update-batch]');
  if (!row) return null;
  const batchId = String(row.dataset.updateBatch || '');
  const codexId = String(row.dataset.updateCodex || '');
  if (!batchId || !codexId) return null;
  markBatchBookRead(batchId, codexId);
  void updatesActions.openBatch({ codexId, batchId, consumeLayer });
  return { batchId, codexId };
}

/* ---------- 内部 ---------- */

function readKey(batchId, codexId) {
  return `${codexId}@${batchId}`;
}

function isRead(batchId, codexId) {
  return readIds().has(readKey(batchId, codexId));
}

function readIds() {
  let raw = null;
  try {
    raw = localStorage.getItem(READ_STORAGE_KEY);
  } catch {}
  const arr = safeJsonParse(raw, []);
  return new Set(Array.isArray(arr) ? arr.map(String) : []);
}

function writeReadIds(ids) {
  try {
    localStorage.setItem(READ_STORAGE_KEY, JSON.stringify([...ids].slice(-MAX_READ_KEYS)));
  } catch {}
}

/* 首次访问的人没有"上次访问"可言：把最新一批之外的历史直接标已读，
   否则新用户一进站就会看到「自你上次访问 4577 条新增」这种假差分。 */
function seedFirstRun() {
  let seeded = null;
  try {
    seeded = localStorage.getItem(SEEDED_STORAGE_KEY);
  } catch {}
  if (seeded) return;
  const ids = readIds();
  for (const batch of batches.slice(1)) {
    for (const book of batch.books) ids.add(readKey(batch.id, book.codexId));
  }
  writeReadIds(ids);
  try {
    localStorage.setItem(SEEDED_STORAGE_KEY, '1');
  } catch {}
}

function normalizeUpdates(data) {
  const list = Array.isArray(data?.batches) ? data.batches : [];
  return list
    .map(batch => {
      const id = String(batch?.id || '').trim();
      const date = String(batch?.date || '').trim();
      const books = (Array.isArray(batch?.books) ? batch.books : [])
        .map(book => ({
          codexId: String(book?.codexId || '').trim(),
          title: String(book?.title || '').trim(),
          type: String(book?.type || '').trim(),
          label: String(book?.label || '').trim(),
          latest: book?.latest === true,
          count: Number(book?.count) || 0,
        }))
        .filter(book => book.codexId && book.count > 0);
      return {
        id,
        date,
        books,
        count: books.reduce((sum, book) => sum + book.count, 0),
      };
    })
    .filter(batch => batch.id && batch.date && batch.books.length)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, MAX_BATCHES);
}

function formatBatchDate(iso) {
  const parts = String(iso || '').split('-');
  if (parts.length !== 3) return String(iso || '');
  return `${Number(parts[1])} 月 ${Number(parts[2])} 日`;
}

/* 只做到「天」的粒度：更新是按批次发的，精确到小时既不真实也没有意义。 */
function relativeDay(iso) {
  const ts = Date.parse(`${iso}T00:00:00`);
  if (!Number.isFinite(ts)) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - ts) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}
