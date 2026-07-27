import { $ } from './utils.js';
import { openMask, closeMask, trapFocus } from './modal.js';

export const ONBOARDING_STORAGE_KEY = 'fadian-onboarding-v1-done';

const initialRouteUrl = hasRouteStateInUrl();
const CUR = '<svg class="ob-cur" viewBox="0 0 24 24"><path d="M5 2.5l13 8-5.4 1.3-3 5.7z" fill="#2a2d3a" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>';
const STEPS = [
  {
    cls: 'obs-1',
    scene: `<div class="ob-grid"><i></i><i></i><i class="ob-t"></i><i></i></div><div class="ob-ck"><svg viewBox="0 0 24 24"><path d="M5 12l4 4 10-10" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>${CUR}`,
    title: '看图，点一下就复制',
    body: '看中哪张例图，点卡片即复制它的法典提示词，直接粘进 NovelAI。',
  },
  {
    cls: 'obs-2',
    scene: `<div class="ob-dim"></div><div class="ob-card"><span class="ob-pic"></span><span class="ob-zoom"><svg viewBox="0 0 24 24"><circle cx="10" cy="10" r="6"/><path d="M14.5 14.5 20 20"/></svg></span></div><div class="ob-info"><u></u><u></u><u></u></div><div class="ob-nai"><i>NAI</i><s></s></div><div class="ob-big"></div>${CUR}`,
    title: '要原参数？放大获取原图拖进 NAI',
    body: '列表是缩略图不含参数。点图右上角放大成原图，再把大图拖进 NovelAI，多数能直接读出生成参数。',
  },
  {
    cls: 'obs-3',
    scene: `<div class="ob-card"><b></b></div><div class="ob-panel"><u></u><u></u></div><div class="ob-fb">!</div>${CUR}`,
    title: '有问题，点反馈',
    body: '海量词条配对难免出错，如遇词条卡片有错、图打不开、复制不对，点反馈说一声，我们会尽快修复更正。',
  },
];

let step = 0;
let prompted = false;

export function setupOnboarding() {
  const mask = $('#onboarding');
  if (!mask) return;
  $('#onboardingSkip')?.addEventListener('click', finishOnboarding);
  $('#onboardingBack')?.addEventListener('click', () => {
    step = Math.max(0, step - 1);
    renderOnboardingStep();
  });
  $('#onboardingNext')?.addEventListener('click', () => {
    if (step >= STEPS.length - 1) {
      finishOnboarding();
      return;
    }
    step += 1;
    renderOnboardingStep();
  });
  mask.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      finishOnboarding();
      return;
    }
    trapFocus(ev, mask);
  });
}

export function maybeShowOnboarding() {
  // 独立本地版由可编辑 Demo 直接教学，通用的线上浏览/反馈引导会造成误导。
  if (document.body.classList.contains('local-edition')) return;
  if (prompted || initialRouteUrl || isOnboardingDone()) return;
  const mask = $('#onboarding');
  if (!mask) return;
  if (document.querySelector('.settings-mask.show')) return;
  prompted = true;
  step = 0;
  renderOnboardingStep();
  openMask(mask);
}

function finishOnboarding() {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, '1');
  } catch {}
  prompted = true;
  closeMask($('#onboarding'));
}

function isOnboardingDone() {
  try {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function renderOnboardingStep() {
  const item = STEPS[step];
  if (!item) return;
  const scene = $('#onboardingScene');
  if (scene) {
    scene.className = 'onboarding-scene ' + item.cls;
    scene.innerHTML = item.scene;
  }
  $('#onboardingTitle').textContent = item.title;
  $('#onboardingBody').textContent = item.body;
  $('#onboardingStep').textContent = `${step + 1} / ${STEPS.length}`;
  const back = $('#onboardingBack');
  const next = $('#onboardingNext');
  if (back) back.disabled = step === 0;
  if (next) next.textContent = step >= STEPS.length - 1 ? '知道了' : '下一步';
  document.querySelectorAll('.onboarding-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === step);
  });
}

function hasRouteStateInUrl() {
  const params = new URLSearchParams(location.search);
  const hash = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
  return ['codex', 'path', 'q', 'entry'].some(key => {
    if (key === 'path') return params.getAll('path').some(Boolean);
    return Boolean(params.get(key));
  }) || Boolean(hash.get('entry'));
}
