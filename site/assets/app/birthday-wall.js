import { esc } from './utils.js';
import { bindBackdropDismiss, closeMask, openMask, trapFocus } from './modal.js';
import { PARTY_HAT_HTML } from './birthday-fx.js';

/* 所长生日祝福墙（后端 functions/api/birthday-messages.js）：先审后发，样子是一张对折的生日贺卡。
   - 第一次画出生日入口时读一次墙的状态；墙开着才给 html 挂 .bday-wall，横幅和选择器里的「生日贺卡」入口靠它显示。
   - 点入口翻开贺卡（同站内其它浮层：背板、Esc、返回键都能关）：左页戴生日帽的所长与签名数，右页横格信纸，
     已通过的祝福一行行签在上面、新的在上；开着时每 30 秒刷新，刷新时新出现的那几条像手写一样从左往右写出来。
   - 右页底下签一句、可署名，送出后进待审，审核通过才签到贺卡上。收留言的时段过了就只看不写。署名记在本机。 */

const ENDPOINT = '/api/birthday-messages';
const POLL_MS = 30_000;
const BODY_MAX = 60;
const NAME_KEY = 'nat-birthday-wall-name';
const REASONS = {
  rate: '留言太频繁，10 分钟后再试',
  blocked: '不能包含链接、号码或联系方式',
  empty: '写几个字再签上',
  too_long: `最多 ${BODY_MAX} 字`,
  closed: '留言已截止',
  off: '贺卡已收起',
};

const wall = { loading: null, data: null, mask: null, timer: 0, seen: null, sending: false };

function readName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
}

function rememberName(name) {
  try { if (name) localStorage.setItem(NAME_KEY, name); else localStorage.removeItem(NAME_KEY); } catch { /* 存不下就下次再填 */ }
}

async function fetchWall() {
  try {
    const res = await fetch(ENDPOINT, { cache: 'no-store', credentials: 'same-origin' });
    const data = res.ok ? await res.json() : null;
    return data?.enabled === true ? data : null;
  } catch { return null; }
}

function applyState(data) {
  wall.data = data;
  document.documentElement.classList.toggle('bday-wall', Boolean(data?.wall));
}

/** 画出生日入口时调；只读一次，决定要不要显示「生日贺卡」入口 */
export function loadBirthdayWall() {
  if (!wall.loading) wall.loading = fetchWall().then(applyState);
  return wall.loading;
}

function ago(ms) {
  const seconds = (Date.now() - ms) / 1000;
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildMask() {
  const mask = document.createElement('div');
  mask.id = 'birthdayWall';
  mask.className = 'settings-mask bwall-mask';
  mask.hidden = true;
  mask.innerHTML =
    '<div class="settings-panel bwall" role="dialog" aria-modal="true" aria-labelledby="bwallTitle">' +
    '<button class="settings-close" type="button" aria-label="关闭" data-bwall-close>×</button>' +
    '<div class="bwall-cover">' +
    `<span class="bwall-avatar" aria-hidden="true"><img src="assets/birthday/suozhang-avatar.webp" alt="" decoding="async">${PARTY_HAT_HTML}</span>` +
    '<span class="bwall-greet"><b id="bwallTitle">生日快乐</b><small>法典创作者 · 所长</small>' +
    '<span class="bwall-count" hidden></span></span></div>' +
    '<div class="bwall-page">' +
    '<ol class="bwall-list" aria-live="polite"></ol>' +
    '<p class="bwall-empty" hidden>还没有签名</p>' +
    '<form class="bwall-form" novalidate>' +
    `<input class="bwall-body" name="body" maxlength="${BODY_MAX}" placeholder="在这里签一句" aria-label="祝福" autocomplete="off">` +
    '<div class="bwall-row"><input name="name" maxlength="12" placeholder="署名（可不填）" aria-label="署名" autocomplete="nickname">' +
    `<span class="bwall-left" aria-hidden="true">0/${BODY_MAX}</span><button class="bwall-send" type="submit" disabled>签上</button></div>` +
    '<p class="bwall-note" role="status"></p>' +
    '</form></div></div>';
  document.body.append(mask);
  const close = () => closeMask(mask);
  mask.querySelector('[data-bwall-close]').addEventListener('click', close);
  bindBackdropDismiss(mask, close);
  mask.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); return; }
    trapFocus(ev, mask);
  });
  const form = mask.querySelector('.bwall-form');
  const body = form.elements.body;
  const sync = () => {
    const length = [...body.value].length;
    form.querySelector('.bwall-left').textContent = `${length}/${BODY_MAX}`;
    form.querySelector('.bwall-send').disabled = wall.sending || !body.value.trim();
  };
  body.addEventListener('input', sync);
  form.elements.name.value = readName();
  form.addEventListener('submit', ev => { ev.preventDefault(); void submit(form, sync); });
  // 关掉贺卡就停止刷新；Mask 自己的 hidden 由 modal.js 管
  new MutationObserver(() => { if (mask.hidden) stopPolling(); }).observe(mask, { attributes: true, attributeFilter: ['hidden'] });
  return mask;
}

