import { state, RANDOM_RECENT_LIMIT, NSFW_LOCKED_MESSAGE } from './state.js';
import { $, esc, samePath, pathStartsWith, relativeDay, updateSearchClear, prefersReducedMotion, safeHttpUrl } from './utils.js';
import { isCodexLocked, showNsfwLockedHint, showR18gLockedHint, isEntryAccessBlocked, isEntryNsfw, isNsfwPathSegment, isR18gEntry, isR18gName } from './access.js';
import { codexStatusLabel, codexStatusClass, codexStatusTitle, codexUpdateFilters, updateFilterDefinitions } from './data.js';
import { hasEntryImage, thumbUrl } from './media.js';
import { toast } from './feedback.js';
import { bindOutsideDismiss } from './modal.js';
import { createSelectMenu } from './select-menu.js';
import { animateUi, cancelUiMotion } from './ui-motion.js';
import { renderBannerInsert, syncBannerInsertState } from './banner-insert.js';
import {
  closeHistoryLayer,
  forgetHistoryLayer,
  getManagedHistoryEntry,
  openHistoryLayer,
  registerHistoryLayer,
  topHistoryLayerId,
} from './browser-history.js';

/* 选择器类型图标（描边 SVG，跟随 currentColor） */
const TYPE_ICONS = {
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H18a1 1 0 0 1 1 1v15H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M8 4v16"/></svg>',
  palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 1.9-1 1.9-1.9 0-.5-.3-.9-.3-1.6 0-.7.6-1.2 1.4-1.2H17a3.5 3.5 0 0 0 3.5-3.5C20.5 6.9 16.7 3.5 12 3.5Z"/><circle cx="8" cy="10.5" r="1"/><circle cx="12" cy="8" r="1"/><circle cx="16" cy="10.5" r="1"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.5" cy="10" r="1.6"/><path d="m4.5 17 4.8-4.8a1.5 1.5 0 0 1 2.1 0L16.2 17"/><path d="m13.8 14.6 1.4-1.4a1.5 1.5 0 0 1 2.1 0L20 16"/></svg>',
  /* 构图＝取景框 + 三分线；内线单独收细，17px 下五条线不糊成一块 */
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.2 4.5v15M14.8 4.5v15M3.5 9.5h17M3.5 14.5h17" stroke-width="1.4"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3 2"/></svg>',
};

/* 锁图标：封面蒙版与 R18 小标共用 */
const LOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>';

/* 投稿门图标：加号（贡献语义）+ 外链箭头（离站前往社区） */
const DOOR_PLUS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const DOOR_OUT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4.5"/></svg>';

/* 选择器类型分类法。法典 / 画风 / 构图 / 图包均可由 codexes.json 按 type 接入。
   某类型在 codexes.json 里没有对应 type 的真法典时，显示其 placeholders（点击只提示「即将上线」，进不去）。
   将来给某本加 type:"string"/"composition"/"pack" 即自动变为可加载、该类占位被忽略。
   ⚠ 2026-08-31 类型名统一成两字并新增「构图」（装构图/服装/场景，成员曾塞在画风串里）。
   「构图」这个名字与将来的服装类典存在已知张力，是维护者定案，别改名——见 docs/decisions/法典重归类.md。 */
const CODEX_TYPES = [
  { id: 'codex', name: '法典', sub: '按分类查词条', icon: 'book' },
  { id: 'string', name: '画风', sub: '画师词典与画风串', icon: 'palette' },
  { id: 'composition', name: '构图', sub: '构图 · 服装 · 场景', icon: 'grid' },
  { id: 'pack', name: '图包', sub: '社区原图与生成参数', icon: 'image', placeholders: [
    { title: '精选构图图包', meta: '原图直出 · 含 NAI 生成参数' },
  ] },
];

/* 电脑端每类是一卷：书脊与卷头都写「卷一 / 卷二…」 */
const VOLUME_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const volumeLabel = index => `卷${VOLUME_NUMERALS[index] || index + 1}`;
const RECENT_UPDATE_MS = 7 * 24 * 3600 * 1000;

const codexType = c => (c && c.type) || 'codex';
const codexPickerTitle = c => c?.selectorTitle || c?.title || '';
const realCodexesOfType = typeId => state.codexes.filter(c => codexType(c) === typeId);
const typeIconOf = c => (CODEX_TYPES.find(t => t.id === codexType(c)) || CODEX_TYPES[0]).icon;
const codexImagedPct = c => (c?.entryCount ? Math.round(Number(c.imagedCount || 0) / Number(c.entryCount) * 100) : 0);
/* 线路图站点的红点：最新一期更新在 7 天内 */
const isRecentlyUpdated = c => {
  const latest = updateFilterDefinitions(c).find(filter => filter.latest);
  return Boolean(latest && Number.isFinite(latest.time) && Date.now() - latest.time < RECENT_UPDATE_MS);
};
/* 外部数据源：书与图都托管在别人站上（只用来打「外部源」小标） */
const isExternalCodex = c => /^https?:/i.test(String(c?.dataUrl || ''));
/* NovelAI 官方标记，由官方图描成的单色矢量：深底那版的锚点与手柄本就是从笔尖里挖掉的，
   所以填 currentColor 后浅底深底都成立，不需要两套图。 */
const V5_MARK = '<svg viewBox="0 0 64 64" focusable="false" aria-hidden="true"><path fill-rule="evenodd" fill="currentColor" d="M27.05,0.03 26.39,0.35 25.92,0.92 19.14,15.67 13.01,27.79 9.43,34.04 6.04,39.02 5.78,39.68 5.77,40.34 6.1,41.22 8.97,43.42 10.63,44.96 12.55,47.17 14.71,50.25 14.93,50.32 25.36,39.9 24.77,37.26 24.84,35.77 25.2,34.39 25.7,33.29 26.45,32.19 27.71,31 29.03,30.16 29.08,1.58 28.93,0.92 28.37,0.29 27.71,0.01ZM36.3,0 35.64,0.27 35.22,0.7 34.92,1.58 34.93,29.99 34.99,30.21 36.08,30.83 37.56,32.19 38.5,33.61 38.8,34.39 39.21,36.16 39.23,37.26 38.64,39.9 49.07,50.31 49.29,50.25 51.45,47.17 53.38,44.96 55.68,42.9 57.88,41.24 58.23,40.34 58.21,39.68 57.96,39.02 55.78,35.93 52.96,31.31 48.58,23.16 43.08,11.93 38.07,0.92 37.4,0.19ZM28.81,43.32 17.23,54.87 19.15,59.94 20.18,63.24 20.66,63.73 21.54,64 42.46,64 43.34,63.7 43.94,63.02 45.08,59.28 46.77,54.87 41.36,49.45 41.14,49.44 36.8,53.77 36.67,53.99 36.79,55.98 36.47,57.08 35.69,58.4 34.53,59.36 33.87,59.75 32.99,60 31.01,59.99 29.69,59.52 28.81,58.91 28.15,58.17 27.45,56.86 27.18,55.32 27.42,53.77 28.28,52.23 29.25,51.34 30.79,50.61 32.11,50.45 33.21,50.58 37.62,46.21 37.77,45.85 35.19,43.32 33.65,43.88 32.11,44.01 30.35,43.87Z"/></svg>';
const N5_LAUNCH_CODEX_IDS = new Set(['artist_nai5_personal', 'nai5_community_pack']);
const N5_LAUNCH_END_AT = Date.parse('2026-09-17T00:00:00+08:00');
const N5_LAUNCH_NOTICE_KEY = 'nai5-launch-notice:2026-08';

export const isN5LaunchCodex = c => N5_LAUNCH_CODEX_IDS.has(c?.id || '');

/* 版面右下角的日期戳：取上线两本里较新的版本日期，统一补零成 2026.08.26 – ver 5.0。
   版本号形如 2026.8.26，按字符串排会把 12 月排到 8 月前面，所以拆成数字比。 */
const parseCodexVersion = value => {
  const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(String(value || '').trim());
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
};
function n5LaunchStamp(list) {
  const latest = list.map(c => parseCodexVersion(c?.version))
    .filter(Boolean)
    .sort((a, b) => (a.y - b.y) || (a.m - b.m) || (a.d - b.d))
    .pop();
  const pad = n => String(n).padStart(2, '0');
  return latest ? `${latest.y}.${pad(latest.m)}.${pad(latest.d)} – ver 5.0` : 'ver 5.0';
}

/* 两本时写「两本」更像人话，将来多一本会自动退回「3 本」 */
const n5BooksLabel = count => (count === 2 ? '两本' : `${count} 本`);

function n5LaunchMode() {
  try {
    const mode = new URLSearchParams(window.location.search).get('n5Launch');
    if (mode === 'off') return { active: false, forceNotice: false };
    if (mode === 'preview') return { active: true, forceNotice: true };
  } catch {
    // URL 参数不可读时仍按正式上线窗口判断。
  }
  return { active: Date.now() < N5_LAUNCH_END_AT, forceNotice: false };
}

/* 模型例图优先展示模型来源；其余书沿用原图能力签。 */
const codexExampleLabel = c => {
  const model = String(c?.exampleModel || '').trim();
  return model ? `${model}模型例图` : '';
};

/* 书卡状态签顺序：模型来源 / 原图能力 → NSFW → 其他来源状态 → 更新日期最后。
   NSFW 解锁/未解锁两枚签同时留在 DOM，由 .locked 类切换，避免刷新整张书卡。 */
export function renderCodexChips(c = {}) {
  const hasOriginal = c.hasOriginal === true;
  const exampleLabel = codexExampleLabel(c);
  const chips = document.body.classList.contains('local-edition') ? [] : [
    exampleLabel ? `<span class="ci-chip model-example">${esc(exampleLabel)}</span>` :
    `<span class="ci-chip orig ${hasOriginal ? 'has-orig' : 'no-orig'}">${hasOriginal ? '含原图' : '无原图'}</span>`,
  ];
  if (c.nsfw) {
    chips.push(`<span class="ci-chip nsfw">NSFW</span><span class="ci-chip lock">${LOCK_ICON}NSFW</span>`);
  }
  if (isExternalCodex(c)) chips.push('<span class="ci-chip ext">外部源</span>');
  const updateLabel = updateFilterDefinitions(c).find(filter => filter.latest)?.label || '';
  if (updateLabel) chips.push(`<span class="ci-chip new">${esc(updateLabel)}</span>`);
  return chips.join('');
}

