import { closeMask, openMask, trapFocus } from './modal.js';
import { isTouchPrimaryInput } from './utils.js';

export function homeShortcutPlatform(userAgent = globalThis.navigator?.userAgent || '', navigatorLike = globalThis.navigator) {
  const ua = String(userAgent || '');
  const ipadDesktop = navigatorLike?.platform === 'MacIntel' && Number(navigatorLike?.maxTouchPoints) > 1;
  const platform = /iPhone|iPad|iPod/i.test(ua) || ipadDesktop
    ? 'ios'
    : /Android/i.test(ua)
      ? 'android'
      : 'generic';
  const embedded = /MicroMessenger|QQ\//i.test(ua)
    || (platform === 'android' && /;\s*wv\)/i.test(ua));
  return embedded ? `${platform}-webview` : platform;
}

export function homeShortcutCopy(platform) {
  if (String(platform).endsWith('-webview')) {
    const ios = String(platform).startsWith('ios');
    const browser = ios ? 'Safari' : 'Chrome';
    return {
      title: `先用 ${browser} 打开本站`,
      steps: [
        '点右上角“…”菜单，选择“在浏览器中打开”',
        `如果没有这个选项，请复制当前链接并粘贴到 ${browser}`,
        ios
          ? '在 Safari 点“分享”→“添加到主屏幕”→“添加”'
          : '在 Chrome 点右上角“⋮”→“添加到主屏幕”并确认',
      ],
    };
  }
  if (platform === 'ios') {
    return {
      title: '装进 iPhone / iPad 主屏幕',
      steps: ['用 Safari 打开本站', '点浏览器的“分享”按钮', '选择“添加到主屏幕”，再点“添加”'],
    };
  }
  if (platform === 'android') {
    return {
      title: '装进 Android 主屏幕',
      steps: ['用 Chrome 打开本站', '点右上角“⋮”菜单', '选择“添加到主屏幕”并确认'],
    };
  }
  return {
    title: '把法典图鉴放到主屏幕',
    steps: ['打开浏览器菜单或分享菜单', '寻找“添加到主屏幕”或“创建快捷方式”', '按浏览器提示确认'],
  };
}

function isStandalone() {
  return Boolean(globalThis.matchMedia?.('(display-mode: standalone)').matches || globalThis.navigator?.standalone);
}

function ensurePanel() {
  let mask = document.getElementById('homeShortcutHelp');
  if (mask) return mask;
  const copy = homeShortcutCopy(homeShortcutPlatform());
  mask = document.createElement('div');
  mask.id = 'homeShortcutHelp';
  mask.className = 'settings-mask';
  mask.hidden = true;
  mask.innerHTML = `
    <section class="settings-panel home-shortcut-panel" role="dialog" aria-modal="true" aria-labelledby="homeShortcutTitle">
      <button class="settings-close" type="button" data-home-shortcut-close aria-label="关闭">×</button>
      <img src="assets/icon-180.png" width="72" height="72" alt="">
      <h2 id="homeShortcutTitle" class="settings-title"></h2>
      <p class="settings-note">这是浏览器快捷方式，不含离线缓存；没有网络时仍需重新联网。</p>
      <ol></ol>
      <button class="nsfw-primary" type="button" data-home-shortcut-close>知道了</button>
    </section>`;
  mask.querySelector('#homeShortcutTitle').textContent = copy.title;
  const list = mask.querySelector('ol');
  copy.steps.forEach(step => {
    const item = document.createElement('li');
    item.textContent = step;
    list.appendChild(item);
  });
  document.body.appendChild(mask);
  const close = () => closeMask(mask);
  mask.querySelectorAll('[data-home-shortcut-close]').forEach(button => button.addEventListener('click', close));
  mask.addEventListener('click', event => { if (event.target === mask) close(); });
  mask.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    trapFocus(event, mask);
  });
  return mask;
}

export function setupHomeShortcutGuide() {
  const button = document.getElementById('homeShortcutBtn');
  if (!button) return;
  const available = isTouchPrimaryInput() && !isStandalone() && !document.body.classList.contains('local-edition');
  button.hidden = !available;
  if (!available || button.dataset.bound === '1') return;
  button.dataset.bound = '1';
  button.addEventListener('click', () => openMask(ensurePanel(), button));
}
