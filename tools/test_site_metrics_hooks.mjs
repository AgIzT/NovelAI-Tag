import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Execute the real, bounded action bodies with in-memory dependencies. This is
// not a browser integration test and never accesses the user's stored content.
async function source(path) { return readFile(new URL(`../site/assets/${path}`, import.meta.url), 'utf8'); }
function between(text, start, end) {
  const left = text.indexOf(start);
  const right = text.indexOf(end, left + start.length);
  assert.ok(left >= 0 && right > left, `Missing action boundary: ${start}`);
  return text.slice(left, right);
}
function bindFunction(text, deps) {
  const names = Object.keys(deps);
  return new Function(...names, `return (${text.replace(/^export /, '')});`)(...Object.values(deps));
}

const copySource = await source('app/copy.js');
const copyBody = between(copySource, 'export async function copyText(', '\nexport function combinedPrompt(');
function copyFixture(result) {
  const trace = [];
  const deps = {
    state: { sdMode: false, allowR18g: true },
    prepareCopiedFragment: () => ({}), prepareCopiedEntry: () => ({}),
    snapshotLocked: () => false, accessProbe: () => ({}), probeLocked: () => false,
    showR18gLockedHint() {}, showNsfwLockedHint() {},
    formatCopyText: text => ({ text, converted: false }),
    async writeClipboardText() { trace.push('clipboard'); return result; },
    showClipboardFallback() { trace.push('manual'); return true; }, toast() {},
    recordSiteEvent(name, detail) { trace.push(`${name}:${detail}`); },
    replayCopiedClass() {}, async recordPreparedCopiedEntry() { trace.push('intake'); return false; },
    playCopySample() {}, relayTossTarget() {}, sampleLabelFrom: () => 'copy',
  };
  const copy = bindFunction(copyBody, deps);
  return { trace, copy };
}
for (const result of [{ ok: true }, { ok: false }, { ok: false, blocked: true }]) {
  const { trace, copy } = copyFixture(result);
  for (const [options, detail] of [[{ entry: {} }, 'prompt'], [{ promptCopy: true }, 'prompt'], [{}, 'text'], [{ promptCopy: 'true' }, 'text']]) {
    trace.length = 0;
    await copy('PRIVATE PROMPT', 'PRIVATE TITLE', null, options);
    assert.deepEqual(trace.filter(item => item.startsWith('copy_success:')), result.ok ? [`copy_success:${detail}`] : []);
    if (result.ok) assert.ok(trace.indexOf(`copy_success:${detail}`) > trace.indexOf('clipboard'));
    else assert.ok(!trace.includes('intake'));
    trace.length = 0;
    await copy('PRIVATE', 'PRIVATE', null, { ...options, accessGuard: () => false });
    assert.equal(trace.length, 0, 'blocked before clipboard is not a successful copy or a crash');
  }
}