/* 选择器封面：codexes.json 的 `cover` 字段（本站书＝该书图片目录下的缩略图文件名，
   外部源书＝对方站上的相对路径，两者都由 thumbUrl 按该书的 assetPathMode 解析）。
   没写就退化成占位块（渐变 + 类型图标），不会显示成坏图；换封面＝改这一行数据，不用动代码。 */
export function codexCoverUrl(c) {
  if (!c?.cover) return '';
  // coverCodexId：封面借用别本的图片前缀时才需要写（如合并册沿用的历史资源目录）
  return thumbUrl({ image: c.cover, assetRev: c.coverRev || '', assetCodexId: c.coverCodexId || '' }, c);
}

/* 封面构图只接受有界数值；独立 scale 与原有 hover transform 叠加。
   未配置时不输出 style 属性，继续使用各表面的默认构图。 */
export function codexCoverStyle(c) {
  const framing = coverFraming(c);
  if (!framing) return '';
  const { x, y, scale } = framing;
  return ` style="object-position:${x}% ${y}%;transform-origin:${x}% ${y}%;scale:${scale}"`;
}

function coverFraming(c) {
  const framing = c?.coverFraming;
  if (!framing || typeof framing !== 'object' || Array.isArray(framing)) return null;
  const bounded = (value, min, max, fallback) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  return { x: bounded(framing.x, 0, 100, 50), y: bounded(framing.y, 0, 100, 50), scale: bounded(framing.scale, 1, 2, 1) };
}

/* 详情横幅与法典选择器必须服从同一份 cover 元数据；只有未配置封面时，
   才回退到首条有图词条，供收藏总览等虚拟法典继续正常显示。 */
export function codexBannerCoverEntry(c = {}) {
  if (c.cover) {
    return {
      image: c.cover,
      assetRev: c.coverRev || '',
      assetCodexId: c.coverCodexId || '',
    };
  }
  return (Array.isArray(c.entries) ? c.entries : []).find(hasEntryImage) || null;
}
const pickerActiveCodex = () => (state.favoritesView || state.siteSearchView) ? state.browseCodex : state.codex;
const pickerActiveCodexId = () => pickerActiveCodex()?.id || '';
const hasActiveSearch = () => Boolean(state.searchPlan?.hasActiveSearch || state.query.trim() || state.searchFilterValues?.length);
const EMPTY_ACCESS_ENTRIES = Object.freeze([]);
const EMPTY_ACCESS_PATHS = Object.freeze([]);
let accessViewMemo = null;

const codexUiActions = {
  loadCodex: async () => {},
  applyFilter: () => {},
  applySearch: async () => {},
  syncUrlState: () => {},
  openLightbox: () => {},
  updateVirtualCards: () => {},
  loadUpdates: async () => [],
  openUpdateBatch: async () => {},
  isContentBlocked: () => false,
  bookPreviews: () => [],
  bookPalette: () => null,
};

export function setCodexUiActions(actions = {}) {
  Object.assign(codexUiActions, actions);
}

export function invalidateAccessViewMemo() {
  accessViewMemo = null;
}

/* 自绘法典选择器：PC = 四卷（每类一卷并排，打开的那卷占满，其余收成书脊）；
   移动端 = 线路图（每类一条竖向线路，书是线上的站，全部展开）。
   两套布局都沿用 `.codex-type[data-type]` / `.codex-item[data-id]` 与 `.locked/.active`，
   verify_ui 与 updateCodexPickerState 靠这几个钩子。原生 #codexSelect 仅做值同步。 */
