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

// 种子芯片必须在后台标签页 / 连点重入后仍从清晰基础态开始，且不能留下 forwards 动画终态。
{
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const timers = new Map();
  const createdAnimations = [];
  let timerId = 0;

  class FakeAnimation {
    constructor(element, keyframes, options) {
      this.element = element;
      this.keyframes = keyframes;
      this.options = options;
      this.cancelled = false;
      this.settled = false;
      this.handlers = [];
      this.finished = {
        then: (resolve, reject) => {
          this.handlers.push({ resolve, reject });
          return this.finished;
        },
      };
    }

    detach() {
      this.element.animations = this.element.animations.filter(item => item !== this);
    }

    cancel() {
      this.cancelled = true;
      this.detach();
      if (this.settled) return;
      this.settled = true;
      for (const handler of this.handlers) handler.reject?.(new Error('cancelled'));
    }

    finish() {
      if (this.settled) return;
      this.settled = true;
      this.detach();
      for (const handler of this.handlers) handler.resolve?.();
    }

    // 模拟一个已经过期、却晚到本轮之后的成功回调；chipGen 必须令它失效。
    forceResolve() {
      for (const handler of this.handlers) handler.resolve?.();
    }
  }

  const chip = {
    animations: [],
    className: '',
    hidden: true,
    isConnected: false,
    style: {},
    textContent: '',
    setAttribute() {},
    getAnimations() { return this.animations.slice(); },
    animate(keyframes, options) {
      const animation = new FakeAnimation(this, keyframes, options);
      this.animations.push(animation);
      createdAnimations.push(animation);
      return animation;
    },
  };
  const fakeWindow = {
    innerHeight: 800,
    innerWidth: 1200,
    addEventListener() {},
    matchMedia: () => ({ matches: false }),
    setTimeout(fn, delay) {
      const id = ++timerId;
      timers.set(id, { fn, delay, interval: false });
      return id;
    },
    setInterval(fn, delay) {
      const id = ++timerId;
      timers.set(id, { fn, delay, interval: true });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    clearInterval(id) { timers.delete(id); },
  };
  const fakeDocument = {
    body: {
      appendChild(node) { node.isConnected = true; },
    },
    createElement(tag) {
      assert.equal(tag, 'div', '无卡片节点时只应创建种子芯片');
      return chip;
    },
  };
  const runTimeout = delay => {
    const found = [...timers].find(([, timer]) => !timer.interval && timer.delay === delay);
    assert.ok(found, `应存在 ${delay}ms 的芯片收尾定时器`);
    const [id, timer] = found;
    timers.delete(id);
    timer.fn();
  };

  globalThis.window = fakeWindow;
  globalThis.document = fakeDocument;
  try {
    const { playCopySample } = await import('../site/assets/app/copy-fx.js?chip-lifecycle-test');

    playCopySample(null, 'alpha,beta', '已复制正面');
    assert.equal(chip.hidden, false);
    assert.equal(chip.style.filter, 'none');
    assert.equal(chip.style.opacity, '1');
    const firstRise = createdAnimations.at(-1);
    assert.equal(firstRise.options.fill, undefined, '入场不得保留 forwards 终态');
    assert.equal(firstRise.keyframes.some(frame => 'filter' in frame), false);
    firstRise.finish();
    runTimeout(1260);
    const staleExit = createdAnimations.at(-1);
    assert.equal(staleExit.options.fill, undefined, '退场不得保留 forwards 终态');
    assert.equal(staleExit.keyframes.some(frame => 'filter' in frame), false, '芯片退场不再使用 blur');

    playCopySample(null, 'negative,noise,artifact', '已复制负面');
    assert.equal(staleExit.cancelled, true, '新一轮必须主动销毁旧退场动画');
    assert.equal(chip.hidden, false);
    assert.equal(chip.style.filter, 'none');
    assert.equal(chip.textContent, '✓ 已复制负面 · 3 tags');
    staleExit.forceResolve();
    assert.equal(chip.hidden, false, '过期回调不得隐藏当前芯片');
    assert.equal(chip.style.filter, 'none');

    const secondRise = createdAnimations.at(-1);
    secondRise.finish();
    runTimeout(820);
    const currentExit = createdAnimations.at(-1);
    currentExit.finish();
    assert.equal(chip.hidden, true);
    assert.equal(chip.style.filter, 'none');
    assert.equal(chip.style.opacity, '1');
    assert.equal(chip.style.translate, '0 -8px');
    assert.equal(chip.getAnimations().length, 0, '隐藏后不能遗留动画 effect');

    playCopySample(null, 'fresh', '已复制正面');
    assert.equal(chip.hidden, false);
    assert.equal(chip.style.filter, 'none', '从隐藏态重播仍必须清晰');

    const thirdRise = createdAnimations.at(-1);
    thirdRise.finish();
    runTimeout(820);
    const frozenExit = createdAnimations.at(-1);
    assert.equal(chip.hidden, false);
    runTimeout(260);
    assert.equal(frozenExit.cancelled, true, '后台冻结的退场动画必须由兜底定时器销毁');
    assert.equal(chip.hidden, true, '后台标签页不能把芯片永久留在页面上');
    assert.equal(chip.style.filter, 'none');
    assert.equal(chip.getAnimations().length, 0);

    let previousRapidRise = null;
    for (let index = 0; index < 8; index++) {
      const label = index % 2 ? '已复制负面' : '已复制正面';
      playCopySample(null, `rapid-${index},shared`, label);
      if (previousRapidRise) {
        assert.equal(previousRapidRise.cancelled, true, `第 ${index + 1} 次连点必须销毁上一轮入场`);
      }
      assert.equal(chip.hidden, false);
      assert.equal(chip.style.filter, 'none', `第 ${index + 1} 次连点不得继承模糊`);
      assert.equal(chip.textContent, `✓ ${label} · 2 tags`);
      previousRapidRise = createdAnimations.at(-1);
    }
    previousRapidRise.finish();
    runTimeout(820);
    const rapidExit = createdAnimations.at(-1);
    runTimeout(260);
    assert.equal(rapidExit.cancelled, true);
    assert.equal(chip.hidden, true);
    assert.equal(chip.style.filter, 'none');
    assert.equal(chip.getAnimations().length, 0);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
}

// 主站与共创广场保留正向→负面接力，但复制成功后不再附加 NovelAI 外链动作。
{
  const [copySource, lightboxSource, masonrySource, moduleMapSource, communityDetailSource] = await Promise.all([
    readFile(new URL('../site/assets/app/copy.js', import.meta.url), 'utf8'),
    readFile(new URL('../site/assets/app/lightbox.js', import.meta.url), 'utf8'),
    readFile(new URL('../site/assets/app/masonry.js', import.meta.url), 'utf8'),
    readFile(new URL('../site/assets/app/MODULE_MAP.md', import.meta.url), 'utf8'),
    readFile(new URL('../site/assets/community/detail.js', import.meta.url), 'utf8'),
  ]);
  assert.match(copySource, /label: '再复制负面'/);
  assert.match(copySource, /const message = `\$\{negative \? '已复制正向' : '已复制'\}\$\{charNote\}：\$\{e\.title\}`/);
  assert.match(copySource, /playCopySample\(node, formatted\.text, options\.sampleLabel, \{[\s\S]*flyTo:/);
  /* 入库必须排在动效之前：芯片抛不抛向中转站取决于这次到底存没存进去 */
  assert.match(copySource, /const intake = options\.entry \? recordCopiedEntry\(options\.entry\) : false;[\s\S]*playCopySample\(/);
  /* opt-in：不传 entry 的复制不得入库 */
  assert.doesNotMatch(copySource, /recordCopiedEntry\(\s*\)/);
  assert.match(lightboxSource, /copyText\(shareUrl, '已复制分享链接', shareBtn, \{ convert: false \}\)/);
  assert.match(lightboxSource, /copyText\(e\.negative[\s\S]*sampleLabel: '已复制负面'/);
  assert.match(masonrySource, /copyText\(e\.negative[\s\S]*sampleLabel: '已复制负面'/);
  assert.match(moduleMapSource, /`copy-fx\.js`/);
  assert.match(communityDetailSource, /type !== 'negative'[\s\S]*label: '再复制负面'/);
  for (const source of [copySource, lightboxSource, masonrySource, moduleMapSource, communityDetailSource]) {
    assert.doesNotMatch(source, /offerNovelAi|novelAiToastAction|novelai-link/);
  }
  await assert.rejects(
    readFile(new URL('../site/assets/app/novelai-link.js', import.meta.url), 'utf8'),
    error => error?.code === 'ENOENT',
  );
}

// 一键复制 = 正面 + 角色词内容（去标记）；「全部」在只有角色词、没有负面时也要出现。
// （entryPromptText / combinedPromptLabel 的行为断言在 test_render_ui.mjs，那边有 DOM 桩）
{
  const [copySource, masonrySource, lightboxSource] = await Promise.all([
    readFile(new URL('../site/assets/app/copy.js', import.meta.url), 'utf8'),
    readFile(new URL('../site/assets/app/masonry.js', import.meta.url), 'utf8'),
    readFile(new URL('../site/assets/app/lightbox.js', import.meta.url), 'utf8'),
  ]);
  assert.match(copySource, /return copyText\(entryPromptText\(e\), message, node/);
  // 灯箱的「复制正向」保持只给正面段（那里角色词是分块展示的，语义不含糊）
  assert.match(lightboxSource, /copyText\(e\.tags, `已复制正向：\$\{e\.title\}`/);
  assert.match(copySource, /（含 \$\{charCount\} 组角色词）/);
  // 卡片和灯箱的「全部」都要在只有角色词、没有负面时出现，文案也不能再写死「正向+负面」
  assert.match(masonrySource, /allBtn\.hidden = !e\.negative && !charPrompts\.length/);
  assert.match(lightboxSource, /\$\('#copyAll'\)\.hidden = !e\.negative && !\(e\.characterPrompts \|\| \[\]\)\.length/);
  for (const source of [masonrySource, lightboxSource]) {
    assert.match(source, /已复制\$\{combinedPromptLabel\(e\)\}/);
    assert.doesNotMatch(source, /已复制正向\+负面/);
  }
}

console.log('copy: all tests passed');
