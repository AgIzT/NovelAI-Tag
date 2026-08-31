import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { normalizeRoutePath, normalizeCodexRoutePath } from '../site/assets/app/codex-route-compat.js';

const node = (name, children = []) => ({ name, children });
const artists = {
  id: 'artist_nai45_personal',
  tree: [
    node('单画师词典', [node('相同分类'), node('画师/A')]),
    node('画师串词典', [node('相同分类'), node('W.O.F_画风', [node('复古')])]),
  ],
};
const packs = {
  id: 'nai45_community_pack',
  tree: [node('梦神 · 社区图包', [node('人物')]), node('社区 · AI杂图', [node('人物')])],
};
const normalize = (codex, source, path) => normalizeCodexRoutePath(codex, path, source);

assert.deepEqual(normalize(artists, 'artist_nai45_strings', ['W.O.F_画风', '复古']), ['画师串词典', 'W.O.F_画风', '复古']);
assert.deepEqual(normalize(artists, 'artist_nai45_personal', ['相同分类']), ['单画师词典', '相同分类']);
assert.deepEqual(normalize(artists, 'artist_nai45_strings', ['相同分类']), ['画师串词典', '相同分类']);
assert.deepEqual(normalize(artists, 'artist_300', ['画师/A']), ['单画师词典', '画师/A']);
assert.deepEqual(normalize(packs, 'mengshen_pack', ['人物']), ['梦神 · 社区图包', '人物']);
assert.deepEqual(normalize(packs, 'community_ai_misc', ['人物']), ['社区 · AI杂图', '人物']);
assert.deepEqual(normalize(packs, 'nai45_community_pack', ['人物']), [], '来源未知时不能猜同名目录');
assert.deepEqual(normalize(artists, 'artist_nai45_personal', []), [], '当前书的全部不变');
assert.deepEqual(normalize(artists, 'artist_nai45_strings', []), ['画师串词典'], '旧分书首页进入对应分区');
assert.deepEqual(normalize(artists, 'unknown', ['W.O.F_画风']), []);
assert.deepEqual(normalize(artists, 'artist_nai45_strings', ['已删除']), []);
assert.deepEqual(normalizeRoutePath(artists.tree, 'W.O.F_画风'), []);
assert.deepEqual(normalize({ id: 'favorites', tree: [node('来源')] }, artists.id, ['来源']), ['来源']);

const canonicalPath = ['画师串词典', 'W.O.F_画风'];
assert.deepEqual(normalize(artists, 'artist_nai45_strings', canonicalPath), canonicalPath);
assert.deepEqual(normalize(artists, artists.id, normalize(artists, 'artist_nai45_strings', canonicalPath)), canonicalPath);
assert.deepEqual(canonicalPath, ['画师串词典', 'W.O.F_画风'], '不修改调用方数组');
// 兼容程序先部署时仍读取旧树：不能提前加上不存在的合并层级。
assert.deepEqual(normalize({ id: artists.id, tree: [node('旧目录')] }, artists.id, ['旧目录']), ['旧目录']);
assert.deepEqual(normalize({ id: 'artist_nai45_strings', tree: [node('W.O.F_画风')] }, 'artist_nai45_strings', ['W.O.F_画风']), ['W.O.F_画风']);

const dataDir = new URL('../site/data/', import.meta.url);
const hasData = await stat(dataDir).then(value => value.isDirectory()).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return false;
});
if (hasData) {
  let checked = 0;
  for (const [id, sources] of [
    ['artist_nai45_personal', { '单画师词典': 'artist_nai45_personal', '画师串词典': 'artist_nai45_strings' }],
    ['nai45_community_pack', { '梦神 · 社区图包': 'mengshen_pack', '社区 · AI杂图': 'community_ai_misc' }],
  ]) {
    const book = JSON.parse(await readFile(new URL(`${id}.json`, dataDir), 'utf8'));
    for (const entry of book.entries) {
      const source = sources[entry.path[0]];
      assert.ok(source, `未审计分区：${entry.path[0]}`);
      for (let depth = 2; depth <= entry.path.length; depth += 1) {
        const current = entry.path.slice(0, depth);
        assert.deepEqual(normalize(book, source, current.slice(1)), current, `${source}:${entry.id}`);
        assert.deepEqual(normalize(book, book.id, current), current);
        checked += 1;
      }
    }
  }
  console.log(`codex route compatibility: ${checked} real legacy category paths OK`);
}
console.log('codex route compatibility tests passed');