export function setupCodexPicker() {
  const sel = $('#codexSelect');
  const btn = $('#codexBtn');
  const menu = $('#codexMenu');
  if (!btn || !menu) return;

  let activeType = null;  // 四卷里当前打开的那一卷
  let dismissN5LaunchNotice = () => {};
  let updateBatches = null;  // updates.json 的批次；卷头「最近新增」读它，载入前为 null
  const n5Launch = n5LaunchMode();
  const n5LaunchActive = n5Launch.active && state.codexes.some(isN5LaunchCodex);
  document.body.classList.toggle('n5-launch-active', n5LaunchActive);

  /* 已打开那卷的书脊被卷体盖住、tabindex=-1，方向键要跳过它 */
  const focusableItems = () => [...menu.querySelectorAll('.n5-launch-book, .codex-type, .vr-cap, .codex-item, .codex-door')]
    .filter(el => el.tabIndex >= 0 && el.getClientRects().length);
  const focusItem = index => {
    const list = focusableItems();
    if (!list.length) return;
    list[(index + list.length) % list.length].focus();
  };
  const focusPreferredItem = ({ preventScroll = n5LaunchActive } = {}) => {
    if (menu.hidden) return;
    const target = (n5LaunchActive && menu.querySelector('.n5-launch-panel')) ||
      menu.querySelector('.codex-item.active') || focusableItems()[0];
    target?.focus({ preventScroll });
  };
  const mobileLayout = window.matchMedia('(max-width: 600px)');
  const isMobile = () => mobileLayout.matches;
  /* 四卷比按钮宽得多：窄桌面上「按钮左沿 + 菜单宽」会超出视口，往左收回来。手机端走 fixed，不处理。 */
  const placeMenu = () => {
    menu.style.left = '';
    if (menu.hidden || isMobile()) return;
    const overflow = menu.getBoundingClientRect().right - (document.documentElement.clientWidth - 14);
    if (overflow > 0) menu.style.left = `${-Math.ceil(overflow)}px`;
  };
  const openDirect = ({ focus = false } = {}) => {
    // 上一次换书留下的「按下」淡化，只属于那一次关闭
    menu.classList.remove('is-choosing');
    renderMenu();
    menu.inert = false;
    menu.hidden = false;
    placeMenu();
    ensureUpdates();
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    if (focus) requestAnimationFrame(() => focusPreferredItem());
  };
  const closeDirect = ({ focusButton = false } = {}) => {
    menu.inert = true;
    menu.hidden = true;
    btn.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    if (focusButton) btn.focus({ preventScroll: true });
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
    // 手机登记过的层随本次打开会话保留到真正关闭，跨回桌面也要消费。
    if (historyMode !== 'none' && topHistoryLayerId() === 'codex-menu' && closeHistoryLayer('codex-menu')) return;
    closeDirect({ focusButton });
  };
  closePickerRef = close;   // 供外部模块（本地编辑模式）正确收起选择器，含移动端托管历史层

  /* 换书接力的起点：按下那本书的封面图和它露出来的那一格（frame）。四本卷的样张条以条里第一张（就是封面）
     为准、只露它自己那一窄条；没配封面、图还没载好时不飞，横幅照常原地换。
     framing 是新书横幅封面的构图，替身落定时要和横幅取景一致。 */
  const switchOrigin = (c, source) => {
    if (!source || !c?.cover) return null;
    const strip = source.querySelector('.vb-strip img');
    const img = strip || source.querySelector('.ci-cover > img') || source.querySelector('.n5b-cover img');
    if (!img || !img.complete || !img.naturalWidth) return null;
    if (img.matches('.ci-cover > img') && !img.classList.contains('is-loaded')) return null;
    const frame = strip || img.closest('.ci-cover, .n5b-cover');
    if (!frame) return null;
    const framing = coverFraming(c);
    return { img, frame, framing: framing && { x: framing.x / 100, y: framing.y / 100, scale: framing.scale } };
  };

  const chooseCodex = (c, source) => {
    if (!c) return;
    if (isCodexLocked(c)) { showNsfwLockedHint(); return; }
    dismissN5LaunchNotice();
    menu.querySelectorAll('.is-selecting').forEach(el => el.classList.remove('is-selecting'));
    source?.classList.add('is-selecting');
    const changed = state.favoritesView || state.siteSearchView || sel.value !== c.id;
    if (!changed) {
      close({ focusButton: true });
      return;
    }
    const consumeLayer = topHistoryLayerId() === 'codex-menu';
    // 起点要在菜单开始退场前量：关菜单只是挂上退场过渡，同一帧里位置还准
    const origin = switchOrigin(c, source);
    menu.classList.add('is-choosing');
    close({ focusButton: true, historyMode: 'none' });
    sel.value = c.id;
    codexUiActions.loadCodex(c.id, { historyMode: 'push', transition: 'route', consumeLayer, origin });
  };

  /* 卷头「最近新增」的点击：进那本书并落到那一批，和顶栏「最近更新」的行点击同一条路 */
  const chooseBatch = (codexId, batchId) => {
    const c = state.codexes.find(item => item.id === codexId);
    if (!c || !batchId) return;
    if (isCodexLocked(c)) { showNsfwLockedHint(); return; }
    dismissN5LaunchNotice();
    const consumeLayer = topHistoryLayerId() === 'codex-menu';
    close({ focusButton: true, historyMode: 'none' });
    sel.value = c.id;
    void codexUiActions.openUpdateBatch({ codexId: c.id, batchId, consumeLayer });
  };

  /* 更新索引顶栏开站时就在载，这里只是复用同一个 Promise；载好时菜单若开着，把占位换成「最近新增」 */
  const ensureUpdates = () => {
    if (updateBatches) return;
    Promise.resolve(codexUiActions.loadUpdates()).then(list => {
      updateBatches = Array.isArray(list) ? list : [];
      if (menu.hidden) return;
      menu.querySelectorAll('.vol-recent.is-pending').forEach(el => {
        const t = buildTypes().find(item => item.id === el.dataset.type);
        if (t) el.outerHTML = recentHTML(t);
      });
      menu.querySelectorAll('.vol-grid[data-layout="strips"] .vbook[data-id]').forEach(addPreviewStrip);
    }, () => { updateBatches = []; });
  };

  /* 4 本卷「样张条」：封面位换成封面 + 书内几张竖图并排（构建时挑好，codexes.json 写 previews 可单独指定）。
     未解锁的书保持糊掉的单张封面；带 nsfw 标记的样图只给已解锁访客看；索引里没有就保持单张封面。 */
  const addPreviewStrip = card => {
    if (card.classList.contains('locked') || card.querySelector('.vb-strip')) return;
    const c = state.codexes.find(item => item.id === card.dataset.id);
    if (!c) return;
    const previews = (codexUiActions.bookPreviews(c.id) || [])
      .filter(item => (!item.nsfw || state.allowNsfw) && !codexUiActions.isContentBlocked({ id: item.id, _srcCodexId: c.id }));
    if (!previews.length) return;
    const framing = c.coverFraming && typeof c.coverFraming === 'object' ? c.coverFraming : null;
    const cover = codexCoverUrl(c);
    const shots = [
      ...(cover ? [{ url: cover, position: framing ? `${framing.x ?? 50}% ${framing.y ?? 50}%` : '' }] : []),
      ...previews.map(item => ({ url: thumbUrl({ image: item.image, assetRev: item.assetRev, assetCodexId: item.assetCodexId }, c) })),
    ].slice(0, 4);
    const strip = document.createElement('span');
    strip.className = 'vb-strip';
    strip.setAttribute('aria-hidden', 'true');
    strip.innerHTML = shots.map((shot, s) =>
      `<img src="${esc(shot.url)}" alt="" loading="lazy" decoding="async" style="--s:${s}${shot.position ? `;object-position:${shot.position}` : ''}">`).join('');
    card.querySelector('.ci-cover')?.appendChild(strip);
  };

  /* 卷头「最近新增」：这一类里访客看得到的最近一次更新（维护者给某本书那一批标了 pickerHidden 的不算）。
     条数按访客能看到的算（未解锁 NSFW 用 safeCount）。样图来自 updates.json 的 samples：默认只挑能公开的，
     维护者指定的成人档样图带 nsfw 标记、只给已解锁的访客看。没有能看的图时改画「新增分布」——这一批落在
     哪几个目录、各多少条；连目录都数不出才用「待配图」卡顶上；索引里没有这一类的更新时退回前几本的封面。 */
  const visibleUpdateCount = book => (state.allowNsfw ? book.count : book.safeCount);
  const recentForType = t => {
    const open = new Map(t.real.filter(c => !isCodexLocked(c)).map(c => [c.id, c]));
    for (const batch of updateBatches || []) {
      const books = batch.books
        .filter(book => !book.pickerHidden && open.has(book.codexId) && visibleUpdateCount(book) > 0)
        .map(book => ({ ...book, meta: open.get(book.codexId), shown: visibleUpdateCount(book) }))
        .sort((a, b) => b.shown - a.shown);
      if (books.length) return { batch, books };
    }
    return null;
  };
  const mergeDirs = books => {
    const totals = new Map();
    books.forEach(book => (state.allowNsfw ? book.dirs : book.safeDirs)
      .forEach(([name, count]) => totals.set(name, (totals.get(name) || 0) + count)));
    return [...totals].sort((a, b) => b[1] - a[1]).slice(0, 3);
  };
  const recentHTML = t => {
    if (!updateBatches) return `<span class="vol-recent is-pending" data-type="${esc(t.id)}" aria-hidden="true"></span>`;
    // 旧版索引（线上数据还没用新脚本重建时）没有样图、分布和可见条数，整块退回封面
    const recent = updateBatches.some(batch => batch.books.some(book => book.hasPreview)) ? recentForType(t) : null;
    if (!recent) return t.real.length ? `<span class="vol-collage" aria-hidden="true">${t.real.slice(0, 4).map(c => miniCover(c, 'vc-card')).join('')}</span>` : '';
    const { batch, books } = recent;
    const lead = books[0];
    const total = books.reduce((sum, book) => sum + book.shown, 0);
    const [, month, day] = String(batch.date).split('-').map(Number);
    const when = `${month}.${day}`;
    const what = books.length > 1 ? `${codexPickerTitle(lead.meta)} 等 ${books.length} 本` : codexPickerTitle(lead.meta);
    const target = codexId => `data-recent-codex="${esc(codexId)}" data-recent-batch="${esc(batch.id)}"`;
    const samples = books
      .flatMap(book => book.samples.map(sample => ({ ...sample, book })))
      .filter(sample => (!sample.nsfw || state.allowNsfw) &&
        !codexUiActions.isContentBlocked({ id: sample.id, _srcCodexId: sample.book.codexId }))
      .slice(0, 4);
    const dirs = samples.length ? [] : mergeDirs(books);
    let visual;
    if (samples.length) {
      visual = `<span class="vol-collage vr-fan" style="--k:${samples.length}">` + samples.map((sample, j) =>
        `<button type="button" class="vc-card vr-card" style="--j:${j}" tabindex="-1" ${target(sample.book.codexId)} ` +
        `aria-label="${esc(codexPickerTitle(sample.book.meta))} ${when} 新增">` +
        `<img src="${esc(thumbUrl({ image: sample.image, assetRev: sample.assetRev, assetCodexId: sample.assetCodexId }, sample.book.meta))}" alt="" loading="lazy" decoding="async"></button>`).join('') +
        `</span>`;
    } else if (dirs.length) {
      const top = dirs[0][1];
      visual = `<button type="button" class="vr-dist" tabindex="-1" ${target(lead.codexId)} aria-label="${esc(what)} ${when} 新增分布">` +
        `<span class="vr-dist-k">新增分布</span>` +
        dirs.map(([name, count], i) =>
          `<span class="vr-row" style="--i:${i};--w:${Math.max(6, Math.round(count / top * 100))}%">` +
          `<span class="vr-name">${esc(name)}</span><b>${count.toLocaleString()}</b><span class="vr-bar"></span></span>`).join('') +
        `</button>`;
    } else {
      visual = `<span class="vol-collage vr-fan" style="--k:3">` +
        `<span class="vc-card vr-blank" style="--j:0"></span><span class="vc-card vr-blank" style="--j:1"></span>` +
        `<button type="button" class="vc-card vr-card vr-num" style="--j:2" tabindex="-1" ${target(lead.codexId)} aria-label="${esc(what)} ${when} 新增">` +
        `${TYPE_ICONS.image}<i>待配图</i></button></span>`;
    }
    return `<span class="vol-recent">` +
      `<button type="button" class="vr-cap" ${target(lead.codexId)}>` +
      `<span class="vr-k">最近新增</span><b>+${total.toLocaleString()}<i>条</i></b>` +
      `<span class="vr-sub">${when} · ${esc(codexPickerTitle(lead.meta))}` +
      (books.length > 1 ? ` <span class="vr-more">等 ${books.length} 本</span>` : '') + `</span></button>` +
      visual + `</span>`;
  };

  /* 类型清单：每类带真实法典 real[] 与是否占位 soon */
  const buildTypes = () => CODEX_TYPES.map(t => {
    const real = realCodexesOfType(t.id);
    return { ...t, real, soon: real.length === 0 };
  }).filter(t => !document.body.classList.contains('local-edition') || t.real.length > 0);

  /* 封面槽：占位块永远在底下垫着，图加载成功才淡入盖上去；图挂了/没配封面都自然露出占位，不会有破图 */
  const coverSlot = (iconKey, url = '', c = null, extra = '') =>
    `<span class="ci-cover">` +
    `<span class="ci-ph">${TYPE_ICONS[iconKey]}</span>` +
    (url ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async"${codexCoverStyle(c)}>` : '') +
    `<span class="ci-veil">${LOCK_ICON}</span>` + extra +
    `</span>`;

  const bindCoverReveal = item => {
    const img = item.querySelector('.ci-cover img');
    if (!img) return;
    const reveal = () => img.classList.add('is-loaded');
    if (img.complete && img.naturalWidth) reveal();
    else img.onload = reveal;   // 失败时保持透明，露出下面的占位块
  };

  /* 一本书一个按钮：variant = 'vbook'（四卷里的等大书卡）| 'stn'（线路图上的站）。
     两种都是 .codex-item[data-id]，状态签与锁态同一套：含原图 / NSFW 两枚都进 DOM，靠 .locked 二选一。 */
  const makeRealItem = (c, variant) => {
    const locked = isCodexLocked(c);
    const active = pickerActiveCodexId() === c.id;
    const n5Featured = n5LaunchActive && isN5LaunchCodex(c);
    const pct = codexImagedPct(c);
    const count = Number(c.entryCount || 0);
    const cover = codexCoverUrl(c);
    /* 版本恰好是「外部源」时不和外部源小标重复说一遍 */
    const version = c.version === '外部源' ? '' : c.version;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `codex-item ${variant}${locked ? ' locked' : ''}${active ? ' active' : ''}`;
    item.dataset.id = c.id;
    item.setAttribute('aria-disabled', locked ? 'true' : 'false');
    /* 锁定状态不写进 aria-label：解锁后只改类不重建，写了会残留成过期描述；由 aria-disabled + title 表达 */
    item.setAttribute('aria-label',
      `${codexPickerTitle(c)}，${c.author || '未知作者'}，${count} 条词条，配图率 ${pct}%${n5Featured ? '，V5 新上线' : ''}`);
    if (active) item.setAttribute('aria-current', 'true');
    if (locked) item.title = NSFW_LOCKED_MESSAGE;
    const ring = `<span class="ci-ring" style="--p:${pct}" title="配图率 ${pct}%" aria-hidden="true"><i></i></span>`;
    const stat = `<span class="ci-n"><b>${count.toLocaleString()}</b><i>条</i></span>${ring}`;
    const main =
      `<span class="ci-main">` +
      // 书名一行排不下时省略；悬停给出书的全名
      `<span class="ci-head"><span class="ci-name" title="${esc(c.title || codexPickerTitle(c))}">${esc(codexPickerTitle(c))}</span>` +
      (active ? '<span class="ci-now">当前</span>' : '') +
      (n5Featured ? '<span class="ci-n5-chip">V5</span>' : '') + `</span>` +
      `<span class="ci-sub">${esc([c.author || '未知作者', version].filter(Boolean).join(' · '))}</span>` +
      `<span class="ci-tags">${renderCodexChips(c)}</span>` +
      `</span>`;
    item.innerHTML = variant === 'stn'
      ? coverSlot(typeIconOf(c), cover, c) + main + `<span class="stn-stat">${stat}</span>` +
        (isRecentlyUpdated(c) ? '<span class="stn-fresh" aria-hidden="true"></span>' : '')
      : coverSlot(typeIconOf(c), cover, c, `<span class="vb-stat">${stat}</span>`) + main;
    bindCoverReveal(item);
    item.onclick = () => chooseCodex(c, item);
    return item;
  };

  const makeSoonItem = (t, ph, variant) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `codex-item ${variant} soon`;
    item.dataset.soon = t.id;
    item.innerHTML =
      coverSlot(t.icon) +
      `<span class="ci-main">` +
      `<span class="ci-head"><span class="ci-name">${esc(ph.title)}</span></span>` +
      `<span class="ci-sub">${esc(ph.meta || '')}</span>` +
      `<span class="ci-tags"><span class="ci-soon-chip">占位册</span></span>` +
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

  const makeN5LaunchPanel = () => {
    if (!n5LaunchActive) return null;
    const featured = state.codexes.filter(isN5LaunchCodex);
    if (!featured.length) return null;
    const entries = featured.reduce((sum, c) => sum + Number(c.entryCount || 0), 0);
    const stamp = n5LaunchStamp(featured);
    const panel = document.createElement('section');
    panel.className = 'n5-launch-panel';
    panel.tabIndex = -1;
    panel.setAttribute('aria-label', 'NovelAI V5 新模型法典');
    /* 左栏标题、右栏书目，中间靠 1px 竖线分栏；日期戳窄屏时换到整块右下角（.n5-stamp-foot）。 */
    panel.innerHTML =
      `<div class="n5-launch-head">` +
      `<span class="n5-brand">${V5_MARK}</span>` +
      `<span class="n5-eyebrow">NEW · NOVELAI V5</span>` +
      `<strong>新模型法典</strong>` +
      `<small>${n5BooksLabel(featured.length)} · ${entries.toLocaleString()} 条词条</small>` +
      `<span class="n5-stamp">${esc(stamp)}</span>` +
      `</div>` +
      `<div class="n5-launch-books">${featured.map(c => {
        const shortTitle = c.id === 'artist_nai5_personal' ? '画师词典' : '社区精选图包';
        const count = Number(c.entryCount || 0);
        const cover = codexCoverUrl(c);
        return `<button type="button" class="n5-launch-book" data-id="${esc(c.id)}" ` +
          `aria-label="${esc(shortTitle)}，${count} 条词条">` +
          `<span class="n5b-cover">` +
          (cover ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async"${codexCoverStyle(c)}>` : '') +
          `</span>` +
          `<span class="n5b-main">` +
          `<span class="n5b-name">${esc(shortTitle)}</span>` +
          `<span class="n5b-sub">${esc(c.author || '未知作者')}</span>` +
          `</span>` +
          `<span class="n5b-n">${count.toLocaleString()}<i>条</i></span>` +
          `<span class="n5-tag">V5</span>` +
          `</button>`;
      }).join('')}</div>` +
      `<span class="n5-stamp n5-stamp-foot">${esc(stamp)}</span>` +
      `<span class="n5-wm" aria-hidden="true">V5</span>`;
    panel.querySelectorAll('.n5-launch-book').forEach(book => {
      book.onclick = () => chooseCodex(featured.find(c => c.id === book.dataset.id), book);
    });
    return panel;
  };

  /* 社区投稿门：置底一扇明确标记的「门」（虚线卡+加号），点击离站前往社区共建站（走跨页 View Transition）。
     刻意做成和策展书行视觉区分的样子——它是共建入口，不是第四本书。 */
  const makeSubmitDoor = () => {
    const wrap = document.createElement('div');
    wrap.className = 'codex-door-wrap';
    const a = document.createElement('a');
    a.className = 'codex-door';
    a.href = '/strings.html';
    a.setAttribute('aria-label', '前往社区共建，投稿你的图片与提示词作品');
    a.innerHTML =
      `<span class="cd-ico">${DOOR_PLUS_ICON}</span>` +
      `<span class="cd-main">` +
      `<span class="cd-name">社区共建 · 去投稿</span>` +
      `<span class="cd-sub">浏览大家的图片与提示词作品，也加入你的一份</span>` +
      `</span>` +
      `<span class="cd-out">${DOOR_OUT_ICON}</span>`;
    wrap.appendChild(a);
    codexUiActions.decorateDoor?.(wrap);   // 本地编辑模式会把这扇门改成「法典管理」，生产未注入即空转
    return wrap;
  };

  const fillItems = (container, t, variant) => {
    if (t.soon) {
      (t.placeholders || []).forEach(ph => container.appendChild(makeSoonItem(t, ph, variant)));
    } else {
      t.real.forEach(c => container.appendChild(makeRealItem(c, variant)));
    }
  };

  /* 入场动效按序号错开：--i 交给 CSS 算 animation-delay */
  const indexChildren = (container, start = 0) => {
    [...container.children].forEach((el, i) => el.style.setProperty('--i', start + i));
    return start + container.children.length;
  };
  const typeCount = t => (t.soon ? (t.placeholders || []).length : t.real.length);
  const typeEntries = t => t.real.reduce((sum, c) => sum + Number(c.entryCount || 0), 0);
  /* 书脊小封面与卷头拼贴共用；data-lock-id 让 updateCodexPickerState 就地切换锁态 */
  const miniCover = (c, cls) => {
    const url = codexCoverUrl(c);
    return `<span class="${cls}${isCodexLocked(c) ? ' locked' : ''}" data-lock-id="${esc(c.id)}">` +
      (url ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async"${codexCoverStyle(c)}>` : '') +
      `</span>`;
  };

  /* PC：四卷。每类一卷并排，打开的那卷靠 flex-grow 过渡撑开，其余收成书脊。
     卷体只给打开的那卷渲染、换卷时同步替换——`.codex-item[data-id]` 永远只列这一卷（verify_ui 依赖）。 */
  const renderVolumes = types => {
    menu.classList.add('volumes');
    menu.classList.remove('metro');
    menu.innerHTML = '';
    // 本地版允许从零法典启动；此时选择器只需要下面的“法典管理”门。
    if (!types.length) return;
    if (!activeType || !types.some(t => t.id === activeType)) {
      const preferred = codexType(pickerActiveCodex());
      activeType = types.some(t => t.id === preferred) ? preferred : types[0].id;
    }
    const vols = document.createElement('div');
    vols.className = 'codex-vols';
    vols.style.setProperty('--n', types.length);
    const volumes = types.map((t, index) => {
      const section = document.createElement('section');
      section.className = `codex-vol cat-${t.id}`;
      section.style.setProperty('--i', index);
      const spine = document.createElement('button');
      spine.type = 'button';
      spine.className = 'codex-type vol-spine';
      spine.dataset.type = t.id;
      spine.title = t.sub;
      spine.setAttribute('aria-controls', `codexVol-${t.id}`);
      spine.setAttribute('aria-label', `${volumeLabel(index)} ${t.name}，${typeCount(t)} 本`);
      spine.innerHTML =
        `<span class="vs-no">${volumeLabel(index)}</span>` +
        `<span class="vs-ico">${TYPE_ICONS[t.icon]}</span>` +
        `<span class="vs-name">${esc(t.name)}</span>` +
        `<span class="vs-n">${t.soon ? '<span class="codex-soon-tag">占位</span>' : `<b>${t.real.length}</b>本`}</span>` +
        `<span class="vs-thumbs" aria-hidden="true">${t.real.slice(0, 3).map(c => miniCover(c, 'vs-thumb')).join('')}</span>`;
      spine.onclick = () => setActive(t.id, { fromSpine: spine });
      const body = document.createElement('div');
      body.className = 'vol-body';
      body.id = `codexVol-${t.id}`;
      section.append(spine, body);
      vols.appendChild(section);
      return { t, index, section, spine, body };
    });
    const fillVolume = ({ t, index, body }) => {
      const head = document.createElement('header');
      head.className = 'vol-head';
      head.innerHTML =
        `<span class="vh-text"><span class="vh-no">${volumeLabel(index)}</span>` +
        `<span class="vh-name">${TYPE_ICONS[t.icon]}<b>${esc(t.name)}</b></span>` +
        `<span class="vh-sub">${esc(t.sub)}</span>` +
        (t.soon ? '' : `<span class="vh-stats"><span><b>${t.real.length}</b> 本 · <b>${typeEntries(t).toLocaleString()}</b> 条词条</span> · <span>圆环＝配图率</span></span>`) +
        `</span>` + recentHTML(t);
      const grid = document.createElement('div');
      grid.className = 'vol-grid';
      const count = typeCount(t);
      /* 卷内一律等大，排法按本数换，目的都是让竖构图的封面别被横着裁成一条：
         ≤3 本一行高卡；4 本 2×2「样张条」——封面位换成封面 + 书内几张竖图并排；
         5 本起两列「书架」——竖版封面在左、文字在右，法典的封面画成精装书（行多了网格内部滚动）。 */
      const layout = count <= 3 ? 'row' : count === 4 ? 'strips' : 'shelf';
      grid.dataset.layout = layout;
      grid.style.setProperty('--cols', count <= 3 ? Math.max(1, count) : 2);
      fillItems(grid, t, 'vbook');
      indexChildren(grid);
      if (layout === 'strips') grid.querySelectorAll('.vbook[data-id]').forEach(addPreviewStrip);
      if (layout === 'shelf') {
        // 封面只有 80 宽，条数与圆环挪进文字栏
        grid.querySelectorAll('.vbook').forEach(card => {
          const stat = card.querySelector('.ci-cover .vb-stat');
          if (stat) card.querySelector('.ci-main').appendChild(stat);
        });
      }
      body.replaceChildren(head, ...(t.soon ? [makeSoonBanner(t)] : []), grid);
    };
    const setActive = (id, { fromSpine = null } = {}) => {
      activeType = id;
      // 首次打开时卷内跟着书脊入场；换卷时等宽度过渡走一段再浮入
      vols.classList.toggle('is-switching', Boolean(fromSpine));
      volumes.forEach(v => {
        const open = v.t.id === id;
        v.section.classList.toggle('is-open', open);
        v.spine.classList.toggle('active', open);
        v.spine.setAttribute('aria-expanded', open ? 'true' : 'false');
        v.spine.tabIndex = open ? -1 : 0;
        v.body.inert = !open;
        if (open) fillVolume(v);
        else v.body.replaceChildren();
      });
      // 键盘换卷：被按的书脊随即藏到卷体后面，焦点交给新卷的第一本
      if (fromSpine && document.activeElement === fromSpine) {
        menu.querySelector('.codex-vol.is-open .codex-item')?.focus({ preventScroll: true });
      }
    };
    vols.addEventListener('click', ev => {
      const recent = ev.target.closest('[data-recent-batch]');
      if (recent) chooseBatch(recent.dataset.recentCodex, recent.dataset.recentBatch);
    });
    menu.appendChild(vols);
    setActive(activeType);
  };

  /* 手机：线路图。每类一条竖向线路，线路牌 + 一站一本，全部展开随面板滚动；
     手机上没有「选类型」这一步，所以不渲染 .codex-type。 */
  const renderMetro = types => {
    menu.classList.add('metro');
    menu.classList.remove('volumes');
    menu.innerHTML = '';
    let order = 0;
    types.forEach((t, index) => {
      const line = document.createElement('section');
      line.className = `metro-line cat-${t.id}${t.soon ? ' soon' : ''}`;
      line.style.setProperty('--li', index);
      line.innerHTML =
        `<div class="metro-badge" style="--i:${order}"><span class="mb-pill">${TYPE_ICONS[t.icon]}` +
        `<b>${esc(t.name)}</b><span class="mb-n">${t.soon ? '占位' : `${t.real.length} 本`}</span></span>` +
        `<span class="mb-sub">${esc(t.sub)}</span></div>`;
      if (t.soon) line.appendChild(makeSoonBanner(t));
      const track = document.createElement('div');
      track.className = 'metro-track';
      fillItems(track, t, 'stn');
      order = indexChildren(track, order + 1);
      line.appendChild(track);
      menu.appendChild(line);
    });
  };

  const renderMenu = () => {
    if (isMobile()) renderMetro(buildTypes());
    else renderVolumes(buildTypes());
    const launchPanel = makeN5LaunchPanel();
    if (launchPanel) menu.prepend(launchPanel);
    menu.appendChild(makeSubmitDoor());  // 两套布局末尾都挂投稿门
  };

  const setupN5LaunchNotice = () => {
    if (!n5LaunchActive) return;
    if (!n5Launch.forceNotice) {
      try {
        if (window.localStorage.getItem(N5_LAUNCH_NOTICE_KEY) === 'seen') return;
      } catch {
        // 隐私模式或禁用存储时，保留本次会话内的提示行为。
      }
    }
    let notice = null;
    let acknowledged = false;
    const remove = () => {
      if (!notice) return;
      const current = notice;
      notice = null;
      current.classList.remove('show');
      window.setTimeout(() => current.remove(), 220);
    };
    const acknowledge = () => {
      acknowledged = true;
      if (!n5Launch.forceNotice) {
        try {
          window.localStorage.setItem(N5_LAUNCH_NOTICE_KEY, 'seen');
        } catch {
          // 存储不可用时只关闭当前页面内的提示。
        }
      }
      remove();
    };
    dismissN5LaunchNotice = acknowledge;
    const show = () => {
      if (acknowledged || notice || document.querySelector('.n5-launch-notice')) return;
      const featured = state.codexes.filter(isN5LaunchCodex);
      const entries = featured.reduce((sum, c) => sum + Number(c.entryCount || 0), 0);
      notice = document.createElement('aside');
      notice.className = 'n5-launch-notice';
      notice.setAttribute('aria-label', 'NovelAI V5 上线提示');
      notice.innerHTML =
        `<button class="n5-notice-close" type="button" aria-label="关闭 V5 上线提示">×</button>` +
        `<span class="n5-brand">${V5_MARK}</span>` +
        `<span class="n5-eyebrow">NEW · NOVELAI V5</span>` +
        `<strong class="n5-notice-title">新模型法典上线</strong>` +
        `<p class="n5-notice-sub">${n5BooksLabel(featured.length)}新法典 · ` +
        `<b>${entries.toLocaleString()}</b> 条词条</p>` +
        `<div class="n5-notice-actions">` +
        `<button class="n5-btn solid n5-notice-open" type="button">看看新法典</button>` +
        `<button class="n5-btn ghost n5-notice-later" type="button">以后再说</button>` +
        `</div>` +
        `<span class="n5-stamp">${esc(n5LaunchStamp(featured))}</span>` +
        `<span class="n5-wm" aria-hidden="true">V5</span>`;
      notice.querySelector('.n5-notice-close').onclick = ev => {
        ev.stopPropagation();
        acknowledge();
      };
      notice.querySelector('.n5-notice-later').onclick = ev => {
        ev.stopPropagation();
        acknowledge();
      };
      notice.querySelector('.n5-notice-open').onclick = ev => {
        ev.stopPropagation();
        acknowledge();
        open({ focus: false });
        requestAnimationFrame(() => menu.querySelector('.n5-launch-panel')?.focus({ preventScroll: true }));
      };
      document.body.appendChild(notice);
      requestAnimationFrame(() => notice?.classList.add('show'));
    };
    const reveal = () => window.setTimeout(show, 260);
    if (document.documentElement.classList.contains('intro-done')) reveal();
    else document.addEventListener('intro:settle', reveal, { once: true });
  };

  btn.onclick = ev => {
    ev.stopPropagation();
    dismissN5LaunchNotice();
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
  bindOutsideDismiss([menu, btn], () => {
    if (!menu.hidden) close();
  });
  window.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && !menu.hidden) close({ focusButton: true });
  });
  mobileLayout.addEventListener('change', () => {
    if (menu.hidden) return;
    // 只在跨断点时重排；手机地址栏/软键盘改变高度不应重建书卡或重置滚动。
    const focused = document.activeElement;
    const restoreFocus = menu.contains(focused);
    const focusedBook = state.codexes.find(c => c.id === focused?.dataset.id);
    if (focusedBook) activeType = codexType(focusedBook);
    const focusSelector = focused?.classList.contains('n5-launch-book') ? '.n5-launch-book' :
      focused?.classList.contains('codex-item') ? '.codex-item' :
      focused?.classList.contains('codex-door') ? '.codex-door' : '.codex-type';
    renderMenu();
    placeMenu();
    if (isMobile() && !getManagedHistoryEntry()?.layers.some(layer => layer.id === 'codex-menu')) {
      openHistoryLayer('codex-menu', { mode: topHistoryLayerId() === 'banner-about' ? 'replace' : 'push' });
    }
    if (restoreFocus) {
      const target = [...menu.querySelectorAll(focusSelector)].find(el =>
        el.dataset.id === focused?.dataset.id && el.dataset.type === focused?.dataset.type);
      if (target) target.focus({ preventScroll: true });
      else focusPreferredItem({ preventScroll: true });
    }
  });
  window.addEventListener('resize', () => {
    if (!menu.hidden) placeMenu();
  });
  ensureUpdates();
  setupN5LaunchNotice();
}

