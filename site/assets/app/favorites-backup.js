import { openMask, closeMask, trapFocus, bindBackdropDismiss } from './modal.js';
import {
  closeHistoryLayer,
  forgetHistoryLayer,
  openHistoryLayer,
  registerHistoryLayer,
} from './browser-history.js';
import {
  COMMUNITY_FAVORITES_STORAGE_KEY,
  FAVORITES_BACKUP_LIMITS,
  FavoritesBackupError,
} from './favorites-backup-core.js';
import { readLibraryFavorites, readFavoritesRecovery, restoreLibraryFavorites, serializeLibraryFavorites } from './favorites-backup-store.js';
import { FAVORITES_LIBRARY_STORAGE_KEY, createLibraryRestorePlan, parseLibraryBackup } from './favorites-library-core.js';
import { setupFavoritesOriginMigration } from './favorites-origin-migration.js';
import { fetchDataJson } from '../data-source.js';
import { decodeFavoritesTransfer, encodeFavoritesTransfer } from './favorites-transfer.js';
import { writeClipboardText } from './clipboard.js';
import { showClipboardFallback } from './clipboard-fallback.js';

const CHANGE_EVENT = 'novelai-tag:favorites-changed';

const byId = id => document.getElementById(id);

function runCallback(callback, detail) {
  Promise.resolve(callback(detail)).catch(error => console.error(error));
}

export function subscribeFavoritesChanges(scope, callback) {
  if (!['atlas', 'community'].includes(scope) || typeof callback !== 'function') return () => {};
  const storageKey = scope === 'atlas' ? FAVORITES_LIBRARY_STORAGE_KEY : COMMUNITY_FAVORITES_STORAGE_KEY;
  const onChanged = event => {
    const scopes = event.detail?.scopes || [];
    if (scopes.includes(scope)) runCallback(callback, event.detail || {});
  };
  const onStorage = event => {
    try { if (event.storageArea !== localStorage) return; } catch { return; }
    if (event.key === null || event.key === storageKey) {
      runCallback(callback, { scopes: [scope], reason: 'storage' });
    }
  };
  window.addEventListener(CHANGE_EVENT, onChanged);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChanged);
    window.removeEventListener('storage', onStorage);
  };
}

export function emitFavoritesChanged(scopes, reason = 'restore') {
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, {
    detail: { scopes, reason },
  }));
}

