import { bindOutsideDismiss } from './modal.js';

let nextSelectId = 0;

/* 只拥有单选菜单的界面状态；选中的业务值由调用方提交成功后 setValue。 */
export function createSelectMenu({
  label = '', options = [], value = '', onChange = () => {}, className = '',
  triggerLabel = '', onOpen = () => {},
} = {}) {
  const element = document.createElement('div');
  element.className = ['ui-select', className].filter(Boolean).join(' ');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ui-select-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const text = document.createElement('span');
  text.className = 'ui-select-label';
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arrow.setAttribute('class', 'ui-select-arrow');
  arrow.setAttribute('viewBox', '0 0 16 16');
  arrow.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm4 6 4 4 4-4');
  arrow.append(path);
  button.append(text, arrow);
  const list = document.createElement('div');
  list.id = `uiSelectList${++nextSelectId}`;
  list.className = 'ui-select-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  button.setAttribute('aria-controls', list.id);
  element.append(button, list);

  let choices = [];
  let selectedValue = String(value);
  let accessibleLabel = String(label);
  let customTriggerLabel = String(triggerLabel);
  let destroyed = false;
  let tabTimer = 0;
  const bindings = [];
  const bind = (target, type, handler) => {
    target.addEventListener(type, handler);
    bindings.push(() => target.removeEventListener(type, handler));
  };
  const optionButtons = () => [...list.children].filter(option => !option.disabled);
  const selectedButton = () => optionButtons().find(option => option.dataset.value === selectedValue);
  const clearTabTimer = () => { clearTimeout(tabTimer); tabTimer = 0; };

  function syncValue() {
    const current = choices.find(option => option.value === selectedValue);
    text.textContent = current?.label || accessibleLabel;
    button.setAttribute('aria-label', customTriggerLabel || (current ? `${accessibleLabel}：${current.label}` : accessibleLabel));
    list.setAttribute('aria-label', accessibleLabel);
    for (const option of list.children) {
      const selected = option.dataset.value === selectedValue;
      option.setAttribute('aria-selected', String(selected));
      option.lastElementChild.textContent = selected ? '✓' : '';
    }
  }

  function close({ restoreFocus = false } = {}) {
    clearTabTimer();
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (!destroyed && restoreFocus && button.isConnected) button.focus({ preventScroll: true });
  }

  function open(focus = 'selected') {
    if (destroyed || button.disabled) return;
    clearTabTimer();
    onOpen();
    if (destroyed) return;
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const available = optionButtons();
    const target = focus === 'last' ? available.at(-1) : focus === 'first' ? available[0] : selectedButton() || available[0];
    target?.focus({ preventScroll: true });
  }

  function select(option) {
    if (destroyed || !option || option.disabled || !list.contains(option)) return;
    const nextValue = option.dataset.value;
    close({ restoreFocus: true });
    onChange(nextValue);
  }

  function setOptions(nextOptions) {
    if (destroyed) return;
    const focused = list.contains(document.activeElement) ? document.activeElement?.dataset.value : undefined;
    choices = (nextOptions || []).map(option => ({
      value: String(option.value), label: String(option.label),
      description: String(option.description || ''), disabled: Boolean(option.disabled),
    }));
    list.replaceChildren(...choices.map(item => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'ui-select-option';
      option.dataset.value = item.value;
      option.setAttribute('role', 'option');
      option.tabIndex = -1;
      option.disabled = item.disabled;
      const name = document.createElement('span');
      name.className = 'ui-select-option-label';
      name.textContent = item.label;
      const note = document.createElement('small');
      note.className = 'ui-select-option-note';
      note.textContent = item.description;
      note.hidden = !item.description;
      const check = document.createElement('span');
      check.className = 'ui-select-option-check';
      check.setAttribute('aria-hidden', 'true');
      option.append(name, note, check);
      return option;
    }));
    syncValue();
    if (focused !== undefined && !list.hidden) {
      (optionButtons().find(option => option.dataset.value === focused) || selectedButton() || optionButtons()[0] || button).focus({ preventScroll: true });
    }
  }

  bind(button, 'click', event => {
    event.stopPropagation();
    if (list.hidden) open();
    else close({ restoreFocus: true });
  });
  bind(button, 'keydown', event => {
    if (event.key === 'Escape' && !list.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true });
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    open(event.key === 'ArrowUp' || event.key === 'End' ? 'last' : event.key === 'Home' ? 'first' : 'selected');
  });
  bind(list, 'click', event => select(event.target?.closest?.('[role="option"]')));
  bind(list, 'keydown', event => {
    // 与原生 select 一样拥有列表内按键；Tab仍交给外层焦点陷阱和浏览器。
    if (event.key !== 'Tab') event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true });
      return;
    }
    if (event.key === 'Tab') {
      // 保留原生 Tab 落点，再关闭；同步隐藏当前焦点会使浏览器从 body 重排 Tab。
      clearTabTimer();
      tabTimer = setTimeout(() => close(), 0);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      select(event.target?.closest?.('[role="option"]'));
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const available = optionButtons();
    if (!available.length) return;
    const current = Math.max(0, available.indexOf(document.activeElement));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length;
    available[next].focus({ preventScroll: true });
  });
  bindings.push(bindOutsideDismiss(() => list.hidden || destroyed ? [] : [list, button], () => close()));
  bind(document, 'visibilitychange', () => { if (document.hidden) close(); });
  setOptions(options);

  return {
    element, button, list, open, close, setOptions,
    setValue(nextValue) { if (!destroyed) { selectedValue = String(nextValue); syncValue(); } },
    setLabel(nextLabel) { if (!destroyed) { accessibleLabel = String(nextLabel); syncValue(); } },
    setTriggerLabel(nextLabel) { if (!destroyed) { customTriggerLabel = String(nextLabel || ''); syncValue(); } },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      close();
      for (const unbind of bindings) unbind();
    },
  };
}
