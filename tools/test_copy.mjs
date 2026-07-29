import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { writeClipboardText } from '../site/assets/app/clipboard.js';
import { formatCopyText, naiToSd } from '../site/assets/app/nai-sd.js';
import { readSdMode, writeSdMode } from '../site/assets/app/sd-mode.js';

// NAI v3 括号与 v4 数字权重混排时，数字权重的回退分支不得吞掉外层收尾括号。
assert.equal(naiToSd('{x, 1.3::a}'), '(x, (a:1.3):1.05)');
assert.equal(naiToSd('{1.3::a}, b'), '((a:1.3):1.05), b');
assert.equal(naiToSd('[x, 1.3::a]'), '(x, (a:1.3):0.952)');
assert.equal(naiToSd('{{tag}}'), '(tag:1.103)');
assert.equal(naiToSd('[[tag]]'), '(tag:0.907)');
assert.equal(naiToSd('{tag'), 'tag', '真正未闭合的左括号只丢弃括号本身');

// 无收尾 :: 且后接逗号的原有回退语义保持不变。
assert.equal(naiToSd('2.5::a, b'), '(a:2.5), b');
assert.deepEqual(
  formatCopyText('{x}', { sdMode: true }),
  { source: '{x}', text: '(x:1.05)', converted: true },
);
assert.deepEqual(
  formatCopyText('{x}', { sdMode: true, convert: false }),
  { source: '{x}', text: '{x}', converted: false },
);

// 可交互 toast 必须承载真实按钮，点击后先关闭旧 toast 再执行动作。
{
  const originalDocument = globalThis.document;
  const classNames = new Set();
  const liveOrder = [];
  const toastElement = {
    children: [],
    offsetWidth: 10,
    classList: {
      add: name => classNames.add(name),
      remove: name => classNames.delete(name),
      toggle(name, force) {
        if (force) classNames.add(name);
        else classNames.delete(name);
      },
    },
    replaceChildren() { liveOrder.push('content'); this.children = []; },
    appendChild(child) { this.children.push(child); },
    contains(node) { return this.children.includes(node); },
    querySelector(selector) {
      return selector === '.toast-action'
        ? this.children.find(child => child.className === 'toast-action') || null
        : null;
    },
    setAttribute(name) { if (name === 'aria-hidden') liveOrder.push('hide'); },
    removeAttribute(name) { if (name === 'aria-hidden') liveOrder.push('show'); },
  };
  const focusTrigger = {
    isConnected: true,
    focused: 0,
    focus() { this.focused += 1; globalThis.document.activeElement = this; },
  };
  globalThis.document = {
    activeElement: focusTrigger,
    querySelector: selector => selector === '#toast' ? toastElement : null,
    createElement: tag => ({
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      type: '',
      listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; },
    }),
  };
  try {
    const { toast } = await import('../site/assets/app/feedback.js?toast-action-test');
    let clicked = 0;
    toast('已复制正向', '✓', { label: '再复制负面', onClick: () => { clicked += 1; } });
    assert.equal(classNames.has('has-action'), true);
    assert.equal(classNames.has('show'), true);
    assert.equal(toastElement.children[0].textContent, '✓ 已复制正向');
    assert.equal(toastElement.children[1].textContent, '再复制负面');
    const liveShowIndex = liveOrder.indexOf('show');
    const liveContentIndex = liveOrder.indexOf('content');
    assert.ok(liveShowIndex >= 0, `live region 必须恢复可见，实际顺序：${liveOrder.join(' > ')}`);
    assert.ok(liveContentIndex >= 0, `toast 必须写入消息，实际顺序：${liveOrder.join(' > ')}`);
    assert.ok(
      liveShowIndex < liveContentIndex,
      `live region 必须先恢复再改消息，实际顺序：${liveOrder.join(' > ')}`,
    );
    globalThis.document.activeElement = toastElement.children[1];
    toastElement.children[1].listeners.click({ stopPropagation() {} });
    assert.equal(clicked, 1);
    assert.equal(classNames.has('show'), false);
    assert.equal(toastElement.children[1].tabIndex, -1);
    assert.equal(globalThis.document.activeElement, focusTrigger);
    assert.equal(focusTrigger.focused, 1);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
}

// Clipboard API 成功时不应再触碰旧式 execCommand。
{
  let clipboardText = '';
  let execCalls = 0;
  const result = await writeClipboardText('alpha', {
    navigatorApi: { clipboard: { writeText: async text => { clipboardText = text; } } },
    documentApi: { execCommand() { execCalls += 1; return true; } },
  });
  assert.deepEqual(result, { ok: true, method: 'clipboard', text: 'alpha' });
  assert.equal(clipboardText, 'alpha');
  assert.equal(execCalls, 0);
}