function localDateStamp(now = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function downloadJson(text, { recovery = false } = {}) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  if (!recovery && blob.size > FAVORITES_BACKUP_LIMITS.maxFileBytes) {
    throw new FavoritesBackupError('FILE_TOO_LARGE', '生成的备份超过 2 MiB，无法导出');
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `novelai-tag-favorites-${recovery ? 'recovery-' : ''}${localDateStamp()}.json`;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function friendlyError(error) {
  if (!(error instanceof FavoritesBackupError)) {
    return error?.message || '处理收藏备份时发生未知错误。';
  }
  if (error.details?.reason) return error.message;
  const messages = {
    INVALID_JSON: '无法读取：文件不是有效的 JSON。',
    INVALID_FORMAT: '这不是法典图鉴的收藏备份。',
    UNSUPPORTED_VERSION: '该备份版本不受支持；如果版本较新，更新站点后再试。',
    INVALID_ROOT: '备份内容不完整或已经损坏，未进行恢复。',
    INVALID_FAVORITES: '备份内容不完整或已经损坏，未进行恢复。',
    INVALID_ATLAS: '备份缺少法典图鉴收藏，未进行恢复。',
    INVALID_COMMUNITY: '备份缺少共创广场收藏，未进行恢复。',
    INVALID_ATLAS_ITEM: '备份中包含无效的法典收藏标识，未进行恢复。',
    INVALID_COMMUNITY_ITEM: '备份中包含无效的共创广场收藏标识，未进行恢复。',
    TOO_MANY_ITEMS: '备份中的收藏数量超过 30,000 条，未进行恢复。',
    FILE_TOO_LARGE: '文件超过 2 MiB，无法作为收藏备份处理。',
    STORAGE_READ_FAILED: '无法读取当前浏览器收藏，未进行恢复。',
    STORAGE_WRITE_FAILED: '浏览器存储空间不足或不可用，收藏未发生变化。',
    STORAGE_ROLLBACK_FAILED: '收藏写入失败，且无法完整恢复原数据；重新导出当前收藏进行核对。',
  };
  return messages[error.code] || error.message || '备份内容无效，未进行恢复。';
}

function formatExportedAt(value) {
  if (!value) return '未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未记录' : date.toLocaleString('zh-CN');
}

function appendStatCard(root, title, stats, mode, unit = '条') {
  const card = document.createElement('section');
  card.className = 'favorites-backup-stat';
  const heading = document.createElement('b');
  heading.textContent = title;
  const detail = document.createElement('span');
  const parts = [
    `备份 ${stats.incoming} ${unit}`,
    stats.current === null ? '当前无法读取' : `当前 ${stats.current} ${unit}`,
    `新增 ${stats.added} ${unit}`,
    `已存在 ${stats.duplicate} ${unit}`,
  ];
  if (mode === 'replace' && stats.current !== null) parts.push(`将移除 ${stats.removed} ${unit}`);
  detail.textContent = parts.join(' · ');
  card.append(heading, detail);
  root.appendChild(card);
}

export function setupFavoritesBackup(options = {}) {
  const panel = byId('favoritesBackupPanel');
  const triggers = [...document.querySelectorAll('[data-favorites-backup-open]')];
  if (!panel || !triggers.length || panel.dataset.bound === '1') return;
  panel.dataset.bound = '1';
  const localEdition = options.localEdition
    ?? document.body.classList.contains('local-edition');

  const closeButton = byId('favoritesBackupClose');
  const exportButton = byId('favoritesExportBtn');
  const exportTextButton = byId('favoritesExportTextBtn');
  const fileInput = byId('favoritesImportFile');
  const textInput = byId('favoritesImportText');
  const importTextButton = byId('favoritesImportTextBtn');
  const preview = byId('favoritesImportPreview');
  const summary = byId('favoritesImportSummary');
  const restoreButton = byId('favoritesRestoreBtn');
  const status = byId('favoritesBackupStatus');
  const errorBox = byId('favoritesBackupError');
  const currentAtlas = byId('favoritesCurrentAtlas');
  const currentCommunity = byId('favoritesCurrentCommunity');
  const replaceConfirm = byId('favoritesReplaceConfirm');
  const replaceMessage = byId('favoritesReplaceMessage');
  const replaceBack = byId('favoritesReplaceBack');
  const replaceConfirmButton = byId('favoritesReplaceConfirmBtn');
  const modeInputs = [...panel.querySelectorAll('input[name="favoritesRestoreMode"]')];
  const dialog = panel.querySelector('.favorites-backup-dialog');
  const replaceBackground = dialog
    ? [...dialog.children].filter(child => child !== replaceConfirm)
    : [];

  let codexesPromise = null;
  let selectedFileName = '';
  let parsedBackup = null;
  let plans = null;
  let planErrors = {};
  let busy = false;
  let corruptRecovery = null;
  let exportedCorruptRaw = null;
  let pendingReplace = null;

  const setStatus = message => {
    if (!status) return;
    status.textContent = message || '';
    status.hidden = !message;
  };
  const skippedStatus = count => count > 0
    ? `${count} 条本地收藏格式异常，已跳过。`
    : '';
  const setError = message => {
    if (!errorBox) return;
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
  };
  const setBusy = value => {
    busy = Boolean(value);
    panel.setAttribute('aria-busy', String(busy));
    if (fileInput) fileInput.disabled = busy;
    if (textInput) textInput.disabled = busy;
    if (importTextButton) importTextButton.disabled = busy;
    if (restoreButton) restoreButton.disabled = busy || restoreButton.dataset.noop === '1'
      || Boolean(corruptRecovery && exportedCorruptRaw !== corruptRecovery.libraryRaw);
    modeInputs.forEach(input => { input.disabled = busy || Boolean(corruptRecovery && input.value === 'merge'); });
    if (replaceConfirmButton) replaceConfirmButton.disabled = busy;
    if (exportButton) exportButton.disabled = busy || exportButton.dataset.empty === '1';
    if (exportTextButton) exportTextButton.disabled = busy || exportTextButton.dataset.empty === '1';
  };

  const resolveCodexes = async () => {
    if (!codexesPromise) {
      codexesPromise = (async () => {
        const supplied = await options.getCodexes?.();
        if (Array.isArray(supplied) && supplied.length) return supplied;
        const data = await fetchDataJson('codexes.json', { cache: 'no-store' });
        return Array.isArray(data) ? data : [];
      })();
    }
    const pending = codexesPromise;
    try {
      return await pending;
    } catch (error) {
      if (codexesPromise === pending) codexesPromise = null;
      console.warn('收藏备份：法典别名索引暂不可用，将原样保留法典标识。', error);
      return [];
    }
  };

  const readCurrent = async () => {
    const codexes = await resolveCodexes();
    try {
      const current = await readLibraryFavorites({ codexes });
      corruptRecovery = null;
      return current;
    } catch (error) {
      if (error.code !== 'CORRUPT') throw error;
      const current = readFavoritesRecovery({ codexes });
      corruptRecovery = current.recovery;
      setError('当前收藏数据无法读取。先导出原始数据，再选择备份覆盖恢复。');
      return current;
    }
  };

  const refreshCounts = async () => {
    const current = await readCurrent();
    if (currentAtlas) currentAtlas.textContent = corruptRecovery ? '无法读取' : String(current.atlasKeys.length);
    if (currentCommunity) currentCommunity.textContent = String(current.communityIds.length);
    const visibleCount = current.atlasKeys.length
      + (localEdition ? 0 : current.communityIds.length);
    const empty = !corruptRecovery && visibleCount === 0 && current.library.folders.length === 0;
    if (exportButton) {
      exportButton.textContent = corruptRecovery ? '导出当前原始数据' : '导出 JSON';
      exportButton.dataset.empty = empty ? '1' : '0';
      exportButton.disabled = busy || empty;
      exportButton.title = empty ? '暂无收藏可备份' : '';
    }
    if (exportTextButton) {
      exportTextButton.dataset.empty = empty || corruptRecovery ? '1' : '0';
      exportTextButton.disabled = busy || empty || Boolean(corruptRecovery);
      exportTextButton.title = empty ? '暂无收藏可备份' : '';
    }
    if (current.skippedCount) setStatus(skippedStatus(current.skippedCount));
    if (parsedBackup && !preview?.hidden && !busy) buildPlans(current, await resolveCodexes());
    setBusy(busy);
    return current;
  };

  const selectedMode = () => modeInputs.find(input => input.checked)?.value === 'replace' ? 'replace' : 'merge';
  const replaceLayerId = 'favorites-replace-confirm';
  const showReplaceConfirmDirect = visible => {
    if (replaceConfirm) replaceConfirm.hidden = !visible;
    replaceBackground.forEach(element => { element.inert = Boolean(visible); });
  };
  registerHistoryLayer(replaceLayerId, {
    isOpen: () => Boolean(replaceConfirm && !replaceConfirm.hidden),
    open: () => showReplaceConfirmDirect(true),
    close: () => showReplaceConfirmDirect(false),
  });
  const showReplaceConfirm = (visible, { historyMode = visible ? 'push' : 'back' } = {}) => {
    if (!visible && historyMode === 'back' && closeHistoryLayer(replaceLayerId)) return;
    showReplaceConfirmDirect(visible);
    if (historyMode === 'none') return;
    if (visible) openHistoryLayer(replaceLayerId, { mode: historyMode === 'replace' ? 'replace' : 'push' });
    else forgetHistoryLayer(replaceLayerId);
  };

  const renderPlan = mode => {
    if (!plans || !summary || !restoreButton) return;
    const plan = plans[mode];
    summary.replaceChildren();
    restoreButton.textContent = mode === 'replace' ? '覆盖恢复' : '合并恢复';
    if (!plan) {
      restoreButton.dataset.noop = '1';
      restoreButton.disabled = true;
      setError(friendlyError(planErrors[mode]));
      return;
    }
    if (!corruptRecovery) setError('');

    const meta = document.createElement('div');
    meta.className = 'favorites-backup-file';
    const name = document.createElement('b');
    name.textContent = selectedFileName || '收藏备份.json';
    name.title = selectedFileName;
    const exported = document.createElement('span');
    exported.textContent = `导出时间：${formatExportedAt(parsedBackup?.exportedAt)}`;
    meta.append(name, exported);
    summary.appendChild(meta);

    const grid = document.createElement('div');
    grid.className = 'favorites-backup-stats';
    appendStatCard(grid, '法典图鉴', corruptRecovery ? { ...plan.stats.atlas, current: null } : plan.stats.atlas, mode);
    appendStatCard(grid, '收藏夹', corruptRecovery ? { ...plan.stats.folders, current: null } : plan.stats.folders, mode, '个');
    if (!localEdition) appendStatCard(grid, '共创广场', plan.stats.community, mode);
    summary.appendChild(grid);

    if (plan.stats.unknownCodexCount) {
      const warning = document.createElement('p');
      warning.className = 'favorites-backup-warning';
      warning.textContent = `${plan.stats.unknownCodexCount} 条收藏来自当前未识别的法典，将原样保留。`;
      summary.appendChild(warning);
    }

    const noChange = !corruptRecovery && !plan.hasChanges;
    restoreButton.dataset.noop = noChange ? '1' : '0';
    restoreButton.dataset.mode = mode;
    restoreButton.disabled = busy || noChange
      || Boolean(corruptRecovery && exportedCorruptRaw !== corruptRecovery.libraryRaw);
    restoreButton.textContent = mode === 'replace' ? '覆盖恢复' : '合并恢复';
    if (noChange) setStatus('备份中的收藏、收藏夹和备注与当前一致。');
    else setStatus('');
  };

  const resetImport = () => {
    selectedFileName = '';
    parsedBackup = null;
    plans = null;
    planErrors = {};
    pendingReplace = null;
    if (preview) preview.hidden = true;
    showReplaceConfirm(false, { historyMode: 'forget' });
    if (summary) summary.replaceChildren();
    if (restoreButton) {
      restoreButton.dataset.noop = '1';
      restoreButton.disabled = true;
    }
    const merge = modeInputs.find(input => input.value === 'merge');
    if (merge) merge.checked = true;
    setStatus('');
    setError('');
  };

  const buildPlans = (current, codexes) => {
    const incoming = localEdition
      ? { ...parsedBackup, favorites: { ...parsedBackup.favorites, community: current.communityIds } }
      : parsedBackup;
    const common = { backup: incoming, currentLibrary: current.library, currentCommunityIds: current.communityIds, codexes };
    plans = {};
    planErrors = {};
    for (const mode of ['merge', 'replace']) {
      try { plans[mode] = createLibraryRestorePlan({ ...common, mode }); }
      catch (error) { planErrors[mode] = error; }
    }
    if (corruptRecovery) {
      modeInputs.forEach(input => { input.checked = input.value === 'replace'; });
    }
    renderPlan(selectedMode());
  };

  const prepareImportText = async (text, label) => {
    const bytes = new TextEncoder().encode(String(text || '')).byteLength;
    if (bytes > FAVORITES_BACKUP_LIMITS.maxFileBytes) {
      throw new FavoritesBackupError('FILE_TOO_LARGE', '备份文本超过 2 MiB，无法处理');
    }
    selectedFileName = label;
    const codexes = await resolveCodexes();
    parsedBackup = parseLibraryBackup(text, codexes);
    const current = await readCurrent();
    buildPlans(current, codexes);
    if (preview) preview.hidden = false;
    renderPlan(selectedMode());
    if (current.skippedCount) {
      const currentStatus = status?.textContent || '';
      setStatus(`${currentStatus}${currentStatus ? ' ' : ''}${skippedStatus(current.skippedCount)}`);
    }
    restoreButton?.focus();
  };

  const close = () => {
    if (busy) return;
    if (replaceConfirm && !replaceConfirm.hidden) {
      showReplaceConfirm(false);
      restoreButton?.focus();
      return;
    }
    closeMask(panel);
  };

  const open = async event => {
    resetImport();
    openMask(panel, event?.currentTarget || document.activeElement);
    setBusy(true);
    try {
      await refreshCounts();
    } catch (error) {
      setError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (previewPlan, incomingBackup = parsedBackup, recoveryRaw = corruptRecovery?.libraryRaw) => {
    if (!previewPlan) return;
    if (recoveryRaw !== undefined && exportedCorruptRaw !== recoveryRaw) {
      setError('当前原始数据尚未导出，使用「导出当前原始数据」保存后再恢复。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { result, plan } = await restoreLibraryFavorites({
        backup: incomingBackup,
        mode: previewPlan.mode,
        codexes: await resolveCodexes(),
        preserveCommunity: localEdition,
        ...(recoveryRaw === undefined ? {} : { expectedCorruptRaw: recoveryRaw }),
      });
      corruptRecovery = null;
      exportedCorruptRaw = null;
      if (preview) preview.hidden = true;
      emitFavoritesChanged(localEdition ? ['atlas'] : ['atlas', 'community']);
      await refreshCounts();
      if (preview) preview.hidden = true;
      showReplaceConfirm(false);
      if (plan.mode === 'replace') {
        setStatus(localEdition
          ? `覆盖完成：本地法典收藏 ${result.atlasKeys.length} 条，收藏夹 ${plan.stats.folders.total} 个。`
          : `覆盖完成：法典图鉴 ${result.atlasKeys.length} 条，共创广场 ${result.communityIds.length} 条，收藏夹 ${plan.stats.folders.total} 个。`);
      } else {
        const visibleStats = localEdition ? plan.stats.atlas : plan.stats.all;
        setStatus(`恢复完成：新增 ${visibleStats.added} 条收藏，${visibleStats.duplicate} 条已存在，收藏夹 ${plan.stats.folders.total} 个。`);
      }
      closeButton?.focus();
    } catch (error) {
      setError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  };

  triggers.forEach(trigger => trigger.addEventListener('click', open));
  closeButton?.addEventListener('click', close);
  bindBackdropDismiss(panel, () => close());
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    trapFocus(event, replaceConfirm && !replaceConfirm.hidden ? replaceConfirm : panel);
  });

  exportButton?.addEventListener('click', async () => {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const codexes = await resolveCodexes();
      const current = await readCurrent();
      if (corruptRecovery) {
        const recovery = localEdition ? { ...corruptRecovery, communityRaw: null } : corruptRecovery;
        downloadJson(JSON.stringify(recovery, null, 2), { recovery: true });
        exportedCorruptRaw = corruptRecovery.libraryRaw;
        if (plans) renderPlan(selectedMode());
        setStatus('原始数据已导出。选择收藏备份后可覆盖恢复。');
        return;
      }
      if (!current.atlasKeys.length && !current.library.folders.length && (localEdition || !current.communityIds.length)) {
        setStatus(current.skippedCount
          ? `暂无有效收藏可备份。${skippedStatus(current.skippedCount)}`
          : '暂无收藏可备份。');
        return;
      }
      downloadJson(serializeLibraryFavorites({
        library: current.library,
        communityIds: localEdition ? [] : current.communityIds,
        codexes,
        exportedAt: new Date().toISOString(),
      }));
      const exported = localEdition
        ? `备份已导出：本地法典收藏 ${current.atlasKeys.length} 条，收藏夹 ${current.library.folders.length} 个。`
        : `备份已导出：法典图鉴 ${current.atlasKeys.length} 条，共创广场 ${current.communityIds.length} 条，收藏夹 ${current.library.folders.length} 个。`;
      setStatus(`${exported}${skippedStatus(current.skippedCount)}`);
    } catch (error) {
      setError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  });

  exportTextButton?.addEventListener('click', async () => {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const codexes = await resolveCodexes();
      const current = await readCurrent();
      if (corruptRecovery) { setError('当前收藏数据无法读取，使用「导出当前原始数据」保存。'); return; }
      if (!current.atlasKeys.length && !current.library.folders.length && (localEdition || !current.communityIds.length)) {
        setStatus('暂无收藏可备份。');
        return;
      }
      const json = serializeLibraryFavorites({
        library: current.library,
        communityIds: localEdition ? [] : current.communityIds,
        codexes,
        exportedAt: new Date().toISOString(),
      });
      const transfer = await encodeFavoritesTransfer(json);
      const result = await writeClipboardText(transfer);
      if (!result.ok) {
        const shown = showClipboardFallback(transfer, { trigger: exportTextButton });
        setStatus(shown ? '自动复制未成功，已打开手动复制面板。' : '自动复制未成功，改用 JSON 文件。');
        return;
      }
      setStatus(`${transfer.length > 10_000 ? '迁移文本较长，聊天工具可能截断；建议同时保留 JSON 文件。' : '迁移文本已复制，可发送给自己并在另一台设备粘贴恢复。'}${skippedStatus(current.skippedCount)}`);
    } catch (error) {
      setError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  });

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    resetImport();
    selectedFileName = file.name;
    if (file.size > FAVORITES_BACKUP_LIMITS.maxFileBytes) {
      setError('文件超过 2 MiB，无法作为收藏备份读取。');
      return;
    }
    setBusy(true);
    try {
      await prepareImportText(await file.text(), file.name);
    } catch (error) {
      setError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  });

  importTextButton?.addEventListener('click', async () => {
    const source = textInput?.value || '';
    resetImport();
    if (!source.trim()) {
      setError('粘贴迁移文本或 JSON 后再恢复。');
      return;
    }
    setBusy(true);
    try {
      const decoded = await decodeFavoritesTransfer(source);
      await prepareImportText(decoded, '粘贴的迁移文本');
    } catch (error) {
      setError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  });

  modeInputs.forEach(input => input.addEventListener('change', () => {
    if (!input.checked || !plans) return;
    showReplaceConfirm(false);
    renderPlan(selectedMode());
  }));

  restoreButton?.addEventListener('click', () => {
    if (!plans || restoreButton.disabled) return;
    const mode = selectedMode();
    if (mode === 'replace') {
      const plan = plans.replace;
      pendingReplace = { plan, backup: parsedBackup, recoveryRaw: corruptRecovery?.libraryRaw };
      if (replaceMessage) {
        const willClearVisible = localEdition
          ? plan.stats.atlas.current > 0 && plan.stats.atlas.total === 0
          : plan.stats.willClearAll;
        replaceMessage.textContent = localEdition
          ? (willClearVisible
              ? '备份为空，覆盖后会清空全部本地法典收藏。建议先导出当前备份。'
              : `覆盖将删除当前设备中未出现在备份里的 ${plan.stats.atlas.removed} 条本地法典收藏。建议先导出当前备份。`)
          : (willClearVisible
              ? '备份为空，覆盖后会清空法典图鉴与共创广场的全部收藏。建议先导出当前备份。'
              : `覆盖将删除当前设备中未出现在备份里的 ${plan.stats.atlas.removed} 条法典收藏和 ${plan.stats.community.removed} 条共创收藏。建议先导出当前备份。`);
      }
      if (replaceMessage) {
        replaceMessage.textContent = corruptRecovery
          ? '当前收藏数据无法读取。确认覆盖后，将用选中的备份替换当前收藏、收藏夹、归类和备注。'
          : replaceMessage.textContent + ' 收藏夹、归类和备注将按备份恢复。';
      }
      showReplaceConfirm(true);
      replaceBack?.focus();
      return;
    }
    restore(plans.merge);
  });

  replaceBack?.addEventListener('click', () => {
    showReplaceConfirm(false);
    restoreButton?.focus();
  });
  replaceConfirmButton?.addEventListener('click', () => {
    if (pendingReplace) restore(pendingReplace.plan, pendingReplace.backup, pendingReplace.recoveryRaw);
  });

  subscribeFavoritesChanges('atlas', refreshCounts);
  if (!localEdition) {
    subscribeFavoritesChanges('community', refreshCounts);
    setupFavoritesOriginMigration({
      getCodexes: resolveCodexes,
      onChanged: scopes => emitFavoritesChanged(scopes),
      refreshCounts,
      onStatus: setStatus,
      onError: setError,
      onBusy: setBusy,
    });
  }
  refreshCounts().catch(error => console.error(error));
}
