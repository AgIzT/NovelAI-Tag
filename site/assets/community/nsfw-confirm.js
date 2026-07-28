import { closeMask, openMask, trapFocus } from '../app/modal.js';

let mask = null;
let pendingAccept = null;

function ensureMask() {
  if (mask?.isConnected) return mask;
  mask = document.createElement('div');
  mask.id = 'communityNsfwConfirm';
  mask.className = 'community-mask';
  mask.hidden = true;
  mask.setAttribute('role', 'dialog');
  mask.setAttribute('aria-modal', 'true');
  mask.setAttribute('aria-labelledby', 'communityNsfwTitle');
  mask.innerHTML = `
    <div class="dialog-panel community-confirm-panel">
      <button class="dialog-close" type="button" data-community-nsfw-cancel aria-label="关闭">×</button>
      <div class="community-confirm-icon" aria-hidden="true">18+</div>
      <h2 id="communityNsfwTitle">成人内容提示</h2>
      <p>开启后，共创广场会混合展示可能包含成人向、裸露、性暗示或露骨内容的投稿。</p>
      <p>请确认你所在地区允许访问此类内容，并且你已年满 18 周岁或达到当地法定成年年龄。</p>
      <div class="community-confirm-actions">
        <button class="ghost-btn" type="button" data-community-nsfw-cancel>暂不开启</button>
        <button class="primary-btn" type="button" data-community-nsfw-accept>我已成年，开启混显</button>
      </div>
    </div>`;
  document.body.appendChild(mask);

  const cancel = () => {
    pendingAccept = null;
    closeMask(mask);
  };
  mask.querySelectorAll('[data-community-nsfw-cancel]').forEach(button => {
    button.addEventListener('click', cancel);
  });
  mask.querySelector('[data-community-nsfw-accept]')?.addEventListener('click', () => {
    const accept = pendingAccept;
    pendingAccept = null;
    /* 接受后的目标动作会以 consumeLayer 替换当前确认层，避免多一层 Back。 */
    closeMask(mask, { historyMode: 'none' });
    accept?.({ consumeLayer: true });
  });
  mask.addEventListener('click', event => {
    if (event.target === mask) cancel();
  });
  mask.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return;
    }
    trapFocus(event, mask);
  });
  return mask;
}

export function requestCommunityNsfwAccess({ trigger = document.activeElement, onAccept } = {}) {
  pendingAccept = typeof onAccept === 'function' ? onAccept : null;
  openMask(ensureMask(), trigger);
}
