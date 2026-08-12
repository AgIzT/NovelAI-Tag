import { isEntryNsfw, isR18gPath } from './app/access.js';
import { writeClipboardText } from './app/clipboard.js';
import { showClipboardFallback } from './app/clipboard-fallback.js';
import { loadBootstrapData, findCodexMeta } from './app/data.js';
import { buildFavoritesCodex } from './app/fav-codex.js';
import { ATLAS_FAVORITES_STORAGE_KEY } from './app/favorites-backup-core.js';
import { hasEntryImage, thumbUrl } from './app/media.js';
import { state as atlasState, NSFW_STORAGE_KEY, R18G_STORAGE_KEY } from './app/state.js';
import {
  TAG_RELAY_STORAGE_KEY,
  appendBlockToPlan,
  appendEntryToPlan,
  compilePlan,
  createPlan,
  deletePlan,
  getActivePlan,
  loadRelayState,
  movePlanItem,
  normalizeRelayEntry,
  normalizeRelayState,
  recordCopyHistory,
  removeInboxEntry,
  removePlanItem,
  renamePlan,
  restoreHistoryAsPlan,
  saveRelayState,
  setActivePlan,
  updatePlanItem,
} from './app/tag-relay-core.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

let relay = loadRelayState();
let sourceMode = 'inbox';
let outputFormat = 'nai';
let joinMode = 'comma';
let selectedItemId = '';
let favorites = null;
let favoritesLoading = false;
let draggedSource = null;
let draggedBlockId = '';
let latestCompiled = null;
let toastTimer = 0;

function cloneRelay(value) {
  try {
    return normalizeRelayState(structuredClone(value));
  } catch {
    return normalizeRelayState(JSON.parse(JSON.stringify(value)));
  }
}

function showToast(message) {
  const node = $('#relayToast');
  if (!node) return;
  clearTimeout(toastTimer);
  node.textContent = message;
  node.hidden = false;
  toastTimer = window.setTimeout(() => { node.hidden = true; }, 2600);
}

function commit(mutator, { render = true } = {}) {
  const next = cloneRelay(relay);
  const result = mutator(next);
  if (!saveRelayState(next)) {
    showToast('保存失败：请检查浏览器存储权限');
    return { ok: false, result };
  }
  relay = next;
  if (render) renderAll();
  document.dispatchEvent(new CustomEvent('tag-relay:changed', { detail: { state: relay } }));
  return { ok: true, result };
}

function readAccessState() {
  try {
    const allowNsfw = localStorage.getItem(NSFW_STORAGE_KEY) === '1';
    return {
      allowNsfw,
      allowR18g: allowNsfw && localStorage.getItem(R18G_STORAGE_KEY) === '1',
    };
  } catch {
    return { allowNsfw: false, allowR18g: false };
  }
}

function accessAllowed(snapshot) {
  const { allowNsfw, allowR18g } = readAccessState();
  if (snapshot?.access?.nsfw && !allowNsfw) return false;
  if (snapshot?.access?.r18g && !allowR18g) return false;
  return true;
}

function planItemLocked(item) {
  return !accessAllowed(item);
}

function activePlan() {
  return getActivePlan(relay);
}

function promptParts(item, channel) {
  const parts = [channel === 'negative' ? item?.negative : item?.prompt];
  for (const character of item?.characterPrompts || []) {
    parts.push(channel === 'negative' ? character.negative : character.prompt);
  }
  return parts.map(value => String(value || '').trim()).filter(Boolean);
}

function itemChannel(item) {
  const positive = promptParts(item, 'positive').length > 0;
  const negative = promptParts(item, 'negative').length > 0;
  if (positive && negative) return { key: 'both', label: '正＋负' };
  if (negative) return { key: 'negative', label: '负向' };
  return { key: 'positive', label: '正向' };
}

function sourcePlaceholder(title = '') {
  const node = document.createElement('span');
  node.className = 'tag-relay-source-thumb is-placeholder';
  node.textContent = String(title || 'T').trim().slice(0, 1).toUpperCase() || 'T';
  return node;
}

