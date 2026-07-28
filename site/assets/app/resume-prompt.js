import { state } from './state.js';
import { browseDesc, isHiddenR18gHistoryItem, resumeLastBrowse } from './history.js';

const SESSION_KEY = 'fadian-resume-prompt-shown-v1';
const DISMISS_KEY = 'fadian-resume-prompt-dismissed-v1';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

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
    || route.entry
    || route.onlyNew
    || (Array.isArray(route.path) && route.path.length)
  );
}

export function shouldOfferResume({
  snapshot,
  route,
  now = Date.now(),
  sessionStorage = globalThis.sessionStorage,
  localStorage = globalThis.localStorage,
  onboardingShown = false,
  migrationVisible = false,
} = {}) {
  if (!snapshot || onboardingShown || migrationVisible || !isDefaultResumeRoute(route)) return false;
  if (isHiddenR18gHistoryItem(snapshot)) return false;
  const age = now - Number(snapshot.at || 0);
  if (age < 0 || age > MAX_AGE) return false;
  if (storageGet(sessionStorage, SESSION_KEY) || storageGet(localStorage, DISMISS_KEY)) return false;
  return true;
}

export function setupResumePrompt({ route = {}, onboardingShown = false } = {}) {
  if (document.body.classList.contains('local-edition')) return false;
  const migrationVisible = Boolean(document.querySelector('[data-favorites-migration-banner]:not([hidden])'));
  if (!shouldOfferResume({ snapshot: state.lastBrowse, route, onboardingShown, migrationVisible })) return false;
  storageSet(globalThis.sessionStorage, SESSION_KEY, '1');

  const chip = document.createElement('aside');
  chip.className = 'resume-prompt';
  chip.setAttribute('aria-label', '继续上次浏览');
  chip.innerHTML = `
    <button class="resume-prompt-main" type="button"><span>继续上次</span><b></b></button>
    <button class="resume-prompt-never" type="button">不再提示</button>
    <button class="resume-prompt-close" type="button" aria-label="本次关闭">×</button>`;
  chip.querySelector('b').textContent = browseDesc(state.lastBrowse);
  document.body.appendChild(chip);
  requestAnimationFrame(() => chip.classList.add('show'));

  let timer = 0;
  const hide = () => {
    window.clearTimeout(timer);
    chip.classList.remove('show');
    window.setTimeout(() => chip.remove(), 240);
  };
  const arm = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(hide, 10_000);
  };
  chip.addEventListener('pointerenter', () => window.clearTimeout(timer));
  chip.addEventListener('pointerleave', arm);
  chip.addEventListener('focusin', () => window.clearTimeout(timer));
  chip.addEventListener('focusout', event => {
    if (!chip.contains(event.relatedTarget)) arm();
  });
  chip.querySelector('.resume-prompt-main')?.addEventListener('click', async () => {
    hide();
    try { await resumeLastBrowse({ historyMode: 'push' }); }
    catch (error) { console.error('[history] 恢复上次浏览失败', error); }
  });
  chip.querySelector('.resume-prompt-close')?.addEventListener('click', hide);
  chip.querySelector('.resume-prompt-never')?.addEventListener('click', () => {
    storageSet(globalThis.localStorage, DISMISS_KEY, '1');
    hide();
  });
  arm();
  return true;
}
