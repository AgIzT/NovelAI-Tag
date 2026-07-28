import assert from 'node:assert/strict';
import { homeShortcutCopy, homeShortcutPlatform } from '../site/assets/app/home-shortcut.js';

assert.equal(homeShortcutPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'ios');
assert.equal(homeShortcutPlatform('Mozilla/5.0 (Linux; Android 15; Pixel 9)'), 'android');
assert.equal(homeShortcutPlatform('Desktop', { platform: 'MacIntel', maxTouchPoints: 5 }), 'ios');
assert.equal(homeShortcutPlatform('Desktop', { platform: 'Win32', maxTouchPoints: 0 }), 'generic');
assert.match(homeShortcutCopy('ios').steps.join(' '), /Safari.*分享.*添加到主屏幕/);
assert.match(homeShortcutCopy('android').steps.join(' '), /Chrome.*⋮.*添加到主屏幕/);
assert.equal(homeShortcutCopy('generic').steps.length, 3);

console.log('home shortcut tests passed');