/* 解锁状态变了就地更新，不重建菜单（重建会让封面图重新淡入、也会丢掉滚动位置）。
   R18 小标的解锁/未解锁两态、封面模糊与锁蒙版全部挂在 .locked 类上，由 CSS 切换。 */
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
  });
  // 书脊小封面与卷头拼贴只跟锁态走
  document.querySelectorAll('#codexMenu [data-lock-id]').forEach(el => {
    el.classList.toggle('locked', isCodexLocked(state.codexes.find(item => item.id === el.dataset.lockId)));
  });
}

export function accessHiddenCount() {
  if (!state.codex) return 0;
  return accessViewSnapshot().hiddenCount;
}

export function lockedCodexCount() {
  return (state.codexes || []).filter(isCodexLocked).length;
}

function showAccessLockedHint() {
  if (!state.allowNsfw) showNsfwLockedHint();
  else showR18gLockedHint();
}

export function syncCodexPickerCounts(codex = state.codex) {
  const meta = state.codexes?.find(item => item.id === codex?.id);
  if (!meta || !codex) return false;
  if (typeof codex.entryCount === 'number') meta.entryCount = codex.entryCount;
  if (typeof codex.imagedCount === 'number') meta.imagedCount = codex.imagedCount;
  return true;
}

export function visibleEntryCount() {
  return Math.max(0, Number(state.codex?.entryCount || 0) - accessHiddenCount());
}

