// 屏蔽清单的 DOM 身份、焦点与动效生命周期；真实插值由浏览器回归验证。
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { state } from '../site/assets/app/state.js';
import { BLOCKING_STORAGE_KEY } from '../site/assets/app/content-blocking-core.js';
import { loadContentBlocking, removeBlockedWord, restoreContentEntry, receiveBlockingStorage } from '../site/assets/app/content-blocking.js';
import { setupContentBlocking, openBlockingManager } from '../site/assets/app/content-blocking-ui.js';

const allAnimations = [];
let reduced = false;
function style() {
  let values = {};
  return new Proxy({}, {
    get: (_, key) => key === 'cssText' ? JSON.stringify(values)
      : key === 'setProperty' ? (name, value) => { values[name] = value; } : values[key] || '',
    set: (_, key, value) => { if (key === 'cssText') values = JSON.parse(value || '{}'); else values[key] = value; return true; },
  });
}
class Element extends EventTarget {
  constructor(tag = 'div', id = '') {
    super();
    Object.assign(this, { tag, id, children: [], dataset: {}, attrs: {}, style: style(), hidden: false, inert: false });
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
      toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
    };
  }
  append(...children) { children.forEach(child => this.insertBefore(child, null)); }
  insertBefore(child, anchor) {
    child.remove();
    this.children.splice(anchor ? this.children.indexOf(anchor) : this.children.length, 0, child);
    child.parentElement = this;
  }
  remove() {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  contains(target) { for (let node = target; node; node = node.parentElement) if (node === this) return true; return false; }
  get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
  set innerHTML(value) {
    assert.equal(this.tag, 'li', '只在创建单个条目时写模板，不可重建整个清单');
    const button = new Element('button');
    if (value.startsWith('<span>')) this.append(new Element('span'), button);
    else { const labels = new Element('div'); labels.append(new Element('b'), new Element('span')); this.append(labels, button); }
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  closest(selector) {
    assert.equal(selector, '[inert]');
    for (let node = this; node; node = node.parentElement) if (node.inert) return node;
    return null;
  }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith('#') ? node.id === selector.slice(1)
      : selector.startsWith('.') ? node.classList.contains(selector.slice(1))
        : selector === '[data-blocking-tab]' ? Boolean(node.dataset.blockingTab) : node.tag === selector;
    const found = [];
    const visit = node => node.children.forEach(child => { if (matches(child)) found.push(child); visit(child); });
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { if (this.isConnected && !this.closest('[inert]')) document.activeElement = this; }
  getBoundingClientRect() {
    const liveRows = list => list.children.filter(row => row.style.position !== 'absolute');
    if (this.tag === 'li') {
      const index = liveRows(this.parentElement).indexOf(this);
      return { left: 100 + index * 100, top: 200, width: 90, height: 28 };
    }
    const height = this.classList.contains('blocking-views')
      ? (!nodes.blockingWordsPanel.hidden ? 200 + liveRows(nodes.blockingWordList).length * 28 : 40 + liveRows(nodes.blockingEntryList).length * 50)
      : 100;
    return { left: 100, top: 200, width: 400, height };
  }
  animate(frames, options) {
    let resolve;
    let reject;
    const animation = {
      element: this, frames, options, cancelled: false,
      finished: new Promise((yes, no) => { resolve = yes; reject = no; }),
      cancel() { this.cancelled = true; reject(new Error('cancelled')); },
      finish: () => resolve(),
    };
    allAnimations.push(animation);
    return animation;
  }
}

globalThis.HTMLElement = Element;
globalThis.MutationObserver = class { observe() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.getComputedStyle = () => ({ opacity: '1', translate: 'none' });
globalThis.window = { matchMedia: () => ({ matches: reduced }), addEventListener() {} };
globalThis.document = {
  body: new Element(), documentElement: new Element(), activeElement: null,
  querySelector: selector => document.body.querySelector(selector), createElement: tag => new Element(tag), addEventListener() {},
};
document.activeElement = document.body;
const nodes = {};
const add = (id, parent = document.body, tag = 'div') => { const node = new Element(tag, id); nodes[id] = node; parent.append(node); return node; };
const mask = add('contentBlocking');
mask.hidden = true;
add('blockingReveal').hidden = true;
const shell = add('blockingViews', mask);
shell.classList.add('blocking-views');
const tabs = add('blockingTabs', mask);
tabs.classList.add('blocking-tabs');
for (const [kind, title] of [['words', 'Words'], ['entries', 'Entries']]) {
  const tab = add(`blocking${title}Tab`, tabs, 'button');
  tab.dataset.blockingTab = kind;
  const panel = add(`blocking${title}Panel`, shell);
  add(`blocking${title === 'Words' ? 'Word' : 'Entry'}List`, panel, 'ul');
  add(`blocking${title}Empty`, panel);
}
for (const id of ['blockingWordForm', 'blockingWordInput', 'blockingWordError']) add(id, nodes.blockingWordsPanel);
add('blockingMoreEntries', nodes.blockingEntriesPanel, 'button');
for (const id of ['blockingEnabled', 'blockingPaused', 'blockingClose']) add(id, mask);
for (const id of ['blockingSettingsBtn', 'blockingResultBtn', 'blockingSettingsSummary', 'blockingRevealClose', 'blockingRevealCancel', 'blockingRevealManage']) add(id);
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
const save = (words, entries = []) => storage.set(BLOCKING_STORAGE_KEY, JSON.stringify({ version: 1, enabled: true, words, entries }));
save(['alpha', 'beta', 'gamma']);
state.list = [{}];
loadContentBlocking();
setupContentBlocking();
openBlockingManager();
const wordRows = () => nodes.blockingWordList.children.filter(row => !row.inert);
const running = () => allAnimations.filter(animation => !animation.cancelled);
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

const [alpha, beta, gamma] = wordRows();
beta.querySelector('button').focus();
removeBlockedWord('alpha');
assert.deepEqual(wordRows(), [beta, gamma], '未删除的节点保持身份');
assert.equal(document.activeElement, beta.querySelector('button'), '未删除的按钮保持焦点');
assert.equal(alpha.inert, true);
assert.equal(alpha.getAttribute('aria-hidden'), 'true');
assert.equal(alpha.querySelector('button').dataset.removeWord, undefined);
assert.equal(alpha.querySelector('button').disabled, true);
assert.equal(running().find(animation => animation.element === beta).frames[0].translate, '100px 0px', '余项从之前的位置补位');
const stale = [...running()];
removeBlockedWord('beta');
assert.equal(alpha.isConnected, false, '快速删除先收掉上一轮残影');
assert.equal(document.activeElement, gamma.querySelector('button'), '删除焦点项后落到相邻项');
stale.forEach(animation => animation.finish());
await flush();
assert.equal(gamma.isConnected, true, '上一轮回调不能移除新一轮保留项');

nodes.blockingEntriesTab.onclick();
const firstSwitch = [...running()];
assert.equal(nodes.blockingWordsPanel.inert, true, '离流的旧页立即退出焦点循环');
assert.equal(nodes.blockingWordsPanel.hidden, false, '普通模式保留短暂视觉退场');
assert.ok(firstSwitch.some(animation => animation.element === shell && animation.frames[0].height !== animation.frames[1].height));
nodes.blockingWordsTab.onclick();
firstSwitch.forEach(animation => animation.finish());
await flush();
assert.equal(nodes.blockingWordsPanel.hidden, false, '快速切回后旧轮不能收起当前页');
assert.equal(nodes.blockingWordsPanel.inert, false);
nodes.blockingClose.onclick();
assert.equal(running().length, 0, '关闭结清所有局部动画');
assert.equal(shell.style.overflow, '');
openBlockingManager();
assert.equal(wordRows()[0], gamma, '重开复用节点且不残留前一轮样式');

gamma.querySelector('button').focus();
save(['delta']);
receiveBlockingStorage({ key: BLOCKING_STORAGE_KEY, storageArea: localStorage });
assert.equal(document.activeElement, wordRows()[0].querySelector('button'), '外部更新删除焦点项后提供可操作的替代焦点');
await sleep(350);
assert.equal(gamma.isConnected, false, '动画时间线冻结时仍由计时兜底回收');
assert.equal(running().length, 0);
assert.equal(shell.style.overflow, '');

for (const mode of ['reduce', 'motion-off']) {
  reduced = mode === 'reduce';
  document.documentElement.classList.toggle('motion-off', mode === 'motion-off');
  nodes.blockingEntriesTab.onclick();
  assert.equal(nodes.blockingWordsPanel.hidden, true, `${mode} 直接隐藏旧页`);
  assert.equal(running().length, 0, `${mode} 不建立 WAAPI 动画`);
  nodes.blockingWordsTab.onclick();
}
wordRows()[0].querySelector('button').focus();
removeBlockedWord('delta');
assert.equal(nodes.blockingWordList.children.length, 0, '关闭动效时删除直接终态，无残影');
assert.equal(document.activeElement, nodes.blockingWordInput, '最后一项删除后回到添加入口');
reduced = false;
document.documentElement.classList.remove('motion-off');
save([], ['first', 'second'].map(key => ({ key: `book:${key}`, codexId: 'book', title: key, codexTitle: 'Book' })));
receiveBlockingStorage({ key: BLOCKING_STORAGE_KEY, storageArea: localStorage });
nodes.blockingEntriesTab.onclick();
const [firstEntry, secondEntry] = nodes.blockingEntryList.children;
firstEntry.querySelector('button').focus();
restoreContentEntry('book:first');
assert.equal(firstEntry.inert, true);
assert.equal(firstEntry.querySelector('button').dataset.restoreEntry, undefined, '恢复后残影不可重复提交');
assert.equal(nodes.blockingEntryList.children[0], secondEntry, '恢复条目复用剩余行');
assert.equal(document.activeElement, secondEntry.querySelector('button'));
restoreContentEntry('book:second');
assert.equal(document.activeElement, nodes.blockingEntriesTab, '恢复末项后回到页签');
await sleep(350);
assert.equal(nodes.blockingEntryList.children.length, 0);
assert.equal(running().length, 0);
console.log('blocking manager: keyed nodes, FLIP intent, inert exits, focus, rapid tabs, close/reopen, storage, timeout and reduced motion passed');
