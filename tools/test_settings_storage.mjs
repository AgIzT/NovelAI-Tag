// 调用实际 UI 绑定和偏好 setter，故障时保持屏、盘与控件一致。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as states from '../site/assets/app/state.js';

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
let moduleId = 0;
async function load(path, dependencies = {}) {
  const names = new Set();
  const source = (await readFile(new URL(`../site/assets/${path}`, import.meta.url), 'utf8'))
    .replace(/^import\s*\{([\s\S]*?)\}\s*from\s*'[^']+';/gm, (_all, list) => {
      list.split(',').map(name => name.trim()).filter(Boolean).forEach(name => names.add(name));
      return '';
    });
  assert.doesNotMatch(source, /^import /m);
  const key = `__settings${++moduleId}`;
  globalThis[key] = Object.fromEntries([...names].map(name => [name, dependencies[name] ?? (() => {})]));
  return import(moduleUrl(`const {${[...names].join(',')}} = globalThis.${key};\n${source}`));
}
class Element {
  constructor(dataset = {}) {
    this.dataset = dataset; this.checked = false; this.disabled = false; this.hidden = true;
    this.value = ''; this.textContent = ''; this.innerHTML = ''; this.attributes = new Map();
    this.handlers = new Map(); this.style = {}; this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !this.classes.has(name) : Boolean(force);
        if (on) this.classes.add(name); else this.classes.delete(name);
        return on;
      },
    };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  replaceChildren() {}
  addEventListener(type, listener) { this.handlers.set(type, listener); }
  closest() { return null; }
  focus() {}
  contains() { return false; }
}
const elements = new Map();
const $ = selector => {
  if (!elements.has(selector)) elements.set(selector, new Element());
  return elements.get(selector);
};
const lists = {
  '[data-density]': ['comfort', 'standard', 'compact'].map(density => new Element({ density })),
  '#darkModeControl [data-dark-mode]': ['auto', 'light', 'dark'].map(darkMode => new Element({ darkMode })),
  '#themeControl [data-theme]': states.THEMES.map(theme => new Element({ theme: theme.id })),
  '#fontControl [data-font]': states.FONTS.map(font => new Element({ font: font.id })),
};
const windowListeners = new Map();
const mediaListeners = new Map();
globalThis.window = {
  innerWidth: 1100, innerHeight: 800, scrollY: 0,
  matchMedia: query => ({ matches: false, addEventListener: (name, fn) => mediaListeners.set(query + name, fn) }),
  addEventListener: (type, fn) => {
    const listeners = windowListeners.get(type) || []; listeners.push(fn); windowListeners.set(type, listeners);
  },
};
globalThis.document = {
  body: new Element(), documentElement: new Element(), activeElement: null,
  querySelector: $, querySelectorAll: selector => lists[selector] || [],
  addEventListener() {}, createElement: () => new Element(),
};
globalThis.requestAnimationFrame = () => 0;
const disk = new Map([
  ['fadian-density', 'standard'], ['fadian-dark-mode', 'light'], ['fadian-dark', '0'],
  ['fadian-theme', ''], ['fadian-font', ''], ['fadian-sdmode', '0'], ['fadian-card-zoom', '0'],
  ['fadian-search-scope', 'site'], ['fadian-tag-zh', '1'], ['fadian-sidebar', 'open'],
  [states.NSFW_STORAGE_KEY, '0'], [states.R18G_STORAGE_KEY, '0'],
]);
let fault = null;
const storage = {
  getItem(key) {
    if (fault?.kind === 'read' && fault.key === key) throw new DOMException('denied', 'SecurityError');
    if (fault?.kind === 'readback' && fault.key === key && fault.written) {
      fault.written = false;
      fault.used = true;
      throw new DOMException('denied', 'SecurityError');
    }
    return disk.get(key) ?? null;
  },
  setItem(key, value) {
    if (fault?.key === key && fault.kind === 'quota') throw new DOMException('full', 'QuotaExceededError');
    if (fault?.key === key && fault.kind === 'drop') return;
    disk.set(key, String(value));
    if (fault?.key === key && fault.kind === 'readback' && !fault.used) fault.written = true;
  },
  removeItem: key => disk.delete(key),
};
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true, get() {
    if (fault?.kind === 'property') throw new DOMException('denied', 'SecurityError');
    return storage;
  },
});
const toasts = [];
const deps = { ...states, $, toast: message => toasts.push(message), prefersReducedMotion: () => true };
let preferences = {};
try {
  const { writeStorageTransaction } = await load('app/storage-coordinator.js');
  preferences = await load('app/preferences-storage.js', { ...deps, writeStorageTransaction });
} catch (error) {
  if (error.code !== 'ENOENT') throw error; // 首次在修复前运行，生产模块尚不存在。
}
const zh = await load('app/tag-zh.js', { ...deps, ...preferences });
const sd = await load('app/sd-mode.js', { ...deps, ...preferences });
Object.assign(states.state, { density: 'standard', searchScope: 'site', sdMode: false, cardZoom: false, allowNsfw: false, allowR18g: false });
let revoked = 0;
const layers = new Map();
const ui = await load('app/ui.js', { ...deps, ...preferences, ...zh, ...sd,
  isNsfwPathSegment: value => value === 'R18', isR18gName: value => value === 'R18G',
  closeMask: mask => { mask.hidden = true; },
  registerHistoryLayer: (name, layer) => layers.set(name, layer),
});
ui.setUiActions({ refreshAccessView: ({ revoked: on }) => { if (on) revoked += 1; } });
ui.bindUI();
assert.equal(states.state.density, 'standard');
$('#nsfwConfirm').hidden = false;
const snapshot = () => ({
  state: [states.state.density, states.state.searchScope, states.state.sdMode, states.state.cardZoom, states.state.allowNsfw, states.state.allowR18g],
  classes: [...document.body.classes].sort(), colorScheme: document.documentElement.style.colorScheme,
  controls: [...elements].map(([key, el]) => [key, el.checked, el.disabled, el.hidden, el.innerHTML, [...el.classes].sort(), [...el.attributes]]),
  buttons: Object.values(lists).flat().map(el => [...el.attributes]),
  disk: [...disk], zh: zh.isTagZhEnabled(),
});
const toggle = (id, on) => () => { const el = $(id); el.checked = on; return el.onchange({ target: el }); };
const density = lists['[data-density]'].find(el => el.dataset.density === 'comfort');
const dark = lists['#darkModeControl [data-dark-mode]'].find(el => el.dataset.darkMode === 'dark');
const skin = lists['#themeControl [data-theme]'].find(el => el.dataset.theme === 'teal');
const font = lists['#fontControl [data-font]'].find(el => el.dataset.font === 'classic');
const cases = [
  ['density', 'fadian-density', () => density.onclick()],
  ['dark mode', 'fadian-dark-mode', () => dark.onclick()],
  ['dark mirror', 'fadian-dark', () => dark.onclick()],
  ['skin', 'fadian-theme', () => skin.onclick()],
  ['font', 'fadian-font', () => font.onclick()],
  ['SD', 'fadian-sdmode', toggle('#sdModeToggle', true)],
  ['card zoom', 'fadian-card-zoom', toggle('#cardZoomToggle', true)],
  ['search scope', 'fadian-search-scope', () => $('#searchScopeBtn').onclick()],
  ['tag zh', 'fadian-tag-zh', toggle('#tagZhSettingToggle', false)],
  ['sidebar', 'fadian-sidebar', () => $('#menuBtn').onclick()],
  ['NSFW', states.NSFW_STORAGE_KEY, () => $('#nsfwAccept').onclick()],
  ['adult confirmation', states.ADULT_CONFIRMATION_STORAGE_KEY, () => $('#nsfwAccept').onclick()],
];
for (const [label, key, action] of cases) {
  for (const kind of ['quota', 'read', 'property', 'drop', 'readback']) {
    const before = snapshot(); const firstToast = toasts.length;
    fault = { key, kind };
    assert.doesNotThrow(action, `${label} ${kind} 不应抛出未处理异常`);
    fault = null;
    assert.deepEqual(snapshot(), before, `${label} ${kind} 保持原状态、DOM、控件和持久化字节`);
    assert.match(toasts.slice(firstToast).join('\n'), /未保存.*重试/, `${label} ${kind} 显示失败反馈`);
  }
}
// 同一次偏好修改：失败补偿后恢复正常存储即可重试。
for (const [label, key, action] of cases.filter(([label]) => !['dark mirror', 'adult confirmation'].includes(label))) {
  action();
  const expected = {
    'fadian-density': 'comfort', 'fadian-dark-mode': 'dark', 'fadian-theme': 'teal',
    'fadian-font': 'classic', 'fadian-sdmode': '1', 'fadian-card-zoom': '1',
    'fadian-search-scope': 'codex', 'fadian-tag-zh': '0', 'fadian-sidebar': 'closed',
    [states.NSFW_STORAGE_KEY]: '1',
  };
  assert.equal(disk.get(key), expected[key], `${label} 故障恢复后重试真实落盘`);
}
assert.equal(states.state.density, 'comfort');
assert.equal(document.body.classList.contains('dark'), true);
assert.equal(document.body.classList.contains('theme-teal'), true);
assert.equal(document.body.classList.contains('font-classic'), true);
assert.equal(states.state.sdMode, true);
assert.equal(states.state.cardZoom, true);
assert.equal(states.state.searchScope, 'codex');
assert.equal(zh.isTagZhEnabled(), false);
assert.equal(states.state.allowNsfw, true);
assert.equal(disk.get(states.ADULT_CONFIRMATION_STORAGE_KEY), '1');

