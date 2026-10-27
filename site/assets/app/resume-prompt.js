import { state } from './state.js';
import { browsePlace, formatRecentTime, isHistoryItemLocked, recentEntryForBrowse, resumeLastBrowse } from './history.js';
import { findCodexMeta } from './data.js';
import { codexCoverUrl } from './codex-ui.js';
import { readPreference, writePreference } from './preferences-storage.js';

const SESSION_KEY = 'fadian-resume-prompt-shown-v1';
const DISMISS_KEY = 'fadian-resume-prompt-dismissed-v1';   // '1'＝在「浏览记录」里关掉了提示
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const FLOAT_HIDE_MS = 10_000;
const SEARCH_MARK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>';

let activePrompt = null;
let activePromptTimer = 0;

function restoreSidebarTip() {
  const tip = document.querySelector('#sbTip');
  if (tip) tip.hidden = false;
}

export function dismissResumePrompt() {
  window.clearTimeout?.(activePromptTimer);
  activePromptTimer = 0;
  if (!activePrompt) return false;
  activePrompt.remove();
  activePrompt = null;
  restoreSidebarTip();
  return true;
}

function storageGet(storage, key) {
  try { return storage?.getItem(key) || ''; } catch { return ''; }
}

function storageSet(storage, key, value) {
  try { storage?.setItem(key, value); } catch { /* optional convenience only */ }
}

export function isDefaultResumeRoute(route = {}) {
  return !(
    route.codex
    || route.favorites
    || route.scope
    || route.q
    || (Array.isArray(route.searchFilters) && route.searchFilters.length)
    || route.entry
    || route.updateFilter
    || route.onlyNew
    || (Array.isArray(route.path) && route.path.length)
  );
}

/* 上次就停在这次打开的默认页首屏（同一本书、没进目录、没搜索、没开词条），继续也还是原地 */
export function isLandingSnapshot(snapshot, landing = {}) {
  if (!landing.codexId) return false;
  const codexId = findCodexMeta(snapshot.codexId)?.id || snapshot.codexId;
  if (codexId !== landing.codexId || snapshot.favoritesView || snapshot.siteSearchView || snapshot.entryId) return false;
  if (String(snapshot.q || '').trim() || snapshot.searchFilters?.length || snapshot.path?.length || snapshot.updateFilter) return false;
  return Number(snapshot.scrollY || 0) < Number(landing.viewportHeight || 0);
}

export function shouldOfferResume({
  snapshot,
  route,
  landing,
  now = Date.now(),
  sessionStorage = globalThis.sessionStorage,
  localStorage = globalThis.localStorage,
  onboardingShown = false,
  migrationVisible = false,
} = {}) {
  if (!snapshot || onboardingShown || migrationVisible || !isDefaultResumeRoute(route)) return false;
  if (isHistoryItemLocked(snapshot) || isLandingSnapshot(snapshot, landing)) return false;
  const age = now - Number(snapshot.at || 0);
  if (age < 0 || age > MAX_AGE) return false;
  if (storageGet(sessionStorage, SESSION_KEY) || storageGet(localStorage, DISMISS_KEY) === '1') return false;
  return true;
}

/* 卡片三行：上次停在词条上就用词条标题和缩略图，否则用法典名、目录与封面 */
function resumeCardContent(snapshot) {
  const place = browsePlace(snapshot);
  const entry = recentEntryForBrowse(snapshot);
  if (entry) {
    return { thumb: entry.thumb, title: entry.title, detail: [place.shortContext, place.detail].filter(Boolean).join(' · ') };
  }
  if (snapshot.favoritesView) return { mark: '★', title: place.context, detail: place.detail };
  if (place.context === '全站搜索') return { mark: SEARCH_MARK, title: place.context, detail: place.detail };
  return { thumb: codexCoverUrl(findCodexMeta(snapshot.codexId)), title: place.context, detail: place.detail || '全部' };
}

function fillThumb(box, content) {
  const showMark = () => {
    box.classList.add('no-img');
    box.innerHTML = content.mark || '☆';
  };
  if (!content.thumb) return showMark();
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.src = content.thumb;
  img.onerror = showMark;
  box.appendChild(img);
}

