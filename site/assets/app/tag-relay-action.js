/* 中转站内的轻量确认 / 命名条。它留在侧栏文档流里，不打开浏览器原生
   prompt / confirm，也不再叠一层模态框打断连续编排。 */

let refs = null;
let pending = null;
let lastTrigger = null;

function finish(value, { restoreFocus = true } = {}) {
  if (!pending || !refs) return;
  const { resolve } = pending;
  pending = null;
  refs.root.hidden = true;
  refs.input.value = '';
  refs.inputWrap.hidden = true;
  refs.message.textContent = '';
  refs.confirm.classList.remove('is-danger');
  const trigger = lastTrigger;
  lastTrigger = null;
  resolve(value);
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
}

/* 收栏 / 切页签时把没走完的确认条收掉。这条 form 是三个页签的公共兄弟节点，
   既不随页签隐藏也不随收栏销毁，留着就会在下一次打开时原样浮现。
   ⚠ 危险的是「清空最近复制」「清空复制历史」「删除方案」这三条 danger 操作：
   用户以为自己已经放弃了，回来随手点一下「确认」就真执行。
   一律按「取消」收尾（resolve(null)），调用方的 `if (!accepted) return` 会照常生效，
   不会留下悬空的 promise；焦点不还，因为要还回去的那个按钮马上就要被 inert / hidden。 */
export function cancelRelayAction() {
  if (!pending) return;
  finish(null, { restoreFocus: false });
}

export function setupRelayAction(root = document) {
  if (refs) return;
  const q = selector => root.querySelector(selector);
  refs = {
    root: q('#relayInlineAction'),
    title: q('#relayInlineActionTitle'),
    message: q('#relayInlineActionMessage'),
    inputWrap: q('#relayInlineActionInputWrap'),
    inputLabel: q('#relayInlineActionInputLabel'),
    input: q('#relayInlineActionInput'),
    cancel: q('#relayInlineActionCancel'),
    confirm: q('#relayInlineActionConfirm'),
  };
  if (Object.values(refs).some(value => !value)) {
    refs = null;
    return;
  }
  refs.root.addEventListener('submit', event => {
    event.preventDefault();
    if (refs.inputWrap.hidden) finish(true);
    else finish(refs.input.value.trim());
  });
  refs.cancel.addEventListener('click', () => finish(null));
  refs.root.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    finish(null);
  });
}

export function requestRelayAction({
  title,
  message = '',
  confirmLabel = '确认',
  danger = false,
  input = null,
  trigger = document.activeElement,
} = {}) {
  setupRelayAction();
  if (!refs) return Promise.resolve(null);
  if (pending) finish(null, { restoreFocus: false });
  if (trigger instanceof HTMLElement) lastTrigger = trigger;
  refs.title.textContent = String(title || '确认操作');
  refs.message.textContent = String(message || '');
  refs.message.hidden = !message;
  refs.confirm.textContent = String(confirmLabel || '确认');
  refs.confirm.classList.toggle('is-danger', Boolean(danger));
  refs.inputWrap.hidden = !input;
  if (input) {
    refs.inputLabel.textContent = String(input.label || '名称');
    refs.input.value = String(input.value || '');
    refs.input.maxLength = Math.max(1, Number(input.maxLength) || 60);
  }
  refs.root.hidden = false;
  const promise = new Promise(resolve => { pending = { resolve }; });
  queueMicrotask(() => {
    const target = input ? refs.input : refs.confirm;
    target.focus({ preventScroll: true });
    if (input && input.select !== false) target.select();
  });
  return promise;
}