// Replay both real relay callers through the real copy action, preserving their
// source-free options and access guards rather than inferring kind from text.
const composeSource = await source('app/tag-relay-compose.js');
const outputBody = between(composeSource, 'async function copyOutput(', '\nfunction historyLocked(');
const historyBody = between(composeSource, 'function renderHistory(', '\nfunction bindSegment(');
const historyTextBody = between(composeSource, 'function historyText(', '\nfunction renderHistory(');
for (const result of [{ ok: true }, { ok: false }, { ok: false, blocked: true }]) {
  for (const channel of ['positive', 'negative', 'both', 'history']) {
    const { trace, copy } = copyFixture(result);
    let copyOptions;
    const relayCopy = (text, message, trigger, options) => {
      copyOptions = options;
      return copy(text, message, trigger, options);
    };
    const historyText = bindFunction(historyTextBody, {});
    if (channel === 'history') {
      const element = (tag, className, textContent = '') => ({
        tag, textContent, dataset: {}, children: [],
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
      });
      const record = { id: 'record', label: 'PRIVATE', positive: 'PRIVATE POSITIVE', negative: 'PRIVATE NEGATIVE' };
      const refs = { historyStatus: {}, historyList: element('div'), historyClear: {}, history: { hidden: false } };
      let locked = false;
      const render = bindFunction(historyBody, {
        refs, relayState: () => ({ history: [record] }), element, historyText,
        historyLocked: () => locked, copyText: relayCopy,
        refreshComposeAccess() { trace.push('access-refresh'); },
      });
      render();
      const button = refs.historyList.children[0].children.at(-1).children[0];
      await button.onclick();
      const beforeBlocked = trace.length;
      locked = true;
      await button.onclick();
      assert.deepEqual(trace.slice(beforeBlocked), ['access-refresh'], 'a stale locked history button must not copy or count');
    } else {
      const output = bindFunction(outputBody, {
        flushCompose: async () => true, renderOutput() {},
        latest: { positive: 'PRIVATE POSITIVE', negative: 'PRIVATE NEGATIVE' },
        safeSnapshot: plan => plan, livePlan: () => ({}), planFolds: () => [],
        copyText: relayCopy, snapshotLocked: () => false, toast() {},
        async commitRelay(mutator) { trace.push('history'); mutator({}); },
        recordCopyHistory() {}, outputFormat: 'nai', joinMode: 'newline',
      });
      await output(channel, null);
      assert.equal(trace.includes('history'), result.ok, 'relay history still requires real copy success');
    }
    assert.equal(copyOptions.promptCopy, true, `${channel} caller must identify prompt output`);
    assert.ok(!copyOptions.entry && !copyOptions.relaySnapshot && !copyOptions.accessEntry, 'kind does not require invented source or intake');
    assert.deepEqual(trace.filter(item => item.startsWith('copy_success:')), result.ok ? ['copy_success:prompt'] : []);
    assert.ok(!trace.includes('intake'), 'classifying prompt output must not add it to the relay inbox');
  }
}

const lightboxSource = await source('app/lightbox.js');
const shareAssignment = between(lightboxSource, 'shareBtn.onclick = async ev => {', '\n  const reportBtn');
const shareBody = shareAssignment.slice(shareAssignment.indexOf('async ev'), shareAssignment.lastIndexOf('\n    };') + 6).trim().replace(/;$/, '');
for (const mode of ['native', 'cancel', 'fallback-ok', 'fallback-fail']) {
  const trace = [];
  const handler = bindFunction(shareBody, {
    shareUrl: 'https://example.test/share/private', e: { title: 'PRIVATE' }, shareBtn: {},
    canUseNativeShare: () => true,
    navigator: { async share() {
      trace.push('native');
      if (mode !== 'native') throw Object.assign(new Error('PRIVATE ERROR'), { name: mode === 'cancel' ? 'AbortError' : 'NotAllowedError' });
    } },
    async copyText() { trace.push('clipboard'); return { ok: mode === 'fallback-ok' }; },
    recordSiteEvent(name, detail) { trace.push(`${name}:${detail}`); },
  });
  await handler({ stopPropagation() {} });
  assert.equal(trace.includes('share_success:native'), mode === 'native');
  assert.equal(trace.includes('share_success:link'), mode === 'fallback-ok');
  if (mode === 'cancel') assert.deepEqual(trace, ['native']);
  if (mode === 'fallback-ok') assert.ok(trace.indexOf('share_success:link') > trace.indexOf('clipboard'));
}

const favoritesSource = await source('app/favorites-backup.js');
const downloadBody = between(favoritesSource, 'function downloadJson(', '\nfunction friendlyError(');
for (const fail of [false, true]) {
  const trace = [];
  const link = { click() { trace.push('download'); if (fail) throw new Error('blocked'); }, remove() {} };
  const download = bindFunction(downloadBody, {
    Blob, FAVORITES_BACKUP_LIMITS: { maxFileBytes: 2048 }, FavoritesBackupError: Error,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    document: { createElement: () => link, body: { appendChild() {} } },
    window: { setTimeout() {} }, localDateStamp: () => '2026-10-12',
    recordSiteEvent(name, detail) { trace.push(`${name}:${detail}`); },
  });
  if (fail) assert.throws(() => download('PRIVATE JSON'));
  else download('PRIVATE JSON');
  assert.equal(trace.includes('export_success:favorites_json'), !fail);
  if (!fail) assert.deepEqual(trace, ['download', 'export_success:favorites_json']);
}

