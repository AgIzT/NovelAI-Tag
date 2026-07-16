import { openMask, closeMask, trapFocus } from './modal.js';
import {
  closeHistoryLayer,
  forgetHistoryLayer,
  openHistoryLayer,
  registerHistoryLayer,
} from './browser-history.js';
import {
  ATLAS_FAVORITES_STORAGE_KEY,
  COMMUNITY_FAVORITES_STORAGE_KEY,
  FAVORITES_BACKUP_LIMITS,
  FavoritesBackupError,
  commitFavoritesRestore,
  createFavoritesRestorePlan,
  parseFavoritesBackup,
  readStoredFavorites,
  serializeFavoritesBackup,
} from './favorites-backup-core.js';

const CHANGE_EVENT = 'novelai-tag:favorites-changed';

const byId = id => document.getElementById(id);

function runCallback(callback, detail) {
  Promise.resolve(callback(detail)).catch(error => console.error(error));
}

export function subscribeFavoritesChanges(scope, callback) {
  if (!['atlas', 'community'].includes(scope) || typeof callback !== 'function') return () => {};
  const storageKey = scope === 'atlas' ? ATLAS_FAVORITES_STORAGE_KEY : COMMUNITY_FAVORITES_STORAGE_KEY;
  const onChanged = event => {
    const scopes = event.detail?.scopes || [];
    if (scopes.includes(scope)) runCallback(callback, event.detail || {});
  };
  const onStorage = event => {
    if (event.storageArea !== localStorage) return;
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

function emitFavoritesChanged(scopes) {
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, {
    detail: { scopes, reason: 'restore' },
  }));
}

