/* 生日留言墙后台（birthday-review.html）：维护者用管理口令看全部留言、改状态、整面墙开关。
   口令与共创广场后台共用同一个 sessionStorage 键，从那边点链接过来不用再输。 */
const KEY = 'strings-admin-token';
const API = '/api/admin/birthday-messages';
const TABS = [
  ['held', '待你定'], ['pending', '待审'], ['approved', '已上墙'], ['hidden', '已隐藏'], ['rejected', '已拒绝'], ['all', '全部'],
];
const ACTIONS = { approve: '通过', hide: '隐藏', reject: '拒绝' };
const $ = id => document.getElementById(id);
let data = null;
let tab = 'held';

const token = () => { try { return sessionStorage.getItem(KEY) || ''; } catch { return ''; } };
const setToken = value => { try { sessionStorage.setItem(KEY, value); } catch { /* 只在本页内存里用 */ } };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = ms => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '');

async function api(method, body) {
  const res = await fetch(API, {
    method, headers: { authorization: `Bearer ${token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error(json.error || '管理口令无效'), { unauthorized: true });
  if (!res.ok || json.ok === false || json.enabled === false) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function render() {
  if (!data) return;
  $('wallState').textContent = data.wall ? '开着' : '关着';
  $('wallState').className = `wall-state${data.wall ? '' : ' off'}`;
  $('wallToggle').textContent = data.wall ? '关闭祝福墙' : '打开祝福墙';
  $('wallToggle').className = data.wall ? 'danger' : 'primary';
  const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
  $('tabs').innerHTML = TABS.map(([id, label]) =>
    `<button type="button" data-tab="${id}" class="${tab === id ? 'on' : ''}">${label} ${id === 'all' ? total : data.counts[id] || 0}</button>`).join('');
  const rows = data.messages.filter(m => tab === 'all' || m.status === tab);
  const label = Object.fromEntries(TABS);
  $('list').innerHTML = rows.length ? rows.map(m => {
    const acts = Object.entries(ACTIONS)
      .filter(([action]) => !(action === 'approve' && m.status === 'approved') && !(action === 'hide' && m.status === 'hidden')
        && !(action === 'reject' && m.status === 'rejected'))
      .map(([action, text]) => `<button type="button" class="${action === 'approve' ? 'primary' : 'danger'}" data-id="${esc(m.id)}" data-action="${action}">${text}</button>`)
      .join('');
    return `<div class="item"><div class="body"><p>${esc(m.body)}</p>` +
      `<small><span class="tag ${esc(m.status)}">${label[m.status] || esc(m.status)}</span>${m.name ? `${esc(m.name)} · ` : ''}${time(m.created_at)}` +
      `${m.decided_by ? ` · ${m.decided_by === 'agent' ? '审核 agent' : '维护者'}处理` : ''}</small></div><div class="acts">${acts}</div></div>`;
  }).join('') : '<div class="empty">这一栏没有留言</div>';
}

async function load() {
  $('err').textContent = '';
  try {
    data = await api('GET');
    $('login').hidden = true;
    $('app').hidden = false;
    render();
  } catch (error) {
    if (error.unauthorized || !token()) { $('app').hidden = true; $('login').hidden = false; $('loginErr').textContent = token() ? error.message : ''; return; }
    $('err').textContent = `读取失败：${error.message}`;
  }
}

$('enter').addEventListener('click', () => { setToken($('token').value.trim()); void load(); });
$('token').addEventListener('keydown', ev => { if (ev.key === 'Enter') $('enter').click(); });
$('refresh').addEventListener('click', () => void load());
$('tabs').addEventListener('click', ev => {
  const button = ev.target.closest('[data-tab]');
  if (button) { tab = button.dataset.tab; render(); }
});
$('wallToggle').addEventListener('click', async () => {
  if (data.wall && !confirm('关闭后访客看不到祝福墙，也不能再留言。确定关闭？')) return;
  try { await api('POST', { action: 'wall', on: !data.wall }); await load(); }
  catch (error) { $('err').textContent = `操作失败：${error.message}`; }
});
$('list').addEventListener('click', async ev => {
  const button = ev.target.closest('[data-action]');
  if (!button) return;
  button.disabled = true;
  try { await api('POST', { id: button.dataset.id, action: button.dataset.action }); await load(); }
  catch (error) { $('err').textContent = `操作失败：${error.message}`; button.disabled = false; }
});
setInterval(() => { if (!$('app').hidden && document.visibilityState === 'visible') void load(); }, 30_000);
void load();
