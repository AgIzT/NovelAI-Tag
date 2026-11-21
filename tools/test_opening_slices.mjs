// Note template decoding & opening slice runtime tests: node tools/test_opening_slices.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal browser globals for importing site/assets/app/*.js in Node.
globalThis.location = { href: 'http://localhost/', hostname: 'localhost', protocol: 'http:', pathname: '/', search: '', hash: '' };
globalThis.document = {
  baseURI: 'http://localhost/',
  body: { classList: { contains: () => false } },
  querySelector: () => null,
};

const { resolveEntryNote, normalizeCodex } = await import('../site/assets/app/data.js');
const { todayFeatured, pinFeatured, FEATURED_CODEX_ID } = await import('../site/assets/app/featured.js');

// 1. resolveEntryNote: plain, exact int, parameterized array, invalid/missing.
const templates = [
  '固定备注模板',
  ['前缀 ', ' 中间 ', ' 后缀'],
];
assert.equal(resolveEntryNote('', templates), '');
assert.equal(resolveEntryNote(null, templates), '');
assert.equal(resolveEntryNote('普通手写备注', templates), '普通手写备注');
assert.equal(resolveEntryNote(0, templates), '固定备注模板');
assert.equal(resolveEntryNote([1, 'A', 'B'], templates), '前缀 A 中间 B 后缀');
assert.equal(resolveEntryNote(99, templates), '');
assert.equal(resolveEntryNote([1, 'only_one_arg'], templates), '');
assert.equal(resolveEntryNote([0], null), '');

// 2. normalizeCodex expands noteTemplates and removes noteTemplates from in-memory codex.
const normalized = normalizeCodex({
  id: 'demo',
  title: 'Demo',
  noteTemplates: templates,
  entries: [
    { id: 'e1', title: 'One', tags: 'artist:a', path: ['A'], note: 0 },
    { id: 'e2', title: 'Two', tags: 'artist:b', path: ['A'], note: [1, '123', 'artist:b'] },
    { id: 'e3', title: 'Three', tags: 'artist:c', path: ['A'], note: 'plain' },
  ],
});
assert.equal(normalized.noteTemplates, undefined);
assert.equal(normalized.entries[0].note, '固定备注模板');
assert.equal(normalized.entries[1].note, '前缀 123 中间 artist:b 后缀');
assert.equal(normalized.entries[2].note, 'plain');

// 3. Cross-language parity: Python pack_codex_notes -> JS normalizeCodex restores identical strings.
const pyOut = execFileSync(
  'python',
  [
    '-c',
    `import json; from tools.codex_note_pack import pack_codex_notes
entries = [
  {"id": f"e{i}", "title": f"t{i}", "tags": f"artist:name_{i}", "path": ["单画师词典", "AgIzT"],
   "note": f"AgIzT 模板头\\nportrait（seed {10000+i}）：\\nartist:name_{i},\\n" + "x"*220}
  for i in range(15)
]
packed, _ = pack_codex_notes({"id": "demo", "entries": entries})
print(json.dumps({"orig": [e["note"] for e in entries], "packed": packed}, ensure_ascii=True))`,
  ],
  { cwd: ROOT, encoding: 'utf8' },
);
const parity = JSON.parse(pyOut);
const decoded = normalizeCodex(parity.packed);
assert.deepEqual(decoded.entries.map(e => e.note), parity.orig);

// 4. Opening slice todayFeatured / pinFeatured uses precomputed day map and never hashes mod 50.
const now = new Date();
const todayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
const eA = { id: 'a1', title: 'A', tags: 'artist:a', path: ['单画师词典', 'MayRain'], rating: 'safe', image: 'a.jpg', imageWidth: 600, imageHeight: 900 };
const eB = { id: 'b2', title: 'B', tags: 'artist:b', path: ['单画师词典', 'MayRain'], rating: 'safe', image: 'b.jpg', imageWidth: 600, imageHeight: 900 };
const openingCodex = {
  id: FEATURED_CODEX_ID,
  _opening: true,
  entries: [eA, eB],
  openingFeaturedByDay: { [todayKey]: 'b2' },
};
assert.equal(todayFeatured(openingCodex), eB);
assert.deepEqual(pinFeatured([eA, eB], openingCodex), [eB, eA]);

const staleOpeningCodex = {
  id: FEATURED_CODEX_ID,
  _opening: true,
  entries: [eA, eB],
  openingFeaturedByDay: { '1999-1-1': 'b2' },
};
assert.equal(todayFeatured(staleOpeningCodex), null);
assert.deepEqual(pinFeatured([eA, eB], staleOpeningCodex), [eA, eB]);

// 5. Cross-language FNV-1a parity between Python build_opening_slices._fnv1a_32 and JS featured.js.
const pyHash = JSON.parse(execFileSync(
  'python',
  [
    '-c',
    `import json; from tools.build_opening_slices import _fnv1a_32
days = ["2026-11-21", "2026-12-31", "2027-1-1", "${todayKey}"]
print(json.dumps({d: _fnv1a_32(d) for d in days}))`,
  ],
  { cwd: ROOT, encoding: 'utf8' },
));
for (const [day, expected] of Object.entries(pyHash)) {
  let h = 2166136261;
  for (const ch of day) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  assert.equal(h >>> 0, expected, `FNV-1a mismatch for ${day}`);
}

console.log('opening slices & note templates: PASS (5 groups)');