/* ---------------- ??? ---------------- */
let treeEnterTimer = 0;
let resultEnterTimer = 0;
const treeBranchAnimations = new Map();

function syncTreeBranchState(item, expanded) {
  const row = item.firstElementChild;
  const kids = item.lastElementChild;
  if (!kids?.classList.contains('tree-children')) return;
  item.classList.toggle('collapsed', !expanded);
  kids.inert = !expanded;
  kids.setAttribute('aria-hidden', String(!expanded));
  const arrow = row.querySelector('.tw-arrow');
  arrow.setAttribute('aria-expanded', String(expanded));
  arrow.setAttribute('aria-label', `${expanded ? '收起' : '展开'}目录：${row.querySelector('.tw-name').textContent}`);
}

function cancelTreeBranchMotion(kids) {
  treeBranchAnimations.delete(kids);
  cancelUiMotion(kids);
  kids.classList.remove('tree-branch-moving');
}

function setTreeBranchExpanded(item, expanded, { animate = true } = {}) {
  const kids = item.lastElementChild;
  if (!kids?.classList.contains('tree-children')) return;
  if (animate && item.classList.contains('collapsed') === !expanded) return;
  const related = [...treeBranchAnimations.keys()].filter(branch => branch === kids || kids.contains(branch) || branch.contains(kids));
  const canAnimate = animate && item.isConnected && kids.animate && !prefersReducedMotion()
    && !document.documentElement.classList.contains('motion-off') && !item.closest('#sidebar.closed');
  // 祖先正在展开时点子目录，先保留当前画面，再按最新子树终态重测，避免旧高度截断内容。
  const moving = canAnimate ? [kids, ...related.filter(branch => branch !== kids && branch.contains(kids))].map(branch => ({
    branch,
    height: branch.getBoundingClientRect().height,
    opacity: Number(getComputedStyle(branch).opacity),
  })) : [];
  related.forEach(cancelTreeBranchMotion);
  syncTreeBranchState(item, expanded);
  const targets = moving.map(record => ({
    ...record,
    expanded: !record.branch.parentElement.classList.contains('collapsed'),
    heightTo: record.branch.parentElement.classList.contains('collapsed') ? 0 : record.branch.scrollHeight,
  }));
  for (const { branch, height, opacity, expanded: opening, heightTo } of targets) {
    if (!height && !heightTo) continue;
    branch.classList.add('tree-branch-moving');
    const animation = animateUi(branch, [
      { height: `${height}px`, opacity: height ? opacity : 0 },
      { height: `${heightTo}px`, opacity: opening ? 1 : 0 },
    ], { duration: opening ? 240 : 190 });
    if (!animation) {
      branch.classList.remove('tree-branch-moving');
      continue;
    }
    treeBranchAnimations.set(branch, animation);
    const finish = () => {
      if (treeBranchAnimations.get(branch) !== animation) return;
      treeBranchAnimations.delete(branch);
      branch.classList.remove('tree-branch-moving');
      refreshTreeSpy();
    };
    animation.finished.then(finish, finish);
  }
  if (animate) refreshTreeSpy();
}