function render() {
  const mask = wall.mask;
  if (!mask) return;
  const data = wall.data;
  const messages = data?.messages || [];
  const list = mask.querySelector('.bwall-list');
  const fresh = wall.seen ? messages.filter(m => !wall.seen.has(m.id)).map(m => m.id) : [];
  list.innerHTML = messages.map(m =>
    `<li class="${fresh.includes(m.id) ? 'is-new' : ''}"><span class="bwall-text">${esc(m.body)}</span>` +
    `<span class="bwall-sig">—— ${m.name ? esc(m.name) : '匿名'} · ${ago(m.at)}</span></li>`).join('');
  wall.seen = new Set(messages.map(m => m.id));
  mask.querySelector('.bwall-empty').hidden = messages.length > 0;
  const count = mask.querySelector('.bwall-count');
  count.hidden = !data?.total;
  count.textContent = data?.total ? `已有 ${data.total} 份签名` : '';
  const form = mask.querySelector('.bwall-form');
  const writable = Boolean(data?.wall && data.open);
  form.querySelector('.bwall-body').hidden = !writable;
  form.querySelector('.bwall-row').hidden = !writable;
  if (!writable && data) form.querySelector('.bwall-note').textContent = data.wall === false ? REASONS.off : REASONS.closed;
}

function stopPolling() {
  window.clearTimeout(wall.timer);
  wall.timer = 0;
}

function schedule() {
  stopPolling();
  wall.timer = window.setTimeout(async () => {
    if (!wall.mask || wall.mask.hidden) return;
    if (document.visibilityState !== 'hidden') {
      const data = await fetchWall();
      if (data) { applyState(data); render(); }
    }
    schedule();
  }, POLL_MS);
}

/** 横幅 / 选择器里的「生日贺卡」入口调 */
export async function openBirthdayWall(trigger) {
  wall.mask ||= buildMask();
  openMask(wall.mask, trigger);
  render();
  const data = await fetchWall();
  if (data) applyState(data);
  render();
  schedule();
}

async function submit(form, sync) {
  const note = form.querySelector('.bwall-note');
  const body = form.elements.body.value.trim();
  const name = form.elements.name.value.trim();
  if (!body || wall.sending) return;
  wall.sending = true;
  sync();
  note.textContent = '';
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body, name }),
    });
    const data = await res.json().catch(() => null);
    if (data?.accepted) {
      form.elements.body.value = '';
      rememberName(name);
      note.textContent = '已收到，审核通过后会签到贺卡上';
    } else {
      note.textContent = REASONS[data?.reason] || '没送出去，稍后再试';
    }
  } catch {
    note.textContent = '没送出去，稍后再试';
  }
  wall.sending = false;
  sync();
}
