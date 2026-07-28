import { closeMask, openMask, trapFocus } from '../app/modal.js';
import { readOwnedRecords } from '../app/local-ownership.js';
import { escHtml } from './utils.js';

export const COMMUNITY_SUBMISSIONS_KEY = 'fadian-community-submissions-v1';

let mask = null;
let getEntries = () => [];
let openEntry = null;

function formatDate(value) {
  try {
    return new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    return '';
  }
}

function ensureMask() {
  if (mask?.isConnected) return mask;
  mask = document.createElement('div');
  mask.id = 'mySubmissionsPanel';
  mask.className = 'community-mask';
  mask.hidden = true;
  mask.setAttribute('role', 'dialog');
  mask.setAttribute('aria-modal', 'true');
  mask.setAttribute('aria-labelledby', 'mySubmissionsTitle');
  mask.innerHTML = `
    <div class="dialog-panel my-submissions-panel">
      <button class="dialog-close" type="button" data-my-submissions-close aria-label="关闭">×</button>
      <h2 id="mySubmissionsTitle">我的投稿</h2>
      <p class="my-submissions-note">这里只记录当前浏览器近 180 天成功提交的投稿；清理浏览器数据或换设备后不会同步。</p>
      <div class="my-submissions-list"></div>
    </div>`;
  document.body.appendChild(mask);
  mask.querySelector('[data-my-submissions-close]')?.addEventListener('click', () => closeMask(mask));
  mask.addEventListener('click', event => {
    if (event.target === mask) closeMask(mask);
    const button = event.target.closest('[data-my-submission-id]');
    if (!button || button.disabled) return;
    const entry = getEntries().find(item => String(item.id) === button.dataset.mySubmissionId);
    if (!entry) return;
    closeMask(mask, { historyMode: 'none' });
    openEntry?.(entry, { consumeLayer: true });
  });
  mask.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMask(mask);
      return;
    }
    trapFocus(event, mask);
  });
  return mask;
}

export function renderMySubmissions() {
  const panel = ensureMask();
  const list = panel.querySelector('.my-submissions-list');
  const records = readOwnedRecords(COMMUNITY_SUBMISSIONS_KEY);
  const entries = new Map(getEntries().map(entry => [String(entry.id || ''), entry]));
  document.querySelectorAll('[data-my-submissions-count]').forEach(node => {
    node.textContent = records.length ? String(records.length) : '';
    node.hidden = records.length === 0;
  });
  if (!records.length) {
    list.innerHTML = '<div class="my-submissions-empty">当前浏览器还没有投稿记录。成功提交后会自动出现在这里。</div>';
    return;
  }
  list.innerHTML = records.map(record => {
    const published = entries.has(record.id);
    return `
      <button class="my-submission-item" type="button" data-my-submission-id="${escHtml(record.id)}"${published ? '' : ' disabled'}>
        <span><b>${escHtml(record.title || '未命名投稿')}</b><small>提交于 ${escHtml(formatDate(record.createdAt))}</small></span>
        <em class="${published ? 'is-published' : 'is-pending'}">${published ? '已发布' : '尚未公开'}</em>
      </button>`;
  }).join('') + '<p class="my-submissions-footnote">“尚未公开”可能表示仍在审核或未通过；本站不会在无鉴权页面公开内部审核备注。</p>';
}

export function openMySubmissions(trigger = document.activeElement) {
  renderMySubmissions();
  openMask(ensureMask(), trigger);
}

export function initMySubmissions(options = {}) {
  getEntries = typeof options.getEntries === 'function' ? options.getEntries : getEntries;
  openEntry = typeof options.openEntry === 'function' ? options.openEntry : openEntry;
  document.querySelectorAll('[data-my-submissions-open]').forEach(button => {
    if (button.dataset.boundMySubmissions === '1') return;
    button.dataset.boundMySubmissions = '1';
    button.addEventListener('click', () => openMySubmissions(button));
  });
  renderMySubmissions();
}
