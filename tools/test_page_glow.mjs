import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window ??= { addEventListener() {} };
globalThis.document ??= { querySelector() { return null; } };
const { breathingBlobs, followStep, FOLLOW_SEC } = await import('../site/assets/app/page-glow.js');

const tokens = readFileSync(new URL('../site/assets/tokens.css', import.meta.url), 'utf8');
const close = (a, b, label, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${label}: ${a} ≠ ${b}`);

// 动态层 t=0 那一帧必须和静态光晕 --page-wash 一模一样：开场幕布、停用淡出都靠它接缝。两边几何从源码对照，防漂移。
const wash = tokens.match(/^body\{--page-wash:([^}]*)\}/m);
assert.ok(wash, 'tokens.css 里找不到各皮肤共用的 body{--page-wash:…}');
const gradients = [...wash[1].matchAll(/radial-gradient\((\d+)vmax (\d+)vmax at (\d+)% (\d+)%,var\(--glow-(\d)\),transparent 72%\)/g)];
assert.equal(gradients.length, 2, '--page-wash 应是两段 radial-gradient，颜色走 --glow-1 / --glow-2');
assert.match(tokens, /^body:not\(\.dark\)::before\{[^}]*background:var\(--page-wash\)\}/m, '浅色档的静态光晕应铺 --page-wash');

// 每套皮肤的浅色块：按分号切成声明再取值。漏一个分号时后一个变量会被前一个吞掉，这里就会报缺
const SKINS = ['dream', 'teal', 'sakura', 'amber', 'indigo', 'ink'];
const skinVars = id => {
  const block = tokens.match(new RegExp(`^body\\.theme-${id}\\{([^}]*)\\}`, 'm'));
  assert.ok(block, `tokens.css 里找不到 body.theme-${id}{…}`);
  return Object.fromEntries(block[1].split(';').map(d => d.trim()).filter(Boolean).map(d => {
    const i = d.indexOf(':');
    return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
  }));
};
const luminance = hex => {
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// 灰字直接压在光晕上：对底色和三种光晕色都不低于梦境现行的约 4.4:1（梦境 #5c6275 最低 4.39）
const MUTED_MIN = 4.35;
for (const id of SKINS) {
  const v = skinVars(id);
  for (const name of ['--bg', '--muted', '--glow-1', '--glow-2', '--glow-3', '--glow-spot']) {
    assert.match(v[name] || '', /^#[0-9a-f]{6}$/, `${id} 的 ${name} 应是六位十六进制色：${v[name]}`);
  }
  for (const surface of ['--bg', '--glow-1', '--glow-2', '--glow-3']) {
    const ratio = contrast(v['--muted'], v[surface]);
    assert.ok(ratio >= MUTED_MIN, `${id} 的灰字压在 ${surface} 上只有 ${ratio.toFixed(2)}:1`);
  }
}

for (const [vw, vh] of [[1440, 800], [390, 844], [1920, 1080]]) {
  const vm = Math.max(vw, vh) / 100;
  const [third, ...pair] = breathingBlobs(0, vw, vh);
  assert.equal(third.color, 3);
  close(third.alpha, 0, '第三色在 t=0 应透明');
  gradients.forEach(([, rx, ry, px, py, color], i) => {
    const b = pair[i];
    const at = `${vw}x${vh} 第 ${i + 1} 团`;
    assert.equal(b.color, Number(color), `${at} 颜色`);
    close(b.x, vw * Number(px) / 100, `${at} 圆心 x`);
    close(b.y, vh * Number(py) / 100, `${at} 圆心 y`);
    close(b.rx, vm * Number(rx), `${at} 横半径`);
    close(b.ry, vm * Number(ry), `${at} 纵半径`);
    close(b.alpha, 1, `${at} 不透明度`);
  });
}

// 任何时刻都只是在原位附近慢漂：位移不超过 16.5vmax（各分量振幅之和）、大小只在 ±10% 内、第三色不透明度在 0～0.8
for (let t = 0; t < 600; t += 0.37) {
  const vw = 1440, vh = 800, vm = 14.4;
  const [third, b1, b2] = breathingBlobs(t, vw, vh);
  assert.ok(third.alpha >= 0 && third.alpha <= 0.8 + 1e-9, `t=${t} 第三色不透明度越界`);
  assert.ok(Math.hypot(b1.x, b1.y) <= 16.5 * vm, `t=${t} 左上光团漂太远`);
  assert.ok(Math.hypot(b2.x - vw, b2.y - vh * 0.06) <= 16.5 * vm, `t=${t} 右上光团漂太远`);
  assert.ok(b1.rx / (70 * vm) >= 0.9 && b1.rx / (70 * vm) <= 1.1, `t=${t} 左上光团缩放越界`);
  assert.ok(b2.rx / (70 * vm) >= 0.9 && b2.rx / (70 * vm) <= 1.1, `t=${t} 右上光团缩放越界`);
}

// 跟手用「快」档：鼠标每秒 1000px 匀速移动、60 帧逐帧追时，稳态落后约 32px（连续极限是 1000×τ = 40px）；
// 原型在无头浏览器里量到约 45px，多出来的是指针事件和画面之间的一帧
assert.equal(FOLLOW_SEC, 0.04);
let pos = 0, target = 0;
for (let i = 0; i < 240; i++) { target += 1000 / 60; pos = followStep(pos, target, 1 / 60, FOLLOW_SEC); }
const lag = target - pos;
assert.ok(lag > 28 && lag < 40, `稳态落后 ${lag.toFixed(1)}px，应在 32px 左右`);
// 停手后 0.12 秒（3τ）追上 95%
let p = 0;
for (let i = 0; i < 12; i++) p = followStep(p, 100, 0.01, FOLLOW_SEC);
assert.ok(p > 94 && p < 96, `0.12 秒后只追上 ${p.toFixed(1)}%`);
close(followStep(5, 5, 0.016, FOLLOW_SEC), 5, '已在目标处不应移动');

console.log('page glow tests passed');