/* 电脑端顶替侧栏底的小贴士，不压内容；侧栏收起或手机端才浮在底边 */
function dockTarget() {
  const foot = document.querySelector('#sbFoot');
  if (!foot || foot.hidden || foot.closest('.sidebar')?.classList.contains('closed')) return null;
  if (window.matchMedia?.('(max-width:600px)').matches) return null;
  return foot;
}

export function setupResumePrompt({ route = {}, onboardingShown = false } = {}) {
  if (document.body.classList.contains('local-edition')) return false;
  const migrationVisible = Boolean(document.querySelector('[data-favorites-migration-banner]:not([hidden])'));
  const snapshot = state.lastBrowse;
  const landing = { codexId: state.codex?.id || '', viewportHeight: window.innerHeight || 0 };
  if (!shouldOfferResume({ snapshot, route, landing, onboardingShown, migrationVisible })) return false;
  storageSet(globalThis.sessionStorage, SESSION_KEY, '1');

  const content = resumeCardContent(snapshot);
  const card = document.createElement('aside');
  card.className = 'resume-prompt';
  card.setAttribute('aria-label', '继续上次浏览');
  card.innerHTML = `
    <button class="resume-prompt-main" type="button">
      <span class="resume-prompt-thumb" aria-hidden="true"></span>
      <span class="resume-prompt-text">
        <span class="resume-prompt-kicker">继续上次<i></i></span>
        <b></b>
        <small></small>
      </span>
    </button>
    <button class="resume-prompt-close" type="button" aria-label="本次关闭">×</button>`;
  fillThumb(card.querySelector('.resume-prompt-thumb'), content);
  card.querySelector('.resume-prompt-kicker i').textContent = formatRecentTime(snapshot.at);
  card.querySelector('b').textContent = content.title;
  const detail = card.querySelector('small');
  detail.textContent = content.detail;
  detail.hidden = !content.detail;
  card.querySelector('.resume-prompt-main').title = [content.title, content.detail].filter(Boolean).join('\n');   // 路径长会截断

  const dock = dockTarget();
  if (dock) {
    card.classList.add('is-docked');
    dock.prepend(card);
    const tip = dock.querySelector('#sbTip');
    if (tip) tip.hidden = true;
  } else {
    card.classList.add('is-floating');
    document.body.appendChild(card);
  }
  activePrompt = card;
  requestAnimationFrame(() => card.classList.add('show'));

  const hide = () => {
    window.clearTimeout(activePromptTimer);
    activePromptTimer = 0;
    card.classList.remove('show');
    window.setTimeout(() => {
      card.remove();
      if (activePrompt !== card) return;
      activePrompt = null;
      restoreSidebarTip();
    }, 240);
  };
  /* 浮在底边时会盖住卡片，十秒没碰就收起；停在侧栏里不挡东西，等用户自己处理 */
  if (!dock) {
    const arm = () => {
      window.clearTimeout(activePromptTimer);
      activePromptTimer = window.setTimeout(hide, FLOAT_HIDE_MS);
    };
    card.addEventListener('pointerenter', () => window.clearTimeout(activePromptTimer));
    card.addEventListener('pointerleave', arm);
    card.addEventListener('focusin', () => window.clearTimeout(activePromptTimer));
    card.addEventListener('focusout', event => {
      if (!card.contains(event.relatedTarget)) arm();
    });
    arm();
  }
  card.querySelector('.resume-prompt-main')?.addEventListener('click', async () => {
    hide();
    try { await resumeLastBrowse({ historyMode: 'push', snapshot }); }
    catch (error) { console.error('[history] 恢复上次浏览失败', error); }
  });
  card.querySelector('.resume-prompt-close')?.addEventListener('click', hide);
  return true;
}

/* 「浏览记录」面板里的开关；每次开面板重新读一遍，别的标签页改过也对得上 */
export function bindResumePromptToggle(input) {
  if (!input) return;
  input.checked = readPreference(DISMISS_KEY) !== '1';
  input.onchange = () => {
    const on = input.checked;
    if (!writePreference(DISMISS_KEY, on ? '0' : '1')) {
      input.checked = !on;
      return;
    }
    if (!on) dismissResumePrompt();
  };
}
