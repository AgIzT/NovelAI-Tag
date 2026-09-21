import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatCopyText } from '../site/assets/app/nai-sd.js';

// Run the production copy pipeline with in-memory clipboard/storage boundaries.
const source = (await readFile(new URL('../site/assets/app/copy.js', import.meta.url), 'utf8'))
  .replace(/^import .*?;\r?\n/gm, '')
  .replace(/^export \{.*?\} from .*?;\r?\n/gm, '')
  .replace(/^export /gm, '');
const state = { codex: { id: 'outdoors' }, sdMode: false };
const stored = [];
const written = [];
const messages = [];
let clipboardResult = { ok: true };
let pendingWrite = null;
const snapshotEntry = entry => ({ ...structuredClone(entry), codexId: entry._srcCodexId || state.codex.id });
const prepareCopiedFragment = (entry, fragment) => ({
  ...snapshotEntry(entry), ...fragment,
  prompt: fragment.channel.endsWith('negative') ? '' : fragment.text,
  tags: fragment.channel.endsWith('negative') ? '' : fragment.text,
  negative: fragment.channel.endsWith('negative') ? fragment.text : '',
  characterPrompts: [],
});
const dependencies = {
  state,
  toast: (...args) => messages.push(args),
  recordRecentEntry() {}, saveBrowseStateNow() {},
  writeClipboardText: async (text, options) => {
    if (!options.canWrite()) return { ok: false, blocked: true };
    written.push(text);
    if (pendingWrite) await pendingWrite;
    return clipboardResult;
  },
  showClipboardFallback: () => false,
  formatCopyText,
  playCopySample() {}, relayTossTarget: () => null,
  prepareCopiedEntry: snapshotEntry,
  prepareCopiedFragment,
  recordPreparedCopiedEntry: async snapshot => { stored.push(structuredClone(snapshot)); return true; },
  snapshotLocked: () => false,
  isEntryAccessBlocked: () => false,
  isR18gEntry: () => false,
  showNsfwLockedHint() {}, showR18gLockedHint() {},
  findCodexMeta: () => null,
};
const { copyText, copyEntry, combinedPrompt, entryPromptText } = new Function(
  ...Object.keys(dependencies),
  `${source}\nreturn { copyText, copyEntry, combinedPrompt, entryPromptText };`,
)(...Object.values(dependencies));

const entry = {
  id: 'outdoor-1', title: '户外装备', tags: 'forest, sunlight', negative: 'blur',
  characterPrompts: [{ label: 'char1', prompt: 'backpack, gloves', negative: 'wet clothing' }],
};
await copyEntry(entry, null);
assert.equal(written.at(-1), 'forest, sunlight\nbackpack, gloves');
assert.equal(stored.at(-1).prompt, entryPromptText(entry));
assert.equal(stored.at(-1).negative, '');
assert.deepEqual(stored.at(-1).characterPrompts, []);

const selection = { text: '{{gloves}}', channel: 'positive', scope: 'selection' };
await copyText(selection.text, 'copied', null, { entry, fragment: selection });
assert.equal(written.at(-1), '{{gloves}}');
assert.equal(stored.at(-1).prompt, '{{gloves}}');
assert.equal(stored.at(-1).negative, '');

await copyText(entry.negative, 'copied', null, {
  entry, fragment: { text: entry.negative, channel: 'negative', scope: 'negative' },
});
assert.equal(stored.at(-1).negative, 'blur');
assert.equal(stored.at(-1).prompt, '');

await copyText(entry.characterPrompts[0].negative, 'copied', null, {
  entry, fragment: {
    text: entry.characterPrompts[0].negative, channel: 'character-negative',
    scope: 'selection', characterIndex: 0, label: 'char1 Negative',
  },
});
assert.equal(stored.at(-1).channel, 'character-negative');
assert.equal(stored.at(-1).characterIndex, 0);
assert.equal(stored.at(-1).prompt, '');

await copyText(combinedPrompt(entry), 'copied', null, { entry });
assert.match(written.at(-1), /char1:\nbackpack, gloves/);
assert.match(written.at(-1), /char1 Negative:\nwet clothing/);
assert.deepEqual(stored.at(-1).characterPrompts, entry.characterPrompts);

const beforeFailure = stored.length;
clipboardResult = { ok: false };
const failed = await copyText(selection.text, 'copied', null, { entry, fragment: selection, manualFallback: false });
assert.equal(failed.ok, false);
assert.equal(stored.length, beforeFailure);
clipboardResult = { ok: true };

state.sdMode = true;
await copyText(selection.text, 'copied', null, { entry, fragment: selection });
assert.equal(written.at(-1), '(gloves:1.103)');
assert.equal(stored.at(-1).prompt, '{{gloves}}');
state.sdMode = false;

let resume;
pendingWrite = new Promise(resolve => { resume = resolve; });
const delayed = copyEntry(entry, null);
state.codex.id = 'another-book';
resume();
await delayed;
pendingWrite = null;
assert.equal(stored.at(-1).codexId, 'outdoors');
const followUp = messages.at(-1)[2];
assert.equal(followUp.label, '再复制负面');
await followUp.onClick();
assert.equal(stored.at(-1).codexId, 'outdoors');
assert.equal(stored.at(-1).negative, 'blur');
assert.equal(stored.at(-1).prompt, '');

const beforePlainCopy = stored.length;
await copyText('https://example.com/', 'link', null, { convert: false });
assert.equal(stored.length, beforePlainCopy);
console.log('copy fragments: precise intake, failure, channels, original storage and frozen source passed');
