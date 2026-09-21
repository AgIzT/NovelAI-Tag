/* 方案持久化由 store 单写；每个方案的本地草稿独立保留，冲突不覆盖输入。 */
import { copyText } from './copy.js';
import { dismissToast, toast } from './feedback.js';
import { state } from './state.js';
import { isTagZhEnabled, loadTagZh, lookupLoadedTagZh, onTagZhChange } from './tag-zh.js';
import { createRelayEditor } from './tag-relay-editor.js';
import { snapshotLocked } from './tag-relay-snapshot.js';
import { foldRanges, tokens } from './tag-relay-text.js';
import { clearCopyHistory, compilePlanChannel, copyPlan, createPlan, deletePlan, getActivePlan, getPlan,
  planFolds, planForSession, recordCopyHistory, renamePlan, replacePlanText, restoreHistoryAsPlan, setActivePlan } from './tag-relay-v4.js';
import { commitRelay, getRelayStorageIssue, initializeRelay, relayState, subscribeRelay } from './tag-relay-store.js';
import { cancelRelayAction, requestRelayAction } from './tag-relay-action.js';
import { setupRelayBackup } from './tag-relay-backup.js';
import { createSelectMenu } from './select-menu.js';

export const RELAY_SOURCE_MIME = 'application/x-relay-source';
let refs, editor, picker, ready;
let activeId = '', loading = false, outputFormat = 'nai', joinMode = 'comma';
let latest = { positive: '', negative: '' };
const drafts = new Map(), requestedZh = new Set();
const FORMAT_LABELS = { nai: 'NAI', sd: 'SD', plain: '纯文本' };
const JOIN_LABELS = { comma: '逗号', newline: '逗号换行' };
const element = (tag, className, text) => {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
function warmTranslations(codexId) {
  const id = String(codexId || '');
  if (requestedZh.has(id)) return;
  requestedZh.add(id); void loadTagZh(id).then(() => editor?.render());
}
function translate(token) {
  return isTagZhEnabled() ? lookupLoadedTagZh(token.name || token.core || '', [token.codexId, state.codex?.id])?.zh || '' : '';
}
function currentDraft() { return drafts.get(activeId); }
function draftFor(plan) {
  const existing = drafts.get(plan.id);
  if (existing && !existing.dirty && !existing.saving && existing.revision !== plan.revision) drafts.delete(plan.id);
  if (!drafts.has(plan.id)) drafts.set(plan.id, { plan: structuredClone(plan), revision: plan.revision,
    generation: 0, dirty: false, issue: '', saving: null, timer: 0 });
  return drafts.get(plan.id);
}
function openPlan(plan) {
  if (!plan) return;
  const draft = draftFor(plan);
  activeId = plan.id; loading = true;
  try { editor.loadPlan(draft.plan); } finally { loading = false; }
  for (const fold of planFolds(draft.plan)) if (!snapshotLocked(fold)) warmTranslations(fold.codexId);
  renderOutput(); renderManager(); renderSaveState();
}
function editorChanged(meta = {}) {
  if (refs && refs.lane.contains(refs.inlineAction)) cancelRelayAction();
  if (!editor || loading) return;
  if (meta.content !== false && currentDraft()) {
    const draft = currentDraft();
    draft.plan = planForSession(draft.plan, editor.getSnapshot(), { gc: false });
    draft.generation += 1; draft.dirty = true;
    clearTimeout(draft.timer);
    draft.timer = setTimeout(async () => { await saveDraft(draft); }, 160);
    renderSaveState();
  }
  renderOutput();
}
async function saveDraft(draft) {
  clearTimeout(draft.timer);
  if (draft.saving) return await draft.saving;
  if (!draft.dirty) return true;
  if (['conflict', 'missing-plan'].includes(draft.issue)) return false;
  draft.saving = (async () => {
    while (draft.dirty) {
      const generation = draft.generation, revision = draft.revision;
      const snapshot = structuredClone(draft.plan);
      const result = await commitRelay(next => replacePlanText(next, snapshot.id, snapshot, { expectedRevision: revision }),
        { changed: 'plan', planId: snapshot.id, revision });
      if (!result.ok) { draft.issue = result.reason; return false; }
      const saved = getPlan(relayState(), snapshot.id);
      draft.revision = saved.revision; draft.plan.revision = saved.revision;
      draft.issue = ''; draft.dirty = generation !== draft.generation;
    }
    return true;
  })();
  renderSaveState();
  try { return await draft.saving; }
  finally { draft.saving = null; renderSaveState(); }
}
export async function flushCompose() {
  return currentDraft() ? await saveDraft(currentDraft()) : true;
}
function renderSaveState() {
  if (!refs) return;
  const draft = currentDraft();
  refs.saveState.replaceChildren();
  const issue = draft?.issue || getRelayStorageIssue();
  /* 正常逐字保存不插入状态行，避免每次输入把正文与光标上下推移。 */
  refs.saveState.hidden = !issue;
  if (refs.saveState.hidden) return;
  refs.saveState.append(element('span', '', issue === 'conflict' || issue === 'missing-plan'
    ? '另一页面已更新方案，本页输入已保留' : issue ? '尚未保存，输入仍在本页' : '正在保存…'));
  const action = (label, run) => {
    const button = element('button', '', label); button.type = 'button'; button.onclick = run; refs.saveState.append(button);
  };
  if (!issue) return;
  if (!['conflict', 'missing-plan'].includes(issue)) action('重试保存', async () => {
    await initializeRelay(); if (draft) draft.issue = ''; await flushCompose(); renderSaveState();
  });
  action('另存副本', async () => {
    if (!draft) return;
    const snapshot = structuredClone(draft.plan);
    const result = await commitRelay(next => {
      const copy = createPlan(next, `${snapshot.name}（本页副本）`);
      return replacePlanText(next, copy.id, snapshot, { expectedRevision: copy.revision });
    }, { changed: 'plan' });
    if (result.ok) { drafts.delete(snapshot.id); openPlan(getActivePlan(relayState())); }
  });
  if (issue === 'conflict' || issue === 'missing-plan') action('载入已保存版本', async () => {
    if (!await requestRelayAction({ title: '放弃本页未保存输入？', message: '载入另一页面保存的版本。', confirmLabel: '载入', danger: true })) return;
    drafts.delete(activeId); openPlan(getPlan(relayState(), activeId) || getActivePlan(relayState()));
  });
}
function syncStoredState(_, meta = {}) {
  if (!editor) return;
  const draft = currentDraft(), stored = getPlan(relayState(), activeId);
  if (!draft) openPlan(getActivePlan(relayState()));
  else if (!draft.saving && (!stored || stored.revision !== draft.revision)) {
    if (draft.dirty) { draft.issue = stored ? 'conflict' : 'missing-plan'; renderSaveState(); }
    else { drafts.delete(activeId); openPlan(stored || getActivePlan(relayState())); }
  }
  renderManager(); renderHistory(); renderSaveState();
  if (meta.source !== 'local') renderOutput();
}
function renderManager() {
  if (!picker) return;
  const plans = relayState().plans;
  picker.setOptions(plans.map(plan => ({ value: plan.id, label: plan.name })));
  picker.setValue(activeId);
  refs.planSelect.replaceChildren(...plans.map(plan => {
    const option = element('option', '', plan.name); option.value = plan.id; return option;
  }));
  refs.planSelect.value = activeId;
}
async function switchPlan(id) {
  if (!await flushCompose()) { renderManager(); return; }
  const result = await commitRelay(next => setActivePlan(next, id), { changed: 'plan' });
  if (result.ok) openPlan(getPlan(relayState(), id));
}
export async function addSourceToPlan(entry, options = {}) {
  if (ready) await ready;
  if (!editor || !entry || snapshotLocked(entry)) { toast('该素材当前无法加入方案', '!'); return null; }
  if (entry.channel === 'character-negative') { toast('角色负向请复制到对应角色槽，不能加入全局负向', '!'); return null; }
  const result = editor.insertSource(entry, options);
  if (result) { warmTranslations(entry.codexId); await flushCompose(); }
  return result;
}
function mergedTotal(records = []) { return records.reduce((sum, item) => sum + item.dropped, 0); }
function mergedNote(node, label, records = []) {
  node.textContent = label;
  const total = mergedTotal(records); if (!total) return;
  const detail = records.map(record => record.token).slice(0, 6).join('、');
  const button = element('button', 'tag-relay-merged', `${label ? ' · ' : ''}已合并 ${total} 条重复`);
  button.type = 'button'; button.title = detail; button.onclick = () => toast(`已合并重复：${detail}`); node.append(button);
}
function livePlan() { return planForSession(currentDraft()?.plan || {}, editor.getSnapshot(), { gc: false }); }
function compiledChannel(channel) {
  return compilePlanChannel(livePlan(), channel, { dedupe: editor.getSession().dedupe, isLocked: snapshotLocked, target: outputFormat, joinMode });
}
export function renderComposeCounters() {
  if (!refs || !editor) return;
  const session = editor.getSession();
  refs.planStats.textContent = `${tokens(session.positive.text).length + tokens(session.negative.text).length} 项`;
}
function renderOutput() {
  if (!refs || !editor) return;
  const positive = compiledChannel('positive'), negative = compiledChannel('negative');
  latest = { positive: positive.text, negative: negative.text };
  refs.positiveOut.value = latest.positive; refs.negativeOut.value = latest.negative;
  mergedNote(refs.positiveMeta, `${positive.tokens.length} 段 · ${latest.positive.length} 字符`, positive.merged);
  mergedNote(refs.negativeMeta, `${negative.tokens.length} 段 · ${latest.negative.length} 字符`, negative.merged);
  refs.copyPositive.disabled = !latest.positive; refs.copyNegative.disabled = !latest.negative;
  refs.copyAll.disabled = !latest.positive && !latest.negative;
  refs.copyPositiveHint.textContent = latest.positive ? `${positive.tokens.length} 个正向 tag` : '还没有正向内容';
  refs.outputSummary.textContent = `${FORMAT_LABELS[outputFormat]} · ${JOIN_LABELS[joinMode]}`;
  refs.dedupe.checked = editor.getSession().dedupe;
  const merged = [...positive.merged, ...negative.merged];
  refs.outputNote.hidden = !mergedTotal(merged); mergedNote(refs.outputNote, '', merged);
  renderComposeCounters();
}
export function refreshComposeAccess() {
  dismissToast({ clear: true }); editor?.refreshAccess(); renderOutput(); renderHistory();
}
export function renderCompose() {
  if (!editor) return;
  warmTranslations(state.codex?.id); syncStoredState(); editor.render(); renderOutput();
}
function safeSnapshot(plan, channels) {
  const safe = structuredClone(plan);
  for (const channel of ['positive', 'negative']) {
    const value = safe[channel];
    if (!channels.includes(channel)) { safe[channel] = { text: '', folds: {} }; continue; }
    for (const token of tokens(value.text).reverse()) {
      if (foldRanges(token.core).some(range => snapshotLocked(value.folds[range.name]))) {
        value.text = value.text.slice(0, token.start) + value.text.slice(token.end);
      }
    }
    const names = new Set(foldRanges(value.text).map(range => range.name));
    value.folds = Object.fromEntries(Object.entries(value.folds).filter(([name]) => names.has(name)));
  }
  return safe;
}
async function copyOutput(channel, trigger) {
  if (!await flushCompose()) return;
  renderOutput();
  const channels = channel === 'both' ? ['positive', 'negative'] : [channel];
  const text = channel === 'both' ? [latest.positive, latest.negative && `Negative:\n${latest.negative}`].filter(Boolean).join('\n\n') : latest[channel];
  if (!text) return;
  const plan = safeSnapshot(livePlan(), channels), sources = planFolds(plan);
  const label = channel === 'both' ? '全部提示词' : channel === 'positive' ? '正向提示词' : '负向';
  const output = { positive: channels.includes('positive') ? latest.positive : '', negative: channels.includes('negative') ? latest.negative : '' };
  const copied = await copyText(text, `已复制${label}`, trigger, { convert: false, sampleLabel: `已复制${label}`,
    accessGuard: () => sources.every(fold => !snapshotLocked(fold)), onAccessBlocked: () => toast('方案中有内容已因权限变化锁定', '!') });
  if (copied?.ok && sources.every(fold => !snapshotLocked(fold))) {
    await commitRelay(next => recordCopyHistory(next, { plan, output, target: outputFormat, joinMode, channel }), { changed: 'history' });
  }
}
function historyLocked(record) { return !record.snapshotComplete || planFolds(record.plan).some(snapshotLocked); }
function historyText(record) {
  return record.channel === 'positive' ? record.positive : record.channel === 'negative' ? record.negative
    : [record.positive, record.negative && `Negative:\n${record.negative}`].filter(Boolean).join('\n\n');
}
function renderHistory() {
  if (!refs) return;
  const history = relayState().history;
  refs.historyStatus.textContent = history.length ? String(history.length) : '';
  refs.historyList.replaceChildren(); refs.historyClear.disabled = !history.length;
  if (refs.history.hidden) return;
  if (!history.length) { refs.historyList.append(element('p', 'tag-relay-history-empty', '还没有成品记录')); return; }
  for (const record of history) {
    const card = element('article', 'tag-relay-history-card'), locked = historyLocked(record);
    card.dataset.historyId = record.id;
    card.append(element('b', '', locked ? record.snapshotComplete ? '内容已锁定' : '记录缺少完整快照' : record.label));
    if (locked) { card.append(element('p', 'tag-relay-history-locked', record.snapshotComplete
      ? '当前权限下不可查看、复制或恢复' : '无法核验原内容，不能查看、复制或恢复')); refs.historyList.append(card); continue; }
    card.append(element('p', '', historyText(record)));
    const actions = element('div', 'tag-relay-history-actions');
    const copy = element('button', '', '再次复制'); copy.type = 'button';
    copy.onclick = async () => {
      if (historyLocked(record)) { refreshComposeAccess(); return; }
      await copyText(historyText(record), '已复制成品记录', copy, { convert: false,
        accessGuard: () => !historyLocked(record), onAccessBlocked: () => refreshComposeAccess() });
    };
    const restore = element('button', '', '恢复为新方案'); restore.type = 'button';
    restore.onclick = async () => {
      if (historyLocked(record) || !await flushCompose()) return;
      const result = await commitRelay(next => restoreHistoryAsPlan(next, record.id, { isLocked: snapshotLocked }), { changed: 'plan' });
    if (result.ok && result.result) {
      refs.history.hidden = true;
      refs.historyToggle.setAttribute('aria-expanded', 'false');
      openPlan(getActivePlan(relayState()));
    }
    };
    actions.append(copy, restore); card.append(actions); refs.historyList.append(card);
  }
}
function bindSegment(buttons, apply) {
  const select = button => {
    buttons.forEach(other => { const selected = other === button; other.setAttribute('aria-checked', String(selected)); other.tabIndex = selected ? 0 : -1; });
    const group = button.closest('.tag-relay-segment');
    group.style.setProperty('--seg-n', String(buttons.length)); group.style.setProperty('--seg-i', String(buttons.indexOf(button)));
    apply(button); renderOutput();
  };
  buttons.forEach((button, index) => {
    button.onclick = () => select(button);
    button.onkeydown = event => {
      const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
      const target = event.key === 'Home' ? buttons[0] : event.key === 'End' ? buttons.at(-1) : step ? buttons[(index + step + buttons.length) % buttons.length] : null;
      if (target) { event.preventDefault(); select(target); target.focus(); }
    };
  });
  select(buttons.find(button => button.getAttribute('aria-checked') === 'true') || buttons[0]);
}
function setupPlanActions(scope, q) {
  const menu = q('#relayPlanMenu'), trigger = q('#relayPlanMenuBtn');
  const close = () => { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); };
  const items = () => [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
  const open = (last = false) => {
    menu.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    (last ? items().at(-1) : items()[0])?.focus({ preventScroll: true });
  };
  trigger.onclick = () => { if (menu.hidden) open(); else close(); };
  trigger.onkeydown = event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); open(event.key === 'ArrowUp');
  };
  document.addEventListener('click', event => { if (!menu.contains(event.target) && event.target !== trigger) close(); });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); trigger.focus(); return; }
    if (event.key === 'Tab') { setTimeout(close, 0); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const list = items(); if (!list.length) return;
    event.preventDefault();
    const current = Math.max(0, list.indexOf(document.activeElement));
    const at = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
    list[at].focus({ preventScroll: true });
  });
  const run = (id, action) => { q(id).onclick = async () => { close(); if (await flushCompose()) await action(); }; };
  run('#relayNewPlan', async () => {
    const name = await requestRelayAction({ title: '新建方案', input: { label: '名称', value: '新方案' }, trigger });
    if (!name) return;
    const result = await commitRelay(next => createPlan(next, name), { changed: 'plan' });
    if (result.ok) openPlan(getActivePlan(relayState()));
  });
  run('#relayDuplicatePlan', async () => {
    const id = activeId; const result = await commitRelay(next => copyPlan(next, id), { changed: 'plan' });
    if (result.ok) openPlan(getActivePlan(relayState()));
  });
  run('#relayRenamePlan', async () => {
    const id = activeId, name = await requestRelayAction({ title: '重命名方案', input: { label: '名称', value: currentDraft().plan.name }, trigger });
    if (!name) return;
    const draft = drafts.get(id);
    if (!draft || !await saveDraft(draft)) return;
    /* 命名只更新元信息。等锁期间仍可输入，不能用已保存旧正文重建编辑器。 */
    draft.saving = (async () => {
      const result = await commitRelay(next => renamePlan(next, id, name),
        { changed: 'plan', planId: id, revision: draft.revision });
      if (!result.ok) { draft.issue = result.reason; return false; }
      const saved = getPlan(relayState(), id);
      draft.revision = saved.revision; draft.plan.revision = saved.revision; draft.plan.name = saved.name;
      return true;
    })();
    try { await draft.saving; }
    finally { draft.saving = null; }
    if (draft.dirty) await saveDraft(draft);
    renderManager(); renderSaveState();
  });
  run('#relayDeletePlan', async () => {
    const id = activeId;
    if (!await requestRelayAction({ title: '删除当前方案？', message: '删除后不能撤销。', confirmLabel: '删除', danger: true, trigger })) return;
    const result = await commitRelay(next => deletePlan(next, id), { changed: 'plan' });
    if (result.ok) { drafts.delete(id); openPlan(getActivePlan(relayState())); }
  });
  setupRelayBackup(scope, { beforeAction: flushCompose, afterRestore: () => openPlan(getActivePlan(relayState())) });
}
export function setupRelayCompose(root) {
  if (!root) return { render: () => {}, ready: Promise.resolve(), flush: async () => true };
  if (editor) return { render: renderCompose, ready, flush: flushCompose };
  const scope = root.closest('.tag-relay-rail') || root, q = selector => scope.querySelector(selector);
  refs = { lane: q('#relayPlanLane'), inlineAction: q('#relayInlineAction'),
    planStats: q('#relayPlanStats'), dedupe: q('#relayDedupe'), planSelect: q('#relayPlanSelect'),
    positiveOut: q('#relayPositiveOutput'), negativeOut: q('#relayNegativeOutput'), positiveMeta: q('#relayPositiveMeta'), negativeMeta: q('#relayNegativeMeta'),
    copyPositive: q('#relayCopyPositive'), copyNegative: q('#relayCopyNegative'), copyAll: q('#relayCopyAll'), copyPositiveHint: q('#relayCopyPositiveHint'),
    outputSummary: q('#relayOutputSummary'), outputNote: q('#relayOutputNote'), history: q('#relayCopyHistory'), historyList: q('#relayHistoryList'), historyToggle: q('#relayHistoryToggle'),
    historyStatus: q('#relayHistoryStatus'), historyClear: q('#relayHistoryClear'), saveState: element('div', 'relay-save-state') };
  refs.saveState.setAttribute('role', 'status'); q('#relayPlanLane').before(refs.saveState);
  editor = createRelayEditor({ root: q('#relayPlanLane'), onChange: editorChanged, isLocked: snapshotLocked, translate, onSourceDrop: addSourceToPlan,
    notify: (message, action) => toast(message, '', action),
    requestName: placement => requestRelayAction({ title: '折叠为词组', input: { label: '名称', value: '词组' }, confirmLabel: '折叠', toggle: true, ...placement }) });
  picker = createSelectMenu({ label: '当前方案', onChange: async id => { await switchPlan(id); } });
  picker.button.id = 'relayPlanPickerBtn'; picker.list.id = 'relayPlanList';
  picker.button.setAttribute('aria-controls', 'relayPlanList');
  q('#relayPlanPicker').append(picker.element);
  refs.planSelect.onchange = async () => { await switchPlan(refs.planSelect.value); };
  refs.dedupe.onchange = () => editor.setDedupe(refs.dedupe.checked);
  bindSegment([...scope.querySelectorAll('[data-format]')], button => { outputFormat = button.dataset.format; });
  bindSegment([...scope.querySelectorAll('[data-join]')], button => { joinMode = button.dataset.join; });
  q('#relayOutputToggle').onclick = event => {
    const button = event.currentTarget, open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open)); q('#relayOutputBoxes').hidden = !open;
  };
  q('#relayHistoryToggle').onclick = () => { refs.history.hidden = !refs.history.hidden; q('#relayHistoryToggle').setAttribute('aria-expanded', String(!refs.history.hidden)); renderHistory(); };
  q('#relayHistoryClose').onclick = () => { refs.history.hidden = true; q('#relayHistoryToggle').setAttribute('aria-expanded', 'false'); q('#relayHistoryToggle').focus(); renderHistory(); };
  refs.historyClear.onclick = async () => {
    if (await requestRelayAction({ title: '清空成品记录？', confirmLabel: '清空', danger: true })) await commitRelay(next => clearCopyHistory(next), { changed: 'history' });
  };
  refs.copyPositive.onclick = event => copyOutput('positive', event.currentTarget);
  refs.copyNegative.onclick = event => copyOutput('negative', event.currentTarget);
  refs.copyAll.onclick = event => copyOutput('both', event.currentTarget);
  setupPlanActions(scope, q); openPlan(getActivePlan(relayState())); subscribeRelay(syncStoredState);
  onTagZhChange(() => editor.render());
  root.addEventListener('focusout', async () => { await flushCompose(); });
  scope.addEventListener('relayclose', async () => { await flushCompose(); });
  document.addEventListener('visibilitychange', async () => { if (document.hidden) await flushCompose(); });
  window.addEventListener('beforeunload', event => { if ([...drafts.values()].some(d => d.dirty)) { event.preventDefault(); event.returnValue = ''; } });
  ready = initializeRelay().then(() => { syncStoredState(); return editor; });
  renderCompose();
  return { render: renderCompose, ready, flush: flushCompose };
}