const relaySource = await source('app/tag-relay-backup.js');
const relayExportBody = between(relaySource, "  exportButton.addEventListener('click', async () => {", '\n  importButton.addEventListener(');
for (const mode of ['ok', 'store-fail', 'draft-fail', 'download-fail']) {
  const trace = [];
  let handler;
  const deps = {
    exportButton: { addEventListener(type, fn) { handler = fn; } }, binding: { busy: false },
    closeMenu() {}, setBusy() {}, getRelayStorageIssue: () => mode === 'store-fail' ? 'corrupt-data' : null,
    toast() {}, flush: async () => mode !== 'draft-fail', exportRelayBackup: () => 'PRIVATE JSON', relayState: () => ({}),
    Blob, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} }, dateStamp: () => '2026-10-12',
    document: { createElement: () => ({ click() { trace.push('download'); if (mode === 'download-fail') throw new Error('blocked'); }, remove() {} }) },
    scope: { append() {} }, setTimeout() {}, recordSiteEvent(name, detail) { trace.push(`${name}:${detail}`); },
  };
  new Function(...Object.keys(deps), relayExportBody)(...Object.values(deps));
  await handler();
  assert.equal(trace.includes('export_success:relay_json'), mode === 'ok');
  if (mode === 'ok') assert.deepEqual(trace, ['download', 'export_success:relay_json']);
}

const appSource = await source('app.js');
const filterBody = between(appSource, 'export function applyFilter(', '\n/* 取消、撤销');
for (const [hasErrors, entries] of [[false, [{}]], [false, []], [true, []]]) {
  const trace = [];
  let observation;
  const plan = { hasActiveSearch: true, hasErrors, filters: [], positiveTerms: [] };
  const state = { codex: { entries }, favoritesView: false, siteSearchView: false, activePath: [], updateFilter: '' };
  const applyFilter = bindFunction(filterBody, {
    state, compileSearchState: () => plan, isCodexLocked: () => false, isEntryAccessBlocked: () => false,
    listSearchDirectories: () => [], searchDirectoryOptions: () => [], virtualView: () => false,
    matchSearchPlan: () => true, codexUpdateFilters: () => [], entryMatchesUpdateFilter: () => true,
    filterFavoritesScope: value => value, isContentBlocked: () => false, filterFavoritesEntries: value => value,
    sortCategoryEntries: value => value,
    rankSearchResults: value => value, pinFeatured: value => value, findRelatedDirectories: () => [],
    renderSearchExperience() {}, updateResultBar() {}, syncFavoritesView() {}, renderFavoritesRail() {},
    renderFavoritesHeader() {}, refreshFavoriteBadges() {}, renderList() { trace.push('render'); }, updateBlockingSummary() {},
  });
  applyFilter({ onSearchSettled(value) { observation = value; trace.push('settled'); } });
  assert.deepEqual(trace, ['render', 'settled']);
  assert.deepEqual(observation, { active: true, valid: !hasErrors, hasResults: entries.length > 0, scope: 'codex' });
}
assert.ok(appSource.includes('applySearch: applyObservedSearch'));
assert.ok(appSource.includes('applyFilter({ resetScroll: true, onSearchSettled: options.onSearchSettled })'));
assert.ok(favoritesSource.indexOf("recordSiteEvent('export_success', 'favorites_text')") > favoritesSource.indexOf('if (!result.ok)', favoritesSource.indexOf("exportTextButton?.addEventListener")));
console.log('PASS anonymous metrics hooks: real copy/share/export/filter action bodies, success ordering, cancellation, manual/blocked/failure exclusion');