// 门控关闭失败不能显示“已锁定”；跨标签已落盘撤权仍立即清场且不反写。
$('#r18gConfirm').hidden = false;
for (let step = 0; step < 2; step += 1) $('#r18gNext').onclick();
for (const kind of ['quota', 'read', 'property', 'drop', 'readback']) {
  const before = snapshot(); fault = { key: states.R18G_STORAGE_KEY, kind };
  assert.doesNotThrow(() => $('#r18gNext').onclick()); fault = null;
  assert.deepEqual(snapshot(), before, `R18G 开启 ${kind} 失败保留确认层与旧偏好`);
}
$('#r18gNext').onclick();
assert.equal(states.state.allowR18g, true);
for (const [id, key] of [['#nsfwToggle', states.R18G_STORAGE_KEY], ['#r18gToggle', states.R18G_STORAGE_KEY]]) {
  const before = snapshot(); fault = { key, kind: 'quota' }; toggle(id, false)(); fault = null;
  assert.deepEqual(snapshot(), before, `${id} 关闭失败保持已保存权限与控件`);
}
const writesBeforeRevoke = [...disk];
for (const listener of windowListeners.get('storage') || []) listener({ key: states.NSFW_STORAGE_KEY, newValue: '0', storageArea: storage });
assert.equal(states.state.allowNsfw, false);
assert.equal(states.state.allowR18g, false);
assert.ok(revoked > 0);
assert.deepEqual([...disk], writesBeforeRevoke, '接收 storage 撤权不反写');

