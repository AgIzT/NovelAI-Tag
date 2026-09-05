import { animateUi, cancelUiMotion } from './ui-motion.js';

const searchUiActions = {
  addFilter: async () => true,
  removeFilter: async () => {},
  removeQueryTerm: async () => {},
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
let renderedChipRecords = [];
const pendingFilterRemovalChips = new Set();

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
  const previousControl = select.hidden ? input : select;
  const usesChoices = Boolean(definition.values.length);
  input.hidden = usesChoices;
  select.hidden = !usesChoices;
  input.required = !usesChoices;
  select.required = usesChoices;
  input.placeholder = definition.placeholder;
  if (usesChoices) replaceOptions(select, definition.values, select.value);
  input.removeAttribute('aria-invalid');
  select.removeAttribute('aria-invalid');
  const nextControl = usesChoices ? select : input;
  if (previousControl !== nextControl && panelIsOpen()) {
    cancelUiMotion(previousControl);
    animateUi(nextControl, [{ opacity: 0, translate: '0 4px' }, { opacity: 1, translate: '0 0' }]);
  }
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
  panel.inert = false;
  trigger.setAttribute('aria-expanded', 'true');
  document.body.classList.add('search-filters-open');
  document.body.classList.remove('tb-hidden');
  if (focus) requestAnimationFrame(() => {
    if (!panel.hidden) el('searchFilterField')?.focus({ preventScroll: true });
  });
}

export function closeSearchFilterPanel({ restoreFocus = false } = {}) {
  const panel = el('searchFilterPanel');
  const trigger = el('searchFilterBtn');
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  panel.inert = true;
  trigger?.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('search-filters-open');
  if (restoreFocus) trigger?.focus({ preventScroll: true });
}

function filterLabel(filter) {
  if (clean(filter?.label)) return clean(filter.label);
  const definition = fieldDefinitions.find(item => item.field === filter?.field);
  const field = definition?.label || (filter?.field === 'default' ? '关键词' : clean(filter?.field)) || '条件';
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
  const text = value > 99 ? '99+' : String(value);
  const changed = badge.hidden || badge.textContent !== text;
  badge.textContent = text;
  badge.hidden = value === 0;
  if (!value) cancelUiMotion(badge);
  else if (changed) animateUi(badge, [{ opacity: .4, scale: '.8' }, { opacity: 1, scale: '1' }]);
  trigger.classList.toggle('has-filters', value > 0);
  trigger.setAttribute('aria-label', value ? `筛选，已启用 ${value} 个条件` : '筛选搜索结果');
}

function chipKey(filter) {
  return JSON.stringify(filter.queryValue === undefined
    ? ['filter', filter.field, filter.op, filter.value, filter.codexId, filter.pathCode]
    : ['query', filter.queryValue]);
}

function createFilterChip() {
  const chip = document.createElement('span');
  chip.className = 'search-filter-chip';
  chip.setAttribute('role', 'listitem');
  const label = document.createElement('span');
  label.className = 'search-filter-chip-label';
  const remove = document.createElement('button');
  remove.className = 'search-filter-chip-remove';
  remove.type = 'button';
  const icon = document.createElement('span');
  icon.className = 'search-filter-chip-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '×';
  remove.append(label, icon);
  chip.append(remove);
  return chip;
}

