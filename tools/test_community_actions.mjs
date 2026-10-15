import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const stripImports = source => source.replace(/^import .*?;\r?\n/gm, '');
const buttons = [];
const notices = [];
let requests = 0;
let requestBody = null;
let finishRequest;

class Button {
  constructor() {
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.count = { textContent: '' };
    this.disabled = false;
  }
  setAttribute(key, value) { this.attributes.set(key, value); }
  querySelector(selector) { return selector === '[data-like-count]' ? this.count : null; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
}

const originalDocument = globalThis.document;
const originalStorage = globalThis.localStorage;
const originalFetch = globalThis.fetch;
globalThis.document = {
  createElement() { const button = new Button(); buttons.push(button); return button; },
  querySelectorAll() { return buttons; },
  addEventListener() {},
};
globalThis.localStorage = { getItem: () => '1' };
globalThis.__communityActionsTest = { notices };

try {
  const likesSource = stripImports(await readFile(new URL('../site/assets/community/likes.js', import.meta.url), 'utf8'));
  const likes = await import(moduleUrl(`const console = { warn() {} };\nconst toast = (...args) => globalThis.__communityActionsTest.notices.push(args);\n${likesSource}`));
  globalThis.__communityActionsTest.createLikeButton = likes.createLikeButton;
  const actionsSource = stripImports(await readFile(new URL('../site/assets/app/community-actions.js', import.meta.url), 'utf8'));
  const actions = await import(moduleUrl(`
const toast = () => {};
const isMaskOpen = () => false;
const createLikeButton = globalThis.__communityActionsTest.createLikeButton;
${actionsSource}`));

  let entries = [{ id: 'public-a', communityId: 'public-a', communityFeatures: { likes: true }, liked: false, likeCount: 2 }];
  actions.initCommunityActions({ getEntries: () => entries });
  const clone = { ...entries[0], liked: true, likeCount: 88 };
  const button = actions.createCommunityLikeButton(clone);
  assert.equal(button.count.textContent, '2', '虚拟词条副本必须读取当前投稿的喜欢状态');
  assert.equal(button.attributes.get('aria-pressed'), 'false');
  assert.equal(actions.createCommunityLikeButton({ id: 'ordinary-entry' }), null);
  assert.equal(actions.createCommunityLikeButton({ communityId: 'disabled', communityFeatures: { likes: false } }), null);

  globalThis.fetch = async (url, init) => {
    requests += 1;
    requestBody = { url, init };
    return new Promise(resolve => { finishRequest = resolve; });
  };
  const click = () => button.listeners.get('click')({ preventDefault() {}, stopPropagation() {} });
  click();
  click();
  assert.equal(requests, 1, '同一投稿请求未完成时不能重复发送');
  assert.equal(requestBody.url, '/api/community-likes/public-a');
  assert.equal(requestBody.init.method, 'PUT');
  assert.equal(requestBody.init.credentials, 'same-origin');
  assert.equal(button.disabled, true);
  assert.equal(button.count.textContent, '3');
  assert.equal(clone.liked, true);

  // 刷新列表换掉词条对象后，在途喜欢响应仍必须同步到新对象。
  entries = [{ ...entries[0], liked: false, likeCount: 2 }];
  finishRequest({ ok: true, status: 200, json: async () => ({ ok: true, id: 'public-a', liked: true, likeCount: 7 }) });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(entries[0].likeCount, 7);
  assert.equal(entries[0].liked, true);
  assert.equal(button.count.textContent, '7');
  assert.equal(button.disabled, false);

  click();
  assert.equal(requestBody.init.method, 'DELETE', '旧按钮再次点击必须按当前源条目取消喜欢');
  assert.equal(entries[0].likeCount, 6);
  finishRequest({ ok: false, status: 503, json: async () => ({ error: 'busy' }) });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(entries[0].likeCount, 7, '失败必须回滚计数');
  assert.equal(clone.liked, true, '失败必须回滚词条副本');
  assert.equal(button.attributes.get('aria-pressed'), 'true');
  assert.equal(button.disabled, false);
  assert.equal(notices.at(-1)?.[0], '喜欢操作未完成，稍后重试');

  entries[0].communityFeatures = { likes: false };
  click();
  assert.equal(requests, 2, '后台关闭喜欢后，已渲染按钮也不能再发请求');

  const list = { innerHTML: '' };
  const panel = new Button();
  panel.isConnected = false;
  panel.querySelector = selector => selector === '.my-submissions-list' ? list : null;
  const opened = [];
  const closed = [];
  globalThis.document = {
    activeElement: null,
    createElement: () => panel,
    body: { appendChild: node => { node.isConnected = true; } },
    querySelectorAll: () => [],
  };
  globalThis.__communityActionsTest.opened = opened;
  globalThis.__communityActionsTest.closed = closed;
  const submissionsSource = stripImports(await readFile(new URL('../site/assets/community/my-submissions.js', import.meta.url), 'utf8'));
  const submissions = await import(moduleUrl(`
const bindBackdropDismiss = () => {};
const trapFocus = () => {};
const openMask = (...args) => globalThis.__communityActionsTest.opened.push(args);
const closeMask = (...args) => globalThis.__communityActionsTest.closed.push(args);
const readOwnedRecords = () => [{ id: 'public-a', title: '我的作品', createdAt: 1 }];
const escHtml = value => String(value);
${submissionsSource}`));
  let allowOpen = false;
  const routed = [];
  submissions.initMySubmissions({
    bindTriggers: false,
    maskClass: 'community-mask community-action-mask',
    getEntries: () => entries,
    openEntry: (entry, options) => { routed.push({ entry, options }); return allowOpen; },
  });
  assert.equal(panel.className, 'community-mask community-action-mask');
  assert.match(list.innerHTML, /已发布/);
  submissions.openMySubmissions(null, { historyMode: 'replace' });
  assert.deepEqual(opened.at(-1)?.[2], { historyMode: 'replace' }, '投稿成功后查看我的投稿应替换当前历史层');
  const row = new Button();
  row.removeAttribute = key => row.attributes.delete(key);
  row.dataset.mySubmissionId = 'public-a';
  const clickRow = () => panel.listeners.get('click')({ target: { closest: () => row } });
  await clickRow();
  assert.equal(closed.length, 0, '主站分级拒绝打开时不能关闭我的投稿面板');
  assert.equal(routed.at(-1)?.options.consumeLayer, true);
  allowOpen = true;
  await clickRow();
  assert.deepEqual(closed.at(-1)?.[1], { historyMode: 'none' }, '详情路由消费历史层后不能再触发 Back');
  entries = [];
  submissions.renderMySubmissions();
  assert.match(list.innerHTML, /尚未公开/);
  assert.doesNotMatch(list.innerHTML, /is-published/);
} finally {
  globalThis.document = originalDocument;
  globalThis.localStorage = originalStorage;
  globalThis.fetch = originalFetch;
  delete globalThis.__communityActionsTest;
}

console.log('community actions: PASS');
