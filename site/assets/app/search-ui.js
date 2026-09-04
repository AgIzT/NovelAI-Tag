const searchUiActions = {
  addFilter: async () => true,
  removeFilter: async () => {},
  clearAll: async () => {},
  useExample: async () => {},
  openRelatedDirectory: async () => {},
  runStatusAction: async () => {},
};

const TEXT_OPERATORS = Object.freeze([
  { value: 'include', label: '包含' },
  { value: 'exclude', label: '排除' },
]);
const EXACT_OPERATORS = Object.freeze([{ value: 'include', label: '是' }]);

export const DEFAULT_SEARCH_FILTER_FIELDS = Object.freeze([
  { field: 'title', label: '标题', placeholder: '例如：蓝眼睛', operators: TEXT_OPERATORS },
  { field: 'prompt', label: '标签 / 正向提示词', placeholder: '例如：blue eyes', operators: TEXT_OPERATORS },
  { field: 'negative', label: '负面提示词', placeholder: '例如：lowres', operators: TEXT_OPERATORS },
  { field: 'note', label: '备注', placeholder: '输入备注文字', operators: TEXT_OPERATORS },
  { field: 'raw', label: '原始标签', placeholder: '输入原始 tag', operators: TEXT_OPERATORS },
  { field: 'author', label: '作者', placeholder: '输入作者名称', operators: TEXT_OPERATORS },
  { field: 'codex', label: '法典', placeholder: '输入法典名称', operators: TEXT_OPERATORS },
  {
    field: 'type', label: '类型', operators: EXACT_OPERATORS,
    values: [
      { value: 'codex', label: '法典' },
      { value: 'string', label: '画风' },
      { value: 'composition', label: '构图 / 服装 / 场景' },
      { value: 'pack', label: '图包' },
    ],
  },
  { field: 'path', label: '目录文字', placeholder: '例如：服装', operators: TEXT_OPERATORS },
  { field: 'directory', label: '精确目录', operators: EXACT_OPERATORS, values: [], requiresOptions: true },
  {
    field: 'has', label: '图片', operators: EXACT_OPERATORS,
    values: [{ value: 'image', label: '有图片' }, { value: 'noimage', label: '无图片' }],
  },
  {
    field: 'fav', label: '收藏', operators: EXACT_OPERATORS,
    values: [{ value: 'true', label: '已收藏' }, { value: 'false', label: '未收藏' }],
  },
]);

let setupDone = false;
let fieldDefinitions = normalizeFields(DEFAULT_SEARCH_FILTER_FIELDS);
let renderedFilters = [];
let renderedDirectories = [];
let renderedFieldsSource = null;
let renderedDirectoryOptions = null;
let renderedStatusActions = [];
let builderComposing = false;
let pendingFilterFocusIndex = null;

const el = id => document.getElementById(id);

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeChoice(choice) {
  if (typeof choice === 'string') return { value: choice, label: choice };
  return {
    ...choice,
    value: clean(choice?.value),
    label: clean(choice?.label || choice?.value),
  };
}

function normalizeFields(fields) {
  return (Array.isArray(fields) ? fields : [])
    .map(definition => ({
      ...definition,
      field: clean(definition?.field || definition?.id),
      label: clean(definition?.label || definition?.field || definition?.id),
      placeholder: clean(definition?.placeholder || '输入筛选内容'),
      operators: (definition?.operators?.length ? definition.operators : TEXT_OPERATORS).map(normalizeChoice),
      values: Array.isArray(definition?.values) ? definition.values.map(normalizeChoice) : [],
    }))
    .filter(definition => definition.field);
}

function directoryChoices(items) {
  return (Array.isArray(items) ? items : []).map(item => {
    const path = clean(item.label || item.breadcrumb || item.name || item.value || item.pathCode);
    const codex = clean(item.codexTitle);
    return {
      value: clean(item.value || item.label || item.name || item.pathCode),
      label: codex && !path.startsWith(codex) ? `${codex} · ${path}` : path,
      codexId: clean(item.codexId),
      pathCode: clean(item.pathCode),
    };
  }).filter(item => item.value && item.label && item.codexId && item.pathCode);
}