function leaveFilterChip(chip, snapshot) {
  pendingFilterRemovalChips.delete(chip);
  cancelUiMotion(chip);
  if (!snapshot?.rect.width || !snapshot.rect.height) {
    chip.remove();
    return;
  }
  // 退场离开文档流；搜索和最后一个条件的占位立即更新，残影不参与焦点或点击。
  const { rect, opacity } = snapshot;
  chip.inert = true;
  chip.setAttribute('aria-hidden', 'true');
  chip.removeAttribute('role');
  chip.dataset.searchChipExit = '';
  const remove = chip.querySelector('button');
  delete remove.dataset.searchFilterIndex;
  remove.disabled = true;
  remove.tabIndex = -1;
  Object.assign(chip.style, {
    position: 'absolute', left: `${rect.left + window.scrollX}px`, top: `${rect.top + window.scrollY}px`,
    width: `${rect.width}px`, height: `${rect.height}px`, maxWidth: 'none', margin: '0',
    boxSizing: 'border-box', pointerEvents: 'none', zIndex: '20',
  });
  document.body.append(chip);
  const animation = animateUi(chip, [
    { opacity, translate: '0 0', scale: '1' },
    { opacity: 0, translate: '0 -4px', scale: '.97' },
  ], { duration: 160 });
  if (!animation) {
    chip.remove();
    return;
  }
  let removed = false;
  let timer;
  const finish = () => {
    if (removed) return;
    removed = true;
    clearTimeout(timer);
    cancelUiMotion(chip);
    chip.remove();
  };
  // 隐藏标签页的动画时间轴可能暂停，仍保证短暂残影被回收。
  timer = setTimeout(finish, 240);
  animation.finished.then(finish, finish);
}

