import { esc } from './utils.js';
import { bindBackdropDismiss, closeMask, openMask, trapFocus } from './modal.js';
import { PARTY_HAT_HTML, buntingSVG, burstConfetti, createWishCombo, flipPartyHat, innerConfettiLayer } from './birthday-fx.js';
import { formatWishes, sendWish, wishPageFull, wishTotal } from './birthday-wishes.js';

/* 所长生日祝福墙（后端 functions/api/birthday-messages.js）：先审后发，样子是一张对折的生日贺卡。
   - 第一次画出生日入口时读一次墙的状态；墙开着才给 html 挂 .bday-wall，横幅和选择器里的「生日贺卡」入口靠它显示。
   - 点入口翻开贺卡（同站内其它浮层：背板、Esc、返回键都能关）：左页是封面——顶上一串彩旗、背景慢慢飘的纸屑、
     「致 所长」、戴生日帽的头像（点它也送一份祝福，有连击）、所长整理的法典本数与词条数、全站祝福数和签名数；右页横格信纸，
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

const wall = { loading: null, data: null, mask: null, timer: 0, seen: null, sending: false, info: {} };
const coverCombo = createWishCombo();

// 2.6 万这种写法，书目里的词条数大多上万
function formatEntries(n) {
  return n >= 10000 ? `${(n / 10000).toFixed(1).replace(/\.0$/, '')} 万` : formatWishes(n);
}

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
    '<div class="bwall-cover">' + buntingSVG() +
    `<span class="bwall-drift" aria-hidden="true">${'<i></i>'.repeat(12)}</span>` +
    '<span class="bwall-to">致 所长</span>' +
    `<button class="bwall-avatar" type="button" aria-label="送上祝福"><img src="assets/birthday/suozhang-avatar.webp" alt="" decoding="async">${PARTY_HAT_HTML}</button>` +
    '<span class="bwall-tap" aria-hidden="true">点头像送祝福</span>' +
    '<span class="bwall-greet"><b id="bwallTitle">生日快乐</b><small>法典创作者 · 所长</small></span>' +
    '<span class="bwall-stats"><span data-stat="books" hidden><b></b>本法典</span><span data-stat="entries" hidden><b></b>条词条</span>' +
    '<span data-stat="wishes" hidden><b></b>份祝福</span></span>' +
    '<span class="bwall-count" hidden></span>' +
    '<p class="bwall-thanks">谢谢你把提示词整理成一本本法典</p></div>' +
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
  const avatar = mask.querySelector('.bwall-avatar');
  const cover = mask.querySelector('.bwall-cover');
  avatar.addEventListener('click', () => {
    const counted = sendWish();
    const layer = innerConfettiLayer(cover);
    const c = cover.getBoundingClientRect();
    const r = avatar.getBoundingClientRect();
    const x = r.left - c.left + r.width / 2;
    coverCombo({
      target: avatar, layer, x: r.right - c.left - r.width * 0.1, y: r.top - c.top + r.height * 0.12, counted, full: wishPageFull(),
      burst: () => burstConfetti(layer, x, r.top - c.top + r.height * 0.3, { angle: -90, spread: 120, count: 8, reach: 60, fall: 120 }),
      big: () => {
        burstConfetti(layer, r.left - c.left, r.top - c.top + r.height * 0.6, { angle: -60, spread: 40, count: 14, reach: 110, fall: 140 });
        burstConfetti(layer, r.right - c.left, r.top - c.top + r.height * 0.6, { angle: -120, spread: 40, count: 14, reach: 110, fall: 140 });
        flipPartyHat(avatar);
      },
    });
  });
  document.addEventListener('birthday:wishes', () => renderStats());
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

function renderStats() {
  const mask = wall.mask;
  if (!mask) return;
  const set = (key, value) => {
    const el = mask.querySelector(`[data-stat="${key}"]`);
    el.hidden = !value;
    if (value) el.firstChild.textContent = value;
  };
  set('books', wall.info.books ? String(wall.info.books) : '');
  set('entries', wall.info.entries ? formatEntries(wall.info.entries) : '');
  const wishes = wishTotal();
  set('wishes', wishes ? formatWishes(wishes) : '');
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

/** 横幅 / 选择器里的「生日贺卡」入口调；info 是所长的书目统计 { books, entries } */
export async function openBirthdayWall(trigger, info = {}) {
  wall.mask ||= buildMask();
  wall.info = info;
  openMask(wall.mask, trigger);
  render();
  renderStats();
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