export function renderTree() {
  if (state.favoritesView) return;
  const nav = $('#tree');
  const shouldAnimate = nav.dataset.codexId !== (state.codex?.id || '');
  clearTimeout(treeEnterTimer);
  nav.classList.remove('tree-entering');
  [...treeBranchAnimations.keys()].forEach(cancelTreeBranchMotion);
  nav.innerHTML = '';   // 同时清掉了 .tree-spy 指示条，下面 reset 后由下次滚动更新重建
  resetTreeSpy();
  nav.dataset.codexId = state.codex?.id || '';
  const searching = hasActiveSearch();
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
  // 分支高度过渡时先暂隐指示条，末轮结束按终态定位，避免逐帧重启其位移过渡。
  if (treeBranchAnimations.size) {
    if (spy) spy.hidden = true;
    resetTreeSpy();
    return;
  }
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
    if (cand && !cand.closest('.tree-children[inert]') && cand.offsetParent !== null) { row = cand; break; }
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
  if (!spyPointerIn && !nav.contains(document.activeElement)) {
    const pad = 44;
    if (top < nav.scrollTop + pad || top + r.height > nav.scrollTop + nav.clientHeight - pad) {
      nav.scrollTo({ top: Math.max(0, top - nav.clientHeight * 0.38), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  }
}

/* 法典选择器的收起入口。setupCodexPicker() 里把内部 close 挂上来，
   外部模块（本地编辑模式点「法典管理」时）据此正确收起，不必复制其历史层逻辑。 */
let closePickerRef = null;
export function closeCodexPicker(options = {}) {
  closePickerRef?.(options);
}

export function visibleTree() {
  return accessViewSnapshot().tree;
}

function accessViewSnapshot() {
  const entries = state.codex?.entries || EMPTY_ACCESS_ENTRIES;
  const emptyPaths = state.codex?.emptyCategories || EMPTY_ACCESS_PATHS;
  const allowNsfw = state.allowNsfw;
  const allowR18g = state.allowR18g;
  if (
    accessViewMemo?.entries === entries &&
    accessViewMemo.emptyPaths === emptyPaths &&
    accessViewMemo.allowNsfw === allowNsfw &&
    accessViewMemo.allowR18g === allowR18g
  ) return accessViewMemo;

  accessViewMemo = {
    entries,
    emptyPaths,
    allowNsfw,
    allowR18g,
    ...buildAccessView(entries, emptyPaths),
  };
  return accessViewMemo;
}

function buildAccessView(entries, emptyPaths) {
  const root = new Map();
  let hiddenCount = 0;
  for (const entry of entries) {
    if (isEntryAccessBlocked(entry)) hiddenCount += 1;
    if (!state.allowR18g && isR18gEntry(entry)) continue;
    const path = Array.isArray(entry.path) ? entry.path : [];
    const entryNsfw = isEntryNsfw(entry);
    const explicitNsfwFrom = path.findIndex(isNsfwPathSegment);
    let node = root;
    path.forEach((name, index) => {
      if (!node.has(name)) node.set(name, { name, count: 0, nsfwCount: 0, explicitNsfw: false, children: new Map() });
      const cur = node.get(name);
      cur.count += 1;
      if (entryNsfw) cur.nsfwCount += 1;
      if (explicitNsfwFrom >= 0 && index >= explicitNsfwFrom) cur.explicitNsfw = true;
      node = cur.children;
    });
  }
  // 本地编辑器登记的空分类（还没有词条）：只保证节点存在，不计数。
  // 普通法典没有这个字段，行为完全不变。
  for (const path of emptyPaths || []) {
    if (!Array.isArray(path) || !path.length) continue;
    let node = root;
    for (const name of path) {
      if (!node.has(name)) node.set(name, { name, count: 0, nsfwCount: 0, explicitNsfw: false, children: new Map() });
      node = node.get(name).children;
    }
  }
  const toList = map => [...map.values()].map(n => ({
    name: n.name,
    count: n.count,
    /* 混合目录保持可进入；只有纯 NSFW 分支或显式名为 NSFW 的分支才锁。 */
    locked: Boolean(n.explicitNsfw || (n.count > 0 && n.nsfwCount === n.count)),
    children: toList(n.children),
  }));
  return { tree: toList(root), hiddenCount };
}

export function buildNodes(nodes, parent, prefix, depth) {
  for (const nd of nodes) {
    if (!state.allowR18g && isR18gName(nd.name)) continue;  // 隐藏 R18G/重口 分类
    const path = prefix.concat(nd.name);
    const item = document.createElement('div');
    const locked = Boolean(nd.locked && !state.allowNsfw);
    const active = !locked && (!hasActiveSearch() || state.siteSearchView) && samePath(path, state.activePath);
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
    if (hasKids) {
      const arrow = row.querySelector('.tw-arrow');
      arrow.setAttribute('role', 'button');
      arrow.tabIndex = 0;
      const toggle = () => setTreeBranchExpanded(item, item.classList.contains('collapsed'));
      arrow.onclick = event => { event.stopPropagation(); toggle(); };
      arrow.onkeydown = event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) toggle();
      };
    }
    row.onclick = () => {
      if (locked) {
        showNsfwLockedHint();
        if (hasKids) setTreeBranchExpanded(item, true);
        return;
      }
      selectPath(path, row);
      if (hasKids) setTreeBranchExpanded(item, true);
      refreshTreeSpy();   // 展开后行可见性变了，指示条重解析
    };
    item.appendChild(row);
    if (hasKids) {
      const kids = document.createElement('div');
      kids.className = 'tree-children';
      buildNodes(nd.children, kids, path, depth + 1);
      item.appendChild(kids);
      syncTreeBranchState(item, !item.classList.contains('collapsed'));
    }
    parent.appendChild(item);
  }
}

export function selectPath(path, rowEl) {
  const parentScrollY = Math.max(0, window.scrollY || 0);
  const isMobile = window.innerWidth <= 600;
  const routeChanged = !samePath(state.activePath, path) || (!state.siteSearchView && hasActiveSearch());
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
  state.searchDraft = '';
  state.searchFilters = [];
  state.searchFilterValues = [];
  state.searchIssues = [];
  state.searchPlan = null;
  state.relatedDirectories = [];
  state.relatedDirectoryCount = 0;
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
      setTreeBranchExpanded(item, true, { animate: false });
      item = item.parentElement ? item.parentElement.closest('.tree-item') : null;
    }
    selectPath(path, row);
    refreshTreeSpy();
    row.scrollIntoView({ block: 'nearest' });
    return;
  }
}


function activeUpdateFilter() {
  return codexUpdateFilters(state.codex).find(filter => filter.id === state.updateFilter) || null;
}

/* 往期下拉的实例要跨重绘存活：updateResultBar 每次搜索 / 筛选都会跑，
   每次重建等于关掉刚打开的菜单、抖掉焦点。updateSelectKey 记住上次喂进去的选项集，
   只有换书或批次真的变了才重新 setOptions。 */
let updateSelect = null;
let updateSelectKey = '';

/* 胶囊和往期下拉共用的落子动作。胶囊是开关（再点一次退出筛选），
   下拉是选择（取消由列表里的「不筛选」承担），所以 toggle 由调用方声明。 */
export function setUpdateFilter(id, { toggle = false } = {}) {
  const requested = String(id || '');
  const next = toggle && String(state.updateFilter || '') === requested ? '' : requested;
  if (next === String(state.updateFilter || '')) return;
  state.updateFilter = next;
  codexUiActions.applyFilter({ resetScroll: true, transition: 'filter' });
  codexUiActions.syncUrlState({ historyMode: 'replace' });
}

function updateFilterChip(filter) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `bar-btn update-filter-btn${filter.latest ? ' is-latest' : ''}`;
  btn.dataset.updateFilter = filter.id;
  const active = state.updateFilter === filter.id;
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  if (filter.latest) {
    const mark = document.createElement('span');
    mark.className = 'update-filter-mark';
    mark.textContent = 'NEW';
    btn.appendChild(mark);
  }
  const label = document.createElement('span');
  label.textContent = filter.label;
  btn.append(label, Object.assign(document.createElement('span'), { textContent: '·' }));
  const count = document.createElement('strong');
  count.textContent = String(filter.count);
  btn.appendChild(count);
  btn.title = active ? `退出${filter.label}筛选` : `只看${filter.label}标记的词条`;
  btn.setAttribute('aria-label',
    `${filter.latest ? 'NEW ' : ''}${filter.label} · ${filter.count}${active ? '，当前已开启' : '，点击筛选'}`);
  return btn;
}

/* 批次只增不减：全部平铺时手机上三行起步，真正要点的 NEW 还被挤在最后。
   最新一期留成常驻胶囊，其余收进单选下拉，控件数就与更新期数脱钩了。
   ⚠ 这里只收窄「显示」，codexUpdateFilters 仍返回全部批次——resolveUpdateFilter 拿它校验
   URL 的 ?update=，截断了会让动态面板的老批次深链静默失效。 */
function pastUpdatesMenu(past) {
  const activeId = past.some(filter => filter.id === state.updateFilter) ? String(state.updateFilter) : '';
  const active = activeId ? past.find(filter => filter.id === activeId) : null;
  /* 「不筛选」只在选中往期时才给：没选中时它会顶掉触发按钮上「往期更新 · N 期」这句邀请。 */
  const options = [
    ...(active ? [{ value: '', label: '不筛选' }] : []),
    ...past.map(filter => ({
      value: filter.id,
      label: `${filter.label} · ${filter.count}`,
      description: relativeDay(filter.time),
    })),
  ];
  if (!updateSelect) {
    updateSelect = createSelectMenu({
      className: 'update-filter-select is-pill',
      onChange: value => setUpdateFilter(value),
    });
    updateSelectKey = '';
  }
  const key = `${state.codex?.id || ''}|${activeId}|${past.map(filter => `${filter.id}:${filter.count}`).join(',')}`;
  if (key !== updateSelectKey) {
    updateSelectKey = key;
    updateSelect.setOptions(options);
  }
  updateSelect.setLabel(`往期更新 · ${past.length} 期`);
  updateSelect.setValue(activeId);
  updateSelect.setTriggerLabel(active
    ? `往期更新：${active.label} · ${active.count} 条，当前已开启，可更换或取消`
    : `往期更新，共 ${past.length} 期，点击选择`);
  updateSelect.element.classList.toggle('is-active', Boolean(active));
  return updateSelect;
}

