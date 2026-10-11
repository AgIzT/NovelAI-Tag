/* 执行真实 compose 保存动作；仅替换 DOM/editor/排队提交，控制等待期间的输入。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as v4 from '../site/assets/app/tag-relay-v4.js';

const source = fs.readFileSync(new URL('../site/assets/app/tag-relay-compose.js', import.meta.url), 'utf8')
  .replace(/^import\s[\s\S]*?;\r?\n/gm, '').replace(/^export\s+/gm, '');
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
function fixture() {
  const refs = Object.fromEntries(['saveState', 'positiveOut', 'negativeOut', 'positiveMeta', 'negativeMeta',
    'copyPositive', 'copyNegative', 'copyAll', 'copyPositiveHint', 'outputSummary', 'outputNote',
    'dedupe', 'planStats', 'historyStatus', 'historyList', 'historyClear', 'history'].map(key => [key, node()]));
  refs.history.hidden = true; refs.lane = { contains: () => false };
  let disk = v4.createRelayState({ planName: 'Original' });
  disk.plans[0].positive.text = 'peer saved'; disk.plans[0].revision = 1;
  let session, notify = () => {}, timer = 0;
  const timers = new Map(), commits = [];
  const editor = {
    loadPlan(plan) { session = structuredClone(plan); },
    getSnapshot() { return structuredClone(session); },
    getSession() { return session; },
  };
  const deps = {
    ...v4, state: { codex: null }, toast() {}, getRelayStorageIssue: () => null,
    relayState: () => disk,
    commitRelay: mutator => {
      const gate = deferred(), attempt = { gate, mutator, fail: false };
      commits.push(attempt);
      return gate.promise.then(() => {
        if (attempt.fail) return { ok: false, reason: 'save' };
        const next = structuredClone(disk), result = mutator(next);
        disk = v4.normalizeRelayState(next); notify(disk, { source: 'local' });
        return { ok: true, result };
      });
    },
    snapshotLocked: () => false, cancelRelayAction() {}, loadTagZh: async () => {},
    isTagZhEnabled: () => false, document: { createElement: node }, tokens: () => [],
    setTimeout(fn) { timers.set(++timer, fn); return timer; },
    clearTimeout(id) { timers.delete(id); },
  };
  const harness = new Function('deps', `with (deps) { ${source}\nreturn {
    seed(testRefs, testEditor, plan) { refs = testRefs; editor = testEditor; activeId = plan.id;
      const draft = draftFor(plan); draft.issue = 'conflict'; draft.dirty = true; editor.loadPlan(plan); },
    renderSaveState, syncStoredState, editorChanged, flushCompose,
    draft: id => drafts.get(id), active: () => activeId
  }; }`)(deps);
  notify = harness.syncStoredState;
  const local = structuredClone(disk.plans[0]);
  local.revision = 0; local.positive.text = 'local first';
  harness.seed(refs, editor, local); harness.renderSaveState();
  const copyButton = () => refs.saveState.children.find(item => item.textContent === '另存副本');
  assert.ok(copyButton(), '真实另存副本按钮必须存在');
  return {
    refs, harness, local, commits, timers, copyButton,
    disk: () => disk, session: () => session,
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

console.log('tag relay compose: all tests passed');