// Back 已离开历史层时无须写持久偏好，配额/属性拒绝仍同步关闭侧栏。
fault = { kind: 'property' };
assert.doesNotThrow(() => layers.get('mobile-sidebar').open());
assert.equal($('#sidebar').classList.contains('closed'), false);
assert.doesNotThrow(() => layers.get('mobile-sidebar').close());
assert.equal($('#sidebar').classList.contains('closed'), true);
states.state.allowNsfw = true; states.state.allowR18g = true;
assert.doesNotThrow(() => {
  for (const listener of windowListeners.get('storage') || []) listener({ key: null, storageArea: storage });
});
fault = null;
assert.equal(states.state.allowNsfw, false);
assert.equal(states.state.allowR18g, false);

// 初始读被拒仍能绑定；初始化不能误写默认值覆盖旧字节。
const saved = [...disk]; fault = { kind: 'property' };
assert.doesNotThrow(() => ui.bindUI()); fault = null;
assert.deepEqual([...disk], saved);

// 浏览器连补偿也拒绝时不能声称已恢复原字节，给出重新加载核对的反馈。
const brokenDisk = new Map([['mode', 'light'], ['mirror', '0']]);
const brokenStorage = {
  getItem: key => brokenDisk.get(key) ?? null,
  setItem(key, value) {
    if (key === 'mirror') throw new DOMException('full', 'QuotaExceededError');
    if (key === 'mode' && value === 'light') throw new DOMException('denied', 'SecurityError');
    brokenDisk.set(key, value);
  },
  removeItem: key => brokenDisk.delete(key),
};
assert.equal(preferences.writePreferences([
  { key: 'mode', value: 'dark' }, { key: 'mirror', value: '1' },
], { storage: brokenStorage }), false);
assert.match(toasts.at(-1), /未能完整保存.*重新加载.*检查设置/);
console.log(`settings storage regressions: PASS (${cases.length * 5 + 5} failure cases + retry + revocation + sidebar history)`);