function replaceOptions(select, options, preferredValue = '') {
  if (!select) return;
  select.replaceChildren();
  for (const choice of options) {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    option.disabled = Boolean(choice.disabled);
    if (choice.codexId) option.dataset.codexId = choice.codexId;
    if (choice.pathCode) option.dataset.pathCode = choice.pathCode;
    select.append(option);
  }
  const preferred = [...select.options].find(option => option.value === preferredValue && !option.disabled);
  const fallback = [...select.options].find(option => !option.disabled);
  if (preferred) select.value = preferred.value;
  else if (fallback) select.value = fallback.value;
}

function activeFieldDefinition() {
  const field = clean(el('searchFilterField')?.value);
  return fieldDefinitions.find(definition => definition.field === field) || fieldDefinitions[0];
}

function updateBuilderValueControl() {
  const definition = activeFieldDefinition();
  const operator = el('searchFilterOperator');
  const input = el('searchFilterValue');
  const select = el('searchFilterValueSelect');
  if (!definition || !operator || !input || !select) return;

  replaceOptions(operator, definition.operators, operator.value);
  const usesChoices = Boolean(definition.values.length);
  input.hidden = usesChoices;
  select.hidden = !usesChoices;
  input.required = !usesChoices;
  select.required = usesChoices;
  input.placeholder = definition.placeholder;
  if (usesChoices) replaceOptions(select, definition.values, select.value);
  input.removeAttribute('aria-invalid');
  select.removeAttribute('aria-invalid');
}

function renderBuilderFields() {
  const field = el('searchFilterField');
  if (!field) return;
  const previous = field.value;
  replaceOptions(field, fieldDefinitions.map(definition => ({
    value: definition.field,
    label: definition.label,
    disabled: Boolean(definition.requiresOptions && !definition.values.length),
  })), previous);
  updateBuilderValueControl();
}

function panelIsOpen() {
  const panel = el('searchFilterPanel');
  return Boolean(panel && !panel.hidden);
}

export function setSearchUiActions(actions = {}) {
  Object.assign(searchUiActions, actions);
}

export function openSearchFilterPanel({ focus = true } = {}) {
  const panel = el('searchFilterPanel');
  const trigger = el('searchFilterBtn');
  if (!panel || !trigger) return;
  panel.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  document.body.classList.add('search-filters-open');
  document.body.classList.remove('tb-hidden');
  if (focus) requestAnimationFrame(() => el('searchFilterField')?.focus({ preventScroll: true }));
}

export function closeSearchFilterPanel({ restoreFocus = false } = {}) {
  const panel = el('searchFilterPanel');
  const trigger = el('searchFilterBtn');
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  trigger?.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('search-filters-open');
  if (restoreFocus) trigger?.focus({ preventScroll: true });
}

function filterLabel(filter) {
  if (clean(filter?.label)) return clean(filter.label);
  const definition = fieldDefinitions.find(item => item.field === filter?.field);
  const field = definition?.label || clean(filter?.field) || '条件';
  const choice = filter?.field === 'directory'
    ? definition?.values?.find(item => item.codexId === filter?.codexId && item.pathCode === filter?.pathCode)
    : definition?.values?.find(item => item.value === clean(filter?.value));
  let fallbackValue = filter?.value;
  if (filter?.field === 'has' && typeof filter?.value === 'boolean') fallbackValue = filter.value ? '有图片' : '无图片';
  if (filter?.field === 'fav' && typeof filter?.value === 'boolean') fallbackValue = filter.value ? '已收藏' : '未收藏';
  if (filter?.field === 'directory' && !choice) fallbackValue = [filter?.codexId, filter?.pathCode].filter(Boolean).join(' · ');
  const value = clean(filter?.valueLabel || choice?.label || fallbackValue);
  const operator = filter?.op === 'exclude' ? '排除' : (definition?.operators?.length > 1 ? '包含' : '为');
  return `${field} ${operator}${value ? ` ${value}` : ''}`;
}