function localDateStamp(now = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function downloadJson(text) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  if (blob.size > FAVORITES_BACKUP_LIMITS.maxFileBytes) {
    throw new FavoritesBackupError('FILE_TOO_LARGE', '生成的备份超过 2 MiB，无法导出');
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `novelai-tag-favorites-${localDateStamp()}.json`;
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
  const messages = {
    INVALID_JSON: '无法读取：文件不是有效的 JSON。',
    INVALID_FORMAT: '这不是法典图鉴的收藏备份。',
    UNSUPPORTED_VERSION: '该备份版本不受支持；如果版本较新，请更新站点后再试。',
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
    STORAGE_ROLLBACK_FAILED: '收藏写入失败，且无法完整恢复原数据；请立即重新导出当前收藏进行核对。',
  };
  return messages[error.code] || error.message || '备份内容无效，未进行恢复。';
}

function formatExportedAt(value) {
  if (!value) return '未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未记录' : date.toLocaleString('zh-CN');
}

function appendStatCard(root, title, stats, mode) {
  const card = document.createElement('section');
  card.className = 'favorites-backup-stat';
  const heading = document.createElement('b');
  heading.textContent = title;
  const detail = document.createElement('span');
  const parts = [
    `备份 ${stats.incoming} 条`,
    `当前 ${stats.current} 条`,
    `新增 ${stats.added} 条`,
    `已存在 ${stats.duplicate} 条`,
  ];
  if (mode === 'replace') parts.push(`将移除 ${stats.removed} 条`);
  detail.textContent = parts.join(' · ');
  card.append(heading, detail);
  root.appendChild(card);
}

export function setupFavoritesBackup(options = {}) {
  const panel = byId('favoritesBackupPanel');
  const triggers = [...document.querySelectorAll('[data-favorites-backup-open]')];
  if (!panel || !triggers.length || panel.dataset.bound === '1') return;
  panel.dataset.bound = '1';

  const closeButton = byId('favoritesBackupClose');
  const exportButton = byId('favoritesExportBtn');
  const fileInput = byId('favoritesImportFile');
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
  let busy = false;

  const setStatus = message => {
    if (!status) return;
    status.textContent = message || '';
    status.hidden = !message;
  };
  const setError = message => {
    if (!errorBox) return;
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
  };
  const setBusy = value => {
    busy = Boolean(value);
    panel.setAttribute('aria-busy', String(busy));
    if (fileInput) fileInput.disabled = busy;
    if (restoreButton) restoreButton.disabled = busy || restoreButton.dataset.noop === '1';
    if (replaceConfirmButton) replaceConfirmButton.disabled = busy;
    if (exportButton) exportButton.disabled = busy || exportButton.dataset.empty === '1';
  };

  const resolveCodexes = async () => {
    if (!codexesPromise) {
      codexesPromise = (async () => {
        try {
          const supplied = await options.getCodexes?.();
          if (Array.isArray(supplied) && supplied.length) return supplied;
          const response = await fetch('data/codexes.json', { cache: 'no-store' });
          if (!response.ok) throw new Error(`codex index ${response.status}`);
          const data = await response.json();
          return Array.isArray(data) ? data : [];
        } catch (error) {
          console.warn('收藏备份：法典别名索引暂不可用，将原样保留法典标识。', error);
          return [];
        }
      })();
    }
    return codexesPromise;
  };

  const readCurrent = async () => readStoredFavorites(localStorage, await resolveCodexes());

  const refreshCounts = async () => {
    const current = await readCurrent();
    if (currentAtlas) currentAtlas.textContent = String(current.atlasKeys.length);
    if (currentCommunity) currentCommunity.textContent = String(current.communityIds.length);
    const empty = current.atlasKeys.length + current.communityIds.length === 0;
    if (exportButton) {
      exportButton.dataset.empty = empty ? '1' : '0';
      exportButton.disabled = busy || empty;
      exportButton.title = empty ? '暂无收藏可备份' : '';
    }
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
    appendStatCard(grid, '法典图鉴', plan.stats.atlas, mode);
    appendStatCard(grid, '共创广场', plan.stats.community, mode);
    summary.appendChild(grid);

    if (plan.stats.unknownCodexCount) {
      const warning = document.createElement('p');
      warning.className = 'favorites-backup-warning';
      warning.textContent = `${plan.stats.unknownCodexCount} 条收藏来自当前未识别的法典，将原样保留。`;
      summary.appendChild(warning);
    }

    const noChange = plan.stats.all.added === 0 && plan.stats.all.removed === 0;
    restoreButton.dataset.noop = noChange ? '1' : '0';
    restoreButton.dataset.mode = mode;
    restoreButton.disabled = busy || noChange;
    restoreButton.textContent = mode === 'replace' ? '覆盖恢复' : '合并恢复';
    if (noChange) setStatus('无需恢复：备份中的收藏与当前收藏一致。');
    else setStatus('');
  };

  const resetImport = () => {
    selectedFileName = '';
    parsedBackup = null;
    plans = null;
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

  const restore = async plan => {
    setBusy(true);
    setError('');
    try {
      const result = commitFavoritesRestore(localStorage, plan);
      emitFavoritesChanged(['atlas', 'community']);
      await refreshCounts();
      if (preview) preview.hidden = true;
      showReplaceConfirm(false);
      if (plan.mode === 'replace') {
        setStatus(`覆盖完成：法典图鉴 ${result.atlasKeys.length} 条，共创广场 ${result.communityIds.length} 条。`);
      } else {
        setStatus(`恢复完成：新增 ${plan.stats.all.added} 条收藏，${plan.stats.all.duplicate} 条已存在。`);
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
  panel.addEventListener('click', event => {
    if (event.target === panel) close();
  });
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
      const current = readStoredFavorites(localStorage, codexes);
      if (!current.atlasKeys.length && !current.communityIds.length) {
        setStatus('暂无收藏可备份。');
        return;
      }
      downloadJson(serializeFavoritesBackup({
        atlasKeys: current.atlasKeys,
        communityIds: current.communityIds,
        codexes,
        exportedAt: new Date().toISOString(),
      }));
      setStatus(`备份已导出：法典图鉴 ${current.atlasKeys.length} 条，共创广场 ${current.communityIds.length} 条。`);
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
      const codexes = await resolveCodexes();
      parsedBackup = parseFavoritesBackup(await file.text(), codexes);
      const current = readStoredFavorites(localStorage, codexes);
      plans = {
        merge: createFavoritesRestorePlan({
          backup: parsedBackup,
          currentAtlasKeys: current.atlasKeys,
          currentCommunityIds: current.communityIds,
          mode: 'merge',
          codexes,
        }),
        replace: createFavoritesRestorePlan({
          backup: parsedBackup,
          currentAtlasKeys: current.atlasKeys,
          currentCommunityIds: current.communityIds,
          mode: 'replace',
          codexes,
        }),
      };
      if (preview) preview.hidden = false;
      renderPlan('merge');
      restoreButton?.focus();
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
      if (replaceMessage) {
        replaceMessage.textContent = plan.stats.willClearAll
          ? '备份为空，覆盖后会清空法典图鉴与共创广场的全部收藏。建议先导出当前备份。'
          : `覆盖将删除当前设备中未出现在备份里的 ${plan.stats.atlas.removed} 条法典收藏和 ${plan.stats.community.removed} 条共创收藏。建议先导出当前备份。`;
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
    if (plans?.replace) restore(plans.replace);
  });

  subscribeFavoritesChanges('atlas', refreshCounts);
  subscribeFavoritesChanges('community', refreshCounts);
  refreshCounts().catch(error => console.error(error));
}
