/* 执行真实 compose 保存动作；仅替换 DOM/editor/排队提交，控制等待期间的输入。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as v4 from '../site/assets/app/tag-relay-v4.js';

const source = fs.readFileSync(new URL('../site/assets/app/tag-relay-compose.js', import.meta.url), 'utf8')
  .replace(/^import\s[\s\S]*?;\r?\n/gm, '').replace(/^export\s+/gm, '');
const unloadRegistration = source.split('\n').find(line => line.includes("window.addEventListener('beforeunload'"));
assert.ok(unloadRegistration, '测试必须执行生产 beforeunload 的真实注册语句');
const node = (tag = 'div') => ({
  tag, children: [], hidden: false, textContent: '', value: '', disabled: false,
  classList: { add() {} }, setAttribute() {},
  append(...items) { this.children.push(...items); },
  replaceChildren(...items) { this.children = items; },
});
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture({ issue = 'conflict', globalIssue = null, localRevision = 0 } = {}) {
  const refs = Object.fromEntries(['saveState', 'positiveOut', 'negativeOut', 'positiveMeta', 'negativeMeta',
    'copyPositive', 'copyNegative', 'copyAll', 'copyPositiveHint', 'outputSummary', 'outputNote',
    'dedupe', 'planStats', 'historyStatus', 'historyList', 'historyClear', 'history'].map(key => [key, node()]));
  refs.history.hidden = true; refs.lane = { contains: () => false };
  let disk = v4.createRelayState({ planName: 'Original' });
  disk.plans[0].positive.text = 'peer saved'; disk.plans[0].revision = 1;
  let session, notify = () => {}, timer = 0, storageIssue = globalIssue, reloads = 0, initializations = 0;
  const timers = new Map(), commits = [];
  const windowHandlers = new Map();
  const editor = {
    loadPlan(plan) { session = structuredClone(plan); },
    getSnapshot() { return structuredClone(session); },
    getSession() { return session; },
  };
  const deps = {
    ...v4, state: { codex: null }, toast() {}, getRelayStorageIssue: () => storageIssue,
    initializeRelay: async () => { initializations += 1; return { ok: storageIssue !== 'rollback' }; },
    window: { location: { reload() { reloads += 1; } }, addEventListener(type, handler) { windowHandlers.set(type, handler); } },
    relayState: () => disk,
    commitRelay: mutator => {
      const gate = deferred(), attempt = { gate, mutator, fail: false };
      commits.push(attempt);
      return gate.promise.then(() => {
        if (attempt.fail) {
          const reason = typeof attempt.fail === 'string' ? attempt.fail : 'save';
          if (reason === 'rollback') storageIssue = reason;
          return { ok: false, reason };
        }
        const next = structuredClone(disk), result = mutator(next);
        if (result?.ok === false) return { ok: false, reason: result.reason };
        disk = v4.normalizeRelayState(next); storageIssue = null; notify(disk, { source: 'local' });
        return { ok: true, result };
      });
    },
    snapshotLocked: () => false, cancelRelayAction() {}, loadTagZh: async () => {},
    isTagZhEnabled: () => false, document: { createElement: node }, tokens: () => [],
    setTimeout(fn) { timers.set(++timer, fn); return timer; },
    clearTimeout(id) { timers.delete(id); },
  };
  const harness = new Function('deps', `with (deps) { ${source}\nreturn {
    seed(testRefs, testEditor, plan, issue) { refs = testRefs; editor = testEditor; activeId = plan.id;
      const draft = draftFor(plan); draft.issue = issue; draft.dirty = true; editor.loadPlan(plan); },
    renderSaveState, syncStoredState, editorChanged, flushCompose, saveDraftAsCopy,
    bindUnload() { ${unloadRegistration} },
    draft: id => drafts.get(id), active: () => activeId
  }; }`)(deps);
  notify = harness.syncStoredState;
  const local = structuredClone(disk.plans[0]);
  local.revision = localRevision; local.positive.text = 'local first';
  if (issue === 'missing-plan') {
    v4.createPlan(disk, 'Peer replacement');
    disk.plans = disk.plans.filter(plan => plan.id !== local.id);
  }
  harness.seed(refs, editor, local, issue); harness.renderSaveState();
  harness.bindUnload();
  const copyButton = () => refs.saveState.children.find(item => item.textContent === '另存副本');
  if (globalIssue !== 'rollback' && issue !== 'rollback') assert.ok(copyButton(), '真实另存副本按钮必须存在');
  return {
    refs, harness, local, commits, timers, copyButton,
    disk: () => disk, session: () => session,
    storageIssue: () => storageIssue,
    setStorageIssue(value) { storageIssue = value; harness.renderSaveState(); },
    peerUpdate(positive) {
      const saved = disk.plans.find(plan => plan.id === local.id);
      saved.positive.text = positive; saved.revision += 1; notify(disk, { source: 'storage' });
    },
    beforeUnload() {
      const event = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
      windowHandlers.get('beforeunload')(event); return event;
    },
    reloads: () => reloads, initializations: () => initializations,
    runTimer() { const [id, callback] = [...timers][0]; timers.delete(id); return callback(); },
    input(positive, negative = '') {
      session.positive.text = positive; session.negative.text = negative; harness.editorChanged();
    },
    release(index = 0) { commits[index].gate.resolve(); },
  };
}

// 完成快照可以清除，但只能载入本次创建的副本。
{
  const f = fixture(), action = f.copyButton().onclick();
  f.release(); await action;
  assert.equal(f.disk().plans.length, 2);
  assert.equal(f.session().positive.text, 'local first');
  assert.equal(f.harness.draft(f.local.id), undefined);
  assert.notEqual(f.harness.active(), f.local.id);
}

// 等锁时多次输入：保存点击快照后仍保留最新双通道草稿和未保存提示。
{
  const f = fixture(), action = f.copyButton().onclick();
  f.input('local first, NEW-TAIL-1', 'negative tail 1');
  f.input('local first, NEW-TAIL-2', 'negative tail 2');
  f.release(); await action;
  assert.equal(f.session().positive.text, 'local first, NEW-TAIL-2', '等待期间的正向尾段必须仍在编辑器');
  assert.equal(f.session().negative.text, 'negative tail 2');
  assert.equal(f.harness.draft(f.local.id)?.plan.positive.text, f.session().positive.text);
  assert.equal(f.harness.draft(f.local.id)?.dirty, true);
  assert.equal(f.refs.saveState.hidden, false, '尚未保存的新输入必须继续提示');
  assert.equal(f.disk().plans[0].positive.text, 'peer saved', '冲突原方案不能覆写');
  assert.equal(f.disk().plans[1].positive.text, 'local first', '第一份副本保存点击时快照');
  // 后续再另存最新草稿，可以完整落盘并清除已保存版本。
  const again = f.copyButton().onclick();
  f.release(1); await again;
  assert.equal(f.disk().plans.length, 3);
  assert.equal(f.disk().plans[2].positive.text, 'local first, NEW-TAIL-2');
  assert.equal(f.disk().plans[2].negative.text, 'negative tail 2');
  assert.equal(f.harness.draft(f.local.id), undefined);
  assert.equal(f.timers.size, 0, '已完成草稿不能遗留定时保存');
}

// 同一按钮重复点击必须共用待完成动作，不能排队创建多个副本。
{
  const f = fixture(), button = f.copyButton();
  const first = button.onclick(), second = button.onclick();
  assert.equal(f.commits.length, 1, '重复点击不能排队两个另存动作');
  f.release(); await Promise.all([first, second]);
  assert.equal(f.disk().plans.length, 2);
}

// 保存失败后保留完整草稿，且下一次点击可重新尝试。
{
  const f = fixture(), action = f.copyButton().onclick();
  f.commits[0].fail = true; f.input('local first, failure tail');
  f.release(); await action;
  assert.equal(f.disk().plans.length, 1);
  assert.equal(f.session().positive.text, 'local first, failure tail');
  assert.equal(f.harness.draft(f.local.id)?.dirty, true);
  assert.equal(f.refs.saveState.hidden, false);
  const retry = f.copyButton().onclick();
  f.release(1); await retry;
  assert.equal(f.disk().plans[1].positive.text, 'local first, failure tail');
}

const issueCases = [
  ['global issue and consumed debounce', async () => {
    const f = fixture({ issue: '', globalIssue: 'storage', localRevision: 1 });
    f.input('local first');
    const copy = f.copyButton().onclick();
    f.input('local first, NEW-TAIL', 'negative tail');
    const consumed = f.runTimer();
    assert.equal(f.commits.length, 1, '等待副本期间的真实 debounce 不能并发覆盖原方案');
    f.release(); await Promise.all([copy, consumed]);
    assert.equal(f.storageIssue(), null, '副本成功会清除 store 的全局存储错误');
    assert.equal(f.harness.draft(f.local.id)?.dirty, true);
    assert.equal(f.beforeUnload().prevented, true, '有未保存尾段仍需离页确认');
    assert.equal(f.refs.saveState.hidden, false, '仅全局 issue 清除后，新尾段必须仍有未保存提示');
    assert.equal(f.timers.size, 1, '副本完成后必须恢复已耗尽的自动保存');
    assert.equal(f.disk().plans[0].positive.text, 'peer saved');
    assert.equal(f.disk().plans[1].positive.text, 'local first');
    // 副本完成后再一次输入应替换补排的 debounce，以最新双通道内容保存。
    f.input('local first, NEW-TAIL, AFTER-COPY', 'negative tail after copy');
    assert.equal(f.timers.size, 1);
    const resumed = f.runTimer();
    assert.equal(f.commits.length, 2);
    f.release(1); await resumed;
    assert.equal(f.disk().plans[0].positive.text, 'local first, NEW-TAIL, AFTER-COPY');
    assert.equal(f.disk().plans[0].negative.text, 'negative tail after copy');
    assert.equal(f.harness.draft(f.local.id)?.dirty, false);
    assert.equal(f.beforeUnload().prevented, false, '双通道落盘成功后解除离页确认');
    assert.equal(f.refs.saveState.hidden, true);
  }],
  ['conflict and consumed debounce', async () => {
    const f = fixture(), copy = f.copyButton().onclick();
    f.input('local first, conflict tail', 'negative conflict tail');
    const consumed = f.runTimer();
    f.release(); await Promise.all([copy, consumed]);
    assert.equal(f.harness.draft(f.local.id)?.issue, 'conflict');
    assert.equal(f.harness.draft(f.local.id)?.dirty, true);
    assert.equal(f.refs.saveState.hidden, false);
    assert.equal(f.timers.size, 0, '冲突草稿不能补排会覆盖对方方案的自动保存');
    assert.equal(await f.harness.flushCompose(), false);
    assert.equal(f.commits.length, 1);
    assert.equal(f.disk().plans[0].positive.text, 'peer saved');
  }],
  ['existing save finishes newest generation before copy', async () => {
    const f = fixture({ issue: '', globalIssue: 'storage', localRevision: 1 });
    const saving = f.harness.flushCompose(), copy = f.copyButton().onclick();
    f.input('local first, existing save tail', 'existing save negative'); const consumed = f.runTimer();
    assert.equal(f.commits.length, 1, '另存先等已有保存，不并发提交');
    f.release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.commits.length, 2, '已有保存的循环应保存等待期间新 generation');
    f.release(1); await saving; await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.commits.length, 3, '已有保存结束后才提交点击时副本');
    f.release(2); await Promise.all([copy, consumed]);
    assert.equal(f.disk().plans[0].positive.text, 'local first, existing save tail');
    assert.equal(f.disk().plans[0].negative.text, 'existing save negative');
    assert.equal(f.disk().plans[1].positive.text, 'local first');
    assert.equal(f.harness.draft(f.local.id)?.dirty, false);
    assert.equal(f.harness.draft(f.local.id)?.issue, '', '新 generation 已被已有保存写完时不能误报未保存');
    assert.equal(f.timers.size, 0);
    assert.equal(f.refs.saveState.hidden, true);
  }],
  ['missing plan and consumed debounce', async () => {
    const f = fixture({ issue: 'missing-plan' }), copy = f.copyButton().onclick();
    f.input('local first, missing tail'); const consumed = f.runTimer();
    f.release(); await Promise.all([copy, consumed]);
    assert.equal(f.harness.draft(f.local.id)?.issue, 'missing-plan');
    assert.equal(f.timers.size, 0);
    assert.equal(await f.harness.flushCompose(), false);
    assert.equal(f.commits.length, 1);
  }],
  ['peer update while copy waits', async () => {
    const f = fixture({ issue: '', globalIssue: 'storage', localRevision: 1 }), copy = f.copyButton().onclick();
    f.input('local first, preserve local tail'); const consumed = f.runTimer();
    f.peerUpdate('peer newer saved');
    f.release(); await Promise.all([copy, consumed]);
    assert.equal(f.harness.draft(f.local.id)?.issue, 'conflict');
    assert.equal(f.timers.size, 0, '等待时新收到的对端 revision 冲突也不能恢复自动覆盖');
    assert.equal(f.refs.saveState.hidden, false);
    assert.equal(await f.harness.flushCompose(), false);
    assert.equal(f.disk().plans[0].positive.text, 'peer newer saved');
    assert.equal(f.session().positive.text, 'local first, preserve local tail');
  }],
  ['rollback UI and direct guards', async () => {
    const f = fixture({ issue: 'conflict', globalIssue: 'rollback' });
    assert.equal(f.refs.saveState.hidden, false);
    assert.equal(f.refs.saveState.children[0].textContent, '保存结果未能确认。先保留本页输入，再重新加载检查方案。');
    const buttons = f.refs.saveState.children.filter(item => item.tag === 'button');
    assert.deepEqual(buttons.map(item => item.textContent), ['重新加载页面'], '不确定态不能提供普通重试、另存或载入');
    assert.equal(f.reloads(), 0, '结果不确定不能自动刷新丢草稿');
    assert.equal(await f.harness.flushCompose(), false);
    assert.equal(await f.harness.saveDraftAsCopy(f.harness.draft(f.local.id)), false);
    assert.equal(f.commits.length, 0, 'UI 藏按钮外，直接调用同样不能绕过不确定态');
    assert.equal(f.initializations(), 0);
    assert.equal(f.harness.draft(f.local.id)?.dirty, true);
    buttons[0].onclick();
    assert.equal(f.reloads(), 1, '明确点击重新加载按钮才请求页面重载');
    assert.equal(f.harness.draft(f.local.id)?.dirty, true, '刷新按钮保留 beforeunload 所依据的 dirty 状态');
    assert.equal(f.beforeUnload().prevented, true);
    assert.equal(f.beforeUnload().returnValue, '');
  }],
  ['stale retry/copy buttons after rollback', async () => {
    const f = fixture({ issue: '', globalIssue: 'storage', localRevision: 1 });
    const staleRetry = f.refs.saveState.children.find(item => item.textContent === '重试保存');
    const staleCopy = f.copyButton();
    f.setStorageIssue('rollback');
    await staleRetry.onclick(); await staleCopy.onclick();
    assert.equal(f.initializations(), 0, '旧按钮回调同样要在调用初始化前核对 terminal issue');
    assert.equal(f.commits.length, 0);
    f.input('local first, rollback input'); await f.runTimer();
    assert.equal(f.commits.length, 0, '不确定态中新输入的 debounce 不能重新提交');
    assert.equal(f.harness.draft(f.local.id)?.dirty, true);
    assert.equal(f.harness.draft(f.local.id)?.issue, 'rollback');
    assert.equal(f.beforeUnload().prevented, true);
  }],
  ['rollback during pending copy', async () => {
    const f = fixture({ issue: '', globalIssue: 'storage', localRevision: 1 }), copy = f.copyButton().onclick();
    f.input('local first, uncertain tail'); const consumed = f.runTimer();
    f.commits[0].fail = 'rollback'; f.release(); await Promise.all([copy, consumed]);
    assert.equal(f.storageIssue(), 'rollback');
    assert.equal(f.harness.draft(f.local.id)?.dirty, true);
    assert.equal(f.harness.draft(f.local.id)?.issue, 'rollback');
    assert.equal(f.timers.size, 0, '不确定态不能补排自动保存');
    assert.deepEqual(f.refs.saveState.children.filter(item => item.tag === 'button').map(item => item.textContent), ['重新加载页面']);
    assert.equal(f.disk().plans.length, 1);
    assert.equal(f.session().positive.text, 'local first, uncertain tail');
  }],
];
const failures = [];
for (const [name, run] of issueCases) {
  try { await run(); } catch (error) { failures.push(error); console.error(`${name}: ${error.message}`); }
}
if (failures.length) throw new AggregateError(failures, 'tag relay compose issue regressions failed');

console.log('tag relay compose: all tests passed');