function updateFilterCount(count) {
  const trigger = el('searchFilterBtn');
  const badge = el('searchFilterCount');
  if (!trigger || !badge) return;
  const value = Math.max(0, Number.isFinite(Number(count)) ? Number(count) : 0);
  badge.textContent = value > 99 ? '99+' : String(value);
  badge.hidden = value === 0;
  trigger.classList.toggle('has-filters', value > 0);
  trigger.setAttribute('aria-label', value ? `筛选，已启用 ${value} 个条件` : '筛选搜索结果');
}

function renderFilterChips(filters, hasActiveSearch) {
  const summary = el('searchFilterSummary');
  const chips = el('searchFilterChips');
  const clear = el('searchClearAllBtn');
  const panelClear = el('searchFilterClearAll');
  if (!summary || !chips) return;
  chips.replaceChildren();
  filters.forEach((filter, index) => {
    const chip = document.createElement('span');
    chip.className = `search-filter-chip${filter?.invalid || filter?.issue ? ' is-error' : ''}`;
    chip.setAttribute('role', 'listitem');

    const label = document.createElement('span');
    label.className = 'search-filter-chip-label';
    label.textContent = filterLabel(filter);
    chip.append(label);

    const remove = document.createElement('button');
    remove.className = 'search-filter-chip-remove';
    remove.type = 'button';
    remove.dataset.searchFilterIndex = String(index);
    remove.setAttribute('aria-label', `移除筛选：${label.textContent}`);
    remove.title = `移除筛选：${label.textContent}`;
    remove.textContent = '×';
    chip.append(remove);
    chips.append(chip);
  });
  summary.hidden = !hasActiveSearch;
  if (clear) clear.hidden = !hasActiveSearch;
  if (panelClear) panelClear.disabled = !hasActiveSearch;
  if (pendingFilterFocusIndex !== null) {
    const focusIndex = pendingFilterFocusIndex;
    pendingFilterFocusIndex = null;
    focusFilterAfterRemoval(focusIndex);
  }
}

function focusFilterAfterRemoval(index) {
  requestAnimationFrame(() => {
    const restore = () => {
      const buttons = [...document.querySelectorAll('#searchFilterChips [data-search-filter-index]')];
      const next = buttons[Math.min(index, Math.max(0, buttons.length - 1))];
      const clear = el('searchClearAllBtn');
      const fallback = clear && !clear.hidden ? clear : el('searchFilterBtn');
      (next || fallback)?.focus({ preventScroll: true });
    };
    restore();
    // 清除最后一个条件可能触发 history.back()；路由恢复会晚于本轮渲染重置焦点。
    // 只在焦点落回页面根节点时补一次，不覆盖用户随后主动移动的焦点。
    setTimeout(() => {
      if (!document.activeElement || document.activeElement === document.body || document.activeElement === document.documentElement) restore();
    }, 250);
  });
}

function renderFilterIssues(issues) {
  const feedback = el('searchFilterFeedback');
  if (!feedback) return;
  feedback.textContent = (Array.isArray(issues) ? issues : [])
    .map(issue => clean(issue?.message || issue))
    .filter(Boolean)
    .join('；');
}

export function renderSearchFilters({
  filters = [],
  issues = [],
  activeCount,
  hasActiveSearch,
  fields,
  directoryOptions,
} = {}) {
  const fieldsChanged = Boolean(fields && fields !== renderedFieldsSource);
  const directoriesChanged = Boolean(directoryOptions && directoryOptions !== renderedDirectoryOptions);
  if (fieldsChanged || directoriesChanged) {
    const source = normalizeFields(fields || fieldDefinitions);
    const directories = directoryOptions ? directoryChoices(directoryOptions) : null;
    fieldDefinitions = source.map(definition => definition.field === 'directory' && directories
      ? { ...definition, values: directories }
      : definition);
    if (fields) renderedFieldsSource = fields;
    if (directoryOptions) renderedDirectoryOptions = directoryOptions;
    renderBuilderFields();
  }
  renderedFilters = Array.isArray(filters) ? [...filters] : [];
  const active = hasActiveSearch === undefined ? Boolean(renderedFilters.length) : Boolean(hasActiveSearch);
  const count = activeCount === undefined ? renderedFilters.length : activeCount;
  updateFilterCount(count);
  renderFilterChips(renderedFilters, active);
  renderFilterIssues(issues);
}

