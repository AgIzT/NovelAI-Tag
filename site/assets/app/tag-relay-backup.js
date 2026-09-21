import { toast } from './feedback.js';
import { requestRelayAction } from './tag-relay-action.js';
import { exportRelayBackup, importRelayBackup, validateRelayBackup } from './tag-relay-v4.js';
import { commitRelay, getRelayStorageIssue, relayState } from './tag-relay-store.js';

const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const bindings = new WeakMap();

function backupError(error) {
  if (error?.reason === 'future-version') return '这份备份来自更新版本，请更新页面后再恢复';
  return '备份格式不正确，请选择中转站导出的 JSON 文件';
}

function dateStamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export function setupRelayBackup(scope, { beforeAction = async () => true, afterRestore = async () => {} } = {}) {
  const menu = scope?.querySelector('#relayPlanMenu');
  if (!menu) return;
  const existing = bindings.get(menu);
  if (existing) {
    existing.beforeAction = beforeAction;
    existing.afterRestore = afterRestore;
    return;
  }
  const binding = { beforeAction, afterRestore, busy: false };
  bindings.set(menu, binding);

  const makeButton = (id, label) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    menu.append(button);
    return button;
  };
  const exportButton = makeButton('relayExportBackup', '导出方案备份');
  const importButton = makeButton('relayImportBackup', '恢复方案备份');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'relayBackupFile';
  fileInput.accept = '.json,application/json';
  fileInput.hidden = true;
  fileInput.tabIndex = -1;
  scope.append(fileInput);

  const menuButton = () => scope.querySelector('#relayPlanMenuBtn');
  const closeMenu = () => {
    menu.hidden = true;
    menuButton()?.setAttribute('aria-expanded', 'false');
    menuButton()?.focus({ preventScroll: true });
  };
  const setBusy = busy => {
    binding.busy = busy;
    exportButton.disabled = busy;
    importButton.disabled = busy;
  };
  const flush = async () => {
    try {
      return await binding.beforeAction() !== false;
    } catch {
      toast('当前输入未能保存，请重试后再操作备份', '!');
      return false;
    }
  };

  exportButton.addEventListener('click', async () => {
    if (binding.busy) return;
    closeMenu();
    setBusy(true);
    let url = '';
    let link = null;
    try {
      const issue = getRelayStorageIssue();
      if (issue) {
        const message = issue === 'future-version'
          ? '方案数据来自更新版本，暂不能导出，请更新页面后重试'
          : issue === 'corrupt-data'
            ? '本机方案数据无法读取，暂不能导出；原始数据已保留'
            : '浏览器存储无法读取，暂不能导出备份';
        toast(message, '!');
        return;
      }
      if (!await flush()) return;
      const payload = exportRelayBackup(relayState());
      url = URL.createObjectURL(new Blob([payload], { type: 'application/json;charset=utf-8' }));
      link = document.createElement('a');
      link.href = url;
      link.download = `novelai-tag-relay-${dateStamp()}.json`;
      link.hidden = true;
      scope.append(link);
      link.click();
      toast('已导出中转站方案备份', '✓');
    } catch {
      toast('备份导出失败，请重试', '!');
    } finally {
      link?.remove();
      // 留出浏览器接管下载的时间，避免部分浏览器拿到已撤销的地址。
      if (url) setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setBusy(false);
    }
  });

  importButton.addEventListener('click', () => {
    if (binding.busy) return;
    closeMenu();
    fileInput.value = '';
    // 文件选择器必须直接响应这次点击，不能放到异步保存之后再打开。
    fileInput.click();
  });
  fileInput.addEventListener('cancel', () => menuButton()?.focus({ preventScroll: true }));
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file || binding.busy) return;
    if (file.size > MAX_BACKUP_BYTES) {
      toast('备份文件过大，请选择不超过 20 MB 的 JSON 文件', '!');
      return;
    }
    setBusy(true);
    try {
      let raw;
      try {
        raw = await file.text();
      } catch {
        toast('备份文件读取失败，请重新选择文件', '!');
        return;
      }
      let backup;
      try {
        backup = validateRelayBackup(raw);
      } catch (error) {
        toast(backupError(error), '!');
        return;
      }
      const accepted = await requestRelayAction({
        title: '恢复中转站备份？',
        message: `备份含 ${backup.plans.length} 个方案、${backup.inbox.length} 条最近复制、${backup.history.length} 条成品记录。现有方案会保留，恢复的方案另存为副本。`,
        confirmLabel: '恢复为副本',
        trigger: menuButton(),
      });
      if (!accepted || !await flush()) return;
      const action = await commitRelay(next => importRelayBackup(next, raw), { changed: 'all' });
      if (!action.ok) return;
      await binding.afterRestore(action.result);
      toast(`已恢复 ${action.result?.planCount || 0} 个方案副本`, '✓');
    } catch {
      toast('备份恢复未完成，请重试', '!');
    } finally {
      setBusy(false);
    }
  });
}
