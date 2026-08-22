import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../site/404.html', import.meta.url));

// Pages 的规矩：顶层没有 404.html 就认定整站是 SPA，任何未命中路径一律回
// /index.html + 200（实测线上 624KB，本地 61KB）。所以这个文件本身就是机制——
// 删掉它，兜底会静默长回来，没有任何报错提醒。
assert.ok(existsSync(path), 'site/404.html 不见了：Pages 会退回「未命中路径一律回 index.html + 200」');

const source = readFileSync(path, 'utf8');
// 禁忌类断言只看代码：这页的注释本身就在讲「不外链 tokens.css」「不碰 innerHTML」，
// 扫全文会被它自己的说明绊倒。
const code = source.replace(/\/\*[\s\S]*?\*\//g, '');

assert.ok(source.length < 16384, `404 页应保持轻量，当前 ${source.length} 字节`);

const refs = [...code.matchAll(/(?:href|src)="([^"]*)"/g)].map(m => m[1]);
assert.ok(refs.length > 0, '没解析到任何引用，正则可能失配了');
for (const ref of refs) {
  // 这张页会被投递到任意深度的路径（/a/b/c/nope 也走它），相对路径会在那儿再打空一次，
  // 再被换回这张页——正好是它要终结的那种空转。
  assert.ok(ref.startsWith('/'), `引用必须用绝对路径，否则深层路径下会二次打空：${ref}`);
  assert.doesNotMatch(ref, /^https?:/, `404 页不能有外部依赖（字体/CDN）：${ref}`);
  assert.doesNotMatch(ref, /styles\.css|tokens\.css|app\.js/, `404 页必须自带样式，不挂主站资源：${ref}`);
}
// 兜底页得在别的东西都坏掉时还能自己站住。
assert.doesNotMatch(code, /rel="stylesheet"/, '样式要内联，不外链');

// 路径栏落的是用户可控输入。
assert.match(code, /textContent\s*=/, '路径要用 textContent 落字');
assert.doesNotMatch(code, /innerHTML\s*=/, '不许改用 innerHTML：路径是用户可控输入');
assert.match(code, /noindex/, '404 页应标 noindex');

// 主题跟随主站，键名漂了就会变成永远浅色。
// 连读取调用一起比：光比键名是子串匹配，改成 fadian-darkmode 也照样含 fadian-dark。
for (const key of ['fadian-dark', 'fadian-theme']) {
  assert.ok(code.includes(`getItem('${key}')`), `主题键 ${key} 对不上主站了`);
}
// 锚到行首：不锚的话 .theme-teal.dark{ 就能满足 /\.dark\{/，基础深色块删了也发现不了。
assert.match(code, /^:root\{/m, '缺浅色 token');
assert.match(code, /^\.dark\{/m, '缺深色 token（.theme-*.dark 不算，基础深色块得在）');

console.log('404 page guards: PASS');
