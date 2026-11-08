// 首屏模块预加载完整性：node tools/test_module_preload.mjs
// 主入口的整张静态 import 图必须都在 index.html 的 modulepreload 里，否则漏掉的模块要等上一层下完、
// 解析完才被发现，慢线路上多等一整轮（2026-11-08 实测第二波晚了约 2 秒）。动态 import 不算首屏，不要求预加载。
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const STATIC_IMPORT = /(?:^|[\s;])(?:import|export)\s+(?:[^'"();]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

export function staticGraph(entries, root = ROOT) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    const file = join(root, rel);
    assert.ok(existsSync(file), `静态 import 指向不存在的文件：${rel}`);
    seen.add(rel);
    for (const match of stripComments(readFileSync(file, 'utf8')).matchAll(STATIC_IMPORT)) {
      stack.push(posix.normalize(posix.join(posix.dirname(rel), match[1])));
    }
  }
  return seen;
}

export function modulePreloads(html) {
  return [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(match => match[1]);
}

export function moduleEntries(html) {
  return [...html.matchAll(/<script type="module"(?: async)? src="([^"]+)"><\/script>/g)].map(match => match[1]);
}

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const preloads = modulePreloads(html);
const entries = moduleEntries(html);
assert.ok(entries.includes('assets/app.js'), 'index.html 必须以 assets/app.js 为模块入口');

const graph = staticGraph(entries);
const entrySet = new Set(entries);
const preloadSet = new Set(preloads);

assert.equal(preloads.length, preloadSet.size, 'modulepreload 不应重复');
const missing = [...graph].filter(rel => !entrySet.has(rel) && !preloadSet.has(rel)).sort();
assert.deepEqual(missing, [], `这些模块在首屏静态 import 图里，但 index.html 没有 modulepreload：\n${missing.join('\n')}`);
const stale = preloads.filter(rel => !graph.has(rel)).sort();
assert.deepEqual(stale, [], `这些 modulepreload 已不在首屏静态 import 图里，删掉或改成动态加载：\n${stale.join('\n')}`);

// 解析器自检：多行 import、re-export 与注释里的 import 字样
const sample = `import {\n  a,\n  b,\n} from './x.js';\nexport * from "../y.js";\n/* import z from './no.js' */\n// import w from './no2.js'\nconst lazy = () => import('./dyn.js');\nimport './side.js';`;
const found = [...stripComments(sample).matchAll(STATIC_IMPORT)].map(m => m[1]);
assert.deepEqual(found, ['./x.js', '../y.js', './side.js']);

console.log(`module preload completeness: PASS (${graph.size} modules, ${preloads.length} preloads)`);