export function renderSearchStatus(status = null) {
  const region = el('searchStatus');
  const live = el('searchStatusLive');
  const actions = el('searchStatusActions');
  if (!region || !live || !actions) return;
  const value = typeof status === 'string' ? { message: status } : status;
  const message = clean(value?.message);
  renderedStatusActions = Array.isArray(value?.actions) ? [...value.actions] : [];
  actions.replaceChildren();
  if (!message) {
    live.textContent = '';
    region.hidden = true;
    region.removeAttribute('data-kind');
    return;
  }
  const detail = clean(value?.detail);
  live.textContent = detail ? `${message} ${detail}` : message;
  region.dataset.kind = ['error', 'empty', 'info'].includes(value?.kind) ? value.kind : 'info';
  renderedStatusActions.forEach((action, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.searchStatusIndex = String(index);
    button.dataset.primary = action?.primary ? 'true' : 'false';
    button.textContent = clean(action?.label || action?.id || '继续');
    actions.append(button);
  });
  region.hidden = false;
}

function relatedBreadcrumb(item) {
  const path = Array.isArray(item?.path) ? item.path.map(clean).filter(Boolean).join(' / ') : clean(item?.breadcrumb || item?.pathLabel);
  const codex = clean(item?.codexTitle || item?.sourceTitle);
  if (!codex) return path;
  return path ? `${codex} · ${path}` : codex;
}

export function renderRelatedDirectories(items = [], { totalCount } = {}) {
  const region = el('searchRelatedDirectories');
  const list = el('searchRelatedList');
  const count = el('searchRelatedCount');
  if (!region || !list || !count) return;
  const allItems = Array.isArray(items) ? items : [];
  renderedDirectories = allItems.slice(0, 5);
  list.replaceChildren();
  if (!renderedDirectories.length) {
    count.textContent = '';
    region.hidden = true;
    return;
  }
  const total = Math.max(renderedDirectories.length, Number(totalCount) || allItems.length);
  count.textContent = total > renderedDirectories.length
    ? `共 ${total} 项，显示前 ${renderedDirectories.length} 项`
    : `共 ${total} 项`;
  renderedDirectories.forEach((item, index) => {
    const row = document.createElement('li');
    const copy = document.createElement('div');
    copy.className = 'search-related-copy';

    const name = document.createElement('strong');
    name.className = 'search-related-name';
    name.textContent = clean(item?.name || item?.title || item?.label || '未命名目录');
    copy.append(name);

    const breadcrumb = relatedBreadcrumb(item);
    const entryCount = Number(item?.count);
    if (breadcrumb || Number.isFinite(entryCount)) {
      const path = document.createElement('span');
      path.className = 'search-related-path';
      path.textContent = [breadcrumb, Number.isFinite(entryCount) ? `${entryCount} 个词条` : ''].filter(Boolean).join(' · ');
      copy.append(path);
    }
    row.append(copy);

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'search-related-open';
    open.dataset.relatedDirectoryIndex = String(index);
    open.textContent = '查看目录全部';
    open.setAttribute('aria-label', `查看目录全部：${name.textContent}`);
    row.append(open);
    list.append(row);
  });
  region.hidden = false;
}

function builderPayload() {
  const field = el('searchFilterField');
  const operator = el('searchFilterOperator');
  const input = el('searchFilterValue');
  const select = el('searchFilterValueSelect');
  const usesChoices = Boolean(select && !select.hidden);
  const valueControl = usesChoices ? select : input;
  const value = clean(valueControl?.value);
  if (!field || !operator || !valueControl || !value) {
    valueControl?.setAttribute('aria-invalid', 'true');
    el('searchFilterFeedback').textContent = '请先填写筛选值。';
    valueControl?.focus();
    return null;
  }
  valueControl.removeAttribute('aria-invalid');
  const payload = { field: field.value, op: operator.value, value };
  if (usesChoices) {
    const option = select.selectedOptions[0];
    if (option?.dataset.codexId) payload.codexId = option.dataset.codexId;
    if (option?.dataset.pathCode) payload.pathCode = option.dataset.pathCode;
  }
  return payload;
}

