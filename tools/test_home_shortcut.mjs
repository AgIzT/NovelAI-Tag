import assert from 'node:assert/strict';
import { homeShortcutCopy, homeShortcutPlatform } from '../site/assets/app/home-shortcut.js';
import { isTouchPrimaryInput } from '../site/assets/app/utils.js';

assert.equal(homeShortcutPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'ios');
assert.equal(homeShortcutPlatform('Mozilla/5.0 (Linux; Android 15; Pixel 9)'), 'android');
assert.equal(homeShortcutPlatform('Desktop', { platform: 'MacIntel', maxTouchPoints: 5 }), 'ios');
assert.equal(homeShortcutPlatform('Desktop', { platform: 'Win32', maxTouchPoints: 0 }), 'generic');
assert.equal(
  homeShortcutPlatform('Mozilla/5.0 (iPhone) MicroMessenger/8.0.50'),
  'ios-webview',
);
assert.equal(
  homeShortcutPlatform('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit QQ/9.1.20'),
  'android-webview',
);
assert.equal(
  homeShortcutPlatform('Mozilla/5.0 (Linux; Android 15; wv) Version/4.0'),
  'android-webview',
);
assert.match(homeShortcutCopy('ios').steps.join(' '), /Safari.*分享.*添加到主屏幕/);
assert.match(homeShortcutCopy('android').steps.join(' '), /Chrome.*⋮.*添加到主屏幕/);
assert.match(homeShortcutCopy('ios-webview').steps.join(' '), /在浏览器中打开.*复制当前链接.*Safari/);
assert.match(homeShortcutCopy('android-webview').steps.join(' '), /在浏览器中打开.*复制当前链接.*Chrome/);
assert.equal(homeShortcutCopy('generic').steps.length, 3);

assert.equal(isTouchPrimaryInput({
  navigatorApi: { maxTouchPoints: 10 },
  matchMediaApi: () => ({ matches: false }),
}), false, '触屏 Windows 笔记本仍以精细主指针为准');
assert.equal(isTouchPrimaryInput({
  navigatorApi: { maxTouchPoints: 0 },
  matchMediaApi: () => ({ matches: true }),
}), true);
assert.equal(isTouchPrimaryInput({
  navigatorApi: { maxTouchPoints: 1 },
  matchMediaApi: null,
}), true, 'matchMedia 不可用时才退回触点数');

console.log('home shortcut tests passed');