function destroyUpdateSelect() {
  if (!updateSelect) return;
  updateSelect.destroy();
  updateSelect.element.remove();
  updateSelect = null;
  updateSelectKey = '';
}

function updateFilterControls() {
  const root = $('#updateFilterControls');
  if (!root) return;
  const focusedFilterId = root.contains(document.activeElement)
    ? String(document.activeElement?.dataset?.updateFilter || '')
    : '';
  const filters = (!state.favoritesView && !state.siteSearchView) ? codexUpdateFilters(state.codex) : [];
  root.hidden = filters.length === 0;
  /* 常驻胶囊＝带 latest 的那期；万一它因为 count 为 0 被滤掉，退到按日期排第一的那期，
     保证任何有批次的书都至少有一枚一键入口。 */
  const primary = filters.find(filter => filter.latest) || filters[0] || null;
  const past = filters.filter(filter => filter !== primary);
  const menu = past.length ? pastUpdatesMenu(past) : null;
  if (!menu) destroyUpdateSelect();
  /* 下拉节点原地留着：整体 replaceChildren 会把它摘下来再挂回去，
     刚选完那一次重绘就会把焦点从触发按钮上抖掉。 */
  for (const node of [...root.children]) {
    if (menu && node === menu.element) continue;
    node.remove();
  }
  if (primary) root.prepend(updateFilterChip(primary));
  if (menu && menu.element.parentNode !== root) root.appendChild(menu.element);
  if (focusedFilterId) {
    const replacement = [...root.querySelectorAll('[data-update-filter]')]
      .find(button => button.dataset.updateFilter === focusedFilterId);
    replacement?.focus({ preventScroll: true });
  }
}