function execDocument(result) {
  const record = { appended: 0, removed: 0, selected: 0, restored: 0, range: null };
  const previousFocus = {
    isConnected: true,
    focus(options) {
      assert.deepEqual(options, { preventScroll: true });
      record.restored += 1;
    },
  };
  const area = {
    style: {},
    setAttribute() {},
    focus() {},
    select() { record.selected += 1; },
    setSelectionRange(start, end) { record.range = [start, end]; },
    remove() { record.removed += 1; },
  };
  return {
    record,
    documentApi: {
      activeElement: previousFocus,
      body: { appendChild(node) { assert.equal(node, area); record.appended += 1; } },
      createElement(tag) { assert.equal(tag, 'textarea'); return area; },
      execCommand(command) { assert.equal(command, 'copy'); return result; },
    },
  };
}

// Clipboard API 被拒绝后，execCommand=true 是真实成功，并恢复原焦点。
{
  const { documentApi, record } = execDocument(true);
  const result = await writeClipboardText('fallback', {
    navigatorApi: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
    documentApi,
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'execCommand');
  assert.deepEqual(record, {
    appended: 1,
    removed: 1,
    selected: 1,
    restored: 1,
    range: [0, 8],
  });
}

// execCommand=false 不能再伪装成成功；失败结果必须携带最终文本供手动复制。
{
  const { documentApi, record } = execDocument(false);
  const result = await writeClipboardText('manual text', { navigatorApi: {}, documentApi });
  assert.equal(result.ok, false);
  assert.equal(result.method, 'manual');
  assert.equal(result.text, 'manual text');
  assert.equal(result.failures.length, 1);
  assert.equal(record.removed, 1);
  assert.equal(record.restored, 1);
}

// 两种自动路径都失败时保留两条原因，仍只返回一次可手动复制的最终文本。
{
  const { documentApi } = execDocument(false);
  const result = await writeClipboardText('{weighted}', {
    navigatorApi: { clipboard: { writeText: async () => { throw new Error('blocked'); } } },
    documentApi,
  });
  assert.equal(result.ok, false);
  assert.equal(result.text, '{weighted}');
  assert.equal(result.failures.length, 2);
}

// SD 开关的存储键和值由两页共用，并安全处理禁用的 storage。
{
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(readSdMode(storage), false);
  assert.equal(writeSdMode(true, storage), true);
  assert.equal(readSdMode(storage), true);
  assert.equal(writeSdMode(false, storage), true);
  assert.equal(readSdMode(storage), false);
  const blocked = {
    getItem() { throw new DOMException('blocked', 'SecurityError'); },
    setItem() { throw new DOMException('blocked', 'SecurityError'); },
  };
  assert.equal(readSdMode(blocked), false);
  assert.equal(writeSdMode(true, blocked), false);
}

// 共创广场读取主站同一 SD 开关，复制结果必须与共享转换器完全一致。
{
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => '1', setItem() {} },
  });
  try {
    const community = await import('../site/assets/community/utils.js?copy-sd-consistency');
    let copiedText = '';
    const source = '{{masterpiece}}, [noise], 1.2::portrait::';
    const result = await community.copyText(source, {
      manualFallback: false,
      clipboardOptions: {
        navigatorApi: { clipboard: { writeText: async text => { copiedText = text; } } },
        documentApi: null,
      },
    });
    assert.equal(result.converted, true);
    assert.equal(copiedText, naiToSd(source));
  } finally {
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else delete globalThis.localStorage;
  }
}

// 主站与共创广场保留正向→负面接力，但复制成功后不再附加 NovelAI 外链动作。
{
  const [copySource, lightboxSource, communityDetailSource] = await Promise.all([
    readFile(new URL('../site/assets/app/copy.js', import.meta.url), 'utf8'),
    readFile(new URL('../site/assets/app/lightbox.js', import.meta.url), 'utf8'),
    readFile(new URL('../site/assets/community/detail.js', import.meta.url), 'utf8'),
  ]);
  assert.match(copySource, /label: '再复制负面'/);
  assert.match(copySource, /const message = negative \? `已复制正向：\$\{e\.title\}` : `已复制：\$\{e\.title\}`/);
  assert.doesNotMatch(copySource, /offerNovelAi|novelAiToastAction/);
  assert.match(lightboxSource, /copyText\(shareUrl, '已复制分享链接', shareBtn, \{ convert: false \}\)/);
  assert.doesNotMatch(lightboxSource, /offerNovelAi|novelAiToastAction/);
  assert.match(communityDetailSource, /type !== 'negative'[\s\S]*label: '再复制负面'/);
  assert.doesNotMatch(communityDetailSource, /novelAiToastAction|novelai-link/);
}

console.log('copy: all tests passed');