function renderFilterChips(filters, hasActiveSearch) {
  const summary = el('searchFilterSummary');
  const chips = el('searchFilterChips');
  const clear = el('searchClearAllBtn');
  const panelClear = el('searchFilterClearAll');
  if (!summary || !chips) return;
  const keys = filters.map(chipKey);
  const labels = filters.map(filterLabel);
  const changed = filters.length !== renderedChipRecords.length || filters.some((filter, index) => {
    const previous = renderedChipRecords[index];
    return previous?.key !== keys[index]
      || previous.chip.firstElementChild.firstElementChild.textContent !== labels[index]
      || previous.chip.classList.contains('is-error') !== Boolean(filter?.invalid || filter?.issue);
  });
  if (changed) {
    // 只在条件变化时测量；同一次搜索的重复渲染复用节点，不重播、不吞第一次点击。
    const snapshots = new Map(renderedChipRecords.map(({ chip }) => [chip, {
      rect: chip.getBoundingClientRect(), opacity: Number(getComputedStyle(chip).opacity),
    }]));
    const available = new Map();
    for (const record of renderedChipRecords) {
      const group = available.get(record.key) || [];
      group.push(record);
      available.set(record.key, group);
      cancelUiMotion(record.chip);
    }
    const counts = new Map();
    keys.forEach(key => counts.set(key, (counts.get(key) || 0) + 1));
    for (const [key, group] of available) {
      let removedCount = group.length - (counts.get(key) || 0);
      // 重复条件删除时，优先让用户实际点中的节点退场。
      available.set(key, group.filter(record => {
        if (removedCount > 0 && pendingFilterRemovalChips.has(record.chip)) {
          removedCount -= 1;
          return false;
        }
        return true;
      }));
    }
    const nextRecords = filters.map((filter, index) => {
      const record = available.get(keys[index])?.shift() || { key: keys[index], chip: createFilterChip() };
      const { chip } = record;
      const remove = chip.firstElementChild;
      const label = remove.firstElementChild;
      chip.classList.toggle('is-error', Boolean(filter?.invalid || filter?.issue));
      if (label.textContent !== labels[index]) label.textContent = labels[index];
      remove.dataset.searchFilterIndex = String(index);
      remove.setAttribute('aria-label', `移除筛选：${labels[index]}`);
      remove.title = `移除筛选：${labels[index]}`;
      return record;
    });
    const retained = new Set(nextRecords.map(record => record.chip));
    for (const { chip } of renderedChipRecords) {
      if (!retained.has(chip)) leaveFilterChip(chip, snapshots.get(chip));
    }
    nextRecords.forEach(({ chip }, index) => {
      if (chips.children[index] !== chip) chips.insertBefore(chip, chips.children[index] || null);
    });
    renderedChipRecords = nextRecords;
    summary.hidden = filters.length === 0;
    // 批量读取最终布局，再用独立 translate 做 FLIP，不碰瀑布流定位或结果提交时序。
    const positions = nextRecords.map(({ chip }) => chip.getBoundingClientRect());
    nextRecords.forEach(({ chip }, index) => {
      const previous = snapshots.get(chip);
      if (!previous) {
        animateUi(chip, [{ opacity: 0, translate: '0 5px' }, { opacity: 1, translate: '0 0' }]);
        return;
      }
      const x = previous.rect.left - positions[index].left;
      const y = previous.rect.top - positions[index].top;
      if (Math.abs(x) > .5 || Math.abs(y) > .5 || previous.opacity < .99) {
        animateUi(chip, [
          { opacity: previous.opacity, translate: `${x}px ${y}px` },
          { opacity: 1, translate: '0 0' },
        ]);
      }
    });
  }
  summary.hidden = filters.length === 0;
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

function setFilterFeedback(message) {
  const feedback = el('searchFilterFeedback');
  if (!feedback || feedback.textContent === message) return;
  cancelUiMotion(feedback);
  feedback.textContent = message;
  if (message && panelIsOpen()) {
    animateUi(feedback, [{ opacity: 0, translate: '0 3px' }, { opacity: 1, translate: '0 0' }]);
  }
}

function renderFilterIssues(issues) {
  setFilterFeedback((Array.isArray(issues) ? issues : [])
    .map(issue => clean(issue?.message || issue))
    .filter(Boolean)
    .join('；'));
}

export function renderSearchFilters({
  filters = [],
  queryConditions = [],
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
  const terms = (Array.isArray(queryConditions) ? queryConditions : []).map(condition => ({
    queryValue: condition.value,
    label: `${condition.quoted ? '完整短语' : '关键词'} ${condition.label}`,
  }));
  renderedFilters = [
    ...terms,
    ...(Array.isArray(filters) ? filters : []).map((filter, filterIndex) => ({ ...filter, filterIndex })),
  ];
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
    setFilterFeedback('填写筛选值');
    animateUi(valueControl, [{ opacity: .55, translate: '0 2px' }, { opacity: 1, translate: '0 0' }], { duration: 180 });
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
  setFilterFeedback('');
  try {
    const accepted = await searchUiActions.addFilter(payload);
    if (accepted !== false && !el('searchFilterValue')?.hidden) el('searchFilterValue').value = '';
  } catch (error) {
    setFilterFeedback(clean(error?.message) || '添加失败，请刷新后重试');
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
  panel.inert = panel.hidden;
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

  el('searchFilterChips')?.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.target.closest?.('[data-search-filter-index]')) return;
    // 默认抢焦点会先让输入框失焦并重画 chips，导致随后 click 丢失；在 click 内再显式交接焦点。
    event.preventDefault();
  });
  el('searchFilterChips')?.addEventListener('click', event => {
    const remove = event.target.closest?.('[data-search-filter-index]');
    const chip = remove?.closest('.search-filter-chip');
    if (!remove || pendingFilterRemovalChips.has(chip)) return;
    const index = Number(remove.dataset.searchFilterIndex);
    const filter = renderedFilters[index];
    if (!filter) return;
    // 先把焦点交给不会随结果重绘销毁的触发按钮；下一轮渲染再优先落到相邻 chip。
    el('searchFilterBtn')?.focus({ preventScroll: true });
    pendingFilterFocusIndex = index;
    pendingFilterRemovalChips.add(chip);
    const removeAction = filter.queryValue === undefined
      ? searchUiActions.removeFilter(filter, filter.filterIndex)
      : searchUiActions.removeQueryTerm(filter.queryValue);
    void Promise.resolve(removeAction).catch(error => {
      pendingFilterFocusIndex = null;
      setFilterFeedback(clean(error?.message) || '移除失败，请刷新后重试');
    }).finally(() => pendingFilterRemovalChips.delete(chip));
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