export function updateResultBar() {
  const n = state.list.length;
  const box = $('#resultInfo');
  const favoritesBackupButton = $('#favoritesViewBackupBtn');
  if (favoritesBackupButton) favoritesBackupButton.hidden = !state.favoritesView;
  updateFilterControls();
  box.innerHTML = '';
  const q = state.query.trim();
  const searching = hasActiveSearch();

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
  if (searching && !state.siteSearchView) {
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
  if (searching) {
    const scope = state.favoritesView ? '收藏内' : (state.siteSearchView ? '全站' : '本书');
    const queryLabel = q ? ` “${esc(q)}”` : '';
    const filterCount = state.searchFilterValues?.length || 0;
    const filterLabel = filterCount ? `${q ? ' · ' : ' · '}${filterCount} 个筛选` : '';
    const relatedLabel = state.relatedDirectoryCount ? ` · ${state.relatedDirectoryCount} 个相关目录` : '';
    t = `${scope}搜索${queryLabel}${filterLabel}：<b>${n}</b> 条图片结果${relatedLabel}`;
  }
  else if (state.favoritesView) t = `收藏：<b>${n}</b> 条`;
  else if (activeUpdateFilter()) t = `${esc(activeUpdateFilter().label)}：<b>${n}</b> 条 · ${state.list.filter(hasEntryImage).length} 条已配图`;
  else if (state.activePath.length) t = `<b>${n}</b> 条`;
  else t = `共 <b>${n}</b> 条词条 · ${state.list.filter(hasEntryImage).length} 条已配图`;
  count.innerHTML = t;
  box.appendChild(count);

  const hiddenCount = (!state.siteSearchView && !state.favoritesView) ? accessHiddenCount() : 0;
  if (hiddenCount > 0) {
    const hiddenHint = document.createElement('button');
    hiddenHint.type = 'button';
    hiddenHint.className = 'access-hidden-hint';
    hiddenHint.textContent = `另有 ${hiddenCount} 条受限内容`;
    hiddenHint.title = '查看解锁说明';
    hiddenHint.onclick = showAccessLockedHint;
    box.appendChild(hiddenHint);
  }
  const lockedBooks = state.siteSearchView ? lockedCodexCount() : 0;
  if (lockedBooks > 0) {
    const lockedHint = document.createElement('button');
    lockedHint.type = 'button';
    lockedHint.className = 'access-hidden-hint';
    lockedHint.textContent = `另有 ${lockedBooks} 本受限法典未解锁，未纳入全站搜索`;
    lockedHint.title = '查看解锁说明';
    lockedHint.onclick = showNsfwLockedHint;
    box.appendChild(lockedHint);
  }

  updateEmptyState(n);
  updateRailActive();
}

export function updateEmptyState(n) {
  const empty = $('#empty');
  if (!empty) return;
  if (hasActiveSearch()) {
    empty.hidden = true;
    return;
  }
  empty.hidden = n > 0;
  if (n > 0) return;

  const q = state.query.trim();
  const updateFilter = activeUpdateFilter();
  const hasFilter = Boolean(updateFilter || state.onlyFav || state.activePath.length || q);
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
    if (state.siteSearchView && lockedCodexCount() > 0) {
      desc += ' 部分受限法典尚未解锁，因此没有纳入本次搜索。';
      actions.push({ label: '查看未解锁范围', action: 'access-hint' });
    }
  } else if (state.favoritesView && !state.activePath.length) {
    title = '收藏夹还是空的';
    desc = '逛任意法典时点卡片右上角的星标，收藏就会集中到这里。';
  } else if (updateFilter) {
    title = state.activePath.length ? `这个分类没有${updateFilter.label}` : `${updateFilter.label}暂无可显示词条`;
    desc = state.activePath.length
      ? `可以查看全书的${updateFilter.label}，或从上方分类继续筛选。`
      : `退出${updateFilter.label}筛选后，可以继续浏览全部词条。`;
    actions.push(state.activePath.length
      ? { label: '查看全书更新', action: 'show-all-updates' }
      : { label: '退出更新筛选', action: 'exit-update-filter' });
  } else if (state.onlyFav) {
    title = '收藏夹还是空的';
    desc = '先在卡片右上角点星标收藏。';
    actions.push({ label: '查看全部词条', action: 'show-all' });
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
  if (action === 'access-hint') {
    showNsfwLockedHint();
    return;
  }
  if (action === 'clear-search') {
    state.query = '';
    state.searchDraft = '';
    state.searchFilters = [];
    state.searchFilterValues = [];
    state.searchIssues = [];
    state.searchPlan = null;
    state.relatedDirectories = [];
    const search = $('#search');
    if (search) search.value = '';
    updateSearchClear();
    renderTree();
  } else if (action === 'show-all-updates') {
    state.activePath = [];
    renderTree();
  } else if (action === 'exit-update-filter') {
    state.updateFilter = '';
  } else if (action === 'show-all') {
    state.query = '';
    state.searchDraft = '';
    state.searchFilters = [];
    state.searchFilterValues = [];
    state.searchIssues = [];
    state.searchPlan = null;
    state.relatedDirectories = [];
    state.activePath = [];
    state.onlyFav = false;
    const search = $('#search');
    if (search) search.value = '';
    const onlyFav = $('#onlyFav');
    if (onlyFav) onlyFav.checked = false;
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
const bannerImagedPct = c => (c.entryCount ? Math.min(100, Math.floor((Number(c.imagedCount || 0) / c.entryCount) * 100)) : 0);

const bannerShortAuthor = author => {
  const names = String(author || '').split(/\s*\/\s*/).filter(Boolean);
  return names.length > 2 ? `${names[0]} 等 ${names.length} 人` : names.join(' / ');
};
function fillBannerInsert(banner, c) {
  renderBannerInsert(banner, c, {
    loadUpdates: codexUiActions.loadUpdates,
    bookPalette: codexUiActions.bookPalette,
    isContentBlocked: codexUiActions.isContentBlocked,
    groups: () => [...document.querySelectorAll('#chipRail .rail-chip')]
      .filter(chip => chip.dataset.path && chip.getAttribute('aria-disabled') !== 'true')
      .map(chip => {
        const path = chip.dataset.path.split('\u0001');
        return { path, name: path.at(-1), count: Number(chip.querySelector('.rc-n')?.textContent) || 0,
          color: chip.querySelector('.rc-dot')?.style.background || 'var(--book-accent)' };
      }).filter(group => group.count > 0),
    selectPath: selectPathByPath,
    selectUpdate: id => setUpdateFilter(id, { toggle: true }),
    openCaption: (entry, index) => codexUiActions.openLightbox(entry, index, banner.querySelector('.banner-cover img')),
    openDirectory: () => {
      if ($('#sidebar')?.classList.contains('closed')) $('#menuBtn')?.click();
      const row = $('#tree .tree-row.active') || $('#tree .tree-row');
      row?.scrollIntoView({ block: 'nearest' });
      row?.focus({ preventScroll: true });
    },
  });
}

/* 横幅主体：封面、书名、作者 · 版本、原图签、作者主页、配图进度。这些都只读 codexes.json 也有的字段，
   所以换书接力时可以先用 meta 画好（pending：封面不播二段浮现、进度行留给计步与落地揭开）。 */
function fillBanner(banner, c, { virtualView = false, pending = false } = {}) {
  const cover = codexBannerCoverEntry(c);
  const metaText = [c.author, c.version].filter(Boolean).join(' · ');
  const exampleLabel = codexExampleLabel(c);
  const originalPill = virtualView || document.body.classList.contains('local-edition') ? '' : exampleLabel ?
    `<span class="data-pill model-example">${esc(exampleLabel)}</span>` :
    `<span class="data-pill ${c.hasOriginal ? 'has-orig' : 'no-orig'}" title="${esc(c.hasOriginal ? '本法典保留原图：放大后可拖入 NovelAI 读取生成参数' : '本法典为压缩缩略图，拖入 NovelAI 读不出参数')}">${c.hasOriginal ? '含原图' : '无原图'}</span>`;
  const home = virtualView ? null : authorHomepage(c);
  const coverHtml = `<div class="banner-cover${pending ? ' no-enter' : ''}">${cover ? `<img src="${esc(thumbUrl(cover, c))}" alt=""${codexCoverStyle(c)}>` : ''}</div>`;
  const progressHtml = `<div class="banner-progress${pending ? ' is-pending' : ''}"><div class="bp-track" aria-hidden="true"><div class="bp-fill" style="width:${bannerImagedPct(c)}%"></div></div>` +
    `<span class="bp-text">${pending ? '' : `${c.imagedCount} / ${c.entryCount} 已配图`}</span></div>`;
  banner.classList.toggle('banner-book', !virtualView);
  if (virtualView) {
    banner.removeAttribute('data-type');
    banner.innerHTML = coverHtml + `<div class="banner-info">` +
      `<div class="banner-title">${esc(c.title)}</div>` +
      `<div class="banner-meta"><span>${esc(metaText)}</span></div>${progressHtml}</div>`;
  } else {
    const typeIndex = Math.max(0, CODEX_TYPES.findIndex(type => type.id === codexType(c)));
    banner.dataset.type = CODEX_TYPES[typeIndex].id;
    banner.innerHTML = `<div class="banner-info">` +
      `<div class="banner-eyebrow"><b>${volumeLabel(typeIndex)}</b><span>${CODEX_TYPES[typeIndex].name}</span></div>` +
      `<div class="banner-title${String(c.title || '').length > 20 ? ' is-long-title' : ''}">${esc(c.title)}</div>` +
      `<div class="banner-rule" aria-hidden="true"></div>` +
      `<div class="banner-meta"><span class="banner-author" title="${esc(c.author || '')}"><small>作者</small>${esc(bannerShortAuthor(c.author) || '未标注')}</span>` +
      `${c.version ? `<span class="banner-version"><small>版本</small>${esc(c.version)}</span>` : ''}` +
      `${progressHtml}${originalPill}${home ? renderAuthorHomepage(home) : ''}</div></div>` +
      `<div class="banner-visuals">${coverHtml}<div class="banner-insert"></div></div>`;
  }
  banner.dataset.identity = virtualView ? '' : c.id;
  /* 封面图 onload 渐显（同卡片图 is-loaded 模式）；缓存命中时 complete 已为真，直接显示 */
  const coverImg = banner.querySelector('.banner-cover img');
  if (coverImg) {
    const reveal = () => coverImg.classList.add('is-loaded');
    if (coverImg.complete && coverImg.naturalWidth) reveal();
    else { coverImg.onload = reveal; coverImg.onerror = reveal; }
  }
}

/* 换书接力：数据还没到就先把横幅换成新书（app/codex-switch.js 回顶那一刻调）。
   awaitingCover：封面替身还在飞，横幅自己的封面先藏着，落定时再露出来。 */
export function renderBannerIdentity(c, { awaitingCover = false } = {}) {
  const banner = $('#codexBanner');
  if (!banner) return;
  closeBannerAbout();
  document.querySelectorAll('.banner-pop').forEach(pop => pop.remove());
  fillBanner(banner, c, { pending: true });
  if (awaitingCover) banner.querySelector('.banner-cover')?.classList.add('awaiting-cover');
}

export function renderCodexHeader({ keepIdentity = false } = {}) {
  const c = state.codex;
  const banner = $('#codexBanner');
  if (!banner) return;
  closeBannerAbout();
  document.querySelectorAll('.banner-pop').forEach(pop => pop.remove());
  const virtualView = state.favoritesView || state.siteSearchView;
  if (keepIdentity && !virtualView && banner.dataset.identity === c.id) {
    /* 接力时已用 meta 画好：重建会让封面 / 文字的二段浮现在落地时再播一遍。
       只补数据才有的「关于」气泡；进度条按数据校准宽度，揭开与计数由编排器落地时做。 */
    banner.querySelector('.banner-about-btn')?.remove();
    const fill = banner.querySelector('.bp-fill');
    if (fill) fill.style.width = `${bannerImagedPct(c)}%`;
  } else {
    fillBanner(banner, c, { virtualView });
  }
  if (!virtualView) renderBannerAbout(c, banner);
  renderCategoryRail();
  if (!virtualView) fillBannerInsert(banner, c);
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
  if (state.favoritesView) return;
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
  syncBannerInsertState();
  const rail = $('#chipRail');
  if (!rail) return;
  const head = (hasActiveSearch() && !state.siteSearchView) ? null : (state.activePath[0] || '');
  let activeChip = null;
  rail.querySelectorAll('.rail-chip').forEach(ch => {
    const active = head !== null && (ch.dataset.path || '') === head;
    ch.classList.toggle('active', active);
    if (active) activeChip = ch;
  });
  if (!activeChip) return;
  const delta = railRevealDelta(rail.getBoundingClientRect(), activeChip.getBoundingClientRect());
  if (Math.abs(delta) < 0.5) return;
  const maxLeft = Math.max(0, rail.scrollWidth - rail.clientWidth);
  const left = Math.min(maxLeft, Math.max(0, rail.scrollLeft + delta));
  if (Math.abs(left - rail.scrollLeft) < 0.5) return;
  rail.scrollTo({
    left,
    top: rail.scrollTop,
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
  });
}

export function railRevealDelta(railRect, chipRect) {
  if (chipRect.left < railRect.left) return chipRect.left - railRect.left;
  if (chipRect.right > railRect.right) return chipRect.right - railRect.right;
  return 0;
}

/* 法典「关于」气泡：来源 / 贡献者 / 相关链接 */
const EXT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>';
let bannerAboutOpen = false;

function safeExternalLinks(links) {
  return links.flatMap(link => {
    if (!link || typeof link !== 'object') return [];
    const url = safeHttpUrl(link.url);
    return url ? [{ ...link, url }] : [];
  });
}

/* 作者主页：贡献者里与 author 同名且带 url 的那位才上横幅；合集书 author 是多人拼接，天然不命中，只在气泡里可点 */
const BILIBILI_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 3.5 10 6.2M16.5 3.5 14 6.2"/><rect x="3" y="6.2" width="18" height="13.6" rx="3.2"/><path d="M9 11.2v3M15 11.2v3"/></svg>';
const ARROW_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 16 16 8M9.5 8H16v6.5"/></svg>';

function homepagePlatform(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'b23.tv' || host === 'bilibili.com' || host.endsWith('.bilibili.com')) return 'bilibili';
  } catch {}
  return '';
}

function contributorHomepage(p) {
  if (!p || typeof p !== 'object' || !p.name) return null;
  const url = safeHttpUrl(p.url);
  return url ? { name: p.name, url, platform: homepagePlatform(url) } : null;
}

function authorHomepage(c) {
  const author = String(c.author || '').trim();
  if (!author) return null;
  const people = Array.isArray(c.contributors) ? c.contributors : [];
  for (const p of people) {
    if (p && typeof p === 'object' && String(p.name || '').trim() === author) return contributorHomepage(p);
  }
  return null;
}

function renderAuthorHomepage(home) {
  const bili = home.platform === 'bilibili';
  const title = `在新标签页打开 ${home.name} 的${bili ? ' B 站' : ''}主页`;
  return `<a class="banner-home${bili ? ' is-bilibili' : ''}" href="${esc(home.url)}" target="_blank" rel="noopener" title="${esc(title)}">` +
    `${bili ? BILIBILI_ICON : EXT_ICON}<span>${bili ? '前往作者B站主页' : '前往作者主页'}</span>${ARROW_ICON}</a>`;
}

function positionBannerPop(pop, banner) {
  const r = banner.getBoundingClientRect();
  const anchor = banner.classList.contains('banner-book') ? banner.querySelector('.banner-about-btn')?.getBoundingClientRect() : null;
  const isMobile = window.matchMedia('(max-width: 600px)').matches;
  const gap = isMobile ? 8 : 12;
  const topOffset = isMobile ? 40 : 46;
  const width = Math.min(280, Math.max(0, r.width - gap * 2));
  const left = Math.min(window.innerWidth - gap - width, Math.max(gap, (anchor?.right ?? r.right - gap) - width));
  pop.style.width = `${Math.round(width)}px`;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(Math.max(gap, anchor ? anchor.bottom + 8 : r.top + topOffset))}px`;
}

function positionOpenBannerPop() {
  if (!bannerAboutOpen) return;
  const openBtn = document.querySelector('.banner-about-btn.open');
  const openPop = document.querySelector('.banner-pop:not([hidden])');
  const banner = openBtn?.closest('.codex-banner');
  if (openPop && banner) positionBannerPop(openPop, banner);
  else bannerAboutOpen = false;
}

function closeBannerAboutDirect() {
  bannerAboutOpen = false;
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
  bannerAboutOpen = true;
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
      const home = contributorHomepage(p);
      html += home
        ? `<a class="bp-chip is-link${home.platform === 'bilibili' ? ' is-bilibili' : ''}" href="${esc(home.url)}" target="_blank" rel="noopener">${esc(name)}${role ? `<small>${esc(role)}</small>` : ''}${ARROW_ICON}</a>`
        : `<span class="bp-chip">${esc(name)}${role ? `<small>${esc(role)}</small>` : ''}</span>`;
    }
    html += '</div>';
  }
  const validLinks = safeExternalLinks(links);
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
      bannerAboutOpen = true;
      openHistoryLayer('banner-about');
    }
  };

  (banner.classList.contains('banner-book') ? banner.querySelector('.banner-info') : banner).appendChild(btn);
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
  const links = safeExternalLinks(Array.isArray(c.links) ? c.links : []);
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
      const home = contributorHomepage(p);
      if (!name) return '';
      return home
        ? `<a class="is-link${home.platform === 'bilibili' ? ' is-bilibili' : ''}" href="${esc(home.url)}" target="_blank" rel="noopener">${esc(name)}${role ? `<small>${esc(role)}</small>` : ''}${ARROW_ICON}</a>`
        : `<span>${esc(name)}${role ? `<small>${esc(role)}</small>` : ''}</span>`;
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
      const url = safeHttpUrl(l.url);
      const real = Boolean(url);
      const el = document.createElement(real ? 'a' : 'div');
      el.className = 'about-link';
      if (real) { el.href = url; el.target = '_blank'; el.rel = 'noopener'; }
      el.innerHTML =
        `<span class="al-text"><span class="al-label">${esc(l.label)}</span>` +
        `<span class="al-desc">${esc(l.desc || (real ? url : '链接待补充'))}</span></span>` +
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