function sourceImage(entry) {
  if (!entry.image) return sourcePlaceholder(entry.title);
  const image = document.createElement('img');
  image.className = 'tag-relay-source-thumb';
  image.src = entry.image;
  image.loading = 'lazy';
  image.alt = '';
  image.onerror = () => image.replaceWith(sourcePlaceholder(entry.title));
  return image;
}

function addSourceToPlan(entry, { negativeOnly = false, atIndex = null } = {}) {
  if (!accessAllowed(entry)) {
    showToast('该词条当前处于访问锁定状态');
    return;
  }
  const plan = activePlan();
  if (!plan) return;
  const source = negativeOnly ? {
    ...entry,
    prompt: '',
    negative: promptParts(entry, 'negative').join(',\n'),
    characterPrompts: [],
  } : entry;
  const action = commit(next => appendEntryToPlan(next, next.activePlanId, source, {
    allowDuplicate: true,
  }));
  if (!action.ok || !action.result?.item) return;
  if (Number.isInteger(atIndex)) {
    commit(next => movePlanItem(next, next.activePlanId, action.result.item.id, atIndex));
  }
  showToast(negativeOnly ? `已加入负向：${entry.title}` : `已加入方案：${entry.title}`);
}

function removeSource(entry) {
  const action = commit(next => removeInboxEntry(next, entry.key));
  if (action.ok) showToast(`已移出待整理：${entry.title}`);
}

function sourceCard(entry, { removable = false } = {}) {
  const locked = !accessAllowed(entry);
  const card = document.createElement('article');
  card.className = 'tag-relay-source-card';
  card.draggable = !locked;
  card.append(locked ? sourcePlaceholder('锁') : sourceImage(entry));

  const main = document.createElement('div');
  main.className = 'tag-relay-source-main';
  const title = document.createElement('b');
  title.textContent = locked ? '已锁定的成人内容' : entry.title;
  const preview = document.createElement('small');
  preview.textContent = locked
    ? '重新开启对应权限后可继续使用'
    : (entry.prompt || entry.negative || entry.path?.join?.(' › ') || entry.book || '候选词条');
  main.append(title, preview);
  card.append(main);

  const actions = document.createElement('div');
  actions.className = 'tag-relay-source-actions';
  const add = document.createElement('button');
  add.type = 'button';
  add.textContent = '加入整条';
  add.disabled = locked;
  add.onclick = () => addSourceToPlan(entry);
  actions.append(add);

  const hasNegative = promptParts(entry, 'negative').length > 0;
  const negative = document.createElement('button');
  negative.type = 'button';
  negative.textContent = '只加负向';
  negative.disabled = locked || !hasNegative;
  negative.title = hasNegative ? '只把负向内容加入方案' : '该词条没有负向内容';
  negative.onclick = () => addSourceToPlan(entry, { negativeOnly: true });
  actions.append(negative);

  if (removable) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'source-remove';
    remove.textContent = '×';
    remove.title = '从待整理移除';
    remove.setAttribute('aria-label', `从待整理移除${entry.title}`);
    remove.onclick = () => removeSource(entry);
    actions.append(remove);
  }
  card.append(actions);

  card.addEventListener('dragstart', event => {
    draggedSource = entry;
    draggedBlockId = '';
    card.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', entry.key || entry.title);
  });
  card.addEventListener('dragend', () => {
    draggedSource = null;
    card.classList.remove('is-dragging');
  });
  return card;
}

function historyLocked(record) {
  return record?.plan?.items?.some(planItemLocked) === true;
}