async function submitBuilder(event) {
  event.preventDefault();
  if (builderComposing) return;
  const payload = builderPayload();
  if (!payload) return;
  const add = el('searchFilterAdd');
  if (add) add.disabled = true;
  el('searchFilterFeedback').textContent = '';
  try {
    const accepted = await searchUiActions.addFilter(payload);
    if (accepted !== false && !el('searchFilterValue')?.hidden) el('searchFilterValue').value = '';
  } catch (error) {
    el('searchFilterFeedback').textContent = clean(error?.message) || '暂时无法添加这个条件。';
  } finally {
    if (add) add.disabled = false;
  }
}

export function setupSearchUi() {
  if (setupDone) return;
  const panel = el('searchFilterPanel');
  const trigger = el('searchFilterBtn');
  const form = el('searchFilterForm');
  if (!panel || !trigger || !form) return;
  setupDone = true;
  renderBuilderFields();
  updateFilterCount(0);

  trigger.addEventListener('click', () => {
    if (panelIsOpen()) closeSearchFilterPanel({ restoreFocus: true });
    else openSearchFilterPanel();
  });
  el('searchFilterClose')?.addEventListener('click', () => closeSearchFilterPanel({ restoreFocus: true }));
  el('searchExit')?.addEventListener('click', () => closeSearchFilterPanel(), { capture: true });
  el('searchFilterField')?.addEventListener('change', updateBuilderValueControl);
  const builderInput = el('searchFilterValue');
  builderInput?.addEventListener('compositionstart', () => { builderComposing = true; });
  builderInput?.addEventListener('compositionend', () => { builderComposing = false; });
  builderInput?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (builderComposing || event.isComposing || event.keyCode === 229)) {
      event.preventDefault();
    }
  });
  form.addEventListener('submit', event => { void submitBuilder(event); });

  panel.addEventListener('click', event => {
    const example = event.target.closest?.('[data-search-example]');
    if (!example || !panel.contains(example)) return;
    const query = clean(example.dataset.searchExample);
    void Promise.resolve(searchUiActions.useExample(query)).then(() => {
      closeSearchFilterPanel();
      el('search')?.focus({ preventScroll: true });
    });
  });

  const clearAll = () => { void searchUiActions.clearAll(); };
  el('searchFilterClearAll')?.addEventListener('click', clearAll);
  el('searchClearAllBtn')?.addEventListener('click', clearAll);

  el('searchFilterChips')?.addEventListener('click', event => {
    const remove = event.target.closest?.('[data-search-filter-index]');
    if (!remove) return;
    const index = Number(remove.dataset.searchFilterIndex);
    const filter = renderedFilters[index];
    if (!filter) return;
    // 先把焦点交给不会随结果重绘销毁的触发按钮；下一轮渲染再优先落到相邻 chip。
    el('searchFilterBtn')?.focus({ preventScroll: true });
    pendingFilterFocusIndex = index;
    void Promise.resolve(searchUiActions.removeFilter(filter, index)).catch(error => {
      pendingFilterFocusIndex = null;
      el('searchFilterFeedback').textContent = clean(error?.message) || '暂时无法移除这个条件。';
    });
  });

  el('searchRelatedList')?.addEventListener('click', event => {
    const open = event.target.closest?.('[data-related-directory-index]');
    if (!open) return;
    const item = renderedDirectories[Number(open.dataset.relatedDirectoryIndex)];
    if (item) void searchUiActions.openRelatedDirectory(item);
  });

  el('searchStatusActions')?.addEventListener('click', event => {
    const button = event.target.closest?.('[data-search-status-index]');
    if (!button) return;
    const action = renderedStatusActions[Number(button.dataset.searchStatusIndex)];
    if (action) void searchUiActions.runStatusAction(action);
  });

  document.addEventListener('pointerdown', event => {
    if (!panelIsOpen() || panel.contains(event.target) || trigger.contains(event.target)) return;
    closeSearchFilterPanel();
  });
  panel.addEventListener('focusout', () => {
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (panelIsOpen() && !panel.contains(focused) && !trigger.contains(focused)) closeSearchFilterPanel();
    });
  });
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !panelIsOpen()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeSearchFilterPanel({ restoreFocus: true });
  }, { capture: true });
}