function historyCard(record) {
  const locked = historyLocked(record);
  const card = document.createElement('article');
  card.className = 'tag-relay-history-card';
  const header = document.createElement('header');
  const title = document.createElement('b');
  title.textContent = locked ? '含已锁定内容的复制记录' : record.planName;
  const time = document.createElement('time');
  const date = new Date(record.createdAt);
  time.dateTime = record.createdAt;
  time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  header.append(title, time);
  const preview = document.createElement('p');
  preview.textContent = locked ? '重新开启对应权限后可查看与恢复' : (record.positive || record.negative || '空输出');
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.disabled = locked;
  restore.textContent = `${record.target.toUpperCase()} · 恢复为新方案`;
  restore.onclick = () => {
    const action = commit(next => restoreHistoryAsPlan(next, record.id));
    if (!action.ok || !action.result) return;
    outputFormat = record.target;
    joinMode = record.joinMode || 'comma';
    $$('[data-format]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.format === outputFormat)));
    $$('[data-join]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.join === joinMode)));
    renderOutput();
    selectedItemId = '';
    switchMobilePane('arrange');
    showToast(`已恢复：${action.result.name}`);
  };
  card.append(header, preview, restore);
  return card;
}

function renderSources() {
  const list = $('#relaySourceList');
  const status = $('#relaySourceStatus');
  if (!list || !status) return;
  let items = [];
  let nodes = [];

  if (sourceMode === 'inbox') {
    items = relay.inbox;
    status.textContent = items.length ? '拖入中间编排台，或用按钮决定加入整条 / 仅负向。' : '浏览时加入的词条会出现在这里。';
    nodes = items.map(entry => sourceCard(entry, { removable: true }));
  } else if (sourceMode === 'favorites') {
    if (favoritesLoading) {
      status.textContent = '正在加载跨法典收藏…';
    } else if (favorites === null) {
      status.textContent = '打开此栏后加载你的本地收藏，不会上传。';
    } else {
      items = favorites;
      status.textContent = items.length ? '收藏只作为素材源；加入方案不会改变收藏状态。' : '当前没有可用收藏。';
      nodes = items.map(entry => sourceCard(entry));
    }
  } else {
    items = relay.history;
    status.textContent = items.length ? '每次成功复制都会留下可恢复快照。' : '完成第一次复制后，版本会保存在这里。';
    nodes = items.map(historyCard);
  }

  if (!nodes.length) {
    const empty = document.createElement('div');
    empty.className = 'tag-relay-source-empty';
    const title = document.createElement('b');
    title.textContent = favoritesLoading ? '加载中…' : '这里还没有内容';
    const note = document.createElement('span');
    note.textContent = sourceMode === 'inbox'
      ? '返回图鉴，点词条标题旁的中转按钮。'
      : (sourceMode === 'favorites' ? '收藏过的词条会在这里成为可选素材。' : '成功复制一次方案后即可恢复版本。');
    empty.append(title, note);
    nodes.push(empty);
  }
  list.replaceChildren(...nodes);
  $('#relaySourceCount').textContent = String(items.length);
  $('#relayMobileSourceCount').textContent = String(relay.inbox.length);
}

async function loadFavorites() {
  if (favoritesLoading || favorites !== null) return;
  favoritesLoading = true;
  renderSources();
  try {
    const access = readAccessState();
    atlasState.allowNsfw = access.allowNsfw;
    atlasState.allowR18g = access.allowR18g;
    try {
      const stored = JSON.parse(localStorage.getItem(ATLAS_FAVORITES_STORAGE_KEY) || '[]');
      atlasState.favs = new Set(Array.isArray(stored) ? stored : []);
    } catch {
      atlasState.favs = new Set();
    }
    const bootstrap = await loadBootstrapData();
    atlasState.codexes = bootstrap.codexes;
    atlasState.media = { ...atlasState.media, ...bootstrap.media };
    const codex = await buildFavoritesCodex();
    favorites = codex.entries.map(entry => {
      const sourceId = String(entry._srcCodexId || '').trim();
      const meta = findCodexMeta(sourceId);
      let image = '';
      try {
        if (hasEntryImage(entry)) image = thumbUrl(entry, codex);
      } catch {
        image = '';
      }
      const path = Array.isArray(entry._srcPath) ? entry._srcPath : (entry.path || []);
      return normalizeRelayEntry({
        ...entry,
        codexId: sourceId,
        entryId: entry.id,
        book: entry._srcCodexTitle || meta?.selectorTitle || meta?.title || '',
        path,
        image,
        access: { nsfw: meta?.nsfw === true || isEntryNsfw(entry), r18g: isR18gPath(path) },
      });
    });
  } catch (error) {
    console.warn('[tag-relay] 收藏素材加载失败', error);
    favorites = [];
    showToast('收藏加载失败，请稍后重试');
  } finally {
    favoritesLoading = false;
    renderSources();
  }
}

function setSourceMode(next) {
  sourceMode = next;
  $$('[data-relay-source]').forEach(button => {
    button.setAttribute('aria-selected', String(button.dataset.relaySource === next));
  });
  renderSources();
  if (next === 'favorites') void loadFavorites();
}

function blockPreview(item) {
  return promptParts(item, 'positive').join(', ') || promptParts(item, 'negative').join(', ') || '空块';
}

function selectBlock(itemId) {
  const item = activePlan()?.items?.find(candidate => candidate.id === itemId);
  if (!item || planItemLocked(item)) return;
  selectedItemId = itemId;
  $('#relayBlockTitle').value = item.title;
  $('#relayBlockWeight').value = ['0.8', '1', '1.1', '1.2'].includes(String(item.weight)) ? String(item.weight) : '1';
  $('#relayBlockText').value = promptParts(item, 'positive').join(',\n');
  $('#relayBlockNegative').value = promptParts(item, 'negative').join(',\n');
  $('#relayInspector').hidden = false;
  renderPlanLane();
}

function moveBlock(itemId, delta) {
  const plan = activePlan();
  const index = plan?.items?.findIndex(item => item.id === itemId) ?? -1;
  if (index < 0) return;
  commit(next => movePlanItem(next, next.activePlanId, itemId, index + delta));
}

function removeBlock(itemId) {
  const action = commit(next => removePlanItem(next, next.activePlanId, itemId));
  if (!action.ok || !action.result) return;
  if (selectedItemId === itemId) closeInspector();
  showToast(`已移除：${action.result.title}`);
}

function toggleBlock(itemId) {
  const item = activePlan()?.items?.find(candidate => candidate.id === itemId);
  if (!item) return;
  commit(next => updatePlanItem(next, next.activePlanId, itemId, { enabled: item.enabled === false }));
}

function planBlock(item, index, total) {
  const locked = planItemLocked(item);
  const block = document.createElement('article');
  block.className = 'tag-relay-block';
  block.classList.toggle('is-selected', selectedItemId === item.id);
  block.classList.toggle('is-disabled', item.enabled === false);
  block.draggable = !locked;
  block.dataset.itemId = item.id;

  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'tag-relay-block-handle';
  handle.textContent = '⠿';
  handle.title = '拖动排序';
  handle.setAttribute('aria-label', `拖动${item.title}排序`);

  const number = document.createElement('span');
  number.className = 'tag-relay-block-index';
  number.textContent = String(index + 1).padStart(2, '0');

  const copy = document.createElement('div');
  copy.className = 'tag-relay-block-copy';
  const header = document.createElement('header');
  const title = document.createElement('b');
  title.textContent = locked ? '已锁定的成人内容' : item.title;
  const channel = itemChannel(item);
  const chip = document.createElement('span');
  chip.className = `tag-relay-channel ${channel.key}`;
  chip.textContent = locked ? '锁定' : channel.label;
  header.append(title, chip);
  const preview = document.createElement('p');
  preview.textContent = locked ? '当前权限关闭，不参与输出' : blockPreview(item);
  copy.append(header, preview);
  copy.onclick = () => selectBlock(item.id);

  const tools = document.createElement('div');
  tools.className = 'tag-relay-block-tools';
  const tool = (label, titleText, action, disabled = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = titleText;
    button.setAttribute('aria-label', `${titleText}：${item.title}`);
    button.disabled = disabled;
    button.onclick = action;
    return button;
  };
  tools.append(
    tool('↑', '上移', () => moveBlock(item.id, -1), index === 0),
    tool('↓', '下移', () => moveBlock(item.id, 1), index === total - 1),
    tool(item.enabled === false ? '○' : '●', item.enabled === false ? '启用' : '停用', () => toggleBlock(item.id), locked),
    tool('×', '移除', () => removeBlock(item.id)),
  );

  block.append(handle, number, copy, tools);
  if (item.enabled === false) block.style.opacity = '.56';

  block.addEventListener('dragstart', event => {
    draggedBlockId = item.id;
    draggedSource = null;
    block.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
  });
  block.addEventListener('dragend', () => {
    draggedBlockId = '';
    block.classList.remove('is-dragging');
  });
  block.addEventListener('dragover', event => {
    if (!draggedBlockId && !draggedSource) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = draggedSource ? 'copy' : 'move';
  });
  block.addEventListener('drop', event => {
    if (!draggedBlockId && !draggedSource) return;
    event.preventDefault();
    event.stopPropagation();
    if (draggedSource) addSourceToPlan(draggedSource, { atIndex: index });
    else commit(next => movePlanItem(next, next.activePlanId, draggedBlockId, index));
    draggedBlockId = '';
    draggedSource = null;
  });
  return block;
}

function renderPlanLane() {
  const plan = activePlan();
  const lane = $('#relayPlanLane');
  const empty = $('#relayPlanEmpty');
  const items = plan?.items || [];
  lane.replaceChildren(...items.map((item, index) => planBlock(item, index, items.length)));
  lane.hidden = items.length === 0;
  empty.hidden = items.length !== 0;
  $('#relayMobileBlockCount').textContent = String(items.length);
}

function safePlan(plan) {
  return { ...plan, items: (plan?.items || []).filter(item => !planItemLocked(item)) };
}

function joined(tokens) {
  return tokens.join(joinMode === 'newline' ? ',\n' : ', ');
}

function renderOutput() {
  const plan = activePlan();
  const compiled = compilePlan(safePlan(plan), { target: outputFormat });
  latestCompiled = {
    ...compiled,
    positive: joined(compiled.positiveTokens),
    negative: joined(compiled.negativeTokens),
  };
  $('#relayPositiveOutput').value = latestCompiled.positive;
  $('#relayNegativeOutput').value = latestCompiled.negative;
  $('#relayPositiveMeta').textContent = `${compiled.positiveCount} 段 · ${latestCompiled.positive.length} 字符`;
  $('#relayNegativeMeta').textContent = `${compiled.negativeCount} 段 · ${latestCompiled.negative.length} 字符`;
  $('#relayCopyPositive').disabled = !latestCompiled.positive;
  $('#relayCopyNegative').disabled = !latestCompiled.negative;
  $('#relayCopyAll').disabled = !latestCompiled.positive && !latestCompiled.negative;
  const lockedCount = plan?.items?.filter(planItemLocked).length || 0;
  $('#relayPlanStats').textContent = `${plan?.items?.length || 0} 个块 · ${latestCompiled.positive.length + latestCompiled.negative.length} 个字符${lockedCount ? ` · ${lockedCount} 个锁定` : ''}`;
}

function renderPlanControls() {
  const select = $('#relayPlanSelect');
  const options = relay.plans.map(plan => {
    const option = document.createElement('option');
    option.value = plan.id;
    option.textContent = `${plan.name} · ${plan.items.length}`;
    option.selected = plan.id === relay.activePlanId;
    return option;
  });
  select.replaceChildren(...options);
  const plan = activePlan();
  document.title = `${plan?.name || 'Tag 中转站'} · Tag 中转站`;
}

function renderAll() {
  renderPlanControls();
  renderSources();
  renderPlanLane();
  renderOutput();
  const selected = activePlan()?.items?.some(item => item.id === selectedItemId);
  if (!selected) closeInspector();
}

function closeInspector() {
  selectedItemId = '';
  const inspector = $('#relayInspector');
  if (inspector) inspector.hidden = true;
  $$('.tag-relay-block.is-selected').forEach(node => node.classList.remove('is-selected'));
}

function copyRecordOutput(channel) {
  if (channel === 'positive') return latestCompiled.positive;
  if (channel === 'negative') return latestCompiled.negative;
  const sections = [];
  if (latestCompiled.positive) sections.push(latestCompiled.positive);
  if (latestCompiled.negative) sections.push(`Negative:\n${latestCompiled.negative}`);
  return sections.join('\n\n');
}

async function copyOutput(channel, trigger) {
  // Permissions may have changed in another tab since the last render. Never copy
  // the cached output until it has been rebuilt against the current lock state.
  renderOutput();
  const text = copyRecordOutput(channel);
  if (!text) {
    showToast('当前没有可复制内容');
    return;
  }
  const result = await writeClipboardText(text);
  if (!result.ok) {
    showClipboardFallback(text, { trigger });
    showToast('自动复制未成功，已打开手动复制面板');
    return;
  }
  const output = {
    ...latestCompiled,
    positiveCount: latestCompiled.positiveTokens.length,
    negativeCount: latestCompiled.negativeTokens.length,
  };
  const saved = commit(next => recordCopyHistory(next, {
    planId: next.activePlanId,
    target: outputFormat,
    joinMode,
    channel,
    output,
  }));
  showToast(saved.ok ? `已复制${channel === 'both' ? '完整方案' : (channel === 'positive' ? '正向' : '负向')}，并保存版本` : '已复制，但版本记录保存失败');
}

function switchMobilePane(name) {
  $$('[data-relay-pane]').forEach(pane => pane.classList.toggle('is-mobile-active', pane.dataset.relayPane === name));
  $$('[data-relay-mobile]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.relayMobile === name)));
}

function duplicateCurrentPlan() {
  const source = activePlan();
  if (!source) return;
  const action = commit(next => {
    const plan = createPlan(next, `${source.name} 副本`);
    for (const item of source.items) {
      const result = item.kind === 'entry'
        ? appendEntryToPlan(next, plan.id, item, { allowDuplicate: true, enabled: item.enabled, weight: item.weight })
        : { item: appendBlockToPlan(next, plan.id, item, { enabled: item.enabled, weight: item.weight }) };
      if (result?.item) updatePlanItem(next, plan.id, result.item.id, {
        title: item.title,
        prompt: item.prompt,
        negative: item.negative,
        characterPrompts: item.characterPrompts,
        enabled: item.enabled,
        weight: item.weight,
      });
    }
    return plan;
  });
  if (action.ok) {
    selectedItemId = '';
    showToast(`已创建：${action.result.name}`);
  }
}

function bindTheme() {
  const button = $('#relayThemeBtn');
  const render = () => {
    const dark = document.body.classList.contains('dark');
    button.innerHTML = dark
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.4A8 8 0 0 1 9.6 3.5 8.5 8.5 0 1 0 20.5 14.4Z"/></svg>';
    button.setAttribute('aria-label', dark ? '切换浅色模式' : '切换深色模式');
  };
  button.onclick = () => {
    const dark = !document.body.classList.contains('dark');
    document.body.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    localStorage.setItem('fadian-dark', dark ? '1' : '0');
    render();
  };
  render();
}

function bindControls() {
  bindTheme();
  $$('[data-relay-source]').forEach(button => {
    button.onclick = () => setSourceMode(button.dataset.relaySource);
  });
  $('#relayPlanSelect').onchange = event => {
    commit(next => setActivePlan(next, event.target.value));
    closeInspector();
  };
  $('#relayNewPlan').onclick = () => {
    const name = window.prompt('新方案名称', `方案 ${relay.plans.length + 1}`)?.trim();
    if (!name) return;
    const action = commit(next => createPlan(next, name));
    if (action.ok) {
      closeInspector();
      switchMobilePane('arrange');
      showToast(`已新建：${name}`);
    }
  };
  $('#relayDuplicatePlan').onclick = duplicateCurrentPlan;
  $('#relayRenamePlan').onclick = () => {
    const plan = activePlan();
    const name = window.prompt('方案名称', plan?.name || '')?.trim();
    if (!name || !plan) return;
    const action = commit(next => renamePlan(next, next.activePlanId, name));
    if (action.ok) showToast(`已改名：${name}`);
  };
  $('#relayDeletePlan').onclick = () => {
    const plan = activePlan();
    if (!plan || !window.confirm(`确认删除方案“${plan.name}”？复制历史不会受影响。`)) return;
    const action = commit(next => deletePlan(next, next.activePlanId));
    if (action.ok) {
      closeInspector();
      showToast(`已删除：${plan.name}`);
    }
  };

  const manual = $('#relayManualForm');
  const toggle = $('#relayManualToggle');
  const closeManual = () => {
    manual.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };
  toggle.onclick = () => {
    manual.hidden = !manual.hidden;
    toggle.setAttribute('aria-expanded', String(!manual.hidden));
    if (!manual.hidden) $('#relayManualTitle').focus();
  };
  $('#relayManualCancel').onclick = closeManual;
  manual.onsubmit = event => {
    event.preventDefault();
    const title = $('#relayManualTitle').value.trim() || '自定义块';
    const text = $('#relayManualText').value.trim();
    const channel = $('#relayManualChannel').value;
    if (!text) {
      showToast('请先填写 Prompt');
      return;
    }
    const action = commit(next => appendBlockToPlan(next, next.activePlanId, {
      title,
      prompt: channel === 'positive' ? text : '',
      negative: channel === 'negative' ? text : '',
    }));
    if (!action.ok) return;
    manual.reset();
    closeManual();
    showToast(`已加入自定义块：${title}`);
  };

  $('#relayInspectorClose').onclick = closeInspector;
  $('#relayBlockSave').onclick = () => {
    if (!selectedItemId) return;
    const title = $('#relayBlockTitle').value.trim() || '未命名块';
    const positive = $('#relayBlockText').value.trim();
    const negative = $('#relayBlockNegative').value.trim();
    const weight = Number($('#relayBlockWeight').value);
    const action = commit(next => updatePlanItem(next, next.activePlanId, selectedItemId, {
      title,
      prompt: positive,
      negative,
      characterPrompts: [],
      weight,
    }));
    if (action.ok) {
      closeInspector();
      showToast(`已保存：${title}`);
    }
  };
  $('#relayBlockRemove').onclick = () => {
    if (selectedItemId) removeBlock(selectedItemId);
  };

  $$('[data-format]').forEach(button => {
    button.onclick = () => {
      outputFormat = button.dataset.format;
      $$('[data-format]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      renderOutput();
    };
  });
  $$('[data-join]').forEach(button => {
    button.onclick = () => {
      joinMode = button.dataset.join;
      $$('[data-join]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      renderOutput();
    };
  });
  $('#relayCopyPositive').onclick = event => void copyOutput('positive', event.currentTarget);
  $('#relayCopyNegative').onclick = event => void copyOutput('negative', event.currentTarget);
  $('#relayCopyAll').onclick = event => void copyOutput('both', event.currentTarget);

  const dropTargets = [$('#relayPlanLane'), $('#relayPlanEmpty')];
  dropTargets.forEach(target => {
    target.addEventListener('dragover', event => {
      if (!draggedSource && !draggedBlockId) return;
      event.preventDefault();
      target.classList.add('is-drop-target');
    });
    target.addEventListener('dragleave', event => {
      if (!target.contains(event.relatedTarget)) target.classList.remove('is-drop-target');
    });
    target.addEventListener('drop', event => {
      if (!draggedSource && !draggedBlockId) return;
      event.preventDefault();
      target.classList.remove('is-drop-target');
      if (draggedSource) addSourceToPlan(draggedSource);
      else commit(next => movePlanItem(next, next.activePlanId, draggedBlockId, activePlan()?.items?.length - 1));
      draggedSource = null;
      draggedBlockId = '';
    });
  });

  $$('[data-relay-mobile]').forEach(button => {
    button.onclick = () => switchMobilePane(button.dataset.relayMobile);
  });
  window.addEventListener('storage', event => {
    if (event.key === TAG_RELAY_STORAGE_KEY || event.key === null) {
      relay = loadRelayState();
      selectedItemId = '';
      renderAll();
      showToast('已同步另一标签页的中转站修改');
      return;
    }
    if (event.key !== NSFW_STORAGE_KEY && event.key !== R18G_STORAGE_KEY) return;
    favorites = null;
    renderAll();
    if (sourceMode === 'favorites') void loadFavorites();
    showToast('内容权限已更新，输出已重新检查');
  });
}

bindControls();
renderAll();
